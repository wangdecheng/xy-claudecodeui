import React, { useState } from 'react';

interface TextContentProps {
  content: string;
  format?: 'plain' | 'json' | 'code';
  className?: string;
}

const CLAMP_LINES = 3;

/**
 * Renders plain text, JSON, or code content with truncation.
 * Long content is clamped to a few lines; click "展开" to see the rest.
 */
export const TextContent: React.FC<TextContentProps> = ({
  content,
  format = 'plain',
  className = ''
}) => {
  const [expanded, setExpanded] = useState(false);
  const lines = content.split('\n');
  const needsTruncation = lines.length > CLAMP_LINES;

  if (format === 'json') {
    let formattedJson = content;
    try {
      const parsed = JSON.parse(content);
      formattedJson = JSON.stringify(parsed, null, 2);
    } catch (e) {
      console.warn('Failed to parse JSON content:', e);
    }
    const jsonLines = formattedJson.split('\n');
    const jsonNeedsTruncation = jsonLines.length > CLAMP_LINES;

    return (
      <div>
        <pre className={`mt-1 overflow-x-auto rounded bg-gray-900 p-2.5 font-mono text-xs text-gray-100 dark:bg-gray-950 ${!expanded && jsonNeedsTruncation ? `line-clamp-${CLAMP_LINES}` : ''} ${className}`}>
          {formattedJson}
        </pre>
        {jsonNeedsTruncation && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="mt-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {expanded ? '▲ 收起' : `▼ 展开全部 (${jsonLines.length} 行)`}
          </button>
        )}
      </div>
    );
  }

  if (format === 'code') {
    return (
      <div>
        <pre className={`mt-1 overflow-hidden whitespace-pre-wrap break-words rounded border border-gray-200/50 bg-gray-50 p-2 font-mono text-xs text-gray-700 dark:border-gray-700/50 dark:bg-gray-800/50 dark:text-gray-300 ${!expanded && needsTruncation ? `line-clamp-${CLAMP_LINES}` : ''} ${className}`}>
          {content}
        </pre>
        {needsTruncation && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="mt-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {expanded ? '▲ 收起' : `▼ 展开全部 (${lines.length} 行)`}
          </button>
        )}
      </div>
    );
  }

  // Plain text
  return (
    <div>
      <div className={`mt-1 whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300 ${!expanded && needsTruncation ? `line-clamp-${CLAMP_LINES}` : ''} ${className}`}>
        {content}
      </div>
      {needsTruncation && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? '▲ 收起' : `▼ 展开全部 (${lines.length} 行)`}
        </button>
      )}
    </div>
  );
};
