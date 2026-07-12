# BAProTips — Booking Analytics Pro

Mobile-first PWA for football betting analytics: booking/card intelligence, referee profiles, live match tracking, and AI-curated daily tips across 17 leagues.

- **Frontend:** single-file app (`index.html`), vanilla JS, no build step. Client-side API-Football calls with a per-day budget + eco mode.
- **Backend:** two Netlify scheduled functions + Supabase (tips storage, stats, audit log).
- **Data:** [API-Football](https://www.api-football.com/) (88 calls/day budget shared between generation and settlement).

## Daily tips pipeline (v2 — model-grounded)

Tips are no longer free-form AI guesses. Since v2 the pipeline is:

1. **`generate-tips-scheduled`** (07:00 UTC daily)
   - One full-season fixtures call per league — yields both finished results (to fit team ratings) and today/tomorrow's fixtures.
   - A **Poisson + Dixon-Coles model** (`netlify/functions/lib/match-model.js`, ported from the [Plsimulator](https://github.com/bamfs1976-art/plsimulator) engine that backtests at RPS 0.2068 vs Pinnacle's 0.1994) fits attack/defence ratings per league and prices every market: 1X2, BTTS, Over/Under, clean sheet, win to nil, correct score.
   - Premier League fixtures are upgraded with **calibrated ratings** from the Plsimulator model bundle (`plsimulation.netlify.app/model.json` — free, CORS-open, zero API budget).
   - Bookmaker odds are fetched per shortlisted fixture, **median-aggregated across books and de-vigged**; candidates carry `model_prob`, `odds`, `implied_prob` and `edge`. Priced candidates need a positive edge to survive.
   - Claude then only **selects** from model-approved candidates and writes rationales — it cannot invent selections, probabilities or odds. If the AI call fails, a deterministic fallback publishes the top candidates by edge, so tip generation never goes dark.
   - Confidence is mechanical: model probability ≥65% = High, ≥52% = Medium, else Low.

2. **`settle-tips-scheduled`** (23:30 UTC daily)
   - v2 tips store structured `market` / `pick` / `line` fields and the API-Football `fixture_id`, so settlement is **deterministic** (no parsing of AI-written selection strings) and results are **batch-fetched 20 fixtures per call**.
   - Stats now include **ROI and profit in units** (flat 1-unit stakes on every tip that had odds attached) alongside win rate — because win rate alone can't tell you if the tips make money.

## Deployment

1. Run `supabase-schema.sql` for a fresh project, or `supabase-migration-v2.sql` on an existing one (idempotent — adds the v2 columns). The functions degrade gracefully pre-migration, but new fields won't be stored until it runs.
2. Set Netlify env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `API_FOOTBALL_KEY`, `ANTHROPIC_API_KEY` (optional — fallback selection works without it).
3. Deploy — schedules are configured in `netlify.toml`.

## Sibling projects

- **[Plsimulator](https://github.com/bamfs1976-art/plsimulator)** — calibrated PL match/season simulator; source of the match model and the `model.json` ratings bundle.
- **[gameweek-edge](https://github.com/bamfs1976-art/gameweek-edge)** — FPL companion; architectural patterns (API proxy, caching, push alerts).
- **[pl-bookings](https://github.com/bamfs1976-art/pl-bookings)** — PL player-bookings desk; card-market data pipeline and risk model.
