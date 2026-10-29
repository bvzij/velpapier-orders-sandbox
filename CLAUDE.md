# Vel Papier dashboard

Internal dashboard for Vel Papier (orders, packing/QC, customers, products, wholesale, analytics). Static frontend on Vercel, Google Apps Script + Google Sheets backend, Python services on a Hostinger VPS. How it is built: `ARCHITECTURE.md`. Coding rules: `CONVENTIONS.md` (loaded below — follow it on every change).

@CONVENTIONS.md

## Current state of the project

This section changes over time. Agents read it; update it when the situation changes.

- `main` is production. Vercel deploys every push to `main` automatically. Never commit or push to `main`.
- The repository is **public** (moving to private as part of the migration). Never put passwords, tokens, keys, the VPS IP or customer data in code, docs, plans, commits or PR descriptions.
- Migration from Apps Script + Sheets to PostgreSQL + FastAPI on the VPS is planned. Until cutover there is a **change freeze: bug fixes only** on the current system. Migration work itself is allowed. Flag any request that breaks the freeze before planning it.
- Vercel preview URLs for branches still call the production Apps Script backend: testing on a preview writes real data.

## How work flows

Bob keeps working the way he does; you (the main session) run this workflow on his behalf. Pick a lane first and say which one in one line.

### Small-change lane

Use it when **all** are true: one or two files, no new behavior, no data/schema/auth change, no deploy step beyond the merge (no Apps Script redeploy, no VPS change). Typos, copy fixes, a clear one-line bug.

1. `git` agent: start a branch (no plan file; pass a short slug and type).
2. Make the change yourself.
3. `reviewer` agent. Apply the findings yourself; run `documenter` only if the reviewer says docs are affected.
4. `git` agent: ship.

If the change turns out bigger than this, stop and switch to the full lane.

### Full lane (everything else)

1. **Plan** — use the `planner` skill. It debates with Bob until nothing is open, then writes `plans/YYYY-MM-DD-slug.md`. **Bob approves the plan** before anything else happens.
2. **Branch** — `git` agent, mode `start`, with the plan path.
3. **Build** — `engineer` agent with the plan path. If it returns a question, take it to Bob (or back to the planner), update the plan, and run the engineer again.
4. **Document** — `documenter` agent with the plan path.
5. **Review** — `reviewer` agent with the plan path. Findings go to this session only, never to GitHub.
6. **Fix** — if the verdict is not "ready": `planner` skill in fix mode with the findings → `engineer` (fix round) → `documenter` → `reviewer` again. At most 2 fix rounds; after that, stop and ask Bob how to proceed.
7. **Ship** — `git` agent, mode `ship`, with the plan path. It opens the PR and stops.
8. **Merge** — a person merges in the GitHub UI (Squash and merge). Fernando may review first; it is optional.
9. **Clean up** — when Bob says it is merged: `git` agent, mode `cleanup`.

Pass each agent the plan path and the fix round number when there is one. Agents start without this conversation, so anything they need must be in the plan file or in what you pass them.

## Names

One short, descriptive English slug (2–5 words, kebab-case) names everything for a piece of work:

- Plan: `plans/2026-10-28-csv-export-zeros.md`
- Branch: `fix/csv-export-zeros` — prefixes `feat/`, `fix/`, `chore/`, `docs/`
- PR title and commit messages: imperative, under 60 characters, say what changes for the user or the code — "Keep SKU IDs as text in CSV export", not "Update apps-script.gs".

## Checks you can run locally

- Frontend JS: `node --check file.js`
- Apps Script: `node --check < apps-script.gs` (works for any `.gs` file)
- Python: `python3 -m py_compile file.py`
- Apps Script unit tests run only inside the Apps Script editor (`runAllTests`) — list them in the deploy notes instead.
