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

	// Security middlewares
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
			auth.POST("/send-login-code", authHandler.SendLoginCode)
			auth.POST("/login-with-code", authHandler.LoginWithCode)
			auth.POST("/refresh", authHandler.RefreshToken)

			// OTP email verification
			otpHandler := handlers.NewOTPHandler(database, cfg)
			auth.POST("/send-otp", otpHandler.SendOTP)
			auth.POST("/verify-otp", otpHandler.VerifyOTP)
		}

		// Public routes - no auth required
		public := api.Group("")
		{
			commentStreamHandler := handlers.NewCommentHandler(database, cfg)
			public.GET("/comments/reactions/stream", commentStreamHandler.StreamCommentReactions)
			notifPublicHandler := handlers.NewNotificationHandler(database, cfg.JWTSecret)
			public.GET("/notifications/stream", notifPublicHandler.Stream)

			feedHandler := handlers.NewFeedHandler(database, nil)
			public.GET("/feed/public", feedHandler.Public)
			public.GET("/feed/video/:id", feedHandler.PublicVideo)

			searchHandler := handlers.NewSearchHandler(database, cfg.JWTSecret)
			public.GET("/search", searchHandler.Search)
			public.GET("/search/trending", searchHandler.Trending)

			userHandler := handlers.NewUserHandler(database, nil, cfg.JWTSecret)
			public.GET("/users/:username", userHandler.GetProfile)
			public.GET("/u/:id/videos", handlers.NewVideoHandler(database, nil, cfg).GetUserVideos)
			creatorSettings := handlers.NewCreatorSettingsHandler(database)
			public.GET("/creator/settings/:id", creatorSettings.GetCreatorSettings)
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
			protected.GET("/videos/saved", videoHandler.GetSavedVideos)
			protected.GET("/videos/shared", videoHandler.GetSharedVideos)
			protected.GET("/videos/:id", videoHandler.GetVideo)
			protected.DELETE("/videos/:id", videoHandler.DeleteVideo)
			protected.POST("/videos/:id/like", videoHandler.Like)
			protected.DELETE("/videos/:id/like", videoHandler.Unlike)
			protected.POST("/videos/:id/view", videoHandler.RecordView)
			protected.POST("/videos/:id/save", videoHandler.SaveVideo)
			protected.DELETE("/videos/:id/save", videoHandler.UnsaveVideo)
			protected.POST("/videos/:id/share", videoHandler.ShareVideo)

			// Comments
			commentHandler := handlers.NewCommentHandler(database, cfg)
			protected.POST("/videos/:id/comments", commentHandler.AddComment)
			protected.GET("/videos/:id/comments", commentHandler.GetComments)
			protected.DELETE("/comments/:id", commentHandler.DeleteComment)
			protected.POST("/comments/:id/reaction", commentHandler.ReactToComment)
			protected.DELETE("/comments/:id/reaction", commentHandler.RemoveReaction)
			protected.GET("/comments/:id/reactions", commentHandler.GetCommentReactions)

			// Creator settings + messages
			creatorSettings := handlers.NewCreatorSettingsHandler(database)
			protected.GET("/creator/settings/me", creatorSettings.GetMySettings)
			protected.PATCH("/creator/settings/me", creatorSettings.UpdateMySettings)
			messageHandler := handlers.NewMessageHandler(database)
			protected.POST("/messages", messageHandler.SendMessage)
			protected.GET("/messages/with/:username", messageHandler.GetConversationByUsername)

			// Feed (personalized - requires auth)
			feedHandlerAuth := handlers.NewFeedHandler(database, rdb)
			protected.GET("/feed/foryou", feedHandlerAuth.ForYou)
			protected.DELETE("/feed/queue", feedHandlerAuth.ClearQueue)
			protected.GET("/feed/following", feedHandlerAuth.Following)

			// Monetization
			monetHandler := handlers.NewMonetizationHandler(database)
			protected.GET("/monetization/stats", monetHandler.GetStats)
			protected.POST("/monetization/withdraw", monetHandler.RequestWithdraw)

			// Admin panel (is_admin=true required - checked inside each handler)
			adminHandler := handlers.NewAdminHandler(database)
			protected.GET("/admin/stats", adminHandler.GetStats)
			protected.GET("/admin/users", adminHandler.ListUsers)
			protected.DELETE("/admin/users/:id", adminHandler.DeleteUser)
			protected.PATCH("/admin/users/:id/role", adminHandler.SetUserAdmin)
			protected.GET("/admin/videos", adminHandler.ListVideos)
			protected.DELETE("/admin/videos/:id", adminHandler.DeleteVideo)
			protected.PATCH("/admin/videos/:id/publish", adminHandler.ToggleVideoPublish)

			// Search history (authenticated)
			searchHistHandler := handlers.NewSearchHandler(database, cfg.JWTSecret)
			protected.POST("/search/history", searchHistHandler.SaveSearchHistory)
			protected.GET("/search/history", searchHistHandler.GetSearchHistory)
			protected.DELETE("/search/history/:id", searchHistHandler.DeleteSearchHistory)
			protected.DELETE("/search/history", searchHistHandler.ClearSearchHistory)

			// Notifications (authenticated)
			notifHandler := handlers.NewNotificationHandler(database, cfg.JWTSecret)
			protected.GET("/notifications", notifHandler.GetNotifications)
			protected.GET("/notifications/unread", notifHandler.GetUnreadCount)
			protected.PATCH("/notifications/read", notifHandler.MarkAllRead)
			protected.PATCH("/notifications/:id/read", notifHandler.MarkOneRead)
			protected.DELETE("/notifications/:id", notifHandler.DeleteNotification)
		}
	}

	log.Printf("Phatforces backend running on :%s", cfg.Port)
	r.Run(":" + cfg.Port)
}
