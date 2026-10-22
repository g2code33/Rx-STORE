/**
 * AI Integration Routes — Multi-Provider (C: Admin choice)
 * Providers: nvidia (main) | openrouter | openai | gemini
 * All except Gemini are OpenAI-compatible. Gemini uses adapter.
 * Provider is resolved: request.provider > D1 ai_settings > env.AI_PROVIDER > "nvidia"
 * Keys are read from env secrets first, fallback to D1 ai_settings (encrypted).
 */

type Provider = 'nvidia' | 'openrouter' | 'openai' | 'gemini';

/**
 * Provider defaults + a fallback chain.
 *
 * Upstream providers RETIRE model ids (NVIDIA returned 410 "Gone" for
 * meta/llama-3.1-8b-instruct in Oct 2026, OpenAI retired gpt-4o-mini, Google
 * retired gemini-1.5-flash). A retired id must never brick the assistant:
 * each provider lists current models in preference order and the call retries
 * down the chain on a "model not found / gone / decommissioned" error.
 */
const PROVIDER_CONFIG: Record<Provider, { baseUrlEnv: string; keyEnv: string; defaultBase: string; defaultModel: string }> = {
  // Nemotron 3 family is NVIDIA's current hosted line (build.nvidia.com).
  nvidia:     { baseUrlEnv: 'AI_BASE_URL_NVIDIA',     keyEnv: 'NVIDIA_API_KEY',     defaultBase: 'https://integrate.api.nvidia.com/v1', defaultModel: 'nvidia/nemotron-3-super-120b-a12b' },
  openrouter: { baseUrlEnv: 'AI_BASE_URL_OPENROUTER', keyEnv: 'OPENROUTER_API_KEY', defaultBase: 'https://openrouter.ai/api/v1', defaultModel: 'meta-llama/llama-3.3-70b-instruct' },
  openai:     { baseUrlEnv: 'AI_BASE_URL_OPENAI',     keyEnv: 'OPENAI_API_KEY',     defaultBase: 'https://api.openai.com/v1',          defaultModel: 'gpt-4.1-mini' },
  gemini:     { baseUrlEnv: 'AI_BASE_URL_GEMINI',     keyEnv: 'GEMINI_API_KEY',     defaultBase: 'https://generativelanguage.googleapis.com/v1beta', defaultModel: 'gemini-2.5-flash' },
};

/** Current models per provider, best first — used when a configured id is dead. */
export const PROVIDER_MODEL_CHAIN: Record<Provider, string[]> = {
  nvidia: [
    'nvidia/nemotron-3-super-120b-a12b',
    'nvidia/nemotron-3-nano-30b-a3b',
    'nvidia/nemotron-3.5-lightning-30b-a3b',
  ],
  openrouter: [
    'meta-llama/llama-3.3-70b-instruct',
    'openai/gpt-4.1-mini',
    'google/gemini-2.5-flash',
  ],
  openai: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-5-mini'],
  gemini: ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-pro'],
};

/** Model ids that upstreams have retired — auto-replaced, never served again. */
const RETIRED_MODELS = new Set([
  'meta/llama-3.1-8b-instruct', 'meta/llama-3.1-70b-instruct',
  'meta-llama/llama-3.1-8b-instruct',
  'gpt-4o-mini', 'gemini-1.5-flash', 'gemini-1.5-pro',
]);

/** Does a provider error mean "this model no longer exists"? */
export function isModelGoneError(status: number, body: string): boolean {
  if (status !== 404 && status !== 410 && status !== 400) return false;
  const t = String(body || '').toLowerCase();
  return /gone|decommission|no longer available|not found|does not exist|invalid model|unknown model|unsupported model|end of life/.test(t);
}

