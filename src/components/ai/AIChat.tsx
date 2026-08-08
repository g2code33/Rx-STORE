import { useState, useRef, useEffect } from 'react';
import { Bot, Send, X, Sparkles, User, Loader2 } from 'lucide-react';
import { api, isApiConfigured } from '../../services/api';

type Message = { role: 'user' | 'assistant'; content: string };

const SUGGESTIONS = [
  'Show me healthcare apps',
  'Which app is best for clinical documentation?',
  'Compare Clinical Rx vs CureLink',
  'What apps work offline?',
];

const MOCK_RESPONSES: Record<string, string> = {
  default:
    "I'm the RX Store Assistant! I can help you discover apps for healthcare, education, productivity and tech. Try asking about a category, comparing apps, or describing what you need — e.g. \"I need a tool for patient communication.\"",
};

function mockReply(input: string): string {
  const q = input.toLowerCase();
  if (q.includes('healthcare')) return 'For healthcare, try **Clinical Rx** (decision support & prescribing), **CureLink** (patient-caregiver communication), and **TAWOMO** (workforce management). All are rated 4.5+ stars.';
  if (q.includes('education') || q.includes('learn')) return '**MediLearn Academy** and **PharmaGAME** are top for education — MediLearn for structured courses, PharmaGAME for gamified pharma training. Want a comparison?';
  if (q.includes('clinical rx') || q.includes('curelink') || q.includes('compare')) return '**Clinical Rx** = clinical decision support (drug interactions, EHR). **CureLink** = patient communication & care coordination. Choose Clinical Rx for prescribing, CureLink for patient engagement.';
  if (q.includes('offline')) return 'Most RX Store apps support offline mode with sync: **Clinical Rx**, **PharmaGAME**, and **CureLink** all work offline on Windows/Android. Check the app detail page → Platforms tab.';
  if (q.includes('document')) return '**Rx Assistant AI** is built for clinical documentation — auto-generates notes, summaries and SOAP notes. Pair it with **Clinical Rx** for full workflow coverage.';
  return MOCK_RESPONSES.default;
}

