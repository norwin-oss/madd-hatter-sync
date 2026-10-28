//
// Server-only GHL (Lead Connector) REST client.
// Docs: https://leadconnectorhq.com/ (REST API v1). Uses the Private Integration
// (PIT) bearer token. Reads token + location id from config.
import { getIntegrationConfig } from "./config.server";
import type { ConnectionDiagnostic } from "./types";

class GhlApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`GHL API error ${status}: ${body.slice(0, 300)}`);
    this.name = "GhlApiError";
    this.status = status;
    this.body = body;
  }
}

export async function ghlFetch(
  path: string,
  init: RequestInit = {},
  version: string = "2021-07-28",
): Promise<any> {
  const cfg = getIntegrationConfig();
  const rawToken = cfg.ghl.pitToken?.trim() ?? "";
  const url = path.startsWith("http") ? path : `${cfg.ghl.apiBase}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${rawToken}`,
      Version: version,
      // channelId (Location ID) is REQUIRED for subaccount-level Private
      // Integration Tokens. Without it, GHL silently rejects or scopes-down
      // requests on endpoints that enforce subaccount scoping.
      channelId: cfg.ghl.locationId,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new GhlApiError(res.status, text);
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// ---- Connection --------------------------------------------------------

export type GhlConnectionDetail = {
  connected: boolean;
  detail: string;
  locationId: string;
  httpStatus: number | null;
  errorCode: string | null;
  diagnostic: ConnectionDiagnostic | null;
};

export async function checkGhlConnection(): Promise<GhlConnectionDetail> {
  const cfg = getIntegrationConfig();
  const base: GhlConnectionDetail = {
    connected: false,
    detail: "",
    locationId: cfg.ghl.locationId,
    httpStatus: null,
    errorCode: null,
    diagnostic: null,
  };
  try {
    const path = `/locations/${cfg.ghl.locationId}`;
    const rawToken = cfg.ghl.pitToken?.trim() ?? "";
    const res = await fetch(`${cfg.ghl.apiBase}${path}`, {
      headers: {
        Authorization: `Bearer ${rawToken}`,
        Version: "2021-07-28",
        channelId: cfg.ghl.locationId,
        Accept: "application/json",
      },
    });
    const text = await res.text();
    base.httpStatus = res.status;
    base.diagnostic = {
      endpoint: path,
      method: "GET",
      baseUrl: cfg.ghl.apiBase,
      authMode: "Authorization: Bearer header (PIT)",
      httpStatus: res.status,
      responseBody: text.slice(0, 500),
    };
    if (!res.ok) throw new GhlApiError(res.status, text);
    const json = text ? JSON.parse(text) : null;
    base.connected = true;
    const name = json?.location?.name ?? json?.name;
    base.detail = `Connected to location: ${name ?? cfg.ghl.locationId}`;
    return base;
  } catch (e: any) {
    if (e instanceof GhlApiError) {
      base.httpStatus = e.status;
      const bodyMsg = (() => {
        try {
          const p = JSON.parse(e.body);
          return p?.message ?? p?.error ?? e.body.slice(0, 160);
        } catch {
          return e.body.slice(0, 160);
        }
      })();
      if (e.status === 401) {
        base.errorCode = "GHL_SCOPE_OR_AUTH_FAILED";
        base.detail =
          `PIT token rejected (401): ${bodyMsg}. ` +
          `Regenerate the PIT in the same sub-account as location ${cfg.ghl.locationId} ` +
          `with scopes: users.read, contacts.read/write, custom-objects.read/write.`;
      } else if (e.status === 403) {
        base.errorCode = "GHL_FORBIDDEN";
        base.detail = `PIT token lacks permission (403): ${bodyMsg}`;
      } else if (e.status === 404) {
        base.errorCode = "GHL_LOCATION_NOT_FOUND";
        base.detail = `Location ${cfg.ghl.locationId} not found for this PIT (404).`;
      } else {
        base.errorCode = `GHL_HTTP_${e.status}`;
        base.detail = `GHL ${e.status}: ${bodyMsg}`;
      }
      if (!base.diagnostic) {
        base.diagnostic = {
          endpoint: `/locations/${cfg.ghl.locationId}`,
          method: "GET",
          baseUrl: cfg.ghl.apiBase,
          authMode: "Authorization: Bearer header (PIT)",
          httpStatus: e.status,
          responseBody: e.body.slice(0, 500),
        };
      }
    } else {
      base.errorCode = "GHL_REQUEST_ERROR";
      base.detail = e?.message ?? "GHL connection failed";
    }
    return base;
  }
}

// ---- Custom object schema discovery -----------------------------------

export type CustomObjectSchema = {
  id: string;
  name: string;
  key: string;
  fields: CustomObjectField[];
};

export type CustomObjectField = {
  id: string;
  name: string;
  key: string;
  type: string;
};

export type SchemaDiscoveryDebug = {
  probed: Array<{
    endpoint: string;
    status: number | null;
    error?: string;
    summary?: any;
    bodySample?: string;
  }>;
};

export async function findPurchaseObjectSchema(): Promise<{
  schema: CustomObjectSchema | null;
  debug: SchemaDiscoveryDebug;
}> {
  const cfg = getIntegrationConfig();
  const debug: SchemaDiscoveryDebug = { probed: [] };

  const objectId = cfg.ghl.purchaseObjectSchemaKey || "6aad9f812c282b1dfcb1c1b8";

  // Official documentation (Objects API):
  // 1. GET /objects/?locationId={locationId} with Version: "2021-07-28" returns all objects.
  // 2. GET /objects/{key}?locationId={locationId}&fetchProperties=true returns schema + fields.
  const endpointsToTry: Array<{ path: string; version: string }> = [
    { path: `/objects/?locationId=${cfg.ghl.locationId}`, version: "2021-07-28" },
    {
      path: `/objects/custom_objects.pos_purchase_item?locationId=${cfg.ghl.locationId}&fetchProperties=true`,
      version: "2021-07-28",
    },
    {
      path: `/objects/${objectId}?locationId=${cfg.ghl.locationId}&fetchProperties=true`,
      version: "2021-07-28",
    },
    {
      path: `/objects/custom_objects.pos_purchase_item?locationId=${cfg.ghl.locationId}`,
      version: "2021-07-28",
    },
    {
      path: `/objects/${objectId}?locationId=${cfg.ghl.locationId}`,
      version: "2021-07-28",
    },
  ];

  let foundMatch: CustomObjectSchema | null = null;

  for (const { path: ep, version: ver } of endpointsToTry) {
    try {
      const json = await ghlFetch(ep, {}, ver);
      const candidates =
        json?.schemas ??
        json?.customObjects ??
        json?.objects ??
        json?.customFields ??
        json?.data ??
        json?.results ??
        (Array.isArray(json) ? json : null);

      const count = Array.isArray(candidates)
        ? candidates.length
        : json
          ? typeof json === "object"
            ? Object.keys(json).length
            : 1
          : 0;

      debug.probed.push({
        endpoint: ep,
        status: 200,
        summary: {
          hasCandidates: Array.isArray(candidates),
          count,
          keys: json && typeof json === "object" ? Object.keys(json).slice(0, 10) : [],
        },
        bodySample: JSON.stringify(json).slice(0, 300),
      });

      const rawFields = json?.customFields ?? (Array.isArray(json) ? json : []);
      if (Array.isArray(rawFields) && rawFields.length > 0) {
        const matchingFields = rawFields.filter((f: any) => {
          const fKey = (f.fieldKey ?? f.key ?? "").toLowerCase();
          const model = (f.model ?? "").toLowerCase();
          const folder = (f.folderName ?? "").toLowerCase();
          const name = (f.name ?? f.label ?? "").toLowerCase();
          return (
            fKey.includes("pos_purchase_item") ||
            model.includes("pos_purchase_item") ||
            folder.includes("pos purchase item") ||
            folder.includes("pos_purchase_item") ||
            fKey.includes("purchase_reference") ||
            name.includes("purchase reference")
          );
        });

        if (matchingFields.length > 0) {
          foundMatch = {
            id: "custom_objects.pos_purchase_item",
            key: "custom_objects.pos_purchase_item",
            name: "POS Purchase Item",
            fields: matchingFields.map((f: any) => ({
              id: f.id ?? f.fieldKey,
              key: f.fieldKey ?? f.key,
              name: f.name ?? f.label ?? f.fieldKey,
              type: f.dataType ?? f.type ?? "string",
            })),
          };
          break;
        }
      }

      const schemas: any[] = Array.isArray(candidates)
        ? candidates
        : json?.schema
          ? [json.schema]
          : json?.key || json?.id
            ? [json]
            : [];

      const match = schemas.find((s: any) => {
        const name = (
          s.name ??
          s.labels?.singular ??
          s.singularLabel ??
          s.title ??
          s.displayName ??
          ""
        ).toLowerCase();
        const plural = (s.labels?.plural ?? s.pluralLabel ?? "").toLowerCase();
        const key = (s.key ?? s.objectKey ?? s.id ?? "").toLowerCase();
        return (
          name.includes("pos purchase item") ||
          plural.includes("pos purchase item") ||
          key.includes("pos_purchase_item") ||
          key.includes("pospurchaseitem") ||
          name.includes("purchase item") ||
          key.includes("purchase_item") ||
          name.includes("pos purchase") ||
          key.includes("pos_purchase") ||
          key === "purchase"
        );
      });

      if (match) {
        let fieldsRaw: any[] = match.fields ?? match.properties ?? match.customFields ?? [];
        if (fieldsRaw.length === 0 && (match.id || match.key)) {
          const schemaKey = match.key || match.id;
          const detailEndpoints = [
            `/objects/${schemaKey}?locationId=${cfg.ghl.locationId}&fetchProperties=true`,
            `/objects/${match.id}?locationId=${cfg.ghl.locationId}&fetchProperties=true`,
          ];
          for (const dep of detailEndpoints) {
            try {
              const detail = await ghlFetch(dep, {}, "2021-07-28");
              if (detail) {
                fieldsRaw = detail.fields ?? detail.customFields ?? detail.properties ?? [];
                if (fieldsRaw.length > 0) break;
              }
            } catch {
              // continue
            }
          }
        }

        foundMatch = {
          id: match.id ?? match.key,
          name: match.name ?? match.labels?.singular ?? match.singularLabel ?? "POS Purchase Item",
          key: match.key ?? match.objectKey ?? match.id,
          fields: fieldsRaw.map((f: any) => ({
            id: f.id ?? f.fieldId ?? f.key,
            name: f.name ?? f.label ?? f.title ?? f.key,
            key: f.key ?? f.fieldKey ?? f.id,
            type: f.type ?? f.dataType ?? f.fieldType ?? "text",
          })),
        };
        break;
      }
    } catch (e: unknown) {
      const err = e as { status?: number; message?: string; body?: string };
      const entry: SchemaDiscoveryDebug["probed"][number] = {
        endpoint: ep,
        status: err.status ?? null,
        error: err.message ?? String(e),
      };
      if (err.body) {
        entry.bodySample = String(err.body).slice(0, 300);
      }
      debug.probed.push(entry);
    }
  }

  return { schema: foundMatch, debug };
}

export const EXPECTED_PURCHASE_FIELDS = [
  "Purchase Reference",
  "Item Name",
  "Category",
  "Quantity",
  "Unit Price",
  "Line Total",
  "Currency",
  "Purchase Date",
  "Clover Order ID",
  "Clover Line Item ID",
  "Clover Item ID",
  "Clover Merchant ID",
  "Clover Customer ID",
  "Location Name",
  "Payment Status",
] as const;

export type SchemaValidation = {
  ok: boolean;
  schema: CustomObjectSchema | null;
  missingFields: string[];
  fieldKeyMap: Record<string, string>;
};

export function validatePurchaseSchema(schema: CustomObjectSchema | null): SchemaValidation {
  if (!schema) {
    return {
      ok: false,
      schema: null,
      missingFields: [...EXPECTED_PURCHASE_FIELDS],
      fieldKeyMap: {},
    };
  }

  const normalize = (str: string) => str.toLowerCase().replace(/[^a-z0-9]/g, "");

  const byNormalized = new Map<string, string>();
  for (const f of schema.fields) {
    byNormalized.set(normalize(f.name), f.key);
    byNormalized.set(normalize(f.key), f.key);
    const strippedKey = f.key.split(".").pop() ?? f.key;
    byNormalized.set(normalize(strippedKey), f.key);
  }

  const fieldKeyMap: Record<string, string> = {};
  const missingFields: string[] = [];

  for (const name of EXPECTED_PURCHASE_FIELDS) {
    const key = byNormalized.get(normalize(name));
    if (key) {
      fieldKeyMap[name] = key;
    } else {
      missingFields.push(name);
    }
  }

  // ok = true whenever a schema exists AND the "Purchase Reference" dedup key
  // is present. Other missing fields are tolerated (record created with
  // available fields) but are surfaced as warnings.
  const hasDedupKey = !!fieldKeyMap["Purchase Reference"];
  return { ok: hasDedupKey, schema, missingFields, fieldKeyMap };
}

// ---- Contact lookup ----------------------------------------------------

export type GhlContact = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
};

