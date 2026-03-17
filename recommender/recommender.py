"""
Photcot Recommender Service - Port 8090
========================================
Combines three systems:

1. FEATURE STORE
   - Offline features: read from PostgreSQL (historical signals)
   - Online features:  read/write from Redis (real-time session signals)
   - Sync job:         background thread refreshes Redis every 5 min

2. COLLABORATIVE FILTERING (CF)
   - Item-Item cosine similarity on implicit feedback
   - POST /recommend -> ranked video_ids for a user
   - Falls back to trending when no history

3. NEURAL RANKER
   - 4-layer feedforward network with tunable dropout
   - SwiGLU activations for better gradient flow
   - 20-dimensional feature input (expanded from 15)
   - Soft label training with 4-tier quality scheme
   - Trained on video_views + video_likes interaction data
   - POST /train  -> trains model, saves weights to ranker_model.pt
   - POST /rank   -> scores a list of candidate video_ids for a user
   - CF recall feeds into neural ranker for final ordering
"""

import os, time, logging, threading, json, random
import numpy as np
import psycopg2, psycopg2.extras
import redis as redis_lib
import torch
import torch.nn as nn
import torch.optim as optim
from torch.optim.lr_scheduler import CosineAnnealingLR
from flask import Flask, request, jsonify
from scipy.sparse import csr_matrix

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("recommender")

app = Flask(__name__)

# ── Config ─────────────────────────────────────────────────────────────────────
DB_DSN        = os.environ.get("DATABASE_URL",
                    "host=localhost dbname=photcot user=photcot password=photcot123 sslmode=disable")
REDIS_HOST    = os.environ.get("REDIS_HOST", "localhost")
REDIS_PORT    = int(os.environ.get("REDIS_PORT", 6379))
MODEL_PATH    = os.path.join(os.path.dirname(__file__), "ranker_model.pt")

# Feature dimension: 20 (expanded from 15)
# User (9):  avg_watch_percent, like_rate, completion_rate, total_views_norm,
#            replay_rate, comment_rate, share_rate, session_tag_overlap, author_affinity
# Video (9): like_count_norm, comment_count_norm, share_count_norm, view_count_norm,
#            avg_completion, freshness_score, duration_norm, engagement_velocity,
#            like_to_view_ratio, comment_to_view_ratio
# Interaction (2): is_completed_by_user_before, has_liked_before
FEATURE_DIM   = 20

# Dropout rates per layer (tunable via env)
DROPOUT_L1    = float(os.environ.get("DROPOUT_L1", 0.3))    # after layer 1 (128->64)
DROPOUT_L2    = float(os.environ.get("DROPOUT_L2", 0.25))   # after layer 2 (64->32)
DROPOUT_L3    = float(os.environ.get("DROPOUT_L3", 0.15))   # after layer 3 (32->16)

# Training hyperparameters (tunable via env or POST body)
TRAIN_EPOCHS        = int(os.environ.get("TRAIN_EPOCHS", 150))
TRAIN_LR            = float(os.environ.get("TRAIN_LR", 0.003))
EARLY_STOP_PATIENCE = int(os.environ.get("EARLY_STOP_PATIENCE", 20))
TRAIN_OPTIMIZER     = os.environ.get("TRAIN_OPTIMIZER", "adam").lower()  # adam | adamw | sgd | rmsprop

REBUILD_INTERVAL      = 120   # CF model rebuild every 2 min
FEATURE_SYNC_INTERVAL = 300   # feature store sync every 5 min
REDIS_TTL             = 86400  # online features expire after 24h

# ── DB / Redis helpers ─────────────────────────────────────────────────────────
def get_db(autocommit: bool = False):
    conn = psycopg2.connect(DB_DSN)
    if autocommit:
        conn.autocommit = True
    return conn

def get_redis():
    try:
        r = redis_lib.Redis(host=REDIS_HOST, port=REDIS_PORT, db=0,
                            decode_responses=True, socket_timeout=1)
        r.ping()
        return r
    except Exception as e:
        log.warning(f"Redis unavailable: {e}")
        return None

# ── Neural Ranker Model ────────────────────────────────────────────────────────
class SwiGLU(nn.Module):
    """
    SwiGLU activation: Swish(xW1) * xW2
    Better gradient flow than ReLU for ranking tasks.
    """
    def __init__(self, dim: int):
        super().__init__()
        self.W1 = nn.Linear(dim, dim)
        self.W2 = nn.Linear(dim, dim)

    def forward(self, x):
        return torch.sigmoid(self.W1(x)) * self.W1(x) * self.W2(x)


class NeuralRanker(nn.Module):
    """
    4-layer feedforward network for video ranking with tunable dropout.

    Architecture:
      Input(20)
        -> Linear(128) -> SwiGLU -> Dropout(d1)
        -> Linear(64)  -> SwiGLU -> Dropout(d2)
        -> Linear(32)  -> SwiGLU -> Dropout(d3)
        -> Linear(1)   -> Sigmoid
        -> scalar output: P(user watches video thoroughly)

    Input features (20 total):
      User (7 base + 2 new):
        avg_watch_percent, like_rate, completion_rate, total_views_norm,
        replay_rate, comment_rate(*), share_rate(*),
        session_tag_overlap, author_affinity
      Video (8 base + 2 new):
        like_count_norm, comment_count_norm, share_count_norm, view_count_norm,
        avg_completion, freshness_score, duration_norm, engagement_velocity,
        like_to_view_ratio(*), comment_to_view_ratio(*)
      Interaction (2 new):
        is_completed_by_user_before(*), has_liked_before(*)
      (* = newly added)

    Soft labels (4-tier):
      watch >= 0.9 OR liked  -> 1.0  (strong positive)
      watch >= 0.7           -> 0.7  (positive)
      watch 0.2-0.7         -> 0.3  (partial)
      watch <  0.2          -> 0.0  (negative)
    """
    def __init__(self, input_dim: int = FEATURE_DIM,
                 dropout_l1: float = DROPOUT_L1,
                 dropout_l2: float = DROPOUT_L2,
                 dropout_l3: float = DROPOUT_L3):
        super().__init__()
        self.fc1   = nn.Linear(input_dim, 128)
        self.act1  = SwiGLU(128)
        self.drop1 = nn.Dropout(dropout_l1)

        self.fc2   = nn.Linear(128, 64)
        self.act2  = SwiGLU(64)
        self.drop2 = nn.Dropout(dropout_l2)

        self.fc3   = nn.Linear(64, 32)
        self.act3  = SwiGLU(32)
        self.drop3 = nn.Dropout(dropout_l3)

        self.fc4 = nn.Linear(32, 1)
        self.out  = nn.Sigmoid()

    def forward(self, x):
        x = self.drop1(self.act1(self.fc1(x)))
        x = self.drop2(self.act2(self.fc2(x)))
        x = self.drop3(self.act3(self.fc3(x)))
        return self.out(self.fc4(x)).squeeze(-1)


