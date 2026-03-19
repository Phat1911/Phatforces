package handlers

import (
	"database/sql"
	"fmt"
	"net/http"
	"strings"

	"photcot/internal/models"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/lib/pq"
)

type SearchHandler struct {
	db        *sql.DB
	jwtSecret string
}

func NewSearchHandler(db *sql.DB, jwtSecret ...string) *SearchHandler {
	secret := ""
	if len(jwtSecret) > 0 {
		secret = jwtSecret[0]
	}
	return &SearchHandler{db: db, jwtSecret: secret}
}

// extractKeywords splits a raw search query into lowercase keyword tokens.
// Strips # prefix so "#cats" becomes "cats" (matching hashtag format in the DB).
func extractKeywords(query string) []string {
	words := strings.Fields(strings.ToLower(query))
	out := make([]string, 0, len(words))
	for _, w := range words {
		w = strings.TrimPrefix(w, "#")
		w = strings.Trim(w, ",./!?;:")
		if len(w) >= 2 {
			out = append(out, w)
		}
	}
	return out
}

// tryExtractUserID attempts to parse the Bearer JWT from the request without requiring it.
// Returns "" if no token or invalid token - used for optional-auth routes.
func (h *SearchHandler) tryExtractUserID(c *gin.Context) string {
	// First check if middleware already set it
	if uid, ok := c.Get("user_id"); ok && uid != nil {
		return fmt.Sprintf("%v", uid)
	}
	// Try to parse from Authorization header
	header := c.GetHeader("Authorization")
	if h.jwtSecret == "" || !strings.HasPrefix(header, "Bearer ") {
		return ""
	}
	tokenStr := strings.TrimPrefix(header, "Bearer ")
	token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected alg")
		}
		return []byte(h.jwtSecret), nil
	})
	if err != nil || !token.Valid {
		return ""
	}
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return ""
	}
	uid, _ := claims["user_id"].(string)
	return uid
}

