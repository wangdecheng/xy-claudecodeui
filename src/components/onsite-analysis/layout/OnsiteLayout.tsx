/**
 * OnsiteLayout — placeholder for Batch 6.
 *
 * Batch 7 replaces this with the real layout: IssueListSidebar on the left,
 * NewIssueWizard, OnsiteChatStream, and the four cards (Evidence /
 * Blocked / RootCause / Sql). For now we render a stable container so the
 * `/onsite` and `/onsite/:problemId` routes resolve without crashing.
 *
 * Contract markers: a `data-testid` is provided so smoke / e2e tests can
 * confirm the placeholder is mounted, and so Batch 7's selector stays
 * stable across the swap.
 */

import { useParams } from 'react-router-dom';

export default function OnsiteLayout() {
  const { problemId } = useParams<{ problemId?: string }>();

  return (
    <div
      data-testid="onsite-layout-placeholder"
      className="flex h-full w-full items-center justify-center bg-background text-muted-foreground"
    >
      <div className="max-w-md rounded-lg border border-dashed border-border bg-card p-6 text-center">
        <h2 className="text-lg font-semibold text-foreground">客户现场分析 / Customer Onsite Analysis</h2>
        <p className="mt-2 text-sm">
          {problemId
            ? `Batch 7 placeholder — problem: ${problemId}`
            : 'Batch 7 placeholder — no problem selected'}
        </p>
        <p className="mt-1 text-xs opacity-70">布局由 Batch 7 接管 (Issue list + chat + cards)</p>
      </div>
    </div>
  );
}