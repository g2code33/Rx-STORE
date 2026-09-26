/**
 * Admin → Inbox (direct-to-admin messages).
 *
 * Everything visitors send via the "send directly to admin" forms — ad slot
 * bookings, contact messages, support requests, sponsor requests — lands
 * here. The admin reads, takes action (in review / actioned / archived, with
 * an internal note) and can REPLY BY EMAIL using the template catalogue
 * (ad_approved / ad_declined / ad_ack / general_reply / support_resolved) or
 * custom text. Delivery states are honest: when email is not configured the
 * reply is still recorded and the admin is told to use the sender's address.
 */
import React, { useEffect, useState } from 'react';
import { Inbox, RefreshCw, Loader2, Send, Eye, CheckCircle2, Archive, StickyNote, Mail } from 'lucide-react';
import { api } from '../../services/api';
import { formatDate } from '../../utils/helpers';
import toast from 'react-hot-toast';

const STATUS_TABS = [
  { id: '', label: 'All' },
  { id: 'new', label: 'New' },
  { id: 'in_review', label: 'In review' },
  { id: 'actioned', label: 'Actioned' },
  { id: 'archived', label: 'Archived' },
];

const TYPE_LABEL: Record<string, string> = {
  ad_booking: '📣 Ad booking', contact: '✉️ Contact', support: '🛠️ Support', sponsor: '🤝 Sponsor',
};

const TYPE_COLORS: Record<string, string> = {
  ad_booking: 'bg-rx-yellow/15 text-rx-yellow', contact: 'bg-blue-400/15 text-blue-300',
  support: 'bg-purple-400/15 text-purple-300', sponsor: 'bg-green-400/15 text-green-300',
};

function Delivery({ state }: { state?: string | null }) {
  if (!state) return null;
  const map: Record<string, { label: string; cls: string }> = {
    sent: { label: 'email sent ✓', cls: 'text-green-400' },
    unconfigured: { label: 'email not configured', cls: 'text-amber-300' },
    failed: { label: 'email failed', cls: 'text-red-400' },
    skipped: { label: 'no copy requested', cls: 'text-rx-gray-medium' },
  };
  const m = map[state];
  if (!m) return null;
  return <span className={`text-[10px] ${m.cls}`}>{m.label}</span>;
}

