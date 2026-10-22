/**
 * AI provider model-retirement tests.
 *
 * Production bug (Oct 2026): NVIDIA returned 410 "Gone" for
 * meta/llama-3.1-8b-instruct, so every assistant request failed with the raw
 * provider error in Admin → AI Providers. OpenAI's gpt-4o-mini and Google's
 * gemini-1.5-flash were retired upstream too.
 *
 * Contract pinned here:
 *   - retired model ids are recognised and replaced before any request
 *   - a provider 404/410/400 "model gone" error retries down the CURRENT
 *     model chain, so the assistant keeps working after an upstream
 *     retirement (no redeploy needed)
 *   - a real outage (500/401) is NOT masked by the fallback
 *
 * Run: node --experimental-strip-types --test backend/src/aiModels.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isModelGoneError, PROVIDER_MODEL_CHAIN } from './routes/ai.ts';

test('model-gone classification: 410/404/400 with a retirement message', () => {
  assert.equal(isModelGoneError(410, '{"type":"about:blank","title":"Gone","status":410,"detail":"The model `x` has reached its end of life"}'), true);
  assert.equal(isModelGoneError(404, '{"error":{"message":"The model `foo` does not exist"}}'), true);
  assert.equal(isModelGoneError(400, 'invalid model: foo'), true);
  assert.equal(isModelGoneError(400, 'decommissioned'), true);
});

test('model-gone classification: real outages and auth failures are NOT swallowed', () => {
  assert.equal(isModelGoneError(500, 'internal error'), false);
  assert.equal(isModelGoneError(503, 'unavailable'), false);
  assert.equal(isModelGoneError(401, 'invalid api key'), false);
  assert.equal(isModelGoneError(429, 'rate limited'), false);
  assert.equal(isModelGoneError(400, 'messages must not be empty'), false, 'a non-model 400 is a real bug, not a retirement');
});

test('every provider has a current fallback chain that does not contain retired ids', () => {
  const retired = [
    'meta/llama-3.1-8b-instruct',
    'meta/llama-3.1-70b-instruct',
    'meta-llama/llama-3.1-8b-instruct',
    'gpt-4o-mini',
    'gemini-1.5-flash',
  ];
  for (const [provider, chain] of Object.entries(PROVIDER_MODEL_CHAIN)) {
    assert.ok(chain.length >= 2, `${provider} needs at least one fallback`);
    for (const model of chain) {
      assert.ok(!retired.includes(model), `${provider} chain must not lead with a retired model (${model})`);
    }
  }
  assert.ok(PROVIDER_MODEL_CHAIN.nvidia[0].includes('nemotron'), 'NVIDIA leads with the current Nemotron line');
  assert.ok(PROVIDER_MODEL_CHAIN.openai[0].startsWith('gpt-4.1'), 'OpenAI leads with gpt-4.1');
  assert.ok(PROVIDER_MODEL_CHAIN.gemini[0].startsWith('gemini-2'), 'Gemini leads with the 2.x line');
});

// ---------------------------------------------------------------------------
// THE ACTIVE PROVIDER MUST ANSWER
//
// Production: NVIDIA was the active provider with a valid key and a working
// model (Admin → Test said "OK in 2296ms"), yet the assistant replied "I'm the
// RX Store Assistant (offline). (last error: Gemini error 404 …)" — the error
// of the LAST fallback, and the streaming path had no model-chain retry at all.
// ---------------------------------------------------------------------------

/** A tiny env whose D1 returns the admin's choice (nvidia + its model). */
function aiEnv(opts: {
  active?: 'nvidia' | 'openrouter' | 'openai' | 'gemini';
  model?: string;
  keys?: Record<string, string>;
} = {}) {
  const active = opts.active || 'nvidia';
  const model = opts.model || 'nvidia/nemotron-3.5-lightning-30b-a3b';
  const keys = opts.keys || {};
  return {
    AI_PROVIDER: active,
    AI_FALLBACK: 'openrouter,openai,gemini',
    AI_MODEL: model,
    AI_BASE_URL_NVIDIA: 'https://integrate.api.nvidia.com/v1',
    AI_BASE_URL_OPENROUTER: 'https://openrouter.ai/api/v1',
    AI_BASE_URL_OPENAI: 'https://api.openai.com/v1',
    AI_BASE_URL_GEMINI: 'https://generativelanguage.googleapis.com/v1beta',
    NVIDIA_API_KEY: keys.nvidia,
    OPENROUTER_API_KEY: keys.openrouter,
    OPENAI_API_KEY: keys.openai,
    GEMINI_API_KEY: keys.gemini,
    DB: {
      prepare(sql: string) {
        const s = sql.replace(/\s+/g, ' ');
        return {
          bind() { return this; },
          async first() {
            if (s.includes("FROM ai_settings WHERE id='default'")) return { provider: active, model };
            if (s.includes('FROM ai_settings WHERE id=?')) return null; // no D1-stored keys
            if (s.includes('FROM applications')) return null;
            return null;
          },
          async all() { return { results: [] }; },
          async run() { return { meta: { changes: 0 } }; },
        };
      },
    },
  };
}

