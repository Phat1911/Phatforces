'use client';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { api, getThumbUrl } from '@/lib/api';
import { AiOutlineBell, AiOutlineHeart, AiOutlineMessage, AiOutlineDelete } from 'react-icons/ai';
import { FiUserPlus, FiBookmark } from 'react-icons/fi';
import Cookies from 'js-cookie';

interface Notification {
  id: string;
  type: string;
  message: string;
  is_read: boolean;
  created_at: string;
  video_id: string | null;
  actor_username: string;
  actor_avatar: string;
  actor_display_name: string;
}

function typeIcon(type: string) {
  switch (type) {
    case 'like':    return <AiOutlineHeart className="text-[#FE2C55]" size={18} />;
    case 'comment': return <AiOutlineMessage className="text-blue-400" size={18} />;
    case 'follow':  return <FiUserPlus className="text-green-400" size={18} />;
    case 'save':    return <FiBookmark className="text-yellow-400" size={18} />;
    default:        return <AiOutlineBell className="text-gray-400" size={18} />;
  }
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

export default function NotificationsPage() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [mounted, setMounted] = useState(false);
  const router = useRouter();

  useEffect(() => { setMounted(true); }, []);

  const isLoggedIn = () => mounted && !!Cookies.get('photcot_token');

  const fetchNotifications = useCallback(async () => {
    if (!isLoggedIn()) { setLoading(false); return; }
    try {
      const res = await api.get('/notifications');
      setNotifications(res.data.notifications || []);
      setUnread(res.data.unread_count || 0);
    } catch { }
    finally { setLoading(false); }
  }, [mounted]);

  useEffect(() => {
    if (mounted) fetchNotifications();
  }, [mounted, fetchNotifications]);

  const markAllRead = async () => {
    try {
      await api.patch('/notifications/read');
      setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
      setUnread(0);
    } catch { }
  };

  const deleteNotif = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.delete(`/notifications/${id}`);
      setNotifications(prev => prev.filter(n => n.id !== id));
    } catch { }
  };

  const handleClick = async (notif: Notification) => {
    // Mark as read
    if (!notif.is_read) {
      await api.patch(`/notifications/${notif.id}/read`).catch(() => {});
      setNotifications(prev => prev.map(n => n.id === notif.id ? { ...n, is_read: true } : n));
      setUnread(prev => Math.max(0, prev - 1));
    }
    // Navigate
    if (notif.type === 'follow') {
      router.push(`/@${notif.actor_username}`);
    } else if (notif.video_id) {
      router.push(`/?v=${notif.video_id}`);
    }
  };

  if (!mounted) return null;

  if (!isLoggedIn()) {
    return (
      <div className="min-h-screen bg-[#161823] flex flex-col items-center justify-center gap-4 p-8">
        <AiOutlineBell size={48} className="text-gray-600" />
        <p className="text-white font-bold text-lg">Login to see notifications</p>
        <button onClick={() => router.push('/')} className="px-6 py-2 bg-[#FE2C55] text-white rounded-full font-semibold">
          Go to Home
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#161823] pb-20 md:pb-4">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[#2D2F3E] sticky top-0 bg-[#161823] z-10">
          <h1 className="text-white font-bold text-xl flex items-center gap-2">
            <AiOutlineBell size={22} />
            Notifications
            {unread > 0 && (
              <span className="bg-[#FE2C55] text-white text-xs font-bold px-2 py-0.5 rounded-full">{unread}</span>
            )}
          </h1>
          {unread > 0 && (
            <button onClick={markAllRead} className="text-[#FE2C55] text-sm font-semibold hover:text-[#e0193f] transition-colors">
              Mark all read
            </button>
          )}
        </div>

        {/* Content */}
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 border-2 border-[#FE2C55] border-t-transparent rounded-full animate-spin" />
          </div>
        ) : notifications.length === 0 ? (
          <div className="flex flex-col items-center py-20 gap-4">
            <AiOutlineBell size={52} className="text-gray-600" />
            <p className="text-gray-400 text-sm">No notifications yet</p>
            <p className="text-gray-600 text-xs">When people like, comment, or follow you - it shows up here</p>
          </div>
        ) : (
          <div className="divide-y divide-[#2D2F3E]">
            {notifications.map(notif => (
              <div
                key={notif.id}
                onClick={() => handleClick(notif)}
                className={`flex items-start gap-3 p-4 cursor-pointer hover:bg-[#1F2030] transition-colors group ${!notif.is_read ? 'bg-[#1a1b2e]' : ''}`}
              >
                {/* Actor avatar */}
                <div className="relative shrink-0">
                  <div className="w-10 h-10 rounded-full bg-gray-700 overflow-hidden flex items-center justify-center text-white font-bold text-sm">
                    {notif.actor_avatar
                      ? <img src={getThumbUrl(notif.actor_avatar)} className="w-full h-full object-cover" alt="" />
                      : notif.actor_username?.[0]?.toUpperCase() || '?'
                    }
                  </div>
                  {/* Type icon badge */}
                  <div className="absolute -bottom-1 -right-1 bg-[#161823] rounded-full p-0.5">
                    {typeIcon(notif.type)}
                  </div>
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <p className={`text-sm ${notif.is_read ? 'text-gray-300' : 'text-white font-medium'}`}>
                    {notif.message}
                  </p>
                  <p className="text-gray-500 text-xs mt-0.5">{timeAgo(notif.created_at)}</p>
                </div>

                {/* Unread dot + delete */}
                <div className="flex items-center gap-2 shrink-0">
                  {!notif.is_read && (
                    <div className="w-2 h-2 rounded-full bg-[#FE2C55]" />
                  )}
                  <button
                    onClick={(e) => deleteNotif(notif.id, e)}
                    className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-[#FE2C55] transition-all"
                  >
                    <AiOutlineDelete size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
