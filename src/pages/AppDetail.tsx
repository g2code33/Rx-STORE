import React, { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Star, Download, ArrowLeft, Share2, ExternalLink, Check, ChevronRight, Shield, Clock, Monitor, Calendar, Tag, ThumbsUp } from 'lucide-react';
import DownloadModal from '../components/apps/DownloadModal';
import AppLogo from '../components/apps/AppLogo';
import { useApps } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { useContent } from '../context/ContentContext';
import Editable from '../components/edit/Editable';
import PageBlocks from '../components/edit/PageBlocks';
import { formatDownloadCount, formatDate, getRatingColor } from '../utils/helpers';
import { normalizeWebsiteUrl } from '../utils/url';
import toast from 'react-hot-toast';

/** Internal paths navigate in-app, external URLs open a new tab, '#' stays inert. */
function DetailLink({ to, className, children }: { to: string; className?: string; children: React.ReactNode }) {
  if (/^https?:\/\//.test(to)) return <a href={to} target="_blank" rel="noreferrer" className={className}>{children}</a>;
  if (to && to !== '#') return <Link to={to} className={className}>{children}</Link>;
  return <a href="#" onClick={(e) => e.preventDefault()} className={className}>{children}</a>;
}

/** previewSlug: the Live Builder renders this page with a real app, no route. */
export default function AppDetail({ previewSlug }: { previewSlug?: string }) {
  const { slug: routeSlug } = useParams<{ slug: string }>();
  const slug = previewSlug ?? routeSlug;
  const { getAppBySlug, installedApps, installApp, uninstallApp, isLoading } = useApps();
  const { user } = useAuth();
  const { get, getJSON } = useContent();
  const app = getAppBySlug(slug || '');
  const [activeTab, setActiveTab] = useState<'overview' | 'reviews' | 'versions' | 'docs'>('overview');
  const [isInstalling, setIsInstalling] = useState(false);
  const [newRating, setNewRating] = useState(5);
  const [newComment, setNewComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showDownload, setShowDownload] = useState(false);
  const [lightbox, setLightbox] = useState<number | null>(null);
  // Screenshots whose objects are missing (404/403) get filtered out, never shown broken
  const [badShots, setBadShots] = useState<Set<number>>(() => new Set());
  const allShots: string[] = ((app?.screenshots as any[]) || []).filter((s: any) => typeof s === 'string' && !!s);
  const goodShots = allShots.filter((_, i) => !badShots.has(i));

  // Screenshot lightbox keyboard nav (Esc close, arrows move)
  React.useEffect(() => {
    if (lightbox === null) return;
    const n = goodShots.length;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null);
      if (e.key === 'ArrowRight') setLightbox((i) => (i === null ? null : (i + 1) % Math.max(n, 1)));
      if (e.key === 'ArrowLeft') setLightbox((i) => (i === null ? null : (i - 1 + Math.max(n, 1)) % Math.max(n, 1)));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox, goodShots.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Hooks first: `app` arrives a render later (context loads async), so no early return before this point.
  const isInstalled = app ? installedApps.includes(app.id) : false;
  const [liveReviews, setLiveReviews] = React.useState<any[] | null>(null);
  React.useEffect(() => {
    const API = (import.meta as any).env?.VITE_API_URL;
    if (!API || !app?.slug) return;
    fetch(`${API.replace(/\/$/,'')}/apps/${app.slug}/reviews`)
      .then(r=>r.json()).then(j=>{
        const arr = j?.data || j?.results || j;
        if (Array.isArray(arr)) {
          const mapped = arr.map((r:any)=>({
            id: r.id,
            appId: app.id,
            userId: r.user_id || r.userId,
            userName: r.user_name || r.userName || r.name || 'User',
            userAvatar: r.avatar_url || r.userAvatar || '👤',
            rating: r.rating,
            comment: r.comment,
            date: r.created_at || r.date || new Date().toISOString(),
            helpful: r.helpful_count ?? r.helpful ?? 0,
          }));
          setLiveReviews(mapped);
        }
      }).catch(()=>{});
  }, [app?.slug]);
  // Live reviews only — null (still loading) or empty both render "No reviews yet", never fabricated ones.
  const appReviews = liveReviews || [];

  if (isLoading && !app) {
    return (
      <div className="section-container py-20 text-center">
        <div className="w-10 h-10 border-2 border-rx-yellow border-t-transparent rounded-full animate-spin mx-auto mb-4" />
        <p className="text-rx-gray-medium">Loading application…</p>
      </div>
    );
  }

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

  const handleInstall = async () => {
    if (!user) { toast.error('Please sign in to install applications'); return; }
    if (isInstalled) return;
    setShowDownload(true);
  };
  const doDownload = async (platform: string) => {
    setIsInstalling(true);
    setShowDownload(false);
    try {
      const API = (import.meta as any).env?.VITE_API_URL;
      const token = localStorage.getItem('rx-store-token')||'';
      if (!API) {
        await new Promise((r) => setTimeout(r, 800));
        installApp(app.id);
        toast.success(`${app.name} installed`);
        setIsInstalling(false);
        return;
      }
      // Step 1: get download URL from API (counts as download + increments)
      const r = await fetch(`${API.replace(/\/$/,'')}/apps/${app.slug}/download?platform=${platform}`, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
      const j = await r.json().catch(()=>null);
      if (!r.ok || !j?.success) throw new Error(j?.error?.message || 'Download failed');

      const dlUrl = j?.data?.url;
      const isPWA = j?.data?.isPWA;
      if (isPWA && dlUrl) {
        window.open(dlUrl, '_blank');
        toast.success(`Opening ${app.name} PWA`);
        setIsInstalling(false);
        return;
      }

      // Step 2: actually fetch the file to ensure it exists and is downloadable
      toast(`Downloading ${app.name} (${platform})...`, { icon: '⬇️' });
      const fileRes = await fetch(dlUrl);
      if (!fileRes.ok) throw new Error(`File not found on storage (${fileRes.status}) — upload may be incomplete. Please try again or contact admin.`);
      const blob = await fileRes.blob();
      if (blob.size === 0) throw new Error('Downloaded file is empty — upload may be incomplete');

      // Step 3: trigger browser download with verified blob
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `${app.slug}-${app.version}-${platform}` + (dlUrl.split('.').pop()?.split('?')[0] ? '.'+dlUrl.split('.').pop()!.split('?')[0] : '');
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(()=> URL.revokeObjectURL(blobUrl), 2000);

      toast.success(`Installed ${app.name} for ${platform} — download verified and counted`);
      installApp(app.id);
      setTimeout(()=> (window as any).rxRefreshApps?.(), 500);
    } catch (e:any) {
      toast.error(e.message || 'Install failed — not marked as complete. You can try again.');
    }
    setIsInstalling(false);
  };

  const handleUninstall = () => {
    if (!confirm(`Uninstall ${app.name}? This will remove the app and its data from your device.`)) return;
    uninstallApp(app.id);
    toast.success(`${app.name} has been uninstalled`);
  };

  // The app's own website — set per app in the App Editor (Website URL field).
  const appWebsite = normalizeWebsiteUrl((app as any)?.website || '');

  const handleShare = async () => {
    const url = window.location.href;
    const payload = { title: `${app.name} — RX Store`, text: `${app.name}: ${app.description}`, url };
    try {
      if (typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share(payload); // user may cancel — that's not an error
      } else {
        await navigator.clipboard.writeText(url);
        toast.success('App link copied — paste it anywhere ✓');
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') return; // share sheet dismissed
      try { await navigator.clipboard.writeText(url); toast.success('App link copied ✓'); }
      catch { window.prompt('Copy this app link:', url); }
    }
  };

  const handleWebsite = () => {
    if (!appWebsite) {
      toast('No website published for this app yet.', { icon: 'ℹ️' });
      return;
    }
    window.open(appWebsite, '_blank', 'noopener,noreferrer');
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
            <ArrowLeft className="w-4 h-4" /> <Editable id="appd.back" label="'Back to Browse' link">{get('appd.back', 'Back to Browse')}</Editable>
          </Link>
          <div className="flex flex-col lg:flex-row gap-8 items-start">
            <div className="w-32 h-32 lg:w-44 lg:h-44 rounded-3xl bg-white/20 backdrop-blur-xl flex items-center justify-center text-6xl lg:text-7xl shadow-2xl flex-shrink-0 overflow-hidden">
              <AppLogo app={app} size="w-full h-full" text="text-6xl lg:text-7xl" rounded="rounded-3xl" className="!shadow-none" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-3xl lg:text-4xl font-bold text-white">{app.name}</h1>
                {!!app.isNew && <span className="px-2.5 py-1 bg-white/20 backdrop-blur-sm text-white text-xs font-bold rounded-lg">NEW</span>}
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
                {/* Share this app — native share sheet when available, else copy the link */}
                <button
                  onClick={handleShare}
                  title="Share this app"
                  aria-label="Share this app"
                  className="p-2 rounded-lg bg-white/10 text-white/70 hover:text-white hover:bg-white/20 transition-all"
                ><Share2 className="w-4 h-4" /></button>
                {/* Open the app's own website (set in the App Editor) */}
                <button
                  onClick={handleWebsite}
                  title={appWebsite ? `Visit website — ${appWebsite}` : 'No website published for this app yet'}
                  aria-label="Visit app website"
                  className={`p-2 rounded-lg transition-all ${appWebsite ? 'bg-white/10 text-white/70 hover:text-white hover:bg-white/20' : 'bg-white/5 text-white/30 hover:text-white/60 hover:bg-white/10'}`}
                ><ExternalLink className="w-4 h-4" /></button>
              </div>
            </div>
          </div>
        </div>
      </div>
      {showDownload && <DownloadModal app={app} onClose={()=>setShowDownload(false)} onDownload={doDownload} />}

      <div className="section-container py-8">
        <div className="flex gap-1 border-b border-white/10 mb-8 overflow-x-auto">
          {(['overview', 'reviews', 'versions', 'docs'] as const).map((tab) => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              className={`px-5 py-3 text-sm font-medium capitalize whitespace-nowrap transition-all border-b-2 -mb-px ${
                activeTab === tab ? 'text-rx-yellow border-rx-yellow' : 'text-rx-gray-medium border-transparent hover:text-white'
              }`}>
              <Editable id={`appd.tab.${tab}`} label={`Tab label — ${tab}`}>{get(`appd.tab.${tab}`, tab)}{tab === 'reviews' && ` (${appReviews.length})`}</Editable>
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2">
            {activeTab === 'overview' && (
              <div className="space-y-8 animate-fade-in">
                <div>
                  <h2 className="text-xl font-bold text-white mb-4"><Editable id="appd.aboutTitle" label="'About this application' heading">{get('appd.aboutTitle', 'About this application')}</Editable></h2>
                  {(app.longDescription || app.description || '').split('\n\n').map((paragraph, i) => (
                    <p key={i} className="text-rx-gray-medium leading-relaxed mb-4">{paragraph}</p>
                  ))}
                </div>
                <div>
                  <h2 className="text-xl font-bold text-white mb-4"><Editable id="appd.featuresTitle" label="'Key Features' heading">{get('appd.featuresTitle', 'Key Features')}</Editable></h2>
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
                  <h2 className="text-xl font-bold text-white mb-4"><Editable id="appd.shotsTitle" label="'Screenshots' heading">{get('appd.shotsTitle', 'Screenshots')}</Editable></h2>
                  {goodShots.length > 0 ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {allShots.map((url: string, i: number) => {
                        if (badShots.has(i)) return null;
                        const goodIdx = goodShots.indexOf(url);
                        return (
                          <button
                            key={i}
                            onClick={() => setLightbox(goodIdx)}
                            className="relative group/shot focus:outline-none focus:ring-2 focus:ring-rx-yellow/60 rounded-xl"
                            title="Click to view full size"
                          >
                            <img
                              src={url}
                              alt={`Screenshot ${i+1}`}
                              loading="lazy"
                              onError={() => setBadShots((s) => new Set(s).add(i))}
                              className="aspect-video w-full rounded-xl object-cover border border-white/10 group-hover/shot:border-rx-yellow/40 transition-colors"
                            />
                            <span className="absolute inset-0 rounded-xl bg-black/0 group-hover/shot:bg-black/25 transition-colors flex items-center justify-center opacity-0 group-hover/shot:opacity-100">
                              <span className="text-xs font-semibold text-white bg-black/60 px-3 py-1.5 rounded-full">⤢ View full</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <Editable id="appd.shotsEmpty" label="Empty-screenshots hint ({n} = number)" group>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {[1, 2, 3, 4].map((i) => (
                          <div key={i} className={`aspect-video rounded-xl bg-gradient-to-br ${app.gradient || 'from-rx-dark to-rx-dark-secondary'} opacity-40 flex items-center justify-center`}>
                            <span className="text-white/50 text-sm">{get('appd.shotsEmpty', 'Screenshot {n} — upload in Admin → Edit').replace(/\{n\}/g, String(i))}</span>
                          </div>
                        ))}
                      </div>
                    </Editable>
                  )}
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
                {user && (
                  <div className="card p-5">
                    <h4 className="font-semibold text-white mb-3"><Editable id="appd.writeReview" label="'Write a review' heading">{get('appd.writeReview', 'Write a review')}</Editable></h4>
                    <div className="flex items-center gap-2 mb-3">
                      {[1,2,3,4,5].map(s=>(
                        <button key={s} onClick={()=>setNewRating(s)} className={`w-8 h-8 rounded-lg flex items-center justify-center ${s<=newRating ? 'bg-rx-yellow text-rx-dark' : 'bg-white/10 text-white'}`}><Star className={`w-4 h-4 ${s<=newRating ? 'fill-current' : ''}`} /></button>
                      ))}
                      <span className="text-sm text-rx-gray-medium ml-2">{newRating} stars</span>
                    </div>
                    <textarea value={newComment} onChange={e=>setNewComment(e.target.value)} placeholder="Share your experience..." rows={3} className="w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder:text-rx-gray-medium" />
                    <button
                      onClick={async()=>{
                        if(!newComment.trim()) { toast.error('Please write a comment'); return; }
                        setSubmitting(true);
                        try {
                          const API=(import.meta as any).env?.VITE_API_URL;
                          const token=localStorage.getItem('rx-store-token')||'';
                          const r=await fetch(`${API.replace(/\/$/,'')}/apps/${app.slug}/reviews`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},body:JSON.stringify({rating:newRating, comment:newComment})});
                          const j=await r.json();
                          if(!r.ok) throw new Error(j.error?.message||'Failed');
                          toast.success('Review submitted');
                          setNewComment('');
                          window.location.reload();
                        } catch(e:any){ toast.error(e.message); }
                        setSubmitting(false);
                      }}
                      disabled={submitting}
                      className="mt-3 btn-primary text-sm px-4 py-2 disabled:opacity-50"
                    >
                      {submitting ? 'Submitting...' : 'Submit Review'}
                    </button>
                  </div>
                )}
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
                  <div className="text-center py-12"><p className="text-rx-gray-medium"><Editable id="appd.noReviews" type="textarea" label="No-reviews message">{get('appd.noReviews', 'No reviews yet. Be the first to review!')}</Editable></p></div>
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
                  <h3 className="text-xl font-bold text-white mb-2"><Editable id="appd.docsTitle" label="Docs card heading">{get('appd.docsTitle', 'Documentation')}</Editable></h3>
                  <p className="text-rx-gray-medium mb-6">
                    <Editable id="appd.docsBody" type="textarea" label="Docs card body ({app} = app name)">{get('appd.docsBody', 'Comprehensive documentation for {app} is available on our developer portal.').replace(/\{app\}/g, app.name)}</Editable>
                  </p>
                  <Editable id="appd.docsBtn" type="link" label="'Open Documentation' button">
                    <DetailLink to={getJSON('appd.docsBtn', { label: 'Open Documentation', to: '#' }).to} className="btn-primary inline-flex items-center gap-2">
                      <ExternalLink className="w-4 h-4" /> {getJSON('appd.docsBtn', { label: 'Open Documentation', to: '#' }).label}
                    </DetailLink>
                  </Editable>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-6">
            <div className="card p-6 space-y-4">
              <h3 className="font-bold text-white text-lg"><Editable id="appd.infoTitle" label="'Information' card title">{get('appd.infoTitle', 'Information')}</Editable></h3>
              <div className="space-y-3">
                {[
                  { icon: Calendar, label: 'Released', value: app.releaseDate ? formatDate(app.releaseDate) : '—' },
                  { icon: Clock, label: 'Updated', value: app.lastUpdated ? formatDate(app.lastUpdated) : '—' },
                  { icon: Monitor, label: 'Size', value: app.size || '—' },
                  { icon: Tag, label: 'Version', value: app.version },
                ].map((item) => (
                  <div key={item.label} className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
                    <div className="flex items-center gap-2 text-rx-gray-medium">
                      <item.icon className="w-4 h-4" /><span className="text-sm">{item.label}</span>
                    </div>
                    <span className="text-sm text-white font-medium">{item.value}</span>
                  </div>
                ))}
                <Editable id="appd.securityValue" label="Security row value" group>
                  <div className="flex items-center justify-between py-2">
                    <div className="flex items-center gap-2 text-rx-gray-medium">
                      <Shield className="w-4 h-4" /><span className="text-sm">Security</span>
                    </div>
                    <span className="text-sm text-white font-medium">{get('appd.securityValue', 'Verified & Safe')}</span>
                  </div>
                </Editable>
              </div>
            </div>
            <div className="card p-6">
              <h3 className="font-bold text-white mb-3"><Editable id="appd.tagsTitle" label="'Tags' card title">{get('appd.tagsTitle', 'Tags')}</Editable></h3>
              <div className="flex flex-wrap gap-2">
                {(app.tags || []).map((tag: any) => (
                  <span key={tag} className="px-2.5 py-1 bg-rx-dark-tertiary text-rx-gray-medium text-xs rounded-lg hover:text-rx-yellow hover:bg-rx-yellow/10 transition-all cursor-pointer">#{tag}</span>
                ))}
              </div>
            </div>
            <div className="card p-6">
              <h3 className="font-bold text-white mb-3"><Editable id="appd.devTitle" label="'Developer' card title">{get('appd.devTitle', 'Developer')}</Editable></h3>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-rx-yellow/20 flex items-center justify-center"><span className="text-rx-yellow font-bold text-sm">CT</span></div>
                <div><p className="text-sm font-medium text-white">{app.developer}</p><p className="text-xs text-rx-gray-medium"><Editable id="appd.verifiedPublisher" label="'Verified Publisher' line">{get('appd.verifiedPublisher', 'Verified Publisher')}</Editable></p></div>
              </div>
            </div>
          </div>
        </div>

        {/* Custom sections inserted via Builder → Add Block */}
        <PageBlocks pageId="appDetail" inContainer />
      </div>

      {/* Full-size screenshot viewer (lightbox) */}
      {lightbox !== null && goodShots[lightbox] && (
        <div
          className="fixed inset-0 z-[60] bg-black/90 backdrop-blur-sm flex items-center justify-center p-4 sm:p-8"
          onClick={() => setLightbox(null)}
        >
          <button
            className="absolute top-4 right-4 w-10 h-10 rounded-xl bg-white/10 hover:bg-white/20 flex items-center justify-center text-white"
            onClick={() => setLightbox(null)}
            aria-label="Close viewer"
          >
            ✕
          </button>
          {goodShots.length > 1 && (
            <>
              <button
                className="absolute left-3 sm:left-6 top-1/2 -translate-y-1/2 w-10 h-10 rounded-xl bg-white/10 hover:bg-white/20 flex items-center justify-center text-white text-lg"
                onClick={(e) => { e.stopPropagation(); setLightbox((lightbox - 1 + goodShots.length) % goodShots.length); }}
                aria-label="Previous screenshot"
              >
                ‹
              </button>
              <button
                className="absolute right-3 sm:right-6 top-1/2 -translate-y-1/2 w-10 h-10 rounded-xl bg-white/10 hover:bg-white/20 flex items-center justify-center text-white text-lg"
                onClick={(e) => { e.stopPropagation(); setLightbox((lightbox + 1) % goodShots.length); }}
                aria-label="Next screenshot"
              >
                ›
              </button>
            </>
          )}
          <img
            src={goodShots[lightbox]}
            alt={`Screenshot ${lightbox + 1} full size`}
            className="max-w-full max-h-full rounded-xl object-contain shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            onError={() => setLightbox(null)}
          />
          <span className="absolute bottom-4 left-1/2 -translate-x-1/2 text-xs text-white/60">
            {lightbox + 1} / {goodShots.length} — click outside or Esc to close
          </span>
        </div>
      )}
    </div>
  );
}
