package handlers

import (
	"database/sql"
	"net/http"
	"photcot/internal/models"
	"github.com/gin-gonic/gin"
)

type SearchHandler struct { db *sql.DB }
func NewSearchHandler(db *sql.DB) *SearchHandler { return &SearchHandler{db: db} }

func (h *SearchHandler) Search(c *gin.Context) {
	q := "%" + c.Query("q") + "%"
	searchType := c.DefaultQuery("type", "all")

	result := gin.H{}

	if searchType == "all" || searchType == "videos" {
		rows, _ := h.db.Query(`
			SELECT v.id, v.user_id, v.title, v.video_url, v.thumbnail_url, v.duration,
				v.view_count, v.like_count, v.hashtags, v.created_at,
				u.username, u.display_name, u.avatar_url, u.is_verified
			FROM videos v JOIN users u ON u.id = v.user_id
			WHERE v.is_published = true AND (v.title ILIKE $1 OR v.description ILIKE $1 OR $1 = ANY(v.hashtags))
			ORDER BY v.like_count DESC LIMIT 20
		`, q)
		var videos []models.Video
		if rows != nil {
			defer rows.Close()
			for rows.Next() {
				var v models.Video
				var a models.User
				rows.Scan(&v.ID, &v.UserID, &v.Title, &v.VideoURL, &v.ThumbnailURL, &v.Duration,
					&v.ViewCount, &v.LikeCount, &v.Hashtags, &v.CreatedAt,
					&a.Username, &a.DisplayName, &a.AvatarURL, &a.IsVerified)
				a.ID = v.UserID
				v.Author = &a
				videos = append(videos, v)
			}
		}
		result["videos"] = videos
	}

	if searchType == "all" || searchType == "users" {
		rows, _ := h.db.Query(`
			SELECT id, username, display_name, avatar_url, is_verified, follower_count
			FROM users WHERE username ILIKE $1 OR display_name ILIKE $1
			ORDER BY follower_count DESC LIMIT 10
		`, q)
		var users []models.User
		if rows != nil {
			defer rows.Close()
			for rows.Next() {
				var u models.User
				rows.Scan(&u.ID, &u.Username, &u.DisplayName, &u.AvatarURL, &u.IsVerified, &u.FollowerCount)
				users = append(users, u)
			}
		}
		result["users"] = users
	}

	c.JSON(http.StatusOK, result)
}

func (h *SearchHandler) Trending(c *gin.Context) {
	rows, err := h.db.Query(`
		SELECT v.id, v.user_id, v.title, v.video_url, v.thumbnail_url, v.duration,
			v.view_count, v.like_count, v.hashtags, v.created_at,
			u.username, u.display_name, u.avatar_url, u.is_verified
		FROM videos v JOIN users u ON u.id = v.user_id
		WHERE v.is_published = true AND v.created_at > NOW() - INTERVAL '7 days'
		ORDER BY v.like_count + v.view_count DESC LIMIT 20
	`)
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
			&v.ViewCount, &v.LikeCount, &v.Hashtags, &v.CreatedAt,
			&a.Username, &a.DisplayName, &a.AvatarURL, &a.IsVerified)
		a.ID = v.UserID
		v.Author = &a
		videos = append(videos, v)
	}
	c.JSON(http.StatusOK, gin.H{"videos": videos})
}
