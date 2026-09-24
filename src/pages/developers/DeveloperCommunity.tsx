/**
 * /developers/community — the real developer community (Phase 20 §5).
 * Public categories/discussions/replies from the backend (no fake forum),
 * signed-in posting, reporting with reasons. Private developer↔admin
 * communication stays in Developer Center → Communications.
 */
import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, MessageSquare, Plus, Reply, Flag, X, Users2, ShieldCheck } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { api, isApiConfigured } from '../../services/api';
import { formatDate } from '../../utils/helpers';
import toast from 'react-hot-toast';

const REPORT_REASONS = ['spam', 'harassment', 'irrelevant', 'malicious_content', 'other'];

export default function DeveloperCommunity() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [categories, setCategories] = useState<any[]>([]);
  const [active, setActive] = useState<string>('');
  const [discussions, setDiscussions] = useState<any[]>([]);
  const [pagination, setPagination] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [openDiscussion, setOpenDiscussion] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [composer, setComposer] = useState(false);
  const [form, setForm] = useState({ categoryId: '', title: '', body: '' });
  const [replyText, setReplyText] = useState('');
  const [reporting, setReporting] = useState<{ type: 'discussion' | 'reply'; id: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const loadList = (category: string, page = 1) => {
    setLoading(true);
    api.community.discussions(category || undefined, page).then((d: any) => {
      setDiscussions(d.discussions || []);
      setPagination(d.pagination);
    }).catch(() => setDiscussions([])).finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!isApiConfigured()) { setLoading(false); return; }
    api.community.categories().then((d: any) => {
      const cats = d.categories || [];
      setCategories(cats);
      if (cats.length && !form.categoryId) setForm((f) => ({ ...f, categoryId: cats[0].id }));
    }).catch(() => {});
    loadList(active);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const open = async (id: string) => {
    if (openDiscussion === id) { setOpenDiscussion(null); setDetail(null); return; }
    setOpenDiscussion(id);
    setDetail(null);
    try {
      const d = await api.community.discussion(id);
      setDetail(d);
    } catch (e: any) { toast.error(e?.message || 'Could not open'); setOpenDiscussion(null); }
  };

  const post = async () => {
    if (!user) { navigate('/login'); return; }
    setBusy(true);
    try {
      await api.community.createDiscussion(form.categoryId, form.title.trim(), form.body.trim());
      toast.success('Discussion posted');
      setComposer(false); setForm((f) => ({ ...f, title: '', body: '' }));
      loadList(active);
    } catch (e: any) { toast.error(e?.message || 'Could not post'); }
    setBusy(false);
  };

  const reply = async () => {
    if (!openDiscussion || !replyText.trim()) return;
    setBusy(true);
    try {
      await api.community.createReply(openDiscussion, replyText.trim());
      toast.success('Reply posted');
      setReplyText('');
      await open(openDiscussion); // reload
      loadList(active);
    } catch (e: any) { toast.error(e?.message || 'Could not reply'); }
    setBusy(false);
  };

  const report = async (reason: string) => {
    if (!reporting) return;
    try {
      await api.community.report(reporting.type, reporting.id, reason);
      toast.success('Reported — moderators will review it');
    } catch (e: any) { toast.error(e?.message || 'Could not report'); }
    setReporting(null);
  };

  return (
    <div className="section-container max-w-4xl py-8 md:py-12">
      <Link to="/developers" className="inline-flex items-center gap-1.5 text-sm text-rx-gray-medium hover:text-white transition-colors">
        <ArrowLeft className="w-4 h-4" /> Developer Portal
      </Link>
      <div className="flex items-start justify-between gap-3 flex-wrap mt-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-black text-white flex items-center gap-2.5"><Users2 className="w-7 h-7 text-rx-yellow" /> Developer Community</h1>
          <p className="text-sm text-rx-gray-medium mt-2 max-w-xl">
            A public space for everyone building on RX Store. For private conversations with the review team, use Developer Center → Communications.
          </p>
        </div>
        <button onClick={() => (user ? setComposer(!composer) : navigate('/login'))} className="btn-primary text-sm flex items-center gap-2">
          <Plus className="w-4 h-4" /> New discussion
        </button>
      </div>

      {/* Composer */}
      {composer && (
        <div className="card p-5 mt-6 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-white uppercase tracking-wider">Start a discussion</h3>
            <button onClick={() => setComposer(false)} className="text-rx-gray-medium hover:text-white"><X className="w-4 h-4" /></button>
          </div>
          <select value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
            className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white">
            {categories.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Title (5+ characters)"
            className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white" maxLength={150} />
          <textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} rows={5}
            placeholder="Write your post — questions, guides, announcements… (10+ characters)"
            className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white" maxLength={5000} />
          <div className="flex justify-end">
            <button onClick={post} disabled={busy || form.title.trim().length < 5 || form.body.trim().length < 10} className="btn-primary text-sm disabled:opacity-40">
              {busy ? 'Posting…' : 'Post discussion'}
            </button>
          </div>
        </div>
      )}

      {/* Categories */}
      <div className="flex gap-2 flex-wrap mt-8">
        <button onClick={() => { setActive(''); loadList(''); }}
          className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all ${!active ? 'bg-rx-yellow text-rx-dark' : 'bg-rx-dark-tertiary text-rx-gray-medium hover:text-white'}`}>
          All
        </button>
        {categories.map((c: any) => (
          <button key={c.id} onClick={() => { setActive(c.id); loadList(c.id); }}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all ${active === c.id ? 'bg-rx-yellow text-rx-dark' : 'bg-rx-dark-tertiary text-rx-gray-medium hover:text-white'}`}>
            {c.name} <span className="opacity-60">({c.discussion_count})</span>
          </button>
        ))}
      </div>

      {/* Discussion list */}
      <div className="mt-5 space-y-3">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => <div key={i} className="card p-5 h-20 animate-pulse" />)
        ) : discussions.length === 0 ? (
          <div className="card p-10 text-center">
            <MessageSquare className="w-8 h-8 text-rx-gray-medium/40 mx-auto" />
            <p className="text-sm text-rx-gray-medium mt-3">No discussions yet — start the first one.</p>
          </div>
        ) : discussions.map((d: any) => (
          <div key={d.id} className="card overflow-hidden">
            <button onClick={() => open(d.id)} className="w-full p-4 flex items-start gap-3 hover:bg-white/[0.03] text-left transition-colors">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-white truncate">{d.title}</p>
                <p className="text-xs text-rx-gray-medium mt-1 truncate">{d.excerpt}</p>
                <p className="text-[11px] text-rx-gray-medium/70 mt-1.5 flex items-center gap-2 flex-wrap">
                  <span className="flex items-center gap-1">{d.isOrgPost && <ShieldCheck className="w-3 h-3 text-rx-yellow" />}{d.author}</span>
                  <span>· {d.replyCount} {d.replyCount === 1 ? 'reply' : 'replies'}</span>
                  <span>· active {formatDate(d.lastActivityAt)}</span>
                </p>
              </div>
            </button>

            {/* Inline detail */}
            {openDiscussion === d.id && (
              <div className="border-t border-white/5 p-4 space-y-4">
                {!detail ? (
                  <div className="h-20 animate-pulse rounded-xl bg-white/5" />
                ) : (
                  <>
                    <div className="p-4 rounded-xl bg-rx-dark-tertiary/50">
                      <p className="text-[11px] text-rx-gray-medium mb-2 flex items-center gap-1.5">
                        {detail.discussion.isOrgPost && <ShieldCheck className="w-3 h-3 text-rx-yellow" />}
                        <span className="text-white font-medium">{detail.discussion.author}</span>
                        · {formatDate(detail.discussion.createdAt)}
                        <button onClick={() => user && setReporting({ type: 'discussion', id: d.id })} className="ml-auto flex items-center gap-1 text-rx-gray-medium hover:text-red-400"><Flag className="w-3 h-3" /> Report</button>
                      </p>
                      <p className="text-sm text-rx-gray-medium whitespace-pre-wrap leading-relaxed">{detail.discussion.body}</p>
                    </div>

                    {(detail.replies || []).map((r: any) => (
                      <div key={r.id} className="p-3.5 rounded-xl bg-rx-dark-tertiary/30 ml-4 sm:ml-8 border-l-2 border-white/5">
                        <p className="text-[11px] text-rx-gray-medium mb-1.5 flex items-center gap-1.5">
                          {r.isOrgPost && <ShieldCheck className="w-3 h-3 text-rx-yellow" />}
                          <span className="text-white font-medium">{r.author}</span>
                          · {formatDate(r.createdAt)}
                          <button onClick={() => user && setReporting({ type: 'reply', id: r.id })} className="ml-auto flex items-center gap-1 text-rx-gray-medium hover:text-red-400"><Flag className="w-3 h-3" /> Report</button>
                        </p>
                        <p className="text-sm text-rx-gray-medium whitespace-pre-wrap leading-relaxed">{r.body}</p>
                      </div>
                    ))}

                    {/* Reply box */}
                    {user ? (
                      <div className="flex flex-col sm:flex-row gap-2">
                        <input value={replyText} onChange={(e) => setReplyText(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && reply()}
                          placeholder="Write a reply…" maxLength={5000}
                          className="flex-1 bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white" />
                        <button onClick={reply} disabled={busy || replyText.trim().length < 10} className="btn-primary text-sm px-4 disabled:opacity-40 flex items-center gap-2"><Reply className="w-4 h-4" /> Reply</button>
                      </div>
                    ) : (
                      <p className="text-xs text-rx-gray-medium text-center py-2"><Link to="/login" className="text-rx-yellow hover:underline">Sign in</Link> to join the discussion.</p>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Pagination */}
      {pagination?.hasNext && (
        <div className="text-center mt-6">
          <button onClick={() => loadList(active, (pagination.page || 1) + 1)} className="btn-secondary text-sm">Load more</button>
        </div>
      )}

      {/* Report picker */}
      {reporting && (
        <div className="fixed inset-0 z-[80] bg-rx-dark/80 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setReporting(null)}>
          <div className="card p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-bold text-white uppercase tracking-wider mb-3">Report this {reporting.type}</h3>
            <div className="space-y-2">
              {REPORT_REASONS.map((r) => (
                <button key={r} onClick={() => report(r)}
                  className="w-full text-left px-3.5 py-2.5 rounded-xl bg-rx-dark-tertiary/60 border border-white/5 hover:border-rx-yellow/30 text-sm text-white capitalize transition-colors">
                  {r.replace(/_/g, ' ')}
                </button>
              ))}
            </div>
            <button onClick={() => setReporting(null)} className="w-full text-xs text-rx-gray-medium hover:text-white mt-3">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
