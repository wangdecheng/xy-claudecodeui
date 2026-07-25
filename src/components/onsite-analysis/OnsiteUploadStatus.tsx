import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useOnsiteStore } from '../../stores/onsiteStore';

export default function OnsiteUploadStatus({ problemId }: { problemId: string }) {
  const { t } = useTranslation(['onsite']);
  const store = useOnsiteStore();
  const batch = store.getUploadBatch(problemId);
  if (!batch) return null;
  const active = batch.phase === 'transferring' || batch.phase === 'processing';
  const successful = batch.results?.filter((result) => result.ok).length ?? 0;
  const failed = batch.results?.filter((result) => !result.ok) ?? [];
  const label = batch.phase === 'cancelled'
    ? t('onsite:upload.cancelled', { defaultValue: '上传已取消' })
    : batch.phase === 'error' && !batch.results
      ? t('onsite:upload.failed', { defaultValue: '上传失败' })
      : batch.phase === 'processing'
    ? t('onsite:upload.processing', { defaultValue: '正在处理文件…' })
    : batch.phase === 'transferring'
      ? t('onsite:upload.transferring', { defaultValue: '正在上传现场资料…' })
        : t('onsite:upload.summary', { defaultValue: `处理完成：成功 ${successful}，失败 ${failed.length}`, successful, failed: failed.length });

  return (
    <div data-testid="onsite-upload-status" aria-live="polite" className="rounded-md border border-border bg-muted/30 p-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span>{label}</span>
        {batch.phase === 'transferring' ? (
          <button type="button" onClick={() => store.cancelUpload(problemId)}>{t('onsite:upload.cancel', { defaultValue: '取消' })}</button>
        ) : !active ? (
          <button type="button" aria-label={t('onsite:upload.dismiss', { defaultValue: '关闭' })} onClick={() => store.dismissUpload(problemId)}><X className="h-3 w-3" /></button>
        ) : null}
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary" style={{ width: `${batch.progress}%` }} /></div>
      <div className="mt-1 text-muted-foreground">{batch.progress}%</div>
      {failed.length > 0 && <ul className="mt-1 text-destructive">{failed.map((result) => <li key={result.originalName}>{result.originalName}: {result.error}</li>)}</ul>}
      {batch.error && <div className="mt-1 text-destructive">{batch.error}</div>}
    </div>
  );
}
