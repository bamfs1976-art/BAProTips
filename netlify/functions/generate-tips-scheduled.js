// ======================================================================
//  GENERATE TIPS — Netlify Scheduled Function
//  Runs daily at 07:00 UTC via cron
//  Budget: ~40 API-Football calls (of 88 daily total)
//  Budget: 1 Anthropic call
//
//  v2: tips are grounded in a Poisson/Dixon-Coles match model
//  (lib/match-model.js). The model prices every market, bookmaker odds
//  are attached where available, and the AI only SELECTS from
//  model-approved candidates and writes rationales — it never invents
//  probabilities or selections. Premier League fixtures are upgraded
//  with calibrated ratings from the Plsimulator model bundle.
// ======================================================================

const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const model = require('./lib/match-model');
const booking = require('./lib/booking-model');

// --- Environment ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// --- Constants ---
const MAX_API_CALLS = 40; // Leave ~48 for settlement function
const PRIORITY_LEAGUES = [2, 39, 140, 135, 78, 61, 94, 88, 253, 40, 179];
const ALL_LEAGUES = [
  { id: 39, name: 'Premier League' }, { id: 140, name: 'La Liga' },
  { id: 135, name: 'Serie A' }, { id: 78, name: 'Bundesliga' },
  { id: 61, name: 'Ligue 1' }, { id: 94, name: 'Primeira Liga' },
  { id: 88, name: 'Eredivisie' }, { id: 2, name: 'Champions League' },
  { id: 3, name: 'Europa League' }, { id: 848, name: 'Conference League' },
  { id: 253, name: 'MLS' }, { id: 262, name: 'Liga MX' },
  { id: 71, name: 'Serie A (Brazil)' }, { id: 307, name: 'Saudi Pro League' },
  { id: 40, name: 'Championship' }, { id: 179, name: 'Premiership (Scotland)' },
  { id: 188, name: 'A-League' }
];
// API-Football season year (2026 = the 2026-27 European season).
// Overridable via env so a new season doesn't need a code change.
const SEASON = parseInt(process.env.API_FOOTBALL_SEASON || '2026', 10);
const MAX_SHORTLIST = 12;      // fixtures we fully price + fetch odds for
const MAX_ODDS_CALLS = 12;
const MAX_INJURY_CALLS = 8;
const MAX_TIPS = 10;
const MIN_EDGE = 0.02;         // when odds exist, require model prob > implied by 2pts
const PLSIM_BUNDLE_URL = 'https://plsimulation.netlify.app/model.json';
const ANTHROPIC_MODEL = 'claude-sonnet-5';

let apiCallCount = 0;

