import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Megaphone } from 'lucide-react';
import { useContent } from '../../context/ContentContext';
import { useApps } from '../../context/AppContext';
import { useEditMode } from '../edit/EditMode';
import StatsBar, { DEFAULT_STATS } from './StatsBar';
import { IntroAd, pickAd, trackAd, sanitizeAccent, INTRO_DURATION_KEY, DEFAULT_INTRO_MS, parseIntroDuration } from './introAds';

const FADE_MS = 700;

let logoIntroRequested = false;

/** The welcome/ad canvas is opt-in: only the brand logo calls this. */
export function replayWelcomeIntro() {
  logoIntroRequested = true;
  try { window.dispatchEvent(new Event('rx-replay-intro')); } catch { /* SSR-safe */ }
}

/**
 * Ad canvas is DEFINED as 16:9 (recommended creative: 1200×675 px). The image
 * is letterboxed inside the frame — always shown in FULL, never cropped — with
 * a softly blurred copy of itself filling the frame behind it.
 */
function AdImage({ src, alt, accent }: { src: string; alt: string; accent: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <div className="relative w-full aspect-video overflow-hidden bg-black/50">
      <img
        src={src}
        alt=""
        aria-hidden
        className="absolute inset-0 w-full h-full object-cover blur-2xl opacity-40 scale-125"
        onError={() => setFailed(true)}
      />
      <img
        src={src}
        alt={alt}
        className="relative w-full h-full object-contain"
        style={{ filter: `drop-shadow(0 8px 24px ${accent}22)` }}
        onError={() => setFailed(true)}
      />
    </div>
  );
}

/**
 * The default welcome hero appears only when the header brand logo is tapped.
 * Live sponsored creatives may open automatically on Home so paid placements
 * are not skipped; with no live ad, Home opens directly at Applications.
 * Every canvas fades out completely after its timer. On-screen time is admin-adjustable (Builder → Ads →
 * Intro duration, default 3s). When the admin publishes intro ads (Builder
 * toolbar → Ads), ONE sponsored card replaces the hero for that showing —
 * rotated per play, same timer, same Skip. Never in the builder.
 */
