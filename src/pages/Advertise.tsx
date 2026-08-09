import React from 'react';
import { Eye, Crown, BarChart3, ArrowRight } from 'lucide-react';
import { useContent } from '../context/ContentContext';
import { getPublicSettings } from '../services/api';
import Editable from '../components/edit/Editable';
import PageBlocks from '../components/edit/PageBlocks';
import { Link } from 'react-router-dom';

/** Internal paths navigate in-app, external URLs open a new tab. */
function PitchLink({ to, className, children }: { to: string; className?: string; children: React.ReactNode }) {
  if (/^https?:\/\//.test(to) || /^mailto:/.test(to)) return <a href={to} target="_blank" rel="noreferrer" className={className}>{children}</a>;
  return <Link to={to || '/'} className={className}>{children}</Link>;
}

/** “Advertise with us” — the pitch for the welcome-intro ad slot. */
export default function Advertise() {
  const { get, getJSON } = useContent();
  const [email, setEmail] = React.useState('support@rxstore.com');
  React.useEffect(() => { getPublicSettings().then((s) => { if (s.support_email) setEmail(s.support_email); }).catch(() => {}); }, []);

  const cta = getJSON('advertise.cta', { label: 'Book the intro slot', to: `mailto:${email}?subject=${encodeURIComponent('Intro Ad — RX Store')}` });

  const CARDS = [
    {
      icon: Eye,
      title: get('advertise.card1.title', 'Guaranteed attention'),
      body: get('advertise.card1.body', 'The welcome intro plays on every fresh visit — full-screen for 3 seconds, every refresh. Nothing scrolls past it.'),
      color: '#FFD600',
    },
    {
      icon: Crown,
      title: get('advertise.card2.title', '100% share of voice'),
      body: get('advertise.card2.body', 'One sponsored card owns the entire viewport: headline, banner art, your story, and a bright call-to-action.'),
      color: '#4ECDC4',
    },
    {
      icon: BarChart3,
      title: get('advertise.card3.title', 'Measured honestly'),
      body: get('advertise.card3.body', 'Views and clicks are counted server-side, per card, across all devices. Fair round-robin rotation, real numbers.'),
      color: '#45B7D1',
    },
  ];

  return (
    <div className="min-h-screen">
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-hero" />
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-rx-yellow/5 rounded-full blur-3xl animate-float" />
        <div className="relative section-container pt-28 pb-16 text-center max-w-3xl mx-auto">
          <p className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-rx-yellow/10 border border-rx-yellow/20 text-xs font-medium text-rx-yellow mb-8">
            <Editable id="advertise.badge" label="Badge">{get('advertise.badge', '📣 Advertise on RX Store')}</Editable>
          </p>
          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-black text-white leading-tight">
            <Editable id="advertise.title" label="Title (part 1)">{get('advertise.title', 'Put your brand on the')}</Editable>{' '}
            <span className="gradient-text"><Editable id="advertise.titleHi" label="Title (highlight)">{get('advertise.titleHi', 'welcome screen')}</Editable></span>
          </h1>
          <p className="mt-6 text-lg text-rx-gray-medium leading-relaxed">
            <Editable id="advertise.sub" type="textarea" label="Subtitle">
              {get('advertise.sub', "Every visitor's first 3 seconds on RX Store belong to one sponsored card. That card can be yours.")}
            </Editable>
          </p>
        </div>
      </section>

      {/* Value cards */}
      <section className="section-container pb-16">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {CARDS.map((c, i) => (
            <div key={i} className="card p-6 hover:border-rx-yellow/30 transition-colors">
              <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-4" style={{ backgroundColor: `${c.color}20` }}>
                <c.icon className="w-6 h-6" style={{ color: c.color }} />
              </div>
              <h3 className="text-lg font-bold text-white">
                <Editable id={`advertise.card${i + 1}.title`} label={`Card ${i + 1} title`}>{c.title}</Editable>
              </h3>
              <p className="text-sm text-rx-gray-medium mt-2 leading-relaxed">
                <Editable id={`advertise.card${i + 1}.body`} type="textarea" label={`Card ${i + 1} body`}>{c.body}</Editable>
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="section-container pb-16">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-2xl sm:text-3xl font-bold text-white mb-5">
            <Editable id="advertise.how.title" label="'How it works' heading">{get('advertise.how.title', 'How the slot works')}</Editable>
          </h2>
          <div className="text-rx-gray-medium leading-relaxed space-y-4">
            <Editable id="advertise.how.body" type="textarea" label="'How it works' body">
              {get('advertise.how.body', "On every fresh page load, each visitor sees one sponsored card for 3 seconds before the store fades in — with a skip, always.\n\nMultiple sponsors rotate fairly, one card per refresh: if you run two campaigns, each gets every other refresh. Your card carries your headline, message, banner art and a button to any URL.\n\nWe count every view and every click server-side and share the numbers with you — no estimates, no black box.")}
            </Editable>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="section-container pb-20">
        <div className="relative rounded-3xl overflow-hidden max-w-4xl mx-auto">
          <div className="absolute inset-0 bg-gradient-to-r from-rx-yellow/20 via-rx-yellow/10 to-transparent" />
          <div className="absolute inset-0 bg-rx-dark-secondary/80 backdrop-blur-sm" />
          <div className="relative px-8 py-14 sm:px-16 text-center">
            <h2 className="text-2xl sm:text-3xl font-bold text-white mb-4">
              <Editable id="advertise.cta.title" label="CTA heading">{get('advertise.cta.title', 'Ready to own the first 3 seconds?')}</Editable>
            </h2>
            <p className="text-rx-gray-medium max-w-lg mx-auto mb-8">
              <Editable id="advertise.cta.sub" type="textarea" label="CTA subtitle">
                {get('advertise.cta.sub', 'Tell us about your product and we will get your card onto the welcome screen — usually within a day.')}
              </Editable>
            </p>
            <Editable id="advertise.cta" type="link" label="CTA button">
              <PitchLink to={cta.to} className="btn-primary text-base inline-flex items-center gap-2 group">
                {cta.label} <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </PitchLink>
            </Editable>
          </div>
        </div>
      </section>

      {/* Custom sections inserted via Builder → Add Block */}
      <PageBlocks pageId="advertise" />
    </div>
  );
}
