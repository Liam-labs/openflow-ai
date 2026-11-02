import type { LucideIcon } from 'lucide-react';
import { BRAND_PATHS } from './brand-icons';

/** The tile on every Set up more card and modal: the product's mark when we have one, otherwise a glyph for what it does. */
export function Logo({ brand, Glyph, size = 'md' }: { brand?: string; Glyph: LucideIcon; size?: 'md' | 'lg' }) {
  const path = brand ? BRAND_PATHS[brand] : undefined;
  return (
    <span className={`sc-logo${size === 'lg' ? ' sc-logo--lg' : ''}`} aria-hidden="true">
      {path ? <svg viewBox="0 0 24 24" fill="currentColor"><path d={path} /></svg> : <Glyph strokeWidth={1.6} />}
    </span>
  );
}
