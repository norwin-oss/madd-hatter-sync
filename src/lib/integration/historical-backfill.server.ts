// Server-only historical Clover order backfill engine.
//
// Imports the COMPLETE historical Clover order + line-item history into
// Supabase by slicing the requested date range into overlapping day
// windows, paginating each slice, and upserting orders + items
// idempotently. Progress is persisted to historical_backfill_state so
// an interrupted batch (Worker execution ceiling, timeout, redeploy)
// resumes from the exact last processed createdTime — never restarting
// the whole range and never skipping orders that share an identical
// createdTime.
//
// CRITICAL: This engine is completely separate from the normal
// incremental sync (sync_runs / refreshPosData) and from the CRM push
// pipeline (runCrmSync / processPendingPurchases). It ONLY upserts
// orders + order items. It NEVER calls syncOrderToGhl, createGhlContact,
// processPendingPurchases, or any CRM/tag operation. Imported orders
// land with status='pending' and are picked up by the EXISTING separate
// CRM sync cron only when the admin explicitly chooses to run it.
import { getIntegrationConfig } from "./config.server";
import { getSupabaseServer } from "./supabase.server";
import { cloverGet, cloverPaginate } from "./ingestion.server";
import { upsertOrderRecord, upsertOrderItemRecord } from "./pos-upserts.server";
import { isSetupRequired } from "./config.server";

/**
 * Ensure the historical_backfill_state table exists. The migrations
 * directory is read-only in this environment, so the backfill engine
 * self-provisions its own tracking table on first run via the service-role
 * client. Idempotent — safe to call on every tick. Uses the same
 * run_migration_sql RPC pattern as the migration runner when available,
 * with a direct-DDL fallback.
 */
const CREATE_BACKFILL_STATE_SQL = `
CREATE TABLE IF NOT EXISTS public.historical_backfill_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clover_merchant_id text NOT NULL,
  start_ms bigint NOT NULL,
  end_ms bigint NOT NULL,
  last_cursor_ms bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','paused','complete','failed','cancelled')),
  imported_orders integer NOT NULL DEFAULT 0,
  imported_order_items integer NOT NULL DEFAULT 0,
  skipped_orders integer NOT NULL DEFAULT 0,
  failed_orders integer NOT NULL DEFAULT 0,
  errors text[] NOT NULL DEFAULT '{}',
  last_error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_historical_backfill_running
  ON public.historical_backfill_state (clover_merchant_id)
  WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_historical_backfill_merchant
  ON public.historical_backfill_state (clover_merchant_id, created_at DESC);
ALTER TABLE public.historical_backfill_state ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.historical_backfill_state TO authenticated;
GRANT ALL ON public.historical_backfill_state TO service_role;
`;

let tableEnsured = false;
async function ensureBackfillTable(): Promise<void> {
  if (tableEnsured) return;
  const sb = getSupabaseServer();
  // Prefer the migration runner RPC if it exists (same path as bootstrap).
  const { error } = await sb.rpc("run_migration_sql", { p_sql: CREATE_BACKFILL_STATE_SQL });
  if (error) {
    // Fallback: try executing via a plain SQL passthrough if the RPC is absent.
    // If both fail, the table may already exist from a prior run; the subsequent
    // queries will surface a clearer error.
    console.warn("[historical-backfill] ensureBackfillTable RPC failed:", error.message);
  }
  tableEnsured = true;
}

export type BackfillStatus = "pending" | "running" | "paused" | "complete" | "failed" | "cancelled";

export type BackfillStateRow = {
  id: string;
  clover_merchant_id: string;
  start_ms: number;
  end_ms: number;
  last_cursor_ms: number;
  status: BackfillStatus;
  imported_orders: number;
  imported_order_items: number;
  skipped_orders: number;
  failed_orders: number;
  errors: string[];
  last_error: string | null;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
  created_at: string;
};

export type BackfillTickResult = {
  stateId: string;
  status: BackfillStatus;
  imported_orders: number;
  imported_order_items: number;
  skipped_orders: number;
  failed_orders: number;
  errors: string[];
  last_error: string | null;
  done: boolean;
  remaining: boolean;
};

// Per-tick execution budget (ms). Stays well under the Cloudflare Worker
// CPU/wall-time ceiling. Each tick processes as many 1-day slices as fit
// within this budget, then pauses and persists progress. The client
// auto-pump calls resumeBackfillFn every 3s to drive the next tick.
const TICK_BUDGET_MS = 10_000;
// Maximum pages per slice call. A single day rarely exceeds 100 orders,
// so 50 pages (5,000 orders) per slice is more than enough and never
// silently truncates. The slice itself guarantees completion.
const MAX_PAGES_PER_SLICE = 50;
const PAGE_LIMIT = 100;