function mapContact(c: any): GhlContact {
  return {
    id: c.id,
    firstName: c.firstName ?? c.contact?.firstName ?? "",
    lastName: c.lastName ?? c.contact?.lastName ?? "",
    email: c.email ?? c.contact?.email ?? "",
    phone: c.phone ?? c.contact?.phone ?? "",
  };
}

export async function searchContactsByEmail(email: string): Promise<GhlContact[]> {
  const cfg = getIntegrationConfig();
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail) return [];

  // Use the dedicated search endpoint with exact email param first, then
  // fall back to the query-based list endpoint.
  const queries = [
    `/contacts/search?locationId=${cfg.ghl.locationId}&email=${encodeURIComponent(cleanEmail)}&limit=25`,
    `/contacts/?locationId=${cfg.ghl.locationId}&query=${encodeURIComponent(cleanEmail)}&limit=25`,
    `/contacts/search/duplicate?locationId=${cfg.ghl.locationId}&email=${encodeURIComponent(cleanEmail)}`,
  ];

  for (const path of queries) {
    try {
      const json = await ghlFetch(path);
      const list: any[] = json?.contacts ?? json?.data ?? (json?.contact ? [json.contact] : []);
      const mapped = list.map(mapContact);
      // Require exact email match (case-insensitive) to avoid false positives.
      const exact = mapped.filter((c) => (c.email ?? "").toLowerCase() === cleanEmail);
      if (exact.length > 0) return exact;
      // FIX #15: Do NOT fall back to returning fuzzy/partial matches — a
      // non-exact email match could silently link an order to the wrong contact,
      // causing incorrect purchase records and tags on an unrelated person.
    } catch {
      // Continue trying fallback endpoint
    }
  }
  return [];
}

