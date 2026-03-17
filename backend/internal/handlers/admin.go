package handlers

import (
	"database/sql"
	"fmt"
	"net/http"
	"strconv"

	"photcot/internal/models"

	"github.com/gin-gonic/gin"
	"github.com/lib/pq"
)

type AdminHandler struct{ db *sql.DB }

func NewAdminHandler(db *sql.DB) *AdminHandler { return &AdminHandler{db: db} }

// requireAdmin checks that the calling user has is_admin=true
func (h *AdminHandler) requireAdmin(c *gin.Context) (string, bool) {
	userIDRaw, exists := c.Get("user_id")
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return "", false
	}
	userID := fmt.Sprintf("%v", userIDRaw)
	var isAdmin bool
	err := h.db.QueryRow(`SELECT is_admin FROM users WHERE id=$1`, userID).Scan(&isAdmin)
	if err != nil || !isAdmin {
		c.JSON(http.StatusForbidden, gin.H{"error": "admin access required"})
		return "", false
	}
	return userID, true
}

// GetStats returns platform-wide stats
func (h *AdminHandler) GetStats(c *gin.Context) {
	if _, ok := h.requireAdmin(c); !ok {
		return
	}
	var stats struct {
		TotalUsers    int `json:"total_users"`
		TotalVideos   int `json:"total_videos"`
		TotalViews    int `json:"total_views"`
		TotalLikes    int `json:"total_likes"`
		TotalComments int `json:"total_comments"`
		TotalShares   int `json:"total_shares"`
	}
	h.db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&stats.TotalUsers)
	h.db.QueryRow(`SELECT COUNT(*) FROM videos WHERE is_published=true`).Scan(&stats.TotalVideos)
	h.db.QueryRow(`SELECT COUNT(*) FROM video_views`).Scan(&stats.TotalViews)
	h.db.QueryRow(`SELECT COUNT(*) FROM video_likes`).Scan(&stats.TotalLikes)
	h.db.QueryRow(`SELECT COUNT(*) FROM comments`).Scan(&stats.TotalComments)
	h.db.QueryRow(`SELECT COALESCE(SUM(share_count),0) FROM videos`).Scan(&stats.TotalShares)
	c.JSON(http.StatusOK, stats)
}

// ListUsers returns all users with pagination
func (h *AdminHandler) ListUsers(c *gin.Context) {
	if _, ok := h.requireAdmin(c); !ok {
		return
	}
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	if page < 1 {
		page = 1
	}
	limit := 20
	offset := (page - 1) * limit
	q := "%" + c.DefaultQuery("q", "") + "%"

	rows, err := h.db.Query(`
		SELECT id, username, email, display_name, avatar_url, is_verified, is_admin,
			follower_count, following_count, total_likes, created_at
		FROM users
		WHERE username ILIKE $1 OR email ILIKE $1 OR display_name ILIKE $1
		ORDER BY created_at DESC
		LIMIT $2 OFFSET $3
	`, q, limit, offset)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "query failed"})
		return
	}
	defer rows.Close()

	type AdminUser struct {
		ID            string `json:"id"`
		Username      string `json:"username"`
		Email         string `json:"email"`
		DisplayName   string `json:"display_name"`
		AvatarURL     string `json:"avatar_url"`
		IsVerified    bool   `json:"is_verified"`
		IsAdmin       bool   `json:"is_admin"`
		FollowerCount int    `json:"follower_count"`
		FollowingCount int   `json:"following_count"`
		TotalLikes    int    `json:"total_likes"`
		CreatedAt     string `json:"created_at"`
	}
	var users []AdminUser
	for rows.Next() {
		var u AdminUser
		rows.Scan(&u.ID, &u.Username, &u.Email, &u.DisplayName, &u.AvatarURL,
			&u.IsVerified, &u.IsAdmin, &u.FollowerCount, &u.FollowingCount, &u.TotalLikes, &u.CreatedAt)
		users = append(users, u)
	}
	if users == nil {
		users = []AdminUser{}
	}

	var total int
	h.db.QueryRow(`SELECT COUNT(*) FROM users WHERE username ILIKE $1 OR email ILIKE $1`, q).Scan(&total)
	c.JSON(http.StatusOK, gin.H{"users": users, "total": total, "page": page})
}

