// Server-only: per-customer aggregate loader for the audience engine.
// Fetches all orders, order_items, customers, and customer_mappings for the
// merchant (paginated to avoid the 1000-row PostgREST cap) and builds a
// per-customer aggregate used by the audience predicates.
import { getAudienceSupabaseServer } from "./supabase.server";
import { wallParts, wallDate, matchEventDate } from "./audience-dates.server";

export type OrderRow = {
  id: string;
  clover_order_id: string;
  clover_customer_id: string | null;
  total_cents: number;
  net_sales_cents: number;
  created_time: number;
  payment_status: string;
  voided: boolean | null;
};

export type ItemRow = {
  clover_order_id: string | null;
  order_id: string;
  item_name: string;
  clover_item_id: string | null;
  category: string | null;
  quantity: number;
  line_total_cents: number;
  created_time: number | null;
};

export type CustomerAgg = {
  cloverCustomerId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  marketingAllowed: boolean | null;
  createdAt: string;
  ghlContactId: string | null;
  matchMethod: string | null;
  orders: OrderRow[];
  items: ItemRow[];
  lifetimeSpend: number;
  firstVisit: number;
  lastVisit: number;
  visitCount: number;
  visitDays: Set<string>;
  visitDows: Set<number>;
  visitsByMonth: Map<string, number>;
  eventNights: Set<string>;
};

const PAGE = 1000;
// Keep `.in(order_id, ids)` URLs comfortably below common proxy/PostgREST URL
// limits. A 500 UUID batch can exceed 16 KB once encoded by Supabase JS.
const ITEM_ORDER_BATCH = 100;
const ITEM_BATCH_CONCURRENCY = 4;

async function fetchAllOrders(
  sb: ReturnType<typeof getAudienceSupabaseServer>,
  mid: string,
): Promise<OrderRow[]> {
  const out: OrderRow[] = [];
  let off = 0;
  for (;;) {
    const { data, error } = await sb
      .from("orders")
      .select(
        "id,clover_order_id,clover_customer_id,total_cents,net_sales_cents,created_time,payment_status,voided",
      )
      .eq("clover_merchant_id", mid)
      .order("created_time", { ascending: true })
      .range(off, off + PAGE - 1);
    if (error) {
      throw new Error(`Audience orders query failed: ${error.message}`);
    }
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
    off += PAGE;
  }
  return out;
}

async function fetchAllItems(
  sb: ReturnType<typeof getAudienceSupabaseServer>,
  orderIds: string[],
): Promise<ItemRow[]> {
  const out: ItemRow[] = [];
  // Filter via merchant-scoped orders. Legacy order_items can have a null
  // clover_merchant_id, which made the old merchant filter hide their products.
  const batches: string[][] = [];
  for (let start = 0; start < orderIds.length; start += ITEM_ORDER_BATCH) {
    batches.push(orderIds.slice(start, start + ITEM_ORDER_BATCH));
  }

  for (let start = 0; start < batches.length; start += ITEM_BATCH_CONCURRENCY) {
    const rowsByBatch = await Promise.all(
      batches.slice(start, start + ITEM_BATCH_CONCURRENCY).map(async (ids) => {
        const batchRows: ItemRow[] = [];
        let off = 0;
        for (;;) {
          const { data, error } = await sb
            .from("order_items")
            .select(
              "clover_order_id,order_id,item_name,clover_item_id,category,quantity,line_total_cents,created_time",
            )
            .in("order_id", ids)
            .range(off, off + PAGE - 1);
          if (error) throw new Error(`Audience order_items query failed: ${error.message}`);
          batchRows.push(...(data ?? []));
          if (!data || data.length < PAGE) break;
          off += PAGE;
        }
        return batchRows;
      }),
    );
    for (const rows of rowsByBatch) out.push(...rows);
  }
  return out;
}