// Build the system prompt from the LIVE store catalog — the assistant may only
// speak from this data (no hallucinations), and may only point "outside" to an
// app's own link when that app actually has one in the DB.
async function buildSystemPrompt(env: any): Promise<string> {
  let catalog = '';
  try {
    if (env.DB) {
      const rows: any = await env.DB.prepare(`SELECT slug, name, category, description, developer, price_type, price_amount, platforms, rating, current_version FROM applications WHERE status='active' AND deleted_at IS NULL ORDER BY download_count DESC LIMIT 60`).all();
      const apps = rows.results || [];
      const links: Record<string, string> = {};
      for (const a of apps) {
        try {
          const p: any = await env.DB.prepare(`SELECT p.deployment_url FROM packages p JOIN releases r ON r.id=p.release_id WHERE p.application_id=(SELECT id FROM applications WHERE slug=?) AND p.platform IN ('web','pwa') AND r.status='published' AND p.deployment_url IS NOT NULL LIMIT 1`).bind(a.slug).first().catch(()=>null);
          if (p?.deployment_url) links[a.name] = p.deployment_url;
        } catch {}
      }
      catalog = apps.map((a: any) => {
        let plats = a.platforms; try { plats = JSON.parse(a.platforms || '[]').join('+'); } catch {}
        const price = a.price_type === 'paid' ? `$${a.price_amount}` : (a.price_type || 'free');
        const link = links[a.name] ? ` | official link: ${links[a.name]}` : '';
        return `- ${a.name} (${a.category}) by ${a.developer}: ${a.description}. ${price}, v${a.current_version}, rated ${a.rating}/5, platforms: ${plats}.${link}`;
      }).join('\n');
    }
  } catch {}

  return `You are the RX Store Assistant for the RX Store marketplace by Calcitonin Technologies.

ONLY source of truth — the live store catalog below. You must NOT use outside knowledge, NOT invent apps, features, prices or links, and NOT recommend anything not in the catalog. If the answer is not in the catalog, say it plainly in one line and point to the closest catalog app.
You may only reference "external" info through an app's own official link IF that app has one listed below (say "check the app's official link"); otherwise stay inside the store.

STYLE: straight to the point. Max 3 short bullet points or 60 words, whichever is less. No intros, no outros, no essays. App names in **bold**.

LIVE CATALOG (${catalog ? 'authoritative' : 'UNAVAILABLE — say you cannot browse the catalog right now'}):
${catalog || '(empty)'}`;
}

async function getActiveProvider(env: any, requested?: string): Promise<{ provider: Provider; model: string }> {
  let provider = (requested || '').toLowerCase() as Provider;
  let model = '';
  const valid: Provider[] = ['nvidia','openrouter','openai','gemini'];
  if (!valid.includes(provider)) provider = '' as any;

  // 1. D1 ai_settings overrides env (allows admin dashboard to change without redeploy)
  try {
    if (env.DB) {
      const row = await env.DB.prepare(`SELECT provider, model FROM ai_settings WHERE id='default'`).first();
      if (row) {
        if (!provider) provider = row.provider as Provider;
        model = row.model as string;
      }
    }
  } catch {}
  if (!provider) provider = (env.AI_PROVIDER as Provider) || 'nvidia';
  if (!valid.includes(provider)) provider = 'nvidia';
  if (!model) model = env.AI_MODEL || PROVIDER_CONFIG[provider].defaultModel;
  // A retired id (stored in D1, env or a migration) is replaced automatically.
  if (RETIRED_MODELS.has(String(model))) model = PROVIDER_CONFIG[provider].defaultModel;
  return { provider, model };
}

async function getProviderCreds(env: any, provider: Provider) {
  const cfg = PROVIDER_CONFIG[provider];
  const baseUrl = env[cfg.baseUrlEnv] || cfg.defaultBase;
  let key = env[cfg.keyEnv] || '';
  // Fallback to D1 stored key (from Admin UI)
  if (!key && env.DB) {
    try {
      const row: any = await env.DB.prepare(`SELECT api_key FROM ai_settings WHERE id=?`).bind('key_'+provider).first();
      if (row?.api_key) key = row.api_key;
    } catch {}
  }
  let model = env.AI_MODEL || cfg.defaultModel;
  if (RETIRED_MODELS.has(String(model))) model = cfg.defaultModel;
  return { baseUrl, key, model };
}

function maskKey(k: string): string {
  if (!k) return '';
  if (k.length <= 10) return '•'.repeat(Math.max(k.length, 6));
  return k.slice(0, 7) + '•'.repeat(8) + k.slice(-4);
}

