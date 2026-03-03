package main

import (
	"log"
	"photcot/internal/config"
	"photcot/internal/db"
	"photcot/internal/handlers"
	"photcot/internal/middleware"

	"github.com/gin-gonic/gin"
)

func main() {
	cfg := config.Load()

	database := db.Connect(cfg.DBURL)
	defer database.Close()
	db.Migrate(database)

	rdb := db.ConnectRedis(cfg.RedisURL)

	r := gin.Default()

	// CORS
	r.Use(middleware.CORS())

	// Static file serving for uploads
	r.Static("/uploads", cfg.UploadDir)

	// Health check
	r.GET("/api/health", func(c *gin.Context) {
		c.JSON(200, gin.H{"status": "ok", "app": "Phatforces"})
	})

	// API routes
	api := r.Group("/api/v1")
	{
		// Auth (register, login, OTP)
		auth := api.Group("/auth")
		{
			authHandler := handlers.NewAuthHandler(database, cfg)
			auth.POST("/register", authHandler.Register)
			auth.POST("/login", authHandler.Login)
			auth.POST("/refresh", authHandler.RefreshToken)

			// OTP email verification
			otpHandler := handlers.NewOTPHandler(database, cfg)
			auth.POST("/send-otp", otpHandler.SendOTP)
			auth.POST("/verify-otp", otpHandler.VerifyOTP)
		}

		// Public routes - no auth required
		public := api.Group("")
		{
			feedHandler := handlers.NewFeedHandler(database, nil)
			public.GET("/feed/public", feedHandler.Public)

			searchHandler := handlers.NewSearchHandler(database)
			public.GET("/search", searchHandler.Search)
			public.GET("/search/trending", searchHandler.Trending)

			userHandler := handlers.NewUserHandler(database, nil)
			public.GET("/users/:username", userHandler.GetProfile)
			public.GET("/u/:id/videos", handlers.NewVideoHandler(database, nil, cfg).GetUserVideos)
		}

		// Protected routes
		protected := api.Group("")
		protected.Use(middleware.Auth(cfg.JWTSecret))
		{
			// Users (protected mutations)
			userHandler := handlers.NewUserHandler(database, rdb)
			protected.PUT("/users/me", userHandler.UpdateProfile)
			protected.POST("/u/:id/follow", userHandler.Follow)
			protected.DELETE("/u/:id/follow", userHandler.Unfollow)
			protected.GET("/u/:id/followers", userHandler.GetFollowers)
			protected.GET("/u/:id/following", userHandler.GetFollowing)

			// Videos
			videoHandler := handlers.NewVideoHandler(database, rdb, cfg)
			protected.POST("/videos", videoHandler.Upload)
			protected.GET("/videos/:id", videoHandler.GetVideo)
			protected.DELETE("/videos/:id", videoHandler.DeleteVideo)
			protected.POST("/videos/:id/like", videoHandler.Like)
			protected.DELETE("/videos/:id/like", videoHandler.Unlike)
			protected.POST("/videos/:id/view", videoHandler.RecordView)

			// Comments
			commentHandler := handlers.NewCommentHandler(database)
			protected.POST("/videos/:id/comments", commentHandler.AddComment)
			protected.GET("/videos/:id/comments", commentHandler.GetComments)
			protected.DELETE("/comments/:id", commentHandler.DeleteComment)

			// Feed (personalized - requires auth)
			feedHandlerAuth := handlers.NewFeedHandler(database, rdb)
			protected.GET("/feed/foryou", feedHandlerAuth.ForYou)
			protected.GET("/feed/following", feedHandlerAuth.Following)

			// Monetization
			monetHandler := handlers.NewMonetizationHandler(database)
			protected.GET("/monetization/stats", monetHandler.GetStats)
			protected.POST("/monetization/withdraw", monetHandler.RequestWithdraw)
		}
	}

	log.Printf("Phatforces backend running on :%s", cfg.Port)
	r.Run(":" + cfg.Port)
}
