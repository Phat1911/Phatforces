'use client';
import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import toast from 'react-hot-toast';
import { AiOutlineCloudUpload } from 'react-icons/ai';

export default function UploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string>('');
  const [form, setForm] = useState({ title: '', description: '', hashtags: '' });
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  // Auth guard - use API probe instead of reading HttpOnly cookie
  useEffect(() => {
    api.get('/notifications/unread').catch(() => {
      router.push('/');
    });
  }, [router]);

  // Cleanup object URL on unmount
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  const handleFile = (f: File) => {
    if (!f.type.startsWith('video/')) { toast.error('Please select a video file'); return; }
    if (f.size > 500 * 1024 * 1024) { toast.error('File too large (max 500MB)'); return; }
    if (preview) URL.revokeObjectURL(preview);
    setFile(f);
    setPreview(URL.createObjectURL(f));
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) { toast.error('Please select a video'); return; }
    setLoading(true);
    setProgress(0);
    const formData = new FormData();
    formData.append('video', file);
    formData.append('title', form.title);
    formData.append('description', form.description);
    formData.append('hashtags', form.hashtags);
    try {
      await api.post('/videos', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (e) => setProgress(Math.round((e.loaded * 100) / (e.total || 1))),
      });
      toast.success('Video uploaded successfully!');
      router.push('/');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Upload failed';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#161823] p-6">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl font-bold text-white mb-6">Upload Video</h1>
        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          <div
            onClick={() => fileRef.current?.click()}
            onDrop={handleDrop}
            onDragOver={e => e.preventDefault()}
            className="border-2 border-dashed border-[#2D2F3E] rounded-xl p-10 text-center cursor-pointer hover:border-[#FE2C55] transition-colors"
          >
            {preview ? (
              <video src={preview} className="max-h-64 mx-auto rounded-lg" controls />
            ) : (
              <div className="flex flex-col items-center gap-3 text-gray-400">
                <AiOutlineCloudUpload size={48} />
                <p className="font-semibold">Drop video here or click to upload</p>
                <p className="text-sm">MP4, WebM, MOV up to 500MB</p>
              </div>
            )}
            <input ref={fileRef} type="file" accept="video/*" className="hidden" onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])} />
          </div>
          {file && (
            <>
              <input type="text" placeholder="Title" value={form.title}
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                className="bg-[#1F2030] border border-[#2D2F3E] rounded-lg px-4 py-3 text-white text-sm focus:outline-none focus:border-[#FE2C55]" />
              <textarea placeholder="Description" value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                rows={3} className="bg-[#1F2030] border border-[#2D2F3E] rounded-lg px-4 py-3 text-white text-sm focus:outline-none focus:border-[#FE2C55] resize-none" />
              <input type="text" placeholder="Hashtags (comma separated)" value={form.hashtags}
                onChange={e => setForm(f => ({ ...f, hashtags: e.target.value }))}
                className="bg-[#1F2030] border border-[#2D2F3E] rounded-lg px-4 py-3 text-white text-sm focus:outline-none focus:border-[#FE2C55]" />
              {loading && (
                <div className="w-full bg-[#2D2F3E] rounded-full h-2">
                  <div className="bg-[#FE2C55] h-2 rounded-full transition-all" style={{ width: `${progress}%` }} />
                </div>
              )}
              <button type="submit" disabled={loading}
                className="bg-[#FE2C55] text-white font-bold py-3 rounded-lg hover:bg-[#e0193f] transition-colors disabled:opacity-50">
                {loading ? `Uploading... ${progress}%` : 'Post Video'}
              </button>
            </>
          )}
        </form>
      </div>
    </div>
  );
}
