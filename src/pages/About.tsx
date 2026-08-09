import React from 'react';
import { Link } from 'react-router-dom';
import { Shield, Globe, Users, Cpu, Zap, ArrowRight, Check } from 'lucide-react';
import { useContent } from '../context/ContentContext';
import Editable from '../components/edit/Editable';

const DEFAULT_VISION_POINTS = [
  'Healthcare-grade security and compliance',
  'Cross-platform availability on all devices',
  'Seamless integration between applications',
  'AI-powered features and recommendations',
  'Continuous updates and improvements',
];

const DEFAULT_ABOUT_APPS = [
  { icon: '🏥', name: 'Clinical Rx', desc: 'Clinical decision support' },
  { icon: '💊', name: 'PharmaGAME', desc: 'Pharmaceutical education' },
  { icon: '💻', name: 'Code Rx Society', desc: 'Healthcare development' },
  { icon: '👥', name: 'TAWOMO', desc: 'Workforce management' },
  { icon: '🔗', name: 'CureLink', desc: 'Patient communication' },
];

const ARCH_ICONS: Record<string, React.ComponentType<{ className?: string; style?: React.CSSProperties }>> = {
  globe: Globe, cpu: Cpu, zap: Zap, shield: Shield, users: Users,
};

const DEFAULT_ARCH_PLATFORMS = [
  { icon: 'globe', name: 'Web App', desc: 'React + TypeScript' },
  { icon: 'cpu', name: 'Windows', desc: 'Tauri' },
  { icon: 'cpu', name: 'Linux', desc: 'Tauri + AppImage' },
  { icon: 'zap', name: 'Mobile', desc: 'Flutter' },
];

const DEFAULT_STACK = [
  { title: 'Frontend', items: ['React 18', 'TypeScript', 'Tailwind CSS', 'Framer Motion', 'React Router'], color: '#FFD600' },
  { title: 'Desktop', items: ['Tauri (Rust)', 'Cross-platform', 'Auto-updater', 'System tray', 'Offline mode'], color: '#4ECDC4' },
  { title: 'Mobile', items: ['Flutter', 'Android & iOS', 'Offline caching', 'Push notifications', 'Biometric auth'], color: '#45B7D1' },
  { title: 'Backend', items: ['Node.js / Workers', 'PostgreSQL / D1', 'Cloudflare R2', 'Redis caching', 'REST + GraphQL'], color: '#96CEB4' },
];

const DEFAULT_SECURITY_POINTS = [
  'End-to-end encryption', 'HIPAA compliance', 'SOC 2 certified', 'Regular security audits',
  'Role-based access control', 'Secure update verification', 'Rate limiting & DDoS protection', 'Malware scanning',
];

