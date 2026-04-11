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

## Next best upgrade
Replace the current heuristic contract mapping with a real market parser that:
1. recognizes listed weather contracts directly from exchange metadata
2. maps each contract to a structured resolution schema
3. uses event-specific weather features instead of generic threshold heuristics
4. backtests edge ranking against historical forecast drift and settlement outcomes
