/**
 * AnalysisInfoChips — 分析头的上下文 chip 行(对齐原型 .ah-info)。
 *
 * 渲染 客户 / 迭代 / 数据库 / third-bridge 分支 四个 chip,数据来自 ProblemRecord。
 * 规则(对齐原型):
 *  - database 为空且 status==='pending_info' → 该 chip 用琥珀「缺:数据库类型」样式;
 *  - third_bridge_branch===null(不涉及三方对接) → 隐藏分支 chip。
 */

import type { ProblemRecord } from '@shared/onsite-types';

import { cn } from '../../lib/utils';

export interface AnalysisInfoChipsProps {
  problem: ProblemRecord;
}

function Chip({
  k,
  v,
  missing = false,
}: {
  k: string;
  v: string;
  missing?: boolean;
}) {
  return (
    <span
      data-testid={`onsite-info-chip-${k}`}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px]',
        missing
          ? 'border-amber-400/50 bg-amber-100/60 text-amber-800 dark:border-amber-600/50 dark:bg-amber-900/20 dark:text-amber-200'
          : 'border-border bg-secondary text-foreground',
      )}
    >
      <span className="text-muted-foreground">{k}</span>
      <span className="font-medium">{v}</span>
    </span>
  );
}

export default function AnalysisInfoChips({ problem }: AnalysisInfoChipsProps) {
  const databaseMissing = !problem.database && problem.status === 'pending_info';
  // 客户首项「不涉及三方对接」时,third_bridge_branch 为 null,直接不渲染该 chip
  const hideThirdBridge = problem.third_bridge_branch === null;

  return (
    <div data-testid="onsite-info-chips" className="flex flex-wrap items-center gap-1.5">
      <Chip k="客户" v={problem.customer || '—'} />
      <Chip k="迭代" v={problem.iteration || '—'} />
      {databaseMissing ? (
        <Chip k="数据库" v="缺：数据库类型" missing />
      ) : (
        <Chip k="数据库" v={problem.database || '—'} />
      )}
      {!hideThirdBridge && (
        <Chip k="third-bridge 分支" v={problem.third_bridge_branch as string} />
      )}
    </div>
  );
}
