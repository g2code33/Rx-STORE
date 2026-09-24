/**
 * /developers/sdk — SDK & resources (Phase 20).
 *
 * HONESTY RULE: every downloadable artifact listed here is served by the
 * EXISTING marketplace download pipeline from a REAL published package row
 * (version, platform, size, SHA-256 — all from the database). The SDK
 * "app" is provisioned through the normal admin/release flow; if it has no
 * published packages, this page says so instead of faking downloads.
 */
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Download, ShieldCheck, FileText, Users } from 'lucide-react';
import { api, isApiConfigured, API_URL } from '../../services/api';
import { formatBytes } from '../../utils/helpers';

const SDK_SLUG = 'rx-developer-sdk';

interface SdkPackage {
  id: string;
  platform: string;
  architecture: string;
  filename: string;
  file_size: number;
  sha256: string;
  version: string;
  release_notes?: string;
}

export default function DeveloperSdk() {
  const [sdk, setSdk] = useState<any>(null);
  const [packages, setPackages] = useState<SdkPackage[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isApiConfigured()) { setError('not-configured'); setPackages([]); return; }
    api.apps.detail(SDK_SLUG).then((d: any) => {
      setSdk(d);
      // The detail payload's sizes map keys are display platforms; the full
      // per-platform package rows (with checksums) come from the same record.
      setPackages((d?.packages as SdkPackage[]) || []);
    }).catch(() => {
      setPackages([]);
    });
  }, []);

  const download = (pkg: SdkPackage) => {
    const token = (() => { try { return localStorage.getItem('rx-store-token') || ''; } catch { return ''; } })();
    const url = `${API_URL}/apps/${SDK_SLUG}/download?platform=${encodeURIComponent(pkg.platform)}&arch=${encodeURIComponent(pkg.architecture)}`;
    // The download endpoint returns a manifest; the client then streams the
    // artifact. Use the same flow as the app page (fetch manifest → fetch url).
    fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => r.json())
      .then((j) => {
        const data = j?.data;
        if (!j?.success || !data?.url) throw new Error(j?.error?.message || 'Download failed');
        window.open(data.url, '_blank');
      })
      .catch((e) => {
        import('react-hot-toast').then(({ default: toast }) => toast.error(e?.message || 'Download failed'));
      });
  };

  return (
    <div className="section-container max-w-3xl py-8 md:py-12">
      <Link to="/developers" className="inline-flex items-center gap-1.5 text-sm text-rx-gray-medium hover:text-white transition-colors">
        <ArrowLeft className="w-4 h-4" /> Developer Portal
      </Link>
      <h1 className="text-3xl font-black text-white mt-4">SDK &amp; Resources</h1>
      <p className="text-rx-gray-medium mt-2 text-sm max-w-xl">
        Everything served here comes through the standard RX Store release pipeline — versioned, checksummed (SHA-256), and verified by the package security pipeline. No fake downloads.
      </p>

      {packages === null ? (
        <div className="card p-8 mt-8 animate-pulse space-y-3"><div className="h-5 bg-white/5 rounded w-1/3" /><div className="h-16 bg-white/5 rounded" /></div>
      ) : error === 'not-configured' ? (
        <div className="card p-8 mt-8 text-center text-sm text-rx-gray-medium">Backend not connected — install a correctly configured build.</div>
      ) : packages.length === 0 ? (
        <div className="card p-8 mt-8 text-center">
          <Download className="w-8 h-8 text-rx-gray-medium/40 mx-auto" />
          <h3 className="font-semibold text-white mt-3">SDK packages are being prepared</h3>
          <p className="text-sm text-rx-gray-medium mt-1.5 max-w-md mx-auto">
            The developer SDK ships through the same release pipeline as marketplace apps. Until the first SDK release is published, start with the API documentation — every documented endpoint is live.
          </p>
          <Link to="/developers/docs" className="btn-primary text-sm mt-4 inline-block">Read the API docs</Link>
        </div>
      ) : (
        <div className="space-y-3 mt-8">
          {packages.map((pkg) => (
            <div key={pkg.id} className="card p-5 flex flex-wrap items-center gap-4">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-white">
                  RX Developer SDK <span className="text-rx-yellow">v{pkg.version}</span>
                  <span className="text-rx-gray-medium font-normal"> · {pkg.platform}{pkg.architecture !== 'universal' ? ` (${pkg.architecture})` : ''}</span>
                </p>
                <p className="text-xs text-rx-gray-medium mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span>{formatBytes(pkg.file_size)}</span>
                  <span className="flex items-center gap-1" title={pkg.sha256}><ShieldCheck className="w-3 h-3 text-green-400" /> SHA-256 verified</span>
                </p>
                <p className="text-[10px] font-mono text-rx-gray-medium/60 mt-1 truncate">{pkg.sha256}</p>
              </div>
              <button onClick={() => download(pkg)} className="btn-primary text-sm flex items-center gap-2">
                <Download className="w-4 h-4" /> Download
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Non-download resources (real routes, no fake artifacts) */}
      <div className="grid sm:grid-cols-2 gap-3 mt-8">
        <Link to="/developers/docs" className="card p-5 hover:bg-white/[0.03] transition-colors">
          <FileText className="w-5 h-5 text-rx-yellow" />
          <h3 className="font-semibold text-white mt-2.5 text-sm">API Documentation</h3>
          <p className="text-xs text-rx-gray-medium mt-1">Every endpoint, error code and rate limit — documented against the real deployment.</p>
        </Link>
        <Link to="/developers/community" className="card p-5 hover:bg-white/[0.03] transition-colors">
          <Users className="w-5 h-5 text-rx-yellow" />
          <h3 className="font-semibold text-white mt-2.5 text-sm">Community</h3>
          <p className="text-xs text-rx-gray-medium mt-1">Ask integration questions and share what you built.</p>
        </Link>
      </div>
    </div>
  );
}
