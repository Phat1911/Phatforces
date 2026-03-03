package handlers

import (
	"database/sql"
	"fmt"
	"net"
	"net/http"
	"regexp"
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

var emailRegex = regexp.MustCompile(`^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$`)

// validateEmailDomain checks format and DNS MX/A records.
// Exported as package-level so otp.go can also call it.
func validateEmailDomain(emailAddr string) error {
	emailAddr = strings.TrimSpace(strings.ToLower(emailAddr))
	if !emailRegex.MatchString(emailAddr) {
		return fmt.Errorf("invalid email format")
	}
	parts := strings.Split(emailAddr, "@")
	if len(parts) != 2 {
		return fmt.Errorf("invalid email format")
	}
	domain := parts[1]
	mxRecords, err := net.LookupMX(domain)
	if err != nil || len(mxRecords) == 0 {
		addrs, errA := net.LookupHost(domain)
		if errA != nil || len(addrs) == 0 {
			return fmt.Errorf("email domain '%s' does not exist or cannot receive mail", domain)
		}
	}
	return nil
}

func (h *AuthHandler) Register(c *gin.Context) {
	var req models.RegisterRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	req.Email = strings.ToLower(strings.TrimSpace(req.Email))

	// Step 1: Validate email domain
	if err := validateEmailDomain(req.Email); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Hash password and create account
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), 12)
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

	token := h.generateToken(user.ID, user.Username)
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
	err := h.db.QueryRow(`
		SELECT id, username, email, display_name, bio, avatar_url, is_verified,
			follower_count, following_count, total_likes, created_at, password_hash
		FROM users WHERE email = $1
	`, strings.ToLower(strings.TrimSpace(req.Email))).Scan(
		&user.ID, &user.Username, &user.Email, &user.DisplayName,
		&user.Bio, &user.AvatarURL, &user.IsVerified,
		&user.FollowerCount, &user.FollowingCount, &user.TotalLikes, &user.CreatedAt,
		&passwordHash,
	)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte(req.Password)); err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
		return
	}

	token := h.generateToken(user.ID, user.Username)
	c.JSON(http.StatusOK, models.AuthResponse{Token: token, User: &user})
}

func (h *AuthHandler) RefreshToken(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"message": "refresh not implemented yet"})
}

func (h *AuthHandler) generateToken(userID, username string) string {
	claims := jwt.MapClaims{
		"user_id":  userID,
		"username": username,
		"exp":      time.Now().Add(24 * time.Hour).Unix(),
	}
	token, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(h.cfg.JWTSecret))
	return token
}
