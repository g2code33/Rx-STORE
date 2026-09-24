/**
 * /developers/sdk — the REAL SDK integration center.
 *
 * The SDK itself lives in the repository at sdk/ (@rx-store/sdk — core is
 * framework-free; an optional React banner lives at @rx-store/sdk/react).
 * This page documents the integration end-to-end.
 *
 * HONESTY RULE (unchanged): the "Downloadable artifacts" section lists only
 * REAL published packages served by the existing marketplace pipeline. If no
 * SDK package has been published through the admin release flow, it says so
 * instead of faking downloads. The SDK source is consumable from the repo
 * regardless (see Installation).
 */
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Download, ShieldCheck, Code2, Terminal, Link2, Bell, RefreshCw, Lock, BookOpen, GitBranch, Smartphone, Monitor } from 'lucide-react';
import { api, isApiConfigured, API_URL } from '../../services/api';
import { formatBytes } from '../../utils/helpers';
import toast from 'react-hot-toast';

const SDK_SLUG = 'rx-developer-sdk';
const API_BASE = 'https://rx-store-api.calcitoninpay.workers.dev/v1';
const WEB_BASE = 'https://rx-store-web.pages.dev';

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

function Snippet({ title, code }: { title: string; code: string }) {
  const copy = () => {
    try { navigator.clipboard.writeText(code); toast.success('Copied'); } catch { toast.error('Copy failed'); }
  };
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-xs font-semibold text-white/80">{title}</p>
        <button onClick={copy} className="text-[11px] text-rx-yellow hover:underline">Copy</button>
      </div>
      <pre className="bg-black/40 border border-white/10 rounded-xl p-4 text-[11px] leading-relaxed text-white/90 overflow-x-auto">{code}</pre>
    </div>
  );
}

