package middleware

import (
	"os"

	"github.com/gin-gonic/gin"
)

// HTTPS sets HSTS header in production only
func HTTPS() gin.HandlerFunc {
	return func(c *gin.Context) {
		if os.Getenv("APP_ENV") == "production" {
			c.Header("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload")
		}
		c.Next()
	}
}
