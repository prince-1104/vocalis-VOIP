// Deliberately small SQL-expression adapter, not a replacement database. Unknown
// predicates fail the test rather than silently behaving as authorization success.
import { getTableColumns, getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as schema from "../../../lib/db/src/schema";
export * from "../../../lib/db/src/schema";

export const rows: Record<string, any[]> = {};
export let writes = 0;
export function resetDatabase() {
  for (const key of Object.keys(rows)) delete rows[key];
  writes = 0;
}
const dialect = new PgDialect();
const UNIQUE_KEYS: Record<string, string | string[]> = {
  widget_verification_policies: "tenantId",
  call_suppressions: ["userId", "phoneKey"],
  usage_ledger: ["tenantId", "idempotencyKey"],
  budget_reservations: ["tenantId", "idempotencyKey"],
  tenant_budget_periods: ["tenantId", "period"],
  billing_rate_cards: "version",
  invoices: ["tenantId", "period"],
  platform_settings: "key",
};
const isSql = (value: unknown) =>
  !!value && typeof value === "object" && "queryChunks" in (value as any);
// Literal column defaults (not SQL defaults such as now()) as Postgres would apply them.
function withDefaults(table: any, value: any) {
  const row = { ...value };
  for (const [key, column] of Object.entries(getTableColumns(table)) as [string, any][]) {
    if (row[key] !== undefined) continue;
    if (column.defaultFn) row[key] = column.defaultFn();
    else if (column.default !== undefined && !isSql(column.default)) row[key] = column.default;
  }
  return row;
}
function columnKey(table: any, name: string): string {
  const columns = getTableColumns(table);
  const key = Object.keys(columns).find(
    (key) => (columns[key] as any).name === name,
  );
  if (!key) throw new Error("Unknown test column");
  return key;
}
const comparable = (value: any) =>
  value instanceof Date ? value.getTime() : value;
function compare(actual: any, operator: string, expected: any): boolean {
  if (operator === "=") return comparable(actual) === comparable(expected);
  if (operator === "<>")
    return actual != null && comparable(actual) !== comparable(expected);
  if (actual == null) return false;
  const a = comparable(actual);
  const b =
    actual instanceof Date ? new Date(expected).getTime() : comparable(expected);
  if (operator === ">") return a > b;
  if (operator === "<") return a < b;
  if (operator === ">=") return a >= b;
  return a <= b;
}
function match(table: any, row: any, where: any): boolean {
  if (!where) return true;
  const query = dialect.sqlToQuery(where);
  const param = (ref: string) => query.params[Number(ref.slice(1)) - 1];
  let remaining = query.sql;
  let accepted = true;
  remaining = remaining.replace(
    /"[^"]+"\."([^"]+)"\s+(not in|in)\s+\(([^)]*)\)/g,
    (_all, name, operator, list) => {
      const value = row[columnKey(table, name)];
      const found = list
        .split(",")
        .map((ref: string) => param(ref.trim()))
        .some((expected: any) => compare(value, "=", expected));
      accepted = accepted && (operator === "in" ? found : !found);
      return "";
    },
  );
  remaining = remaining.replace(
    /"[^"]+"\."([^"]+)"\s*(is not null|is null|<=|>=|<>|=|>|<)\s*(\$\d+)?/g,
    (_all, name, operator, ref) => {
      const value = row[columnKey(table, name)];
      accepted =
        accepted &&
        (operator === "is null"
          ? value == null
          : operator === "is not null"
            ? value != null
            : compare(value, operator, param(ref)));
      return "";
    },
  );
  if (remaining.replace(/\band\b|[\s()]/g, ""))
    throw new Error("Unsupported test SQL predicate");
  return accepted;
}
// Supports `column + n` increments used for counters; other SQL fails loudly.
function applySet(table: any, row: any, values: any) {
  for (const [key, value] of Object.entries(values)) {
    if (value && typeof value === "object" && "queryChunks" in (value as any)) {
      const query = dialect.sqlToQuery(value as any);
      const increment = /^"[^"]+"\."([^"]+)"\s*\+\s*(?:(\d+)|\$(\d+))$/.exec(
        query.sql.trim(),
      );
      if (!increment) throw new Error("Unsupported test SQL assignment");
      const source = columnKey(table, increment[1]);
      const amount = increment[2]
        ? Number(increment[2])
        : Number(query.params[Number(increment[3]) - 1]);
      row[key] = Number(row[source] ?? 0) + amount;
    } else {
      row[key] = value;
    }
  }
}
function builder(table: any, operation = "select", values?: any) {
  let where: any;
  let limit = Infinity;
  let conflict = false;
  let conflictSet: any;
  const run = () => {
    const name = getTableName(table);
    const data = (rows[name] ||= []);
    let selected = data.filter((row) => match(table, row, where));
    if (operation === "insert") {
      const incoming = (Array.isArray(values) ? values : [values]).map(
        (value, index) => withDefaults(table, { id: data.length + 1 + index, revokedAt: null, ...value }),
      );
      const uniqueKey = [UNIQUE_KEYS[name] ?? "callLogId"].flat();
      const inserted: any[] = [];
      for (const value of incoming) {
        const existing = conflict
          ? data.find((row) => uniqueKey.every((key) => row[key] === value[key]))
          : undefined;
        if (existing) {
          if (conflictSet) {
            applySet(table, existing, conflictSet);
            inserted.push(existing);
            writes++;
          }
          continue;
        }
        inserted.push(value);
        data.push(value);
        writes++;
      }
      selected = conflict ? inserted : incoming;
    } else if (operation === "update") {
      for (const row of selected) {
        applySet(table, row, values);
        writes++;
      }
    } else if (operation === "delete") {
      rows[name] = data.filter((row) => !selected.includes(row));
      writes += selected.length;
    }
    return selected.slice(0, limit).map((row) => ({ ...row }));
  };
  const chain: any = {
    where(value: any) {
      where = value;
      return chain;
    },
    limit(value: number) {
      limit = value;
      return chain;
    },
    orderBy() {
      return chain;
    },
    returning() {
      return chain;
    },
    onConflictDoNothing() {
      conflict = true;
      return chain;
    },
    onConflictDoUpdate(options: { set: any }) {
      conflict = true;
      conflictSet = options.set;
      return chain;
    },
    // Row locks are no-ops: this fake has no concurrency. Locking is verified
    // only by the PostgreSQL suites.
    for() {
      return chain;
    },
    groupBy() {
      return chain;
    },
    then(resolve: any, reject: any) {
      return Promise.resolve().then(run).then(resolve, reject);
    },
    catch(reject: any) {
      return Promise.resolve().then(run).catch(reject);
    },
  };
  return chain;
}
export const db: any = {
  query: Object.fromEntries(
    Object.entries(schema)
      .filter(([, value]) => {
        try {
          return !!getTableName(value as any);
        } catch {
          return false;
        }
      })
      .map(([name, table]) => [
        name,
        {
          findFirst: async (options: any = {}) =>
            (await builder(table).where(options.where).limit(1))[0],
          findMany: async (options: any = {}) =>
            builder(table).where(options.where).limit(options.limit ?? Infinity),
        },
      ]),
  ),
  select: () => ({ from: (table: any) => builder(table) }),
  insert: (table: any) => ({
    values: (values: any) => builder(table, "insert", values),
  }),
  update: (table: any) => ({
    set: (values: any) => builder(table, "update", values),
  }),
  delete: (table: any) => builder(table, "delete"),
  transaction: async (fn: any) => fn(db),
  execute: async () => [],
};
