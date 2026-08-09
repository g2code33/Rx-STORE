import React from 'react';
import { Link } from 'react-router-dom';
import { Github, Twitter, Linkedin, Mail, Heart } from 'lucide-react';
import toast from 'react-hot-toast';
import { getPublicSettings } from '../../services/api';
import { useContent } from '../../context/ContentContext';
import Editable from '../edit/Editable';
import { replayWelcomeIntro } from '../home/WelcomeIntro';

const DEFAULT_PLATFORM_LINKS = [
  { label: 'Browse Apps', to: '/browse' },
  { label: 'Categories', to: '/categories' },
  { label: 'Featured', to: '/browse?featured=1' },
  { label: 'New Releases', to: '/browse?sort=newest' },
  { label: 'Updates', to: '/profile' },
];

const DEFAULT_COMPANY_LINKS = [
  { label: 'About Calcitonin', to: '/about' },
  { label: 'Advertise', to: '/advertise' },
  { label: 'Privacy Policy', to: '/privacy' },
  { label: 'Terms of Service', to: '/terms' },
  { label: 'Careers', to: '', soon: true },
  { label: 'Press Kit', to: '', soon: true },
];

/** Internal paths render as router Links; external URLs as anchors. */
function FooterLink({ to, className, children }: { to: string; className?: string; children: React.ReactNode }) {
  if (/^https?:\/\//.test(to)) return <a href={to} target="_blank" rel="noreferrer" className={className}>{children}</a>;
  return <Link to={to || '/'} className={className}>{children}</Link>;
}

export default function Footer() {
  const [settings, setSettings] = React.useState<Record<string, string>>({});
  React.useEffect(() => { getPublicSettings().then(setSettings); }, []);
  const { get, getJSON } = useContent();
  const platformName = settings.platform_name || 'RX Store';
  const supportEmail = settings.support_email || 'support@rxstore.com';
  const platformLinks = getJSON('footer.platformLinks', DEFAULT_PLATFORM_LINKS);
  const companyLinks = getJSON('footer.companyLinks', DEFAULT_COMPANY_LINKS);

  return (
    <footer className="bg-rx-dark border-t border-white/5">
      <div className="section-container py-16">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-12">
          {/* Brand */}
          <div className="lg:col-span-1">
            <Link to="/" onClick={replayWelcomeIntro} className="flex items-center gap-2.5 mb-4">
              <img src="/v1.png" alt={`${platformName} logo`} className="w-10 h-10 rounded-lg object-cover" />
              <div>
                <span className="text-xl font-bold text-white">
                  {platformName.split(' ')[0]} <span className="text-rx-yellow">{platformName.split(' ').slice(1).join(' ') || 'Store'}</span>
                </span>
                <span className="block text-[10px] text-rx-gray-medium -mt-0.5 tracking-wider">
                  BY CALCITONIN TECHNOLOGIES
                </span>
              </div>
            </Link>
            <p className="text-sm text-rx-gray-medium leading-relaxed mb-6">
              <Editable id="footer.blurb" type="textarea" label="Footer blurb">
                {get('footer.blurb', 'Professional digital marketplace for healthcare, education, productivity, and technology applications. Discover, download, and manage all your essential tools.')}
              </Editable>
            </p>
            <div className="flex items-center gap-3">
              <a href="#" className="w-9 h-9 rounded-lg bg-rx-dark-tertiary flex items-center justify-center text-rx-gray-medium hover:text-rx-yellow hover:bg-rx-dark-secondary transition-all">
                <Github className="w-4 h-4" />
              </a>
              <a href="#" className="w-9 h-9 rounded-lg bg-rx-dark-tertiary flex items-center justify-center text-rx-gray-medium hover:text-rx-yellow hover:bg-rx-dark-secondary transition-all">
                <Twitter className="w-4 h-4" />
              </a>
              <a href="#" className="w-9 h-9 rounded-lg bg-rx-dark-tertiary flex items-center justify-center text-rx-gray-medium hover:text-rx-yellow hover:bg-rx-dark-secondary transition-all">
                <Linkedin className="w-4 h-4" />
              </a>
              <a href={`mailto:${supportEmail}`} className="w-9 h-9 rounded-lg bg-rx-dark-tertiary flex items-center justify-center text-rx-gray-medium hover:text-rx-yellow hover:bg-rx-dark-secondary transition-all" title={supportEmail}>
                <Mail className="w-4 h-4" />
              </a>
            </div>
          </div>

          {/* Platform */}
          <div>
            <h3 className="text-sm font-semibold text-white mb-4 uppercase tracking-wider">Platform</h3>
            <Editable id="footer.platformLinks" type="linkList" label="Platform links" group>
              <ul className="space-y-3">
                {platformLinks.map((item: { label: string; to: string }) => (
                  <li key={item.label}>
                    <FooterLink to={item.to} className="text-sm text-rx-gray-medium hover:text-rx-yellow transition-colors">
                      {item.label}
                    </FooterLink>
                  </li>
                ))}
              </ul>
            </Editable>
          </div>

          {/* Developers — not launched yet */}
          <div>
            <h3 className="text-sm font-semibold text-white mb-4 uppercase tracking-wider">Developers</h3>
            <ul className="space-y-3">
              {['Developer Portal', 'API Documentation', 'Submit an App', 'SDK Downloads', 'Community Forum'].map((item) => (
                <li key={item}>
                  <button
                    onClick={() => toast(`${item} — coming soon 🚧`, { icon: '🛠️' })}
                    className="text-sm text-rx-gray-medium/70 hover:text-rx-yellow transition-colors flex items-center gap-2"
                    title="Not available yet"
                  >
                    {item}
                    <span className="text-[9px] font-bold uppercase tracking-wider bg-rx-yellow/15 text-rx-yellow px-1.5 py-0.5 rounded">Soon</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {/* Company */}
          <div>
            <h3 className="text-sm font-semibold text-white mb-4 uppercase tracking-wider">Company</h3>
            <Editable id="footer.companyLinks" type="linkList" label="Company links" group>
              <ul className="space-y-3">
                {companyLinks.map((item: { label: string; to: string; soon?: boolean }) => (
                  <li key={item.label}>
                    {item.soon || !item.to ? (
                      <button
                        onClick={() => toast(`${item.label} — coming soon 🚧`, { icon: '🛠️' })}
                        className="text-sm text-rx-gray-medium/70 hover:text-rx-yellow transition-colors flex items-center gap-2"
                        title="Not available yet"
                      >
                        {item.label}
                        <span className="text-[9px] font-bold uppercase tracking-wider bg-rx-yellow/15 text-rx-yellow px-1.5 py-0.5 rounded">Soon</span>
                      </button>
                    ) : (
                      <FooterLink to={item.to} className="text-sm text-rx-gray-medium hover:text-rx-yellow transition-colors">
                        {item.label}
                      </FooterLink>
                    )}
                  </li>
                ))}
              </ul>
            </Editable>
          </div>
        </div>

        {/* Bottom */}
        <div className="mt-12 pt-8 border-t border-white/5 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-xs text-rx-gray-medium">
            <Editable id="footer.copyright" label="Copyright line">
              {get('footer.copyright', '© {year} Calcitonin Technologies. All rights reserved.').replace('{year}', String(new Date().getFullYear()))}
            </Editable>
          </p>
          <p className="text-xs text-rx-gray-medium flex items-center gap-1">
            Made with <Heart className="w-3 h-3 text-rx-yellow fill-rx-yellow" />{' '}
            <Editable id="footer.madeWith" label="Made-with line">{get('footer.madeWith', 'for Healthcare Innovation')}</Editable>
          </p>
        </div>
      </div>
    </footer>
  );
}
