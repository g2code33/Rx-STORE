import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import DownloadModal from './DownloadModal';
import { Star, Download, ArrowRight } from 'lucide-react';
import { App } from '../../types';
import { formatDownloadCount, getRatingColor } from '../../utils/helpers';
import { useApps } from '../../context/AppContext';
import { useEditMode } from '../edit/EditMode';
import AppLogo from './AppLogo';
import { androidIsInstalled, desktopDetect, isAndroidShell, isDesktopShell } from '../../platform/nativeInstaller';

interface AppCardProps {
  app: App;
  variant?: 'default' | 'featured' | 'compact' | 'horizontal' | 'mobile-store';
}

export default function AppCard({ app, variant = 'default' }: AppCardProps) {
  const { installedApps, installApp } = useApps();
  const [showDl, setShowDl] = useState(false);
  const isInstalled = installedApps.includes(app.id);
  const [detected, setDetected] = React.useState(false);
  React.useEffect(() => {
    if (isDesktopShell()) desktopDetect({ windowsUninstallKey: app.windowsUninstallKey, windowsExecutable: app.windowsExecutable, linuxPackageName: app.linuxPackageName, linuxExecutable: app.linuxExecutable }).then(r=>setDetected(r.installed)).catch(()=>{});
    else if (isAndroidShell() && app.androidPackageId) androidIsInstalled(app.androidPackageId).then(r=>setDetected(r.installed)).catch(()=>{});
  }, [app.slug]); // eslint-disable-line react-hooks/exhaustive-deps
  const present = isInstalled || detected;
  const edit = useEditMode(); // Live Website Builder: pencil opens the full AppEditor

  if (variant === 'horizontal') {
    return (
      <Link
        to={`/app/${app.slug}`}
        className="card-hover p-4 flex items-center gap-4 group"
      >
        <AppLogo app={app} size="w-16 h-16" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-white group-hover:text-rx-yellow transition-colors truncate">
              {app.name}
            </h3>
            {app.isNew && <span className="badge-new">New</span>}
          </div>
          <p className="text-sm text-rx-gray-medium mt-0.5 line-clamp-1">{app.description}</p>
          <div className="flex items-center gap-4 mt-2">
            <div className="flex items-center gap-1">
              <Star className={`w-3.5 h-3.5 ${getRatingColor(app.rating)} fill-current`} />
              <span className="text-xs text-rx-gray-medium">{app.rating}</span>
            </div>
            <span className="text-xs text-rx-gray-medium">{formatDownloadCount(app.downloadCount)} downloads</span>
            <span className={`text-xs font-medium ${app.price === 'free' ? 'text-green-400' : 'text-rx-yellow'}`}>
              {app.price === 'free' ? 'Free' : app.price === 'subscription' ? `$${app.priceAmount}/mo` : `$${app.priceAmount}`}
            </span>
          </div>
        </div>
        <ArrowRight className="w-5 h-5 text-rx-gray-medium group-hover:text-rx-yellow transition-colors flex-shrink-0" />
      </Link>
    );
  }

  if (variant === 'compact') {
    return (
      <Link
        to={`/app/${app.slug}`}
        className="card-hover p-4 flex flex-col items-center text-center group"
      >
        <AppLogo app={app} size="w-14 h-14" text="text-xl" className="mb-3" />
        <h3 className="text-sm font-semibold text-white group-hover:text-rx-yellow transition-colors truncate w-full">
          {app.name}
        </h3>
        <p className="text-xs text-rx-gray-medium mt-0.5">{app.category}</p>
      </Link>
    );
  }

  if (variant === 'mobile-store') {
    return (
      <div className="flex items-center gap-3 py-3.5 border-b border-white/10 last:border-0">
        <Link to={`/app/${app.slug}`} className="flex items-center gap-3 flex-1 min-w-0 group">
          <AppLogo app={app} size="w-[72px] h-[72px]" text="text-3xl" rounded="rounded-[18px]" className="shadow-lg flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-semibold text-white truncate group-hover:text-rx-yellow">{app.name}</h3>
            <p className="text-xs text-rx-gray-medium truncate mt-0.5">{app.description}</p>
            <div className="flex items-center gap-2 mt-1.5 text-[11px] text-rx-gray-medium">
              {app.rating > 0 && <span className="flex items-center gap-0.5"><Star className="w-3 h-3 fill-current text-yellow-400" /> {app.rating}</span>}
              <span className="capitalize">{app.category}</span>
            </div>
          </div>
        </Link>
        <Link to={`/app/${app.slug}`} className={`flex-shrink-0 min-w-[64px] text-center px-4 py-1.5 rounded-full text-xs font-bold ${present ? 'bg-white/10 text-green-400' : 'bg-rx-yellow text-rx-dark'}`}>
          {present ? 'OPEN' : app.price === 'free' ? 'GET' : 'VIEW'}
        </Link>
      </div>
    );
  }

  return (
    <>
    <Link
      to={`/app/${app.slug}`}
      className="card-hover overflow-hidden group flex flex-col"
    >
      {/* Card Header / Icon Area — enlarged logo */}
      <div className={`relative h-44 bg-gradient-to-br ${app.gradient} p-6 flex items-center justify-center`}>
        <AppLogo app={app} size="w-28 h-28" text="text-7xl" rounded="rounded-3xl" className="transform group-hover:scale-110 transition-transform duration-500 drop-shadow-xl" />
        {/* Badges (booleans coerced upstream — never renders stray 0s) */}
        <div className="absolute top-3 left-3 flex gap-2">
          {!!app.isFeatured && (
            <span className="px-2 py-0.5 bg-rx-yellow/90 text-rx-dark text-[10px] font-bold rounded-md uppercase">
              Featured
            </span>
          )}
          {!!app.isNew && (
            <span className="px-2 py-0.5 bg-white/90 text-rx-dark text-[10px] font-bold rounded-md uppercase">
              New
            </span>
          )}
        </div>
        {app.status === 'beta' && (
          <div className="absolute top-3 right-3">
            <span className="badge-beta">Beta</span>
          </div>
        )}
        {edit?.editMode && (
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); edit.onEditApp?.(app); }}
            title={`Edit ${app.name}`}
            className="absolute bottom-3 right-3 z-20 px-2.5 py-1.5 rounded-lg bg-rx-yellow text-rx-dark text-[10px] font-bold shadow-lg hover:bg-rx-yellow-light transition-colors"
          >
            ✏️ Edit app
          </button>
        )}
        {/* Glow effect */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/30 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
      </div>

      {/* Card Body */}
      <div className="p-5 flex-1 flex flex-col">
        <div className="flex items-start justify-between gap-2 mb-2">
          <div>
            <h3 className="font-bold text-white group-hover:text-rx-yellow transition-colors text-lg">
              {app.name}
            </h3>
            <p className="text-xs text-rx-gray-medium mt-0.5">{app.developer}</p>
          </div>
        </div>

        <p className="text-sm text-rx-gray-medium line-clamp-2 mb-4 flex-1">
          {app.description}
        </p>

        {/* Stats + Install */}
        <div className="flex items-center justify-between mt-auto gap-2">
          <div className="flex items-center gap-3">
            {app.rating > 0 ? (
              <div className="flex items-center gap-1">
                <Star className={`w-4 h-4 ${getRatingColor(app.rating)} fill-current`} />
                <span className="text-sm font-medium text-white">{app.rating}</span>
              </div>
            ) : (
              <span className="text-xs text-rx-gray-medium">New</span>
            )}
            <div className="flex items-center gap-1 text-rx-gray-medium">
              <Download className="w-3.5 h-3.5" />
              <span className="text-xs">{formatDownloadCount(app.downloadCount)}</span>
            </div>
          </div>

          {present ? (
            <span className="text-xs font-medium text-green-400 bg-green-400/10 px-2.5 py-1 rounded-lg">Open</span>
          ) : (
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); const token=localStorage.getItem('rx-store-token'); if(!token){ window.location.href='/login'; return; } if((window as any).rxDesktop?.isDesktop){ window.location.href=`/app/${app.slug}`; return; } setShowDl(true); }}
              className={`text-xs font-bold px-3 py-1.5 rounded-lg transition-all ${app.price === 'free' ? 'bg-green-500 text-white hover:bg-green-600' : 'bg-rx-yellow text-rx-dark hover:bg-rx-yellow-light'}`}
            >
              {app.price === 'free'
                ? 'Install'
                : app.priceAmount
                  ? `Get $${app.priceAmount}${app.price === 'subscription' ? '/mo' : ''}`
                  : app.price === 'subscription' ? 'Subscribe' : 'Get'}
            </button>
          )}
        </div>

        {/* Platform tags */}
        <div className="flex items-center gap-1.5 mt-3 pt-3 border-t border-white/5">
          {app.platforms.map((platform) => (
            <span key={platform} className="text-[10px] bg-rx-dark-tertiary text-rx-gray-medium px-2 py-0.5 rounded">
              {platform}
            </span>
          ))}
        </div>
      </div>
    </Link>
    {showDl && <DownloadModal app={app} onClose={()=>setShowDl(false)} onDownload={async (platform)=>{
      const token=localStorage.getItem('rx-store-token');
      if(!token){ window.location.href='/login'; return; }
      try{
        const API=(import.meta as any).env?.VITE_API_URL;
        const r=await fetch(`${API.replace(/\/$/,'')}/apps/${app.slug}/download?platform=${platform}`,{headers:{'Authorization':`Bearer ${token}`}});
        const j=await r.json().catch(()=>null);
        if(!r.ok||!j?.success) throw new Error(j?.error?.message||'Download failed');
        if (j.data?.isPWA && j.data?.deploymentUrl) { window.open(j.data.deploymentUrl, '_blank'); setShowDl(false); return; }
        const url=j?.data?.url;
        const fr = await fetch(url);
        if(!fr.ok) throw new Error('File not found — upload may be incomplete');
        const blob = await fr.blob();
        if(blob.size===0) throw new Error('File is empty');
        const blobUrl=URL.createObjectURL(blob);
        const a=document.createElement('a'); a.href=blobUrl; a.download=`${app.slug}-${app.version}-${platform}`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(blobUrl),2000);
        window.dispatchEvent(new CustomEvent('rx-refresh'));
        const {default:toast}=await import('react-hot-toast'); toast.success(`Downloaded ${app.name} for ${platform} — open the file to install`);
        setShowDl(false);
      }catch(e:any){ const {default:toast}=await import('react-hot-toast'); toast.error(e.message + ' — not marked as complete, you can try again'); }
    }} />}
    </>
  );
}