# Global ranker instance
ranker_model: NeuralRanker = NeuralRanker()
ranker_lock = threading.RLock()
ranker_trained = False

def load_ranker():
    global ranker_model, ranker_trained
    if os.path.exists(MODEL_PATH):
        try:
            state = torch.load(MODEL_PATH, map_location="cpu")
            # Check if saved model matches current FEATURE_DIM
            first_weight_key = next((k for k in state if "weight" in k), None)
            if first_weight_key:
                saved_in = state[first_weight_key].shape[1]
                if saved_in != FEATURE_DIM:
                    log.warning(
                        f"Saved model input_dim={saved_in} != FEATURE_DIM={FEATURE_DIM}. "
                        "Ignoring saved weights - retrain required."
                    )
                    return
            ranker_model.load_state_dict(state)
            ranker_model.eval()
            ranker_trained = True
            log.info(f"Loaded ranker weights from {MODEL_PATH}")
        except Exception as e:
            log.warning(f"Could not load ranker weights: {e}")

# ── Feature Store ──────────────────────────────────────────────────────────────

def compute_user_features_offline(user_id: str, cur) -> dict:
    """
    Compute user features from PostgreSQL (offline store).
    Historical aggregates over all time.
    """
    features = {
        "avg_watch_percent": 0.0,
        "like_rate":         0.0,
        "completion_rate":   0.0,
        "total_views":       0,
        "replay_rate":       0.0,
        "comment_rate":      0.0,  # NEW: comments left / total_views
        "share_rate":        0.0,  # NEW: shares made / total_views
    }
    cur.execute("""
        SELECT
            COALESCE(AVG(watch_percent), 0)                         AS avg_watch,
            COALESCE(SUM(CASE WHEN watch_percent >= 0.7 THEN 1 ELSE 0 END)::float
                     / NULLIF(COUNT(*), 0), 0)                      AS completion_rate,
            COALESCE(SUM(CASE WHEN replayed THEN 1 ELSE 0 END)::float
                     / NULLIF(COUNT(*), 0), 0)                      AS replay_rate,
            COUNT(*)                                                 AS total_views
        FROM video_views WHERE user_id = %s
    """, (user_id,))
    row = cur.fetchone()
    if row:
        features["avg_watch_percent"] = float(row[0])
        features["completion_rate"]   = float(row[1])
        features["replay_rate"]       = float(row[2])
        features["total_views"]       = int(row[3])

    total_views = features["total_views"]

    # Like rate
    cur.execute("SELECT COUNT(*) FROM video_likes WHERE user_id = %s", (user_id,))
    likes = cur.fetchone()[0] or 0
    if total_views > 0:
        features["like_rate"] = likes / total_views

    # Comment rate: comments by this user / total_views
    try:
        cur.execute("SELECT COUNT(*) FROM video_comments WHERE user_id = %s", (user_id,))
        comments = cur.fetchone()[0] or 0
        if total_views > 0:
            features["comment_rate"] = comments / total_views
    except Exception:
        pass  # table may not exist yet

    # Share rate: shares by this user / total_views
    try:
        cur.execute("SELECT COUNT(*) FROM video_shares WHERE user_id = %s", (user_id,))
        shares = cur.fetchone()[0] or 0
        if total_views > 0:
            features["share_rate"] = shares / total_views
    except Exception:
        pass

    return features


def compute_video_features_offline(video_id: str, cur) -> dict:
    """
    Compute video features from PostgreSQL (offline store).
    """
    features = {
        "like_count":            0,
        "comment_count":         0,
        "share_count":           0,
        "view_count":            0,
        "avg_completion":        0.0,
        "freshness_hours":       9999.0,
        "duration":              60.0,
        "engagement_velocity":   0.0,
        "like_to_view_ratio":    0.0,   # NEW
        "comment_to_view_ratio": 0.0,   # NEW
    }
    cur.execute("""
        SELECT like_count, comment_count, share_count, view_count, duration,
               EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600.0 AS hours_old
        FROM videos WHERE id = %s
    """, (video_id,))
    row = cur.fetchone()
    if row:
        features["like_count"]     = int(row[0])
        features["comment_count"]  = int(row[1])
        features["share_count"]    = int(row[2])
        features["view_count"]     = int(row[3])
        features["duration"]       = float(row[4]) if row[4] else 60.0
        features["freshness_hours"]= max(float(row[5]), 0.1)
        hours = features["freshness_hours"]
        features["engagement_velocity"] = (features["like_count"] + features["comment_count"]) / hours

        vc = features["view_count"]
        if vc > 0:
            features["like_to_view_ratio"]    = features["like_count"]    / vc
            features["comment_to_view_ratio"] = features["comment_count"] / vc

    cur.execute("SELECT COALESCE(AVG(watch_percent), 0) FROM video_views WHERE video_id = %s", (video_id,))
    features["avg_completion"] = float(cur.fetchone()[0])

    return features


def sync_features_to_redis():
    """
    Background job: compute all user + video features from PostgreSQL
    and write to Redis (online feature store).
    Runs every FEATURE_SYNC_INTERVAL seconds.
    """
    rdb = get_redis()
    if rdb is None:
        log.warning("Feature sync skipped - Redis unavailable")
        return

    log.info("Syncing features to Redis...")
    t0 = time.time()
    conn = None
    try:
        conn = get_db(autocommit=True)
        cur = conn.cursor()

        cur.execute("SELECT DISTINCT user_id FROM video_views")
        user_ids = [str(r[0]) for r in cur.fetchall()]
        for uid in user_ids:
            try:
                feats = compute_user_features_offline(uid, cur)
                key = f"feat:user:{uid}"
                rdb.hset(key, mapping={k: str(v) for k, v in feats.items()})
                rdb.expire(key, REDIS_TTL)
            except Exception as e:
                log.warning(f"Feature sync user {uid} error: {e}")

        cur.execute("SELECT id FROM videos WHERE is_published = true")
        video_ids = [str(r[0]) for r in cur.fetchall()]
        for vid in video_ids:
            try:
                feats = compute_video_features_offline(vid, cur)
                key = f"feat:video:{vid}"
                rdb.hset(key, mapping={k: str(v) for k, v in feats.items()})
                rdb.expire(key, REDIS_TTL)
            except Exception as e:
                log.warning(f"Feature sync video {vid} error: {e}")

        cur.close()
        elapsed = time.time() - t0
        log.info(f"Feature sync done: {len(user_ids)} users, {len(video_ids)} videos ({elapsed:.1f}s)")
    except Exception as e:
        log.error(f"Feature sync error: {e}")
    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass


