# RX Store API Documentation

## Base URL
```
Production: https://api.rxstore.com/v1
Staging:    https://api-staging.rxstore.com/v1
Local:      http://localhost:8080/v1
```

## Authentication
All authenticated endpoints require a Bearer token in the Authorization header:
```
Authorization: Bearer <token>
```

---

## Endpoints

### Authentication

#### POST /auth/register
Register a new user account.

**Request:**
```json
{
  "name": "Dr. John Smith",
  "email": "john@hospital.org",
  "password": "secure_password_123",
  "role": "user"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "usr_abc123",
      "name": "Dr. John Smith",
      "email": "john@hospital.org",
      "role": "user",
      "avatar": null,
      "joinDate": "2024-12-20T10:00:00Z"
    },
    "token": "eyJhbGciOiJIUzI1NiIs...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIs..."
  }
}
```

#### POST /auth/login
```json
{
  "email": "john@hospital.org",
  "password": "secure_password_123"
}
```

#### POST /auth/refresh
```json
{
  "refreshToken": "eyJhbGciOiJIUzI1NiIs..."
}
```

#### POST /auth/logout
Requires authentication. Invalidates the current token.

---

### Applications

#### GET /apps
List all applications with optional filters.

**Query Parameters:**
- `category` (string) - Filter by category
- `platform` (string) - Filter by platform (web, windows, linux, android, ios)
- `search` (string) - Search by name, description, or tags
- `sort` (string) - Sort by: popular, rating, newest, name
- `page` (number) - Page number (default: 1)
- `limit` (number) - Items per page (default: 20, max: 100)

**Response:**
```json
{
  "success": true,
  "data": {
    "apps": [...],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 8,
      "pages": 1
    }
  }
}
```

#### GET /apps/:slug
Get application details by slug.

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "clinical-rx",
    "name": "Clinical Rx",
    "slug": "clinical-rx",
    "description": "...",
    "longDescription": "...",
    "category": "healthcare",
    "tags": ["clinical", "prescribing"],
    "icon": "🏥",
    "version": "3.2.1",
    "size": "148 MB",
    "developer": "Calcitonin Technologies",
    "rating": 4.8,
    "reviewCount": 2847,
    "downloadCount": 156000,
    "price": "subscription",
    "priceAmount": 29.99,
    "platforms": ["web", "windows", "linux", "android", "ios"],
    "releaseDate": "2023-01-15",
    "lastUpdated": "2024-12-20",
    "releaseNotes": ["...", "..."],
    "features": ["...", "..."],
    "status": "active"
  }
}
```

#### GET /apps/:slug/reviews
Get reviews for an application.

**Query Parameters:**
- `sort` (string) - recent, helpful, rating
- `page` (number)
- `limit` (number)

#### GET /apps/:slug/releases
Get version history for an application.

---

### Categories

#### GET /categories
List all categories with app counts.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "healthcare",
      "name": "Healthcare",
      "icon": "Heart",
      "description": "...",
      "count": 3,
      "color": "#FF6B6B"
    }
  ]
}
```

---

### Downloads

#### POST /downloads
Record a download event (requires authentication).

**Request:**
```json
{
  "appId": "clinical-rx",
  "platform": "windows",
  "version": "3.2.1"
}
```

#### GET /downloads/:appId/:platform
Get download URL for a specific platform.

**Response:**
```json
{
  "success": true,
  "data": {
    "url": "https://cdn.rxstore.com/apps/clinical-rx/windows/installer-3.2.1.exe",
    "expiresAt": "2024-12-20T11:00:00Z",
    "checksum": "sha256:abc123..."
  }
}
```

---

### Updates

#### GET /apps/check-update
Check for application updates.

**Query Parameters:**
- `app` (string) - Application ID
- `currentVersion` (string) - Currently installed version
- `platform` (string) - Platform identifier

