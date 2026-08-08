import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Mail, Lock, User, ArrowRight, Github } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import toast from 'react-hot-toast';

export default function Login() {
  const [searchParams] = useSearchParams();
  const initialMode = searchParams.get('mode') === 'register' ? 'register' : 'login';
  const [mode, setMode] = useState<'login' | 'register'>(initialMode);
  const [formData, setFormData] = useState({ name: '', email: '', password: '' });
  const [isLoading, setIsLoading] = useState(false);
  const { login, register } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      if (mode === 'login') {
        await login(formData.email, formData.password);
        toast.success('Welcome back!');
        navigate('/');
      } else {
        if (!formData.name.trim()) { toast.error('Please enter your full name'); setIsLoading(false); return; }
        await register(formData.name, formData.email, formData.password);
        toast.success('Account created successfully!');
        navigate('/');
      }
    } catch (e: any) {
      toast.error(e.message || 'Authentication failed. Please check your credentials.');
    }
    setIsLoading(false);
  };

  return (
    <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center section-container py-12">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <Link to="/" className="inline-flex items-center gap-2.5 mb-6">
            <div className="w-12 h-12 bg-rx-yellow rounded-xl flex items-center justify-center font-bold text-rx-dark text-lg">Rx</div>
          </Link>
          <h1 className="text-2xl font-bold text-white">{mode === 'login' ? 'Welcome Back' : 'Create Account'}</h1>
          <p className="text-rx-gray-medium mt-2">
            {mode === 'login' ? 'Sign in to access your applications and subscriptions' : 'Join RX Store to discover and manage your applications'}
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
              <label className="block text-sm font-medium text-rx-gray-medium mb-2">Email Address</label>
              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-rx-gray-medium" />
                <input type="email" value={formData.email} onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  placeholder="you@healthcare.com" className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl pl-11 pr-4 py-3 text-white placeholder-rx-gray-medium focus:outline-none focus:border-rx-yellow/50 focus:ring-1 focus:ring-rx-yellow/25 transition-all" required />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-rx-gray-medium mb-2">Password</label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-rx-gray-medium" />
                <input type="password" value={formData.password} onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  placeholder="••••••••" className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl pl-11 pr-4 py-3 text-white placeholder-rx-gray-medium focus:outline-none focus:border-rx-yellow/50 focus:ring-1 focus:ring-rx-yellow/25 transition-all" required minLength={6} />
              </div>
            </div>
            {mode === 'login' && (
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" className="w-4 h-4 rounded border-white/20 bg-rx-dark-tertiary text-rx-yellow focus:ring-rx-yellow/25" />
                  <span className="text-sm text-rx-gray-medium">Remember me</span>
                </label>
                <a href="#" className="text-sm text-rx-yellow hover:underline">Forgot password?</a>
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