def get_user_features(user_id: str) -> dict:
    """
    Get user features: try Redis (online) first, fall back to PostgreSQL (offline).
    """
    defaults = {
        "avg_watch_percent": 0.0, "like_rate":    0.0,
        "completion_rate":   0.0, "total_views":  0,
        "replay_rate":       0.0, "comment_rate": 0.0,
        "share_rate":        0.0,
    }
    rdb = get_redis()
    if rdb:
        try:
            cached = rdb.hgetall(f"feat:user:{user_id}")
            if cached:
                return {k: float(v) for k, v in cached.items()}
        except Exception as e:
            log.warning(f"Redis hgetall user error: {e}")

    conn = None
    try:
        conn = get_db(autocommit=True)
        cur = conn.cursor()
        feats = compute_user_features_offline(user_id, cur)
        cur.close()
        return feats
    except Exception as e:
        log.error(f"get_user_features error: {e}")
        return defaults
    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass


def get_video_features(video_id: str) -> dict:
    """
    Get video features: try Redis (online) first, fall back to PostgreSQL.
    """
    defaults = {
        "like_count": 0, "comment_count": 0, "share_count": 0,
        "view_count": 0, "avg_completion": 0.0,
        "freshness_hours": 9999.0, "duration": 60.0,
        "engagement_velocity": 0.0,
        "like_to_view_ratio": 0.0, "comment_to_view_ratio": 0.0,
    }
    rdb = get_redis()
    if rdb:
        try:
            cached = rdb.hgetall(f"feat:video:{video_id}")
            if cached:
                return {k: float(v) for k, v in cached.items()}
        except Exception as e:
            log.warning(f"Redis hgetall video error: {e}")

    conn = None
    try:
        conn = get_db(autocommit=True)
        cur = conn.cursor()
        feats = compute_video_features_offline(video_id, cur)
        cur.close()
        return feats
    except Exception as e:
        log.error(f"get_video_features error: {e}")
        return defaults
    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass


def build_feature_vector(user_feats: dict, video_feats: dict,
                         session_tag_overlap: float = 0.0,
                         author_affinity: float = 0.0,
                         is_completed_before: float = 0.0,
                         has_liked_before: float = 0.0) -> list:
    """
    Build a 20-dimensional feature vector for a (user, video) pair.
    All values normalized to [0, 1] range.

    Features:
      0  user avg_watch_percent         (0-1)
      1  user like_rate                 (0-1, capped)
      2  user completion_rate           (0-1)
      3  user total_views norm          (log scale, 0-1)
      4  user replay_rate               (0-1)
      5  user comment_rate              (0-1, NEW)
      6  user share_rate                (0-1, NEW)
      7  session_tag_overlap            (0-1, real-time Redis)
      8  author_affinity                (0 or 1)
      9  video like_count norm          (log scale, 0-1)
      10 video comment_count norm       (log scale, 0-1)
      11 video share_count norm         (log scale, 0-1)
      12 video view_count norm          (log scale, 0-1)
      13 video avg_completion           (0-1)
      14 video freshness_score          (1/sqrt(hours), 0-1)
      15 video duration norm            (0-1, cap at 300s)
      16 video engagement_velocity norm (log scale, 0-1)
      17 video like_to_view_ratio       (0-1, NEW)
      18 video comment_to_view_ratio    (0-1, NEW)
      19 is_completed_by_user_before    (0 or 1, NEW interaction)
    """
    def log_norm(x, cap=10000):
        return min(float(np.log1p(max(x, 0)) / np.log1p(cap)), 1.0)

    freshness = 1.0 / (float(video_feats.get("freshness_hours", 9999)) ** 0.5 + 1e-6)
    freshness = min(freshness, 1.0)

    return [
        # User features (indices 0-8)
        min(float(user_feats.get("avg_watch_percent", 0)), 1.0),
        min(float(user_feats.get("like_rate", 0)), 1.0),
        min(float(user_feats.get("completion_rate", 0)), 1.0),
        log_norm(user_feats.get("total_views", 0), 1000),
        min(float(user_feats.get("replay_rate", 0)), 1.0),
        min(float(user_feats.get("comment_rate", 0)), 1.0),  # NEW
        min(float(user_feats.get("share_rate", 0)), 1.0),    # NEW
        min(float(session_tag_overlap), 1.0),
        min(float(author_affinity), 1.0),
        # Video features (indices 9-18)
        log_norm(video_feats.get("like_count", 0), 10000),
        log_norm(video_feats.get("comment_count", 0), 1000),
        log_norm(video_feats.get("share_count", 0), 1000),
        log_norm(video_feats.get("view_count", 0), 100000),
        min(float(video_feats.get("avg_completion", 0)), 1.0),
        freshness,
        min(float(video_feats.get("duration", 60)) / 300.0, 1.0),
        log_norm(video_feats.get("engagement_velocity", 0), 100),
        min(float(video_feats.get("like_to_view_ratio", 0)), 1.0),    # NEW
        min(float(video_feats.get("comment_to_view_ratio", 0)), 1.0), # NEW
        # Interaction feature (index 19) - strong engagement: completed watch OR explicitly liked
        min(float(max(is_completed_before, has_liked_before)), 1.0),
    ]


def get_soft_label(watch_percent: float, is_liked: bool) -> float:
    """
    4-tier soft label scheme for training.

    Tier 4 (1.0)  : watch >= 0.9 or user explicitly liked -> strong engagement
    Tier 3 (0.7)  : watch >= 0.7                          -> completed watch
    Tier 2 (0.3)  : watch 0.2-0.7                        -> partial engagement
    Tier 1 (0.0)  : watch < 0.2                          -> skip / rejection

    Soft labels reduce overconfidence and improve calibration on borderline cases.
    BCELoss still works correctly with float targets in [0, 1].
    """
    if is_liked or watch_percent >= 0.9:
        return 1.0
    elif watch_percent >= 0.7:
        return 0.7
    elif watch_percent >= 0.2:
        return 0.3
    else:
        return 0.0


