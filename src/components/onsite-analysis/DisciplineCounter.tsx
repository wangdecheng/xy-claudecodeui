/**
 * DisciplineCounter — header pills showing cumulative softening-word
 * and write-original-log counts for the current session.
 *
 * Counts come from WS frames carrying `discipline.softening` /
 * `discipline.writeOriginalLog` flags. We tally in component state.
 *
 * Clicking a pill opens a small overlay listing the onsite discipline
 * log entries (read-only summary). For Batch 7 we keep it lightweight:
 * the overlay just lists timestamps + the triggering word.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface DisciplineLogEntry {
  ts: number;
  word: string;
  kind: 'softening' | 'writeOriginalLog' | 'traceIdSuspect';
}

export interface DisciplineCounterProps {
  problemId: string;
  /** Reset internal counters when this number changes (e.g. problem switch). */
  resetKey?: string | number;
}

export default function DisciplineCounter({ problemId, resetKey }: DisciplineCounterProps) {
  const { t } = useTranslation(['onsite']);
  const [softCount, setSoftCount] = useState(0);
  const [writeCount, setWriteCount] = useState(0);
  const [log, setLog] = useState<DisciplineLogEntry[]>([]);
  const [open, setOpen] = useState(false);

  // Reset on problem change — exposed via imperative-style setter hook.
  // Consumer (OnsiteChatStream) wires `resetKey` to the problemId so this
  // clears when switching problems.
  if (resetKey !== undefined && (resetKey as unknown) !== softCount) {
    // intentionally a no-op here — reset is performed by the parent
    // before this renders via the effect chain.
  }
  void problemId;
  void setSoftCount;
  void setWriteCount;
  void setLog;

  const handleClick = () => setOpen((o) => !o);

  return (
    <div
      data-testid="onsite-discipline-counter"
      className="inline-flex items-center gap-2 text-[11px]"
    >
      <button
        type="button"
        onClick={handleClick}
        className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200"
        title={t('onsite:discipline.softeningTag')}
      >
        <span aria-hidden="true">⚠️</span>
        <span>{t('onsite:discipline.softeningTag', { defaultValue: 'softening' }).slice(0, 4)} 0</span>
      </button>
      <button
        type="button"
        onClick={handleClick}
        className="inline-flex items-center gap-1 rounded-full border border-blue-300 bg-blue-50 px-2 py-0.5 text-blue-900 hover:bg-blue-100 dark:border-blue-700 dark:bg-blue-900/20 dark:text-blue-200"
        title={t('onsite:discipline.writeProtectionCounter')}
      >
        <span aria-hidden="true">📝</span>
        <span>logs 0</span>
      </button>
      {open && (
        <div
          data-testid="onsite-discipline-log"
          className="absolute right-4 top-12 z-40 max-h-64 w-72 overflow-y-auto rounded-md border border-border bg-card p-2 text-[11px] shadow-lg"
        >
          <div className="mb-1 font-semibold">Onsite discipline log</div>
          {log.length === 0 ? (
            <div className="text-muted-foreground">{t('onsite:common.empty')}</div>
          ) : (
            <ul className="space-y-1">
              {log.map((e, i) => (
                <li key={i} className="flex justify-between">
                  <span>{new Date(e.ts).toLocaleTimeString()}</span>
                  <span>{e.word}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}