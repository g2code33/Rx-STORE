# RX Store

<p align="center">
  <img src="public/v1.png" alt="RX Store Logo" width="80" />
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
            Cloudflare Workers (D1 + R2 + KV)
                         |
   ┌──────────┬──────────┬──────────┬──────────┐
   |          |          |          |          |
  Web       Windows    Linux    Android     iOS
 (React      (Electron) (Electron) (Capacitor) (PWA)
  + PWA)
   └──────────┴──────────┴──────────┴──────────┘
                         |
               Marketplace Applications
   Clinical Rx · PharmaGAME · Code Rx Society
   TAWOMO · CureLink · CGPA Pilot · + more
```

> **Desktop is Electron** (with `electron-builder`), **Android is Capacitor**
> (native installer plugin), and **iOS is served as a PWA** — no native IPA
> pipeline. The old `desktop/tauri` and `mobile/flutter` trees remain in the
> repository as LEGACY, non-shipping code.

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
| **Desktop** | Electron (electron-builder) |
| **Android** | Capacitor (native installer plugin) |
| **iOS** | PWA (web install flow) |
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
├── electron/                      # Desktop shell (Electron — shipping)
├── android/                       # Android shell (Capacitor — shipping)
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


---

## 📋 Production Status (Phase 21 certification)

Implemented and verified in this repository (see `docs/ACCEPTANCE_CHECKLIST.md`,
`docs/RELEASE_READINESS.md` and the test suite — 414 tests):

- Account/device/installation model with native detection (Windows registry,
  Linux dpkg/PATH/.desktop, Android PackageManager) and multi-device sync
- Storefront (home sections, search, categories, discovery), Library,
  first-launch restore, install queue with retry/recovery
- Developer platform: application → verification → organization → roles →
  apps → releases → packages → automated security checks → submission →
  admin review → publication; analytics, revenue, payouts; public portal,
  API docs, SDK page, community forum, scoped API tokens
- Reviews with moderation + developer responses; public community with
  moderation; admin consoles for all of it
- Payments (Paystack), entitlements, refunds, short-lived paid-download
  authorization — **activation requires `PAYSTACK_SECRET_KEY`; until then
  production purchases fail closed (by design)**
- Package security pipeline: quarantine storage, structure/integrity/
  duplicate/signature/certificate/native-identity checks — **malware
  scanning requires `VIRUSTOTAL_API_KEY`; without it results are honestly
  UNAVAILABLE and publication requires an audited admin override**

Not claimable until tested on real environments (see
`docs/RELEASE_READINESS.md` for the full BLOCKED list): native OS install
flows on real Windows/Linux/Android devices, live Paystack transactions,
live VirusTotal scanning, and Electron/Android installer packaging from
this CI sandbox.
