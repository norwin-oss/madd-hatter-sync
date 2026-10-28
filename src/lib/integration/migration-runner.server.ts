//
// Server-only: automatic database migration runner.
//
// After the one-time bootstrap (supabase/bootstrap.sql creates the
// `schema_migrations` tracking table + the `run_migration_sql` RPC), this
// module runs every migration file (0001–0012) that has not yet been applied.
// It is safe and cheap to call on every cold start: it does one SELECT to
// list applied migrations, then only executes the missing ones.
//
// Each migration is split into individual SQL statements (dollar-quote aware
// so `$$ ... $$` function bodies and `$tag$ ... $tag$` blocks survive) and
// executed one statement at a time via the security-definer RPC, because a
// single plpgsql `EXECUTE` only runs one statement.
//
// All migrations are idempotent (`if not exists` / `or replace`), so re-runs
// are harmless. The tracking table guarantees we never re-apply a migration.
//
// No new dependencies, no new secrets: it reuses the existing service-role
// Supabase client.
import { getSupabaseServer } from "./supabase.server";

// Migration SQL is inlined at build time via Vite's `?raw` import so it is
// available in the Cloudflare Worker bundle without filesystem access.
import m0001 from "../../../supabase/migrations/0001_init.sql?raw";
import m0002 from "../../../supabase/migrations/0002_pos_tables.sql?raw";
import m0003 from "../../../supabase/migrations/0003_auto_sync.sql?raw";
import m0004 from "../../../supabase/migrations/0004_fix_missing_columns.sql?raw";
import m0005 from "../../../supabase/migrations/0005_reconciliation.sql?raw";
import m0006 from "../../../supabase/migrations/0006_net_sales.sql?raw";
import m0007 from "../../../supabase/migrations/0007_purchase_tags.sql?raw";
import m0008 from "../../../supabase/migrations/0008_match_audit.sql?raw";
import m0009 from "../../../supabase/migrations/0009_product_mapping_and_logs.sql?raw";
import m0010 from "../../../supabase/migrations/0010_backfill_cursor.sql?raw";
import m0011 from "../../../supabase/migrations/0011_admin_allowlist.sql?raw";
import m0012 from "../../../supabase/migrations/0012_sync_runs_updated_at.sql?raw";

const MIGRATIONS: { id: string; sql: string }[] = [
  { id: "0001_init", sql: m0001 },
  { id: "0002_pos_tables", sql: m0002 },
  { id: "0003_auto_sync", sql: m0003 },
  { id: "0004_fix_missing_columns", sql: m0004 },
  { id: "0005_reconciliation", sql: m0005 },
  { id: "0006_net_sales", sql: m0006 },
  { id: "0007_purchase_tags", sql: m0007 },
  { id: "0008_match_audit", sql: m0008 },
  { id: "0009_product_mapping_and_logs", sql: m0009 },
  { id: "0010_backfill_cursor", sql: m0010 },
  { id: "0011_admin_allowlist", sql: m0011 },
  { id: "0012_sync_runs_updated_at", sql: m0012 },
];

/**
 * Split a SQL script into individual statements, respecting:
 *  - single-quoted strings ('...' with '' escapes)
 *  - dollar-quoted strings ($$ ... $$ and $tag$ ... $tag$)
 *  - line comments (-- to end of line)
 * Empty / comment-only statements are dropped.
 */
function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    // Line comment: skip to end of line (keep it in the buffer is unnecessary;
    // drop it so comment-only fragments don't become empty statements).
    if (ch === "-" && next === "-") {
      const eol = sql.indexOf("\n", i);
      const end = eol === -1 ? n : eol;
      // preserve the newline for formatting but skip the comment text
      buf += "\n";
      i = end + 1;
      continue;
    }

    // Single-quoted string literal
    if (ch === "'") {
      buf += ch;
      i += 1;
      while (i < n) {
        const c = sql[i];
        buf += c;
        if (c === "'") {
          // doubled quote = escaped, consume both
          if (sql[i + 1] === "'") {
            buf += "'";
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    // Dollar-quoted string: $tag$ ... $tag$
    if (ch === "$") {
      // Try to read a dollar-quote tag: $[A-Za-z_0-9]*$
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(sql[j] ?? "")) j += 1;
      if (j < n && sql[j] === "$") {
        const tag = sql.slice(i, j + 1); // includes both $ signs
        buf += tag;
        i = j + 1;
        // scan until the closing tag
        const closeIdx = sql.indexOf(tag, i);
        if (closeIdx === -1) {
          // unterminated — append the rest and stop
          buf += sql.slice(i);
          i = n;
        } else {
          buf += sql.slice(i, closeIdx + tag.length);
          i = closeIdx + tag.length;
        }
        continue;
      }
      // not a dollar quote, fall through
    }

    if (ch === ";") {
      const stmt = buf.trim();
      if (stmt) out.push(stmt);
      buf = "";
      i += 1;
      continue;
    }

    buf += ch;
    i += 1;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

let ranOnce = false;
let lastResult: { ok: boolean; applied: string[]; errors: string[] } | null = null;

/**
 * Run all pending migrations. Cheap to call repeatedly: it lists already-applied
 * migrations first and only executes the missing ones. Results are cached for
 * the lifetime of the worker isolate so repeated calls in the same cold start
 * don't re-query.
 */
export async function ensureMigrations(): Promise<{
  ok: boolean;
  applied: string[];
  errors: string[];
}> {
  if (ranOnce && lastResult) return lastResult;
  ranOnce = true;

  const sb = getSupabaseServer();
  const applied: string[] = [];
  const errors: string[] = [];

  // 1. Which migrations are already applied?
  let appliedIds = new Set<string>();
  try {
    const { data, error } = await sb.from("schema_migrations").select("id");
    if (error) {
      // If the tracking table doesn't exist yet, the bootstrap hasn't been run.
      // We can't auto-run migrations without it, so report and bail gracefully.
      errors.push(`schema_migrations read: ${error.message} (run supabase/bootstrap.sql once)`);
      lastResult = { ok: false, applied, errors };
      return lastResult;
    }
    appliedIds = new Set((data ?? []).map((r: any) => r.id as string));
  } catch (e: any) {
    errors.push(
      `schema_migrations read: ${e?.message ?? String(e)} (run supabase/bootstrap.sql once)`,
    );
    lastResult = { ok: false, applied, errors };
    return lastResult;
  }

  // 2. Run each pending migration, statement by statement.
  for (const mig of MIGRATIONS) {
    if (appliedIds.has(mig.id)) continue;

    const statements = splitSqlStatements(mig.sql);
    let failed = false;
    for (const stmt of statements) {
      const { error } = await sb.rpc("run_migration_sql", { p_sql: stmt });
      if (error) {
        // A statement may legitimately fail if the object already exists from a
        // partial prior run. Treat "already exists" / "duplicate" as non-fatal
        // so the migration still marks as applied and we move on.
        const msg = String(error.message ?? "");
        const benign = /already exists|duplicate (column|index|table|object)|has no column/i.test(
          msg,
        );
        if (!benign) {
          errors.push(`${mig.id}: ${msg}`);
          failed = true;
          break;
        }
      }
    }

    if (!failed) {
      try {
        await sb.from("schema_migrations").upsert({ id: mig.id });
        applied.push(mig.id);
      } catch (e: any) {
        errors.push(`${mig.id} track: ${e?.message ?? String(e)}`);
      }
    }
  }

  lastResult = { ok: errors.length === 0, applied, errors };
  return lastResult;
}
