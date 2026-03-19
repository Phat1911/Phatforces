package handlers

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"math/rand"
	"net/http"
	"os"
	"strconv"
	"photcot/internal/models"
	"github.com/gin-gonic/gin"
	"github.com/lib/pq"
	"github.com/redis/go-redis/v9"
)

type FeedHandler struct {
	db  *sql.DB
	rdb *redis.Client
}

func NewFeedHandler(db *sql.DB, rdb *redis.Client) *FeedHandler {
	return &FeedHandler{db: db, rdb: rdb}
}

// recommenderURL returns the Python CF microservice base URL.
// Defaults to http://localhost:8090 if env var RECOMMENDER_URL is not set.
func recommenderURL() string {
	if u := os.Getenv("RECOMMENDER_URL"); u != "" {
		return u
	}
	return "http://localhost:8090"
}

// neuralRank calls the Python neural ranker to re-score a list of candidate IDs.
// Returns re-ordered IDs. Falls back to original order on any error.
func neuralRank(userID string, candidateIDs []string) ([]string, error) {
	if len(candidateIDs) == 0 {
		return candidateIDs, nil
	}
	payload := map[string]interface{}{
		"user_id":       userID,
		"candidate_ids": candidateIDs,
	}
	body, _ := json.Marshal(payload)
	resp, err := http.Post(
		fmt.Sprintf("%s/rank", recommenderURL()),
		"application/json",
		bytes.NewReader(body),
	)
	if err != nil {
		return nil, fmt.Errorf("ranker unreachable: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var result struct {
		RankedIDs []string  `json:"ranked_ids"`
		Scores    []float64 `json:"scores"`
		Source    string    `json:"source"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, fmt.Errorf("ranker bad response: %w", err)
	}
	log.Printf("Neural rank user=%s source=%s candidates=%d", userID, result.Source, len(result.RankedIDs))
	return result.RankedIDs, nil
}

// SendViewSignal fires a real-time session signal to the Python recommender (non-blocking).
// Called after RecordView so the feature store stays current within the session.
func SendViewSignal(userID, videoID string, watchPercent float64, hashtags []string) {
	go func() {
		payload := map[string]interface{}{
			"user_id":       userID,
			"video_id":      videoID,
			"watch_percent": watchPercent,
			"hashtags":      hashtags,
		}
		body, _ := json.Marshal(payload)
		resp, err := http.Post(
			fmt.Sprintf("%s/signal/view", recommenderURL()),
			"application/json",
			bytes.NewReader(body),
		)
		if err != nil {
			log.Printf("SendViewSignal error: %v", err)
			return
		}
		resp.Body.Close()
	}()
}

// cfRecommend calls the Python CF microservice and returns a ranked list of video IDs.
// Returns nil (no IDs) on any error so the caller can gracefully fall back.
func cfRecommend(userID string, limit int, excludeSeen bool) ([]string, error) {
	payload := map[string]interface{}{
		"user_id":      userID,
		"limit":        limit,
		"exclude_seen": excludeSeen,
	}
	body, _ := json.Marshal(payload)
	resp, err := http.Post(
		fmt.Sprintf("%s/recommend", recommenderURL()),
		"application/json",
		bytes.NewReader(body),
	)
	if err != nil {
		return nil, fmt.Errorf("cf service unreachable: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var result struct {
		VideoIDs []string `json:"video_ids"`
		Source   string   `json:"source"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, fmt.Errorf("cf service bad response: %w", err)
	}
	log.Printf("CF recommend user=%s source=%s returned %d videos", userID, result.Source, len(result.VideoIDs))
	return result.VideoIDs, nil
}

// Public - no auth required, returns trending videos for guest visitors.
func (h *FeedHandler) Public(c *gin.Context) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	if page < 1 {
		page = 1
	}
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "10"))
	if limit < 1 {
		limit = 10
	}
	if limit > 50 {
		limit = 50
	}
	// Fetch all published videos once, then use modulo to page infinitely.
	// This is the guest/public feed - no user context for personalization.
	allRows, err := h.db.Query(`
		WITH ranked AS (
			SELECT v.id, v.user_id, v.title, v.description, v.video_url, v.thumbnail_url,
				v.duration, v.view_count, v.like_count, v.comment_count, v.share_count,
				v.save_count, v.hashtags, v.created_at,
				u.username, u.display_name, u.avatar_url, u.is_verified, u.follower_count,
				ROW_NUMBER() OVER (ORDER BY LN(1 + v.like_count * 3 + v.view_count * 0.1) DESC) AS rn
			FROM videos v JOIN users u ON u.id = v.user_id
			WHERE v.is_published = true
		)
		SELECT id, user_id, title, description, video_url, thumbnail_url,
			duration, view_count, like_count, comment_count, share_count,
			save_count, hashtags, created_at,
			username, display_name, avatar_url, is_verified, follower_count
		FROM ranked
		ORDER BY POWER(RANDOM(), 1.0 / rn) DESC
	`)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "feed failed"})
		return
	}
	defer allRows.Close()
	allVideos := h.scanVideos(allRows, "")

	if len(allVideos) == 0 {
		c.JSON(http.StatusOK, gin.H{"videos": []interface{}{}, "page": page})
		return
	}

	// Cyclic pagination: modulo wraps so page 5 re-starts from the top
	poolSize := len(allVideos)
	startIdx := ((page - 1) * limit) % poolSize
	var videos []models.Video
	for i := 0; i < limit; i++ {
		videos = append(videos, allVideos[(startIdx+i)%poolSize])
	}
	c.JSON(http.StatusOK, gin.H{"videos": videos, "page": page})
}

