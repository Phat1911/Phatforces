#!/usr/bin/env python3
"""Phot Cot - Database Seeder. Creates 10 virtual users and demo video data."""
import psycopg2
import bcrypt
import uuid
import random

DB_URL = "postgres://photcot:photcot123@localhost:5432/photcot"

USERS = [
    {"username": "thuytien_dance", "display_name": "Thuy Tien Dance", "bio": "Dancing is my life"},
    {"username": "foodie_saigon", "display_name": "Foodie Saigon", "bio": "Street food explorer"},
    {"username": "travel_vietnam", "display_name": "Travel Vietnam", "bio": "Exploring every corner of VN"},
    {"username": "comedy_khoa", "display_name": "Comedy Khoa", "bio": "Making you laugh every day"},
    {"username": "music_linh", "display_name": "Music Linh", "bio": "Singer and songwriter"},
    {"username": "tech_minh", "display_name": "Tech Minh", "bio": "Tech tips and tricks"},
    {"username": "beauty_ngoc", "display_name": "Beauty Ngoc", "bio": "Makeup and skincare"},
    {"username": "sport_hung", "display_name": "Sport Hung", "bio": "Football lover"},
    {"username": "cooking_mai", "display_name": "Cooking Mai", "bio": "Home cooking recipes"},
    {"username": "vlog_tuan", "display_name": "Vlog Tuan", "bio": "Daily life vlogs"},
]

VIDEO_TITLES = [
    ("Morning routine in Saigon", "morning,routine,saigon,vlog"),
    ("Banh mi review TOP 5 in HCMC", "food,banhmi,saigon,review"),
    ("Learning to cook Pho from scratch", "cooking,pho,recipe,vietnam"),
    ("Street dance challenge 2026", "dance,challenge,viral,street"),
    ("Ha Long Bay solo trip vlog", "travel,halong,vlog,vietnam"),
    ("iPhone 17 vs Samsung S25 comparison", "tech,iphone,samsung,review"),
    ("5 minute makeup routine", "beauty,makeup,tutorial,quick"),
    ("Football freestyle tricks", "sport,football,freestyle,viral"),
    ("Cooking bun bo hue from scratch", "cooking,bunbohue,recipe"),
    ("Comedy skit - Vietnamese family dinner", "comedy,family,relatable,funny"),
    ("Hoi An night market tour", "travel,hoian,nightmarket,vlog"),
    ("Easy 3-ingredient Vietnamese dessert", "cooking,dessert,easy,recipe"),
    ("Day in the life of a developer in HN", "tech,developer,hanoi,vlog"),
    ("Viral dance tutorial", "dance,tutorial,viral,trending"),
    ("Ben Thanh market street food haul", "food,market,saigon,streetfood"),
]

def seed():
    conn = psycopg2.connect(DB_URL)
    cur = conn.cursor()
    print("Connected to database")

    password_hash = bcrypt.hashpw(b"password123", bcrypt.gensalt()).decode()
    user_ids = []

    for u in USERS:
        uid = str(uuid.uuid4())
        email = u["username"] + "@photcot.demo"
        cur.execute(
            "INSERT INTO users (id, username, email, password_hash, display_name, bio, follower_count, following_count, total_likes) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (username) DO NOTHING RETURNING id",
            (uid, u["username"], email, password_hash, u["display_name"], u["bio"],
             random.randint(100, 50000), random.randint(50, 500), random.randint(500, 200000))
        )
        row = cur.fetchone()
        if row:
            user_ids.append(row[0])
            print("  Created user: @" + u["username"])
        else:
            cur.execute("SELECT id FROM users WHERE username = %s", (u["username"],))
            row = cur.fetchone()
            if row:
                user_ids.append(row[0])

    conn.commit()

    for i, uid in enumerate(user_ids):
        others = [u for u in user_ids if u != uid]
        for fid in random.sample(others, min(5, len(others))):
            cur.execute(
                "INSERT INTO follows (follower_id, following_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                (uid, fid)
            )
    conn.commit()

    for i, (title, tags) in enumerate(VIDEO_TITLES):
        if not user_ids:
            break
        uid = user_ids[i % len(user_ids)]
        vid = str(uuid.uuid4())
        hashtags = "{" + tags + "}"
        view_count = random.randint(500, 500000)
        like_count = int(view_count * random.uniform(0.03, 0.15))
        comment_count = int(like_count * random.uniform(0.05, 0.2))
        cur.execute(
            "INSERT INTO videos (id, user_id, title, description, video_url, thumbnail_url, duration, view_count, like_count, comment_count, hashtags) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT DO NOTHING",
            (vid, uid, title, "Check out this video! #photcot",
             "/uploads/demo/video_" + str(i+1) + ".mp4",
             "/uploads/demo/thumb_" + str(i+1) + ".jpg",
             random.uniform(15, 90), view_count, like_count, comment_count, hashtags)
        )
        print("  Created video: " + title)

    conn.commit()

    cur.execute("SELECT id FROM videos LIMIT 10")
    video_ids = [r[0] for r in cur.fetchall()]
    sample_comments = [
        "This is amazing!", "Love this content!", "Keep it up!",
        "So relatable", "Where is this place?", "Tutorial please!",
        "Sharing this with everyone!", "More please!",
    ]
    for vid in video_ids:
        for _ in range(random.randint(2, 5)):
            uid = random.choice(user_ids)
            comment = random.choice(sample_comments)
            cur.execute(
                "INSERT INTO comments (video_id, user_id, content) VALUES (%s, %s, %s)",
                (vid, uid, comment)
            )

    conn.commit()
    cur.close()
    conn.close()
    print("\nSeeding complete!")
    print("  - " + str(len(user_ids)) + " virtual users created")
    print("  - " + str(len(VIDEO_TITLES)) + " demo videos created")
    print("  Login: email = username@photcot.demo | password = password123")

if __name__ == "__main__":
    seed()
