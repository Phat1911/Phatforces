'use client';
import { useRef, useEffect, useState, useCallback } from 'react';
import { api, getVideoUrl, getThumbUrl } from '@/lib/api';
import { Video } from '@/lib/store';
import { videoController } from '@/lib/videoController';
import { AiFillHeart, AiOutlineHeart, AiOutlineComment, AiOutlineShareAlt } from 'react-icons/ai';
import { BsMusicNote, BsVolumeMute, BsVolumeUp } from 'react-icons/bs';
import { IoBookmarkOutline, IoBookmark, IoClose, IoCopyOutline, IoLogoWhatsapp, IoLogoFacebook, IoTrash } from 'react-icons/io5';
import Link from 'next/link';
import toast from 'react-hot-toast';
import Cookies from 'js-cookie';
import { decodeJwtPayload } from '@/lib/jwt';

interface Props { video: Video; isActive: boolean; onAuthRequired: () => void; }
interface Comment {
  id: string;
  content: string;
  image_url?: string;
  parent_id?: string;
  replies?: Comment[];
  author: { username: string; avatar_url: string };
  created_at: string;
}

export default function VideoCard({ video, isActive, onAuthRequired }: Props) {
  // Memoized callback ref - fires synchronously on DOM insert (before IO can fire).
  // Guarantees element is in videoController map before activate() is ever called.
  // Use instanceId as controller key - unique per feed slot, prevents map collision on cycling
  const ctrlKey = video.instanceId || video.id;
  const videoCallbackRef = useCallback(videoController.refCallback(ctrlKey), [ctrlKey]);
  const videoRef = useRef<HTMLVideoElement>(null);
  // combinedRef: keeps local ref for progress bar AND registers with controller
  const combinedRef = useCallback((el: HTMLVideoElement | null) => {
    (videoRef as React.MutableRefObject<HTMLVideoElement | null>).current = el;
    videoCallbackRef(el);
  }, [videoCallbackRef]);

  const [liked, setLiked] = useState(video.is_liked);
  const [likeCount, setLikeCount] = useState(video.like_count || 0);
  const [saved, setSaved] = useState(video.is_saved);
  const [saveCount, setSaveCount] = useState(video.save_count || 0);
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(videoController.isMuted());
  const [showComments, setShowComments] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentText, setCommentText] = useState('');
  const [commentImage, setCommentImage] = useState<File | null>(null);
  const [commentImagePreview, setCommentImagePreview] = useState('');
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const [expandedReplies, setExpandedReplies] = useState<Record<string, boolean>>({});
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentCount, setCommentCount] = useState(video.comment_count || 0);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isSeeking, setIsSeeking] = useState(false);
  const [showTime, setShowTime] = useState(false);
  const seekBarRef = useRef<HTMLDivElement>(null);
  const isSeekingRef = useRef(false);
  const [likeAnim, setLikeAnim] = useState(false);
  const [saveAnim, setSaveAnim] = useState(false);
  const [doubleTapHeart, setDoubleTapHeart] = useState(false);
  const lastTapRef = useRef(0);
  const viewRecordedRef = useRef(false);
  const viewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commentInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (commentImagePreview) {
        URL.revokeObjectURL(commentImagePreview);
      }
    };
  }, [commentImagePreview]);

  useEffect(() => {
    if (!replyTo) return;
    const timer = setTimeout(() => {
      commentInputRef.current?.focus();
      commentInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 0);
    return () => clearTimeout(timer);
  }, [replyTo]);

  const startReply = (cm: Comment) => {
    setReplyTo(cm);
    if (!commentText.trim()) {
      setCommentText(`@${cm.author?.username} `);
    }
  };

  // isActive drives UI only: mute icon sync, paused reset, view tracking.
  // Actual play/pause/mute is owned by videoController.activate() called
  // from IntersectionObserver in page.tsx - synchronous, no React gap.
  useEffect(() => {
    viewRecordedRef.current = false;
    if (isActive) {
      setMuted(videoController.isMuted());
      setPaused(false);
      // Record view after 3s using real watch_percent from the video element
      viewTimerRef.current = setTimeout(() => {
        if (!viewRecordedRef.current && Cookies.get('photcot_token')) {
          const v = videoRef.current;
          const dur = v?.duration || 0;
          const cur = v?.currentTime || 0;
          const watchPercent = dur > 0 ? Math.round((cur / dur) * 100) : 10;
          const watchTime = cur > 0 ? Math.round(cur) : 3;
          api.post(`/videos/${video.id}/view`, { watch_time: watchTime, watch_percent: watchPercent }).catch(() => {});
          viewRecordedRef.current = true;
        }
      }, 3000);
    } else {
      // On scroll-away: send final view with real watch_percent if not yet recorded
      const v = videoRef.current;
      if (!viewRecordedRef.current && Cookies.get('photcot_token') && v && v.duration > 0 && v.currentTime > 1) {
        const watchPercent = Math.round((v.currentTime / v.duration) * 100);
        const watchTime = Math.round(v.currentTime);
        api.post(`/videos/${video.id}/view`, { watch_time: watchTime, watch_percent: watchPercent }).catch(() => {});
        viewRecordedRef.current = true;
      }
      setProgress(0);
      setCurrentTime(0);
      setDuration(0);
      setIsSeeking(false);
      setShowTime(false);
      setPaused(false);
      if (viewTimerRef.current) clearTimeout(viewTimerRef.current);
    }
    return () => { if (viewTimerRef.current) clearTimeout(viewTimerRef.current); };
  }, [isActive, video.id]);

  // Progress bar update - tracks time and duration
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !isActive) return;
    const update = () => {
      if (v.duration && !isSeekingRef.current) {
        setCurrentTime(v.currentTime);
        setDuration(v.duration);
        setProgress((v.currentTime / v.duration) * 100);
      }
    };
    const onLoadedMeta = () => {
      if (v.duration) setDuration(v.duration);
    };
    v.addEventListener('timeupdate', update);
    v.addEventListener('loadedmetadata', onLoadedMeta);
    return () => {
      v.removeEventListener('timeupdate', update);
      v.removeEventListener('loadedmetadata', onLoadedMeta);
    };
  }, [isActive]); // isSeeking handled via isSeekingRef to avoid listener churn

  const toggleMute = (e: React.MouseEvent) => {
    e.stopPropagation();
    const newMuted = videoController.toggleMute();
    setMuted(newMuted);
  };

  const fmtTime = (s: number) => {
    if (!s || isNaN(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const getSeekPosition = (e: React.MouseEvent | React.TouchEvent): number => {
    const bar = seekBarRef.current;
    if (!bar) return 0;
    const rect = bar.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
    return x / rect.width;
  };

  const handleSeekStart = (e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    isSeekingRef.current = true;
    setIsSeeking(true);
    setShowTime(true);
    const ratio = getSeekPosition(e as React.MouseEvent);
    setProgress(ratio * 100);
    const v = videoRef.current;
    if (v && v.duration) {
      const t = ratio * v.duration;
      setCurrentTime(t);
      v.currentTime = t;
    }
    // Attach document-level drag handlers so seek works outside the narrow bar
    document.addEventListener('mousemove', handleSeekMoveDoc);
    document.addEventListener('mouseup', handleSeekEnd);
    document.addEventListener('touchmove', handleSeekMoveDoc, { passive: true });
    document.addEventListener('touchend', handleSeekEnd);
  };

  const handleSeekMove = (e: React.MouseEvent) => {
    if (!isSeekingRef.current) return;
    e.stopPropagation();
    const ratio = getSeekPosition(e);
    setProgress(ratio * 100);
    const v = videoRef.current;
    if (v && v.duration) {
      const t = ratio * v.duration;
      setCurrentTime(t);
      v.currentTime = t;
    }
  };

  // Document-level handler for drag outside the seek bar element
  const handleSeekMoveDoc = (e: MouseEvent | TouchEvent) => {
    if (!isSeekingRef.current) return;
    const bar = seekBarRef.current;
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    const clientX = e instanceof TouchEvent ? e.touches[0]?.clientX ?? 0 : e.clientX;
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
    const ratio = x / rect.width;
    setProgress(ratio * 100);
    const v = videoRef.current;
    if (v && v.duration) {
      const t = ratio * v.duration;
      setCurrentTime(t);
      v.currentTime = t;
    }
  };

  const handleSeekEnd = (e?: React.MouseEvent | MouseEvent | TouchEvent) => {
    if (e && 'stopPropagation' in e) e.stopPropagation();
    isSeekingRef.current = false;
    setIsSeeking(false);
    setShowTime(false);
    // Remove document-level drag listeners
    document.removeEventListener('mousemove', handleSeekMoveDoc);
    document.removeEventListener('mouseup', handleSeekEnd);
    document.removeEventListener('touchmove', handleSeekMoveDoc);
    document.removeEventListener('touchend', handleSeekEnd);
  };

  const handleLike = useCallback(async () => {
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
  }, [liked, video.id, onAuthRequired]);

  const handleSave = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!Cookies.get('photcot_token')) { onAuthRequired(); return; }
    setSaveAnim(true);
    setTimeout(() => setSaveAnim(false), 400);
    try {
      if (saved) {
        await api.delete(`/videos/${video.id}/save`);
        setSaved(false);
        setSaveCount(c => Math.max(0, c - 1));
        toast.success('Removed from saved');
      } else {
        await api.post(`/videos/${video.id}/save`);
        setSaved(true);
        setSaveCount(c => c + 1);
        toast.success('Saved!');
      }
    } catch { toast.error('Failed to save'); }
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

  const onCommentImageChange = (file: File | null) => {
    if (commentImagePreview) {
      URL.revokeObjectURL(commentImagePreview);
      setCommentImagePreview('');
    }
    setCommentImage(file);
    if (file) {
      setCommentImagePreview(URL.createObjectURL(file));
    }
  };

  const submitComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!Cookies.get('photcot_token')) { onAuthRequired(); return; }
    if (!commentText.trim() && !commentImage) return;
    const trimmed = commentText.trim();
    const hasImage = Boolean(commentImage);
    try {
      const res = hasImage
        ? await api.post(`/videos/${video.id}/comments`, (() => {
            const form = new FormData();
            if (trimmed) form.append('content', trimmed);
            if (commentImage) form.append('image', commentImage);
            if (replyTo?.id) form.append('parent_id', replyTo.id);
            return form;
          })(), {
            headers: { 'Content-Type': 'multipart/form-data' },
          })
        : await api.post(`/videos/${video.id}/comments`, {
            content: trimmed,
            parent_id: replyTo?.id || '',
          });

      const created = res.data as Comment;
      setComments(prev => {
        if (created.parent_id) {
          return prev.map((cm) => cm.id === created.parent_id
            ? { ...cm, replies: [created, ...(cm.replies || [])] }
            : cm);
        }
        return [created, ...prev];
      });
      // Increment comment count for top-level comments
      if (!created.parent_id) {
        setCommentCount(prev => prev + 1);
      }
      setCommentText('');
      onCommentImageChange(null);
      setReplyTo(null);
      toast.success('Comment posted!');
    } catch {
      // Fallback for backends that still do not support parent_id threading.
      if (replyTo && !hasImage && trimmed) {
        try {
          const fallbackText = trimmed.startsWith('@') ? trimmed : `@${replyTo.author?.username} ${trimmed}`;
          const res = await api.post(`/videos/${video.id}/comments`, { content: fallbackText });
          const created = res.data as Comment;
          setComments(prev => [created, ...prev]);
          setCommentCount(prev => prev + 1);
          setCommentText('');
          setReplyTo(null);
          toast.success('Reply posted as comment');
          return;
        } catch {
          // Keep generic error below.
        }
      }
      toast.error('Failed to post comment');
    }
  };

  const deleteComment = async (commentId: string, isReply: boolean, parentId?: string) => {
    try {
      await api.delete(`/comments/${commentId}`);
      
      if (isReply && parentId) {
        // Remove reply from parent
        setComments(prev => prev.map(cm => 
          cm.id === parentId
            ? { ...cm, replies: (cm.replies || []).filter(rp => rp.id !== commentId) }
            : cm
        ));
      } else {
        // Remove top-level comment
        setComments(prev => prev.filter(cm => cm.id !== commentId));
        setCommentCount(prev => Math.max(0, prev - 1));
      }
      toast.success('Comment deleted');
    } catch { toast.error('Failed to delete comment'); }
  };

  const getCurrentUsername = () => {
    const token = Cookies.get('photcot_token');
    if (!token) return null;
    const payload = decodeJwtPayload(token);
    const username = typeof payload?.username === 'string' ? payload.username : null;
    return username?.toLowerCase() || null;
  };

  const canDelete = (commentUsername?: string) => {
    if (!commentUsername) return false;
    const current = getCurrentUsername();
    return Boolean(current && current === commentUsername.toLowerCase());
  };

  const videoShareUrl = typeof window !== 'undefined'
    ? `${window.location.origin}?v=${video.id}`
    : `https://phatforces.app?v=${video.id}`;

  // Record share in backend (increments share_count + stores in shared_videos)
  const recordShare = () => {
    if (Cookies.get('photcot_token')) {
      api.post(`/videos/${video.id}/share`).catch(() => {});
    }
  };

  const handleCopyLink = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(videoShareUrl);
      toast.success('Link copied!');
      recordShare();
    } catch { toast.error('Could not copy link'); }
    setShowShare(false);
  };

  const handleNativeShare = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (navigator.share) {
      try {
        await navigator.share({
          title: video.title || 'Check this out on Phatforces',
          text: video.description || video.title || '',
          url: videoShareUrl,
        });
        recordShare();
      } catch { /* user cancelled */ }
    } else {
      navigator.clipboard.writeText(videoShareUrl).catch(() => {});
      toast.success('Link copied!');
      recordShare();
    }
    setShowShare(false);
  };

  const togglePlay = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('[data-mute-btn]')) return;
    if ((e.target as HTMLElement).closest('[data-action-btn]')) return;

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

    const isPaused = videoController.togglePlayPause(ctrlKey);
    setPaused(isPaused);
  };

  const fmt = (n: number) =>
    n >= 1000000 ? (n/1000000).toFixed(1)+'M' : n >= 1000 ? (n/1000).toFixed(1)+'K' : String(n || 0);

  const videoSrc = getVideoUrl(video.video_url);

  return (
    <div className="video-item" data-video-id={video.instanceId || video.id} onClick={togglePlay}>
      {videoSrc ? (
        <video
          ref={combinedRef}
          src={videoSrc}
          loop
          playsInline
          className="max-h-screen max-w-full object-contain"
          style={{ maxWidth: '420px', width: '100%' }}
        />
      ) : (
        <div className="w-full max-w-sm aspect-[9/16] bg-gradient-to-br from-[#1F2030] to-[#2D2F3E] flex items-center justify-center rounded-lg">
          <span className="text-gray-500 text-4xl">▶</span>
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

      {/* Seekable Play Bar */}
      <div
        className="absolute bottom-0 left-0 right-0 z-20 px-0 pb-0 select-none"
        data-action-btn="true"
        style={{ bottom: 'var(--mobile-bottom-nav-height)', touchAction: 'none' }}
      >
        {/* Time display - shown while seeking or on hover */}
        {(showTime || isSeeking) && duration > 0 && (
          <div className="flex justify-between px-3 pb-1 text-xs font-bold text-white/80 drop-shadow">
            <span>{fmtTime(currentTime)}</span>
            <span>{fmtTime(duration)}</span>
          </div>
        )}
        {/* Seek bar track */}
        <div
          ref={seekBarRef}
          className="relative w-full cursor-pointer group"
          style={{ height: isSeeking ? '20px' : '12px', paddingTop: isSeeking ? '4px' : '7px', paddingBottom: isSeeking ? '4px' : '1px' }}
          onMouseDown={handleSeekStart}
          onTouchStart={handleSeekStart}
          onClick={e => e.stopPropagation()}
        >
          {/* Track background */}
          <div className="absolute left-0 right-0 rounded-full" style={{ height: isSeeking ? '4px' : '2px', top: '50%', transform: 'translateY(-50%)', background: 'rgba(255,255,255,0.2)' }}>
            {/* Progress fill */}
            <div
              className="h-full rounded-full"
              style={{ width: `${progress}%`, background: 'linear-gradient(90deg, #FE2C55, #ff6b6b)', transition: isSeeking ? 'none' : 'width 0.1s linear' }}
            />
          </div>
          {/* Seek thumb - visible while seeking */}
          {isSeeking && (
            <div
              className="absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full shadow-lg border-2 border-white pointer-events-none"
              style={{ left: `calc(${progress}% - 8px)`, background: '#FE2C55', boxShadow: '0 0 8px rgba(254,44,85,0.8)' }}
            />
          )}
        </div>
      </div>

      {/* Bottom info */}
      <div className="absolute left-0 right-16 p-4 md:bottom-2" style={{ bottom: 'calc(var(--mobile-bottom-nav-height) + 0.5rem)', background: 'linear-gradient(to top, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.6) 50%, transparent 100%)' }}>
        <Link
          href={`/${video.author?.username}`}
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
          {video.author?.is_verified && <span className="text-[#FE2C55] text-xs font-bold">✓</span>}
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

      {/* Action buttons */}
      <div className="absolute right-2 md:bottom-16 flex flex-col items-center gap-4" style={{ bottom: 'calc(var(--mobile-bottom-nav-height) + 3.5rem)' }}>
        {/* Avatar */}
        <Link href={`/${video.author?.username}`} onClick={e => e.stopPropagation()}>
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
          data-action-btn="true"
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
          data-action-btn="true"
          onClick={(e) => { e.stopPropagation(); openComments(); }}
          className="flex flex-col items-center gap-0.5 group"
        >
          <div className="w-12 h-12 rounded-full flex items-center justify-center bg-black/30 backdrop-blur-sm border border-white/10 shadow-lg group-hover:scale-110 transition-transform">
            <AiOutlineComment size={26} className="text-white drop-shadow" />
          </div>
          <span className="text-xs font-bold text-white drop-shadow">{fmt(commentCount)}</span>
        </button>

        {/* Save / Bookmark */}
        <button
          data-action-btn="true"
          className="flex flex-col items-center gap-0.5 group"
          onClick={(e) => { e.stopPropagation(); handleSave(e); }}
        >
          <div className={`w-12 h-12 rounded-full flex items-center justify-center transition-all duration-200 ${
            saved ? 'bg-yellow-500/20' : 'bg-black/30'
          } backdrop-blur-sm border border-white/10 shadow-lg ${
            saveAnim ? 'scale-125' : 'scale-100 group-hover:scale-110'
          }`}>
            {saved
              ? <IoBookmark size={24} className="text-yellow-400 drop-shadow" style={{ filter: 'drop-shadow(0 0 6px #facc15)' }} />
              : <IoBookmarkOutline size={24} className="text-white drop-shadow group-hover:text-yellow-400 transition-colors" />
            }
          </div>
          <span className={`text-xs font-bold drop-shadow ${saved ? 'text-yellow-400' : 'text-white'}`}>
            {saveCount > 0 ? fmt(saveCount) : 'Save'}
          </span>
        </button>

        {/* Share */}
        <button
          data-action-btn="true"
          onClick={(e) => { e.stopPropagation(); setShowShare(true); }}
          className="flex flex-col items-center gap-0.5 group"
        >
          <div className="w-12 h-12 rounded-full flex items-center justify-center bg-black/30 backdrop-blur-sm border border-white/10 shadow-lg group-hover:scale-110 transition-transform">
            <AiOutlineShareAlt size={26} className="text-white drop-shadow" />
          </div>
          <span className="text-xs font-bold text-white drop-shadow">{video.share_count > 0 ? fmt(video.share_count) : 'Share'}</span>
        </button>
      </div>

      {/* Comments drawer */}
      {showComments && (
        <div
          className="absolute inset-0 z-40 flex flex-col justify-end"
          style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
          onClick={(e) => { e.stopPropagation(); setShowComments(false); }}
        >
          <div
            className="rounded-t-3xl max-h-[78vh] md:max-h-[72vh] flex flex-col"
            style={{ background: 'linear-gradient(180deg, #1a1b2e 0%, #161823 100%)', border: '1px solid rgba(255,255,255,0.08)', borderBottom: 'none' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-3 md:px-4 py-3 border-b border-white/8">
              <span className="text-white font-bold">{fmt(commentCount)} comments</span>
              <button onClick={() => setShowComments(false)} className="text-gray-400 hover:text-white w-8 h-8 rounded-full flex items-center justify-center hover:bg-white/10 transition-colors">
                <IoClose size={20} />
              </button>
            </div>

            <div className="overflow-y-auto flex-1 px-3 md:px-4 py-2 space-y-2.5 min-h-[100px]">
              {commentsLoading && <div className="text-center text-gray-400 py-4">Loading...</div>}
              {!commentsLoading && comments.length === 0 && (
                <div className="text-center text-gray-400 py-6">No comments yet. Be first!</div>
              )}

              {comments.map(cm => (
                <div key={cm.id} className="py-1">
                  <div className="flex gap-2.5 md:gap-3">
                    <div
                      className="w-7 h-7 md:w-8 md:h-8 rounded-full flex-shrink-0 flex items-center justify-center text-[10px] md:text-xs font-bold text-white shadow"
                      style={{ background: 'linear-gradient(135deg, #FE2C55, #ff8c00)' }}
                    >
                      {cm.author?.username?.[0]?.toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="text-white text-xs font-bold mr-2">@{cm.author?.username}</span>
                      <span className="text-gray-200 text-[13px] md:text-sm">{cm.content}</span>
                      {cm.image_url && (
                        <img src={getThumbUrl(cm.image_url)} alt="comment" className="mt-2 rounded-xl max-h-40 w-auto border border-white/10" />
                      )}

                      <div className="flex items-center gap-3 mt-1.5">
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); startReply(cm); }}
                          className="text-xs text-[#9ca7ff] hover:text-[#c1c8ff]"
                        >
                          Reply
                        </button>
                        {(cm.replies || []).length > 0 && (
                          <button
                            type="button"
                            onClick={() => setExpandedReplies(prev => ({ ...prev, [cm.id]: !(prev[cm.id] ?? true) }))}
                            className="text-xs text-gray-400 hover:text-gray-200"
                          >
                            {(expandedReplies[cm.id] ?? true) ? `Hide replies (${(cm.replies || []).length})` : `Show replies (${(cm.replies || []).length})`}
                          </button>
                        )}
                        {canDelete(cm.author?.username) && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); deleteComment(cm.id, false); }}
                            className="text-xs text-red-400 hover:text-red-300 flex items-center gap-1"
                          >
                            <IoTrash size={12} /> Delete
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  {(expandedReplies[cm.id] ?? true) && (cm.replies || []).map((rp) => (
                    <div key={rp.id} className="flex gap-2.5 md:gap-3 mt-2 ml-8">
                      <div
                        className="w-6 h-6 md:w-7 md:h-7 rounded-full flex-shrink-0 flex items-center justify-center text-[9px] md:text-[10px] font-bold text-white shadow"
                        style={{ background: 'linear-gradient(135deg, #6378ff, #8f66ff)' }}
                      >
                        {rp.author?.username?.[0]?.toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="text-white text-[11px] md:text-xs font-bold mr-2">@{rp.author?.username}</span>
                        <span className="text-gray-200 text-[13px] md:text-sm">{rp.content}</span>
                        {rp.image_url && (
                          <img src={getThumbUrl(rp.image_url)} alt="reply" className="mt-2 rounded-xl max-h-36 w-auto border border-white/10" />
                        )}
                        <div className="mt-1.5">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); startReply(rp); }}
                            className="text-xs text-[#9ca7ff] hover:text-[#c1c8ff]"
                          >
                            Reply
                          </button>
                        </div>
                        {canDelete(rp.author?.username) && (
                          <div className="mt-1.5">
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); deleteComment(rp.id, true, cm.id); }}
                              className="text-xs text-red-400 hover:text-red-300 flex items-center gap-1"
                            >
                              <IoTrash size={12} /> Delete
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>

            <form onSubmit={submitComment} className="px-3 md:px-4 py-3 border-t border-white/8">
              {replyTo && (
                <div className="mb-2 flex items-center justify-between rounded-lg bg-[#22253a] px-3 py-1.5 text-xs text-gray-300">
                  <span>Replying to @{replyTo.author?.username}</span>
                  <button type="button" onClick={() => setReplyTo(null)} className="text-gray-400 hover:text-white">Cancel</button>
                </div>
              )}

              <div className="flex items-center gap-1.5 md:gap-2 mb-2 overflow-x-auto no-scrollbar">
                {['😀', '😂', '😍', '🔥', '👍', '🎉', '🙏', '❤️'].map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => setCommentText((prev) => `${prev}${emoji}`)}
                    className="text-lg hover:scale-110 transition-transform"
                  >
                    {emoji}
                  </button>
                ))}
              </div>

              {commentImagePreview && (
                <div className="mb-2 inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-2 py-2">
                  <img src={commentImagePreview} alt="preview" className="w-14 h-14 rounded-lg object-cover" />
                  <div className="text-xs text-gray-300 max-w-[130px] truncate">{commentImage?.name || 'Selected image'}</div>
                  <button
                    type="button"
                    onClick={() => onCommentImageChange(null)}
                    className="text-gray-400 hover:text-white text-xs px-2"
                  >
                    Remove
                  </button>
                </div>
              )}

              <div className="flex gap-2">
                <input
                  ref={commentInputRef}
                  value={commentText}
                  onChange={e => setCommentText(e.target.value)}
                  placeholder="Add a comment..."
                  className="flex-1 rounded-full px-4 py-2 text-white text-sm focus:outline-none"
                  style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)' }}
                />
                <label className="px-3 py-2 rounded-full text-xs font-bold text-white cursor-pointer" style={{ background: 'rgba(255,255,255,0.12)' }}>
                  Photo
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => onCommentImageChange(e.target.files?.[0] || null)}
                  />
                </label>
                <button
                  type="submit"
                  className="px-4 py-2 text-white text-sm font-bold rounded-full transition-all hover:brightness-110 active:scale-95"
                  style={{ background: 'linear-gradient(135deg, #FE2C55, #ff4070)' }}
                >
                  Post
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* Share sheet - TikTok style */}
      {showShare && (
        <div
          className="absolute inset-0 z-50 flex flex-col justify-end"
          style={{ background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)' }}
          onClick={(e) => { e.stopPropagation(); setShowShare(false); }}
        >
          <div
            className="rounded-t-3xl pb-6"
            style={{
              background: 'linear-gradient(180deg, #1e1f30 0%, #161823 100%)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderBottom: 'none'
            }}
            onClick={e => e.stopPropagation()}
          >
            {/* Drag handle */}
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 rounded-full bg-white/20" />
            </div>

            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-white font-bold text-base">Share to</span>
              <button
                onClick={() => setShowShare(false)}
                className="text-gray-400 hover:text-white w-8 h-8 rounded-full flex items-center justify-center hover:bg-white/10"
              >
                <IoClose size={20} />
              </button>
            </div>

            {/* Video preview */}
            <div className="px-4 pb-3">
              <div className="flex items-center gap-3 p-3 rounded-2xl" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}>
                <div className="w-10 h-14 rounded-lg overflow-hidden flex-shrink-0 bg-[#2D2F3E]">
                  {video.thumbnail_url && (
                    <img src={getThumbUrl(video.thumbnail_url)} alt="" className="w-full h-full object-cover" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-white text-sm font-semibold truncate">{video.title || 'Video'}</p>
                  <p className="text-gray-400 text-xs">@{video.author?.username}</p>
                </div>
              </div>
            </div>

            {/* Share options */}
            <div className="grid grid-cols-4 gap-2 px-4 pb-3">
              <button onClick={handleCopyLink} className="flex flex-col items-center gap-2 group">
                <div className="w-14 h-14 rounded-2xl flex items-center justify-center group-hover:scale-110 transition-transform"
                  style={{ background: 'linear-gradient(135deg, #374151, #1f2937)' }}>
                  <IoCopyOutline size={24} className="text-white" />
                </div>
                <span className="text-white text-xs text-center leading-tight">Copy link</span>
              </button>

              <a
                href={`https://wa.me/?text=${encodeURIComponent(videoShareUrl)}`}
                target="_blank" rel="noopener noreferrer"
                onClick={e => { e.stopPropagation(); setShowShare(false); }}
                className="flex flex-col items-center gap-2 group"
              >
                <div className="w-14 h-14 rounded-2xl flex items-center justify-center group-hover:scale-110 transition-transform"
                  style={{ background: 'linear-gradient(135deg, #25d366, #128c7e)' }}>
                  <IoLogoWhatsapp size={26} className="text-white" />
                </div>
                <span className="text-white text-xs text-center leading-tight">WhatsApp</span>
              </a>

              <a
                href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(videoShareUrl)}`}
                target="_blank" rel="noopener noreferrer"
                onClick={e => { e.stopPropagation(); setShowShare(false); }}
                className="flex flex-col items-center gap-2 group"
              >
                <div className="w-14 h-14 rounded-2xl flex items-center justify-center group-hover:scale-110 transition-transform"
                  style={{ background: 'linear-gradient(135deg, #1877f2, #0a52cc)' }}>
                  <IoLogoFacebook size={26} className="text-white" />
                </div>
                <span className="text-white text-xs text-center leading-tight">Facebook</span>
              </a>

              <button onClick={handleNativeShare} className="flex flex-col items-center gap-2 group">
                <div className="w-14 h-14 rounded-2xl flex items-center justify-center group-hover:scale-110 transition-transform"
                  style={{ background: 'linear-gradient(135deg, #6366f1, #4f46e5)' }}>
                  <AiOutlineShareAlt size={24} className="text-white" />
                </div>
                <span className="text-white text-xs text-center leading-tight">More</span>
              </button>
            </div>

            <div className="mx-4 border-t border-white/8 my-1" />

            <div className="px-4 pt-1">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toast('Noted - we\'ll show you less of this', { icon: '👍' });
                  setShowShare(false);
                }}
                className="w-full text-left px-4 py-3 rounded-xl text-gray-400 text-sm hover:bg-white/5 transition-colors"
              >
                Not interested
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
