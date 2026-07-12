// ======================================================================
//  MATCH MODEL — Poisson + Dixon-Coles probability engine
//  Ported from Plsimulator (plsim/models.py, walk-forward backtested
//  RPS 0.2068 vs Pinnacle 0.1994) and Gameweek Edge (plsimRatings).
//  Pure functions, no dependencies. Shared by generate + settle.
// ======================================================================

const GRID = 11;               // 0..10 goals per side
const PRIOR_WEIGHT = 8;        // pseudo-matches pulling ratings toward 1.0
const FIT_ITERATIONS = 24;
const DEFAULT_RHO = -0.084;    // Dixon-Coles low-score correction (fitted)
const DEFAULT_BASE_HOME = 1.62;
const DEFAULT_BASE_AWAY = 1.32;

// --- Poisson ---
function poissonPmf(k, lambda) {
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}

// Dixon-Coles tau: reweights 0-0 / 1-0 / 0-1 / 1-1 cells
function dcTau(h, a, lh, la, rho) {
  if (h === 0 && a === 0) return 1 - lh * la * rho;
  if (h === 0 && a === 1) return 1 + lh * rho;
  if (h === 1 && a === 0) return 1 + la * rho;
  if (h === 1 && a === 1) return 1 - rho;
  return 1;
}

// 11x11 scoreline grid, flat array indexed h*GRID+a, normalised to 1
function scoreGrid(lh, la, rho = DEFAULT_RHO) {
  const grid = new Array(GRID * GRID);
  let total = 0;
  for (let h = 0; h < GRID; h++) {
    const ph = poissonPmf(h, lh);
    for (let a = 0; a < GRID; a++) {
      const p = ph * poissonPmf(a, la) * dcTau(h, a, lh, la, rho);
      grid[h * GRID + a] = p;
      total += p;
    }
  }
  for (let i = 0; i < grid.length; i++) grid[i] /= total;
  return grid;
}

// --- Rating fit (attack/defence multipliers from finished results) ---
// results: [{ home, away, hg, ag }] — team names as keys.
// Returns { teams: {name: {att, def}}, baseHome, baseAway, matches }.
// Ratings shrink toward 1.0 via PRIOR_WEIGHT pseudo-matches, so a
// small early-season sample degrades gracefully to league-average.
function fitRatings(results) {
  const teams = {};
  results.forEach(r => { teams[r.home] = true; teams[r.away] = true; });
  const names = Object.keys(teams);
  if (!names.length || !results.length) {
    return { teams: {}, baseHome: DEFAULT_BASE_HOME, baseAway: DEFAULT_BASE_AWAY, matches: 0 };
  }

  const baseHome = results.reduce((s, r) => s + r.hg, 0) / results.length || DEFAULT_BASE_HOME;
  const baseAway = results.reduce((s, r) => s + r.ag, 0) / results.length || DEFAULT_BASE_AWAY;
  const avgSide = (baseHome + baseAway) / 2;
  const prior = PRIOR_WEIGHT * avgSide;

  const att = {}, def = {};
  names.forEach(n => { att[n] = 1; def[n] = 1; });

  for (let iter = 0; iter < FIT_ITERATIONS; iter++) {
    const scored = {}, expScored = {}, conceded = {}, expConceded = {};
    names.forEach(n => { scored[n] = 0; expScored[n] = 0; conceded[n] = 0; expConceded[n] = 0; });

    for (const r of results) {
      const expH = baseHome * att[r.home] * def[r.away];
      const expA = baseAway * att[r.away] * def[r.home];
      scored[r.home] += r.hg; expScored[r.home] += expH;
      scored[r.away] += r.ag; expScored[r.away] += expA;
      conceded[r.home] += r.ag; expConceded[r.home] += expA;
      conceded[r.away] += r.hg; expConceded[r.away] += expH;
    }

    let attSum = 0, defSum = 0;
    for (const n of names) {
      att[n] *= Math.sqrt((scored[n] + prior) / (expScored[n] + prior));
      def[n] *= Math.sqrt((conceded[n] + prior) / (expConceded[n] + prior));
      attSum += att[n]; defSum += def[n];
    }
    // Renormalise so mean att = mean def = 1 (keeps bases meaningful)
    const attMean = attSum / names.length, defMean = defSum / names.length;
    for (const n of names) { att[n] /= attMean; def[n] /= defMean; }
  }

  const out = {};
  names.forEach(n => { out[n] = { att: att[n], def: def[n] }; });
  return { teams: out, baseHome, baseAway, matches: results.length };
}

// Expected goals for a fixture under a fit. def > 1 = concedes more.
function lambdas(fit, home, away) {
  const h = fit.teams[home], a = fit.teams[away];
  if (!h || !a) return null;
  return {
    lh: fit.baseHome * h.att * a.def,
    la: fit.baseAway * a.att * h.def
  };
}

// --- Market probabilities from a score grid ---
function markets(grid) {
  let home = 0, draw = 0, away = 0, btts = 0;
  let over15 = 0, over25 = 0, over35 = 0;
  let csHome = 0, csAway = 0, wtnHome = 0, wtnAway = 0;
  const scores = [];

  for (let h = 0; h < GRID; h++) {
    for (let a = 0; a < GRID; a++) {
      const p = grid[h * GRID + a];
      if (h > a) home += p; else if (h === a) draw += p; else away += p;
      if (h > 0 && a > 0) btts += p;
      if (h + a > 1.5) over15 += p;
      if (h + a > 2.5) over25 += p;
      if (h + a > 3.5) over35 += p;
      if (a === 0) { csHome += p; if (h > 0) wtnHome += p; }
      if (h === 0) { csAway += p; if (a > 0) wtnAway += p; }
      scores.push({ h, a, p });
    }
  }
  scores.sort((x, y) => y.p - x.p);
  return {
    home, draw, away, btts,
    over15, over25, over35,
    under15: 1 - over15, under25: 1 - over25, under35: 1 - over35,
    csHome, csAway, wtnHome, wtnAway,
    topScores: scores.slice(0, 5)
  };
}

