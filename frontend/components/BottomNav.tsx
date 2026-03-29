'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useEffect } from 'react';
import { AiFillHome, AiOutlineHome, AiOutlineSearch, AiOutlinePlusSquare, AiOutlineBell, AiFillBell } from 'react-icons/ai';
import { BsPerson, BsPersonFill } from 'react-icons/bs';
import { MdAdminPanelSettings } from 'react-icons/md';
import { api } from '@/lib/api';
import { decodeJwtPayload } from '@/lib/jwt';

interface Props { onAuthRequired: () => void; }

function getIsAdminFromToken(): boolean {
  if (typeof window === 'undefined') return false;
  const token = localStorage.getItem('photcot_token');
  if (!token) return false;
  const payload = decodeJwtPayload(token);
  if (!payload) return false;
  const claim = payload.is_admin;
  return claim === true || claim === 'true' || claim === 1;
}

export default function BottomNav({ onAuthRequired }: Props) {
  const pathname = usePathname();
  const [unread, setUnread] = useState(0);
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!mounted) return;
    const fetchUnread = async () => {
      try {
        const res = await api.get('/notifications/unread');
        setUnread(res.data.unread_count || 0);
      } catch { }
    };
    fetchUnread();
    const base = (api.defaults.baseURL || '').replace(/\/$/, '');
    let es: EventSource | null = null;
    // EventSource will automatically include HttpOnly cookie
    if (base.startsWith('http')) {
      const streamUrl = `${base}/notifications/stream`;
      es = new EventSource(streamUrl);
      es.addEventListener('notification', fetchUnread);
    }
    const interval = setInterval(fetchUnread, 30000);
    return () => {
      clearInterval(interval);
      es?.close();
    };
  }, [mounted]);

  const [loggedIn, setLoggedIn] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    const checkAuth = async () => {
      try {
        await api.get('/notifications/unread');
        setLoggedIn(true);
        setIsAdmin(getIsAdminFromToken());
      } catch (e) {
        if ((e as any)?.response?.status === 401) {
          setLoggedIn(false);
          setIsAdmin(false);
        }
      }
    };
    const onAuthExpired = () => {
      setLoggedIn(false);
      setIsAdmin(false);
    };
    checkAuth();
    window.addEventListener('photcot:auth-changed', checkAuth);
    window.addEventListener('photcot:auth-expired', onAuthExpired);
    return () => {
      window.removeEventListener('photcot:auth-changed', checkAuth);
      window.removeEventListener('photcot:auth-expired', onAuthExpired);
    };
  }, []);

  const handleProtected = (e: React.MouseEvent) => {
    if (!loggedIn) { e.preventDefault(); onAuthRequired(); }
  };

  return (
    <nav
      className="md:hidden fixed bottom-0 left-0 right-0 z-30 flex justify-around items-center bg-[#161823]"
      style={{ height: 'calc(56px + env(safe-area-inset-bottom))', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <Link href="/" className={`flex flex-col items-center gap-0.5 ${pathname === '/' ? 'text-white' : 'text-gray-500'}`}>
        {pathname === '/' ? <AiFillHome size={24}/> : <AiOutlineHome size={24}/>}
        <span className="text-[10px]">Home</span>
      </Link>
      <Link href="/search" className={`flex flex-col items-center gap-0.5 ${pathname === '/search' ? 'text-white' : 'text-gray-500'}`}>
        <AiOutlineSearch size={24}/>
        <span className="text-[10px]">Search</span>
      </Link>
      <Link href="/upload" onClick={handleProtected}
        className="flex items-center justify-center w-12 h-8 bg-[#FE2C55] rounded-lg text-white">
        <AiOutlinePlusSquare size={22}/>
      </Link>
      <Link href="/notifications" onClick={handleProtected}
        className={`flex flex-col items-center gap-0.5 relative ${pathname === '/notifications' ? 'text-white' : 'text-gray-500'}`}>
        {pathname === '/notifications' ? <AiFillBell size={24}/> : <AiOutlineBell size={24}/>}
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 bg-[#FE2C55] text-white text-[9px] font-bold w-4 h-4 rounded-full flex items-center justify-center">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
        <span className="text-[10px]">Nortification</span>
      </Link>
      <Link href="/profile" onClick={handleProtected}
        className={`flex flex-col items-center gap-0.5 ${pathname === '/profile' ? 'text-white' : 'text-gray-500'}`}>
        {pathname === '/profile' ? <BsPersonFill size={24}/> : <BsPerson size={24}/>}
        <span className="text-[10px]">Profile</span>
      </Link>
      {isAdmin && (
        <Link href="/admin" className={`flex flex-col items-center gap-0.5 ${pathname === '/admin' ? 'text-white' : 'text-gray-500'}`}>
          <MdAdminPanelSettings size={24}/>
          <span className="text-[10px]">Admin</span>
        </Link>
      )}
    </nav>
  );
}
