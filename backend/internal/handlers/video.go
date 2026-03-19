package handlers

import (
	"database/sql"
	"fmt"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/lib/pq"
	"github.com/redis/go-redis/v9"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"photcot/internal/config"
	"photcot/internal/models"
	"strconv"
	"strings"
)

type VideoHandler struct {
	db  *sql.DB
	rdb *redis.Client
	cfg *config.Config
}

func NewVideoHandler(db *sql.DB, rdb *redis.Client, cfg *config.Config) *VideoHandler {
	return &VideoHandler{db: db, rdb: rdb, cfg: cfg}
}

var allowedMIMETypes = map[string]bool{
	"video/mp4": true, "video/quicktime": true, "video/x-msvideo": true,
	"video/webm": true, "video/x-matroska": true, "video/3gpp": true,
}

func (h *VideoHandler) Upload(c *gin.Context) {
	userID, exists := c.Get("user_id")
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	file, _, err := c.Request.FormFile("video")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "video file required"})
		return
	}
	defer file.Close()

	// SECURITY: MIME type check via magic bytes
	sniff := make([]byte, 512)
	n, _ := file.Read(sniff)
	mime := http.DetectContentType(sniff[:n])
	// Reset reader
	file.Seek(0, io.SeekStart)
	if !allowedMIMETypes[mime] && !strings.HasPrefix(mime, "video/") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "only video files are allowed"})
		return
	}

	title := c.PostForm("title")
	description := c.PostForm("description")
	hashtagStr := c.PostForm("hashtags")

	videoID := uuid.New().String()
	// SECURITY: Use only the video ID as directory, never user-supplied filename
	videoDir := filepath.Join(h.cfg.UploadDir, videoID)
	if err := os.MkdirAll(videoDir, 0755); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create upload dir"})
		return
	}

	rawPath := filepath.Join(videoDir, "raw.mp4")
	outFile, err := os.Create(rawPath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save file"})
		return
	}
	if _, err := io.Copy(outFile, file); err != nil {
		outFile.Close()
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to write file"})
		return
	}
	outFile.Close()

	outPath := filepath.Join(videoDir, "video.mp4")
	thumbPath := filepath.Join(videoDir, "thumb.jpg")

	exec.Command("ffmpeg", "-i", rawPath, "-vf", "scale=720:-2", "-c:v", "libx264",
		"-crf", "23", "-preset", "fast", "-c:a", "aac", "-y", outPath).Run()
	exec.Command("ffmpeg", "-i", rawPath, "-ss", "00:00:01", "-vframes", "1",
		"-vf", "scale=360:-2", thumbPath).Run()

	durationOut, _ := exec.Command("ffprobe", "-v", "error", "-show_entries",
		"format=duration", "-of", "default=noprint_wrappers=1:nokey=1", outPath).Output()
	duration, _ := strconv.ParseFloat(strings.TrimSpace(string(durationOut)), 64)

	videoURL := fmt.Sprintf("/uploads/%s/video.mp4", videoID)
	if _, statErr := os.Stat(outPath); os.IsNotExist(statErr) {
		videoURL = fmt.Sprintf("/uploads/%s/raw.mp4", videoID)
	}
	thumbURL := fmt.Sprintf("/uploads/%s/thumb.jpg", videoID)
	if _, statErr := os.Stat(thumbPath); os.IsNotExist(statErr) {
		thumbURL = ""
	}

	hashtags := []string{}
	if hashtagStr != "" {
		for _, tag := range strings.Split(hashtagStr, ",") {
			tag = strings.TrimSpace(strings.ToLower(tag))
			if tag != "" {
				hashtags = append(hashtags, tag)
			}
		}
	}

	var video models.Video
	err = h.db.QueryRow(`
		INSERT INTO videos (id, user_id, title, description, video_url, thumbnail_url, duration, hashtags)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id, user_id, title, description, video_url, thumbnail_url, duration, view_count, like_count, comment_count, hashtags, created_at
	`, videoID, userID, title, description, videoURL, thumbURL, duration, pq.Array(hashtags)).Scan(
		&video.ID, &video.UserID, &video.Title, &video.Description,
		&video.VideoURL, &video.ThumbnailURL, &video.Duration,
		&video.ViewCount, &video.LikeCount, &video.CommentCount,
		pq.Array(&video.Hashtags), &video.CreatedAt,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("db insert failed: %v", err)})
		return
	}
	// Clear the uploader's feed queue so the next ForYou scroll rebuilds fresh.
	// This prevents the newly posted video from appearing repeatedly due to a
	// stale queue that was built before the video existed.
	if h.rdb != nil {
		h.rdb.Del(c.Request.Context(), "feed:queue:"+fmt.Sprintf("%v", userID))
	}
	c.JSON(http.StatusCreated, video)
}

