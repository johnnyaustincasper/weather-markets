# Weather Markets MVP

A polished React + Vite MVP for scanning weather prediction market opportunities.

## What it includes
- premium dark dashboard shell
- opportunity board with implied probability, model probability, edge, disagreement, confidence
- selectable market detail panel
- source comparison panel
- scoring and explanation panel
- mock seeded data with clean service boundaries for future Polymarket + weather API integration

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

## Next integration step
Replace `src/services/marketData.ts` with a provider that:
1. pulls active market contracts from Polymarket
2. normalizes market implied probabilities
3. fetches forecast probabilities from weather sources
4. returns the shared `WeatherMarket` model to the UI
