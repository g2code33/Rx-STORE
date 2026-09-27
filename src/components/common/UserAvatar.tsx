/**
 * UserAvatar — renders a user avatar correctly for BOTH account kinds:
 *   - social accounts (Google / GitHub) → the provider's picture URL → <img>
 *   - password accounts → the emoji/text value (legacy behaviour)
 *
 * A picture URL that fails to load (offline, provider outage, deleted image)
 * degrades gracefully to the emoji fallback instead of a broken-image icon —
 * the same honest-fallback principle used across the app.
 */
import { useState } from 'react';
import { isImageAvatar, avatarFallbackText } from '../../utils/avatar.ts';

type Props = {
  /** The user.avatar value (emoji/text for password accounts, URL for social). */
  avatar?: string | null;
  /** User name — used for accessible alt text. */
  name?: string | null;
  /** Container classes: size + rounding + background (e.g. "w-8 h-8 rounded-lg bg-rx-dark-tertiary"). */
  className?: string;
  /** Classes for the emoji/text fallback (e.g. "text-lg"). */
  textClassName?: string;
};

export default function UserAvatar({ avatar, name, className = '', textClassName = '' }: Props) {
  const [broken, setBroken] = useState(false);
  const src = isImageAvatar(avatar) ? String(avatar).trim() : null;

  return (
    <div className={`overflow-hidden flex items-center justify-center shrink-0 ${className}`}>
      {src && !broken ? (
        <img
          src={src}
          alt={name ? `${name}'s avatar` : 'User avatar'}
          className="w-full h-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
        />
      ) : (
        <span className={textClassName} role="img" aria-label="User avatar">
          {avatarFallbackText(avatar)}
        </span>
      )}
    </div>
  );
}
