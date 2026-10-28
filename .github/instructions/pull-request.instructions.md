---
description: "How to write pull request titles and descriptions for llama-paddock"
---

# Pull requests

- **Base branch:** `dev`. `main` only for an urgent hotfix.
- **Title:** a valid Conventional Commit, following the commit message rules in `commit-message.instructions.md`. Feature PRs are squash-merged, so the title becomes the changelog entry. The `pr-title` check fails otherwise. No `!` unless the maintainer agreed to a breaking change.
- **Description:** fill in `.github/pull_request_template.md`. Keep its headings and checklist, and tick only what is true. Delete the Screenshots and Breaking changes sections when they don't apply.
  - **What and why:** the problem, then what changed, as short bullets. New settings, env vars and API changes by name.
  - Link issues with `Closes #N`. For roadmap issues, say which items of the issue's scope checklist are done and which are left.
  - **How it was tested:** what was actually run, and on what. Say plainly what was not tested. Don't claim checks that weren't run.
  - Upgrade notes for anything users will notice when they update, even when it isn't breaking.
- One logical change per PR. If it depends on another open PR, say which one to merge first.
