/**
 * RX Store — in-app text dialog.
 *
 * WHY THIS EXISTS: `window.prompt()` is NOT implemented in Electron. Calling it
 * throws `Error: prompt() is and will not be supported.` — so every desktop
 * admin action that asked for a reason (Manual approve, Reject, Withdraw,
 * Delete, Suspend/Disconnect a repository, reset a user's password) silently
 * did nothing in the desktop app. `window.confirm` still works, `window.prompt`
 * does not, and neither is styleable.
 *
 * This is a real modal: focus-trapped, Escape closes, Enter submits (single
 * line), validation is inline and the reason is never lost to a browser dialog.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, AlertTriangle, Copy, Check } from 'lucide-react';

export interface PromptDialogProps {
  open: boolean;
  title: string;
  /** Explanatory copy above the field (what will happen). */
  description?: React.ReactNode;
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  /** Minimum trimmed length before Confirm is enabled (e.g. 10 for a reason). */
  minLength?: number;
  maxLength?: number;
  /** Multi-line field (reasons) instead of a single line. */
  multiline?: boolean;
  /** Render as a password field with a reveal toggle. */
  secret?: boolean;
  /** Show a Copy button (for "here is your new password" style values). */
  copyable?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  onCancel: () => void;
  onConfirm: (value: string) => void;
}

export default function PromptDialog({
  open,
  title,
  description,
  label,
  placeholder,
  defaultValue = '',
  minLength = 0,
  maxLength = 2000,
  multiline = false,
  secret = false,
  copyable = false,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  onCancel,
  onConfirm,
}: PromptDialogProps) {
  const [value, setValue] = useState(defaultValue);
  const [reveal, setReveal] = useState(!secret);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const aliveRef = useRef(true);

  // Reset each time the dialog is (re)opened with a new default.
  useEffect(() => {
    if (!open) return;
    setValue(defaultValue);
    setReveal(!secret);
    setCopied(false);
    aliveRef.current = true;
    // Focus on the next frame so the dialog is mounted and visible.
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultValue]);

  useEffect(() => () => { aliveRef.current = false; }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  const trimmed = value.trim();
  const tooShort = trimmed.length < minLength;
  const hint = useMemo(() => {
    if (minLength <= 0) return null;
    if (trimmed.length === 0) return `${minLength}+ characters required`;
    if (tooShort) return `${minLength - trimmed.length} more character${minLength - trimmed.length === 1 ? '' : 's'} needed`;
    return null;
  }, [minLength, trimmed.length, tooShort]);

  if (!open) return null;

  const submit = () => {
    if (tooShort) return;
    onConfirm(trimmed);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => { if (aliveRef.current) setCopied(false); }, 1800);
    } catch {
      // Clipboard blocked (insecure context / no permission): select the text
      // so the user can copy it manually — never a browser prompt().
      inputRef.current?.focus();
      if (inputRef.current && 'select' in inputRef.current) inputRef.current.select();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={onCancel}
      role="presentation"
    >
      <div
        className="w-full max-w-lg card p-5 space-y-4 animate-scale-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rx-prompt-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            {tone === 'danger' && <AlertTriangle className="w-5 h-5 text-red-400 mt-0.5 flex-shrink-0" />}
            <div>
              <h3 id="rx-prompt-title" className="text-base font-bold text-white">{title}</h3>
              {description && <div className="text-xs text-rx-gray-medium mt-1 leading-relaxed">{description}</div>}
            </div>
          </div>
          <button type="button" onClick={onCancel} aria-label="Close" className="p-1 rounded-lg text-rx-gray-medium hover:text-white hover:bg-white/10">
            <X className="w-4 h-4" />
          </button>
        </div>

        {label && <label htmlFor="rx-prompt-input" className="block text-xs font-medium text-white/80">{label}</label>}

        <div className="relative">
          {multiline ? (
            <textarea
              id="rx-prompt-input"
              ref={(el) => { inputRef.current = el; }}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={placeholder}
              maxLength={maxLength}
              rows={4}
              className="input w-full resize-y min-h-[96px]"
            />
          ) : (
            <input
              id="rx-prompt-input"
              ref={(el) => { inputRef.current = el; }}
              type={secret ? (reveal ? 'text' : 'password') : 'text'}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={placeholder}
              maxLength={maxLength}
              autoComplete="off"
              spellCheck={false}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
              className="input w-full pr-16"
            />
          )}
          {secret && (
            <button type="button" onClick={() => setReveal((r) => !r)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] px-2 py-1 rounded-lg text-rx-gray-medium hover:text-white hover:bg-white/10">
              {reveal ? 'Hide' : 'Show'}
            </button>
          )}
          {copyable && !multiline && (
            <button type="button" onClick={copy}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] px-2 py-1 rounded-lg text-rx-gray-medium hover:text-white hover:bg-white/10 flex items-center gap-1">
              {copied ? <><Check className="w-3 h-3" /> Copied</> : <><Copy className="w-3 h-3" /> Copy</>}
            </button>
          )}
        </div>

        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] text-rx-gray-medium">{hint || ' '}</p>
          <div className="flex gap-2 flex-shrink-0">
            <button type="button" onClick={onCancel} className="btn-secondary text-sm px-4 py-2">{cancelLabel}</button>
            <button
              type="button"
              onClick={submit}
              disabled={tooShort}
              className={`text-sm px-4 py-2 rounded-xl font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                tone === 'danger'
                  ? 'bg-red-500 text-white hover:bg-red-600'
                  : 'bg-rx-yellow text-[#0f1419] hover:bg-rx-yellow-light'
              }`}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
