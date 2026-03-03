package db

import (
	"context"
	"database/sql"
	"log"

	"github.com/redis/go-redis/v9"
	_ "github.com/lib/pq"
)

func Connect(dsn string) *sql.DB {
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		log.Fatalf("Failed to open DB: %v", err)
	}
	if err := db.Ping(); err != nil {
		log.Fatalf("Failed to ping DB: %v", err)
	}
	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(5)
	log.Println("Connected to PostgreSQL")
	return db
}

func ConnectRedis(addr string) *redis.Client {
	rdb := redis.NewClient(&redis.Options{
		Addr: addr,
		DB:   0,
	})
	if err := rdb.Ping(context.Background()).Err(); err != nil {
		log.Printf("Redis connection warning: %v (running without cache)", err)
		return nil
	}
	log.Println("Connected to Redis")
	return rdb
}

func Migrate(db *sql.DB) {
	queries := []string{
		`CREATE TABLE IF NOT EXISTS users (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			username VARCHAR(50) UNIQUE NOT NULL,
			email VARCHAR(255) UNIQUE NOT NULL,
			password_hash TEXT NOT NULL,
			display_name VARCHAR(100),
			bio TEXT DEFAULT '',
			avatar_url TEXT DEFAULT '',
			is_verified BOOLEAN DEFAULT FALSE,
			follower_count INT DEFAULT 0 CHECK (follower_count >= 0),
			following_count INT DEFAULT 0 CHECK (following_count >= 0),
			total_likes INT DEFAULT 0 CHECK (total_likes >= 0),
			coins DECIMAL(10,2) DEFAULT 0 CHECK (coins >= 0),
			created_at TIMESTAMPTZ DEFAULT NOW(),
			updated_at TIMESTAMPTZ DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS videos (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			title TEXT NOT NULL DEFAULT '',
			description TEXT DEFAULT '',
			video_url TEXT NOT NULL,
			thumbnail_url TEXT DEFAULT '',
			duration FLOAT DEFAULT 0,
			width INT DEFAULT 0,
			height INT DEFAULT 0,
			view_count INT DEFAULT 0 CHECK (view_count >= 0),
			like_count INT DEFAULT 0 CHECK (like_count >= 0),
			comment_count INT DEFAULT 0 CHECK (comment_count >= 0),
			share_count INT DEFAULT 0 CHECK (share_count >= 0),
			hashtags TEXT[] DEFAULT '{}',
			is_published BOOLEAN DEFAULT TRUE,
			created_at TIMESTAMPTZ DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS video_likes (
			user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
			created_at TIMESTAMPTZ DEFAULT NOW(),
			PRIMARY KEY (user_id, video_id)
		)`,
		`CREATE TABLE IF NOT EXISTS video_views (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
			watch_time FLOAT DEFAULT 0,
			watch_percent FLOAT DEFAULT 0,
			replayed BOOLEAN DEFAULT FALSE,
			created_at TIMESTAMPTZ DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS follows (
			follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			following_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			created_at TIMESTAMPTZ DEFAULT NOW(),
			PRIMARY KEY (follower_id, following_id),
			CONSTRAINT no_self_follow CHECK (follower_id != following_id)
		)`,
		`CREATE TABLE IF NOT EXISTS comments (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
			user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			content TEXT NOT NULL,
			like_count INT DEFAULT 0 CHECK (like_count >= 0),
			created_at TIMESTAMPTZ DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS hashtags (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			name VARCHAR(100) UNIQUE NOT NULL,
			video_count INT DEFAULT 0,
			created_at TIMESTAMPTZ DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS coin_transactions (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			type VARCHAR(50) NOT NULL,
			amount DECIMAL(10,2) NOT NULL,
			description TEXT,
			created_at TIMESTAMPTZ DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS email_otps (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			email VARCHAR(255) NOT NULL,
			code VARCHAR(6) NOT NULL,
			verified BOOLEAN DEFAULT FALSE,
			expires_at TIMESTAMPTZ NOT NULL,
			created_at TIMESTAMPTZ DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_email_otps_email ON email_otps(email)`,
		`CREATE INDEX IF NOT EXISTS idx_email_otps_expires ON email_otps(expires_at)`,
		`CREATE INDEX IF NOT EXISTS idx_videos_user_id ON videos(user_id)`,
		`CREATE INDEX IF NOT EXISTS idx_videos_created_at ON videos(created_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_video_views_video_id ON video_views(video_id)`,
		`CREATE INDEX IF NOT EXISTS idx_follows_following_id ON follows(following_id)`,
		`CREATE INDEX IF NOT EXISTS idx_follows_follower_id ON follows(follower_id)`,
		`CREATE INDEX IF NOT EXISTS idx_comments_video_id ON comments(video_id)`,
	}

	for _, q := range queries {
		if _, err := db.Exec(q); err != nil {
			log.Printf("Migration warning: %v", err)
		}
	}
	log.Println("Database migrated successfully")
}
