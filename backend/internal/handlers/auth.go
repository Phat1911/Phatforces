package handlers

import (
	"database/sql"
	"net/http"
	"strings"
	"time"

	"photcot/internal/config"
	"photcot/internal/models"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

type AuthHandler struct {
	db  *sql.DB
	cfg *config.Config
}

func NewAuthHandler(db *sql.DB, cfg *config.Config) *AuthHandler {
	return &AuthHandler{db: db, cfg: cfg}
}

func (h *AuthHandler) Register(c *gin.Context) {
	var req models.RegisterRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	req.Email = strings.ToLower(strings.TrimSpace(req.Email))

	if len(req.Password) < 6 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "password must be at least 6 characters"})
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to hash password"})
		return
	}

	var user models.User
	err = h.db.QueryRow(`
		INSERT INTO users (username, email, password_hash, display_name)
		VALUES ($1, $2, $3, $4)
		RETURNING id, username, email, display_name, bio, avatar_url, is_verified, follower_count, following_count, total_likes, created_at
	`, req.Username, req.Email, string(hash), req.Username).Scan(
		&user.ID, &user.Username, &user.Email, &user.DisplayName,
		&user.Bio, &user.AvatarURL, &user.IsVerified,
		&user.FollowerCount, &user.FollowingCount, &user.TotalLikes, &user.CreatedAt,
	)
	if err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": "username or email already exists"})
		return
	}

	token := h.generateToken(user.ID, user.Username, false)
	c.JSON(http.StatusCreated, models.AuthResponse{Token: token, User: &user})
}

func (h *AuthHandler) Login(c *gin.Context) {
	var req models.LoginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var user models.User
	var passwordHash string
	var isAdmin bool
	err := h.db.QueryRow(`
		SELECT id, username, email, display_name, bio, avatar_url, is_verified,
			follower_count, following_count, total_likes, created_at, password_hash, is_admin
		FROM users WHERE email = $1
	`, strings.ToLower(strings.TrimSpace(req.Email))).Scan(
		&user.ID, &user.Username, &user.Email, &user.DisplayName,
		&user.Bio, &user.AvatarURL, &user.IsVerified,
		&user.FollowerCount, &user.FollowingCount, &user.TotalLikes, &user.CreatedAt,
		&passwordHash, &isAdmin,
	)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte(req.Password)); err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
		return
	}

	token := h.generateToken(user.ID, user.Username, isAdmin)
	c.JSON(http.StatusOK, models.AuthResponse{Token: token, User: &user})
}

func (h *AuthHandler) RefreshToken(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"message": "refresh not implemented yet"})
}

func (h *AuthHandler) generateToken(userID, username string, isAdmin bool) string {
	claims := jwt.MapClaims{
		"user_id":  userID,
		"username": username,
		"is_admin": isAdmin,
		"exp":      time.Now().Add(24 * time.Hour).Unix(),
	}
	token, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(h.cfg.JWTSecret))
	return token
}

