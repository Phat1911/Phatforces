'use client';
import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api, getThumbUrl, getVideoUrl } from '@/lib/api';
import { User, Video } from '@/lib/store';
import Link from 'next/link';

export default function UserProfilePage() {
  const params = useParams();
  const router = useRouter();
  const rawUsername = params.username as string;
  // Strip leading @ if present
  const username = rawUsername?.startsWith('@') ? rawUsername.slice(1) : rawUsername;
  const [profile, setProfile] = useState<User | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!username) return;
    setLoading(true);
    api.get(`/users/${username}`)
      .then(r => {
        setProfile(r.data);
        return api.get(`/users/${r.data.id}/videos`);
      })
      .then(r => setVideos(r.data.videos || []))
      .catch(() => router.push('/'))
      .finally(() => setLoading(false));
  }, [username, router]);

  if (loading) return (
    <div className="min-h-screen bg-[#161823] flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-[#FE2C55] border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (!profile) return null;

  return (
    <div className="min-h-screen bg-[#161823] pb-20 md:pb-4">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center p-4 border-b border-[#2D2F3E]">
          <Link href="/" className="text-gray-400 mr-4">← Back</Link>
          <h1 className="text-white font-bold text-lg">@{profile.username}</h1>
        </div>
        <div className="flex flex-col items-center p-6 gap-4">
          <div className="w-20 h-20 rounded-full bg-gray-600 flex items-center justify-center text-2xl font-bold overflow-hidden">
            {profile.avatar_url
              ? <img src={getThumbUrl(profile.avatar_url)} className="w-full h-full object-cover" alt="" />
              : profile.username[0].toUpperCase()
            }
          </div>
          <h2 className="text-white font-bold text-xl">{profile.display_name || profile.username}</h2>
          {profile.bio && <p className="text-gray-400 text-sm text-center">{profile.bio}</p>}
          <div className="flex gap-8 text-center">
            <div><p className="text-white font-bold text-lg">{profile.following_count}</p><p className="text-gray-400 text-xs">Following</p></div>
            <div><p className="text-white font-bold text-lg">{profile.follower_count}</p><p className="text-gray-400 text-xs">Followers</p></div>
            <div><p className="text-white font-bold text-lg">{profile.total_likes}</p><p className="text-gray-400 text-xs">Likes</p></div>
          </div>
        </div>
        <div className="px-4">
          <h3 className="text-white font-bold mb-3">Videos</h3>
          {videos.length === 0
            ? <div className="text-center text-gray-400 py-10">No videos yet</div>
            : (
              <div className="grid grid-cols-3 gap-1">
                {videos.map((v) => (
                  <div key={v.id} className="aspect-[9/16] bg-[#1F2030] rounded-md overflow-hidden relative">
                    <video src={getVideoUrl(v.video_url)} className="w-full h-full object-cover" muted />
                    <div className="absolute bottom-1 left-1 text-white text-xs bg-black/60 px-1 rounded">{v.view_count} views</div>
                  </div>
                ))}
              </div>
            )
          }
        </div>
      </div>
    </div>
  );
}
