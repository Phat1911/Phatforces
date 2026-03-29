'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api, getThumbUrl } from '@/lib/api';
import { getAuthToken } from '@/lib/auth';
import toast from 'react-hot-toast';

export default function AdminPage() {
  const router = useRouter();
  const [stats, setStats] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [videos, setVideos] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<'stats' | 'users' | 'videos'>('stats');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [totalUsers, setTotalUsers] = useState(0);
  const [totalVideos, setTotalVideos] = useState(0);
  const [userPage, setUserPage] = useState(1);
  const [videoPage, setVideoPage] = useState(1);

  useEffect(() => {
    const token = getAuthToken();
    if (!token) { router.push('/'); return; }
    loadStats();
  }, [router]);

  const loadStats = async () => {
    try {
      const res = await api.get('/admin/stats');
      setStats(res.data);
    } catch (e: any) {
      if (e?.response?.status === 403) {
        toast.error('Admin access required');
        router.push('/');
      }
    }
  };

  const loadUsers = async (page = 1, q = '') => {
    setLoading(true);
    try {
      const res = await api.get(`/admin/users?page=${page}&q=${q}`);
      setUsers(res.data.users || []);
      setTotalUsers(res.data.total || 0);
      setUserPage(page);
    } catch { toast.error('Failed to load users'); }
    finally { setLoading(false); }
  };

  const loadVideos = async (page = 1, q = '') => {
    setLoading(true);
    try {
      const res = await api.get(`/admin/videos?page=${page}&q=${q}`);
      setVideos(res.data.videos || []);
      setTotalVideos(res.data.total || 0);
      setVideoPage(page);
    } catch { toast.error('Failed to load videos'); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    if (activeTab === 'users') loadUsers(1, search);
    if (activeTab === 'videos') loadVideos(1, search);
  }, [activeTab]);

  const deleteUser = async (id: string, username: string) => {
    if (!confirm(`Delete user @${username}? This is irreversible.`)) return;
    try {
      await api.delete(`/admin/users/${id}`);
      toast.success(`User @${username} deleted`);
      setUsers(prev => prev.filter(u => u.id !== id));
    } catch { toast.error('Delete failed'); }
  };

  const toggleAdmin = async (id: string, current: boolean, username: string) => {
    try {
      await api.patch(`/admin/users/${id}/role`, { is_admin: !current });
      toast.success(`@${username} admin role ${!current ? 'granted' : 'revoked'}`);
      setUsers(prev => prev.map(u => u.id === id ? { ...u, is_admin: !current } : u));
    } catch { toast.error('Update failed'); }
  };

  const deleteVideo = async (id: string, title: string) => {
    if (!confirm(`Delete "${title}"? This is irreversible.`)) return;
    try {
      await api.delete(`/admin/videos/${id}`);
      toast.success('Video deleted');
      setVideos(prev => prev.filter(v => v.id !== id));
    } catch { toast.error('Delete failed'); }
  };

  const togglePublish = async (id: string, current: boolean, title: string) => {
    try {
      await api.patch(`/admin/videos/${id}/publish`, { is_published: !current });
      toast.success(`"${title}" ${!current ? 'published' : 'unpublished'}`);
      setVideos(prev => prev.map(v => v.id === id ? { ...v, is_published: !current } : v));
    } catch { toast.error('Update failed'); }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (activeTab === 'users') loadUsers(1, search);
    if (activeTab === 'videos') loadVideos(1, search);
  };

  return (
    <div className="min-h-screen bg-[#161823] text-white pb-20 md:pb-4">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[#2D2F3E]">
          <div>
            <h1 className="text-xl font-bold text-white">Admin Panel</h1>
            <p className="text-xs text-gray-500">Phatforces Control Center</p>
          </div>
          <button onClick={() => router.push('/')} className="text-gray-400 text-sm hover:text-white px-3 py-1 rounded-full border border-[#2D2F3E]">
            Back to App
          </button>
        </div>

        {/* Tab Bar */}
        <div className="flex border-b border-[#2D2F3E]">
          {(['stats', 'users', 'videos'] as const).map(t => (
            <button key={t} onClick={() => setActiveTab(t)}
              className={`px-6 py-3 text-sm font-semibold capitalize transition-colors border-b-2 ${
                activeTab === t ? 'text-white border-[#FE2C55]' : 'text-gray-500 border-transparent hover:text-gray-300'
              }`}>
              {t === 'stats' ? '📊 Stats' : t === 'users' ? '👥 Users' : '🎬 Videos'}
            </button>
          ))}
        </div>

        <div className="p-4">
          {/* Stats Tab */}
          {activeTab === 'stats' && stats && (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {[
                { label: 'Total Users', value: stats.total_users, icon: '👥' },
                { label: 'Total Videos', value: stats.total_videos, icon: '🎬' },
                { label: 'Total Views', value: stats.total_views?.toLocaleString(), icon: '👁' },
                { label: 'Total Likes', value: stats.total_likes?.toLocaleString(), icon: '❤️' },
                { label: 'Total Comments', value: stats.total_comments?.toLocaleString(), icon: '💬' },
                { label: 'Total Shares', value: stats.total_shares?.toLocaleString(), icon: '🔗' },
              ].map(s => (
                <div key={s.label} className="bg-[#1F2030] rounded-2xl p-4 border border-[#2D2F3E]">
                  <p className="text-gray-400 text-xs mb-1">{s.icon} {s.label}</p>
                  <p className="text-white font-bold text-2xl">{s.value}</p>
                </div>
              ))}
            </div>
          )}

          {/* Users Tab */}
          {activeTab === 'users' && (
            <div>
              <form onSubmit={handleSearch} className="flex gap-2 mb-4">
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search by username, email..."
                  className="flex-1 bg-[#1F2030] text-white rounded-xl px-4 py-2 text-sm border border-[#2D2F3E] focus:outline-none focus:border-[#FE2C55]"
                />
                <button type="submit" className="bg-[#FE2C55] text-white px-4 py-2 rounded-xl text-sm font-semibold">Search</button>
              </form>
              <p className="text-gray-500 text-xs mb-3">{totalUsers} users found</p>
              <div className="space-y-2">
                {users.map(u => (
                  <div key={u.id} className="bg-[#1F2030] rounded-xl p-3 border border-[#2D2F3E] flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-[#FE2C55] flex items-center justify-center text-sm font-bold flex-shrink-0">
                      {u.avatar_url ? <img src={getThumbUrl(u.avatar_url)} className="w-full h-full rounded-full object-cover" alt=""/> : u.username[0]?.toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-white font-semibold text-sm">@{u.username}</p>
                        {u.is_admin && <span className="text-xs bg-yellow-500/20 text-yellow-400 px-2 py-0.5 rounded-full">Admin</span>}
                        {u.is_verified && <span className="text-xs bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded-full">Verified</span>}
                      </div>
                      <p className="text-gray-500 text-xs truncate">{u.email}</p>
                      <p className="text-gray-600 text-xs">{u.follower_count} followers · {u.total_likes} likes</p>
                    </div>
                    <div className="flex flex-col gap-1">
                      <button onClick={() => toggleAdmin(u.id, u.is_admin, u.username)}
                        className={`text-xs px-2 py-1 rounded-lg border ${u.is_admin ? 'border-yellow-500/40 text-yellow-400 hover:bg-yellow-500/10' : 'border-[#2D2F3E] text-gray-400 hover:border-blue-500 hover:text-blue-400'}`}>
                        {u.is_admin ? 'Revoke Admin' : 'Make Admin'}
                      </button>
                      <button onClick={() => deleteUser(u.id, u.username)}
                        className="text-xs px-2 py-1 rounded-lg border border-[#2D2F3E] text-red-400 hover:border-red-500 hover:bg-red-500/10">
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              {/* Pagination */}
              <div className="flex gap-2 mt-4 justify-center">
                {userPage > 1 && <button onClick={() => loadUsers(userPage - 1, search)} className="px-4 py-2 bg-[#1F2030] text-sm rounded-xl hover:bg-[#2D2F3E]">← Prev</button>}
                {users.length === 20 && <button onClick={() => loadUsers(userPage + 1, search)} className="px-4 py-2 bg-[#1F2030] text-sm rounded-xl hover:bg-[#2D2F3E]">Next →</button>}
              </div>
            </div>
          )}

          {/* Videos Tab */}
          {activeTab === 'videos' && (
            <div>
              <form onSubmit={handleSearch} className="flex gap-2 mb-4">
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search by title, username..."
                  className="flex-1 bg-[#1F2030] text-white rounded-xl px-4 py-2 text-sm border border-[#2D2F3E] focus:outline-none focus:border-[#FE2C55]"
                />
                <button type="submit" className="bg-[#FE2C55] text-white px-4 py-2 rounded-xl text-sm font-semibold">Search</button>
              </form>
              <p className="text-gray-500 text-xs mb-3">{totalVideos} videos found</p>
              <div className="space-y-2">
                {videos.map(v => (
                  <div key={v.id} className="bg-[#1F2030] rounded-xl p-3 border border-[#2D2F3E] flex items-center gap-3">
                    <div className="w-14 h-20 bg-[#2D2F3E] rounded-lg overflow-hidden flex-shrink-0">
                      {v.thumbnail_url
                        ? <img src={getThumbUrl(v.thumbnail_url)} className="w-full h-full object-cover" alt=""/>
                        : <div className="w-full h-full flex items-center justify-center text-xl">🎬</div>
                      }
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-white font-semibold text-sm truncate">{v.title}</p>
                      <p className="text-gray-500 text-xs">@{v.author?.username}</p>
                      <div className="flex gap-3 text-xs text-gray-500 mt-1">
                        <span>👁 {v.view_count}</span>
                        <span>❤️ {v.like_count}</span>
                        <span>💬 {v.comment_count}</span>
                        <span>🔗 {v.share_count}</span>
                      </div>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${v.is_published ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                        {v.is_published ? '● Published' : '● Unpublished'}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <button onClick={() => togglePublish(v.id, v.is_published, v.title)}
                        className={`text-xs px-2 py-1 rounded-lg border ${v.is_published ? 'border-orange-500/40 text-orange-400 hover:bg-orange-500/10' : 'border-green-500/40 text-green-400 hover:bg-green-500/10'}`}>
                        {v.is_published ? 'Unpublish' : 'Publish'}
                      </button>
                      <button onClick={() => deleteVideo(v.id, v.title)}
                        className="text-xs px-2 py-1 rounded-lg border border-[#2D2F3E] text-red-400 hover:border-red-500 hover:bg-red-500/10">
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              {/* Pagination */}
              <div className="flex gap-2 mt-4 justify-center">
                {videoPage > 1 && <button onClick={() => loadVideos(videoPage - 1, search)} className="px-4 py-2 bg-[#1F2030] text-sm rounded-xl hover:bg-[#2D2F3E]">← Prev</button>}
                {videos.length === 20 && <button onClick={() => loadVideos(videoPage + 1, search)} className="px-4 py-2 bg-[#1F2030] text-sm rounded-xl hover:bg-[#2D2F3E]">Next →</button>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