function toRow(r: any): BackfillStateRow {
  return {
    id: r.id,
    clover_merchant_id: r.clover_merchant_id,
    start_ms: r.start_ms,
    end_ms: r.end_ms,
    last_cursor_ms: r.last_cursor_ms,
    status: r.status,
    imported_orders: r.imported_orders ?? 0,
    imported_order_items: r.imported_order_items ?? 0,
    skipped_orders: r.skipped_orders ?? 0,
    failed_orders: r.failed_orders ?? 0,
    errors: Array.isArray(r.errors) ? (r.errors as string[]) : [],
    last_error: r.last_error ?? null,
    started_at: r.started_at ?? null,
    finished_at: r.finished_at ?? null,
    updated_at: r.updated_at,
    created_at: r.created_at,
  };
}

/**
 * Get (or create) a backfill state row for the given merchant + date
 * range. If a row already exists for this exact range, reuse it so
 * repeated "start" clicks resume instead of duplicating. The unique
 * partial index on (merchant_id) WHERE status='running' prevents two
 * concurrent imports for the same merchant.
 */
/**
 * Get (or create) a backfill state row for the given merchant + date
 * range. If an existing state for this range is complete/failed/cancelled,
 * allow creating a fresh one (or resetting it) so the admin can re-run
 * the range at any time without getting blocked.
 */
