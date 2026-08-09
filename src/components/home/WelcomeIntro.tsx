import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useContent } from '../../context/ContentContext';
import { useApps } from '../../context/AppContext';
import { useEditMode } from '../edit/EditMode';
import StatsBar, { DEFAULT_STATS } from './StatsBar';

const INTRO_MS = 3000;
const FADE_MS = 700;

// Once per FULL page load (module state resets on refresh) — so the intro
// plays on every fresh open/refresh, but not on in-app navigation back Home.
let introShownThisLoad = false;

/**
 * Fresh-open welcome hero: the exact hero (same content ids, so builder edits
 * apply) fills the screen for 3 seconds on every refresh, then fades out —
 * revealing the Applications grid scrolled into view. A Skip control and a
 * thin progress bar keep it honest, and it never appears inside the builder.
 * (Ad space candidate later.)
 */
export default function WelcomeIntro() {
  const edit = useEditMode();
  const builderActive = !!edit;
  const [enabled] = useState(() => {
    if (typeof window === 'undefined' || window.location.pathname !== '/') return false;
    if (introShownThisLoad) return false;
    introShownThisLoad = true;
    return true;
  });
  const [phase, setPhase] = useState<'show' | 'fade'>('show');
  const [gone, setGone] = useState(false);
  const { get, getJSON } = useContent();
  const { apps } = useApps();

  const btn1 = getJSON('home.hero.btn1', { label: 'Explore Applications', to: '/browse' });
  const btn2 = getJSON('home.hero.btn2', { label: 'Learn More', to: '/about' });
  const statsLabels = getJSON('home.statsLabels', DEFAULT_STATS);

  useEffect(() => {
    if (!enabled || builderActive || gone) return;
    document.body.style.overflow = 'hidden';
    const fade = setTimeout(() => {
      setPhase('fade');
      // Position the applications grid under the dissolving hero
      document.getElementById('apps-section')?.scrollIntoView({ behavior: 'auto', block: 'start' });
    }, INTRO_MS);
    const remove = setTimeout(() => {
      document.body.style.overflow = '';
      setGone(true);
    }, INTRO_MS + FADE_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(remove);
      document.body.style.overflow = '';
    };
  }, [enabled, builderActive, gone]);

  if (!enabled || builderActive || gone) return null;

  const dismiss = () => {
    document.getElementById('apps-section')?.scrollIntoView({ behavior: 'auto', block: 'start' });
    document.body.style.overflow = '';
    setGone(true);
  };

  return (
    <div
      className={`fixed inset-0 z-[100] bg-rx-dark overflow-hidden transition-opacity ease-out ${phase === 'fade' ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
      style={{ transitionDuration: `${FADE_MS}ms` }}
      role="dialog"
      aria-label="Welcome to RX Store"
    >
      {/* Same backdrop treatment as the hero */}
      <div className="absolute inset-0 bg-gradient-hero" />
      <div className="absolute top-0 left-1/4 w-96 h-96 bg-rx-yellow/5 rounded-full blur-3xl animate-float" />
      <div className="absolute bottom-0 right-1/4 w-80 h-80 bg-rx-yellow/3 rounded-full blur-3xl animate-float" style={{ animationDelay: '-3s' }} />

      <div className="relative h-full section-container flex flex-col items-center justify-center text-center overflow-y-auto py-16">
        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-rx-yellow/10 border border-rx-yellow/20 mb-8 animate-fade-in">
          <div className="w-2 h-2 bg-rx-yellow rounded-full animate-pulse" />
          <span className="text-xs font-medium text-rx-yellow">{get('home.hero.badge', 'Platform v1.0 — Now Available')}</span>
        </div>

        <h1 className="text-4xl sm:text-5xl lg:text-7xl font-black text-white leading-tight animate-slide-up">
          {get('home.hero.l1', 'The Future of')}
          <br />
          <span className="gradient-text">{get('home.hero.l2', 'Healthcare Apps')}</span>
          <br />
          {get('home.hero.l3', 'Starts Here')}
        </h1>

        <p className="mt-6 text-lg sm:text-xl text-rx-gray-medium max-w-2xl leading-relaxed animate-slide-up text-balance" style={{ animationDelay: '0.1s' }}>
          {get('home.hero.subtitle', 'Discover, download, and manage premium applications for healthcare, education, productivity, and technology — all in one professional marketplace.')}
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mt-10 animate-slide-up" style={{ animationDelay: '0.2s' }}>
          <Link to={btn1.to || '/browse'} className="btn-primary text-base flex items-center gap-2 group">
            {btn1.label}
            <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
          </Link>
          <Link to={btn2.to || '/about'} className="btn-secondary text-base">{btn2.label}</Link>
        </div>

        <div className="w-full max-w-2xl">
          <StatsBar apps={apps} labels={statsLabels} />
        </div>
      </div>

      {/* Skip + 5s progress */}
      <button
        onClick={dismiss}
        className="absolute bottom-8 right-6 sm:right-10 text-xs font-semibold text-rx-gray-medium hover:text-rx-yellow transition-colors flex items-center gap-1"
      >
        Skip intro <ArrowRight className="w-3.5 h-3.5" />
      </button>
      <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-white/5">
        <div
          className="h-full bg-rx-yellow"
          style={{ animation: `rx-intro-progress ${INTRO_MS}ms linear forwards` }}
        />
      </div>
      <style>{`@keyframes rx-intro-progress { from { width: 0% } to { width: 100% } }`}</style>
    </div>
  );
}