// DeleteUser hard-deletes a user (cascades to their videos, likes, etc.)
func (h *AdminHandler) DeleteUser(c *gin.Context) {
	if _, ok := h.requireAdmin(c); !ok {
		return
	}
	targetID := c.Param("id")
	if len(targetID) != 36 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	result, err := h.db.Exec(`DELETE FROM users WHERE id=$1`, targetID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "delete failed"})
		return
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "user deleted"})
}

// SetUserAdmin grants or revokes admin role
func (h *AdminHandler) SetUserAdmin(c *gin.Context) {
	if _, ok := h.requireAdmin(c); !ok {
		return
	}
	targetID := c.Param("id")
	var body struct {
		IsAdmin bool `json:"is_admin"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
		return
	}
	h.db.Exec(`UPDATE users SET is_admin=$1 WHERE id=$2`, body.IsAdmin, targetID)
	c.JSON(http.StatusOK, gin.H{"message": "updated"})
}

// ListVideos returns all videos with pagination + optional search
func (h *AdminHandler) ListVideos(c *gin.Context) {
	if _, ok := h.requireAdmin(c); !ok {
		return
	}
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	if page < 1 {
		page = 1
	}
	limit := 20
	offset := (page - 1) * limit
	q := "%" + c.DefaultQuery("q", "") + "%"

	rows, err := h.db.Query(`
		SELECT v.id, v.user_id, v.title, v.description, v.video_url, v.thumbnail_url,
			v.duration, v.view_count, v.like_count, v.comment_count, v.share_count,
			v.save_count, v.hashtags, v.is_published, v.created_at,
			u.username, u.display_name, u.avatar_url, u.is_verified, u.follower_count
		FROM videos v JOIN users u ON u.id = v.user_id
		WHERE v.title ILIKE $1 OR v.description ILIKE $1 OR u.username ILIKE $1
		ORDER BY v.created_at DESC
		LIMIT $2 OFFSET $3
	`, q, limit, offset)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "query failed"})
		return
	}
	defer rows.Close()

	type AdminVideo struct {
		models.Video
		IsPublished bool `json:"is_published"`
	}
	var videos []AdminVideo
	for rows.Next() {
		var v AdminVideo
		var a models.User
		rows.Scan(&v.ID, &v.UserID, &v.Title, &v.Description, &v.VideoURL, &v.ThumbnailURL,
			&v.Duration, &v.ViewCount, &v.LikeCount, &v.CommentCount, &v.ShareCount, &v.SaveCount,
			pq.Array(&v.Hashtags), &v.IsPublished, &v.CreatedAt,
			&a.Username, &a.DisplayName, &a.AvatarURL, &a.IsVerified, &a.FollowerCount)
		a.ID = v.UserID
		v.Author = &a
		videos = append(videos, v)
	}
	if videos == nil {
		videos = []AdminVideo{}
	}

	var total int
	h.db.QueryRow(`SELECT COUNT(*) FROM videos WHERE title ILIKE $1 OR description ILIKE $1`, q).Scan(&total)
	c.JSON(http.StatusOK, gin.H{"videos": videos, "total": total, "page": page})
}

// DeleteVideo hard-deletes a video
func (h *AdminHandler) DeleteVideo(c *gin.Context) {
	if _, ok := h.requireAdmin(c); !ok {
		return
	}
	videoID := c.Param("id")
	if len(videoID) != 36 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	result, err := h.db.Exec(`DELETE FROM videos WHERE id=$1`, videoID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "delete failed"})
		return
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "video not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "video deleted"})
}

// ToggleVideoPublish toggles is_published on a video
func (h *AdminHandler) ToggleVideoPublish(c *gin.Context) {
	if _, ok := h.requireAdmin(c); !ok {
		return
	}
	videoID := c.Param("id")
	var body struct {
		IsPublished bool `json:"is_published"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
		return
	}
	h.db.Exec(`UPDATE videos SET is_published=$1 WHERE id=$2`, body.IsPublished, videoID)
	c.JSON(http.StatusOK, gin.H{"message": "updated"})
}
