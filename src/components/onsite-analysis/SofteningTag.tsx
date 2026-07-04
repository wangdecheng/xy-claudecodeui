/**
 * SofteningTag — inline amber wavy-underline span that wraps a single
 * softening word (可能 / 也许 / 大概 / might / maybe / perhaps / seems / ...).
 *
 * Detection modes (per brief, both allowed in Batch 7):
 *   1) Envelope-driven: server's discipline middleware already wrapped
 *      the word in `<softening word="X" position="N"/>` — the CardRenderer
 *      uses replaceForUi and splits there; SofteningTag renders each hit.
 *   2) Client-fallback: when the envelope flag is missing, scan the
 *      text locally with the same word list (loaded lazily via a small
 *      fetch to /api/onsite/config endpoint is NOT possible — word list
 *      lives in config/discipline-words.json which is server-only).
 *      For client fallback we use a small built-in list mirroring the
 *      server's English+Chinese subset; this is best-effort and the
 *      envelope path takes priority.
 *
 * Visual:
 *   - amber-500 color, wavy underline (CSS `text-decoration-style: wavy`)
 *   - tooltip via title attribute showing the discipline copy
 */

import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/utils';

// Mirror subset of server config/discipline-words.json — keep in sync
// when adding new server words. This is only used when the server-side
// envelope doesn't carry the `discipline.softening` flag.
const CLIENT_FALLBACK_WORDS = [
  '可能', '也许', '大概', '似乎', '或许',
  'might', 'maybe', 'perhaps', 'possibly', 'seems', 'appears',
];

export interface SofteningTagProps {
  word: string;
  className?: string;
}

/** True if the word is a known softening word (case-insensitive). */
export function isSofteningWord(word: string): boolean {
  const lower = word.toLowerCase();
  return CLIENT_FALLBACK_WORDS.some((w) => w.toLowerCase() === lower);
}

/** Split a piece of text into alternating plain / softening segments. */
export function splitSoftening(text: string): Array<{ text: string; soft: boolean }> {
  if (!text) return [];
  const segs: Array<{ text: string; soft: boolean }> = [];
  const regex = new RegExp(
    `(${CLIENT_FALLBACK_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
    'gi',
  );
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segs.push({ text: text.slice(lastIndex, match.index), soft: false });
    }
    segs.push({ text: match[0], soft: true });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    segs.push({ text: text.slice(lastIndex), soft: false });
  }
  return segs;
}

export default function SofteningTag({ word, className }: SofteningTagProps) {
  const { t } = useTranslation(['onsite']);
  return (
    <span
      data-testid="onsite-softening-tag"
      title={t('onsite:discipline.softeningTag')}
      className={cn(
        'inline font-medium text-amber-600 dark:text-amber-400',
        className,
      )}
      style={{
        textDecoration: 'underline',
        textDecorationStyle: 'wavy',
        textDecorationColor: 'currentColor',
        textUnderlineOffset: '3px',
      }}
    >
      {word}
    </span>
  );
}