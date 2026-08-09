import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Shield, Zap, Globe, Download, Star, Users, Cpu, Heart, GraduationCap, Gamepad2 } from 'lucide-react';
import { useApps } from '../context/AppContext';
import AppCard from '../components/apps/AppCard';
import { useContent } from '../context/ContentContext';
import Editable from '../components/edit/Editable';
import { useCategories } from '../hooks/useCategories';
import StatsBar, { DEFAULT_STATS } from '../components/home/StatsBar';
import WelcomeIntro from '../components/home/WelcomeIntro';
import PageBlocks from '../components/edit/PageBlocks';
import PlatformIcon from '../icons/PlatformIcon';

const HOME_PLATFORM_FILTERS = [
  { id: 'all', label: 'All', icon: '✨' },
  { id: 'android', label: 'Android', icon: '🤖' },
  { id: 'ios', label: 'iOS', icon: '🍎' },
  { id: 'windows', label: 'Windows', icon: '🪟' },
  { id: 'linux', label: 'Linux', icon: '🐧' },
  { id: 'web', label: 'Web', icon: '🌐' },
];

const DEFAULT_PLATFORM_CARDS = [
  { name: 'Web', icon: '🌐', desc: 'Any browser' },
  { name: 'Windows', icon: '🪟', desc: 'Win 10+' },
  { name: 'Linux', icon: '🐧', desc: 'Ubuntu/Debian' },
  { name: 'Android', icon: '🤖', desc: 'Android 8+' },
  { name: 'iOS', icon: '🍎', desc: 'iOS 15+' },
];

const FEATURE_ICONS: Record<string, React.ComponentType<{ className?: string; style?: React.CSSProperties }>> = {
  shield: Shield, zap: Zap, globe: Globe, download: Download, users: Users, star: Star,
};

const DEFAULT_FEATURES = [
  { icon: 'shield', title: 'Enterprise Security', description: 'HIPAA-compliant infrastructure with end-to-end encryption and regular security audits.', color: '#FF6B6B' },
  { icon: 'zap', title: 'Lightning Fast', description: 'Optimized delivery with CDN distribution for instant downloads and seamless updates.', color: '#FFD600' },
  { icon: 'globe', title: 'Cross-Platform', description: 'One account, every device. Sync your apps and preferences across all platforms.', color: '#4ECDC4' },
  { icon: 'download', title: 'Auto Updates', description: 'Stay current with automatic background updates. Never miss an important feature.', color: '#45B7D1' },
  { icon: 'users', title: 'Community Driven', description: 'Join thousands of healthcare professionals who trust RX Store for their essential tools.', color: '#96CEB4' },
  { icon: 'star', title: 'Curated Quality', description: 'Every application undergoes rigorous review to meet our standards for quality and reliability.', color: '#DDA0DD' },
];

/** "Web" → web, "iOS" → ios, … so card names resolve to icon slot ids */
function platformCardIconId(name: string): string {
  const n = String(name || '').toLowerCase();
  if (n.includes('web')) return 'web';
  if (n.includes('win')) return 'windows';
  if (n.includes('linux') || n.includes('ubuntu') || n.includes('debian')) return 'linux';
  if (n.includes('android')) return 'android';
  if (n.includes('ios') || n.includes('apple') || n.includes('mac')) return n.includes('mac') ? 'macos' : 'ios';
  return '';
}

