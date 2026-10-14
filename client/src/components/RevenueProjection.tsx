import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { AREAS, type ProjectionRow, type RevenueProjection } from "@shared/schema";
import { monthLabel, shortDate } from "@/lib/forecastGrid";
import { Input } from "@/components/ui/input";
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Search, X } from "lucide-react";

// Revenue projection: one row per live job / open Upcoming work job, grouped
// by area, months across the top. Each month = the row's manual day rate x
// the days the job runs in that month (start / end dates come from the job's
// start + estimated release, or the Upcoming work job's start / end).

const DAY = 86400000;
const toMs = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
function monthBounds(ym: string): [number, number] {
  return [Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1, 1), Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)];
}
export function projectionDays(row: ProjectionRow, months: string[], windowStart: string, windowEnd: string) {
  const s = row.start_on ? toMs(row.start_on) : toMs(windowStart);
  const e = row.end_on ? toMs(row.end_on) : toMs(windowEnd);
  return months.map((ym) => {
    const [ms, me] = monthBounds(ym);
    const a = Math.max(ms, s);
    const b = Math.min(me, e);
    return b >= a ? Math.round((b - a) / DAY) + 1 : 0;
  });
}

const money = (n: number | null | undefined) =>
  n == null
    ? "—"
    : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

type Level = 0 | 1 | 2; // 0 = committed only, 1 = + likely, 2 = + bids
const visible = (r: ProjectionRow, lvl: Level) =>
  r.stage === "Likely" ? lvl >= 1 : r.stage === "Bid" ? lvl >= 2 : true;

const STAGE_TONE: Record<string, string> = {
  Active: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  "Rig Move": "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  Awarded: "bg-primary/15 text-primary",
  Likely: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  Bid: "bg-muted text-muted-foreground",
};

function RateInput({ row, canEdit }: { row: ProjectionRow; canEdit: boolean }) {
  const { toast } = useToast();
  const [val, setVal] = useState(row.day_rate == null ? "" : String(row.day_rate));
  useEffect(() => setVal(row.day_rate == null ? "" : String(row.day_rate)), [row.day_rate]);
  const save = useMutation({
    mutationFn: async (rate: number | null) => {
      if (row.kind === "job")
        await apiRequest("PATCH", `/api/revenue/projection/jobs/${row.id}`, { projected_day_rate: rate });
      else await apiRequest("PATCH", `/api/forecast-jobs/${row.id}`, { day_rate: rate });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/revenue/projection"] });
      queryClient.invalidateQueries({ queryKey: ["/api/forecast"] });
    },
    onError: (e: any) => {
      setVal(row.day_rate == null ? "" : String(row.day_rate));
      toast({ title: "Could not save the day rate", description: e.message, variant: "destructive" });
    },
  });
  const commit = () => {
    const clean = val.replace(/[$,\s]/g, "");
    const next = clean === "" ? null : Number(clean);
    if (next != null && (!Number.isFinite(next) || next < 0)) {
      toast({ title: "Enter a dollar amount", variant: "destructive" });
      setVal(row.day_rate == null ? "" : String(row.day_rate));
      return;
    }
    if (next === row.day_rate) return;
    save.mutate(next);
  };
  if (!canEdit) return <span className="tabular-nums">{money(row.day_rate)}</span>;
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">$</span>
      <Input
        value={val}
        inputMode="decimal"
        onChange={(e) => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setVal(row.day_rate == null ? "" : String(row.day_rate));
            (e.target as HTMLInputElement).blur();
          }
        }}
        placeholder="Day rate"
        className="h-8 w-[104px] pl-5 text-right text-xs tabular-nums"
        data-testid={`input-proj-rate-${row.id}`}
      />
      {save.isPending && <Loader2 className="absolute -right-5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />}
    </div>
  );
}

