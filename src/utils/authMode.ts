/**
 * Auth mode derivation for the /login page — the URL is the single source of
 * truth.
 *
 * WHY this exists: the header renders "Sign In" -> /login and
 * "Get Started" -> /login?mode=register. Both point at the SAME route, so
 * React Router keeps the Login page mounted and only the query string
 * changes. A mount-only useState initializer never re-runs in that case, so
 * the header buttons appeared dead after the first navigation ("Get Started
 * does nothing", "Sign In does nothing after clicking Get Started").
 * Deriving the mode from the URL on every render keeps header links, the
 * in-page toggle and browser back/forward all consistent.
 */
export type AuthMode = 'login' | 'register';

/**
 * Map a search string / URLSearchParams to the auth mode.
 * Unknown or missing values fall back to login — the mode is never guessed.
 */
export function authModeFromSearch(
  search: string | URLSearchParams | null | undefined,
): AuthMode {
  if (!search) return 'login';
  const value =
    typeof search === 'string'
      ? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('mode')
      : search.get('mode');
  return value === 'register' ? 'register' : 'login';
}
