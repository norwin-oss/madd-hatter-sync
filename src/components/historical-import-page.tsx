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

const SUPER_ADMIN =
  typeof localStorage !== "undefined" ? localStorage.getItem("admin-email") || "" : "";

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

export function HistoricalImportPage() {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const qc = useQueryClient();

  const startFn = useServerFn(startBackfillFn);
  const resumeFn = useServerFn(resumeBackfillFn);
  const cancelFn = useServerFn(cancelBackfillFn);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["historical-backfill-states"],
    queryFn: () => listBackfillStatesFn(),
    refetchOnMount: true,
    staleTime: 0,
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

  // Poll while an import is running.
  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (active?.status === "running") {
      pollRef.current = setInterval(() => {
        void refetch();
      }, 5000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [active?.status, refetch]);

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
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const progressPct =
    active && active.end_ms > active.start_ms
      ? Math.min(
          100,
          Math.round(
            ((active.last_cursor_ms - active.start_ms) / (active.end_ms - active.start_ms)) * 100,
          ),
        )
      : 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Historical Import"
        description="Backfill complete historical Clover order and line-item data into the dashboard for full reporting coverage."
      />

      {!isSuperAdminEmail(SUPER_ADMIN) ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-sm font-semibold text-foreground">
              This tool is restricted to super-admin accounts.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Sign in with an authorized administrator email to run a historical import.
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
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="hist-start">Start date</Label>
                  <Input
                    id="hist-start"
                    type="date"
                    value={start}
                    onChange={(e) => setStart(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="hist-end">End date</Label>
                  <Input
                    id="hist-end"
                    type="date"
                    value={end}
                    onChange={(e) => setEnd(e.target.value)}
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
