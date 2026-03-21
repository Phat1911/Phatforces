package middleware

import (
	"strings"
	"os"
	"github.com/gin-gonic/gin"
)

func CORS() gin.HandlerFunc {
	raw := strings.TrimSpace(os.Getenv("CORS_ALLOWED_ORIGINS"))
	if raw == "" {
		// Backward compatibility with old single-origin env var.
		raw = strings.TrimSpace(os.Getenv("CORS_ALLOWED_ORIGIN"))
	}
	if raw == "" {
		raw = "http://localhost:3000"
	}
	allowedOrigins := map[string]struct{}{}
	allowedWildcards := []string{}
	for _, item := range strings.Split(raw, ",") {
		o := strings.TrimSpace(item)
		if o != "" {
			if strings.Contains(o, "*") {
				allowedWildcards = append(allowedWildcards, o)
			} else {
				allowedOrigins[o] = struct{}{}
			}
		}
	}

	return func(c *gin.Context) {
		origin := c.Request.Header.Get("Origin")
		allow := false
		if _, ok := allowedOrigins[origin]; ok {
			allow = true
		}
		if !allow {
			for _, p := range allowedWildcards {
				if strings.HasPrefix(p, "https://*.") {
					suffix := strings.TrimPrefix(p, "https://*.")
					if strings.HasPrefix(origin, "https://") && strings.HasSuffix(origin, "."+suffix) {
						allow = true
						break
					}
				}
				if strings.HasPrefix(p, "http://*.") {
					suffix := strings.TrimPrefix(p, "http://*.")
					if strings.HasPrefix(origin, "http://") && strings.HasSuffix(origin, "."+suffix) {
						allow = true
						break
					}
				}
			}
		}

		if allow {
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Access-Control-Allow-Credentials", "true")
		}
		c.Header("Vary", "Origin")
		c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Authorization, Content-Type")
		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}
		c.Next()
	}
}
