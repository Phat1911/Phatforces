# Phatforces

A TikTok-inspired short video platform built with Go, Next.js, and PostgreSQL.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Go 1.22 + Gin framework |
| Frontend | Next.js 14 + TypeScript + Tailwind CSS |
| Database | PostgreSQL |
| Cache | Redis |
| Auth | JWT (access + refresh tokens) |
| Media | Local file storage (uploads/) |

## Features

- Short video feed (For You + Following)
- User authentication (register, login, JWT)
- Video upload, like, view tracking
- Comments
- User profiles with follow/unfollow
- Search and trending
- Monetization stats
- Explore page

## Project Structure

```
photcot/
├── backend/
│   ├── cmd/main.go           # Entry point
│   ├── internal/
│   │   ├── config/           # Env config loader
│   │   ├── db/               # PostgreSQL + migrations
│   │   ├── email/            # Email sender (Resend)
│   │   ├── handlers/         # HTTP handlers (auth, video, user, feed...)
│   │   ├── middleware/        # JWT auth, CORS
│   │   └── models/           # Shared data models
│   ├── go.mod
│   └── go.sum
├── frontend/
│   ├── app/                  # Next.js App Router pages
│   │   ├── page.tsx          # Home feed
│   │   ├── explore/          # Explore page
│   │   ├── upload/           # Video upload
│   │   ├── search/           # Search
│   │   ├── profile/          # Own profile
│   │   └── [username]/       # Public user profile
│   ├── components/           # Shared UI components
│   ├── lib/                  # API client, auth store
│   └── package.json
└── scripts/
    └── seed.py               # Database seeder
```

## Getting Started

### Prerequisites

- Go 1.22+
- Node.js 18+
- PostgreSQL 14+
- Redis 6+
- WSL2 (if running on Windows)

### Setup

**1. Clone the repo**
```bash
git clone https://github.com/Phat1911/Phatforces.git
cd Phatforces
```

**2. Configure environment**
```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env`:
```env
PORT=8080
DB_URL=postgres://photcot:photcot123@localhost:5432/photcot?sslmode=disable
REDIS_URL=localhost:6379
JWT_SECRET=your_secret_key_here
JWT_EXPIRES_IN=24h
UPLOAD_DIR=./uploads
RESEND_API_KEY=your_resend_api_key
EMAIL_FROM=Phatforces <onboarding@resend.dev>
```

**3. Start services**
```bash
sudo service postgresql start
sudo service redis-server start
```

**4. Run the backend**
```bash
cd backend
go run cmd/main.go
# Server starts on :8080
```

**5. Run the frontend**
```bash
cd frontend
npm install
npm run dev
# App starts on :3000
```

**6. Open the app**

Navigate to [http://localhost:3000](http://localhost:3000)

### Quick Start (WSL)

Use the included startup script to start all services at once:
```bash
bash ~/start_photcot.sh
```

## API Endpoints

### Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/auth/register` | Create account |
| POST | `/api/v1/auth/login` | Login |
| POST | `/api/v1/auth/refresh` | Refresh JWT token |

### Videos
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/videos` | Upload video |
| GET | `/api/v1/videos/:id` | Get video |
| DELETE | `/api/v1/videos/:id` | Delete video |
| POST | `/api/v1/videos/:id/like` | Like video |
| DELETE | `/api/v1/videos/:id/like` | Unlike video |
| POST | `/api/v1/videos/:id/view` | Record view |

### Feed
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/feed/public` | Public feed |
| GET | `/api/v1/feed/foryou` | For You feed (auth) |
| GET | `/api/v1/feed/following` | Following feed (auth) |

### Users
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/users/:username` | Get profile |
| PUT | `/api/v1/users/me` | Update profile |
| POST | `/api/v1/u/:id/follow` | Follow user |
| DELETE | `/api/v1/u/:id/follow` | Unfollow user |

### Search
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/search` | Search videos/users |
| GET | `/api/v1/search/trending` | Trending content |

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `PORT` | Backend server port | Yes |
| `DB_URL` | PostgreSQL connection string | Yes |
| `REDIS_URL` | Redis connection string | Yes |
| `JWT_SECRET` | Secret key for signing JWTs | Yes |
| `JWT_EXPIRES_IN` | Token expiry (e.g. `24h`) | Yes |
| `UPLOAD_DIR` | Directory for uploaded videos | Yes |
| `RESEND_API_KEY` | Resend API key for email | Optional |
| `EMAIL_FROM` | Sender email address | Optional |

## License

MIT
