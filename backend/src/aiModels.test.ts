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
