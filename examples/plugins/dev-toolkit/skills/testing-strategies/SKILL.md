---
name: testing-strategies
description: Testing pyramid and strategies
---

# Testing Pyramid and Strategies

## The Testing Pyramid
- **Unit Tests (70%)**: Fast, isolated, test individual functions and components.
- **Integration Tests (20%)**: Test module interactions (DB + service, API + auth).
- **E2E Tests (10%)**: Full user flows through the UI (Playwright, Cypress).

## Unit Testing Principles
- Test behavior, not implementation details (avoid mocking every internal call).
- Follow Arrange-Act-Assert structure for clarity.
- Each test should verify one behavior — use `describe` blocks for grouping.
- Use descriptive test names: `should return 404 when user not found`.

## Integration Testing
- Use real databases in test containers or SQLite in-memory for speed.
- Test API endpoints with supertest including happy path and error scenarios.
- Verify side effects: database state changes, emails sent, events emitted.
- Reset state between tests with proper cleanup/teardown hooks.

## E2E Testing
- Focus on critical user journeys, not edge cases (those belong in lower levels).
- Use page object models to decouple selectors from test logic.
- Run E2E tests in CI with video recording on failure for debugging.
- Parallelize test execution to keep suite time under 10 minutes.

## Test Quality
- Aim for meaningful coverage, not 100% line coverage.
- Test boundary values, empty inputs, and error conditions explicitly.
- Review and maintain tests the same way as production code.
- Run tests locally before pushing; fail fast in CI pipelines.