export function AIChatPanel({ onClose }: { onClose: () => void }) {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: MOCK_RESPONSES.default },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, loading]);

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;
    setMessages((m) => [...m, { role: 'user', content: trimmed }]);
    setInput('');
    setLoading(true);

    try {
      if (isApiConfigured()) {
        abortRef.current?.abort();
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        // Streaming: tokens appear as they are generated (fast model + short answers).
        // Append a placeholder bubble and fill it progressively.
        setMessages((m) => [...m, { role: 'assistant', content: '' }]);
        let gotFirst = false;
        try {
          await api.ai.chatStream(trimmed, (full) => {
            if (!gotFirst) { gotFirst = true; setLoading(false); }
            setMessages((m) => {
              const copy = [...m];
              copy[copy.length - 1] = { role: 'assistant', content: full };
              return copy;
            });
          }, ctrl.signal);
        } catch (streamErr: any) {
          if (streamErr?.name === 'AbortError') return;
          // Streaming unavailable → buffered endpoint, then local demo fallback
          setMessages((m) => m.slice(0, -1));
          try {
            const res = await api.ai.chat(trimmed, undefined, ctrl.signal);
            setMessages((m) => [...m, { role: 'assistant', content: res.response }]);
          } catch {
            setMessages((m) => [...m, { role: 'assistant', content: mockReply(trimmed) }]);
          }
        }
      } else {
        await new Promise((r) => setTimeout(r, 600));
        setMessages((m) => [...m, { role: 'assistant', content: mockReply(trimmed) }]);
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        setMessages((m) => [...m, { role: 'assistant', content: mockReply(trimmed) }]);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-[min(560px,70vh)] w-full max-w-md bg-rx-dark-secondary border border-white/10 rounded-2xl shadow-2xl overflow-hidden">
      {/* header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-rx-dark-tertiary/50">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-rx-yellow flex items-center justify-center">
            <Bot className="w-5 h-5 text-rx-dark" />
          </div>
          <div>
            <p className="text-sm font-semibold text-white flex items-center gap-1.5">
              RX Assistant <Sparkles className="w-3.5 h-3.5 text-rx-yellow" />
            </p>
            <p className="text-[11px] text-rx-gray-medium">
              {isApiConfigured() ? 'Connected' : 'Offline demo'} · powered by RX Store
            </p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 flex items-center justify-center text-rx-gray-medium hover:text-white transition-colors"
          aria-label="Close chat"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* messages */}
      <div ref={listRef} className="flex-1 overflow-y-auto p-4 space-y-4 bg-rx-dark">
        {messages.map((m, i) => (
          <div key={i} className={`flex gap-2.5 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {m.role === 'assistant' && (
              <div className="w-7 h-7 rounded-full bg-rx-yellow/15 border border-rx-yellow/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Bot className="w-3.5 h-3.5 text-rx-yellow" />
              </div>
            )}
            <div
              className={`max-w-[78%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                m.role === 'user'
                  ? 'bg-rx-yellow text-rx-dark font-medium rounded-br-md'
                  : 'bg-white/[0.06] border border-white/10 text-white rounded-bl-md'
              }`}
            >
              {m.content}
            </div>
            {m.role === 'user' && (
              <div className="w-7 h-7 rounded-full bg-white/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                <User className="w-3.5 h-3.5 text-white" />
              </div>
            )}
          </div>
        ))}
        {loading && (
          <div className="flex gap-2.5">
            <div className="w-7 h-7 rounded-full bg-rx-yellow/15 border border-rx-yellow/20 flex items-center justify-center">
              <Bot className="w-3.5 h-3.5 text-rx-yellow" />
            </div>
            <div className="bg-white/[0.06] border border-white/10 rounded-2xl rounded-bl-md px-3.5 py-2.5 flex items-center gap-2 text-sm text-rx-gray-medium">
              <Loader2 className="w-4 h-4 animate-spin" /> Thinking…
            </div>
          </div>
        )}
      </div>

      {/* suggestions */}
      <div className="px-4 pb-2 flex gap-1.5 flex-wrap">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => send(s)}
            className="text-[11px] px-2.5 py-1 rounded-full bg-white/5 hover:bg-rx-yellow/15 hover:text-rx-yellow border border-white/10 text-rx-gray-medium transition-colors"
          >
            {s}
          </button>
        ))}
      </div>

      {/* input */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="p-3 border-t border-white/10 flex gap-2 bg-rx-dark-secondary"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about apps, pricing, platforms…"
          className="flex-1 bg-rx-dark border border-white/10 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder:text-rx-gray-medium focus:outline-none focus:border-rx-yellow/40 focus:ring-2 focus:ring-rx-yellow/20"
        />
        <button
          type="submit"
          disabled={!input.trim() || loading}
          className="w-10 h-10 rounded-xl bg-rx-yellow hover:bg-rx-yellow-light disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center text-rx-dark transition-colors shrink-0"
          aria-label="Send"
        >
          <Send className="w-4 h-4" />
        </button>
      </form>
    </div>
  );
}

export function AIFloatingButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`fixed bottom-6 right-6 z-40 w-14 h-14 rounded-2xl shadow-lg flex items-center justify-center transition-all duration-200 ${
          open ? 'bg-white text-rx-dark rotate-90' : 'bg-rx-yellow text-rx-dark hover:shadow-glow hover:scale-105'
        }`}
        aria-label={open ? 'Close assistant' : 'Open RX Assistant'}
      >
        {open ? <X className="w-6 h-6" /> : <Bot className="w-6 h-6" />}
      </button>
      {open && (
        <div className="fixed bottom-24 right-6 z-40 w-[min(92vw,380px)] animate-scale-in">
          <AIChatPanel onClose={() => setOpen(false)} />
        </div>
      )}
    </>
  );
}
