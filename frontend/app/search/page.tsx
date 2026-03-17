'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api, getThumbUrl, getVideoUrl } from '@/lib/api';
import { useAuthStore } from '@/lib/store';
import { AiOutlineSearch, AiFillPlayCircle, AiFillHeart } from 'react-icons/ai';
import Cookies from 'js-cookie';

export default function SearchPage() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [followLoading, setFollowLoading] = useState<Record<string, boolean>>({});
  const [mounted, setMounted] = useState(false);
  const router = useRouter();
  const { user } = useAuthStore();

  useEffect(() => { setMounted(true); }, []);

  const isLoggedIn = () => mounted && !!Cookies.get('photcot_token');

  const search = async (query: string) => {
    if (!query.trim()) return;
    setLoading(true);
    try {
      const res = await api.get(`/search?q=${encodeURIComponent(query)}`);
      setResults(res.data);
    } catch { setResults(null); }
    finally { setLoading(false); }
  };

  const toggleFollow = async (targetUser: any) => {
    if (!isLoggedIn()) return;
    const uid = targetUser.id;
    setFollowLoading(prev => ({ ...prev, [uid]: true }));
    try {
      if (targetUser.is_following) {
        await api.delete(`/u/${uid}/follow`);
      } else {
        await api.post(`/u/${uid}/follow`);
      }
      // Update the result in-place
      setResults((prev: any) => {
        if (!prev?.users) return prev;
        return {
          ...prev,
          users: prev.users.map((u: any) =>
            u.id === uid
              ? {
                  ...u,
                  is_following: !u.is_following,
                  follower_count: u.follower_count + (u.is_following ? -1 : 1),
                }
              : u
          ),
        };
      });
    } catch (err) {
      console.error('Follow error', err);
    } finally {
      setFollowLoading(prev => ({ ...prev, [uid]: false }));
    }
  };

  const fmt = (n: number) =>
    n >= 1000000 ? (n / 1000000).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n || 0);

  const openVideo = (v: any) => {
    router.push(`/?v=${v.id}`);
  };

  return (
    <div className="min-h-screen bg-[#161823] p-4 pb-20 md:pb-4">
      <div className="max-w-2xl mx-auto">
        {/* Search bar */}
        <div className="flex gap-2 mb-6">
          <div className="flex-1 flex items-center gap-2 bg-[#1F2030] border border-[#2D2F3E] rounded-full px-4 py-2">
            <AiOutlineSearch className="text-gray-400" size={20} />
            <input
              type="text"
              placeholder="Search videos, users, hashtags..."
              value={q}
              onChange={e => setQ(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && search(q)}
              className="bg-transparent flex-1 text-white text-sm focus:outline-none"
            />
          </div>
          <button
            onClick={() => search(q)}
            className="bg-[#FE2C55] text-white px-4 py-2 rounded-full text-sm font-semibold"
          >
            Search
          </button>
        </div>

        {loading && <div className="text-center text-gray-400 py-10">Searching...</div>}

        {results && (
          <>
            {/* Users section */}
            {results.users?.length > 0 && (
              <section className="mb-6">
                <h2 className="text-white font-bold mb-3">Users</h2>
                <div className="flex flex-col gap-2">
                  {results.users.map((u: any) => {
                    const isSelf = user?.id === u.id;
                    return (
                      <div
                        key={u.id}
                        className="flex items-center gap-3 p-3 bg-[#1F2030] rounded-lg hover:bg-[#2D2F3E] transition-colors"
                      >
                        {/* Avatar - clickable to profile */}
                        <a href={`/@${u.username}`} className="shrink-0">
                          <div className="w-10 h-10 rounded-full bg-gray-600 flex items-center justify-center font-bold text-sm overflow-hidden">
                            {u.avatar_url
                              ? <img src={getThumbUrl(u.avatar_url)} className="w-full h-full object-cover" alt="" />
                              : u.username[0].toUpperCase()}
                          </div>
                        </a>

                        {/* Username + follower count */}
                        <a href={`/@${u.username}`} className="flex-1 min-w-0">
                          <p className="text-white font-semibold text-sm">@{u.username}</p>
                          <p className="text-gray-400 text-xs">{fmt(u.follower_count)} followers</p>
                        </a>

                        {/* Follow / Unfollow button */}
                        {isLoggedIn() && !isSelf && (
                          <button
                            onClick={() => toggleFollow(u)}
                            disabled={followLoading[u.id]}
                            className={`shrink-0 px-4 py-1.5 rounded-full text-xs font-bold transition-all disabled:opacity-50 ${
                              u.is_following
                                ? 'bg-transparent border border-gray-500 text-gray-300 hover:border-red-500 hover:text-red-400'
                                : 'bg-[#FE2C55] text-white hover:bg-[#e0193f]'
                            }`}
                          >
                            {followLoading[u.id]
                              ? '...'
                              : u.is_following
                              ? 'Following'
                              : 'Follow'}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Videos section */}
            {results.videos?.length > 0 && (
              <section>
                <h2 className="text-white font-bold mb-3">Videos</h2>
                <div className="grid grid-cols-2 gap-3">
                  {results.videos.map((v: any) => (
                    <div
                      key={v.id}
                      className="aspect-[9/16] bg-[#1F2030] rounded-xl overflow-hidden relative cursor-pointer group shadow-lg"
                      onClick={() => openVideo(v)}
                    >
                      {v.thumbnail_url ? (
                        <img
                          src={getThumbUrl(v.thumbnail_url)}
                          className="w-full h-full object-cover"
                          alt={v.title}
                        />
                      ) : (
                        <video
                          src={getVideoUrl(v.video_url)}
                          className="w-full h-full object-cover"
                          muted
                          preload="metadata"
                        />
                      )}
                      <div className="absolute inset-0 bg-black/20 group-hover:bg-black/50 transition-all flex items-center justify-center">
                        <AiFillPlayCircle
                          size={52}
                          className="text-white opacity-0 group-hover:opacity-90 transition-opacity drop-shadow-lg scale-90 group-hover:scale-100 transform duration-200"
                        />
                      </div>
                      <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/90 via-black/50 to-transparent">
                        <p className="text-white text-xs font-semibold line-clamp-1">{v.title}</p>
                        <div className="flex items-center justify-between mt-0.5">
                          <p className="text-gray-300 text-xs">@{v.author?.username}</p>
                          <div className="flex items-center gap-1 text-gray-300 text-xs">
                            <AiFillHeart size={10} className="text-[#FE2C55]" />
                            <span>{fmt(v.like_count || 0)}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {!results.users?.length && !results.videos?.length && (
              <div className="text-center text-gray-400 py-10">No results found</div>
            )}
          </>
        )}

        {!results && !loading && (
          <div className="text-center text-gray-400 py-16">
            <AiOutlineSearch size={48} className="mx-auto mb-3 opacity-40" />
            <p>Search for videos, creators, hashtags</p>
          </div>
        )}
      </div>
    </div>
  );
}
