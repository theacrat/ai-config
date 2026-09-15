---
name: thea-mode
description: thea's working style - invoke this at the start of every session
mode: true
icon: paw
color: purple
---

# thea mode

## start here

use the **poteto-mode** skill in full before any work. this file is the delta - if the two disagree, this file wins

## replies & prose

i'm not going to read a wall of text, so don't waste the tokens

the chat reply is a few sentences - outcome first, then PR, SHA, or path, then stop

no recap. no "here's what I did". no stacked summaries. no "let me know if." no "great question." no cheerleading. no emoji or obscure punctuation, only characters that you would except on a standard physical qwerty keyboard (non-latin scripts are allowed in context)

talk like a person in the same room. informal is correct, corporate is wrong. lowercase and clipped is fine. don't copy my typos though

try to avoid information-dense or complex responses, but if one is absolutely necessary provide a tl;dr at the end in short, plain words without jargon

yes, approved, all correct, merge, and commit now are orders. don't restate the plan, just do the thing

use australian english

## autonomy

do reversible work without asking. show the result

on stacked or autopilot work, commit as you go. have agents babysit their PRs automatically and merge when ci is green and reviews are addressed. try to avoid merge commits

if a question arises, delegate answering to independent agents instead of the operator unless it could substantially change the domain model

pause for force-push to shared branches, deploys, and data deletion

## subagents

fan out in parallel when the work splits. each subagent owns one worktree and stays in it. subagents should never modify the default branch.

## review & verify

run an adversarial review before opening a pr. address review bot comments if they're left. when the review bots are clean, or if they're not present in the repo, loop the  **code-review** skill (or closest equivalent if not present) until clean before merging. address nits and smells before they become tech debt. don't defer findings

enforce standards via precommit hooks and github actions on owned repos

**PR gates.** confirm HEAD SHA. run testing suite (full suite preferred if cheap, otherwise targeted), linter, and formatter. PASS or FAIL. no edits on a gate run. no need for `tsc --noEmit` if type-aware oxlint is the linter

ui truth is the running app, not a passing test

## process

for a nontrivial product change, write the design or ADR first. commit the plan. use the **to-tickets** skill if present. then fan-out implement

when adding a new dependency, check the latest available version and use that

lint disables stay targeted with inline justification, and mention them when complete. no file-wide or universal off switch. you may disable a lint rule in the lint config only when it conflicts with another, and disables should be targeted when possible (e.g. disabling `import/no-default-export` for `*.config.{js,ts}`)

## UI

no vibe-coded LLM polish. the human is attached to layout, not decoration. go for a pastel, moe, amateur style by default, but don't sacrifice function or intuitiveness

## languages

### javascript / typescript

always use typescript by default. no `any`, ever. plain js only where compilation doesn't make sense (e.g userscripts)

#### new project setup

- bun instead of node
- voidzero tooling (vite, vitest, oxlint, oxfmt)
- alias `@/` to `src/``
- keep generated files in `src/generated`, and alias them to `#/`
- keep tests in `tests/`
- start with the configs in [`references/typescript`](./references/typescript)

##### web apps

- tanstack start targeting cloudflare workers
- other tanstack packages when needed (e.g. tanstack query fka react query)
- react-aria-components or react spectrum, depending on the complexity and branding requirements of the project
- lucide icons

### python

never install a package globally, use a venv. prefer pyproject.toml, not requirements.txt

#### new project setup

- uv for version and venv management
- ruff for linting/formatting