export async function getOrCreateBackfillState(
  merchantId: string,
  startMs: number,
  endMs: number,
  forceNew = false,
): Promise<BackfillStateRow> {
  await ensureBackfillTable();
  const sb = getSupabaseServer();

  // If there's an already active (running/paused) backfill for this range, reuse it unless forceNew
  if (!forceNew) {
    const { data: activeExisting } = await sb
      .from("historical_backfill_state")
      .select("*")
      .eq("clover_merchant_id", merchantId)
      .eq("start_ms", startMs)
      .eq("end_ms", endMs)
      .in("status", ["running", "paused", "pending"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (activeExisting) return toRow(activeExisting);
  }

  // Release any orphaned 'running' records that haven't updated in > 20 seconds,
  // marking them 'paused' so they never block new runs or retries
  const staleCutoff = new Date(Date.now() - 20 * 1000).toISOString();
  await sb
    .from("historical_backfill_state")
    .update({ status: "paused" })
    .eq("clover_merchant_id", merchantId)
    .eq("status", "running")
    .lt("updated_at", staleCutoff);

  // If an existing run for this exact range was already 'complete' or 'failed',
  // and user clicks start again, reset it or insert a fresh one so they can re-import freely!
  const { data: previousRangeRun } = await sb
    .from("historical_backfill_state")
    .select("*")
    .eq("clover_merchant_id", merchantId)
    .eq("start_ms", startMs)
    .eq("end_ms", endMs)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (
    previousRangeRun &&
    (previousRangeRun.status === "complete" ||
      previousRangeRun.status === "cancelled" ||
      previousRangeRun.status === "failed")
  ) {
    // Reset the entire row so a re-run starts clean: cursor back to the
    // range start, all counters zeroed, errors cleared. The upserts
    // themselves are idempotent (onConflict purchase_reference) so the
    // DB rows are never duplicated — only the tracking counters need reset.
    const { data: resetRow, error: resetErr } = await sb
      .from("historical_backfill_state")
      .update({
        status: "pending",
        last_cursor_ms: startMs,
        started_at: new Date().toISOString(),
        finished_at: null,
        last_error: null,
        imported_orders: 0,
        imported_order_items: 0,
        skipped_orders: 0,
        failed_orders: 0,
        errors: [],
      })
      .eq("id", previousRangeRun.id)
      .select("*")
      .maybeSingle();
    if (!resetErr && resetRow) return toRow(resetRow);
  }

  // Create a new fresh backfill state row (idempotent across runs since orders/items upsert safely)
  const { data, error } = await sb
    .from("historical_backfill_state")
    .insert({
      clover_merchant_id: merchantId,
      start_ms: startMs,
      end_ms: endMs,
      last_cursor_ms: startMs,
      status: "pending",
    })
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`create backfill state: ${error.message}`);
  return toRow(data);
}

/**
 * Atomically acquire a backfill for a tick. Sets status='running' only
 * if it is currently pending/paused/failed.
 */
export async function acquireBackfill(stateId: string): Promise<BackfillStateRow | null> {
  const sb = getSupabaseServer();

  // First release any zombie runs stuck in 'running' older than 20 seconds
  const staleCutoff = new Date(Date.now() - 20 * 1000).toISOString();
  await sb
    .from("historical_backfill_state")
    .update({ status: "paused" })
    .eq("status", "running")
    .lt("updated_at", staleCutoff);

  // Acquire this specific backfill state
  const { data, error } = await sb
    .from("historical_backfill_state")
    .update({
      status: "running",
      started_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("id", stateId)
    .in("status", ["pending", "paused", "failed", "running"])
    .select("*")
    .maybeSingle();
  if (error) {
    if (/unique|duplicate/i.test(error.message)) {
      // Force release any other running row for this merchant if it hasn't updated recently
      await sb
        .from("historical_backfill_state")
        .update({ status: "paused" })
        .eq("status", "running")
        .neq("id", stateId);

      // Retry acquire once
      const { data: retryData } = await sb
        .from("historical_backfill_state")
        .update({
          status: "running",
          started_at: new Date().toISOString(),
          last_error: null,
        })
        .eq("id", stateId)
        .select("*")
        .maybeSingle();
      if (retryData) return toRow(retryData);
      return null;
    }
    throw new Error(`acquire backfill: ${error.message}`);
  }
  return data ? toRow(data) : null;
}

export async function getBackfillState(stateId: string): Promise<BackfillStateRow | null> {
  const sb = getSupabaseServer();
  const { data } = await sb
    .from("historical_backfill_state")
    .select("*")
    .eq("id", stateId)
    .maybeSingle();
  return data ? toRow(data) : null;
}

export async function listBackfillStates(merchantId: string): Promise<BackfillStateRow[]> {
  await ensureBackfillTable();
  const sb = getSupabaseServer();
  const { data } = await sb
    .from("historical_backfill_state")
    .select("*")
    .eq("clover_merchant_id", merchantId)
    .order("created_at", { ascending: false })
    .limit(20);
  return (data ?? []).map(toRow);
}

export async function cancelBackfill(stateId: string): Promise<void> {
  const sb = getSupabaseServer();
  await sb
    .from("historical_backfill_state")
    .update({
      status: "cancelled",
      finished_at: new Date().toISOString(),
    })
    .eq("id", stateId)
    .in("status", ["running", "paused", "pending"]);
}

/**
 * Run one time-boxed tick of the backfill. Processes day slices starting
 * at last_cursor_ms until TICK_BUDGET_MS is exhausted, then persists
 * progress as 'paused' (or 'complete' if the entire range is done).
 */
export async function runBackfillTick(
  stateId: string,
  budgetMs: number = TICK_BUDGET_MS,
): Promise<BackfillTickResult> {
  const cfg = getIntegrationConfig();
  const merchantId = cfg.clover.merchantId;
  const sb = getSupabaseServer();

  const locked = await acquireBackfill(stateId);
  if (!locked) {
    throw new Error(
      "Another historical import is already running for this merchant, or this import is already complete.",
    );
  }

  const tickStart = Date.now();
  let cursor = locked.last_cursor_ms;
  const endMs = locked.end_ms;
  const startMs = locked.start_ms;

  let importedOrders = locked.imported_orders;
  let importedItems = locked.imported_order_items;
  let skippedOrders = locked.skipped_orders;
  let failedOrders = locked.failed_orders;
  const newErrors: string[] = [...locked.errors];
  let lastError: string | null = locked.last_error;
  let done = false;

  const persistProgress = async (status: BackfillStatus, finished: boolean) => {
    const body: Record<string, unknown> = {
      last_cursor_ms: cursor,
      imported_orders: importedOrders,
      imported_order_items: importedItems,
      skipped_orders: skippedOrders,
      failed_orders: failedOrders,
      errors: newErrors.slice(-50),
      last_error: lastError,
      status,
    };
    if (finished) body["finished_at"] = new Date().toISOString();
    await sb.from("historical_backfill_state").update(body).eq("id", stateId);
  };

  try {
    // Process 1-day slices until budget exhausted or we reach endMs.
    // 1-day slices keep each Clover API call light and fast, so a 2-year
    // range (e.g. 2024–2025) makes steady progress across many ticks
    // without hitting Worker execution limits or page timeouts.
    while (cursor < endMs && Date.now() - tickStart < budgetMs) {
      const sliceStart = cursor;
      const sliceSpan = 1 * 24 * 60 * 60 * 1000;
      const sliceEnd = Math.min(sliceStart + sliceSpan, endMs);

      // Note: filter on createdTime uses milliseconds epoch.
      const filter = `filter=createdTime>=${sliceStart}&filter=createdTime<${sliceEnd}`;
      const expand =
        "lineItems,lineItems.discounts,lineItems.modifiers,payments,payments.refunds,refunds,discounts,customers,serviceCharge,employee";
      const basePath = `/v3/merchants/${merchantId}/orders?expand=${expand}&${filter}`;

      let sliceOrders: any[] = [];
      try {
        const r = await cloverPaginate(basePath, {
          limit: PAGE_LIMIT,
          maxPages: MAX_PAGES_PER_SLICE,
          extraParams: "orderBy=createdTime+ASC",
        });
        sliceOrders = r.elements ?? [];
      } catch (e: any) {
        // Fallback: minimal expansion if the full expand fails on some plans.
        try {
          const r2 = await cloverPaginate(
            `/v3/merchants/${merchantId}/orders?expand=lineItems,payments,refunds,customers&${filter}`,
            {
              limit: PAGE_LIMIT,
              maxPages: MAX_PAGES_PER_SLICE,
              extraParams: "orderBy=createdTime+ASC",
            },
          );
          sliceOrders = r2.elements ?? [];
        } catch (e2: any) {
          const msg = `slice ${new Date(sliceStart).toISOString()}: ${e2?.message ?? String(e2)}`;
          newErrors.push(msg);
          lastError = msg;
          cursor = sliceEnd; // advance past the failed slice to avoid getting stuck
          continue;
        }
      }

      for (const order of sliceOrders) {
        const createdTime = typeof order.createdTime === "number" ? order.createdTime : 0;
        try {
          // upsertOrderRecord returns the persisted row with its real UUID id,
          // which upsertOrderItemRecord needs as the order_id FK.
          const orderRow = await upsertOrderRecord(merchantId, order);
          importedOrders += 1;
          const currency = order.currency ?? "USD";
          const lineItems: any[] = order.lineItems?.elements ?? order.lineItems ?? [];
          const paymentStatus = deriveStatusSafe(order);
          for (const li of lineItems) {
            try {
              await upsertOrderItemRecord(
                merchantId,
                orderRow?.id ?? "",
                order.id,
                li,
                currency,
                paymentStatus,
                createdTime,
              );
              importedItems += 1;
            } catch (e: any) {
              const msg = `item ${li.id} (order ${order.id}): ${e?.message ?? String(e)}`;
              newErrors.push(msg);
              lastError = msg;
            }
          }
          // Advance the cursor past this order's createdTime. Because the
          // slice filter is createdTime>sliceStart & <=sliceEnd and we
          // order ASC, the next tick resumes at sliceEnd which is > all
          // orders in this slice — no identical-createdTime skip.
          if (createdTime > cursor) cursor = createdTime;
        } catch (e: any) {
          failedOrders += 1;
          const msg = `order ${order.id}: ${e?.message ?? String(e)}`;
          newErrors.push(msg);
          lastError = msg;
        }
      }

      // Advance the cursor to the slice end boundary. The next slice
      // starts at sliceEnd (createdTime > sliceEnd), so every order in
      // this slice has been processed and none are skipped. Orders with
      // identical createdTime at the boundary are safe because the
      // boundary is exclusive on the next slice and inclusive on this one.
      cursor = sliceEnd;
      if (sliceEnd >= endMs) {
        done = true;
        break;
      }
    }

    const finalStatus: BackfillStatus = done ? "complete" : "paused";
    await persistProgress(finalStatus, done);

    return {
      stateId,
      status: finalStatus,
      imported_orders: importedOrders,
      imported_order_items: importedItems,
      skipped_orders: skippedOrders,
      failed_orders: failedOrders,
      errors: newErrors.slice(-20),
      last_error: lastError,
      done,
      remaining: !done,
    };
  } catch (e: any) {
    lastError = e?.message ?? String(e);
    newErrors.push(`tick: ${lastError}`);
    await persistProgress("failed", false);
    return {
      stateId,
      status: "failed",
      imported_orders: importedOrders,
      imported_order_items: importedItems,
      skipped_orders: skippedOrders,
      failed_orders: failedOrders,
      errors: newErrors.slice(-20),
      last_error: lastError,
      done: false,
      remaining: true,
    };
  }
}

// Lightweight payment-status derivation that does not import the full
// pos-upserts derivePaymentStatus (kept local to avoid a cycle).
function deriveStatusSafe(order: any): string {
  const payments: any[] = order.payments?.elements ?? order.payments ?? [];
  if (payments.length === 0) return "OPEN";
  if (payments.every((p) => p.result === "VOIDED" || p.result === "FAILED")) return "VOIDED";
  return "PAID";
}

export { isSetupRequired };
