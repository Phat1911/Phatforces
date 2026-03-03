import { create } from 'zustand';

export interface User {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string;
  bio: string;
  is_verified: boolean;
  follower_count: number;
  following_count: number;
  total_likes: number;
  coins: number;
}

export interface Video {
  id: string;
  user_id: string;
  author: User;
  title: string;
  description: string;
  video_url: string;
  thumbnail_url: string;
  duration: number;
  view_count: number;
  like_count: number;
  comment_count: number;
  share_count: number;
  hashtags: string[];
  is_liked: boolean;
  created_at: string;
}

interface AuthStore {
  user: User | null;
  token: string | null;
  setAuth: (user: User, token: string) => void;
  clearAuth: () => void;
}

export const useAuthStore = create<AuthStore>((set) => ({
  user: null,
  token: null,
  setAuth: (user, token) => set({ user, token }),
  clearAuth: () => set({ user: null, token: null }),
}));

interface FeedStore {
  videos: Video[];
  currentIndex: number;
  setVideos: (videos: Video[]) => void;
  appendVideos: (videos: Video[]) => void;
  setCurrentIndex: (i: number) => void;
}

export const useFeedStore = create<FeedStore>((set) => ({
  videos: [],
  currentIndex: 0,
  setVideos: (videos) => set({ videos }),
  appendVideos: (videos) => set((s) => ({ videos: [...s.videos, ...videos] })),
  setCurrentIndex: (currentIndex) => set({ currentIndex }),
}));
