import { API_URL, isApiConfigured } from '../../services/api';

/**
 * Welcome-intro ads — the 3-second intro screen can carry one sponsored card
 * per fresh page load. Managed from the Live Builder toolbar → Ads.
 *
 * Rotation: a persistent counter advances on every full page load, so each
 * refresh shows the next enabled ad in list order (fair, deterministic).
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

const IDX_KEY = 'rx-intro-ad-idx';

/** Round-robin pick: each full page load advances the counter by one. */
export function pickAd(ads: IntroAd[]): IntroAd | null {
  const active = (Array.isArray(ads) ? ads : []).filter((a) => a && a.enabled && typeof a.title === 'string' && a.title.trim());
  if (!active.length) return null;
  let idx = 1;
  try {
    idx = (parseInt(localStorage.getItem(IDX_KEY) || '0', 10) || 0) + 1;
    localStorage.setItem(IDX_KEY, String(idx));
  } catch { /* private mode — still show ad #1 */ }
  return active[(idx - 1) % active.length];
}

// ---------- per-device stats ----------

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