**Response:**
```json
{
  "success": true,
  "data": {
    "app": "Clinical Rx",
    "currentVersion": "3.2.0",
    "latestVersion": "3.2.1",
    "updateAvailable": true,
    "downloadURL": "https://cdn.rxstore.com/apps/clinical-rx/windows/installer-3.2.1.exe",
    "mandatory": false,
    "releaseNotes": [
      "Added AI-powered drug interaction predictions",
      "Enhanced EHR integration"
    ],
    "fileSize": "148 MB",
    "checksum": "sha256:abc123..."
  }
}
```

---

### Users (Authenticated)

#### GET /users/me
Get current user profile.

#### PATCH /users/me
Update user profile.

**Request:**
```json
{
  "name": "Dr. Jane Smith",
  "avatar": "👩‍⚕️",
  "preferences": {
    "emailNotifications": true,
    "autoUpdate": true
  }
}
```

#### GET /users/me/apps
Get user's installed applications.

#### GET /users/me/subscriptions
Get user's active subscriptions.

#### GET /users/me/notifications
Get user's notifications.

#### PATCH /users/me/notifications/:id/read
Mark a notification as read.

---

### Admin Endpoints

#### GET /admin/dashboard
Get admin dashboard statistics.

**Response:**
```json
{
  "success": true,
  "data": {
    "totalDownloads": 734000,
    "activeUsers": 28400,
    "monthlyRevenue": 47832,
    "averageRating": 4.7,
    "newUsersToday": 156,
    "downloadTrend": [12.5, 8.2, ...],
    "topApps": [...]
  }
}
```

#### POST /admin/apps
Create a new application listing.

#### PATCH /admin/apps/:id
Update application details.

#### DELETE /admin/apps/:id
Remove an application.

#### POST /admin/apps/:id/releases
Create a new release for an application.

**Request:**
```json
{
  "version": "3.3.0",
  "releaseNotes": ["New features", "Bug fixes"],
  "platforms": {
    "windows": { "fileUrl": "...", "checksum": "..." },
    "android": { "fileUrl": "...", "checksum": "..." }
  },
  "mandatory": false
}
```

#### GET /admin/users
List all users with filters.

#### PATCH /admin/users/:id/role
Update user role.

#### GET /admin/analytics
Get detailed analytics.

**Query Parameters:**
- `period` (string) - 7d, 30d, 90d, 1y
- `metric` (string) - downloads, users, revenue, ratings

#### GET /admin/revenue
Get revenue data.

---

### Payments

#### POST /payments/subscribe
Create a subscription.

**Request:**
```json
{
  "appId": "clinical-rx",
  "plan": "professional",
  "paymentMethod": "paystack",
  "paymentDetails": { ... }
}
```

#### GET /payments/history
Get payment history.

#### POST /payments/verify/:transactionId
Verify a payment transaction.

---

### AI Assistant

#### POST /ai/chat
Send a message to the AI assistant.

**Request:**
```json
{
  "message": "Which app is best for drug interaction checking?",
  "context": {
    "currentApp": null,
    "userRole": "pharmacist"
  }
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "response": "Based on your needs, I recommend Clinical Rx...",
    "suggestions": [
      "Compare Clinical Rx vs CureLink",
      "Show me drug interaction features"
    ]
  }
}
```

#### POST /ai/recommend
Get AI-powered app recommendations.

---

## Error Responses

All errors follow this format:
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid email format",
    "details": [
      {
        "field": "email",
        "message": "Must be a valid email address"
      }
    ]
  }
}
```

### Error Codes
| Code | HTTP Status | Description |
|------|-------------|-------------|
| VALIDATION_ERROR | 400 | Request validation failed |
| UNAUTHORIZED | 401 | Authentication required |
| FORBIDDEN | 403 | Insufficient permissions |
| NOT_FOUND | 404 | Resource not found |
| RATE_LIMITED | 429 | Too many requests |
| INTERNAL_ERROR | 500 | Server error |

---

## Rate Limits
- Public endpoints: 100 requests/minute
- Authenticated endpoints: 300 requests/minute
- Admin endpoints: 500 requests/minute
- AI endpoints: 30 requests/minute
