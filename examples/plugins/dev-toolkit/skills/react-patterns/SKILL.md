---
name: react-patterns
description: React component patterns and best practices
---

# React Patterns and Best Practices

## Component Composition
- Prefer composition over prop drilling using children or render props.
- Split large components into smaller, focused presentational components.
- Use compound component patterns for related UI elements (e.g., Tabs + TabPanel).

## State Management
- Keep state as local as possible; lift only when shared.
- Use `useReducer` for complex state logic with multiple sub-values.
- Consider Zustand or Jotai for medium-scale shared state instead of Redux.
- Use `useMemo` and `useCallback` only when profiling shows a need.

## Hooks Patterns
- Extract reusable logic into custom hooks (e.g., `useDebounce`, `useLocalStorage`).
- Follow the Rules of Hooks: never call conditionally or inside loops.
- Use `useEffect` cleanup functions to prevent memory leaks.
- Prefer `useSyncExternalStore` for subscribing to external data sources.

## Performance
- Use `React.lazy` and `Suspense` for code splitting at route level.
- Virtualize long lists with `react-window` or `@tanstack/virtual`.
- Avoid inline object/array creation in JSX props to prevent re-renders.
- Profile with React DevTools before optimizing.

## TypeScript Integration
- Define explicit prop interfaces for every component.
- Use discriminated unions for components with variant-based rendering.
- Prefer `React.FC` only when you need children typed automatically.
- Use generic components for reusable list/table wrappers.