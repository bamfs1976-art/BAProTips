// ======================================================================
//  AI PROXY — Netlify Function
//  The app's in-browser AI features (Generate Tips Now, performance
//  analysis) used to call the Anthropic API directly from the client with
//  a key kept in localStorage. That put the key in the browser. This
//  function replaces those calls: the client posts structured data to
//  /.netlify/functions/ai-proxy, the prompts are fixed here, and the key
//  comes from ANTHROPIC_API_KEY in the Netlify environment (the same
//  variable the scheduled functions already require).
// ======================================================================

const MODEL = 'claude-sonnet-4-20250514'; // parity with the scheduled generator
const MAX_BODY = 200 * 1024;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const json = (statusCode, body) => ({
  statusCode,
  headers: { ...CORS, 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

// Fixed prompt builders — the client supplies data, never instructions.
const ACTIONS = {
  'generate-tips': {
    maxTokens: 2000,
    system: 'You are an expert football analyst and tipster. You analyse fixture data and statistics to generate high-quality betting tips for casual punters. You consider recent form, head to head records, goal averages, defensive records and player availability. You only generate tips where the data provides clear statistical justification. Every tip must include a confidence level of Low, Medium or High and a plain English rationale of no more than two sentences. You do not encourage irresponsible gambling. Always vary bet types across the tip set.',
    user(payload) {
      const fixtures = Array.isArray(payload.fixtures) ? payload.fixtures.slice(0, 40) : [];
      if (!fixtures.length) return null;
      return `Here is today's fixture and stats data: ${JSON.stringify(fixtures)}. Generate up to 10 tips for today across a mix of these bet types: 1X2, BTTS, Over/Under goals (1.5/2.5/3.5), first team to score, clean sheet, correct score, anytime goalscorer, Asian handicap, half time/full time, win to nil. Also generate one accumulator tip combining two to five of your highest confidence selections from different matches. Return your response as a valid JSON array only, no other text. Each tip object must have these fields exactly: match (string), competition (string), kickoff (ISO datetime string), betType (string), selection (string), confidence (string: Low or Medium or High), rationale (string max two sentences), status (string: always Pending for new tips), isAcca (boolean), accaLegs (array of match strings if isAcca is true else empty array).`;
    }
  },
  'analyse': {
    maxTokens: 1500,
    system: 'You are a football betting analyst. You analyse a punter\'s historical tip performance data and give clear, specific, actionable advice. Focus on which bet types and markets are performing well, which are underperforming, and what adjustments would improve the success rate. Do not encourage irresponsible gambling. Keep all advice responsible and measured.',
    user(payload) {
      if (!payload.stats || typeof payload.stats !== 'object') return null;
      return `Here is my tip performance data: ${JSON.stringify(payload.stats)}. Give me: 1. My three strongest bet types and why. 2. My three weakest bet types and what to change. 3. The competitions where I am most accurate. 4. Acca combinations that have worked well. 5. Three specific actions to improve my overall success rate. Be direct and specific.`;
    }
  }
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  if ((event.body || '').length > MAX_BODY) return json(413, { error: 'Payload too large' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json(501, { error: 'AI is not configured on this deploy — set ANTHROPIC_API_KEY in the Netlify environment.' });

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { error: 'Bad JSON' });
  }

  const action = ACTIONS[payload.action];
  if (!action) return json(400, { error: 'Unknown action' });
  const user = action.user(payload);
  if (!user) return json(400, { error: 'Missing or invalid data for action' });

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: action.maxTokens,
        system: action.system,
        messages: [{ role: 'user', content: user }]
      })
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`[ai-proxy] Anthropic API ${resp.status}: ${errText.slice(0, 200)}`);
      return json(502, { error: `AI service error ${resp.status}` });
    }

    const data = await resp.json();
    const text = (data.content && data.content[0] && data.content[0].text) || '';
    if (!text) return json(502, { error: 'Empty AI response' });
    return json(200, { text });
  } catch (e) {
    console.error('[ai-proxy] ' + e.message);
    return json(502, { error: 'AI service unavailable' });
  }
};
