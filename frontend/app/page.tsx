'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useFeedStore, type Video } from '@/lib/store';
import { videoController } from '@/lib/videoController';
import VideoCard from '@/components/VideoCard';
import Sidebar from '@/components/Sidebar';
import BottomNav from '@/components/BottomNav';
import AuthModal from '@/components/AuthModal';
import { getAuthToken, hasAuthToken } from '@/lib/auth';

// Only this many VideoCard components are mounted in the DOM at once.
// Cards outside this window are replaced with an empty placeholder div
// that preserves scroll height. This prevents memory overflow on long sessions.
const WINDOW_SIZE = 7;
const WINDOW_HALF = Math.floor(WINDOW_SIZE / 2); // 3

function HomePage() {
  const router = useRouter();
  const { videos, setVideos, appendVideos, currentIndex, setCurrentIndex } = useFeedStore();
  const [loading, setLoading] = useState(false);
  const [showAuth, setShowAuth] = useState(false);
  const [tab, setTab] = useState<'foryou' | 'following'>('foryou');
  const [mounted, setMounted] = useState(false);
  const loadingRef = useRef(false);
  const followingPage = useRef(1);
  // Deep link: holds the prefetched target video until the feed is ready to receive it.
  // Using a ref (not state) avoids triggering extra renders during the load sequence.
  const deepLinkVideoRef = useRef<import('@/lib/store').Video | null>(null);
  const deepLinkCommentRef = useRef<string | null>(null);
  // Profile zone: when opening from a user's profile, feed is locked to that
  // creator's videos in sequential order (no recommender/infinite feed).
  const profileZoneRef = useRef<{ active: boolean; username: string | null }>({
    active: false,
    username: null,
  });
  const [profileZone, setProfileZone] = useState<{ active: boolean; username: string | null }>({
    active: false,
    username: null,
  });
  // Set to true while a ?v= deep link fetch is in-flight so the tab-change effect
  // skips its own fetchVideos(reset) call and lets the deep link handle the load.
  const deepLinkPendingRef = useRef(false);
  const searchParams = useSearchParams();

  useEffect(() => { setMounted(true); }, []);

  const isLoggedIn = () => mounted && hasAuthToken();

  // Deep link handler: ?v=<video_id>
  // Prefetch the target video into deepLinkVideoRef so fetchVideos can prepend it
  // to the feed once loaded. This avoids the race where setVideos([targetVideo])
  // gets overwritten by the subsequent feed fetch setVideos([feedVideos...]).
  useEffect(() => {
    const videoId = searchParams.get('v');
    const commentId = searchParams.get('c');
    const profileUsernameRaw = searchParams.get('u');
    const profileUsername = profileUsernameRaw?.startsWith('@')
      ? profileUsernameRaw.slice(1)
      : profileUsernameRaw;
    if (!videoId || !mounted) return;
    deepLinkCommentRef.current = commentId;
    if (profileUsername) {
      const cleanUsername = profileUsername.trim();
      if (!cleanUsername) return;
      deepLinkPendingRef.current = true;
      api.get(`/users/${encodeURIComponent(cleanUsername)}`)
        .then((userRes) => api.get(`/u/${userRes.data.id}/videos`))
        .then((videosRes) => {
          const creatorVideos: Video[] = videosRes.data.videos || [];
          if (creatorVideos.length === 0) {
            profileZoneRef.current = { active: false, username: null };
            setProfileZone({ active: false, username: null });
            return;
          }
          profileZoneRef.current = { active: true, username: cleanUsername };
          setProfileZone({ active: true, username: cleanUsername });
          setVideos(creatorVideos);
          const targetIndex = creatorVideos.findIndex((v) => v.id === videoId);
          const nextIndex = targetIndex >= 0 ? targetIndex : 0;
          setCurrentIndex(nextIndex);
          const container = document.getElementById('feed-container');
          if (container) {
            container.scrollTop = nextIndex * container.clientHeight;
          }
        })
        .catch(() => {
          profileZoneRef.current = { active: false, username: null };
          setProfileZone({ active: false, username: null });
        })
        .finally(() => {
          deepLinkPendingRef.current = false;
        });

      // Remove deep link params once zone is initialized.
      const url = new URL(window.location.href);
      url.searchParams.delete('v');
      url.searchParams.delete('c');
      url.searchParams.delete('u');
      window.history.replaceState({}, '', url.toString());
      return;
    }

    // If no profile-zone marker, ensure normal global feed behavior.
    profileZoneRef.current = { active: false, username: null };
    setProfileZone({ active: false, username: null });
    const token = getAuthToken();
    const endpoint = token ? `/videos/${videoId}` : `/feed/video/${videoId}`;
    // Remove ?v= from URL immediately so back/forward navigation stays clean
    const url = new URL(window.location.href);
    url.searchParams.delete('v');
    url.searchParams.delete('c');
    window.history.replaceState({}, '', url.toString());
    deepLinkPendingRef.current = true;
    api.get(endpoint)
      .then(res => {
        const video = res.data.id ? res.data : null;
        if (video) {
          deepLinkVideoRef.current = video;
          // Trigger a fresh feed load - the deep link video will be prepended.
          // Keep deepLinkPendingRef=true until fetchVideos sets videos+scroll
          // so IntersectionObserver cannot overwrite currentIndex during setup.
          setCurrentIndex(0);
          const container = document.getElementById('feed-container');
          if (container) container.scrollTop = 0;
          loadingRef.current = false; // unblock in case tab-change already locked it
          fetchVideos(tab, true);
        } else {
          deepLinkPendingRef.current = false;
        }
      })
      .catch(() => { deepLinkPendingRef.current = false; });
  // fetchVideos and tab are intentionally omitted: this runs once on mount
  // when ?v= is present. Re-running on tab change would re-fetch unnecessarily.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, searchParams]);

  const fetchVideos = useCallback(async (feedTab: string, reset = false) => {
    if (profileZoneRef.current.active) return;
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      let endpoint: string;
      const token = getAuthToken();

      if (feedTab === 'following') {
        if (!token) {
          setShowAuth(true);
          return;
        }
        // Following tab is cursor-based (chronological, no server queue).
        if (reset) followingPage.current = 1;
        endpoint = `/feed/following?page=${followingPage.current}&limit=10`;
      } else if (token) {
        // ForYou (logged in): server owns the queue cursor, no page param needed.
        if (reset) {
          // On reset, clear the server-side queue so it rebuilds fresh.
          api.delete('/feed/queue').catch(() => {});
        }
        endpoint = `/feed/foryou?limit=10`;
      } else {
        // Public feed: page-based with modulo cycling on server.
        if (reset) followingPage.current = 1;
        endpoint = `/feed/public?page=${followingPage.current}&limit=10`;
      }

      const res = await api.get(endpoint);
      const newVideos: Video[] = res.data.videos || [];

      if (reset) {
        // If a deep link video is waiting, prepend it to the feed so it appears
        // at position 0. Remove any duplicate of it from the feed results so it
        // only appears once.
        const dlv = deepLinkVideoRef.current;
        deepLinkVideoRef.current = null;
        if (dlv) {
          const deduped = newVideos.filter(v => v.id !== dlv.id);
          setVideos([dlv, ...deduped]);
          // Force index 0 and scroll reset AFTER videos state is updated
          // to prevent IntersectionObserver from overwriting currentIndex
          // before the deep-link comment panel opens (race condition fix).
          setCurrentIndex(0);
          requestAnimationFrame(() => {
            const container = document.getElementById('feed-container');
            if (container) container.scrollTop = 0;
            // Release the IntersectionObserver block only after scroll reset
            deepLinkPendingRef.current = false;
          });
        } else {
          setVideos(newVideos);
          deepLinkPendingRef.current = false;
        }
        followingPage.current = 2;
      } else if (newVideos.length > 0) {
        appendVideos(newVideos);
        // Always advance page cursor for following/public (server queue handles foryou)
        if (feedTab !== 'foryou' || !hasAuthToken()) {
          followingPage.current += 1;
        }
      }
    } catch {
      // swallow - next scroll will retry
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [setVideos, appendVideos]);

  // Reset and reload when tab changes (or on first mount).
  // Skip if a deep link fetch is in-flight - it will call fetchVideos itself
  // once the target video is ready, ensuring correct prepend order.
  useEffect(() => {
    if (!mounted) return;
    if (deepLinkPendingRef.current) return;
    if (profileZoneRef.current.active) return;
    setCurrentIndex(0);
    const container = document.getElementById('feed-container');
    if (container) container.scrollTop = 0;
    fetchVideos(tab, true);
  }, [tab, mounted]);

  // Trigger next batch when user is 3 videos from the end.
  // `loading` is in the dep array so the effect re-fires when a fetch
  // finishes - catches the case where the user reaches the end exactly
  // while a fetch was in-flight (loadingRef blocked it, now it's free).
  useEffect(() => {
    if (profileZoneRef.current.active) return;
    if (videos.length > 0 && currentIndex >= videos.length - 3 && !loadingRef.current) {
      fetchVideos(tab);
    }
  }, [currentIndex, videos.length, loading, tab, fetchVideos]);

  // IO + first-interaction autoplay.
  // CRITICAL: The feed scrolls inside #feed-container (overflow-y: scroll).
  // IO root MUST be the container - not null/window - so intersection is measured
  // against the container's viewport, not the page viewport.
  // First-interaction: listen on the CONTAINER for scroll/touchstart, not window.
  useEffect(() => {
    const container = document.getElementById('feed-container');
    if (!container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        // Block IntersectionObserver from overwriting currentIndex while
        // a deep-link is being set up (prevents race condition with comment panel)
        if (deepLinkPendingRef.current) return;
        entries.forEach((entry) => {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
            const el = entry.target as HTMLElement;
            const idx = parseInt(el.dataset.index || '0', 10);
            const videoId = el.dataset.videoId;
            if (!videoId) return;
            videoController.activate(videoId);
            setCurrentIndex(idx);
          }
        });
      },
      { root: container, threshold: 0.5 }
    );

    const observed = new Set<Element>();
    const observe = () => {
      container.querySelectorAll('.video-item').forEach((el, i) => {
        (el as HTMLElement).dataset.index = String(i);
        if (!observed.has(el)) { observer.observe(el); observed.add(el); }
      });
    };
    observe();
    const mutation = new MutationObserver(observe);
    mutation.observe(container, { childList: true, subtree: true });

    let interacted = false;
    const activateVisible = () => {
      if (interacted) return;
      interacted = true;
      const items = container.querySelectorAll<HTMLElement>('.video-item');
      let bestId: string | null = null;
      let bestOverlap = 0;
      const cRect = container.getBoundingClientRect();
      items.forEach((el) => {
        const r = el.getBoundingClientRect();
        const overlap = Math.min(r.bottom, cRect.bottom) - Math.max(r.top, cRect.top);
        if (overlap > bestOverlap) { bestOverlap = overlap; bestId = el.dataset.videoId || null; }
      });
      if (bestId) videoController.activate(bestId);
    };
    container.addEventListener('scroll', activateVisible, { once: true, passive: true });
    container.addEventListener('touchstart', activateVisible, { once: true, passive: true });
    container.addEventListener('click', activateVisible, { once: true });

    return () => {
      observer.disconnect();
      mutation.disconnect();
      observed.clear();
      container.removeEventListener('scroll', activateVisible);
      container.removeEventListener('touchstart', activateVisible);
      container.removeEventListener('click', activateVisible);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, mounted, setCurrentIndex]);

  useEffect(() => {
    const handler = () => setShowAuth(true);
    window.addEventListener('photcot:auth-expired', handler);
    return () => window.removeEventListener('photcot:auth-expired', handler);
  }, []);

  if (!mounted) {
    return (
      <div className="flex h-screen bg-[#161823]">
        <div className="hidden md:flex flex-col w-64 border-r border-[#2D2F3E]" />
        <div className="flex-1 flex items-center justify-center">
          <div className="w-10 h-10 border-2 border-[#FE2C55] border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  // ── Virtual window rendering ─────────────────────────────────────────────
  // Only mount VideoCard for indices within [currentIndex-WINDOW_HALF, currentIndex+WINDOW_HALF].
  // All other slots render a plain div with the same height to keep scroll geometry intact.
  // When currentIndex moves, React unmounts old cards and mounts new ones automatically.
  const windowStart = Math.max(0, currentIndex - WINDOW_HALF);
  const windowEnd   = Math.min(videos.length - 1, currentIndex + WINDOW_HALF);

  return (
    <div className="flex h-screen bg-[#161823]">
      <Sidebar onAuthRequired={() => setShowAuth(true)} />
      <div className="flex-1 flex flex-col">
        <div className="absolute top-0 left-0 right-0 z-20 flex justify-center gap-8 pt-4 pb-2 bg-gradient-to-b from-black/60 to-transparent pointer-events-none md:pointer-events-auto md:static md:bg-transparent md:justify-start md:px-4">
          {profileZone.active ? (
            <div className="w-full max-w-[420px] mx-auto pointer-events-auto flex items-center justify-between px-3 py-2 rounded-xl bg-black/35 border border-white/10 backdrop-blur-sm">
              <div>
                <p className="text-[11px] uppercase tracking-[0.12em] text-gray-300">Creator Zone</p>
                <p className="text-sm font-semibold text-white">@{profileZone.username}</p>
              </div>
              <button
                onClick={() => {
                  const username = profileZone.username;
                  if (!username) return;
                  router.push(`/${encodeURIComponent(username)}`);
                }}
                className="text-xs font-semibold text-white border border-white/25 px-3 py-1.5 rounded-full hover:bg-white/10 transition-colors"
              >
                Back to profile
              </button>
            </div>
          ) : (
            <>
              <button
                className={`font-semibold text-base pointer-events-auto transition-colors ${tab === 'foryou' ? 'text-white border-b-2 border-white pb-1' : 'text-gray-400 hover:text-white'}`}
                onClick={() => {
                  profileZoneRef.current = { active: false, username: null };
                  setProfileZone({ active: false, username: null });
                  videoController.stopAll();
                  setTab('foryou');
                }}
              >
                For You
              </button>
              <button
                className={`font-semibold text-base pointer-events-auto transition-colors ${tab === 'following' ? 'text-white border-b-2 border-white pb-1' : 'text-gray-400 hover:text-white'}`}
                onClick={() => {
                  if (!isLoggedIn()) {
                    setShowAuth(true);
                  } else {
                    profileZoneRef.current = { active: false, username: null };
                    setProfileZone({ active: false, username: null });
                    videoController.stopAll();
                    setTab('following');
                  }
                }}
              >
                Following
              </button>
            </>
          )}
        </div>
        <div id="feed-container" className="video-feed-container flex-1">
          {videos.length === 0 && !loading && !isLoggedIn() && (
            <div className="h-screen flex items-center justify-center">
              <div className="text-center space-y-4">
                <div className="text-6xl">🎬</div>
                <p className="text-xl font-semibold text-white">Welcome to Phatforces</p>
                <p className="text-gray-400">Short videos, big moments</p>
                <button onClick={() => setShowAuth(true)} className="mt-4 px-6 py-3 bg-[#FE2C55] text-white font-bold rounded-full hover:bg-[#e0193f] transition-colors">
                  Sign up to get started
                </button>
              </div>
            </div>
          )}
          {videos.length === 0 && !loading && isLoggedIn() && tab === 'following' && (
            <div className="h-screen flex items-center justify-center">
              <div className="text-center space-y-4 px-6">
                <div className="text-6xl">👥</div>
                <p className="text-xl font-semibold text-white">No videos yet</p>
                <p className="text-gray-400 text-sm max-w-xs mx-auto">
                  The creators you follow haven&apos;t posted any videos yet. Follow more creators to fill your feed!
                </p>
                <button
                  onClick={() => { videoController.stopAll(); setTab('foryou'); }}
                  className="mt-4 px-6 py-3 bg-[#FE2C55] text-white font-bold rounded-full hover:bg-[#e0193f] transition-colors text-sm"
                >
                  Discover creators on For You
                </button>
              </div>
            </div>
          )}
          {videos.map((video, idx) => {
            const inWindow = idx >= windowStart && idx <= windowEnd;
            if (inWindow) {
              return (
                <VideoCard
                  key={video.instanceId || video.id}
                  video={video}
                  isActive={idx === currentIndex}
                  targetCommentId={idx === currentIndex ? (deepLinkCommentRef.current || undefined) : undefined}
                  onTargetCommentHandled={() => {
                    if (idx === currentIndex) {
                      deepLinkCommentRef.current = null;
                    }
                  }}
                  onAuthRequired={() => setShowAuth(true)}
                />
              );
            }
            // Outside window: placeholder preserves scroll height, costs ~0 memory
            return (
              <div
                key={(video.instanceId || video.id) + '_ph'}
                className="video-item video-placeholder"
                data-video-id={video.instanceId || video.id}
                data-index={String(idx)}
                style={{ maxWidth: '420px', margin: '0 auto' }}
              />
            );
          })}
          {loading && (
            <div className="h-screen flex items-center justify-center">
              <div className="w-10 h-10 border-2 border-[#FE2C55] border-t-transparent rounded-full animate-spin" />
            </div>
          )}
        </div>
      </div>
      <BottomNav onAuthRequired={() => setShowAuth(true)} />
      {showAuth && <AuthModal onClose={() => setShowAuth(false)} />}
    </div>
  );
}

// Wrap in Suspense because useSearchParams() requires it in Next.js App Router
import { Suspense } from 'react';
export default function Page() {
  return (
    <Suspense fallback={
      <div className="flex h-screen bg-[#161823] items-center justify-center">
        <div className="w-10 h-10 border-2 border-[#FE2C55] border-t-transparent rounded-full animate-spin" />
      </div>
    }>
      <HomePage />
    </Suspense>
  );
}
