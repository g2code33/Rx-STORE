/**
 * Header navigation — defaults + a merge that guarantees the Advertise page
 * (sponsor booking) is ALWAYS reachable from the header, even when the admin
 * previously saved a custom nav in the builder without it. Pure module.
 */

export interface NavLink {
  label: string;
  to: string;
}

export const ADVERTISE_LINK: NavLink = { label: 'Advertise', to: '/advertise' };

export const DEFAULT_NAV: NavLink[] = [
  { label: 'Home', to: '/' },
  { label: 'Browse', to: '/browse' },
  { label: 'Categories', to: '/categories' },
  { label: 'Advertise', to: '/advertise' },
  { label: 'About', to: '/about' },
];

export function mergeNavLinks(links?: NavLink[] | null): NavLink[] {
  const list = (Array.isArray(links) && links.length ? links : DEFAULT_NAV).filter(
    (l): l is NavLink => !!l && typeof l.to === 'string' && typeof l.label === 'string' && !!l.to
  );
  const seen = new Set<string>();
  const out: NavLink[] = [];
  for (const l of list) {
    if (seen.has(l.to)) continue; // first occurrence wins — no dupes
    seen.add(l.to);
    out.push({ label: l.label, to: l.to });
  }
  if (!seen.has(ADVERTISE_LINK.to)) {
    // Slot Advertise right before About when there is one, else append.
    const i = out.findIndex((l) => l.to === '/about');
    if (i >= 0) out.splice(i, 0, { ...ADVERTISE_LINK });
    else out.push({ ...ADVERTISE_LINK });
  }
  return out;
}
