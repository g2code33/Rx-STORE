import { useState } from 'react';
import { X, AlertTriangle, Lock } from 'lucide-react';

type Props = {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'default' | 'danger';
  requirePassword?: boolean;
  passwordPlaceholder?: string;
  onConfirm: (password?: string) => void;
  onCancel: () => void;
};

export default function ConfirmModal({ title, message, confirmText = 'Confirm', cancelText = 'Cancel', variant = 'default', requirePassword = false, passwordPlaceholder = '••••••••', onConfirm, onCancel }: Props) {
  const [pwd, setPwd] = useState('');
  const [error, setError] = useState('');

  const handleConfirm = () => {
    if (requirePassword && !pwd) { setError('Password required'); return; }
    onConfirm(requirePassword ? pwd : undefined);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onCancel}>
      <div onClick={e=>e.stopPropagation()} className="bg-rx-dark-secondary border border-white/10 rounded-2xl w-full max-w-md overflow-hidden">
        <div className="p-6">
          <div className="flex items-start gap-3">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${variant==='danger' ? 'bg-red-500/10' : 'bg-rx-yellow/10'}`}>
              {variant==='danger' ? <AlertTriangle className="w-5 h-5 text-red-400"/> : <Lock className="w-4 h-4 text-rx-yellow"/>}
            </div>
            <div className="flex-1">
              <h3 className="font-bold text-white">{title}</h3>
              <p className="text-sm text-rx-gray-medium mt-1 leading-relaxed">{message}</p>
            </div>
            <button onClick={onCancel} className="p-1.5 rounded-lg hover:bg-white/10 text-rx-gray-medium"><X className="w-4 h-4"/></button>
          </div>
          {requirePassword && (
            <div className="mt-4">
              <input type="password" value={pwd} onChange={e=>{ setPwd(e.target.value); setError(''); }} placeholder={passwordPlaceholder} autoFocus className="w-full bg-rx-dark border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-rx-yellow/50" />
              {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
            </div>
          )}
        </div>
        <div className="p-4 bg-rx-dark/50 border-t border-white/5 flex gap-2 justify-end">
          <button onClick={onCancel} className="px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-white border border-white/10 text-sm">{cancelText}</button>
          <button onClick={handleConfirm} className={`px-4 py-2 rounded-xl font-bold text-sm ${variant==='danger' ? 'bg-red-500 hover:bg-red-600 text-white' : 'bg-rx-yellow hover:bg-rx-yellow-light text-rx-dark'}`}>{confirmText}</button>
        </div>
      </div>
    </div>
  );
}
