# Running this on your own machine

**Written for Windows**; the macOS and Linux equivalents are in the Claude Code docs at
<https://code.claude.com/docs/en/setup>.

---

## After clicking Deploy

The **Deploy to Cloudflare** button does almost everything: it forks the repo into your GitHub account,
creates a Worker, and provisions a fresh D1 database and R2 bucket, all wired together automatically. The
one thing it does **not** do is run the database migrations — your new database is created completely
empty, with no tables. Visiting your new site and trying to sign in fails with **Internal Server Error**
until you fix this. It's a one-time step, and it's the same for every fresh deployment:

1. Install [Node 20+](https://nodejs.org) and [Git for Windows](https://git-scm.com/downloads/win) if you
   don't already have them (see "What you need first" below for details).
2. Clone **your own fork** — not this template, the copy the Deploy button created under your GitHub
   account. It's named after the project name you chose during deploy.
   ```powershell
   git clone https://github.com/<your-username>/<your-project-name>
   cd <your-project-name>
   npm install
   ```
3. Sign in to Cloudflare from the command line — this opens a browser window once:
   ```powershell
   npx wrangler login
   ```
4. Apply every migration to your new database in one command. Cloudflare already wrote your database's
   name into `wrangler.jsonc` during deploy, so this needs no editing:
   ```powershell
   npx wrangler d1 migrations apply <your-project-name>-db --remote
   ```
   (If you renamed the database during deploy, use that name instead — check the `database_name` field in
   `wrangler.jsonc` if you're not sure.)
5. Reload your site. Sign in with the `APP_PASSWORD` you set during deploy.

That's it — steps 1-4 only ever need to happen once, right after your first deploy. From then on your app
works normally, and any *future* migration (if you pull in an update from the template) is applied the same
way: `npx wrangler d1 migrations apply <your-project-name>-db --remote`.

**Sending this app to someone else?** Every person who clicks the Deploy button gets their own completely
separate copy — their own database, their own Worker, their own data, invisible to you and to anyone else's
deployment. Each of them needs to do the one-time steps above once for their own copy.

---

## First: you may not need a terminal at all

There is a **desktop app** that runs Claude Code with a graphical interface — no terminal. Download for
Windows: <https://claude.com/download>. If the terminal is the part you are dreading, start there.

The rest of this document assumes the terminal, because that is where the git commands live and they are
worth knowing.

---

## Which terminal (Windows)

Press **Start**, type `powershell`, open **Windows PowerShell**. That is the terminal. You can tell you
are in it because the prompt starts with `PS`:

```
PS C:\Users\you>
```

If the prompt has no `PS` in front, you are in Command Prompt instead — that also works, but the install
command is different, so it is worth knowing which one you have.

Nothing here needs Administrator.

---

## What you need first

| Thing | Why | Check |
|---|---|---|
| **Node 20 or newer** | Wrangler 4 requires it. This is for the PROJECT, not for Claude Code | `node -v` |
| **git** | Real commits, branches, diffs | `git --version` |
| Access to your GitHub repo | Cloning and pushing | You own it |
| Access to your Cloudflare account | Only to touch D1 or deploy by hand | You own it |

If either command says `not recognized`, install it:

- **Node** — <https://nodejs.org>, the LTS installer. Accept the defaults.
- **Git for Windows** — <https://git-scm.com/downloads/win>. Also gives Claude Code its Bash tool; without
  it Claude Code falls back to PowerShell, which works but is more limited.

Close and reopen PowerShell after either install, or the new commands will not be on your path yet.

**Claude Code itself does not need Node.** It ships as a native Windows binary. Node is required by *this
project* — wrangler, `npm install`, the local database.

---

## Installing Claude Code

In **PowerShell**:

```powershell
irm https://claude.ai/install.ps1 | iex
```

In **Command Prompt** instead:

```
curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd
```

Then confirm it worked:

```powershell
claude --version
```

That should print a version number. If anything looks wrong later, `claude doctor` prints diagnostics
without starting a session.

**If it says `claude` is not recognized**, the install worked but did not reach your PATH. Check:

```powershell
Test-Path "$env:USERPROFILE\.local\bin\claude.exe"
```

`True` means the binary is there and only PATH is wrong. Add it once:

```powershell
[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path","User") + ";$env:USERPROFILE\.local\bin", "User")
```

That prints nothing on success. Close PowerShell, open a new window, and `claude --version` works from
anywhere. PATH is only read when a window opens, so a reopen is required — reinstalling is not.

Native installs update themselves in the background. `winget install Anthropic.ClaudeCode` also works but
does not auto-update.

The first time you run `claude` it opens a browser to log in. Claude Code requires a Pro, Max, Team,
Enterprise or Console account; the free plan does not include it.

---

## Where to put the repo — this one matters

**Do not clone it inside OneDrive.**

`npm install` creates a `node_modules` folder holding tens of thousands of small files. OneDrive will try
to sync every one of them: builds crawl, files get locked mid-write, and git can end up in a confused
state that is genuinely unpleasant to unpick. The same applies to Dropbox and Google Drive.

Your home folder is fine — `C:\Users\you\practice-platform`. It is plain local storage; OneDrive only
syncs what lives under an explicitly-synced folder.

The repository is already backed up: it lives on GitHub, and that is the copy that matters. It does not
need to be in a synced folder to be safe.

---

## One-time PowerShell setting

Windows ships with script execution disabled, and npm on Windows *is* a script. Without this, every `npm`
command fails with `npm.ps1 cannot be loaded because running scripts is disabled on this system`:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

No Administrator needed, and it may apply silently without asking for confirmation. Verify with
`Get-ExecutionPolicy -Scope CurrentUser`, which should answer `RemoteSigned` — Microsoft's own recommended
workstation setting: scripts written locally run, scripts downloaded from the internet need a signature.

---

## Setup, once

**`git clone` creates the folder for you.** Do not make it first — cloning into a folder you created by
hand nests the repo inside it.

```powershell
cd C:\Users\you
git clone https://github.com/<your-username>/<your-repo>
cd <your-repo>
npm install
```

**Read what `npm install` prints.** npm 11 blocks package install scripts by default, and this project
has two that genuinely need to run:

```
2 packages have install scripts not yet covered by allowScripts:
  esbuild, workerd
```

`workerd` **is** the Cloudflare Workers runtime — the thing that actually runs the app locally. If its
install script did not run, nothing starts. Approve them and install again:

```powershell
npm install-scripts approve esbuild
npm install-scripts approve workerd
npm install
```

Then create a file called `.dev.vars` in the project root. Run this from inside the project folder:

```powershell
Set-Content -Path .dev.vars -Encoding ascii -Value @(
  "APP_PASSWORD=test",
  "SESSION_SECRET=local-only-9f3a7c2e1b4d8a6f"
)
Get-Content .dev.vars
```

The second line echoes the file back so you can see it worked.

**Not Notepad**, deliberately. Notepad's Save As appends `.txt`, producing `.dev.vars.txt` — which looks
correct in a folder listing and silently does not work. `-Encoding ascii` matters too: PowerShell 5.1's
`utf8` writes a byte-order mark, and three invisible bytes at the start of the file would attach
themselves to the first variable name.

**Do not put your production values in this file.** They are not needed and copying them puts live
credentials on your laptop for no benefit. The local database is separate and starts empty, so `test` is
a fine local passphrase. `.dev.vars` is already in `.gitignore`, so it cannot be committed by accident —
but the reason to use throwaway values is that a laptop is a worse place to keep a production secret than
Cloudflare is.

The Microsoft variables (`MS_CLIENT_ID`, `MS_TENANT_ID`, `MS_CLIENT_SECRET`) are **optional**. Leave them
out and the app runs normally, with the Outlook panel on `/health` reporting that it is not configured.
That is deliberate — see the note on `Bindings` in `src/types.ts`.

---

## Running it

```powershell
npm run db:local    # build a local database from the migrations
npm run dev         # then open http://localhost:8787
```

Leave that window running while you work; `Ctrl+C` stops it.

Sign in with whatever you put in `APP_PASSWORD`.

**`npm run db:local` deletes the local database and replays every migration from empty.** That is
deliberate: an incremental mode was tried and was actively destructive, because several migrations rebuild
tables via create-copy-drop-rename, which does not replay safely over an already-migrated database. Local
data is disposable. Run it whenever you add a migration, and whenever the app complains about a missing
table.

**The local database has no data in it.** That is normal. It is a real schema with no rows, which is the
right thing for testing a form or a query. If you need realistic data, restore a backup JSON from R2 into
it rather than pointing anything local at production.

---

## Before every pull request

```powershell
npm run check
```

That runs the TypeScript check and verifies `src/schemaManifest.ts` matches the migrations. It is fast,
and it catches the two mistakes this codebase is built to guard against: a type error, and a migration
whose objects were never added to the manifest that `/health` compares against.

---

## Migrations are still applied by hand

A merge to `main` auto-deploys, but the Cloudflare Workers Builds token cannot touch D1 — so a migration
never applies itself. Someone applies it, deliberately, before the merge.

```powershell
npx wrangler login                                   # once
npx wrangler d1 execute <yourapp>-dev  --remote --file=migrations/00NN_whatever.sql
npx wrangler d1 execute <yourapp>-prod --remote --file=migrations/00NN_whatever.sql
npx wrangler d1 execute <yourapp>-prod --remote --command "INSERT INTO d1_migrations (name) VALUES ('00NN_whatever.sql');"
```

Dev first, then prod, then the ledger row **in the same sitting**. A hand-applied migration missing from
the ledger will cause a future `wrangler d1 migrations apply` to try to replay it (or everything before
it) against a database that already has it.

Take a manual backup first if the migration drops or rebuilds anything: `/health` → **Run Backup Now**.

Full rules — including the SQLite table-rebuild pattern — are in `runbook.md`.

---

## Working agreements worth keeping

These aren't about tooling — they're the habits that keep a codebase like this honest as it grows,
whether you're working alone or with help from an AI assistant.

1. **Every change arrives as a pull request and waits for review**, even when you're the only one working
   on this. It's a deliberate failsafe, not a formality — it's the point where you actually read the diff.
2. **A fresh branch per pull request**, cut from current `main` — not from the previous branch. A branch
   cut before someone else's merge will conflict unnecessarily.
3. **Migrations before the merge**, per the section above.
4. **The decision log gets a row whenever a direction is chosen**, including the alternatives that were
   rejected and why. `docs/decision-log.md` is what lets a future session (yours, or an AI assistant's)
   pick up months of context in one read.
5. **Verify by looking at real output, not by reasoning about the code.** A check that "should" pass is
   not the same as one you watched pass. This applies doubly to anything touching money, deletion, or
   other people's data.

---

## Where to start reading

| File | What it holds |
|---|---|
| `docs/decision-log.md` | Every decision, its reason, what was rejected, and what it cost. Start here |
| `docs/definitions.md` | What your own vocabulary means — stages, cadence rules, pursuits, duplicates |
| `docs/runbook.md` | How to operate it — deploys, rollback, migrations, backups, Outlook, the digest |
| `src/types.ts` | The controlled vocabularies, and which ones carry a database constraint |

The code comments in this project are unusually long on purpose. They carry the argument for why
something is the way it is, which is the part that is expensive to reconstruct and cheap to write down at
the time. Keep that habit as you extend it.