export async function searchContactsByPhone(phone: string): Promise<GhlContact[]> {
  const cfg = getIntegrationConfig();
  const cleanPhone = phone.trim();
  if (!cleanPhone) return [];

  const variants = new Set<string>([cleanPhone]);
  const digits = cleanPhone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    variants.add(`+1${digits.slice(1)}`);
    variants.add(digits.slice(1));
  } else if (digits.length === 10) {
    variants.add(`+1${digits}`);
    variants.add(`1${digits}`);
  }
  variants.add(`+${digits}`);

  for (const v of variants) {
    const queries = [
      `/contacts/search?locationId=${cfg.ghl.locationId}&phone=${encodeURIComponent(v)}&limit=25`,
      `/contacts/?locationId=${cfg.ghl.locationId}&query=${encodeURIComponent(v)}&limit=25`,
      `/contacts/search/duplicate?locationId=${cfg.ghl.locationId}&phone=${encodeURIComponent(v)}`,
    ];
    for (const path of queries) {
      try {
        const json = await ghlFetch(path);
        const list: any[] = json?.contacts ?? json?.data ?? (json?.contact ? [json.contact] : []);
        const mapped = list.map(mapContact);
        // Verify the returned contact's phone digits match to avoid
        // false positives from fuzzy query matching.
        const vDigits = v.replace(/\D/g, "");
        const exact = mapped.filter((c) => (c.phone ?? "").replace(/\D/g, "") === vDigits);
        if (exact.length > 0) return exact;
        if (mapped.length > 0) return mapped;
      } catch {
        // Continue trying next endpoint/variant
      }
    }
  }
  return [];
}

