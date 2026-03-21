package handlers

import (
	"database/sql"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

type NotificationHandler struct {
	db        *sql.DB
	jwtSecret string
}

// extractTokenFromContext tries to get JWT token from cookie, Authorization header, or query string
func extractTokenFromContext(c *gin.Context) string {
	// Try cookie first (HttpOnly cookie from login)
	if token, err := c.Cookie("photcot_token"); err == nil && token != "" {
		return token
	}

	// Try Authorization header (Bearer token)
	authHeader := c.GetHeader("Authorization")
	if strings.HasPrefix(authHeader, "Bearer ") {
		return strings.TrimPrefix(authHeader, "Bearer ")
	}

	// Fallback to query string (legacy, for EventSource compatibility)
	return strings.TrimSpace(c.Query("token"))
}

type notificationHub struct {
	mu          sync.RWMutex
	subscribers map[string]map[chan string]struct{}
}

func newNotificationHub() *notificationHub {
	return &notificationHub{subscribers: map[string]map[chan string]struct{}{}}
}

func (h *notificationHub) Subscribe(userID string) chan string {
	ch := make(chan string, 32)
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.subscribers[userID]; !ok {
		h.subscribers[userID] = map[chan string]struct{}{}
	}
	h.subscribers[userID][ch] = struct{}{}
	return ch
}

func (h *notificationHub) Unsubscribe(userID string, ch chan string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if subs, ok := h.subscribers[userID]; ok {
		delete(subs, ch)
		if len(subs) == 0 {
			delete(h.subscribers, userID)
		}
	}
	close(ch)
}

func (h *notificationHub) Publish(userID string, data string) {
	h.mu.RLock()
	subs := h.subscribers[userID]
	h.mu.RUnlock()
	for ch := range subs {
		select {
		case ch <- data:
		default:
		}
	}
}

var liveNotificationHub = newNotificationHub()

func NewNotificationHandler(db *sql.DB, jwtSecret string) *NotificationHandler {
	return &NotificationHandler{db: db, jwtSecret: jwtSecret}
}

// CreateNotification inserts a notification for user_id from actor_id.
// notifType: "like", "comment", "reply", "follow", "save"
// Safe to call in a goroutine - silently drops errors.
func CreateNotification(db *sql.DB, userID, actorID, notifType string, videoID, commentID *string, message string) {
	go func() {
		if userID == actorID {
			return // never notify yourself
		}
		var notificationsEnabled bool
		queryErr := db.QueryRow(`SELECT COALESCE((SELECT notifications_enabled FROM creator_settings WHERE user_id=$1), TRUE)`, userID).Scan(&notificationsEnabled)
		if queryErr != nil || !notificationsEnabled {
			return
		}
		var err error
		if videoID != nil {
			_, err = db.Exec(`
				INSERT INTO notifications (user_id, actor_id, type, video_id, comment_id, message)
				VALUES ($1, $2, $3, $4, $5, $6)
			`, userID, actorID, notifType, *videoID, commentID, message)
		} else {
			_, err = db.Exec(`
				INSERT INTO notifications (user_id, actor_id, type, comment_id, message)
				VALUES ($1, $2, $3, $4, $5)
			`, userID, actorID, notifType, commentID, message)
		}
		if err == nil {
			liveNotificationHub.Publish(userID, `{"kind":"notification"}`)
		}
	}()
}

func (h *NotificationHandler) Stream(c *gin.Context) {
	tokenStr := extractTokenFromContext(c)
	if tokenStr == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "token is required in cookie, Authorization header, or query string"})
		return
	}

	token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return []byte(h.jwtSecret), nil
	})
	if err != nil || !token.Valid {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid token"})
		return
	}

	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid claims"})
		return
	}
	uid := fmt.Sprintf("%v", claims["user_id"])
	if uid == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid user"})
		return
	}

	var exists bool
	if scanErr := h.db.QueryRow(`SELECT EXISTS(SELECT 1 FROM users WHERE id=$1)`, uid).Scan(&exists); scanErr != nil || !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "account not found"})
		return
	}

	flusher, ok := c.Writer.(http.Flusher)
	if !ok {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "streaming unsupported"})
		return
	}

	c.Writer.Header().Set("Content-Type", "text/event-stream")
	c.Writer.Header().Set("Cache-Control", "no-cache")
	c.Writer.Header().Set("Connection", "keep-alive")
	c.Writer.Header().Set("X-Accel-Buffering", "no")

	ch := liveNotificationHub.Subscribe(uid)
	defer liveNotificationHub.Unsubscribe(uid, ch)

	fmt.Fprintf(c.Writer, "event: connected\ndata: {\"ok\":true}\n\n")
	flusher.Flush()

	heartbeat := time.NewTicker(25 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-c.Request.Context().Done():
			return
		case data := <-ch:
			fmt.Fprintf(c.Writer, "event: notification\ndata: %s\n\n", data)
			flusher.Flush()
		case <-heartbeat.C:
			fmt.Fprintf(c.Writer, ": keepalive\n\n")
			flusher.Flush()
		}
	}
}

// GetNotifications returns the last 30 notifications for the authenticated user.
func (h *NotificationHandler) GetNotifications(c *gin.Context) {
	userID, _ := c.Get("user_id")

	rows, err := h.db.Query(`
		SELECT n.id, n.type, n.message, n.is_read, n.created_at,
			n.video_id, n.comment_id,
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
		CommentID        *string `json:"comment_id"`
		ActorUsername    string  `json:"actor_username"`
		ActorAvatar      string  `json:"actor_avatar"`
		ActorDisplayName string  `json:"actor_display_name"`
	}

	var notifs []Notif
	for rows.Next() {
		var n Notif
		rows.Scan(&n.ID, &n.Type, &n.Message, &n.IsRead, &n.CreatedAt,
			&n.VideoID, &n.CommentID, &n.ActorUsername, &n.ActorAvatar, &n.ActorDisplayName)
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
