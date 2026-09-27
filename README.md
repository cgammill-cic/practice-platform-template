# Practice Platform

A private practice-management app for independent advisors: relationships and follow-ups, meetings,
outreach drafting, pursuits and customers, time tracking, and a daily digest. It runs as your own copy
in your own Cloudflare account, with your own database. Nobody else, including whoever set it up for you,
can see your data unless you give them access.

## What's in your copy

| Layer | Component |
|---|---|
| App | Cloudflare Workers (Hono, TypeScript), server-rendered pages |
| Data | Cloudflare D1 (SQLite) in your account |
| Files | Cloudflare R2 in your account: nightly backups, your logo |
| Sign-in | Named accounts (email and password) plus an owner passphrase for emergencies |
| Calendar and mail (optional) | Microsoft Outlook via Microsoft Graph: meeting sync, email logging, the digest, drafts |
| Outreach drafting (optional) | Anthropic's Claude, with your own API key |

## First visit

The first time anyone opens a new copy, it shows **Set up this copy**. Enter the owner passphrase chosen
when the copy was deployed (`APP_PASSWORD`), then your name, email and a password. The app builds its
database and signs you in as the first admin. Then:

1. **Settings** (Data → Settings): your firm name, app name, timezone, digest hour and logo.
2. **Users**: add the people who should have access.
3. **Health**: connect Outlook if you use it.
4. **Outreach → Voice & limits**: your name and a line about your practice, if you use drafting.

## Secrets

Set in Cloudflare: Workers & Pages → your worker → Settings → Variables and Secrets. Always choose type
**Secret**, never plain text.

| Name | Required | Purpose |
|---|---|---|
| `APP_PASSWORD` | yes | The owner passphrase: first-run setup, and an emergency way in |
| `SESSION_SECRET` | yes | Signs sign-in sessions. A long random string. Changing it signs everyone out and disconnects Outlook |
| `MS_CLIENT_ID`, `MS_TENANT_ID`, `MS_CLIENT_SECRET` | no | Your Microsoft app registration, for Outlook |
| `ANTHROPIC_API_KEY` | no | For outreach drafting. Create it inside a **workspace** at console.anthropic.com |

## Updates

See [docs/UPDATING.md](docs/UPDATING.md). In short: sync your copy with the template on GitHub, wait for
it to redeploy, then click **Apply Updates** on the Health page if it asks.

## Running it locally (for developers)

```
npm install
cp .dev.vars.example .dev.vars   # throwaway local values
npm run db:local                 # build a local database from the migrations
npm run dev                      # http://localhost:8787
```

`npm run check` runs the type check and confirms the generated schema manifest and migrations bundle are
current. After adding a migration: `npm run schema:manifest && npm run migrations:bundle`.

## License

See `LICENSE`. This software is licensed per copy; it is not open source.
