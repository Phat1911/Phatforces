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
import { decodeJwtPayload } from '@/lib/jwt';

interface Props {
  video: Video;
  isActive: boolean;
  onAuthRequired: () => void;
  targetCommentId?: string;
  onTargetCommentHandled?: () => void;
}
interface Comment {
  id: string;
  content: string;
  image_url?: string;
  parent_id?: string;
  reaction_counts?: Record<string, number>;
  my_reaction?: string;
  replies?: Comment[];
  author: { username: string; avatar_url: string };
  created_at: string;
}

interface Reactor {
  user_id: string;
  username: string;
  display_name: string;
  avatar_url: string;
  type: string;
  created_at: string;
}

function countAllComments(list: Comment[]): number {
  return list.reduce((sum, cm) => sum + 1 + ((cm.replies || []).length), 0);
}

const COMMENTS_PAGE_SIZE = 20;
const REACTION_OPTIONS: Array<{ type: string; emoji: string; label: string }> = [
  { type: 'like', emoji: '👍', label: 'Like' },
  { type: 'love', emoji: '❤️', label: 'Love' },
  { type: 'care', emoji: '🤗', label: 'Care' },
  { type: 'haha', emoji: '😆', label: 'Haha' },
  { type: 'wow', emoji: '😮', label: 'Wow' },
  { type: 'sad', emoji: '😢', label: 'Sad' },
  { type: 'angry', emoji: '😡', label: 'Angry' },
];

