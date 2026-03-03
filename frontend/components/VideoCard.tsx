'use client';
import { useRef, useEffect, useState } from 'react';
import { api, getVideoUrl, getThumbUrl } from '@/lib/api';
import { Video } from '@/lib/store';
import { AiFillHeart, AiOutlineHeart, AiOutlineComment, AiOutlineShareAlt } from 'react-icons/ai';
import { BsMusicNote, BsVolumeMute, BsVolumeUp } from 'react-icons/bs';
import { IoBookmarkOutline, IoClose } from 'react-icons/io5';
import Link from 'next/link';
import toast from 'react-hot-toast';
import Cookies from 'js-cookie';

interface Props { video: Video; isActive: boolean; onAuthRequired: () => void; }
interface Comment { id: string; content: string; author: { username: string; avatar_url: string }; created_at: string; }

let globalMuted = true;

export default function VideoCard({ video, isActive, onAuthRequired }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [liked, setLiked] = useState(video.is_liked);
  const [likeCount, setLikeCount] = useState(video.like_count || 0);
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(globalMuted);
  const [showComments, setShowComments] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentText, setCommentText] = useState('');
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [likeAnim, setLikeAnim] = useState(false);
  const [doubleTapHeart, setDoubleTapHeart] = useState(false);
  const lastTapRef = useRef(0);
  const viewRecordedRef = useRef(false);
  const viewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (v) v.muted = muted;
  }, [muted]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (isActive) {
      v.muted = globalMuted;
      setMuted(globalMuted);
      const p = v.play();
      if (p) p.catch(() => {});
      setPaused(false);
      viewTimerRef.current = setTimeout(() => {
        if (!viewRecordedRef.current && Cookies.get('photcot_token')) {
          api.post(`/videos/${video.id}/view`, { watch_time: 3, watch_percent: 50 }).catch(() => {});
          viewRecordedRef.current = true;
        }
      }, 3000);
    } else {
      const p = v.play().catch(() => {});
      if (p) p.then(() => { v.pause(); v.currentTime = 0; }).catch(() => {});
      else { v.pause(); v.currentTime = 0; }
      setProgress(0);
      if (viewTimerRef.current) clearTimeout(viewTimerRef.current);
    }
    return () => { if (viewTimerRef.current) clearTimeout(viewTimerRef.current); };
  }, [isActive, video.id]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !isActive) return;
    const update = () => {
      if (v.duration) setProgress((v.currentTime / v.duration) * 100);
    };
    v.addEventListener('timeupdate', update);
    return () => v.removeEventListener('timeupdate', update);
  }, [isActive]);

  const toggleMute = (e: React.MouseEvent) => {
    e.stopPropagation();
    const v = videoRef.current;
    if (!v) return;
    const newMuted = !muted;
    v.muted = newMuted;
    globalMuted = newMuted;
    setMuted(newMuted);
  };

  const handleLike = async () => {
    if (!Cookies.get('photcot_token')) { onAuthRequired(); return; }
    setLikeAnim(true);
    setTimeout(() => setLikeAnim(false), 400);
    try {
      if (liked) {
        await api.delete(`/videos/${video.id}/like`);
        setLiked(false); setLikeCount(c => Math.max(0, c - 1));
      } else {
        await api.post(`/videos/${video.id}/like`);
        setLiked(true); setLikeCount(c => c + 1);
      }
    } catch { toast.error('Failed'); }
  };

  const openComments = async () => {
    setShowComments(true);
    if (comments.length > 0) return;
    setCommentsLoading(true);
    try {
      const res = await api.get(`/videos/${video.id}/comments`);
      setComments(res.data.comments || []);
    } catch { toast.error('Could not load comments'); }
    finally { setCommentsLoading(false); }
  };

  const submitComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!Cookies.get('photcot_token')) { onAuthRequired(); return; }
    if (!commentText.trim()) return;
    try {
      const res = await api.post(`/videos/${video.id}/comments`, { content: commentText });
      setComments(prev => [res.data, ...prev]);
      setCommentText('');
      toast.success('Comment posted!');
    } catch { toast.error('Failed to post comment'); }
  };

  const handleShare = () => {
    navigator.clipboard.writeText(window.location.origin + '?v=' + video.id).catch(() => {});
    toast.success('Link copied!');
  };

  const togglePlay = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('[data-mute-btn]')) return;
    const now = Date.now();
    if (now - lastTapRef.current < 300) {
      // Double tap - like
      if (!liked && Cookies.get('photcot_token')) {
        setDoubleTapHeart(true);
        setTimeout(() => setDoubleTapHeart(false), 900);
        handleLike();
      }
      return;
    }
    lastTapRef.current = now;
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { v.play().catch(() => {}); setPaused(false); }
    else { v.pause(); setPaused(true); }
  };

  const fmt = (n: number) =>
    n >= 1000000 ? (n/1000000).toFixed(1)+'M' : n >= 1000 ? (n/1000).toFixed(1)+'K' : String(n || 0);

  const videoSrc = getVideoUrl(video.video_url);

  return (
    <div className="video-item" onClick={togglePlay}>
      {videoSrc ? (
        <video
          ref={videoRef}
          src={videoSrc}
          loop
          playsInline
          muted={muted}
          className="max-h-screen max-w-full object-contain"
          style={{ maxWidth: '420px', width: '100%' }}
        />
      ) : (
        <div className="w-full max-w-sm aspect-[9/16] bg-gradient-to-br from-[#1F2030] to-[#2D2F3E] flex items-center justify-center rounded-lg">
          <span className="text-gray-500 text-4xl">🎬</span>
        </div>
      )}

      {/* Pause overlay */}
      {paused && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-20 h-20 bg-black/40 backdrop-blur-sm rounded-full flex items-center justify-center border border-white/20 shadow-2xl">
            <div className="w-0 h-0 border-t-[16px] border-b-[16px] border-l-[28px] border-t-transparent border-b-transparent border-l-white ml-2 drop-shadow" />
          </div>
        </div>
      )}

      {/* Double-tap heart animation */}
      {doubleTapHeart && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-20">
          <AiFillHeart
            size={100}
            className="text-[#FE2C55] drop-shadow-2xl animate-ping opacity-90"
            style={{ animationDuration: '0.7s', animationIterationCount: 1 }}
          />
        </div>
      )}

      {/* Mute button */}
      <button
        data-mute-btn="true"
        onClick={toggleMute}
        className="absolute top-16 right-4 z-30 w-10 h-10 bg-black/40 backdrop-blur-sm border border-white/10 rounded-full flex items-center justify-center text-white hover:bg-black/60 transition-all shadow-lg"
      >
        {muted ? <BsVolumeMute size={18} /> : <BsVolumeUp size={18} />}
      </button>

      {/* Progress bar - glossy */}
      <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-white/10 z-20">
        <div
          className="h-full transition-all duration-100"
          style={{
            width: `${progress}%`,
            background: 'linear-gradient(90deg, #FE2C55, #ff6b6b)'
          }}
        />
      </div>

      {/* Bottom info - richer gradient */}
      <div className="absolute bottom-2 left-0 right-16 p-4" style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.6) 50%, transparent 100%)' }}>
        <Link
          href={`/@${video.author?.username}`}
          className="flex items-center gap-2 mb-2"
          onClick={e => e.stopPropagation()}
        >
          <div className="w-9 h-9 rounded-full overflow-hidden flex-shrink-0 flex items-center justify-center text-white text-xs font-bold ring-2 ring-[#FE2C55] ring-offset-1 ring-offset-black shadow-lg">
            {video.author?.avatar_url
              ? <img src={getThumbUrl(video.author.avatar_url)} alt="" className="w-full h-full object-cover" />
              : <div className="w-full h-full bg-gradient-to-br from-[#FE2C55] to-[#ff8c00] flex items-center justify-center">{video.author?.username?.[0]?.toUpperCase()}</div>
            }
          </div>
          <span className="font-bold text-sm text-white drop-shadow-lg">@{video.author?.username}</span>
          {video.author?.is_verified && <span className="text-[#FE2C55] text-xs font-bold">&#10003;</span>}
        </Link>
        {video.title && (
          <p className="text-sm text-white font-semibold drop-shadow-lg line-clamp-2 mb-1 leading-snug">{video.title}</p>
        )}
        {video.hashtags?.length > 0 && (
          <p className="text-xs font-bold" style={{ color: '#ff6b8a' }}>
            {video.hashtags.slice(0, 4).map((h: string) => `#${h}`).join(' ')}
          </p>
        )}
        <div className="flex items-center gap-1 mt-1.5 text-xs text-gray-300">
          <BsMusicNote size={10} className="text-white" />
          <span className="truncate max-w-[160px]">Original sound - @{video.author?.username}</span>
        </div>
      </div>

      {/* Action buttons - glossier */}
      <div className="absolute right-2 bottom-16 flex flex-col items-center gap-4">
        {/* Avatar */}
        <Link href={`/@${video.author?.username}`} onClick={e => e.stopPropagation()}>
          <div className="relative">
            <div className="w-12 h-12 rounded-full overflow-hidden ring-2 ring-white shadow-xl flex items-center justify-center text-white font-bold">
              {video.author?.avatar_url
                ? <img src={getThumbUrl(video.author.avatar_url)} alt="" className="w-full h-full object-cover" />
                : <div className="w-full h-full bg-gradient-to-br from-[#FE2C55] to-[#ff8c00] flex items-center justify-center">{video.author?.username?.[0]?.toUpperCase()}</div>
              }
            </div>
            <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 w-5 h-5 rounded-full flex items-center justify-center text-white text-xs font-bold border-2 border-[#161823] shadow"
              style={{ background: 'linear-gradient(135deg, #FE2C55, #ff8c00)' }}>+</div>
          </div>
        </Link>

        {/* Like */}
        <button
          onClick={(e) => { e.stopPropagation(); handleLike(); }}
          className="flex flex-col items-center gap-0.5 group"
        >
          <div className={`w-12 h-12 rounded-full flex items-center justify-center transition-all duration-200 ${
            liked ? 'bg-[#FE2C55]/20' : 'bg-black/30'
          } backdrop-blur-sm border border-white/10 shadow-lg ${
            likeAnim ? 'scale-125' : 'scale-100 group-hover:scale-110'
          }`}>
            {liked
              ? <AiFillHeart size={28} className="text-[#FE2C55] drop-shadow" style={{ filter: 'drop-shadow(0 0 8px #FE2C55)' }} />
              : <AiOutlineHeart size={28} className="text-white drop-shadow group-hover:text-[#FE2C55] transition-colors" />
            }
          </div>
          <span className="text-xs font-bold text-white drop-shadow">{fmt(likeCount)}</span>
        </button>

        {/* Comment */}
        <button
          onClick={(e) => { e.stopPropagation(); openComments(); }}
          className="flex flex-col items-center gap-0.5 group"
        >
          <div className="w-12 h-12 rounded-full flex items-center justify-center bg-black/30 backdrop-blur-sm border border-white/10 shadow-lg group-hover:scale-110 transition-transform">
            <AiOutlineComment size={26} className="text-white drop-shadow" />
          </div>
          <span className="text-xs font-bold text-white drop-shadow">{fmt(video.comment_count || 0)}</span>
        </button>

        {/* Save */}
        <button
          className="flex flex-col items-center gap-0.5 group"
          onClick={e => e.stopPropagation()}
        >
          <div className="w-12 h-12 rounded-full flex items-center justify-center bg-black/30 backdrop-blur-sm border border-white/10 shadow-lg group-hover:scale-110 transition-transform">
            <IoBookmarkOutline size={24} className="text-white drop-shadow" />
          </div>
          <span className="text-xs font-bold text-white drop-shadow">Save</span>
        </button>

        {/* Share */}
        <button
          onClick={(e) => { e.stopPropagation(); handleShare(); }}
          className="flex flex-col items-center gap-0.5 group"
        >
          <div className="w-12 h-12 rounded-full flex items-center justify-center bg-black/30 backdrop-blur-sm border border-white/10 shadow-lg group-hover:scale-110 transition-transform">
            <AiOutlineShareAlt size={26} className="text-white drop-shadow" />
          </div>
          <span className="text-xs font-bold text-white drop-shadow">Share</span>
        </button>
      </div>

      {/* Comments drawer */}
      {showComments && (
        <div className="absolute inset-0 z-40 flex flex-col justify-end"
          style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
          onClick={(e) => { e.stopPropagation(); setShowComments(false); }}>
          <div className="rounded-t-3xl max-h-[72vh] flex flex-col"
            style={{ background: 'linear-gradient(180deg, #1a1b2e 0%, #161823 100%)', border: '1px solid rgba(255,255,255,0.08)', borderBottom: 'none' }}
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/8">
              <span className="text-white font-bold">{fmt(video.comment_count || 0)} comments</span>
              <button onClick={() => setShowComments(false)} className="text-gray-400 hover:text-white w-8 h-8 rounded-full flex items-center justify-center hover:bg-white/10 transition-colors">
                <IoClose size={20} />
              </button>
            </div>
            <div className="overflow-y-auto flex-1 px-4 py-2 space-y-3 min-h-[100px]">
              {commentsLoading && <div className="text-center text-gray-400 py-4">Loading...</div>}
              {!commentsLoading && comments.length === 0 && (
                <div className="text-center text-gray-400 py-6">No comments yet. Be first!</div>
              )}
              {comments.map(cm => (
                <div key={cm.id} className="flex gap-3 py-1">
                  <div className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-bold text-white shadow"
                    style={{ background: 'linear-gradient(135deg, #FE2C55, #ff8c00)' }}>
                    {cm.author?.username?.[0]?.toUpperCase()}
                  </div>
                  <div>
                    <span className="text-white text-xs font-bold mr-2">@{cm.author?.username}</span>
                    <span className="text-gray-200 text-sm">{cm.content}</span>
                  </div>
                </div>
              ))}
            </div>
            <form onSubmit={submitComment} className="flex gap-2 px-4 py-3 border-t border-white/8">
              <input
                value={commentText}
                onChange={e => setCommentText(e.target.value)}
                placeholder="Add a comment..."
                className="flex-1 rounded-full px-4 py-2 text-white text-sm focus:outline-none"
                style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)' }}
              />
              <button type="submit"
                className="px-4 py-2 text-white text-sm font-bold rounded-full transition-all hover:brightness-110 active:scale-95"
                style={{ background: 'linear-gradient(135deg, #FE2C55, #ff4070)' }}>
                Post
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
