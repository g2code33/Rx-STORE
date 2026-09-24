/**
 * Paystack provider client (Phase 18).
 *
 * RX Store's intended production payment provider (Paystack — the secrets in
 * backend/wrangler.toml: PAYSTACK_SECRET_KEY). The provider hosts all
 * sensitive payment information (cards, mobile money authorization); RX Store
 * NEVER sees or stores card credentials. We only:
 *   - initialize transactions (returns a hosted authorization URL)
 *   - verify transactions server-side (amount + currency + status)
 *   - request refunds
 *   - verify signed webhooks (x-paystack-signature = HMAC-SHA512 of raw body)
 */

const API = 'https://api.paystack.co';

export interface InitializeResult {
  ok: boolean;
  authorizationUrl?: string;
  reference?: string;
  error?: string;
}

export async function initializeTransaction(env: any, input: {
  email: string; amountMinor: number; currency: string; reference: string; callbackUrl: string;
}): Promise<InitializeResult> {
  try {
    const res = await fetch(`${API}/transaction/initialize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: input.email, amount: input.amountMinor, currency: input.currency,
        reference: input.reference, callback_url: input.callbackUrl,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const j: any = await res.json().catch(() => null);
    if (!res.ok || !j?.status) return { ok: false, error: j?.message || `Paystack responded ${res.status}` };
    return { ok: true, authorizationUrl: j.data?.authorization_url, reference: j.data?.reference || input.reference };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Paystack request failed' };
  }
}

export interface VerifyResult {
  ok: boolean;
  status?: string;             // provider transaction status ('success' | 'failed' | ...)
  amountMinor?: number;
  currency?: string;
  transactionId?: string;
  error?: string;
}

export async function verifyTransaction(env: any, reference: string): Promise<VerifyResult> {
  try {
    const res = await fetch(`${API}/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` },
      signal: AbortSignal.timeout(15000),
    });
    const j: any = await res.json().catch(() => null);
    if (!res.ok || !j?.status) return { ok: false, error: j?.message || `Paystack responded ${res.status}` };
    return {
      ok: true,
      status: String(j.data?.status || ''),
      amountMinor: Number(j.data?.amount) || 0,
      currency: String(j.data?.currency || ''),
      transactionId: j.data?.id != null ? String(j.data?.id) : undefined,
    };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Paystack request failed' };
  }
}

export interface RefundResult {
  ok: boolean;
  refundId?: string;
  status?: string;
  error?: string;
}

export async function createRefund(env: any, transactionReference: string): Promise<RefundResult> {
  try {
    const res = await fetch(`${API}/refund`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ transaction_reference: transactionReference }),
      signal: AbortSignal.timeout(15000),
    });
    const j: any = await res.json().catch(() => null);
    if (!res.ok || !j?.status) return { ok: false, error: j?.message || `Paystack responded ${res.status}` };
    return { ok: true, refundId: j.data?.id != null ? String(j.data.id) : undefined, status: j.data?.status };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Paystack request failed' };
  }
}

/**
 * Verify a Paystack webhook signature: x-paystack-signature is HMAC-SHA512 of
 * the RAW request body using the secret key. Always compare with a
 * timing-safe comparison.
 */
export async function verifyWebhookSignature(rawBody: string, signature: string | null, secretKey: string): Promise<boolean> {
  if (!signature || !secretKey) return false;
  const enc = new TextEncoder();
  const key = await (crypto as any).subtle.importKey('raw', enc.encode(secretKey), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const mac = await (crypto as any).subtle.sign('HMAC', key, enc.encode(rawBody));
  const expected = Array.from(new Uint8Array(mac)).map((b: number) => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqualStr(expected, String(signature).toLowerCase());
}

/** Timing-safe string comparison (avoids early-exit signature oracles). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
