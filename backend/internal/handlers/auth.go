package handlers

import (
	"database/sql"
	"fmt"
	"math/rand"
	"net/http"
	"strings"
	"time"

	"photcot/internal/config"
	"photcot/internal/email"
	"photcot/internal/models"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

type AuthHandler struct {
	db     *sql.DB
	cfg    *config.Config
	mailer *email.Sender
}

func NewAuthHandler(db *sql.DB, cfg *config.Config) *AuthHandler {
	return &AuthHandler{db: db, cfg: cfg, mailer: email.NewSender(cfg.ResendKey, cfg.EmailFrom)}
}

type sendLoginCodeRequest struct {
	Email string `json:"email" binding:"required,email"`
}

type loginWithCodeRequest struct {
	Email string `json:"email" binding:"required,email"`
	Code  string `json:"code" binding:"required"`
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

// SendLoginCode sends a one-time login code to an existing account email.
func (h *AuthHandler) SendLoginCode(c *gin.Context) {
	var req sendLoginCodeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "valid email is required"})
		return
	}
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))

	var userID string
	err := h.db.QueryRow("SELECT id FROM users WHERE email = $1", req.Email).Scan(&userID)
	if err == sql.ErrNoRows {
		c.JSON(http.StatusNotFound, gin.H{"error": "this email is not registered"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to process request"})
		return
	}

	var recentCount int
	h.db.QueryRow(
		"SELECT COUNT(*) FROM email_otps WHERE email=$1 AND created_at > NOW() - INTERVAL '1 hour'",
		req.Email,
	).Scan(&recentCount)
	if recentCount >= h.cfg.OTPMaxRequestsPerHour {
		c.JSON(http.StatusTooManyRequests, gin.H{"error": "too many code requests, please wait before trying again"})
		return
	}

	// Keep only fresh, single-use codes for this email.
	h.db.Exec("DELETE FROM email_otps WHERE email=$1 AND (expires_at < NOW() OR verified=FALSE)", req.Email)

	rng := rand.New(rand.NewSource(time.Now().UnixNano()))
	code := fmt.Sprintf("%06d", rng.Intn(1000000))
	expiresAt := time.Now().Add(time.Duration(h.cfg.OTPExpiryMinutes) * time.Minute)

	_, err = h.db.Exec(
		"INSERT INTO email_otps (email, code, expires_at) VALUES ($1, $2, $3)",
		req.Email, code, expiresAt,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to generate login code"})
		return
	}

	body := email.OTPEmailBody(code, "Phatforces")
	if err := h.mailer.Send(req.Email, "Your Phatforces login code", body); err != nil {
		h.db.Exec("DELETE FROM email_otps WHERE email=$1 AND code=$2", req.Email, code)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to send login code"})
		return
	}

	if h.cfg.ResendKey == "" {
		c.JSON(http.StatusOK, gin.H{
			"message":          "login code sent to " + req.Email,
			"dev_code":         code,
			"cooldown_seconds": h.cfg.OTPResendCooldownSeconds,
		})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"message":          "login code sent to " + req.Email,
		"cooldown_seconds": h.cfg.OTPResendCooldownSeconds,
	})
}

// LoginWithCode verifies a one-time code and logs the user in.
func (h *AuthHandler) LoginWithCode(c *gin.Context) {
	var req loginWithCodeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "email and code are required"})
		return
	}
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	req.Code = strings.TrimSpace(req.Code)

	var otpID string
	err := h.db.QueryRow(
		"SELECT id FROM email_otps WHERE email=$1 AND code=$2 AND verified=FALSE AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1",
		req.Email, req.Code,
	).Scan(&otpID)
	if err == sql.ErrNoRows {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid or expired verification code"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "verification failed"})
		return
	}

	var user models.User
	var isAdmin bool
	err = h.db.QueryRow(`
		SELECT id, username, email, display_name, bio, avatar_url, is_verified,
			follower_count, following_count, total_likes, created_at, is_admin
		FROM users WHERE email = $1
	`, req.Email).Scan(
		&user.ID, &user.Username, &user.Email, &user.DisplayName,
		&user.Bio, &user.AvatarURL, &user.IsVerified,
		&user.FollowerCount, &user.FollowingCount, &user.TotalLikes, &user.CreatedAt,
		&isAdmin,
	)
	if err == sql.ErrNoRows {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "account not found"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to login"})
		return
	}

	h.db.Exec("UPDATE email_otps SET verified=TRUE WHERE id=$1", otpID)

	token := h.generateToken(user.ID, user.Username, isAdmin)
	c.JSON(http.StatusOK, models.AuthResponse{Token: token, User: &user})
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

