/**
 * Developer Center (Phase 11 §6) — the approved developer's workspace.
 * One layout, sectioned by route:
 *   /developers/center (overview) · /apps · /releases · /submissions ·
 *   /analytics · /reviews · /team · /messages · /profile · /settings
 * Sections render real backend data (org, apps, releases, reviews, threads).
 * Suspended organizations get a restricted view (status + communications only).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Package, Upload, FileCheck, BarChart3, Star, Users, MessageSquare,
  User as UserIcon, Settings as SettingsIcon, AlertTriangle, Send, Copy, X,
} from 'lucide-react';
import { api, isApiConfigured } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { formatDate } from '../../utils/helpers';
import AppLogo from '../../components/apps/AppLogo';
import toast from 'react-hot-toast';

const NAV = [
  { to: '/developers/center', label: 'Overview', icon: LayoutDashboard },
  { to: '/developers/apps', label: 'My Apps', icon: Package },
  { to: '/developers/releases', label: 'Releases', icon: Upload },
  { to: '/developers/submissions', label: 'Submissions', icon: FileCheck },
  { to: '/developers/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/developers/reviews', label: 'Reviews', icon: Star },
  { to: '/developers/team', label: 'Team', icon: Users },
  { to: '/developers/messages', label: 'Communications', icon: MessageSquare },
  { to: '/developers/profile', label: 'Developer Profile', icon: UserIcon },
  { to: '/developers/settings', label: 'Settings', icon: SettingsIcon },
];

const ASSIGNABLE = ['ADMIN', 'DEVELOPER', 'RELEASE_MANAGER', 'ANALYST', 'SUPPORT'];

function Section({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div>
      <h1 className="text-xl sm:text-2xl font-bold text-white">{title}</h1>
      {desc && <p className="text-sm text-rx-gray-medium mt-1">{desc}</p>}
      <div className="mt-6">{children}</div>
    </div>
  );
}

function Empty({ icon: Icon, title, desc }: { icon: any; title: string; desc: string }) {
  return (
    <div className="card p-8 text-center">
      <div className="w-12 h-12 rounded-xl bg-rx-yellow/10 flex items-center justify-center mx-auto"><Icon className="w-6 h-6 text-rx-yellow" /></div>
      <h3 className="font-semibold text-white mt-3">{title}</h3>
      <p className="text-sm text-rx-gray-medium mt-1 max-w-sm mx-auto">{desc}</p>
    </div>
  );
}

export default function DeveloperCenter() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [org, setOrg] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const section = useMemo(() => location.pathname.replace('/developers/', '') || 'center', [location.pathname]);

  useEffect(() => {
    if (!user) { navigate('/login'); return; }
    if (!isApiConfigured()) { setLoading(false); setError('not-configured'); return; }
    let alive = true;
    api.developers.organization().then((d) => { if (alive) setOrg(d); })
      .catch((e: any) => { if (alive) setError(e?.message || 'Could not load your organization'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!user) return null;

  const refresh = () => api.developers.organization().then(setOrg).catch(() => {});
  const suspended = org?.organization?.status === 'SUSPENDED';

  return (
    <div className="section-container py-8 md:py-12">
      <div className="flex flex-col lg:flex-row gap-8">
        {/* Sidebar */}
        <aside className="lg:w-60 flex-shrink-0">
          <div className="card p-4 lg:sticky lg:top-24">
            <p className="text-[10px] font-bold uppercase tracking-wider text-rx-gray-medium px-2">Developer Center</p>
            <p className="text-sm font-semibold text-white px-2 mt-1 truncate">{org?.organization?.profile?.publisherName || user?.name}</p>
            {org?.organization && (
              <p className="text-[11px] text-rx-gray-medium px-2 mt-0.5">
                {org.organization.id} · <span className={suspended ? 'text-amber-300' : 'text-green-400'}>{suspended ? 'Suspended' : 'Active'}</span>
              </p>
            )}
            <nav className="flex lg:flex-col gap-1 mt-4 overflow-x-auto">
              {NAV.map((n) => {
                const restricted = suspended && !['center', 'messages', 'settings'].includes(n.to.replace('/developers/', ''));
                if (restricted) return null;
                return (
                  <NavLink
                    key={n.to} to={n.to} end
                    className={({ isActive }) => `flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm whitespace-nowrap transition-all ${isActive ? 'text-rx-yellow bg-rx-yellow/10 font-medium' : 'text-rx-gray-medium hover:text-white hover:bg-white/5'}`}
                  >
                    <n.icon className="w-4 h-4 flex-shrink-0" /> {n.label}
                  </NavLink>
                );
              })}
            </nav>
          </div>
        </aside>

        {/* Content */}
        <main className="flex-1 min-w-0">
          {suspended && (
            <div className="mb-6 p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 flex gap-3 items-start text-sm">
              <AlertTriangle className="w-5 h-5 text-amber-300 flex-shrink-0 mt-0.5" />
              <p className="text-rx-gray-medium">
                Your organization is suspended — team, apps and publishing are read-only.
                Use <Link to="/developers/messages" className="text-rx-yellow hover:underline">Communications</Link> to reach the RX Store team.
              </p>
            </div>
          )}

          {loading ? (
            <div className="card p-8 animate-pulse space-y-4">
              <div className="h-5 bg-white/5 rounded w-1/3" /><div className="h-3 bg-white/5 rounded w-2/3" /><div className="h-24 bg-white/5 rounded" />
            </div>
          ) : error === 'not-configured' ? (
            <div className="card p-8 text-center"><p className="text-sm text-rx-gray-medium">Backend not connected — install a correctly configured build.</p></div>
          ) : error ? (
            <div className="card p-8 text-center">
              <AlertTriangle className="w-8 h-8 text-red-400 mx-auto" />
              <p className="text-sm text-rx-gray-medium mt-3">{error}</p>
              <Link to="/developers/status" className="btn-secondary text-sm mt-4 inline-block">Application status</Link>
            </div>
          ) : org ? (
            <>
              {section === 'center' && <Overview org={org} />}
              {section === 'apps' && <MyApps org={org} />}
              {section === 'releases' && <Releases org={org} />}
              {section === 'submissions' && (
                <Section title="Submissions" desc="App submission to the RX Store review pipeline.">
                  <Empty icon={FileCheck} title="App submissions open in a later phase" desc="Developer approval, teams, releases and admin communication are live today. The app submission pipeline (security review, signed packages) attaches to this organization model next." />
                </Section>
              )}
              {section === 'analytics' && <Analytics org={org} />}
              {section === 'reviews' && <Reviews org={org} />}
              {section === 'team' && <Team org={org} onChanged={refresh} />}
              {section === 'messages' && <Communications />}
              {section === 'profile' && <PublicProfile org={org} onChanged={refresh} />}
              {section === 'settings' && <Settings org={org} />}
            </>
          ) : null}
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Overview({ org }: { org: any }) {
  const { stats, organization } = org;
  const cards = [
    { label: 'Published apps', value: stats?.published ?? 0 },
    { label: 'Total downloads', value: stats?.downloads ?? 0 },
    { label: 'Reviews', value: stats?.reviews ?? 0 },
    { label: 'Average rating', value: stats?.avgRating ?? 0 },
  ];
  return (
    <Section title="Overview" desc={`${organization.profile?.publisherName || 'Your organization'} · developer since ${formatDate(organization.developerSince)}`}>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {cards.map((c) => (
          <div key={c.label} className="card p-4 sm:p-5">
            <p className="text-2xl font-black text-white">{c.value}</p>
            <p className="text-xs text-rx-gray-medium mt-1">{c.label}</p>
          </div>
        ))}
      </div>
      <div className="grid md:grid-cols-2 gap-4 mt-4">
        <div className="card p-5">
          <h3 className="font-semibold text-white text-sm">Your role</h3>
          <p className="text-rx-yellow font-bold mt-2">{organization.myRole}</p>
          <div className="flex flex-wrap gap-1.5 mt-3">
            {(organization.permissions || []).map((p: string) => (
              <span key={p} className="text-[10px] bg-white/5 text-rx-gray-medium px-2 py-1 rounded">{p}</span>
            ))}
          </div>
        </div>
        <div className="card p-5">
          <h3 className="font-semibold text-white text-sm">Recent releases</h3>
          {(org.releases || []).slice(0, 4).map((r: any) => (
            <div key={r.id} className="flex items-center justify-between text-sm mt-2">
              <span className="text-rx-gray-medium truncate">{r.app_name} <span className="text-white">{r.version}</span></span>
              <span className={`text-[10px] px-2 py-0.5 rounded ${r.status === 'published' ? 'bg-green-400/10 text-green-400' : 'bg-white/5 text-rx-gray-medium'}`}>{r.status}</span>
            </div>
          )) || <p className="text-sm text-rx-gray-medium mt-2">No releases yet.</p>}
          {!org.releases?.length && <p className="text-sm text-rx-gray-medium mt-2">No releases yet.</p>}
        </div>
      </div>
      <div className="card p-5 mt-4">
        <h3 className="font-semibold text-white text-sm">Public profile</h3>
        <p className="text-xs text-rx-gray-medium mt-1">Share your developer page with users:</p>
        <code className="block text-xs bg-rx-dark-tertiary rounded-lg px-3 py-2 mt-2 text-rx-yellow overflow-x-auto">/developer/{organization.id}</code>
      </div>
    </Section>
  );
}

