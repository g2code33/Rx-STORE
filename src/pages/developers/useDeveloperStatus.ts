/**
 * Developer status hook + intelligent destination routing (Phase 11 §14).
 *
 * One source of truth for "where should a developer link take THIS user":
 *   signed out            -> /developers (info + sign-in CTA)
 *   not a developer       -> /developers/apply (Become a Developer)
 *   draft / submitted /   -> /developers/status
 *   under review / changes requested / rejected
 *   approved (active)     -> /developers/center
 *   suspended             -> /developers/status (restricted view + comms)
 */
import { useEffect, useState } from 'react';
import { api, isApiConfigured } from '../../services/api';
import { useAuth } from '../../context/AuthContext';

export interface DeveloperStatusState {
  status: string;
  application: any | null;
  developer: any | null;
}

let cache: { at: number; userId?: string; data: DeveloperStatusState } | null = null;
const CACHE_MS = 30_000;

/** Fetch (lightly cached) developer status for the signed-in user. */
export async function fetchDeveloperStatus(userId?: string, force = false): Promise<DeveloperStatusState | null> {
  if (!isApiConfigured()) return null;
  if (!force && cache && cache.userId === userId && Date.now() - cache.at < CACHE_MS) return cache.data;
  try {
    const data = await api.developers.status();
    cache = { at: Date.now(), userId, data };
    return data;
  } catch {
    return null;
  }
}

export function clearDeveloperStatusCache() {
  cache = null;
}

/** Where a "Developer" link should send the current user. */
export function developerDestination(status: string | null | undefined): string {
  switch (status) {
    case 'APPROVED': return '/developers/center';
    case 'SUSPENDED': return '/developers/status';
    case 'DRAFT':
    case 'SUBMITTED':
    case 'UNDER_REVIEW':
    case 'CHANGES_REQUESTED':
    case 'REJECTED':
    case 'NOT_APPLIED':
      return status === 'NOT_APPLIED' ? '/developers/apply' : '/developers/status';
    default:
      return '/developers';
  }
}

/** React hook: developer status for the signed-in user (null while loading). */
export function useDeveloperStatus() {
  const { user } = useAuth();
  const initial: DeveloperStatusState | null =
    cache && cache.userId === user?.id ? cache.data : null;
  const [state, setState] = useState<DeveloperStatusState | null>(initial);
  const [loading, setLoading] = useState<boolean>(() => !!user && isApiConfigured());

  useEffect(() => {
    if (!user || !isApiConfigured()) { setState(null); setLoading(false); return; }
    let alive = true;
    setLoading(true);
    fetchDeveloperStatus(user.id).then((d) => {
      if (alive) { setState(d || { status: 'NOT_APPLIED', application: null, developer: null }); setLoading(false); }
    });
    return () => { alive = false; };
  }, [user?.id]);

  return { status: state, loading };
}
