// Historical Clover order + line-item backfill admin page.
//
// Super-admin only. Configurable start/end dates, start/resume/pause
// controls, live progress (imported/skipped/failed), error details, and
// a history of past imports. The backfill is completely separate from
// the normal incremental sync and CRM push — it only upserts orders +
// order items; it never creates CRM contacts or triggers CRM sync.
import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  startBackfillFn,
  resumeBackfillFn,
  cancelBackfillFn,
  listBackfillStatesFn,
} from "@/lib/integration/historical-backfill.functions";
import { PageHeader } from "./page-header";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { isSuperAdminEmail } from "@/lib/integration/super-admin";
import { cn } from "@/lib/utils";

type BackfillStateDTO = {
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

type BackfillResult = {
  stateId: string;
  status: string;
  imported_orders: number;
  imported_order_items: number;
  skipped_orders: number;
  failed_orders: number;
  errors: string[];
  last_error: string | null;
  done: boolean;
  remaining: boolean;
};

type StartPayload =
  | { ok: true; state: BackfillStateDTO | null; result: BackfillResult }
  | { ok: false; setupRequired?: true; missing?: string[]; message?: string; error?: string };

type ResumePayload =
  | { ok: true; state: BackfillStateDTO | null; result: BackfillResult }
  | { ok: false; setupRequired?: true; missing?: string[]; message?: string; error?: string };

type ListPayload =
  | { ok: true; states: BackfillStateDTO[] }
  | { ok: false; setupRequired?: true; missing?: string[]; message?: string; error?: string };

type CancelPayload = { ok: true } | { ok: false; error?: string };

// Authentication is verified via the adminMe / checkAdminApproval route gate
// and the server function re-checks caller permission on every request.

function fmtDate(ms: number): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleString("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return new Date(ms).toLocaleString();
  }
}

function fmtRange(start: number, end: number): string {
  return `${fmtDate(start)} → ${fmtDate(end)}`;
}

function statusVariant(status: string) {
  switch (status) {
    case "complete":
      return { variant: "default", label: "Complete", tone: "success" } as const;
    case "running":
      return { variant: "default", label: "Running", tone: "info" } as const;
    case "paused":
      return { variant: "secondary", label: "Paused", tone: "warning" } as const;
    case "failed":
      return { variant: "destructive", label: "Failed", tone: "error" } as const;
    case "cancelled":
      return { variant: "secondary", label: "Cancelled", tone: "neutral" } as const;
    default:
      return { variant: "outline", label: "Pending", tone: "neutral" } as const;
  }
}

type DatePreset = { label: string; range: () => { start: string; end: string } };

function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const DATE_PRESETS: DatePreset[] = [
  {
    label: "Last 30 Days",
    range: () => {
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - 30);
      return { start: toISODate(start), end: toISODate(end) };
    },
  },
  {
    label: "Last 90 Days",
    range: () => {
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - 90);
      return { start: toISODate(start), end: toISODate(end) };
    },
  },
  {
    label: "Year to Date",
    range: () => {
      const end = new Date();
      const start = new Date(end.getFullYear(), 0, 1);
      return { start: toISODate(start), end: toISODate(end) };
    },
  },
  {
    label: "Last Year",
    range: () => {
      const y = new Date().getFullYear() - 1;
      return { start: `${y}-01-01`, end: `${y}-12-31` };
    },
  },
  {
    label: "2024 – 2025",
    range: () => ({ start: "2024-01-01", end: "2025-12-31" }),
  },
  {
    label: "Full Lifetime",
    range: () => {
      const end = new Date();
      return { start: "2020-01-01", end: toISODate(end) };
    },
  },
];

