/**
 * EvidenceCard — 🔍 evidence / proof rendering (对齐原型 .card.evidence + .logquote)。
 *
 * CardRenderer dispatches here when `<card type="evidence">` is found.
 * body 以 logquote 样式渲染:命中计数为 0 的片段(`0` / `count=0` / `没有结果`)标红,
 * 便于一眼看出 traceId 全目录 0 命中。底部提供复制按钮。
 */

import { Fragment } from 'react';

import { CardFoot, CopyButton } from './CardFoot';

export interface EvidenceCardProps {
  title?: string;
  body?: string;
}

// 命中“0 计数 / 无结果”语义的片段 → 标红;其余原样。
const ZERO_HIT = /(\bcount\s*=\s*0\b|:\s*0(?=\s|$)|\b0\s*(?:结果|命中|matches?)\b|没有结果|无命中|未找到|no matches)/gi;

function renderLogLine(line: string, key: string) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  ZERO_HIT.lastIndex = 0;
  while ((m = ZERO_HIT.exec(line)) !== null) {
    if (m.index > last) parts.push(<Fragment key={`${key}-t${last}`}>{line.slice(last, m.index)}</Fragment>);
    parts.push(
      <span key={`${key}-h${m.index}`} className="font-semibold text-red-600 dark:text-red-400">
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < line.length) parts.push(<Fragment key={`${key}-e`}>{line.slice(last)}</Fragment>);
  return <div key={key}>{parts.length ? parts : line || ' '}</div>;
}

export default function EvidenceCard({ title, body }: EvidenceCardProps) {
  return (
    <div
      data-testid="onsite-card-evidence"
      className="my-1 rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-xs text-gray-800 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-200"
    >
      <div className="mb-1 flex items-center gap-1 font-semibold">
        <span aria-hidden="true">🔍</span>
        <span>{title ?? 'Evidence'}</span>
      </div>
      {body && (
        <>
          <pre
            data-testid="onsite-logquote"
            className="overflow-x-auto whitespace-pre rounded bg-black/5 p-2 font-mono text-[11px] leading-relaxed dark:bg-black/30"
          >
            {body.split('\n').map((line, i) => renderLogLine(line, `l${i}`))}
          </pre>
          <CardFoot>
            <CopyButton text={body} />
          </CardFoot>
        </>
      )}
    </div>
  );
}
