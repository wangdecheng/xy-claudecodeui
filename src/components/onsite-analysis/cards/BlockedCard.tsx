/**
 * BlockedCard — ⛔ blocked / waiting-on-human rendering.
 *
 * CardRenderer dispatches here when `<card type="blocked">` is found.
 */

export interface BlockedCardProps {
  title?: string;
  reason?: string;
}

export default function BlockedCard({ title, reason }: BlockedCardProps) {
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
    </div>
  );
}