export async function createGhlContact(input: {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  note?: string;
}): Promise<GhlContact> {
  const cfg = getIntegrationConfig();
  const body: Record<string, any> = {
    locationId: cfg.ghl.locationId,
    tags: ["Clover POS Customer"],
    source: "Clover POS",
  };
  if (input.firstName) body["firstName"] = input.firstName;
  if (input.lastName) body["lastName"] = input.lastName;
  if (input.email) body["email"] = input.email;
  if (input.phone) body["phone"] = input.phone;

  // Use the Upsert Contact endpoint (POST /contacts/upsert) so GHL
  // deduplicates on email/phone based on subaccount "Allow Duplicate
  // Contact" settings — preventing duplicate contacts on repeated syncs.
  const json = await ghlFetch(`/contacts/upsert`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const c = json?.contact ?? json?.contacts?.[0] ?? json;
  return mapContact({ id: c.id, ...c });
}

export async function searchContactsByName(name: string): Promise<GhlContact[]> {
  const cfg = getIntegrationConfig();
  const q = name.trim();
  if (!q) return [];
  try {
    const json = await ghlFetch(
      `/contacts/?locationId=${cfg.ghl.locationId}&query=${encodeURIComponent(q)}&limit=10`,
    );
    const list: any[] = json?.contacts ?? json?.data ?? [];
    return list.map(mapContact);
  } catch {
    return [];
  }
}

// ---- Custom object record create + associate ---------------------------
//
// Official GHL docs (Objects API): POST /objects/:schemaKey/records
// Version header: 2021-07-28 (date string, per documented standard).
// Body: { locationId, properties: { field_key: value } }

export async function createPurchaseRecord(
  schemaId: string,
  fieldKeyMap: Record<string, string>,
  values: Record<string, string>,
): Promise<string> {
  const cfg = getIntegrationConfig();

  // Only include entries where the key was actually discovered in the live
  // GHL schema. Guessed/synthetic keys are skipped — they cause GHL 422 errors.
  const properties: Record<string, string> = {};
  for (const [displayName, val] of Object.entries(values)) {
    const key = fieldKeyMap[displayName];
    if (key !== undefined && key !== null) {
      properties[key] = val;
    }
  }

  // Fallback: If no schema fields matched, map standard properties directly to ensure properties is never empty
  if (Object.keys(properties).length === 0) {
    if (values["Purchase Reference"])
      properties["purchase_reference"] = values["Purchase Reference"];
    if (values["Item Name"]) properties["item_name"] = values["Item Name"];
    if (values["Line Total"]) properties["line_total"] = values["Line Total"];
  }

  const body = {
    locationId: cfg.ghl.locationId,
    properties,
  };

  const attempts: Array<{ path: string; version: string }> = [
    { path: `/objects/custom_objects.pos_purchase_item/records`, version: "2021-07-28" },
    { path: `/objects/${schemaId}/records`, version: "2021-07-28" },
  ];

  let json: any = null;
  let lastErr: any = null;
  for (const { path: ep, version: ver } of attempts) {
    try {
      json = await ghlFetch(ep, { method: "POST", body: JSON.stringify(body) }, ver);
      if (json?.record?.id || json?.id) break;
    } catch (e) {
      lastErr = e;
    }
  }

  const recordId = json?.record?.id ?? json?.id;
  if (!recordId)
    throw new Error(`CRM record creation failed: ${lastErr?.message ?? "no record id returned"}`);
  return recordId as string;
}

export async function associateRecordToContact(
  schemaId: string,
  recordId: string,
  contactId: string,
): Promise<void> {
  const cfg = getIntegrationConfig();
  const schemaKey =
    schemaId.startsWith("custom_objects.") || schemaId.includes(".")
      ? schemaId
      : "custom_objects.pos_purchase_item";

  const associationPaths = [
    `/objects/${schemaKey}/records/${recordId}/associations?locationId=${cfg.ghl.locationId}`,
    `/objects/custom_objects.pos_purchase_item/records/${recordId}/associations?locationId=${cfg.ghl.locationId}`,
    `/objects/${schemaId}/records/${recordId}/associations?locationId=${cfg.ghl.locationId}`,
  ];

  const bodyShapes = [
    JSON.stringify({ otherRecordId: contactId, associationKey: "Contact" }),
    JSON.stringify({ otherRecordId: contactId }),
    JSON.stringify({ otherRecordId: contactId, associationKey: "contact" }),
    JSON.stringify({ contactId }),
  ];

  let succeeded = false;
  let lastErr: any = null;
  outer: for (const ep of associationPaths) {
    for (const body of bodyShapes) {
      try {
        await ghlFetch(ep, { method: "POST", body }, "2021-07-28");
        succeeded = true;
        break outer;
      } catch (e) {
        lastErr = e;
      }
    }
  }
  if (!succeeded) {
    throw new Error(
      `Failed to associate record ${recordId} to contact ${contactId}: ${lastErr?.message ?? "unknown error"}`,
    );
  }
}

export async function findRecordByPurchaseReference(
  schemaId: string,
  fieldKey: string,
  purchaseReference: string,
): Promise<string | null> {
  const cfg = getIntegrationConfig();
  const basePathsWithVersion: Array<{ path: string; version: string }> = [
    { path: `/objects/custom_objects.pos_purchase_item/records`, version: "2021-07-28" },
    { path: `/objects/${schemaId}/records`, version: "2021-07-28" },
  ];

  const LIMIT = 100;
  const MAX_PAGES = 5;

  for (const { path: basePath, version: ver } of basePathsWithVersion) {
    for (let page = 0; page < MAX_PAGES; page++) {
      const ep = `${basePath}?locationId=${cfg.ghl.locationId}&limit=${LIMIT}&skip=${page * LIMIT}`;
      let json: any;
      try {
        json = await ghlFetch(ep, {}, ver);
      } catch {
        break;
      }
      const records: any[] = json?.records ?? json?.data ?? [];
      const match = records.find((r: any) => {
        const val = r.properties?.[fieldKey] ?? r[fieldKey];
        return val === purchaseReference;
      });
      if (match?.id) return match.id;
      if (records.length < LIMIT) break;
    }
  }
  return null;
}

/**
 * Fetch a single GHL contact by its ID.
 * Returns null if the contact does not exist (404) — used for cached-mapping
 * liveness checks so stale mappings pointing to deleted contacts are invalidated.
 */
export async function getGhlContactById(contactId: string): Promise<GhlContact | null> {
  const cfg = getIntegrationConfig();
  try {
    const json = await ghlFetch(`/contacts/${contactId}?locationId=${cfg.ghl.locationId}`);
    const c = json?.contact ?? json;
    if (!c?.id) return null;
    return mapContact(c);
  } catch (e: unknown) {
    const err = e as { status?: number };
    if (err.status === 404) return null; // contact was deleted
    throw e; // re-throw anything else (auth, network)
  }
}
