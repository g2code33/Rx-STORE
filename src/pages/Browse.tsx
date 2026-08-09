import React, { useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { SlidersHorizontal, Grid3X3, List, X } from 'lucide-react';
import { useApps } from '../context/AppContext';
import { useCategories } from '../hooks/useCategories';
import AppCard from '../components/apps/AppCard';
import { useContent } from '../context/ContentContext';
import Editable from '../components/edit/Editable';
import PageBlocks from '../components/edit/PageBlocks';
import SearchBox from '../components/search/SearchBox';

export default function Browse() {
  const { apps, isLoading, searchQuery, setSearchQuery, selectedCategory, setSelectedCategory, selectedPlatform, setSelectedPlatform, getFilteredApps } = useApps();
  const categories = useCategories();
  const { get } = useContent();
  const [viewMode, setViewMode] = React.useState<'grid' | 'list'>('grid');
  const [sortBy, setSortBy] = React.useState<'popular' | 'rating' | 'newest' | 'name'>('popular');

  // Deep links: ?featured=1 → only featured, ?sort=newest, ?q=… → run that
  // search (header search submits here — open Browse and search for you).
  const location = useLocation();
  const [featuredOnly, setFeaturedOnly] = React.useState(false);
  React.useEffect(() => {
    const p = new URLSearchParams(location.search);
    setFeaturedOnly(p.get('featured') === '1');
    if (p.get('sort') === 'newest') setSortBy('newest');
    const q = p.get('q');
    if (q !== null && q !== searchQuery) setSearchQuery(q);
  }, [location.search]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredApps = useMemo(() => {
    let result = getFilteredApps();
    if (featuredOnly) result = result.filter((a: any) => a.isFeatured);
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

  // Editable copy — {count} is replaced with the live number of applications
  const subtitle = get('browse.sub', 'Discover {count} applications for healthcare, education, productivity, and more.').replace(/\{count\}/g, String(apps.length));
  const searchPlaceholder = get('browse.searchPlaceholder', 'Search applications, categories, tags...');

  return (
    <div className="section-container py-8 lg:py-12">
      <div className="mb-8">
        <h1 className="text-3xl sm:text-4xl font-bold text-white">
          <Editable id="browse.title" label="Browse title (part 1)">{get('browse.title', 'Browse')}</Editable>{' '}
          <span className="gradient-text"><Editable id="browse.titleHi" label="Browse title (highlight)">{get('browse.titleHi', 'Applications')}</Editable></span>
        </h1>
        <p className="mt-2 text-rx-gray-medium">
          <Editable id="browse.sub" type="textarea" label="Browse subtitle ({count} = live number)">{subtitle}</Editable>
        </p>
      </div>

      <div className="flex flex-col lg:flex-row gap-4 mb-8">
        <Editable id="browse.searchPlaceholder" label="Search placeholder" className="flex-1">
          <SearchBox placeholder={searchPlaceholder} className="w-full" />
        </Editable>

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
          <SlidersHorizontal className="w-3.5 h-3.5" /> <Editable id="browse.filtersLabel" label="Filters label">{get('browse.filtersLabel', 'Filters:')}</Editable>
        </span>
        <button
          onClick={() => setSelectedCategory(null)}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
            !selectedCategory ? 'bg-rx-yellow text-rx-dark' : 'bg-rx-dark-tertiary text-rx-gray-medium hover:text-white hover:bg-rx-dark-secondary'
          }`}
        >
          <Editable id="browse.allCategories" label="'All Categories' chip">{get('browse.allCategories', 'All Categories')}</Editable>
        </button>
        <Editable id="site.categories" type="categories" label="Category chips (shared with Home)" group>
          <span className="contents">
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
          </span>
        </Editable>
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

      <div className="mb-6 flex items-center gap-3 flex-wrap">
        <p className="text-sm text-rx-gray-medium">
          Showing <span className="text-white font-medium">{filteredApps.length}</span> application{filteredApps.length !== 1 ? 's' : ''}
          {searchQuery && <span> for "<span className="text-rx-yellow">{searchQuery}</span>"</span>}
        </p>
        {featuredOnly && (
          <button
            onClick={() => { setFeaturedOnly(false); window.history.replaceState(null, '', '/browse'); }}
            className="text-xs font-semibold bg-rx-yellow/15 text-rx-yellow px-2.5 py-1 rounded-full hover:bg-rx-yellow/25 transition-colors flex items-center gap-1"
          >
            ⭐ Featured only <X className="w-3 h-3" />
          </button>
        )}
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
      ) : isLoading && apps.length === 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="card p-5 h-44 animate-pulse bg-rx-dark-tertiary/40" />
          ))}
        </div>
      ) : (
        <div className="text-center py-20">
          <div className="text-5xl mb-4">🔍</div>
          <h3 className="text-xl font-semibold text-white mb-2">
            <Editable id="browse.emptyTitle" label="Empty-state heading">{get('browse.emptyTitle', 'No applications found')}</Editable>
          </h3>
          <p className="text-rx-gray-medium mb-6">
            <Editable id="browse.emptyBody" type="textarea" label="Empty-state message">{get('browse.emptyBody', 'Try adjusting your search or filters')}</Editable>
          </p>
          <button onClick={clearFilters} className="btn-primary">
            <Editable id="browse.emptyBtn" label="Empty-state button">{get('browse.emptyBtn', 'Clear Filters')}</Editable>
          </button>
        </div>
      )}

      {/* Custom sections inserted via Builder → Add Block */}
      <PageBlocks pageId="browse" inContainer />
    </div>
  );
}