func (h *VideoHandler) GetVideo(c *gin.Context) {
	videoID := c.Param("id")
	currentUserID, _ := c.Get("user_id")

	var video models.Video
	var author models.User
	err := h.db.QueryRow(`
		SELECT v.id, v.user_id, v.title, v.description, v.video_url, v.thumbnail_url,
			v.duration, v.view_count, v.like_count, v.comment_count, v.share_count,
			v.hashtags, v.created_at,
			u.username, u.display_name, u.avatar_url, u.is_verified, u.follower_count
		FROM videos v JOIN users u ON u.id = v.user_id
		WHERE v.id = $1 AND v.is_published = true
	`, videoID).Scan(
		&video.ID, &video.UserID, &video.Title, &video.Description,
		&video.VideoURL, &video.ThumbnailURL, &video.Duration,
		&video.ViewCount, &video.LikeCount, &video.CommentCount, &video.ShareCount,
		pq.Array(&video.Hashtags), &video.CreatedAt,
		&author.Username, &author.DisplayName, &author.AvatarURL, &author.IsVerified, &author.FollowerCount,
	)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "video not found"})
		return
	}
	author.ID = video.UserID
	video.Author = &author

	if currentUserID != nil {
		var count int
		h.db.QueryRow(`SELECT COUNT(*) FROM video_likes WHERE user_id=$1 AND video_id=$2`,
			currentUserID, videoID).Scan(&count)
		video.IsLiked = count > 0
	}
	c.JSON(http.StatusOK, video)
}

func (h *VideoHandler) DeleteVideo(c *gin.Context) {
	userID, _ := c.Get("user_id")
	videoID := c.Param("id")
	// Validate videoID is a UUID to prevent path traversal
	if len(videoID) != 36 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid video id"})
		return
	}

	result, err := h.db.Exec(`DELETE FROM videos WHERE id=$1 AND user_id=$2`, videoID, userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "delete failed"})
		return
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		c.JSON(http.StatusForbidden, gin.H{"error": "not your video"})
		return
	}
	os.RemoveAll(filepath.Join(h.cfg.UploadDir, videoID))
	c.JSON(http.StatusOK, gin.H{"message": "deleted"})
}

func (h *VideoHandler) Like(c *gin.Context) {
	userID, _ := c.Get("user_id")
	videoID := c.Param("id")

	// Atomic: only increment count when the row is actually inserted
	var count int
	err := h.db.QueryRow(`
		WITH ins AS (
			INSERT INTO video_likes (user_id, video_id) VALUES ($1, $2)
			ON CONFLICT DO NOTHING
			RETURNING 1
		)
		SELECT COUNT(*) FROM ins
	`, userID, videoID).Scan(&count)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "like failed"})
		return
	}
	if count > 0 {
		h.db.Exec(`UPDATE videos SET like_count = like_count + 1 WHERE id = $1`, videoID)
		// Notification + recommender signal
		actorUsername, videoOwnerID, videoTitle := GetActorInfo(h.db, fmt.Sprintf("%v", userID), videoID)
		if videoOwnerID != "" {
			msg := fmt.Sprintf("%s liked your video \"%.40s\"", actorUsername, videoTitle)
			CreateNotification(h.db, videoOwnerID, fmt.Sprintf("%v", userID), "like", &videoID, nil, msg)
			SendLikeSignal(fmt.Sprintf("%v", userID), videoID)
		}
	}
	c.JSON(http.StatusOK, gin.H{"message": "liked"})
}

func (h *VideoHandler) Unlike(c *gin.Context) {
	userID, _ := c.Get("user_id")
	videoID := c.Param("id")

	result, _ := h.db.Exec(`DELETE FROM video_likes WHERE user_id=$1 AND video_id=$2`, userID, videoID)
	rows, _ := result.RowsAffected()
	if rows > 0 {
		h.db.Exec(`UPDATE videos SET like_count = like_count - 1 WHERE id = $1 AND like_count > 0`, videoID)
	}
	c.JSON(http.StatusOK, gin.H{"message": "unliked"})
}

func (h *VideoHandler) RecordView(c *gin.Context) {
	userIDRaw, _ := c.Get("user_id")
	userID := fmt.Sprintf("%v", userIDRaw)
	videoID := c.Param("id")
	var req struct {
		WatchTime    float64 `json:"watch_time"`
		WatchPercent float64 `json:"watch_percent"`
		Replayed     bool    `json:"replayed"`
	}
	c.ShouldBindJSON(&req)

	// Normalize watch_percent: frontend sends 0-100, recommender expects 0.0-1.0.
	// Accept either format: if value > 1.0 assume it's a percentage and divide by 100.
	watchPct := req.WatchPercent
	if watchPct > 1.0 {
		watchPct = watchPct / 100.0
	}
	if watchPct > 1.0 {
		watchPct = 1.0
	}

	h.db.Exec(`
		INSERT INTO video_views (user_id, video_id, watch_time, watch_percent, replayed)
		VALUES ($1, $2, $3, $4, $5)
	`, userID, videoID, req.WatchTime, watchPct, req.Replayed)
	h.db.Exec(`UPDATE videos SET view_count = view_count + 1 WHERE id = $1`, videoID)

	// Send real-time signal to recommender feature store (non-blocking goroutine)
	var hashtags []string
	h.db.QueryRow(`SELECT COALESCE(hashtags, '{}') FROM videos WHERE id = $1`, videoID).Scan(pq.Array(&hashtags))
	SendViewSignal(userID, videoID, watchPct, hashtags)

	c.JSON(http.StatusOK, gin.H{"message": "recorded"})
}

