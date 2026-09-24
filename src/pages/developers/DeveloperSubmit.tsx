/**
 * /developers/submit — Submit an App (Phase 20 §4).
 * Routes by the visitor's real developer state:
 *   signed out   → sign-in / developer info
 *   no org       → Become a Developer
 *   pending      → application status
 *   approved     → Developer Center / app submission
 */
import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, CheckCircle2, Clock, LogIn, Rocket, Upload } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useDeveloperStatus } from './useDeveloperStatus';

export default function DeveloperSubmit() {
  const { user } = useAuth();
  const { status, loading } = useDeveloperStatus();
  const navigate = useNavigate();

  if (!user) {
    return (
      <div className="section-container max-w-lg py-16 md:py-24 text-center">
        <div className="card p-8">
          <LogIn className="w-10 h-10 text-rx-yellow mx-auto" />
          <h1 className="text-2xl font-black text-white mt-4">Submit an app to RX Store</h1>
          <p className="text-sm text-rx-gray-medium mt-2">
            Publishing on RX Store requires a (free) account and an approved developer organization — one account, every platform.
          </p>
          <div className="flex flex-col sm:flex-row gap-2.5 justify-center mt-6">
            <Link to="/login" className="btn-primary text-sm flex items-center justify-center gap-2">Sign in to continue <ArrowRight className="w-4 h-4" /></Link>
            <Link to="/login?mode=register" className="btn-secondary text-sm">Create an account</Link>
          </div>
          <p className="text-xs text-rx-gray-medium/70 mt-5">
            New here? Read the <Link to="/developers" className="text-rx-yellow hover:underline">Developer Portal</Link> overview first.
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return <div className="section-container max-w-lg py-16"><div className="card p-8 animate-pulse h-40" /></div>;
  }

  const st = status?.status || 'NOT_APPLIED';

  if (st === 'APPROVED') {
    return (
      <div className="section-container max-w-lg py-16 md:py-24 text-center">
        <div className="card p-8">
          <Rocket className="w-10 h-10 text-rx-yellow mx-auto" />
          <h1 className="text-2xl font-black text-white mt-4">You're approved — ship it 🚀</h1>
          <p className="text-sm text-rx-gray-medium mt-2">
            Create your app, upload packages and submit releases for review from the Developer Center.
          </p>
          <div className="flex flex-col sm:flex-row gap-2.5 justify-center mt-6">
            <Link to="/developers/apps/new" className="btn-primary text-sm flex items-center justify-center gap-2"><Upload className="w-4 h-4" /> Create a new app</Link>
            <Link to="/developers/apps" className="btn-secondary text-sm">My apps</Link>
          </div>
        </div>
      </div>
    );
  }

  if (st === 'SUSPENDED') {
    return (
      <div className="section-container max-w-lg py-16 md:py-24 text-center">
        <div className="card p-8">
          <h1 className="text-2xl font-black text-white">Your developer account is suspended</h1>
          <p className="text-sm text-rx-gray-medium mt-2">Contact the RX Store team through the Developer Center to resolve this.</p>
          <Link to="/developers/status" className="btn-primary text-sm mt-6 inline-block">View status</Link>
        </div>
      </div>
    );
  }

  if (['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'CHANGES_REQUESTED', 'REJECTED'].includes(st)) {
    return (
      <div className="section-container max-w-lg py-16 md:py-24 text-center">
        <div className="card p-8">
          <Clock className="w-10 h-10 text-rx-yellow mx-auto" />
          <h1 className="text-2xl font-black text-white mt-4">Your developer application is {String(st).replace(/_/g, ' ').toLowerCase()}</h1>
          <p className="text-sm text-rx-gray-medium mt-2">
            You can submit apps once your developer organization is approved. Check your status or update your application.
          </p>
          <div className="flex flex-col sm:flex-row gap-2.5 justify-center mt-6">
            <Link to="/developers/status" className="btn-primary text-sm">View application status</Link>
            {st === 'CHANGES_REQUESTED' || st === 'REJECTED' ? (
              <Link to="/developers/apply" className="btn-secondary text-sm">Update application</Link>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  // NOT_APPLIED — Become a Developer
  return (
    <div className="section-container max-w-lg py-16 md:py-24 text-center">
      <div className="card p-8">
        <CheckCircle2 className="w-10 h-10 text-rx-yellow mx-auto" />
        <h1 className="text-2xl font-black text-white mt-4">Become a RX Store developer</h1>
        <p className="text-sm text-rx-gray-medium mt-2">
          Apply once, get reviewed by the RX Store team, and publish under your own organization — apps, releases, analytics and payouts included.
        </p>
        <button onClick={() => navigate('/developers/apply')} className="btn-primary text-sm mt-6 inline-flex items-center gap-2">
          Start your application <ArrowRight className="w-4 h-4" />
        </button>
        <p className="text-xs text-rx-gray-medium/70 mt-5">
          Review the <Link to="/developers" className="text-rx-yellow hover:underline">requirements</Link> before applying.
        </p>
      </div>
    </div>
  );
}
