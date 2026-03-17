'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/lib/store';
import toast from 'react-hot-toast';
import Cookies from 'js-cookie';

interface Props { onClose: () => void; }

type RegisterStep = 'form' | 'otp';

export default function AuthModal({ onClose }: Props) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [registerStep, setRegisterStep] = useState<RegisterStep>('form');
  const [form, setForm] = useState({ username: '', email: '', password: '' });
  const [otpCode, setOtpCode] = useState('');
  const [loading, setLoading] = useState(false);
  const { setAuth } = useAuthStore();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await api.post('/auth/login', { email: form.email, password: form.password });
      const { token, user } = res.data;
      Cookies.set('photcot_token', token, { expires: 1 });
      setAuth(user, token);
      window.dispatchEvent(new CustomEvent('photcot:auth-changed'));
      toast.success(`Welcome back, @${user.username}!`);
      onClose();
      window.location.reload();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Invalid credentials';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  // Step 1: validate form and send OTP
  const handleSendOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.password.length < 6) {
      toast.error('Password must be at least 6 characters');
      return;
    }
    setLoading(true);
    try {
      await api.post('/auth/send-otp', { email: form.email });
      toast.success(`Verification code sent to ${form.email}`);
      setRegisterStep('otp');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed to send verification code';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  // Step 2: verify OTP then register
  const handleVerifyAndRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      // Verify the OTP first
      await api.post('/auth/verify-otp', { email: form.email, code: otpCode });
      // OTP verified - now register
      const res = await api.post('/auth/register', {
        username: form.username,
        email: form.email,
        password: form.password,
      });
      const { token, user } = res.data;
      Cookies.set('photcot_token', token, { expires: 1 });
      setAuth(user, token);
      window.dispatchEvent(new CustomEvent('photcot:auth-changed'));
      toast.success(`Welcome to Phatforces, @${user.username}!`);
      onClose();
      window.location.reload();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Verification failed';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const switchMode = (m: 'login' | 'register') => {
    setMode(m);
    setRegisterStep('form');
    setForm({ username: '', email: '', password: '' });
    setOtpCode('');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-[#1F2030] rounded-2xl p-8 w-full max-w-sm mx-4 border border-[#2D2F3E] shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="text-center mb-6">
          <h1 className="text-3xl font-black text-[#FE2C55] mb-1">Phatforces</h1>
          <p className="text-gray-400 text-sm">
            {mode === 'login' ? 'Log in to continue' : registerStep === 'form' ? 'Create your account' : 'Verify your email'}
          </p>
        </div>

        {mode === 'login' && (
          <form onSubmit={handleLogin} className="flex flex-col gap-3">
            <input type="email" placeholder="Email" value={form.email}
              onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
              className="bg-[#161823] border border-[#2D2F3E] rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-[#FE2C55] transition-colors"
              required />
            <input type="password" placeholder="Password" value={form.password}
              onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
              className="bg-[#161823] border border-[#2D2F3E] rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-[#FE2C55] transition-colors"
              required minLength={6} />
            <button type="submit" disabled={loading}
              className="bg-[#FE2C55] text-white font-bold py-3 rounded-xl hover:bg-[#e0193f] transition-colors disabled:opacity-50 mt-1 text-sm">
              {loading ? 'Logging in...' : 'Log In'}
            </button>
          </form>
        )}

        {mode === 'register' && registerStep === 'form' && (
          <form onSubmit={handleSendOTP} className="flex flex-col gap-3">
            <input type="text" placeholder="Username" value={form.username}
              onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
              className="bg-[#161823] border border-[#2D2F3E] rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-[#FE2C55] transition-colors"
              required minLength={3} maxLength={50} />
            <input type="email" placeholder="Email" value={form.email}
              onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
              className="bg-[#161823] border border-[#2D2F3E] rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-[#FE2C55] transition-colors"
              required />
            <input type="password" placeholder="Password (min 6 chars)" value={form.password}
              onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
              className="bg-[#161823] border border-[#2D2F3E] rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-[#FE2C55] transition-colors"
              required minLength={6} />
            <button type="submit" disabled={loading}
              className="bg-[#FE2C55] text-white font-bold py-3 rounded-xl hover:bg-[#e0193f] transition-colors disabled:opacity-50 mt-1 text-sm">
              {loading ? 'Sending code...' : 'Send Verification Code'}
            </button>
          </form>
        )}

        {mode === 'register' && registerStep === 'otp' && (
          <form onSubmit={handleVerifyAndRegister} className="flex flex-col gap-3">
            <p className="text-gray-400 text-sm text-center">
              We sent a 6-digit code to<br />
              <span className="text-white font-semibold">{form.email}</span>
            </p>
            <input type="text" placeholder="Enter 6-digit code" value={otpCode}
              onChange={e => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              className="bg-[#161823] border border-[#2D2F3E] rounded-xl px-4 py-3 text-white text-sm text-center tracking-[0.5em] text-lg focus:outline-none focus:border-[#FE2C55] transition-colors"
              required maxLength={6} minLength={6} autoFocus />
            <button type="submit" disabled={loading || otpCode.length !== 6}
              className="bg-[#FE2C55] text-white font-bold py-3 rounded-xl hover:bg-[#e0193f] transition-colors disabled:opacity-50 mt-1 text-sm">
              {loading ? 'Verifying...' : 'Verify & Create Account'}
            </button>
            <button type="button" onClick={() => { setRegisterStep('form'); setOtpCode(''); }}
              className="text-gray-400 text-sm hover:text-white transition-colors">
              Back
            </button>
          </form>
        )}

        <div className="text-center mt-5 text-sm text-gray-400">
          {mode === 'login' ? (
            <>Don&apos;t have an account?{' '}
              <button className="text-[#FE2C55] font-semibold hover:underline" onClick={() => switchMode('register')}>Sign up</button>
            </>
          ) : (
            <>Already have an account?{' '}
              <button className="text-[#FE2C55] font-semibold hover:underline" onClick={() => switchMode('login')}>Log in</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
