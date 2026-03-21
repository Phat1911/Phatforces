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
	"github.com/gin-gonic/gin"
)

type OTPHandler struct {
	db     *sql.DB
	cfg    *config.Config
	mailer *email.Sender
}

func NewOTPHandler(db *sql.DB, cfg *config.Config) *OTPHandler {
	mailer := email.NewSender(cfg.ResendKey, cfg.EmailFrom)
	return &OTPHandler{db: db, cfg: cfg, mailer: mailer}
}

type sendOTPRequest struct {
	Email string `json:"email" binding:"required,email"`
}

type verifyOTPRequest struct {
	Email string `json:"email" binding:"required,email"`
	Code  string `json:"code" binding:"required"`
}

// SendOTP - POST /auth/send-otp
// Generates a 6-digit code, stores it in email_otps (expires 10min), sends it via Resend.
// Rate-limited: max 3 OTPs per email per hour.
func (h *OTPHandler) SendOTP(c *gin.Context) {
	var req sendOTPRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "valid email is required"})
		return
	}
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))

	// Rate-limit: max 3 OTPs per email per hour
	var recentCount int
	h.db.QueryRow(
		"SELECT COUNT(*) FROM email_otps WHERE email=$1 AND created_at > NOW() - INTERVAL '1 hour'",
		req.Email,
	).Scan(&recentCount)
	if recentCount >= 3 {
		c.JSON(http.StatusTooManyRequests, gin.H{"error": "too many OTP requests, please wait before trying again"})
		return
	}

	// Clean up expired OTPs for this email
	h.db.Exec("DELETE FROM email_otps WHERE email=$1 AND expires_at < NOW()", req.Email)

	// Generate 6-digit code
	rng := rand.New(rand.NewSource(time.Now().UnixNano()))
	code := fmt.Sprintf("%06d", rng.Intn(1000000))
	expiresAt := time.Now().Add(10 * time.Minute)

	_, err := h.db.Exec(
		"INSERT INTO email_otps (email, code, expires_at) VALUES ($1, $2, $3)",
		req.Email, code, expiresAt,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to generate OTP"})
		return
	}

	// Send email via Resend
	body := email.OTPEmailBody(code, "Phatforces")
	if err := h.mailer.Send(req.Email, "Your Phatforces verification code", body); err != nil {
		h.db.Exec("DELETE FROM email_otps WHERE email=$1 AND code=$2", req.Email, code)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to send verification email, please check your email address"})
		return
	}

	// If no Resend key configured, return code directly for dev convenience
	if h.cfg.ResendKey == "" {
		c.JSON(http.StatusOK, gin.H{
			"message":  "verification code sent to " + req.Email,
			"dev_code": code,
		})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "verification code sent to " + req.Email})
}

// VerifyOTP - POST /auth/verify-otp
// Checks the code, marks it verified.
func (h *OTPHandler) VerifyOTP(c *gin.Context) {
	var req verifyOTPRequest
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

	h.db.Exec("UPDATE email_otps SET verified=TRUE WHERE id=$1", otpID)

	c.JSON(http.StatusOK, gin.H{
		"message":        "email verified successfully",
		"verified_email": req.Email,
	})
}
