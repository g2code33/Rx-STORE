import React from 'react';

/**
 * The ONE safe way to render an app logo anywhere in the app:
 * - URL icons render as <img> (lazy), with onError fallback;
 * - fallback is the emoji icon, or the app's initial on its gradient —
 *   a URL is NEVER printed as text and a broken image never shows.
 */
export default function AppLogo({
  app,
  size = 'w-14 h-14',
  text = 'text-2xl',
  rounded = 'rounded-2xl',
  className = '',
}: {
  app: any;
  size?: string;
  text?: string;
  rounded?: string;
  className?: string;
}) {
  const icon: string = app?.icon || '';
  const isUrl = icon.startsWith('http') || icon.startsWith('/') || icon.startsWith('data:');
  const [failed, setFailed] = React.useState(false);

  if (isUrl && !failed) {
    return (
      <img
        src={icon}
        alt={app?.name || 'App logo'}
        loading="lazy"
        draggable={false}
        onError={() => setFailed(true)}
        className={`${size} ${rounded} object-cover shadow-lg flex-shrink-0 ${className}`}
      />
    );
  }

  const fallback = isUrl
    ? (app?.name || '?').trim().charAt(0).toUpperCase()
    : icon || (app?.name || '?').trim().charAt(0).toUpperCase();

  return (
    <div
      className={`${size} ${rounded} bg-gradient-to-br ${app?.gradient || 'from-rx-yellow/70 to-amber-700/70'} flex items-center justify-center ${text} shadow-lg flex-shrink-0 ${className}`}
    >
      {fallback}
    </div>
  );
}