export function HistoricalImportPage() {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function applyPreset(p: DatePreset) {
    const { start: s, end: e } = p.range();
    setStart(s);
    setEnd(e);
    setActivePreset(p.label);
    setError(null);
  }
  const qc = useQueryClient();

  // Read current user session from /api/auth/me
  const { data: meData, isLoading: isMeLoading } = useQuery({
    queryKey: ["auth-me-current"],
    queryFn: async () => {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      if (!res.ok) return null;
      const json = await res.json();
      return json?.session?.email ?? null;
    },
    staleTime: 60_000,
  });

  const currentUserEmail: string | null = meData ?? null;
  const isSuperAdmin = isSuperAdminEmail(currentUserEmail);

  const startFn = useServerFn(startBackfillFn);
  const resumeFn = useServerFn(resumeBackfillFn);
  const cancelFn = useServerFn(cancelBackfillFn);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["historical-backfill-states"],
    queryFn: () => listBackfillStatesFn(),
    refetchOnMount: true,
    staleTime: 0,
    enabled: isSuperAdmin,
  });

  const listPayload = data as ListPayload | undefined;
  const states: BackfillStateDTO[] = listPayload && listPayload.ok ? listPayload.states : [];
  const listError =
    listPayload && !listPayload.ok
      ? (listPayload as ListPayload & { ok: false }).error ||
        (listPayload as ListPayload & { ok: false }).message
      : null;
  const setupMissing =
    listPayload && !listPayload.ok && listPayload.setupRequired
      ? ((listPayload as ListPayload & { ok: false }).missing ?? [])
      : [];

  const active = useMemo(
    () => states.find((s) => s.status === "running" || s.status === "paused"),
    [states],
  );

  // Auto-pump effect: continuously drive an active import to completion.
  // Uses a ref for the latest active state so the interval always sees the
  // freshest status (avoiding the stale-closure bug where it captured the
  // status at interval-creation time and never updated).
  const isPumpingRef = useRef(false);
  const activeRef = useRef<BackfillStateDTO | null>(active);
  activeRef.current = active;

  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }

    if (active && (active.status === "running" || active.status === "paused")) {
      pollRef.current = setInterval(async () => {
        // Refresh status first so we see the latest state
        await refetch();
        const cur = activeRef.current;
        if (!cur) return;
        // Only pump when paused (running means a tick is in-flight server-side)
        if (cur.status === "paused" && !isPumpingRef.current) {
          isPumpingRef.current = true;
          try {
            await resumeFn({ data: { stateId: cur.id } });
            await qc.invalidateQueries({ queryKey: ["historical-backfill-states"] });
          } catch (e) {
            console.warn("Auto-pump tick error:", e);
          } finally {
            isPumpingRef.current = false;
          }
        }
      }, 3000);
    }

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [active?.id, active?.status, refetch, resumeFn, qc]);

  async function handleStart() {
    if (!start || !end) {
      setError("Please choose a start date and an end date.");
      return;
    }
    if (new Date(end).getTime() < new Date(start).getTime()) {
      setError("End date must be after the start date.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = (await startFn({ data: { startDate: start, endDate: end } })) as StartPayload;
      if (res.ok) {
        toast.success("Historical import started");
        await qc.invalidateQueries({ queryKey: ["historical-backfill-states"] });
        if (res.result?.remaining) {
          toast.info("Import is running — this page will refresh as it progresses.");
        }
      } else {
        const msg = res.setupRequired
          ? `Missing secrets: ${(res.missing ?? []).join(", ")}`
          : (res.error ?? res.message ?? "Failed to start the import.");
        setError(msg);
        toast.error(msg);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  async function handleResume(stateId: string) {
    setBusy(true);
    setError(null);
    try {
      const res = (await resumeFn({ data: { stateId } })) as ResumePayload;
      if (res.ok) {
        toast.success("Import resumed");
        await qc.invalidateQueries({ queryKey: ["historical-backfill-states"] });
        if (res.result?.remaining) {
          toast.info("Import is running — this page will refresh as it progresses.");
        }
      } else {
        const msg = res.setupRequired
          ? `Missing secrets: ${(res.missing ?? []).join(", ")}`
          : (res.error ?? res.message ?? "Failed to resume the import.");
        setError(msg);
        toast.error(msg);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel(stateId: string) {
    setBusy(true);
    try {
      const res = (await cancelFn({ data: { stateId } })) as CancelPayload;
      if (res.ok) {
        toast.success("Import cancelled");
      } else {
        toast.error(res.error ?? "Failed to cancel the import.");
      }
      await qc.invalidateQueries({ queryKey: ["historical-backfill-states"] });
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function handleRerun(s: BackfillStateDTO) {
    const startIso = toISODate(new Date(s.start_ms));
    const endIso = toISODate(new Date(s.end_ms));
    setStart(startIso);
    setEnd(endIso);
    setActivePreset(null);
    setError(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
    toast.info(`Selected ${startIso} → ${endIso}. Click "Start Import" to re-run.`);
  }

  const progressPct =
    active && active.end_ms > active.start_ms
      ? Math.min(
          100,
          Math.max(
            0,
            Math.round(
              ((active.last_cursor_ms - active.start_ms) / (active.end_ms - active.start_ms)) * 100,
            ),
          ),
        )
      : 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Historical Import"
        description="Backfill complete historical Clover order and line-item data into the dashboard for full reporting coverage."
      />

      {isMeLoading ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-sm text-muted-foreground">Checking permissions…</p>
          </CardContent>
        </Card>
      ) : !isSuperAdmin ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-sm font-semibold text-foreground">
              This tool is restricted to super-admin accounts.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Sign in with an authorized administrator email to run a historical import. Current:{" "}
              {currentUserEmail ?? "none"}
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {setupMissing.length > 0 && (
            <Card className="border-destructive/30">
              <CardContent className="py-4 text-sm text-destructive">
                Missing secrets: {setupMissing.join(", ")}. Add them in the Secrets panel before
                importing.
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Start a new import</CardTitle>
              <p className="text-xs text-muted-foreground">
                Choose a date range covering the full history you want. The import runs in bounded
                time-boxed batches and resumes automatically after interruptions — no duplicates, no
                CRM changes.
              </p>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-wrap gap-2">
                {DATE_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => applyPreset(p)}
                    className={cn(
                      "rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors",
                      activePreset === p.label
                        ? "border-primary bg-primary text-primary-foreground shadow-sm"
                        : "border-border bg-background text-muted-foreground hover:border-primary/50 hover:text-foreground",
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="hist-start">Start date</Label>
                  <Input
                    id="hist-start"
                    type="date"
                    value={start}
                    onChange={(e) => {
                      setStart(e.target.value);
                      setActivePreset(null);
                    }}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="hist-end">End date</Label>
                  <Input
                    id="hist-end"
                    type="date"
                    value={end}
                    onChange={(e) => {
                      setEnd(e.target.value);
                      setActivePreset(null);
                    }}
                  />
                </div>
              </div>
              {error && <p className="text-sm font-semibold text-destructive">{error}</p>}
              <div className="flex flex-wrap gap-3">
                <Button onClick={handleStart} disabled={busy || !start || !end}>
                  {busy ? "Working…" : "Start Import"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setStart("");
                    setEnd("");
                    setError(null);
                  }}
                >
                  Clear
                </Button>
              </div>
            </CardContent>
          </Card>

          {active && (
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="text-base">Current import</CardTitle>
                  <Badge variant={statusVariant(active.status).variant}>
                    {statusVariant(active.status).label}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {fmtRange(active.start_ms, active.end_ms)}
                </p>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Metric label="Orders imported" value={active.imported_orders} />
                  <Metric label="Line items" value={active.imported_order_items} />
                  <Metric label="Skipped" value={active.skipped_orders} />
                  <Metric label="Failed" value={active.failed_orders} tone="error" />
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                    <span>Progress</span>
                    <span>{progressPct}%</span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                </div>
                {active.last_error && (
                  <p className="text-xs text-destructive">Last error: {active.last_error}</p>
                )}
                <div className="flex gap-3">
                  {active.status === "running" && (
                    <Button
                      variant="outline"
                      onClick={() => handleCancel(active.id)}
                      disabled={busy}
                    >
                      Pause
                    </Button>
                  )}
                  {active.status === "paused" && (
                    <Button onClick={() => handleResume(active.id)} disabled={busy}>
                      Resume
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Import history</CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : listError ? (
                <p className="text-sm font-semibold text-destructive">{listError}</p>
              ) : states.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No imports yet. Start one above to backfill historical Clover data.
                </p>
              ) : (
                <div className="flex flex-col gap-3">
                  {states.map((s) => (
                    <div
                      key={s.id}
                      className="flex flex-col gap-2 rounded-xl border border-border/60 p-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                          <Badge variant={statusVariant(s.status).variant}>
                            {statusVariant(s.status).label}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {fmtRange(s.start_ms, s.end_ms)}
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                          <span>Orders: {s.imported_orders}</span>
                          <span>Items: {s.imported_order_items}</span>
                          <span>Failed: {s.failed_orders}</span>
                          <span>Updated: {fmtDate(new Date(s.updated_at).getTime())}</span>
                        </div>
                        {s.last_error && (
                          <span className="text-xs text-destructive">
                            Last error: {s.last_error}
                          </span>
                        )}
                      </div>
                      <div className="flex gap-2">
                        {s.status === "paused" && (
                          <Button size="sm" onClick={() => handleResume(s.id)} disabled={busy}>
                            Resume
                          </Button>
                        )}
                        {(s.status === "running" || s.status === "paused") && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleCancel(s.id)}
                            disabled={busy}
                          >
                            Cancel
                          </Button>
                        )}
                        {(s.status === "complete" ||
                          s.status === "cancelled" ||
                          s.status === "failed") && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => handleRerun(s)}
                            disabled={busy}
                          >
                            Re-run
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "error";
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
      <div className="text-lg font-bold text-foreground">{value.toLocaleString()}</div>
      <div
        className={
          tone === "error"
            ? "text-xs font-semibold text-destructive"
            : "text-xs text-muted-foreground"
        }
      >
        {label}
      </div>
    </div>
  );
}
