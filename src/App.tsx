import React, { Suspense, lazy } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import Header from './components/layout/Header';
import Footer from './components/layout/Footer';

const Home = lazy(() => import('./pages/Home'));
const Browse = lazy(() => import('./pages/Browse'));
const AppDetail = lazy(() => import('./pages/AppDetail'));
const Categories = lazy(() => import('./pages/Categories'));
const CategoryPage = lazy(() => import('./pages/CategoryPage'));
const Login = lazy(() => import('./pages/Login'));
const Profile = lazy(() => import('./pages/Profile'));
const About = lazy(() => import('./pages/About'));
const Admin = lazy(() => import('./pages/Admin'));

function LoadingFallback() {
  return (
    <div className="min-h-screen bg-rx-dark flex items-center justify-center">
      <div className="text-center">
        <div className="w-16 h-16 bg-rx-yellow rounded-2xl flex items-center justify-center font-bold text-rx-dark text-xl mx-auto mb-4 animate-pulse">
          Rx
        </div>
        <p className="text-rx-gray-medium text-sm">Loading RX Store...</p>
      </div>
    </div>
  );
}

function ScrollToTop() {
  const { pathname } = useLocation();
  React.useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

export default function App() {
  return (
    <div className="min-h-screen bg-rx-dark text-white flex flex-col">
      <ScrollToTop />
      <Toaster
        position="top-right"
        toastOptions={{
          style: {
            background: '#1A2332',
            color: '#fff',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '12px',
          },
        }}
      />
      <Header />
      <main className="flex-1 pt-16">
        <Suspense fallback={<LoadingFallback />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/browse" element={<Browse />} />
            <Route path="/app/:slug" element={<AppDetail />} />
            <Route path="/categories" element={<Categories />} />
            <Route path="/categories/:category" element={<CategoryPage />} />
            <Route path="/login" element={<Login />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/about" element={<About />} />
            <Route path="/admin" element={<Admin />} />
          </Routes>
        </Suspense>
      </main>
      <Footer />
    </div>
  );
}
