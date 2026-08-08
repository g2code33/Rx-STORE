import React, { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Star, Download, ArrowLeft, Share2, ExternalLink, Check, ChevronRight, Shield, Clock, Monitor, Calendar, Tag, ThumbsUp } from 'lucide-react';
import { useApps } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { reviews } from '../data/apps';
import { formatDownloadCount, formatDate, getRatingColor } from '../utils/helpers';
import toast from 'react-hot-toast';

export default function AppDetail() {
  const { slug } = useParams<{ slug: string }>();
  const { getAppBySlug, installedApps, installApp, uninstallApp } = useApps();
  const { user } = useAuth();
  const app = getAppBySlug(slug || '');
  const [activeTab, setActiveTab] = useState<'overview' | 'reviews' | 'versions' | 'docs'>('overview');
  const [isInstalling, setIsInstalling] = useState(false);

  if (!app) {
    return (
      <div className="section-container py-20 text-center">
        <div className="text-6xl mb-4">🔍</div>
        <h2 className="text-2xl font-bold text-white mb-2">Application Not Found</h2>
        <p className="text-rx-gray-medium mb-6">The application you're looking for doesn't exist.</p>
        <Link to="/browse" className="btn-primary">Browse Applications</Link>
      </div>
    );
  }

  const isInstalled = installedApps.includes(app.id);
  const appReviews = reviews.filter((r) => r.appId === app.id);

  const handleInstall = async () => {
    if (!user) { toast.error('Please sign in to install applications'); return; }
    setIsInstalling(true);
    await new Promise((r) => setTimeout(r, 2000));
    installApp(app.id);
    setIsInstalling(false);
    toast.success(`${app.name} installed successfully!`);
  };

  const handleUninstall = () => {
    uninstallApp(app.id);
    toast.success(`${app.name} has been uninstalled`);
  };

  const ratingDistribution = [5, 4, 3, 2, 1].map((stars) => ({
    stars,
    count: appReviews.filter((r) => r.rating === stars).length,
    percentage: appReviews.length > 0 ? (appReviews.filter((r) => r.rating === stars).length / appReviews.length) * 100 : 0,
  }));

  return (
    <div className="min-h-screen">
      <div className={`relative bg-gradient-to-br ${app.gradient || 'from-rx-dark to-rx-dark-secondary'}`}>
        <div className="absolute inset-0 bg-black/20" />
        <div className="relative section-container py-12 lg:py-16">
          <Link to="/browse" className="inline-flex items-center gap-2 text-white/70 hover:text-white text-sm mb-6 transition-colors">
            <ArrowLeft className="w-4 h-4" /> Back to Browse
          </Link>
          <div className="flex flex-col lg:flex-row gap-8 items-start">
            <div className="w-24 h-24 lg:w-32 lg:h-32 rounded-3xl bg-white/20 backdrop-blur-xl flex items-center justify-center text-5xl lg:text-6xl shadow-2xl flex-shrink-0">
              {app.icon}
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-3xl lg:text-4xl font-bold text-white">{app.name}</h1>
                {app.isNew && <span className="px-2.5 py-1 bg-white/20 backdrop-blur-sm text-white text-xs font-bold rounded-lg">NEW</span>}
                {app.status === 'beta' && <span className="px-2.5 py-1 bg-purple-500/30 backdrop-blur-sm text-white text-xs font-bold rounded-lg">BETA</span>}
              </div>
              <p className="text-white/70 mt-1">{app.developer}</p>
              <div className="flex items-center gap-6 mt-4 flex-wrap">
                <div className="flex items-center gap-1.5">
                  <Star className="w-5 h-5 text-yellow-300 fill-yellow-300" />
                  <span className="text-white font-bold text-lg">{app.rating}</span>
                  <span className="text-white/60 text-sm">({formatDownloadCount(app.reviewCount)} reviews)</span>
                </div>
                <div className="flex items-center gap-1.5 text-white/70">
                  <Download className="w-4 h-4" />
                  <span className="text-sm">{formatDownloadCount(app.downloadCount)} downloads</span>
                </div>
                <div className="flex items-center gap-1.5 text-white/70">
                  <Tag className="w-4 h-4" />
                  <span className="text-sm capitalize">{app.category}</span>
                </div>
              </div>
              <div className="flex items-center gap-2 mt-4">
                {(app.platforms || []).map((p: any) => (
                  <span key={p} className="px-3 py-1 bg-white/10 backdrop-blur-sm text-white/90 text-xs rounded-lg capitalize">{p}</span>
                ))}
              </div>
            </div>
            <div className="flex flex-col items-end gap-3 flex-shrink-0">
              {isInstalled ? (
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-2 text-green-300 font-medium"><Check className="w-5 h-5" /> Installed</span>
                  <button onClick={handleUninstall} className="px-4 py-2.5 bg-white/10 backdrop-blur-sm text-white rounded-xl text-sm hover:bg-white/20 transition-all">Uninstall</button>
                </div>
              ) : (
                <button onClick={handleInstall} disabled={isInstalling} className="px-8 py-3.5 bg-white text-rx-dark font-bold rounded-xl hover:bg-white/90 transition-all active:scale-95 disabled:opacity-70 flex items-center gap-2 shadow-lg">
                  {isInstalling ? (
                    <><div className="w-4 h-4 border-2 border-rx-dark/30 border-t-rx-dark rounded-full animate-spin" />Installing...</>
                  ) : (
                    <><Download className="w-5 h-5" />{app.price === 'free' ? 'Install Free' : `Get — $${app.priceAmount}${app.price === 'subscription' ? '/mo' : ''}`}</>
                  )}
                </button>
              )}
              <div className="flex items-center gap-2">
                <button className="p-2 rounded-lg bg-white/10 text-white/70 hover:text-white hover:bg-white/20 transition-all"><Share2 className="w-4 h-4" /></button>
                <button className="p-2 rounded-lg bg-white/10 text-white/70 hover:text-white hover:bg-white/20 transition-all"><ExternalLink className="w-4 h-4" /></button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="section-container py-8">
        <div className="flex gap-1 border-b border-white/10 mb-8 overflow-x-auto">
          {(['overview', 'reviews', 'versions', 'docs'] as const).map((tab) => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              className={`px-5 py-3 text-sm font-medium capitalize whitespace-nowrap transition-all border-b-2 -mb-px ${
                activeTab === tab ? 'text-rx-yellow border-rx-yellow' : 'text-rx-gray-medium border-transparent hover:text-white'
              }`}>
              {tab}{tab === 'reviews' && ` (${appReviews.length})`}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2">
            {activeTab === 'overview' && (
              <div className="space-y-8 animate-fade-in">
                <div>
                  <h2 className="text-xl font-bold text-white mb-4">About this application</h2>
                  {app.longDescription.split('\n\n').map((paragraph, i) => (
                    <p key={i} className="text-rx-gray-medium leading-relaxed mb-4">{paragraph}</p>
                  ))}
                </div>
                <div>
                  <h2 className="text-xl font-bold text-white mb-4">Key Features</h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {(app.features || []).map((feature, i) => (
                      <div key={i} className="flex items-start gap-3 p-3 rounded-xl bg-rx-dark-secondary/50 border border-white/5">
                        <div className="w-6 h-6 rounded-lg bg-rx-yellow/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                          <Check className="w-3.5 h-3.5 text-rx-yellow" />
                        </div>
                        <span className="text-sm text-rx-gray-medium">{feature}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <h2 className="text-xl font-bold text-white mb-4">Screenshots</h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {[1, 2, 3, 4].map((i) => (
                      <div key={i} className={`aspect-video rounded-xl bg-gradient-to-br ${app.gradient || 'from-rx-dark to-rx-dark-secondary'} opacity-40 flex items-center justify-center`}>
                        <span className="text-white/50 text-sm">Screenshot {i}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {activeTab === 'reviews' && (
              <div className="space-y-6 animate-fade-in">
                <div className="card p-6">
                  <div className="flex items-center gap-8">
                    <div className="text-center">
                      <p className={`text-5xl font-bold ${getRatingColor(app.rating)}`}>{app.rating}</p>
                      <div className="flex items-center gap-1 mt-2 justify-center">
                        {[1, 2, 3, 4, 5].map((s) => (
                          <Star key={s} className={`w-4 h-4 ${s <= Math.round(app.rating) ? 'text-yellow-400 fill-yellow-400' : 'text-gray-600'}`} />
                        ))}
                      </div>
                      <p className="text-xs text-rx-gray-medium mt-1">{formatDownloadCount(app.reviewCount)} reviews</p>
                    </div>
                    <div className="flex-1 space-y-2">
                      {ratingDistribution.map((d) => (
                        <div key={d.stars} className="flex items-center gap-2">
                          <span className="text-xs text-rx-gray-medium w-3">{d.stars}</span>
                          <Star className="w-3 h-3 text-yellow-400 fill-yellow-400" />
                          <div className="flex-1 h-2 bg-rx-dark-tertiary rounded-full overflow-hidden">
                            <div className="h-full bg-yellow-400 rounded-full" style={{ width: `${d.percentage}%` }} />
                          </div>
                          <span className="text-xs text-rx-gray-medium w-6">{d.count}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                {appReviews.length > 0 ? appReviews.map((review) => (
                  <div key={review.id} className="card p-5">
                    <div className="flex items-start gap-4">
                      <div className="w-10 h-10 rounded-xl bg-rx-dark-tertiary flex items-center justify-center text-lg flex-shrink-0">{review.userAvatar}</div>
                      <div className="flex-1">
                        <div className="flex items-center justify-between">
                          <h4 className="font-semibold text-white">{review.userName}</h4>
                          <span className="text-xs text-rx-gray-medium">{formatDate(review.date)}</span>
                        </div>
                        <div className="flex items-center gap-1 mt-1">
                          {[1, 2, 3, 4, 5].map((s) => (
                            <Star key={s} className={`w-3.5 h-3.5 ${s <= review.rating ? 'text-yellow-400 fill-yellow-400' : 'text-gray-600'}`} />
                          ))}
                        </div>
                        <p className="text-sm text-rx-gray-medium mt-2 leading-relaxed">{review.comment}</p>
                        <button className="flex items-center gap-1 text-xs text-rx-gray-medium hover:text-rx-yellow transition-colors mt-3">
                          <ThumbsUp className="w-3.5 h-3.5" /> Helpful ({review.helpful})
                        </button>
                      </div>
                    </div>
                  </div>
                )) : (
                  <div className="text-center py-12"><p className="text-rx-gray-medium">No reviews yet. Be the first to review!</p></div>
                )}
              </div>
            )}
            {activeTab === 'versions' && (
              <div className="space-y-4 animate-fade-in">
                <div className="card p-5 border-l-4 border-l-rx-yellow">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="font-bold text-white">Version {app.version}</h4>
                    <span className="text-xs text-rx-gray-medium">Latest · {formatDate(app.lastUpdated)}</span>
                  </div>
                  <ul className="space-y-2">
                    {(app.releaseNotes || []).map((note: any, i: number) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-rx-gray-medium">
                        <ChevronRight className="w-4 h-4 text-rx-yellow flex-shrink-0 mt-0.5" />{note}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="card p-5 opacity-60">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="font-bold text-white">Previous Version</h4>
                    <span className="text-xs text-rx-gray-medium">{formatDate('2024-10-15')}</span>
                  </div>
                  <ul className="space-y-2">
                    <li className="flex items-start gap-2 text-sm text-rx-gray-medium"><ChevronRight className="w-4 h-4 text-rx-yellow flex-shrink-0 mt-0.5" />Bug fixes and performance improvements</li>
                    <li className="flex items-start gap-2 text-sm text-rx-gray-medium"><ChevronRight className="w-4 h-4 text-rx-yellow flex-shrink-0 mt-0.5" />Updated dependencies</li>
                  </ul>
                </div>
              </div>
            )}
            {activeTab === 'docs' && (
              <div className="animate-fade-in">
                <div className="card p-8 text-center">
                  <div className="text-4xl mb-4">📖</div>
                  <h3 className="text-xl font-bold text-white mb-2">Documentation</h3>
                  <p className="text-rx-gray-medium mb-6">Comprehensive documentation for {app.name} is available on our developer portal.</p>
                  <a href="#" className="btn-primary inline-flex items-center gap-2"><ExternalLink className="w-4 h-4" /> Open Documentation</a>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-6">
            <div className="card p-6 space-y-4">
              <h3 className="font-bold text-white text-lg">Information</h3>
              <div className="space-y-3">
                {[
                  { icon: Calendar, label: 'Released', value: app.releaseDate ? formatDate(app.releaseDate) : '—' },
                  { icon: Clock, label: 'Updated', value: app.lastUpdated ? formatDate(app.lastUpdated) : '—' },
                  { icon: Monitor, label: 'Size', value: app.size || '—' },
                  { icon: Tag, label: 'Version', value: app.version },
                  { icon: Shield, label: 'Security', value: 'Verified & Safe' },
                ].map((item) => (
                  <div key={item.label} className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
                    <div className="flex items-center gap-2 text-rx-gray-medium">
                      <item.icon className="w-4 h-4" /><span className="text-sm">{item.label}</span>
                    </div>
                    <span className="text-sm text-white font-medium">{item.value}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="card p-6">
              <h3 className="font-bold text-white mb-3">Tags</h3>
              <div className="flex flex-wrap gap-2">
                {(app.tags || []).map((tag: any) => (
                  <span key={tag} className="px-2.5 py-1 bg-rx-dark-tertiary text-rx-gray-medium text-xs rounded-lg hover:text-rx-yellow hover:bg-rx-yellow/10 transition-all cursor-pointer">#{tag}</span>
                ))}
              </div>
            </div>
            <div className="card p-6">
              <h3 className="font-bold text-white mb-3">Developer</h3>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-rx-yellow/20 flex items-center justify-center"><span className="text-rx-yellow font-bold text-sm">CT</span></div>
                <div><p className="text-sm font-medium text-white">{app.developer}</p><p className="text-xs text-rx-gray-medium">Verified Publisher</p></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
