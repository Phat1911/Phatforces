package handlers

import (
	"database/sql"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"photcot/internal/config"
	"photcot/internal/models"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type CommentHandler struct {
	db  *sql.DB
	cfg *config.Config
}

func NewCommentHandler(db *sql.DB, cfg *config.Config) *CommentHandler {
	return &CommentHandler{db: db, cfg: cfg}
}

func (h *CommentHandler) AddComment(c *gin.Context) {
	userID, _ := c.Get("user_id")
	videoID := c.Param("id")

	var content string
	var parentID string
	imageURL := ""

	if strings.HasPrefix(c.GetHeader("Content-Type"), "multipart/form-data") {
		content = strings.TrimSpace(c.PostForm("content"))
		parentID = strings.TrimSpace(c.PostForm("parent_id"))

		file, header, err := c.Request.FormFile("image")
		if err == nil && header != nil {
			defer file.Close()
			sniff := make([]byte, 512)
			n, _ := file.Read(sniff)
			mime := http.DetectContentType(sniff[:n])
			file.Seek(0, io.SeekStart)
			if !strings.HasPrefix(mime, "image/") {
				c.JSON(http.StatusBadRequest, gin.H{"error": "only image files are allowed for comments"})
				return
			}

			commentID := uuid.New().String()
			dir := filepath.Join(h.cfg.UploadDir, "comments", commentID)
			if err := os.MkdirAll(dir, 0755); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create comment upload dir"})
				return
			}
			ext := filepath.Ext(header.Filename)
			if ext == "" {
				ext = ".jpg"
			}
			imgPath := filepath.Join(dir, "image"+ext)
			out, err := os.Create(imgPath)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save comment image"})
				return
			}
			if _, err := io.Copy(out, file); err != nil {
				out.Close()
				c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to write comment image"})
				return
			}
			out.Close()
			imageURL = fmt.Sprintf("/uploads/comments/%s/image%s", commentID, ext)

			if content == "" && imageURL == "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": "comment text or image is required"})
				return
			}

			comment, err := h.insertComment(c, commentID, fmt.Sprintf("%v", userID), videoID, content, parentID, imageURL)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to add comment"})
				return
			}
			c.JSON(http.StatusCreated, comment)
			return
		}
	} else {
		var req struct {
			Content  string `json:"content"`
			ParentID string `json:"parent_id"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		content = strings.TrimSpace(req.Content)
		parentID = strings.TrimSpace(req.ParentID)
	}

	if content == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "comment text or image is required"})
		return
	}

	commentID := uuid.New().String()
	comment, err := h.insertComment(c, commentID, fmt.Sprintf("%v", userID), videoID, content, parentID, imageURL)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to add comment"})
		return
	}
	c.JSON(http.StatusCreated, comment)
}

func (h *CommentHandler) insertComment(c *gin.Context, commentID, userID, videoID, content, parentID, imageURL string) (*models.Comment, error) {
	if parentID != "" {
		var exists bool
		err := h.db.QueryRow(`SELECT EXISTS(SELECT 1 FROM comments WHERE id=$1 AND video_id=$2)`, parentID, videoID).Scan(&exists)
		if err != nil || !exists {
			return nil, fmt.Errorf("invalid parent comment")
		}
	}

	var comment models.Comment
	var author models.User
	var parent sql.NullString
	err := h.db.QueryRow(`
		WITH ins AS (
			INSERT INTO comments (id, video_id, user_id, parent_id, content, image_url)
			VALUES ($1, $2, $3, NULLIF($4,''), $5, $6)
			RETURNING id, video_id, user_id, parent_id, content, image_url, created_at
		)
		SELECT ins.id, ins.video_id, ins.user_id, ins.parent_id, ins.content, ins.image_url, ins.created_at,
			u.username, u.display_name, u.avatar_url
		FROM ins JOIN users u ON u.id = ins.user_id
	`, commentID, videoID, userID, parentID, content, imageURL).Scan(
		&comment.ID, &comment.VideoID, &comment.UserID, &parent, &comment.Content, &comment.ImageURL, &comment.CreatedAt,
		&author.Username, &author.DisplayName, &author.AvatarURL,
	)
	if err != nil {
		return nil, err
	}

	h.db.Exec(`UPDATE videos SET comment_count = comment_count + 1 WHERE id = $1`, videoID)
	author.ID = comment.UserID
	comment.Author = &author
	if parent.Valid {
		comment.ParentID = &parent.String
	}

	actorUsername, videoOwnerID, videoTitle := GetActorInfo(h.db, userID, videoID)
	if videoOwnerID != "" {
		msg := fmt.Sprintf("%s commented on your video \"%.40s\"", actorUsername, videoTitle)
		CreateNotification(h.db, videoOwnerID, userID, "comment", &videoID, msg)
	}

	return &comment, nil
}

func (h *CommentHandler) GetComments(c *gin.Context) {
	videoID := c.Param("id")
	rows, err := h.db.Query(`
		SELECT c.id, c.video_id, c.user_id, c.parent_id, c.content, c.image_url, c.like_count, c.created_at,
			u.username, u.display_name, u.avatar_url, u.is_verified
		FROM comments c JOIN users u ON u.id = c.user_id
		WHERE c.video_id = $1
		ORDER BY c.created_at DESC
		LIMIT 100
	`, videoID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed"})
		return
	}
	defer rows.Close()

	byID := make(map[string]*models.Comment)
	ordered := make([]*models.Comment, 0)
	for rows.Next() {
		var cm models.Comment
		var a models.User
		var parent sql.NullString
		rows.Scan(&cm.ID, &cm.VideoID, &cm.UserID, &parent, &cm.Content, &cm.ImageURL, &cm.LikeCount, &cm.CreatedAt,
			&a.Username, &a.DisplayName, &a.AvatarURL, &a.IsVerified)
		a.ID = cm.UserID
		cm.Author = &a
		if parent.Valid {
			cm.ParentID = &parent.String
		}
		cm.Replies = []models.Comment{}
		copy := cm
		byID[cm.ID] = &copy
		ordered = append(ordered, &copy)
	}

	root := make([]models.Comment, 0)
	for _, cm := range ordered {
		if cm.ParentID != nil {
			if parent, ok := byID[*cm.ParentID]; ok {
				parent.Replies = append(parent.Replies, *cm)
				continue
			}
		}
		root = append(root, *cm)
	}

	c.JSON(http.StatusOK, gin.H{"comments": root})
}

func (h *CommentHandler) DeleteComment(c *gin.Context) {
	userID, _ := c.Get("user_id")
	commentID := c.Param("id")

	var videoID string
	err := h.db.QueryRow(`SELECT video_id FROM comments WHERE id=$1 AND user_id=$2`, commentID, userID).Scan(&videoID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "comment not found"})
		return
	}

	result, err := h.db.Exec(`DELETE FROM comments WHERE id=$1 AND user_id=$2`, commentID, userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "delete failed"})
		return
	}
	rows, _ := result.RowsAffected()
	if rows > 0 {
		h.db.Exec(`UPDATE videos SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = $1`, videoID)
	}
	c.JSON(http.StatusOK, gin.H{"message": "deleted"})
}