// PublicVideo returns a single video by ID with no auth required.
// Used by deep links (?v=<id>) so unauthenticated users can view a shared video.
func (h *FeedHandler) PublicVideo(c *gin.Context) {
	videoID := c.Param("id")
	if len(videoID) != 36 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid video id"})
		return
	}

	rows, err := h.db.Query(`
		SELECT v.id, v.user_id, v.title, v.description, v.video_url, v.thumbnail_url,
			v.duration, v.view_count, v.like_count, v.comment_count, v.share_count,
			v.save_count, v.hashtags, v.created_at,
			u.username, u.display_name, u.avatar_url, u.is_verified, u.follower_count
		FROM videos v JOIN users u ON u.id = v.user_id
		WHERE v.id = $1 AND v.is_published = true
	`, videoID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "video not found"})
		return
	}
	defer rows.Close()
	videos := h.scanVideos(rows, "")
	if len(videos) == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "video not found"})
		return
	}
	c.JSON(http.StatusOK, videos[0])
}

// ── Feed Queue constants ─────────────────────────────────────────────────────
const (
	feedQueueKeyPrefix  = "feed:queue:"  // Redis list key per user
	feedQueueMinLen     = 20             // refill when queue drops below this
	feedQueueFillSize   = 60            // how many IDs to fill per batch
	feedQueueTTL        = 3600          // queue expires after 1h of inactivity (seconds)
)

// queueKey returns the Redis list key for a user's feed queue.
func queueKey(userID string) string {
	return feedQueueKeyPrefix + userID
}

