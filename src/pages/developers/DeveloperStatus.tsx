/**
 * /developers/status — application status (Phase 11 §2/§13).
 * Also the RESTRICTED area for suspended developers (status + communication).
 */
import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Clock, CheckCircle2, AlertCircle, XCircle, PauseCircle, MessageSquare } from 'lucide-react';
import { api, isApiConfigured } from '../../services/api';
import { useAuth } from '../../context/AuthContext';

const FLOW = ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED'];

export default function DeveloperStatus() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [state, setState] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user) { navigate('/login'); return; }
    if (!isApiConfigured()) { setLoading(false); setError('not-configured'); return; }
    let alive = true;
    api.developers.status().then((s) => { if (alive) setState(s); })
      .catch((e: any) => { if (alive) setError(e?.message || 'Could not load status'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!user) return null;

  const status = state?.status || 'NOT_APPLIED';
  const app = state?.application;
  const stepIndex = FLOW.indexOf(status === 'SUSPENDED' ? 'APPROVED' : status);

  const badge = (s: string) => {
    switch (s) {
      case 'APPROVED': return { icon: CheckCircle2, cls: 'text-green-400 bg-green-400/10 border-green-400/20', label: 'Approved' };
      case 'SUSPENDED': return { icon: PauseCircle, cls: 'text-amber-300 bg-amber-500/10 border-amber-500/20', label: 'Suspended' };
      case 'REJECTED': return { icon: XCircle, cls: 'text-red-400 bg-red-400/10 border-red-400/20', label: 'Not approved' };
      case 'CHANGES_REQUESTED': return { icon: AlertCircle, cls: 'text-amber-300 bg-amber-500/10 border-amber-500/20', label: 'Changes requested' };
      case 'SUBMITTED': return { icon: Clock, cls: 'text-rx-yellow bg-rx-yellow/10 border-rx-yellow/20', label: 'Submitted' };
      case 'UNDER_REVIEW': return { icon: Clock, cls: 'text-rx-yellow bg-rx-yellow/10 border-rx-yellow/20', label: 'Under review' };
      case 'DRAFT': return { icon: Clock, cls: 'text-rx-gray-medium bg-white/5 border-white/10', label: 'Draft' };
      default: return { icon: Clock, cls: 'text-rx-gray-medium bg-white/5 border-white/10', label: 'Not applied' };
    }
  };
  const b = badge(status);

  return (
    <div className="section-container max-w-3xl py-10 md:py-14">
      <Link to="/developers" className="inline-flex items-center gap-1.5 text-sm text-rx-gray-medium hover:text-white transition-colors">
        <ArrowLeft className="w-4 h-4" /> Developer Platform
      </Link>

      <h1 className="text-2xl sm:text-3xl font-black text-white mt-4">Developer application status</h1>

      {loading ? (
        <div className="card p-8 mt-8 animate-pulse space-y-4">
          <div className="h-5 bg-white/5 rounded w-1/3" /><div className="h-3 bg-white/5 rounded w-2/3" />
        </div>
      ) : error === 'not-configured' ? (
        <div className="card p-8 mt-8 text-center">
          <AlertCircle className="w-8 h-8 text-rx-yellow mx-auto" />
          <p className="text-sm text-rx-gray-medium mt-3">Backend not connected — install a correctly configured build.</p>
        </div>
      ) : error ? (
        <div className="card p-8 mt-8 text-center">
          <AlertCircle className="w-8 h-8 text-red-400 mx-auto" />
          <p className="text-sm text-rx-gray-medium mt-3">{error}</p>
        </div>
      ) : (
        <>
          <div className={`mt-6 inline-flex items-center gap-2 px-4 py-2 rounded-xl border text-sm font-semibold ${b.cls}`}>
            <b.icon className="w-4 h-4" /> {b.label}
          </div>

          {/* Progress (draft -> approved) */}
          <div className="card p-6 md:p-8 mt-6">
            <div className="flex items-center">
              {FLOW.map((s, i) => (
                <React.Fragment key={s}>
                  <div className="flex flex-col items-center">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${i <= stepIndex ? 'bg-rx-yellow text-rx-dark' : 'bg-rx-dark-tertiary text-rx-gray-medium'}`}>
                      {i < stepIndex ? <CheckCircle2 className="w-4 h-4" /> : i + 1}
                    </div>
                    <span className={`text-[10px] mt-1.5 text-center ${i <= stepIndex ? 'text-white' : 'text-rx-gray-medium'}`}>
                      {s === 'DRAFT' ? 'Draft' : s === 'SUBMITTED' ? 'Submitted' : s === 'UNDER_REVIEW' ? 'Review' : 'Approved'}
                    </span>
                  </div>
                  {i < FLOW.length - 1 && <div className={`flex-1 h-0.5 mx-1 mb-5 ${i < stepIndex ? 'bg-rx-yellow' : 'bg-white/10'}`} />}
                </React.Fragment>
              ))}
            </div>

            {app?.reviewReason && ['CHANGES_REQUESTED', 'REJECTED', 'SUSPENDED'].includes(status) && (
              <div className="mt-6 p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 text-sm">
                <p className="font-semibold text-amber-200">Note from the RX Store team</p>
                <p className="text-rx-gray-medium mt-1">{app.reviewReason}</p>
              </div>
            )}

            <div className="mt-6 grid sm:grid-cols-2 gap-4 text-sm">
              <div><p className="text-rx-gray-medium">Publisher name</p><p className="text-white font-medium">{app?.publisherName || '—'}</p></div>
              <div><p className="text-rx-gray-medium">Submitted</p><p className="text-white font-medium">{app?.submittedAt ? String(app.submittedAt).slice(0, 10) : '—'}</p></div>
            </div>

            <div className="mt-8 flex flex-col sm:flex-row gap-3">
              {['NOT_APPLIED', 'DRAFT', 'CHANGES_REQUESTED', 'REJECTED'].includes(status) && (
                <Link to="/developers/apply" className="btn-primary flex items-center justify-center gap-2 text-sm">
                  {status === 'NOT_APPLIED' || status === 'DRAFT' ? 'Continue application' : 'Update & resubmit'}
                </Link>
              )}
              {status === 'APPROVED' && (
                <Link to="/developers/center" className="btn-primary flex items-center justify-center gap-2 text-sm">
                  <CheckCircle2 className="w-4 h-4" /> Open Developer Center
                </Link>
              )}
              {status === 'SUSPENDED' && state?.developer && (
                <Link to="/developers/messages" className="btn-primary flex items-center justify-center gap-2 text-sm">
                  <MessageSquare className="w-4 h-4" /> Contact the RX Store team
                </Link>
              )}
            </div>
          </div>

          {status === 'SUSPENDED' && (
            <div className="mt-6 p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 text-sm text-rx-gray-medium">
              Your developer organization is suspended. Team management and publishing are blocked,
              but you can still view your status and communicate with the RX Store team.
            </div>
          )}
        </>
      )}
    </div>
  );
}
