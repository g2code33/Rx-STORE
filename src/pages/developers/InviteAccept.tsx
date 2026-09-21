/**
 * /developers/invite?token=… — accept a team invitation (Phase 11 §5).
 * The token is validated server-side (hash + expiry + email match); this page
 * just collects it and reports the honest result.
 */
import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, AlertCircle, ArrowLeft } from 'lucide-react';
import { api, isApiConfigured } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { clearDeveloperStatusCache } from './useDeveloperStatus';

export default function InviteAccept() {
  const [params] = useSearchParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [state, setState] = useState<'working' | 'ok' | 'error'>('working');
  const [message, setMessage] = useState('');
  const [role, setRole] = useState('');

  useEffect(() => {
    const token = params.get('token') || '';
    if (!user) { navigate(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`); return; }
    if (!isApiConfigured()) { setState('error'); setMessage('Backend not connected.'); return; }
    if (!token) { setState('error'); setMessage('This invitation link is incomplete.'); return; }
    let alive = true;
    api.developers.acceptInvitation(token)
      .then((r: any) => {
        if (!alive) return;
        clearDeveloperStatusCache();
        setRole(r.role || '');
        setState('ok');
      })
      .catch((e: any) => { if (alive) { setState('error'); setMessage(e?.message || 'This invitation could not be accepted.'); } });
    return () => { alive = false; };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="section-container max-w-md py-16 md:py-24">
      <Link to="/developers" className="inline-flex items-center gap-1.5 text-sm text-rx-gray-medium hover:text-white transition-colors">
        <ArrowLeft className="w-4 h-4" /> Developer Platform
      </Link>
      <div className="card p-8 text-center mt-6">
        {state === 'working' && (
          <>
            <div className="w-12 h-12 rounded-xl bg-rx-yellow/10 flex items-center justify-center mx-auto">
              <div className="w-5 h-5 border-2 border-rx-dark/30 border-t-rx-dark rounded-full animate-spin" style={{ borderColor: 'rgba(255,214,0,.3)', borderTopColor: '#FFD600' }} />
            </div>
            <h1 className="font-bold text-white mt-4">Accepting invitation…</h1>
          </>
        )}
        {state === 'ok' && (
          <>
            <CheckCircle2 className="w-12 h-12 text-green-400 mx-auto" />
            <h1 className="text-xl font-bold text-white mt-4">Welcome to the team!</h1>
            <p className="text-sm text-rx-gray-medium mt-2">You are now a member of the developer organization{role ? ` as ${role}` : ''}.</p>
            <Link to="/developers/center" className="btn-primary text-sm mt-6 inline-block">Open Developer Center</Link>
          </>
        )}
        {state === 'error' && (
          <>
            <AlertCircle className="w-12 h-12 text-rx-yellow mx-auto" />
            <h1 className="text-xl font-bold text-white mt-4">Invitation not accepted</h1>
            <p className="text-sm text-rx-gray-medium mt-2">{message}</p>
            <Link to="/developers" className="btn-secondary text-sm mt-6 inline-block">Developer Platform</Link>
          </>
        )}
      </div>
    </div>
  );
}
