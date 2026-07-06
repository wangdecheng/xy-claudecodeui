/**
 * sqlTemplates — 按数据库方言返回一段可粘贴到输入框的排查用 SQL 模板。
 *
 * 供 OnsiteChatStream 输入区的「插入 SQL 模板」按钮使用。模板是本地字符串,
 * 不硬编码任何客户/环境信息;占位符用尖括号标注,提示现场替换。
 */

export type DatabaseKind = 'mysql' | 'dm' | 'kingbase' | 'oracle' | string;

/** 限制单条查询返回行数的方言差异。 */
function limitClause(database: DatabaseKind, n: number): string {
  switch (database) {
    case 'oracle':
    case 'dm': // 达梦兼容 Oracle 语法
      return `WHERE ROWNUM <= ${n}`;
    default:
      return `LIMIT ${n}`;
  }
}

/**
 * 生成一段带方言注释的排查 SQL 模板。
 * database 为空时按 mysql 兜底,并在注释里提示未选择数据库。
 */
export function sqlTemplateFor(database: DatabaseKind | undefined | null): string {
  const db = (database || '').trim();
  const dialect = db || 'mysql（未选择数据库，按 MySQL 兜底）';
  const isRownum = db === 'oracle' || db === 'dm';
  const tail = limitClause(db, 50);

  if (isRownum) {
    return [
      `-- 方言: ${dialect}`,
      `SELECT * FROM <表名> t`,
      `WHERE t.<字段> = '<值>'`,
      `  AND ROWNUM <= 50`,
      `ORDER BY t.<时间字段> DESC;`,
    ].join('\n');
  }

  return [
    `-- 方言: ${dialect}`,
    `SELECT * FROM <表名>`,
    `WHERE <字段> = '<值>'`,
    `ORDER BY <时间字段> DESC`,
    `${tail};`,
  ].join('\n');
}
