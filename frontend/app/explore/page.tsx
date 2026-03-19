'use client';
import { useState, useEffect, useRef } from 'react';
import { api, getThumbUrl, getVideoUrl } from '@/lib/api';
import { Video } from '@/lib/store';
import { useAuthExpired } from '@/lib/useAuthExpired';
import AuthModal from '@/components/AuthModal';
import VideoCard from '@/components/VideoCard';
import { AiFillHeart, AiOutlineComment } from 'react-icons/ai';
import Link from 'next/link';

// Mini video card for the grid - plays on hover
function VideoGridItem({ video, onClick }: { video: Video; onClick: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (hovered) {
      v.muted = true;
      v.play().catch(() => {});
    } else {
      v.pause();
      v.currentTime = 0;
    }
  }, [hovered]);

  const fmt = (n: number) =>
    n >= 1000000 ? (n / 1000000).toFixed(1) + 'M' :
    n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n || 0);

  return (
    <div
      className="aspect-[9/16] bg-[#1F2030] rounded-xl overflow-hidden relative cursor-pointer group"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
    >
      {/* Thumbnail shown when not hovered */}
      {!hovered && video.thumbnail_url && (
        <img
          src={getThumbUrl(video.thumbnail_url)}
          alt={video.title}
          className="absolute inset-0 w-full h-full object-cover"
        />
      )}

      {/* Video - always in DOM so it loads, only visible when hovered */}
      <video
        ref={ref}
        src={getVideoUrl(video.video_url)}
        loop
        muted
        playsInline
        preload="metadata"
        className={`w-full h-full object-cover transition-opacity duration-200 ${hovered ? 'opacity-100' : 'opacity-0'}`}
      />

      {/* Colored bg fallback when no thumbnail */}
      {!video.thumbnail_url && !hovered && (
        <div className="absolute inset-0 bg-gradient-to-b from-[#2D2F3E] to-[#1F2030] flex items-center justify-center">
          <span className="text-4xl">🎬</span>
        </div>
      )}

      {/* Play indicator when hovered */}
      {hovered && (
        <div className="absolute top-2 right-2 bg-[#FE2C55] rounded-full px-2 py-0.5 text-white text-xs font-bold flex items-center gap-1">
          ▶ LIVE
        </div>
      )}

      {/* Bottom overlay */}
      <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/90 to-transparent">
        <p className="text-white text-xs font-semibold line-clamp-2 mb-1 leading-tight">{video.title}</p>
        <div className="flex items-center justify-between">
          <Link
            href={`/${video.author?.username}`}
            className="text-gray-300 text-xs hover:text-white transition-colors"
            onClick={e => e.stopPropagation()}
          >
            @{video.author?.username}
          </Link>
          <div className="flex items-center gap-2 text-gray-300 text-xs">
            <span className="flex items-center gap-0.5">
              <AiFillHeart size={11} className="text-[#FE2C55]" /> {fmt(video.like_count)}
            </span>
            <span className="flex items-center gap-0.5">
              <AiOutlineComment size={11} /> {fmt(video.comment_count)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ExplorePage() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const { showAuth, setShowAuth } = useAuthExpired();

  useEffect(() => {
    api.get('/search/trending')
      .then(r => setVideos(r.data.videos || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Full-screen player when a video is clicked
  if (activeIndex !== null && videos[activeIndex]) {
    return (
      <div className="fixed inset-0 z-50 bg-black flex items-center justify-center">
        {/* Close button */}
        <button
          onClick={() => setActiveIndex(null)}
          className="absolute top-4 left-4 z-60 text-white bg-black/50 rounded-full w-10 h-10 flex items-center justify-center text-xl hover:bg-black/80 transition-colors"
        >
          ✕
        </button>

        {/* Prev / Next arrows */}
        {activeIndex > 0 && (
          <button
            onClick={() => setActiveIndex(i => (i ?? 1) - 1)}
            className="absolute left-4 top-1/2 -translate-y-1/2 z-60 text-white bg-black/50 rounded-full w-10 h-10 flex items-center justify-center text-xl hover:bg-black/80 transition-colors hidden md:flex"
          >
            ‹
          </button>
        )}
        {activeIndex < videos.length - 1 && (
          <button
            onClick={() => setActiveIndex(i => (i ?? 0) + 1)}
            className="absolute right-20 md:right-4 top-1/2 -translate-y-1/2 z-60 text-white bg-black/50 rounded-full w-10 h-10 flex items-center justify-center text-xl hover:bg-black/80 transition-colors"
          >
            ›
          </button>
        )}

        {/* VideoCard reused - full experience */}
        <div className="w-full max-w-sm h-screen overflow-hidden relative">
          <VideoCard
            video={videos[activeIndex]}
            isActive={true}
            onAuthRequired={() => setShowAuth(true)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#161823] p-4 pb-20 md:pb-4">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="mb-5">
          <h1 className="text-white font-bold text-2xl">Explore</h1>
          <p className="text-gray-400 text-sm mt-1">Hover to preview · Click to watch</p>
        </div>

        {loading && (
          <div className="flex justify-center py-20">
            <div className="w-8 h-8 border-2 border-[#FE2C55] border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {!loading && videos.length === 0 && (
          <div className="text-center text-gray-400 py-16">
            <p className="text-4xl mb-3">🎬</p>
            <p>No trending videos yet</p>
          </div>
        )}

        {!loading && videos.length > 0 && (
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            {videos.map((v, idx) => (
              <VideoGridItem
                key={v.id}
                video={v}
                onClick={() => setActiveIndex(idx)}
              />
            ))}
          </div>
        )}
      </div>
      {showAuth && <AuthModal onClose={() => setShowAuth(false)} />}
    </div>
  );
}
