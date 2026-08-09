import { useEffect, useState } from 'react';
import { Bell, Send, Loader2, Users, Package, Globe, Link2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { API_URL } from '../../services/api';
import { useApps } from '../../context/AppContext';

/** Admin → Notifications: send to all users, selected users, or users having a specific app installed. */
export default function NotificationComposer() {
  const { apps } = useApps();
  const token = localStorage.getItem('rx-store-token') || '';

  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [link, setLink] = useState('');
  const [audience, setAudience] = useState<'all' | 'users' | 'app'>('all');
  const [sending, setSending] = useState(false);

  const [users, setUsers] = useState<any[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [appSlug, setAppSlug] = useState('');

  // Prefill from a Recent Activity 📣 action
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('rx-notif-draft');
      if (raw) {
        const d = JSON.parse(raw);
        if (d.title) setTitle(d.title);
        if (d.message) setMessage(d.message);
        if (d.link) setLink(d.link);
        sessionStorage.removeItem('rx-notif-draft');
        toast('Draft loaded from recent activity', { icon: '📣' });
      }
    } catch {}
  }, []);

  // Load users only when the "selected users" audience is picked
  useEffect(() => {
    if (audience !== 'users' || users.length || !API_URL) return;
    fetch(`${API_URL}/admin/users`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((j) => setUsers(j.data || j || []))
      .catch(() => toast.error('Could not load users'));
  }, [audience]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (audience === 'app' && !appSlug && apps.length) setAppSlug(apps[0].slug);
  }, [audience, apps]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleUser = (id: string) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

  const send = async () => {
    if (!title.trim() || !message.trim()) { toast.error('Title and message are required'); return; }
    if (audience === 'users' && selected.size === 0) { toast.error('Pick at least one user'); return; }
    if (audience === 'app' && !appSlug) { toast.error('Pick an app'); return; }
    setSending(true);
    try {
      const res = await fetch(`${API_URL}/admin/notifications/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          audience,
          userIds: [...selected],
          appSlug: audience === 'app' ? appSlug : undefined,
          title: title.trim(),
          message: message.trim(),
          link: link.trim(),
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error?.message || 'Send failed');
      toast.success(`Notification sent to ${j?.data?.recipients ?? '?'} user${j?.data?.recipients === 1 ? '' : 's'} 🔔`);
      setTitle(''); setMessage(''); setLink(''); setSelected(new Set());
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSending(false);
    }
  };

  const audienceMeta = [
    { id: 'all' as const, label: 'All users', desc: 'Every registered account', icon: Globe },
    { id: 'users' as const, label: 'Selected users', desc: 'Pick recipients one by one', icon: Users },
    { id: 'app' as const, label: 'App installed', desc: 'Only users who downloaded a specific app', icon: Package },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white flex items-center gap-2"><Bell className="w-5 h-5 text-rx-yellow" /> Notifications</h2>
        <p className="text-sm text-rx-gray-medium mt-1">
          Broadcast to everyone, hand-pick users, or target by installed app. Appears instantly in the bell of every recipient.
          Publishing a release also auto-notifies that app's installers.
        </p>
      </div>

      <div className="card p-6 space-y-5">
        {/* Audience */}
        <div>
          <label className="block text-sm text-rx-gray-medium mb-2">Audience</label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {audienceMeta.map((a) => (
              <button
                key={a.id}
                onClick={() => setAudience(a.id)}
                className={`p-3.5 rounded-xl border text-left transition-all ${
                  audience === a.id ? 'border-rx-yellow bg-rx-yellow/10' : 'border-white/10 bg-rx-dark-tertiary/40 hover:border-white/25'
                }`}
              >
                <a.icon className={`w-4 h-4 mb-1.5 ${audience === a.id ? 'text-rx-yellow' : 'text-rx-gray-medium'}`} />
                <p className="text-sm font-semibold text-white">{a.label}</p>
                <p className="text-[11px] text-rx-gray-medium mt-0.5">{a.desc}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Selected users */}
        {audience === 'users' && (
          <div className="max-h-56 overflow-y-auto rounded-xl border border-white/10 divide-y divide-white/5">
            {users.length === 0 && <p className="p-4 text-sm text-rx-gray-medium text-center">Loading users…</p>}
            {users.map((u: any) => (
              <label key={u.id} className="flex items-center gap-3 p-3 cursor-pointer hover:bg-white/5">
                <input type="checkbox" checked={selected.has(u.id)} onChange={() => toggleUser(u.id)} className="accent-rx-yellow w-4 h-4" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white truncate">{u.name || '(no name)'}</p>
                  <p className="text-xs text-rx-gray-medium truncate">{u.email} · {u.role}</p>
                </div>
              </label>
            ))}
          </div>
        )}

        {/* App selector */}
        {audience === 'app' && (
          <div>
            <label className="block text-sm text-rx-gray-medium mb-1.5">Users who installed</label>
            <select
              value={appSlug}
              onChange={(e) => setAppSlug(e.target.value)}
              className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-rx-yellow/50"
            >
              {apps.map((a: any) => <option key={a.slug} value={a.slug}>{a.name} ({a.slug})</option>)}
            </select>
          </div>
        )}

        {/* Content */}
        <div>
          <label className="block text-sm text-rx-gray-medium mb-1.5">Title</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. CLINICAL RX 1.4.3 is live"
            className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-rx-yellow/50"
          />
        </div>
        <div>
          <label className="block text-sm text-rx-gray-medium mb-1.5">Message</label>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
            placeholder="What should users know?"
            className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-rx-yellow/50 resize-none"
          />
        </div>
        <div>
          <label className="block text-sm text-rx-gray-medium mb-1.5 flex items-center gap-1"><Link2 className="w-3.5 h-3.5" /> Link (optional)</label>
          <input
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="/app/C-RX"
            className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-rx-yellow/50"
          />
          <p className="text-[11px] text-rx-gray-medium mt-1">Tapping the notification opens this page.</p>
        </div>

        <button
          onClick={send}
          disabled={sending}
          className="w-full py-3 rounded-xl bg-rx-yellow text-rx-dark font-bold text-sm flex items-center justify-center gap-2 disabled:opacity-50 hover:bg-rx-yellow-light transition-colors"
        >
          {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          Send Notification
        </button>
      </div>
    </div>
  );
}
