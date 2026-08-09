import React, { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import toast from 'react-hot-toast';
import { API_URL, isApiConfigured } from '../services/api';

/**
 * Site Content — every public text/link/image/design-token lives here.
 * Visitors: read-only (published values). Admins (in the Builder): per-item
 * immediate publish; failures queue locally for Publish All.
 */

type ContentMap = Record<string, string>;
type PendingItem = { key: string; value: string; at: number };

interface ContentCtxType {
  get: (id: string, fallback?: string) => string;
  getJSON: <T = any>(id: string, fallback: T) => T;
  /** Like get/getJSON but fall back to the value the page currently shows
   *  (registered by render sites) — so editors always open PRE-FILLED. */
  getEffective: (id: string, hardFallback?: string) => string;
  getEffectiveJSON: <T = any>(id: string, hardFallback: T) => T;
  save: (id: string, value: string | object) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  /** Update local state only (e.g. after a server-side revert) — no network. */
  applyLocal: (id: string, value: string) => void;
  pending: PendingItem[];
  publishAll: () => Promise<void>;
  saving: string | null;
  savedAt: Record<string, number>;
  ready: boolean;
}

const ContentContext = createContext<ContentCtxType | undefined>(undefined);

const PENDING_KEY = 'rx-content-pending';
const loadPending = (): PendingItem[] => {
  try { const a = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
};

// Design tokens applied as CSS variables (channel triplets for Tailwind v3)
function applyDesignTokens(content: ContentMap) {
  if (typeof document === 'undefined') return;
  const hexToTriplet = (hex: string) => {
    const m = hex.trim().replace('#', '');
    if (!/^[0-9a-f]{6}$/i.test(m)) return null;
    return `${parseInt(m.slice(0, 2), 16)} ${parseInt(m.slice(2, 4), 16)} ${parseInt(m.slice(4, 6), 16)}`;
  };
  const setVar = (name: string, hex?: string) => {
    const el = document.documentElement;
    if (!hex) { el.style.removeProperty(name); return; }
    const t = hexToTriplet(hex);
    if (t) el.style.setProperty(name, t);
  };
  setVar('--rx-yellow', content['design.brandColor']);
  setVar('--rx-yellow-light', content['design.brandColorLight']);
  setVar('--rx-yellow-dark', content['design.brandColorDark']);
  setVar('--rx-dark', content['design.bgColor']);
  setVar('--rx-dark-secondary', content['design.surfaceColor']);
  setVar('--rx-dark-tertiary', content['design.surfaceColor2']);
}

let memoryCache: { at: number; map: ContentMap } | null = null;

export function invalidatePublicContent() { memoryCache = null; }

export function ContentProvider({ children }: { children: ReactNode }) {
  const [content, setContent] = useState<ContentMap>({});
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState<PendingItem[]>(loadPending());
  const [saving, setSaving] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Record<string, number>>({});
  // Every render site's fallback, so the Inspector can pre-fill with the text
  // the visitor currently sees (instead of an empty box) — updated per render.
  const defaultsRef = React.useRef<Record<string, any>>({});

  const fetchContent = useCallback(async () => {
    if (!isApiConfigured()) { setReady(true); return; }
    if (memoryCache && Date.now() - memoryCache.at < 30_000) {
      setContent((c) => ({ ...memoryCache!.map, ...overlayPending(c) }));
      setReady(true);
      return;
    }
    try {
      const res = await fetch(`${API_URL}/content`);
      const j = await res.json();
      const map: ContentMap = (j?.data && typeof j.data === 'object') ? j.data : {};
      memoryCache = { at: Date.now(), map };
      setContent((c) => ({ ...map, ...overlayPending(c) }));
    } catch { /* keep fallbacks */ }
    setReady(true);
  }, []);

  // Pending (unpublished) edits stay visible to the editing admin
  const overlayPending = (c: ContentMap): ContentMap => {
    const o: ContentMap = {};
    for (const p of loadPending()) o[p.key] = p.value;
    return o;
  };

  useEffect(() => { fetchContent(); }, [fetchContent]);
  useEffect(() => { applyDesignTokens(content); }, [content]);
  useEffect(() => { try { localStorage.setItem(PENDING_KEY, JSON.stringify(pending)); } catch {} }, [pending]);

  const get = useCallback((id: string, fallback = '') => {
    if (fallback !== undefined && fallback !== null) defaultsRef.current[id] = fallback;
    const v = content[id];
    return v === undefined || v === null || v === '' ? fallback : v;
  }, [content]);

  const getJSON = useCallback(<T,>(id: string, fallback: T): T => {
    if (fallback !== undefined && fallback !== null) defaultsRef.current[id] = fallback;
    const v = content[id];
    if (!v) return fallback;
    if (typeof v !== 'string') return v as T;
    try { return JSON.parse(v) as T; } catch { return fallback; }
  }, [content]);

  const getEffective = useCallback((id: string, hardFallback = '') => {
    const v = content[id];
    if (v !== undefined && v !== null && v !== '') return v;
    const d = defaultsRef.current[id];
    return d !== undefined ? String(d) : hardFallback;
  }, [content]);

  const getEffectiveJSON = useCallback(<T,>(id: string, hardFallback: T): T => {
    const v = content[id];
    if (v) {
      if (typeof v !== 'string') return v as T;
      try { return JSON.parse(v) as T; } catch { /* fall through */ }
    }
    const d = defaultsRef.current[id];
    return d !== undefined ? (d as T) : hardFallback;
  }, [content]);

  const pushOne = useCallback(async (key: string, value: string): Promise<boolean> => {
    if (!isApiConfigured()) throw new Error('API not configured');
    const token = localStorage.getItem('rx-store-token') || '';
    const res = await fetch(`${API_URL}/admin/content`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ content: { [key]: value } }),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || j?.success === false) throw new Error(j?.error?.message || `Publish failed (${res.status})`);
    invalidatePublicContent();
    return true;
  }, []);

  // Immediate publish, with durable pending queue as the safety net
  const save = useCallback(async (id: string, value: string | object): Promise<boolean> => {
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    setSaving(id);
    setContent((c) => ({ ...c, [id]: str })); // optimistic
    try {
      await pushOne(id, str);
      setPending((p) => p.filter((x) => x.key !== id));
      setSavedAt((s) => ({ ...s, [id]: Date.now() }));
      return true;
    } catch (e: any) {
      setPending((p) => [...p.filter((x) => x.key !== id), { key: id, value: str, at: Date.now() }]);
      toast.error(`Couldn't publish — kept in pending queue. ${e.message}`);
      return false;
    } finally {
      setSaving(null);
    }
  }, [pushOne]);

  const remove = useCallback(async (id: string): Promise<boolean> => save(id, ''), [save]);

  const applyLocal = useCallback((id: string, value: string) => {
    setContent((c) => ({ ...c, [id]: value }));
  }, []);

  const publishAll = useCallback(async () => {
    const items = loadPending();
    if (!items.length) { toast.success('Nothing pending'); return; }
    let failed = 0;
    for (const item of items) {
      try { await pushOne(item.key, item.value); setPending((p) => p.filter((x) => x.key !== item.key)); setSavedAt((s) => ({ ...s, [item.key]: Date.now() })); }
      catch { failed++; }
    }
    if (failed) toast.error(`${failed} item(s) still couldn't publish — they stay queued.`);
    else { toast.success('All pending changes are live 🚀'); fetchContent(); }
  }, [pushOne, fetchContent]);

  return (
    <ContentContext.Provider value={{ get, getJSON, getEffective, getEffectiveJSON, save, remove, applyLocal, pending, publishAll, saving, savedAt, ready }}>
      {children}
    </ContentContext.Provider>
  );
}

export function useContent() {
  const ctx = useContext(ContentContext);
  if (!ctx) throw new Error('useContent must be used within ContentProvider');
  return ctx;
}