/** Renders internal paths with router Links, external URLs with anchors. */
function CLink({ to, className, children }: { to: string; className?: string; children: React.ReactNode }) {
  if (/^https?:\/\//.test(to)) return <a href={to} target="_blank" rel="noreferrer" className={className}>{children}</a>;
  return <Link to={to || '/'} className={className}>{children}</Link>;
}

export default function Home() {
  const { apps, isLoading } = useApps();
  const { get, getJSON } = useContent();
  const categories = useCategories();
  const [platform, setPlatform] = useState('all');
  const platformApps = platform === 'all' ? apps : apps.filter((a: any) => (a.platforms || []).includes(platform));
  // Real trending: admin-flagged apps first, then by actual download count.
  const trending = [...apps]
    .sort((a, b) =>
      Number((b as any).isTrending ? 1 : 0) - Number((a as any).isTrending ? 1 : 0) ||
      (b.downloadCount || 0) - (a.downloadCount || 0) ||
      (b.rating || 0) - (a.rating || 0)
    )
    .slice(0, 6);
  const categoryCount = (id: string) => apps.filter((a) => a.category === id).length;

  const btn1 = getJSON('home.hero.btn1', { label: 'Explore Applications', to: '/browse' });
  const btn2 = getJSON('home.hero.btn2', { label: 'Learn More', to: '/about' });
  const statsLabels = getJSON('home.statsLabels', DEFAULT_STATS);
  const platformCards = getJSON('home.platformCards', DEFAULT_PLATFORM_CARDS);
  const features = getJSON('home.features', DEFAULT_FEATURES);
  const ctaBtn1 = getJSON('home.cta.btn1', { label: 'Get Started Free', to: '/browse' });
  const ctaBtn2 = getJSON('home.cta.btn2', { label: 'Create Account', to: '/login' });

  return (
    <div className="min-h-screen">
      {/* 5-second welcome hero on fresh visits — then dissolves into the apps */}
      <WelcomeIntro />
      {/* Hero Section */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-hero" />
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-rx-yellow/5 rounded-full blur-3xl animate-float" />
        <div className="absolute bottom-0 right-1/4 w-80 h-80 bg-rx-yellow/3 rounded-full blur-3xl animate-float" style={{ animationDelay: '-3s' }} />
        <div className="absolute inset-0 opacity-[0.02]" style={{
          backgroundImage: 'linear-gradient(rgba(255,214,0,0.3) 1px, transparent 1px), linear-gradient(90deg, rgba(255,214,0,0.3) 1px, transparent 1px)',
          backgroundSize: '60px 60px'
        }} />

        <div className="relative section-container pt-32 pb-20 lg:pt-40 lg:pb-28">
          <div className="text-center max-w-4xl mx-auto">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-rx-yellow/10 border border-rx-yellow/20 mb-8 animate-fade-in">
              <div className="w-2 h-2 bg-rx-yellow rounded-full animate-pulse" />
              <span className="text-xs font-medium text-rx-yellow">
                <Editable id="home.hero.badge" label="Hero badge">{get('home.hero.badge', 'Platform v1.0 — Now Available')}</Editable>
              </span>
            </div>

            <h1 className="text-4xl sm:text-5xl lg:text-7xl font-black text-white leading-tight animate-slide-up">
              <Editable id="home.hero.l1" label="Hero line 1">{get('home.hero.l1', 'The Future of')}</Editable>
              <br />
              <span className="gradient-text">
                <Editable id="home.hero.l2" label="Hero line 2 (gradient)">{get('home.hero.l2', 'Healthcare Apps')}</Editable>
              </span>
              <br />
              <Editable id="home.hero.l3" label="Hero line 3">{get('home.hero.l3', 'Starts Here')}</Editable>
            </h1>

            <p className="mt-6 text-lg sm:text-xl text-rx-gray-medium max-w-2xl mx-auto leading-relaxed animate-slide-up text-balance" style={{ animationDelay: '0.1s' }}>
              <Editable id="home.hero.subtitle" type="textarea" label="Hero subtitle">
                {get('home.hero.subtitle', 'Discover, download, and manage premium applications for healthcare, education, productivity, and technology — all in one professional marketplace.')}
              </Editable>
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mt-10 animate-slide-up" style={{ animationDelay: '0.2s' }}>
              <Editable id="home.hero.btn1" type="link" label="Primary button">
                <CLink to={btn1.to} className="btn-primary text-base flex items-center gap-2 group">
                  {btn1.label}
                  <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                </CLink>
              </Editable>
              <Editable id="home.hero.btn2" type="link" label="Secondary button">
                <CLink to={btn2.to} className="btn-secondary text-base">{btn2.label}</CLink>
              </Editable>
            </div>

            <Editable id="home.statsLabels" type="statsLabels" label="Hero stat labels" group>
              <StatsBar apps={apps} labels={statsLabels} />
            </Editable>
          </div>
        </div>

        <div className="absolute bottom-0 left-0 right-0 h-24 bg-gradient-to-t from-rx-dark to-transparent" />
      </section>

      {/* Ecosystem Apps — visible immediately, with platform quick-filters */}
      {/* Alias anchor: builder-saved buttons pointing at /#docs land here */}
      <span id="docs" aria-hidden className="block scroll-mt-20" />
      <section id="apps-section" className="section-container py-14 scroll-mt-16">
        <div className="text-center mb-8">
          <h2 className="text-3xl sm:text-4xl font-bold text-white">
            <Editable id="home.apps.titleA" label="Apps section title (part 1)">{get('home.apps.titleA', 'Our')}</Editable>{' '}
            <span className="gradient-text"><Editable id="home.apps.titleB" label="Apps section title (highlight)">{get('home.apps.titleB', 'Applications')}</Editable></span>
          </h2>
          <p className="mt-3 text-rx-gray-medium max-w-xl mx-auto">
            <Editable id="home.apps.sub" type="textarea" label="Apps section subtitle">{get('home.apps.sub', 'A curated collection of professional-grade tools built for modern healthcare, education, and technology needs.')}</Editable>
          </p>
        </div>

        <div className="flex items-center justify-center gap-2 flex-wrap mb-10">
          {HOME_PLATFORM_FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setPlatform(f.id)}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-medium border transition-all ${
                platform === f.id
                  ? 'bg-rx-yellow text-rx-dark border-rx-yellow shadow-glow'
                  : 'bg-rx-dark-tertiary/60 text-rx-gray-medium border-white/10 hover:text-white hover:border-rx-yellow/40'
              }`}
            >
              {f.id === 'all' ? <span>{f.icon}</span> : <PlatformIcon id={f.id} className="text-sm leading-none" imgClassName="w-4 h-4 inline-block" />} {f.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {isLoading && apps.length === 0
            ? Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="card p-5 h-44 animate-pulse bg-rx-dark-tertiary/40" />
              ))
            : platformApps.slice(0, 8).map((app) => (
                <AppCard key={app.id} app={app} />
              ))}
          {!isLoading && platformApps.length === 0 && (
            <div className="col-span-full text-center py-12 text-rx-gray-medium">
              <p className="text-3xl mb-2">📦</p>
              <p>No apps for this platform yet — check back soon.</p>
            </div>
          )}
        </div>
      </section>

      {/* Categories */}
      <section className="section-container py-20">
        <div className="flex items-center justify-between mb-10">
          <div>
            <h2 className="text-2xl sm:text-3xl font-bold text-white">
              <Editable id="home.cats.title" label="Categories heading">{get('home.cats.title', 'Browse by Category')}</Editable>
            </h2>
            <p className="mt-2 text-rx-gray-medium"><Editable id="home.cats.sub" label="Categories subheading">{get('home.cats.sub', 'Find the right tools for your needs')}</Editable></p>
          </div>
          <Link to="/categories" className="text-sm text-rx-yellow hover:underline flex items-center gap-1">
            View all <ArrowRight className="w-4 h-4" />
          </Link>
        </div>

        <Editable id="site.categories" type="categories" label="Store categories" group>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
            {categories.map((cat: any) => {
              const IconMap: Record<string, React.ComponentType<{ className?: string; style?: React.CSSProperties }>> = {
                Heart, GraduationCap, Zap, Cpu, Gamepad2, Users,
              };
              const Icon = IconMap[cat.icon] || Globe;
              return (
                <Link
                  key={cat.id}
                  to={`/categories/${cat.id}`}
                  className="card-hover p-5 text-center group"
                >
                  <div className="w-12 h-12 rounded-xl mx-auto mb-3 flex items-center justify-center" style={{ backgroundColor: `${cat.color}20` }}>
                    <Icon className="w-6 h-6" style={{ color: cat.color }} />
                  </div>
                  <h3 className="text-sm font-semibold text-white group-hover:text-rx-yellow transition-colors">
                    {cat.name}
                  </h3>
                  <p className="text-xs text-rx-gray-medium mt-1">{categoryCount(cat.id)} {categoryCount(cat.id) === 1 ? 'app' : 'apps'}</p>
                </Link>
              );
            })}
          </div>
        </Editable>
      </section>

      {/* Trending — real apps from D1, no fabricated stats */}
      {trending.length > 0 && (
        <section className="section-container py-20">
          <div className="flex items-center justify-between mb-10">
            <div>
              <h2 className="text-2xl sm:text-3xl font-bold text-white flex items-center gap-2">
                <Editable id="home.trending.title" label="Trending heading">{get('home.trending.title', '🔥 Trending Now')}</Editable>
              </h2>
              <p className="mt-2 text-rx-gray-medium"><Editable id="home.trending.sub" label="Trending subheading">{get('home.trending.sub', 'Most popular applications this week')}</Editable></p>
            </div>
            <Link to="/browse" className="text-sm text-rx-yellow hover:underline flex items-center gap-1">
              See all <ArrowRight className="w-4 h-4" />
            </Link>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {trending.map((app) => (
              <AppCard key={app.id} app={app} />
            ))}
          </div>
        </section>
      )}

      {/* Platform Availability */}
      <section className="section-container py-20">
        <div className="card p-8 sm:p-12 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-80 h-80 bg-rx-yellow/5 rounded-full blur-3xl" />
          <div className="relative">
            <div className="text-center mb-10">
              <h2 className="text-3xl sm:text-4xl font-bold text-white">
                <Editable id="home.plat.titleA" label="Platforms title (part 1)">{get('home.plat.titleA', 'Available on')}</Editable>{' '}
                <span className="gradient-text"><Editable id="home.plat.titleB" label="Platforms title (highlight)">{get('home.plat.titleB', 'Every Platform')}</Editable></span>
              </h2>
              <p className="mt-3 text-rx-gray-medium max-w-xl mx-auto">
                <Editable id="home.plat.sub" type="textarea" label="Platforms subtitle">{get('home.plat.sub', 'Access RX Store from any device. Our applications work seamlessly across web, desktop, and mobile platforms.')}</Editable>
              </p>
            </div>

            <Editable id="home.platformCards" type="platformCards" label="Platform cards" group>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
              {platformCards.map((p: any) => (
                <div key={p.name} className="text-center p-4 rounded-xl bg-rx-dark-tertiary/50 border border-white/5 hover:border-rx-yellow/20 transition-all">
                  {platformCardIconId(p.name)
                    ? <PlatformIcon id={platformCardIconId(p.name)} className="text-3xl leading-none" imgClassName="w-9 h-9 inline-block" />
                    : <span className="text-3xl">{p.icon}</span>}
                  <p className="text-sm font-semibold text-white mt-2">{p.name}</p>
                    <p className="text-xs text-rx-gray-medium">{p.desc}</p>
                  </div>
                ))}
              </div>
            </Editable>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="section-container py-20">
        <div className="text-center mb-12">
          <h2 className="text-3xl sm:text-4xl font-bold text-white">
            <Editable id="home.why.titleA" label="Why-Choose title (part 1)">{get('home.why.titleA', 'Why Choose')}</Editable>{' '}
            <span className="gradient-text"><Editable id="home.why.titleB" label="Why-Choose title (highlight)">{get('home.why.titleB', 'RX Store?')}</Editable></span>
          </h2>
          <p className="mt-3 text-rx-gray-medium max-w-xl mx-auto">
            <Editable id="home.why.sub" type="textarea" label="Why-Choose subtitle">{get('home.why.sub', 'Built with security, performance, and user experience at the core.')}</Editable>
          </p>
        </div>

        <Editable id="home.features" type="features" label="Why-Choose feature cards" group>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map((feature: any) => {
              const FIcon = FEATURE_ICONS[feature.icon] || Star;
              return (
                <div key={feature.title} className="card p-6 group hover:border-rx-yellow/20">
                  <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-4" style={{ backgroundColor: `${feature.color}15` }}>
                    <FIcon className="w-6 h-6" style={{ color: feature.color }} />
                  </div>
                  <h3 className="text-lg font-semibold text-white group-hover:text-rx-yellow transition-colors">
                    {feature.title}
                  </h3>
                  <p className="text-sm text-rx-gray-medium mt-2 leading-relaxed">{feature.description}</p>
                </div>
              );
            })}
          </div>
        </Editable>
      </section>

      {/* CTA */}
      <section className="section-container py-20">
        <div className="relative rounded-3xl overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-r from-rx-yellow/20 via-rx-yellow/10 to-transparent" />
          <div className="absolute inset-0 bg-rx-dark-secondary/80 backdrop-blur-sm" />
          <div className="relative px-8 py-16 sm:px-16 sm:py-20 text-center">
            <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
              <Editable id="home.cta.title" label="CTA heading">{get('home.cta.title', 'Ready to Transform Your Workflow?')}</Editable>
            </h2>
            <p className="text-rx-gray-medium max-w-lg mx-auto mb-8">
              <Editable id="home.cta.sub" type="textarea" label="CTA subtitle">{get('home.cta.sub', 'Join thousands of professionals who trust RX Store for their essential applications. Start exploring today.')}</Editable>
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Editable id="home.cta.btn1" type="link" label="CTA primary button">
                <CLink to={ctaBtn1.to} className="btn-primary text-base flex items-center gap-2 group">
                  {ctaBtn1.label}
                  <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                </CLink>
              </Editable>
              <Editable id="home.cta.btn2" type="link" label="CTA secondary button">
                <CLink to={ctaBtn2.to} className="btn-outline text-base">{ctaBtn2.label}</CLink>
              </Editable>
            </div>
          </div>
        </div>
      </section>

      {/* Custom sections inserted via Builder → Add Block */}
      <PageBlocks pageId="home" />
    </div>
  );
}
