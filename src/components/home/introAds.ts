import { API_URL, isApiConfigured } from '../../services/api';

/**
 * Welcome-intro ads — sponsored creatives used by the welcome intro AND the
 * Sponsored banner blocks. Managed from the Live Builder toolbar → Ads.
 *
 * Scheduling: optional start/end dates bound when an ad is eligible to show
 * (intro rotation AND banner placements honour it).
 * Rotation: a persistent counter advances on every full page load — fair,
 * deterministic round-robin through the live ads.
 * Stats: views & clicks beaconed to the worker (server totals, all devices)
 * plus a per-device mirror shown in the editor.
 */

export interface IntroAd {
  id: string;
  enabled: boolean;
  title: string;
  body?: string;
  imageUrl?: string;
  sponsor?: string;
  buttonLabel?: string;
  buttonTo?: string;
  /** #RRGGBB — button/border/glow tint; defaults to the brand yellow */
  accent?: string;
  /** Optional schedule window — 'YYYY-MM-DD' (local) or full ISO */
  startsAt?: string;
  endsAt?: string;
}

export function newIntroAd(): IntroAd {
  return {
    id: `ad-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    enabled: true,
    title: 'Your product here',
    body: 'Reach every RX Store visitor — right on the welcome screen.',
    imageUrl: '',
    sponsor: '',
    buttonLabel: 'Learn more',
    buttonTo: 'https://',
    accent: '#FFD600',
  };
}

export function sanitizeAccent(hex?: string): string {
  return hex && /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#FFD600';
}

// ---------------- scheduling ----------------

/** Date-only input is local: start begins 00:00, end includes until 23:59:59.999. */
function parseAdDate(v: string | undefined, isEnd: boolean): number | null {
  const s = (v || '').trim();
  if (!s) return null;
  let t: number;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    t = new Date(`${s}T${isEnd ? '23:59:59.999' : '00:00:00.000'}`).getTime();
  } else {
    t = new Date(s).getTime();
  }
  return Number.isFinite(t) ? t : null;
}

/** Is this ad inside its schedule window right now (or unwindowed)? */
export function isAdLive(ad: Pick<IntroAd, 'startsAt' | 'endsAt'> | null | undefined, now: Date = new Date()): boolean {
  if (!ad) return false;
  const t = now.getTime();
  const start = parseAdDate(ad.startsAt, false);
  if (start !== null && t < start) return false;
  const end = parseAdDate(ad.endsAt, true);
  if (end !== null && t > end) return false;
  return true;
}

/** Human window status for the editor. */
export function adWindowLabel(ad: IntroAd, now: Date = new Date()): string {
  const start = parseAdDate(ad.startsAt, false);
  const end = parseAdDate(ad.endsAt, true);
  if (start === null && end === null) return 'Always on';
  const t = now.getTime();
  if (start !== null && t < start) return `Starts ${ad.startsAt}`;
  if (end !== null && t > end) return `Ended ${ad.endsAt}`;
  return `Live${end !== null ? ` until ${ad.endsAt}` : ''}`;
}

/** Keep only the date part for <input type="date">. */
export function dateForInput(v?: string): string {
  return (v || '').slice(0, 10);
}

// ---------------- rotation ----------------

const IDX_KEY = 'rx-intro-ad-idx';

/** Round-robin pick: each full page load advances the counter by one. */
export function pickAd(ads: IntroAd[]): IntroAd | null {
  const live = (Array.isArray(ads) ? ads : []).filter((a) => a && a.enabled && typeof a.title === 'string' && a.title.trim() && isAdLive(a));
  if (!live.length) return null;
  let idx = 1;
  try {
    idx = (parseInt(localStorage.getItem(IDX_KEY) || '0', 10) || 0) + 1;
    localStorage.setItem(IDX_KEY, String(idx));
  } catch { /* private mode — still show ad #1 */ }
  return live[(idx - 1) % live.length];
}

// ---------------- per-device stats ----------------

export interface AdStat { views: number; clicks: number }
type AdStats = Record<string, AdStat>;
const STATS_KEY = 'rx-intro-ad-stats';

export function readAdStats(): AdStats {
  try {
    const j = JSON.parse(localStorage.getItem(STATS_KEY) || '{}');
    return j && typeof j === 'object' ? j : {};
  } catch { return {}; }
}

export function trackAd(id: string, field: keyof AdStat) {
  try {
    const s = readAdStats();
    const cur = Object.assign({ views: 0, clicks: 0 } as AdStat, s[id]);
    cur[field] += 1;
    s[id] = cur;
    localStorage.setItem(STATS_KEY, JSON.stringify(s));
  } catch { /* non-critical */ }
  // Server beacon — one tiny POST, fire-and-forget (keeps running on nav away)
  if (isApiConfigured()) {
    try {
      fetch(`${API_URL}/ads/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, type: field === 'views' ? 'view' : 'click' }),
        keepalive: true,
      }).catch(() => {});
    } catch { /* offline — local mirror still counts */ }
  }
}

/** Server-side totals for every ad (admin editor uses this). */
export async function fetchAdServerStats(): Promise<Record<string, AdStat>> {
  if (!isApiConfigured()) return {};
  try {
    const token = localStorage.getItem('rx-store-token') || '';
    const res = await fetch(`${API_URL}/admin/ads/stats`, { headers: { Authorization: `Bearer ${token}` } });
    const j = await res.json();
    const out: Record<string, AdStat> = {};
    for (const r of j?.data?.stats || []) out[r.ad_id] = { views: Number(r.views) || 0, clicks: Number(r.clicks) || 0 };
    return out;
  } catch { return {}; }
}

// ---------------- sponsor share links (admin side) ----------------

export interface SponsorShare { token: string; ad_id: string; label: string; created_at?: string }

export function sponsorUrl(token: string): string {
  return `${typeof window !== 'undefined' ? window.location.origin : ''}/sponsor/${token}`;
}

async function adminAdsFetch(path: string, init?: RequestInit): Promise<any> {
  if (!isApiConfigured()) throw new Error('API not configured');
  const token = localStorage.getItem('rx-store-token') || '';
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init?.headers || {}) },
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message || `Request failed (${res.status})`);
  return j?.data;
}

export async function createSponsorShare(adId: string, label: string): Promise<SponsorShare | null> {
  return (await adminAdsFetch('/admin/ads/shares', { method: 'POST', body: JSON.stringify({ adId, label }) })) as SponsorShare | null;
}

export async function listSponsorShares(): Promise<SponsorShare[]> {
  const d = await adminAdsFetch('/admin/ads/shares');
  return Array.isArray(d?.shares) ? d.shares : [];
}

export async function revokeSponsorShare(token: string): Promise<void> {
  await adminAdsFetch(`/admin/ads/shares/${token}`, { method: 'DELETE' });
}

// ---------------- sponsor dashboard (public, token-gated) ----------------

export interface SponsorStats {
  adId: string;
  label: string;
  createdAt?: string;
  views: number;
  clicks: number;
  ctr: number;
  daily: { day: string; views: number; clicks: number }[];
}

export async function fetchSponsorStats(token: string): Promise<SponsorStats | null> {
  if (!isApiConfigured()) return null;
  try {
    const res = await fetch(`${API_URL}/ads/public/${token}`);
    if (!res.ok) return null;
    const j = await res.json();
    return (j?.data as SponsorStats) || null;
  } catch { return null; }
}
