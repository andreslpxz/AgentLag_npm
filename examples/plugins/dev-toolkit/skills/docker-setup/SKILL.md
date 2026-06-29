---
name: docker-setup
description: Docker containerization patterns
---

# Docker Containerization Patterns

## Dockerfile Best Practices
- Use multi-stage builds to separate build dependencies from runtime.
- Order instructions from least to most frequently changing for cache hits.
- Use specific base image tags (e.g., `node:20-alpine3.19`) instead of `latest`.
- Pin digest hashes for reproducible builds in production.

## Image Optimization
- Combine `RUN` commands with `&&` to reduce layer count.
- Use `.dockerignore` to exclude node_modules, .git, and build artifacts.
- Run as a non-root user: `RUN adduser -D appuser && USER appuser`.
- Copy package files first, install deps, then copy source code.

## Compose Patterns
- Use `depends_on` with `condition: service_healthy` for startup ordering.
- Define named volumes for persistent data and bind mounts for development.
- Use environment files (`.env`) separate from `docker-compose.yml`.
- Override with `docker-compose.override.yml` for local dev customizations.

## Networking
- Use custom bridge networks instead of the default network for isolation.
- Expose only necessary ports; use internal-only ports for inter-service communication.
- Use Docker DNS for service discovery instead of hardcoded IPs.

## Health Checks
- Define `HEALTHCHECK` instructions for all long-running services.
- Use lightweight checks (e.g., `curl -f http://localhost:3000/health`).
- Set appropriate intervals (30s), timeouts (10s), and retries (3).