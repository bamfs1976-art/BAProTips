// ======================================================================
//  SETTLE TIPS — Netlify Scheduled Function
//  Runs daily at 23:30 UTC via cron
//  Budget: ~48 API-Football calls (of 88 daily total)
//  Idempotent: re-running is safe, only settles Pending tips
// ======================================================================

const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

// --- Environment ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;

// --- Constants ---
const MAX_API_CALLS = 48;
const MIN_ELAPSED_MS = 6000000; // 100 minutes after kickoff

let apiCallCount = 0;

// --- Helpers ---
async function apiFootball(endpoint, params) {
  if (apiCallCount >= MAX_API_CALLS) {
    console.log(`[API-Football] Budget exhausted (${apiCallCount}/${MAX_API_CALLS})`);
    return null;
  }
  const url = new URL(`https://v3.football.api-sports.io${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const resp = await fetch(url.toString(), {
    headers: { 'x-apisports-key': API_FOOTBALL_KEY }
  });

  if (!resp.ok) {
    console.error(`[API-Football] ${endpoint} returned ${resp.status}`);
    return null;
  }

  const data = await resp.json();
  apiCallCount++;
  console.log(`[API-Football] ${endpoint} — call #${apiCallCount}`);
  return data.response || [];
}

// --- Settlement Logic ---
function settleBet(tip, homeGoals, awayGoals, events) {
  const hg = homeGoals ?? 0;
  const ag = awayGoals ?? 0;
  const totalGoals = hg + ag;
  const score = `${hg}-${ag}`;
  const sel = tip.selection.toLowerCase();
  const bt = tip.bet_type.toLowerCase();
  const matchParts = tip.match.split(' vs ');
  const homeName = (matchParts[0] || '').trim().toLowerCase();
  const awayName = (matchParts[1] || '').trim().toLowerCase();

  let result = 'Void';

  if (bt === '1x2' || bt === 'match result') {
    if (sel.includes('home') || sel.includes(homeName)) {
      result = hg > ag ? 'Won' : 'Lost';
    } else if (sel.includes('away') || sel.includes(awayName)) {
      result = ag > hg ? 'Won' : 'Lost';
    } else if (sel.includes('draw')) {
      result = hg === ag ? 'Won' : 'Lost';
    }
  } else if (bt === 'btts' || bt.includes('both teams')) {
    const btts = hg > 0 && ag > 0;
    result = (sel.includes('yes') && btts) || (sel.includes('no') && !btts) ? 'Won' : 'Lost';
  } else if (bt.includes('over') || bt.includes('under')) {
    const lineMatch = tip.selection.match(/([\d.]+)/);
    if (lineMatch) {
      const line = parseFloat(lineMatch[1]);
      if (sel.includes('over')) result = totalGoals > line ? 'Won' : 'Lost';
      else result = totalGoals < line ? 'Won' : 'Lost';
    }
  } else if (bt.includes('clean sheet')) {
    const isHome = sel.includes(homeName);
    const clean = isHome ? ag === 0 : hg === 0;
    if (sel.includes('yes') || !sel.includes('no')) result = clean ? 'Won' : 'Lost';
    else result = !clean ? 'Won' : 'Lost';
  } else if (bt.includes('win to nil')) {
    const isHome = sel.includes(homeName);
    result = (isHome && hg > ag && ag === 0) || (!isHome && ag > hg && hg === 0) ? 'Won' : 'Lost';
  } else if (bt.includes('correct score')) {
    const csMatch = sel.match(/(\d+)\s*[-\u2013]\s*(\d+)/);
    if (csMatch) {
      result = (parseInt(csMatch[1]) === hg && parseInt(csMatch[2]) === ag) ? 'Won' : 'Lost';
    }
  } else if (bt.includes('first team to score')) {
    if (events && events.length) {
      const goals = events
        .filter(e => e.type === 'Goal')
        .sort((a, b) => (a.time.elapsed || 0) - (b.time.elapsed || 0));
      if (goals.length) {
        result = sel.includes(goals[0].team.name.toLowerCase()) ? 'Won' : 'Lost';
      }
    }
  } else if (bt.includes('goalscorer')) {
    if (events && events.length) {
      const scorerNames = events
        .filter(e => e.type === 'Goal')
        .map(e => (e.player.name || '').toLowerCase());
      const playerName = sel.replace(/anytime|to score|goalscorer/gi, '').trim().toLowerCase();
      result = scorerNames.some(n => n.includes(playerName) || playerName.includes(n)) ? 'Won' : 'Lost';
    }
  } else if (bt.includes('handicap')) {
    const hcMatch = sel.match(/([-+][\d.]+)/);
    if (hcMatch) {
      const hc = parseFloat(hcMatch[1]);
      const isHome = sel.includes(homeName);
      const adjHome = hg + (isHome ? hc : 0);
      const adjAway = ag + (isHome ? 0 : hc);
      if (isHome) {
        result = adjHome > adjAway ? 'Won' : adjHome === adjAway ? 'Void' : 'Lost';
      } else {
        result = adjAway > adjHome ? 'Won' : adjAway === adjHome ? 'Void' : 'Lost';
      }
    }
  }

  return { result, score };
}

// --- Recalculate Stats ---
function calculateStats(tips) {
  const settled = tips.filter(t => t.status !== 'Pending');
  const won = settled.filter(t => t.status === 'Won');
  const lost = settled.filter(t => t.status === 'Lost');
  const voided = settled.filter(t => t.status === 'Void');
  const nonVoid = settled.filter(t => t.status !== 'Void');
  const winRate = nonVoid.length > 0 ? Math.round(won.length / nonVoid.length * 100) : 0;

  // This week
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  weekStart.setHours(0, 0, 0, 0);
  const wonThisWeek = won.filter(t => t.settled_at && t.settled_at >= weekStart.getTime()).length;

  // Streak
  let streak = 0, streakDir = '';
  const sorted = [...settled].sort((a, b) => (b.settled_at || 0) - (a.settled_at || 0));
  if (sorted.length) {
    streakDir = sorted[0].status === 'Won' ? 'W' : 'L';
    for (const t of sorted) {
      if ((streakDir === 'W' && t.status === 'Won') || (streakDir === 'L' && t.status === 'Lost')) streak++;
      else break;
    }
  }

  // By bet type
  const winRateByBet = {};
  settled.forEach(t => {
    if (!winRateByBet[t.bet_type]) winRateByBet[t.bet_type] = { won: 0, total: 0 };
    if (t.status !== 'Void') winRateByBet[t.bet_type].total++;
    if (t.status === 'Won') winRateByBet[t.bet_type].won++;
  });
  const winRateByBetPct = {};
  for (const [k, v] of Object.entries(winRateByBet)) {
    winRateByBetPct[k] = v.total > 0 ? Math.round(v.won / v.total * 100) : 0;
  }

  // By competition
  const winRateByComp = {};
  settled.forEach(t => {
    if (!winRateByComp[t.competition]) winRateByComp[t.competition] = { won: 0, total: 0 };
    if (t.status !== 'Void') winRateByComp[t.competition].total++;
    if (t.status === 'Won') winRateByComp[t.competition].won++;
  });
  const winRateByCompPct = {};
  for (const [k, v] of Object.entries(winRateByComp)) {
    winRateByCompPct[k] = v.total > 0 ? Math.round(v.won / v.total * 100) : 0;
  }

  // Acca stats
  const accas = settled.filter(t => t.is_acca);
  const accaWon = accas.filter(t => t.status === 'Won').length;
  const accaNonVoid = accas.filter(t => t.status !== 'Void').length;
  const accaWinRate = accaNonVoid > 0 ? Math.round(accaWon / accaNonVoid * 100) : 0;

  // Longest streaks
  let longestWin = 0, longestLoss = 0, cw = 0, cl = 0;
  [...sorted].reverse().forEach(t => {
    if (t.status === 'Won') { cw++; cl = 0; if (cw > longestWin) longestWin = cw; }
    else if (t.status === 'Lost') { cl++; cw = 0; if (cl > longestLoss) longestLoss = cl; }
  });

  return {
    total: settled.length,
    won: won.length,
    lost: lost.length,
    voided: voided.length,
    win_rate: winRate,
    won_this_week: wonThisWeek,
    streak: `${streak}${streakDir}`,
    streak_dir: streakDir,
    win_rate_by_bet: winRateByBetPct,
    win_rate_by_comp: winRateByCompPct,
    acca_win_rate: accaWinRate,
    longest_win: longestWin,
    longest_loss: longestLoss
  };
}

// --- Main Handler ---
exports.handler = async (event) => {
  const startTime = Date.now();
  console.log('=== SETTLE TIPS START ===');

  // Validate environment
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[FATAL] Missing Supabase config');
    return { statusCode: 500, body: 'Missing Supabase config' };
  }
  if (!API_FOOTBALL_KEY) {
    console.error('[FATAL] Missing API_FOOTBALL_KEY');
    return { statusCode: 500, body: 'Missing API-Football key' };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  try {
    // ----------------------------------------------------------------
    //  STEP 1: Fetch all pending tips from Supabase
    // ----------------------------------------------------------------
    console.log('[Step 1] Fetching pending tips...');
    const { data: pendingTips, error: fetchErr } = await supabase
      .from('daily_tips')
      .select('*')
      .eq('status', 'Pending')
      .order('kickoff', { ascending: true });

    if (fetchErr) throw new Error(`Supabase fetch error: ${fetchErr.message}`);

    const now = Date.now();
    // Filter to tips where kickoff was 100+ minutes ago
    const eligibleTips = pendingTips.filter(t => {
      const ko = new Date(t.kickoff).getTime();
      return now - ko >= MIN_ELAPSED_MS;
    });

    // Separate non-acca and acca tips
    const singleTips = eligibleTips.filter(t => !t.is_acca);
    const accaTips = eligibleTips.filter(t => t.is_acca);

    console.log(`[Step 1] Found ${pendingTips.length} pending, ${eligibleTips.length} eligible (${singleTips.length} singles, ${accaTips.length} accas)`);

    if (!eligibleTips.length) {
      console.log('[Step 1] No eligible tips — logging skip');
      await supabase.from('generation_log').insert({
        run_type: 'settle', status: 'skipped', settled_count: 0,
        api_calls_used: 0, duration_ms: Date.now() - startTime,
        error_message: 'No eligible pending tips'
      });
      return { statusCode: 200, body: 'No tips to settle' };
    }

    // ----------------------------------------------------------------
    //  STEP 2: Settle each single tip
    // ----------------------------------------------------------------
    console.log('[Step 2] Settling individual tips...');
    let settledCount = 0;
    const fixtureCache = {}; // cache fixture lookups by match name

    for (const tip of singleTips) {
      if (apiCallCount >= MAX_API_CALLS) {
        console.log('[Step 2] API budget exhausted, stopping');
        break;
      }

      const matchParts = tip.match.split(' vs ');
      if (matchParts.length !== 2) {
        console.warn(`[Step 2] Invalid match format: ${tip.match}`);
        continue;
      }

      const homeName = matchParts[0].trim();
      const awayName = matchParts[1].trim();
      const cacheKey = `${homeName}|${awayName}`;

      let fixtureResult = fixtureCache[cacheKey];

      if (!fixtureResult) {
        // Search for the fixture by date
        const koDate = tip.kickoff.split('T')[0] || new Date(tip.kickoff).toISOString().split('T')[0];
        const searchResults = await apiFootball('/fixtures', {
          date: koDate, timezone: 'UTC'
        });

        if (!searchResults || !searchResults.length) {
          console.warn(`[Step 2] No fixtures found for date ${koDate}`);
          continue;
        }

        // Find matching fixture
        const match = searchResults.find(f =>
          f.teams.home.name === homeName && f.teams.away.name === awayName
        );

        if (!match) {
          console.warn(`[Step 2] Fixture not found: ${tip.match}`);
          continue;
        }

        fixtureResult = match;
        fixtureCache[cacheKey] = match;
      }

      const st = fixtureResult.fixture?.status?.short;
      if (!['FT', 'AET', 'PEN'].includes(st)) {
        console.log(`[Step 2] ${tip.match} not finished (status: ${st})`);
        continue;
      }

      const hg = fixtureResult.goals?.home ?? 0;
      const ag = fixtureResult.goals?.away ?? 0;

      // Fetch events if needed for goalscorer/first-to-score bets
      let events = null;
      const bt = tip.bet_type.toLowerCase();
      if (bt.includes('goalscorer') || bt.includes('first team to score')) {
        if (apiCallCount < MAX_API_CALLS) {
          events = await apiFootball('/fixtures/events', {
            fixture: fixtureResult.fixture.id
          });
        }
      }

      const { result, score } = settleBet(tip, hg, ag, events);

      // Update in Supabase
      const { error: updateErr } = await supabase
        .from('daily_tips')
        .update({
          status: result,
          settled_at: now,
          settled_score: score
        })
        .eq('id', tip.id);

      if (updateErr) {
        console.error(`[Step 2] Update failed for ${tip.match}: ${updateErr.message}`);
      } else {
        console.log(`[Step 2] Settled: ${tip.match} — ${result} (${score})`);
        settledCount++;
      }
    }

    // ----------------------------------------------------------------
    //  STEP 3: Settle accumulator tips
    // ----------------------------------------------------------------
    if (accaTips.length) {
      console.log('[Step 3] Settling accumulators...');

      // Refetch all tips to get updated statuses
      const { data: allTips } = await supabase
        .from('daily_tips')
        .select('*')
        .gte('generated_at', Date.now() - 7 * 86400000); // last 7 days

      for (const acca of accaTips) {
        const legs = acca.acca_legs || [];
        if (!legs.length) continue;

        const legResults = legs.map(legMatch => {
          const legTip = (allTips || []).find(t => !t.is_acca && t.match === legMatch);
          return legTip ? legTip.status : 'Pending';
        });

        if (legResults.includes('Pending')) {
          console.log(`[Step 3] Acca "${acca.match}" has pending legs, skipping`);
          continue;
        }

        let accaResult;
        if (legResults.includes('Lost')) accaResult = 'Lost';
        else if (legResults.every(r => r === 'Won')) accaResult = 'Won';
        else if (legResults.some(r => r === 'Void') && !legResults.includes('Lost')) accaResult = 'Void';
        else accaResult = 'Lost';

        const { error: accaErr } = await supabase
          .from('daily_tips')
          .update({
            status: accaResult,
            settled_at: now,
            settled_score: legResults.join(', ')
          })
          .eq('id', acca.id);

        if (!accaErr) {
          console.log(`[Step 3] Acca settled: ${accaResult}`);
          settledCount++;
        }
      }
    }

    // ----------------------------------------------------------------
    //  STEP 4: Recalculate stats
    // ----------------------------------------------------------------
    console.log('[Step 4] Recalculating stats...');
    const { data: allTipsForStats } = await supabase
      .from('daily_tips')
      .select('*')
      .order('generated_at', { ascending: false })
      .limit(500);

    if (allTipsForStats && allTipsForStats.length) {
      const stats = calculateStats(allTipsForStats);
      const today = new Date().toISOString().split('T')[0];

      await supabase.from('tip_stats').upsert({
        stats_date: today,
        ...stats
      }, { onConflict: 'stats_date' });

      console.log(`[Step 4] Stats updated: ${stats.win_rate}% win rate, ${stats.total} settled`);
    }

    // Log success
    await supabase.from('generation_log').insert({
      run_type: 'settle',
      status: 'success',
      settled_count: settledCount,
      api_calls_used: apiCallCount,
      duration_ms: Date.now() - startTime
    });

    console.log(`=== SETTLE TIPS COMPLETE === (${Date.now() - startTime}ms, ${apiCallCount} API calls, ${settledCount} settled)`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        settled: settledCount,
        apiCalls: apiCallCount,
        duration: Date.now() - startTime
      })
    };

  } catch (err) {
    console.error('[FATAL]', err.message);

    try {
      await supabase.from('generation_log').insert({
        run_type: 'settle',
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
