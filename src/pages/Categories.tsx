import React from 'react';
import { Link } from 'react-router-dom';
import { Heart, GraduationCap, Zap, Cpu, Gamepad2, Users, ArrowRight } from 'lucide-react';
import { useCategories } from '../hooks/useCategories';
import { useApps } from '../context/AppContext';

const iconMap: Record<string, React.ComponentType<{ className?: string; style?: React.CSSProperties }>> = {
  Heart, GraduationCap, Zap, Cpu, Gamepad2, Users,
};

export default function Categories() {
  const { getAppsByCategory } = useApps();
  const categories = useCategories();
  return (
    <div className="section-container py-8 lg:py-12">
      <div className="mb-10">
        <h1 className="text-3xl sm:text-4xl font-bold text-white">App <span className="gradient-text">Categories</span></h1>
        <p className="mt-2 text-rx-gray-medium">Explore applications organized by category</p>
      </div>
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
    </div>
  );
}
