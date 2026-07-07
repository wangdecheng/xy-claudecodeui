import React, { useState } from 'react';

import { Markdown } from '../../../view/subcomponents/Markdown';

interface MarkdownContentProps {
  content: string;
  className?: string;
}

/**
 * Renders markdown content with truncation for long outputs.
 * Content is clipped to ~6 lines by default; click "展开" to see all.
 */
export const MarkdownContent: React.FC<MarkdownContentProps> = ({
  content,
  className = 'mt-1 prose prose-sm max-w-none dark:prose-invert'
}) => {
  const [expanded, setExpanded] = useState(false);
  // Heuristic: if content is short (< 500 chars), show it all
  const isLong = content.length > 500;

  return (
    <div>
      <div className={!expanded && isLong ? 'max-h-28 overflow-hidden' : ''}>
        <Markdown className={className}>
          {content}
        </Markdown>
      </div>
      {isLong && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? '▲ 收起' : '▼ 展开全部'}
        </button>
      )}
    </div>
  );
};
