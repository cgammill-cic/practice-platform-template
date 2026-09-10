# Definitions

This file is where the vocabulary this app uses gets written down in plain language: what a stage means,
what counts as an outreach attempt, how activity categories map to your calendar, and so on. The
controlled lists themselves (stages, departments, activity categories, sources) live in `src/types.ts`
and are enforced by the database — this file is where you explain *why* each one means what it means, for
your own future reference and for anyone else who works on this with you.

Keep it in sync with the code deliberately. If this file and `src/types.ts` ever disagree, the code is
what actually runs — note the disagreement here as a TODO rather than letting it go unremarked.

## 1. Relationship stages

Document your stage list here (see `STAGES` in `src/types.ts` for the enforced values) — what each stage
means, and the rule for when a contact moves between them.

## 2. Contact sources and priority

Document how contacts get their initial priority/tier when imported or added by hand.

## 3. Data fields

Document any fields whose meaning isn't obvious from the column name alone.

## 4. Cadence and follow-up rules

Document how "next follow-up" dates get set, and any keep-in-touch cadence rules.

## 5. Calendar and time-entry conventions

Document your Outlook category standard here if you use the calendar import (`src/calimport.ts`) or the
activity vocabulary (`/activities`) — what each activity category means, and which one (if any) is
billable.

## Where to look instead

- `src/types.ts` — the controlled vocabularies, and which ones carry a database constraint.
- `docs/decision-log.md` — decisions made while operating this app, and why.
- `docs/runbook.md` — how to operate it day to day.