// --- Candidate tip generation ---
// Turns market probabilities into a list of structured tip candidates.
// Thresholds keep only selections the model considers genuinely likely;
// the caller applies a further edge filter once odds are attached.
function candidatesForFixture(homeName, awayName, m) {
  const c = [];
  const add = (market, pick, line, prob, betType, selection) =>
    c.push({ market, pick, line, prob, betType, selection });

  // 1X2 — strongest outcome only
  const best = Math.max(m.home, m.draw, m.away);
  if (best === m.home && m.home >= 0.45) add('1X2', 'HOME', null, m.home, '1X2', `${homeName} to win`);
  else if (best === m.away && m.away >= 0.45) add('1X2', 'AWAY', null, m.away, '1X2', `${awayName} to win`);
  else if (best === m.draw && m.draw >= 0.32) add('1X2', 'DRAW', null, m.draw, '1X2', 'Draw');

  // BTTS
  if (m.btts >= 0.55) add('BTTS', 'YES', null, m.btts, 'BTTS', 'Yes');
  else if (m.btts <= 0.42) add('BTTS', 'NO', null, 1 - m.btts, 'BTTS', 'No');

  // Over/Under goals
  const ouLines = [[1.5, m.over15, m.under15], [2.5, m.over25, m.under25], [3.5, m.over35, m.under35]];
  for (const [line, over, under] of ouLines) {
    if (over >= 0.58) add('OU', 'OVER', line, over, `Over/Under ${line}`, `Over ${line} Goals`);
    else if (under >= 0.58) add('OU', 'UNDER', line, under, `Over/Under ${line}`, `Under ${line} Goals`);
  }

  // Clean sheets / win to nil
  if (m.csHome >= 0.42) add('CLEAN_SHEET', 'HOME', null, m.csHome, 'Clean Sheet', `${homeName} clean sheet`);
  if (m.csAway >= 0.42) add('CLEAN_SHEET', 'AWAY', null, m.csAway, 'Clean Sheet', `${awayName} clean sheet`);
  if (m.wtnHome >= 0.35) add('WIN_TO_NIL', 'HOME', null, m.wtnHome, 'Win to Nil', `${homeName} win to nil`);
  if (m.wtnAway >= 0.35) add('WIN_TO_NIL', 'AWAY', null, m.wtnAway, 'Win to Nil', `${awayName} win to nil`);

  // Correct score — most likely score if it carries real weight
  const top = m.topScores[0];
  if (top && top.p >= 0.12) {
    add('CORRECT_SCORE', `${top.h}-${top.a}`, null, top.p, 'Correct Score', `${top.h}-${top.a}`);
  }

  return c;
}

// --- Deterministic settlement for structured tips ---
// Returns 'Won' | 'Lost' | 'Void'
function settleStructured(market, pick, line, hg, ag) {
  const total = hg + ag;
  switch (market) {
    case '1X2':
      if (pick === 'HOME') return hg > ag ? 'Won' : 'Lost';
      if (pick === 'AWAY') return ag > hg ? 'Won' : 'Lost';
      if (pick === 'DRAW') return hg === ag ? 'Won' : 'Lost';
      return 'Void';
    case 'BTTS': {
      const both = hg > 0 && ag > 0;
      if (pick === 'YES') return both ? 'Won' : 'Lost';
      if (pick === 'NO') return !both ? 'Won' : 'Lost';
      return 'Void';
    }
    case 'OU':
      if (line == null) return 'Void';
      if (pick === 'OVER') return total > line ? 'Won' : 'Lost';
      if (pick === 'UNDER') return total < line ? 'Won' : 'Lost';
      return 'Void';
    case 'CLEAN_SHEET':
      if (pick === 'HOME') return ag === 0 ? 'Won' : 'Lost';
      if (pick === 'AWAY') return hg === 0 ? 'Won' : 'Lost';
      return 'Void';
    case 'WIN_TO_NIL':
      if (pick === 'HOME') return hg > ag && ag === 0 ? 'Won' : 'Lost';
      if (pick === 'AWAY') return ag > hg && hg === 0 ? 'Won' : 'Lost';
      return 'Void';
    case 'CORRECT_SCORE': {
      const mParts = String(pick).match(/^(\d+)-(\d+)$/);
      if (!mParts) return 'Void';
      return parseInt(mParts[1]) === hg && parseInt(mParts[2]) === ag ? 'Won' : 'Lost';
    }
    default:
      return 'Void';
  }
}

// Normalise a club name for cross-source matching (model.json vs API-Football)
function normName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(fc|afc|cf|sc|ac|club|cd|de|the)\b/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '');
}

module.exports = {
  GRID,
  DEFAULT_RHO,
  poissonPmf,
  dcTau,
  scoreGrid,
  fitRatings,
  lambdas,
  markets,
  candidatesForFixture,
  settleStructured,
  normName
};
