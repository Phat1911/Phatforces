package handlers

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"photcot/internal/config"
	"photcot/internal/models"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

type CommentHandler struct {
	db  *sql.DB
	cfg *config.Config
}

type reactionHub struct {
	mu          sync.RWMutex
	subscribers map[string]map[chan string]struct{}
}

func newReactionHub() *reactionHub {
	return &reactionHub{
		subscribers: map[string]map[chan string]struct{}{},
	}
}

func (h *reactionHub) Subscribe(videoID string) chan string {
	ch := make(chan string, 32)
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.subscribers[videoID]; !ok {
		h.subscribers[videoID] = map[chan string]struct{}{}
	}
	h.subscribers[videoID][ch] = struct{}{}
	return ch
}

func (h *reactionHub) Unsubscribe(videoID string, ch chan string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if subs, ok := h.subscribers[videoID]; ok {
		delete(subs, ch)
		if len(subs) == 0 {
			delete(h.subscribers, videoID)
		}
	}
	close(ch)
}

func (h *reactionHub) Publish(videoID string, data string) {
	h.mu.RLock()
	subs := h.subscribers[videoID]
	h.mu.RUnlock()
	for ch := range subs {
		select {
		case ch <- data:
		default:
		}
	}
}

var commentReactionHub = newReactionHub()

var allowedCommentReactions = map[string]struct{}{
	"like":  {},
	"love":  {},
	"care":  {},
	"haha":  {},
	"wow":   {},
	"sad":   {},
	"angry": {},
}

func NewCommentHandler(db *sql.DB, cfg *config.Config) *CommentHandler {
	return &CommentHandler{db: db, cfg: cfg}
}

// extractToken tries to get JWT token from cookie, Authorization header, or query string
func extractToken(c *gin.Context) string {
	// Try cookie first (HttpOnly cookie from login)
	if token, err := c.Cookie("photcot_token"); err == nil && token != "" {
		return token
	}

	// Try Authorization header (Bearer token)
	authHeader := c.GetHeader("Authorization")
	if strings.HasPrefix(authHeader, "Bearer ") {
		return strings.TrimPrefix(authHeader, "Bearer ")
	}

	// Fallback to query string (legacy, for EventSource compatibility)
	return strings.TrimSpace(c.Query("token"))
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
			VALUES ($1, $2, $3, NULLIF($4, '')::uuid, $5, $6)
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
		CreateNotification(h.db, videoOwnerID, userID, "comment", &videoID, &comment.ID, msg)
	}

	if parent.Valid {
		var parentUserID string
		err := h.db.QueryRow(`SELECT user_id::text FROM comments WHERE id=$1`, parent.String).Scan(&parentUserID)
		if err == nil && parentUserID != "" && parentUserID != userID {
			msg := fmt.Sprintf("%s replied to your comment", actorUsername)
			CreateNotification(h.db, parentUserID, userID, "reply", &videoID, &parent.String, msg)
		}
	}

	return &comment, nil
}

