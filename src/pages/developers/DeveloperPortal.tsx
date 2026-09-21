/**
 * /developers — public Developer Platform landing (Phase 11).
 * Shows what the platform offers and routes the CTA by the visitor's
 * developer status (signed out -> info/sign-in, applicant -> status,
 * approved -> Developer Center).
 */
import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Shield, Users, Upload, BarChart3, MessageSquare, CheckCircle2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useDeveloperStatus, developerDestination } from './useDeveloperStatus';

const BENEFITS = [
  { icon: Shield, title: 'Verified publisher identity', desc: 'Apply once, get reviewed by the RX Store team, and publish under a trusted organization profile.' },
  { icon: Users, title: 'Team & roles', desc: 'Invite your team with server-enforced roles: Owner, Admin, Developer, Release Manager, Analyst, Support.' },
  { icon: Upload, title: 'Releases & packages', desc: 'Manage multi-platform releases with per-architecture packages, channels and rollback.' },
  { icon: BarChart3, title: 'Real analytics', desc: 'Downloads, ratings and reviews for your published applications.' },
  { icon: MessageSquare, title: 'Direct admin channel', desc: 'Private communication threads with the RX Store review team.' },
  { icon: CheckCircle2, title: 'One account', desc: 'Your normal RX Store account becomes a developer account — no separate login.' },
];

const STEPS = [
  { n: 1, title: 'Apply', desc: 'Fill in the developer application (save a draft anytime).' },
  { n: 2, title: 'Review', desc: 'The RX Store team reviews and may request changes.' },
  { n: 3, title: 'Get your organization', desc: 'Approval creates your developer organization and public profile.' },
  { n: 4, title: 'Build', desc: 'Manage apps, releases, team and analytics from the Developer Center.' },
];

export default function DeveloperPortal() {
  const { user } = useAuth();
  const { status, loading } = useDeveloperStatus();
  const navigate = useNavigate();

  const dest = user && !loading ? developerDestination(status?.status) : '/developers';
  const ctaLabel = !user ? 'Sign in to become a developer'
    : status?.status === 'APPROVED' ? 'Open Developer Center'
    : status?.status === 'SUSPENDED' ? 'View account status'
    : status && status.status !== 'NOT_APPLIED' ? 'View application status'
    : 'Become a Developer';

  return (
    <div className="section-container py-12 md:py-16">
      {/* Hero */}
      <div className="text-center max-w-3xl mx-auto">
        <span className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-rx-yellow/10 border border-rx-yellow/20 text-xs font-medium text-rx-yellow">
          <Shield className="w-3.5 h-3.5" /> RX STORE DEVELOPER PLATFORM
        </span>
        <h1 className="text-3xl sm:text-4xl lg:text-5xl font-black text-white mt-6 leading-tight">
          Publish your apps on <span className="gradient-text">RX Store</span>
        </h1>
        <p className="mt-4 text-rx-gray-medium text-lg leading-relaxed">
          One account, one organization, every platform. Join the marketplace serving
          healthcare, education and productivity users across web, Windows, Linux and Android.
        </p>
        <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
          <button
            onClick={() => (user ? navigate(dest) : navigate('/login'))}
            className="btn-primary text-base flex items-center gap-2"
          >
            {ctaLabel} <ArrowRight className="w-4 h-4" />
          </button>
          <a href="#how-it-works" className="btn-secondary text-base">How it works</a>
        </div>
        {!user && (
          <p className="mt-3 text-xs text-rx-gray-medium">
            New here? <Link to="/login?mode=register" className="text-rx-yellow hover:underline">Create an RX Store account</Link> first — it takes a minute.
          </p>
        )}
      </div>

      {/* Benefits */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-14">
        {BENEFITS.map((b) => (
          <div key={b.title} className="card p-6">
            <div className="w-10 h-10 rounded-xl bg-rx-yellow/10 flex items-center justify-center">
              <b.icon className="w-5 h-5 text-rx-yellow" />
            </div>
            <h3 className="font-semibold text-white mt-4">{b.title}</h3>
            <p className="text-sm text-rx-gray-medium mt-1.5 leading-relaxed">{b.desc}</p>
          </div>
        ))}
      </div>

      {/* Steps */}
      <div id="how-it-works" className="mt-16">
        <h2 className="text-2xl font-bold text-white text-center">How it works</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-8">
          {STEPS.map((s) => (
            <div key={s.n} className="card p-6 relative">
              <span className="absolute -top-3 left-6 w-7 h-7 rounded-lg bg-rx-yellow text-rx-dark text-sm font-black flex items-center justify-center">{s.n}</span>
              <h3 className="font-semibold text-white mt-2">{s.title}</h3>
              <p className="text-sm text-rx-gray-medium mt-1.5">{s.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Roles */}
      <div className="card p-6 md:p-8 mt-16">
        <h2 className="text-xl font-bold text-white">Six roles, enforced on the server</h2>
        <p className="text-sm text-rx-gray-medium mt-1">Permissions are checked on every request — the UI only hides what the backend already refuses.</p>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mt-6">
          {[
            ['OWNER', 'Full control'],
            ['ADMIN', 'Operations'],
            ['DEVELOPER', 'Apps & releases'],
            ['RELEASE MANAGER', 'Ship & publish'],
            ['ANALYST', 'Analytics only'],
            ['SUPPORT', 'Reviews & replies'],
          ].map(([role, desc]) => (
            <div key={role} className="rounded-xl bg-rx-dark-tertiary border border-white/5 p-4 text-center">
              <p className="text-xs font-black text-rx-yellow tracking-wide">{role}</p>
              <p className="text-[11px] text-rx-gray-medium mt-1">{desc}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="text-center mt-14">
        <button onClick={() => (user ? navigate(dest) : navigate('/login'))} className="btn-primary text-base inline-flex items-center gap-2">
          {ctaLabel} <ArrowRight className="w-4 h-4" />
        </button>
        <p className="text-xs text-rx-gray-medium mt-4 max-w-md mx-auto">
          Developer approval is separate from app publication. Applications are reviewed by the
          RX Store team — nothing is auto-approved.
        </p>
      </div>
    </div>
  );
}
