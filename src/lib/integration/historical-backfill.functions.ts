// Server function wrappers for the historical Clover order backfill.
// Thin wrappers only — all runtime logic lives in the .server.ts module.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  getOrCreateBackfillState,
  runBackfillTick,
  getBackfillState,
  listBackfillStates,
  cancelBackfill,
  type BackfillStateRow,
  type BackfillTickResult,
} from "./historical-backfill.server";
import { getIntegrationConfig } from "./config.server";
import { isSetupRequired, getMissingSecrets } from "./config.server";

export type BackfillStateDTO = {
  id: string;
  start_ms: number;
  end_ms: number;
  last_cursor_ms: number;
  status: string;
  imported_orders: number;
  imported_order_items: number;
  skipped_orders: number;
  failed_orders: number;
  errors: string[];
  last_error: string | null;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
};

function toDTO(r: BackfillStateRow): BackfillStateDTO {
  return {
    id: r.id,
    start_ms: r.start_ms,
    end_ms: r.end_ms,
    last_cursor_ms: r.last_cursor_ms,
    status: r.status,
    imported_orders: r.imported_orders,
    imported_order_items: r.imported_order_items,
    skipped_orders: r.skipped_orders,
    failed_orders: r.failed_orders,
    errors: r.errors,
    last_error: r.last_error,
    started_at: r.started_at,
    finished_at: r.finished_at,
    updated_at: r.updated_at,
  };
}

const dateToStartMs = (s: string) => {
  // e.g. "2024-01-01" -> start of day UTC/local
  const clean = s.trim();
  const d = new Date(clean.includes("T") ? clean : `${clean}T00:00:00Z`);
  if (isNaN(d.getTime())) throw new Error(`Invalid start date: ${s}`);
  return d.getTime();
};

const dateToEndMs = (s: string) => {
  // e.g. "2024-01-31" -> end of day 23:59:59.999 UTC so the entire selected day is included
  const clean = s.trim();
  const d = new Date(clean.includes("T") ? clean : `${clean}T23:59:59.999Z`);
  if (isNaN(d.getTime())) throw new Error(`Invalid end date: ${s}`);
  return d.getTime();
};

export const startBackfillFn = createServerFn({ method: "POST" })
  .validator((data) =>
    z
      .object({
        startDate: z.string().min(1),
        endDate: z.string().min(1),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    try {
      const cfg = getIntegrationConfig();
      const merchantId = cfg.clover.merchantId;
      const startMs = dateToStartMs(data.startDate);
      const endMs = dateToEndMs(data.endDate);
      if (endMs < startMs) throw new Error("End date must be after start date.");

      const state = await getOrCreateBackfillState(merchantId, startMs, endMs);
      // Run one tick immediately so the admin sees progress without polling.
      const result = await runBackfillTick(state.id);
      const refreshed = await getBackfillState(state.id);
      return { ok: true as const, state: refreshed ? toDTO(refreshed) : null, result };
    } catch (e: unknown) {
      if (isSetupRequired(e)) {
        return {
          ok: false as const,
          setupRequired: true as const,
          missing: getMissingSecrets(e),
          message: (e as Error).message,
        };
      }
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[historical-backfill] start error:", msg, e);
      return { ok: false as const, error: msg };
    }
  });

export const resumeBackfillFn = createServerFn({ method: "POST" })
  .validator((data) => z.object({ stateId: z.string().min(1) }).parse(data))
  .handler(async ({ data }) => {
    try {
      const result = await runBackfillTick(data.stateId);
      const refreshed2 = await getBackfillState(data.stateId);
      return { ok: true as const, state: refreshed2 ? toDTO(refreshed2) : null, result };
    } catch (e: unknown) {
      if (isSetupRequired(e)) {
        return {
          ok: false as const,
          setupRequired: true as const,
          missing: getMissingSecrets(e),
          message: (e as Error).message,
        };
      }
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false as const, error: msg };
    }
  });

export const getBackfillStatusFn = createServerFn({ method: "GET" })
  .validator((data) => z.object({ stateId: z.string().min(1) }).parse(data))
  .handler(async ({ data }) => {
    const row = await getBackfillState(data.stateId);
    if (!row) return { ok: false as const, error: "Import not found" };
    return { ok: true as const, state: toDTO(row) };
  });

export const listBackfillStatesFn = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const cfg = getIntegrationConfig();
    const rows = await listBackfillStates(cfg.clover.merchantId);
    return { ok: true as const, states: rows.map(toDTO) };
  } catch (e: unknown) {
    if (isSetupRequired(e)) {
      return {
        ok: false as const,
        setupRequired: true as const,
        missing: getMissingSecrets(e),
        message: (e as Error).message,
      };
    }
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
});

export const cancelBackfillFn = createServerFn({ method: "POST" })
  .validator((data) => z.object({ stateId: z.string().min(1) }).parse(data))
  .handler(async ({ data }) => {
    try {
      await cancelBackfill(data.stateId);
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });

export type { BackfillTickResult };
