/**
 * /developers/docs — API documentation (Phase 20).
 *
 * Documents ONLY the endpoints that actually exist in this deployment (each
 * section is backed by the dispatch code in backend/src/index.ts). No
 * aspirational APIs. Code blocks are copyable.
 */
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Terminal, KeyRound, Gauge, AlertTriangle, Webhook, Copy } from 'lucide-react';
import { API_URL } from '../../services/api';
import toast from 'react-hot-toast';

const SECTIONS = ['authentication', 'apps', 'community', 'analytics', 'webhooks', 'errors', 'rate-limits'] as const;
type Section = (typeof SECTIONS)[number];

function Code({ children }: { children: string }) {
  return (
    <div className="relative group">
      <pre className="bg-rx-dark-tertiary/70 border border-white/10 rounded-xl p-4 text-xs text-rx-gray-medium overflow-x-auto whitespace-pre">{children}</pre>
      <button
        onClick={() => { navigator.clipboard?.writeText(children); toast.success('Copied'); }}
        className="absolute top-2 right-2 p-1.5 rounded-lg bg-white/5 text-rx-gray-medium hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
        aria-label="Copy"
      ><Copy className="w-3.5 h-3.5" /></button>
    </div>
  );
}

export default function DeveloperDocs() {
  const [section, setSection] = useState<Section>('authentication');
  const base = API_URL || 'https://rx-store-api.calcitoninpay.workers.dev/v1';

  return (
    <div className="section-container max-w-4xl py-8 md:py-12">
      <Link to="/developers" className="inline-flex items-center gap-1.5 text-sm text-rx-gray-medium hover:text-white transition-colors">
        <ArrowLeft className="w-4 h-4" /> Developer Portal
      </Link>
      <h1 className="text-3xl font-black text-white mt-4">API Documentation</h1>
      <p className="text-rx-gray-medium mt-2 text-sm">
        The real RX Store developer APIs — every endpoint below exists in this deployment. Base URL:
      </p>
      <div className="mt-2"><Code>{base}</Code></div>

      {/* Section nav */}
      <div className="flex gap-1 bg-rx-dark-secondary rounded-xl p-1 w-fit mt-6 overflow-x-auto max-w-full">
        {SECTIONS.map((id) => (
          <button key={id} onClick={() => setSection(id)}
            className={`px-3.5 py-2 rounded-lg text-xs sm:text-sm font-medium transition-all whitespace-nowrap capitalize ${section === id ? 'bg-rx-yellow text-rx-dark' : 'text-rx-gray-medium hover:text-white'}`}>
            {id.replace('-', ' ')}
          </button>
        ))}
      </div>

      <div className="mt-6 space-y-6">
        {section === 'authentication' && (
          <>
            <h2 className="text-xl font-bold text-white flex items-center gap-2"><KeyRound className="w-5 h-5 text-rx-yellow" /> Authentication</h2>
            <div className="card p-5 space-y-4 text-sm text-rx-gray-medium">
              <p><b className="text-white">User JWT</b> — the token from signing in. Use for Developer Center endpoints (create apps, releases, submissions, analytics).</p>
              <Code>{`Authorization: Bearer <jwt>`}</Code>
              <p><b className="text-white">Developer API tokens</b> — scoped, revocable tokens for programmatic access. Create them in Developer Center → Settings → API tokens (Owner/Admin roles). The token is shown once; only its hash is stored.</p>
              <Code>{`Authorization: Bearer rxs_...`}</Code>
              <p>Token scopes: <code className="text-rx-yellow">analytics.read</code>, <code className="text-rx-yellow">apps.read</code>, <code className="text-rx-yellow">releases.read</code>.</p>
            </div>
          </>
        )}

        {section === 'apps' && (
          <>
            <h2 className="text-xl font-bold text-white flex items-center gap-2"><Terminal className="w-5 h-5 text-rx-yellow" /> Storefront & community APIs</h2>
            <div className="card p-5 space-y-4 text-sm text-rx-gray-medium">
              <p><b className="text-white">Public catalog</b> (no auth):</p>
              <Code>{`# List published apps (search, filters, pagination)
GET ${base}/apps?search=cgpa&platform=windows&sort=popular&page=1

# App detail (metadata, versions, sizes, native identity)
GET ${base}/apps/clinic

# Factual related-apps discovery
GET ${base}/apps/related/clinic

# Download manifest (free apps; paid apps need an entitlement)
GET ${base}/apps/clinic/download?platform=windows&arch=x64`}</Code>
              <p><b className="text-white">Developer Center</b> (JWT, role-checked server-side):</p>
              <Code>{`GET  ${base}/developers/me                     # application status + org summary
GET  ${base}/developers/organization            # apps, releases, stats
POST ${base}/developers/apps                    # create draft app
POST ${base}/developers/apps/:id/releases       # create draft release
POST ${base}/developers/releases/:id/packages   # upload package (multipart)
POST ${base}/developers/releases/:id/submit     # submit for review
GET  ${base}/developers/submissions             # submission status`}</Code>
              <p><b className="text-white">Community</b> (reads public; posts need sign-in):</p>
              <Code>{`GET  ${base}/community/categories
GET  ${base}/community/discussions?category=general
GET  ${base}/community/discussions/:id
POST ${base}/community/discussions              { "categoryId": "cc_general", "title": "…", "body": "…" }
POST ${base}/community/discussions/:id/replies  { "body": "…" }`}</Code>
            </div>
          </>
        )}

        {section === 'analytics' && (
          <>
            <h2 className="text-xl font-bold text-white flex items-center gap-2"><Terminal className="w-5 h-5 text-rx-yellow" /> Analytics APIs</h2>
            <div className="card p-5 space-y-4 text-sm text-rx-gray-medium">
              <p><b className="text-white">Web (JWT, analytics.view)</b> — aggregated org analytics:</p>
              <Code>{`GET ${base}/developers/analytics`}</Code>
              <p><b className="text-white">API token</b> (analytics.read scope) — lightweight app metrics:</p>
              <Code>{`curl -H "Authorization: Bearer rxs_..." ${base}/api/v1/apps

# Response
{ "success": true, "data": { "developerId": "dev_…", "apps": [
  { "slug": "clinic", "version": "2.0.0", "downloads": 20, "rating": 5, "reviews": 1 } ] } }`}</Code>
            </div>
          </>
        )}

        {section === 'webhooks' && (
          <>
            <h2 className="text-xl font-bold text-white flex items-center gap-2"><Webhook className="w-5 h-5 text-rx-yellow" /> Webhooks</h2>
            <div className="card p-5 space-y-4 text-sm text-rx-gray-medium">
              <p><b className="text-white">Paystack payment events</b> (marketplace purchases — configured by RX Store, documented for transparency):</p>
              <Code>{`POST ${base.slice(0, base.lastIndexOf('/v1'))}/payments/webhook/paystack
# Signature: x-paystack-signature = HMAC-SHA512(raw body, secret)
# Events handled: charge.success, refund.processed
# Processing is idempotent (duplicate events are ignored).`}</Code>
              <p className="text-xs text-rx-gray-medium/70">Developer-specific webhooks (release status changes) are delivered through the Developer Center communication threads today; event-push webhooks are not yet available and are not claimed here.</p>
            </div>
          </>
        )}

        {section === 'errors' && (
          <>
            <h2 className="text-xl font-bold text-white flex items-center gap-2"><AlertTriangle className="w-5 h-5 text-rx-yellow" /> Errors</h2>
            <div className="card p-5 space-y-3 text-sm text-rx-gray-medium">
              <Code>{`{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",     // machine-readable
    "message": "Human explanation",  // never internals
    "requestId": "req_…"             // correlation id (also X-Request-Id)
  }
}`}</Code>
              <p>Common codes: <code className="text-rx-yellow">AUTH_REQUIRED</code> (401), <code className="text-rx-yellow">FORBIDDEN</code> (403 — role/scope), <code className="text-rx-yellow">NOT_FOUND</code> (404), <code className="text-rx-yellow">VALIDATION_ERROR</code> (400), <code className="text-rx-yellow">RATE_LIMITED</code> (429), <code className="text-rx-yellow">PURCHASE_REQUIRED</code> (402), <code className="text-rx-yellow">DOWNLOAD_EXPIRED</code> (410).</p>
            </div>
          </>
        )}

        {section === 'rate-limits' && (
          <>
            <h2 className="text-xl font-bold text-white flex items-center gap-2"><Gauge className="w-5 h-5 text-rx-yellow" /> Rate limits</h2>
            <div className="card p-5 text-sm text-rx-gray-medium">
              <div className="space-y-1.5">
                {[
                  ['Auth endpoints', '10–20 / minute'],
                  ['Community posts', '20 / minute (5 posts / hour)'],
                  ['Developer API tokens (/api/v1)', '120 / minute'],
                  ['Reviews', '20 / minute'],
                  ['Default', '300 / minute'],
                ].map(([what, limit]) => (
                  <div key={what} className="flex justify-between border-b border-white/5 pb-1.5">
                    <span>{what}</span><span className="text-white">{limit}</span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-rx-gray-medium/70 mt-3">Limits are per identity (user id or IP) over a sliding window. Exceeding them returns <code className="text-rx-yellow">RATE_LIMITED</code> (429).</p>
            </div>
          </>
        )}
      </div>

      <div className="flex flex-wrap gap-3 mt-10">
        <Link to="/developers/submit" className="btn-primary text-sm">Submit an app</Link>
        <Link to="/developers/sdk" className="btn-secondary text-sm">SDK downloads</Link>
        <Link to="/developers/community" className="btn-secondary text-sm">Community</Link>
      </div>
    </div>
  );
}
