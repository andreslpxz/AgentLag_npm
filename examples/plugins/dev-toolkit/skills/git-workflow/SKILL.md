---
name: git-workflow
description: Git branching and workflow strategies
---

# Git Branching and Workflow Strategies

## Branch Naming Conventions
- Use `type/scope-description`: `feat/auth-login`, `fix/api-timeout`, `chore/deps-update`.
- Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `ci`.
- Keep branch names short but descriptive (under 60 characters).
- Use issue numbers: `feat/PROJ-123-user-profile`.

## Branching Models
- **GitHub Flow**: main + short-lived feature branches. Best for continuous deployment.
- **Git Flow**: main, develop, feature, release, hotfix. Best for scheduled releases.
- **Trunk-Based**: short-lived branches (< 1 day) with feature flags. Best for large teams.

## Commit Practices
- Follow Conventional Commits: `feat: add user authentication endpoint`.
- Make atomic commits — one logical change per commit.
- Write the body explaining *why*, not *what* (the diff shows what).
- Use `git rebase -i` to squash WIP commits before merging.

## Pull Request Hygiene
- Keep PRs small (under 400 lines changed) for effective review.
- Include a clear description with screenshots for UI changes.
- Require at least one approval before merging to protected branches.
- Use draft PRs for early feedback on in-progress work.

## Safety Practices
- Never force push to shared branches (main, develop).
- Use `git stash` instead of committing WIP changes.
- Set up branch protection rules on CI-passing and review-required.
- Regularly prune remote-tracking branches with `git fetch --prune`.