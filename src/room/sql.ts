/**
 * `sql.exec<T>()` requires `T` to be assignable to a row of arbitrary SQL
 * values (an index signature keyed by string). Adding that index signature
 * directly to the row interfaces would make them open types, which in turn
 * would make `Partial<Row>` accept arbitrary keys and silently defeat the
 * column-name safety of the update helpers. Instead we widen only at the
 * query boundary, via this helper type and the wrappers below, so the row
 * types stay closed.
 */
export type SqlRow<T> = T & Record<string, SqlStorageValue>;

export function rows<T>(cursor: SqlStorageCursor<SqlRow<T>>): T[] {
  return cursor.toArray();
}

export function firstRow<T>(cursor: SqlStorageCursor<SqlRow<T>>): T | null {
  return rows(cursor)[0] ?? null;
}

/** A column added to a table after that table shipped. */
export interface ColumnMigration {
  readonly name: string;
  readonly ddl: string;
}

/**
 * Adds any missing column to a table that already exists. Idempotent: the
 * check runs against the live table shape, so it is safe to call on every
 * actor start, and it writes only when a column is actually missing.
 *
 * Callers must have confirmed the room's tables exist: running DDL on a room
 * that was never created would allocate storage for it.
 */
export function addMissingColumns(
  sql: SqlStorage,
  table: string,
  columns: readonly ColumnMigration[],
): void {
  const existing = new Set(
    rows(sql.exec<SqlRow<{ name: string }>>(`SELECT name FROM pragma_table_info('${table}')`)).map(
      (r) => r.name,
    ),
  );
  for (const column of columns) {
    if (!existing.has(column.name)) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column.ddl}`);
  }
}
