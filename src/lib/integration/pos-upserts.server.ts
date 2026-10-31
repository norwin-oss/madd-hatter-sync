// Server-only Supabase upsert helpers for normalized Clover POS data.
// Keeps ingestion.server.ts focused on orchestration; all DB writes live here.
import { getSupabaseServer } from "./supabase.server";
import { purchaseReference } from "./matching.server";

function cents(v: any): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function num(v: any): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function upsertCustomer(merchantId: string, c: any) {
  const sb = getSupabaseServer();
  const email =
    c.email ??
    c.emailAddresses?.[0]?.emailAddress ??
    c.emailAddresses?.elements?.[0]?.emailAddress ??
    (typeof c.emailAddresses?.[0] === "string" ? c.emailAddresses[0] : null);
  const phone =
    c.phone ??
    c.phoneNumbers?.[0]?.phoneNumber ??
    c.phoneNumbers?.elements?.[0]?.phoneNumber ??
    (typeof c.phoneNumbers?.[0] === "string" ? c.phoneNumbers[0] : null) ??
    c.addresses?.[0]?.phoneNumber ??
    c.addresses?.elements?.[0]?.phoneNumber ??
    null;

  const { error } = await sb.from("customers").upsert(
    {
      clover_merchant_id: merchantId,
      clover_customer_id: c.id,
      first_name: c.firstName ?? null,
      last_name: c.lastName ?? null,
      email: email ? String(email).trim() : null,
      phone: phone ? String(phone).trim() : null,
      marketing_allowed: c.marketingAllowed ?? null,
    },
    { onConflict: "clover_merchant_id,clover_customer_id" },
  );
  if (error) throw new Error(`upsert customer: ${error.message}`);
}

export async function upsertCategory(merchantId: string, c: any) {
  const sb = getSupabaseServer();
  const { error } = await sb.from("categories").upsert(
    {
      clover_merchant_id: merchantId,
      clover_category_id: c.id,
      name: c.name ?? null,
    },
    { onConflict: "clover_merchant_id,clover_category_id" },
  );
  if (error) throw new Error(`upsert category: ${error.message}`);
}

export async function upsertProduct(merchantId: string, item: any, categoryName?: string | null) {
  const sb = getSupabaseServer();
  const { error } = await sb.from("products").upsert(
    {
      clover_merchant_id: merchantId,
      clover_item_id: item.id,
      name: item.name ?? null,
      clover_category_id: item.categories?.elements?.[0]?.id ?? item.category?.id ?? null,
      category_name: categoryName ?? null,
      sku: item.sku ?? item.code ?? null,
      price_cents: cents(item.price),
      price_type: item.priceType ?? null,
      unit_name: item.unitName ?? null,
      stock: item.stockCount != null ? num(item.stockCount) : null,
      hidden: item.hidden ?? false,
    },
    { onConflict: "clover_merchant_id,clover_item_id" },
  );
  if (error) throw new Error(`upsert product: ${error.message}`);
}

export async function upsertEmployee(merchantId: string, e: any) {
  const sb = getSupabaseServer();
  const { error } = await sb.from("employees").upsert(
    {
      clover_merchant_id: merchantId,
      clover_employee_id: e.id,
      name: [e.firstName, e.lastName].filter(Boolean).join(" ") || e.name || null,
      email: e.email ?? null,
      role: e.role ?? null,
    },
    { onConflict: "clover_merchant_id,clover_employee_id" },
  );
  if (error) throw new Error(`upsert employee: ${error.message}`);
}

