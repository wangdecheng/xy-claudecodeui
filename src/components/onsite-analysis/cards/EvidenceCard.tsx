/**
 * EvidenceCard — 🔍 evidence / proof rendering (对齐原型 .card.evidence + .logquote)。
 *
 * CardRenderer dispatches here when `<card type="evidence">` is found.
 * body 以 logquote 样式渲染,三色高亮(REQ-4.10):
 *   - err (红色): 命中 0 计数 / 无结果 / 未找到
 *   - hl  (琥珀加粗): 关键字 / 注释行 (# 起头 / 已穷尽 / 关键 / 范围)
 *   - ok  (绿色): 命中 ≥1 的成功行 (路径:N / matches:N / 命中 N 条)
 * 底部提供复制按钮。
 */

import { Fragment } from 'react';

import { CardFoot, CopyButton } from './CardFoot';

export interface EvidenceCardProps {
  title?: string;
  body?: string;
}

// err: 命中 0 计数 / 无结果 语义的片段 → 标红
const ZERO_HIT = /(\bcount\s*=\s*0\b|:\s*0(?=\s|$)|\b0\s*(?:结果|命中|matches?)\b|没有结果|无命中|未找到|no matches)/gi;
// hl: 关键字 / 注释行(以 # 起头,或含 已穷尽 / 关键 / 范围) → 琥珀加粗
const HL_HIT = /(?:^|\s)(#\s.*|已穷尽候选.*|.*关键.*|.*范围.*)/g;
// ok: 命中 ≥1 的成功行(路径: N / matches: N / 命中 N 条) → 绿
const OK_HIT = /(:\s+[1-9]\d*\s*$|\bmatches?:\s*\d+\b|\bhit:\s*\d+\b|命中\s*[1-9]\d*\s*条)/gi;

type SpanKind = 'err' | 'hl' | 'ok' | 'plain';

function renderLineWithSpans(line: string, key: string): React.ReactNode[] {
  type Hit = { start: number; end: number; kind: SpanKind };
  const hits: Hit[] = [];

  const collect = (re: RegExp, kind: SpanKind) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      // 对 HL_HIT 我们希望保留整个匹配(含前导空白),用 m.index 即可
      hits.push({ start: m.index, end: m.index + m[0].length, kind });
    }
  };
  collect(ZERO_HIT, 'err');
  collect(HL_HIT, 'hl');
  collect(OK_HIT, 'ok');

  if (hits.length === 0) return [line || ' '];

  // 按 start 排序;重叠时优先级 err > hl > ok
  const priority: Record<SpanKind, number> = { err: 3, hl: 2, ok: 1, plain: 0 };
  hits.sort((a, b) => a.start - b.start || priority[b.kind] - priority[a.kind]);

  // 移除被高优先级覆盖的子区间
  const filtered: Hit[] = [];
  let cursor = 0;
  for (const h of hits) {
    if (h.start >= cursor) {
      filtered.push(h);
      cursor = h.end;
    }
  }

  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const h of filtered) {
    if (h.start > last) parts.push(<Fragment key={`${key}-t${last}`}>{line.slice(last, h.start)}</Fragment>);
    const cls =
      h.kind === 'err'
        ? 'font-semibold text-red-600 dark:text-red-400'
        : h.kind === 'hl'
          ? 'font-semibold text-amber-700 dark:text-amber-300'
          : 'font-semibold text-green-700 dark:text-green-400';
    parts.push(
      <span key={`${key}-${h.kind}-${h.start}`} className={cls}>
        {line.slice(h.start, h.end)}
      </span>,
    );
    last = h.end;
  }
  if (last < line.length) parts.push(<Fragment key={`${key}-e`}>{line.slice(last)}</Fragment>);
  return parts;
}

function renderLogLine(line: string, key: string) {
  const parts = renderLineWithSpans(line, key);
  return <div key={key}>{parts.length ? parts : line || ' '}</div>;
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
