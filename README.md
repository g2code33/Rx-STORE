# RX Store

<p align="center">
  <img src="public/favicon.svg" alt="RX Store Logo" width="80" />
</p>

<p align="center">
  <strong>Professional Digital Marketplace by Calcitonin Technologies</strong><br/>
  <em>Healthcare • Education • Productivity • Technology</em>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#getting-started">Getting Started</a> •
  <a href="#documentation">Documentation</a> •
  <a href="#security">Security</a>
</p>

---

## Overview

**RX Store** is a complete multi-platform application marketplace ecosystem created by Calcitonin Technologies for distributing, managing, updating, and monetizing applications focused on healthcare, education, productivity, and technology.

The platform combines the best of Microsoft Store, Samsung Galaxy Store, and JetBrains Toolbox — purpose-built for professionals who need secure, reliable, and compliant software tools.

## 🏗️ Ecosystem Structure

```
                     RX STORE
                        |
                 Rx Cloud Backend
                        |
    ┌───────────┬───────────┬──────────────┐
    |           |           |              |
Web App    Windows     Linux         Mobile
(React)    (Tauri)    (Tauri)      (Flutter)
    |           |           |              |
    └───────────┴───────────┴──────────────┘
                        |
               Available Applications
    ┌───────────┬───────────┬──────────────┐
Clinical Rx  PharmaGAME   Code Rx Society
TAWOMO       CureLink     + Future Apps
```

## ✨ Features

### Marketplace
- 📱 Browse and discover applications
- 🔍 Powerful search with filters (category, platform, rating)
- ⭐ Ratings and reviews system
- 📥 One-click downloads with auto-update
- 🏷️ Category-based organization
- 🖼️ App screenshots and video previews

### User Experience
- 👤 User accounts with profile management
- 📦 Installed apps management
- 💳 Subscription management
- 🔔 Push notifications
- 📊 Download history
- 🌐 Multi-language support

### Admin Dashboard
- 📈 Analytics and insights
- 💰 Revenue tracking
- 👥 User management
- 📦 Application management
- 🔄 Version/release management
- ⚙️ Platform settings

### Security
- 🔒 Enterprise-grade security
- 🛡️ HIPAA compliance ready
- 🔐 Role-based access control
- 📝 Complete audit logging
- 🔑 JWT authentication
- 🛑 Rate limiting and DDoS protection

### AI Integration
- 🤖 AI-powered app recommendations
- 💬 Technical support assistant
- 📖 Documentation assistant
- 🔧 Developer assistant

### Payments
- 💳 Multiple payment providers (Paystack, Mobile Money, Hubtel)
- 📋 Subscription management
- 🔑 License key generation
- 💼 Enterprise licensing

## 🛠️ Technology Stack

| Layer | Technology |
|-------|-----------|
| **Web Frontend** | React 18, TypeScript, Tailwind CSS, Framer Motion |
| **Desktop** | Tauri (Rust + WebView) |
| **Mobile** | Flutter (Dart) |
| **Backend** | Node.js / Cloudflare Workers |
| **Database** | PostgreSQL / Cloudflare D1 |
| **Cache** | Redis / Cloudflare KV |
| **Storage** | Cloudflare R2 |
| **CDN** | Cloudflare |
| **Payments** | Paystack, Mobile Money, Hubtel |
| **AI** | OpenAI API compatible |

## 🚀 Getting Started

### Prerequisites
- Node.js 18+
- npm 9+

### Quick Start
```bash
# Clone the repository
git clone https://github.com/calcitonin-tech/rx-store.git
cd rx-store

# Install dependencies
npm install

# Start development server
npm run dev
```

### Build for Production
```bash
# Build
npm run build

# Preview production build
npm run preview
```

## 📂 Project Structure

```
Rx-STORE/
├── src/                          # Frontend source
│   ├── components/
│   │   ├── layout/               # Header, Footer, Sidebar
│   │   ├── apps/                 # App card, grid components
│   │   ├── common/               # Reusable UI components
│   │   └── admin/                # Admin-specific components
│   ├── pages/                    # Route pages
│   │   ├── Home.tsx
│   │   ├── Browse.tsx
│   │   ├── AppDetail.tsx
│   │   ├── Categories.tsx
│   │   ├── Login.tsx
│   │   ├── Profile.tsx
│   │   ├── About.tsx
│   │   └── Admin.tsx
│   ├── context/                  # React Context providers
│   ├── data/                     # Static data / mock data
│   ├── types/                    # TypeScript type definitions
│   ├── utils/                    # Utility functions
│   ├── hooks/                    # Custom React hooks
│   ├── App.tsx                   # Main app component
│   ├── main.tsx                  # Entry point
│   └── index.css                 # Global styles
├── public/                       # Static assets
├── docs/                         # Documentation
│   ├── API.md                    # API documentation
│   ├── DATABASE.md               # Database schema
│   ├── DEPLOYMENT.md             # Deployment guide
│   ├── SECURITY.md               # Security checklist
│   └── TESTING.md                # Testing strategy
├── desktop/                      # Desktop apps (Tauri)
├── mobile/                       # Mobile app (Flutter)
├── backend/                      # Backend API source
├── package.json
├── vite.config.ts
├── tailwind.config.js
└── tsconfig.json
```

## 📱 Available Applications

| App | Category | Description |
|-----|----------|-------------|
| **Clinical Rx** | Healthcare | Clinical decision support system |
| **PharmaGAME** | Education | Gamified pharmaceutical learning |
| **Code Rx Society** | Technology | Healthcare developer platform |
| **TAWOMO** | Productivity | Healthcare workforce management |
| **CureLink** | Healthcare | Patient-caregiver communication |

## 🔌 API Endpoints

See [API Documentation](docs/API.md) for complete API reference.

Key endpoints:
- `GET /api/apps` - List applications
- `GET /api/apps/:slug` - App details
- `GET /api/categories` - List categories
- `POST /api/auth/login` - User login
- `GET /api/apps/check-update` - Check for updates
- `POST /api/payments/subscribe` - Create subscription

## 📊 Database

See [Database Schema](docs/DATABASE.md) for complete schema reference.

Main tables: `users`, `apps`, `app_versions`, `reviews`, `subscriptions`, `payments`, `downloads`, `notifications`, `audit_logs`, `licenses`

## 🔒 Security

See [Security Checklist](docs/SECURITY.md) for complete security documentation.

- End-to-end encryption
- HIPAA compliance
- SOC 2 certified
- Regular security audits
- Rate limiting
- Malware scanning

## 🚢 Deployment

See [Deployment Guide](docs/DEPLOYMENT.md) for deployment options:
1. Cloudflare Stack (recommended)
2. Traditional server (Node.js + PostgreSQL)
3. Docker Compose

## 🧪 Testing

See [Testing Strategy](docs/TESTING.md) for test documentation.

```bash
npm run test          # Unit tests
npm run test:e2e      # E2E tests
npm run test:coverage # With coverage
```

## 📄 License

© 2024 Calcitonin Technologies. All rights reserved.

---

<p align="center">
  Built with ❤️ by <strong>Calcitonin Technologies</strong>
</p>