export default function WelcomeIntro() {
  const edit = useEditMode();
  const builderActive = !!edit;
  // Normal Home visits start at the application catalog. The header logo is
  // the single explicit trigger for this full-screen welcome/ad experience.
  const [enabled, setEnabled] = useState(() => {
    if (typeof window === 'undefined' || window.location.pathname !== '/' || !logoIntroRequested) return false;
    logoIntroRequested = false;
    return true;
  });
  const [phase, setPhase] = useState<'show' | 'fade'>('show');
  const [gone, setGone] = useState(false);
  // Bumped on every Home-click replay so timers + ad roll restart.
  const [replayKey, setReplayKey] = useState(0);
  const { get, getJSON, ready } = useContent();
  const { apps } = useApps();
  // Admin-adjustable on-screen time (Builder → Ads → Intro duration), default 3s.
  const introMs = parseIntroDuration(get(INTRO_DURATION_KEY, String(DEFAULT_INTRO_MS)));

  // Arm the countdown only once content has landed (so the admin's duration
  // applies on THIS viewing) — but never hold the intro hostage on a slow
  // network: after 1.2s we run with the default.
  const [contentWaitExpired, setContentWaitExpired] = useState(false);
  useEffect(() => {
    if (ready || contentWaitExpired) return;
    const t = setTimeout(() => setContentWaitExpired(true), 1200);
    return () => clearTimeout(t);
  }, [ready, contentWaitExpired]);
  const armed = ready || contentWaitExpired;

  // Ad roll: a live ad is important enough to open automatically on Home.
  // With no live ad, normal visits remain at the app grid; only a logo tap
  // enables the default welcome hero.
  const [ad, setAd] = useState<IntroAd | null>(null);
  const rolled = React.useRef(false);
  useEffect(() => {
    if (builderActive || rolled.current || !ready) return;
    rolled.current = true;
    const picked = pickAd(getJSON<IntroAd[]>('intro.ads', []));
    if (picked) {
      setAd(picked);
      setEnabled(true);
      trackAd(picked.id, 'views');
    }
  }, [enabled, builderActive, ready, replayKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Header-logo replay: full reset, fresh ad roll, then exactly one timed play.
  useEffect(() => {
    const on = () => {
      logoIntroRequested = false;
      rolled.current = false;
      setAd(null);
      setPhase('show');
      setGone(false);
      setEnabled(true);
      setReplayKey((k) => k + 1);
      try { window.scrollTo(0, 0); } catch { /* ok */ }
    };
    window.addEventListener('rx-replay-intro', on);
    return () => window.removeEventListener('rx-replay-intro', on);
  }, []);

  const btn1 = getJSON('home.hero.btn1', { label: 'Explore Applications', to: '/browse' });
  const btn2 = getJSON('home.hero.btn2', { label: 'Learn More', to: '/about' });
  const statsLabels = getJSON('home.statsLabels', DEFAULT_STATS);

  // Scroll-lock the moment the intro is on screen
  useEffect(() => {
    if (!enabled || builderActive || gone) return;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, [enabled, builderActive, gone]);

  useEffect(() => {
    if (!enabled || builderActive || gone || !armed) return;
    const fade = setTimeout(() => {
      setPhase('fade');
      // Position the applications grid under the dissolving intro
      document.getElementById('apps-section')?.scrollIntoView({ behavior: 'auto', block: 'start' });
    }, introMs);
    const remove = setTimeout(() => {
      document.body.style.overflow = '';
      setGone(true);
    }, introMs + FADE_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(remove);
    };
  }, [enabled, builderActive, gone, replayKey, armed, introMs]);

  if (!enabled || builderActive || gone) return null;

  const dismiss = () => {
    document.getElementById('apps-section')?.scrollIntoView({ behavior: 'auto', block: 'start' });
    document.body.style.overflow = '';
    setGone(true);
  };

    const accent = ad ? sanitizeAccent(ad.accent) : '#FFD600';
  const AdCta = ({ ad: a }: { ad: IntroAd }) => {
    const cls = 'inline-flex items-center gap-2 font-bold rounded-xl px-7 py-3 text-base transition-transform active:scale-95 hover:brightness-110';
    const style = { background: accent, color: '#0F1419' };
    const onClick = () => trackAd(a.id, 'clicks');
    if (a.buttonTo && /^https?:\/\//.test(a.buttonTo)) {
      return <a href={a.buttonTo} target="_blank" rel="noreferrer" className={cls} style={style} onClick={() => { onClick(); dismiss(); }}>{a.buttonLabel || 'Learn more'} ↗</a>;
    }
    return <Link to={a.buttonTo || '/'} className={cls} style={style} onClick={onClick}>{a.buttonLabel || 'Learn more'}</Link>;
  };

  return (
    <div
      className={`fixed inset-0 z-[100] bg-rx-dark overflow-hidden transition-opacity ease-out ${phase === 'fade' ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
      style={{ transitionDuration: `${FADE_MS}ms` }}
      role="dialog"
      aria-label={ad ? 'Sponsored' : 'Welcome to RX Store'}
    >
      {/* Same backdrop treatment as the hero */}
      <div className="absolute inset-0 bg-gradient-hero" />
      <div className="absolute top-0 left-1/4 w-96 h-96 bg-rx-yellow/5 rounded-full blur-3xl animate-float" />
      <div className="absolute bottom-0 right-1/4 w-80 h-80 bg-rx-yellow/3 rounded-full blur-3xl animate-float" style={{ animationDelay: '-3s' }} />

      {ad ? (
        /* ================= SPONSORED CARD (rotates per refresh) ================= */
        <div className="relative h-full section-container flex flex-col items-center justify-center overflow-y-auto py-16">
          <div className="w-full max-w-xl animate-slide-up">
            <div
              className="rounded-3xl border bg-rx-dark-secondary/85 backdrop-blur-xl overflow-hidden"
              style={{ borderColor: `${accent}4D`, boxShadow: `0 30px 90px -30px ${accent}66` }}
            >
              {ad.imageUrl && <AdImage src={ad.imageUrl} alt={ad.title} accent={accent} />}
              <div className="p-7 sm:p-9 text-center">
                <span
                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest"
                  style={{ background: `${accent}1F`, color: accent }}
                >
                  <Megaphone className="w-3 h-3" /> Sponsored{ad.sponsor ? ` · ${ad.sponsor}` : ''}
                </span>
                <h2 className="text-3xl sm:text-4xl font-black text-white mt-4 leading-tight">{ad.title}</h2>
                {ad.body && <p className="mt-3 text-rx-gray-medium leading-relaxed whitespace-pre-line">{ad.body}</p>}
                <div className="mt-7">
                  <AdCta ad={ad} />
                </div>
              </div>
            </div>
            <p className="text-center text-[11px] text-white/30 mt-4">
              {get('intro.ads.footNote', 'Advertisement — keeps RX Store free for everyone')}
            </p>
          </div>
        </div>
      ) : (
        /* ================= DEFAULT WELCOME HERO (no ads published) ================= */
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
      )}

      {/* Skip + 3s progress */}
      <button
        onClick={dismiss}
        className="absolute bottom-8 right-6 sm:right-10 text-xs font-semibold text-rx-gray-medium hover:text-rx-yellow transition-colors flex items-center gap-1"
      >
        {ad ? get('intro.ads.skipLabel', 'Skip ad') : 'Skip intro'} <ArrowRight className="w-3.5 h-3.5" />
      </button>
      <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-white/5">
        {armed && (
          <div
            key={`${replayKey}-${introMs}`}
            className="h-full"
            style={{ background: accent, animation: `rx-intro-progress ${introMs}ms linear forwards` }}
          />
        )}
      </div>
      <style>{`@keyframes rx-intro-progress { from { width: 0% } to { width: 100% } }`}</style>
    </div>
  );
}
