---
name: node-apis
description: Node.js API development patterns
---

# Node.js API Development Patterns

## Project Structure
- Organize by feature or domain (routes, controllers, services, repositories).
- Separate validation schemas from route handlers (use Zod or Joi).
- Keep middleware composable and reusable across routes.

## Express/Fastify Patterns
- Use a router-per-resource pattern to keep route files manageable.
- Centralize error handling with a global error middleware at the end of the chain.
- Apply rate limiting, CORS, and helmet as early middleware in the stack.
- Use async handler wrappers to avoid try/catch repetition in every route.

## Request Validation
- Validate all inputs at the route boundary before reaching business logic.
- Return 422 with detailed field-level error messages for validation failures.
- Sanitize and coerce types (e.g., string to integer for query params).
- Use schema-based validation libraries that integrate with TypeScript types.

## Response Patterns
- Standardize response envelopes: `{ data, meta, errors }` for consistency.
- Implement cursor-based pagination for large datasets instead of offset-based.
- Use HATEOAS links for discoverability in REST APIs.
- Set appropriate `Cache-Control` headers for GET endpoints.

## Error Handling
- Create a custom `AppError` class with HTTP status code and error code.
- Map domain errors to HTTP status codes in a centralized error mapper.
- Never expose stack traces or internal details in production responses.
- Log errors with context (request ID, user ID, path) for observability.