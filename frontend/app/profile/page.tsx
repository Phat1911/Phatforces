'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api, getThumbUrl, getVideoUrl } from '@/lib/api';
import { useAuthStore } from '@/lib/store';
import Cookies from 'js-cookie';
import toast from 'react-hot-toast';

export default function ProfilePage() {
  const { user, setAuth, clearAuth } = useAuthStore();
  const [profile, setProfile] = useState<any>(null);
  const [videos, setVideos] = useState<any[]>([]);
  const [savedVideos, setSavedVideos] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<'videos'|'saved'>('videos');
  const [stats, setStats] = useState<any>(null);
  const router = useRouter();

  useEffect(() => {
    const token = Cookies.get('photcot_token');
    if (!token) { router.push('/'); return; }

    const loadProfile = async () => {
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        const username = payload.username;
        const userId = payload.user_id;

        const [profileRes, videosRes, statsRes, savedRes] = await Promise.all([
          api.get(`/users/${username}`),
          api.get(`/u/${userId}/videos`),
          api.get('/monetization/stats'),
          api.get('/videos/saved').catch(() => ({ data: { videos: [] } })),
        ]);

        setProfile(profileRes.data);
        setVideos(videosRes.data.videos || []);
        setSavedVideos(savedRes.data.videos || []);
        setStats(statsRes.data);

        if (!user) setAuth(profileRes.data, token);
      } catch {
        router.push('/');
      }
    };
    loadProfile();
  }, [router, user, setAuth]);

  const handleLogout = () => {
    Cookies.remove('photcot_token');
    clearAuth();
    window.dispatchEvent(new CustomEvent('photcot:auth-changed'));
    toast.success('Logged out');
    router.push('/');
    window.location.reload();
  };

  if (!profile) return (
    <div className="min-h-screen bg-[#161823] flex items-center justify-center">
      <div className="w-10 h-10 border-2 border-[#FE2C55] border-t-transparent rounded-full animate-spin"/>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#161823] pb-20 md:pb-4">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between p-4 border-b border-[#2D2F3E]">
          <h1 className="text-white font-bold text-lg">@{profile.username}</h1>
          <button onClick={handleLogout} className="text-gray-400 text-sm hover:text-white transition-colors px-3 py-1 rounded-full border border-[#2D2F3E] hover:border-white">
            Log out
          </button>
        </div>

        <div className="flex flex-col items-center p-6 gap-4">
          <div className="w-24 h-24 rounded-full bg-[#FE2C55] flex items-center justify-center text-3xl font-black text-white overflow-hidden">
            {profile.avatar_url
              ? <img src={getThumbUrl(profile.avatar_url)} className="w-full h-full object-cover" alt=""/>
              : profile.username[0].toUpperCase()
            }
          </div>
          <div className="text-center">
            <h2 className="text-white font-bold text-xl">{profile.display_name || profile.username}</h2>
            {profile.bio && <p className="text-gray-400 text-sm mt-1 max-w-xs">{profile.bio}</p>}
          </div>
          <div className="flex gap-10 text-center">
            <div><p className="text-white font-bold text-xl">{profile.following_count}</p><p className="text-gray-400 text-xs">Following</p></div>
            <div><p className="text-white font-bold text-xl">{profile.follower_count}</p><p className="text-gray-400 text-xs">Followers</p></div>
            <div><p className="text-white font-bold text-xl">{profile.total_likes}</p><p className="text-gray-400 text-xs">Likes</p></div>
          </div>
        </div>

        {stats && (
          <div className="mx-4 mb-4 p-4 bg-[#1F2030] rounded-2xl border border-[#2D2F3E]">
            <h3 className="text-white font-bold mb-3 text-sm uppercase tracking-wide">Creator Dashboard</h3>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="bg-[#161823] rounded-xl p-3">
                <p className="text-gray-400 text-xs mb-1">Total Views</p>
                <p className="text-white font-bold text-lg">{stats.total_views?.toLocaleString()}</p>
              </div>
              <div className="bg-[#161823] rounded-xl p-3">
                <p className="text-gray-400 text-xs mb-1">Estimated Earnings</p>
                <p className="text-[#FE2C55] font-bold text-lg">${stats.estimated_usd?.toFixed(2)}</p>
              </div>
              <div className="bg-[#161823] rounded-xl p-3">
                <p className="text-gray-400 text-xs mb-1">Coins</p>
                <p className="text-yellow-400 font-bold text-lg">{stats.coins?.toFixed(0)} 🪙</p>
              </div>
              <div className="bg-[#161823] rounded-xl p-3">
                <p className="text-gray-400 text-xs mb-1">Videos</p>
                <p className="text-white font-bold text-lg">{stats.video_count}</p>
              </div>
            </div>
            <p className="text-gray-600 text-xs mt-2">{stats.monetization_rate}</p>
          </div>
        )}

        <div className="px-4">
          {/* Tab Bar */}
          <div className="flex border-b border-[#2D2F3E] mb-4">
            <button onClick={() => setActiveTab('videos')}
              className={"flex-1 py-2 text-sm font-semibold transition-colors border-b-2 " + (activeTab === 'videos' ? 'text-white border-[#FE2C55]' : 'text-gray-500 border-transparent hover:text-gray-300')}>
              Videos ({videos.length})
            </button>
            <button onClick={() => setActiveTab('saved')}
              className={"flex-1 py-2 text-sm font-semibold transition-colors border-b-2 " + (activeTab === 'saved' ? 'text-white border-[#FE2C55]' : 'text-gray-500 border-transparent hover:text-gray-300')}>
              Saved ({savedVideos.length})
            </button>
          </div>

          {/* Tab Content */}
          {activeTab === 'videos' && (
            videos.length === 0
              ? <div className="text-center text-gray-400 py-10"><p className="text-4xl mb-2"></p><p>No videos yet</p></div>
              : <div className="grid grid-cols-3 gap-1">{videos.map((v: any) => (
                  <div key={v.id} className="aspect-[9/16] bg-[#1F2030] rounded-md overflow-hidden relative">
                    {v.thumbnail_url ? <img src={getThumbUrl(v.thumbnail_url)} className="w-full h-full object-cover" alt=""/> : <div className="w-full h-full flex items-center justify-center"><span className="text-2xl"></span></div>}
                    <div className="absolute bottom-1 left-1 text-white text-xs bg-black/70 px-1 rounded"> {v.view_count}</div>
                  </div>
                ))}</div>
          )}
          {activeTab === 'saved' && (
            savedVideos.length === 0
              ? <div className="text-center text-gray-400 py-10"><p className="text-4xl mb-2"></p><p>No saved videos</p></div>
              : <div className="grid grid-cols-3 gap-1">{savedVideos.map((v: any) => (
                  <div key={v.id} className="aspect-[9/16] bg-[#1F2030] rounded-md overflow-hidden relative">
                    {v.thumbnail_url ? <img src={getThumbUrl(v.thumbnail_url)} className="w-full h-full object-cover" alt=""/> : <div className="w-full h-full flex items-center justify-center"><span className="text-2xl"></span></div>}
                    <div className="absolute bottom-1 left-1 text-white text-xs bg-black/70 px-1 rounded"> {v.view_count}</div>
                  </div>
                ))}</div>
          )}
        </div>
      </div>
    </div>
  );
}
