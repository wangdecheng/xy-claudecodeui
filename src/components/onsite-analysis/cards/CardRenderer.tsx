/**
 * CardRenderer — parse AI message text for `<card type="...">` tags and
 * dispatch to the matching card component.
 *
 * Wire format expected from the AI:
 *   <card type="evidence" title="...">body</card>
 *   <card type="blocked" title="..." reason="...">body</card>
 *   <card type="root_cause" title="...">body</card>
 *   <card type="sql" title="...">body</card>
 *
 * Behavior:
 *  - Unknown card type → fall through to raw text.
 *  - No `<card>` tags → render plain text with SofteningTag highlights.
 *  - Multiple cards → render each in sequence, intersperse plain text.
 */

import { Fragment } from 'react';

import SofteningTag, { splitSoftening } from '../SofteningTag';
import BlockedCard from './BlockedCard';
import EvidenceCard from './EvidenceCard';
import RootCauseCard from './RootCauseCard';
import SqlCard from './SqlCard';

const CARD_REGEX = /<card\s+([^>]*?)\/?>([\s\S]*?)<\/card>|<card\s+([^>]*?)\/>/g;

function parseAttrs(attrText: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrText)) !== null) {
    if (m[1]) out[m[1]] = m[2] ?? '';
  }
  return out;
}

interface Segment {
  kind: 'text' | 'card';
  cardType?: string;
  attrs: Record<string, string>;
  text: string;
}

export function parseAiText(text: string): Segment[] {
  const segments: Segment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  CARD_REGEX.lastIndex = 0;
  while ((match = CARD_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: 'text', attrs: {}, text: text.slice(lastIndex, match.index) });
    }
    const attrPart = match[1] ?? match[3] ?? '';
    const body = match[2] ?? '';
    segments.push({
      kind: 'card',
      cardType: parseAttrs(attrPart).type,
      attrs: parseAttrs(attrPart),
      text: body,
    });
    lastIndex = CARD_REGEX.lastIndex;
  }
  if (lastIndex < text.length) {
    segments.push({ kind: 'text', attrs: {}, text: text.slice(lastIndex) });
  }
  return segments;
}

function renderText(text: string, keyPrefix: string) {
  return (
    <span key={keyPrefix}>
      {splitSoftening(text).map((seg, i) =>
        seg.soft ? (
          <SofteningTag key={`${keyPrefix}-${i}`} word={seg.text} />
        ) : (
          <span key={`${keyPrefix}-${i}`}>{seg.text}</span>
        ),
      )}
    </span>
  );
}

function renderCard(seg: Segment, key: string) {
  const title = seg.attrs.title;
  switch (seg.cardType) {
    case 'evidence':
      return <EvidenceCard key={key} {...(title ? { title } : {})} body={seg.text} />;
    case 'blocked':
      return (
        <BlockedCard
          key={key}
          {...(title ? { title } : {})}
          {...(seg.attrs.reason ? { reason: seg.attrs.reason } : {})}
        />
      );
    case 'root_cause':
      return <RootCauseCard key={key} {...(title ? { title } : {})} body={seg.text} />;
    case 'sql':
      return <SqlCard key={key} {...(title ? { title } : {})} body={seg.text} />;
    default:
      // Unknown card type — render the original markup as plain text
      // (with softening highlight) so we never silently drop content.
      return renderText(`<card ${JSON.stringify(seg.attrs)}>${seg.text}</card>`, key);
  }
}

export interface CardRendererProps {
  text: string;
}

export default function CardRenderer({ text }: CardRendererProps) {
  const segments = parseAiText(text);
  return (
    <>
      {segments.map((seg, i) => {
        const key = `seg-${i}`;
        if (seg.kind === 'card') return renderCard(seg, key);
        return <Fragment key={key}>{renderText(seg.text, key)}</Fragment>;
      })}
    </>
  );
}