export default function AdminInboxPanel() {
  const [filter, setFilter] = useState('');
  const [messages, setMessages] = useState<any[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [templates, setTemplates] = useState<Array<{ id: string; label: string; subject: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [note, setNote] = useState<Record<string, string>>({});
  const [replyTemplate, setReplyTemplate] = useState<Record<string, string>>({});
  const [replyCustom, setReplyCustom] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');

  const load = () => {
    setLoading(true);
    Promise.all([
      api.inbox.list(filter || undefined).catch(() => ({ messages: [], counts: {} })),
      api.inbox.templates().catch(() => ({ templates: [] })),
    ]).then(([l, t]: any[]) => {
      setMessages(l.messages || []);
      setCounts(l.counts || {});
      setTemplates(t.templates || []);
    }).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [filter]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (id: string, status: string) => {
    setBusy(id + status);
    try {
      await api.inbox.setStatus(id, status, note[id]?.trim() || undefined);
      toast.success(`Marked ${status.replace('_', ' ')}`);
      setNote((n) => ({ ...n, [id]: '' }));
      load();
    } catch (e: any) { toast.error(e?.message || 'Failed'); }
    setBusy('');
  };

  const reply = async (id: string) => {
    setBusy(id + 'reply');
    try {
      const res = await api.inbox.reply(id, replyTemplate[id] || 'general_reply', replyCustom[id] || '');
      if (res.delivery === 'sent') toast.success('Reply email sent ✓');
      else toast(res.note, { icon: '⚠️', duration: 7000 });
      load();
    } catch (e: any) { toast.error(e?.message || 'Reply failed'); }
    setBusy('');
  };

  const totalNew = counts.new || 0;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Inbox className="w-5 h-5 text-rx-yellow" /> Inbox
            {totalNew > 0 && <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rx-yellow text-rx-dark">{totalNew} NEW</span>}
          </h2>
          <p className="text-sm text-rx-gray-medium mt-1">
            Ad slot bookings, contact and support messages sent directly to the admin. Take action, then reply with an email template.
          </p>
        </div>
        <button onClick={load} className="btn-secondary text-sm flex items-center gap-2"><RefreshCw className="w-4 h-4" /> Refresh</button>
      </div>

      <div className="flex gap-1 bg-rx-dark-secondary rounded-xl p-1 w-fit flex-wrap">
        {STATUS_TABS.map((t) => (
          <button key={t.id} onClick={() => setFilter(t.id)}
            className={`px-4 py-2 rounded-lg text-xs sm:text-sm font-medium transition-all ${filter === t.id ? 'bg-rx-yellow text-rx-dark' : 'text-rx-gray-medium hover:text-white'}`}>
            {t.label}{t.id && counts[t.id] ? ` (${counts[t.id]})` : ''}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="card p-8 animate-pulse" />
      ) : messages.length === 0 ? (
        <div className="card p-8 text-center text-sm text-rx-gray-medium">
          Nothing here yet. Messages from the "Send directly to admin" forms (e.g. the ad booking form on /advertise) arrive in this inbox.
        </div>
      ) : (
        <div className="space-y-3">
          {messages.map((m) => {
            const open = openId === m.id;
            return (
              <div key={m.id} className={`card overflow-hidden ${m.status === 'new' ? 'border-rx-yellow/30' : ''}`}>
                <button onClick={() => setOpenId(open ? null : m.id)} className="w-full text-left p-4 flex items-start gap-3 hover:bg-white/5 transition-colors">
                  <span className={`px-2 py-1 rounded text-[10px] font-bold whitespace-nowrap ${TYPE_COLORS[m.type] || 'bg-white/5 text-rx-gray-medium'}`}>
                    {TYPE_LABEL[m.type] || m.type}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white truncate">{m.subject}</p>
                    <p className="text-xs text-rx-gray-medium truncate">
                      {m.name} &lt;{m.email}&gt; · {formatDate(m.created_at)}
                      {m.replied_at ? ' · replied' : ''}
                    </p>
                  </div>
                  <span className={`text-[10px] font-bold px-2 py-1 rounded whitespace-nowrap ${
                    m.status === 'new' ? 'bg-rx-yellow/15 text-rx-yellow' : m.status === 'in_review' ? 'bg-blue-400/10 text-blue-300'
                    : m.status === 'actioned' ? 'bg-green-400/10 text-green-400' : 'bg-white/5 text-rx-gray-medium'
                  }`}>{m.status.replace('_', ' ')}</span>
                </button>

                {open && (
                  <div className="border-t border-white/5 p-4 space-y-4">
                    {/* The message */}
                    <div className="bg-black/30 rounded-xl p-4">
                      <pre className="text-sm text-white/90 whitespace-pre-wrap font-sans leading-relaxed">{m.message}</pre>
                    </div>

                    {/* Structured extras (ad booking details…) */}
                    {(() => {
                      let payload: any = {};
                      try { payload = JSON.parse(m.payload || '{}'); } catch { payload = {}; }
                      const entries = Object.entries(payload).filter(([, v]) => !!v);
                      if (!entries.length) return null;
                      return (
                        <div className="grid sm:grid-cols-2 gap-2">
                          {entries.map(([k, v]) => (
                            <div key={k} className="bg-white/5 rounded-lg px-3 py-2">
                              <p className="text-[10px] uppercase tracking-wider text-rx-gray-medium">{k.replace(/([A-Z])/g, ' $1')}</p>
                              <p className="text-xs text-white truncate">{String(v)}</p>
                            </div>
                          ))}
                        </div>
                      );
                    })()}

                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-rx-gray-medium">
                      <span>Admin notification on arrival: <Delivery state={m.notified_admin} /></span>
                      {m.replied_at && <span>Replied {formatDate(m.replied_at)} with “{m.reply_template}”: <Delivery state={m.reply_delivery} /></span>}
                      <a href={`mailto:${m.email}?subject=${encodeURIComponent('Re: ' + m.subject)}`} className="text-rx-yellow hover:underline inline-flex items-center gap-1">
                        <Mail className="w-3 h-3" /> or email {m.email} directly
                      </a>
                    </div>

                    {m.admin_note && (
                      <div className="bg-rx-yellow/5 border border-rx-yellow/15 rounded-xl p-3">
                        <p className="text-[10px] uppercase tracking-wider text-rx-yellow/80 flex items-center gap-1"><StickyNote className="w-3 h-3" /> Your note</p>
                        <p className="text-xs text-white/85 mt-1 whitespace-pre-wrap">{m.admin_note}</p>
                      </div>
                    )}

                    {/* Actions */}
                    <div className="flex flex-wrap gap-2">
                      {m.status !== 'in_review' && (
                        <button onClick={() => act(m.id, 'in_review')} disabled={!!busy} className="btn-secondary text-xs !py-2 flex items-center gap-1.5 disabled:opacity-50">
                          {busy === m.id + 'in_review' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />} Mark in review
                        </button>
                      )}
                      {m.status !== 'actioned' && (
                        <button onClick={() => act(m.id, 'actioned')} disabled={!!busy} className="px-3 py-2 text-xs font-medium rounded-lg bg-green-500/10 hover:bg-green-500/20 text-green-400 border border-green-500/20 flex items-center gap-1.5 disabled:opacity-50">
                          {busy === m.id + 'actioned' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />} Actioned
                        </button>
                      )}
                      {m.status !== 'archived' && (
                        <button onClick={() => act(m.id, 'archived')} disabled={!!busy} className="px-3 py-2 text-xs rounded-lg bg-white/5 hover:bg-white/10 text-rx-gray-medium border border-white/10 flex items-center gap-1.5 disabled:opacity-50">
                          <Archive className="w-3.5 h-3.5" /> Archive
                        </button>
                      )}
                    </div>

                    {/* Internal note */}
                    <div>
                      <label className="block text-xs text-rx-gray-medium mb-1">Internal note (saved with the next action)</label>
                      <textarea value={note[m.id] || ''} onChange={(e) => setNote({ ...note, [m.id]: e.target.value })} rows={2} maxLength={2000}
                        placeholder="e.g. Approved — invoice sent separately, slot starts Monday…"
                        className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2 text-sm text-white" />
                    </div>

                    {/* Reply with template */}
                    <div className="bg-white/5 rounded-xl p-4 space-y-3">
                      <p className="text-xs font-semibold text-white flex items-center gap-1.5"><Send className="w-3.5 h-3.5 text-rx-yellow" /> Reply to the sender by email</p>
                      <div className="grid sm:grid-cols-2 gap-2">
                        <select
                          value={replyTemplate[m.id] || (m.type === 'ad_booking' ? 'ad_ack' : 'general_reply')}
                          onChange={(e) => setReplyTemplate({ ...replyTemplate, [m.id]: e.target.value })}
                          className="bg-rx-dark border border-white/10 rounded-xl px-3 py-2 text-sm text-white"
                        >
                          {templates.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                        </select>
                        <a href={`mailto:${m.email}`} className="text-xs text-rx-gray-medium hover:text-white self-center truncate">
                          to: {m.email}
                        </a>
                      </div>
                      <textarea value={replyCustom[m.id] || ''} onChange={(e) => setReplyCustom({ ...replyCustom, [m.id]: e.target.value })} rows={4} maxLength={5000}
                        placeholder="Your message (inserted into the template) — pricing, scheduling, questions…"
                        className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2 text-sm text-white" />
                      <button onClick={() => reply(m.id)} disabled={!!busy} className="btn-primary text-sm flex items-center gap-2 disabled:opacity-50">
                        {busy === m.id + 'reply' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Send reply
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
