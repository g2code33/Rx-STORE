/**
 * /oauth/callback — the OAuth completion page (web + PWA + Electron).
 *
 * The backend redirected here with a ONE-TIME completion code:
 *   /oauth/callback?status=<state>&code=<one-time>
 * This page exchanges the code for a NORMAL session (the exact same response
 * shape as password login) and renders friendly states — raw provider errors
 * never reach the user (Phase 16).
 *
 * It also offers a one-time SIGN-IN CODE for native shells: after signing in
 * here, the code can be typed into the Android/desktop app's login screen
 * (Google blocks OAuth inside embedded WebViews, so native shells complete
 * sign-in via the web and carry the session over with the code).
 */
import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api, isApiConfigured } from '../services/api';
import { safeRedirectTarget } from '../utils/profileTabs';

type Phase = 'working' | 'done' | 'error';

const STATUS_COPY: Record<string, { title: string; body: string; tone: 'ok' | 'warn' | 'error' }> = {
  login: { title: 'Welcome back', body: 'You are signed in with your RX Store account.', tone: 'ok' },
  new: { title: 'Account created', body: 'Your RX Store account is ready — welcome!', tone: 'ok' },
  linked: { title: 'Provider connected', body: 'The provider was connected to your RX Store account.', tone: 'ok' },
  already_linked: { title: 'Already connected', body: 'That provider was already connected to your account.', tone: 'warn' },
  cancelled: { title: 'Sign-in cancelled', body: 'You cancelled the provider sign-in. Nothing was changed.', tone: 'warn' },
  provider_validation: { title: 'Provider verification failed', body: 'We could not verify the sign-in with the provider. Please try again.', tone: 'error' },
  invalid_state: { title: 'Sign-in expired', body: 'That sign-in attempt expired or was already used. Please start again.', tone: 'error' },
  invalid_callback: { title: 'Invalid callback', body: 'The sign-in link was malformed. Please start again.', tone: 'error' },
  provider_linked_elsewhere: { title: 'Already in use', body: 'That provider account is connected to a different RX Store account.', tone: 'error' },
  account_missing: { title: 'Account unavailable', body: 'The associated account no longer exists. Please contact support.', tone: 'error' },
  registration_closed: { title: 'Registration closed', body: 'New account registration is currently disabled on this deployment.', tone: 'error' },
  unknown_provider: { title: 'Unknown provider', body: 'That sign-in provider is not supported.', tone: 'error' },
  code_invalid: { title: 'Code invalid', body: 'That sign-in code is invalid or has expired.', tone: 'error' },
};

export default function OAuthCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { completeOAuth, user } = useAuth();
  const [phase, setPhase] = useState<Phase>('working');
  const [statusKey, setStatusKey] = useState('login');
  const [errorDetail, setErrorDetail] = useState('');
  const [pairing, setPairing] = useState<{ code: string } | null>(null);
  const [pairingOpen, setPairingOpen] = useState(false);
  const ran = useRef(false);

  const status = searchParams.get('status') || 'error';
  const code = searchParams.get('code') || '';
  const reason = searchParams.get('reason') || '';

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    (async () => {
      // Provider-side failure / cancellation states: no code to exchange.
      if (!code) {
        setStatusKey(status || 'cancelled');
        setPhase(status === 'cancelled' || status === 'already_linked' ? 'done' : 'error');
        return;
      }
      if (!isApiConfigured()) {
        setStatusKey('code_invalid');
        setErrorDetail('RX Store cannot reach the account service.');
        setPhase('error');
        return;
      }
      try {
        const res = await completeOAuth(code);
        setStatusKey(res.status || 'login');
        setPhase('done');
        // Return to the intended in-app destination (validated server-side).
        const dest = safeRedirectTarget(res.redirect) || '/';
        const t = setTimeout(() => navigate(dest, { replace: true }), 900);
        return () => clearTimeout(t);
      } catch (e: any) {
        setStatusKey('code_invalid');
        setErrorDetail(e?.message || 'The sign-in code could not be exchanged.');
        setPhase('error');
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const copy = STATUS_COPY[statusKey] || STATUS_COPY.invalid_callback;

  const requestPairingCode = async () => {
    try {
      const res = await api.auth.oauthPairingCode();
      setPairing({ code: res.code });
      setPairingOpen(true);
    } catch { /* honest: the button simply shows nothing new */ }
  };

  return (
    <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center section-container py-12">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <Link to="/" className="inline-flex items-center gap-2.5 mb-4">
            <img src="/v1.png" alt="RX Store" className="w-14 h-14 rounded-xl object-cover" />
          </Link>
          <h1 className="text-xl font-bold text-white">{copy.title}</h1>
        </div>
        <div className={`card p-6 text-center ${phase === 'working' ? 'animate-pulse' : ''}`}>
          {phase === 'working' && (
            <p className="text-sm text-rx-gray-medium">Completing your sign-in…</p>
          )}
          {phase !== 'working' && (
            <>
              <p className={`text-sm ${copy.tone === 'ok' ? 'text-green-300' : copy.tone === 'warn' ? 'text-amber-200' : 'text-red-300'}`}>
                {copy.body}
              </p>
              {errorDetail && <p className="text-xs text-rx-gray-medium mt-2">{errorDetail}</p>}
              {reason && phase === 'error' && <p className="text-[11px] text-rx-gray-medium/70 mt-1">Reference: {reason}</p>}
              <div className="mt-5 flex flex-wrap gap-2 justify-center">
                <Link to="/" className="btn-primary text-sm">Go to RX Store</Link>
                <Link to="/login" className="btn-secondary text-sm">Back to sign in</Link>
              </div>
            </>
          )}
        </div>

        {/* Sign in on another device (native shells) — one-time code */}
        {phase === 'done' && user && (
          <div className="card p-4 mt-4">
            <button
              type="button"
              onClick={() => (pairing ? setPairingOpen((v) => !v) : requestPairingCode())}
              className="w-full text-left text-xs text-rx-gray-medium hover:text-white transition-colors"
            >
              Using the Android or desktop app? Get a one-time sign-in code →
            </button>
            {pairingOpen && pairing && (
              <div className="mt-3 p-3 bg-rx-dark-tertiary border border-white/10 rounded-xl text-center">
                <p className="text-[11px] text-rx-gray-medium mb-1.5">
                  Open RX Store on your other device → Sign In → <b className="text-white">Use a sign-in code</b>, then enter:
                </p>
                <code className="block font-mono text-sm text-rx-yellow break-all select-all">{pairing.code}</code>
                <p className="text-[10px] text-rx-gray-medium/70 mt-1.5">Valid for 10 minutes · single use · never share it</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
