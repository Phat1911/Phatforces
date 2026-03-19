package handlers

import (
	"database/sql"
	"fmt"
	"net/http"
	"strings"
	"time"

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

func truncateMessagePreview(s string, maxRunes int) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) <= maxRunes {
		return string(r)
	}
	if maxRunes <= 3 {
		return string(r[:maxRunes])
	}
	return string(r[:maxRunes-3]) + "..."
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

	// Notify receiver with a deep-linkable message notification.
	var senderUsername string
	_ = h.db.QueryRow(`SELECT username FROM users WHERE id=$1`, fromID).Scan(&senderUsername)
	if senderUsername == "" {
		senderUsername = "Someone"
	}
	preview := truncateMessagePreview(content, 80)
	notifMsg := fmt.Sprintf("%s sent you a message: %s", senderUsername, preview)
	CreateNotification(h.db, req.ToUserID, fromID, "message", nil, nil, notifMsg)

	c.JSON(http.StatusOK, gin.H{"message": "sent"})
}

func (h *MessageHandler) GetConversationByUsername(c *gin.Context) {
	meRaw, _ := c.Get("user_id")
	me := fmt.Sprintf("%v", meRaw)
	username := strings.TrimSpace(c.Param("username"))
	if username == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "username is required"})
		return
	}

	var peer struct {
		ID          string `json:"id"`
		Username    string `json:"username"`
		DisplayName string `json:"display_name"`
		AvatarURL   string `json:"avatar_url"`
	}
	err := h.db.QueryRow(`
		SELECT id::text, username, COALESCE(display_name, ''), COALESCE(avatar_url, '')
		FROM users
		WHERE LOWER(username) = LOWER($1)
	`, username).Scan(&peer.ID, &peer.Username, &peer.DisplayName, &peer.AvatarURL)
	if err == sql.ErrNoRows {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load conversation"})
		return
	}
	if peer.ID == me {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cannot open conversation with yourself"})
		return
	}

	rows, err := h.db.Query(`
		SELECT id::text, from_user_id::text, to_user_id::text, content, created_at
		FROM (
			SELECT id, from_user_id, to_user_id, content, created_at
			FROM direct_messages
			WHERE (from_user_id = $1 AND to_user_id = $2)
			   OR (from_user_id = $2 AND to_user_id = $1)
			ORDER BY created_at DESC
			LIMIT 200
		) AS m
		ORDER BY created_at ASC
	`, me, peer.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load messages"})
		return
	}
	defer rows.Close()

	type DM struct {
		ID         string `json:"id"`
		FromUserID string `json:"from_user_id"`
		ToUserID   string `json:"to_user_id"`
		Content    string `json:"content"`
		CreatedAt  string `json:"created_at"`
	}
	msgs := make([]DM, 0)
	for rows.Next() {
		var m DM
		var createdAt time.Time
		if err := rows.Scan(&m.ID, &m.FromUserID, &m.ToUserID, &m.Content, &createdAt); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to parse messages"})
			return
		}
		m.CreatedAt = createdAt.UTC().Format(time.RFC3339)
		msgs = append(msgs, m)
	}

	c.JSON(http.StatusOK, gin.H{
		"peer":     peer,
		"messages": msgs,
	})
}
