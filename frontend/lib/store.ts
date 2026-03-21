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
  // instanceId is unique per slot in the feed array.
  // For first-time videos instanceId === id.
  // For cycled videos instanceId === id + '_c' + cycleIndex.
  // Used as React key and VideoController map key to prevent duplicate-key bugs
  // when the same video appears multiple times in the infinite scroll list.
  instanceId: string;
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
  save_count: number;
  hashtags: string[];
  is_liked: boolean;
  is_saved: boolean;
  created_at: string;
}

interface AuthStore {
  user: User | null;
  token: string | null;
  setAuth: (user: User, token?: string) => void;
  clearAuth: () => void;
}

const loadUserFromStorage = (): User | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem('photcot_user');
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
};

export const useAuthStore = create<AuthStore>((set) => ({
  user: loadUserFromStorage(),
  token: null,
  setAuth: (user, token) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('photcot_user', JSON.stringify(user));
    }
    set({ user, token: token ?? null });
  },
  clearAuth: () => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('photcot_user');
    }
    set({ user: null, token: null });
  },
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
  setVideos: (videos) => set({ videos: videos.map(v => ({ ...v, instanceId: v.instanceId || v.id })) }),
  // appendVideos: dedup only within the current session window (last 50 videos)
  // to prevent double-fetching on overlap, but allows cycling back through
  // videos once the user has seen everything (infinite scroll never stops).
  appendVideos: (videos) => set((s) => {
    // Only deduplicate against the last 50 items to catch overlap from concurrent fetches.
    // Once the pool cycles, we allow re-adding so scroll never hits a wall.
    const recentIds = new Set(s.videos.slice(-50).map(v => v.id));
    const fresh = videos.filter(v => !recentIds.has(v.id));
    // If everything was deduped (full cycle), add all with unique instanceIds
    // so React keys and VideoController keys stay unique even for repeated videos.
    const cycleStart = s.videos.length;
    const toAdd = fresh.length > 0
      ? fresh.map(v => ({ ...v, instanceId: v.instanceId || v.id }))
      : videos.map((v, i) => ({ ...v, instanceId: `${v.id}_c${cycleStart + i}` }));
    return { videos: [...s.videos, ...toAdd] };
  }),
  setCurrentIndex: (currentIndex) => set({ currentIndex }),
}));
