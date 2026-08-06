import React from 'react';
import { Link } from 'react-router-dom';
import { Github, Twitter, Linkedin, Mail, Heart } from 'lucide-react';

export default function Footer() {
  return (
    <footer className="bg-rx-dark border-t border-white/5">
      <div className="section-container py-16">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-12">
          {/* Brand */}
          <div className="lg:col-span-1">
            <Link to="/" className="flex items-center gap-2.5 mb-4">
              <div className="w-10 h-10 bg-rx-yellow rounded-lg flex items-center justify-center font-bold text-rx-dark text-base">
                Rx
              </div>
              <div>
                <span className="text-xl font-bold text-white">
                  RX <span className="text-rx-yellow">Store</span>
                </span>
                <span className="block text-[10px] text-rx-gray-medium -mt-0.5 tracking-wider">
                  BY CALCITONIN TECHNOLOGIES
                </span>
              </div>
            </Link>
            <p className="text-sm text-rx-gray-medium leading-relaxed mb-6">
              Professional digital marketplace for healthcare, education, productivity, and technology applications. 
              Discover, download, and manage all your essential tools.
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
              <a href="#" className="w-9 h-9 rounded-lg bg-rx-dark-tertiary flex items-center justify-center text-rx-gray-medium hover:text-rx-yellow hover:bg-rx-dark-secondary transition-all">
                <Mail className="w-4 h-4" />
              </a>
            </div>
          </div>

          {/* Platform */}
          <div>
            <h3 className="text-sm font-semibold text-white mb-4 uppercase tracking-wider">Platform</h3>
            <ul className="space-y-3">
              {['Browse Apps', 'Categories', 'Featured', 'New Releases', 'Updates'].map((item) => (
                <li key={item}>
                  <Link to="/browse" className="text-sm text-rx-gray-medium hover:text-rx-yellow transition-colors">
                    {item}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Developers */}
          <div>
            <h3 className="text-sm font-semibold text-white mb-4 uppercase tracking-wider">Developers</h3>
            <ul className="space-y-3">
              {['Developer Portal', 'API Documentation', 'Submit an App', 'SDK Downloads', 'Community Forum'].map((item) => (
                <li key={item}>
                  <a href="#" className="text-sm text-rx-gray-medium hover:text-rx-yellow transition-colors">
                    {item}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {/* Company */}
          <div>
            <h3 className="text-sm font-semibold text-white mb-4 uppercase tracking-wider">Company</h3>
            <ul className="space-y-3">
              {['About Calcitonin', 'Careers', 'Press Kit', 'Privacy Policy', 'Terms of Service'].map((item) => (
                <li key={item}>
                  <a href="#" className="text-sm text-rx-gray-medium hover:text-rx-yellow transition-colors">
                    {item}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Bottom */}
        <div className="mt-12 pt-8 border-t border-white/5 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-xs text-rx-gray-medium">
            © {new Date().getFullYear()} Calcitonin Technologies. All rights reserved.
          </p>
          <p className="text-xs text-rx-gray-medium flex items-center gap-1">
            Made with <Heart className="w-3 h-3 text-rx-yellow fill-rx-yellow" /> for Healthcare Innovation
          </p>
        </div>
      </div>
    </footer>
  );
}
