// Shared, browser-safe types for the Clover <-> CRM middleware.
// No secrets, no server-only imports. Imported by both UI and server code.

export type AlternateAttempt = {
  status: number;
  authMode: string;
  body: string;
};

export type ConnectionDiagnostic = {
  // The exact endpoint path + method used for the primary auth probe.
  endpoint: string;
  method: string;
  baseUrl: string;
  // How the credential was sent (never the credential itself).
  authMode: string;
  httpStatus: number | null;
  // Raw response body from the API (sanitized, truncated, no secrets).
  responseBody: string;
  // Non-secret indicators (Clover) so the user can confirm the runtime
  // loaded the secret without ever exposing the token value.
  tokenLoaded?: boolean;
  tokenLength?: number;
  merchantId?: string;
  // If a second auth mode was tried (e.g. query param after Bearer 401),
  // its result is surfaced here so the user sees both attempts failed.
  alternateAttempt?: AlternateAttempt | null;
};

export type CloverConnectionDetail = {
  connected: boolean;
  detail: string;
  environment: "sandbox" | "production";
  merchantId: string;
  merchantName: string | null;
  baseUrl: string;
  httpStatus: number | null;
  errorCode: string | null;
  // Data-validation probes (null = not tested / not reachable).
  validation: {
    merchantApi: boolean | null;
    ordersApi: boolean | null;
    customersApi: boolean | null;
    paymentsApi: boolean | null;
    inventoryApi: boolean | null;
  };
  diagnostic: ConnectionDiagnostic | null;
};

export type GhlConnectionDetail = {
  connected: boolean;
  detail: string;
  locationId: string;
  httpStatus: number | null;
  errorCode: string | null;
  diagnostic: ConnectionDiagnostic | null;
};

export type ConnectionStatus = {
  supabase: { connected: boolean; detail: string };
  clover: CloverConnectionDetail;
  ghl: GhlConnectionDetail;
};

export type CloverMoney = {
  // Clover returns integer minor units + currency code.
  cents: number;
  currency: string;
};

export type CloverCustomer = {
  id: string;
  merchantId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  // raw addresses etc. omitted for the DTO
};

export type CloverLineItem = {
  id: string; // line item id
  name: string;
  price: CloverMoney;
  quantity: number;
  note: string | null;
  modifiers: Array<{
    name: string;
    amount: CloverMoney;
  }>;
  discountAmount: CloverMoney;
  cloverItemId: string | null;
  category: string | null;
};

export type CloverOrder = {
  id: string;
  merchantId: string;
  orderType: string | null;
  createdTime: number; // ms epoch (Clover purchase timestamp)
  customer: CloverCustomer | null;
  customerIds: string[]; // all customer ids attached
  lineItems: CloverLineItem[];
  total: CloverMoney;
  paymentStatus: "PAID" | "PARTIALLY_PAID" | "OPEN" | "REFUNDED" | "UNKNOWN";
  currency: string;
  locationName: string | null;
};

export type CloverRecentOrderSummary = {
  id: string;
  total: CloverMoney;
  createdTime: number;
  paymentStatus: "PAID" | "PARTIALLY_PAID" | "OPEN" | "REFUNDED" | "UNKNOWN";
  customerName: string | null;
  itemsCount: number;
};

export type MatchDecision =
  "matched_existing" | "will_create" | "held_for_review" | "anonymous" | "auto_create";

export type CustomerMatchPreview = {
  decision: MatchDecision;
  reason: string;
  // The GHL contact id we will use, if known ahead of sync.
  ghlContactId: string | null;
  // Candidates found during the lookup (for transparency).
  candidates: Array<{
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    matchedBy: "email" | "phone" | "mapping";
  }>;
};

export type OrderPreview = {
  order: CloverOrder;
  match: CustomerMatchPreview;
  // Per-line eligibility + the deterministic purchase reference.
  items: Array<{
    lineItem: CloverLineItem;
    purchaseReference: string;
    eligible: boolean;
    flag: string | null;
  }>;
  orderEligible: boolean;
  orderFlag: string | null;
};

export type SyncOutcome = "synced" | "partial" | "held_for_review" | "skipped" | "error";

export type SyncResult = {
  outcome: SyncOutcome;
  message: string;
  // What was written.
  ghlContactId: string | null;
  matchedBy: string | null;
  purchaseRecordIds: string[];
  itemsSynced: number;
  itemsHeld: number;
  // If something needs human attention.
  reviewReason: string | null;
  // Actionable error, if any.
  error: string | null;
};

export type AdminSession = {
  userId: string;
  email: string;
} | null;

// ---- Provider status (slim, no payloads) -------------------------------

export type ProviderStatus = {
  provider: "clover" | "ghl";
  status: "connected" | "error";
  identifier?: string | null;
};

// ---- POS data / dashboard types (browser-safe DTOs) -------------------

export type ListResult<T> = {
  rows: T[];
  total: number;
};

export type OrderListItem = {
  id: string;
  cloverOrderId: string;
  cloverCustomerId: string | null;
  ghlContactId: string | null;
  status: string;
  paymentStatus: string;
  currency: string;
  totalCents: number;
  createdTime: number;
  locationName: string | null;
  // Meaningful mapping + sync status from the purchase-mapping pipeline.
  mappingStatus: string | null;
  matchMethod: string | null;
  processedAt: string | null;
  // Derived, human-readable sync status for display.
  syncStatus: string;
};

