package middleware

import (
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// RateLimiter tracks requests per IP
type RateLimiter struct {
	requests map[string][]time.Time
	mu       sync.RWMutex
	limit    int
	window   time.Duration
}

// NewRateLimiter creates a new rate limiter
// limit: max requests per window
// window: time window for counting requests
func NewRateLimiter(limit int, window time.Duration) *RateLimiter {
	rl := &RateLimiter{
		requests: make(map[string][]time.Time),
		limit:    limit,
		window:   window,
	}

	// Cleanup old entries every minute
	go func() {
		ticker := time.NewTicker(1 * time.Minute)
		for range ticker.C {
			rl.cleanup()
		}
	}()

	return rl
}

// IsAllowed checks if request from IP is allowed
func (rl *RateLimiter) IsAllowed(ip string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	timestamps, exists := rl.requests[ip]

	if !exists {
		rl.requests[ip] = []time.Time{now}
		return true
	}

	// Remove old timestamps outside the window
	validTimestamps := []time.Time{}
	for _, t := range timestamps {
		if now.Sub(t) < rl.window {
			validTimestamps = append(validTimestamps, t)
		}
	}

	if len(validTimestamps) < rl.limit {
		validTimestamps = append(validTimestamps, now)
		rl.requests[ip] = validTimestamps
		return true
	}

	rl.requests[ip] = validTimestamps
	return false
}

// cleanup removes entries older than window
func (rl *RateLimiter) cleanup() {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	for ip, timestamps := range rl.requests {
		validTimestamps := []time.Time{}
		for _, t := range timestamps {
			if now.Sub(t) < rl.window {
				validTimestamps = append(validTimestamps, t)
			}
		}
		if len(validTimestamps) == 0 {
			delete(rl.requests, ip)
		} else {
			rl.requests[ip] = validTimestamps
		}
	}
}

// RateLimit returns a middleware that enforces rate limiting
func RateLimit(limiter *RateLimiter) gin.HandlerFunc {
	return func(c *gin.Context) {
		ip := c.ClientIP()
		if !limiter.IsAllowed(ip) {
			c.JSON(http.StatusTooManyRequests, gin.H{
				"error": "rate limit exceeded, please try again later",
			})
			c.Abort()
			return
		}
		c.Next()
	}
}