const jsonResponse = (obj: any, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

test('the ACTIVE provider answers — the fallback is never used while it works', async () => {
  const { aiRoutes } = await import('./routes/ai.ts');
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith('https://integrate.api.nvidia.com')) {
      return jsonResponse({ choices: [{ message: { content: 'Here are two healthcare apps from the catalog.' } }] });
    }
    // A fallback answering would mean the active provider was skipped.
    return jsonResponse({ choices: [{ message: { content: 'WRONG PROVIDER' } }] });
  }) as any;
  try {
    const env = aiEnv({ keys: { nvidia: 'nvapi-test', gemini: 'gemini-test' } });
    const out: any = await aiRoutes.chat(new Request('https://x/ai/chat', { method: 'POST', body: JSON.stringify({ message: 'healthcare apps?' }) }), env);
    assert.equal(out.provider, 'nvidia', `the active provider must answer (got ${out.provider})`);
    assert.equal(out.model, 'nvidia/nemotron-3.5-lightning-30b-a3b');
    assert.match(out.response, /healthcare/);
    assert.equal(calls.every((u) => u.includes('integrate.api.nvidia.com')), true, 'no fallback provider was called');
  } finally { globalThis.fetch = original; }
});

test('the streaming path also uses the active provider, with its model chain', async () => {
  const { aiRoutes } = await import('./routes/ai.ts');
  const original = globalThis.fetch;
  const tried: string[] = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    tried.push(`${String(url)} :: ${String(init?.body || '')}`);
    if (!String(url).includes('integrate.api.nvidia.com')) {
      return jsonResponse({ error: { message: 'a fallback provider must not be reached' } }, 500);
    }
    const body = JSON.parse(String(init?.body || '{}'));
    if (body.model === 'nvidia/nemotron-3.5-lightning-30b-a3b') {
      // The configured streaming model is gone upstream…
      return new Response('{"detail":"model not found"}', { status: 404 });
    }
    // …but a current model in the chain works.
    return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as any;
  try {
    const env = aiEnv({ keys: { nvidia: 'nvapi-test', gemini: 'gemini-test' } });
    const res = await aiRoutes.chatStream(new Request('https://x/ai/chat/stream', { method: 'POST', body: JSON.stringify({ message: 'hi' }) }), env);
    assert.equal(res.status, 200);
    const usedModel = res.headers.get('X-AI-Model');
    assert.equal(res.headers.get('X-AI-Provider'), 'nvidia');
    assert.notEqual(usedModel, 'nvidia/nemotron-3.5-lightning-30b-a3b', 'the dead id was replaced');
    assert.ok(PROVIDER_MODEL_CHAIN.nvidia.includes(String(usedModel)), `served with a current model (${usedModel})`);
    const text = await res.text();
    assert.match(text, /ok/, 'the streamed answer is returned');
    assert.equal(tried.every((t) => t.includes('integrate.api.nvidia.com')), true, 'no fallback provider was reached');
  } finally { globalThis.fetch = original; }
});

test('a streaming failure falls back to a buffered answer from the SAME provider', async () => {
  const { aiRoutes } = await import('./routes/ai.ts');
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => {
    const body = JSON.parse(String(init?.body || '{}'));
    if (body.stream) return new Response('streaming not supported', { status: 400 });
    return jsonResponse({ choices: [{ message: { content: 'buffered answer' } }] });
  }) as any;
  try {
    const env = aiEnv({ keys: { nvidia: 'nvapi-test', gemini: 'gemini-test' } });
    const res = await aiRoutes.chatStream(new Request('https://x/ai/chat/stream', { method: 'POST', body: JSON.stringify({ message: 'hi' }) }), env);
    const text = await res.text();
    assert.match(text, /buffered answer/, 'the active provider still answers, just not as a stream');
    assert.doesNotMatch(text, /offline/);
  } finally { globalThis.fetch = original; }
});

test('the offline message names the ACTIVE provider, never only the last fallback', async () => {
  const { aiRoutes } = await import('./routes/ai.ts');
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    if (u.includes('generativelanguage')) {
      // The 404 that used to be reported on its own, blaming Gemini.
      return new Response('{"error":{"code":404,"message":"models/gemini-3.8-flash is not found"}}', { status: 404 });
    }
    return new Response('{"error":{"message":"nvidia is rate limited"}}', { status: 429 });
  }) as any;
  try {
    const env = aiEnv({ keys: { nvidia: 'nvapi-test', gemini: 'gemini-test' } });
    const out: any = await aiRoutes.chat(new Request('https://x/ai/chat', { method: 'POST', body: JSON.stringify({ message: 'hi' }) }), env);
    assert.equal(out.provider, 'offline');
    assert.equal(out.activeProvider, 'nvidia');
    assert.match(out.response, /nvidia/i, 'the active provider is named first');
    assert.match(out.response, /rate limited/i, 'its real error is reported');
    // The fallback error is still available (diagnostics), but second.
    assert.ok(out.attempts.some((a: any) => a.provider === 'gemini' && !a.ok));
  } finally { globalThis.fetch = original; }
});

