/**
 * /developer/:id — PUBLIC developer profile (Phase 11 §7).
 * Only public profile fields + published apps. Never exposes private contact
 * data, members, or audit info (the backend endpoint enforces the same).
 */
import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Globe, LifeBuoy, Calendar, ArrowLeft, AlertCircle } from 'lucide-react';
import { api, isApiConfigured } from '../../services/api';
import { formatDate } from '../../utils/helpers';
import AppLogo from '../../components/apps/AppLogo';

export default function PublicDeveloperProfile() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isApiConfigured()) { setLoading(false); setError('not-configured'); return; }
    let alive = true;
    api.developers.publicProfile(String(id || ''))
      .then((d) => { if (alive) setData(d); })
      .catch((e: any) => { if (alive) setError(e?.message || 'Developer not found'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [id]);

  const dev = data?.developer;

  return (
    <div className="section-container max-w-4xl py-10 md:py-14">
      <Link to="/browse" className="inline-flex items-center gap-1.5 text-sm text-rx-gray-medium hover:text-white transition-colors">
        <ArrowLeft className="w-4 h-4" /> Browse apps
      </Link>

      {loading ? (
        <div className="card p-8 mt-6 animate-pulse space-y-4">
          <div className="flex gap-4 items-center"><div className="w-20 h-20 bg-white/5 rounded-2xl" /><div className="space-y-2 flex-1"><div className="h-5 bg-white/5 rounded w-1/2" /><div className="h-3 bg-white/5 rounded w-1/3" /></div></div>
        </div>
      ) : error ? (
        <div className="card p-10 mt-6 text-center">
          <AlertCircle className="w-10 h-10 text-rx-yellow mx-auto" />
          <h1 className="text-xl font-bold text-white mt-4">{error === 'not-configured' ? 'Backend not connected' : 'Developer not found'}</h1>
          <p className="text-sm text-rx-gray-medium mt-2">{error === 'not-configured' ? 'Install a correctly configured build.' : 'This developer profile does not exist or is not active.'}</p>
        </div>
      ) : (
        <>
          {/* Header */}
          <div className="card p-6 md:p-8 mt-6">
            <div className="flex flex-col sm:flex-row sm:items-center gap-5">
              {dev?.logo ? (
                <img src={dev.logo} alt={dev.publisherName} className="w-20 h-20 rounded-2xl object-cover border border-white/10" />
              ) : (
                <div className="w-20 h-20 rounded-2xl bg-rx-yellow/10 border border-rx-yellow/20 flex items-center justify-center text-3xl">🏢</div>
              )}
              <div className="flex-1 min-w-0">
                <h1 className="text-2xl font-black text-white truncate">{dev?.publisherName || 'Developer'}</h1>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-sm text-rx-gray-medium">
                  <span className="inline-flex items-center gap-1.5"><Calendar className="w-3.5 h-3.5" /> Developer since {formatDate(dev?.developerSince)}</span>
                  {dev?.website && <a href={dev.website} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-rx-yellow hover:underline"><Globe className="w-3.5 h-3.5" /> Website</a>}
                  {dev?.supportUrl && <a href={dev.supportUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-rx-yellow hover:underline"><LifeBuoy className="w-3.5 h-3.5" /> Support</a>}
                </div>
              </div>
            </div>
            {dev?.description && <p className="text-rx-gray-medium mt-5 leading-relaxed">{dev.description}</p>}
          </div>

          {/* Apps */}
          <h2 className="text-lg font-bold text-white mt-10">
            Applications <span className="text-rx-gray-medium font-normal">({data?.apps?.length || 0})</span>
          </h2>
          {(data?.apps || []).length === 0 ? (
            <div className="card p-8 text-center mt-4">
              <p className="text-sm text-rx-gray-medium">This developer has no published applications yet.</p>
            </div>
          ) : (
            <div className="grid sm:grid-cols-2 gap-3 mt-4">
              {data.apps.map((a: any) => (
                <Link key={a.slug} to={`/app/${a.slug}`} className="card p-4 flex items-center gap-4 hover:bg-white/[0.03] transition-colors">
                  <AppLogo app={a} size="w-14 h-14" />
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-white truncate">{a.name}</p>
                    <p className="text-xs text-rx-gray-medium line-clamp-2 mt-0.5">{a.description}</p>
                    <p className="text-xs text-rx-gray-medium mt-1">⭐ {a.rating || 0} · {a.download_count || 0} downloads</p>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
