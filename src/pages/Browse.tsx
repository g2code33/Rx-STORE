import React, { useMemo } from 'react';
import { Search, SlidersHorizontal, Grid3X3, List, X } from 'lucide-react';
import { useApps } from '../context/AppContext';
import { categories } from '../data/apps';
import AppCard from '../components/apps/AppCard';

export default function Browse() {
  const { apps, searchQuery, setSearchQuery, selectedCategory, setSelectedCategory, selectedPlatform, setSelectedPlatform, getFilteredApps } = useApps();
  const [viewMode, setViewMode] = React.useState<'grid' | 'list'>('grid');
  const [sortBy, setSortBy] = React.useState<'popular' | 'rating' | 'newest' | 'name'>('popular');

  const filteredApps = useMemo(() => {
    let result = getFilteredApps();
    switch (sortBy) {
      case 'rating':
        result = [...result].sort((a, b) => b.rating - a.rating);
        break;
      case 'newest':
        result = [...result].sort((a, b) => new Date(b.releaseDate).getTime() - new Date(a.releaseDate).getTime());
        break;
      case 'name':
        result = [...result].sort((a, b) => a.name.localeCompare(b.name));
        break;
      default:
        result = [...result].sort((a, b) => b.downloadCount - a.downloadCount);
    }
    return result;
  }, [getFilteredApps, sortBy]);

  const clearFilters = () => {
    setSearchQuery('');
    setSelectedCategory(null);
    setSelectedPlatform(null);
  };

  const hasFilters = searchQuery || selectedCategory || selectedPlatform;

  return (
    <div className="section-container py-8 lg:py-12">
      <div className="mb-8">
        <h1 className="text-3xl sm:text-4xl font-bold text-white">
          Browse <span className="gradient-text">Applications</span>
        </h1>
        <p className="mt-2 text-rx-gray-medium">
          Discover {apps.length} applications for healthcare, education, productivity, and more.
        </p>
      </div>

      <div className="flex flex-col lg:flex-row gap-4 mb-8">
        <div className="relative flex-1">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-rx-gray-medium" />
          <input
            type="text"
            placeholder="Search applications, categories, tags..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-rx-dark-secondary border border-white/10 rounded-xl pl-12 pr-4 py-3.5 text-white placeholder-rx-gray-medium focus:outline-none focus:border-rx-yellow/50 focus:ring-1 focus:ring-rx-yellow/25 transition-all"
          />
          {searchQuery && (
            <button onClick={() => setSearchQuery('')} className="absolute right-4 top-1/2 -translate-y-1/2 text-rx-gray-medium hover:text-white">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-3">
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as any)}
            className="bg-rx-dark-secondary border border-white/10 rounded-xl px-4 py-3.5 text-sm text-white focus:outline-none focus:border-rx-yellow/50 appearance-none cursor-pointer"
          >
            <option value="popular">Most Popular</option>
            <option value="rating">Highest Rated</option>
            <option value="newest">Newest</option>
            <option value="name">Name A-Z</option>
          </select>

          <div className="flex items-center bg-rx-dark-secondary border border-white/10 rounded-xl overflow-hidden">
            <button
              onClick={() => setViewMode('grid')}
              className={`p-3 transition-colors ${viewMode === 'grid' ? 'bg-rx-yellow/20 text-rx-yellow' : 'text-rx-gray-medium hover:text-white'}`}
            >
              <Grid3X3 className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={`p-3 transition-colors ${viewMode === 'list' ? 'bg-rx-yellow/20 text-rx-yellow' : 'text-rx-gray-medium hover:text-white'}`}
            >
              <List className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-8">
        <span className="text-xs text-rx-gray-medium uppercase tracking-wider font-medium flex items-center gap-1.5">
          <SlidersHorizontal className="w-3.5 h-3.5" /> Filters:
        </span>
        <button
          onClick={() => setSelectedCategory(null)}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
            !selectedCategory ? 'bg-rx-yellow text-rx-dark' : 'bg-rx-dark-tertiary text-rx-gray-medium hover:text-white hover:bg-rx-dark-secondary'
          }`}
        >
          All Categories
        </button>
        {categories.map((cat) => (
          <button
            key={cat.id}
            onClick={() => setSelectedCategory(selectedCategory === cat.id ? null : cat.id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              selectedCategory === cat.id ? 'bg-rx-yellow text-rx-dark' : 'bg-rx-dark-tertiary text-rx-gray-medium hover:text-white hover:bg-rx-dark-secondary'
            }`}
          >
            {cat.name}
          </button>
        ))}
        <div className="w-px h-5 bg-white/10 mx-1 hidden sm:block" />
        {['web', 'windows', 'linux', 'android', 'ios'].map((platform) => (
          <button
            key={platform}
            onClick={() => setSelectedPlatform(selectedPlatform === platform ? null : platform)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-all ${
              selectedPlatform === platform ? 'bg-rx-yellow text-rx-dark' : 'bg-rx-dark-tertiary text-rx-gray-medium hover:text-white hover:bg-rx-dark-secondary'
            }`}
          >
            {platform}
          </button>
        ))}
        {hasFilters && (
          <button onClick={clearFilters} className="px-3 py-1.5 rounded-lg text-xs font-medium text-red-400 hover:bg-red-400/10 transition-all">
            Clear All
          </button>
        )}
      </div>

      <div className="mb-6">
        <p className="text-sm text-rx-gray-medium">
          Showing <span className="text-white font-medium">{filteredApps.length}</span> application{filteredApps.length !== 1 ? 's' : ''}
          {searchQuery && <span> for "<span className="text-rx-yellow">{searchQuery}</span>"</span>}
        </p>
      </div>

      {filteredApps.length > 0 ? (
        viewMode === 'grid' ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {filteredApps.map((app) => (
              <AppCard key={app.id} app={app} />
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {filteredApps.map((app) => (
              <AppCard key={app.id} app={app} variant="horizontal" />
            ))}
          </div>
        )
      ) : (
        <div className="text-center py-20">
          <div className="text-5xl mb-4">🔍</div>
          <h3 className="text-xl font-semibold text-white mb-2">No applications found</h3>
          <p className="text-rx-gray-medium mb-6">Try adjusting your search or filters</p>
          <button onClick={clearFilters} className="btn-primary">Clear Filters</button>
        </div>
      )}
    </div>
  );
}