# ── Real-time session signals (Redis) ─────────────────────────────────────────

def record_view_signal(user_id: str, video_id: str, watch_percent: float, hashtags: list):
    """
    Write real-time session signal to Redis when user watches a video.
    Called from Go backend via POST /signal/view
    """
    rdb = get_redis()
    if rdb is None:
        return
    pipe = rdb.pipeline()
    pipe.lpush(f"session:{user_id}:watches", video_id)
    pipe.ltrim(f"session:{user_id}:watches", 0, 19)
    pipe.expire(f"session:{user_id}:watches", 3600)
    for tag in hashtags:
        pipe.zincrby(f"session:{user_id}:tags", watch_percent, tag)
    pipe.expire(f"session:{user_id}:tags", 3600)
    pipe.execute()


def get_session_signals(user_id: str) -> dict:
    """
    Read real-time session signals from Redis.
    """
    rdb = get_redis()
    if rdb is None:
        return {"recent_watches": [], "top_tags": []}
    recent   = rdb.lrange(f"session:{user_id}:watches", 0, 19) or []
    top_tags = rdb.zrevrange(f"session:{user_id}:tags", 0, 9)  or []
    return {"recent_watches": recent, "top_tags": top_tags}


def compute_session_tag_overlap(video_hashtags: list, session_top_tags: list) -> float:
    if not video_hashtags or not session_top_tags:
        return 0.0
    overlap = len(set(video_hashtags) & set(session_top_tags))
    return min(overlap / max(len(session_top_tags), 1), 1.0)


# ── Training ───────────────────────────────────────────────────────────────────

def train_ranker(epochs: int = TRAIN_EPOCHS,
                 lr: float = TRAIN_LR,
                 dropout_l1: float = DROPOUT_L1,
                 dropout_l2: float = DROPOUT_L2,
                 dropout_l3: float = DROPOUT_L3,
                 optimizer_name: str = TRAIN_OPTIMIZER):
    """
    Train the neural ranker on existing interaction data from PostgreSQL.

    Label scheme (soft, 4-tier):
      watch >= 0.9 OR liked  -> 1.0  (strong positive)
      watch >= 0.7           -> 0.7  (positive)
      watch 0.2-0.7         -> 0.3  (partial)
      watch <  0.2          -> 0.0  (negative)

    Optimizer: configurable (adam|adamw|sgd|rmsprop) + CosineAnnealingLR scheduler
    Early stopping: patience=EARLY_STOP_PATIENCE epochs without improvement
    Hyperparams configurable via env or POST body overrides.
    """
    global ranker_model, ranker_trained
    log.info(f"Training neural ranker: epochs={epochs} lr={lr} "
             f"dropout=({dropout_l1},{dropout_l2},{dropout_l3})")
    t0 = time.time()

    try:
        conn = get_db(autocommit=True)
        cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)

        # Fetch all views with like status for soft labels
        cur.execute("""
            SELECT vv.user_id::text, vv.video_id::text,
                   MAX(vv.watch_percent) AS watch_percent,
                   BOOL_OR(vl.video_id IS NOT NULL) AS is_liked
            FROM video_views vv
            LEFT JOIN video_likes vl
              ON vl.user_id = vv.user_id AND vl.video_id = vv.video_id
            GROUP BY vv.user_id, vv.video_id
        """)
        rows = cur.fetchall()

        if len(rows) < 10:
            log.warning(f"Not enough training data ({len(rows)} samples). Need at least 10.")
            cur.close(); conn.close()
            return {"status": "insufficient_data", "samples": len(rows)}

        # Build feature matrix with soft labels
        X, y = [], []
        for row in rows:
            uid      = str(row["user_id"])
            vid      = str(row["video_id"])
            wp       = float(row["watch_percent"] or 0)
            is_liked = bool(row["is_liked"])
            label    = get_soft_label(wp, is_liked)

            u_feats = get_user_features(uid)
            v_feats = get_video_features(vid)

            # is_completed_before derived from this user's own watch_percent
            completed_before = 1.0 if wp >= 0.7 else 0.0

            fv = build_feature_vector(
                u_feats, v_feats,
                session_tag_overlap=0.0,
                author_affinity=0.0,
                is_completed_before=completed_before,
                has_liked_before=1.0 if is_liked else 0.0,
            )
            X.append(fv)
            y.append(label)

        cur.close(); conn.close()

        n = len(X)
        positives = sum(1 for lbl in y if lbl >= 0.7)
        partials  = sum(1 for lbl in y if 0.0 < lbl < 0.7)
        negatives = sum(1 for lbl in y if lbl == 0.0)
        log.info(f"Training on {n} samples | strong_pos={positives} partial={partials} neg={negatives}")

        X_tensor = torch.tensor(X, dtype=torch.float32)
        y_tensor = torch.tensor(y, dtype=torch.float32)

        # Build fresh model with tuned dropout
        model     = NeuralRanker(FEATURE_DIM, dropout_l1, dropout_l2, dropout_l3)
        _opt = optimizer_name.lower()
        if _opt == "adamw":
            optimizer = optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
        elif _opt == "sgd":
            optimizer = optim.SGD(model.parameters(), lr=lr,
                                  momentum=0.9, weight_decay=1e-4, nesterov=True)
        elif _opt == "rmsprop":
            optimizer = optim.RMSprop(model.parameters(), lr=lr,
                                      momentum=0.9, weight_decay=1e-5)
        else:  # default: adam
            optimizer = optim.Adam(model.parameters(), lr=lr, weight_decay=1e-5)
        log.info(f"Optimizer: {_opt}  lr={lr}")
        scheduler = CosineAnnealingLR(optimizer, T_max=epochs, eta_min=lr * 0.01)
        criterion = nn.BCELoss()

        # Training loop with early stopping
        best_loss    = float("inf")
        best_state   = None
        patience_ctr = 0
        epoch        = 0

        model.train()
        for epoch in range(epochs):
            optimizer.zero_grad()
            preds = model(X_tensor)
            loss  = criterion(preds, y_tensor)
            loss.backward()
            optimizer.step()
            scheduler.step()

            current_loss = loss.item()
            if (epoch + 1) % 10 == 0:
                log.info(f"  Epoch {epoch+1}/{epochs}  loss={current_loss:.4f}  "
                         f"lr={scheduler.get_last_lr()[0]:.6f}")

            # Early stopping
            if current_loss < best_loss - 1e-5:
                best_loss    = current_loss
                best_state   = {k: v.clone() for k, v in model.state_dict().items()}
                patience_ctr = 0
            else:
                patience_ctr += 1
                if patience_ctr >= EARLY_STOP_PATIENCE:
                    log.info(f"  Early stopping at epoch {epoch+1} "
                             f"(no improvement for {EARLY_STOP_PATIENCE} epochs)")
                    break

        # Restore best weights
        if best_state:
            model.load_state_dict(best_state)

        # Evaluate (hard accuracy: threshold at 0.5, positive = label >= 0.7)
        model.eval()
        with torch.no_grad():
            preds     = model(X_tensor)
            hard_pred = (preds > 0.5).float()
            hard_true = (y_tensor >= 0.7).float()
            accuracy  = (hard_pred == hard_true).float().mean().item()
            avg_pred  = preds.mean().item()

        # Save
        torch.save(model.state_dict(), MODEL_PATH)

        with ranker_lock:
            ranker_model = NeuralRanker(FEATURE_DIM, dropout_l1, dropout_l2, dropout_l3)
            ranker_model.load_state_dict(model.state_dict())
            ranker_model.eval()
            ranker_trained = True

        epochs_ran = epoch + 1
        elapsed    = time.time() - t0
        log.info(f"Training done: {n} samples, accuracy={accuracy:.3f}, "
                 f"best_loss={best_loss:.4f}, epochs_ran={epochs_ran} ({elapsed:.1f}s)")
        return {
            "status":           "trained",
            "samples":          n,
            "accuracy":         round(accuracy, 4),
            "best_loss":        round(best_loss, 4),
            "avg_pred_score":   round(avg_pred, 4),
            "epochs_requested": epochs,
            "epochs_ran":       epochs_ran,
            "early_stopped":    epochs_ran < epochs,
            "elapsed_sec":      round(elapsed, 1),
            "label_distribution": {
                "strong_positive_1.0": positives,
                "partial_0.3":         partials,
                "negative_0.0":        negatives,
            },
            "hyperparams": {
                "lr":         lr,
            "optimizer":  optimizer_name,
                "dropout_l1": dropout_l1,
                "dropout_l2": dropout_l2,
                "dropout_l3": dropout_l3,
            },
        }

    except Exception as e:
        log.error(f"Training error: {e}")
        return {"status": "error", "error": str(e)}