export default function VideoCard({ video, isActive, onAuthRequired, targetCommentId, onTargetCommentHandled }: Props) {
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
  const [loggedIn, setLoggedIn] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentText, setCommentText] = useState('');
  const [commentImage, setCommentImage] = useState<File | null>(null);
  const [commentImagePreview, setCommentImagePreview] = useState('');
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const [expandedReplies, setExpandedReplies] = useState<Record<string, boolean>>({});
  const [visibleReplies, setVisibleReplies] = useState<Record<string, number>>({});
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [loadingMoreComments, setLoadingMoreComments] = useState(false);
  const [reactionPickerFor, setReactionPickerFor] = useState<string | null>(null);
  const [reactionModalCommentId, setReactionModalCommentId] = useState<string | null>(null);
  const [reactionModalOpen, setReactionModalOpen] = useState(false);
  const [reactionModalLoading, setReactionModalLoading] = useState(false);
  const [reactionModalReactors, setReactionModalReactors] = useState<Reactor[]>([]);
  const [reactionModalSummary, setReactionModalSummary] = useState<Record<string, number>>({});
  const [reactionModalFilter, setReactionModalFilter] = useState<string>('all');
  const [reactionSSEConnected, setReactionSSEConnected] = useState(false);
  const [commentsPage, setCommentsPage] = useState(1);
  const [hasMoreComments, setHasMoreComments] = useState(false);
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
  const commentNodeRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const handledDeepLinkCommentRef = useRef<string | null>(null);
  // Tracks whether the "please login" toast has been shown for this panel open
  // so it only fires once per open, not on every SSE-triggered reload.
  const loginToastShownRef = useRef(false);

  useEffect(() => {
    return () => {
      if (commentImagePreview) {
        URL.revokeObjectURL(commentImagePreview);
      }
    };
  }, [commentImagePreview]);

  // Check if user is logged in from localStorage (fast, no network call)
  useEffect(() => {
    const checkAuth = () => {
      const token = localStorage.getItem('photcot_token');
      setLoggedIn(!!token);
    };
    checkAuth();
    const onAuthChange = () => checkAuth();
    window.addEventListener('photcot:auth-changed', onAuthChange);
    window.addEventListener('photcot:auth-expired', () => setLoggedIn(false));
    return () => {
      window.removeEventListener('photcot:auth-changed', onAuthChange);
      window.removeEventListener('photcot:auth-expired', () => {});
    };
  }, []);

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

  useEffect(() => {
    if (!targetCommentId || !isActive) return;
    if (handledDeepLinkCommentRef.current === targetCommentId) return;
    handledDeepLinkCommentRef.current = targetCommentId;
    onTargetCommentHandled?.();
    const ensureOpened = async () => {
      // Always fetch fresh comments and use the returned data (avoid stale closure)
      const loadedComments = await openComments();
      const allComments = loadedComments.length > 0 ? loadedComments : comments;
      // Wait a tick for React to render the comment nodes before scrolling
      await new Promise(resolve => setTimeout(resolve, 300));
      let parentId: string | null = null;
      for (const cm of allComments) {
        if (cm.id === targetCommentId) {
          parentId = null;
          break;
        }
        const idx = (cm.replies || []).findIndex(rp => rp.id === targetCommentId);
        if (idx >= 0) {
          parentId = cm.id;
          setExpandedReplies(prev => ({ ...prev, [cm.id]: true }));
          setVisibleReplies(prev => ({ ...prev, [cm.id]: Math.max(prev[cm.id] || 10, idx + 1, 10) }));
          break;
        }
      }
      // Wait for expanded replies to render
      await new Promise(resolve => setTimeout(resolve, 150));
      const el = commentNodeRefs.current[targetCommentId];
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('ring-2', 'ring-[#FE2C55]');
        setTimeout(() => el.classList.remove('ring-2', 'ring-[#FE2C55]'), 2200);
      } else if (parentId) {
        const parentEl = commentNodeRefs.current[parentId];
        parentEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    };
    ensureOpened();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetCommentId, isActive, showComments, comments.length, onTargetCommentHandled]);

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
        if (!viewRecordedRef.current && loggedIn) {
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
      if (!viewRecordedRef.current && loggedIn && v && v.duration > 0 && v.currentTime > 1) {
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
    if (!loggedIn) { onAuthRequired(); return; }
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
    if (!loggedIn) { onAuthRequired(); return; }
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

  const openComments = async (force = false): Promise<Comment[]> => {
    setShowComments(true);
    if (!force && comments.length > 0) return comments;
    if (!force) {
      // Reset the login-toast guard each time the panel is freshly opened
      loginToastShownRef.current = false;
    }
    if (force) {
      setCommentsPage(1);
      setHasMoreComments(false);
      // Don't clear existing comments on force-reload to prevent layout jerk.
      // New comments will replace them once loaded.
    }
    setCommentsLoading(true);
    try {
      const res = await api.get(`/videos/${video.id}/comments`, {
        params: { page: 1, limit: COMMENTS_PAGE_SIZE },
      });
      const loaded = res.data.comments || [];
      setComments(loaded);
      setCommentCount(countAllComments(loaded));
      setCommentsPage(1);
      setHasMoreComments(Boolean(res.data.has_more));
      return loaded;
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 401) {
        // Not logged in - show hint once per panel open, not on every SSE retry
        if (!loginToastShownRef.current) {
          loginToastShownRef.current = true;
          toast.error('Please login to see comments');
        }
      } else {
        toast.error('Could not load comments');
      }
      return [];
    }
    finally { setCommentsLoading(false); }
  };

  const loadMoreComments = async () => {
    if (commentsLoading || loadingMoreComments || !hasMoreComments) return;
    const nextPage = commentsPage + 1;
    setLoadingMoreComments(true);
    try {
      const res = await api.get(`/videos/${video.id}/comments`, {
        params: { page: nextPage, limit: COMMENTS_PAGE_SIZE },
      });
      const loaded = res.data.comments || [];
      setComments(prev => [...prev, ...loaded]);
      setCommentCount(prev => prev + countAllComments(loaded));
      setCommentsPage(nextPage);
      setHasMoreComments(Boolean(res.data.has_more));
    } catch {
      toast.error('Could not load more comments');
    } finally {
      setLoadingMoreComments(false);
    }
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
    if (!loggedIn) { onAuthRequired(); return; }
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
      let affectedRootId: string | null = null;
      let affectedReplyCount = 0;
      setComments(prev => {
        if (created.parent_id) {
          return prev.map((cm) => {
            const isRootParent = cm.id === created.parent_id;
            const isNestedUnderRoot = (cm.replies || []).some((rp) => rp.id === created.parent_id);
            if (isRootParent || isNestedUnderRoot) {
              affectedRootId = cm.id;
              affectedReplyCount = (cm.replies || []).length + 1;
              return { ...cm, replies: [...(cm.replies || []), created] };
            }
            return cm;
          });
        }
        return [...prev, created];
      });
      if (affectedRootId) {
        setExpandedReplies(exp => ({ ...exp, [affectedRootId as string]: true }));
        setVisibleReplies(vis => ({ ...vis, [affectedRootId as string]: Math.max(vis[affectedRootId as string] || 10, affectedReplyCount) }));
      }
      setCommentCount(prev => prev + 1);
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
      const res = await api.delete(`/comments/${commentId}`);
      const deletedCount = Number(res?.data?.deleted_count) > 0 ? Number(res.data.deleted_count) : 1;

      if (isReply && parentId) {
        // Remove the deleted reply subtree in O(r) over replies in this root-thread list.
        setComments(prev => prev.map(cm => {
          if (cm.id !== parentId) return cm;
          const replies = cm.replies || [];
          const childrenByParent = new Map<string, string[]>();
          for (const rp of replies) {
            if (!rp.parent_id) continue;
            const arr = childrenByParent.get(rp.parent_id) || [];
            arr.push(rp.id);
            childrenByParent.set(rp.parent_id, arr);
          }

          const toRemove = new Set<string>();
          const stack: string[] = [commentId];
          while (stack.length > 0) {
            const curr = stack.pop() as string;
            if (toRemove.has(curr)) continue;
            toRemove.add(curr);
            const children = childrenByParent.get(curr) || [];
            for (const child of children) {
              if (!toRemove.has(child)) stack.push(child);
            }
            }
          return { ...cm, replies: replies.filter(rp => !toRemove.has(rp.id)) };
        }));
        setCommentCount(prev => Math.max(0, prev - deletedCount));
      } else {
        // Remove top-level comment (and account for local nested replies removed with it)
        setComments(prev => prev.filter(cm => cm.id !== commentId));
        setCommentCount(prev => Math.max(0, prev - deletedCount));
      }
      toast.success('Comment deleted');
    } catch { toast.error('Failed to delete comment'); }
  };

  const getCurrentUsername = () => {
    // Cannot decode HttpOnly cookie on client
    // Delete functionality will use API to verify ownership
    return null;
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
    if (loggedIn) {
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
      if (!liked && loggedIn) {
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

  const totalReactions = (cm: Comment) => Object.values(cm.reaction_counts || {}).reduce((s, v) => s + v, 0);

  const reactionEmoji = (type?: string) => REACTION_OPTIONS.find(r => r.type === type)?.emoji || '';

  const reactionSummaryEntries = (summary?: Record<string, number>) => {
    if (!summary) return [] as Array<{ type: string; count: number }>;
    return Object.entries(summary)
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => ({ type, count }));
  };

  const openReactionModal = async (commentId: string) => {
    setReactionModalCommentId(commentId);
    setReactionModalOpen(true);
    setReactionModalLoading(true);
    try {
      const res = await api.get(`/comments/${commentId}/reactions`);
      const reactors = res.data.reactors || [];
      const summary = res.data.summary || {};
      setReactionModalReactors(reactors);
      setReactionModalSummary(summary);
      const hasLike = summary.like && summary.like > 0;
      setReactionModalFilter(hasLike ? 'like' : 'all');
    } catch {
      toast.error('Failed to load reactions');
      setReactionModalOpen(false);
      setReactionModalCommentId(null);
    } finally {
      setReactionModalLoading(false);
    }
  };

  const closeReactionModal = () => {
    setReactionModalOpen(false);
    setReactionModalCommentId(null);
    setReactionModalReactors([]);
    setReactionModalSummary({});
    setReactionModalFilter('all');
  };

  const updateCommentReactionState = (commentId: string, counts: Record<string, number>, myReaction?: string | null) => {
    setComments(prev => prev.map(cm => {
      if (cm.id === commentId) {
        return {
          ...cm,
          reaction_counts: counts,
          my_reaction: myReaction === undefined || myReaction === null ? cm.my_reaction : (myReaction || ''),
        };
      }
      const replies = (cm.replies || []).map(rp => rp.id === commentId
        ? {
          ...rp,
          reaction_counts: counts,
          my_reaction: myReaction === undefined || myReaction === null ? rp.my_reaction : (myReaction || ''),
        }
        : rp);
      return { ...cm, replies };
    }));
  };

  const reactComment = async (commentId: string, type: string) => {
    if (!loggedIn) { onAuthRequired(); return; }
    try {
      const res = await api.post(`/comments/${commentId}/reaction`, { type });
      updateCommentReactionState(commentId, res.data.reaction_counts || {}, res.data.my_reaction || '');
      setReactionPickerFor(null);
    } catch {
      toast.error('Failed to react');
    }
  };

  const removeReaction = async (commentId: string) => {
    if (!loggedIn) { onAuthRequired(); return; }
    try {
      const res = await api.delete(`/comments/${commentId}/reaction`);
      updateCommentReactionState(commentId, res.data.reaction_counts || {}, res.data.my_reaction || '');
      setReactionPickerFor(null);
    } catch {
      toast.error('Failed to remove reaction');
    }
  };

  useEffect(() => {
    if (!showComments || !isActive) return;

    const base = (api.defaults.baseURL || '').replace(/\/$/, '');
    if (!base.startsWith('http')) return;

    // EventSource will automatically include HttpOnly cookie with the request
    const streamUrl = `${base}/comments/reactions/stream?video_id=${encodeURIComponent(video.id)}`;
    const es = new EventSource(streamUrl);

    es.addEventListener('connected', () => {
      setReactionSSEConnected(true);
    });

    es.addEventListener('reaction', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data || '{}') as {
          comment_id?: string;
          reaction_counts?: Record<string, number>;
        };
        if (payload.comment_id && payload.reaction_counts) {
          updateCommentReactionState(payload.comment_id, payload.reaction_counts, null);
          if (reactionModalOpen && reactionModalCommentId === payload.comment_id) {
            api.get(`/comments/${payload.comment_id}/reactions`).then((res) => {
              setReactionModalReactors(res.data.reactors || []);
              setReactionModalSummary(res.data.summary || {});
            }).catch(() => {});
          }
        }
      } catch {
        // ignore malformed event payloads
      }
    });

    es.onerror = () => {
      setReactionSSEConnected(false);
    };

    return () => {
      setReactionSSEConnected(false);
      es.close();
    };
  }, [showComments, isActive, video.id, reactionModalOpen, reactionModalCommentId]);

  useEffect(() => {
    if (!showComments || !isActive || reactionSSEConnected) return;
    const timer = setInterval(() => {
      openComments(true).catch(() => {});
    }, 4000);
    return () => clearInterval(timer);
  }, [showComments, isActive, reactionSSEConnected]);

  useEffect(() => {
    if (!reactionModalOpen || !reactionModalCommentId) return;
    const timer = setInterval(async () => {
      try {
        const res = await api.get(`/comments/${reactionModalCommentId}/reactions`);
        setReactionModalReactors(res.data.reactors || []);
        setReactionModalSummary(res.data.summary || {});
      } catch {
        // silent refresh to keep modal data fresh while open
      }
    }, 4000);
    return () => clearInterval(timer);
  }, [reactionModalOpen, reactionModalCommentId]);

  const timeAgo = (dateStr?: string) => {
    if (!dateStr) return 'now';
    const t = new Date(dateStr).getTime();
    if (Number.isNaN(t)) return 'now';
    const diffSec = Math.max(1, Math.floor((Date.now() - t) / 1000));
    if (diffSec < 60) return `${diffSec}s`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m`;
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return `${diffHour}h`;
    const diffDay = Math.floor(diffHour / 24);
    if (diffDay < 7) return `${diffDay}d`;
    const diffWeek = Math.floor(diffDay / 7);
    if (diffWeek < 5) return `${diffWeek}w`;
    const diffMonth = Math.floor(diffDay / 30);
    if (diffMonth < 12) return `${diffMonth}mo`;
    const diffYear = Math.floor(diffDay / 365);
    return `${diffYear}y`;
  };

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
        className="absolute top-10 right-4 z-50 w-10 h-10 bg-black/40 backdrop-blur-sm border border-white/10 rounded-full flex items-center justify-center text-white hover:bg-black/60 transition-all shadow-lg"
      >
        {muted ? <BsVolumeMute size={18} /> : <BsVolumeUp size={18} />}
      </button>

      {/* Seekable Play Bar */}
      <div
        className="absolute bottom-0 left-0 right-0 z-50 px-0 pb-0 select-none"
        data-action-btn="true"
        style={{ touchAction: 'none', bottom: 'var(--playbar-gap)' }}
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
          style={{ height: isSeeking ? '16px' : 'var(--mobile-playbar-height)', paddingTop: 0, paddingBottom: 0 }}
          onMouseDown={handleSeekStart}
          onTouchStart={handleSeekStart}
          onClick={e => e.stopPropagation()}
        >
          {/* Track background — pinned to bottom so no gap below the track */}
          <div className="absolute left-0 right-0 rounded-full" style={{ height: isSeeking ? '4px' : '2px', bottom: 0, background: 'rgba(255,255,255,0.2)' }}>
            {/* Progress fill */}
            <div
              className="h-full rounded-full"
              style={{ width: `${progress}%`, background: 'linear-gradient(90deg, #FE2C55, #ff6b6b)', transition: isSeeking ? 'none' : 'width 0.1s linear' }}
            />
          </div>
          {/* Seek thumb - visible while seeking; top:6px centers it on the 4px track at bottom:0 inside a 16px container */}
          {isSeeking && (
            <div
              className="absolute w-4 h-4 rounded-full shadow-lg border-2 border-white pointer-events-none"
              style={{ left: `calc(${progress}% - 8px)`, top: '6px', background: '#FE2C55', boxShadow: '0 0 8px rgba(254,44,85,0.8)' }}
            />
          )}
        </div>
      </div>

      {/* Bottom info */}
      <div className="absolute left-0 right-0 p-4 pr-24 md:pr-4" style={{ bottom: 'var(--video-info-bottom-offset)', minHeight: 'var(--video-info-min-height)', background: 'linear-gradient(to top, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.6) 50%, transparent 100%)' }}>
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
      <div className="absolute right-2 md:bottom-16 flex flex-col items-center gap-4" style={{ bottom: 'var(--video-actions-bottom-offset)' }}>
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
              {commentsLoading && comments.length === 0 && <div className="text-center text-gray-400 py-4">Loading...</div>}
              {!commentsLoading && comments.length === 0 && (
                <div className="text-center text-gray-400 py-6">No comments yet. Be first!</div>
              )}

              {comments.map(cm => (
                <div
                  key={cm.id}
                  ref={(el) => { commentNodeRefs.current[cm.id] = el; }}
                  className="py-2"
                >
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-full overflow-hidden flex-shrink-0">
                      {cm.author?.avatar_url ? (
                        <img src={getThumbUrl(cm.author.avatar_url)} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <div
                          className="w-full h-full flex items-center justify-center text-[11px] font-bold text-white"
                          style={{ background: 'linear-gradient(135deg, #FE2C55, #ff8c00)' }}
                        >
                          {cm.author?.username?.[0]?.toUpperCase()}
                        </div>
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 text-[11px] text-gray-400">
                        <span className="font-semibold text-gray-300">@{cm.author?.username}</span>
                        <span>•</span>
                        <span>{timeAgo(cm.created_at)}</span>
                      </div>

                      <p className="mt-0.5 text-[14px] leading-[1.35] text-white break-words">{cm.content}</p>

                      {cm.image_url && (
                        <img src={getThumbUrl(cm.image_url)} alt="comment" className="mt-2 rounded-xl max-h-40 w-auto border border-white/10" />
                      )}

                      <div className="mt-1.5 flex items-center gap-4 text-[12px] text-gray-400">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (cm.my_reaction === 'like') removeReaction(cm.id);
                            else reactComment(cm.id, 'like');
                          }}
                          className={`hover:text-white ${cm.my_reaction ? 'text-white' : ''}`}
                        >
                          {cm.my_reaction ? `${reactionEmoji(cm.my_reaction)} ${cm.my_reaction}` : 'Like'}
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setReactionPickerFor(prev => prev === cm.id ? null : cm.id);
                          }}
                          className="hover:text-white"
                        >
                          React
                        </button>
                        {totalReactions(cm) > 0 && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              openReactionModal(cm.id);
                            }}
                            className="text-gray-300 hover:text-white inline-flex items-center gap-1"
                            title="See who reacted"
                          >
                            <span>{reactionSummaryEntries(cm.reaction_counts).slice(0, 3).map((entry) => reactionEmoji(entry.type)).join(' ')}</span>
                            <span>{totalReactions(cm)}</span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); startReply(cm); }}
                          className="hover:text-white"
                        >
                          Reply
                        </button>
                        {(cm.replies || []).length > 0 && (
                          <button
                            type="button"
                            onClick={() => setExpandedReplies(prev => ({ ...prev, [cm.id]: !(prev[cm.id] ?? false) }))}
                            className="hover:text-white"
                          >
                            {(expandedReplies[cm.id] ?? false)
                              ? 'Hide replies'
                              : `View ${(cm.replies || []).length} repl${(cm.replies || []).length === 1 ? 'y' : 'ies'}`}
                          </button>
                        )}
                        {canDelete(cm.author?.username) && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); deleteComment(cm.id, false); }}
                            className="text-red-400 hover:text-red-300 flex items-center gap-1"
                          >
                            <IoTrash size={12} /> Delete
                          </button>
                        )}
                      </div>

                      {reactionPickerFor === cm.id && (
                        <div className="mt-2 flex flex-wrap items-center gap-1 rounded-full bg-white/10 border border-white/10 px-2 py-1 w-fit">
                          {REACTION_OPTIONS.map((r) => (
                            <button
                              key={r.type}
                              type="button"
                              onClick={(e) => { e.stopPropagation(); reactComment(cm.id, r.type); }}
                              className="text-lg hover:scale-110 transition-transform"
                              title={r.label}
                            >
                              {r.emoji}
                            </button>
                          ))}
                          {cm.my_reaction && (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); removeReaction(cm.id); }}
                              className="ml-1 text-xs text-gray-300 hover:text-white"
                            >
                              Clear
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {(expandedReplies[cm.id] ?? false) && (
                    <div className="ml-11 mt-2 pl-3 border-l border-white/10 space-y-2.5">
                      {(cm.replies || []).slice(0, visibleReplies[cm.id] || 10).map((rp) => (
                        <div
                          key={rp.id}
                          ref={(el) => { commentNodeRefs.current[rp.id] = el; }}
                          className="flex items-start gap-2.5"
                        >
                          <div className="w-6 h-6 rounded-full overflow-hidden flex-shrink-0">
                            {rp.author?.avatar_url ? (
                              <img src={getThumbUrl(rp.author.avatar_url)} alt="" className="w-full h-full object-cover" />
                            ) : (
                              <div
                                className="w-full h-full flex items-center justify-center text-[9px] font-bold text-white"
                                style={{ background: 'linear-gradient(135deg, #6378ff, #8f66ff)' }}
                              >
                                {rp.author?.username?.[0]?.toUpperCase()}
                              </div>
                            )}
                          </div>

                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 text-[11px] text-gray-400">
                              <span className="font-semibold text-gray-300">@{rp.author?.username}</span>
                              <span>•</span>
                              <span>{timeAgo(rp.created_at)}</span>
                            </div>
                            <p className="mt-0.5 text-[13px] leading-[1.35] text-gray-100 break-words">{rp.content}</p>

                            {rp.image_url && (
                              <img src={getThumbUrl(rp.image_url)} alt="reply" className="mt-2 rounded-xl max-h-36 w-auto border border-white/10" />
                            )}

                            <div className="mt-1.5 flex items-center gap-4 text-[12px] text-gray-400">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (rp.my_reaction === 'like') removeReaction(rp.id);
                                  else reactComment(rp.id, 'like');
                                }}
                                className={`hover:text-white ${rp.my_reaction ? 'text-white' : ''}`}
                              >
                                {rp.my_reaction ? `${reactionEmoji(rp.my_reaction)} ${rp.my_reaction}` : 'Like'}
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setReactionPickerFor(prev => prev === rp.id ? null : rp.id);
                                }}
                                className="hover:text-white"
                              >
                                React
                              </button>
                              {totalReactions(rp) > 0 && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openReactionModal(rp.id);
                                  }}
                                  className="text-gray-300 hover:text-white inline-flex items-center gap-1"
                                  title="See who reacted"
                                >
                                  <span>{reactionSummaryEntries(rp.reaction_counts).slice(0, 3).map((entry) => reactionEmoji(entry.type)).join(' ')}</span>
                                  <span>{totalReactions(rp)}</span>
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); startReply(rp); }}
                                className="hover:text-white"
                              >
                                Reply
                              </button>
                              {canDelete(rp.author?.username) && (
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); deleteComment(rp.id, true, cm.id); }}
                                  className="text-red-400 hover:text-red-300 flex items-center gap-1"
                                >
                                  <IoTrash size={12} /> Delete
                                </button>
                              )}
                            </div>

                            {reactionPickerFor === rp.id && (
                              <div className="mt-2 flex flex-wrap items-center gap-1 rounded-full bg-white/10 border border-white/10 px-2 py-1 w-fit">
                                {REACTION_OPTIONS.map((r) => (
                                  <button
                                    key={r.type}
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); reactComment(rp.id, r.type); }}
                                    className="text-lg hover:scale-110 transition-transform"
                                    title={r.label}
                                  >
                                    {r.emoji}
                                  </button>
                                ))}
                                {rp.my_reaction && (
                                  <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); removeReaction(rp.id); }}
                                    className="ml-1 text-xs text-gray-300 hover:text-white"
                                  >
                                    Clear
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}

                    {!commentsLoading && hasMoreComments && (
                      <div className="pt-1 pb-2">
                        <button
                          type="button"
                          onClick={loadMoreComments}
                          disabled={loadingMoreComments}
                          className="w-full rounded-full py-2 text-sm font-semibold text-white/90 bg-white/10 hover:bg-white/15 disabled:opacity-60 transition-colors"
                        >
                          {loadingMoreComments ? 'Loading...' : 'Load more comments'}
                        </button>
                      </div>
                    )}
                    </div>
                  )}
                  {(expandedReplies[cm.id] ?? false) && (cm.replies || []).length === 0 && (
                    <div className="ml-11 mt-2 text-xs text-gray-500">No replies yet</div>
                  )}
                  {(expandedReplies[cm.id] ?? false) && (cm.replies || []).length > (visibleReplies[cm.id] || 10) && (
                    <button
                      type="button"
                      onClick={() => setVisibleReplies(prev => ({ ...prev, [cm.id]: (prev[cm.id] || 10) + 10 }))}
                      className="ml-11 mt-2 text-xs text-[#9ca7ff] hover:text-[#c1c8ff]"
                    >
                      {`See more +${(cm.replies || []).length - (visibleReplies[cm.id] || 10)}`}
                    </button>
                  )}
                </div>
              ))}
            </div>

            <form onSubmit={submitComment} className="px-3 md:px-4 py-3 border-t border-white/8">
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

      {reactionModalOpen && (
        <div
          className="absolute inset-0 z-[60] flex items-end md:items-center md:justify-center"
          style={{ background: 'rgba(0,0,0,0.62)', backdropFilter: 'blur(5px)' }}
          onClick={(e) => { e.stopPropagation(); closeReactionModal(); }}
        >
          <div
            className="w-full md:max-w-md rounded-t-3xl md:rounded-2xl max-h-[78vh] md:max-h-[70vh] flex flex-col"
            style={{ background: 'linear-gradient(180deg, #1f2133 0%, #151622 100%)', border: '1px solid rgba(255,255,255,0.12)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
              <span className="text-white font-bold">Reactions</span>
              <button
                type="button"
                onClick={closeReactionModal}
                className="text-gray-400 hover:text-white w-8 h-8 rounded-full flex items-center justify-center hover:bg-white/10 transition-colors"
              >
                <IoClose size={19} />
              </button>
            </div>

            <div className="px-3 py-2 border-b border-white/10 flex items-center gap-2 overflow-x-auto no-scrollbar">
              <button
                type="button"
                onClick={() => setReactionModalFilter('all')}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap ${reactionModalFilter === 'all' ? 'bg-white text-[#111]' : 'bg-white/10 text-gray-200 hover:bg-white/15'}`}
              >
                All {reactionModalReactors.length}
              </button>
              {reactionSummaryEntries(reactionModalSummary).map((entry) => (
                <button
                  key={entry.type}
                  type="button"
                  onClick={() => setReactionModalFilter(entry.type)}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap ${reactionModalFilter === entry.type ? 'bg-white text-[#111]' : 'bg-white/10 text-gray-200 hover:bg-white/15'}`}
                >
                  {reactionEmoji(entry.type)} {entry.count}
                </button>
              ))}
            </div>

            <div className="overflow-y-auto flex-1 px-3 py-2">
              {reactionModalLoading && (
                <div className="text-center text-gray-400 py-6">Loading reactions...</div>
              )}

              {!reactionModalLoading && reactionModalReactors.filter((r) => reactionModalFilter === 'all' ? true : r.type === reactionModalFilter).length === 0 && (
                <div className="text-center text-gray-400 py-6">No reactions found</div>
              )}

              {!reactionModalLoading && reactionModalReactors
                .filter((r) => reactionModalFilter === 'all' ? true : r.type === reactionModalFilter)
                .map((r) => (
                  <div key={`${r.user_id}-${r.type}-${r.created_at}`} className="flex items-center justify-between py-2.5 border-b border-white/5">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="w-8 h-8 rounded-full overflow-hidden flex-shrink-0">
                        {r.avatar_url ? (
                          <img src={getThumbUrl(r.avatar_url)} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-[11px] font-bold text-white" style={{ background: 'linear-gradient(135deg, #FE2C55, #ff8c00)' }}>
                            {(r.display_name || r.username || '?').charAt(0).toUpperCase()}
                          </div>
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm text-white font-semibold truncate">{r.display_name || r.username}</div>
                        <div className="text-xs text-gray-400 truncate">@{r.username}</div>
                      </div>
                    </div>
                    <div className="text-xl">{reactionEmoji(r.type)}</div>
                  </div>
                ))}
            </div>
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
