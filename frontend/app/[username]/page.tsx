'use client';
import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api, getThumbUrl, getVideoUrl } from '@/lib/api';
import { hasAuthToken } from '@/lib/auth';
import { User, Video } from '@/lib/store';
import Link from 'next/link';
import toast from 'react-hot-toast';
import { AiOutlineEye } from 'react-icons/ai';

export default function UserProfilePage() {
  const params = useParams();
  const router = useRouter();
  const rawUsername = params.username as string;
  const username = rawUsername?.startsWith('@') ? rawUsername.slice(1) : rawUsername;
  const [profile, setProfile] = useState<User | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [loading, setLoading] = useState(true);
  const [following, setFollowing] = useState(false);
  const [followLoading, setFollowLoading] = useState(false);
  const [messageText, setMessageText] = useState('');
  const [messageOpen, setMessageOpen] = useState(false);
  const [messageLoading, setMessageLoading] = useState(false);
  const [messagesEnabled, setMessagesEnabled] = useState(true);
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  const isLoggedIn = () => mounted && hasAuthToken();

  useEffect(() => {
    if (!username) return;
    setLoading(true);
    api.get(`/users/${username}`)
      .then(r => {
        setProfile(r.data);
        setFollowing(r.data.is_following || false);
        return Promise.all([
          api.get(`/u/${r.data.id}/videos`),
          api.get(`/creator/settings/${r.data.id}`).catch(() => ({ data: { messages_enabled: true } }))
        ]);
      })
      .then(([videosRes, settingsRes]) => {
        setVideos(videosRes.data.videos || []);
        setMessagesEnabled(settingsRes.data.messages_enabled !== false);
      })
      .catch(() => router.push('/'))
      .finally(() => setLoading(false));
  }, [username, router]);

  const toggleFollow = async () => {
    if (!isLoggedIn() || !profile) return;
    setFollowLoading(true);
    try {
      if (following) {
        await api.delete(`/u/${profile.id}/follow`);
        setFollowing(false);
        setProfile(prev => prev ? { ...prev, follower_count: Math.max(0, (prev.follower_count || 0) - 1) } : prev);
      } else {
        await api.post(`/u/${profile.id}/follow`);
        setFollowing(true);
        setProfile(prev => prev ? { ...prev, follower_count: (prev.follower_count || 0) + 1 } : prev);
      }
    } catch (err) {
      console.error('Follow error', err);
    } finally {
      setFollowLoading(false);
    }
  };

  const sendMessage = async () => {
    if (!isLoggedIn() || !profile) {
      toast.error('Please log in first');
      return;
    }
    const content = messageText.trim();
    if (!content) {
      toast.error('Type a message first');
      return;
    }

    setMessageLoading(true);
    try {
      await api.post('/messages', { to_user_id: profile.id, content });
      toast.success('Message sent');
      setMessageText('');
      setMessageOpen(false);
    } catch (e: any) {
      const msg = e?.response?.data?.error || 'Could not send message';
      toast.error(msg);
    } finally {
      setMessageLoading(false);
    }
  };

  const fmt = (n: number) =>
    n >= 1000000 ? (n / 1000000).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n || 0);

  if (loading) return (
    <div className="min-h-screen bg-[#161823] flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-[#FE2C55] border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (!profile) return null;

  return (
    <div className="min-h-screen bg-[#161823] pb-20 md:pb-4">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex items-center p-4 border-b border-[#2D2F3E]">
          <Link href="/" className="text-gray-400 mr-4 hover:text-white transition-colors">← Back</Link>
          <h1 className="text-white font-bold text-lg">@{profile.username}</h1>
        </div>

        {/* Profile info */}
        <div className="flex flex-col items-center p-6 gap-4">
          <div className="w-20 h-20 rounded-full bg-gray-600 flex items-center justify-center text-2xl font-bold overflow-hidden ring-2 ring-[#FE2C55]">
            {profile.avatar_url
              ? <img src={getThumbUrl(profile.avatar_url)} className="w-full h-full object-cover" alt="" />
              : <span className="text-white">{profile.username[0].toUpperCase()}</span>
            }
          </div>
          <div className="text-center">
            <h2 className="text-white font-bold text-xl">{profile.display_name || profile.username}</h2>
            {profile.bio && <p className="text-gray-400 text-sm mt-1">{profile.bio}</p>}
          </div>
          {/* Stats */}
          <div className="flex gap-8 text-center">
            <div><p className="text-white font-bold text-lg">{fmt(profile.following_count || 0)}</p><p className="text-gray-400 text-xs">Following</p></div>
            <div><p className="text-white font-bold text-lg">{fmt(profile.follower_count || 0)}</p><p className="text-gray-400 text-xs">Followers</p></div>
            <div><p className="text-white font-bold text-lg">{fmt(profile.total_likes || 0)}</p><p className="text-gray-400 text-xs">Likes</p></div>
          </div>

          {/* Follow + Message actions */}
          <div className="flex gap-2">
            {isLoggedIn() ? (
              <button
                onClick={toggleFollow}
                disabled={followLoading}
                className={`px-8 py-2 rounded-full text-sm font-bold transition-all disabled:opacity-50 ${
                  following
                    ? 'bg-transparent border border-gray-500 text-gray-300 hover:border-[#FE2C55] hover:text-[#FE2C55]'
                    : 'bg-[#FE2C55] text-white hover:bg-[#e0193f]'
                }`}
              >
                {followLoading ? '...' : following ? 'Following' : 'Follow'}
              </button>
            ) : (
              <Link href="/" className="px-8 py-2 rounded-full text-sm font-bold bg-[#FE2C55] text-white hover:bg-[#e0193f] transition-all">
                Follow
              </Link>
            )}

            <button
              onClick={() => {
                if (!isLoggedIn()) {
                  toast.error('Please log in first');
                  return;
                }
                if (!messagesEnabled) {
                  toast.error('Creator is not receiving messages');
                  return;
                }
                setMessageOpen(true);
              }}
              className={`px-6 py-2 rounded-full text-sm font-bold border transition-all ${
                messagesEnabled ? 'border-[#4d5bff] text-[#9ca7ff] hover:bg-[#4d5bff]/10' : 'border-gray-600 text-gray-500 cursor-not-allowed'
              }`}
            >
              Message
            </button>
          </div>

          {messageOpen && (
            <div className="w-full max-w-md mt-3 rounded-2xl border border-[#2D2F3E] bg-[#1F2030] p-3">
              <textarea
                value={messageText}
                onChange={(e) => setMessageText(e.target.value)}
                rows={3}
                placeholder={`Message @${profile.username}...`}
                className="w-full rounded-xl border border-[#2D2F3E] bg-[#161823] text-white text-sm p-3 focus:outline-none focus:border-[#4d5bff]"
              />
              <div className="flex justify-end gap-2 mt-2">
                <button
                  onClick={() => setMessageOpen(false)}
                  className="px-4 py-1.5 rounded-full text-xs font-semibold border border-gray-600 text-gray-300 hover:border-gray-400"
                >
                  Cancel
                </button>
                <button
                  onClick={sendMessage}
                  disabled={messageLoading}
                  className="px-4 py-1.5 rounded-full text-xs font-semibold bg-[#4d5bff] text-white hover:brightness-110 disabled:opacity-60"
                >
                  {messageLoading ? 'Sending...' : 'Send'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Videos grid */}
        <div className="px-4">
          <h3 className="text-white font-bold mb-3">Videos ({videos.length})</h3>
          {videos.length === 0
            ? <div className="text-center text-gray-400 py-10">No videos yet</div>
            : (
              <div className="grid grid-cols-3 gap-1">
                {videos.map((v) => (
                  <Link key={v.id} href={`/?v=${v.id}&u=${encodeURIComponent(profile.username)}`} className="aspect-[9/16] bg-[#1F2030] rounded-md overflow-hidden relative block">
                    {v.thumbnail_url
                      ? <img src={getThumbUrl(v.thumbnail_url)} className="w-full h-full object-cover" alt={v.title} />
                      : <video src={getVideoUrl(v.video_url)} className="w-full h-full object-cover" muted />
                    }
                    {v.is_watched && (
                      <div className="absolute top-1 left-1 bg-black/60 rounded-full p-1" title="Watched">
                        <AiOutlineEye className="text-white" size={14} />
                      </div>
                    )}
                    <div className="absolute bottom-0 left-0 right-0 p-1 bg-gradient-to-t from-black/80 to-transparent">
                      <p className="text-white text-xs line-clamp-1">{v.title}</p>
                    </div>
                  </Link>
                ))}
              </div>
            )
          }
        </div>
      </div>
    </div>
  );
}
