export function formatDownloadCount(count: number): string {
  if (count >= 1000000) {
    return `${(count / 1000000).toFixed(1)}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(0)}K`;
  }
  return count.toString();
}

export function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function timeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;
  return `${Math.floor(diffDays / 365)} years ago`;
}

export function getRatingColor(rating: number): string {
  if (rating >= 4.5) return 'text-green-400';
  if (rating >= 4.0) return 'text-green-300';
  if (rating >= 3.5) return 'text-yellow-400';
  if (rating >= 3.0) return 'text-orange-400';
  return 'text-red-400';
}

export function cn(...classes: (string | boolean | undefined | null)[]): string {
  return classes.filter(Boolean).join(' ');
}

export function getPlatformIcon(platform: string): string {
  const icons: Record<string, string> = {
    web: '🌐',
    windows: '🪟',
    linux: '🐧',
    android: '🤖',
    ios: '🍎',
  };
  return icons[platform] || '📱';
}

export function getCategoryColor(category: string): string {
  const colors: Record<string, string> = {
    healthcare: 'from-red-500 to-pink-600',
    education: 'from-teal-400 to-cyan-500',
    productivity: 'from-blue-500 to-indigo-600',
    technology: 'from-green-400 to-emerald-600',
    gaming: 'from-yellow-400 to-orange-500',
    social: 'from-purple-400 to-violet-600',
  };
  return colors[category] || 'from-gray-400 to-gray-600';
}