export function RevenueProjectionView({ canEdit }: { canEdit: boolean }) {
  const { data, isLoading, error } = useQuery<RevenueProjection>({ queryKey: ["/api/revenue/projection"] });
  const [lvl, setLvl] = useState<Level>(2);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const q = query.trim().toLowerCase();

  const view = useMemo(() => {
    if (!data) return null;
    const { months, window_start, window_end } = data;
    const zero = () => months.map(() => 0);
    const grand = zero();
    let missing = 0;
    const areas = AREAS.map((area) => {
      const rows = data.rows
        .filter((r) => r.area === area && visible(r, lvl))
        .filter((r) => !q || `${r.name} ${r.customer_name ?? ""} ${r.stage}`.toLowerCase().includes(q))
        .map((r) => {
          const days = projectionDays(r, months, window_start, window_end);
          const amounts = days.map((d) => (r.day_rate == null ? null : d * r.day_rate));
          return { r, days, amounts };
        })
        // Running jobs first, then Upcoming work by start date.
        .sort((a, b) => {
          const ka = a.r.kind === "job" ? "0" : `1${a.r.start_on ?? ""}`;
          const kb = b.r.kind === "job" ? "0" : `1${b.r.start_on ?? ""}`;
          return ka < kb ? -1 : ka > kb ? 1 : a.r.name.localeCompare(b.r.name);
        });
      const totals = zero();
      rows.forEach(({ r, amounts }) => {
        if (r.day_rate == null) missing++;
        amounts.forEach((v, i) => {
          if (v != null) {
            totals[i] += v;
            grand[i] += v;
          }
        });
      });
      return { area, rows, totals, rated: rows.some((x) => x.r.day_rate != null) };
    }).filter((a) => a.rows.length > 0);
    return { months, areas, grand, missing, anyRated: areas.some((a) => a.rated) };
  }, [data, lvl, q]);

  if (isLoading) return <div className="text-sm text-muted-foreground">Loading projection…</div>;
  if (error)
    return (
      <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-6 text-sm" data-testid="text-projection-error">
        <AlertTriangle className="mb-1 h-5 w-5 text-amber-500" />
        {(() => {
          const raw = (error as Error).message.replace(/^\d+:\s*/, "");
          try {
            return JSON.parse(raw).message || raw;
          } catch {
            return raw;
          }
        })()}
      </div>
    );
  if (!data || !view) return null;

  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const cols = data.months.length + 3;
  const STICKY = "sticky left-0 z-10";

  return (
    <div className="space-y-3" data-testid="revenue-projection">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-medium">Revenue projection</div>
          <div className="text-xs text-muted-foreground">
            {monthLabel(data.months[0])} – {monthLabel(data.months[data.months.length - 1])} · day rate × days the job
            runs each month · dates come from Field Ops &amp; Jobs and Upcoming work
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search job or customer"
              className="h-8 w-56 pl-7 pr-7 text-xs"
              data-testid="input-projection-search"
            />
            {q && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="inline-flex rounded-md border border-card-border p-0.5 text-xs">
            {(["Committed only", "+ Likely", "+ Bids"] as const).map((t, i) => (
              <button
                key={t}
                type="button"
                onClick={() => setLvl(i as Level)}
                className={`rounded px-2.5 py-1 font-medium ${lvl === i ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                data-testid={`button-projection-level-${i}`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      </div>

      {view.missing > 0 && (
        <div className="text-xs text-amber-700 dark:text-amber-400" data-testid="text-projection-missing">
          {view.missing} job{view.missing === 1 ? "" : "s"} still need{view.missing === 1 ? "s" : ""} a day rate and{" "}
          {view.missing === 1 ? "isn't" : "aren't"} counted in the totals.
        </div>
      )}

      {view.areas.length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-8 text-center text-sm text-muted-foreground">
          {q ? "No jobs match your search." : "No active or upcoming jobs in this window."}
        </div>
      ) : (
        <div className="overflow-auto rounded-lg border border-card-border" style={{ maxHeight: "70vh" }} data-testid="scroll-projection">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="sticky top-0 z-20 bg-muted text-xs text-muted-foreground">
              <tr>
                <th className={`${STICKY} z-30 bg-muted px-3 py-2 text-left font-medium`}>Job</th>
                <th className="px-3 py-2 text-left font-medium">Day rate</th>
                {data.months.map((m) => (
                  <th key={m} className="px-3 py-2 text-right font-medium whitespace-nowrap">
                    {monthLabel(m)}
                  </th>
                ))}
                <th className="px-3 py-2 text-right font-medium">6-mo total</th>
              </tr>
            </thead>
            <tbody>
              {view.areas.map((a) => {
                const open = !!q || !collapsed[a.area];
                return [
                  <tr
                    key={`h-${a.area}`}
                    className="cursor-pointer border-t border-card-border bg-muted/40 hover:bg-muted/60"
                    onClick={() => setCollapsed((c) => ({ ...c, [a.area]: !c[a.area] }))}
                    data-testid={`row-projection-area-${a.area}`}
                  >
                    <td colSpan={cols} className="px-3 py-2">
                      <span className="flex items-center gap-1.5 font-medium">
                        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        {a.area}
                        <span className="text-xs font-normal text-muted-foreground">
                          · {a.rows.length} job{a.rows.length === 1 ? "" : "s"}
                        </span>
                      </span>
                    </td>
                  </tr>,
                  ...(open
                    ? a.rows.map(({ r, days, amounts }) => (
                        <tr key={`${r.kind}-${r.id}`} className="border-t border-card-border/60" data-testid={`row-projection-${r.id}`}>
                          <td className={`${STICKY} bg-background px-3 py-2`}>
                            <div className="flex items-center gap-1.5">
                              <span className="font-medium">{r.name}</span>
                              <span className={`inline-flex rounded px-1.5 py-0.5 text-[11px] font-medium ${STAGE_TONE[r.stage] ?? ""}`}>
                                {r.stage}
                                {r.kind === "forecast" && r.odds != null && r.stage !== "Awarded" ? ` ${r.odds}%` : ""}
                              </span>
                            </div>
                            <div className="max-w-[240px] truncate text-xs text-muted-foreground">
                              {r.customer_name || "—"} ·{" "}
                              {r.start_on ? shortDate(r.start_on) : "Running"} → {r.end_on ? shortDate(r.end_on) : "no end date"}
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <RateInput row={r} canEdit={canEdit} />
                            {r.day_rate == null && r.latest_report_rate != null && (
                              <div className="mt-0.5 text-[11px] text-muted-foreground">
                                Latest report {money(r.latest_report_rate)}
                              </div>
                            )}
                          </td>
                          {amounts.map((v, i) => (
                            <td key={i} className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                              {days[i] === 0 ? (
                                <span className="text-muted-foreground/50">—</span>
                              ) : (
                                <>
                                  <div className={v == null ? "text-muted-foreground" : ""}>{money(v)}</div>
                                  <div className="text-[11px] text-muted-foreground">{days[i]} days</div>
                                </>
                              )}
                            </td>
                          ))}
                          <td className="px-3 py-2 text-right font-medium tabular-nums whitespace-nowrap">
                            {r.day_rate == null ? "—" : money(sum(amounts.map((v) => v ?? 0)))}
                          </td>
                        </tr>
                      ))
                    : []),
                  <tr key={`t-${a.area}`} className="border-t border-card-border bg-muted font-medium" data-testid={`row-projection-total-${a.area}`}>
                    <td className={`${STICKY} bg-muted px-3 py-2`} colSpan={2}>
                      {a.area} total
                    </td>
                    {a.totals.map((v, i) => (
                      <td key={i} className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                        {a.rated ? money(v) : "—"}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{a.rated ? money(sum(a.totals)) : "—"}</td>
                  </tr>,
                ];
              })}
            </tbody>
            <tfoot className="sticky bottom-0 z-20">
              <tr className="border-t-2 border-card-border bg-primary/10 font-semibold backdrop-blur" data-testid="row-projection-grand-total">
                <td className={`${STICKY} bg-muted px-3 py-2.5`} colSpan={2}>
                  All areas total
                </td>
                {view.grand.map((v, i) => (
                  <td key={i} className="bg-muted px-3 py-2.5 text-right tabular-nums whitespace-nowrap">
                    {view.anyRated ? money(v) : "—"}
                  </td>
                ))}
                <td className="bg-muted px-3 py-2.5 text-right tabular-nums whitespace-nowrap">
                  {view.anyRated ? money(sum(view.grand)) : "—"}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Each month is the day rate you enter × the days the job runs that month. A running job counts from the start of
        the window (or its start date) until its estimated release. With no release date set, it runs through the end of
        the window. Upcoming work jobs use their start and end dates, and their day rate is the same one shown in
        Upcoming work, so changing it in either place updates both. Amounts are not weighted by bid odds. Use the
        Committed / Likely / Bids buttons to choose which upcoming jobs are counted.
      </p>
    </div>
  );
}
