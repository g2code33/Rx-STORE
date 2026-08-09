import { useEffect } from 'react';
import { useContent } from '../context/ContentContext';
import { isImageIcon, resolveIcon, iconContentKey, PLATFORM_ICON_FALLBACKS } from './platformIcons';

/**
 * The ONE way to render a platform icon — reads Admin → Icons settings live.
 * Emoji values render as text, uploaded PNGs as <img>.
 */
export default function PlatformIcon({
  id,
  className = 'text-base leading-none',
  imgClassName = 'w-5 h-5 inline-block',
}: {
  id: keyof typeof PLATFORM_ICON_FALLBACKS | string;
  className?: string;
  imgClassName?: string;
}) {
  const { get } = useContent();
  const v = resolveIcon(get(iconContentKey(`platform.${id}`), ''), `platform.${id}`);
  if (isImageIcon(v)) return <img src={v} alt="" draggable={false} className={`${imgClassName} object-contain`} />;
  return <span className={className} role="img" aria-hidden>{v}</span>;
}

/** Current value of any icon slot (brand.logo, brand.favicon, …) with its fallback. */
export function useSiteIcon(slotId: string, fallback: string): string {
  const { get } = useContent();
  return resolveIcon(get(iconContentKey(slotId), ''), slotId) || fallback;
}

/** Applies the admin's favicon / apple-touch icon to the live document head. */
export function FaviconSync() {
  const { get, ready } = useContent();
  useEffect(() => {
    if (!ready || typeof document === 'undefined') return;
    const fav = get(iconContentKey('brand.favicon'), '/favicon.png') || '/favicon.png';
    const touch = get(iconContentKey('brand.appleTouch'), '/icon-192.png') || '/icon-192.png';
    document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]').forEach((l) => { l.href = fav; });
    let touchLink = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
    if (!touchLink) {
      touchLink = document.createElement('link');
      touchLink.rel = 'apple-touch-icon';
      document.head.appendChild(touchLink);
    }
    touchLink.href = touch;
  }, [get, ready]);
  return null;
}