// fillQueue builds a fresh ranked list of video IDs for a user and pushes them
// to the right end of the Redis queue. It uses CF recall -> neural rank, with
// random fallback when CF returns empty. Already-queued IDs are deduplicated.
// Safe to call concurrently (Redis RPUSH is atomic).
func (h *FeedHandler) fillQueue(userID string, excludeSeen bool) {
	ctx := context.Background()

	// ── Step 1: CF recall ──────────────────────────────────────────────────
	cfIDs, err := cfRecommend(userID, feedQueueFillSize*2, excludeSeen)
	if err != nil || len(cfIDs) == 0 {
		if excludeSeen {
			// Retry including seen videos so queue never runs dry
			cfIDs, err = cfRecommend(userID, feedQueueFillSize*2, false)
		}
	}

	// ── Step 2: Neural ranker re-scores candidates ─────────────────────────
	if len(cfIDs) > 0 {
		if ranked, rerr := neuralRank(userID, cfIDs); rerr == nil {
			cfIDs = ranked
		}
	}

	// ── Step 3: If still empty, fall back to DB random order ──────────────
	// Note: intentionally includes the user's own videos here - this is the
	// last resort when CF returns nothing (e.g. all published videos belong
	// to the current user). The feed must never run completely dry.
	if len(cfIDs) == 0 {
		rows, qerr := h.db.QueryContext(ctx, `
			SELECT id FROM videos
			WHERE is_published = true
			ORDER BY RANDOM() LIMIT $1
		`, feedQueueFillSize)
		if qerr == nil {
			defer rows.Close()
			for rows.Next() {
				var id string
				if rows.Scan(&id) == nil {
					cfIDs = append(cfIDs, id)
				}
			}
		}
	}

	if len(cfIDs) == 0 {
		return
	}

	// ── Step 4: Deduplicate against what's already in the queue ───────────
	key := queueKey(userID)
	existing, _ := h.rdb.LRange(ctx, key, 0, -1).Result()
	inQueue := make(map[string]bool, len(existing))
	for _, id := range existing {
		inQueue[id] = true
	}

	var toAdd []interface{}
	for _, id := range cfIDs {
		if !inQueue[id] {
			toAdd = append(toAdd, id)
			inQueue[id] = true // prevent dupes within this batch too
		}
	}

	if len(toAdd) == 0 {
		// Queue has all these IDs already - push them anyway so scroll never stops
		// (user has seen everything, we cycle through again)
		for _, id := range cfIDs {
			toAdd = append(toAdd, id)
		}
	}

	// Push to right end of list, reset TTL
	h.rdb.RPush(ctx, key, toAdd...)
	h.rdb.Expire(ctx, key, feedQueueTTL*1e9) // nanoseconds for time.Duration
	log.Printf("fillQueue user=%s added=%d queueLen=%d", userID, len(toAdd),
		h.rdb.LLen(ctx, key).Val())
}

// popFromQueue pops `limit` IDs from the left of the user's queue.
// If the queue is too short, it triggers a background refill.
// If the queue is empty, it fills synchronously first.
func (h *FeedHandler) popFromQueue(userID string, limit int) []string {
	ctx := context.Background()
	key := queueKey(userID)

	qLen := h.rdb.LLen(ctx, key).Val()

	// Empty queue: fill synchronously so this request gets real content
	if qLen == 0 {
		h.fillQueue(userID, true)
		qLen = h.rdb.LLen(ctx, key).Val()
	}

	// Queue running low: kick off async refill so next request is instant
	if qLen < int64(feedQueueMinLen) {
		go h.fillQueue(userID, true)
	}

	// Pop `limit` IDs atomically from the left
	ids := make([]string, 0, limit)
	for i := 0; i < limit; i++ {
		id, err := h.rdb.LPop(ctx, key).Result()
		if err != nil {
			break // queue exhausted mid-pop
		}
		ids = append(ids, id)
	}
	return ids
}

// ForYou - Queue-based infinite personalized feed.
//
// Pipeline:
//  1. Pop `limit` video IDs from user's Redis queue (pre-ranked by CF + neural ranker)
//  2. When queue is empty → synchronous fillQueue before popping
//  3. When queue is low (<20) → async fillQueue in background for next request
//  4. fillQueue: CF recall → neural rank → DB random fallback → dedupe → RPush
//
// The client no longer needs a page number - the server owns cursor state.
// Passing page= is still accepted for compatibility but ignored.
func (h *FeedHandler) ForYou(c *gin.Context) {
	currentUserIDRaw, exists := c.Get("user_id")
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	currentUserID, ok := currentUserIDRaw.(string)
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid user"})
		return
	}

	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "10"))
	if limit < 1 {
		limit = 10
	}
	if limit > 50 {
		limit = 50
	}

	// ── Pop next batch from queue ─────────────────────────────────────────
	ids := h.popFromQueue(currentUserID, limit)

	if len(ids) > 0 {
		videos, err := h.fetchVideosByIDs(ids, currentUserID)
		if err == nil && len(videos) > 0 {
			c.JSON(http.StatusOK, gin.H{"videos": videos, "source": "queue"})
			return
		}
	}

	// ── Hard fallback: Redis down or DB error ─────────────────────────────
	log.Printf("ForYou hard fallback for user %s (queue miss)", currentUserID)
	videos := h.forYouRandom(currentUserID, 1, limit)
	c.JSON(http.StatusOK, gin.H{"videos": videos, "source": "fallback"})
}