export async function upsertPayment(merchantId: string, p: any) {
  const sb = getSupabaseServer();
  const result = p.result ?? null;
  const voided = result === "VOIDED";
  const { error } = await sb.from("payments").upsert(
    {
      clover_merchant_id: merchantId,
      clover_payment_id: p.id,
      clover_order_id: p.order?.id ?? null,
      clover_employee_id: p.employee?.id ?? null,
      amount_cents: cents(p.amount),
      tax_amount_cents: cents(p.taxAmount),
      tip_amount_cents: cents(p.tipAmount),
      cash_tendered_cents: cents(p.cashTendered),
      payment_type: p.tender?.label ?? p.tender?.type ?? null,
      result,
      voided,
      refunded_amount_cents: cents(p.refundedAmount),
      card_type: p.cardTransaction?.cardType ?? null,
      currency: p.currency ?? "USD",
      created_time: typeof p.createdTime === "number" ? p.createdTime : 0,
    },
    { onConflict: "clover_merchant_id,clover_payment_id" },
  );
  if (error) throw new Error(`upsert payment: ${error.message}`);
}

export async function upsertRefund(merchantId: string, r: any) {
  const sb = getSupabaseServer();
  const { error } = await sb.from("refunds").upsert(
    {
      clover_merchant_id: merchantId,
      clover_refund_id: r.id,
      clover_order_id: r.order?.id ?? null,
      clover_payment_id: r.payment?.id ?? null,
      amount_cents: cents(r.amount),
      tax_amount_cents: cents(r.taxAmount),
      tip_amount_cents: cents(r.tipAmount),
      currency: r.currency ?? "USD",
      created_time: typeof r.createdTime === "number" ? r.createdTime : 0,
    },
    { onConflict: "clover_merchant_id,clover_refund_id" },
  );
  if (error) throw new Error(`upsert refund: ${error.message}`);
}

export async function upsertDiscount(merchantId: string, d: any) {
  const sb = getSupabaseServer();
  const { error } = await sb.from("discounts").upsert(
    {
      clover_merchant_id: merchantId,
      clover_discount_id: d.id,
      name: d.name ?? null,
      amount_cents: cents(d.amount),
      percentage: d.percentage != null ? num(d.percentage) : null,
    },
    { onConflict: "clover_merchant_id,clover_discount_id" },
  );
  if (error) throw new Error(`upsert discount: ${error.message}`);
}

export async function upsertModifierGroup(merchantId: string, g: any) {
  const sb = getSupabaseServer();
  const { error } = await sb.from("modifier_groups").upsert(
    {
      clover_merchant_id: merchantId,
      clover_modifier_group_id: g.id,
      name: g.name ?? null,
    },
    { onConflict: "clover_merchant_id,clover_modifier_group_id" },
  );
  if (error) throw new Error(`upsert modifier group: ${error.message}`);
}

export async function upsertModifier(merchantId: string, m: any) {
  const sb = getSupabaseServer();
  const { error } = await sb.from("modifiers").upsert(
    {
      clover_merchant_id: merchantId,
      clover_modifier_id: m.id,
      clover_modifier_group_id: m.modifierGroup?.id ?? null,
      name: m.name ?? null,
      price_cents: cents(m.price ?? m.amount),
    },
    { onConflict: "clover_merchant_id,clover_modifier_id" },
  );
  if (error) throw new Error(`upsert modifier: ${error.message}`);
}

/**
 * Derive payment status from Clover order + payments.
 * Only SUCCESS (non-voided) payments count as captured funds.
 * Refunds reduce the effective paid amount.
 */
export function derivePaymentStatus(order: any, payments: any[]): string {
  const total = cents(order.total);
  const successful = payments.filter((p) => !p.result || p.result === "SUCCESS");
  const paid = successful.reduce((s, p) => s + cents(p.amount), 0);
  const refunded = successful.reduce((s, p) => s + cents(p.refundedAmount), 0);
  const netPaid = paid - refunded;
  if (total <= 0 && payments.length === 0) return "OPEN";
  if (refunded > 0 && refunded >= paid && paid > 0) return "REFUNDED";
  if (netPaid === 0) return "OPEN";
  if (netPaid < total) return "PARTIALLY_PAID";
  return "PAID";
}

