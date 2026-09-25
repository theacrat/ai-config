---
name: Skill discovery
description: Before working, load this discovery guide. Find task guidance with skill_search, then native skill(id).
---

At session start, load thea-mode using the native skill tool if available. Follow
its required skills through native skill(id).

Skills are sectioned into groups: cloudflare, 1password, engineering,
frontend, testing, workflow, personal. Only groups relevant to the current
project are advertised; the rest stay registered but hidden.

Before a task, search skill_search with a few keywords, optionally filtered
by group, then load relevant exact IDs with native skill(id). Search returns
metadata only and may include permission-denied skills. Native loading
applies OpenCode permissions. Do not load unrelated skills or enumerate the
catalogue.

To force groups for a project, create `.opencode/skill-groups.json` with
`{"groups": ["cloudflare"]}` using any of the group names above.
