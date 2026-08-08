-- 0003: switch the default chat model to the fast 8B (70B was the main reason the
-- assistant felt "very very very long"). Admin can still set any model in the panel.
-- Run: npx wrangler d1 execute rx-store-db --remote --file=backend/migrations/0003_fast_ai_model.sql
UPDATE ai_settings SET model='meta/llama-3.1-8b-instruct' WHERE id='default' AND model LIKE '%llama-3.1-70b%';
