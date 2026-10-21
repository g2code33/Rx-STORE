-- 0025 — Refresh the AI model ids (upstream retirements).
--
-- NVIDIA returned 410 "Gone" for meta/llama-3.1-8b-instruct (end of life
-- 2026-08-26); OpenAI retired gpt-4o-mini and Google retired gemini-1.5-flash.
-- A retired id in ai_settings made every AI request fail with the provider
-- error shown in Admin → AI Providers. This migration moves the stored value
-- to the provider's current default; the Worker ALSO auto-replaces retired ids
-- at request time (routes/ai.ts RETIRED_MODELS + fallback chain), so this is a
-- data tidy-up rather than the only line of defence.
--
-- Re-running is harmless (idempotent by construction).

UPDATE ai_settings
   SET model = 'nvidia/nemotron-3-super-120b-a12b', updated_at = datetime('now')
 WHERE id = 'default'
   AND model IN ('meta/llama-3.1-8b-instruct', 'meta/llama-3.1-70b-instruct', 'meta/llama-3.1-405b-instruct');

UPDATE ai_settings
   SET model = 'meta-llama/llama-3.3-70b-instruct', updated_at = datetime('now')
 WHERE model IN ('meta-llama/llama-3.1-8b-instruct', 'meta-llama/llama-3.1-70b-instruct');

UPDATE ai_settings
   SET model = 'gpt-4.1-mini', updated_at = datetime('now')
 WHERE model IN ('gpt-4o-mini', 'gpt-4o');

UPDATE ai_settings
   SET model = 'gemini-2.5-flash', updated_at = datetime('now')
 WHERE model IN ('gemini-1.5-flash', 'gemini-1.5-pro');
