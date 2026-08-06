# RX Store Testing Strategy

## Test Types

### Unit Tests (Jest/Vitest)
- Components (React Testing Library)
- Utilities and helpers
- Context/state management
- API client functions

### Integration Tests
- API endpoint testing (Supertest)
- Database operations
- Authentication flows
- Payment processing (mocked)

### End-to-End Tests (Playwright)
- User registration and login
- App browsing and search
- Download and install flows
- Admin dashboard operations
- Subscription management

### Performance Tests (k6)
- API response times
- Concurrent user simulation
- Database query performance
- CDN cache hit rates

## Running Tests
```bash
# Unit tests
npm run test

# Integration tests
npm run test:integration

# E2E tests
npm run test:e2e

# All tests with coverage
npm run test:coverage

# Performance tests
npm run test:perf
```

## Coverage Targets
- Statements: >90%
- Branches: >85%
- Functions: >90%
- Lines: >90%