// SaveSearchHistory saves a search query for an authenticated user (max 20, deduplicates).
func (h *SearchHandler) SaveSearchHistory(c *gin.Context) {
	userID, _ := c.Get("user_id")
	var req struct {
		Query string `json:"query"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Query) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "query is required"})
		return
	}
	q := strings.TrimSpace(req.Query)
	// Delete existing same query for this user (dedup)
	h.db.Exec(`DELETE FROM search_history WHERE user_id=$1 AND query=$2`, userID, q)
	// Insert fresh entry on top
	h.db.Exec(`INSERT INTO search_history (user_id, query) VALUES ($1, $2)`, userID, q)
	// Keep only last 20 per user
	h.db.Exec(`
		DELETE FROM search_history WHERE id IN (
			SELECT id FROM search_history WHERE user_id=$1
			ORDER BY created_at DESC OFFSET 20
		)`, userID)
	c.JSON(http.StatusOK, gin.H{"message": "saved"})
}

// GetSearchHistory returns the last 20 search queries for the authenticated user.
func (h *SearchHandler) GetSearchHistory(c *gin.Context) {
	userID, _ := c.Get("user_id")
	rows, err := h.db.Query(
		`SELECT id, query, created_at FROM search_history WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`,
		userID,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed"})
		return
	}
	defer rows.Close()
	type Entry struct {
		ID        string `json:"id"`
		Query     string `json:"query"`
		CreatedAt string `json:"created_at"`
	}
	var history []Entry
	for rows.Next() {
		var e Entry
		rows.Scan(&e.ID, &e.Query, &e.CreatedAt)
		history = append(history, e)
	}
	if history == nil {
		history = []Entry{}
	}
	c.JSON(http.StatusOK, gin.H{"history": history})
}

// DeleteSearchHistory deletes a single search history entry by ID.
func (h *SearchHandler) DeleteSearchHistory(c *gin.Context) {
	userID, _ := c.Get("user_id")
	id := c.Param("id")
	res, err := h.db.Exec(`DELETE FROM search_history WHERE id=$1 AND user_id=$2`, id, userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed"})
		return
	}
	rows, _ := res.RowsAffected()
	if rows == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "deleted"})
}

// ClearSearchHistory deletes all search history for the authenticated user.
func (h *SearchHandler) ClearSearchHistory(c *gin.Context) {
	userID, _ := c.Get("user_id")
	h.db.Exec(`DELETE FROM search_history WHERE user_id=$1`, userID)
	c.JSON(http.StatusOK, gin.H{"message": "cleared"})
}

func (h *SearchHandler) Search(c *gin.Context) {
	rawQuery := c.Query("q")
	q := "%" + rawQuery + "%"
	searchType := c.DefaultQuery("type", "all")

	result := gin.H{}

	if searchType == "all" || searchType == "videos" {
		rows, _ := h.db.Query(`
			SELECT v.id, v.user_id, v.title, v.video_url, v.thumbnail_url, v.duration,
				v.view_count, v.like_count, v.comment_count, v.share_count, v.hashtags, v.created_at,
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
					&v.ViewCount, &v.LikeCount, &v.CommentCount, &v.ShareCount, pq.Array(&v.Hashtags), &v.CreatedAt,
					&a.Username, &a.DisplayName, &a.AvatarURL, &a.IsVerified)
				a.ID = v.UserID
				v.Author = &a
				videos = append(videos, v)
			}
		}
		result["videos"] = videos
	}

	if searchType == "all" || searchType == "users" {
		currentUserID := h.tryExtractUserID(c)
		rows, _ := h.db.Query(`
			SELECT id, username, display_name, avatar_url, is_verified, follower_count
			FROM users WHERE (username ILIKE $1 OR display_name ILIKE $1) AND is_admin = false
			ORDER BY follower_count DESC LIMIT 10
		`, q)
		var users []models.User
		if rows != nil {
			defer rows.Close()
			for rows.Next() {
				var u models.User
				rows.Scan(&u.ID, &u.Username, &u.DisplayName, &u.AvatarURL, &u.IsVerified, &u.FollowerCount)
				// Check is_following for authenticated users
				if currentUserID != "" && currentUserID != fmt.Sprintf("%v", u.ID) {
					var cnt int
					h.db.QueryRow(
						`SELECT COUNT(*) FROM follows WHERE follower_id=$1 AND following_id=$2`,
						currentUserID, u.ID,
					).Scan(&cnt)
					u.IsFollowing = cnt > 0
				}
				users = append(users, u)
			}
		}
		result["users"] = users
	}

	// Fire search signal to recommender for authenticated users.
	// Uses optional JWT extraction since /search is a public route.
	if len(rawQuery) >= 2 {
		if userID := h.tryExtractUserID(c); userID != "" {
			keywords := extractKeywords(rawQuery)
			if len(keywords) > 0 {
				SendSearchSignal(userID, rawQuery, keywords)
			}
		}
	}

	c.JSON(http.StatusOK, result)
}

func (h *SearchHandler) Trending(c *gin.Context) {
	rows, err := h.db.Query(`
		SELECT v.id, v.user_id, v.title, v.video_url, v.thumbnail_url, v.duration,
			v.view_count, v.like_count, v.comment_count, v.share_count, v.hashtags, v.created_at,
			u.username, u.display_name, u.avatar_url, u.is_verified, u.follower_count
		FROM videos v JOIN users u ON u.id = v.user_id
		WHERE v.is_published = true
		ORDER BY (v.like_count * 3 + v.comment_count * 5 + v.share_count * 7 + v.view_count * 0.1)
			* POWER(EXTRACT(EPOCH FROM (NOW() - v.created_at + INTERVAL '1 hour')) / 3600.0, -0.5) DESC
		LIMIT 30
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
			&v.ViewCount, &v.LikeCount, &v.CommentCount, &v.ShareCount, pq.Array(&v.Hashtags), &v.CreatedAt,
			&a.Username, &a.DisplayName, &a.AvatarURL, &a.IsVerified, &a.FollowerCount)
		a.ID = v.UserID
		v.Author = &a
		videos = append(videos, v)
	}
	c.JSON(http.StatusOK, gin.H{"videos": videos})
}
