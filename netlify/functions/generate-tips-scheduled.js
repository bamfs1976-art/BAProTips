// ======================================================================
//  GENERATE TIPS — Netlify Scheduled Function
//  Runs daily at 07:00 UTC via cron
//  Budget: ~40 API-Football calls (of 88 daily total)
//  Budget: 1 Anthropic call
// ======================================================================

const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

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
const SEASON = 2025;

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

// --- Main Handler ---
exports.handler = async (event) => {
  const startTime = Date.now();
  console.log('=== GENERATE TIPS START ===');
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
  if (!ANTHROPIC_KEY) {
    console.error('[FATAL] Missing ANTHROPIC_API_KEY');
    return { statusCode: 500, body: 'Missing Anthropic key' };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  try {
    // ----------------------------------------------------------------
    //  STEP 1: Fetch fixtures for today + tomorrow across all leagues
    // ----------------------------------------------------------------
    console.log('[Step 1] Fetching fixtures...');
    const today = todayStr();
    const tomorrow = tomorrowStr();

    // Sort leagues by priority
    const sortedLeagues = [...ALL_LEAGUES].sort((a, b) => {
      const ai = PRIORITY_LEAGUES.indexOf(a.id);
      const bi = PRIORITY_LEAGUES.indexOf(b.id);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    let allFixtures = [];
    for (const lg of sortedLeagues) {
      if (apiCallCount >= MAX_API_CALLS) break;
      try {
        const fx = await apiFootball('/fixtures', {
          league: lg.id, season: SEASON, from: today, to: tomorrow
        });
        fx.forEach(f => { f._league = lg.name; f._leagueId = lg.id; });
        allFixtures.push(...fx);
      } catch (e) {
        console.warn(`[Step 1] League ${lg.name} failed: ${e.message}`);
      }
    }

    // Keep only upcoming fixtures
    const now = Date.now();
    allFixtures = allFixtures.filter(f => {
      const st = f.fixture?.status?.short;
      return ['NS', 'TBD'].includes(st) || new Date(f.fixture.date).getTime() > now;
    });

    console.log(`[Step 1] Found ${allFixtures.length} upcoming fixtures (${apiCallCount} API calls used)`);

    if (!allFixtures.length) {
      console.log('[Step 1] No fixtures found — logging skip');
      await supabase.from('generation_log').insert({
        run_type: 'generate', status: 'skipped', tips_count: 0,
        api_calls_used: apiCallCount, duration_ms: Date.now() - startTime,
        error_message: 'No upcoming fixtures found'
      });
      return { statusCode: 200, body: 'No fixtures — skipped' };
    }

    // ----------------------------------------------------------------
    //  STEP 2: Fetch H2H + injuries for top fixtures (max 15)
    // ----------------------------------------------------------------
    console.log('[Step 2] Fetching stats for top fixtures...');
    const fixtureData = [];
    const maxStats = Math.min(allFixtures.length, 15);

    for (const f of allFixtures.slice(0, maxStats)) {
      if (apiCallCount >= MAX_API_CALLS) break;
      const entry = { fixture: f, h2h: [], injuries: [] };

      try {
        const h2h = await apiFootball('/fixtures/headtohead', {
          h2h: `${f.teams.home.id}-${f.teams.away.id}`, last: 5
        });
        entry.h2h = h2h.map(m => ({
          home: m.teams.home.name, away: m.teams.away.name,
          homeGoals: m.goals.home, awayGoals: m.goals.away,
          date: m.fixture.date
        }));
      } catch (e) {
        console.warn(`[Step 2] H2H failed for ${f.teams.home.name} vs ${f.teams.away.name}`);
      }

      try {
        const inj = await apiFootball('/injuries', { fixture: f.fixture.id });
        entry.injuries = inj.map(i => ({
          player: i.player.name, team: i.team.name,
          type: i.player.type, reason: i.player.reason
        }));
      } catch (e) {
        console.warn(`[Step 2] Injuries failed for fixture ${f.fixture.id}`);
      }

      fixtureData.push(entry);
    }

    console.log(`[Step 2] Enriched ${fixtureData.length} fixtures (${apiCallCount} API calls used)`);

    // ----------------------------------------------------------------
    //  STEP 3: Send to Anthropic Claude for tip generation
    // ----------------------------------------------------------------
    console.log('[Step 3] Generating AI tips via Anthropic...');

    const fixturePayload = fixtureData.map(fd => ({
      match: `${fd.fixture.teams.home.name} vs ${fd.fixture.teams.away.name}`,
      competition: fd.fixture._league,
      kickoff: fd.fixture.fixture.date,
      referee: fd.fixture.fixture.referee,
      homeForm: fd.fixture.teams.home.winner ? 'Recent winner' : '',
      awayForm: fd.fixture.teams.away.winner ? 'Recent winner' : '',
      h2h: fd.h2h,
      injuries: fd.injuries
    }));

    const systemPrompt = `You are an expert football analyst and tipster. You analyse fixture data and statistics to generate high-quality betting tips for casual punters. You consider recent form, head to head records, goal averages, defensive records and player availability. You only generate tips where the data provides clear statistical justification. Every tip must include a confidence level of Low, Medium or High and a plain English rationale of no more than two sentences. You do not encourage irresponsible gambling. Always vary bet types across the tip set.`;

    const userPrompt = `Here is today's fixture and stats data: ${JSON.stringify(fixturePayload)}. Generate up to 10 tips for today across a mix of these bet types: 1X2, BTTS, Over/Under goals (1.5/2.5/3.5), first team to score, clean sheet, correct score, anytime goalscorer, Asian handicap, half time/full time, win to nil. Also generate one accumulator tip combining two to five of your highest confidence selections from different matches. Return your response as a valid JSON array only, no other text. Each tip object must have these fields exactly: match (string), competition (string), kickoff (ISO datetime string), betType (string), selection (string), confidence (string: Low or Medium or High), rationale (string max two sentences), status (string: always Pending for new tips), isAcca (boolean), accaLegs (array of match strings if isAcca is true else empty array).`;

    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!claudeResp.ok) {
      const errText = await claudeResp.text();
      throw new Error(`Anthropic API error ${claudeResp.status}: ${errText.substring(0, 200)}`);
    }

    const claudeData = await claudeResp.json();
    console.log('[Step 3] Anthropic response received');

    // ----------------------------------------------------------------
    //  STEP 4: Parse tips and store in Supabase
    // ----------------------------------------------------------------
    console.log('[Step 4] Parsing and storing tips...');

    const tipText = claudeData.content?.[0]?.text || '';
    const jsonMatch = tipText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error('Could not parse tips JSON from AI response');
    }

    let parsedTips = JSON.parse(jsonMatch[0]);
    const ts = Date.now();

    // Map to Supabase row format
    const rows = parsedTips.map((t, i) => ({
      tip_id: `${ts}_${i}`,
      match: t.match,
      competition: t.competition,
      kickoff: t.kickoff,
      bet_type: t.betType,
      selection: t.selection,
      confidence: t.confidence,
      rationale: t.rationale,
      status: 'Pending',
      is_acca: t.isAcca || false,
      acca_legs: t.accaLegs || [],
      generated_at: ts,
      settled_at: null,
      settled_score: null
    }));

    // Upsert tips (tip_id is unique)
    const { data: insertedTips, error: insertErr } = await supabase
      .from('daily_tips')
      .upsert(rows, { onConflict: 'tip_id' })
      .select();

    if (insertErr) {
      console.error('[Step 4] Supabase insert error:', insertErr.message);
      throw new Error(`Supabase insert failed: ${insertErr.message}`);
    }

    console.log(`[Step 4] Stored ${rows.length} tips in Supabase`);

    // Log success
    await supabase.from('generation_log').insert({
      run_type: 'generate',
      status: 'success',
      tips_count: rows.length,
      api_calls_used: apiCallCount,
      duration_ms: Date.now() - startTime
    });

    console.log(`=== GENERATE TIPS COMPLETE === (${Date.now() - startTime}ms, ${apiCallCount} API calls, ${rows.length} tips)`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        tips: rows.length,
        apiCalls: apiCallCount,
        duration: Date.now() - startTime
      })
    };

  } catch (err) {
    console.error('[FATAL]', err.message);

    // Log error
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
