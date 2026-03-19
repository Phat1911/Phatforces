package handlers

import (
	"database/sql"
	"fmt"
	"net/http"
	"strings"
	"photcot/internal/models"
	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/redis/go-redis/v9"
)

type UserHandler struct {
	db        *sql.DB
	rdb       *redis.Client
	jwtSecret string
}

func NewUserHandler(db *sql.DB, rdb *redis.Client, jwtSecret ...string) *UserHandler {
	secret := ""
	if len(jwtSecret) > 0 {
		secret = jwtSecret[0]
	}
	return &UserHandler{db: db, rdb: rdb, jwtSecret: secret}
}

// tryGetUserID extracts user_id from context (set by auth middleware) OR
// parses it directly from the Bearer token - for optional-auth public routes.
func (h *UserHandler) tryGetUserID(c *gin.Context) string {
	if uid, ok := c.Get("user_id"); ok && uid != nil {
		return fmt.Sprintf("%v", uid)
	}
	if h.jwtSecret == "" {
		return ""
	}
	header := c.GetHeader("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
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

func (h *UserHandler) GetProfile(c *gin.Context) {
	username := c.Param("username")
	currentUserID := h.tryGetUserID(c)

	var user models.User
	err := h.db.QueryRow(`
		SELECT id, username, display_name, bio, avatar_url, is_verified,
			follower_count, following_count, total_likes, created_at
		FROM users WHERE username = $1
	`, username).Scan(
		&user.ID, &user.Username, &user.DisplayName, &user.Bio,
		&user.AvatarURL, &user.IsVerified, &user.FollowerCount,
		&user.FollowingCount, &user.TotalLikes, &user.CreatedAt,
	)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}

	// Check if current user follows this user
	if currentUserID != "" {
		var count int
		h.db.QueryRow(`SELECT COUNT(*) FROM follows WHERE follower_id=$1 AND following_id=$2`,
			currentUserID, user.ID).Scan(&count)
		user.IsFollowing = count > 0
	}

	c.JSON(http.StatusOK, user)
}

func (h *UserHandler) UpdateProfile(c *gin.Context) {
	userID, _ := c.Get("user_id")
	var req struct {
		DisplayName string `json:"display_name"`
		Bio         string `json:"bio"`
		AvatarURL   string `json:"avatar_url"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	_, err := h.db.Exec(`
		UPDATE users SET display_name=$1, bio=$2, avatar_url=$3, updated_at=NOW()
		WHERE id=$4
	`, req.DisplayName, req.Bio, req.AvatarURL, userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "update failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "profile updated"})
}

func (h *UserHandler) Follow(c *gin.Context) {
	followerID, _ := c.Get("user_id")
	followingID := c.Param("id")

	if followerID == followingID {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cannot follow yourself"})
		return
	}

	// FIXED: Atomic CTE - only update counters when the row was actually inserted
	var inserted int
	err := h.db.QueryRow(`
		WITH ins AS (
			INSERT INTO follows (follower_id, following_id) VALUES ($1, $2)
			ON CONFLICT DO NOTHING
			RETURNING 1
		)
		SELECT COUNT(*) FROM ins
	`, followerID, followingID).Scan(&inserted)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "follow failed"})
		return
	}
	if inserted > 0 {
		h.db.Exec(`UPDATE users SET follower_count = follower_count + 1 WHERE id = $1`, followingID)
		h.db.Exec(`UPDATE users SET following_count = following_count + 1 WHERE id = $1`, followerID)
		// Notification + recommender signal
		var actorName string
		h.db.QueryRow(`SELECT username FROM users WHERE id=$1`, followerID).Scan(&actorName)
		msg := fmt.Sprintf("%s started following you", actorName)
		CreateNotification(h.db, fmt.Sprintf("%v", followingID), fmt.Sprintf("%v", followerID), "follow", nil, nil, msg)
		SendFollowSignal(fmt.Sprintf("%v", followerID), fmt.Sprintf("%v", followingID))
	}
	c.JSON(http.StatusOK, gin.H{"message": "followed"})
}

func (h *UserHandler) Unfollow(c *gin.Context) {
	followerID, _ := c.Get("user_id")
	followingID := c.Param("id")

	result, err := h.db.Exec(`DELETE FROM follows WHERE follower_id=$1 AND following_id=$2`, followerID, followingID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "unfollow failed"})
		return
	}
	rows, _ := result.RowsAffected()
	if rows > 0 {
		h.db.Exec(`UPDATE users SET follower_count = follower_count - 1 WHERE id = $1 AND follower_count > 0`, followingID)
		h.db.Exec(`UPDATE users SET following_count = following_count - 1 WHERE id = $1 AND following_count > 0`, followerID)
	}
	c.JSON(http.StatusOK, gin.H{"message": "unfollowed"})
}

func (h *UserHandler) GetFollowers(c *gin.Context) {
	userID := c.Param("id")
	rows, err := h.db.Query(`
		SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_verified, u.follower_count
		FROM follows f JOIN users u ON u.id = f.follower_id
		WHERE f.following_id = $1 AND u.is_admin = false ORDER BY f.created_at DESC LIMIT 50
	`, userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed"})
		return
	}
	defer rows.Close()
	var users []models.User
	for rows.Next() {
		var u models.User
		rows.Scan(&u.ID, &u.Username, &u.DisplayName, &u.AvatarURL, &u.IsVerified, &u.FollowerCount)
		users = append(users, u)
	}
	c.JSON(http.StatusOK, gin.H{"users": users})
}

func (h *UserHandler) GetFollowing(c *gin.Context) {
	userID := c.Param("id")
	rows, err := h.db.Query(`
		SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_verified, u.follower_count
		FROM follows f JOIN users u ON u.id = f.following_id
		WHERE f.follower_id = $1 AND u.is_admin = false ORDER BY f.created_at DESC LIMIT 50
	`, userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed"})
		return
	}
	defer rows.Close()
	var users []models.User
	for rows.Next() {
		var u models.User
		rows.Scan(&u.ID, &u.Username, &u.DisplayName, &u.AvatarURL, &u.IsVerified, &u.FollowerCount)
		users = append(users, u)
	}
	c.JSON(http.StatusOK, gin.H{"users": users})
}