func (h *VideoHandler) SaveVideo(c *gin.Context) {
	userID, _ := c.Get("user_id")
	videoID := c.Param("id")
	if len(videoID) != 36 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid video id"})
		return
	}

	var count int
	err := h.db.QueryRow(`
		WITH ins AS (
			INSERT INTO saved_videos (user_id, video_id) VALUES ($1, $2)
			ON CONFLICT DO NOTHING
			RETURNING 1
		)
		SELECT COUNT(*) FROM ins
	`, userID, videoID).Scan(&count)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "save failed"})
		return
	}
	if count > 0 {
		h.db.Exec(`UPDATE videos SET save_count = save_count + 1 WHERE id = $1`, videoID)
		// Notification + signal for new saves
		actorUsername, videoOwnerID, videoTitle := GetActorInfo(h.db, fmt.Sprintf("%v", userID), videoID)
		if videoOwnerID != "" {
			msg := fmt.Sprintf("%s saved your video \"%.40s\"", actorUsername, videoTitle)
			CreateNotification(h.db, videoOwnerID, fmt.Sprintf("%v", userID), "save", &videoID, nil, msg)
			SendSaveSignal(fmt.Sprintf("%v", userID), videoID)
		}
	}
	c.JSON(http.StatusOK, gin.H{"message": "saved", "inserted": count > 0})
}

func (h *VideoHandler) UnsaveVideo(c *gin.Context) {
	userID, _ := c.Get("user_id")
	videoID := c.Param("id")
	if len(videoID) != 36 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid video id"})
		return
	}

	result, err := h.db.Exec(`DELETE FROM saved_videos WHERE user_id=$1 AND video_id=$2`, userID, videoID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "unsave failed"})
		return
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		c.JSON(http.StatusOK, gin.H{"message": "not saved"})
		return
	}
	h.db.Exec(`UPDATE videos SET save_count = GREATEST(save_count - 1, 0) WHERE id = $1`, videoID)
	c.JSON(http.StatusOK, gin.H{"message": "unsaved"})
}

func (h *VideoHandler) GetSavedVideos(c *gin.Context) {
	currentUserIDRaw, exists := c.Get("user_id")
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	currentUserID := fmt.Sprintf("%v", currentUserIDRaw)

	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	if page < 1 {
		page = 1
	}
	limit := 20
	offset := (page - 1) * limit

	rows, err := h.db.Query(`
		SELECT v.id, v.user_id, v.title, v.description, v.video_url, v.thumbnail_url,
			v.duration, v.view_count, v.like_count, v.comment_count, v.share_count, v.save_count,
			v.hashtags, v.created_at,
			u.username, u.display_name, u.avatar_url, u.is_verified, u.follower_count
		FROM saved_videos s
		JOIN videos v ON v.id = s.video_id
		JOIN users u ON u.id = v.user_id
		WHERE s.user_id = $1 AND v.is_published = true
		ORDER BY s.created_at DESC
		LIMIT $2 OFFSET $3
	`, currentUserID, limit, offset)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get saved videos"})
		return
	}
	defer rows.Close()

	var videos []models.Video
	for rows.Next() {
		var v models.Video
		var a models.User
		if err := rows.Scan(&v.ID, &v.UserID, &v.Title, &v.Description, &v.VideoURL, &v.ThumbnailURL,
			&v.Duration, &v.ViewCount, &v.LikeCount, &v.CommentCount, &v.ShareCount, &v.SaveCount,
			pq.Array(&v.Hashtags), &v.CreatedAt,
			&a.Username, &a.DisplayName, &a.AvatarURL, &a.IsVerified, &a.FollowerCount); err != nil {
			continue
		}
		a.ID = v.UserID
		v.Author = &a
		v.IsSaved = true
		var likeCount int
		h.db.QueryRow(`SELECT COUNT(*) FROM video_likes WHERE user_id=$1 AND video_id=$2`,
			currentUserID, v.ID).Scan(&likeCount)
		v.IsLiked = likeCount > 0
		videos = append(videos, v)
	}
	c.JSON(http.StatusOK, gin.H{"videos": videos, "page": page})
}

