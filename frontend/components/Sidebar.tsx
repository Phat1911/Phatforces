'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AiFillHome, AiOutlineHome, AiOutlineSearch, AiOutlinePlusSquare } from 'react-icons/ai';
import { BsPerson, BsPersonFill } from 'react-icons/bs';
import { MdOutlineExplore } from 'react-icons/md';
import Cookies from 'js-cookie';

interface Props { onAuthRequired: () => void; }

export default function Sidebar({ onAuthRequired }: Props) {
  const pathname = usePathname();
  const [loggedIn, setLoggedIn] = useState(false);

  useEffect(() => {
    setLoggedIn(!!Cookies.get('photcot_token'));
    const handler = () => setLoggedIn(!!Cookies.get('photcot_token'));
    window.addEventListener('photcot:auth-changed', handler);
    window.addEventListener('photcot:auth-expired', handler);
    return () => {
      window.removeEventListener('photcot:auth-changed', handler);
      window.removeEventListener('photcot:auth-expired', handler);
    };
  }, []);

  const handleProtected = (e: React.MouseEvent) => {
    if (!Cookies.get('photcot_token')) { e.preventDefault(); onAuthRequired(); }
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
      <NavItem href="/profile" icon={<BsPerson size={26}/>} activeIcon={<BsPersonFill size={26}/>} label="Profile" active={pathname === '/profile'} onClick={handleProtected} />

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

function NavItem({ href, icon, activeIcon, label, active, onClick }: {
  href: string; icon: React.ReactNode; activeIcon: React.ReactNode;
  label: string; active: boolean; onClick?: (e: React.MouseEvent) => void;
}) {
  return (
    <Link href={href} onClick={onClick}
      className={`flex items-center gap-3 px-2 py-3 rounded-lg transition-colors hover:bg-[#1F2030] ${active ? 'font-bold text-white bg-[#1F2030]' : 'text-gray-400'}`}>
      {active ? activeIcon : icon}
      <span className="text-base">{label}</span>
    </Link>
  );
}