export async function upsertOrderRecord(merchantId: string, order: any) {
  const sb = getSupabaseServer();
  const currency = order.currency ?? "USD";
  const payments: any[] = order.payments?.elements ?? order.payments ?? [];
  const refunds: any[] = order.refunds?.elements ?? order.refunds ?? [];
  const discounts: any[] = order.discounts?.elements ?? order.discounts ?? [];
  const lineItems: any[] = order.lineItems?.elements ?? order.lineItems ?? [];

  const total = cents(order.total);

  // NET SALES = sum of line-item totals (unit*qty + modifiers - line discounts).
  // This matches how Clover's dashboard reports "Net Sales" rather than the
  // order `total`, which is 0 for many Clover orders. Order-level discounts,
  // tax, tip, and service charge are excluded — Clover's Net Sales excludes them too.
  // ALWAYS recompute on every upsert so previously-stored rows (with NULL
  // net_sales_cents) get corrected when re-synced.
  const netSales = lineItems.reduce((s, li) => {
    const unit = cents(li.price);
    const qty = num(li.quantity ?? 1);
    const mods = (li.modifiers?.elements ?? li.modifiers ?? []).reduce(
      (ms: number, m: any) => ms + cents(m.amount ?? m.price),
      0,
    );
    const disc = (li.discounts?.elements ?? li.discounts ?? []).reduce(
      (ds: number, d: any) => ds + cents(d.amount),
      0,
    );
    return s + Math.max(0, unit * qty + mods - disc);
  }, 0);

  const subtotal = netSales; // subtotal == net sales before order-level discounts/tax
  const discountTotal = discounts.reduce((s, d) => s + cents(d.amount), 0);
  const taxTotal = cents(order.taxAmount) + lineItems.reduce((s, li) => s + cents(li.taxAmount), 0);
  const serviceCharge = cents(order.serviceCharge?.amount);
  const tip = payments.reduce((s, p) => s + cents(p.tipAmount), 0);
  const totalRefunded = refunds.reduce((s, r) => s + cents(r.amount), 0);
  // Net total = order.total minus refunds. If order.total is 0 (common),
  // fall back to netSales so the order still carries a meaningful total.
  const netTotal = Math.max(0, (total > 0 ? total : netSales) - totalRefunded);

  const paymentStatus = derivePaymentStatus(order, payments);
  const voided =
    payments.length > 0 && payments.every((p) => p.result === "VOIDED" || p.result === "FAILED");

  const row = {
    clover_merchant_id: merchantId,
    clover_order_id: order.id,
    clover_customer_id: order.customer?.id ?? order.customers?.elements?.[0]?.id ?? null,
    status: "pending",
    payment_status: paymentStatus,
    currency,
    total_cents: total,
    net_total_cents: netTotal,
    net_sales_cents: netSales,
    subtotal_cents: subtotal,
    discount_total_cents: discountTotal,
    tax_total_cents: taxTotal,
    service_charge_cents: serviceCharge,
    tip_cents: tip,
    total_refunded_cents: totalRefunded,
    voided,
    created_time: typeof order.createdTime === "number" ? order.createdTime : 0,
    modified_time: typeof order.modifiedTime === "number" ? order.modifiedTime : null,
    location_name: null,
    clover_employee_id: order.employee?.id ?? null,
    order_type: order.orderType?.label ?? order.orderType ?? null,
    group_line_items: !!order.groupLineItems,
    test_mode: !!order.testMode,
  };

  const { data, error } = await sb
    .from("orders")
    .upsert(row, { onConflict: "clover_merchant_id,clover_order_id" })
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`upsert order: ${error.message}`);
  return data;
}

export async function upsertOrderItemRecord(
  merchantId: string,
  orderRowId: string,
  orderId: string,
  li: any,
  currency: string,
  paymentStatus: string,
  createdTime: number,
) {
  const sb = getSupabaseServer();
  const { error } = await sb
    .from("order_items")
    .upsert(
      buildOrderItemRow(merchantId, orderRowId, orderId, li, currency, paymentStatus, createdTime),
      {
        onConflict: "purchase_reference",
      },
    );
  if (error) throw new Error(`upsert order item: ${error.message}`);
}