export default function About() {
  const { get, getJSON } = useContent();

  const visionPoints = getJSON<string[]>('about.visionPoints', DEFAULT_VISION_POINTS);
  const aboutApps = getJSON<any[]>('about.apps', DEFAULT_ABOUT_APPS);
  const archPlatforms = getJSON<any[]>('about.arch.platforms', DEFAULT_ARCH_PLATFORMS);
  const stackCards = getJSON<any[]>('about.stackCards', DEFAULT_STACK);
  const securityPoints = getJSON<string[]>('about.security.points', DEFAULT_SECURITY_POINTS);
  const ctaBtn = getJSON('about.cta.btn', { label: 'Explore Applications', to: '/browse' });

  return (
    <div className="min-h-screen">
      <section className="relative overflow-hidden py-20 lg:py-28">
        <div className="absolute inset-0 bg-gradient-hero" />
        <div className="absolute top-1/4 left-1/3 w-96 h-96 bg-rx-yellow/5 rounded-full blur-3xl" />
        <div className="relative section-container text-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-rx-yellow/10 border border-rx-yellow/20 mb-6">
            <span className="text-xs font-medium text-rx-yellow">
              <Editable id="about.badge" label="About badge">{get('about.badge', 'By Calcitonin Technologies')}</Editable>
            </span>
          </div>
          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-black text-white leading-tight">
            <Editable id="about.titleA" label="Title (part 1)">{get('about.titleA', 'About')}</Editable>{' '}
            <span className="gradient-text">
              <Editable id="about.titleB" label="Title (highlight)">{get('about.titleB', 'RX Store')}</Editable>
            </span>
          </h1>
          <p className="mt-6 text-lg text-rx-gray-medium max-w-2xl mx-auto leading-relaxed">
            <Editable id="about.intro" type="textarea" label="Intro paragraph">
              {get('about.intro', 'A professional digital marketplace and application management platform for distributing, managing, updating, and monetizing all applications developed under the Calcitonin Technologies ecosystem.')}
            </Editable>
          </p>
        </div>
      </section>

      <section className="section-container py-20">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
          <div>
            <h2 className="text-3xl font-bold text-white mb-6">
              <Editable id="about.vision.title" label="Vision heading">{get('about.vision.title', 'Our Vision')}</Editable>
            </h2>
            <p className="text-rx-gray-medium leading-relaxed mb-4">
              <Editable id="about.vision.p1" type="textarea" label="Vision paragraph 1">
                {get('about.vision.p1', 'RX Store was created with a clear vision: to build a platform similar to Microsoft Store, Samsung Galaxy Store, and JetBrains Toolbox — but focused specifically on healthcare, education, productivity, and technology applications.')}
              </Editable>
            </p>
            <p className="text-rx-gray-medium leading-relaxed mb-6">
              <Editable id="about.vision.p2" type="textarea" label="Vision paragraph 2">
                {get('about.vision.p2', 'We believe that professionals in these critical fields deserve purpose-built tools that understand their unique workflows, compliance requirements, and collaboration needs.')}
              </Editable>
            </p>
            <Editable id="about.visionPoints" type="textList" label="Vision checklist" group>
              <div className="space-y-3">
                {visionPoints.map((item) => (
                  <div key={item} className="flex items-center gap-3">
                    <div className="w-5 h-5 rounded-full bg-rx-yellow/20 flex items-center justify-center flex-shrink-0"><Check className="w-3 h-3 text-rx-yellow" /></div>
                    <span className="text-sm text-rx-gray-medium">{item}</span>
                  </div>
                ))}
              </div>
            </Editable>
          </div>
          <div className="relative">
            <div className="card p-8 relative overflow-hidden">
              <div className="absolute top-0 right-0 w-40 h-40 bg-rx-yellow/5 rounded-full blur-2xl" />
              <Editable id="about.apps" type="platformCards" label="Ecosystem app list" group>
                <div className="relative space-y-4">
                  {aboutApps.map((app) => (
                    <div key={app.name} className="flex items-center gap-4 p-4 rounded-xl bg-rx-dark-tertiary/50 border border-white/5">
                      <div className="w-10 h-10 rounded-lg bg-rx-yellow/20 flex items-center justify-center text-lg">{app.icon}</div>
                      <div><p className="font-semibold text-white text-sm">{app.name}</p><p className="text-xs text-rx-gray-medium">{app.desc}</p></div>
                    </div>
                  ))}
                </div>
              </Editable>
            </div>
          </div>
        </div>
      </section>

      <section className="section-container py-20">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold text-white">
            <Editable id="about.arch.titleA" label="Architecture title (part 1)">{get('about.arch.titleA', 'Platform')}</Editable>{' '}
            <span className="gradient-text"><Editable id="about.arch.titleB" label="Architecture title (highlight)">{get('about.arch.titleB', 'Architecture')}</Editable></span>
          </h2>
          <p className="mt-3 text-rx-gray-medium max-w-xl mx-auto">
            <Editable id="about.arch.sub" type="textarea" label="Architecture subtitle">
              {get('about.arch.sub', 'A complete multi-platform ecosystem designed for scale, security, and seamless user experience.')}
            </Editable>
          </p>
        </div>
        <div className="max-w-3xl mx-auto space-y-6">
          <div className="text-center">
            <div className="inline-block px-8 py-4 bg-rx-yellow text-rx-dark font-bold rounded-2xl text-lg">
              <Editable id="about.arch.core" label="Core box label">{get('about.arch.core', 'RX STORE')}</Editable>
            </div>
          </div>
          <div className="flex justify-center"><div className="w-px h-8 bg-rx-yellow/50" /></div>
          <div className="text-center">
            <div className="inline-block px-6 py-3 bg-rx-dark-secondary border border-rx-yellow/30 rounded-xl text-rx-yellow font-semibold">
              <Editable id="about.arch.cloud" label="Cloud box label">{get('about.arch.cloud', '☁️ Rx Cloud Backend')}</Editable>
            </div>
          </div>
          <div className="flex justify-center"><div className="w-px h-8 bg-white/20" /></div>
          <Editable id="about.arch.platforms" type="platformCards" label="Architecture platform cards" group>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {archPlatforms.map((p) => {
                const AIcon = ARCH_ICONS[String(p.icon || '').toLowerCase()];
                return (
                  <div key={p.name} className="card p-4 text-center">
                    {AIcon
                      ? <AIcon className="w-6 h-6 text-rx-yellow mx-auto mb-2" />
                      : <span className="block text-2xl mb-2">{p.icon}</span>}
                    <p className="text-sm font-semibold text-white">{p.name}</p>
                    <p className="text-xs text-rx-gray-medium">{p.desc}</p>
                  </div>
                );
              })}
            </div>
          </Editable>
        </div>
      </section>

      <section className="section-container py-20">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold text-white">
            <Editable id="about.stack.titleA" label="Stack title (part 1)">{get('about.stack.titleA', 'Technology')}</Editable>{' '}
            <span className="gradient-text"><Editable id="about.stack.titleB" label="Stack title (highlight)">{get('about.stack.titleB', 'Stack')}</Editable></span>
          </h2>
        </div>
        <Editable id="about.stackCards" type="stackCards" label="Technology stack cards" group>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {stackCards.map((stack) => (
              <div key={stack.title} className="card p-6">
                <h3 className="font-bold text-lg mb-4" style={{ color: stack.color }}>{stack.title}</h3>
                <ul className="space-y-2">
                  {(stack.items || []).map((item: string) => (
                    <li key={item} className="flex items-center gap-2 text-sm text-rx-gray-medium">
                      <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: stack.color }} />{item}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Editable>
      </section>

      <section className="section-container py-20">
        <div className="card p-8 sm:p-12 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-64 h-64 bg-rx-yellow/5 rounded-full blur-3xl" />
          <div className="relative grid grid-cols-1 lg:grid-cols-2 gap-8 items-center">
            <div>
              <div className="flex items-center gap-3 mb-4">
                <Shield className="w-8 h-8 text-rx-yellow" />
                <h2 className="text-2xl font-bold text-white">
                  <Editable id="about.security.title" label="Security heading">{get('about.security.title', 'Enterprise Security')}</Editable>
                </h2>
              </div>
              <p className="text-rx-gray-medium leading-relaxed mb-6">
                <Editable id="about.security.desc" type="textarea" label="Security paragraph">
                  {get('about.security.desc', 'Security is at the core of RX Store. Every application undergoes rigorous security review, and our infrastructure meets healthcare industry compliance standards.')}
                </Editable>
              </p>
              <Editable id="about.security.points" type="textList" label="Security checklist" group>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {securityPoints.map((item) => (
                    <div key={item} className="flex items-center gap-2"><Check className="w-4 h-4 text-rx-yellow flex-shrink-0" /><span className="text-sm text-rx-gray-medium">{item}</span></div>
                  ))}
                </div>
              </Editable>
            </div>
            <div className="text-center">
              <div className="inline-block">
                <div className="w-40 h-40 rounded-full border-4 border-rx-yellow/20 flex items-center justify-center relative">
                  <Shield className="w-16 h-16 text-rx-yellow" />
                  <div className="absolute -top-2 -right-2 w-8 h-8 bg-green-400 rounded-full flex items-center justify-center"><Check className="w-5 h-5 text-white" /></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section-container py-20">
        <div className="text-center">
          <h2 className="text-3xl font-bold text-white mb-4">
            <Editable id="about.cta.title" label="CTA heading">{get('about.cta.title', 'Ready to Get Started?')}</Editable>
          </h2>
          <p className="text-rx-gray-medium mb-8 max-w-lg mx-auto">
            <Editable id="about.cta.sub" type="textarea" label="CTA subtitle">
              {get('about.cta.sub', 'Join the RX Store ecosystem and discover applications built for professionals.')}
            </Editable>
          </p>
          <Editable id="about.cta.btn" type="link" label="CTA button">
            {/^https?:\/\//.test(ctaBtn.to) ? (
              <a href={ctaBtn.to} target="_blank" rel="noreferrer" className="btn-primary text-base inline-flex items-center gap-2 group">
                {ctaBtn.label} <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </a>
            ) : (
              <Link to={ctaBtn.to || '/browse'} className="btn-primary text-base inline-flex items-center gap-2 group">
                {ctaBtn.label} <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </Link>
            )}
          </Editable>
        </div>
      </section>
    </div>
  );
}
