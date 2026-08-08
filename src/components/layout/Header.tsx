import React, { useState, useEffect, useRef } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { Search, Menu, X, Bell, User, ChevronDown, LogOut, Settings, Shield, Download } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useApps } from '../../context/AppContext';

export default function Header() {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isNotifOpen, setIsNotifOpen] = useState(false);
  const { user, logout, notifications } = useAuth();
  const { searchQuery, setSearchQuery } = useApps();
  const navigate = useNavigate();
  const location = useLocation();
  const profileRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) setIsProfileOpen(false);
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setIsNotifOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  useEffect(() => {
    setIsProfileOpen(false);
    setIsNotifOpen(false);
    setIsMenuOpen(false);
  }, [location.pathname]);

  const unreadCount = notifications.filter((n) => !n.read).length;

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      navigate(`/browse?q=${encodeURIComponent(searchQuery.trim())}`);
    }
  };

  const isActive = (path: string) => location.pathname === path;

  const navLinks = [
    { path: '/', label: 'Home' },
    { path: '/browse', label: 'Browse' },
    { path: '/categories', label: 'Categories' },
    { path: '/about', label: 'About' },
  ];

  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-rx-dark/80 backdrop-blur-xl border-b border-white/5">
      <div className="section-container">
        <div className="flex items-center justify-between h-16 lg:h-18">
          {/* Logo — v1.png */}
          <Link to="/" className="flex items-center gap-2.5 group">
            <img src="/v1.png" alt="RX Store" className="w-11 h-11 rounded-xl object-cover group-hover:shadow-glow transition-shadow duration-300" />
            <div className="hidden sm:block">
              <span className="text-lg font-bold text-white">
                RX <span className="text-rx-yellow">Store</span>
              </span>
              <span className="block text-[10px] text-rx-gray-medium -mt-0.5 tracking-wider">
                BY CALCITONIN TECHNOLOGIES
              </span>
            </div>
          </Link>

          {/* Desktop Nav */}
          <nav className="hidden lg:flex items-center gap-1">
            {navLinks.map((link) => (
              <Link
                key={link.path}
                to={link.path}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
                  isActive(link.path)
                    ? 'text-rx-yellow bg-rx-yellow/10'
                    : 'text-rx-gray-medium hover:text-white hover:bg-white/5'
                }`}
              >
                {link.label}
              </Link>
            ))}
          </nav>

          {/* Search Bar */}
          <form onSubmit={handleSearch} className="hidden md:flex items-center flex-1 max-w-md mx-6">
            <div className="relative w-full">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-rx-gray-medium" />
              <input
                type="text"
                placeholder="Search applications..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl pl-10 pr-4 py-2.5 text-sm text-white placeholder-rx-gray-medium focus:outline-none focus:border-rx-yellow/50 focus:ring-1 focus:ring-rx-yellow/25 transition-all"
              />
            </div>
          </form>

          {/* Right Actions */}
          <div className="flex items-center gap-2">
            {/* Notifications */}
            {user && (
              <div className="relative" ref={notifRef}>
                <button
                  onClick={() => { setIsNotifOpen(!isNotifOpen); setIsProfileOpen(false); }}
                  className="relative p-2.5 rounded-xl text-rx-gray-medium hover:text-white hover:bg-white/5 transition-all"
                >
                  <Bell className="w-5 h-5" />
                  {unreadCount > 0 && (
                    <span className="absolute top-1 right-1 w-4 h-4 bg-rx-yellow text-rx-dark text-[10px] font-bold rounded-full flex items-center justify-center">
                      {unreadCount}
                    </span>
                  )}
                </button>

                {isNotifOpen && (
                  <div className="absolute right-0 mt-2 w-80 bg-rx-dark-secondary border border-white/10 rounded-2xl shadow-xl animate-slide-down overflow-hidden">
                    <div className="p-4 border-b border-white/5">
                      <h3 className="text-sm font-semibold">Notifications</h3>
                    </div>
                    <div className="max-h-80 overflow-y-auto">
                      {notifications.map((notif) => (
                        <div
                          key={notif.id}
                          className={`p-4 border-b border-white/5 hover:bg-white/5 transition-colors ${
                            !notif.read ? 'bg-rx-yellow/5' : ''
                          }`}
                        >
                          <div className="flex items-start gap-3">
                            <div className="w-8 h-8 rounded-lg bg-rx-dark-tertiary flex items-center justify-center text-sm">
                              {notif.type === 'update' ? '🔄' : notif.type === 'download' ? '📥' : '📢'}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-white">{notif.title}</p>
                              <p className="text-xs text-rx-gray-medium mt-0.5 line-clamp-2">{notif.message}</p>
                            </div>
                            {!notif.read && <div className="w-2 h-2 bg-rx-yellow rounded-full mt-2 flex-shrink-0"></div>}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="p-3">
                      <Link to="/profile" onClick={()=>setIsProfileOpen(false)} className="text-xs text-rx-yellow hover:underline text-center block">
                        View all notifications
                      </Link>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Profile / Auth */}
            {user ? (
              <div className="relative" ref={profileRef}>
                <button
                  onClick={() => { setIsProfileOpen(!isProfileOpen); setIsNotifOpen(false); }}
                  className="flex items-center gap-2 p-1.5 pr-3 rounded-xl hover:bg-white/5 transition-all"
                >
                  <div className="w-8 h-8 rounded-lg bg-rx-dark-tertiary flex items-center justify-center text-lg">
                    {user.avatar}
                  </div>
                  <span className="hidden sm:block text-sm font-medium text-white">{user.name.split(' ')[0]}</span>
                  <ChevronDown className="w-3.5 h-3.5 text-rx-gray-medium hidden sm:block" />
                </button>

                {isProfileOpen && (
                  <div className="absolute right-0 mt-2 w-56 bg-rx-dark-secondary border border-white/10 rounded-2xl shadow-xl animate-slide-down overflow-hidden">
                    <div className="p-4 border-b border-white/5">
                      <p className="text-sm font-semibold">{user.name}</p>
                      <p className="text-xs text-rx-gray-medium">{user.email}</p>
                    </div>
                    <div className="p-2">
                      <Link to="/profile" onClick={()=>setIsProfileOpen(false)} className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-rx-gray-medium hover:text-white hover:bg-white/5 transition-all">
                        <User className="w-4 h-4" /> My Profile
                      </Link>
                      <Link to="/profile" onClick={()=>setIsProfileOpen(false)} className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-rx-gray-medium hover:text-white hover:bg-white/5 transition-all">
                        <Download className="w-4 h-4" /> My Apps
                      </Link>
                      <Link to="/profile" onClick={()=>setIsProfileOpen(false)} className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-rx-gray-medium hover:text-white hover:bg-white/5 transition-all">
                        <Settings className="w-4 h-4" /> Settings
                      </Link>
                      {user.role === 'admin' && (
                        <Link to="/admin" onClick={()=>setIsProfileOpen(false)} className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-rx-yellow hover:bg-rx-yellow/10 transition-all">
                          <Shield className="w-4 h-4" /> Admin Dashboard
                        </Link>
                      )}
                    </div>
                    <div className="p-2 border-t border-white/5">
                      <button onClick={logout} className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-red-400 hover:bg-red-400/10 transition-all w-full">
                        <LogOut className="w-4 h-4" /> Sign Out
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Link to="/login" className="hidden sm:block px-4 py-2 text-sm font-medium text-rx-gray-medium hover:text-white transition-colors">
                  Sign In
                </Link>
                <Link to="/login?mode=register" className="btn-primary text-sm !px-4 !py-2">
                  Get Started
                </Link>
              </div>
            )}

            {/* Mobile Menu Toggle */}
            <button
              onClick={() => setIsMenuOpen(!isMenuOpen)}
              className="lg:hidden p-2.5 rounded-xl text-rx-gray-medium hover:text-white hover:bg-white/5 transition-all"
            >
              {isMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Menu */}
      {isMenuOpen && (
        <div className="lg:hidden border-t border-white/5 bg-rx-dark/95 backdrop-blur-xl animate-slide-down">
          <div className="section-container py-4 space-y-1">
            {/* Mobile Search */}
            <form onSubmit={handleSearch} className="mb-4 md:hidden">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-rx-gray-medium" />
                <input
                  type="text"
                  placeholder="Search applications..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl pl-10 pr-4 py-2.5 text-sm text-white placeholder-rx-gray-medium focus:outline-none focus:border-rx-yellow/50"
                />
              </div>
            </form>

            {navLinks.map((link) => (
              <Link
                key={link.path}
                to={link.path}
                onClick={() => setIsMenuOpen(false)}
                className={`block px-4 py-3 rounded-xl text-sm font-medium transition-all ${
                  isActive(link.path)
                    ? 'text-rx-yellow bg-rx-yellow/10'
                    : 'text-rx-gray-medium hover:text-white hover:bg-white/5'
                }`}
              >
                {link.label}
              </Link>
            ))}
          </div>
        </div>
      )}
    </header>
  );
}
