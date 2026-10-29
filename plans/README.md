# Plans

One file per piece of work in the full lane, written by the `planner` skill and approved by Bob before any code changes. The plan is the contract between the agents: the engineer builds only what it says, the documenter and reviewer check against it, and the PR description comes from it.

- **Name:** `YYYY-MM-DD-slug.md` — the date the plan was started, and the same slug as the branch (see `CLAUDE.md` → Names).
- **Status:** `draft` → `approved` → `in progress` → `in review` → `done`. A plan marked `done` on `main` is shipped.
- **Public repo:** no passwords, tokens, keys, VPS IP or customer data in a plan.

Plans stay in the repo after they ship. They are the history of what was decided and why.

## Template

```markdown
# <Title in plain words>

Status: draft
Branch: <type>/<slug>
Lane: full

## Goal
One or two sentences: what changes for whom, and why now.

## Decisions
- <Decision> — <why; the alternative that was rejected>

## Out of scope
- <Things deliberately not done, so nobody adds them>

## Steps
1. **<Short name>**
   - Files: `path/file.js`, …
   - Do: <exact change, specific enough to build without asking>
   - Done when: <observable result>

## How to test
- <Step-by-step check a person can run, with expected result>

## Deploy notes
- <Apps Script version bump / VPS command / "frontend only: deploys on merge">
- How to check it worked:
- Rollback:

## Open questions
- (must be empty before Status: approved)

## Log
<!-- Agents add entries here: engineer steps, documenter changes, reviewer verdicts, fix rounds. -->
```
