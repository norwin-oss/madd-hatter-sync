import { createFileRoute } from "@tanstack/react-router";
import { getIntegrationConfig } from "@/lib/integration/config.server";
import { getSupabaseServer } from "@/lib/integration/supabase.server";
import {
  getOrCreateBackfillState,
  runBackfillTick,
  getBackfillState,
} from "@/lib/integration/historical-backfill.server";

// -------------------------------------------------------------------------
// /api/historical-import — Server-to-server historical backfill trigger.
//
// Runs the historical Clover order backfill in time-boxed ticks. Each call
// processes as many day-slices as fit within the Worker execution budget,
// then persists progress and returns the current state so the caller can
// poll/re-call until status === 'complete'.
//
// Security: requires the same SYNC_SECRET as /api/sync. No admin browser
// session is needed, so this can be driven by an external scheduler or a
// simple curl/Postman loop.
//
// Query params:
//   secret   (required) — must match SYNC_SECRET
//   start    (required) — ISO date or ms epoch, e.g. 2024-01-01
//   end      (required) — ISO date or ms epoch, e.g. 2025-12-31
//   stateId  (optional) — resume an existing backfill by id (start/end ignored)
//   ticks    (optional) — max ticks to run in this request (default 1)
//
// Returns JSON: { ok, state, result } or { ok:false, error }.
// -------------------------------------------------------------------------

export const Route = createFileRoute("/api/historical-import")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const secret = url.searchParams.get("secret");
        const expectedSecret = (process.env["SYNC_SECRET"] ?? "").trim();
        if (!expectedSecret) {
          return Response.json(
            { ok: false, error: "SYNC_SECRET is not configured" },
            { status: 503 },
          );
        }
        if (secret !== expectedSecret) {
          return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
        }

        const startParam = url.searchParams.get("start");
        const endParam = url.searchParams.get("end");
        const stateId = url.searchParams.get("stateId");
        const ticksParam = parseInt(url.searchParams.get("ticks") ?? "1", 10);
        const maxTicks = Math.min(Math.max(ticksParam || 1, 1), 20);

        try {
          let state;
          if (stateId) {
            state = await getBackfillState(stateId);
            if (!state) {
              return Response.json({ ok: false, error: "Import not found" }, { status: 404 });
            }
          } else {
            if (!startParam || !endParam) {
              return Response.json(
                {
                  ok: false,
                  error: "start and end are required (e.g. ?start=2024-01-01&end=2025-12-31)",
                },
                { status: 400 },
              );
            }
            const cfg = getIntegrationConfig();
            const merchantId = cfg.clover.merchantId;
            const cleanStart = startParam.trim();
            const cleanEnd = endParam.trim();
            const startMs = new Date(cleanStart.includes("T") ? cleanStart : `${cleanStart}T00:00:00Z`).getTime();
            const endMs = new Date(cleanEnd.includes("T") ? cleanEnd : `${cleanEnd}T23:59:59.999Z`).getTime();
            if (isNaN(startMs) || isNaN(endMs)) {
              return Response.json({ ok: false, error: "Invalid start/end date" }, { status: 400 });
            }
            if (endMs < startMs) {
              return Response.json(
                { ok: false, error: "end must be after start" },
                { status: 400 },
              );
            }
            state = await getOrCreateBackfillState(merchantId, startMs, endMs);
          }

          // Run up to maxTicks sequential ticks. Each tick processes day-slices
          // until the execution budget is exhausted, then pauses. We stop early
          // if a tick reports done or no remaining work.
          let lastResult = null;
          for (let i = 0; i < maxTicks; i++) {
            const r = await runBackfillTick(state.id);
            lastResult = r;
            if (r.done || !r.remaining) break;
            // Re-read state to check status before next tick.
            const refreshed = await getBackfillState(state.id);
            if (!refreshed || refreshed.status !== "running") break;
          }

          const finalState = await getBackfillState(state.id);
          return Response.json({
            ok: true,
            state: finalState,
            result: lastResult,
          });
        } catch (e: any) {
          console.error("[historical-import] error:", e);
          return Response.json(
            { ok: false, error: e?.message ?? "Historical import failed" },
            { status: 500 },
          );
        }
      },
    },
  },
});
