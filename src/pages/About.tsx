import React from 'react';
import { Link } from 'react-router-dom';
import { Shield, Globe, Users, Cpu, Zap, ArrowRight, Check } from 'lucide-react';

export default function About() {
  return (
    <div className="min-h-screen">
      <section className="relative overflow-hidden py-20 lg:py-28">
        <div className="absolute inset-0 bg-gradient-hero" />
        <div className="absolute top-1/4 left-1/3 w-96 h-96 bg-rx-yellow/5 rounded-full blur-3xl" />
        <div className="relative section-container text-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-rx-yellow/10 border border-rx-yellow/20 mb-6">
            <span className="text-xs font-medium text-rx-yellow">By Calcitonin Technologies</span>
          </div>
          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-black text-white leading-tight">
            About <span className="gradient-text">RX Store</span>
          </h1>
          <p className="mt-6 text-lg text-rx-gray-medium max-w-2xl mx-auto leading-relaxed">
            A professional digital marketplace and application management platform for distributing, managing,
            updating, and monetizing all applications developed under the Calcitonin Technologies ecosystem.
          </p>
        </div>
      </section>

      <section className="section-container py-20">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
          <div>
            <h2 className="text-3xl font-bold text-white mb-6">Our Vision</h2>
            <p className="text-rx-gray-medium leading-relaxed mb-4">
              RX Store was created with a clear vision: to build a platform similar to Microsoft Store, Samsung Galaxy Store,
              and JetBrains Toolbox — but focused specifically on healthcare, education, productivity, and technology applications.
            </p>
            <p className="text-rx-gray-medium leading-relaxed mb-6">
              We believe that professionals in these critical fields deserve purpose-built tools that understand their unique
              workflows, compliance requirements, and collaboration needs.
            </p>
            <div className="space-y-3">
              {['Healthcare-grade security and compliance', 'Cross-platform availability on all devices', 'Seamless integration between applications', 'AI-powered features and recommendations', 'Continuous updates and improvements'].map((item) => (
                <div key={item} className="flex items-center gap-3">
                  <div className="w-5 h-5 rounded-full bg-rx-yellow/20 flex items-center justify-center flex-shrink-0"><Check className="w-3 h-3 text-rx-yellow" /></div>
                  <span className="text-sm text-rx-gray-medium">{item}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="relative">
            <div className="card p-8 relative overflow-hidden">
              <div className="absolute top-0 right-0 w-40 h-40 bg-rx-yellow/5 rounded-full blur-2xl" />
              <div className="relative space-y-4">
                {[
                  { icon: '🏥', name: 'Clinical Rx', desc: 'Clinical decision support' },
                  { icon: '💊', name: 'PharmaGAME', desc: 'Pharmaceutical education' },
                  { icon: '💻', name: 'Code Rx Society', desc: 'Healthcare development' },
                  { icon: '👥', name: 'TAWOMO', desc: 'Workforce management' },
                  { icon: '🔗', name: 'CureLink', desc: 'Patient communication' },
                ].map((app) => (
                  <div key={app.name} className="flex items-center gap-4 p-4 rounded-xl bg-rx-dark-tertiary/50 border border-white/5">
                    <div className="w-10 h-10 rounded-lg bg-rx-yellow/20 flex items-center justify-center text-lg">{app.icon}</div>
                    <div><p className="font-semibold text-white text-sm">{app.name}</p><p className="text-xs text-rx-gray-medium">{app.desc}</p></div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section-container py-20">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold text-white">Platform <span className="gradient-text">Architecture</span></h2>
          <p className="mt-3 text-rx-gray-medium max-w-xl mx-auto">A complete multi-platform ecosystem designed for scale, security, and seamless user experience.</p>
        </div>
        <div className="max-w-3xl mx-auto space-y-6">
          <div className="text-center"><div className="inline-block px-8 py-4 bg-rx-yellow text-rx-dark font-bold rounded-2xl text-lg">RX STORE</div></div>
          <div className="flex justify-center"><div className="w-px h-8 bg-rx-yellow/50" /></div>
          <div className="text-center"><div className="inline-block px-6 py-3 bg-rx-dark-secondary border border-rx-yellow/30 rounded-xl text-rx-yellow font-semibold">☁️ Rx Cloud Backend</div></div>
          <div className="flex justify-center"><div className="w-px h-8 bg-white/20" /></div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { icon: Globe, name: 'Web App', tech: 'React + TypeScript' },
              { icon: Cpu, name: 'Windows', tech: 'Tauri' },
              { icon: Cpu, name: 'Linux', tech: 'Tauri + AppImage' },
              { icon: Zap, name: 'Mobile', tech: 'Flutter' },
            ].map((p) => (
              <div key={p.name} className="card p-4 text-center">
                <p.icon className="w-6 h-6 text-rx-yellow mx-auto mb-2" />
                <p className="text-sm font-semibold text-white">{p.name}</p>
                <p className="text-xs text-rx-gray-medium">{p.tech}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section-container py-20">
        <div className="text-center mb-12"><h2 className="text-3xl font-bold text-white">Technology <span className="gradient-text">Stack</span></h2></div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {[
            { title: 'Frontend', items: ['React 18', 'TypeScript', 'Tailwind CSS', 'Framer Motion', 'React Router'], color: '#FFD600' },
            { title: 'Desktop', items: ['Tauri (Rust)', 'Cross-platform', 'Auto-updater', 'System tray', 'Offline mode'], color: '#4ECDC4' },
            { title: 'Mobile', items: ['Flutter', 'Android & iOS', 'Offline caching', 'Push notifications', 'Biometric auth'], color: '#45B7D1' },
            { title: 'Backend', items: ['Node.js / Workers', 'PostgreSQL / D1', 'Cloudflare R2', 'Redis caching', 'REST + GraphQL'], color: '#96CEB4' },
          ].map((stack) => (
            <div key={stack.title} className="card p-6">
              <h3 className="font-bold text-lg mb-4" style={{ color: stack.color }}>{stack.title}</h3>
              <ul className="space-y-2">
                {stack.items.map((item) => (
                  <li key={item} className="flex items-center gap-2 text-sm text-rx-gray-medium">
                    <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: stack.color }} />{item}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section className="section-container py-20">
        <div className="card p-8 sm:p-12 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-64 h-64 bg-rx-yellow/5 rounded-full blur-3xl" />
          <div className="relative grid grid-cols-1 lg:grid-cols-2 gap-8 items-center">
            <div>
              <div className="flex items-center gap-3 mb-4"><Shield className="w-8 h-8 text-rx-yellow" /><h2 className="text-2xl font-bold text-white">Enterprise Security</h2></div>
              <p className="text-rx-gray-medium leading-relaxed mb-6">Security is at the core of RX Store. Every application undergoes rigorous security review, and our infrastructure meets healthcare industry compliance standards.</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {['End-to-end encryption', 'HIPAA compliance', 'SOC 2 certified', 'Regular security audits', 'Role-based access control', 'Secure update verification', 'Rate limiting & DDoS protection', 'Malware scanning'].map((item) => (
                  <div key={item} className="flex items-center gap-2"><Check className="w-4 h-4 text-rx-yellow flex-shrink-0" /><span className="text-sm text-rx-gray-medium">{item}</span></div>
                ))}
              </div>
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
          <h2 className="text-3xl font-bold text-white mb-4">Ready to Get Started?</h2>
          <p className="text-rx-gray-medium mb-8 max-w-lg mx-auto">Join the RX Store ecosystem and discover applications built for professionals.</p>
          <Link to="/browse" className="btn-primary text-base inline-flex items-center gap-2 group">
            Explore Applications <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
          </Link>
        </div>
      </section>
    </div>
  );
}
