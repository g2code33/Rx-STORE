import React from 'react';
import { Link } from 'react-router-dom';
import { Check, Megaphone } from 'lucide-react';
import { useContent } from '../../context/ContentContext';
import { IntroAd, trackAd, sanitizeAccent } from '../home/introAds';
import Editable from './Editable';

/**
 * Page Blocks — sections the admin inserts via the Live Builder's Add button.
 * Stored per page under `page.blocks.<pageId>` as a JSON array; this component
 * renders them at the bottom of the page for VISITORS (styled like the rest of
 * the site), and in Builder edit mode the whole region is outlined and opens
 * the blocks editor in the Inspector.
 */

export type BlockType = 'cta' | 'text' | 'features' | 'image' | 'adBanner';

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
  /** cta — #RRGGBB tint for the border, glow and button */
  accent?: string;
  /** image */
  imageUrl?: string;
  imageAlt?: string;
  /** features — edited as lines "Title | Description | emoji" */
  items?: { icon?: string; title: string; description: string }[];
  /** adBanner — which intro ad to show; '' rotates through them */
  adId?: string;
}

export const BLOCK_TYPE_LABELS: Record<BlockType, string> = {
  cta: 'CTA banner',
  text: 'Text section',
  features: 'Feature grid',
  image: 'Image banner',
  adBanner: 'Sponsored banner',
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
    case 'adBanner':
      return { ...base, adId: '' };
  }
}

/** Internal links use the router; external open in a new tab. */
function BlockLink({ to, className, style, onClick, children }: { to: string; className?: string; style?: React.CSSProperties; onClick?: () => void; children: React.ReactNode }) {
  if (/^https?:\/\//.test(to)) return <a href={to} target="_blank" rel="noreferrer" className={className} style={style} onClick={onClick}>{children}</a>;
  return <Link to={to || '/'} className={className} style={style} onClick={onClick}>{children}</Link>;
}

/** Compact sponsored banner — reuses the intro-ad creatives (Builder → Ads). */
function AdBannerView({ block }: { block: PageBlock }) {
  const { getJSON, ready } = useContent();
  const ads = getJSON<IntroAd[]>('intro.ads', []);
  const active = (Array.isArray(ads) ? ads : []).filter((a) => a && a.enabled && a.title?.trim());
  let ad: IntroAd | undefined;
  if (block.adId) ad = active.find((a) => a.id === block.adId);
  else if (active.length) {
    // Stable per-block rotation — different banners on a page show different ads
    let h = 0;
    for (const ch of block.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    ad = active[h % active.length];
  }
  const accent = sanitizeAccent(ad?.accent);
  const viewed = React.useRef(false);
  React.useEffect(() => {
    if (ready && ad && !viewed.current) { viewed.current = true; trackAd(ad.id, 'views'); }
  }, [ready, ad?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ad) {
    return (
      <div className="rounded-2xl border border-dashed border-white/15 bg-rx-dark-secondary/50 px-6 py-8 text-center text-sm text-rx-gray-medium">
        📣 Sponsored banner — publish an ad in Builder → Ads and it appears here.
      </div>
    );
  }

  return (
    <div className="relative rounded-2xl border bg-rx-dark-secondary/70 backdrop-blur-sm overflow-hidden" style={{ borderColor: `${accent}40` }}>
      <span className="absolute top-3 right-3 text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full" style={{ background: `${accent}1F`, color: accent }}>
        Ad
      </span>
      <div className="flex items-center gap-4 sm:gap-5 p-4 sm:p-5">
        {ad.imageUrl ? (
          <img
            src={ad.imageUrl}
            alt={ad.title}
            loading="lazy"
            className="w-16 h-16 sm:w-20 sm:h-20 rounded-xl object-cover flex-shrink-0 border border-white/10"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
          />
        ) : (
          <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-xl flex items-center justify-center flex-shrink-0 border border-white/10" style={{ background: `${accent}14` }}>
            <Megaphone className="w-6 h-6" style={{ color: accent }} />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: accent }}>
            Sponsored{ad.sponsor ? ` · ${ad.sponsor}` : ''}
          </p>
          <h3 className="text-base sm:text-lg font-bold text-white mt-0.5 truncate">{ad.title}</h3>
          {ad.body && <p className="text-xs sm:text-sm text-rx-gray-medium mt-0.5 line-clamp-1">{ad.body}</p>}
        </div>
        {ad.buttonLabel && (
          <BlockLink
            to={ad.buttonTo || '/'}
            className="flex-shrink-0 text-xs sm:text-sm font-bold rounded-xl px-4 py-2.5 transition-transform active:scale-95 hover:brightness-110"
            style={{ background: accent, color: '#0F1419' }}
            onClick={() => trackAd(ad.id, 'clicks')}
          >
            {ad.buttonLabel}
          </BlockLink>
        )}
      </div>
    </div>
  );
}

function BlockView({ block }: { block: PageBlock }) {
  switch (block.type) {
    case 'cta': {
      const accent = block.accent && /^#[0-9a-f]{6}$/i.test(block.accent) ? block.accent : null;
      return (
        <div
          className="relative overflow-hidden rounded-3xl border bg-gradient-to-br from-rx-dark-secondary to-rx-dark px-6 py-14 text-center"
          style={accent ? { borderColor: `${accent}4D`, boxShadow: `0 24px 80px -32px ${accent}55` } : { borderColor: 'rgba(255,214,0,0.2)' }}
        >
          <div className="absolute -top-16 left-1/4 w-72 h-72 rounded-full blur-3xl pointer-events-none" style={{ background: accent ? `${accent}1A` : 'rgba(255,214,0,0.1)' }} />
          <div className="relative">
            {block.icon && <div className="text-5xl mb-4">{block.icon}</div>}
            <h2 className="text-2xl sm:text-3xl font-bold text-white">{block.title}</h2>
            {block.body && <p className="mt-3 text-rx-gray-medium max-w-2xl mx-auto whitespace-pre-line">{block.body}</p>}
            {block.buttonLabel && (
              <BlockLink
                to={block.buttonTo || '/'}
                className={`${accent ? 'font-bold text-rx-dark hover:brightness-110' : 'btn-primary'} inline-flex items-center gap-2 mt-7 rounded-xl px-6 py-3 transition-all active:scale-95`}
                style={accent ? { background: accent } : undefined}
              >
                {block.buttonLabel}
              </BlockLink>
            )}
          </div>
        </div>
      );
    }
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
    case 'adBanner':
      return <AdBannerView block={block} />;
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
