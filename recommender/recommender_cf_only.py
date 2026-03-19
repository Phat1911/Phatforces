"""
Photcot Recommender Service - CF-Only Mode (Port 8090)
=======================================================
Item-Item Collaborative Filtering + Redis feature store.
Neural ranker (PyTorch) removed for low-RAM VM compatibility.
"""

import os, time, logging, threading, json, random
import numpy as np
import psycopg2, psycopg2.extras
import redis as redis_lib
from flask import Flask, request, jsonify
from scipy.sparse import csr_matrix

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("recommender")

app = Flask(__name__)

# ── Config ─────────────────────────────────────────────────────────────────────
DB_DSN              = os.getenv("DB_DSN", "postgresql://photcot:photcot@localhost:5432/photcot?sslmode=disable")
REDIS_HOST          = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT          = int(os.getenv("REDIS_PORT", "6379"))
REDIS_TTL           = int(os.getenv("REDIS_TTL", "3600"))
CF_REBUILD_INTERVAL = int(os.getenv("CF_REBUILD_INTERVAL", "120"))
FEATURE_SYNC_INTERVAL = int(os.getenv("FEATURE_SYNC_INTERVAL", "300"))

# ── DB / Redis helpers ─────────────────────────────────────────────────────────
def get_db(autocommit=False):
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

# ── CF Model ───────────────────────────────────────────────────────────────────
cf_model = {
    "sim_matrix":   None,
    "user_ids":     [],
    "video_ids":    [],
    "user_index":   {},
    "video_index":  {},
    "user_videos":  {},
    "trending_ids": [],
    "video_to_author": {},
    "last_built":   None,
}
cf_lock = threading.RLock()

def build_interaction_score(watch_percent: float, is_liked: bool) -> float:
    score = watch_percent * 1.0
    if is_liked:
        score += 0.5
    return min(score, 1.5)

def rebuild_cf_model():
    global cf_model
    log.info("Rebuilding CF model...")
    t0 = time.time()
    conn = None
    try:
        conn = get_db(autocommit=True)
        cur  = conn.cursor()

        # Fetch interactions
        cur.execute("""
            SELECT vv.user_id::text, vv.video_id::text,
                   MAX(vv.watch_percent) AS watch_percent,
                   BOOL_OR(vl.video_id IS NOT NULL) AS is_liked
            FROM video_views vv
            LEFT JOIN video_likes vl
                   ON vl.user_id = vv.user_id AND vl.video_id = vv.video_id
            WHERE vv.watch_percent > 0.05
            GROUP BY vv.user_id, vv.video_id
        """)
        rows = cur.fetchall()

        # Fetch trending
        cur.execute("""
            SELECT id::text FROM videos WHERE is_published = true
            ORDER BY (like_count*3 + comment_count*5 + share_count*7 + view_count*0.1)
                * POWER(EXTRACT(EPOCH FROM (NOW()-created_at+INTERVAL '1 hour'))/3600.0,-0.5) DESC
            LIMIT 200
        """)
        trending_ids = [r[0] for r in cur.fetchall()]

        # video_to_author map
        cur.execute("SELECT id::text, user_id::text FROM videos WHERE is_published=true")
        video_to_author = {r[0]: r[1] for r in cur.fetchall()}

        # follow graph
        cur.execute("SELECT follower_id::text, following_id::text FROM follows")
        follow_graph = {}
        for follower, following in cur.fetchall():
            follow_graph.setdefault(follower, set()).add(following)

        cur.close()

        if not rows:
            with cf_lock:
                cf_model["trending_ids"]    = trending_ids
                cf_model["video_to_author"] = video_to_author
                cf_model["last_built"]      = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            log.info("CF model: no interactions yet, trending fallback only")
            return

        # Build index
        user_set  = sorted({r[0] for r in rows})
        video_set = sorted({r[1] for r in rows})
        user_idx  = {u: i for i, u in enumerate(user_set)}
        video_idx = {v: i for i, v in enumerate(video_set)}

        # user->videos map for exclusion
        user_videos = {}
        for uid, vid, wp, liked in rows:
            user_videos.setdefault(uid, set()).add(vid)

        # Build interaction matrix (users x videos)
        row_i, col_i, data = [], [], []
        for uid, vid, wp, liked in rows:
            score = build_interaction_score(float(wp), bool(liked))
            row_i.append(user_idx[uid])
            col_i.append(video_idx[vid])
            data.append(score)

        n_users  = len(user_set)
        n_videos = len(video_set)
        mat = csr_matrix((data, (row_i, col_i)), shape=(n_users, n_videos))

        # Item-item cosine similarity (videos x videos)
        # Normalize columns (videos) by L2 norm
        video_mat = mat.T.tocsr()  # shape: videos x users
        norms = np.sqrt(np.array(video_mat.multiply(video_mat).sum(axis=1))).flatten()
        norms[norms == 0] = 1.0
        from scipy.sparse import diags
        norm_mat   = diags(1.0 / norms)
        video_norm = norm_mat.dot(video_mat)
        sim_matrix = (video_norm.dot(video_norm.T)).toarray()  # videos x videos

        with cf_lock:
            cf_model["sim_matrix"]      = sim_matrix
            cf_model["user_ids"]        = user_set
            cf_model["video_ids"]       = video_set
            cf_model["user_index"]      = user_idx
            cf_model["video_index"]     = video_idx
            cf_model["user_videos"]     = user_videos
            cf_model["trending_ids"]    = trending_ids
            cf_model["video_to_author"] = video_to_author
            cf_model["follow_graph"]    = follow_graph
            cf_model["last_built"]      = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

        elapsed = time.time() - t0
        log.info(f"CF model rebuilt: {n_users} users, {n_videos} videos, {elapsed:.2f}s")

    except Exception as e:
        log.error(f"rebuild_cf_model error: {e}")
    finally:
        if conn:
            try: conn.close()
            except: pass


