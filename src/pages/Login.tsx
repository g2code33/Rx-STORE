import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Mail, Lock, User, ArrowRight, Github, Phone, KeyRound } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import toast from 'react-hot-toast';

export default function Login() {
  const [searchParams] = useSearchParams();
  const initialMode = searchParams.get('mode') === 'register' ? 'register' : 'login';
  const [mode, setMode] = useState<'login' | 'register'>(initialMode);
  const [formData, setFormData] = useState({ name: '', email: '', phone: '', password: '' });
  const [isLoading, setIsLoading] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);
  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const { login, register, forgotPassword, resetPassword } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      if (mode === 'login') {
        // email field can be email or phone — backend handles both via identifier
        await login(formData.email.trim(), formData.password);
        toast.success('Welcome back!');
        navigate('/');
      } else {
        if (!formData.name.trim()) { toast.error('Please enter your full name'); setIsLoading(false); return; }
        await register(formData.name, formData.email, formData.password, formData.phone || undefined);
        toast.success('Account created successfully!');
        navigate('/');
      }
    } catch (e: any) {
      toast.error(e.message || 'Authentication failed. Please check your credentials.');
    }
    setIsLoading(false);
  };

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    setForgotLoading(true);
    try {
      const res: any = await forgotPassword(forgotEmail.trim());
      if (res.resetToken) setResetToken(res.resetToken);
      toast.success('If that email exists, a reset link has been sent');
      if (res.resetToken) toast(`Demo token: ${res.resetToken.slice(0,8)}…`, { icon: '🔑' });
    } catch (e: any) { toast.error(e.message || 'Failed to send reset email'); }
    setForgotLoading(false);
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await resetPassword(resetToken, newPassword);
      toast.success('Password reset — please sign in');
      setForgotOpen(false); setResetToken(''); setNewPassword('');
    } catch (e: any) { toast.error(e.message || 'Reset failed'); }
  };

  return (
    <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center section-container py-12">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <Link to="/" className="inline-flex items-center gap-2.5 mb-6">
            <img src="/v1.png" alt="RX Store" className="w-16 h-16 rounded-xl object-cover" />
          </Link>
          <h1 className="text-2xl font-bold text-white">{mode === 'login' ? 'Welcome Back' : 'Create Account'}</h1>
          <p className="text-rx-gray-medium mt-2">
            {mode === 'login' ? 'Sign in with email or phone' : 'Join RX Store to discover and manage your applications'}
          </p>
        </div>

        <div className="card p-8">
          <form onSubmit={handleSubmit} className="space-y-5">
            {mode === 'register' && (
              <div>
                <label className="block text-sm font-medium text-rx-gray-medium mb-2">Full Name</label>
                <div className="relative">
                  <User className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-rx-gray-medium" />
                  <input type="text" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="Dr. John Smith" className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl pl-11 pr-4 py-3 text-white placeholder-rx-gray-medium focus:outline-none focus:border-rx-yellow/50 focus:ring-1 focus:ring-rx-yellow/25 transition-all" required />
                </div>
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-rx-gray-medium mb-2">{mode === 'login' ? 'Email or Phone' : 'Email Address'}</label>
              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-rx-gray-medium" />
                <input type={mode==='login' ? 'text' : 'email'} value={formData.email} onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  placeholder={mode==='login' ? 'you@healthcare.com or +233...' : 'you@healthcare.com'} className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl pl-11 pr-4 py-3 text-white placeholder-rx-gray-medium focus:outline-none focus:border-rx-yellow/50 focus:ring-1 focus:ring-rx-yellow/25 transition-all" required />
              </div>
            </div>
            {mode === 'register' && (
              <div>
                <label className="block text-sm font-medium text-rx-gray-medium mb-2">Phone <span className="text-rx-gray-medium/60 font-normal">(optional, for login)</span></label>
                <div className="relative">
                  <Phone className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-rx-gray-medium" />
                  <input type="tel" value={formData.phone} onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                    placeholder="+233 24 123 4567" className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl pl-11 pr-4 py-3 text-white placeholder-rx-gray-medium focus:outline-none focus:border-rx-yellow/50 focus:ring-1 focus:ring-rx-yellow/25 transition-all" />
                </div>
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-rx-gray-medium mb-2">Password</label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-rx-gray-medium" />
                <input type="password" value={formData.password} onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  placeholder="••••••••" className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl pl-11 pr-4 py-3 text-white placeholder-rx-gray-medium focus:outline-none focus:border-rx-yellow/50 focus:ring-1 focus:ring-rx-yellow/25 transition-all" required minLength={8} />
              </div>
            </div>
            {mode === 'login' && (
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" className="w-4 h-4 rounded border-white/20 bg-rx-dark-tertiary text-rx-yellow focus:ring-rx-yellow/25" />
                  <span className="text-sm text-rx-gray-medium">Remember me</span>
                </label>
                <button type="button" onClick={()=>setForgotOpen(true)} className="text-sm text-rx-yellow hover:underline">Forgot password?</button>
              </div>
            )}
            <button type="submit" disabled={isLoading} className="btn-primary w-full flex items-center justify-center gap-2">
              {isLoading ? (
                <div className="w-4 h-4 border-2 border-rx-dark/30 border-t-rx-dark rounded-full animate-spin" />
              ) : (
                <>{mode === 'login' ? 'Sign In' : 'Create Account'}<ArrowRight className="w-4 h-4" /></>
              )}
            </button>
          </form>

          {forgotOpen && (
            <div className="mt-6 p-4 rounded-xl bg-rx-dark-tertiary/50 border border-white/10">
              <h4 className="text-sm font-semibold text-white flex items-center gap-2"><KeyRound className="w-4 h-4"/> Reset via Email</h4>
              {!resetToken ? (
                <form onSubmit={handleForgot} className="mt-3 flex gap-2">
                  <input type="email" value={forgotEmail} onChange={e=>setForgotEmail(e.target.value)} placeholder="you@healthcare.com" className="flex-1 bg-rx-dark border border-white/10 rounded-xl px-3 py-2 text-sm text-white" required />
                  <button type="submit" disabled={forgotLoading} className="btn-primary text-sm px-4">{forgotLoading ? '…' : 'Send'}</button>
                  <button type="button" onClick={()=>setForgotOpen(false)} className="px-3 py-2 text-sm text-rx-gray-medium">Cancel</button>
                </form>
              ) : (
                <form onSubmit={handleReset} className="mt-3 space-y-2">
                  <p className="text-xs text-green-400">Token received (demo). Enter new password:</p>
                  <input type="text" value={resetToken} readOnly className="w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2 text-xs text-rx-gray-medium" />
                  <input type="password" value={newPassword} onChange={e=>setNewPassword(e.target.value)} placeholder="New password (8+ chars)" className="w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2 text-sm text-white" required minLength={8} />
                  <div className="flex gap-2">
                    <button type="submit" className="btn-primary text-sm flex-1">Reset Password</button>
                    <button type="button" onClick={()=>{setForgotOpen(false); setResetToken('');}} className="px-3 py-2 text-sm text-rx-gray-medium">Close</button>
                  </div>
                </form>
              )}
              {/* Human fallback — email the team and the admin sorts the reset manually */}
              <p className="mt-3 text-[11px] leading-relaxed text-rx-gray-medium">
                No reset email, or no longer have access to that inbox?{' '}
                <a
                  className="text-rx-yellow hover:underline font-medium"
                  href={`mailto:support@rxstore.com?subject=${encodeURIComponent('Password reset help — RX Store')}&body=${encodeURIComponent('Hi RX Store team,\n\nPlease reset the password for my account.\n\nMy account email: \nMy full name: \n\nThank you.')}`}
                >
                  Email support@rxstore.com
                </a>{' '}
                from your account email — an admin will sort it for you.
              </p>
            </div>
          )}

          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-white/10"></div></div>
            <div className="relative flex justify-center"><span className="px-3 text-xs text-rx-gray-medium bg-rx-dark-secondary">or continue with</span></div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <button className="flex items-center justify-center gap-2 px-4 py-3 bg-rx-dark-tertiary border border-white/10 rounded-xl text-sm text-rx-gray-medium hover:text-white hover:border-white/20 transition-all">
              <Github className="w-4 h-4" /> GitHub
            </button>
            <button className="flex items-center justify-center gap-2 px-4 py-3 bg-rx-dark-tertiary border border-white/10 rounded-xl text-sm text-rx-gray-medium hover:text-white hover:border-white/20 transition-all">
              <svg className="w-4 h-4" viewBox="0 0 24 24"><path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
              Google
            </button>
          </div>
        </div>

        <p className="text-center text-sm text-rx-gray-medium mt-6">
          {mode === 'login' ? "Don't have an account?" : 'Already have an account?'}
          <button onClick={() => setMode(mode === 'login' ? 'register' : 'login')} className="text-rx-yellow hover:underline ml-1 font-medium">
            {mode === 'login' ? 'Sign Up' : 'Sign In'}
          </button>
        </p>
      </div>
    </div>
  );
}
