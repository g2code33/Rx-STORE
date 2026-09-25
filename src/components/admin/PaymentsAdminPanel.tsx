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

type Tab = 'transactions' | 'payouts' | 'reconciliation';

const PAYOUT_TABS: Array<{ id: Tab; label: string }> = [
  { id: 'transactions', label: 'Transactions' },
  { id: 'payouts', label: 'Payouts' },
  { id: 'reconciliation', label: 'Reconciliation' },
];

export default function PaymentsAdminPanel() {
  const [tab, setTab] = useState<Tab>('transactions');
  const [transactions, setTransactions] = useState<any[]>([]);
  const [entitlements, setEntitlements] = useState<any[]>([]);
  const [payouts, setPayouts] = useState<any[]>([]);
  const [reconciliation, setReconciliation] = useState<any>(null);
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [revokeReason, setRevokeReason] = useState<Record<string, string>>({});
  const [processReason, setProcessReason] = useState<Record<string, string>>({});
  const [processRef, setProcessRef] = useState<Record<string, string>>({});

  const load = () => {
    setLoading(true);
    Promise.all([
      api.adminPayments.status().catch(() => null),
      api.adminPayments.transactions().catch(() => ({ transactions: [] })),
      api.adminPayments.entitlements().catch(() => ({ entitlements: [] })),
      (api as any).adminFinance.payouts().catch(() => ({ payouts: [] })),
      (api as any).adminFinance.reconciliation().catch(() => null),
    ]).then(([st, t, e, po, rec]: any[]) => {
      if (st) setStatus(st);
      setTransactions(t.transactions || []);
      setEntitlements(e.entitlements || []);
      setPayouts(po?.payouts || []);
      if (rec) setReconciliation(rec);
    }).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const processPayout = async (id: string, status: string) => {
    setBusy(true);
    try {
      await (api as any).adminFinance.processPayout(id, status, {
        reason: processReason[id] || undefined,
        reference: processRef[id] || undefined,
      });
      toast.success(`Payout marked ${status}`);
      setProcessReason((r) => ({ ...r, [id]: '' }));
      setProcessRef((r) => ({ ...r, [id]: '' }));
      load();
    } catch (e: any) { toast.error(e?.message || 'Failed'); }
    setBusy(false);
  };

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

      {/* LIVE provider status — what is actually configured on this deployment */}
      {status && (
        <div className="card p-5">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div>
              <p className="text-xs uppercase tracking-wider text-rx-gray-medium">Provider</p>
              <p className="text-sm font-bold text-white flex items-center gap-2">
                Paystack
                {status.configured ? (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-400/15 text-green-300">CONNECTED · LIVE</span>
                ) : (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-300">NOT CONFIGURED</span>
                )}
              </p>
              {status.simulation && <p className="text-[11px] text-amber-300 mt-0.5">Dev simulation active (non-production, no secret).</p>}
            </div>
            <div>
              <p className="text-xs uppercase tracking-wider text-rx-gray-medium">Purchases</p>
              <p className="text-sm text-white">{status.purchases?.complete ?? 0} complete · {status.purchases?.refunded ?? 0} refunded · {status.purchases?.total ?? 0} total</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wider text-rx-gray-medium">Marketplace fee</p>
              <p className="text-sm text-white">{status.marketplaceFeePercent}% (developer revenue)</p>
            </div>
            <div className="flex-1 min-w-64">
              <p className="text-xs uppercase tracking-wider text-rx-gray-medium">Webhook endpoint</p>
              <div className="flex items-center gap-2 mt-0.5">
                <code className="text-[11px] text-white/85 bg-black/30 rounded px-2 py-1 truncate flex-1">{status.webhookUrl}</code>
                <button
                  onClick={() => { try { navigator.clipboard.writeText(status.webhookUrl); toast.success('Webhook URL copied'); } catch { toast.error('Copy failed'); } }}
                  className="btn-secondary text-xs !py-1.5 !px-3"
                >Copy</button>
              </div>
              <p className="text-[11px] mt-1">
                {status.webhook?.events > 0 ? (
                  <span className="text-green-300">
                    ✓ {status.webhook.events} event{status.webhook.events === 1 ? '' : 's'} received{status.webhook.lastType ? ` · last: ${status.webhook.lastType}` : ''}{status.webhook.lastAt ? ` (${formatDate(status.webhook.lastAt)})` : ''}
                  </span>
                ) : (
                  <span className="text-amber-300">
                    No webhooks received yet — register this URL in your Paystack dashboard (Settings → API Keys &amp; Webhooks) so refunds and completions sync automatically.
                  </span>
                )}
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="flex gap-1 bg-rx-dark-secondary rounded-xl p-1 w-fit mt-4">
        {PAYOUT_TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-4 py-2 rounded-lg text-xs sm:text-sm font-medium transition-all ${tab === t.id ? 'bg-rx-yellow text-rx-dark' : 'text-rx-gray-medium hover:text-white'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="card p-8 animate-pulse space-y-3"><div className="h-5 bg-white/5 rounded w-1/3" /><div className="h-16 bg-white/5 rounded" /></div>
      ) : tab === 'payouts' ? (
        <>
          {/* Payout requests */}
          <div className="card">
            <div className="p-4 border-b border-white/5"><h3 className="text-sm font-bold text-white uppercase tracking-wider">Payout requests ({payouts.length})</h3></div>
            <div className="divide-y divide-white/5">
              {payouts.length === 0 ? (
                <p className="p-6 text-center text-sm text-rx-gray-medium">No payouts requested yet.</p>
              ) : payouts.map((po) => (
                <div key={po.id} className="p-4 space-y-2">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-white truncate">{po.publisherName || po.developerId} — GH₵{(Number(po.amountMinor) / 100).toFixed(2)}</p>
                      <p className="text-xs text-rx-gray-medium truncate">
                        requested {formatDate(po.createdAt)} by {po.requestedBy}
                        {po.failureReason ? ` · ${po.failureReason}` : ''}
                        {po.paidAt ? ` · paid ${formatDate(po.paidAt)}` : ''}
                        {po.processorReference ? ` · ref ${po.processorReference}` : ''}
                      </p>
                    </div>
                    <span className={`text-[10px] font-bold px-2 py-1 rounded ${
                      po.status === 'PAID' ? 'bg-green-400/10 text-green-400'
                      : po.status === 'FAILED' ? 'bg-red-400/10 text-red-400'
                      : po.status === 'HELD' ? 'bg-amber-500/10 text-amber-300'
                      : po.status === 'CANCELLED' ? 'bg-white/5 text-rx-gray-medium'
                      : 'bg-blue-400/10 text-blue-300'}`}>{po.status}</span>
                  </div>
                  {['PENDING', 'PROCESSING', 'HELD'].includes(po.status) && (
                    <div className="flex gap-2 flex-wrap">
                      <input
                        className="flex-1 min-w-[160px] bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2 text-xs text-white"
                        placeholder={po.status === 'PROCESSING' ? 'Processor reference (required for PAID)…' : 'Reference (optional)…'}
                        value={processRef[po.id] || ''}
                        onChange={(e) => setProcessRef((r) => ({ ...r, [po.id]: e.target.value }))}
                      />
                      <input
                        className="flex-1 min-w-[160px] bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2 text-xs text-white"
                        placeholder="Reason (required for FAILED / HELD)…"
                        value={processReason[po.id] || ''}
                        onChange={(e) => setProcessReason((r) => ({ ...r, [po.id]: e.target.value }))}
                      />
                      {po.status === 'PENDING' && (
                        <>
                          <button onClick={() => processPayout(po.id, 'PROCESSING')} disabled={busy} className="btn-secondary text-xs px-3 py-2 disabled:opacity-40">Start processing</button>
                          <button onClick={() => processPayout(po.id, 'CANCELLED')} disabled={busy} className="text-xs px-3 py-2 rounded-xl text-rx-gray-medium hover:text-white">Cancel</button>
                        </>
                      )}
                      {['PENDING', 'PROCESSING'].includes(po.status) && (
                        <>
                          <button onClick={() => processPayout(po.id, 'PAID')} disabled={busy} className="btn-primary text-xs px-3 py-2 disabled:opacity-40">Mark paid</button>
                          <button onClick={() => processPayout(po.id, 'FAILED')} disabled={busy} className="text-xs px-3 py-2 rounded-xl bg-red-400/10 text-red-400 border border-red-400/20 hover:bg-red-400/20 disabled:opacity-40">Mark failed</button>
                        </>
                      )}
                      {po.status === 'PROCESSING' && (
                        <button onClick={() => processPayout(po.id, 'HELD')} disabled={busy} className="text-xs px-3 py-2 rounded-xl bg-amber-500/10 text-amber-300 border border-amber-500/20 hover:bg-amber-500/20 disabled:opacity-40">Hold</button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </>
      ) : tab === 'reconciliation' ? (
        <>
          {/* Reconciliation */}
          <div className="card p-5">
            <h3 className="text-sm font-bold text-white uppercase tracking-wider mb-4">Marketplace money movement</h3>
            {reconciliation ? (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                  {[
                    ['Gross', reconciliation.totals?.grossMinor, 'text-white'],
                    ['Refunds', reconciliation.totals?.refundsMinor, 'text-purple-300'],
                    ['Fees', reconciliation.totals?.feesMinor, 'text-amber-300'],
                    ['Net to devs', reconciliation.totals?.netMinor, 'text-green-400'],
                    ['Paid out', reconciliation.totals?.paidMinor, 'text-rx-gray-medium'],
                    ['Outstanding', reconciliation.totals?.outstandingPayoutMinor, 'text-rx-yellow'],
                  ].map(([label, value, cls]) => (
                    <div key={String(label)} className="rounded-xl bg-rx-dark-tertiary/60 border border-white/5 p-3 text-center">
                      <p className="text-[10px] uppercase tracking-wide text-rx-gray-medium">{String(label)}</p>
                      <p className={`text-sm font-bold mt-1 ${cls}`}>GH₵{((Number(value) || 0) / 100).toFixed(2)}</p>
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-rx-gray-medium/70 mt-3">Platform fee: {reconciliation.feePercent ?? 15}% of retained sales · purchase ledger: {(reconciliation.purchaseLedger || []).map((l: any) => `${l.status}: ${l.count} (GH₵${(l.totalMinor / 100).toFixed(2)})`).join(' · ')}</p>
                {(reconciliation.developers || []).length > 0 && (
                  <div className="mt-4 divide-y divide-white/5 border-t border-white/5 pt-2">
                    {reconciliation.developers.map((d: any) => (
                      <div key={d.developerId} className="flex items-center justify-between gap-2 py-2 flex-wrap">
                        <span className="text-sm text-white">{d.developerId}</span>
                        <span className="text-xs text-rx-gray-medium">gross GH₵{((Number(d.grossMinor) || 0) / 100).toFixed(2)} · net GH₵{((Number(d.netMinor) || 0) / 100).toFixed(2)} · paid GH₵{((Number(d.paidMinor) || 0) / 100).toFixed(2)} · payable GH₵{((Number(d.pendingMinor) || 0) / 100).toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-rx-gray-medium text-center py-4">Reconciliation unavailable.</p>
            )}
          </div>
        </>
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
