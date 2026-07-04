/**
 * RootCauseCard — ✅ confirmed root-cause rendering.
 *
 * CardRenderer dispatches here when `<card type="root_cause">` is found.
 *
 * If the incoming `body` contains softening words (e.g. 可能 / maybe),
 * the server-side middleware would have already rejected the confirm.
 * But defensively, we still let SofteningTag highlight any residual
 * softening words in the visible body.
 */

import SofteningTag, { splitSoftening } from '../SofteningTag';

export interface RootCauseCardProps {
  title?: string;
  body?: string;
}

export default function RootCauseCard({ title, body }: RootCauseCardProps) {
  return (
    <div
      data-testid="onsite-card-root-cause"
      className="my-1 rounded-md border border-green-300 bg-green-50 px-3 py-2 text-xs text-green-900 dark:border-green-700 dark:bg-green-900/20 dark:text-green-200"
    >
      <div className="mb-1 flex items-center gap-1 font-semibold">
        <span aria-hidden="true">✅</span>
        <span>{title ?? 'Root cause'}</span>
      </div>
      {body && (
        <p className="whitespace-pre-wrap text-[11px] leading-relaxed">
          {splitSoftening(body).map((seg, i) =>
            seg.soft ? (
              <SofteningTag key={i} word={seg.text} />
            ) : (
              <span key={i}>{seg.text}</span>
            ),
          )}
        </p>
      )}
    </div>
  );
}