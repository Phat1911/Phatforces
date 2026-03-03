package handlers

import (
	"database/sql"
	"log"
	"net/http"
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

// Public - no auth required, returns trending videos for guest visitors
func (h *FeedHandler) Public(c *gin.Context) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	if page < 1 { page = 1 }
	limit := 10
	offset := (page - 1) * limit

	rows, err := h.db.Query(`
		SELECT v.id, v.user_id, v.title, v.description, v.video_url, v.thumbnail_url,
			v.duration, v.view_count, v.like_count, v.comment_count, v.share_count,
			v.hashtags, v.created_at,
			u.username, u.display_name, u.avatar_url, u.is_verified, u.follower_count
		FROM videos v JOIN users u ON u.id = v.user_id
		WHERE v.is_published = true
		ORDER BY (v.like_count * 3 + v.view_count * 0.1) DESC, v.created_at DESC
		LIMIT $1 OFFSET $2
	`, limit, offset)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "feed failed"})
		return
	}
	defer rows.Close()
	videos := h.scanVideos(rows, "")
	c.JSON(http.StatusOK, gin.H{"videos": videos, "page": page})
}

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

	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	if page < 1 { page = 1 }
	limit := 10
	offset := (page - 1) * limit

	rows, err := h.db.Query(`
		SELECT v.id, v.user_id, v.title, v.description, v.video_url, v.thumbnail_url,
			v.duration, v.view_count, v.like_count, v.comment_count, v.share_count,
			v.hashtags, v.created_at,
			u.username, u.display_name, u.avatar_url, u.is_verified, u.follower_count
		FROM videos v JOIN users u ON u.id = v.user_id
		WHERE v.is_published = true AND v.user_id != $1
		ORDER BY (
			v.like_count * 3 + v.comment_count * 5 + v.share_count * 7 + v.view_count * 0.1
		) * EXTRACT(EPOCH FROM (NOW() - v.created_at + INTERVAL '1 hour'))^(-0.5) DESC,
		v.created_at DESC
		LIMIT $2 OFFSET $3
	`, currentUserID, limit, offset)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "feed failed"})
		return
	}
	defer rows.Close()

	videos := h.scanVideos(rows, currentUserID)
	c.JSON(http.StatusOK, gin.H{"videos": videos, "page": page})
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
	if page < 1 { page = 1 }
	limit := 10
	offset := (page - 1) * limit

	rows, err := h.db.Query(`
		SELECT v.id, v.user_id, v.title, v.description, v.video_url, v.thumbnail_url,
			v.duration, v.view_count, v.like_count, v.comment_count, v.share_count,
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
	var videos []models.Video
	for rows.Next() {
		var v models.Video
		var a models.User
		if err := rows.Scan(&v.ID, &v.UserID, &v.Title, &v.Description, &v.VideoURL, &v.ThumbnailURL,
			&v.Duration, &v.ViewCount, &v.LikeCount, &v.CommentCount, &v.ShareCount,
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
		videos = append(videos, v)
	}
	return videos
}