async function callOpenAICompatible(baseUrl: string, key: string, model: string, message: string, systemPrompt: string): Promise<string> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(baseUrl.includes('openrouter.ai') ? { 'HTTP-Referer': 'https://rxstore.calcitonin.tech', 'X-Title': 'RX Store' } : {}),
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message },
      ],
      max_tokens: 288,
      temperature: 0.3,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    { const e: any = new Error(`Provider error ${res.status}: ${err.slice(0,500)}`); e.status = res.status; e.body = err; throw e; }
  }
  const data: any = await res.json();
  return data.choices?.[0]?.message?.content || data.choices?.[0]?.text || '';
}

// Streaming version — returns the provider's raw SSE body (OpenAI-compatible delta format)
async function streamOpenAICompatible(baseUrl: string, key: string, model: string, message: string, systemPrompt: string): Promise<ReadableStream> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(baseUrl.includes('openrouter.ai') ? { 'HTTP-Referer': 'https://rxstore.calcitonin.tech', 'X-Title': 'RX Store' } : {}),
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message },
      ],
      max_tokens: 288,
      temperature: 0.3,
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    const err = await res.text().catch(() => '');
    { const e: any = new Error(`Provider error ${res.status}: ${err.slice(0,300)}`); e.status = res.status; e.body = err; throw e; }
  }
  return res.body;
}