// --- Helpers ---
async function apiFootball(endpoint, params) {
  if (apiCallCount >= MAX_API_CALLS) {
    console.log(`[API-Football] Budget exhausted (${apiCallCount}/${MAX_API_CALLS})`);
    return [];
  }
  const url = new URL(`https://v3.football.api-sports.io${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const resp = await fetch(url.toString(), {
    headers: { 'x-apisports-key': API_FOOTBALL_KEY }
  });

  if (!resp.ok) {
    console.error(`[API-Football] ${endpoint} returned ${resp.status}`);
    return [];
  }

  const data = await resp.json();
  apiCallCount++;
  console.log(`[API-Football] ${endpoint} — call #${apiCallCount}, results: ${data.response?.length || 0}`);
  return data.response || [];
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function tomorrowStr() {
  return new Date(Date.now() + 86400000).toISOString().split('T')[0];
}

function confidenceFor(prob) {
  if (prob >= 0.65) return 'High';
  if (prob >= 0.52) return 'Medium';
  return 'Low';
}

function round4(x) {
  return x == null ? null : Math.round(x * 10000) / 10000;
}

// Last-5 form string ("WWDLW", newest first) for a team from league results
function formString(results, team) {
  const played = results
    .filter(r => r.home === team || r.away === team)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 5);
  return played.map(r => {
    const gf = r.home === team ? r.hg : r.ag;
    const ga = r.home === team ? r.ag : r.hg;
    return gf > ga ? 'W' : gf === ga ? 'D' : 'L';
  }).join('');
}

// --- Plsimulator bundle (free, CORS-open, calibrated PL ratings) ---
async function fetchPlsimBundle() {
  try {
    const resp = await fetch(PLSIM_BUNDLE_URL, { timeout: 8000 });
    if (!resp.ok) return null;
    const bundle = await resp.json();
    if (!bundle?.teams || !bundle?.constants) return null;
    const byNorm = {};
    for (const [name, r] of Object.entries(bundle.teams)) {
      if (name.startsWith('_')) continue;
      byNorm[model.normName(name)] = r;
    }
    console.log(`[Plsim] Bundle loaded — ${Object.keys(byNorm).length} teams, version ${bundle.version || '?'}`);
    return { constants: bundle.constants, byNorm };
  } catch (e) {
    console.warn(`[Plsim] Bundle fetch failed: ${e.message}`);
    return null;
  }
}

// Calibrated lambdas from the Plsimulator bundle, or null if teams unknown
function plsimLambdas(bundle, homeName, awayName) {
  if (!bundle) return null;
  const h = bundle.byNorm[model.normName(homeName)];
  const a = bundle.byNorm[model.normName(awayName)];
  if (!h || !a) return null;
  const c = bundle.constants;
  return {
    lh: (c.BASE_H || 1.62) * h.attack * a.defence * (h.home || 1),
    la: (c.BASE_A || 1.32) * a.attack * h.defence,
    source: 'plsim'
  };
}

// --- Odds parsing ---
// Median decimal odds per selection across bookmakers, then de-vig
// within each market to get implied probabilities.
function parseOdds(oddsResponse) {
  const byMarket = {}; // key -> { selection -> [odds...] }
  const collect = (marketKey, selection, odd) => {
    const o = parseFloat(odd);
    if (!o || o <= 1) return;
    byMarket[marketKey] = byMarket[marketKey] || {};
    (byMarket[marketKey][selection] = byMarket[marketKey][selection] || []).push(o);
  };

  for (const entry of oddsResponse || []) {
    for (const bm of entry.bookmakers || []) {
      for (const bet of bm.bets || []) {
        const name = (bet.name || '').toLowerCase();
        if (name === 'match winner') {
          for (const v of bet.values || []) collect('1X2', v.value, v.odd);
        } else if (name === 'both teams score' || name === 'both teams to score') {
          for (const v of bet.values || []) collect('BTTS', v.value, v.odd);
        } else if (name === 'goals over/under') {
          for (const v of bet.values || []) {
            const m = String(v.value).match(/(Over|Under)\s+([\d.]+)/i);
            if (m) collect(`OU_${m[2]}`, m[1].toUpperCase(), v.odd);
          }
        } else if (name.includes('card') && name.includes('over/under')) {
          for (const v of bet.values || []) {
            const m = String(v.value).match(/(Over|Under)\s+([\d.]+)/i);
            if (m) collect(`CARDS_OU_${m[2]}`, m[1].toUpperCase(), v.odd);
          }
        }
      }
    }
  }

  const median = arr => {
    const s = [...arr].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };

  const out = {}; // key -> { selection -> { odds, implied } }
  for (const [mkt, sels] of Object.entries(byMarket)) {
    const meds = {};
    let vigSum = 0;
    for (const [sel, arr] of Object.entries(sels)) {
      meds[sel] = median(arr);
      vigSum += 1 / meds[sel];
    }
    if (vigSum <= 0) continue;
    out[mkt] = {};
    for (const [sel, odd] of Object.entries(meds)) {
      out[mkt][sel] = { odds: odd, implied: (1 / odd) / vigSum };
    }
  }
  return out;
}

// Attach odds + de-vigged implied prob + edge to a candidate
function attachOdds(cand, odds) {
  let priced = null;
  if (cand.market === '1X2') {
    const sel = cand.pick === 'HOME' ? 'Home' : cand.pick === 'AWAY' ? 'Away' : 'Draw';
    priced = odds['1X2']?.[sel];
  } else if (cand.market === 'BTTS') {
    priced = odds['BTTS']?.[cand.pick === 'YES' ? 'Yes' : 'No'];
  } else if (cand.market === 'OU') {
    priced = odds[`OU_${cand.line}`]?.[cand.pick];
  } else if (cand.market === 'CARDS_OU') {
    priced = odds[`CARDS_OU_${cand.line}`]?.[cand.pick];
  }
  if (priced) {
    cand.odds = Math.round(priced.odds * 100) / 100;
    cand.implied = priced.implied;
    cand.edge = cand.prob - priced.implied;
  }
  return cand;
}

// --- Anthropic selection call ---
// The AI picks candidate ids and writes rationales. All numbers stay
// server-side, so a hallucinated probability cannot reach the database.
async function selectTipsWithAI(fixturesPayload) {
  const systemPrompt = `You are an expert football analyst for a betting tips app. You are given fixtures, recent form, injuries, and a list of CANDIDATE selections. Every candidate was approved by a Poisson/Dixon-Coles statistical model and includes the model probability, and where available the bookmaker odds and the edge versus the market. Your job is ONLY to choose the best candidates and write rationales. You must not invent selections, probabilities or odds — reason only over the data provided. Prefer candidates with positive edge and strong probability, vary bet types, and never pick more than 2 candidates from the same match. Card-market candidates (Total Cards, Player Carded) come from a discipline/referee model — their "note" field carries the supporting stats; never select a Player Carded candidate whose player appears in the injuries list. Do not put Player Carded or Correct Score selections in the accumulator. Rationales are plain English, max two sentences, and should reference the supporting data (form, model probability, edge, referee stats, injuries). You do not encourage irresponsible gambling.`;

  const userPrompt = `Fixture data with candidates: ${JSON.stringify(fixturesPayload)}

Choose up to ${MAX_TIPS} candidates. Also choose 2-4 of your selected candidates from DIFFERENT matches for an accumulator (prefer probability >= 0.55 each). Return ONLY valid JSON, no other text, in this exact shape:
{"tips":[{"id":"<candidate id>","rationale":"<max two sentences>"}],"acca":{"ids":["<candidate id>","<candidate id>"],"rationale":"<max two sentences>"}}
If no accumulator is sensible, return "acca": null.`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 2500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Anthropic API error ${resp.status}: ${errText.substring(0, 200)}`);
  }

  const data = await resp.json();
  const text = data.content?.[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Could not parse selection JSON from AI response');
  return JSON.parse(jsonMatch[0]);
}

// Deterministic fallback when the AI call fails: top candidates by
// edge (when priced) then probability, max 2 per match.
function selectTipsFallback(allCandidates) {
  const ranked = [...allCandidates].sort((a, b) => {
    const ea = a.edge ?? -1, eb = b.edge ?? -1;
    if (eb !== ea) return eb - ea;
    return b.prob - a.prob;
  });
  const perMatch = {};
  const chosen = [];
  for (const c of ranked) {
    if (chosen.length >= MAX_TIPS) break;
    perMatch[c.match] = perMatch[c.match] || 0;
    if (perMatch[c.match] >= 2) continue;
    perMatch[c.match]++;
    chosen.push({
      id: c.id,
      rationale: `Model probability ${(c.prob * 100).toFixed(0)}%${c.edge != null ? ` vs ${(c.implied * 100).toFixed(0)}% implied by the odds (${(c.edge * 100).toFixed(0)}% edge)` : ''}. Selected automatically by the statistical model.`
    });
  }
  const accaIds = chosen
    .map(t => allCandidates.find(c => c.id === t.id))
    .filter(c => c && c.prob >= 0.55)
    .filter((c, i, arr) => arr.findIndex(x => x.match === c.match) === i)
    .slice(0, 4)
    .map(c => c.id);
  return {
    tips: chosen,
    acca: accaIds.length >= 2 ? { ids: accaIds, rationale: 'Combination of the model\'s highest-probability selections from different matches.' } : null
  };
}

// --- Main Handler ---
exports.handler = async (event) => {
  const startTime = Date.now();
  console.log('=== GENERATE TIPS START (v2 model-grounded) ===');
  console.log(`[Config] Date: ${todayStr()}, Max API calls: ${MAX_API_CALLS}`);

  // Validate environment
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[FATAL] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
    return { statusCode: 500, body: 'Missing Supabase config' };
  }
  if (!API_FOOTBALL_KEY) {
    console.error('[FATAL] Missing API_FOOTBALL_KEY');
    return { statusCode: 500, body: 'Missing API-Football key' };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  try {
    // ----------------------------------------------------------------
    //  STEP 1: One full-season fixtures call per league.
    //  This yields BOTH the finished results (to fit team ratings)
    //  AND today/tomorrow's upcoming fixtures — same 1 call per league
    //  the old code spent on a 2-day window.
    // ----------------------------------------------------------------
    console.log('[Step 1] Fetching season fixtures per league...');
    const today = todayStr();
    const tomorrow = tomorrowStr();
    const now = Date.now();

    const sortedLeagues = [...ALL_LEAGUES].sort((a, b) => {
      const ai = PRIORITY_LEAGUES.indexOf(a.id);
      const bi = PRIORITY_LEAGUES.indexOf(b.id);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    const leagueData = {}; // leagueId -> { results, fit, upcoming }
    let upcomingCount = 0;

    for (const lg of sortedLeagues) {
      if (apiCallCount >= MAX_API_CALLS - MAX_ODDS_CALLS) break;
      try {
        const fx = await apiFootball('/fixtures', { league: lg.id, season: SEASON });
        const results = [];
        const upcoming = [];
        for (const f of fx) {
          const st = f.fixture?.status?.short;
          if (['FT', 'AET', 'PEN'].includes(st) && f.goals?.home != null && f.goals?.away != null) {
            results.push({
              home: f.teams.home.name, away: f.teams.away.name,
              hg: f.goals.home, ag: f.goals.away,
              ts: new Date(f.fixture.date).getTime()
            });
          } else {
            const koDate = (f.fixture?.date || '').split('T')[0];
            const isUpcoming = (['NS', 'TBD'].includes(st) || new Date(f.fixture.date).getTime() > now);
            if (isUpcoming && (koDate === today || koDate === tomorrow)) {
              f._league = lg.name; f._leagueId = lg.id;
              upcoming.push(f);
            }
          }
        }
        if (upcoming.length) {
          leagueData[lg.id] = {
            results,
            fit: model.fitRatings(results),
            upcoming
          };
          upcomingCount += upcoming.length;
          console.log(`[Step 1] ${lg.name}: ${results.length} results fitted, ${upcoming.length} upcoming`);
        }
      } catch (e) {
        console.warn(`[Step 1] League ${lg.name} failed: ${e.message}`);
      }
    }

    console.log(`[Step 1] ${upcomingCount} upcoming fixtures across ${Object.keys(leagueData).length} leagues (${apiCallCount} API calls used)`);

    if (!upcomingCount) {
      console.log('[Step 1] No fixtures found — logging skip');
      await supabase.from('generation_log').insert({
        run_type: 'generate', status: 'skipped', tips_count: 0,
        api_calls_used: apiCallCount, duration_ms: Date.now() - startTime,
        error_message: 'No upcoming fixtures found'
      });
      return { statusCode: 200, body: 'No fixtures — skipped' };
    }

    // ----------------------------------------------------------------
    //  STEP 2: Price the shortlist with the model.
    //  PL fixtures use calibrated Plsimulator ratings when team names
    //  match; everything else uses the season fit from Step 1.
    // ----------------------------------------------------------------
    console.log('[Step 2] Pricing fixtures with the model...');
    const plsimBundle = await fetchPlsimBundle(); // free call, not in budget

    const shortlist = [];
    const seenFixtures = new Set();
    for (const lg of sortedLeagues) {
      const ld = leagueData[lg.id];
      if (!ld) continue;
      for (const f of ld.upcoming.sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date))) {
        if (shortlist.length >= MAX_SHORTLIST) break;
        if (seenFixtures.has(f.fixture.id)) continue;
        seenFixtures.add(f.fixture.id);
        const homeName = f.teams.home.name, awayName = f.teams.away.name;

        let lam = lg.id === 39 ? plsimLambdas(plsimBundle, homeName, awayName) : null;
        if (!lam) {
          lam = model.lambdas(ld.fit, homeName, awayName);
          if (lam) lam.source = `season-fit (${ld.fit.matches} matches)`;
        }
        if (!lam) {
          console.log(`[Step 2] No ratings for ${homeName} vs ${awayName} — skipped`);
          continue;
        }

        const grid = model.scoreGrid(lam.lh, lam.la);
        const mkts = model.markets(grid);
        const cands = model.candidatesForFixture(homeName, awayName, mkts);

        // Booking Analytics Pro speciality: card-market candidates for
        // PL fixtures, from the pl-bookings discipline/referee dataset.
        if (lg.id === 39) {
          try {
            cands.push(...booking.cardCandidates(homeName, awayName, f.fixture.referee));
          } catch (e) {
            console.warn(`[Step 2] Card candidates failed for ${homeName} vs ${awayName}: ${e.message}`);
          }
        }
        if (!cands.length) continue;

        shortlist.push({
          fixture: f,
          homeName, awayName,
          league: f._league,
          lambdas: lam,
          markets: mkts,
          candidates: cands,
          homeForm: formString(ld.results, homeName),
          awayForm: formString(ld.results, awayName),
          injuries: []
        });
      }
    }

    console.log(`[Step 2] Priced ${shortlist.length} fixtures (sources: ${shortlist.map(s => s.lambdas.source).join(', ')})`);

    // ----------------------------------------------------------------
    //  STEP 3: Attach bookmaker odds (median across books, de-vigged)
    //  and injuries where the API budget allows.
    // ----------------------------------------------------------------
    console.log('[Step 3] Fetching odds + injuries...');
    let oddsCalls = 0;
    for (const s of shortlist) {
      if (oddsCalls >= MAX_ODDS_CALLS || apiCallCount >= MAX_API_CALLS) break;
      try {
        const oddsResp = await apiFootball('/odds', { fixture: s.fixture.fixture.id });
        oddsCalls++;
        const parsed = parseOdds(oddsResp);
        s.candidates.forEach(c => attachOdds(c, parsed));
      } catch (e) {
        console.warn(`[Step 3] Odds failed for ${s.homeName} vs ${s.awayName}`);
      }
    }

    let injuryCalls = 0;
    for (const s of shortlist) {
      if (injuryCalls >= MAX_INJURY_CALLS || apiCallCount >= MAX_API_CALLS) break;
      try {
        const inj = await apiFootball('/injuries', { fixture: s.fixture.fixture.id });
        injuryCalls++;
        s.injuries = inj.slice(0, 8).map(i => ({
          player: i.player.name, team: i.team.name,
          type: i.player.type, reason: i.player.reason
        }));
      } catch (e) {
        console.warn(`[Step 3] Injuries failed for fixture ${s.fixture.fixture.id}`);
      }
    }

    // ----------------------------------------------------------------
    //  STEP 4: Build the candidate pool.
    //  When a candidate is priced, require a positive edge; keep the
    //  top 4 candidates per fixture to bound the AI context.
    // ----------------------------------------------------------------
    const allCandidates = [];
    const seenSelections = new Set();
    let candSeq = 0;
    for (const s of shortlist) {
      const eligible = s.candidates
        .filter(c => c.edge == null || c.edge >= MIN_EDGE)
        .filter(c => {
          const key = `${s.homeName}|${s.awayName}|${c.market}|${c.pick}|${c.line}`;
          if (seenSelections.has(key)) return false;
          seenSelections.add(key);
          return true;
        })
        .sort((a, b) => (b.edge ?? b.prob - 0.5) - (a.edge ?? a.prob - 0.5));
      // Card markets get reserved slots — the app's speciality shouldn't
      // lose the cap race to generic goals markets.
      const isCard = c => booking.BOOKING_MARKETS.includes(c.market);
      const kept = [
        ...eligible.filter(c => !isCard(c)).slice(0, 4),
        ...eligible.filter(isCard).slice(0, 2)
      ];
      for (const c of kept) {
        c.id = `c${++candSeq}`;
        c.match = `${s.homeName} vs ${s.awayName}`;
        c.competition = s.league;
        c.kickoff = s.fixture.fixture.date;
        c.fixtureId = s.fixture.fixture.id;
        allCandidates.push(c);
      }
      s.kept = kept;
    }

    console.log(`[Step 4] ${allCandidates.length} candidates across ${shortlist.length} fixtures`);

    if (!allCandidates.length) {
      await supabase.from('generation_log').insert({
        run_type: 'generate', status: 'skipped', tips_count: 0,
        api_calls_used: apiCallCount, duration_ms: Date.now() - startTime,
        error_message: 'Model produced no qualifying candidates'
      });
      return { statusCode: 200, body: 'No qualifying candidates — skipped' };
    }

    // ----------------------------------------------------------------
    //  STEP 5: AI selects candidates + writes rationales.
    //  Falls back to a deterministic pick if the AI call fails.
    // ----------------------------------------------------------------
    console.log('[Step 5] Selecting tips...');
    const fixturesPayload = shortlist.filter(s => s.kept.length).map(s => ({
      match: `${s.homeName} vs ${s.awayName}`,
      competition: s.league,
      kickoff: s.fixture.fixture.date,
      referee: s.fixture.fixture.referee || null,
      homeForm: s.homeForm, awayForm: s.awayForm,
      modelExpectedGoals: { home: round4(s.lambdas.lh), away: round4(s.lambdas.la) },
      injuries: s.injuries,
      candidates: s.kept.map(c => ({
        id: c.id, betType: c.betType, selection: c.selection,
        modelProb: round4(c.prob),
        odds: c.odds ?? null,
        impliedProb: round4(c.implied),
        edge: round4(c.edge),
        note: c.meta || undefined
      }))
    }));

    let selection;
    let usedFallback = false;
    if (ANTHROPIC_KEY) {
      try {
        selection = await selectTipsWithAI(fixturesPayload);
      } catch (e) {
        console.warn(`[Step 5] AI selection failed (${e.message}) — using deterministic fallback`);
        selection = selectTipsFallback(allCandidates);
        usedFallback = true;
      }
    } else {
      console.warn('[Step 5] No ANTHROPIC_API_KEY — using deterministic fallback');
      selection = selectTipsFallback(allCandidates);
      usedFallback = true;
    }

    // ----------------------------------------------------------------
    //  STEP 6: Build rows from the chosen candidates. All numbers come
    //  from the model/odds, never from the AI.
    // ----------------------------------------------------------------
    console.log('[Step 6] Building and storing tips...');
    const byId = {};
    allCandidates.forEach(c => { byId[c.id] = c; });

    const ts = Date.now();
    const rows = [];
    const chosen = (selection.tips || []).slice(0, MAX_TIPS);
    const perMatch = {};

    for (const t of chosen) {
      const c = byId[t.id];
      if (!c) { console.warn(`[Step 6] AI chose unknown candidate ${t.id} — ignored`); continue; }
      perMatch[c.match] = (perMatch[c.match] || 0) + 1;
      if (perMatch[c.match] > 2) continue;
      rows.push({
        tip_id: `${ts}_${rows.length}`,
        match: c.match,
        competition: c.competition,
        kickoff: c.kickoff,
        bet_type: c.betType,
        selection: c.selection,
        confidence: confidenceFor(c.prob),
        rationale: String(t.rationale || '').substring(0, 400),
        status: 'Pending',
        is_acca: false,
        acca_legs: [],
        generated_at: ts,
        settled_at: null,
        settled_score: null,
        market: c.market,
        pick: c.pick,
        line: c.line,
        model_prob: round4(c.prob),
        odds: c.odds ?? null,
        implied_prob: round4(c.implied),
        edge: round4(c.edge),
        fixture_id: c.fixtureId
      });
    }

    // Accumulator: legs must be chosen candidates from distinct matches
    const accaSel = selection.acca;
    if (accaSel && Array.isArray(accaSel.ids) && accaSel.ids.length >= 2) {
      const legs = accaSel.ids
        .map(id => byId[id])
        .filter(Boolean)
        .filter(c => !['PLAYER_CARDED', 'CORRECT_SCORE'].includes(c.market))
        .filter(c => rows.some(r => r.match === c.match && r.market === c.market && r.pick === c.pick))
        .filter((c, i, arr) => arr.findIndex(x => x.match === c.match) === i)
        .slice(0, 5);
      if (legs.length >= 2) {
        const combinedProb = legs.reduce((p, c) => p * c.prob, 1);
        const combinedOdds = legs.every(c => c.odds) ?
          Math.round(legs.reduce((p, c) => p * c.odds, 1) * 100) / 100 : null;
        const lastKickoff = legs.map(c => c.kickoff).sort().slice(-1)[0];
        rows.push({
          tip_id: `${ts}_${rows.length}`,
          match: `Accumulator (${legs.length} legs)`,
          competition: 'Multiple',
          kickoff: lastKickoff,
          bet_type: 'Accumulator',
          selection: legs.map(c => `${c.match}: ${c.selection}`).join(' + '),
          confidence: confidenceFor(combinedProb + 0.25), // accas are long odds by nature
          rationale: String(accaSel.rationale || '').substring(0, 400),
          status: 'Pending',
          is_acca: true,
          acca_legs: legs.map(c => c.match),
          generated_at: ts,
          settled_at: null,
          settled_score: null,
          market: 'ACCA',
          pick: null,
          line: null,
          model_prob: round4(combinedProb),
          odds: combinedOdds,
          implied_prob: null,
          edge: null,
          fixture_id: null
        });
      }
    }

    if (!rows.length) throw new Error('No valid tips after AI selection');

    let { error: insertErr } = await supabase
      .from('daily_tips')
      .upsert(rows, { onConflict: 'tip_id' })
      .select();

    // If the v2 migration (supabase-migration-v2.sql) hasn't been run yet,
    // the new columns don't exist — retry with the legacy shape so tip
    // generation never goes dark.
    if (insertErr && /column/i.test(insertErr.message)) {
      console.warn('[Step 6] Insert failed on new columns — run supabase-migration-v2.sql. Retrying with legacy columns only.');
      const legacyRows = rows.map(r => {
        const { market, pick, line, model_prob, odds, implied_prob, edge, fixture_id, ...legacy } = r;
        return legacy;
      });
      ({ error: insertErr } = await supabase
        .from('daily_tips')
        .upsert(legacyRows, { onConflict: 'tip_id' })
        .select());
    }

    if (insertErr) {
      console.error('[Step 6] Supabase insert error:', insertErr.message);
      throw new Error(`Supabase insert failed: ${insertErr.message}`);
    }

    console.log(`[Step 6] Stored ${rows.length} tips in Supabase${usedFallback ? ' (deterministic fallback)' : ''}`);

    await supabase.from('generation_log').insert({
      run_type: 'generate',
      status: 'success',
      tips_count: rows.length,
      api_calls_used: apiCallCount,
      duration_ms: Date.now() - startTime,
      error_message: usedFallback ? 'AI unavailable — deterministic model selection used' : null
    });

    console.log(`=== GENERATE TIPS COMPLETE === (${Date.now() - startTime}ms, ${apiCallCount} API calls, ${rows.length} tips)`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        tips: rows.length,
        apiCalls: apiCallCount,
        fallback: usedFallback,
        duration: Date.now() - startTime
      })
    };

  } catch (err) {
    console.error('[FATAL]', err.message);

    try {
      await supabase.from('generation_log').insert({
        run_type: 'generate',
        status: 'error',
        api_calls_used: apiCallCount,
        duration_ms: Date.now() - startTime,
        error_message: err.message.substring(0, 500)
      });
    } catch (logErr) {
      console.error('[LOG ERROR]', logErr.message);
    }

    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
