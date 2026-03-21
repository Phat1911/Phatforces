'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AiFillHome, AiOutlineHome, AiOutlineSearch, AiOutlinePlusSquare, AiOutlineBell, AiFillBell } from 'react-icons/ai';
import { BsPerson, BsPersonFill } from 'react-icons/bs';
import { MdOutlineExplore, MdAdminPanelSettings } from 'react-icons/md';
import { api } from '@/lib/api';
import { decodeJwtPayload } from '@/lib/jwt';

interface Props { onAuthRequired: () => void; }

export default function Sidebar({ onAuthRequired }: Props) {
  const pathname = usePathname();
  const [loggedIn, setLoggedIn] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    const checkAuth = async () => {
      try {
        // Try to fetch unread notifications to verify auth status
        await api.get('/notifications/unread');
        setLoggedIn(true);
        // Note: Can't decode token anymore since it's HttpOnly, but auth-exp event can set isAdmin if needed
      } catch (e) {
        // If 401, user is not logged in
        if ((e as any)?.response?.status === 401) {
          setLoggedIn(false);
          setIsAdmin(false);
          setUnread(0);
        }
      }
    };
    checkAuth();
    window.addEventListener('photcot:auth-changed', checkAuth);
    window.addEventListener('photcot:auth-expired', () => {
      setLoggedIn(false);
      setIsAdmin(false);
      setUnread(0);
    });
    return () => {
      window.removeEventListener('photcot:auth-changed', checkAuth);
      window.removeEventListener('photcot:auth-expired', () => {});
    };
  }, []);

  useEffect(() => {
    if (!loggedIn) return;
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
  }, [loggedIn]);

  const handleProtected = (e: React.MouseEvent) => {
    if (!loggedIn) { e.preventDefault(); onAuthRequired(); }
  };

  return (
    <aside className="hidden md:flex flex-col w-64 border-r border-[#2D2F3E] px-4 py-6 gap-1 shrink-0">
      <div className="mb-6 px-2">
        <span className="text-2xl font-black text-[#FE2C55]">Phatforces</span>
      </div>
      <NavItem href="/" icon={<AiOutlineHome size={26}/>} activeIcon={<AiFillHome size={26}/>} label="For You" active={pathname === '/'} />
      <NavItem href="/explore" icon={<MdOutlineExplore size={26}/>} activeIcon={<MdOutlineExplore size={26}/>} label="Explore" active={pathname === '/explore'} />
      <NavItem href="/search" icon={<AiOutlineSearch size={26}/>} activeIcon={<AiOutlineSearch size={26}/>} label="Search" active={pathname === '/search'} />
      <NavItem href="/upload" icon={<AiOutlinePlusSquare size={26}/>} activeIcon={<AiOutlinePlusSquare size={26}/>} label="Upload" active={pathname === '/upload'} onClick={handleProtected} />
      <NavItem
        href="/notifications"
        icon={<AiOutlineBell size={26}/>}
        activeIcon={<AiFillBell size={26}/>}
        label="Inbox"
        active={pathname === '/notifications'}
        onClick={handleProtected}
        badge={unread}
      />
      <NavItem href="/profile" icon={<BsPerson size={26}/>} activeIcon={<BsPersonFill size={26}/>} label="Profile" active={pathname === '/profile'} onClick={handleProtected} />
      {isAdmin && (
        <NavItem href="/admin" icon={<MdAdminPanelSettings size={26}/>} activeIcon={<MdAdminPanelSettings size={26}/>} label="Admin" active={pathname === '/admin'} />
      )}

      <div className="mt-auto pt-4 border-t border-[#2D2F3E]">
        {!loggedIn ? (
          <button
            onClick={onAuthRequired}
            className="w-full py-2 px-4 border-2 border-[#FE2C55] text-[#FE2C55] font-semibold rounded-full hover:bg-[#FE2C55] hover:text-white transition-colors text-sm"
          >
            Log in
          </button>
        ) : (
          <Link href="/profile" className="flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-[#1F2030] transition-colors">
            <div className="w-8 h-8 rounded-full bg-[#FE2C55] flex items-center justify-center text-white text-xs font-bold">ME</div>
            <span className="text-sm text-gray-300">My Profile</span>
          </Link>
        )}
      </div>
    </aside>
  );
}

function NavItem({ href, icon, activeIcon, label, active, onClick, badge }: {
  href: string; icon: React.ReactNode; activeIcon: React.ReactNode;
  label: string; active: boolean; onClick?: (e: React.MouseEvent) => void;
  badge?: number;
}) {
  return (
    <Link href={href} onClick={onClick}
      className={`flex items-center gap-3 px-2 py-3 rounded-lg transition-colors hover:bg-[#1F2030] ${active ? 'font-bold text-white bg-[#1F2030]' : 'text-gray-400'}`}>
      <div className="relative">
        {active ? activeIcon : icon}
        {badge != null && badge > 0 && (
          <span className="absolute -top-1.5 -right-1.5 bg-[#FE2C55] text-white text-[9px] font-bold w-4 h-4 rounded-full flex items-center justify-center">
            {badge > 9 ? '9+' : badge}
          </span>
        )}
      </div>
      <span className="text-base">{label}</span>
    </Link>
  );
}
