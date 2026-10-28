import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Loader2,
  Plus,
  X,
  Download,
  Users,
  AlertTriangle,
  Sparkles,
  Filter,
  CalendarClock,
  Layers,
  Wand2,
  Target,
  RotateCcw,
} from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { buildAudienceFn } from "@/lib/integration/audience.functions";
import type { AudienceResult } from "@/lib/integration/audience-build.server";
import { toCsv, downloadCsv } from "@/lib/csv-export";
import { AUDIENCE_CATALOG } from "@/lib/audience-catalog";
import {
  RuleRow,
  AddCondition,
  KpiStrip,
  ResultsTable,
  type AudienceMeta,
} from "@/components/audience-builder-parts";

function formatDate(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function AudienceBuilderPage() {
  const runFn = useServerFn(buildAudienceFn);

  const catalog: AudienceMeta[] = AUDIENCE_CATALOG;
  const [andAudiences, setAndAudiences] = useState<string[]>([]);
  const [orGroups, setOrGroups] = useState<string[][]>([[]]);
  const [result, setResult] = useState<AudienceResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  // Tracks whether the user changed conditions since the last build, so we
  // can mark displayed results as stale instead of hiding them.
  const [stale, setStale] = useState(false);

  const runSearch = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSearched(true);
    setStale(false);
    try {
      const cleanOr = orGroups.filter((g) => g.length > 0);
      const res: any = await runFn({ data: { andAudiences, orGroups: cleanOr } });
      // Detect raw HTML / 500 responses that crossed the RPC boundary.
      const rawText = typeof res === "string" ? res : "";
      if (
        rawText.includes("<!DOCTYPE") ||
        rawText.includes("<html") ||
        rawText.includes("Internal server error")
      ) {
        setError("The audience request failed on the server (HTTP 500). Check the server logs for the underlying error.");
        setResult(null);
        return;
      }
      if (res && typeof res === "object" && "setupRequired" in res && res.setupRequired) {
        setError("Integration not configured. Please complete setup in Settings.");
        return;
      }
      if (res && typeof res === "object" && "error" in res && res.error) {
        const errorText = String(res.error);
        if (errorText.includes("<!DOCTYPE") || errorText.includes("<html")) {
          setError("The audience request failed on the server (HTTP 500). Check the server logs for the underlying error.");
        } else {
          setError(errorText);
        }
        setResult(null);
        return;
      }
      if (res && typeof res === "object" && "result" in res && res.result) {
        setResult(res.result);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (
        msg.includes("<!DOCTYPE") ||
        msg.includes("<html") ||
        msg.includes("Internal server error")
      ) {
        setError("The audience request failed on the server (HTTP 500). Check the server logs for the underlying error.");
      } else {
        setError(msg || "Failed to build audience.");
      }
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [andAudiences, orGroups, runFn]);

  const groups = useMemo(() => {
    const m = new Map<string, AudienceMeta[]>();
    for (const a of catalog) {
      const arr = m.get(a.group) ?? [];
      arr.push(a);
      m.set(a.group, arr);
    }
    return Array.from(m.entries());
  }, [catalog]);

  const labelFor = (id: string) => catalog.find((a) => a.id === id)?.label ?? id;
  const descFor = (id: string) => catalog.find((a) => a.id === id)?.description ?? "";

  const hasConditions = andAudiences.length > 0 || orGroups.some((g) => g.length > 0);
  const totalAudiences = catalog.length;

  // ---- AND filter management ----
  const markStale = () => setStale(true);
  const addAnd = (id: string) => {
    if (!id || andAudiences.includes(id)) return;
    setAndAudiences([...andAudiences, id]);
    markStale();
  };
  const removeAnd = (id: string) => {
    setAndAudiences(andAudiences.filter((x) => x !== id));
    markStale();
  };

  // ---- OR group management ----
  const addOrToGroup = (gi: number, id: string) => {
    if (!id) return;
    const next = orGroups.map((g, i) => (i === gi ? Array.from(new Set([...g, id])) : g));
    setOrGroups(next);
    markStale();
  };
  const removeOrFromGroup = (gi: number, id: string) => {
    const next = orGroups.map((g, i) => (i === gi ? g.filter((x) => x !== id) : g));
    setOrGroups(next);
    markStale();
  };
  const addOrGroup = () => {
    setOrGroups([...orGroups, []]);
    markStale();
  };
  const removeOrGroup = (gi: number) => {
    setOrGroups(orGroups.filter((_, i) => i !== gi));
    markStale();
  };

  const clearAll = () => {
    setAndAudiences([]);
    setOrGroups([[]]);
    setResult(null);
    setSearched(false);
    setError(null);
    setStale(false);
  };

  const handleExport = () => {
    if (!result || result.customers.length === 0) return;
    const ts = new Date().toISOString().slice(0, 10);
    const rows = result.customers.map((c) => ({
      "Full Name": c.fullName,
      "First Name": c.firstName ?? "",
      "Last Name": c.lastName ?? "",
      Phone: c.phone ?? "",
      Email: c.email ?? "",
      "Clover Customer ID": c.cloverCustomerId,
      "GHL Contact ID": c.ghlContactId ?? "",
      "Lifetime Spend": (c.lifetimeSpendCents / 100).toFixed(2),
      "Visit Count": c.visitCount,
      "First Visit": formatDate(c.firstVisitMs),
      "Last Visit": formatDate(c.lastVisitMs),
      "Marketing Eligible": c.marketingAllowed === false ? "No" : "Yes",
      "Matching Audiences": c.matchingAudiences.map(labelFor).join("; "),
    }));
    const csv = toCsv(rows, [
      { key: "Full Name", label: "Full Name" },
      { key: "First Name", label: "First Name" },
      { key: "Last Name", label: "Last Name" },
      { key: "Phone", label: "Phone" },
      { key: "Email", label: "Email" },
      { key: "Clover Customer ID", label: "Clover Customer ID" },
      { key: "GHL Contact ID", label: "GHL Contact ID" },
      { key: "Lifetime Spend", label: "Lifetime Spend" },
      { key: "Visit Count", label: "Visit Count" },
      { key: "First Visit", label: "First Visit" },
      { key: "Last Visit", label: "Last Visit" },
      { key: "Marketing Eligible", label: "Marketing Eligible" },
      { key: "Matching Audiences", label: "Matching Audiences" },
    ]);
    downloadCsv(csv, `audience-${ts}.csv`);
  };

  const activeConditionCount =
    andAudiences.length + orGroups.filter((g) => g.length > 0).reduce((n, g) => n + g.length, 0);

  return (
    <div className="mx-auto w-full">
      {/* ---- Compact header ---- */}
      <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Target className="h-5 w-5" />
            </span>
            <h1 className="text-xl font-extrabold tracking-tight text-foreground">
              Audience Builder
            </h1>
          </div>
          <p className="mt-1.5 pl-[46px] text-sm text-muted-foreground">
            Combine purchase, visit, spending, event & birthday criteria into deduplicated outreach
            lists.
          </p>
        </div>
        <Badge variant="outline" className="h-fit gap-1.5 px-3 py-1.5 text-xs">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          {totalAudiences} audiences available
        </Badge>
      </div>

      {/* ---- Split-screen workspace (occupies available viewport height) ---- */}
      <div className="grid min-h-[calc(100vh-13rem)] grid-cols-1 items-stretch gap-5 lg:grid-cols-[minmax(340px,0.9fr)_minmax(0,2.1fr)]">
        {/* ============ LEFT: Rule builder (stretches to fill vertical height) ============ */}
        <div className="flex w-full flex-col">
          <div className="flex h-full flex-1 flex-col rounded-2xl border border-border bg-card shadow-sm">
            <div className="flex items-center gap-2.5 border-b border-border bg-muted/20 px-5 py-4">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Filter className="h-4 w-4" />
              </span>
              <div className="flex flex-col">
                <span className="text-sm font-bold text-foreground">Audience Conditions</span>
                <span className="text-[11px] text-muted-foreground">Select criteria to match</span>
              </div>
              {activeConditionCount > 0 && (
                <Badge className="ml-auto h-5.5 px-2.5 text-[11px] font-bold">
                  {activeConditionCount} {activeConditionCount === 1 ? "rule" : "rules"}
                </Badge>
              )}
            </div>

            <div className="flex-1 space-y-6 overflow-y-auto p-5">
              {/* ---- Match ALL (AND) ---- */}
              <div className="rounded-xl border border-border/60 bg-muted/15 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center rounded-md bg-primary/10 px-2 py-0.5 text-[11px] font-extrabold uppercase tracking-wider text-primary">
                      Match all
                    </span>
                    <span className="text-xs text-muted-foreground">
                      · Every condition required
                    </span>
                  </div>
                </div>
                <div className="space-y-2.5">
                  {andAudiences.map((id) => (
                    <RuleRow
                      key={id}
                      label={labelFor(id)}
                      description={descFor(id)}
                      onRemove={() => removeAnd(id)}
                      tone="and"
                    />
                  ))}
                  {andAudiences.length === 0 && (
                    <div className="rounded-xl border border-dashed border-border/80 bg-background/50 px-3.5 py-3 text-center">
                      <p className="text-xs font-medium text-muted-foreground">
                        No required conditions — all customers match.
                      </p>
                    </div>
                  )}
                  <AddCondition
                    groups={groups}
                    placeholder="Add required condition…"
                    onPick={addAnd}
                    exclude={andAudiences}
                  />
                </div>
              </div>

              {/* ---- Match ANY (OR groups) ---- */}
              <div className="rounded-xl border border-border/60 bg-muted/15 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center rounded-md bg-accent/20 px-2 py-0.5 text-[11px] font-extrabold uppercase tracking-wider text-accent-foreground">
                      Match any
                    </span>
                    <span className="text-xs text-muted-foreground">· OR groups</span>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={addOrGroup}
                    className="h-7 gap-1 rounded-lg px-2 text-xs font-bold text-primary hover:bg-primary/10 hover:text-primary"
                  >
                    <Plus className="h-3.5 w-3.5" /> Add Group
                  </Button>
                </div>

                <div className="space-y-3">
                  {orGroups.map((group, gi) => (
                    <div
                      key={gi}
                      className="rounded-xl border border-border/80 bg-background/90 p-3.5 shadow-2xs"
                    >
                      <div className="mb-2.5 flex items-center justify-between">
                        <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                          <Layers className="h-3.5 w-3.5 text-primary" /> Group {gi + 1}
                        </span>
                        {orGroups.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeOrGroup(gi)}
                            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                            aria-label="Remove group"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                      <div className="space-y-2">
                        {group.map((id) => (
                          <RuleRow
                            key={id}
                            label={labelFor(id)}
                            description={descFor(id)}
                            onRemove={() => removeOrFromGroup(gi, id)}
                            tone="or"
                          />
                        ))}
                        {group.length === 0 && (
                          <div className="rounded-lg border border-dashed border-border/80 bg-muted/30 px-3 py-2.5 text-center">
                            <p className="text-xs text-muted-foreground">
                              Empty group — pick a condition below.
                            </p>
                          </div>
                        )}
                        <AddCondition
                          groups={groups}
                          placeholder="Add to group…"
                          onPick={(id) => addOrToGroup(gi, id)}
                          exclude={group}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* ---- Action bar (pinned cleanly at the bottom, fills bottom space) ---- */}
            <div className="mt-auto border-t border-border bg-muted/20 px-5 py-4">
              <div className="flex items-center gap-2.5">
                <Button
                  onClick={runSearch}
                  disabled={loading || !hasConditions}
                  className="h-11 flex-1 gap-2 rounded-xl text-sm font-bold shadow-sm transition-all hover:shadow active:scale-[0.99]"
                  size="default"
                >
                  {loading ? (
                    <Loader2 className="h-4.5 w-4.5 animate-spin" />
                  ) : (
                    <Wand2 className="h-4.5 w-4.5" />
                  )}
                  Build Audience
                </Button>
                {hasConditions && (
                  <Button
                    variant="outline"
                    size="default"
                    onClick={clearAll}
                    className="h-11 rounded-xl border-border px-3 text-muted-foreground hover:bg-muted hover:text-foreground active:scale-[0.99]"
                    title="Clear all conditions"
                  >
                    <RotateCcw className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ============ RIGHT: Results dashboard ============ */}
        <div className="flex min-w-0 flex-col gap-4">
          {/* ---- Error ---- */}
          {error && (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>{error}</span>
                {error.toLowerCase().includes("session") && (
                  <a href="/login" className="ml-2 font-bold underline hover:opacity-80">
                    Go to Login →
                  </a>
                )}
              </div>
              <button
                type="button"
                onClick={() => setError(null)}
                className="shrink-0 rounded-md p-1 hover:bg-destructive/10"
                aria-label="Dismiss"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          {/* ---- Birthday / data warnings ---- */}
          {result &&
            result.warnings.map((w, i) => (
              <div
                key={i}
                className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-warning"
              >
                <CalendarClock className="mt-0.5 h-4 w-4 shrink-0" /> {w}
              </div>
            ))}

          {/* ---- Stale banner ---- */}
          {result && stale && !loading && (
            <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              Conditions changed — results below are from a previous build.
            </div>
          )}

          {/* ---- Loading skeleton ---- */}
          {loading && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-2xl border border-border bg-card py-20 shadow-sm">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">
                Evaluating audiences against purchase history…
              </p>
            </div>
          )}

          {/* ---- Results dashboard ---- */}
          {result && !loading && (
            <>
              {/* KPI strip */}
              <KpiStrip
                total={result.totalCustomers}
                eligible={result.marketingEligible}
                phone={result.withPhone}
                email={result.withEmail}
                crm={result.crmLinked}
              />

              {/* Individual audience sizes */}
              {Object.keys(result.audienceSizes).length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {Object.entries(result.audienceSizes).map(([id, n]) => (
                    <Badge key={id} variant="outline" className="gap-1.5 px-2.5 py-1 text-[11px]">
                      {labelFor(id)} <span className="font-bold text-primary">{n}</span>
                    </Badge>
                  ))}
                </div>
              )}

              {/* Results table panel */}
              <div className="flex min-h-0 flex-1 flex-col rounded-2xl border border-border bg-card shadow-sm">
                <div className="flex flex-col gap-2 border-b border-border px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2">
                    <Users className="h-4 w-4 text-primary" />
                    <span className="text-sm font-bold text-foreground">
                      {result.totalCustomers.toLocaleString()} matching customers
                    </span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleExport}
                    disabled={result.customers.length === 0}
                  >
                    <Download className="h-4 w-4" /> Export CSV
                  </Button>
                </div>
                {result.customers.length === 0 ? (
                  <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
                    <p className="text-sm font-bold text-foreground">No matching customers</p>
                    <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                      No identified customers match this combination. Try widening your conditions.
                    </p>
                  </div>
                ) : (
                  <ResultsTable customers={result.customers} labelFor={labelFor} />
                )}
              </div>
            </>
          )}

          {/* ---- Initial empty state ---- */}
          {!result && !error && !loading && !searched && (
            <div className="flex flex-1 flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card/40 px-6 py-20 text-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Target className="h-7 w-7" />
              </span>
              <p className="mt-4 text-base font-bold text-foreground">Build your audience</p>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                Select conditions on the left and click Build Audience to find matching customers
                across all Clover purchase history.
              </p>
            </div>
          )}

          {/* ---- Zero-result state (searched but empty) ---- */}
          {result && result.customers.length === 0 && !loading && (
            <div className="flex flex-1 flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card/40 px-6 py-16 text-center">
              <p className="text-sm font-bold text-foreground">No matching customers found</p>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                Try removing a condition or switching AND to OR.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
