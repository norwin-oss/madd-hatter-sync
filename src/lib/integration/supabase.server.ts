// Server-only Supabase access. Uses the service-role key, so this module
// must never be imported from client code. Import it only from .server.ts
// helpers or .functions.ts handlers (which the build replaces with RPC stubs).
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getIntegrationConfig } from "./config.server";

// FIX #14: Removed module-level singleton cache. In serverless/edge environments
// (Cloudflare Workers, Nitro) module state can persist across warm invocations:
// a cached client built with a rotated secret silently uses stale credentials.
// The Supabase client is lightweight to construct — per-call creation is safe.
export function getSupabaseServer(): SupabaseClient {
  const cfg = getIntegrationConfig();
  // Server-only: uses the secret key. Never import this from client code.
  return createClient(cfg.supabase.url, cfg.supabase.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Audience reports only need Supabase and a merchant ID, not Clover API or GHL secrets. */
export function getAudienceSupabaseServer(): SupabaseClient {
  const url = (process.env["SUPABASE_URL"] ?? "").trim();
  const secretKey = (process.env["SUPABASE_SECRET_KEY"] ?? "").trim();
  const missing = [!url && "SUPABASE_URL", !secretKey && "SUPABASE_SECRET_KEY"].filter(Boolean);
  if (missing.length) throw new Error(`Missing audience database secrets: ${missing.join(", ")}`);
  return createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function getSupabaseAnon(): SupabaseClient {
  const cfg = getIntegrationConfig();
  // Browser-safe publishable key for client-side auth flows.
  return createClient(cfg.supabase.url, cfg.supabase.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ---- Typed row helpers -------------------------------------------------

export type CustomerMappingRow = {
  id: string;
  clover_merchant_id: string;
  clover_customer_id: string;
  ghl_contact_id: string;
  matched_by: string;
  created_at: string;
  updated_at: string;
};

export type OrderRow = {
  id: string;
  clover_merchant_id: string;
  clover_order_id: string;
  clover_customer_id: string | null;
  ghl_contact_id: string | null;
  status: string; // pending | in_progress | synced | held_for_review | error
  payment_status: string;
  currency: string;
  total_cents: number;
  net_total_cents: number | null;
  net_sales_cents: number | null;
  voided: boolean | null;
  created_time: number;
  location_name: string | null;
  review_reason: string | null;
  last_attempt_id: string | null;
  // Purchase-mapping pipeline columns (migration 0008).
  mapping_status: string | null;
  match_method: string | null;
  processed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type OrderItemRow = {
  id: string;
  order_id: string;
  clover_line_item_id: string;
  clover_item_id: string | null;
  purchase_reference: string;
  ghl_record_id: string | null;
  item_name: string;
  category: string | null;
  quantity: number;
  unit_price_cents: number;
  line_total_cents: number;
  currency: string;
  payment_status: string;
  status: string; // pending | synced | held | error
  flag: string | null;
  created_at: string;
  updated_at: string;
};

export type SyncAttemptRow = {
  id: string;
  order_id: string;
  attempt_number: number;
  status: string; // in_progress | synced | partial | held_for_review | error | skipped
  outcome_message: string | null;
  ghl_contact_id: string | null;
  matched_by: string | null;
  items_synced: number;
  items_held: number;
  error: string | null;
  review_reason: string | null;
  started_at: string;
  finished_at: string | null;
};

// ---- Customer mapping --------------------------------------------------

export async function getCustomerMapping(
  merchantId: string,
  cloverCustomerId: string,
): Promise<CustomerMappingRow | null> {
  const sb = getSupabaseServer();
  const { data, error } = await sb
    .from("customer_mappings")
    .select("*")
    .eq("clover_merchant_id", merchantId)
    .eq("clover_customer_id", cloverCustomerId)
    .maybeSingle();
  if (error) throw new Error(`DB: ${error.message}`);
  return data as CustomerMappingRow | null;
}

export async function saveCustomerMapping(
  merchantId: string,
  cloverCustomerId: string,
  ghlContactId: string,
  matchedBy: string,
): Promise<void> {
  const sb = getSupabaseServer();
  const { error } = await sb.from("customer_mappings").upsert(
    {
      clover_merchant_id: merchantId,
      clover_customer_id: cloverCustomerId,
      ghl_contact_id: ghlContactId,
      matched_by: matchedBy,
    },
    { onConflict: "clover_merchant_id,clover_customer_id" },
  );
  if (error) throw new Error(`DB save mapping: ${error.message}`);
}

// ---- Orders ------------------------------------------------------------

export async function getOrder(merchantId: string, orderId: string): Promise<OrderRow | null> {
  const sb = getSupabaseServer();
  const { data, error } = await sb
    .from("orders")
    .select("*")
    .eq("clover_merchant_id", merchantId)
    .eq("clover_order_id", orderId)
    .maybeSingle();
  if (error) throw new Error(`DB: ${error.message}`);
  return data as OrderRow | null;
}

export async function upsertOrder(
  row: Partial<OrderRow> & { clover_merchant_id: string; clover_order_id: string },
): Promise<OrderRow> {
  const sb = getSupabaseServer();
  const { data, error } = await sb
    .from("orders")
    .upsert(row, { onConflict: "clover_merchant_id,clover_order_id" })
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`DB upsert order: ${error.message}`);
  return data as OrderRow;
}

export async function updateOrder(id: string, patch: Partial<OrderRow>): Promise<void> {
  const sb = getSupabaseServer();
  const { error } = await sb.from("orders").update(patch).eq("id", id);
  if (error) throw new Error(`DB update order: ${error.message}`);
}

// ---- Order items -------------------------------------------------------

export async function getOrderItems(orderId: string): Promise<OrderItemRow[]> {
  const sb = getSupabaseServer();
  const { data, error } = await sb.from("order_items").select("*").eq("order_id", orderId);
  if (error) throw new Error(`DB: ${error.message}`);
  return (data ?? []) as OrderItemRow[];
}

export async function upsertOrderItem(
  row: Partial<OrderItemRow> & { purchase_reference: string },
): Promise<OrderItemRow> {
  const sb = getSupabaseServer();
  const { data, error } = await sb
    .from("order_items")
    .upsert(row, { onConflict: "purchase_reference" })
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`DB upsert item: ${error.message}`);
  return data as OrderItemRow;
}

// ---- Sync attempts -----------------------------------------------------

export async function createSyncAttempt(
  orderId: string,
  attemptNumber: number,
): Promise<SyncAttemptRow> {
  const sb = getSupabaseServer();
  const { data, error } = await sb
    .from("sync_attempts")
    .insert({
      order_id: orderId,
      attempt_number: attemptNumber,
      status: "in_progress",
      started_at: new Date().toISOString(),
    })
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`DB create attempt: ${error.message}`);
  return data as SyncAttemptRow;
}

export async function finishSyncAttempt(id: string, patch: Partial<SyncAttemptRow>): Promise<void> {
  const sb = getSupabaseServer();
  const { error } = await sb
    .from("sync_attempts")
    .update({ ...patch, finished_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`DB finish attempt: ${error.message}`);
}

export async function nextAttemptNumber(orderId: string): Promise<number> {
  const sb = getSupabaseServer();
  const { data, error } = await sb
    .from("sync_attempts")
    .select("attempt_number")
    .eq("order_id", orderId)
    .order("attempt_number", { ascending: false })
    .limit(1);
  if (error) throw new Error(`DB attempt count: ${error.message}`);
  const last = (data ?? [])[0];
  return last ? (last.attempt_number as number) + 1 : 1;
}

// ---- Concurrency lock --------------------------------------------------
// Advisory lock via a status guard. We set status='in_progress' only if it is
// not already in_progress. Returns true if we acquired the lock.

export async function tryAcquireOrderLock(orderRowId: string): Promise<boolean> {
  const sb = getSupabaseServer();
  // Atomic conditional update: only flip to in_progress if not already.
  const { data, error } = await sb.rpc("try_lock_order", { p_order_id: orderRowId });
  if (error) {
    // Fallback if RPC not present yet: optimistic update.
    const { data: upd } = await sb
      .from("orders")
      .update({ status: "in_progress", updated_at: new Date().toISOString() })
      .eq("id", orderRowId)
      .neq("status", "in_progress")
      .select("id")
      .maybeSingle();
    return !!upd;
  }
  return data === true;
}

export async function releaseOrderLock(orderRowId: string, newStatus: string): Promise<void> {
  await updateOrder(orderRowId, { status: newStatus });
}
