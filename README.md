# BAProTips (Booking Analytics Pro)

Multi-league AI football tips app: a single-file client (`index.html`) over the
API-Football v3 API, with Claude-generated daily tips created and settled by
scheduled Netlify Functions, and Supabase for tip storage and sync.

## Status

**This app is being retired in favour of
[pl-bookings](https://github.com/bamfs1976-art/pl-bookings) (Premier League
Bookings Desk).** The features worth keeping — the player watchlist and the AI
review of tracker picks — have been ported there. pl-bookings runs on the free
official FPL API with no client-side keys; this app needs a paid API-Football
key and an Anthropic key, and its scheduled functions spend both daily.

Before archiving, delete the two scheduled functions' schedules (or the site)
in Netlify so `generate-tips-scheduled` and `settle-tips-scheduled` stop
burning API budget, and rotate any Anthropic key that was previously pasted
into the app's Settings on any device (older versions kept it in
localStorage).

## Security notes (fixed)

- The in-browser AI features (Generate Tips Now, performance analysis) no
  longer call the Anthropic API directly from the client with a
  localStorage key. They post structured data to
  `netlify/functions/ai-proxy.js`, which holds the prompts and reads
  `ANTHROPIC_API_KEY` from the Netlify environment — the same variable the
  scheduled functions already use. The app clears any key an older version
  left in localStorage.
- The Tips admin panel no longer ships a hardcoded default password. No
  password exists until one is set in Settings, the saved password is never
  echoed back into the DOM, and "reset" now clears the password instead of
  reverting to a known default. (The gate is client-side and cosmetic — the
  panel only drives the user's own local data and keys — but it should never
  have carried a published default.)

## Environment variables (Netlify)

- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` — tip storage (scheduled functions)
- `API_FOOTBALL_KEY` — fixtures/stats (scheduled functions; the client uses a
  user-supplied key from Settings)
- `ANTHROPIC_API_KEY` — tip generation and analysis (scheduled functions and
  `ai-proxy`)
