import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, X, Star, ArrowRight, LayoutGrid } from 'lucide-react';
import { useApps } from '../../context/AppContext';
import { useCategories } from '../../hooks/useCategories';
import AppLogo from '../apps/AppLogo';
import { rankSuggestions, SearchHit } from './searchCore';

/**
 * The ONE search box used in the header (desktop + the mobile popover row) and
 * on /browse. Typing opens a live prediction dropdown right below the box —
 * matching apps and categories, arrow-key navigable. Enter (or the footer row)
 * opens Browse with the query applied; picking a suggestion goes straight to it.
 */

interface SearchBoxProps {
  placeholder?: string;
  /** sm = compact header size, lg = page-size (Browse). */
  size?: 'sm' | 'lg';
  autoFocus?: boolean;
  className?: string;
  /** Called after navigation (mobile row uses it to collapse itself). */
  onNavigate?: () => void;
}

/** Bolds the matched substring inside a suggestion title. */
function Highlight({ text, q }: { text: string; q: string }) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0 || !q) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <span className="text-rx-yellow">{text.slice(i, i + q.length)}</span>
      {text.slice(i + q.length)}
    </>
  );
}

export default function SearchBox({ placeholder = 'Search applications...', size = 'lg', autoFocus = false, className = '', onNavigate }: SearchBoxProps) {
  const { apps, searchQuery, setSearchQuery } = useApps();
  const categories = useCategories();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const q = searchQuery.trim();
  const hits = useMemo(() => (q ? rankSuggestions(apps, categories, q, 7) : []), [apps, categories, q]);
  const showPanel = open && q.length > 0;

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) { setOpen(false); setActive(-1); }
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const go = (to: string) => {
    setOpen(false);
    setActive(-1);
    onNavigate?.();
    navigate(to);
  };

  /** Pick a suggestion: jump straight to it (search context is cleared so Browse stays unfiltered). */
  const pick = (h: SearchHit) => {
    if (h.kind === 'app') setSearchQuery('');
    go(h.to);
  };

  /** Open Browse and run the actual search there. */
  const submit = () => {
    if (!q) return;
    go(`/browse?q=${encodeURIComponent(q)}`);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' && hits.length) {
      e.preventDefault();
      setOpen(true);
      setActive((a) => (a + 1) % hits.length);
    } else if (e.key === 'ArrowUp' && hits.length) {
      e.preventDefault();
      setActive((a) => (a <= 0 ? hits.length - 1 : a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0 && hits[active]) pick(hits[active]);
      else submit();
    } else if (e.key === 'Escape') {
      setOpen(false);
      setActive(-1);
      inputRef.current?.blur();
    }
  };

  const sm = size === 'sm';
  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      <Search className={`absolute left-3 top-1/2 -translate-y-1/2 text-rx-gray-medium pointer-events-none ${sm ? 'w-4 h-4' : 'w-5 h-5 left-4'}`} />
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={showPanel}
        aria-controls="rx-search-hits"
        aria-activedescendant={active >= 0 ? `rx-search-hit-${active}` : undefined}
        aria-label="Search applications"
        placeholder={placeholder}
        value={searchQuery}
        autoFocus={autoFocus}
        onChange={(e) => { setSearchQuery(e.target.value); setOpen(true); setActive(-1); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className={`w-full bg-rx-dark-tertiary border border-white/10 rounded-xl text-white placeholder-rx-gray-medium focus:outline-none focus:border-rx-yellow/50 focus:ring-1 focus:ring-rx-yellow/25 transition-all ${
          sm ? 'pl-10 pr-9 py-2.5 text-sm' : 'pl-12 pr-10 py-3.5'
        }`}
      />
      {searchQuery && (
        <button
          type="button"
          onClick={() => { setSearchQuery(''); setActive(-1); inputRef.current?.focus(); }}
          className={`absolute top-1/2 -translate-y-1/2 text-rx-gray-medium hover:text-white transition-colors ${sm ? 'right-3' : 'right-4'}`}
          aria-label="Clear search"
        >
          <X className="w-4 h-4" />
        </button>
      )}

      {showPanel && (
        <div
          id="rx-search-hits"
          role="listbox"
          className="absolute left-0 right-0 top-full mt-2 z-[70] rounded-2xl border border-white/10 bg-rx-dark-secondary shadow-2xl shadow-black/60 overflow-hidden animate-slide-down"
        >
          {hits.length > 0 ? (
            <ul className="max-h-80 overflow-y-auto py-1.5">
              {hits.map((h, i) => (
                <li key={h.id} id={`rx-search-hit-${i}`} role="option" aria-selected={active === i}>
                  <button
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(h)}
                    className={`w-full flex items-center gap-3 px-3.5 py-2 text-left transition-colors ${active === i ? 'bg-white/5' : ''}`}
                  >
                    {h.kind === 'app' && h.app ? (
                      <AppLogo app={h.app} size="w-9 h-9" text="text-base" rounded="rounded-lg" />
                    ) : (
                      <div
                        className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
                        style={{ backgroundColor: `${h.catColor || '#FFD600'}1A` }}
                      >
                        <LayoutGrid className="w-4 h-4" style={{ color: h.catColor || '#FFD600' }} />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-white truncate">
                        <Highlight text={h.title} q={q} />
                      </p>
                      <p className="text-[11px] text-rx-gray-medium truncate">{h.sub}</p>
                    </div>
                    {h.kind === 'app' && h.app ? (
                      <span className="flex items-center gap-1 text-[11px] text-rx-gray-medium flex-shrink-0">
                        <Star className="w-3 h-3 text-rx-yellow fill-current" />
                        {h.app.rating}
                      </span>
                    ) : (
                      <ArrowRight className="w-3.5 h-3.5 text-rx-gray-medium flex-shrink-0" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-3 text-xs text-rx-gray-medium">
              No quick matches — press Enter to search everything for “{q}”.
            </p>
          )}
          <button
            type="button"
            onClick={submit}
            className="w-full flex items-center justify-between gap-2 px-4 py-2.5 text-xs font-semibold text-rx-yellow hover:bg-rx-yellow/10 border-t border-white/5 transition-colors"
          >
            <span className="truncate">Search all apps for “{q}”</span>
            <ArrowRight className="w-3.5 h-3.5 flex-shrink-0" />
          </button>
        </div>
      )}
    </div>
  );
}