// fetchVideosByIDs fetches full video details for a list of IDs, preserving order.
func (h *FeedHandler) fetchVideosByIDs(ids []string, currentUserID string) ([]models.Video, error) {
	if len(ids) == 0 {
		return nil, fmt.Errorf("empty ids")
	}
	// Build parameterized query with ANY($1::uuid[])
	rows, err := h.db.Query(`
		SELECT v.id, v.user_id, v.title, v.description, v.video_url, v.thumbnail_url,
			v.duration, v.view_count, v.like_count, v.comment_count, v.share_count,
			v.save_count, v.hashtags, v.created_at,
			u.username, u.display_name, u.avatar_url, u.is_verified, u.follower_count
		FROM videos v JOIN users u ON u.id = v.user_id
		WHERE v.id = ANY($1::uuid[]) AND v.is_published = true
	`, pq.Array(ids))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	// Scan into a map by ID so we can re-order correctly
	byID := map[string]models.Video{}
	for rows.Next() {
		var v models.Video
		var a models.User
		if err := rows.Scan(
			&v.ID, &v.UserID, &v.Title, &v.Description, &v.VideoURL, &v.ThumbnailURL,
			&v.Duration, &v.ViewCount, &v.LikeCount, &v.CommentCount, &v.ShareCount, &v.SaveCount,
			pq.Array(&v.Hashtags), &v.CreatedAt,
			&a.Username, &a.DisplayName, &a.AvatarURL, &a.IsVerified, &a.FollowerCount,
		); err != nil {
			log.Printf("fetchVideosByIDs scan error: %v", err)
			continue
		}
		a.ID = v.UserID
		v.Author = &a
		// Enrich with is_liked
		var count int
		h.db.QueryRow(`SELECT COUNT(*) FROM video_likes WHERE user_id=$1 AND video_id=$2`,
			currentUserID, v.ID).Scan(&count)
		v.IsLiked = count > 0
		// Enrich with is_saved
		var savedCount int
		h.db.QueryRow(`SELECT COUNT(*) FROM saved_videos WHERE user_id=$1 AND video_id=$2`,
			currentUserID, v.ID).Scan(&savedCount)
		v.IsSaved = savedCount > 0
		byID[v.ID] = v
	}

	// Re-order to match CF ranking
	var result []models.Video
	for _, id := range ids {
		if v, ok := byID[id]; ok {
			result = append(result, v)
		}
	}
	return result, nil
}


// forYouRandom fetches all published videos in random order (DB-side RANDOM()).
// Used when CF pool is exhausted (user has seen everything).
// Returns a paginated slice with no score bias.
// ClearQueue deletes the user's feed queue so the next ForYou request rebuilds it fresh.
// Called by the frontend when the user switches tabs or explicitly refreshes.
func (h *FeedHandler) ClearQueue(c *gin.Context) {
	currentUserIDRaw, exists := c.Get("user_id")
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	currentUserID := fmt.Sprintf("%v", currentUserIDRaw)
	ctx := context.Background()
	h.rdb.Del(ctx, queueKey(currentUserID))
	c.JSON(http.StatusOK, gin.H{"message": "queue cleared"})
}

