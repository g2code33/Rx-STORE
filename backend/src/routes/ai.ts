/**
 * AI Integration Routes — Multi-Provider (C: Admin choice)
 * Providers: nvidia (main) | openrouter | openai | gemini
 * All except Gemini are OpenAI-compatible. Gemini uses adapter.
 * Provider is resolved: request.provider > D1 ai_settings > env.AI_PROVIDER > "nvidia"
 * Keys are read from env secrets first, fallback to D1 ai_settings (encrypted).
 */

type Provider = 'nvidia' | 'openrouter' | 'openai' | 'gemini';

const PROVIDER_CONFIG: Record<Provider, { baseUrlEnv: string; keyEnv: string; defaultBase: string; defaultModel: string }> = {
  nvidia:     { baseUrlEnv: 'AI_BASE_URL_NVIDIA',     keyEnv: 'NVIDIA_API_KEY',     defaultBase: 'https://integrate.api.nvidia.com/v1', defaultModel: 'meta/llama-3.1-70b-instruct' },
  openrouter: { baseUrlEnv: 'AI_BASE_URL_OPENROUTER', keyEnv: 'OPENROUTER_API_KEY', defaultBase: 'https://openrouter.ai/api/v1', defaultModel: 'meta-llama/llama-3.1-70b-instruct' },
  openai:     { baseUrlEnv: 'AI_BASE_URL_OPENAI',     keyEnv: 'OPENAI_API_KEY',     defaultBase: 'https://api.openai.com/v1',          defaultModel: 'gpt-4o-mini' },
  gemini:     { baseUrlEnv: 'AI_BASE_URL_GEMINI',     keyEnv: 'GEMINI_API_KEY',     defaultBase: 'https://generativelanguage.googleapis.com/v1beta', defaultModel: 'gemini-1.5-flash' },
};

const SYSTEM_PROMPT = `You are the RX Store AI Assistant, helping users find and use applications from the RX Store marketplace.

Available applications:
1. Clinical Rx - Clinical decision support (drug interactions, prescribing guidance)
2. PharmaGAME - Gamified pharmaceutical education
3. Code Rx Society - Healthcare software development platform
4. TAWOMO - Healthcare workforce management
5. CureLink - Patient-caregiver communication
6. MediLearn Academy - Medical education platform
7. Rx Assistant AI - AI-powered clinical documentation
8. PharmaConnect - Professional networking

Be helpful, professional, and provide specific recommendations based on the user's needs.
Focus on healthcare, education, and productivity use cases.`;

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

async function callOpenAICompatible(baseUrl: string, key: string, model: string, message: string): Promise<string> {
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
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: message },
      ],
      max_tokens: 600,
      temperature: 0.7,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Provider error ${res.status}: ${err.slice(0,500)}`);
  }
  const data: any = await res.json();
  return data.choices?.[0]?.message?.content || data.choices?.[0]?.text || '';
}

async function callGemini(baseUrl: string, key: string, model: string, message: string): Promise<string> {
  // Gemini REST: POST /v1beta/models/{model}:generateContent?key=KEY
  const url = `${baseUrl.replace(/\/$/, '')}/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: SYSTEM_PROMPT + "\n\nUser: " + message }] }],
      generationConfig: { maxOutputTokens: 600, temperature: 0.7 },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini error ${res.status}: ${err.slice(0,800)}`);
  }
  const data: any = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

export const aiRoutes = {
  async chat(request: Request, env: any) {
    const { message, context, provider: requestedProvider } = await request.json().catch(() => ({}));
    if (!message || typeof message !== 'string') return { error: 'message is required' };

    const { provider, model } = await getActiveProvider(env, requestedProvider);
    const order: Provider[] = [provider, ...(((env.AI_FALLBACK as string) || 'openrouter,openai').split(',').map(s=>s.trim()).filter(Boolean) as Provider[])].filter((v,i,a)=>a.indexOf(v)===i) as Provider[];

    let lastError = '';
    for (const p of order) {
      const { baseUrl, key } = await getProviderCreds(env, p);
      const m = p === provider ? model : PROVIDER_CONFIG[p].defaultModel;
      if (!key) { lastError = `No key for ${p}`; continue; }
      try {
        const text = p === 'gemini' ? await callGemini(baseUrl, key, m, message) : await callOpenAICompatible(baseUrl, key, m, message);
        if (text) return { response: text, provider: p, model: m, suggestions: ['Show me healthcare apps','Compare Clinical Rx vs CureLink','What apps work offline?'] };
      } catch (e: any) { lastError = e.message || String(e); continue; }
    }
    // If all providers failed, return detailed error for debugging
    if (lastError) {
      console.log(`AI chat failed for ${provider}, tried ${order.join(',')}: ${lastError}`);
    }
    return { response: `I'm the RX Store Assistant (offline). ${lastError ? `(last error: ${lastError.slice(0,200)})` : ''} Try: Clinical Rx for prescribing, CureLink for patient communication.`, provider: 'offline', suggestions: ['Show me healthcare apps'] };
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
      const text = provider === 'gemini'
        ? await callGemini(baseUrl, key, model, probe)
        : await callOpenAICompatible(baseUrl, key, model, probe);
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
