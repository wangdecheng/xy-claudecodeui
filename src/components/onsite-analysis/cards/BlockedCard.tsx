/**
 * BlockedCard — ⛔ blocked / waiting-on-human rendering (对齐原型 .card.blocked)。
 *
 * CardRenderer dispatches here when `<card type="blocked">` is found.
 * body 按行渲染为编号阻塞清单(对齐原型 .blocklist:一次只补一件最关键的);
 * 底部提供「复制给现场的话术」与「补日志后重跑分析」。
 */

import { CardFoot, CopyButton, RerunButton } from './CardFoot';

export interface BlockedCardProps {
  title?: string;
  reason?: string;
  body?: string;
  onRerun?: (hint: string) => void;
}

/** 把 body 拆成清单项:优先按已有编号(1. / 1、)切,否则按非空行切。 */
function toItems(body: string): string[] {
  const trimmed = body.trim();
  if (!trimmed) return [];
  const numbered = trimmed.split(/\n(?=\s*\d+[.、)])/).map((s) => s.trim()).filter(Boolean);
  if (numbered.length > 1) return numbered.map((s) => s.replace(/^\s*\d+[.、)]\s*/, ''));
  return trimmed.split(/\n+/).map((s) => s.trim()).filter(Boolean);
}

export default function BlockedCard({ title, reason, body, onRerun }: BlockedCardProps) {
  const items = body ? toItems(body) : [];
  const copyText = [reason, body].filter(Boolean).join('\n');

  return (
    <div
      data-testid="onsite-card-blocked"
      className="my-1 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200"
    >
      <div className="mb-1 flex items-center gap-1 font-semibold">
        <span aria-hidden="true">⛔</span>
        <span>{title ?? 'Blocked'}</span>
      </div>
      {reason && <p className="text-[11px]">{reason}</p>}
      {items.length > 0 && (
        <ol data-testid="onsite-blocklist" className="mt-1.5 flex flex-col gap-1.5">
          {items.map((it, i) => (
            <li key={i} className="flex gap-2">
              <span className="mt-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-amber-400/30 text-[10px] font-bold">
                {i + 1}
              </span>
              <span className="whitespace-pre-wrap text-[11px] leading-relaxed">{it}</span>
            </li>
          ))}
        </ol>
      )}
      {(copyText || onRerun) && (
        <CardFoot>
          {copyText && <CopyButton text={copyText} label="复制给现场的话术" />}
          {onRerun && <RerunButton onRerun={onRerun} hint="已补充日志，请重跑分析：重新对全部候选子目录 grep traceId 并记录命中条数。" />}
        </CardFoot>
      )}
    </div>
  );
}
