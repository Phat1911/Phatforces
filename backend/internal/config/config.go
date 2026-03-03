package config

import (
	"log"
	"os"
	"github.com/joho/godotenv"
)

type Config struct {
	Port        string
	DBURL       string
	RedisURL    string
	JWTSecret   string
	JWTExpires  string
	UploadDir   string
	MaxUpload   int64
	ResendKey   string
	EmailFrom   string
}

func Load() *Config {
	if err := godotenv.Load(); err != nil {
		log.Println("No .env file found, using environment variables")
	}
	cfg := &Config{
		Port:       getEnv("PORT", "8080"),
		DBURL:      getEnv("DB_URL", "postgres://photcot:photcot123@localhost:5432/photcot?sslmode=disable"),
		RedisURL:   getEnv("REDIS_URL", "localhost:6379"),
		JWTSecret:  getEnv("JWT_SECRET", ""),
		JWTExpires: getEnv("JWT_EXPIRES_IN", "24h"),
		UploadDir:  getEnv("UPLOAD_DIR", "./uploads"),
		MaxUpload:  524288000,
		ResendKey:  getEnv("RESEND_API_KEY", ""),
		EmailFrom:  getEnv("EMAIL_FROM", "Phatforces <onboarding@resend.dev>"),
	}
	if cfg.JWTSecret == "" {
		log.Fatal("JWT_SECRET must be set in .env or environment")
	}
	return cfg
}

func getEnv(key, fallback string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return fallback
}
