/**
 * ContactAdminForm — the reusable "send directly to the RX Store admin" form.
 *
 * Anywhere a user would previously be dumped into a mailto: link, this form
 * sends the message straight into the ADMIN PORTAL inbox (Admin → Inbox),
 * where the admin can read it, take action, and reply with a template.
 * Email notification/acknowledgement is attempted when the deployment has
 * email configured — the UI shows the HONEST delivery state either way.
 *
 * Props:
 *   type           ad_booking | contact | support | sponsor
 *   defaultSubject prefilled subject line
 *   template       prefilled message template (editable by the sender)
 *   fields         optional structured extras rendered as inputs
 *                  (e.g. Company, Headline, Target URL for ad bookings)
 *   compact        tighter layout for embedding (login box, sponsor page)
 *   onSent         callback after a successful submit
 */
import React, { useState } from 'react';
import { Send, Loader2, CheckCircle2 } from 'lucide-react';
import { api, isApiConfigured } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import toast from 'react-hot-toast';

export interface ContactAdminExtraField {
  key: string;
  label: string;
  placeholder?: string;
}

export default function ContactAdminForm({
  type,
  defaultSubject,
  template,
  fields = [],
  compact = false,
  onSent,
}: {
  type: 'ad_booking' | 'contact' | 'support' | 'sponsor';
  defaultSubject: string;
  template: string;
  fields?: ContactAdminExtraField[];
  compact?: boolean;
  onSent?: () => void;
}) {
  const { user } = useAuth();
  const [name, setName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [subject, setSubject] = useState(defaultSubject);
  const [message, setMessage] = useState(template);
  const [extras, setExtras] = useState<Record<string, string>>({});
  const [notifySender, setNotifySender] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<null | { adminNotified: string }>(null);

  React.useEffect(() => {
    if (user) { setName((n) => n || user.name || ''); setEmail((e) => e || user.email || ''); }
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isApiConfigured()) { toast.error('RX Store cannot reach the account service right now.'); return; }
    setBusy(true);
    try {
      const res = await api.inbox.submit({
        type, name: name.trim(), email: email.trim(), subject: subject.trim(),
        message: message.trim(), payload: extras, notifySender,
      });
      setDone({ adminNotified: res.adminNotified });
      toast.success('Sent to the RX Store admin inbox ✓');
      onSent?.();
    } catch (e: any) {
      toast.error(e?.message || 'Could not send your message. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className={`card ${compact ? 'p-4' : 'p-6'} text-center`}>
        <CheckCircle2 className="w-8 h-8 text-green-400 mx-auto mb-2" />
        <p className="text-sm font-semibold text-white">Message delivered to the admin inbox</p>
        <p className="text-xs text-rx-gray-medium mt-1">
          {done.adminNotified === 'sent'
            ? 'The RX Store team has been notified by email and usually replies within a business day.'
            : 'The admin team will see it in their portal inbox.'}
        </p>
        <button onClick={() => setDone(null)} className="mt-3 text-xs text-rx-yellow hover:underline">
          Send another message
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className={`card ${compact ? 'p-4 space-y-3' : 'p-6 space-y-4'}`}>
      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-rx-gray-medium mb-1">Your name</label>
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Ama Mensah"
            className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white" />
        </div>
        <div>
          <label className="block text-xs text-rx-gray-medium mb-1">Your email</label>
          <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com"
            className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white" />
        </div>
      </div>
      <div>
        <label className="block text-xs text-rx-gray-medium mb-1">Subject</label>
        <input required value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200}
          className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white" />
      </div>
      {fields.length > 0 && (
        <div className={`grid gap-3 ${compact ? '' : 'sm:grid-cols-2'}`}>
          {fields.map((f) => (
            <div key={f.key}>
              <label className="block text-xs text-rx-gray-medium mb-1">{f.label}</label>
              <input value={extras[f.key] || ''} onChange={(e) => setExtras({ ...extras, [f.key]: e.target.value })}
                placeholder={f.placeholder} maxLength={500}
                className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white" />
            </div>
          ))}
        </div>
      )}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs text-rx-gray-medium">Message (editable template)</label>
          {message !== template && (
            <button type="button" onClick={() => setMessage(template)} className="text-[11px] text-rx-yellow hover:underline">
              Reset template
            </button>
          )}
        </div>
        <textarea required value={message} onChange={(e) => setMessage(e.target.value)} rows={compact ? 6 : 8} maxLength={5000}
          className="w-full bg-rx-dark-tertiary border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white leading-relaxed" />
      </div>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <label className="flex items-center gap-2 text-xs text-rx-gray-medium cursor-pointer">
          <input type="checkbox" checked={notifySender} onChange={(e) => setNotifySender(e.target.checked)}
            className="w-3.5 h-3.5 rounded border-white/20 bg-rx-dark-tertiary text-rx-yellow" />
          Also email me a copy / acknowledgement
        </label>
        <button type="submit" disabled={busy || !name.trim() || !email.trim() || message.trim().length < 10}
          className="btn-primary text-sm flex items-center gap-2 disabled:opacity-50">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          {busy ? 'Sending…' : 'Send directly to admin'}
        </button>
      </div>
    </form>
  );
}
