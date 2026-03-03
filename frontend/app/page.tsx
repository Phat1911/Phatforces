'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from '@/lib/api';
import { useFeedStore } from '@/lib/store';
import VideoCard from '@/components/VideoCard';
import Sidebar from '@/components/Sidebar';
import BottomNav from '@/components/BottomNav';
import AuthModal from '@/components/AuthModal';
import Cookies from 'js-cookie';

export default function HomePage() {
  const { videos, setVideos, appendVideos, currentIndex, setCurrentIndex } = useFeedStore();
  const [loading, setLoading] = useState(false);
  const [showAuth, setShowAuth] = useState(false);
  const [tab, setTab] = useState<'foryou' | 'following'>('foryou');
  // FIX: mounted prevents SSR/client mismatch on cookie reads
  const [mounted, setMounted] = useState(false);
  const loadingRef = useRef(false);
  const fetchedPagesRef = useRef<Set<string>>(new Set());
  const pageRef = useRef(1);

  useEffect(() => { setMounted(true); }, []);

  // Safe cookie check - only runs client-side after mount
  const isLoggedIn = () => mounted && !!Cookies.get('photcot_token');

  const fetchVideos = useCallback(async (pg: number, feedTab: string, reset = false) => {
    const key = `${feedTab}-${pg}`;
    if (loadingRef.current || fetchedPagesRef.current.has(key)) return;

    loadingRef.current = true;
    setLoading(true);
    fetchedPagesRef.current.add(key);
    pageRef.current = pg;

    try {
      let endpoint: string;
      const token = Cookies.get('photcot_token');
      if (feedTab === 'following') {
        if (!token) { setShowAuth(true); setLoading(false); loadingRef.current = false; fetchedPagesRef.current.delete(key); return; }
        endpoint = `/feed/following?page=${pg}`;
      } else if (token) {
        endpoint = `/feed/foryou?page=${pg}`;
      } else {
        endpoint = `/feed/public?page=${pg}`;
      }

      const res = await api.get(endpoint);
      const newVideos = res.data.videos || [];
      if (reset) setVideos(newVideos);
      else if (newVideos.length > 0) appendVideos(newVideos);
    } catch {
      fetchedPagesRef.current.delete(key);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [setVideos, appendVideos]);

  // Only start fetching after mount to avoid SSR issues
  useEffect(() => {
    if (!mounted) return;
    pageRef.current = 1;
    fetchedPagesRef.current.clear();
    fetchVideos(1, tab, true);
  }, [tab, mounted]);

  useEffect(() => {
    if (videos.length > 0 && currentIndex >= videos.length - 3 && !loadingRef.current) {
      fetchVideos(pageRef.current + 1, tab);
    }
  }, [currentIndex, videos.length, tab, fetchVideos]);

  useEffect(() => {
    const container = document.getElementById('feed-container');
    if (!container) return;
    const handleScroll = () => {
      const idx = Math.round(container.scrollTop / window.innerHeight);
      setCurrentIndex(idx);
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [setCurrentIndex]);

  useEffect(() => {
    const handler = () => setShowAuth(true);
    window.addEventListener('photcot:auth-expired', handler);
    return () => window.removeEventListener('photcot:auth-expired', handler);
  }, []);

  // Before mount: render skeleton to match server output (avoids hydration mismatch)
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

  return (
    <div className="flex h-screen bg-[#161823]">
      <Sidebar onAuthRequired={() => setShowAuth(true)} />
      <div className="flex-1 flex flex-col">
        {/* Tab bar */}
        <div className="absolute top-0 left-0 right-0 z-20 flex justify-center gap-8 pt-4 pb-2 bg-gradient-to-b from-black/60 to-transparent pointer-events-none md:pointer-events-auto md:static md:bg-transparent md:justify-start md:px-4">
          <button
            className={`font-semibold text-base pointer-events-auto transition-colors ${tab === 'foryou' ? 'text-white border-b-2 border-white pb-1' : 'text-gray-400 hover:text-white'}`}
            onClick={() => setTab('foryou')}
          >
            For You
          </button>
          <button
            className={`font-semibold text-base pointer-events-auto transition-colors ${tab === 'following' ? 'text-white border-b-2 border-white pb-1' : 'text-gray-400 hover:text-white'}`}
            onClick={() => { if (!isLoggedIn()) { setShowAuth(true); } else { setTab('following'); } }}
          >
            Following
          </button>
        </div>

        <div id="feed-container" className="video-feed-container flex-1">
          {/* Only show guest banner when not logged in */}
          {videos.length === 0 && !loading && !isLoggedIn() && (
            <div className="h-screen flex items-center justify-center">
              <div className="text-center space-y-4">
                <div className="text-6xl">🎬</div>
                <p className="text-xl font-semibold text-white">Welcome to Phatforces</p>
                <p className="text-gray-400">Short videos, big moments</p>
                <button
                  onClick={() => setShowAuth(true)}
                  className="mt-4 px-6 py-3 bg-[#FE2C55] text-white font-bold rounded-full hover:bg-[#e0193f] transition-colors"
                >
                  Sign up to get started
                </button>
              </div>
            </div>
          )}
          {videos.map((video, idx) => (
            <VideoCard
              key={video.id}
              video={video}
              isActive={idx === currentIndex}
              onAuthRequired={() => setShowAuth(true)}
            />
          ))}
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