def cf_score_for_user(user_id: str, limit: int, exclude_seen: bool = True):
    with cf_lock:
        sim        = cf_model["sim_matrix"]
        user_idx   = cf_model["user_index"]
        video_ids  = cf_model["video_ids"]
        video_idx  = cf_model["video_index"]
        user_vids  = cf_model["user_videos"]
        trending   = cf_model["trending_ids"]

    if sim is None or user_id not in user_idx:
        # No CF data - return trending with weighted shuffle
        pool    = trending[:min(limit * 3, len(trending))]
        weights = [1.0 / (i + 1) for i in range(len(pool))]
        if not pool:
            return [], "trending_empty"
        result = []
        seen   = set()
        k = min(limit, len(pool))
        while len(result) < k and pool:
            choice = random.choices(pool, weights=weights[:len(pool)], k=1)[0]
            if choice not in seen:
                result.append(choice)
                seen.add(choice)
        return result, "trending"

    ui      = user_idx[user_id]
    watched = user_vids.get(user_id, set())
    seen_set = set(watched) if exclude_seen else set()

    # Sum similarity scores for all videos the user interacted with
    scores = np.zeros(len(video_ids))
    for vid in watched:
        if vid in video_idx:
            vi = video_idx[vid]
            scores += sim[vi]

    # Zero out already-seen if excluding
    for vid in seen_set:
        if vid in video_idx:
            scores[video_idx[vid]] = 0.0

    # Rank by score
    ranked_indices = np.argsort(scores)[::-1]
    result = []
    for idx in ranked_indices:
        vid = video_ids[idx]
        if vid not in seen_set and scores[idx] > 0:
            result.append(vid)
        if len(result) >= limit:
            break

    # Top-up with trending if not enough
    if len(result) < limit:
        pool    = [v for v in trending if v not in set(result) and v not in seen_set]
        weights = [1.0 / (i + 1) for i in range(len(pool))]
        needed  = limit - len(result)
        added   = set()
        k       = min(needed, len(pool))
        attempts = 0
        while len(added) < k and pool and attempts < k * 3:
            attempts += 1
            choice = random.choices(pool, weights=weights[:len(pool)], k=1)[0]
            if choice not in added:
                result.append(choice)
                added.add(choice)

    source = "cf" if result else "trending"
    return result[:limit], source


# ── Signal helpers ─────────────────────────────────────────────────────────────
def record_view_signal(user_id: str, video_id: str, watch_percent: float, hashtags: list):
    rdb = get_redis()
    if rdb is None:
        return
    try:
        pipe = rdb.pipeline()
        key  = f"session:{user_id}:tags"
        for tag in hashtags:
            tag = tag.lower().strip().lstrip("#")
            if len(tag) >= 2:
                pipe.zincrby(key, watch_percent, tag)
        pipe.expire(key, 3600)
        watches_key = f"session:{user_id}:watches"
        pipe.lpush(watches_key, video_id)
        pipe.ltrim(watches_key, 0, 49)
        pipe.expire(watches_key, 7200)
        pipe.execute()
    except Exception as e:
        log.warning(f"record_view_signal error: {e}")

def get_session_signals(user_id: str) -> dict:
    rdb = get_redis()
    defaults = {"top_tags": [], "recent_watches": []}
    if rdb is None:
        return defaults
    try:
        top_tags = rdb.zrevrange(f"session:{user_id}:tags", 0, 9)
        recent   = rdb.lrange(f"session:{user_id}:watches", 0, 19)
        return {"top_tags": top_tags, "recent_watches": recent}
    except Exception as e:
        log.warning(f"get_session_signals error: {e}")
        return defaults

