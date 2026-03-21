package config

import (
	"log"
	"os"
	"strconv"

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
	OTPExpiryMinutes         int
	OTPMaxRequestsPerHour    int
	OTPResendCooldownSeconds int
}

func Load() *Config {
	if err := godotenv.Load(); err != nil {
		log.Println("No .env file found, using environment variables")
	}
	cfg := &Config{
		Port:       getEnv("PORT", "8080"),
		DBURL:      getEnv("DB_URL", ""),
		RedisURL:   getEnv("REDIS_URL", "localhost:6379"),
		JWTSecret:  getEnv("JWT_SECRET", ""),
		JWTExpires: getEnv("JWT_EXPIRES_IN", "24h"),
		UploadDir:  getEnv("UPLOAD_DIR", "./uploads"),
		MaxUpload:  524288000,
		ResendKey:  getEnv("RESEND_API_KEY", ""),
		EmailFrom:  getEnv("EMAIL_FROM", "Phatforces <onboarding@resend.dev>"),
		OTPExpiryMinutes:         getEnvInt("OTP_EXPIRY_MINUTES", 10),
		OTPMaxRequestsPerHour:    getEnvInt("OTP_MAX_REQUESTS_PER_HOUR", 3),
		OTPResendCooldownSeconds: getEnvInt("OTP_RESEND_COOLDOWN_SECONDS", 60),
	}
	return cfg
}

func getEnv(key, fallback string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	val := os.Getenv(key)
	if val == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(val)
	if err != nil {
		log.Printf("invalid int for %s=%q, using default %d", key, val, fallback)
		return fallback
	}
	return parsed
}
