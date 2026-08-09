import toast from 'react-hot-toast';
import { API_URL, isApiConfigured } from '../services/api';
import { DownloadOption, SELF_APP_SLUG, storeDownloadPath } from './downloads';

/**
 * Download a platform build of the RX Store app — served by the STORE ITSELF.
 * Same flow as every app listing: ask the API for the file's R2 URL (counts a
 * download), then navigate to it. Errors mean the admin hasn't uploaded that
 * platform yet (or the worker needs a redeploy) and are surfaced as toasts.
 */
export async function startStoreDownload(opt: DownloadOption): Promise<boolean> {
  if (!isApiConfigured()) {
    toast.error('Store API not configured — try again shortly.');
    return false;
  }
  const t = toast.loading(`Preparing ${opt.platform} download…`);
  try {
    const r = await fetch(`${API_URL}${storeDownloadPath(opt.platformId)}`);
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.success) {
      const msg = j?.error?.message || 'Download unavailable';
      if (r.status === 404) throw new Error(`Not uploaded yet — open the RX Store listing while the admin publishes this platform.`);
      throw new Error(msg);
    }
    const url = j?.data?.url;
    if (!url) throw new Error('No file attached to this platform yet.');
    toast.success(`Downloading for ${opt.platform} — ${opt.ext} ${opt.size}`, { id: t });
    window.location.href = url; // same-origin R2 binary — the browser downloads it
    return true;
  } catch (e: any) {
    toast.error(e?.message || 'Download failed — try again shortly.', { id: t });
    return false;
  }
}

/** Listing info for the RX Store entry (null = admin hasn't published it yet). */
export interface SelfListing {
  name: string;
  version: string;
  icon: string;
  rating: number;
  downloads: number;
}

export async function fetchSelfListing(): Promise<SelfListing | null> {
  if (!isApiConfigured()) return null;
  try {
    const r = await fetch(`${API_URL}/apps/${SELF_APP_SLUG}`);
    const j = await r.json().catch(() => null);
    const a = j?.data?.app || j?.data || null;
    if (!r.ok || !j?.success || !a?.slug) return null;
    return {
      name: a.name || 'RX Store',
      version: a.current_version || a.version || '1.0.0',
      icon: a.icon || '',
      rating: a.rating || 0,
      downloads: a.download_count || a.downloadCount || 0,
    };
  } catch {
    return null;
  }
}