func (h *CommentHandler) GetComments(c *gin.Context) {
	userID, _ := c.Get("user_id")
	videoID := c.Param("id")
	page := 1
	limit := 20
	if p, err := strconv.Atoi(c.DefaultQuery("page", "1")); err == nil && p > 0 {
		page = p
	}
	if l, err := strconv.Atoi(c.DefaultQuery("limit", "20")); err == nil && l > 0 {
		if l > 50 {
			l = 50
		}
		limit = l
	}
	rows, err := h.db.Query(`
		SELECT c.id, c.video_id, c.user_id, c.parent_id, c.content, c.image_url, c.like_count, c.created_at,
			u.username, u.display_name, u.avatar_url, u.is_verified
		FROM comments c JOIN users u ON u.id = c.user_id
		WHERE c.video_id = $1
		ORDER BY c.created_at ASC
		LIMIT 5000
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

	// Aggregate reaction counts per comment for this video.
	rRows, err := h.db.Query(`
		SELECT cr.comment_id::text, cr.reaction_type, COUNT(*)
		FROM comment_reactions cr
		JOIN comments c ON c.id = cr.comment_id
		WHERE c.video_id = $1
		GROUP BY cr.comment_id, cr.reaction_type
	`, videoID)
	if err == nil {
		defer rRows.Close()
		for rRows.Next() {
			var cid, rType string
			var cnt int
			if scanErr := rRows.Scan(&cid, &rType, &cnt); scanErr != nil {
				continue
			}
			if cm, ok := byID[cid]; ok {
				if cm.ReactionCounts == nil {
					cm.ReactionCounts = map[string]int{}
				}
				cm.ReactionCounts[rType] = cnt
			}
		}
	}

	// Current user's reaction per comment (if any).
	if uid := fmt.Sprintf("%v", userID); uid != "" {
		myRows, myErr := h.db.Query(`
			SELECT cr.comment_id::text, cr.reaction_type
			FROM comment_reactions cr
			JOIN comments c ON c.id = cr.comment_id
			WHERE c.video_id = $1 AND cr.user_id = $2
		`, videoID, uid)
		if myErr == nil {
			defer myRows.Close()
			for myRows.Next() {
				var cid, rType string
				if scanErr := myRows.Scan(&cid, &rType); scanErr != nil {
					continue
				}
				if cm, ok := byID[cid]; ok {
					cm.MyReaction = rType
				}
			}
		}
	}

	root := make([]models.Comment, 0)
	rootByID := make(map[string]int)
	for _, cm := range ordered {
		if cm.ParentID == nil {
			root = append(root, *cm)
			rootByID[cm.ID] = len(root) - 1
		}
	}

	findRootID := func(id string) string {
		curr, ok := byID[id]
		if !ok {
			return ""
		}
		for curr.ParentID != nil {
			next, ok := byID[*curr.ParentID]
			if !ok {
				return curr.ID
			}
			curr = next
		}
		return curr.ID
	}

	for _, cm := range ordered {
		if cm.ParentID == nil {
			continue
		}
		rootID := findRootID(cm.ID)
		if rootID == "" {
			root = append(root, *cm)
			rootByID[cm.ID] = len(root) - 1
			continue
		}
		if idx, ok := rootByID[rootID]; ok {
			root[idx].Replies = append(root[idx].Replies, *cm)
			continue
		}
		root = append(root, *cm)
		rootByID[cm.ID] = len(root) - 1
	}

	totalRoots := len(root)
	offset := (page - 1) * limit
	if offset > totalRoots {
		offset = totalRoots
	}
	end := offset + limit
	if end > totalRoots {
		end = totalRoots
	}
	paged := root[offset:end]
	hasMore := end < totalRoots

	c.JSON(http.StatusOK, gin.H{
		"comments":            paged,
		"page":                page,
		"limit":               limit,
		"has_more":            hasMore,
		"total_root_comments": totalRoots,
	})
}

func (h *CommentHandler) DeleteComment(c *gin.Context) {
	userID, _ := c.Get("user_id")
	commentID := c.Param("id")

	var videoID sql.NullString
	var deletedCount int
	err := h.db.QueryRow(`
		WITH RECURSIVE to_delete AS (
			SELECT id, video_id
			FROM comments
			WHERE id = $1 AND user_id = $2
			UNION ALL
			SELECT c.id, c.video_id
			FROM comments c
			JOIN to_delete td ON c.parent_id = td.id
		),
		deleted AS (
			DELETE FROM comments
			WHERE id IN (SELECT id FROM to_delete)
			RETURNING id
		)
		SELECT
			(SELECT video_id::text FROM to_delete LIMIT 1) AS video_id,
			(SELECT COUNT(*) FROM deleted) AS deleted_count
	`, commentID, userID).Scan(&videoID, &deletedCount)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "delete failed"})
		return
	}

	if !videoID.Valid || deletedCount == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "comment not found"})
		return
	}

	h.db.Exec(`UPDATE videos SET comment_count = GREATEST(comment_count - $2, 0) WHERE id = $1`, videoID.String, deletedCount)
	c.JSON(http.StatusOK, gin.H{"message": "deleted", "deleted_count": deletedCount})
}

func (h *CommentHandler) ReactToComment(c *gin.Context) {
	userID, _ := c.Get("user_id")
	uid := fmt.Sprintf("%v", userID)
	commentID := c.Param("id")

	var req struct {
		Type string `json:"type"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid payload"})
		return
	}
	reactionType := strings.ToLower(strings.TrimSpace(req.Type))
	if _, ok := allowedCommentReactions[reactionType]; !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid reaction type"})
		return
	}

	var videoID, commentOwnerID string
	if err := h.db.QueryRow(`SELECT video_id::text, user_id::text FROM comments WHERE id=$1`, commentID).Scan(&videoID, &commentOwnerID); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "comment not found"})
		return
	}

	previousReaction := ""
	_ = h.db.QueryRow(`SELECT reaction_type FROM comment_reactions WHERE user_id=$1 AND comment_id=$2`, uid, commentID).Scan(&previousReaction)

	_, err := h.db.Exec(`
		INSERT INTO comment_reactions (user_id, comment_id, reaction_type)
		VALUES ($1, $2, $3)
		ON CONFLICT (user_id, comment_id)
		DO UPDATE SET reaction_type = EXCLUDED.reaction_type, created_at = NOW()
	`, uid, commentID, reactionType)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to react"})
		return
	}

	counts, my := h.getCommentReactionSnapshot(commentID, uid)
	h.publishCommentReactionUpdate(videoID, commentID, counts)
	if previousReaction == "" && commentOwnerID != "" && commentOwnerID != uid {
		actorUsername, _, _ := GetActorInfo(h.db, uid, videoID)
		msg := fmt.Sprintf("%s reacted to your comment", actorUsername)
		CreateNotification(h.db, commentOwnerID, uid, "reaction", &videoID, &commentID, msg)
	}
	c.JSON(http.StatusOK, gin.H{"reaction_counts": counts, "my_reaction": my})
}