// ---------------------------------------------------------------------------
// LIVE MODEL DISCOVERY
//
// Production: NVIDIA retired EVERY id in our hardcoded chain
// (`nvidia/nemotron-3-nano-30b-a3b` — "reached its end of life on
// 2026-09-01"). The assistant died with a 410 even though the provider, key and
// network were healthy. A hardcoded list will always rot, so the provider's own
// /models endpoint is consulted when a configured/chain id is gone.
// ---------------------------------------------------------------------------

test('rankModels: prefers the same family, then chat/instruct, never a retired id', async () => {
  const { rankModels } = await import('./routes/ai.ts');
  const live = [
    'nvidia/nemotron-3-super-120b-a12b',
    'nvidia/nemotron-3-nano-30b-a3b',
    'nvidia/llama-3.3-nemotron-super-49b-v1',
    'meta/llama-3.1-8b-instruct', // retired
    'nvidia/embed-qa-4',          // not a chat model
  ].filter((x) => !x.includes('embed')); // (isChatModel is applied upstream)
  const ranked = rankModels(live, 'nvidia/nemotron-3.5-lightning-30b-a3b', 'nvidia');
  assert.equal(ranked[0], 'nvidia/nemotron-3-super-120b-a12b', 'the family + biggest wins');
  assert.ok(!ranked.includes('meta/llama-3.1-8b-instruct'), 'retired ids are never proposed');
  // Deterministic: same input, same order.
  assert.deepEqual(rankModels(live, 'nvidia/nemotron-3.5-lightning-30b-a3b', 'nvidia'), ranked);
});

test('a retired chain is replaced by a model the provider actually serves', async () => {
  const { aiRoutes } = await import('./routes/ai.ts');
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    calls.push(u);
    // The provider's live list.
    if (u.endsWith('/models')) {
      return jsonResponse({ data: [
        { id: 'nvidia/nemotron-3-nano-30b-a3b' },   // retired (below)
        { id: 'nvidia/nemotron-4-super-250b' },     // actually served
        { id: 'nvidia/embed-qa-4' },
      ] });
    }
    const body = JSON.parse(String(init?.body || '{}'));
    // Every hardcoded id is gone…
    if (['nvidia/nemotron-3.5-lightning-30b-a3b', 'nvidia/nemotron-3-super-120b-a12b', 'nvidia/nemotron-3-nano-30b-a3b'].includes(body.model)) {
      return new Response(JSON.stringify({ title: 'Gone', status: 410, detail: `The model \`${body.model}\` has reached its end of life` }), { status: 410 });
    }
    // …but the live one answers.
    return jsonResponse({ choices: [{ message: { content: 'live model answered' } }] });
  }) as any;
  try {
    const env = aiEnv({ keys: { nvidia: 'nvapi-test' } });
    const out: any = await aiRoutes.chat(new Request('https://x/ai/chat', { method: 'POST', body: JSON.stringify({ message: 'hi' }) }), env);
    assert.equal(out.provider, 'nvidia', `the active provider must answer (got ${JSON.stringify(out).slice(0, 300)})`);
    assert.equal(out.model, 'nvidia/nemotron-4-super-250b', 'served by a model the provider really offers');
    assert.match(out.response, /live model answered/);
    assert.ok(calls.some((u) => u.endsWith('/models')), 'the live list was consulted');
  } finally { globalThis.fetch = original; }
});

test('when even discovery fails, the error explains that every model is retired', async () => {
  const { aiRoutes } = await import('./routes/ai.ts');
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    if (u.endsWith('/models')) return new Response('nope', { status: 503 });
    return new Response(JSON.stringify({ title: 'Gone', status: 410, detail: 'The model has reached its end of life' }), { status: 410 });
  }) as any;
  try {
    const env = aiEnv({ keys: { nvidia: 'nvapi-test' } });
    const out: any = await aiRoutes.chat(new Request('https://x/ai/chat', { method: 'POST', body: JSON.stringify({ message: 'hi' }) }), env);
    assert.equal(out.provider, 'offline');
    assert.match(out.response, /nvidia/i);
    assert.match(out.response, /retired|end of life/i);
  } finally { globalThis.fetch = original; }
});

test('/ai/providers exposes live models and whether the saved id still exists', async () => {
  const { aiRoutes } = await import('./routes/ai.ts');
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    if (String(url).endsWith('/models')) {
      return jsonResponse({ data: [{ id: 'nvidia/nemotron-4-super-250b' }, { id: 'nvidia/embed-qa-4' }] });
    }
    return jsonResponse({ data: [] });
  }) as any;
  try {
    const env = aiEnv({ keys: { nvidia: 'nvapi-test' } });
    const out: any = await aiRoutes.providers(new Request('https://x/ai/providers'), env);
    const nv = out.providers.find((p: any) => p.id === 'nvidia');
    assert.ok(nv.models.includes('nvidia/nemotron-4-super-250b'), 'the live list reaches the admin UI');
    assert.ok(!nv.models.some((m: string) => /embed/.test(m)), 'non-chat models are filtered out');
    assert.equal(nv.modelAvailable, false, 'the saved (retired) id is flagged so the UI can warn');
  } finally { globalThis.fetch = original; }
});
