import React from 'react';
import { Link } from 'react-router-dom';
import { Heart, GraduationCap, Zap, Cpu, Gamepad2, Users, ArrowRight } from 'lucide-react';
import { useCategories } from '../hooks/useCategories';
import { useApps } from '../context/AppContext';
import { useContent } from '../context/ContentContext';
import Editable from '../components/edit/Editable';
import PageBlocks from '../components/edit/PageBlocks';

const iconMap: Record<string, React.ComponentType<{ className?: string; style?: React.CSSProperties }>> = {
  Heart, GraduationCap, Zap, Cpu, Gamepad2, Users,
};

export default function Categories() {
  const { getAppsByCategory } = useApps();
  const categories = useCategories();
  const { get } = useContent();
  return (
    <div className="section-container py-8 lg:py-12">
      <div className="mb-10">
        <h1 className="text-3xl sm:text-4xl font-bold text-white">
          <Editable id="cats.title" label="Categories title (part 1)">{get('cats.title', 'App')}</Editable>{' '}
          <span className="gradient-text"><Editable id="cats.titleHi" label="Categories title (highlight)">{get('cats.titleHi', 'Categories')}</Editable></span>
        </h1>
        <p className="mt-2 text-rx-gray-medium">
          <Editable id="cats.sub" type="textarea" label="Categories subtitle">{get('cats.sub', 'Explore applications organized by category')}</Editable>
        </p>
      </div>
      <Editable id="site.categories" type="categories" label="Category cards (shared with Home & Browse)" group>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {categories.map((cat) => {
            const Icon = iconMap[cat.icon] || Zap;
            const categoryApps = getAppsByCategory(cat.id);
            return (
              <Link key={cat.id} to={`/categories/${cat.id}`} className="card-hover p-6 group relative overflow-hidden">
                <div className="absolute top-0 right-0 w-32 h-32 rounded-full blur-3xl opacity-10" style={{ backgroundColor: cat.color }} />
                <div className="relative">
                  <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4" style={{ backgroundColor: `${cat.color}20` }}>
                    <Icon className="w-7 h-7" style={{ color: cat.color }} />
                  </div>
                  <h3 className="text-xl font-bold text-white group-hover:text-rx-yellow transition-colors">{cat.name}</h3>
                  <p className="text-sm text-rx-gray-medium mt-2">{cat.description}</p>
                  <div className="flex items-center justify-between mt-4">
                    <span className="text-xs text-rx-gray-medium">{categoryApps.length} applications</span>
                    <ArrowRight className="w-4 h-4 text-rx-gray-medium group-hover:text-rx-yellow transition-colors group-hover:translate-x-1 transform" />
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </Editable>

      {/* Custom sections inserted via Builder → Add Block */}
      <PageBlocks pageId="categories" inContainer />
    </div>
  );
}