export async function loadAggregates(): Promise<{
  byCustomer: Map<string, CustomerAgg>;
  allCustomers: CustomerAgg[];
  warnings: string[];
}> {
  const warnings: string[] = [];
  let sb: ReturnType<typeof getAudienceSupabaseServer> | null = null;
  let mid = "";
  try {
    sb = getAudienceSupabaseServer();
    mid = (process.env["CLOVER_MERCHANT_ID"] ?? "").trim();
    if (!mid) {
      throw new Error("Missing CLOVER_MERCHANT_ID");
    }
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    warnings.push(`Configuration error: ${msg}. Add the missing secrets in Settings → Secrets.`);
    return { byCustomer: new Map(), allCustomers: [], warnings };
  }

  let orders: OrderRow[] = [];
  let items: ItemRow[] = [];
  try {
    if (sb && mid) {
      orders = await fetchAllOrders(sb, mid);
      items = await fetchAllItems(
        sb,
        orders.map((o) => o.id),
      );
    }
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    warnings.push(`Orders/items fetch failed: ${msg}`);
  }

  // Paginate customers to avoid PostgREST's 1000-row default cap (DEF-011).
  const custRows: Array<{
    clover_customer_id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    phone: string | null;
    marketing_allowed: boolean | null;
    created_at: string;
  }> = [];
  try {
    let off = 0;
    for (;;) {
      const { data, error } = await sb
        .from("customers")
        .select("clover_customer_id,first_name,last_name,email,phone,marketing_allowed,created_at")
        .eq("clover_merchant_id", mid)
        .range(off, off + PAGE - 1);
      if (error) {
        warnings.push(`Customers query error: ${error.message}`);
        break;
      }
      custRows.push(...(data ?? []));
      if (!data || data.length < PAGE) break;
      off += PAGE;
    }
  } catch (e) {
    warnings.push(`Customers fetch failed: ${(e as Error)?.message ?? String(e)}`);
  }

  // Paginate customer_mappings — same reason (DEF-011).
  let mapRows: Array<{
    clover_customer_id: string;
    ghl_contact_id: string | null;
    matched_by?: string | null;
  }> | null = null;
  try {
    const allMap: Array<{
      clover_customer_id: string;
      ghl_contact_id: string | null;
      matched_by?: string | null;
    }> = [];
    let off = 0;
    let ok = true;
    for (;;) {
      const { data: mData, error: mErr } = await sb
        .from("customer_mappings")
        .select("clover_customer_id,ghl_contact_id")
        .eq("clover_merchant_id", mid)
        .range(off, off + PAGE - 1);
      if (mErr) {
        warnings.push(`Customer mappings query error: ${mErr.message}`);
        ok = false;
        break;
      }
      allMap.push(...(mData ?? []));
      if (!mData || mData.length < PAGE) break;
      off += PAGE;
    }
    if (ok) mapRows = allMap;
  } catch (e) {
    warnings.push(`Customer mappings fetch failed: ${(e as Error)?.message ?? String(e)}`);
  }

  const custMap = new Map((custRows ?? []).map((c) => [c.clover_customer_id, c]));
  const mapMap = new Map((mapRows ?? []).map((m) => [m.clover_customer_id, m]));

  // Index items by order_id and by clover_order_id.
  const itemsByOrderId = new Map<string, ItemRow[]>();
  const itemsByCloverOrderId = new Map<string, ItemRow[]>();
  for (const it of items) {
    if (it.order_id) {
      const arr = itemsByOrderId.get(it.order_id) ?? [];
      arr.push(it);
      itemsByOrderId.set(it.order_id, arr);
    }
    if (it.clover_order_id) {
      const arr = itemsByCloverOrderId.get(it.clover_order_id) ?? [];
      arr.push(it);
      itemsByCloverOrderId.set(it.clover_order_id, arr);
    }
  }

  const byCustomer = new Map<string, CustomerAgg>();

  function ensureAgg(cid: string): CustomerAgg {
    let agg = byCustomer.get(cid);
    if (!agg) {
      const c = custMap.get(cid);
      const m = mapMap.get(cid);
      agg = {
        cloverCustomerId: cid,
        firstName: c?.first_name ?? null,
        lastName: c?.last_name ?? null,
        email: c?.email ?? null,
        phone: c?.phone ?? null,
        marketingAllowed: c?.marketing_allowed ?? null,
        createdAt: c?.created_at ?? new Date().toISOString(),
        ghlContactId: m?.ghl_contact_id ?? null,
        matchMethod: m?.matched_by ?? null,
        orders: [],
        items: [],
        lifetimeSpend: 0,
        firstVisit: Infinity,
        lastVisit: 0,
        visitCount: 0,
        visitDays: new Set(),
        visitDows: new Set(),
        visitsByMonth: new Map(),
        eventNights: new Set(),
      };
      byCustomer.set(cid, agg);
    }
    return agg;
  }

  for (const o of orders) {
    // Only count identified customers (master plan: do not infer identity from
    // cardholder/payment credentials; anonymous walk-ins are excluded).
    if (!o.clover_customer_id) continue;
    // Exclude voided orders from spend/visit metrics.
    if (o.voided) continue;
    const agg = ensureAgg(o.clover_customer_id);
    const spend = o.net_sales_cents || o.total_cents || 0;
    agg.orders.push(o);
    agg.lifetimeSpend += spend;
    agg.visitCount += 1;
    const t = o.created_time || 0;
    if (t < agg.firstVisit) agg.firstVisit = t;
    if (t > agg.lastVisit) agg.lastVisit = t;
    agg.visitDays.add(wallDate(t));
    agg.visitDows.add(wallParts(t).dow);
    const p = wallParts(t);
    const ym = `${p.y}-${String(p.mo).padStart(2, "0")}`;
    agg.visitsByMonth.set(ym, (agg.visitsByMonth.get(ym) ?? 0) + 1);

    const oi = itemsByOrderId.get(o.id) ?? itemsByCloverOrderId.get(o.clover_order_id) ?? [];
    for (const it of oi) agg.items.push(it);

    const eventDate = matchEventDate(t);
    if (eventDate) agg.eventNights.add(eventDate);
  }

  return { byCustomer, allCustomers: Array.from(byCustomer.values()), warnings };
}
