import React from 'react';
import { useEditMode, EditType } from './EditMode';
import { useContent } from '../../context/ContentContext';

interface EditableProps {
  id: string;
  type?: EditType;
  label: string;
  children: React.ReactNode;
  className?: string;
  /** Collection editor: outline the whole block instead of inline text */
  group?: boolean;
}

export interface StyleOverrides {
  color?: string; bg?: string; fontSize?: string; fontWeight?: string;
  align?: string; opacity?: number; pad?: string; radius?: string;
  width?: string; center?: boolean;
  hideMobile?: boolean; hideTablet?: boolean; hideDesktop?: boolean;
  theme?: '' | 'accent' | 'muted' | 'card';
}

const FONT_SIZES: Record<string, string> = { xs: '0.75rem', sm: '0.875rem', base: '1rem', lg: '1.25rem', xl: '1.5rem', '2xl': '2rem' };
const PADS: Record<string, string> = { none: '0', sm: '0.5rem', md: '1rem', lg: '1.5rem', xl: '2rem' };
const RADII: Record<string, string> = { none: '0', sm: '0.375rem', md: '0.75rem', lg: '1rem', full: '9999px' };

/** Overrides → inline style + classes for the wrapper (visitor-rendered too). */
export function applyOverrides(ov: StyleOverrides, block: boolean): { style: React.CSSProperties; cls: string; boxy: boolean } {
  const style: React.CSSProperties = {};
  const cls: string[] = [];
  let boxy = block; // needs a boxing display for bg/pad/width/center to matter
  if (ov.color) { style.color = ov.color; }
  if (ov.bg) { style.background = ov.bg.startsWith('#') ? ov.bg : ov.bg; boxy = true; }
  if (ov.fontSize) style.fontSize = FONT_SIZES[ov.fontSize] || ov.fontSize;
  if (ov.fontWeight) style.fontWeight = ov.fontWeight;
  if (ov.align) { style.textAlign = ov.align as any; boxy = true; }
  if (ov.opacity !== undefined && ov.opacity !== null && ov.opacity < 1) style.opacity = ov.opacity;
  if (ov.pad && ov.pad !== 'none') { style.padding = PADS[ov.pad] || ov.pad; boxy = true; }
  if (ov.radius && ov.radius !== 'none') { style.borderRadius = RADII[ov.radius] || ov.radius; boxy = true; }
  if (ov.width) { style.width = ov.width; boxy = true; }
  if (ov.center) { style.marginLeft = 'auto'; style.marginRight = 'auto'; boxy = true; }
  if (ov.theme === 'accent') style.color = 'rgb(var(--rx-yellow, 255 214 0))';
  if (ov.theme === 'muted') style.color = '#8899AA';
  if (ov.theme === 'card') {
    style.background = 'rgb(var(--rx-dark-secondary, 26 35 50))';
    style.padding = style.padding || PADS.md;
    style.borderRadius = style.borderRadius || RADII.md;
    style.border = '1px solid rgba(255,255,255,0.08)';
    boxy = true;
  }
  if (ov.hideMobile) cls.push('max-sm:hidden');
  if (ov.hideTablet) cls.push('md:max-lg:hidden');
  if (ov.hideDesktop) cls.push('lg:hidden');
  return { style, cls: cls.join(' '), boxy };
}

export function hasOverrides(ov: any): boolean {
  return !!ov && typeof ov === 'object' && Object.keys(ov).length > 0;
}

/**
 * Wraps any piece of public content. For visitors it renders children untouched
 * — unless the admin published style overrides for it, which apply to everyone.
 * In Builder Edit mode every element gets a dashed outline + name tag (their
 * reference editor style); clicking opens the Inspector for that exact content.
 */
export default function Editable({ id, type = 'text', label, children, className = '', group = false }: EditableProps) {
  const edit = useEditMode();
  const { getJSON } = useContent();
  const overrides = getJSON<StyleOverrides | null>(`style.${id}`, null);
  const styled = hasOverrides(overrides);
  const chrome = !!edit && edit.editMode && !edit.interact;

  if (!chrome && !styled) return <>{children}</>;

  const { style, cls, boxy } = styled ? applyOverrides(overrides!, group) : { style: {}, cls: '', boxy: group };
  const Tag: any = 'span'; // span-safe everywhere (incl. inside <p>/<h1>); display via class
  const boxCls = boxy ? (group ? 'block' : 'inline-block') : '';

  if (!chrome) {
    // Visitor view with published styling only
    return <Tag className={`${cls} ${boxCls} ${className}`} style={style}>{children}</Tag>;
  }

  return (
    <Tag
      className={`rx-ed ${group ? 'rx-ed-group' : ''} ${boxCls} ${cls} ${className}`}
      style={style}
      role="button"
      title={`Edit — ${label}`}
      onClickCapture={(e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        edit.openInspector({ id, type, label });
      }}
    >
      <span className="rx-ed-tag">{label}</span>
      {children}
    </Tag>
  );
}
