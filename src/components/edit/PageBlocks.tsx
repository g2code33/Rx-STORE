import React from 'react';
import { Link } from 'react-router-dom';
import { Check } from 'lucide-react';
import { useContent } from '../../context/ContentContext';
import Editable from './Editable';

/**
 * Page Blocks — sections the admin inserts via the Live Builder's Add button.
 * Stored per page under `page.blocks.<pageId>` as a JSON array; this component
 * renders them at the bottom of the page for VISITORS (styled like the rest of
 * the site), and in Builder edit mode the whole region is outlined and opens
 * the blocks editor in the Inspector.
 */

export type BlockType = 'cta' | 'text' | 'features' | 'image';

export interface PageBlock {
  id: string;
  type: BlockType;
  /** shared */
  title?: string;
  /** cta + text */
  body?: string;
  /** cta */
  icon?: string;
  buttonLabel?: string;
  buttonTo?: string;
  /** image */
  imageUrl?: string;
  imageAlt?: string;
  /** features — edited as lines "Title | Description | emoji" */
  items?: { icon?: string; title: string; description: string }[];
}

export const BLOCK_TYPE_LABELS: Record<BlockType, string> = {
  cta: 'CTA banner',
  text: 'Text section',
  features: 'Feature grid',
  image: 'Image banner',
};

export function newBlock(type: BlockType): PageBlock {
  const base = { id: `blk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, type };
  switch (type) {
    case 'cta':
      return { ...base, icon: '🚀', title: 'Ready to get started?', body: 'Everything you need, one click away.', buttonLabel: 'Explore Applications', buttonTo: '/browse' };
    case 'text':
      return { ...base, title: 'New section', body: 'Write the story of this section here.\n\nUse blank lines to separate paragraphs.' };
    case 'features':
      return { ...base, title: 'Why it matters', items: [
        { icon: '✅', title: 'First highlight', description: 'A short reason this matters.' },
        { icon: '⚡', title: 'Second highlight', description: 'Another benefit for visitors.' },
        { icon: '🛡️', title: 'Third highlight', description: 'Trust, safety, quality — you name it.' },
      ] };
    case 'image':
      return { ...base, title: '', imageUrl: '', imageAlt: 'Section image' };
  }
}

/** Internal links use the router; external open in a new tab. */
function BlockLink({ to, className, children }: { to: string; className?: string; children: React.ReactNode }) {
  if (/^https?:\/\//.test(to)) return <a href={to} target="_blank" rel="noreferrer" className={className}>{children}</a>;
  return <Link to={to || '/'} className={className}>{children}</Link>;
}

function BlockView({ block }: { block: PageBlock }) {
  switch (block.type) {
    case 'cta':
      return (
        <div className="relative overflow-hidden rounded-3xl border border-rx-yellow/20 bg-gradient-to-br from-rx-dark-secondary to-rx-dark px-6 py-14 text-center">
          <div className="absolute -top-16 left-1/4 w-72 h-72 bg-rx-yellow/10 rounded-full blur-3xl pointer-events-none" />
          <div className="relative">
            {block.icon && <div className="text-5xl mb-4">{block.icon}</div>}
            <h2 className="text-2xl sm:text-3xl font-bold text-white">{block.title}</h2>
            {block.body && <p className="mt-3 text-rx-gray-medium max-w-2xl mx-auto whitespace-pre-line">{block.body}</p>}
            {block.buttonLabel && (
              <BlockLink to={block.buttonTo || '/'} className="btn-primary inline-flex items-center gap-2 mt-7">
                {block.buttonLabel}
              </BlockLink>
            )}
          </div>
        </div>
      );
    case 'text':
      return (
        <div className="max-w-3xl mx-auto">
          {block.title && <h2 className="text-2xl sm:text-3xl font-bold text-white mb-5">{block.title}</h2>}
          {(block.body || '').split(/\n\s*\n/).filter(Boolean).map((p, i) => (
            <p key={i} className="text-rx-gray-medium leading-relaxed mb-4 whitespace-pre-line">{p}</p>
          ))}
        </div>
      );
    case 'features':
      return (
        <div>
          {block.title && <h2 className="text-2xl sm:text-3xl font-bold text-white mb-8 text-center">{block.title}</h2>}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {(block.items || []).map((it, i) => (
              <div key={i} className="card p-5 hover:border-rx-yellow/30 transition-colors">
                <div className="text-2xl mb-3">{it.icon || <Check className="w-5 h-5 text-rx-yellow" />}</div>
                <h3 className="font-semibold text-white mb-1.5">{it.title}</h3>
                {it.description && <p className="text-sm text-rx-gray-medium leading-relaxed">{it.description}</p>}
              </div>
            ))}
          </div>
        </div>
      );
    case 'image':
      return (
        <figure>
          {block.imageUrl ? (
            <img src={block.imageUrl} alt={block.imageAlt || ''} loading="lazy" className="w-full max-h-[440px] object-cover rounded-3xl border border-white/10" />
          ) : (
            <div className="w-full h-56 rounded-3xl border border-dashed border-white/15 bg-rx-dark-secondary/60 flex items-center justify-center text-rx-gray-medium text-sm">
              🖼️ Image banner — set an image in the block editor
            </div>
          )}
          {block.title && <figcaption className="mt-3 text-center text-sm text-rx-gray-medium">{block.title}</figcaption>}
        </figure>
      );
  }
}

export default function PageBlocks({ pageId, inContainer = false }: { pageId: string; inContainer?: boolean }) {
  const { getJSON } = useContent();
  const key = `page.blocks.${pageId}`;
  const blocks = getJSON<PageBlock[]>(key, []);
  const list = Array.isArray(blocks) ? blocks.filter((b) => b && BLOCK_TYPE_LABELS[b.type]) : [];
  if (!list.length) return null; // nothing inserted yet — invisible for visitors AND editing happens from the Add button

  return (
    <section className={`${inContainer ? 'pt-14' : 'section-container pb-16'} space-y-12`}>
      <Editable id={key} type="blocks" label={`Custom blocks · ${pageId}`} group>
        <div className="space-y-12">
          {list.map((b) => (
            <BlockView key={b.id} block={b} />
          ))}
        </div>
      </Editable>
    </section>
  );
}