func (h *FeedHandler) forYouRandom(currentUserID string, page, limit int) []models.Video {
	rows, err := h.db.Query(`
		SELECT v.id, v.user_id, v.title, v.description, v.video_url, v.thumbnail_url,
			v.duration, v.view_count, v.like_count, v.comment_count, v.share_count, v.save_count,
			v.hashtags, v.created_at,
			u.username, u.display_name, u.avatar_url, u.is_verified, u.follower_count
		FROM videos v
		JOIN users u ON u.id = v.user_id
		WHERE v.is_published = true
		ORDER BY RANDOM()
		LIMIT $1 OFFSET $2
	`, limit, (page-1)*limit)
	if err != nil {
		return nil
	}
	defer rows.Close()
	return h.scanVideos(rows, currentUserID)
}

// forYouRuleBased ranks all available videos by engagement+affinity signals and
// returns the requested page. The pool cycles (modulo) so the feed never ends.
func (h *FeedHandler) forYouRuleBased(currentUserID string, page, limit int) []models.Video {
	// Learn user hashtag affinity
	affinityRows, _ := h.db.Query(`
		SELECT DISTINCT unnest(v.hashtags) AS tag
		FROM videos v
		WHERE v.id IN (
			SELECT video_id FROM video_likes WHERE user_id = $1
			UNION
			SELECT video_id FROM video_views WHERE user_id = $1 AND watch_percent >= 0.5
		)
		LIMIT 200
	`, currentUserID)
	userHashtags := map[string]bool{}
	if affinityRows != nil {
		defer affinityRows.Close()
		for affinityRows.Next() {
			var tag string
			if err := affinityRows.Scan(&tag); err == nil && tag != "" {
				userHashtags[tag] = true
			}
		}
	}

	// Learn author affinity
	authorRows, _ := h.db.Query(`
		SELECT DISTINCT v.user_id
		FROM videos v
		WHERE v.id IN (
			SELECT video_id FROM video_likes WHERE user_id = $1
			UNION
			SELECT video_id FROM video_views WHERE user_id = $1 AND watch_percent >= 0.5
		)
		LIMIT 100
	`, currentUserID)
	likedAuthors := map[string]bool{}
	if authorRows != nil {
		defer authorRows.Close()
		for authorRows.Next() {
			var authorID string
			if err := authorRows.Scan(&authorID); err == nil {
				likedAuthors[authorID] = true
			}
		}
	}

	// Fetch the FULL pool of available videos (no SQL offset/limit for pagination).
	// We rank in memory. Unseen videos get a bonus so they appear first.
	// When all videos have been seen the feed still continues with the best-ranked ones.
	rows, err := h.db.Query(`
		SELECT v.id, v.user_id, v.title, v.description, v.video_url, v.thumbnail_url,
			v.duration, v.view_count, v.like_count, v.comment_count, v.share_count, v.save_count,
			v.hashtags, v.created_at,
			u.username, u.display_name, u.avatar_url, u.is_verified, u.follower_count,
			COALESCE(avg_view.avg_pct, 0) AS avg_watch_percent,
			CASE WHEN vv.video_id IS NOT NULL THEN 1 ELSE 0 END AS has_seen
		FROM videos v
		JOIN users u ON u.id = v.user_id
		LEFT JOIN (
			SELECT video_id, AVG(watch_percent) AS avg_pct
			FROM video_views
			GROUP BY video_id
		) avg_view ON avg_view.video_id = v.id
		LEFT JOIN (
			SELECT DISTINCT video_id FROM video_views WHERE user_id = $1
		) vv ON vv.video_id = v.id
		WHERE v.is_published = true
			AND v.user_id != $1
		ORDER BY v.created_at DESC
	`, currentUserID)
	if err != nil {
		return nil
	}
	defer rows.Close()

	type scoredVideo struct {
		video models.Video
		score float64
	}
	var candidates []scoredVideo
	for rows.Next() {
		var v models.Video
		var a models.User
		var avgWatchPct float64
		var hasSeen int
		if err := rows.Scan(
			&v.ID, &v.UserID, &v.Title, &v.Description, &v.VideoURL, &v.ThumbnailURL,
			&v.Duration, &v.ViewCount, &v.LikeCount, &v.CommentCount, &v.ShareCount, &v.SaveCount,
			pq.Array(&v.Hashtags), &v.CreatedAt,
			&a.Username, &a.DisplayName, &a.AvatarURL, &a.IsVerified, &a.FollowerCount,
			&avgWatchPct, &hasSeen,
		); err != nil {
			continue
		}
		a.ID = v.UserID
		v.Author = &a

		// Log-normalize engagement score so 25x raw gaps compress to ~1.4x
		// This lets ±40% random jitter actually rotate the top slot across reloads.
		rawScore := float64(v.LikeCount*3+v.CommentCount*5+v.ShareCount*7) + float64(v.ViewCount)*0.1
		score := math.Log1p(rawScore) * (0.6 + 0.8*rand.Float64()) // ±40% jitter
		for _, tag := range v.Hashtags {
			if userHashtags[tag] {
				score += 2.0 // scaled for log range
			}
		}
		if likedAuthors[v.UserID] {
			score += 3.0
		}
		if avgWatchPct >= 0.7 {
			score += 2.5
		}
		// Unseen videos get a strong bonus so they appear before re-surfaced ones
		if hasSeen == 0 {
			score += 8.0
		}
		candidates = append(candidates, scoredVideo{video: v, score: score})
	}

	// Count how many unseen videos are in this pool
	unseenCount := 0
	for _, c := range candidates {
		if c.score > 8.0 { // hasSeen==0 adds 8.0, so >8 means unseen
			unseenCount++
		}
	}

	if unseenCount == 0 {
		// User has seen everything - pure shuffle for variety
		rand.Shuffle(len(candidates), func(i, j int) {
			candidates[i], candidates[j] = candidates[j], candidates[i]
		})
	} else {
		// Sort descending by jittered score
		for i := 0; i < len(candidates); i++ {
			for j := i + 1; j < len(candidates); j++ {
				if candidates[j].score > candidates[i].score {
					candidates[i], candidates[j] = candidates[j], candidates[i]
				}
			}
		}
	}

	poolSize := len(candidates)
	if poolSize == 0 {
		return nil
	}
	// Cyclic pagination: wrap around so the feed never ends.
	// startIdx cycles through the pool using modulo.
	startIdx := ((page - 1) * limit) % poolSize
	endIdx := startIdx + limit
	// If the window overflows the end of the pool, wrap around and
	// collect from the beginning to fill the page.
	var selected []models.Video
	if endIdx <= poolSize {
		for _, sc := range candidates[startIdx:endIdx] {
			selected = append(selected, sc.video)
		}
	} else {
		for _, sc := range candidates[startIdx:] {
			selected = append(selected, sc.video)
		}
		remaining := limit - len(selected)
		if remaining > poolSize {
			remaining = poolSize
		}
		for _, sc := range candidates[:remaining] {
			selected = append(selected, sc.video)
		}
	}

	videos := make([]models.Video, 0)
	for _, v := range selected {
		var count int
		h.db.QueryRow(`SELECT COUNT(*) FROM video_likes WHERE user_id=$1 AND video_id=$2`,
			currentUserID, v.ID).Scan(&count)
		v.IsLiked = count > 0
		var savedCount int
		h.db.QueryRow(`SELECT COUNT(*) FROM saved_videos WHERE user_id=$1 AND video_id=$2`,
			currentUserID, v.ID).Scan(&savedCount)
		v.IsSaved = savedCount > 0
		videos = append(videos, v)
	}
	return videos
}

