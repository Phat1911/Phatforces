package handlers

import (
	"database/sql"
	"net/http"
	"github.com/gin-gonic/gin"
)

type MonetizationHandler struct { db *sql.DB }
func NewMonetizationHandler(db *sql.DB) *MonetizationHandler { return &MonetizationHandler{db: db} }

func (h *MonetizationHandler) GetStats(c *gin.Context) {
	userID, _ := c.Get("user_id")
	var totalViews, totalLikes int
	var coins float64
	var videoCount int
	h.db.QueryRow(`SELECT COALESCE(SUM(view_count),0), COALESCE(SUM(like_count),0), COUNT(*) FROM videos WHERE user_id=$1`, userID).
		Scan(&totalViews, &totalLikes, &videoCount)
	h.db.QueryRow(`SELECT COALESCE(coins,0) FROM users WHERE id=$1`, userID).Scan(&coins)
	estimatedCoins := float64(totalViews) / 1000.0
	estimatedUSD := estimatedCoins * 0.05
	c.JSON(http.StatusOK, gin.H{
		"total_views": totalViews, "total_likes": totalLikes, "video_count": videoCount,
		"coins": coins, "estimated_coins": estimatedCoins, "estimated_usd": estimatedUSD,
		"monetization_rate": "1000 views = 1 coin = $0.05",
	})
}

func (h *MonetizationHandler) RequestWithdraw(c *gin.Context) {
	userID, _ := c.Get("user_id")
	var req struct {
		Amount float64 `json:"amount" binding:"required"`
		Method string  `json:"method" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.Amount <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "amount must be positive"})
		return
	}

	// FIXED: Use transaction with SELECT FOR UPDATE to prevent double-spend race condition
	tx, err := h.db.Begin()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "transaction failed"})
		return
	}
	defer tx.Rollback()

	var coins float64
	if err := tx.QueryRow(`SELECT coins FROM users WHERE id=$1 FOR UPDATE`, userID).Scan(&coins); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "user not found"})
		return
	}
	if coins < req.Amount {
		c.JSON(http.StatusBadRequest, gin.H{"error": "insufficient coins"})
		return
	}

	// FIXED: Check errors on each tx statement before committing
	if _, err := tx.Exec(`UPDATE users SET coins=coins-$1 WHERE id=$2`, req.Amount, userID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "deduction failed"})
		return
	}
	if _, err := tx.Exec(`INSERT INTO coin_transactions(user_id,type,amount,description) VALUES($1,'withdraw',$2,$3)`,
		userID, req.Amount, "Withdrawal via "+req.Method); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "transaction record failed"})
		return
	}

	if err := tx.Commit(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "commit failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "withdrawal requested", "amount": req.Amount})
}
