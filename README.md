# Weather Markets MVP

A polished React + Vite scanner for weather-driven prediction market setups.

## What changed in this phase
- live Polymarket ingestion for market-context scanning
- live Open-Meteo and NWS weather ingestion with typed normalization
- computed implied probability, model probability, edge, disagreement, confidence, and freshness in the UI
- premium dashboard updated with feed status, freshness, heuristic details, and source comparison
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
- `firebase.json` keeps Hosting, Firestore rules, and Firestore index config in-repo
- `firestore.indexes.json` is scaffolded so future composite indexes can be tracked in git
- `.env.example` documents the Vite Firebase web config expected by the app, including `VITE_PAPER_LEDGER_ID`
- `src/lib/firebase.ts` safely initializes Firebase only when env vars are present
- `src/services/paperPersistence.ts` adds a Firestore-backed paper ledger document
- `src/App.tsx` now hydrates from Firestore when configured and otherwise falls back cleanly to browser-local storage
- the UI shows whether paper persistence is running local-only or against Firestore

### Local setup
```bash
cp .env.example .env.local
# optionally change VITE_PAPER_LEDGER_ID if you want a non-default ledger document
npm install
npm run dev
```

### Current Firestore shape
The first durable backend layer writes one document per paper ledger in:
- `paperTradeLedgers/{ledgerId}`

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

### Manual console steps still required
1. Open Firebase Console for project `weather-markets-bot`
2. Enable Firebase Authentication if you want direct browser writes to Firestore
3. Update the app to sign users in and persist `ownerUid` on each `paperTradeLedgers/{ledgerId}` document
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
4. wires `runPaperBotTick` into a real scheduled backend entrypoint that reads and writes the Firestore ledger
5. backtests edge ranking against historical forecast drift and settlement outcomes
