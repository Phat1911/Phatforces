'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AiFillHome, AiOutlineHome, AiOutlineSearch, AiOutlinePlusSquare } from 'react-icons/ai';
import { BsPerson, BsPersonFill } from 'react-icons/bs';
import { MdOutlineExplore } from 'react-icons/md';
import Cookies from 'js-cookie';

interface Props { onAuthRequired: () => void; }

export default function BottomNav({ onAuthRequired }: Props) {
  const pathname = usePathname();
  const handleProtected = (e: React.MouseEvent) => {
    if (!Cookies.get('photcot_token')) { e.preventDefault(); onAuthRequired(); }
  };
  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 z-30 flex justify-around items-center h-14 bg-[#161823] border-t border-[#2D2F3E]">
      <Link href="/" className={`flex flex-col items-center gap-0.5 ${pathname === '/' ? 'text-white' : 'text-gray-500'}`}>
        {pathname === '/' ? <AiFillHome size={24}/> : <AiOutlineHome size={24}/>}
        <span className="text-[10px]">Home</span>
      </Link>
      <Link href="/explore" className={`flex flex-col items-center gap-0.5 ${pathname === '/explore' ? 'text-white' : 'text-gray-500'}`}>
        <MdOutlineExplore size={24}/>
        <span className="text-[10px]">Explore</span>
      </Link>
      <Link href="/upload" onClick={handleProtected}
        className="flex items-center justify-center w-12 h-8 bg-[#FE2C55] rounded-lg text-white">
        <AiOutlinePlusSquare size={22}/>
      </Link>
      <Link href="/search" className={`flex flex-col items-center gap-0.5 ${pathname === '/search' ? 'text-white' : 'text-gray-500'}`}>
        <AiOutlineSearch size={24}/>
        <span className="text-[10px]">Search</span>
      </Link>
      <Link href="/profile" onClick={handleProtected}
        className={`flex flex-col items-center gap-0.5 ${pathname === '/profile' ? 'text-white' : 'text-gray-500'}`}>
        {pathname === '/profile' ? <BsPersonFill size={24}/> : <BsPerson size={24}/>}
        <span className="text-[10px]">Profile</span>
      </Link>
    </nav>
  );
}