func (h *CommentHandler) RemoveReaction(c *gin.Context) {
	userID, _ := c.Get("user_id")
	uid := fmt.Sprintf("%v", userID)
	commentID := c.Param("id")
	var videoID string
	if err := h.db.QueryRow(`SELECT video_id::text FROM comments WHERE id=$1`, commentID).Scan(&videoID); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "comment not found"})
		return
	}

	_, err := h.db.Exec(`DELETE FROM comment_reactions WHERE user_id=$1 AND comment_id=$2`, uid, commentID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to remove reaction"})
		return
	}

	counts, my := h.getCommentReactionSnapshot(commentID, uid)
	h.publishCommentReactionUpdate(videoID, commentID, counts)
	c.JSON(http.StatusOK, gin.H{"reaction_counts": counts, "my_reaction": my})
}

func (h *CommentHandler) publishCommentReactionUpdate(videoID, commentID string, counts map[string]int) {
	if videoID == "" || commentID == "" {
		return
	}
	type reactionEvent struct {
		CommentID      string         `json:"comment_id"`
		ReactionCounts map[string]int `json:"reaction_counts"`
		SentAt         time.Time      `json:"sent_at"`
	}
	payload, err := json.Marshal(reactionEvent{
		CommentID:      commentID,
		ReactionCounts: counts,
		SentAt:         time.Now().UTC(),
	})
	if err != nil {
		return
	}
	commentReactionHub.Publish(videoID, string(payload))
}