# ── Feature Store (simplified, no neural ranker) ───────────────────────────────
def compute_user_features_offline(user_id: str, cur) -> dict:
    defaults = {"avg_watch_percent": 0.0, "like_rate": 0.0, "completion_rate": 0.0,
                "total_views": 0, "replay_rate": 0.0, "comment_rate": 0.0, "share_rate": 0.0}
    try:
        cur.execute("""
            SELECT COUNT(*) AS total_views,
                   AVG(watch_percent) AS avg_watch,
                   SUM(CASE WHEN watch_percent >= 0.9 THEN 1 ELSE 0 END)::float /
                       NULLIF(COUNT(*), 0) AS completion_rate
            FROM video_views WHERE user_id = %s
        """, (user_id,))
        row = cur.fetchone()
        if not row or row[0] == 0:
            return defaults
        total, avg_watch, comp_rate = row
        cur.execute("SELECT COUNT(*) FROM video_likes WHERE user_id = %s", (user_id,))
        likes = cur.fetchone()[0]
        return {
            "avg_watch_percent": float(avg_watch or 0),
            "like_rate":         float(likes) / max(int(total), 1),
            "completion_rate":   float(comp_rate or 0),
            "total_views":       int(total),
            "replay_rate":       0.0,
            "comment_rate":      0.0,
            "share_rate":        0.0,
        }
    except Exception as e:
        log.warning(f"compute_user_features error: {e}")
        return defaults

def sync_features_to_redis():
    rdb = get_redis()
    if rdb is None:
        return
    conn = None
    try:
        conn = get_db(autocommit=True)
        cur  = conn.cursor()
        cur.execute("SELECT DISTINCT user_id FROM video_views")
        for (uid,) in cur.fetchall():
            uid = str(uid)
            feats = compute_user_features_offline(uid, cur)
            key = f"feat:user:{uid}"
            rdb.hset(key, mapping={k: str(v) for k, v in feats.items()})
            rdb.expire(key, REDIS_TTL)
        cur.close()
    except Exception as e:
        log.error(f"sync_features_to_redis error: {e}")
    finally:
        if conn:
            try: conn.close()
            except: pass

# ── Flask Routes ───────────────────────────────────────────────────────────────
@app.route("/health")
def health():
    with cf_lock:
        return jsonify({
            "status":         "ok",
            "mode":           "cf_only",
            "indexed_users":  len(cf_model["user_ids"]),
            "indexed_videos": len(cf_model["video_ids"]),
            "cf_last_built":  cf_model["last_built"],
            "ranker_trained": False,
        })


@app.route("/recommend", methods=["POST"])
def recommend():
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
    # CF-only stub: return candidates as-is (no neural reranking)
    body          = request.get_json(force=True, silent=True) or {}
    candidate_ids = body.get("candidate_ids", [])
    return jsonify({
        "ranked_ids": candidate_ids,
        "scores":     [0.5] * len(candidate_ids),
        "source":     "cf_fallback",
    })


@app.route("/train", methods=["POST"])
def train():
    return jsonify({"status": "skipped", "reason": "neural ranker disabled in cf_only mode"})


@app.route("/signal/view", methods=["POST"])
def signal_view():
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
    body     = request.get_json(force=True, silent=True) or {}
    user_id  = body.get("user_id", "")
    keywords = body.get("keywords", [])
    if not user_id or not keywords:
        return jsonify({"error": "user_id and keywords required"}), 400
    rdb = get_redis()
    if rdb is None:
        return jsonify({"status": "ok", "note": "redis unavailable"})
    try:
        pipe = rdb.pipeline()
        for kw in keywords:
            kw = kw.lower().strip().lstrip("#")
            if len(kw) >= 2:
                pipe.zincrby(f"session:{user_id}:tags", 0.5, kw)
        pipe.expire(f"session:{user_id}:tags", 3600)
        pipe.execute()
    except Exception as e:
        log.warning(f"signal_search error: {e}")
    return jsonify({"status": "ok"})


@app.route("/metrics")
def metrics():
    result = {
        "mode": "cf_only",
        "ranker": {"trained": False},
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
        cur.close(); conn.close()
    except Exception as e:
        result["database"]["error"] = str(e)
    rdb = get_redis()
    if rdb:
        try:
            result["feature_store"] = {
                "status":        "connected",
                "cached_users":  len(rdb.keys("feat:user:*")),
                "cached_videos": len(rdb.keys("feat:video:*")),
                "active_sessions": len(rdb.keys("session:*")),
            }
        except Exception as e:
            result["feature_store"]["error"] = str(e)
    else:
        result["feature_store"]["status"] = "unavailable"
    return jsonify(result)


# ── Background threads ─────────────────────────────────────────────────────────
def background_cf_rebuild():
    time.sleep(5)
    while True:
        try:
            rebuild_cf_model()
        except Exception as e:
            log.error(f"background_cf_rebuild error: {e}")
        time.sleep(CF_REBUILD_INTERVAL)

def background_feature_sync():
    time.sleep(30)
    while True:
        try:
            sync_features_to_redis()
        except Exception as e:
            log.error(f"background_feature_sync error: {e}")
        time.sleep(FEATURE_SYNC_INTERVAL)


if __name__ == "__main__":
    log.info("Starting Photcot Recommender (CF-only mode)...")
    rebuild_cf_model()
    threading.Thread(target=background_cf_rebuild,  daemon=True).start()
    threading.Thread(target=background_feature_sync, daemon=True).start()
    app.run(host="0.0.0.0", port=8090, threaded=True)