# ── CF Model ───────────────────────────────────────────────────────────────────
cf_lock = threading.RLock()
cf_model = {
    "video_ids": [], "user_ids": [], "video_index": {}, "user_index": {},
    "interaction_matrix": None, "similarity_matrix": None,
    "trending_ids": [], "last_built": 0,
    "video_to_author": {},
    "follow_graph": {},    # follower_id -> set of following_ids
}

def build_interaction_score(watch_percent: float, is_liked: bool) -> float:
    score = 0.0
    if watch_percent >= 0.9:   score = 3.0
    elif watch_percent >= 0.7: score = 2.0
    elif watch_percent >= 0.5: score = 1.5
    elif watch_percent >= 0.2: score = 0.5
    elif watch_percent > 0:    score = 0.1
    if is_liked: score += 2.0
    return score

def rebuild_cf_model():
    log.info("Rebuilding CF model...")
    t0 = time.time()
    try:
        conn = get_db(autocommit=True)
        cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
        cur.execute("""
            SELECT vv.user_id, vv.video_id, MAX(vv.watch_percent) AS watch_percent
            FROM video_views vv GROUP BY vv.user_id, vv.video_id
        """)
        watch_rows = cur.fetchall()
        cur.execute("SELECT user_id, video_id FROM video_likes")
        like_rows = cur.fetchall()
        cur.execute("""
            SELECT id FROM videos WHERE is_published = true
            ORDER BY (like_count*3 + comment_count*5 + share_count*7 + view_count*0.1)
                     * POWER(EXTRACT(EPOCH FROM (NOW()-created_at+INTERVAL '1 hour'))/3600.0,-0.5) DESC
            LIMIT 100
        """)
        trending = [r["id"] for r in cur.fetchall()]
        cur.execute("SELECT id, user_id FROM videos WHERE is_published = true")
        video_to_author = {str(r["id"]): str(r["user_id"]) for r in cur.fetchall()}
        # Follow graph: follower -> set of users they follow
        cur.execute("SELECT follower_id, following_id FROM follows")
        follow_graph: dict = {}
        for fr in cur.fetchall():
            fid = str(fr["follower_id"])
            fing = str(fr["following_id"])
            follow_graph.setdefault(fid, set()).add(fing)
        cur.close(); conn.close()

        interactions = {}
        for row in watch_rows:
            key = (str(row["user_id"]), str(row["video_id"]))
            interactions[key] = build_interaction_score(float(row["watch_percent"] or 0), False)
        for row in like_rows:
            key = (str(row["user_id"]), str(row["video_id"]))
            interactions[key] = interactions.get(key, 0.0) + 2.0

        if not interactions:
            with cf_lock:
                cf_model["trending_ids"] = trending
                cf_model["last_built"] = time.time()
            return

        all_users  = sorted(set(k[0] for k in interactions))
        all_videos = sorted(set(k[1] for k in interactions))
        user_index  = {u: i for i, u in enumerate(all_users)}
        video_index = {v: i for i, v in enumerate(all_videos)}

        rows_idx, cols_idx, data = [], [], []
        for (uid, vid), score in interactions.items():
            rows_idx.append(user_index[uid])
            cols_idx.append(video_index[vid])
            data.append(score)
        mat = csr_matrix((data, (rows_idx, cols_idx)),
                         shape=(len(all_users), len(all_videos)), dtype=np.float32)

        item_mat = mat.T
        norms = np.sqrt(np.array(item_mat.power(2).sum(axis=1)).flatten())
        norms[norms == 0] = 1.0
        dot = (item_mat @ item_mat.T).toarray()
        sim_matrix = dot / np.outer(norms, norms)
        np.fill_diagonal(sim_matrix, 0)

        with cf_lock:
            cf_model.update({
                "video_ids": all_videos, "user_ids": all_users,
                "video_index": video_index, "user_index": user_index,
                "interaction_matrix": mat, "similarity_matrix": sim_matrix,
                "trending_ids": trending, "video_to_author": video_to_author,
                "follow_graph": follow_graph, "last_built": time.time(),
            })
        log.info(f"CF rebuilt: {len(all_users)} users, {len(all_videos)} videos, "
                 f"{len(follow_graph)} followers indexed ({time.time()-t0:.2f}s)")
    except Exception as e:
        log.error(f"CF rebuild error: {e}")

