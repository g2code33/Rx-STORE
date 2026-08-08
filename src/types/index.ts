export interface App {
  id: string;
  name: string;
  slug: string;
  description: string;
  longDescription: string;
  category: AppCategory;
  tags: string[];
  icon: string;
  color: string;
  gradient: string;
  screenshots: string[];
  version: string;
  size: string;
  developer: string;
  rating: number;
  reviewCount: number;
  downloadCount: number;
  price: 'free' | 'paid' | 'subscription';
  priceAmount?: number;
  platforms: Platform[];
  releaseDate: string;
  lastUpdated: string;
  releaseNotes: string[];
  features: string[];
  isFeatured?: boolean;
  isNew?: boolean;
  isTrending?: boolean;
  requiresAuth?: boolean;
  status: 'active' | 'beta' | 'coming-soon';
}

export type AppCategory =
  | 'healthcare'
  | 'education'
  | 'productivity'
  | 'technology'
  | 'gaming'
  | 'social';

export type Platform = 'web' | 'windows' | 'linux' | 'android' | 'ios';

export interface Review {
  id: string;
  appId: string;
  userId: string;
  userName: string;
  userAvatar: string;
  rating: number;
  comment: string;
  date: string;
  helpful: number;
}

export interface User {
  id: string;
  name: string;
  email: string;
  phone?: string;
  avatar: string;
  role: 'user' | 'admin' | 'developer';
  joinDate: string;
  downloadedApps: string[];
  subscriptions: Subscription[];
  notifications: Notification[];
}

export interface Subscription {
  id: string;
  appId: string;
  plan: string;
  status: 'active' | 'cancelled' | 'expired';
  startDate: string;
  endDate: string;
  amount: number;
}

export interface Notification {
  id: string;
  type: 'update' | 'download' | 'message' | 'system';
  title: string;
  message: string;
  date: string;
  read: boolean;
}

export interface CategoryInfo {
  id: AppCategory;
  name: string;
  icon: string;
  description: string;
  count: number;
  color: string;
}