function MyApps({ org }: { org: any }) {
  const apps = org.apps || [];
  return (
    <Section title="My Apps" desc="Applications connected to your organization.">
      {apps.length === 0 ? (
        <Empty icon={Package} title="No apps yet" desc="Apps you already publish under your account are connected automatically on approval. New app submission opens in a later phase." />
      ) : (
        <div className="grid sm:grid-cols-2 gap-3">
          {apps.map((a: any) => (
            <Link key={a.id} to={`/app/${a.slug}`} className="card p-4 flex items-center gap-4 hover:bg-white/[0.03] transition-colors">
              <AppLogo app={a} size="w-14 h-14" />
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-white truncate">{a.name}</p>
                <p className="text-xs text-rx-gray-medium mt-0.5">v{a.current_version || '—'} · ⭐ {a.rating || 0} ({a.review_count || 0})</p>
                <p className="text-xs text-rx-gray-medium">{a.download_count || 0} downloads</p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </Section>
  );
}

function Releases({ org }: { org: any }) {
  const releases = org.releases || [];
  return (
    <Section title="Releases" desc="Recent releases across your applications (read-only in this phase).">
      {releases.length === 0 ? (
        <Empty icon={Upload} title="No releases yet" desc="Releases published for your apps appear here. Release management attaches to your organization in the next phase." />
      ) : (
        <div className="card divide-y divide-white/5">
          {releases.map((r: any) => (
            <div key={r.id} className="p-4 flex flex-wrap items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white truncate">{r.app_name} <span className="text-rx-yellow">{r.version}</span></p>
                <p className="text-xs text-rx-gray-medium mt-0.5">{formatDate(r.created_at)} · {r.channel || 'stable'}</p>
              </div>
              <span className={`text-[10px] px-2 py-1 rounded font-medium ${r.status === 'published' ? 'bg-green-400/10 text-green-400' : 'bg-white/5 text-rx-gray-medium'}`}>{r.status}</span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function Analytics({ org }: { org: any }) {
  const apps = org.apps || [];
  const max = Math.max(1, ...apps.map((a: any) => Number(a.download_count) || 0));
  return (
    <Section title="Analytics" desc="Real download and rating data from the marketplace (analytics.view).">
      {apps.length === 0 ? (
        <Empty icon={BarChart3} title="No analytics yet" desc="Analytics appear once your organization has published applications." />
      ) : (
        <>
          <div className="card p-5 space-y-4">
            {apps.map((a: any) => (
              <div key={a.id}>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-white truncate">{a.name}</span>
                  <span className="text-rx-gray-medium">{a.download_count || 0} downloads</span>
                </div>
                <div className="h-2 bg-white/5 rounded-full mt-1.5 overflow-hidden">
                  <div className="h-full bg-rx-yellow rounded-full" style={{ width: `${Math.round(((Number(a.download_count) || 0) / max) * 100)}%` }} />
                </div>
                <p className="text-[11px] text-rx-gray-medium mt-1">⭐ {a.rating || 0} · {a.review_count || 0} reviews</p>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-rx-gray-medium/70 mt-3">ANALYST role: analytics only — publishing requires RELEASE_MANAGER or higher.</p>
        </>
      )}
    </Section>
  );
}

function Reviews({ org }: { org: any }) {
  const reviews = org.reviews || [];
  return (
    <Section title="Reviews" desc="What users say about your applications (reviews.manage).">
      {reviews.length === 0 ? (
        <Empty icon={Star} title="No reviews yet" desc="User reviews for your published apps appear here." />
      ) : (
        <div className="card divide-y divide-white/5">
          {reviews.map((r: any) => (
            <div key={r.id} className="p-4">
              <div className="flex items-center gap-2">
                <span className="text-rx-yellow text-sm">{'★'.repeat(r.rating || 0)}<span className="text-rx-gray-medium/40">{'★'.repeat(5 - (r.rating || 0))}</span></span>
                <span className="text-xs text-white truncate">{r.app_name}</span>
                <span className="text-[11px] text-rx-gray-medium ml-auto">{formatDate(r.created_at)}</span>
              </div>
              {r.comment && <p className="text-sm text-rx-gray-medium mt-1.5">{r.comment}</p>}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------

function Team({ org, onChanged }: { org: any; onChanged: () => void }) {
  const [team, setTeam] = useState<any>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('DEVELOPER');
  const [inviteToken, setInviteToken] = useState('');
  const [busy, setBusy] = useState(false);
  const canManage = (team?.permissions || []).includes('team.manage');

  const load = () => api.developers.team().then(setTeam).catch(() => {});
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const invite = async () => {
    if (!inviteEmail.trim()) { toast.error('Enter an email address'); return; }
    setBusy(true);
    try {
      const res = await api.developers.inviteMember({ email: inviteEmail.trim(), role: inviteRole });
      setInviteToken(res.inviteToken);
      setInviteEmail('');
      toast.success('Invitation created — share the link below');
      load();
    } catch (e: any) { toast.error(e?.message || 'Could not create invitation'); }
    setBusy(false);
  };

  const inputCls = 'flex-1 min-w-0 bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white placeholder-rx-gray-medium focus:outline-none focus:border-rx-yellow/50';

  return (
    <Section title="Team" desc="Members and roles are enforced server-side. Every change is audited.">
      {canManage && (
        <div className="card p-5">
          <h3 className="font-semibold text-white text-sm">Invite a member</h3>
          <div className="flex flex-col sm:flex-row gap-2 mt-3">
            <input className={inputCls} type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="teammate@company.com" />
            <select className={`${inputCls} sm:w-44`} value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
              {ASSIGNABLE.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <button onClick={invite} disabled={busy} className="btn-primary text-sm px-4 disabled:opacity-40">{busy ? '…' : 'Invite'}</button>
          </div>
          <p className="text-[11px] text-rx-gray-medium/70 mt-2">OWNER is granted only by the approval flow — invitations assign the five working roles.</p>
          {inviteToken && (
            <div className="mt-4 p-3 rounded-xl bg-rx-dark-tertiary border border-rx-yellow/20">
              <p className="text-xs text-rx-gray-medium">Invitation link (shown once — only a hash is stored):</p>
              <div className="flex items-center gap-2 mt-2">
                <code className="flex-1 text-[11px] text-rx-yellow overflow-x-auto whitespace-nowrap">{`${window.location.origin}/developers/invite?token=${inviteToken}`}</code>
                <button onClick={() => { navigator.clipboard?.writeText(`${window.location.origin}/developers/invite?token=${inviteToken}`); toast.success('Link copied'); }} className="p-1.5 rounded-lg hover:bg-white/10 text-rx-gray-medium hover:text-white"><Copy className="w-4 h-4" /></button>
                <button onClick={() => setInviteToken('')} className="p-1.5 rounded-lg hover:bg-white/10 text-rx-gray-medium hover:text-white"><X className="w-4 h-4" /></button>
              </div>
              <p className="text-[11px] text-rx-gray-medium/70 mt-2">The invitee must sign in with this exact email, then open the link. Expires in 7 days.</p>
            </div>
          )}
        </div>
      )}

      <div className="card mt-4 divide-y divide-white/5">
        {(team?.members || []).map((m: any) => (
          <div key={m.userId} className="p-4 flex flex-wrap items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-rx-dark-tertiary flex items-center justify-center text-sm">👤</div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">{m.name} {m.userId === org?.organization?.ownerUserId ? '' : ''}</p>
              <p className="text-xs text-rx-gray-medium truncate">{m.email}</p>
            </div>
            {m.role === 'OWNER' ? (
              <span className="text-[10px] font-bold bg-rx-yellow/15 text-rx-yellow px-2.5 py-1.5 rounded">OWNER</span>
            ) : canManage ? (
              <div className="flex items-center gap-2">
                <select
                  className="bg-rx-dark-tertiary border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white"
                  value={m.role}
                  onChange={async (e) => {
                    try { await api.developers.changeRole(m.userId, e.target.value); toast.success('Role updated'); load(); onChanged(); }
                    catch (err: any) { toast.error(err?.message || 'Could not change role'); load(); }
                  }}
                >
                  {ASSIGNABLE.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
                <button
                  onClick={async () => {
                    if (!confirm(`Remove ${m.name} from the team?`)) return;
                    try { await api.developers.removeMember(m.userId); toast.success('Member removed'); load(); }
                    catch (err: any) { toast.error(err?.message || 'Could not remove member'); }
                  }}
                  className="p-1.5 rounded-lg text-rx-gray-medium hover:text-red-400 hover:bg-red-400/10"
                  title="Remove member"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <span className="text-[10px] bg-white/5 text-rx-gray-medium px-2.5 py-1.5 rounded">{m.role}</span>
            )}
          </div>
        ))}
      </div>

      {(team?.invitations || []).length > 0 && (
        <div className="card mt-4">
          <div className="p-4 border-b border-white/5"><h3 className="font-semibold text-white text-sm">Pending invitations</h3></div>
          <div className="divide-y divide-white/5">
            {team.invitations.map((i: any) => (
              <div key={i.id} className="p-4 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white truncate">{i.email}</p>
                  <p className="text-xs text-rx-gray-medium">{i.role} · expires {formatDate(i.expires_at)}</p>
                </div>
                {canManage && (
                  <button
                    onClick={async () => {
                      try { await api.developers.cancelInvitation(i.id); toast.success('Invitation cancelled'); load(); }
                      catch (err: any) { toast.error(err?.message || 'Could not cancel'); }
                    }}
                    className="text-xs text-rx-gray-medium hover:text-red-400"
                  >Cancel</button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------

function Communications() {
  const [threads, setThreads] = useState<any[]>([]);
  const [active, setActive] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [subject, setSubject] = useState('');
  const [firstMessage, setFirstMessage] = useState('');
  const [reply, setReply] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = () => api.developers.threads().then((t: any) => setThreads(t.threads || [])).catch(() => {});
  useEffect(() => { load().finally(() => setLoading(false)); }, []);

  const open = async (t: any) => {
    setActive(t);
    setMessages([]);
    try {
      const d = await api.developers.thread(t.id);
      setActive(d.thread); setMessages(d.messages || []);
    } catch (e: any) { toast.error(e?.message || 'Could not open thread'); }
  };

  const createThread = async () => {
    if (subject.trim().length < 3 || !firstMessage.trim()) { toast.error('Subject and message are required'); return; }
    setBusy(true);
    try {
      await api.developers.createThread({ subject: subject.trim(), message: firstMessage.trim() });
      setSubject(''); setFirstMessage('');
      toast.success('Message sent to the RX Store team');
      load();
    } catch (e: any) { toast.error(e?.message || 'Could not send'); }
    setBusy(false);
  };

  const send = async () => {
    if (!reply.trim() || !active) return;
    setBusy(true);
    try {
      await api.developers.sendMessage(active.id, reply.trim());
      setReply('');
      open(active);
    } catch (e: any) { toast.error(e?.message || 'Could not send'); }
    setBusy(false);
  };

  return (
    <Section title="Communications" desc="Private threads with the RX Store team — stored server-side, tied to your organization.">
      <div className="grid lg:grid-cols-[280px,1fr] gap-4">
        <div className="card divide-y divide-white/5 max-h-[480px] overflow-y-auto">
          <button onClick={() => setActive(null)} className="w-full p-3 text-left text-sm text-rx-yellow hover:bg-white/5">＋ New thread</button>
          {loading ? <div className="p-4 animate-pulse h-16" /> : threads.length === 0 ? (
            <p className="p-4 text-xs text-rx-gray-medium">No threads yet.</p>
          ) : threads.map((t: any) => (
            <button key={t.id} onClick={() => open(t)} className={`w-full p-4 text-left hover:bg-white/5 ${active?.id === t.id ? 'bg-rx-yellow/5' : ''}`}>
              <p className="text-sm text-white truncate">{t.subject}</p>
              <p className="text-[11px] text-rx-gray-medium mt-0.5">{t.status?.replace('_', ' ')} · {formatDate(t.updated_at)}</p>
              {Number(t.unread) > 0 && <span className="inline-block mt-1 text-[10px] bg-rx-yellow/15 text-rx-yellow px-1.5 py-0.5 rounded">{t.unread} new</span>}
            </button>
          ))}
        </div>

        <div className="card p-5 flex flex-col min-h-[320px]">
          {!active ? (
            <>
              <h3 className="font-semibold text-white text-sm">New thread</h3>
              <input className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white mt-3" placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
              <textarea rows={5} className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white mt-2" placeholder="How can the RX Store team help?" value={firstMessage} onChange={(e) => setFirstMessage(e.target.value)} />
              <button onClick={createThread} disabled={busy} className="btn-primary text-sm mt-3 self-start flex items-center gap-2 disabled:opacity-40"><Send className="w-4 h-4" /> Send</button>
            </>
          ) : (
            <>
              <div className="flex items-start justify-between gap-3 border-b border-white/5 pb-3">
                <div>
                  <h3 className="font-semibold text-white text-sm">{active.subject}</h3>
                  <p className="text-[11px] text-rx-gray-medium">{active.status?.replace('_', ' ')} · {formatDate(active.updated_at)}</p>
                </div>
              </div>
              <div className="flex-1 space-y-3 py-4 overflow-y-auto max-h-80">
                {messages.map((m: any) => (
                  <div key={m.id} className={`max-w-[85%] rounded-xl p-3 text-sm ${m.sender_context === 'ADMIN' ? 'bg-rx-yellow/10 text-white ml-auto' : 'bg-rx-dark-tertiary text-rx-gray-medium'}`}>
                    <p className="text-[10px] font-bold uppercase tracking-wide mb-1" style={{ color: m.sender_context === 'ADMIN' ? '#FFD600' : undefined }}>
                      {m.sender_context === 'ADMIN' ? 'RX Store Team' : 'You'}
                    </p>
                    <p className="whitespace-pre-wrap">{m.body}</p>
                    <p className="text-[10px] text-rx-gray-medium/60 mt-1">{formatDate(m.created_at)}</p>
                  </div>
                ))}
                {messages.length === 0 && <p className="text-xs text-rx-gray-medium">No messages.</p>}
              </div>
              {active.status !== 'CLOSED' && (
                <div className="flex gap-2 border-t border-white/5 pt-3">
                  <input className="flex-1 bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white" placeholder="Reply…" value={reply} onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} />
                  <button onClick={send} disabled={busy} className="btn-primary text-sm px-4 disabled:opacity-40"><Send className="w-4 h-4" /></button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------

function PublicProfile({ org, onChanged }: { org: any; onChanged: () => void }) {
  const p = org?.organization?.profile || {};
  const [form, setForm] = useState({ publisherName: p.publisherName || '', logo: p.logo || '', description: p.description || '', website: p.website || '', supportUrl: p.supportUrl || '' });
  const [busy, setBusy] = useState(false);
  const canManage = (org?.organization?.permissions || []).includes('organization.manage');
  const inputCls = 'w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-4 py-3 text-white placeholder-rx-gray-medium focus:outline-none focus:border-rx-yellow/50 transition-all';

  const save = async () => {
    setBusy(true);
    try {
      await api.developers.updateProfile({
        publisher_name: form.publisherName, logo: form.logo, description: form.description,
        website: form.website, support_url: form.supportUrl,
      });
      toast.success('Public profile updated');
      onChanged();
    } catch (e: any) { toast.error(e?.message || 'Could not update profile'); }
    setBusy(false);
  };

  return (
    <Section title="Developer Profile" desc="Your PUBLIC developer page — private verification data is never shown here.">
      <div className="card p-6 space-y-4">
        <div className="grid sm:grid-cols-2 gap-4">
          <div><label className="block text-sm font-medium text-rx-gray-medium mb-2">Publisher name</label>
            <input className={inputCls} value={form.publisherName} onChange={(e) => setForm({ ...form, publisherName: e.target.value })} disabled={!canManage} /></div>
          <div><label className="block text-sm font-medium text-rx-gray-medium mb-2">Logo URL</label>
            <input className={inputCls} value={form.logo} onChange={(e) => setForm({ ...form, logo: e.target.value })} placeholder="https://…" disabled={!canManage} /></div>
          <div className="sm:col-span-2"><label className="block text-sm font-medium text-rx-gray-medium mb-2">Description</label>
            <textarea rows={3} className={inputCls} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} disabled={!canManage} /></div>
          <div><label className="block text-sm font-medium text-rx-gray-medium mb-2">Website</label>
            <input className={inputCls} value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} placeholder="https://…" disabled={!canManage} /></div>
          <div><label className="block text-sm font-medium text-rx-gray-medium mb-2">Support URL</label>
            <input className={inputCls} value={form.supportUrl} onChange={(e) => setForm({ ...form, supportUrl: e.target.value })} placeholder="https://… or mailto:" disabled={!canManage} /></div>
        </div>
        <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
          <button onClick={save} disabled={busy || !canManage} className="btn-primary text-sm disabled:opacity-40">{busy ? 'Saving…' : 'Save profile'}</button>
          <Link to={`/developer/${org?.organization?.id}`} className="text-sm text-rx-yellow hover:underline">View public page →</Link>
        </div>
        {!canManage && <p className="text-xs text-rx-gray-medium">Your role can view but not edit the public profile (organization.manage required).</p>}
      </div>
    </Section>
  );
}

function Settings({ org }: { org: any }) {
  const o = org?.organization;
  return (
    <Section title="Settings" desc="Organization identity and status.">
      <div className="card p-6 space-y-4 text-sm">
        <div className="flex justify-between border-b border-white/5 pb-3"><span className="text-rx-gray-medium">Developer ID</span><code className="text-rx-yellow">{o?.id}</code></div>
        <div className="flex justify-between border-b border-white/5 pb-3"><span className="text-rx-gray-medium">Status</span><span className={o?.status === 'ACTIVE' ? 'text-green-400' : 'text-amber-300'}>{o?.status}</span></div>
        <div className="flex justify-between border-b border-white/5 pb-3"><span className="text-rx-gray-medium">Your role</span><span className="text-white">{o?.myRole}</span></div>
        <div className="flex justify-between"><span className="text-rx-gray-medium">Developer since</span><span className="text-white">{formatDate(o?.developerSince)}</span></div>
      </div>
      <p className="text-[11px] text-rx-gray-medium/70 mt-3">
        Organization deletion, ownership transfer and billing attach to this model in a later phase.
        Suspension/reinstatement is controlled by the RX Store admin team.
      </p>
    </Section>
  );
}
