/**
 * OnsiteLayout — real layout for the Customer Onsite Analysis feature
 * (Batch 7). Replaces the Batch 6 placeholder.
 *
 * Structure:
 *   ┌─ IssueListSidebar (300px) ─┬─ main: <OnsiteChatStream /> or empty ─┐
 *
 * Routes:
 *   /onsite                  → no problem selected
 *   /onsite/:problemId       → chat for that problem
 *
 * The layout does NOT mount <OnsiteWebSocketProvider /> — that lives at the
 * App root (App.tsx) so a single socket is shared across navigation.
 *
 * Viewport 锚定: 用 `fixed inset-0`(同 AppContent),让容器直接吃满视口。
 * 原因:`/onsite/*` 由 React Router 直接 mount 为 route element,父链是
 * `#root`(`min-h-100vh`,无固定 height)。若外层用 `h-full`,flex 子链
 * `OnsiteChatStream` 的 `h-full flex-col` 解析不到确定高度,scroll 容器
 * `flex-1 overflow-y-auto` 的 min-content(子消息列表)会撑爆整个布局
 * 到几万 px。`fixed inset-0` 直接锚到视口,这一支 flex 链就有确定高度。
 */

import { useParams } from 'react-router-dom';

import IssueListSidebar from '../IssueListSidebar';
import OnsiteChatStream from '../OnsiteChatStream';

export default function OnsiteLayout() {
  const { problemId } = useParams<{ problemId?: string }>();

  return (
    <div
      data-testid="onsite-layout"
      className="fixed inset-0 flex bg-background text-foreground"
    >
      <IssueListSidebar currentProblemId={problemId ?? null} />
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden" data-testid="onsite-main">
        {problemId ? (
          <OnsiteChatStream key={problemId} problemId={problemId} />
        ) : (
          <div className="flex h-full items-center justify-center p-6">
            <div className="max-w-md rounded-lg border border-dashed border-border bg-card p-6 text-center">
              <h2 className="text-lg font-semibold">🔍 {problemId ? problemId : 'No problem selected'}</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                从左侧选择一个客户现场问题,或点击「+」新建。
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}