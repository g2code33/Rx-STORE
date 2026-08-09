import { useEffect, useState } from 'react';
import { Users, Shield, Crown, Wrench, Loader2, Search, Save, KeyRound, Megaphone } from 'lucide-react';
import toast from 'react-hot-toast';
import { API_URL } from '../../services/api';

type U = { id: string; name: string; email: string; role: string; created_at?: string; advertiser?: number | boolean };

const roleMeta: Record<string, { label: string; color: string; icon: any }> = {
  user: { label: 'User', color: 'bg-white/10 text-rx-gray-medium', icon: Users },
  developer: { label: 'Developer', color: 'bg-purple-400/20 text-purple-300', icon: Wrench },
  admin: { label: 'Admin', color: 'bg-rx-yellow/20 text-rx-yellow', icon: Crown },
};

export default function UserRoleEditor() {
  const [users, setUsers] = useState<U[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [saving, setSaving] = useState<string>('');

  const token = localStorage.getItem('rx-store-token') || '';

  const fetchUsers = async () => {
    if (!API_URL) {
      setUsers([
        { id: 'u1', name: 'Dr. Sarah Chen', email: 'sarah.chen@hospital.org', role: 'user' },
        { id: 'u2', name: 'James Wilson', email: 'j.wilson@pharmacy.com', role: 'developer' },
        { id: 'u3', name: 'Lisa Thompson', email: 'lisa.t@healthcare.org', role: 'admin' },
      ]); setLoading(false); return;
    }
    try {
      const res = await fetch(`${API_URL}/admin/users`, { headers: { 'Authorization': `Bearer ${token}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Failed');
      setUsers(data.data || data.users || []);
    } catch (e: any) { toast.error(e.message); }
    setLoading(false);
  };
  useEffect(() => { fetchUsers(); }, []);

  const updateRole = async (id: string, role: string) => {
    if (!API_URL) { toast('Set VITE_API_URL for live role updates', { icon: '⚠️' }); return; }
    if (!token) { toast.error('Login as admin'); return; }
    setSaving(id);
    try {
      const res = await fetch(`${API_URL}/admin/users/${id}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ role }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Failed');
      toast.success(`Role → ${role}`);
      setUsers(u => u.map(x => x.id===id ? { ...x, role } : x));
    } catch (e: any) { toast.error(e.message); }
    finally { setSaving(''); }
  };

  /** Mark/unmark a user as having an active advertisement running. */
  const toggleAdvertiser = async (u: U) => {
    if (!API_URL) { toast('Set VITE_API_URL for live updates', { icon: '⚠️' }); return; }
    const next = !(u.advertiser === 1 || u.advertiser === true);
    setSaving(`ad-${u.id}`);
    try {
      const res = await fetch(`${API_URL}/admin/users/${u.id}/advertiser`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ advertiser: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || (res.status === 404 ? 'Redeploy the worker first (npx wrangler deploy --config backend/wrangler.toml)' : 'Failed'));
      setUsers(list => list.map(x => x.id === u.id ? { ...x, advertiser: next ? 1 : 0 } : x));
      toast.success(next ? `${u.name} marked as advertiser 📣` : `${u.name} unmarked`);
    } catch (e: any) { toast.error(e.message); }
    finally { setSaving(''); }
  };

  /** Reset a user's login — hand them the new password once, it's never stored in plain text. */
  const resetLogin = async (u: U) => {
    if (!API_URL) { toast('Set VITE_API_URL for live updates', { icon: '⚠️' }); return; }
    const typed = window.prompt(
      `Reset the login for ${u.name} (${u.email}).\n\n` +
      `Type a NEW password (8+ characters) — or leave EMPTY to auto-generate a temporary one.\n` +
      `(They can change it after signing in.)`,
      ''
    );
    if (typed === null) return; // cancelled
    if (typed.trim() && typed.trim().length < 8) { toast.error('Password must be at least 8 characters'); return; }
    setSaving(`pw-${u.id}`);
    try {
      const res = await fetch(`${API_URL}/admin/users/${u.id}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(typed.trim() ? { password: typed.trim() } : {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || (res.status === 404 ? 'Redeploy the worker first (npx wrangler deploy --config backend/wrangler.toml)' : 'Failed'));
      const pwd = data.data?.tempPassword || typed.trim();
      window.prompt(`Login reset ✓ — give this to ${u.name} (shown once, store it nowhere else):\n\nEmail: ${u.email}\nPassword:`, pwd);
      toast.success(`Login reset for ${u.name} ✓`);
    } catch (e: any) { toast.error(e.message); }
    finally { setSaving(''); }
  };

  const filtered = users.filter(u => !q || u.name.toLowerCase().includes(q.toLowerCase()) || u.email.toLowerCase().includes(q.toLowerCase()));

  if (loading) return <div className="card p-8 text-center text-rx-gray-medium flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin"/> Loading users…</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div><h2 className="text-xl font-bold text-white flex items-center gap-2"><Shield className="w-5 h-5 text-rx-yellow"/> User Roles</h2><p className="text-sm text-rx-gray-medium mt-1">Change user → developer → admin. Admin can manage AI, releases, revenue.</p></div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-rx-gray-medium"/>
          <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search name or email" className="pl-9 pr-3 py-2 bg-rx-dark border border-white/10 rounded-xl text-sm text-white placeholder:text-rx-gray-medium focus:outline-none focus:border-rx-yellow/40 w-64"/>
        </div>
      </div>

      {!API_URL && <div className="text-xs px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-200">Offline demo — changes are local until VITE_API_URL is set.</div>}

      <div className="card overflow-hidden">
        <div className="divide-y divide-white/5">
          {filtered.map(u => {
            const m = roleMeta[u.role] || roleMeta.user;
            const Icon = m.icon;
            return (
              <div key={u.id} className="flex items-center gap-3 p-4 hover:bg-white/5 transition-colors">
                <div className="w-9 h-9 rounded-lg bg-rx-dark-tertiary flex items-center justify-center text-sm font-bold text-rx-yellow">{u.name.charAt(0)}</div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate flex items-center gap-1.5">
                    {u.name}
                    {(u.advertiser === 1 || (u.advertiser as any) === true) && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-rx-yellow/15 text-rx-yellow text-[9px] font-bold uppercase tracking-wider flex-shrink-0" title="Has an active advertisement">
                        <Megaphone className="w-2.5 h-2.5" /> Advertiser
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-rx-gray-medium truncate">{u.email}</p>
                </div>
                <span className={`hidden sm:inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${m.color}`}><Icon className="w-3 h-3"/>{m.label}</span>
                {/* Advertiser flag — marks users who have an active advertisement */}
                <button
                  onClick={() => toggleAdvertiser(u)}
                  disabled={!!saving}
                  title={(u.advertiser === 1 || (u.advertiser as any) === true) ? 'Advertiser — click to unmark' : 'Mark as advertiser (has an active ad)'}
                  className={`p-2 rounded-lg transition-all disabled:opacity-50 ${
                    (u.advertiser === 1 || (u.advertiser as any) === true)
                      ? 'bg-rx-yellow/20 text-rx-yellow'
                      : 'text-rx-gray-medium hover:text-rx-yellow hover:bg-rx-yellow/10'
                  }`}
                >
                  {saving === `ad-${u.id}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Megaphone className="w-4 h-4" />}
                </button>
                {/* Reset the user's login for them */}
                <button
                  onClick={() => resetLogin(u)}
                  disabled={!!saving}
                  title="Reset this user's password"
                  className="p-2 rounded-lg text-rx-gray-medium hover:text-white hover:bg-white/10 transition-all disabled:opacity-50"
                >
                  {saving === `pw-${u.id}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
                </button>
                <select value={u.role} onChange={e=>updateRole(u.id, e.target.value)} disabled={!!saving} className="bg-rx-dark border border-white/10 rounded-xl px-2 py-1.5 text-sm text-white disabled:opacity-50">
                  <option value="user">user</option>
                  <option value="developer">developer</option>
                  <option value="admin">admin</option>
                </select>
                {saving===u.id && <Loader2 className="w-4 h-4 animate-spin text-rx-gray-medium"/>}
              </div>
            );
          })}
          {filtered.length===0 && <div className="p-8 text-center text-rx-gray-medium text-sm">No users match.</div>}
        </div>
      </div>
      <p className="text-xs text-rx-gray-medium">Tip: to make yourself admin quickly: <code className="px-1 py-0.5 bg-white/10 rounded">npx wrangler d1 execute rx-store-db --command "UPDATE users SET role='admin' WHERE email='YOUR_EMAIL'" --remote</code></p>
    </div>
  );
}
