/**
 * /oauth/link?token=… — SAFE account linking confirmation (Phase 5).
 *
 * Reached when a Google/GitHub identity is new but an RX Store account with
 * the same VERIFIED provider email already exists. The provider identity is
 * NEVER attached silently: the user proves ownership of the existing account
 * with its PASSWORD, and only then does the identity attach + a normal
 * session issue.
 */
import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ShieldCheck, KeyRound } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import PasswordInput from '../components/common/PasswordInput';
import toast from 'react-hot-toast';

export default function OAuthLink() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { oauthLinkConfirm } = useAuth() as any;
  const token = searchParams.get('token') || '';
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) { toast.error('This linking request is missing its token. Please start again.'); return; }
    setBusy(true);
    try {
      const res = await oauthLinkConfirm(token, password);
      toast.success('Provider connected to your account ✓');
      navigate(res.redirect && String(res.redirect).startsWith('/') ? res.redirect : '/', { replace: true });
    } catch (e: any) {
      toast.error(e?.message || 'Could not confirm the linking. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center section-container py-12">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <Link to="/" className="inline-flex items-center gap-2.5 mb-4">
            <img src="/v1.png" alt="RX Store" className="w-14 h-14 rounded-xl object-cover" />
          </Link>
          <h1 className="text-xl font-bold text-white">An RX Store account already exists</h1>
          <p className="text-sm text-rx-gray-medium mt-2 max-w-sm mx-auto">
            You signed in with a provider whose verified email matches an existing RX Store account.
            To connect it, confirm the password of that account.
          </p>
        </div>
        <form onSubmit={confirm} className="card p-6 space-y-4">
          <div className="flex items-start gap-2.5 p-3 rounded-xl bg-rx-yellow/5 border border-rx-yellow/20">
            <ShieldCheck className="w-4 h-4 text-rx-yellow mt-0.5 flex-shrink-0" />
            <p className="text-[11px] leading-relaxed text-white/80">
              For your security the provider is only connected after you prove you own this account.
              This prevents a provider identity from taking over an account it did not create.
            </p>
          </div>
          <div>
            <label className="block text-sm text-rx-gray-medium mb-1.5">Account password</label>
            <PasswordInput
              leftIcon={<KeyRound className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-rx-gray-medium" />}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Your existing RX Store password"
              inputClassName="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl pl-11 py-3 text-white placeholder-rx-gray-medium focus:outline-none focus:border-rx-yellow/50 focus:ring-1 focus:ring-rx-yellow/25"
              required
              autoFocus
            />
          </div>
          <button type="submit" disabled={busy || !password} className="btn-primary w-full disabled:opacity-50">
            {busy ? 'Connecting…' : 'Confirm and connect'}
          </button>
          <p className="text-center text-xs text-rx-gray-medium">
            Don't want to connect?{' '}
            <Link to="/login" className="text-rx-yellow hover:underline">Sign in another way</Link>
          </p>
        </form>
      </div>
    </div>
  );
}
