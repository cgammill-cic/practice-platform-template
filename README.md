# practice-platform

A private practice management platform for independent consultants and advisors: relationships,
follow-ups, time tracking, and reporting. One place to know who matters, what has happened, what should
happen next, what work was performed, and what should be invoiced.

**North star:** capture information once, reuse it everywhere.

This is a template — deploy your own independent copy on your own Cloudflare account. Nobody else,
including whoever maintains the upstream template, has access to your data.

## Architecture

| Layer | Component |
|---|---|
| UI | Server-rendered HTML from the Worker (Hono) |
| Logic | Cloudflare Workers (Hono, TypeScript) |
| Data | Cloudflare D1 (SQLite) |
| Files | Cloudflare R2 (backups) |
| Identity | Passphrase session |
| Calendar/mail | Microsoft Graph, delegated, read-only for calendar/mail metadata, send-as-self for the daily digest (optional — the app runs fully without it) |

## Principles

Relationships before pipeline. Capture once, reuse everywhere. Draft, then approve — automation prepares
records for review; it never silently posts data you haven't seen. Integrate rather than recreate. Least
privilege. Every feature useful on its own.

## Deploy your own copy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cgammill-cic/practice-platform-template)

The **Deploy to Cloudflare** button above provisions your own D1 database and R2 bucket, forks this repo
into your own GitHub account, wires up auto-deploy, and prompts you for secrets. It does **not** run the
database migrations — your new database is created empty, and the first sign-in will fail with an
Internal Server Error until you apply them. See **`docs/local-setup.md` → "After clicking Deploy"** for
the one command that fixes this, and for the full walkthrough (including running it locally first if
you'd rather develop before deploying).

## Working agreements

- No secrets, personal data, or production tokens in the repository. Secrets live in Cloudflare
  (Settings → Variables and Secrets).
- Database migrations are versioned and applied by hand — see `docs/runbook.md`.
- Keep a decision log (`docs/decision-log.md`) — write down why, not just what.

## Running it locally

```
git clone https://github.com/<your-username>/<your-repo>
cd <your-repo>
npm install
# create .dev.vars with APP_PASSWORD and SESSION_SECRET — throwaway values, not your production ones
npm run db:local    # build a local database from the migrations
npm run dev         # then open http://localhost:8787
```

Needs Node 20+. Clone it somewhere plain and local — **not inside OneDrive or Dropbox**, which will try
to sync `node_modules` and make a mess of builds and git state.

`npm run check` before every pull request. Migrations are applied by hand, dev then prod, before the
merge — a merge auto-deploys but cannot touch D1.

Full setup, the working agreements, and where to start reading: **`docs/local-setup.md`**.

## Environments

| Environment | Purpose | Database |
|---|---|---|
| Production | `main` branch auto-deploys to your Worker's URL | `<yourapp>-prod` |
| Preview | Pull requests get automatic preview URLs | (no real data) |
| Local | `npm run dev` — local simulation | local SQLite, touches nothing real |

## Runbook

Deploy, rollback, secrets, databases, health check: see [docs/runbook.md](docs/runbook.md).

## Repository layout

```
/docs          decision-log.md, definitions.md, runbook.md, local-setup.md
/migrations    versioned D1 migrations
/src           application code
```