def cf_score_for_user(user_id: str, limit: int, exclude_seen: bool = True):
    with cf_lock:
        sim_matrix      = cf_model["similarity_matrix"]
        video_ids       = cf_model["video_ids"]
        user_index      = cf_model["user_index"]
        int_matrix      = cf_model["interaction_matrix"]
        trending_ids    = cf_model["trending_ids"]
        # published_ids: only videos with is_published=true (from video_to_author)
        published_ids   = set(cf_model.get("video_to_author", {}).keys())
        follow_graph    = cf_model.get("follow_graph", {})

    if sim_matrix is None or user_id not in user_index:
        # Weighted shuffle: higher-ranked items more likely to stay near top,
        # but not pinned to exact position 1 -- prevents new videos from
        # always appearing first just because freshness score is maximal.
        pool = trending_ids[:min(limit * 3, len(trending_ids))]
        weights = [1.0 / (i + 1) for i in range(len(pool))]
        shuffled = random.choices(pool, weights=weights, k=min(limit, len(pool)))
        seen_shuffle: set = set()
        deduped = []
        for v in shuffled:
            if v not in seen_shuffle:
                seen_shuffle.add(v)
                deduped.append(v)
        # Top-up with remaining trending if deduped < limit
        for v in pool:
            if len(deduped) >= limit: break
            if v not in seen_shuffle:
                deduped.append(v)
        return deduped[:limit], "trending_fallback"


    user_row = user_index[user_id]
    user_vec = int_matrix[user_row]
    interacted = set(user_vec.nonzero()[1].tolist())
    if not interacted:
        return trending_ids[:limit], "trending_fallback"

    n = len(video_ids)
    scores = np.zeros(n, dtype=np.float32)
    user_data = user_vec.toarray().flatten()
    for col in interacted:
        scores += user_data[col] * sim_matrix[:, col]
    if exclude_seen:
        for col in interacted:
            scores[col] = -1.0

    # ── Social CF: blend in signals from followed users (weight=0.3) ──────────
    # For each user the current user follows, add a dampened version of their
    # interaction vector. This surfaces videos popular among followed creators.
    FOLLOW_BLEND_WEIGHT = 0.3
    followed_users = follow_graph.get(user_id, set())
    if followed_users:
        social_scores = np.zeros(n, dtype=np.float32)
        n_followed = 0
        for fuid in followed_users:
            if fuid not in user_index:
                continue
            frow = user_index[fuid]
            fvec = int_matrix[frow].toarray().flatten()
            social_scores += fvec
            n_followed += 1
        if n_followed > 0:
            social_scores /= n_followed          # average across followed users
            # Normalise to same scale as CF scores
            s_max = social_scores.max()
            if s_max > 0:
                social_scores = social_scores / s_max * float(scores.max() or 1.0)
            scores += FOLLOW_BLEND_WEIGHT * social_scores
            log.debug(f"Social CF blended {n_followed} followed users for {user_id}")

    # Zero out scores for unpublished videos so they never surface in recommendations
    if published_ids:
        for col, vid in enumerate(video_ids):
            if vid not in published_ids:
                scores[col] = -1.0

    ranked = np.argsort(scores)[::-1]
    result = []
    for idx in ranked:
        if len(result) >= limit: break
        if scores[idx] <= 0: break
        result.append(video_ids[idx])

    if len(result) < limit:
        # When cycling (exclude_seen=False), don't block top-up on already-seen videos
        # so the feed never runs dry. Only block own videos.
        if exclude_seen:
            seen_set = set(result) | {video_ids[c] for c in interacted}
        else:
            seen_set = set(result)
        # Weighted-shuffle trending pool before top-up so new videos
        # don't always pin to position 1 due to max freshness score.
        remaining_needed = limit - len(result)
        topup_pool = [t for t in trending_ids if t not in seen_set]
        if topup_pool:
            topup_weights = [1.0 / (i + 1) for i in range(len(topup_pool))]
            topup_shuffled = random.choices(topup_pool, weights=topup_weights,
                                            k=min(remaining_needed * 2, len(topup_pool)))
            seen_topup: set = set()
            for tid in topup_shuffled:
                if len(result) >= limit: break
                if tid not in seen_topup and tid not in seen_set:
                    seen_topup.add(tid)
                    result.append(tid)
            # Fill remainder in strict order if still short
            for tid in topup_pool:
                if len(result) >= limit: break
                if tid not in seen_set and tid not in seen_topup:
                    result.append(tid)

    return result, "cf"


# ── Flask Endpoints ────────────────────────────────────────────────────────────

@app.route("/health")
def health():
    with cf_lock:
        return jsonify({
            "status":         "ok",
            "indexed_users":  len(cf_model["user_ids"]),
            "indexed_videos": len(cf_model["video_ids"]),
            "cf_last_built":  cf_model["last_built"],
            "ranker_trained": ranker_trained,
            "feature_dim":    FEATURE_DIM,
            "model_path":     MODEL_PATH,
            "train_epochs":   TRAIN_EPOCHS,
            "train_lr":       TRAIN_LR,
            "train_optimizer": TRAIN_OPTIMIZER,
            "follow_graph_users": len(cf_model.get("follow_graph", {})),
            "dropout":        [DROPOUT_L1, DROPOUT_L2, DROPOUT_L3],
        })


@app.route("/recommend", methods=["POST"])
def recommend():
    """CF-based recall. Returns ranked video_ids."""
    body         = request.get_json(force=True, silent=True) or {}
    user_id      = body.get("user_id", "")
    limit        = int(body.get("limit", 10))
    exclude_seen = bool(body.get("exclude_seen", True))
    if not user_id:
        return jsonify({"error": "user_id required"}), 400
    video_ids, source = cf_score_for_user(user_id, limit, exclude_seen=exclude_seen)
    return jsonify({"video_ids": video_ids, "source": source})


