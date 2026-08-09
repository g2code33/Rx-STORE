import React from 'react';

export const DEFAULT_STATS = [
  { label: 'Applications' },
  { label: 'Downloads' },
  { label: 'Platforms' },
  { label: 'Avg Rating' },
];

/** Live store stats — real counts only (admin-flagged dashboard or local sums). */
export default function StatsBar({ apps, labels }: { apps: any[]; labels: { label: string }[] }) {
  const [stats, setStats] = React.useState({ apps: apps.length || 0, downloads: 0, platforms: 5, rating: 0 });
  const avgRating = (list: any[]) => {
    const rated = list.filter((x) => (x.rating || 0) > 0);
    return rated.length ? rated.reduce((s: number, x: any) => s + (x.rating || 0), 0) / rated.length : 0;
  };
  React.useEffect(() => {
    const API = (import.meta as any).env?.VITE_API_URL;
    if (!API) {
      const totalDl = apps.reduce((s,a)=> s + (a.downloadCount||0), 0);
      setStats({ apps: apps.length, downloads: totalDl, platforms: 5, rating: Number(avgRating(apps).toFixed(1)) });
      return;
    }
    fetch(`${API.replace(/\/$/,'')}/admin/dashboard`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('rx-store-token')||''}` } })
      .then(r=>r.json()).then(j=>{
        const d=j.data||j;
        const totalDl = d.totalDownloads ?? apps.reduce((s,a)=> s + (a.downloadCount||0),0);
        const avg = d.averageRating ?? avgRating(apps);
        setStats({ apps: apps.length, downloads: totalDl, platforms: 5, rating: Number(Number(avg).toFixed(1)) });
      }).catch(()=>{
        const totalDl = apps.reduce((s,a)=> s + (a.downloadCount||0),0);
        setStats({ apps: apps.length, downloads: totalDl, platforms: 5, rating: Number(avgRating(apps).toFixed(1)) });
      });
  }, [apps]); // eslint-disable-line react-hooks/exhaustive-deps
  const fmt = (n:number)=> n>=1000 ? `${(n/1000).toFixed(n>=10000?0:1)}K` : String(n);
  const values = [
    String(stats.apps),
    stats.downloads === 0 ? '0' : fmt(stats.downloads),
    String(stats.platforms),
    stats.rating ? String(stats.rating) : '0.0',
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 mt-16 max-w-2xl mx-auto animate-slide-up" style={{ animationDelay: '0.3s' }}>
      {values.map((value, i) => (
        <div key={i} className="text-center">
          <p className="text-2xl sm:text-3xl font-bold text-rx-yellow">{value}</p>
          <p className="text-xs text-rx-gray-medium mt-1">{labels[i]?.label ?? DEFAULT_STATS[i].label}</p>
        </div>
      ))}
    </div>
  );
}
