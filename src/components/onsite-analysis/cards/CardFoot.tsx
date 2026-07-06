/**
 * CardFoot — 卡片底部操作条(对齐原型 .card-foot)。
 *
 * 提供两个通用动作:
 *  - CopyButton:复制指定文本到剪贴板(如「复制给现场的话术」)。
 *  - RerunButton:把提示写回输入框(如「补日志后重跑分析」),经 onRerun 回调。
 */

import { useState } from 'react';
import { Copy, RefreshCw } from 'lucide-react';

const BTN_CLS =
  'inline-flex items-center gap-1 rounded-md border border-border bg-secondary px-2 py-0.5 text-[11px] text-foreground hover:border-primary/50';

export function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      data-testid="onsite-card-copy"
      className={BTN_CLS}
      onClick={() => {
        try {
          void navigator.clipboard?.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable — no-op */
        }
      }}
    >
      <Copy className="h-3 w-3" />
      {copied ? '已复制' : label}
    </button>
  );
}

export function RerunButton({ onRerun, hint }: { onRerun: (hint: string) => void; hint: string }) {
  return (
    <button
      type="button"
      data-testid="onsite-card-rerun"
      className={BTN_CLS}
      onClick={() => onRerun(hint)}
    >
      <RefreshCw className="h-3 w-3" />
      补日志后重跑分析
    </button>
  );
}

export function CardFoot({ children }: { children: React.ReactNode }) {
  return <div className="mt-2 flex flex-wrap gap-1.5 border-t border-border/60 pt-1.5">{children}</div>;
}
