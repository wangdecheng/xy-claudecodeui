/**
 * AnalysisInfoChips — 分析头的上下文 chip 行(对齐原型 .ah-info)。
 *
 * 渲染 客户 / 迭代 / 数据库 / third-bridge 分支 四个 chip,数据来自 ProblemRecord。
 * 规则(对齐原型):
 *  - database 为空且 status==='pending_info' → 该 chip 用琥珀「缺:数据库类型」样式;
 *  - third_bridge_branch===null(其他问题) → 隐藏分支 chip。
 */

import type { ProblemRecord } from '@shared/onsite-types';

import { cn } from '../../lib/utils';

export interface AnalysisInfoChipsProps {
  problem: ProblemRecord;
}

function Chip({
  k,
  v,
}: {
  k: string;
  v: string;
}) {
  return (
    <span
      data-testid={`onsite-info-chip-${k}`}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px]',
        'border-border bg-secondary text-foreground',
      )}
    >
      <span className="text-muted-foreground">{k}</span>
      <span className="font-medium">{v}</span>
    </span>
  );
}

export default function AnalysisInfoChips({ problem }: AnalysisInfoChipsProps) {
  // 客户首项「其他问题」时,third_bridge_branch 为 null,直接不渲染该 chip
  const hideThirdBridge = problem.third_bridge_branch === null;

  return (
    <div data-testid="onsite-info-chips" className="flex flex-wrap items-center gap-1.5">
      <Chip k="客户" v={problem.customer || '—'} />
      <Chip k="迭代" v={problem.iteration || '—'} />
      <Chip k="数据库" v={problem.database || '—'} />
      {!hideThirdBridge && (
        <Chip k="third-bridge 分支" v={problem.third_bridge_branch as string} />
      )}
    </div>
  );
}
