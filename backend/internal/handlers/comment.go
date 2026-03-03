package handlers

import (
	"database/sql"
	"net/http"
	"photcot/internal/models"
	"github.com/gin-gonic/gin"
)

type CommentHandler struct { db *sql.DB }
func NewCommentHandler(db *sql.DB) *CommentHandler { return &CommentHandler{db: db} }

func (h *CommentHandler) AddComment(c *gin.Context) {
	userID, _ := c.Get("user_id")
	videoID := c.Param("id")

	var req struct{ Content string `json:"content" binding:"required"` }
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var comment models.Comment
	var author models.User
	err := h.db.QueryRow(`
		WITH ins AS (
			INSERT INTO comments (video_id, user_id, content) VALUES ($1, $2, $3)
			RETURNING id, video_id, user_id, content, created_at
		)
		SELECT ins.id, ins.video_id, ins.user_id, ins.content, ins.created_at,
			u.username, u.display_name, u.avatar_url
		FROM ins JOIN users u ON u.id = ins.user_id
	`, videoID, userID, req.Content).Scan(
		&comment.ID, &comment.VideoID, &comment.UserID, &comment.Content, &comment.CreatedAt,
		&author.Username, &author.DisplayName, &author.AvatarURL,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to add comment"})
		return
	}

	h.db.Exec(`UPDATE videos SET comment_count = comment_count + 1 WHERE id = $1`, videoID)
	author.ID = comment.UserID
	comment.Author = &author
	c.JSON(http.StatusCreated, comment)
}

func (h *CommentHandler) GetComments(c *gin.Context) {
	videoID := c.Param("id")
	rows, err := h.db.Query(`
		SELECT c.id, c.video_id, c.user_id, c.content, c.like_count, c.created_at,
			u.username, u.display_name, u.avatar_url, u.is_verified
		FROM comments c JOIN users u ON u.id = c.user_id
		WHERE c.video_id = $1 ORDER BY c.created_at DESC LIMIT 50
	`, videoID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed"})
		return
	}
	defer rows.Close()

	var comments []models.Comment
	for rows.Next() {
		var cm models.Comment
		var a models.User
		rows.Scan(&cm.ID, &cm.VideoID, &cm.UserID, &cm.Content, &cm.LikeCount, &cm.CreatedAt,
			&a.Username, &a.DisplayName, &a.AvatarURL, &a.IsVerified)
		a.ID = cm.UserID
		cm.Author = &a
		comments = append(comments, cm)
	}
	c.JSON(http.StatusOK, gin.H{"comments": comments})
}

func (h *CommentHandler) DeleteComment(c *gin.Context) {
	userID, _ := c.Get("user_id")
	commentID := c.Param("id")
	h.db.Exec(`DELETE FROM comments WHERE id=$1 AND user_id=$2`, commentID, userID)
	c.JSON(http.StatusOK, gin.H{"message": "deleted"})
}
