import { categories as staticCategories } from '../data/apps';
import { useContent } from '../context/ContentContext';

/**
 * Categories come from the site-content store when the admin has edited them
 * in the Live Website Builder; otherwise the built-in defaults. Counts are
 * always computed live by consumers (never stored).
 */
export function useCategories(): any[] {
  const { getJSON } = useContent();
  const stored = getJSON<any[]>('site.categories', null as any);
  if (Array.isArray(stored) && stored.length) return stored;
  return staticCategories;
}
