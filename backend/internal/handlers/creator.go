package handlers

import (
	"database/sql"
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

type CreatorSettingsHandler struct {
	db *sql.DB
}

func NewCreatorSettingsHandler(db *sql.DB) *CreatorSettingsHandler {
	return &CreatorSettingsHandler{db: db}
}

func (h *CreatorSettingsHandler) GetMySettings(c *gin.Context) {
	userID, _ := c.Get("user_id")
	uid := fmt.Sprintf("%v", userID)
	var notificationsEnabled bool
	var messagesEnabled bool
	err := h.db.QueryRow(`
		INSERT INTO creator_settings (user_id)
		VALUES ($1)
		ON CONFLICT (user_id) DO NOTHING
		RETURNING notifications_enabled, messages_enabled
	`, uid).Scan(&notificationsEnabled, &messagesEnabled)
	if err == sql.ErrNoRows {
		err = h.db.QueryRow(`SELECT notifications_enabled, messages_enabled FROM creator_settings WHERE user_id=$1`, uid).Scan(&notificationsEnabled, &messagesEnabled)
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load settings"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"notifications_enabled": notificationsEnabled,
		"messages_enabled":      messagesEnabled,
	})
}

func (h *CreatorSettingsHandler) UpdateMySettings(c *gin.Context) {
	userID, _ := c.Get("user_id")
	uid := fmt.Sprintf("%v", userID)
	var req struct {
		NotificationsEnabled *bool `json:"notifications_enabled"`
		MessagesEnabled      *bool `json:"messages_enabled"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid settings payload"})
		return
	}

	if req.NotificationsEnabled == nil && req.MessagesEnabled == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "no settings to update"})
		return
	}

	var notificationsEnabled bool
	var messagesEnabled bool
	if err := h.db.QueryRow(`SELECT notifications_enabled, messages_enabled FROM creator_settings WHERE user_id=$1`, uid).Scan(&notificationsEnabled, &messagesEnabled); err != nil {
		if err != sql.ErrNoRows {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load current settings"})
			return
		}
		notificationsEnabled = true
		messagesEnabled = true
	}

	if req.NotificationsEnabled != nil {
		notificationsEnabled = *req.NotificationsEnabled
	}
	if req.MessagesEnabled != nil {
		messagesEnabled = *req.MessagesEnabled
	}

	_, err := h.db.Exec(`
		INSERT INTO creator_settings (user_id, notifications_enabled, messages_enabled, updated_at)
		VALUES ($1, $2, $3, NOW())
		ON CONFLICT (user_id) DO UPDATE
		SET notifications_enabled = EXCLUDED.notifications_enabled,
			messages_enabled = EXCLUDED.messages_enabled,
			updated_at = NOW()
	`, uid, notificationsEnabled, messagesEnabled)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save settings"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"notifications_enabled": notificationsEnabled,
		"messages_enabled":      messagesEnabled,
	})
}

func (h *CreatorSettingsHandler) GetCreatorSettings(c *gin.Context) {
	creatorID := c.Param("id")
	if len(creatorID) != 36 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid creator id"})
		return
	}
	var messagesEnabled bool
	err := h.db.QueryRow(`SELECT COALESCE((SELECT messages_enabled FROM creator_settings WHERE user_id=$1), TRUE)`, creatorID).Scan(&messagesEnabled)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get creator settings"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"messages_enabled": messagesEnabled})
}

type MessageHandler struct {
	db *sql.DB
}

func NewMessageHandler(db *sql.DB) *MessageHandler {
	return &MessageHandler{db: db}
}

func (h *MessageHandler) SendMessage(c *gin.Context) {
	fromUserID, _ := c.Get("user_id")
	fromID := fmt.Sprintf("%v", fromUserID)

	var req struct {
		ToUserID string `json:"to_user_id"`
		Content  string `json:"content"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid message payload"})
		return
	}
	if len(req.ToUserID) != 36 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid recipient id"})
		return
	}
	if req.ToUserID == fromID {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cannot message yourself"})
		return
	}

	content := strings.TrimSpace(req.Content)
	if content == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "message content is required"})
		return
	}

	var canReceive bool
	err := h.db.QueryRow(`SELECT COALESCE((SELECT messages_enabled FROM creator_settings WHERE user_id=$1), TRUE)`, req.ToUserID).Scan(&canReceive)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to validate recipient"})
		return
	}
	if !canReceive {
		c.JSON(http.StatusForbidden, gin.H{"error": "creator is not receiving messages"})
		return
	}

	_, err = h.db.Exec(`
		INSERT INTO direct_messages (from_user_id, to_user_id, content)
		VALUES ($1, $2, $3)
	`, fromID, req.ToUserID, content)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to send message"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "sent"})
}
