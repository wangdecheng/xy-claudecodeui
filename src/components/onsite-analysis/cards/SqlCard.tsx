/**
 * SqlCard — 📋 SQL statement rendering with keyword highlight (对齐原型 .card.sql)。
 *
 * body 以 monospace 渲染,SQL 关键字高亮;底部提供复制按钮。
 */

import { Fragment } from 'react';

import { CardFoot, CopyButton } from './CardFoot';

export interface SqlCardProps {
  title?: string;
  body?: string;
}

const SQL_KEYWORDS =
  /\b(SELECT|FROM|WHERE|AND|OR|ORDER\s+BY|GROUP\s+BY|LIMIT|JOIN|LEFT|RIGHT|INNER|OUTER|ON|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|ALTER|DROP|AS|IN|IS|NULL|NOT|LIKE|BETWEEN|DESC|ASC|COUNT|DISTINCT|ROWNUM)\b/gi;

function highlightSql(body: string) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  SQL_KEYWORDS.lastIndex = 0;
  while ((m = SQL_KEYWORDS.exec(body)) !== null) {
    if (m.index > last) parts.push(<Fragment key={`t${last}`}>{body.slice(last, m.index)}</Fragment>);
    parts.push(
      <span key={`k${m.index}`} className="font-semibold text-blue-600 dark:text-blue-400">
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < body.length) parts.push(<Fragment key="end">{body.slice(last)}</Fragment>);
  return parts;
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
        <>
          <pre className="overflow-x-auto whitespace-pre rounded bg-slate-900/5 p-2 font-mono text-[11px] dark:bg-slate-900/40">
            {highlightSql(body)}
          </pre>
          <CardFoot>
            <CopyButton text={body} label="复制 SQL" />
          </CardFoot>
        </>
      )}
    </div>
  );
}
