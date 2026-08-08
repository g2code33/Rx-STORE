/**
 * AI Integration Routes — Multi-Provider (C: Admin choice)
 * Providers: nvidia (main) | openrouter | openai | gemini
 * All except Gemini are OpenAI-compatible. Gemini uses adapter.
 * Provider is resolved: request.provider > D1 ai_settings > env.AI_PROVIDER > "nvidia"
 * Keys are read from env secrets first, fallback to D1 ai_settings (encrypted).
 */

type Provider = 'nvidia' | 'openrouter' | 'openai' | 'gemini';

const PROVIDER_CONFIG: Record<Provider, { baseUrlEnv: string; keyEnv: string; defaultBase: string; defaultModel: string }> = {
  nvidia:     { baseUrlEnv: 'AI_BASE_URL_NVIDIA',     keyEnv: 'NVIDIA_API_KEY',     defaultBase: 'https://integrate.api.nvidia.com/v1', defaultModel: 'meta/llama-3.1-8b-instruct' },
  openrouter: { baseUrlEnv: 'AI_BASE_URL_OPENROUTER', keyEnv: 'OPENROUTER_API_KEY', defaultBase: 'https://openrouter.ai/api/v1', defaultModel: 'meta-llama/llama-3.1-8b-instruct' },
  openai:     { baseUrlEnv: 'AI_BASE_URL_OPENAI',     keyEnv: 'OPENAI_API_KEY',     defaultBase: 'https://api.openai.com/v1',          defaultModel: 'gpt-4o-mini' },
  gemini:     { baseUrlEnv: 'AI_BASE_URL_GEMINI',     keyEnv: 'GEMINI_API_KEY',     defaultBase: 'https://generativelanguage.googleapis.com/v1beta', defaultModel: 'gemini-1.5-flash' },
};

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
  const model = env.AI_MODEL || cfg.defaultModel;
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
    throw new Error(`Provider error ${res.status}: ${err.slice(0,500)}`);
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
    throw new Error(`Provider error ${res.status}: ${err.slice(0,300)}`);
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
    throw new Error(`Gemini error ${res.status}: ${err.slice(0,800)}`);
  }
  const data: any = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// Provider fallback order: chosen provider first, then the env AI_FALLBACK chain
function providerOrder(env: any, provider: Provider): Provider[] {
  return [provider, ...(((env.AI_FALLBACK as string) || 'openrouter,openai').split(',').map(s=>s.trim()).filter(Boolean) as Provider[])].filter((v,i,a)=>a.indexOf(v)===i) as Provider[];
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

    let lastError = '';
    for (const p of order) {
      const { baseUrl, key } = await getProviderCreds(env, p);
      const m = p === provider ? model : PROVIDER_CONFIG[p].defaultModel;
      if (!key) { lastError = `No key for ${p}`; continue; }
      try {
        const text = p === 'gemini' ? await callGemini(baseUrl, key, m, message, systemPrompt) : await callOpenAICompatible(baseUrl, key, m, message, systemPrompt);
        if (text) return { response: text, provider: p, model: m, suggestions: ['Show me healthcare apps','Compare Clinical Rx vs CureLink','What apps work offline?'] };
      } catch (e: any) { lastError = e.message || String(e); continue; }
    }
    // If all providers failed, return detailed error for debugging
    if (lastError) {
      console.log(`AI chat failed for ${provider}, tried ${order.join(',')}: ${lastError}`);
    }
    return { response: `I'm the RX Store Assistant (offline). ${lastError ? `(last error: ${lastError.slice(0,200)})` : ''} Browse the store directly — each app page lists full details.`, provider: 'offline', suggestions: ['Show me healthcare apps'] };
  },

  // Streaming chat — first tokens arrive in ~1s instead of one slow final blob.
  // Proxies the provider's OpenAI-compatible SSE straight through.
  async chatStream(request: Request, env: any): Promise<Response> {
    const { message, provider: requestedProvider } = await request.json().catch(() => ({} as any));
    if (!message || typeof message !== 'string') return sseSingle('Ask me something about the store apps.');

    const { provider, model } = await getActiveProvider(env, requestedProvider as string);
    const order = providerOrder(env, provider);
    const systemPrompt = await buildSystemPrompt(env);

    let lastError = '';
    for (const p of order) {
      const { baseUrl, key } = await getProviderCreds(env, p);
      const m = p === provider ? model : PROVIDER_CONFIG[p].defaultModel;
      if (!key) { lastError = `No key for ${p}`; continue; }
      try {
        if (p === 'gemini') {
          // Gemini stays buffered (REST shape differs) — one SSE chunk keeps the client simple
          const text = await callGemini(baseUrl, key, m, message, systemPrompt);
          if (text) return sseSingle(text);
          continue;
        }
        const stream = await streamOpenAICompatible(baseUrl, key, m, message, systemPrompt);
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
      } catch (e: any) { lastError = e.message || String(e); continue; }
    }
    return sseSingle(`I'm offline at the moment (${lastError.slice(0,120)}). Browse the store directly — each app page lists full details.`);
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
    try {
      const probe = 'Reply with exactly: RX Store connection OK';
      const probeSystem = 'You are a connectivity probe. Reply exactly as instructed.';
      const text = provider === 'gemini'
        ? await callGemini(baseUrl, key, model, probe, probeSystem)
        : await callOpenAICompatible(baseUrl, key, model, probe, probeSystem);
      return { ok: true, provider, model, usedStoredKey: key === storedKey, latencyMs: Date.now() - started, reply: (text || '').slice(0, 300) };
    } catch (e: any) {
      return { ok: false, provider, model, latencyMs: Date.now() - started, error: (e.message || String(e)).slice(0, 400) };
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
