import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

export interface LegalSection {
  heading: string;
  /** Paragraphs; wrap inline code-like text (emails) in backticks for styling. */
  body: string[];
}

/** Renders `backtick` segments as inline code chips (used for contact emails). */
function RichText({ text }: { text: string }) {
  const parts = text.split('`');
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <code key={i} className="px-1.5 py-0.5 bg-white/10 rounded text-rx-yellow text-[13px]">{p}</code>
        ) : (
          <React.Fragment key={i}>{p}</React.Fragment>
        )
      )}
    </>
  );
}

export default function LegalDoc({ title, updated, intro, sections }: { title: string; updated: string; intro: string; sections: LegalSection[] }) {
  return (
    <div className="min-h-screen">
      <section className="relative overflow-hidden py-16 lg:py-20">
        <div className="absolute inset-0 bg-gradient-hero" />
        <div className="absolute top-1/4 left-1/3 w-96 h-96 bg-rx-yellow/5 rounded-full blur-3xl" />
        <div className="relative section-container max-w-3xl">
          <Link to="/" className="inline-flex items-center gap-2 text-sm text-rx-gray-medium hover:text-white mb-6 transition-colors">
            <ArrowLeft className="w-4 h-4" /> Back to RX Store
          </Link>
          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-black text-white">{title}</h1>
          <p className="mt-3 text-xs uppercase tracking-wider text-rx-yellow font-semibold">Last Updated: {updated}</p>
          <p className="mt-5 text-rx-gray-medium leading-relaxed">{intro}</p>
        </div>
      </section>

      <section className="section-container max-w-3xl pb-20">
        <div className="space-y-10">
          {sections.map((s) => (
            <div key={s.heading}>
              <h2 className="text-xl font-bold text-white mb-3">{s.heading}</h2>
              <div className="space-y-3">
                {s.body.map((p, i) => (
                  <p key={i} className="text-sm text-rx-gray-medium leading-relaxed whitespace-pre-line">
                    <RichText text={p} />
                  </p>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-14 pt-8 border-t border-white/5 flex flex-wrap items-center gap-4 text-xs text-rx-gray-medium">
          <span>Related:</span>
          <Link to="/privacy" className="text-rx-yellow hover:underline">Privacy Policy</Link>
          <Link to="/terms" className="text-rx-yellow hover:underline">Terms of Service</Link>
          <Link to="/about" className="text-rx-yellow hover:underline">About Calcitonin</Link>
        </div>
      </section>
    </div>
  );
}