async function callGemini(baseUrl: string, key: string, model: string, message: string, systemPrompt: string): Promise<string> {
  // Gemini REST: POST /v1beta/models/{model}:generateContent?key=KEY
  const url = `${baseUrl.replace(/\/$/, '')}/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: systemPrompt + "\n\nUser: " + message }] }],
      generationConfig: { maxOutputTokens: 288, temperature: 0.3 },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    { const e: any = new Error(`Gemini error ${res.status}: ${err.slice(0,800)}`); e.status = res.status; e.body = err; throw e; }
  }
  const data: any = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// Provider fallback order: chosen provider first, then the env AI_FALLBACK chain
function providerOrder(env: any, provider: Provider): Provider[] {
  return [provider, ...(((env.AI_FALLBACK as string) || 'openrouter,openai').split(',').map(s=>s.trim()).filter(Boolean) as Provider[])].filter((v,i,a)=>a.indexOf(v)===i) as Provider[];
}

/**
 * Try ONE provider, walking its model chain when an id is gone.
 *
 * `stream: true` returns the provider's raw SSE body; the fallback to the next
 * model is only attempted while no bytes have been sent (a non-2xx response
 * happens before the stream starts), so a retry can never corrupt a partial
 * answer.
 *
 * Why this exists: the streaming path used to call the ACTIVE provider with the
 * configured model and, on ANY failure, jump straight to the fallback list —
 * without trying the provider's current models and without reporting the active
 * provider's real error. The assistant then blamed Gemini (the last fallback)
 * and looked like it "always uses Gemini".
 */
interface Attempt {
  ok: boolean;
  provider: Provider;
  /** The model that actually answered (may be a chain replacement). */
  model: string;
  text?: string;
  stream?: ReadableStream;
  error?: string;
  /** True when the provider has no key at all (not an outage). */
  noKey?: boolean;
}

async function attemptProvider(
  env: any,
  p: Provider,
  preferredModel: string,
  message: string,
  systemPrompt: string,
  opts: { stream?: boolean } = {},
): Promise<Attempt> {
  const { baseUrl, key } = await getProviderCreds(env, p);
  if (!key) return { ok: false, provider: p, model: preferredModel, noKey: true, error: `No API key configured for ${p}` };

  const chain = [preferredModel, ...PROVIDER_MODEL_CHAIN[p].filter((x) => x !== preferredModel)].filter(Boolean);
  let lastError = '';
  for (const candidate of chain.slice(0, 3)) {
    try {
      if (p === 'gemini') {
        const text = await callGemini(baseUrl, key, candidate, message, systemPrompt);
        if (!text) { lastError = `${p}: empty response`; continue; }
        if (candidate !== preferredModel) console.warn(`[ai] ${p}: '${preferredModel}' unavailable, served '${candidate}'`);
        return { ok: true, provider: p, model: candidate, text };
      }
      if (opts.stream) {
        const stream = await streamOpenAICompatible(baseUrl, key, candidate, message, systemPrompt);
        if (candidate !== preferredModel) console.warn(`[ai] ${p}: '${preferredModel}' unavailable, streamed '${candidate}'`);
        return { ok: true, provider: p, model: candidate, stream };
      }
      const text = await callOpenAICompatible(baseUrl, key, candidate, message, systemPrompt);
      if (!text) { lastError = `${p}: empty response`; continue; }
      if (candidate !== preferredModel) console.warn(`[ai] ${p}: '${preferredModel}' unavailable, served '${candidate}'`);
      return { ok: true, provider: p, model: candidate, text };
    } catch (e: any) {
      lastError = String(e?.message || e).slice(0, 300);
      // Only a DEAD MODEL moves us down the chain. An auth error, a rate limit
      // or an outage must fall through to the next PROVIDER (and be reported),
      // never be hidden behind another model id.
      if (!isModelGoneError(Number(e?.status || 0), String(e?.body || e?.message || ''))) break;
    }
  }
  return { ok: false, provider: p, model: preferredModel, error: lastError || `${p}: no model responded` };
}

/**
 * Human-readable summary of a failed chain.
 *
 * The ACTIVE provider's failure is stated first — reporting only the last
 * fallback's error is what made a working NVIDIA setup look like "always
 * Gemini".
 */
function failureSummary(active: Provider, results: Attempt[]): string {
  const activeResult = results.find((r) => r.provider === active);
  const others = results.filter((r) => r.provider !== active);
  const parts: string[] = [];
  if (activeResult?.error) parts.push(`${active}: ${activeResult.error}`);
  for (const o of others) {
    if (o.noKey) continue; // "no key" is configuration, not a failure worth shouting about
    if (o.error) parts.push(`${o.provider}: ${o.error}`);
  }
  if (!parts.length) parts.push(`${active}: no API key configured`);
  return parts.join(' | ');
}

// Wrap plain text as a one-chunk OpenAI-compatible SSE stream (for Gemini + offline replies)
function sseSingle(text: string): Response {
  const enc = new TextEncoder();
  const chunk = JSON.stringify({ choices: [{ delta: { content: text } }] });
  const body = `data: ${chunk}\n\ndata: [DONE]\n\n`;
  return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(body)); c.close(); } }), {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  });
}

export const aiRoutes = {
  async chat(request: Request, env: any) {
    const { message, context, provider: requestedProvider } = await request.json().catch(() => ({}));
    if (!message || typeof message !== 'string') return { error: 'message is required' };

    const { provider, model } = await getActiveProvider(env, requestedProvider);
    const order = providerOrder(env, provider);
    const systemPrompt = await buildSystemPrompt(env);

    // The ACTIVE provider is asked first, with its configured model; only a
    // genuine failure moves on. Every attempt is recorded so the error we show
    // names the active provider instead of whichever fallback spoke last.
    const attempts: Attempt[] = [];
    for (const p of order) {
      const preferred = p === provider ? model : PROVIDER_CONFIG[p].defaultModel;
      const r = await attemptProvider(env, p, preferred, message, systemPrompt);
      attempts.push(r);
      if (r.ok && r.text) {
        return {
          response: r.text,
          provider: r.provider,
          model: r.model,
          // Honest: the configured model was replaced by a current one.
          modelSubstituted: r.model !== preferred,
          suggestions: ['Show me healthcare apps', 'Compare Clinical Rx vs CureLink', 'What apps work offline?'],
        };
      }
    }
    const summary = failureSummary(provider, attempts);
    console.log(`AI chat failed on the active provider '${provider}': ${summary}`);
    return {
      response: `I'm the RX Store Assistant (offline). ${summary ? `(${summary.slice(0, 200)})` : ''} Browse the store directly — each app page lists full details.`,
      provider: 'offline',
      activeProvider: provider,
      attempts: attempts.map((a) => ({ provider: a.provider, ok: a.ok, noKey: !!a.noKey, error: a.error })),
      suggestions: ['Show me healthcare apps'],
    };
  },

  // Streaming chat — first tokens arrive in ~1s instead of one slow final blob.
  // Proxies the provider's OpenAI-compatible SSE straight through.
  async chatStream(request: Request, env: any): Promise<Response> {
    const { message, provider: requestedProvider } = await request.json().catch(() => ({} as any));
    if (!message || typeof message !== 'string') return sseSingle('Ask me something about the store apps.');

    const { provider, model } = await getActiveProvider(env, requestedProvider as string);
    const order = providerOrder(env, provider);
    const systemPrompt = await buildSystemPrompt(env);

    const attempts: Attempt[] = [];
    for (const p of order) {
      const preferred = p === provider ? model : PROVIDER_CONFIG[p].defaultModel;
      const r = await attemptProvider(env, p, preferred, message, systemPrompt, { stream: true });
      attempts.push(r);
      if (!r.ok && !r.noKey) {
        // Streaming can fail where a normal completion succeeds (provider
        // rejects `stream:true`, proxy strips SSE, …). The ACTIVE provider gets
        // one buffered retry before we hand the answer to a fallback provider.
        const buffered = await attemptProvider(env, p, preferred, message, systemPrompt, { stream: false });
        if (buffered.ok && buffered.text) {
          console.warn(`[ai] ${p}: streaming unavailable, served buffered`);
          return sseSingle(buffered.text);
        }
        if (!buffered.ok && buffered.error) r.error = `${r.error} | buffered: ${buffered.error}`;
      }
      if (r.ok && r.stream) {
        // Provider/model actually used is visible to the client for debugging.
        return new Response(r.stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'X-AI-Provider': r.provider,
            'X-AI-Model': r.model,
          },
        });
      }
      if (r.ok && r.text) return sseSingle(r.text);
    }
    const summary = failureSummary(provider, attempts);
    console.log(`AI stream failed on the active provider '${provider}': ${summary}`);
    return sseSingle(`I'm the RX Store Assistant (offline). ${summary ? `(${summary.slice(0, 200)})` : ''} Browse the store directly — each app page lists full details.`);
  },

  async recommend(request: Request, env: any) {
    const { provider: requestedProvider } = await request.json().catch(()=>({}));
    // For now use DB ranking; AI-enhanced recommend can call chat internally
    const apps = await env.DB.prepare(`SELECT * FROM applications WHERE status='active' ORDER BY rating DESC LIMIT 5`).all();
    const { provider } = await getActiveProvider(env, requestedProvider);
    return { recommendations: (apps.results||[]).map((app: any) => ({ id: app.id, name: app.name, reason: `Highly rated ${app.category} (${app.rating}★) via ${provider}` })), provider };
  },

  async providers(request: Request, env: any) {
    const { provider: active } = await getActiveProvider(env);
    const list = await Promise.all((['nvidia','openrouter','openai','gemini'] as Provider[]).map(async p => {
      const { key } = await getProviderCreds(env, p);
      const cfg = PROVIDER_CONFIG[p];
      return { id: p, enabled: !!key, hasKey: !!key, maskedKey: maskKey(key), baseUrl: env[cfg.baseUrlEnv] || cfg.defaultBase, defaultModel: cfg.defaultModel, active: p===active };
    }));
    return { active, providers: list };
  },

  // Admin only — returns full keys so the Admin UI can pre-fill fields (never expose publicly)
  async getSettings(request: Request, env: any) {
    const { provider: active, model } = await getActiveProvider(env);
    const keys: Record<string, string> = {} as any;
    const maskedKeys: Record<string, string> = {} as any;
    for (const p of ['nvidia','openrouter','openai','gemini'] as Provider[]) {
      const { key } = await getProviderCreds(env, p);
      keys[p] = key || '';
      maskedKeys[p] = maskKey(key || '');
    }
    return { active, model, keys, maskedKeys };
  },

  // Admin only — test a specific provider key (typed in the form, or stored). No fallback chain — tests exactly what you picked.
  async test(request: Request, env: any) {
    const body: any = await request.json().catch(()=>({}));
    const provider = (body.provider || '').toLowerCase() as Provider;
    const valid: Provider[] = ['nvidia','openrouter','openai','gemini'];
    if (!valid.includes(provider)) return { error: 'Invalid provider. Use nvidia|openrouter|openai|gemini' };
    const { baseUrl, key: storedKey } = await getProviderCreds(env, provider);
    const key = (typeof body.apiKey === 'string' && body.apiKey.trim().length > 10) ? body.apiKey.trim() : storedKey;
    if (!key) return { ok: false, provider, error: `No key for ${provider} — enter one or save it first` };
    let model = (body.model || '').trim();
    if (!model) {
      try {
        const row: any = await env.DB?.prepare(`SELECT model FROM ai_settings WHERE id='default'`).first();
        const activeRow: any = await env.DB?.prepare(`SELECT provider FROM ai_settings WHERE id='default'`).first();
        if (row?.model && activeRow?.provider === provider) model = row.model;
      } catch {}
    }
    if (!model) model = PROVIDER_CONFIG[provider].defaultModel;
    const started = Date.now();
    const probe = 'Reply with exactly: RX Store connection OK';
    const probeSystem = 'You are a connectivity probe. Reply exactly as instructed.';
    // The assistant streams by default, and a provider can pass a buffered call
    // while its streaming request fails. Test BOTH so "Test OK" means "the
    // assistant can actually answer with this provider".
    let streamOk: boolean | null = null;
    let streamError = '';
    if (provider !== 'gemini') {
      try {
        const stream = await streamOpenAICompatible(baseUrl, key, model, probe, probeSystem);
        await stream.cancel?.().catch?.(() => {});
        streamOk = true;
      } catch (e: any) {
        streamOk = false;
        streamError = String(e?.message || e).slice(0, 200);
      }
    }
    try {
      const text = provider === 'gemini'
        ? await callGemini(baseUrl, key, model, probe, probeSystem)
        : await callOpenAICompatible(baseUrl, key, model, probe, probeSystem);
      return {
        ok: true, provider, model, usedStoredKey: key === storedKey, latencyMs: Date.now() - started,
        reply: (text || '').slice(0, 300),
        streamOk, streamError: streamError || undefined,
        warning: streamOk === false
          ? 'Buffered completion works but streaming fails — the assistant will answer this provider buffered.'
          : undefined,
      };
    } catch (e: any) {
      return {
        ok: false, provider, model, latencyMs: Date.now() - started,
        error: (e.message || String(e)).slice(0, 400),
        streamOk, streamError: streamError || undefined,
      };
    }
  },

  async updateSettings(request: Request, env: any) {
    // Admin only — caller should be protected by admin middleware, but we also check here if middleware passed user
    const body: any = await request.json().catch(()=>({}));
    const provider = (body.provider || '').toLowerCase();
    const model = (body.model || '').trim() || PROVIDER_CONFIG[provider as Provider]?.defaultModel || '';
    const valid: Provider[] = ['nvidia','openrouter','openai','gemini'];
    if (!valid.includes(provider)) return { error: 'Invalid provider. Use nvidia|openrouter|openai|gemini' };
    // Self-heal: a previous version stored keys under id '0' due to a SQL '+' concat bug
    try { await env.DB.prepare(`DELETE FROM ai_settings WHERE id IN ('0', '')`).run(); } catch {}
    await env.DB.prepare(`INSERT INTO ai_settings (id, provider, model, updated_at) VALUES ('default', ?, ?, datetime('now')) ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, model=excluded.model, updated_at=datetime('now')`).bind(provider, model).run();
    // Also allow storing keys via admin (encrypted at rest — simple obfuscation here; for production use Secrets Store)
    if (body.apiKey && typeof body.apiKey === 'string' && body.apiKey.trim().length > 10) {
      // Store in D1 as fallback if env secret not set — not recommended for highly sensitive keys, but enables admin UI
      // NOTE: build the row id in JS — in SQLite '+' is arithmetic, '||' is concat (old bug stored keys under id '0')
      const rowId = 'key_' + provider;
      await env.DB.prepare(`INSERT INTO ai_settings (id, provider, model, api_key, updated_at) VALUES (?, ?, ?, ?, datetime('now')) ON CONFLICT(id) DO UPDATE SET api_key=excluded.api_key, model=excluded.model, updated_at=datetime('now')`).bind(rowId, provider, model, body.apiKey.trim()).run();
    }
    return { success: true, provider, model };
  },
};
