'use strict';
/*
 * OpenRouter narration layer. The market engine computes every number;
 * the model only explains them. If no key is configured (or the call
 * fails) we fall back to a deterministic local brief — the feature must
 * never break because an AI provider is down.
 */
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

function localBrief(a, coach) {
  if (!a || !a.ok) return 'Not enough market data for a brief yet.';
  const res = a.nearestResistance[0], sup = a.nearestSupport[0];
  const lines = [];
  lines.push(`${a.symbol || 'Instrument'} at ${a.price} — ${a.trend}, VWAP ${a.vwap}, RSI ${a.rsi14}.`);
  if (res) lines.push(`Nearest resistance ${res.price}${res.source === 'oi' ? ' (OI wall)' : ''}; nearest support ${sup ? sup.price : '—'}.`);
  const dz = a.demandZones.filter((z) => !z.mitigated).slice(-1)[0];
  const sz = a.supplyZones.filter((z) => !z.mitigated).slice(-1)[0];
  if (sz && a.price < sz.high) lines.push(`Supply overhead ${sz.low}–${sz.high}: avoid chasing longs into it.`);
  if (dz) lines.push(`Demand below ${dz.low}–${dz.high}${dz.fresh ? ' (fresh, untested)' : ''}.`);
  const fvg = a.fvgs.filter((g) => !g.mitigated).slice(-1)[0];
  if (fvg) lines.push(`Unfilled ${fvg.type} FVG ${fvg.low}–${fvg.high} can act as a magnet.`);
  if (a.oi) lines.push(`Option OI: PCR ${a.oi.pcr}, call wall ${a.oi.maxCallOiStrike}, put wall ${a.oi.maxPutOiStrike}, max pain ${a.oi.maxPain}.`);
  if (a.theta) lines.push('Time decay: ' + a.theta.verdict);
  if (coach && coach.signals && coach.signals.length) {
    const danger = coach.signals.find((s) => s.level === 'danger');
    if (danger) lines.push('Coach warning: ' + danger.text);
  }
  lines.push('Levels are context, not a signal. Your lock rules still decide when the day is over.');
  return lines.join(' ');
}

function buildMessages(a, coach) {
  const payload = { market: a, coach: coach || null };
  return [
    { role: 'system', content: 'You are a trading-discipline assistant for an Indian retail trader. ' +
      'Use ONLY the numbers provided. Never give buy/sell recommendations or price predictions. ' +
      'Explain key levels, OI context and behavioural risks in under 140 words, plain language, ₹ formatting where relevant. ' +
      'End with one discipline reminder tied to the coach data.' },
    { role: 'user', content: 'Market analysis JSON:\n' + JSON.stringify(payload) }
  ];
}

async function summarize({ apiKey, geminiApiKey, model, geminiModel, analysis, coach }, fetchImpl) {
  const fallback = () => localBrief(analysis, coach);
  const f = fetchImpl || fetch;

  // 1. Try Google Gemini API if key is present
  const gKey = geminiApiKey || process.env.GEMINI_API_KEY;
  if (gKey) {
    try {
      const gModel = geminiModel || DEFAULT_GEMINI_MODEL;
      const sysInstruction = 'You are a trading-discipline assistant for an Indian retail trader. ' +
        'Use ONLY the numbers provided. Never give buy/sell recommendations or price predictions. ' +
        'Explain key levels, OI context and behavioural risks in under 140 words, plain language, ₹ formatting where relevant. ' +
        'End with one discipline reminder tied to the coach data.';
      const payload = { market: analysis, coach: coach || null };
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${gModel}:generateContent?key=${encodeURIComponent(gKey)}`;
      const res = await f(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: sysInstruction }] },
          contents: [{ role: 'user', parts: [{ text: 'Market analysis JSON:\n' + JSON.stringify(payload) }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 350 }
        })
      });
      const data = await res.json();
      const text = data && data.candidates && data.candidates[0] &&
        data.candidates[0].content && data.candidates[0].content.parts &&
        data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
      if (res.ok && text) {
        return { text: text.trim(), source: 'gemini:' + gModel };
      }
    } catch (e) {
      // Fall through to OpenRouter or local brief
    }
  }

  // 2. Try OpenRouter if key is present
  const oKey = apiKey || process.env.OPENROUTER_API_KEY;
  if (oKey) {
    try {
      const r = await f('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + oKey,
          'HTTP-Referer': process.env.PUBLIC_BASE_URL || 'http://localhost:8787',
          'X-Title': 'Trade Lock'
        },
        body: JSON.stringify({ model: model || DEFAULT_MODEL, messages: buildMessages(analysis, coach), max_tokens: 350, temperature: 0.4 })
      });
      const data = await r.json();
      const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (r.ok && text) return { text: text.trim(), source: 'openrouter:' + (model || DEFAULT_MODEL) };
    } catch (e) {
      // Fall through to local fallback
    }
  }

  // 3. Deterministic local brief fallback
  return { text: fallback(), source: 'local' };
}

module.exports = { localBrief, buildMessages, summarize, DEFAULT_MODEL, DEFAULT_GEMINI_MODEL };
