// ======================================================================
//  BOOKING MODEL — card-market candidates for Premier League fixtures
//  Ported from pl-bookings (Premier League Bookings Desk):
//    - club discipline: cards-against + fouls per game (2025-26 form)
//    - referee card rates: yellows per game
//    - player booking risk: r = yellows/90 x 2 + fouls/90
//  Data snapshot in booking-data.json (rebuild from pl-bookings'
//  data/build_pl_data.py pipeline when a new season's form lands).
// ======================================================================

const DATA = require('./booking-data.json');

const LEAGUE_AVG_YPG = DATA._meta.leagueAvgYpg || 3.74;
const CA_MEDIAN = DATA._meta.caMedian || 1.84;
const CARD_LINES = [3.5, 4.5, 5.5];
const MIN_OU_PROB = 0.58;      // same bar as goals over/unders
const MIN_PLAYER_PROB = 0.32;  // player-carded picks are long odds by nature

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// Fuzzy club lookup: exact normalised match, else containment either way
// ("Tottenham" matches "Tottenham Hotspur", "Bournemouth" matches
// "AFC Bournemouth"). Returns { name, ca, fm } or null.
function lookupClub(apiName) {
  const target = norm(apiName);
  if (!target) return null;
  let hit = null;
  for (const [name, c] of Object.entries(DATA.clubs)) {
    const cand = norm(name);
    if (cand === target || cand.includes(target) || target.includes(cand)) {
      hit = { name, ...c };
      break;
    }
  }
  return hit;
}

// Referee lookup. API-Football gives "M. Oliver", "Michael Oliver" or
// "Michael Oliver, England" — match on surname + first initial.
function lookupRef(apiRef) {
  if (!apiRef) return null;
  const cleaned = String(apiRef).split(',')[0].trim();
  const target = norm(cleaned);
  if (!target) return null;
  const parts = cleaned.split(/\s+/);
  const surname = norm(parts[parts.length - 1]);
  const initial = norm(parts[0]).charAt(0);
  for (const [name, r] of Object.entries(DATA.refs)) {
    const full = norm(name);
    if (full === target) return { name, ...r };
    const rParts = name.split(/\s+/);
    const rSurname = norm(rParts[rParts.length - 1]);
    const rInitial = norm(rParts[0]).charAt(0);
    if (rSurname === surname && rInitial === initial) return { name, ...r };
  }
  return null;
}

function poissonCdf(k, lambda) {
  let sum = 0, term = Math.exp(-lambda);
  for (let i = 0; i <= k; i++) {
    if (i > 0) term *= lambda / i;
    sum += term;
  }
  return sum;
}

// Card-market candidates for one fixture. Returns [] when we have no
// club data at all (non-PL or unknown clubs).
function cardCandidates(homeName, awayName, refName) {
  const hc = lookupClub(homeName);
  const ac = lookupClub(awayName);
  if (!hc && !ac) return [];

  const caH = hc?.ca ?? CA_MEDIAN;
  const caA = ac?.ca ?? CA_MEDIAN;
  const ref = lookupRef(refName);
  const refFactor = ref?.ypg ? ref.ypg / LEAGUE_AVG_YPG : 1;

  // Expected total cards: both clubs' cards-received rate, scaled by
  // how card-happy the assigned referee is (1.0 when unknown).
  const lambda = (caH + caA) * refFactor;

  const out = [];
  const refNote = ref ? ` (ref ${ref.name}, ${ref.ypg}/gm)` : '';

  // Total cards over/under — keep only the single strongest line so
  // cards tips don't crowd out the goals markets.
  let bestOU = null;
  for (const line of CARD_LINES) {
    const pOver = 1 - poissonCdf(Math.floor(line), lambda);
    const pUnder = 1 - pOver;
    const side = pOver >= pUnder
      ? { pick: 'OVER', prob: pOver, sel: `Over ${line} Cards` }
      : { pick: 'UNDER', prob: pUnder, sel: `Under ${line} Cards` };
    if (side.prob >= MIN_OU_PROB && side.prob <= 0.80 && (!bestOU || side.prob > bestOU.prob)) {
      bestOU = { market: 'CARDS_OU', pick: side.pick, line, prob: side.prob, betType: 'Total Cards', selection: side.sel };
    }
  }
  if (bestOU) {
    bestOU.meta = `Expected cards ${lambda.toFixed(1)}${refNote}`;
    out.push(bestOU);
  }

  // Player to be carded — top booking risks across both squads.
  // Probability from the per-90 yellow rate scaled by the referee:
  // p = 1 - exp(-yellows_per_90 * refFactor).
  const pool = [];
  for (const club of [hc, ac]) {
    if (!club) continue;
    for (const p of DATA.players[club.name] || []) {
      const prob = 1 - Math.exp(-p.y * refFactor);
      if (prob >= MIN_PLAYER_PROB) pool.push({ player: p, club: club.name, prob });
    }
  }
  pool.sort((a, b) => b.prob - a.prob);
  for (const { player, club, prob } of pool.slice(0, 2)) {
    out.push({
      market: 'PLAYER_CARDED',
      pick: player.n,
      line: null,
      prob,
      betType: 'Player Carded',
      selection: `${player.n} to be carded`,
      meta: `${player.y}/90 yellows, ${player.f}/90 fouls over ${player.min} mins (${club})${refNote}`
    });
  }

  return out;
}

// --- Settlement from fixture events ---
// Each API-Football Card event counts as one card ('Yellow Card',
// 'Second Yellow card' and straight 'Red Card' details are all single
// events, so a second-yellow dismissal counts 2 cards total).
function countCards(events) {
  return (events || []).filter(e => e.type === 'Card').length;
}

function playerWasCarded(events, playerName) {
  const target = norm(playerName);
  const words = String(playerName || '').trim().split(/\s+/);
  const surname = norm(words[words.length - 1]);
  return (events || []).some(e => {
    if (e.type !== 'Card') return false;
    const n = norm(e.player?.name);
    if (!n) return false;
    // fuzzy: full containment either way, or shared surname
    // (API events often abbreviate: "M. Caicedo" vs "Moisés Caicedo")
    if (n.includes(target) || target.includes(n)) return true;
    return surname.length > 3 && n.endsWith(surname);
  });
}

// Settle a card-market tip. Requires fixture events; Void without them.
function settleBooking(market, pick, line, events) {
  if (!events || !events.length) return 'Void';
  if (market === 'CARDS_OU') {
    const total = countCards(events);
    if (line == null) return 'Void';
    if (pick === 'OVER') return total > line ? 'Won' : 'Lost';
    if (pick === 'UNDER') return total < line ? 'Won' : 'Lost';
    return 'Void';
  }
  if (market === 'PLAYER_CARDED') {
    return playerWasCarded(events, pick) ? 'Won' : 'Lost';
  }
  return 'Void';
}

const BOOKING_MARKETS = ['CARDS_OU', 'PLAYER_CARDED'];

module.exports = {
  BOOKING_MARKETS,
  LEAGUE_AVG_YPG,
  CA_MEDIAN,
  lookupClub,
  lookupRef,
  cardCandidates,
  countCards,
  playerWasCarded,
  settleBooking
};
