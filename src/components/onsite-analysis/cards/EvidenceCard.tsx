/**
 * EvidenceCard — 🔍 evidence / proof rendering.
 *
 * Used for AI messages that present supporting evidence (logs, sql
 * fragments, screenshots references). CardRenderer dispatches here
 * when `<card type="evidence">` is found.
 */

export interface EvidenceCardProps {
  title?: string;
  body?: string;
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
      {body && <pre className="whitespace-pre-wrap font-mono text-[11px]">{body}</pre>}
    </div>
  );
}