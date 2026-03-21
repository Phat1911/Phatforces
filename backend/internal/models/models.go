package models

import "time"

type User struct {
	ID             string    `json:"id"`
	Username       string    `json:"username"`
	Email          string    `json:"email,omitempty"`
	DisplayName    string    `json:"display_name"`
	Bio            string    `json:"bio"`
	AvatarURL      string    `json:"avatar_url"`
	IsVerified     bool      `json:"is_verified"`
	FollowerCount  int       `json:"follower_count"`
	FollowingCount int       `json:"following_count"`
	TotalLikes     int       `json:"total_likes"`
	Coins          float64   `json:"coins,omitempty"`
	IsFollowing    bool      `json:"is_following,omitempty"`
	CreatedAt      time.Time `json:"created_at"`
}

type Video struct {
	ID           string    `json:"id"`
	UserID       string    `json:"user_id"`
	Author       *User     `json:"author,omitempty"`
	Title        string    `json:"title"`
	Description  string    `json:"description"`
	VideoURL     string    `json:"video_url"`
	ThumbnailURL string    `json:"thumbnail_url"`
	Duration     float64   `json:"duration"`
	ViewCount    int       `json:"view_count"`
	LikeCount    int       `json:"like_count"`
	CommentCount int       `json:"comment_count"`
	ShareCount   int       `json:"share_count"`
	Hashtags     []string  `json:"hashtags"`
	IsLiked      bool      `json:"is_liked,omitempty"`
	IsSaved      bool      `json:"is_saved,omitempty"`
	SaveCount    int       `json:"save_count"`
	IsPublished  bool      `json:"is_published"`
	CreatedAt    time.Time `json:"created_at"`
}

// SavedVideo represents a user's saved/bookmarked video
type SavedVideo struct {
	ID        string    `json:"id"`
	UserID    string    `json:"user_id"`
	VideoID   string    `json:"video_id"`
	CreatedAt time.Time `json:"created_at"`
}

type Comment struct {
	ID        string    `json:"id"`
	VideoID   string    `json:"video_id"`
	UserID    string    `json:"user_id"`
	ParentID  *string   `json:"parent_id,omitempty"`
	Author    *User     `json:"author,omitempty"`
	Content   string    `json:"content"`
	ImageURL  string    `json:"image_url,omitempty"`
	LikeCount int       `json:"like_count"`
	ReactionCounts map[string]int `json:"reaction_counts,omitempty"`
	MyReaction     string         `json:"my_reaction,omitempty"`
	Replies   []Comment `json:"replies,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

type LoginRequest struct {
	Email    string `json:"email" binding:"required,email"`
	Password string `json:"password" binding:"required"`
}

type RegisterRequest struct {
	Username string `json:"username" binding:"required,min=3,max=50"`
	Email    string `json:"email" binding:"required,email"`
	Password string `json:"password" binding:"required,min=8"`
}

type AuthResponse struct {
	Token string `json:"token"`
	User  *User  `json:"user"`
}