/**
 * Build a single order_items row object from a Clover line item, without
 * writing it. Shared by the single-row and bulk upsert paths so the two
 * paths can never drift in shape.
 */
function buildOrderItemRow(
  merchantId: string,
  orderRowId: string,
  orderId: string,
  li: any,
  currency: string,
  paymentStatus: string,
  createdTime: number,
) {
  const unit = cents(li.price);
  const qty = num(li.quantity ?? 1);
  const modifiers = (li.modifiers?.elements ?? li.modifiers ?? []).map((m: any) => ({
    name: m.name ?? "Modifier",
    amount: cents(m.amount ?? m.price),
  }));
  const lineDiscounts = (li.discounts?.elements ?? li.discounts ?? []).map((d: any) => ({
    name: d.name,
    amount: cents(d.amount),
  }));
  const discountCents = lineDiscounts.reduce((s: number, d: any) => s + d.amount, 0);
  const modSum = modifiers.reduce((s: number, m: any) => s + m.amount, 0);
  const lineTotal = Math.max(0, unit * qty + modSum - discountCents);

  const ref = purchaseReference(merchantId, orderId, li.id);
  return {
    order_id: orderRowId,
    clover_line_item_id: li.id,
    clover_item_id: li.item?.id ?? li.itemId ?? null,
    clover_order_id: orderId,
    clover_merchant_id: merchantId,
    purchase_reference: ref,
    item_name: li.name ?? "Item",
    category: li.categoryName ?? li.category?.name ?? null,
    quantity: qty,
    unit_price_cents: unit,
    line_total_cents: lineTotal,
    currency,
    payment_status: paymentStatus,
    status: "pending",
    flag: null,
    modifiers_json: modifiers.length ? JSON.stringify(modifiers) : null,
    discounts_json: lineDiscounts.length ? JSON.stringify(lineDiscounts) : null,
    unit_name: li.unitName ?? null,
    note: li.note ?? null,
    created_time: createdTime,
  };
}

/**
 * Build an orders row object from a Clover order, without writing it.
 * Shared by the single-row and bulk upsert paths.
 */
function buildOrderRow(merchantId: string, order: any) {
  const currency = order.currency ?? "USD";
  const payments: any[] = order.payments?.elements ?? order.payments ?? [];
  const refunds: any[] = order.refunds?.elements ?? order.refunds ?? [];
  const discounts: any[] = order.discounts?.elements ?? order.discounts ?? [];
  const lineItems: any[] = order.lineItems?.elements ?? order.lineItems ?? [];

  const total = cents(order.total);

  const netSales = lineItems.reduce((s, li) => {
    const unit = cents(li.price);
    const qty = num(li.quantity ?? 1);
    const mods = (li.modifiers?.elements ?? li.modifiers ?? []).reduce(
      (ms: number, m: any) => ms + cents(m.amount ?? m.price),
      0,
    );
    const disc = (li.discounts?.elements ?? li.discounts ?? []).reduce(
      (ds: number, d: any) => ds + cents(d.amount),
      0,
    );
    return s + Math.max(0, unit * qty + mods - disc);
  }, 0);

  const subtotal = netSales;
  const discountTotal = discounts.reduce((s, d) => s + cents(d.amount), 0);
  const taxTotal = cents(order.taxAmount) + lineItems.reduce((s, li) => s + cents(li.taxAmount), 0);
  const serviceCharge = cents(order.serviceCharge?.amount);
  const tip = payments.reduce((s, p) => s + cents(p.tipAmount), 0);
  const totalRefunded = refunds.reduce((s, r) => s + cents(r.amount), 0);
  const netTotal = Math.max(0, (total > 0 ? total : netSales) - totalRefunded);

  const paymentStatus = derivePaymentStatus(order, payments);
  const voided =
    payments.length > 0 && payments.every((p) => p.result === "VOIDED" || p.result === "FAILED");

  return {
    clover_merchant_id: merchantId,
    clover_order_id: order.id,
    clover_customer_id: order.customer?.id ?? order.customers?.elements?.[0]?.id ?? null,
    status: "pending",
    payment_status: paymentStatus,
    currency,
    total_cents: total,
    net_total_cents: netTotal,
    net_sales_cents: netSales,
    subtotal_cents: subtotal,
    discount_total_cents: discountTotal,
    tax_total_cents: taxTotal,
    service_charge_cents: serviceCharge,
    tip_cents: tip,
    total_refunded_cents: totalRefunded,
    voided,
    created_time: typeof order.createdTime === "number" ? order.createdTime : 0,
    modified_time: typeof order.modifiedTime === "number" ? order.modifiedTime : null,
    location_name: null,
    clover_employee_id: order.employee?.id ?? null,
    order_type: order.orderType?.label ?? order.orderType ?? null,
    group_line_items: !!order.groupLineItems,
    test_mode: !!order.testMode,
  };
}