func (h *CommentHandler) StreamCommentReactions(c *gin.Context) {
	videoID := strings.TrimSpace(c.Query("video_id"))
	tokenStr := extractToken(c)
	
	if videoID == "" || tokenStr == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "video_id is required, and token must be in cookie, Authorization header, or query string"})
		return
	}

	token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return []byte(h.cfg.JWTSecret), nil
	})
	if err != nil || !token.Valid {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid token"})
		return
	}

	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid claims"})
		return
	}
	uid := fmt.Sprintf("%v", claims["user_id"])
	if uid == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid user"})
		return
	}

	var exists bool
	if scanErr := h.db.QueryRow(`SELECT EXISTS(SELECT 1 FROM users WHERE id=$1)`, uid).Scan(&exists); scanErr != nil || !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "account not found"})
		return
	}

	flusher, ok := c.Writer.(http.Flusher)
	if !ok {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "streaming unsupported"})
		return
	}

	c.Writer.Header().Set("Content-Type", "text/event-stream")
	c.Writer.Header().Set("Cache-Control", "no-cache")
	c.Writer.Header().Set("Connection", "keep-alive")
	c.Writer.Header().Set("X-Accel-Buffering", "no")

	ch := commentReactionHub.Subscribe(videoID)
	defer commentReactionHub.Unsubscribe(videoID, ch)

	fmt.Fprintf(c.Writer, "event: connected\ndata: {\"ok\":true}\n\n")
	flusher.Flush()

	heartbeat := time.NewTicker(25 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-c.Request.Context().Done():
			return
		case data := <-ch:
			fmt.Fprintf(c.Writer, "event: reaction\ndata: %s\n\n", data)
			flusher.Flush()
		case <-heartbeat.C:
			fmt.Fprintf(c.Writer, ": keepalive\n\n")
			flusher.Flush()
		}
	}
}

func (h *CommentHandler) getCommentReactionSnapshot(commentID, userID string) (map[string]int, string) {
	counts := map[string]int{}

	rows, err := h.db.Query(`
		SELECT reaction_type, COUNT(*)
		FROM comment_reactions
		WHERE comment_id = $1
		GROUP BY reaction_type
	`, commentID)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var t string
			var n int
			if scanErr := rows.Scan(&t, &n); scanErr != nil {
				continue
			}
			counts[t] = n
		}
	}

	myReaction := ""
	_ = h.db.QueryRow(`SELECT reaction_type FROM comment_reactions WHERE comment_id=$1 AND user_id=$2`, commentID, userID).Scan(&myReaction)

	return counts, myReaction
}

func (h *CommentHandler) GetCommentReactions(c *gin.Context) {
	commentID := c.Param("id")

	var exists bool
	if err := h.db.QueryRow(`SELECT EXISTS(SELECT 1 FROM comments WHERE id=$1)`, commentID).Scan(&exists); err != nil || !exists {
		c.JSON(http.StatusNotFound, gin.H{"error": "comment not found"})
		return
	}

	rows, err := h.db.Query(`
		SELECT
			cr.user_id::text,
			COALESCE(u.username, ''),
			COALESCE(u.display_name, ''),
			COALESCE(u.avatar_url, ''),
			cr.reaction_type,
			cr.created_at
		FROM comment_reactions cr
		JOIN users u ON u.id = cr.user_id
		WHERE cr.comment_id = $1
		ORDER BY cr.created_at DESC
		LIMIT 500
	`, commentID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load reactions"})
		return
	}
	defer rows.Close()

	type Reactor struct {
		UserID      string    `json:"user_id"`
		Username    string    `json:"username"`
		DisplayName string    `json:"display_name"`
		AvatarURL   string    `json:"avatar_url"`
		Type        string    `json:"type"`
		CreatedAt   time.Time `json:"created_at"`
	}

	reactors := make([]Reactor, 0)
	summary := map[string]int{}

	for rows.Next() {
		var r Reactor
		if scanErr := rows.Scan(&r.UserID, &r.Username, &r.DisplayName, &r.AvatarURL, &r.Type, &r.CreatedAt); scanErr != nil {
			continue
		}
		reactors = append(reactors, r)
		summary[r.Type]++
	}

	c.JSON(http.StatusOK, gin.H{
		"reactors": reactors,
		"summary":  summary,
	})
}
