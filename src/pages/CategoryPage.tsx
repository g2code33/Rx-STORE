import React from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Heart, GraduationCap, Zap, Cpu, Gamepad2, Users } from 'lucide-react';
import { useCategories } from '../hooks/useCategories';
import { useApps } from '../context/AppContext';
import { AppCategory } from '../types';
import AppCard from '../components/apps/AppCard';
import { useContent } from '../context/ContentContext';
import Editable from '../components/edit/Editable';
import PageBlocks from '../components/edit/PageBlocks';

const iconMap: Record<string, React.ComponentType<{ className?: string; style?: React.CSSProperties }>> = {
  Heart, GraduationCap, Zap, Cpu, Gamepad2, Users,
};

/** previewCategory: the Live Builder renders this page without a route. */
export default function CategoryPage({ previewCategory }: { previewCategory?: string }) {
  const { category: routeCategory } = useParams<{ category: string }>();
  const category = previewCategory ?? routeCategory;
  const { getAppsByCategory } = useApps();
  const categories = useCategories();
  const { get } = useContent();
  const categoryInfo = categories.find((c) => c.id === category);
  const categoryApps = category ? getAppsByCategory(category as AppCategory) : [];

  if (!categoryInfo) {
    return (
      <div className="section-container py-20 text-center">
        <div className="text-5xl mb-4">📁</div>
        <h2 className="text-2xl font-bold text-white mb-2">Category Not Found</h2>
        <Link to="/categories" className="btn-primary mt-4 inline-block">Browse Categories</Link>
      </div>
    );
  }

  const Icon = iconMap[categoryInfo.icon] || Zap;
  return (
    <div className="section-container py-8 lg:py-12">
      <Link to="/categories" className="inline-flex items-center gap-2 text-rx-gray-medium hover:text-white text-sm mb-6 transition-colors">
        <ArrowLeft className="w-4 h-4" /> <Editable id="catp.back" label="'Back to Categories' link">{get('catp.back', 'Back to Categories')}</Editable>
      </Link>
      <Editable id="site.categories" type="categories" label="This category (shared editor)" group>
        <div className="flex items-center gap-4 mb-10">
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center" style={{ backgroundColor: `${categoryInfo.color}20` }}>
            <Icon className="w-8 h-8" style={{ color: categoryInfo.color }} />
          </div>
          <div>
            <h1 className="text-3xl font-bold text-white">{categoryInfo.name}</h1>
            <p className="text-rx-gray-medium mt-1">{categoryInfo.description}</p>
          </div>
        </div>
      </Editable>
      {categoryApps.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {categoryApps.map((app) => (<AppCard key={app.id} app={app} />))}
        </div>
      ) : (
        <div className="text-center py-20">
          <div className="text-5xl mb-4">📭</div>
          <h3 className="text-xl font-semibold text-white mb-2">
            <Editable id="catp.emptyTitle" label="Empty-category heading">{get('catp.emptyTitle', 'No applications in this category yet')}</Editable>
          </h3>
          <p className="text-rx-gray-medium">
            <Editable id="catp.emptyBody" type="textarea" label="Empty-category message">{get('catp.emptyBody', 'Check back soon for new additions.')}</Editable>
          </p>
        </div>
      )}

      {/* Custom sections inserted via Builder → Add Block (shows on every category page) */}
      <PageBlocks pageId="categoryPage" inContainer />
    </div>
  );
}