func (h *FeedHandler) Following(c *gin.Context) {
	currentUserIDRaw, exists := c.Get("user_id")
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	currentUserID, ok := currentUserIDRaw.(string)
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid user"})
		return
	}

	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	if page < 1 {
		page = 1
	}
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "10"))
	if limit < 1 {
		limit = 10
	}
	if limit > 50 {
		limit = 50
	}
	offset := (page - 1) * limit

	rows, err := h.db.Query(`
		SELECT v.id, v.user_id, v.title, v.description, v.video_url, v.thumbnail_url,
			v.duration, v.view_count, v.like_count, v.comment_count, v.share_count, v.save_count,
			v.hashtags, v.created_at,
			u.username, u.display_name, u.avatar_url, u.is_verified, u.follower_count
		FROM videos v
		JOIN users u ON u.id = v.user_id
		JOIN follows f ON f.following_id = v.user_id
		WHERE f.follower_id = $1 AND v.is_published = true
		ORDER BY v.created_at DESC
		LIMIT $2 OFFSET $3
	`, currentUserID, limit, offset)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "following feed failed"})
		return
	}
	defer rows.Close()

	videos := h.scanVideos(rows, currentUserID)
	c.JSON(http.StatusOK, gin.H{"videos": videos, "page": page})
}

func (h *FeedHandler) scanVideos(rows *sql.Rows, currentUserID string) []models.Video {
	videos := make([]models.Video, 0)
	for rows.Next() {
		var v models.Video
		var a models.User
		if err := rows.Scan(&v.ID, &v.UserID, &v.Title, &v.Description, &v.VideoURL, &v.ThumbnailURL,
			&v.Duration, &v.ViewCount, &v.LikeCount, &v.CommentCount, &v.ShareCount, &v.SaveCount,
			pq.Array(&v.Hashtags), &v.CreatedAt,
			&a.Username, &a.DisplayName, &a.AvatarURL, &a.IsVerified, &a.FollowerCount); err != nil {
			log.Printf("scanVideos error: %v", err)
			continue
		}
		a.ID = v.UserID
		v.Author = &a
		var count int
		h.db.QueryRow(`SELECT COUNT(*) FROM video_likes WHERE user_id=$1 AND video_id=$2`,
			currentUserID, v.ID).Scan(&count)
		v.IsLiked = count > 0
		if currentUserID != "" {
			var savedCount int
			h.db.QueryRow(`SELECT COUNT(*) FROM saved_videos WHERE user_id=$1 AND video_id=$2`,
				currentUserID, v.ID).Scan(&savedCount)
			v.IsSaved = savedCount > 0
		}
		videos = append(videos, v)
	}
	return videos
}