// ShareVideo records that the current user shared this video.
// Increments share_count, upserts into shared_videos, returns updated count.
func (h *VideoHandler) ShareVideo(c *gin.Context) {
	userIDRaw, _ := c.Get("user_id")
	userID := fmt.Sprintf("%v", userIDRaw)
	videoID := c.Param("id")
	if len(videoID) != 36 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid video id"})
		return
	}

	// Upsert into shared_videos (ignore if already shared)
	var inserted int
	h.db.QueryRow(`
		WITH ins AS (
			INSERT INTO shared_videos (user_id, video_id)
			VALUES ($1, $2)
			ON CONFLICT DO NOTHING
			RETURNING 1
		)
		SELECT COUNT(*) FROM ins
	`, userID, videoID).Scan(&inserted)

	// Always increment share_count (each click = a share event)
	h.db.Exec(`UPDATE videos SET share_count = share_count + 1 WHERE id = $1`, videoID)

	var shareCount int
	h.db.QueryRow(`SELECT share_count FROM videos WHERE id = $1`, videoID).Scan(&shareCount)
	c.JSON(http.StatusOK, gin.H{"message": "shared", "share_count": shareCount})
}

// GetSharedVideos returns videos the current user has shared.
func (h *VideoHandler) GetSharedVideos(c *gin.Context) {
	currentUserIDRaw, exists := c.Get("user_id")
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	currentUserID := fmt.Sprintf("%v", currentUserIDRaw)

	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	if page < 1 {
		page = 1
	}
	limit := 20
	offset := (page - 1) * limit

	rows, err := h.db.Query(`
		SELECT v.id, v.user_id, v.title, v.description, v.video_url, v.thumbnail_url,
			v.duration, v.view_count, v.like_count, v.comment_count, v.share_count,
			v.save_count, v.hashtags, v.created_at,
			u.username, u.display_name, u.avatar_url, u.is_verified, u.follower_count
		FROM shared_videos s
		JOIN videos v ON v.id = s.video_id
		JOIN users u ON u.id = v.user_id
		WHERE s.user_id = $1 AND v.is_published = true
		ORDER BY s.created_at DESC
		LIMIT $2 OFFSET $3
	`, currentUserID, limit, offset)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed"})
		return
	}
	defer rows.Close()

	var videos []models.Video
	for rows.Next() {
		var v models.Video
		var a models.User
		if err := rows.Scan(&v.ID, &v.UserID, &v.Title, &v.Description, &v.VideoURL, &v.ThumbnailURL,
			&v.Duration, &v.ViewCount, &v.LikeCount, &v.CommentCount, &v.ShareCount, &v.SaveCount,
			pq.Array(&v.Hashtags), &v.CreatedAt,
			&a.Username, &a.DisplayName, &a.AvatarURL, &a.IsVerified, &a.FollowerCount); err != nil {
			continue
		}
		a.ID = v.UserID
		v.Author = &a
		var likeCount int
		h.db.QueryRow(`SELECT COUNT(*) FROM video_likes WHERE user_id=$1 AND video_id=$2`,
			currentUserID, v.ID).Scan(&likeCount)
		v.IsLiked = likeCount > 0
		videos = append(videos, v)
	}
	if videos == nil {
		videos = []models.Video{}
	}
	c.JSON(http.StatusOK, gin.H{"videos": videos, "page": page})
}

func (h *VideoHandler) GetUserVideos(c *gin.Context) {
	userID := c.Param("id")
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	if page < 1 {
		page = 1
	}
	limit := 20
	offset := (page - 1) * limit

	rows, err := h.db.Query(`
		SELECT v.id, v.user_id, v.title, v.video_url, v.thumbnail_url, v.duration,
			v.view_count, v.like_count, v.comment_count, v.hashtags, v.created_at,
			u.username, u.display_name, u.avatar_url, u.is_verified
		FROM videos v JOIN users u ON u.id = v.user_id
		WHERE v.user_id = $1 AND v.is_published = true
		ORDER BY v.created_at DESC LIMIT $2 OFFSET $3
	`, userID, limit, offset)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed"})
		return
	}
	defer rows.Close()

	var videos []models.Video
	for rows.Next() {
		var v models.Video
		var a models.User
		rows.Scan(&v.ID, &v.UserID, &v.Title, &v.VideoURL, &v.ThumbnailURL, &v.Duration,
			&v.ViewCount, &v.LikeCount, &v.CommentCount, pq.Array(&v.Hashtags), &v.CreatedAt,
			&a.Username, &a.DisplayName, &a.AvatarURL, &a.IsVerified)
		a.ID = v.UserID
		v.Author = &a
		videos = append(videos, v)
	}
	c.JSON(http.StatusOK, gin.H{"videos": videos, "page": page})
}