/**
 * Bulk-upsert a batch of Clover orders in a single Supabase call and return
 * the persisted rows (with their real UUID ids) keyed by clover_order_id.
 * Used by the historical backfill to avoid one round-trip per order.
 * Chunks internally to stay under Supabase's per-request row ceiling.
 */
export async function bulkUpsertOrders(
  merchantId: string,
  orders: any[],
  chunkSize = 200,
): Promise<Map<string, { id: string; clover_order_id: string }>> {
  const sb = getSupabaseServer();
  const result = new Map<string, { id: string; clover_order_id: string }>();
  for (let i = 0; i < orders.length; i += chunkSize) {
    const chunk = orders.slice(i, i + chunkSize);
    const rows = chunk.map((o) => buildOrderRow(merchantId, o));
    const { data, error } = await sb
      .from("orders")
      .upsert(rows, { onConflict: "clover_merchant_id,clover_order_id" })
      .select("id, clover_order_id");
    if (error) throw new Error(`bulk upsert orders: ${error.message}`);
    for (const r of data ?? []) result.set(r.clover_order_id, r);
  }
  return result;
}

/**
 * Bulk-upsert a batch of order line items in a single Supabase call.
 * `itemRows` must already be built via buildOrderItemRowsForSlice.
 * Chunks internally to stay under Supabase's per-request row ceiling.
 */
export async function bulkUpsertOrderItems(itemRows: any[], chunkSize = 500): Promise<void> {
  const sb = getSupabaseServer();
  for (let i = 0; i < itemRows.length; i += chunkSize) {
    const chunk = itemRows.slice(i, i + chunkSize);
    const { error } = await sb
      .from("order_items")
      .upsert(chunk, { onConflict: "purchase_reference" });
    if (error) throw new Error(`bulk upsert order items: ${error.message}`);
  }
}

/**
 * Build all order_items rows for a slice of orders, mapping each line item
 * to its parent order's persisted UUID via `orderMap`.
 */
export function buildOrderItemRowsForSlice(
  merchantId: string,
  orders: any[],
  orderMap: Map<string, { id: string; clover_order_id: string }>,
): { rows: any[]; missingOrderIds: string[] } {
  const rows: any[] = [];
  const missingOrderIds: string[] = [];
  for (const order of orders) {
    const orderRow = orderMap.get(order.id);
    if (!orderRow) {
      missingOrderIds.push(order.id);
      continue;
    }
    const currency = order.currency ?? "USD";
    const createdTime = typeof order.createdTime === "number" ? order.createdTime : 0;
    const paymentStatus = derivePaymentStatus(
      order,
      order.payments?.elements ?? order.payments ?? [],
    );
    const lineItems: any[] = order.lineItems?.elements ?? order.lineItems ?? [];
    for (const li of lineItems) {
      rows.push(
        buildOrderItemRow(
          merchantId,
          orderRow.id,
          order.id,
          li,
          currency,
          paymentStatus,
          createdTime,
        ),
      );
    }
  }
  return { rows, missingOrderIds };
}
