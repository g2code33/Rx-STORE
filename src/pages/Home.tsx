import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Shield, Zap, Globe, Download, Star, Users, Cpu, Heart, GraduationCap, Gamepad2 } from 'lucide-react';
import { useApps } from '../context/AppContext';
import { featuredApps, trendingApps, newApps, categories } from '../data/apps';
import AppCard from '../components/apps/AppCard';
import { formatDownloadCount } from '../utils/helpers';


function StatsBar({ apps }: { apps: any[] }) {
  const [stats, setStats] = React.useState({ apps: apps.length || 0, downloads: 0, platforms: 5, rating: 0 });
  React.useEffect(() => {
    const API = (import.meta as any).env?.VITE_API_URL;
    if (!API) {
      const totalDl = apps.reduce((s,a)=> s + (a.downloadCount||0), 0);
      const avg = apps.length ? (apps.reduce((s,a)=> s + (a.rating||0),0)/apps.length) : 0;
      setStats({ apps: apps.length, downloads: totalDl, platforms: 5, rating: Number(avg.toFixed(1)) });
      return;
    }
    fetch(`${API.replace(/\/$/,'')}/admin/dashboard`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('rx-store-token')||''}` } })
      .then(r=>r.json()).then(j=>{
        const d=j.data||j;
        const totalDl = d.totalDownloads ?? apps.reduce((s,a)=> s + (a.downloadCount||0),0);
        const avg = d.averageRating ?? (apps.length ? apps.reduce((s,a)=> s + (a.rating||0),0)/apps.length : 0);
        setStats({ apps: apps.length || d.totalUsers || 0, downloads: totalDl, platforms: 5, rating: Number(Number(avg).toFixed(1)) });
      }).catch(()=>{
        const totalDl = apps.reduce((s,a)=> s + (a.downloadCount||0),0);
        const avg = apps.length ? apps.reduce((s,a)=> s + (a.rating||0),0)/apps.length : 0;
        setStats({ apps: apps.length, downloads: totalDl, platforms: 5, rating: Number(avg.toFixed(1)) });
      });
  }, [apps]);
  const fmt = (n:number)=> n>=1000 ? `${(n/1000).toFixed(n>=10000?0:1)}K` : String(n);
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 mt-16 max-w-2xl mx-auto animate-slide-up" style={{ animationDelay: '0.3s' }}>
      {[
        { value: String(stats.apps), label: 'Applications' },
        { value: stats.downloads===0 ? '0' : fmt(stats.downloads), label: 'Downloads' },
        { value: String(stats.platforms), label: 'Platforms' },
        { value: stats.rating ? String(stats.rating) : '0.0', label: 'Avg Rating' },
      ].map((stat) => (
        <div key={stat.label} className="text-center">
          <p className="text-2xl sm:text-3xl font-bold text-rx-yellow">{stat.value}</p>
          <p className="text-xs text-rx-gray-medium mt-1">{stat.label}</p>
        </div>
      ))}
    </div>
  );
}

export default function Home() {
  const { apps } = useApps();

  return (
    <div className="min-h-screen">
      {/* Hero Section */}
      <section className="relative overflow-hidden">
        {/* Background Effects */}
        <div className="absolute inset-0 bg-gradient-hero" />
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-rx-yellow/5 rounded-full blur-3xl animate-float" />
        <div className="absolute bottom-0 right-1/4 w-80 h-80 bg-rx-yellow/3 rounded-full blur-3xl animate-float" style={{ animationDelay: '-3s' }} />
        
        {/* Grid Pattern */}
        <div className="absolute inset-0 opacity-[0.02]" style={{
          backgroundImage: 'linear-gradient(rgba(255,214,0,0.3) 1px, transparent 1px), linear-gradient(90deg, rgba(255,214,0,0.3) 1px, transparent 1px)',
          backgroundSize: '60px 60px'
        }} />

        <div className="relative section-container pt-32 pb-20 lg:pt-40 lg:pb-28">
          <div className="text-center max-w-4xl mx-auto">
            {/* Badge */}
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-rx-yellow/10 border border-rx-yellow/20 mb-8 animate-fade-in">
              <div className="w-2 h-2 bg-rx-yellow rounded-full animate-pulse" />
              <span className="text-xs font-medium text-rx-yellow">Platform v1.0 — Now Available</span>
            </div>

            <h1 className="text-4xl sm:text-5xl lg:text-7xl font-black text-white leading-tight animate-slide-up">
              The Future of
              <br />
              <span className="gradient-text">Healthcare Apps</span>
              <br />
              Starts Here
            </h1>

            <p className="mt-6 text-lg sm:text-xl text-rx-gray-medium max-w-2xl mx-auto leading-relaxed animate-slide-up text-balance" style={{ animationDelay: '0.1s' }}>
              Discover, download, and manage premium applications for healthcare, education, 
              productivity, and technology — all in one professional marketplace.
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mt-10 animate-slide-up" style={{ animationDelay: '0.2s' }}>
              <Link to="/browse" className="btn-primary text-base flex items-center gap-2 group">
                Explore Applications
                <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </Link>
              <Link to="/about" className="btn-secondary text-base">
                Learn More
              </Link>
            </div>

            {/* Stats — real from D1 */}
            <StatsBar apps={apps} />
          </div>
        </div>

        {/* Bottom fade */}
        <div className="absolute bottom-0 left-0 right-0 h-24 bg-gradient-to-t from-rx-dark to-transparent" />
      </section>

      {/* Ecosystem Apps */}
      <section className="section-container py-20">
        <div className="text-center mb-12">
          <h2 className="text-3xl sm:text-4xl font-bold text-white">
            Our <span className="gradient-text">Applications</span>
          </h2>
          <p className="mt-3 text-rx-gray-medium max-w-xl mx-auto">
            A curated collection of professional-grade tools built for modern healthcare, education, and technology needs.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {apps.slice(0, 8).map((app) => (
            <AppCard key={app.id} app={app} />
          ))}
        </div>
      </section>

      {/* Categories */}
      <section className="section-container py-20">
        <div className="flex items-center justify-between mb-10">
          <div>
            <h2 className="text-2xl sm:text-3xl font-bold text-white">Browse by Category</h2>
            <p className="mt-2 text-rx-gray-medium">Find the right tools for your needs</p>
          </div>
          <Link to="/categories" className="text-sm text-rx-yellow hover:underline flex items-center gap-1">
            View all <ArrowRight className="w-4 h-4" />
          </Link>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
          {categories.map((cat) => {
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
                <p className="text-xs text-rx-gray-medium mt-1">{cat.count} apps</p>
              </Link>
            );
          })}
        </div>
      </section>

      {/* Trending */}
      <section className="section-container py-20">
        <div className="flex items-center justify-between mb-10">
          <div>
            <h2 className="text-2xl sm:text-3xl font-bold text-white flex items-center gap-2">
              🔥 Trending Now
            </h2>
            <p className="mt-2 text-rx-gray-medium">Most popular applications this week</p>
          </div>
          <Link to="/browse" className="text-sm text-rx-yellow hover:underline flex items-center gap-1">
            See all <ArrowRight className="w-4 h-4" />
          </Link>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {trendingApps.map((app) => (
            <AppCard key={app.id} app={app} />
          ))}
        </div>
      </section>

      {/* Platform Availability */}
      <section className="section-container py-20">
        <div className="card p-8 sm:p-12 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-80 h-80 bg-rx-yellow/5 rounded-full blur-3xl" />
          <div className="relative">
            <div className="text-center mb-10">
              <h2 className="text-3xl sm:text-4xl font-bold text-white">
                Available on <span className="gradient-text">Every Platform</span>
              </h2>
              <p className="mt-3 text-rx-gray-medium max-w-xl mx-auto">
                Access RX Store from any device. Our applications work seamlessly across web, desktop, and mobile platforms.
              </p>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
              {[
                { name: 'Web', icon: '🌐', desc: 'Any browser' },
                { name: 'Windows', icon: '🪟', desc: 'Win 10+' },
                { name: 'Linux', icon: '🐧', desc: 'Ubuntu/Debian' },
                { name: 'Android', icon: '🤖', desc: 'Android 8+' },
                { name: 'iOS', icon: '🍎', desc: 'iOS 15+' },
              ].map((platform) => (
                <div key={platform.name} className="text-center p-4 rounded-xl bg-rx-dark-tertiary/50 border border-white/5 hover:border-rx-yellow/20 transition-all">
                  <span className="text-3xl">{platform.icon}</span>
                  <p className="text-sm font-semibold text-white mt-2">{platform.name}</p>
                  <p className="text-xs text-rx-gray-medium">{platform.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="section-container py-20">
        <div className="text-center mb-12">
          <h2 className="text-3xl sm:text-4xl font-bold text-white">
            Why Choose <span className="gradient-text">RX Store</span>?
          </h2>
          <p className="mt-3 text-rx-gray-medium max-w-xl mx-auto">
            Built with security, performance, and user experience at the core.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {[
            {
              icon: Shield,
              title: 'Enterprise Security',
              description: 'HIPAA-compliant infrastructure with end-to-end encryption and regular security audits.',
              color: '#FF6B6B',
            },
            {
              icon: Zap,
              title: 'Lightning Fast',
              description: 'Optimized delivery with CDN distribution for instant downloads and seamless updates.',
              color: '#FFD600',
            },
            {
              icon: Globe,
              title: 'Cross-Platform',
              description: 'One account, every device. Sync your apps and preferences across all platforms.',
              color: '#4ECDC4',
            },
            {
              icon: Download,
              title: 'Auto Updates',
              description: 'Stay current with automatic background updates. Never miss an important feature.',
              color: '#45B7D1',
            },
            {
              icon: Users,
              title: 'Community Driven',
              description: 'Join thousands of healthcare professionals who trust RX Store for their essential tools.',
              color: '#96CEB4',
            },
            {
              icon: Star,
              title: 'Curated Quality',
              description: 'Every application undergoes rigorous review to meet our standards for quality and reliability.',
              color: '#DDA0DD',
            },
          ].map((feature) => (
            <div key={feature.title} className="card p-6 group hover:border-rx-yellow/20">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-4" style={{ backgroundColor: `${feature.color}15` }}>
                <feature.icon className="w-6 h-6" style={{ color: feature.color }} />
              </div>
              <h3 className="text-lg font-semibold text-white group-hover:text-rx-yellow transition-colors">
                {feature.title}
              </h3>
              <p className="text-sm text-rx-gray-medium mt-2 leading-relaxed">{feature.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="section-container py-20">
        <div className="relative rounded-3xl overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-r from-rx-yellow/20 via-rx-yellow/10 to-transparent" />
          <div className="absolute inset-0 bg-rx-dark-secondary/80 backdrop-blur-sm" />
          <div className="relative px-8 py-16 sm:px-16 sm:py-20 text-center">
            <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
              Ready to Transform Your Workflow?
            </h2>
            <p className="text-rx-gray-medium max-w-lg mx-auto mb-8">
              Join thousands of professionals who trust RX Store for their essential applications. 
              Start exploring today.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Link to="/browse" className="btn-primary text-base flex items-center gap-2 group">
                Get Started Free
                <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </Link>
              <Link to="/login" className="btn-outline text-base">
                Create Account
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
