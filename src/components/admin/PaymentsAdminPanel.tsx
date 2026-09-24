/**
 * Admin → Payments (Phase 18).
 * Transactions, entitlements, refunds and revocations. No payment credentials
 * exist anywhere in this data (the provider hosts them) — nothing to redact,
 * and that is stated on the panel.
 */
import React, { useEffect, useState } from 'react';
import { RotateCcw, Ban, RefreshCw } from 'lucide-react';
import { api } from '../../services/api';
import { formatDate } from '../../utils/helpers';
import toast from 'react-hot-toast';

const STATUS_COLORS: Record<string, string> = {
  complete: 'bg-green-400/10 text-green-400', ACTIVE: 'bg-green-400/10 text-green-400',
  pending: 'bg-amber-500/10 text-amber-300', PENDING: 'bg-amber-500/10 text-amber-300',
  failed: 'bg-red-400/10 text-red-400', refunded: 'bg-purple-400/10 text-purple-300',
  REFUNDED: 'bg-purple-400/10 text-purple-300', REVOKED: 'bg-red-400/10 text-red-400',
  EXPIRED: 'bg-white/5 text-rx-gray-medium',
};

function Badge({ status }: { status: string }) {
  return <span className={`text-[10px] font-bold px-2 py-1 rounded whitespace-nowrap ${STATUS_COLORS[status] || 'bg-white/5 text-rx-gray-medium'}`}>{String(status).toLowerCase()}</span>;
}

export default function PaymentsAdminPanel() {
  const [transactions, setTransactions] = useState<any[]>([]);
  const [entitlements, setEntitlements] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [revokeReason, setRevokeReason] = useState<Record<string, string>>({});

  const load = () => {
    setLoading(true);
    Promise.all([
      api.adminPayments.transactions().catch(() => ({ transactions: [] })),
      api.adminPayments.entitlements().catch(() => ({ entitlements: [] })),
    ]).then(([t, e]: any[]) => {
      setTransactions(t.transactions || []);
      setEntitlements(e.entitlements || []);
    }).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const refund = async (purchaseId: string) => {
    if (!confirm('Refund this purchase? The user\'s paid access ends immediately.')) return;
    setBusy(true);
    try { await api.adminPayments.refund(purchaseId); toast.success('Refund processed'); load(); }
    catch (e: any) { toast.error(e?.message || 'Refund failed'); }
    setBusy(false);
  };

  const revoke = async (entitlementId: string) => {
    const reason = (revokeReason[entitlementId] || '').trim();
    if (reason.length < 10) { toast.error('A revocation reason of at least 10 characters is required'); return; }
    setBusy(true);
    try { await api.adminPayments.revoke(entitlementId, reason); toast.success('Entitlement revoked'); setRevokeReason((r) => ({ ...r, [entitlementId]: '' })); load(); }
    catch (e: any) { toast.error(e?.message || 'Revoke failed'); }
    setBusy(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-white">Payments</h2>
          <p className="text-sm text-rx-gray-medium mt-1">Transactions, entitlements and refunds. Card and mobile-money credentials are hosted entirely by the payment provider — none exist in RX Store data.</p>
        </div>
        <button onClick={load} className="btn-secondary text-sm flex items-center gap-2"><RefreshCw className="w-4 h-4" /> Refresh</button>
      </div>

      {loading ? (
        <div className="card p-8 animate-pulse space-y-3"><div className="h-5 bg-white/5 rounded w-1/3" /><div className="h-16 bg-white/5 rounded" /></div>
      ) : (
        <>
          {/* Transactions */}
          <div className="card">
            <div className="p-4 border-b border-white/5"><h3 className="text-sm font-bold text-white uppercase tracking-wider">Transactions ({transactions.length})</h3></div>
            <div className="divide-y divide-white/5">
              {transactions.length === 0 ? (
                <p className="p-6 text-center text-sm text-rx-gray-medium">No transactions yet.</p>
              ) : transactions.map((t) => (
                <div key={t.id} className="p-4 flex flex-wrap items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white truncate">{t.app_name || 'App'} — {t.user_name || t.user_email || 'user'}</p>
                    <p className="text-xs text-rx-gray-medium truncate">
                      {formatDate(t.created_at)} · GH₵{(Number(t.amount) / 100).toFixed(2)} {t.currency} · {t.provider}
                      {t.provider_reference ? ` · ref ${t.provider_reference}` : ''}
                      {t.failure_reason ? ` · ${t.failure_reason}` : ''}
                    </p>
                  </div>
                  <Badge status={t.status} />
                  {t.status === 'complete' && (
                    <button onClick={() => refund(t.id)} disabled={busy} className="btn-secondary text-xs px-3 py-1.5 flex items-center gap-1.5 disabled:opacity-40">
                      <RotateCcw className="w-3.5 h-3.5" /> Refund
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Entitlements */}
          <div className="card">
            <div className="p-4 border-b border-white/5"><h3 className="text-sm font-bold text-white uppercase tracking-wider">Entitlements ({entitlements.length})</h3></div>
            <div className="divide-y divide-white/5">
              {entitlements.length === 0 ? (
                <p className="p-6 text-center text-sm text-rx-gray-medium">No entitlements yet.</p>
              ) : entitlements.map((e) => (
                <div key={e.id} className="p-4 space-y-2">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-white truncate">{e.app_name || 'App'} — {e.user_name || e.user_email || 'user'}</p>
                      <p className="text-xs text-rx-gray-medium truncate">
                        activated {formatDate(e.activated_at || e.created_at)} · {e.provider}
                        {e.revoked_reason ? ` · revoked: ${e.revoked_reason}` : ''}
                      </p>
                    </div>
                    <Badge status={e.status} />
                  </div>
                  {e.status === 'ACTIVE' && (
                    <div className="flex gap-2 flex-wrap">
                      <input
                        className="flex-1 min-w-[220px] bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2 text-xs text-white"
                        placeholder="Revocation reason (required, min 10 characters)…"
                        value={revokeReason[e.id] || ''}
                        onChange={(ev) => setRevokeReason((r) => ({ ...r, [e.id]: ev.target.value }))}
                      />
                      <button onClick={() => revoke(e.id)} disabled={busy} className="text-xs flex items-center gap-1.5 px-3 py-2 rounded-xl bg-red-400/10 text-red-400 border border-red-400/20 hover:bg-red-400/20 disabled:opacity-40">
                        <Ban className="w-3.5 h-3.5" /> Revoke access
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
