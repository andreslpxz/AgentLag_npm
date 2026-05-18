# Changelog

## 1.1.0 - 2026-05-18

### Added
- `search_in_files` for repo-wide literal or regex search.
- `show_diff` to inspect current Git diffs after edits.
- `apply_patch` for unified patches via `git apply`.
- Configurable `timeoutMs` for `run_shell`.
- Memory v2 metadata: `project`, `context`, `createdAt`, `updatedAt`, and optional TTL expiration.
- Short-lived skills cache with explicit invalidation after skill install/update.
- `npm test` for automated Node tests.
- `npm run devintest` to start the interactive AgentLag CLI for manual testing.
- Public DuckDuckGo fallback for `web_search` when `TAVILY_API_KEY` is not configured.

### Changed
- `edit_file` now requires a unique `oldText` match and returns a diff.
- ReAct iteration and error tracking now live in graph state instead of shared closure variables.
- Removed duplicate `search_files` registration so the model has one canonical search tool.
- Tests use explicit file-path injection for memory isolation instead of ESM cache-busting imports.

### Migration notes
- Existing flat `~/.agentlag/memory.json` files are migrated in memory to the v2 shape and keep their values.