export type OrderItemListRow = {
  id: string;
  orderId: string;
  cloverLineItemId: string;
  cloverItemId: string | null;
  purchaseReference: string;
  itemName: string;
  category: string | null;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
  currency: string;
  paymentStatus: string;
  status: string;
  flag: string | null;
};

export type CustomerListItem = {
  cloverCustomerId: string;
  ghlContactId: string | null;
  matchedBy: string | null;
  orderCount: number;
  totalSpendCents: number;
  lastVisitMs: number;
};

export type ProductListItem = {
  cloverItemId: string | null;
  name: string;
  category: string | null;
  priceCents: number;
  quantitySold: number;
  revenueCents: number;
  orderCount: number;
};

export type DashboardStats = {
  hasData: boolean;
  filterRange?: "today" | "week" | "month" | "all";
  totalSalesCents: number;
  totalOrders: number;
  totalCustomers: number;
  totalItemsSold: number;
  todaySalesCents: number;
  todayOrdersCount: number;
  thisWeekSalesCents: number;
  thisWeekOrdersCount: number;
  thisMonthSalesCents: number;
  thisMonthOrdersCount: number;
  // Metrics calculated for the active filter range
  filteredSalesCents: number;
  filteredOrdersCount: number;
  filteredPaidOrdersCount: number;
  filteredAverageOrderValueCents: number;
  filteredCustomersCount: number;
  filteredItemsSoldCount: number;
  averageOrderValueCents: number;
  topItems: Array<{
    name: string;
    category: string | null;
    quantity: number;
    revenueCents: number;
  }>;
  topCategories: Array<{ name: string; revenueCents: number }>;
  recentOrders: OrderListItem[];
};

// ---- Sync run / refresh types ------------------------------------------

export type SyncRunSummary = {
  runId: string;
  status: "completed" | "failed";
  merchantId: string;
  kind: string;
  rangeStart: number | null;
  rangeEnd: number | null;
  ordersFetched: number;
  ordersUpserted: number;
  orderItemsFetched: number;
  orderItemsUpserted: number;
  customersFetched: number;
  customersUpserted: number;
  paymentsFetched: number;
  paymentsUpserted: number;
  refundsFetched: number;
  productsFetched: number;
  productsUpserted: number;
  categoriesFetched: number;
  categoriesUpserted: number;
  employeesFetched: number;
  employeesUpserted: number;
  modifiersFetched: number;
  discountsFetched: number;
  crmOrdersSynced: number;
  crmOrdersHeld: number;
  crmOrdersErrors: number;
  crmContactsCreated: number;
  crmPurchaseRecordsCreated: number;
  errors: string[];
  startedAt: string;
  finishedAt: string | null;
  // Reconciliation debug: lets us compare our totals directly against Clover.
  reconciliation?: {
    rangeLabel: string;
    rangeStartMs: number;
    rangeEndMs: number;
    ordersFetched: number;
    pagesFetched: number;
    paymentsFetched: number;
    refundsFetched: number;
    voidsFetched: number;
    grossSalesCents: number;
    discountsCents: number;
    taxesCents: number;
    tipsCents: number;
    serviceChargesCents: number;
    refundAmountCents: number;
    netSalesCents: number;
    paidOrderCount: number;
    itemsSold: number;
  };
};

export type LastSyncRun = {
  runId: string | null;
  status: string | null;
  kind: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  ordersUpserted: number;
  customersUpserted: number;
  paymentsUpserted: number;
  productsUpserted: number;
  errorMessage: string | null;
} | null;

// ---- Extended list row types -------------------------------------------

export type TransactionRow = {
  cloverPaymentId: string;
  cloverOrderId: string | null;
  date: number;
  amountCents: number;
  tipCents: number;
  taxCents: number;
  paymentType: string | null;
  result: string | null;
  cardType: string | null;
  currency: string;
  cloverEmployeeId: string | null;
};

export type ProductRow = {
  cloverItemId: string;
  name: string;
  category: string | null;
  sku: string | null;
  priceCents: number;
  quantitySold: number;
  revenueCents: number;
  orderCount: number;
};

export type CategoryRow = {
  cloverCategoryId: string;
  name: string;
  itemCount: number;
  quantitySold: number;
  revenueCents: number;
};

export type EmployeeRow = {
  cloverEmployeeId: string;
  name: string;
  orderCount: number;
  salesCents: number;
};

export type CustomerDetailRow = {
  cloverCustomerId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  orderCount: number;
  totalSpendCents: number;
  averageOrderCents: number;
  lastVisitMs: number;
  ghlContactId: string | null;
  matchedBy: string | null;
  matchStatus: string;
};

export type OrderDetailRow = {
  id: string;
  cloverOrderId: string;
  cloverCustomerId: string | null;
  cloverEmployeeId: string | null;
  orderType: string | null;
  status: string;
  paymentStatus: string;
  currency: string;
  createdTime: number;
  modifiedTime: number | null;
  subtotalCents: number;
  discountTotalCents: number;
  taxTotalCents: number;
  serviceChargeCents: number;
  tipCents: number;
  totalCents: number;
  totalRefundedCents: number;
  locationName: string | null;
  items: Array<{
    cloverLineItemId: string;
    cloverItemId: string | null;
    itemName: string;
    category: string | null;
    quantity: number;
    unitPriceCents: number;
    lineTotalCents: number;
    modifiers: string | null;
    discounts: string | null;
  }>;
};
