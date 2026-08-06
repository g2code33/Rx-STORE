import React from 'react';
import { Link } from 'react-router-dom';
import { Star, Download, ArrowRight } from 'lucide-react';
import { App } from '../../types';
import { formatDownloadCount, getRatingColor } from '../../utils/helpers';
import { useApps } from '../../context/AppContext';

interface AppCardProps {
  app: App;
  variant?: 'default' | 'featured' | 'compact' | 'horizontal';
}

export default function AppCard({ app, variant = 'default' }: AppCardProps) {
  const { installedApps } = useApps();
  const isInstalled = installedApps.includes(app.id);

  if (variant === 'horizontal') {
    return (
      <Link
        to={`/app/${app.slug}`}
        className="card-hover p-4 flex items-center gap-4 group"
      >
        <div className={`w-16 h-16 rounded-2xl bg-gradient-to-br ${app.gradient} flex items-center justify-center text-2xl flex-shrink-0 shadow-lg`}>
          {app.icon}
        </div>
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
        <div className={`w-14 h-14 rounded-2xl bg-gradient-to-br ${app.gradient} flex items-center justify-center text-xl shadow-lg mb-3`}>
          {app.icon}
        </div>
        <h3 className="text-sm font-semibold text-white group-hover:text-rx-yellow transition-colors truncate w-full">
          {app.name}
        </h3>
        <p className="text-xs text-rx-gray-medium mt-0.5">{app.category}</p>
      </Link>
    );
  }

  return (
    <Link
      to={`/app/${app.slug}`}
      className="card-hover overflow-hidden group flex flex-col"
    >
      {/* Card Header / Icon Area */}
      <div className={`relative h-40 bg-gradient-to-br ${app.gradient} p-6 flex items-center justify-center`}>
        <div className="text-6xl transform group-hover:scale-110 transition-transform duration-500">
          {app.icon}
        </div>
        {/* Badges */}
        <div className="absolute top-3 left-3 flex gap-2">
          {app.isFeatured && (
            <span className="px-2 py-0.5 bg-rx-yellow/90 text-rx-dark text-[10px] font-bold rounded-md uppercase">
              Featured
            </span>
          )}
          {app.isNew && (
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

        {/* Stats */}
        <div className="flex items-center justify-between mt-auto">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
              <Star className={`w-4 h-4 ${getRatingColor(app.rating)} fill-current`} />
              <span className="text-sm font-medium text-white">{app.rating}</span>
            </div>
            <div className="flex items-center gap-1 text-rx-gray-medium">
              <Download className="w-3.5 h-3.5" />
              <span className="text-xs">{formatDownloadCount(app.downloadCount)}</span>
            </div>
          </div>

          {isInstalled ? (
            <span className="text-xs font-medium text-green-400 bg-green-400/10 px-2.5 py-1 rounded-lg">
              Installed
            </span>
          ) : (
            <span className={`text-sm font-semibold ${app.price === 'free' ? 'text-green-400' : 'text-rx-yellow'}`}>
              {app.price === 'free' ? 'Free' : `$${app.priceAmount}${app.price === 'subscription' ? '/mo' : ''}`}
            </span>
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
  );
}
