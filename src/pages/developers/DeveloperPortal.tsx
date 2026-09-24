/**
 * /developers — Developer Portal home (Phase 20 §1).
 * Explains what developers can do, platforms, submission process, security
 * requirements, developer requirements, review process and resources — with
 * clear entry points to every public destination.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight, BookOpen, Download, Users2, Upload, Shield, ClipboardCheck,
  MonitorSmartphone, FileSearch, BadgeCheck, UserCheck, Rocket, Gauge,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useDeveloperStatus, developerDestination } from './useDeveloperStatus';

const STEPS = [
  { icon: UserCheck, title: 'Apply', desc: 'One application per account — publisher details, contact info and terms acceptance. Save a draft anytime.' },
  { icon: Shield, title: 'Get verified', desc: 'The RX Store team reviews every application. We may request changes; approval creates your developer organization.' },
  { icon: Upload, title: 'Build & submit', desc: 'Create apps, draft releases, upload per-platform packages. Everything is checksum-verified and malware-scanned automatically.' },
  { icon: ClipboardCheck, title: 'Review & publish', desc: 'Submissions pass automated security checks, then admin review. Approved releases publish with one click.' },
];

const PLATFORMS = [
  { name: 'Windows', detail: '.exe / .msi — x64, arm64' },
  { name: 'Linux', detail: '.deb / .AppImage — x64, arm64' },
  { name: 'Android', detail: '.apk / .aab — arm64, universal' },
  { name: 'Web / PWA', detail: 'HTTPS deployment URL' },
  { name: 'iOS', detail: 'PWA install flow (no native IPA)' },
];

const SECURITY = [
  'Every uploaded package is quarantined until it passes automated checks.',
  'SHA-256 checksums are computed server-side and verified before install.',
  'Malware scanning (industry provider) — uploads never auto-pass.',
  'Structure validation parses the real binaries (PE, APK/ZIP, .deb/ar).',
  'Native identity checks: your package must match your registered app identity.',
  'Signed packages are checked; unsigned apps are flagged for review.',
];

const REQUIREMENTS = [
  'A real, reachable contact email and support email.',
  'Accurate publisher information (individual or organization).',
  'Apps must be functional, safe and honestly described.',
  'Packages must match the app\u2019s registered native identity.',
  'Acceptance of the RX Store developer terms and privacy policy.',
];

export default function DeveloperPortalHome() {
  const { user } = useAuth();
  const { status, loading } = useDeveloperStatus();
  const dest = user && !loading ? developerDestination(status?.status) : '/developers/apply';
  const isApproved = status?.status === 'APPROVED';

  return (
    <div className="section-container py-12 md:py-16 max-w-5xl">
      {/* Hero */}
      <div className="text-center max-w-3xl mx-auto">
        <span className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-rx-yellow/10 border border-rx-yellow/20 text-xs font-medium text-rx-yellow">
          <Shield className="w-3.5 h-3.5" /> RX STORE DEVELOPER PLATFORM
        </span>
        <h1 className="text-3xl sm:text-4xl lg:text-5xl font-black text-white mt-6 leading-tight">
          Publish your apps on <span className="gradient-text">RX Store</span>
        </h1>
        <p className="mt-4 text-rx-gray-medium text-lg leading-relaxed">
          One account, one organization, every platform — with automated package verification, a real review workflow, analytics and payouts.
        </p>
        <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
          {user && isApproved ? (
            <Link to="/developers/center" className="btn-primary text-base flex items-center gap-2">Open Developer Center <ArrowRight className="w-4 h-4" /></Link>
          ) : (
            <Link to={user ? dest : '/developers/apply'} className="btn-primary text-base flex items-center gap-2">Become a Developer <ArrowRight className="w-4 h-4" /></Link>
          )}
          <Link to="/developers/submit" className="btn-secondary text-base">Submit an App</Link>
        </div>
      </div>

      {/* Entry points */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mt-14">
        {[
          { to: '/developers/apply', icon: Rocket, title: 'Become a Developer', desc: 'Apply for your organization' },
          { to: '/developers/center', icon: MonitorSmartphone, title: 'Developer Center', desc: 'Apps, releases, analytics' },
          { to: '/developers/docs', icon: BookOpen, title: 'Documentation', desc: 'The real APIs, errors, limits' },
          { to: '/developers/submit', icon: Upload, title: 'Submit an App', desc: 'The guided path' },
          { to: '/developers/sdk', icon: Download, title: 'SDK', desc: 'Versioned, checksummed' },
        ].map((c) => (
          <Link key={c.to} to={c.to} className="card p-4 hover:bg-white/[0.04] transition-colors group">
            <c.icon className="w-5 h-5 text-rx-yellow" />
            <p className="text-sm font-semibold text-white mt-2.5 group-hover:text-rx-yellow transition-colors">{c.title}</p>
            <p className="text-[11px] text-rx-gray-medium mt-0.5">{c.desc}</p>
          </Link>
        ))}
      </div>

      {/* What you can do */}
      <div className="mt-16">
        <h2 className="text-2xl font-bold text-white">What RX Store developers can do</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-6">
          {[
            { icon: MonitorSmartphone, title: 'Publish everywhere', desc: 'Windows, Linux, Android and the web from one release pipeline with per-platform packages and architectures.' },
            { icon: Shield, title: 'Ship verified', desc: 'Automated structure, integrity, malware and native-identity checks on every upload — your users get safe binaries.' },
            { icon: Gauge, title: 'See real numbers', desc: 'Downloads, installs vs updates, active devices, platform and version distributions, ratings and revenue.' },
            { icon: Users2, title: 'Run a team', desc: 'Invite teammates with server-enforced roles: Owner, Admin, Developer, Release Manager, Analyst, Support.' },
            { icon: BadgeCheck, title: 'Own your identity', desc: 'A public developer profile with your published apps — private contact data stays private.' },
            { icon: FileSearch, title: 'Talk to reviewers', desc: 'Private threads with the review team, action-item based change requests, full submission history.' },
          ].map((f) => (
            <div key={f.title} className="card p-5">
              <f.icon className="w-5 h-5 text-rx-yellow" />
              <h3 className="font-semibold text-white mt-3">{f.title}</h3>
              <p className="text-sm text-rx-gray-medium mt-1 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Platforms */}
      <div className="mt-16">
        <h2 className="text-2xl font-bold text-white">Supported platforms</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mt-6">
          {PLATFORMS.map((p) => (
            <div key={p.name} className="card p-4 text-center">
              <p className="text-sm font-semibold text-white">{p.name}</p>
              <p className="text-[11px] text-rx-gray-medium mt-1">{p.detail}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Process */}
      <div className="mt-16">
        <h2 className="text-2xl font-bold text-white">The submission process</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-6">
          {STEPS.map((s, i) => (
            <div key={s.title} className="card p-5 relative">
              <span className="absolute -top-3 left-5 w-7 h-7 rounded-lg bg-rx-yellow text-rx-dark text-sm font-black flex items-center justify-center">{i + 1}</span>
              <s.icon className="w-5 h-5 text-rx-yellow mt-2" />
              <h3 className="font-semibold text-white mt-2.5">{s.title}</h3>
              <p className="text-sm text-rx-gray-medium mt-1 leading-relaxed">{s.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Security + requirements */}
      <div className="grid lg:grid-cols-2 gap-6 mt-16">
        <div className="card p-6">
          <h2 className="text-xl font-bold text-white flex items-center gap-2"><Shield className="w-5 h-5 text-rx-yellow" /> Security requirements</h2>
          <ul className="mt-4 space-y-2.5">
            {SECURITY.map((s) => (
              <li key={s} className="text-sm text-rx-gray-medium flex gap-2.5"><Shield className="w-3.5 h-3.5 text-green-400 flex-shrink-0 mt-0.5" />{s}</li>
            ))}
          </ul>
        </div>
        <div className="card p-6">
          <h2 className="text-xl font-bold text-white flex items-center gap-2"><UserCheck className="w-5 h-5 text-rx-yellow" /> Developer requirements</h2>
          <ul className="mt-4 space-y-2.5">
            {REQUIREMENTS.map((s) => (
              <li key={s} className="text-sm text-rx-gray-medium flex gap-2.5"><BadgeCheck className="w-3.5 h-3.5 text-rx-yellow flex-shrink-0 mt-0.5" />{s}</li>
            ))}
          </ul>
        </div>
      </div>

      {/* Review process */}
      <div className="card p-6 mt-6">
        <h2 className="text-xl font-bold text-white">The review process</h2>
        <p className="text-sm text-rx-gray-medium mt-2 leading-relaxed max-w-3xl">
          Every submission runs the automated security pipeline first (structure, integrity, duplicates, malware, signatures, native identity).
          Then an authorized reviewer takes it through admin review — with approve, reject and change-request decisions. Rejections and change
          requests always carry a written reason and concrete action items; the full history is preserved. Publication is a separate, explicit step
          an administrator performs after approval. Developer approval and app approval are independent: your organization is verified once,
          each release is reviewed on its own merits.
        </p>
      </div>

      {/* Resources / footer links */}
      <div className="mt-16 text-center">
        <h2 className="text-2xl font-bold text-white">Developer resources</h2>
        <div className="flex flex-wrap justify-center gap-3 mt-6">
          <Link to="/developers/docs" className="btn-secondary text-sm flex items-center gap-2"><BookOpen className="w-4 h-4" /> API Documentation</Link>
          <Link to="/developers/sdk" className="btn-secondary text-sm flex items-center gap-2"><Download className="w-4 h-4" /> SDK Downloads</Link>
          <Link to="/developers/community" className="btn-secondary text-sm flex items-center gap-2"><Users2 className="w-4 h-4" /> Community</Link>
          <Link to="/developers/submit" className="btn-secondary text-sm flex items-center gap-2"><Upload className="w-4 h-4" /> Submit an App</Link>
        </div>
      </div>
    </div>
  );
}