function Section({ id, icon, title, children }: { id: string; icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="text-lg font-bold text-white flex items-center gap-2 mt-10 first:mt-0">{icon}{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export default function DeveloperSdk() {
  const [sdk, setSdk] = useState<any>(null);
  const [packages, setPackages] = useState<SdkPackage[] | null>(null);

  useEffect(() => {
    if (!isApiConfigured()) { setPackages([]); return; }
    api.apps.detail(SDK_SLUG).then((d: any) => {
      setSdk(d);
      setPackages((d?.packages as SdkPackage[]) || []);
    }).catch(() => {
      setPackages([]);
    });
  }, []);

  const download = (pkg: SdkPackage) => {
    const token = (() => { try { return localStorage.getItem('rx-store-token') || ''; } catch { return ''; } })();
    const url = `${API_URL}/apps/${SDK_SLUG}/download?platform=${encodeURIComponent(pkg.platform)}&arch=${encodeURIComponent(pkg.architecture)}`;
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
    <div className="section-container py-8 lg:py-12 max-w-4xl">
      <Link to="/developers" className="inline-flex items-center gap-1.5 text-sm text-rx-gray-medium hover:text-white mb-6">
        <ArrowLeft className="w-4 h-4" /> Developer Portal
      </Link>

      <h1 className="text-2xl sm:text-3xl font-black text-white">RX Store Developer SDK</h1>
      <p className="text-rx-gray-medium mt-2 text-sm leading-relaxed">
        Add in-app update checks to <b className="text-white">your</b> application. The SDK tells your app when a newer
        RX Store release exists and hands the user to RX Store for the update — RX Store performs the verified download,
        security pipeline and installation. <b className="text-white">The SDK never downloads or installs anything itself.</b>
      </p>

      <div className="card p-4 mt-6 bg-rx-yellow/5 border-rx-yellow/20">
        <p className="text-xs text-white/90 leading-relaxed">
          <ShieldCheck className="w-4 h-4 text-rx-yellow inline -mt-0.5 mr-1" />
          The flow: <code className="text-rx-yellow">your app → SDK → GET /updates/check → your banner → "Update via RX Store" → rxstore://app/&#123;slug&#125; → RX Store page → RX Store's existing update pipeline.</code>
        </p>
      </div>

      {/* 1. Overview */}
      <Section id="overview" icon={<Code2 className="w-5 h-5 text-rx-yellow" />} title="1 · Overview">
        <ul className="text-sm text-rx-gray-medium space-y-1.5 list-disc pl-5">
          <li><b className="text-white">Framework-free core</b> — TypeScript/JavaScript, zero dependencies, works in any host (web, PWA, Android WebView, Electron).</li>
          <li><b className="text-white">Optional React banner</b> — accessible, responsive, mandatory-aware (<code>&lt;RxStoreUpdateBanner /&gt;</code>).</li>
          <li><b className="text-white">Server-authoritative</b> — updateAvailable, latestVersion, mandatory and checksums come from RX Store and are validated client-side.</li>
          <li><b className="text-white">No secrets</b> — the update check is the same public API a browser uses; nothing sensitive ships in your app.</li>
          <li><b className="text-white">Platform-aware</b> — web / PWA / Android / Windows / Linux, with explicit overrides so browser detection is never authoritative for package identity.</li>
        </ul>
      </Section>

      {/* 2. Installation */}
      <Section id="installation" icon={<Terminal className="w-5 h-5 text-rx-yellow" />} title="2 · Installation">
        <p className="text-sm text-rx-gray-medium">
          The SDK source lives in this repository at <code className="text-rx-yellow">sdk/</code> (package name <code className="text-rx-yellow">@rx-store/sdk</code>).
          It is <b className="text-white">not yet published to npm</b> — consume it from the repository:
        </p>
        <Snippet title="Install (until the npm package is published)" code={`npm install g2code33/Rx-STORE#v1.5.1`} />
        <Snippet title="Import" code={`import { createRxStoreSDK } from '@rx-store/sdk';            // core (no React)\nimport { RxStoreUpdateBanner } from '@rx-store/sdk/react';   // optional React banner`} />
      </Section>

      {/* 3. Quick start */}
      <Section id="quick-start" icon={<BookOpen className="w-5 h-5 text-rx-yellow" />} title="3 · Quick start">
        <Snippet title="Quick start" code={`import { createRxStoreSDK } from '@rx-store/sdk';\n\nexport const rxStore = createRxStoreSDK({\n  appId: 'pharmatrack',        // your app's RX Store slug (App → SDK Integration)\n  currentVersion: APP_VERSION, // your app's SemVer, e.g. '1.1.4'\n  platform: 'android',         // explicit on native hosts (recommended)\n});\n\nawait rxStore.initialize();    // non-blocking startup check`} />
        <p className="text-[11px] text-rx-gray-medium mt-2">
          Find your appId/slug in the Developer Center → your app → <Link to="/developers/apps" className="text-rx-yellow hover:underline">SDK &amp; Update Integration</Link>.
        </p>
      </Section>

      {/* 4. Update checking */}
      <Section id="checking" icon={<RefreshCw className="w-5 h-5 text-rx-yellow" />} title="4 · Update checking">
        <Snippet title="checkForUpdate() — never throws" code={`const result = await rxStore.checkForUpdate();\n\nif (result.status === 'UPDATE_AVAILABLE') {\n  // result.update.latestVersion, releaseNotes, fileSize, checksum…\n} else if (result.status === 'MANDATORY_UPDATE') {\n  // the server marked this release mandatory — updating is required\n} else if (result.status === 'NO_UPDATE') {\n  // up to date\n} else {\n  // NETWORK_ERROR | RATE_LIMITED | SERVER_ERROR → SDK backs off, retry later\n  // INVALID_RESPONSE | APP_NOT_FOUND | UNSUPPORTED_PLATFORM → check your config\n}`} />
        <p className="text-sm text-rx-gray-medium mt-2">
          Helpers: <code className="text-rx-yellow">hasUpdate()</code>, <code className="text-rx-yellow">isMandatoryUpdate()</code>, <code className="text-rx-yellow">getUpdateInfo()</code>.
          The SDK checks once on start, re-checks on visibility, caches successes for 5 minutes, de-duplicates concurrent
          checks and backs off exponentially (30s → ×2 → 10 min) after failures — it never polls aggressively and never blocks your startup.
        </p>
      </Section>

      {/* 5. Update banner */}
      <Section id="banner" icon={<Bell className="w-5 h-5 text-rx-yellow" />} title="5 · Update banner (React, optional)">
        <Snippet title="One line banner" code={`import { RxStoreUpdateBanner } from '@rx-store/sdk/react';\n\n<RxStoreUpdateBanner sdk={rxStore} onUpdateOpen={() => analytics.track('update_open')} />`} />
        <div className="card p-4 mt-3 bg-white/5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-white">RX Store update</p>
              <p className="text-xs text-rx-gray-medium mt-0.5">PharmaTRACK v1.1.5 is available. Open RX Store to update securely.</p>
            </div>
            <div className="flex gap-2">
              <span className="px-4 py-2 text-xs font-bold bg-rx-yellow text-rx-dark rounded-lg">Update via RX Store</span>
              <span className="px-4 py-2 text-xs border border-white/20 rounded-lg">Later</span>
            </div>
          </div>
        </div>
        <p className="text-xs text-rx-gray-medium mt-2">
          Mandatory updates render as a required-update banner and cannot be permanently dismissed; network failures show a
          retryable state; the core has no React dependency if you build your own UI.
        </p>
      </Section>

      {/* 6. Deep linking */}
      <Section id="deep-linking" icon={<Link2 className="w-5 h-5 text-rx-yellow" />} title="6 · RX Store deep linking">
        <Snippet title="One action — the SDK handles the rest" code={`rxStore.openUpdateInRxStore();\n\n// Native hosts: opens rxstore://app/pharmatrack, HTTPS fallback after ~2s\n//            if RX Store is not installed.\n// Web hosts:   opens https://rx-store-web.pages.dev/app/pharmatrack directly.`} />
        <div className="grid sm:grid-cols-2 gap-3 mt-3">
          <div className="bg-white/5 rounded-xl p-3">
            <p className="text-xs font-semibold text-white flex items-center gap-1.5"><Smartphone className="w-3.5 h-3.5 text-rx-yellow" /> Android</p>
            <p className="text-[11px] text-rx-gray-medium mt-1">RX Store registers the <code className="text-rx-yellow">rxstore://</code> intent; links open the exact app page even while RX Store is running.</p>
          </div>
          <div className="bg-white/5 rounded-xl p-3">
            <p className="text-xs font-semibold text-white flex items-center gap-1.5"><Monitor className="w-3.5 h-3.5 text-rx-yellow" /> Windows / Linux</p>
            <p className="text-[11px] text-rx-gray-medium mt-1">RX Store (Electron) registers the protocol handler and reuses its existing window — validated in the main process before navigation.</p>
          </div>
        </div>
        <p className="text-xs text-rx-gray-medium mt-2">
          Links are strictly <code className="text-rx-yellow">rxstore://app/&#123;kebab-slug&#125;</code>; RX Store re-validates every incoming link and never executes URL content.
          When RX Store is not installed, the HTTPS page preserves your intended destination and continues after install.
        </p>
      </Section>

      {/* 7. Platform integration */}
      <Section id="platforms" icon={<Monitor className="w-5 h-5 text-rx-yellow" />} title="7 · Platform integration">
        <div className="text-sm text-rx-gray-medium space-y-2">
          <p><b className="text-white">Android (Capacitor/Cordova/native WebView):</b> pass <code className="text-rx-yellow">platform: 'android'</code> and <code className="text-rx-yellow">architecture</code> explicitly. Never rely on user-agent — the SDK deliberately refuses to infer Android package identity from a browser UA.</p>
          <p><b className="text-white">Windows / Linux (Electron or bundled webview):</b> pass <code className="text-rx-yellow">platform: 'windows' | 'linux'</code>. The deep link opens RX Store's registered protocol handler.</p>
          <p><b className="text-white">Web / PWA hosts:</b> no override needed — the SDK reports web/pwa and uses the HTTPS store URL directly.</p>
          <p><b className="text-white">iOS:</b> distribute as a PWA link; use the web flow (the SDK's HTTPS destination works everywhere).</p>
        </div>
      </Section>

      {/* 8. Mandatory updates */}
      <Section id="mandatory" icon={<Bell className="w-5 h-5 text-rx-yellow" />} title="8 · Mandatory updates">
        <p className="text-sm text-rx-gray-medium">
          A release can be marked <b className="text-white">mandatory</b> (and/or set a <b className="text-white">minimum supported version</b>) when it is created.
          When your user's version is affected, <code className="text-rx-yellow">checkForUpdate()</code> returns
          <code className="text-rx-yellow"> MANDATORY_UPDATE</code> — communicate that updating through RX Store is required, and treat the banner as non-dismissible.
        </p>
        <Snippet title="Mandatory handling" code={`if (rxStore.isMandatoryUpdate()) {\n  // block the flow / show a non-dismissible screen:\n  // "This version is no longer supported. Update via RX Store to continue."\n  rxStore.openUpdateInRxStore();\n}`} />
      </Section>

      {/* 9. Security */}
      <Section id="security" icon={<Lock className="w-5 h-5 text-rx-yellow" />} title="9 · Security">
        <ul className="text-sm text-rx-gray-medium space-y-1.5 list-disc pl-5">
          <li>The SDK contains <b className="text-white">no secrets</b> — no API keys, tokens or signing material. The update check is public and unauthenticated.</li>
          <li><b className="text-white">Server-authoritative metadata</b>: latestVersion, mandatory, minimumSupportedVersion, checksum and destinations are validated; client-supplied values are never trusted.</li>
          <li>Paid applications <b className="text-white">never expose a binary URL</b> through the update check — entitlements and short-lived download grants stay inside RX Store.</li>
          <li>The SDK <b className="text-white">ignores download URLs entirely</b>; downloading, SHA-256 verification, package security and installation are RX Store's job.</li>
          <li>Fail-closed for unsafe metadata; fail-open (non-crashing) for ordinary network outages.</li>
        </ul>
      </Section>

      {/* 10. API reference */}
      <Section id="api" icon={<BookOpen className="w-5 h-5 text-rx-yellow" />} title="10 · API reference">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-rx-gray-medium border-b border-white/10">
                <th className="py-2 pr-4">Method</th><th className="py-2 pr-4">Returns</th><th className="py-2">Description</th>
              </tr>
            </thead>
            <tbody className="text-white/90">
              {[
                ['initialize()', 'Promise&lt;void&gt;', 'validate config, start the non-blocking first check'],
                ['checkForUpdate(force?)', 'UpdateCheckResult', 'the check — never throws; cached + backoff aware'],
                ['getUpdateInfo()', 'UpdateInfo | null', 'last validated metadata'],
                ['hasUpdate()', 'boolean', 'newer version available (mandatory included)'],
                ['isMandatoryUpdate()', 'boolean', 'server marked the update mandatory'],
                ['openUpdateInRxStore()', 'void', 'deep link with HTTPS fallback — never installs'],
                ['buildStoreUrl()', 'string | null', 'HTTPS store page for your app'],
                ['buildDeepLink()', 'string | null', 'rxstore://app/{slug}'],
                ['destroy()', 'void', 'release timers/listeners on shutdown'],
              ].map(([m, r, d]) => (
                <tr key={m} className="border-b border-white/5">
                  <td className="py-2 pr-4 font-mono text-rx-yellow whitespace-nowrap">{m}</td>
                  <td className="py-2 pr-4 text-rx-gray-medium whitespace-nowrap" dangerouslySetInnerHTML={{ __html: r }} />
                  <td className="py-2 text-rx-gray-medium">{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-rx-gray-medium mt-3">
          Full contract: <code className="text-rx-yellow">GET {API_BASE}/updates/check?app=&#123;slug&#125;&amp;currentVersion=&#123;semver&#125;&amp;platform=&#123;platform&#125;</code> —
          documented with every field in <Link to="/developers/docs" className="text-rx-yellow hover:underline">docs/API.md</Link>. Statuses:
          UPDATE_AVAILABLE · MANDATORY_UPDATE · NO_UPDATE · NETWORK_ERROR · INVALID_RESPONSE · APP_NOT_FOUND · UNSUPPORTED_PLATFORM · RATE_LIMITED · SERVER_ERROR.
        </p>
      </Section>

      {/* 11. Downloadable artifacts (honest) */}
      <Section id="downloads" icon={<Download className="w-5 h-5 text-rx-yellow" />} title="11 · Downloadable artifacts">
        {packages === null ? (
          <div className="card p-6 h-16 animate-pulse" />
        ) : packages.length === 0 ? (
          <div className="card p-6 text-sm text-rx-gray-medium">
            No SDK package has been published yet. The SDK is consumed from the repository (see Installation) — when a
            packaged SDK artifact is published through the normal release flow, it will appear here with real version,
            size and SHA-256 values.
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-3">
            {packages.map((pkg) => (
              <button key={pkg.id} onClick={() => download(pkg)} className="card p-4 text-left hover:border-rx-yellow/30 transition-all">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-white text-sm">{pkg.filename}</span>
                  <Download className="w-4 h-4 text-rx-yellow" />
                </div>
                <p className="text-xs text-rx-gray-medium mt-1">
                  v{pkg.version} · {pkg.platform}/{pkg.architecture} · {formatBytes(pkg.file_size)} · sha256 {pkg.sha256?.slice(0, 12)}…
                </p>
              </button>
            ))}
          </div>
        )}
        {sdk && packages && packages.length > 0 && (
          <p className="text-[11px] text-rx-gray-medium mt-2">Served by the existing marketplace download pipeline — real package rows, real checksums.</p>
        )}
      </Section>

      {/* 12. Changelog */}
      <Section id="changelog" icon={<GitBranch className="w-5 h-5 text-rx-yellow" />} title="12 · Changelog">
        <div className="text-sm text-rx-gray-medium space-y-2">
          <p><b className="text-white">v0.1.0</b> — initial SDK: core (<code>createRxStoreSDK</code>), update-check policy
          (cache / dedupe / exponential backoff), platform detection with overrides, strict deep-link builders, error
          taxonomy, optional React update banner. Update API extended with <code>mandatory</code>,
          <code> minimumSupportedVersion</code>, <code>storeUrl</code>, <code>deepLink</code>, <code>checkedAt</code> —
          one canonical endpoint, paid apps never expose binary URLs.</p>
          <p className="text-[11px]">SemVer from here on. The backend update contract is canonical across all future
          platform SDKs (Android/Kotlin, iOS/PWA guidance, desktop).</p>
        </div>
      </Section>
    </div>
  );
}