@app.route("/rank", methods=["POST"])
def rank():
    """
    Neural ranker endpoint.
    Scores a list of candidate video_ids for a user using the trained model.
    Falls back to CF ordering if model not trained.

    Body: {"user_id": "uuid", "candidate_ids": ["uuid", ...]}
    Returns: {"ranked_ids": [...], "scores": [...], "source": "ranker"|"cf_fallback"}
    """
    body          = request.get_json(force=True, silent=True) or {}
    user_id       = body.get("user_id", "")
    candidate_ids = body.get("candidate_ids", [])

    if not user_id or not candidate_ids:
        return jsonify({"error": "user_id and candidate_ids required"}), 400

    if not ranker_trained:
        log.info(f"/rank fallback to CF (not trained) for user {user_id}")
        return jsonify({
            "ranked_ids": candidate_ids,
            "scores":     [0.5] * len(candidate_ids),
            "source":     "cf_fallback",
        })

    u_feats  = get_user_features(user_id)
    session  = get_session_signals(user_id)
    top_tags = session["top_tags"]
    recent_watches = set(session["recent_watches"])

    author_affinity_cache = {}
    try:
        conn = get_db(autocommit=True)
        cur  = conn.cursor()
        # 1) Engagement-based affinity: authors of recently watched videos => 1.0
        if recent_watches:
            cur.execute("SELECT id, user_id FROM videos WHERE id = ANY(%s)",
                        (list(recent_watches),))
            for r in cur.fetchall():
                author_affinity_cache[str(r[1])] = 1.0
        # 2) Follow-based affinity: followed authors not yet engaged => 0.5
        cur.execute(
            "SELECT following_id FROM follows WHERE follower_id = %s", (user_id,)
        )
        for r in cur.fetchall():
            aid = str(r[0])
            # Only set 0.5 if not already 1.0 from engagement
            if aid not in author_affinity_cache:
                author_affinity_cache[aid] = 0.5
        cur.close(); conn.close()
    except Exception as e:
        log.warning(f"Author affinity lookup failed: {e}")

    # Get user's completed and liked videos for interaction features
    user_completed_set = set()
    user_liked_set     = set()
    try:
        conn = get_db(autocommit=True)
        cur  = conn.cursor()
        cur.execute("""
            SELECT video_id FROM video_views
            WHERE user_id = %s AND watch_percent >= 0.7
        """, (user_id,))
        user_completed_set = {str(r[0]) for r in cur.fetchall()}
        cur.execute("SELECT video_id FROM video_likes WHERE user_id = %s", (user_id,))
        user_liked_set = {str(r[0]) for r in cur.fetchall()}
        cur.close(); conn.close()
    except Exception as e:
        log.warning(f"Interaction feature lookup failed: {e}")

    feature_vectors = []
    for vid in candidate_ids:
        v_feats    = get_video_features(vid)
        v_hashtags = []
        try:
            conn = get_db(autocommit=True)
            cur  = conn.cursor()
            cur.execute("SELECT hashtags, user_id FROM videos WHERE id = %s", (vid,))
            row = cur.fetchone()
            if row:
                v_hashtags = list(row[0]) if row[0] else []
                author_affinity_cache.setdefault(str(row[1]), 0.0)
            cur.close(); conn.close()
        except Exception:
            pass

        tag_overlap   = compute_session_tag_overlap(v_hashtags, top_tags)
        author_aff    = author_affinity_cache.get(vid, 0.0)
        completed_bef = 1.0 if vid in user_completed_set else 0.0
        liked_bef     = 1.0 if vid in user_liked_set     else 0.0

        fv = build_feature_vector(
            u_feats, v_feats, tag_overlap, author_aff,
            completed_bef, liked_bef,
        )
        feature_vectors.append(fv)

    X = torch.tensor(feature_vectors, dtype=torch.float32)
    with ranker_lock:
        ranker_model.eval()
        with torch.no_grad():
            scores = ranker_model(X).tolist()

    ranked_pairs  = sorted(zip(candidate_ids, scores), key=lambda x: x[1], reverse=True)
    ranked_ids    = [p[0] for p in ranked_pairs]
    ranked_scores = [round(p[1], 4) for p in ranked_pairs]

    log.info(f"/rank user={user_id} candidates={len(candidate_ids)} "
             f"top_score={ranked_scores[0] if ranked_scores else 0}")
    return jsonify({"ranked_ids": ranked_ids, "scores": ranked_scores, "source": "ranker"})


@app.route("/train", methods=["POST"])
def train():
    """
    Trigger neural ranker training.

    Optional body overrides:
      {
        "epochs":     150,
        "lr":         0.003,
        "dropout_l1": 0.3,
        "dropout_l2": 0.25,
        "dropout_l3": 0.15
      }
    """
    body   = request.get_json(force=True, silent=True) or {}
    result = train_ranker(
        epochs         = int(body.get("epochs",         TRAIN_EPOCHS)),
        lr             = float(body.get("lr",             TRAIN_LR)),
        dropout_l1     = float(body.get("dropout_l1",     DROPOUT_L1)),
        dropout_l2     = float(body.get("dropout_l2",     DROPOUT_L2)),
        dropout_l3     = float(body.get("dropout_l3",     DROPOUT_L3)),
        optimizer_name = str(body.get("optimizer",       TRAIN_OPTIMIZER)).lower(),
    )
    return jsonify(result)


@app.route("/signal/view", methods=["POST"])
def signal_view():
    """
    Record real-time view signal to Redis.
    Called by Go backend after user watches a video.
    Body: {"user_id": "uuid", "video_id": "uuid", "watch_percent": 0.85, "hashtags": [...]}
    """
    body          = request.get_json(force=True, silent=True) or {}
    user_id       = body.get("user_id", "")
    video_id      = body.get("video_id", "")
    watch_percent = float(body.get("watch_percent", 0))
    hashtags      = body.get("hashtags", [])
    if not user_id or not video_id:
        return jsonify({"error": "user_id and video_id required"}), 400
    record_view_signal(user_id, video_id, watch_percent, hashtags)
    return jsonify({"status": "ok"})




