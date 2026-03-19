'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Cookies from 'js-cookie';
import toast from 'react-hot-toast';
import { api, getThumbUrl } from '@/lib/api';
import { decodeJwtPayload } from '@/lib/jwt';

interface Peer {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string;
}

interface DirectMessage {
  id: string;
  from_user_id: string;
  to_user_id: string;
  content: string;
  created_at: string;
}

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function InboxPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [mounted, setMounted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [peer, setPeer] = useState<Peer | null>(null);
  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement | null>(null);

  const withUsername = useMemo(() => {
    const raw = (searchParams.get('with') || '').trim();
    return raw.startsWith('@') ? raw.slice(1) : raw;
  }, [searchParams]);

  const myUserID = useMemo(() => {
    const token = Cookies.get('photcot_token');
    if (!token) return '';
    const payload = decodeJwtPayload(token);
    const id = payload?.user_id;
    return typeof id === 'string' ? id : '';
  }, [mounted]);

  const isLoggedIn = () => mounted && !!Cookies.get('photcot_token');

  const fetchConversation = useCallback(async () => {
    if (!mounted) return;
    if (!isLoggedIn()) {
      setLoading(false);
      return;
    }
    if (!withUsername) {
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const res = await api.get(`/messages/with/${encodeURIComponent(withUsername)}`);
      setPeer(res.data.peer || null);
      setMessages(res.data.messages || []);
    } catch (e: any) {
      const msg = e?.response?.data?.error || 'Could not load conversation';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [mounted, withUsername]);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!mounted) return;
    fetchConversation();
  }, [mounted, fetchConversation]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  const send = async () => {
    if (!peer) return;
    const content = draft.trim();
    if (!content) return;

    setSending(true);
    try {
      await api.post('/messages', { to_user_id: peer.id, content });
      const optimistic: DirectMessage = {
        id: `tmp-${Date.now()}`,
        from_user_id: myUserID,
        to_user_id: peer.id,
        content,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, optimistic]);
      setDraft('');
    } catch (e: any) {
      const msg = e?.response?.data?.error || 'Could not send message';
      toast.error(msg);
    } finally {
      setSending(false);
    }
  };

  if (!mounted) return null;

  if (!isLoggedIn()) {
    return (
      <div className="min-h-screen bg-[#161823] flex items-center justify-center p-6">
        <button onClick={() => router.push('/')} className="px-5 py-2 rounded-full bg-[#FE2C55] text-white font-semibold">
          Login to open inbox
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#161823] pb-20 md:pb-6 flex flex-col">
      <div className="max-w-2xl mx-auto w-full flex-1 flex flex-col">
        <div className="sticky top-0 z-10 bg-[#161823] border-b border-[#2D2F3E] p-4 flex items-center gap-3">
          <button onClick={() => router.back()} className="text-gray-400 hover:text-white">←</button>
          {peer ? (
            <>
              <div className="w-9 h-9 rounded-full bg-gray-700 overflow-hidden flex items-center justify-center text-white font-semibold text-xs">
                {peer.avatar_url
                  ? <img src={getThumbUrl(peer.avatar_url)} alt="" className="w-full h-full object-cover" />
                  : peer.username?.[0]?.toUpperCase() || '?'
                }
              </div>
              <div>
                <p className="text-white font-semibold text-sm">@{peer.username}</p>
                <p className="text-gray-400 text-xs">{peer.display_name || 'Direct message'}</p>
              </div>
            </>
          ) : (
            <p className="text-white font-semibold">Inbox</p>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {loading ? (
            <div className="flex justify-center py-12">
              <div className="w-8 h-8 border-2 border-[#FE2C55] border-t-transparent rounded-full animate-spin" />
            </div>
          ) : !withUsername ? (
            <div className="text-gray-400 text-sm text-center py-10">Open a message notification to start chatting.</div>
          ) : messages.length === 0 ? (
            <div className="text-gray-400 text-sm text-center py-10">No messages yet. Say hi!</div>
          ) : (
            messages.map((m) => {
              const mine = m.from_user_id === myUserID;
              return (
                <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[78%] rounded-2xl px-3 py-2 ${mine ? 'bg-[#FE2C55] text-white rounded-br-md' : 'bg-[#26283a] text-gray-100 rounded-bl-md'}`}>
                    <p className="text-sm whitespace-pre-wrap break-words">{m.content}</p>
                    <p className={`text-[10px] mt-1 ${mine ? 'text-pink-100' : 'text-gray-400'}`}>{formatTime(m.created_at)}</p>
                  </div>
                </div>
              );
            })
          )}
          <div ref={endRef} />
        </div>

        <div className="border-t border-[#2D2F3E] p-3 flex items-center gap-2 bg-[#161823]">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={peer ? `Message @${peer.username}...` : 'Select a conversation'}
            disabled={!peer || sending}
            className="flex-1 rounded-full px-4 py-2 text-sm text-white bg-white/10 border border-white/10 focus:outline-none"
          />
          <button
            onClick={send}
            disabled={!peer || sending || !draft.trim()}
            className="px-4 py-2 rounded-full text-white font-semibold disabled:opacity-50"
            style={{ background: 'linear-gradient(135deg, #FE2C55, #ff4070)' }}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