// SendSearchSignal fires a search-intent signal to the Python recommender (non-blocking).
// Called when an authenticated user performs a search so the recommender learns keyword interests.
func SendSearchSignal(userID, query string, keywords []string) {
	go func() {
		payload := map[string]interface{}{
			"user_id":  userID,
			"query":    query,
			"keywords": keywords,
		}
		body, _ := json.Marshal(payload)
		resp, err := http.Post(
			fmt.Sprintf("%s/signal/search", recommenderURL()),
			"application/json",
			bytes.NewReader(body),
		)
		if err != nil {
			return // recommender offline - silently ignore
		}
		resp.Body.Close()
	}()
}

// SendLikeSignal fires a like signal to the recommender.
func SendLikeSignal(userID, videoID string) {
	go func() {
		payload, _ := json.Marshal(map[string]interface{}{
			"user_id":  userID,
			"video_id": videoID,
			"type":     "like",
			"weight":   1.5,
		})
		resp, err := http.Post(fmt.Sprintf("%s/signal/like", recommenderURL()), "application/json", bytes.NewReader(payload))
		if err != nil { return }
		resp.Body.Close()
	}()
}

// SendSaveSignal fires a save signal to the recommender.
func SendSaveSignal(userID, videoID string) {
	go func() {
		payload, _ := json.Marshal(map[string]interface{}{
			"user_id":  userID,
			"video_id": videoID,
			"type":     "save",
			"weight":   2.0,
		})
		resp, err := http.Post(fmt.Sprintf("%s/signal/save", recommenderURL()), "application/json", bytes.NewReader(payload))
		if err != nil { return }
		resp.Body.Close()
	}()
}

// SendFollowSignal fires a follow signal to the recommender.
func SendFollowSignal(followerID, followingID string) {
	go func() {
		payload, _ := json.Marshal(map[string]interface{}{
			"follower_id":  followerID,
			"following_id": followingID,
		})
		resp, err := http.Post(fmt.Sprintf("%s/signal/follow", recommenderURL()), "application/json", bytes.NewReader(payload))
		if err != nil { return }
		resp.Body.Close()
	}()
}
