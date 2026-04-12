# Weather Markets MVP

A polished React + Vite scanner for weather-driven prediction market setups, now with a clear paper account and equity layer for simulated capital tracking.

## What changed in this phase
- live Polymarket ingestion for market-context scanning
- live Open-Meteo and NWS weather ingestion with typed normalization
- computed implied probability, model probability, edge, disagreement, confidence, and freshness in the UI
- premium dashboard updated with feed status, freshness, heuristic details, source comparison, and a dedicated paper account command panel
- clean seam for replacing heuristics with a real event-resolution model later

## Important note
Polymarket's active public feed did not surface live weather-specific contracts during implementation, so the app now:
1. scans active Polymarket markets live
2. counts any live weather-linked contracts it can detect
3. falls back to a curated weather watchlist when live weather listings are absent
4. still computes scanner scores from real weather feeds and a Polymarket-anchored market prior

## Stack
- React
- TypeScript
- Vite

## Run locally
```bash
npm install
npm run dev
```

Then open the local Vite URL, usually `http://localhost:5173`.

## Production build
```bash
npm run build
npm run preview
```

## Firebase backend setup
This repo is now scaffolded for a standalone Firebase path on project `weather-markets-bot`.

### What is wired
- `.firebaserc` points the default Firebase project to `weather-markets-bot`
- Firebase Hosting is already mapped to the `weather-markets-bot` site
- Firebase Web app `weather-markets-web` exists and its public SDK values are prefilled in `.env.example`
- `firebase.json` keeps Hosting, Firestore rules, Firestore indexes, and the Functions codebase in-repo
- `firestore.indexes.json` is scaffolded so future composite indexes can be tracked in git
- `.env.example` documents the Vite Firebase web config expected by the app, including `VITE_PAPER_LEDGER_ID`
- `src/lib/firebase.ts` safely initializes Firebase only when env vars are present
- `src/services/paperPersistence.ts` adds a Firestore-backed paper ledger document with owner metadata and owner-scoped document ids
- `src/App.tsx` now offers Firebase Auth sign-in, hydrates only the signed-in owner's ledger from Firestore, and otherwise falls back cleanly to browser-local storage
- `functions/src/index.ts` adds a backend-runner-ready scheduled paper bot tick path plus an HTTP trigger for manual runs
- the UI shows whether paper persistence is running local-only or against Firestore
- the UI now surfaces paper account value, cash, exposure, open PnL, realized PnL, and bot-managed capital from the same blotter, order, and bot state already tracked in-app
- the operator panel now includes bot supervision checks for overdue ticks, stale inputs, queue buildup, and fill handoff gaps
- backend and manual bot ticks now append a durable run audit trail with action counts, stale-input counts, and queued versus active posture so production supervision can verify scheduler behavior without live trading

### Local setup
```bash
cp .env.example .env.local
# optionally change VITE_PAPER_LEDGER_ID if you want a non-default ledger document
npm install
npm run dev
```

### Current Firestore shape
The first durable backend layer writes one document per owner-scoped paper ledger in:
- `paperTradeLedgers/{ownerUid}__{ledgerId}`

That document currently stores:
- watchlist ids
- paper trade state
- paper execution profile
- paper blotter journal
- staged paper orders
- durable bot loop state, including lease, cadence, tick counters, next due time, and per-market runtime memory

### Deploy
```bash
npm run build
npm run deploy
# or, if dist is already built:
npm run deploy:firebase
```

### Backend runner scaffold
The next scheduler step is now in-repo under `functions/`.

What it does:
- runs on a Firebase scheduled function, default `every 5 minutes`
- can also be triggered manually through an HTTP function or a one-shot local script
- reads and writes the same owner-scoped Firestore ledger document used by the app, `paperTradeLedgers/{ownerUid}__{ledgerId}`
- fetches the current weather market scan using the same market provider used by the app
- runs the existing `runPaperBotTick(...)` paper-only loop
- writes the updated ledger back to Firestore with backend run metadata

Useful commands:
```bash
npm install
npm --prefix functions install
npm run build
npm run build:functions
npm --prefix functions run tick:once -- <ledgerId> <ownerId>
npm run deploy:backend
```

Optional backend env vars:
- `WEATHER_MARKETS_PAPER_LEDGER_ID`, default `default`
- `WEATHER_MARKETS_RUNNER_ID`, set this to the Firebase Auth uid that owns the paper ledger you want the always-on bot to manage. If left at the default `firebase-scheduler` placeholder, scheduled runs now block on purpose so the bot does not silently write to an unreadable owner scope.
- `WEATHER_MARKETS_CRON`, default `every 5 minutes`
- `WEATHER_MARKETS_TRIGGER_SECRET`, optional shared secret for the manual HTTP trigger. Send it as `x-weather-markets-trigger-secret`, `?secret=...`, or JSON body `secret`.

Owner identity mapping for the backend runner:
- the signed-in app writes one Firestore ledger per owner uid
- the Firestore document id is `{ownerUid}__{ledgerId}`
- the Firestore path is `paperTradeLedgers/{ownerUid}__{ledgerId}`
- the scheduler must use that same `ownerUid` as `WEATHER_MARKETS_RUNNER_ID`
- local one-shot runs now fail fast if you omit `<ownerUid>` so the target scope stays explicit

Example:
```bash
# if the signed-in owner uid is abc123 and the ledger id is default,
# the backend runner must use WEATHER_MARKETS_RUNNER_ID=abc123
# and it will read/write paperTradeLedgers/abc123__default
npm --prefix functions run tick:once -- default abc123
```

Deployed Firebase functions:
- `runScheduledPaperBot`, the cron entrypoint. It now records run warnings, owner-scope metadata, and blocks if the runner owner is still the default placeholder.
- `triggerPaperBotNow`, a manual HTTP trigger for ad hoc backend runs. It accepts either query params or JSON body for `ledgerId` and `ownerId`, returns the resolved owner-scope mapping in its summary, and can be protected with `WEATHER_MARKETS_TRIGGER_SECRET`.

### Manual console steps still required
1. Open Firebase Console for project `weather-markets-bot`
2. Enable Firebase Authentication if you want direct browser writes to Firestore
3. Enable Google as a Firebase Auth sign-in provider so the new browser sign-in button can mint a trusted owner identity
4. Keep or tighten the auth-aware `firestore.rules` in this repo, then deploy them with `npm run deploy:firestore`
5. If you deploy through Vercel instead of Firebase Hosting, copy the same `VITE_FIREBASE_*` env vars into the Vercel project settings

## Bot loop scaffolding
`src/services/paperBotLoop.ts` adds a pure, scheduler-friendly paper bot tick runner. It is intentionally safe:
- no live trading hooks
- no direct network writes inside the loop
- simple lease protection so multiple schedulers do not both mutate the same ledger at once
- durable runtime memory for per-market queue and activation state
- conservative automation that only queues, activates after repeated qualifying ticks, and auto-closes when support breaks down

This is meant to be called later from a Firebase Function, cron worker, or another backend runner using the persisted ledger document as the source of truth.

## Next best upgrade
Replace the current heuristic contract mapping with a real market parser that:
1. recognizes listed weather contracts directly from exchange metadata
2. maps each contract to a structured resolution schema
3. uses event-specific weather features instead of generic threshold heuristics
4. adds auth or service-to-service controls around the manual HTTP trigger and any future operator actions
5. backtests edge ranking against historical forecast drift and settlement outcomes
