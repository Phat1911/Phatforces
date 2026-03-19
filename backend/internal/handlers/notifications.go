package handlers

import (
	"database/sql"
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
)

type NotificationHandler struct {
	db *sql.DB
}

func NewNotificationHandler(db *sql.DB) *NotificationHandler {
	return &NotificationHandler{db: db}
}

// CreateNotification inserts a notification for user_id from actor_id.
// notifType: "like", "comment", "follow", "save"
// Safe to call in a goroutine - silently drops errors.
func CreateNotification(db *sql.DB, userID, actorID, notifType string, videoID *string, message string) {
	go func() {
		if userID == actorID {
			return // never notify yourself
		}
		var notificationsEnabled bool
		err := db.QueryRow(`SELECT COALESCE((SELECT notifications_enabled FROM creator_settings WHERE user_id=$1), TRUE)`, userID).Scan(&notificationsEnabled)
		if err != nil || !notificationsEnabled {
			return
		}
		if videoID != nil {
			db.Exec(`
				INSERT INTO notifications (user_id, actor_id, type, video_id, message)
				VALUES ($1, $2, $3, $4, $5)
			`, userID, actorID, notifType, *videoID, message)
		} else {
			db.Exec(`
				INSERT INTO notifications (user_id, actor_id, type, message)
				VALUES ($1, $2, $3, $4)
			`, userID, actorID, notifType, message)
		}
	}()
}

// GetNotifications returns the last 30 notifications for the authenticated user.
func (h *NotificationHandler) GetNotifications(c *gin.Context) {
	userID, _ := c.Get("user_id")

	rows, err := h.db.Query(`
		SELECT n.id, n.type, n.message, n.is_read, n.created_at,
			n.video_id,
			COALESCE(u.username, '') AS actor_username,
			COALESCE(u.avatar_url, '') AS actor_avatar,
			COALESCE(u.display_name, '') AS actor_display_name
		FROM notifications n
		LEFT JOIN users u ON u.id = n.actor_id
		WHERE n.user_id = $1
		ORDER BY n.created_at DESC
		LIMIT 30
	`, userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed"})
		return
	}
	defer rows.Close()

	type Notif struct {
		ID               string  `json:"id"`
		Type             string  `json:"type"`
		Message          string  `json:"message"`
		IsRead           bool    `json:"is_read"`
		CreatedAt        string  `json:"created_at"`
		VideoID          *string `json:"video_id"`
		ActorUsername    string  `json:"actor_username"`
		ActorAvatar      string  `json:"actor_avatar"`
		ActorDisplayName string  `json:"actor_display_name"`
	}

	var notifs []Notif
	for rows.Next() {
		var n Notif
		rows.Scan(&n.ID, &n.Type, &n.Message, &n.IsRead, &n.CreatedAt,
			&n.VideoID, &n.ActorUsername, &n.ActorAvatar, &n.ActorDisplayName)
		notifs = append(notifs, n)
	}
	if notifs == nil {
		notifs = []Notif{}
	}

	// Count unread
	var unread int
	h.db.QueryRow(`SELECT COUNT(*) FROM notifications WHERE user_id=$1 AND is_read=FALSE`, userID).Scan(&unread)

	c.JSON(http.StatusOK, gin.H{"notifications": notifs, "unread_count": unread})
}

// MarkAllRead marks all notifications as read for the authenticated user.
func (h *NotificationHandler) MarkAllRead(c *gin.Context) {
	userID, _ := c.Get("user_id")
	h.db.Exec(`UPDATE notifications SET is_read=TRUE WHERE user_id=$1`, userID)
	c.JSON(http.StatusOK, gin.H{"message": "marked"})
}

// MarkOneRead marks a single notification as read.
func (h *NotificationHandler) MarkOneRead(c *gin.Context) {
	userID, _ := c.Get("user_id")
	notifID := c.Param("id")
	h.db.Exec(`UPDATE notifications SET is_read=TRUE WHERE id=$1 AND user_id=$2`, notifID, userID)
	c.JSON(http.StatusOK, gin.H{"message": "marked"})
}

// GetUnreadCount returns just the unread notification count.
func (h *NotificationHandler) GetUnreadCount(c *gin.Context) {
	userID, _ := c.Get("user_id")
	var count int
	h.db.QueryRow(`SELECT COUNT(*) FROM notifications WHERE user_id=$1 AND is_read=FALSE`, userID).Scan(&count)
	c.JSON(http.StatusOK, gin.H{"unread_count": count})
}

// DeleteNotification deletes a single notification.
func (h *NotificationHandler) DeleteNotification(c *gin.Context) {
	userID, _ := c.Get("user_id")
	notifID := c.Param("id")
	h.db.Exec(`DELETE FROM notifications WHERE id=$1 AND user_id=$2`, notifID, userID)
	c.JSON(http.StatusOK, gin.H{"message": "deleted"})
}

// GetActorInfo returns username and video title for notification creation.
// Returns (actorUsername, videoOwnerID, videoTitle)
func GetActorInfo(db *sql.DB, actorID, videoID string) (string, string, string) {
	var username string
	db.QueryRow(`SELECT username FROM users WHERE id=$1`, actorID).Scan(&username)
	var ownerID, title string
	if videoID != "" {
		db.QueryRow(`SELECT user_id::text, title FROM videos WHERE id=$1`, videoID).Scan(&ownerID, &title)
	}
	return username, ownerID, title
}

// UnreadCountForUser returns unread notification count as plain int (for embedding in other responses).
func UnreadCountForUser(db *sql.DB, userID string) int {
	var n int
	db.QueryRow(`SELECT COUNT(*) FROM notifications WHERE user_id=$1 AND is_read=FALSE`, fmt.Sprintf("%v", userID)).Scan(&n)
	return n
}