@app.route("/signal/search", methods=["POST"])
def signal_search():
    """
    Record a search-intent signal to Redis session state.
    Called by Go backend when an authenticated user performs a search.
    Body: {"user_id": "uuid", "query": "cats playing piano", "keywords": ["cats", "playing", "piano"]}

    Treats search keywords as implicit interest signals - adds them to the user's session tag set
    with a moderate weight (0.5) so subsequent /recommend calls boost matching videos.
    Lower weight than watch_percent signals since search intent is weaker than completed views.
    """
    body     = request.get_json(force=True, silent=True) or {}
    user_id  = body.get("user_id", "")
    keywords = body.get("keywords", [])

    if not user_id or not keywords:
        return jsonify({"error": "user_id and keywords required"}), 400

    if rdb is None:
        return jsonify({"status": "ok", "note": "redis unavailable - signal dropped"})

    try:
        pipe = rdb.pipeline()
        # Add each keyword to the session tag set with weight 0.5 (moderate intent signal)
        SEARCH_SIGNAL_WEIGHT = 0.5
        for kw in keywords:
            kw = kw.lower().strip().lstrip("#")
            if len(kw) >= 2:
                pipe.zincrby(f"session:{user_id}:tags", SEARCH_SIGNAL_WEIGHT, kw)
        pipe.expire(f"session:{user_id}:tags", 3600)
        pipe.execute()
        log.debug(f"search signal: user={user_id} keywords={keywords}")
    except Exception as e:
        log.warning(f"signal_search redis error: {e}")

    return jsonify({"status": "ok"})

@app.route("/metrics")
def metrics():
    """
    Recommendation quality monitoring endpoint.
    """
    result = {
        "ranker": {
            "trained":       ranker_trained,
            "model_path":    MODEL_PATH,
            "model_exists":  os.path.exists(MODEL_PATH),
            "model_size_kb": round(os.path.getsize(MODEL_PATH) / 1024, 1) if os.path.exists(MODEL_PATH) else 0,
            "feature_dim":   FEATURE_DIM,
            "hyperparams": {
                "epochs":     TRAIN_EPOCHS,
                "lr":         TRAIN_LR,
                "dropout_l1": DROPOUT_L1,
                "dropout_l2": DROPOUT_L2,
                "dropout_l3": DROPOUT_L3,
            },
        },
        "cf_model": {
            "indexed_users":  len(cf_model["user_ids"]),
            "indexed_videos": len(cf_model["video_ids"]),
            "last_built":     cf_model["last_built"],
            "trending_count": len(cf_model["trending_ids"]),
        },
        "database": {},
        "feature_store": {},
    }

    try:
        conn = get_db(autocommit=True)
        cur  = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM video_views")
        result["database"]["total_views"] = cur.fetchone()[0]
        cur.execute("SELECT COUNT(*) FROM video_likes")
        result["database"]["total_likes"] = cur.fetchone()[0]
        cur.execute("SELECT COUNT(*) FROM videos WHERE is_published=true")
        result["database"]["total_videos"] = cur.fetchone()[0]
        cur.execute("SELECT COUNT(*) FROM users")
        result["database"]["total_users"] = cur.fetchone()[0]

        # Soft-label distribution
        cur.execute("""
            SELECT
              SUM(CASE WHEN wp >= 0.9 OR is_liked THEN 1 ELSE 0 END) AS tier4,
              SUM(CASE WHEN wp >= 0.7 AND wp < 0.9 AND NOT is_liked THEN 1 ELSE 0 END) AS tier3,
              SUM(CASE WHEN wp >= 0.2 AND wp < 0.7 THEN 1 ELSE 0 END) AS tier2,
              SUM(CASE WHEN wp < 0.2 THEN 1 ELSE 0 END) AS tier1
            FROM (
              SELECT
                MAX(vv.watch_percent) AS wp,
                BOOL_OR(vl.video_id IS NOT NULL) AS is_liked
              FROM video_views vv
              LEFT JOIN video_likes vl ON vl.user_id=vv.user_id AND vl.video_id=vv.video_id
              GROUP BY vv.user_id, vv.video_id
            ) t
        """)
        row = cur.fetchone()
        if row:
            t4, t3, t2, t1 = (int(x or 0) for x in row)
            total = t4 + t3 + t2 + t1
            result["database"]["soft_label_distribution"] = {
                "tier4_strong_pos_1.0": t4,
                "tier3_positive_0.7":   t3,
                "tier2_partial_0.3":    t2,
                "tier1_negative_0.0":   t1,
                "total":                total,
                "ready_to_train":       total >= 10,
            }

        cur.execute("""
            SELECT ROUND(AVG(avg_pct)::numeric, 3)
            FROM (SELECT AVG(watch_percent) AS avg_pct FROM video_views GROUP BY video_id) t
        """)
        avg_row = cur.fetchone()
        result["database"]["avg_watch_percent_across_videos"] = float(avg_row[0] or 0)

        cur.close()
        conn.close()
    except Exception as e:
        result["database"]["error"] = str(e)

    rdb = get_redis()
    if rdb:
        try:
            user_keys    = len(rdb.keys("feat:user:*"))
            video_keys   = len(rdb.keys("feat:video:*"))
            session_keys = len(rdb.keys("session:*"))
            result["feature_store"] = {
                "status":          "connected",
                "cached_users":    user_keys,
                "cached_videos":   video_keys,
                "active_sessions": session_keys,
                "redis_info":      rdb.info("memory").get("used_memory_human", "unknown"),
            }
        except Exception as e:
            result["feature_store"] = {"status": "error", "error": str(e)}
    else:
        result["feature_store"] = {"status": "unavailable"}

    return jsonify(result)


# ── Background threads ─────────────────────────────────────────────────────────

def background_cf_rebuild():
    while True:
        time.sleep(REBUILD_INTERVAL)
        rebuild_cf_model()

def background_feature_sync():
    while True:
        time.sleep(FEATURE_SYNC_INTERVAL)
        sync_features_to_redis()

# ── Startup ────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    rebuild_cf_model()
    sync_features_to_redis()
    load_ranker()

    threading.Thread(target=background_cf_rebuild, daemon=True).start()
    threading.Thread(target=background_feature_sync, daemon=True).start()

    port = int(os.environ.get("RECOMMENDER_PORT", 8090))
    log.info(f"Recommender service starting on port {port}")
    log.info(f"Config: FEATURE_DIM={FEATURE_DIM}, TRAIN_EPOCHS={TRAIN_EPOCHS}, "
             f"TRAIN_LR={TRAIN_LR}, DROPOUT=({DROPOUT_L1},{DROPOUT_L2},{DROPOUT_L3})")
    app.run(host="0.0.0.0", port=port, debug=False)
