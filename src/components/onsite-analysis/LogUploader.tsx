/**
 * LogUploader — drag-zone + multi-file picker for problem logs.
 *
 * Contract (Batch 7.2):
 *   - Client truncates to MAX_FILES = 20; any extras trigger a warning
 *     toast (in-place, no library) and are dropped.
 *   - Client also truncates to MAX_FILE_SIZE = 200MB per file. Anything
 *     bigger is dropped with a per-file warning. The server's multer
 *     enforces the same bound, but trimming client-side avoids burning
 *     bandwidth on rejected payloads.
 *   - Progress bar pulls `getUploadProgress(problemId)` from the store.
 *   - When `problemId` is undefined (e.g. wizard hasn't created the
 *     problem yet), upload is disabled.
 */

import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Upload, X } from 'lucide-react';

import { useOnsiteStore } from '../../stores/onsiteStore';
import { cn } from '../../lib/utils';

export const MAX_FILES = 20;
export const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200 MB

export interface LogUploaderProps {
  problemId: string | null;
  className?: string;
  onUploaded?: () => void;
}

interface WarningEntry {
  id: number;
  text: string;
}

export default function LogUploader({ problemId, className, onUploaded }: LogUploaderProps) {
  const { t } = useTranslation(['onsite']);
  const store = useOnsiteStore();
  const uploadFiles = store.uploadFiles;
  const getUploadProgress = store.getUploadProgress;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [warnings, setWarnings] = useState<WarningEntry[]>([]);

  const progress = problemId ? getUploadProgress(problemId) : -1;
  const uploading = progress >= 0 && progress < 100;

  const pushWarning = (text: string) => {
    const id = Date.now() + Math.random();
    setWarnings((cur) => [...cur, { id, text }]);
    setTimeout(() => {
      setWarnings((cur) => cur.filter((w) => w.id !== id));
    }, 5000);
  };

  const trimFiles = (raw: File[]): File[] => {
    const accepted: File[] = [];
    let oversizedCount = 0;
    for (const f of raw) {
      if (f.size > MAX_FILE_SIZE) {
        oversizedCount += 1;
        continue;
      }
      accepted.push(f);
    }
    if (oversizedCount > 0) {
      pushWarning(
        t('onsite:error.uploadFailed', { defaultValue: 'Upload failed' }) +
          `: ${oversizedCount} file(s) > 200MB dropped`,
      );
    }
    if (accepted.length > MAX_FILES) {
      const dropped = accepted.length - MAX_FILES;
      pushWarning(`${accepted.length} files selected; truncating to ${MAX_FILES} (dropped ${dropped})`);
      return accepted.slice(0, MAX_FILES);
    }
    return accepted;
  };

  const handleFiles = async (raw: File[]) => {
    if (!problemId) {
      pushWarning('请先创建问题再上传文件');
      return;
    }
    const trimmed = trimFiles(raw);
    if (trimmed.length === 0) return;
    try {
      await uploadFiles(problemId, trimmed);
      onUploaded?.();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      pushWarning(`${t('onsite:error.uploadFailed')}: ${message}`);
    }
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    void handleFiles(files);
  };

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <label className="text-xs font-medium text-foreground">
        {t('onsite:wizard.upload')}
      </label>
      <div
        role="button"
        tabIndex={0}
        data-testid="onsite-log-uploader"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed px-3 py-4 text-xs text-muted-foreground transition-colors',
          dragging ? 'border-primary bg-primary/5' : 'border-input hover:border-primary/60',
          !problemId && 'cursor-not-allowed opacity-60',
        )}
      >
        <Upload className="h-4 w-4" />
        <span>{t('onsite:wizard.uploadHint')}</span>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          data-testid="onsite-log-uploader-input"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            void handleFiles(files);
            // allow re-selecting the same file
            e.target.value = '';
          }}
        />
      </div>

      <p
        data-testid="onsite-dz-note"
        className="rounded-md border border-amber-400/50 bg-amber-50 px-2 py-1.5 text-[11px] leading-relaxed text-amber-900 dark:border-amber-600/50 dark:bg-amber-900/20 dark:text-amber-200"
      >
        {t('onsite:wizard.dzNote')}
      </p>

      {uploading && (
        <div data-testid="onsite-upload-progress" className="flex flex-col gap-1">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-[10px] text-muted-foreground">uploading… {progress}%</span>
        </div>
      )}

      {warnings.length > 0 && (
        <ul className="space-y-1" data-testid="onsite-upload-warnings">
          {warnings.map((w) => (
            <li
              key={w.id}
              className="flex items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200"
            >
              <span>{w.text}</span>
              <button
                type="button"
                onClick={() => setWarnings((cur) => cur.filter((x) => x.id !== w.id))}
                className="text-amber-700 hover:text-amber-900 dark:text-amber-300"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}