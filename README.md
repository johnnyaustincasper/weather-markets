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
- `firebase.json` keeps both Firestore rules and Hosting config in-repo
- `.env.example` documents the Vite Firebase web config expected by the app
- `src/lib/firebase.ts` safely initializes Firebase only when env vars are present
- `src/services/paperPersistence.ts` adds a Firestore-backed paper ledger document
- `src/App.tsx` now hydrates from Firestore when configured and otherwise falls back cleanly to browser-local storage
- the UI shows whether paper persistence is running local-only or against Firestore

### Local setup
```bash
cp .env.example .env.local
# fill in the real Firebase Web App values from the Firebase console
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
- basic bot state scaffolding for future automation

### Deploy
```bash
npm run build
npm run deploy
```

### Manual console steps still required
1. Open Firebase Console for project `weather-markets-bot`
2. Create or confirm the Firebase Web app and copy its config into `.env.local`
3. Enable Firestore in Native mode
4. Replace the placeholder deny-all `firestore.rules` with real auth-aware rules before production use
5. If you want browser writes to Firestore, add Authentication or another trusted write path, then update the rules accordingly
6. If you deploy hosting through Firebase, make sure the hosting site `weather-markets-bot` exists
7. If you deploy through Vercel instead, copy the same `VITE_FIREBASE_*` env vars into the Vercel project settings

## Next best upgrade
Replace the current heuristic contract mapping with a real market parser that:
1. recognizes listed weather contracts directly from exchange metadata
2. maps each contract to a structured resolution schema
3. uses event-specific weather features instead of generic threshold heuristics
4. backtests edge ranking against historical forecast drift and settlement outcomes
