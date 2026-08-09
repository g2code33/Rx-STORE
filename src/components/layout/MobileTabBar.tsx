import { Link, useLocation } from 'react-router-dom';
import { Home, LayoutGrid, Layers, Info, User } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

/** App-Store-style bottom navigation for phones (replaces the hamburger menu). */
export default function MobileTabBar() {
  const location = useLocation();
  const { user } = useAuth();

  const tabs = [
    { to: '/', label: 'Home', icon: Home, exact: true },
    { to: '/browse', label: 'Browse', icon: LayoutGrid },
    { to: '/categories', label: 'Categories', icon: Layers },
    { to: '/about', label: 'About', icon: Info },
    { to: user ? '/profile' : '/login', label: 'Account', icon: User },
  ];

  const isActive = (t: (typeof tabs)[number]) =>
    t.exact ? location.pathname === t.to : location.pathname.startsWith(t.to);

  return (
    <nav
      className="fixed bottom-0 inset-x-0 z-40 lg:hidden bg-rx-dark/95 backdrop-blur-xl border-t border-white/10"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      aria-label="Primary"
    >
      <div className="grid grid-cols-5">
        {tabs.map((t) => {
          const active = isActive(t);
          return (
            <Link
              key={t.label}
              to={t.to}
              className={`flex flex-col items-center gap-0.5 py-2 transition-colors ${
                active ? 'text-rx-yellow' : 'text-rx-gray-medium hover:text-white'
              }`}
            >
              <t.icon className={`w-5 h-5 ${active ? 'stroke-[2.5]' : ''}`} />
              <span className={`text-[10px] ${active ? 'font-semibold' : ''}`}>{t.label}</span>
              <span className={`w-1 h-1 rounded-full ${active ? 'bg-rx-yellow' : 'bg-transparent'}`} />
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
