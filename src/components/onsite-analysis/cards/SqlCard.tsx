/**
 * SqlCard — 📋 SQL statement rendering with monospace pre.
 */

export interface SqlCardProps {
  title?: string;
  body?: string;
}

export default function SqlCard({ title, body }: SqlCardProps) {
  return (
    <div
      data-testid="onsite-card-sql"
      className="my-1 rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-200"
    >
      <div className="mb-1 flex items-center gap-1 font-semibold">
        <span aria-hidden="true">📋</span>
        <span>{title ?? 'SQL'}</span>
      </div>
      {body && (
        <pre className="overflow-x-auto whitespace-pre rounded bg-slate-900/5 p-2 font-mono text-[11px] dark:bg-slate-900/40">
          {body}
        </pre>
      )}
    </div>
  );
}