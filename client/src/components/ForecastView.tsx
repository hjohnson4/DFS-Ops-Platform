import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import {
  AREAS,
  FORECAST_CATEGORIES,
  FORECAST_DEFAULT_ODDS,
  type Customer,
  type ForecastBoard,
  type ForecastJob,
} from "@shared/schema";
import {
  type CategoryBlock,
  buildGrid,
  revenueByMonth,
  monthLabel,
  shortDate,
  type ForecastLevel,
  type Piece,
} from "@/lib/forecastGrid";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Plus, Pencil, Boxes, ArrowRightCircle, AlertTriangle, FileText, ChevronDown, ChevronRight, Search, X } from "lucide-react";
import { BidDocuments } from "@/components/BidDocuments";
import { RentalBadge } from "@/components/Rental";

const money = (n: number) =>
  n >= 1_000_000
    ? `$${(n / 1_000_000).toFixed(2)}M`
    : n >= 1000
      ? `$${Math.round(n / 1000).toLocaleString("en-US")}K`
      : `$${Math.round(n).toLocaleString("en-US")}`;

const STAGE_TONE: Record<string, string> = {
  Awarded: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  Likely: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  Bid: "bg-muted text-muted-foreground",
  Converted: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
};

const STRIPES = {
  backgroundImage: "repeating-linear-gradient(135deg, rgba(61,143,99,.55) 0 4px, rgba(61,143,99,.2) 4px 8px)",
};
const PIECE_CLASS: Record<string, string> = {
  act: "bg-[#1f6b45] text-white",
  awd: "bg-[#5ea883] text-white",
  lik: "text-foreground",
  bid: "border-[1.5px] border-dashed border-[#3d8f63] text-muted-foreground bg-emerald-500/5",
  shop: "bg-muted text-muted-foreground",
  idle: "border border-card-border bg-muted/30 text-muted-foreground/60 justify-center",
  conflict: "bg-rose-600 text-white",
};

function Cell({ pieces, rental = false }: { pieces: Piece[]; rental?: boolean }) {
  return (
    <div className={`flex h-8 gap-0.5 ${rental ? "rounded-md outline outline-2 outline-offset-1 outline-orange-400" : ""}`}>
      {pieces.map((p, i) => (
        <div
          key={i}
          title={p.tip}
          style={{ flexGrow: p.frac, flexBasis: 0, ...(p.kind === "lik" ? STRIPES : {}) }}
          className={`min-w-0 overflow-hidden whitespace-nowrap text-ellipsis rounded px-1 text-[10.5px] leading-8 ${PIECE_CLASS[p.kind]}`}
        >
          {p.frac >= 0.2 ? p.label : ""}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
export function ForecastView({ area }: { area: string }) {
  const { profile } = useAuth();
  const canEdit = profile?.role === "admin" || profile?.role === "area";
  const [lvl, setLvl] = useState<ForecastLevel>(1);
  const [editing, setEditing] = useState<ForecastJob | "new" | null>(null);
  const [placing, setPlacing] = useState<ForecastJob | null>(null);
  const [converting, setConverting] = useState<ForecastJob | null>(null);
  const [docsFor, setDocsFor] = useState<ForecastJob | null>(null);

  const qArea = area !== "all" ? area : "";
  const { data: board, isLoading, error } = useQuery<ForecastBoard>({
    queryKey: ["/api/forecast", qArea],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/forecast${qArea ? `?area=${encodeURIComponent(qArea)}` : ""}`);
      return res.json();
    },
  });

  const blocks = useMemo(
    () => (board ? buildGrid(board, lvl, FORECAST_CATEGORIES) : []),
    [board, lvl],
  );
  const revenue = useMemo(() => (board ? revenueByMonth(board) : null), [board]);

  if (isLoading) return <div className="py-8 text-center text-sm text-muted-foreground">Loading forecast…</div>;
  if (error || !board)
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm" data-testid="text-forecast-error">
        {(error as Error)?.message || "Could not load the forecast."}
      </div>
    );

  const open = board.forecasts.filter((f) => f.stage !== "Converted");
  const awarded = open.filter((f) => f.stage === "Awarded");
  const pipeline = open.filter((f) => f.stage !== "Awarded");
  const indefinite = board.jobs.filter((j) => !j.est_release_on).length;
  const nextMonth = revenue?.rows[1];
  const jobsInArea = qArea ? board.jobs.filter((j) => j.area === qArea) : board.jobs;

  return (
    <div className="space-y-5" data-testid="section-forecast">
      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Active jobs" value={String(jobsInArea.length)} sub={`${indefinite} indefinite`} />
        <Stat label="Awarded, not started" value={String(awarded.length)} sub={awarded.length ? "ready to convert" : "—"} />
        <Stat
          label="Pipeline"
          value={String(pipeline.length)}
          sub={`${pipeline.filter((f) => f.stage === "Likely").length} likely · ${pipeline.filter((f) => f.stage === "Bid").length} bid`}
        />
        <Stat
          label={nextMonth ? `${monthLabel(nextMonth.month)} revenue (weighted)` : "Revenue"}
          value={nextMonth && nextMonth.weighted > 0 ? money(nextMonth.weighted) : "—"}
          sub={nextMonth && nextMonth.committed > 0 ? `${money(nextMonth.committed)} committed` : "needs day rates"}
        />
      </div>

      {/* Centrifuge schedule */}
      <ScheduleCard board={board} blocks={blocks} lvl={lvl} setLvl={setLvl} />
      {/* Upcoming work */}
      <div className="rounded-lg border border-card-border">
        <div className="flex items-center justify-between gap-3 p-3">
          <div>
            <div className="font-medium">Upcoming work</div>
            <div className="text-xs text-muted-foreground">
              Stage sets the odds (Bid {FORECAST_DEFAULT_ODDS.Bid}%, Likely {FORECAST_DEFAULT_ODDS.Likely}%, Awarded{" "}
              {FORECAST_DEFAULT_ODDS.Awarded}%). {canEdit ? "You can change the odds on any job." : "Admins and Area Managers edit this list."}
            </div>
          </div>
          {canEdit && (
            <Button size="sm" onClick={() => setEditing("new")} data-testid="button-add-forecast">
              <Plus className="mr-1.5 h-4 w-4" /> Add upcoming job
            </Button>
          )}
        </div>
        {open.length === 0 ? (
          <div className="border-t border-card-border p-6 text-center text-sm text-muted-foreground">
            No upcoming work yet.
          </div>
        ) : (
          <div className="overflow-x-auto border-t border-card-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr className="text-left">
                  <th className="px-3 py-2 font-medium">Rig · customer</th>
                  <th className="px-3 py-2 font-medium">Area</th>
                  <th className="px-3 py-2 font-medium">Stage</th>
                  <th className="px-3 py-2 font-medium">Odds</th>
                  <th className="px-3 py-2 font-medium">Start → end</th>
                  <th className="px-3 py-2 font-medium">Centrifuges</th>
                  <th className="px-3 py-2 font-medium">Day rate</th>
                  <th className="px-3 py-2 font-medium">Bid PDFs</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {open.map((f) => {
                  const placedBB = (f.asset_ids || []).filter(
                    (id) => board.assets.find((a) => a.id === id)?.category === "Big Bowl Centrifuge",
                  ).length;
                  const placedSB = (f.asset_ids || []).length - placedBB;
                  return (
                    <tr key={f.id} className="border-t border-card-border" data-testid={`row-forecast-${f.id}`}>
                      <td className="px-3 py-2">
                        <div className="font-medium">{f.rig}</div>
                        <div className="text-xs text-muted-foreground">{f.customer_name || "—"}</div>
                      </td>
                      <td className="px-3 py-2 text-xs">{f.area}</td>
                      <td className="px-3 py-2">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STAGE_TONE[f.stage]}`}>{f.stage}</span>
                      </td>
                      <td className="px-3 py-2 tabular-nums">{f.odds}%</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {shortDate(f.start_on)} → {f.end_on ? shortDate(f.end_on) : "∞ Indefinite"}
                      </td>
                      <td className="px-3 py-2 text-xs whitespace-nowrap">
                        {f.big_bowl_needed > 0 && (
                          <div className={placedBB < f.big_bowl_needed ? "text-rose-700 dark:text-rose-400" : ""}>
                            Big Bowl {placedBB}/{f.big_bowl_needed} placed
                          </div>
                        )}
                        {f.small_bowl_needed > 0 && (
                          <div className={placedSB < f.small_bowl_needed ? "text-rose-700 dark:text-rose-400" : ""}>
                            Small Bowl {placedSB}/{f.small_bowl_needed} placed
                          </div>
                        )}
                        {f.big_bowl_needed + f.small_bowl_needed === 0 && "—"}
                      </td>
                      <td className="px-3 py-2 tabular-nums whitespace-nowrap">
                        {f.day_rate == null ? "—" : `$${f.day_rate.toLocaleString("en-US")}/day`}
                      </td>
                      <td className="px-3 py-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          onClick={() => setDocsFor(f)}
                          data-testid={`button-bid-docs-${f.id}`}
                        >
                          <FileText className="mr-1 h-3.5 w-3.5" />
                          {f.bid_doc_count ? `${f.bid_doc_count} PDF${f.bid_doc_count === 1 ? "" : "s"}` : canEdit ? "Add" : "—"}
                        </Button>
                      </td>
                      <td className="px-3 py-2">
                        {canEdit && (
                          <div className="flex justify-end gap-1.5">
                            <Button size="sm" variant="ghost" onClick={() => setEditing(f)} data-testid={`button-edit-forecast-${f.id}`}>
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => setPlacing(f)} data-testid={`button-place-units-${f.id}`}>
                              <Boxes className="mr-1 h-3.5 w-3.5" /> Units
                            </Button>
                            {f.stage === "Awarded" && (
                              <Button size="sm" onClick={() => setConverting(f)} data-testid={`button-convert-${f.id}`}>
                                <ArrowRightCircle className="mr-1 h-3.5 w-3.5" /> Convert to job
                              </Button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Active jobs release dates */}
      <ReleaseDates board={board} jobs={jobsInArea} canEdit={canEdit} />

      {revenue && revenue.noRate > 0 && (
        <p className="text-xs text-muted-foreground">
          Revenue leaves out {revenue.noRate} job{revenue.noRate === 1 ? "" : "s"} with no day rate set. Active jobs use the
          day rate saved on the job.
        </p>
      )}

      {editing && (
        <ForecastJobDialog
          forecast={editing === "new" ? null : editing}
          defaultArea={qArea || profile?.area || "West Texas"}
          lockArea={profile?.role !== "admin" ? (profile?.area ?? null) : null}
          board={board ?? null}
          onClose={() => setEditing(null)}
        />
      )}
      {placing && <UnitsDialog forecast={placing} board={board} onClose={() => setPlacing(null)} />}
      {docsFor && <BidDocsDialog forecast={docsFor} canEdit={canEdit} onClose={() => setDocsFor(null)} />}
      {converting && <ConvertDialog forecast={converting} board={board} onClose={() => setConverting(null)} />}
    </div>
  );
}

// ---- Centrifuge schedule ---------------------------------------------------
// Spare-all-6-months units are hidden by default, each category can collapse
// to just its Spare/Short line, the month row and unit column stay pinned
// while you scroll inside the card, and a search box filters by unit or rig.
const isSpareAllMonths = (r: CategoryBlock["rows"][number]) =>
  !r.cells.some((c) => c.some((p) => p.kind !== "idle"));

function ScheduleCard({
  board,
  blocks,
  lvl,
  setLvl,
}: {
  board: ForecastBoard;
  blocks: CategoryBlock[];
  lvl: ForecastLevel;
  setLvl: (l: ForecastLevel) => void;
}) {
  const [hideSpare, setHideSpare] = useState(true);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const rowMatches = (r: CategoryBlock["rows"][number]) => {
    const hay = [
      r.asset.tag,
      r.asset.area,
      r.asset.rental_vendor,
      ...r.cells.flatMap((c) => c.flatMap((p) => [p.label, p.tip])),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  };
  const hiddenSpare = hideSpare && !searching
    ? blocks.reduce((n, b) => n + b.rows.filter(isSpareAllMonths).length, 0)
    : 0;
  let matchCount = 0;
  const view = blocks.map((b) => {
    let rows = b.rows;
    let needs = b.needs;
    if (searching) {
      rows = rows.filter(rowMatches);
      needs = needs.filter((n) => `${n.forecast.rig} ${n.forecast.customer_name ?? ""}`.toLowerCase().includes(q));
    } else if (hideSpare) {
      rows = rows.filter((r) => !isSpareAllMonths(r));
    }
    matchCount += rows.length + needs.length;
    // Searching always opens the categories so matches are visible.
    const isOpen = searching || !collapsed[b.category];
    return { b, rows, needs, isOpen };
  });
  const STICKY_LEFT = "sticky left-0 z-10 bg-background";
  return (
    <div className="rounded-lg border border-card-border p-3" data-testid="card-schedule">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-medium">Centrifuge schedule</div>
          <div className="text-xs text-muted-foreground">
            {monthLabel(board.months[0])} – {monthLabel(board.months[5])} · hover a square for dates
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search unit or rig"
              className="h-8 w-48 pl-7 pr-7 text-xs"
              data-testid="input-schedule-search"
            />
            {searching && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
                data-testid="button-clear-schedule-search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox checked={hideSpare} onCheckedChange={(v) => setHideSpare(!!v)} data-testid="check-hide-spare" />
            Hide units spare all 6 months
          </label>
          <div className="inline-flex rounded-md border border-card-border p-0.5 text-xs">
            {(["Committed only", "+ Likely", "+ Bids"] as const).map((t, i) => (
              <button
                key={t}
                type="button"
                onClick={() => setLvl(i as ForecastLevel)}
                className={`rounded px-2.5 py-1 font-medium ${lvl === i ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                data-testid={`button-forecast-level-${i}`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      </div>
      {(hiddenSpare > 0 || searching) && (
        <div className="mb-2 text-xs text-muted-foreground" data-testid="text-schedule-filter-note">
          {searching ? (
            <>
              {matchCount} {matchCount === 1 ? "row matches" : "rows match"} “{query.trim()}” ·{" "}
              <button type="button" className="font-medium text-primary hover:underline" onClick={() => setQuery("")}>
                Clear search
              </button>
            </>
          ) : (
            <>
              {hiddenSpare} spare {hiddenSpare === 1 ? "unit" : "units"} hidden ·{" "}
              <button
                type="button"
                className="font-medium text-primary hover:underline"
                onClick={() => setHideSpare(false)}
                data-testid="button-show-spare"
              >
                Show
              </button>
            </>
          )}
        </div>
      )}
      {/* Own scroll area so the month row (top) and unit column (left) stay pinned. */}
      <div className="overflow-auto rounded-md" style={{ maxHeight: "70vh" }} data-testid="scroll-schedule">
        <div
          className="grid min-w-[720px] gap-[3px]"
          style={{ gridTemplateColumns: "96px repeat(6, minmax(96px, 1fr))" }}
          data-testid="grid-centrifuges"
        >
          <div className="sticky left-0 top-0 z-30 bg-background" />
          {board.months.map((m) => (
            <div key={m} className="sticky top-0 z-20 bg-background pb-1 pt-0.5 text-center text-xs font-medium text-muted-foreground">
              {monthLabel(m)}
            </div>
          ))}
          {view.map(({ b, rows, needs, isOpen }) => (
            <div key={b.category} className="contents">
              <button
                type="button"
                onClick={() => setCollapsed((c) => ({ ...c, [b.category]: !c[b.category] }))}
                disabled={searching}
                className="col-span-7 flex items-center justify-between rounded px-1 pb-1 pt-3 text-left text-sm font-medium hover:bg-muted/40 disabled:hover:bg-transparent"
                aria-expanded={isOpen}
                data-testid={`button-toggle-${b.category.startsWith("Big") ? "bb" : "sb"}`}
              >
                <span className={`flex items-center gap-1 ${STICKY_LEFT}`}>
                  {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  {b.category}
                </span>
                <span className="text-xs font-normal text-muted-foreground">
                  {searching ? `${rows.length} of ${b.rows.length} units` : `${b.rows.length} units`}
                  {!isOpen && " · click to show"}
                </span>
              </button>
              {isOpen &&
                rows.map((r) => (
                  <div key={r.asset.id} className="contents">
                    <div
                      className={`flex flex-col justify-center text-xs font-medium leading-tight ${STICKY_LEFT}`}
                      data-testid={`row-unit-${r.asset.tag}`}
                    >
                      <span className="flex items-center gap-1">
                        {r.asset.tag}
                        <RentalBadge asset={r.asset} className="px-1 text-[9px] leading-3" />
                      </span>
                      <span className="truncate text-[10px] font-normal text-muted-foreground">
                        {r.asset.is_rental && r.asset.rental_vendor ? r.asset.rental_vendor : r.asset.area}
                      </span>
                    </div>
                    {r.cells.map((c, i) => (
                      <Cell key={i} pieces={c} rental={!!r.asset.is_rental} />
                    ))}
                  </div>
                ))}
              {needs.map((n) => (
                <div key={n.forecast.id} className="contents">
                  <div className={`flex flex-col justify-center text-xs font-medium leading-tight text-rose-700 dark:text-rose-400 ${STICKY_LEFT}`}>
                    Needs {n.missing}
                    <span className="truncate text-[10px] font-normal">{n.forecast.rig}</span>
                  </div>
                  {n.cells.map((frac, i) => (
                    <div key={i} className="flex h-8">
                      {frac > 0 && (
                        <div
                          className="ml-auto truncate rounded border-[1.5px] border-dashed border-rose-500 bg-rose-500/10 px-1 text-[10.5px] leading-7 text-rose-700 dark:text-rose-400"
                          style={{ width: `${Math.round(frac * 100)}%` }}
                          title={`${n.forecast.rig} still needs ${n.missing} ${n.category}${n.missing > 1 ? "s" : ""} placed`}
                        >
                          {frac >= 0.25 ? `${n.missing} to place` : ""}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ))}
              {searching && rows.length === 0 && needs.length === 0 ? null : (
                <>
                  <div className={`border-t border-card-border pt-1 text-xs text-muted-foreground ${STICKY_LEFT}`}>Spare</div>
                  {b.spare.map((s, i) => {
                    const sh = b.short[i];
                    return (
                      <div
                        key={i}
                        className={`border-t border-card-border pt-1 text-center text-xs ${
                          sh ? "font-medium text-rose-700 dark:text-rose-400" : s ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400"
                        }`}
                        data-testid={`text-spare-${b.category.startsWith("Big") ? "bb" : "sb"}-${i}`}
                      >
                        {sh ? `Short ${sh}` : `${s} spare`}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          ))}
        </div>
        {searching && matchCount === 0 && (
          <div className="py-6 text-center text-sm text-muted-foreground">No units or rigs match “{query.trim()}”.</div>
        )}
      </div>
      <Legend />
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg bg-muted/40 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}

function Legend() {
  const items: [string, string][] = [
    ["act", "Active job"],
    ["awd", "Awarded / starting"],
    ["lik", "Likely"],
    ["bid", "Bid"],
    ["shop", "In shop"],
    ["idle", "Spare"],
    ["conflict", "Double-booked"],
  ];
  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map(([k, t]) => (
        <span key={k} className="inline-flex items-center gap-1.5">
          <span className={`inline-block h-3 w-4 rounded-sm ${PIECE_CLASS[k]}`} style={k === "lik" ? STRIPES : undefined} />
          {t}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block h-3 w-4 rounded-sm outline outline-2 outline-orange-400" />
        Rental unit
      </span>
      <span>∞ = indefinite (no end date) · a split square = the unit changes jobs that month</span>
    </div>
  );
}

// ---- Active jobs: estimated release ---------------------------------------
function ReleaseDates({ board, jobs, canEdit }: { board: ForecastBoard; jobs: ForecastBoard["jobs"]; canEdit: boolean }) {
  const { toast } = useToast();
  const save = useMutation({
    mutationFn: async (v: { id: string; est_release_on: string | null }) =>
      (await apiRequest("PATCH", `/api/jobs/${v.id}/est-release`, { est_release_on: v.est_release_on })).json(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/forecast"] }),
    onError: (e: any) => toast({ title: "Could not save", description: e.message, variant: "destructive" }),
  });
  const withUnits = jobs
    .map((j) => ({ j, units: board.assets.filter((a) => a.job_id === j.id) }))
    .filter((x) => x.units.length > 0)
    .sort((a, b) => a.j.job_number.localeCompare(b.j.job_number));
  if (!withUnits.length) return null;
  return (
    <div className="rounded-lg border border-card-border">
      <div className="p-3">
        <div className="font-medium">Active jobs · when do the centrifuges come back?</div>
        <div className="text-xs text-muted-foreground">
          Leave a job Indefinite when there's no end in sight. Set a date when you expect the units released.
        </div>
      </div>
      <div className="overflow-x-auto border-t border-card-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr className="text-left">
              <th className="px-3 py-2 font-medium">Job</th>
              <th className="px-3 py-2 font-medium">Area</th>
              <th className="px-3 py-2 font-medium">Centrifuges</th>
              <th className="px-3 py-2 font-medium">Est. release</th>
            </tr>
          </thead>
          <tbody>
            {withUnits.map(({ j, units }) => (
              <tr key={j.id} className="border-t border-card-border" data-testid={`row-release-${j.id}`}>
                <td className="px-3 py-2">
                  <div className="font-medium">{j.job_number}</div>
                  <div className="text-xs text-muted-foreground">{j.customer_name || "—"}</div>
                </td>
                <td className="px-3 py-2 text-xs">{j.area}</td>
                <td className="px-3 py-2 text-xs">{units.map((u) => u.tag).join(", ")}</td>
                <td className="px-3 py-2">
                  {canEdit ? (
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-1.5 text-xs">
                        <Checkbox
                          checked={!j.est_release_on}
                          onCheckedChange={(v) =>
                            save.mutate({ id: j.id, est_release_on: v ? null : board.months[1] + "-01" })
                          }
                          data-testid={`check-indefinite-${j.id}`}
                        />
                        Indefinite
                      </label>
                      {j.est_release_on && (
                        <Input
                          type="date"
                          className="h-8 w-[150px]"
                          defaultValue={j.est_release_on}
                          onBlur={(e) =>
                            e.target.value && e.target.value !== j.est_release_on &&
                            save.mutate({ id: j.id, est_release_on: e.target.value })
                          }
                          data-testid={`input-release-${j.id}`}
                        />
                      )}
                    </div>
                  ) : (
                    <span>{j.est_release_on ? shortDate(j.est_release_on) : "∞ Indefinite"}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- Add / edit forecast job ---------------------------------------------
function ForecastJobDialog({
  forecast,
  defaultArea,
  lockArea,
  board,
  onClose,
}: {
  forecast: ForecastJob | null;
  defaultArea: string;
  lockArea: string | null;
  board: ForecastBoard | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const { data: customers } = useQuery<Customer[]>({ queryKey: ["/api/customers"] });
  const [rig, setRig] = useState(forecast?.rig ?? "");
  const [customerId, setCustomerId] = useState<string>(forecast?.customer_id ?? "");
  const [customerName, setCustomerName] = useState(forecast?.customer_id ? "" : (forecast?.customer_name ?? ""));
  const [area, setArea] = useState<string>(forecast?.area ?? lockArea ?? defaultArea);
  const [stage, setStage] = useState<string>(forecast?.stage ?? "Bid");
  const [odds, setOdds] = useState<string>(String(forecast?.odds ?? FORECAST_DEFAULT_ODDS.Bid));
  const [start, setStart] = useState(forecast?.start_on ?? "");
  const [indef, setIndef] = useState(forecast ? !forecast.end_on : false);
  const [end, setEnd] = useState(forecast?.end_on ?? "");
  const [rate, setRate] = useState(forecast?.day_rate != null ? String(forecast.day_rate) : "");
  const [bb, setBb] = useState(String(forecast?.big_bowl_needed ?? 0));
  const [sb, setSb] = useState(String(forecast?.small_bowl_needed ?? 0));
  const [notes, setNotes] = useState(forecast?.notes ?? "");
  const [units, setUnits] = useState<Set<string>>(new Set(forecast?.asset_ids || []));
  const unitsChanged = (() => {
    const before = new Set(forecast?.asset_ids || []);
    return before.size !== units.size || Array.from(units).some((id) => !before.has(id));
  })();
  // Picking more units than the count needed raises the count to match.
  const pickUnits = (next: Set<string>) => {
    setUnits(next);
    const count = (cat: string) => (board?.assets ?? []).filter((a) => a.category === cat && next.has(a.id)).length;
    const nb = count("Big Bowl Centrifuge");
    const ns = count("Small Bowl Centrifuge");
    if (nb > (Number(bb) || 0)) setBb(String(nb));
    if (ns > (Number(sb) || 0)) setSb(String(ns));
  };

  const save = useMutation({
    mutationFn: async () => {
      const cust = customers?.find((c) => c.id === customerId);
      const body: any = {
        rig: rig.trim(),
        customer_id: cust ? cust.id : null,
        customer_name: cust ? cust.name : customerName.trim() || null,
        area,
        stage,
        odds: Number(odds),
        start_on: start,
        end_on: indef ? null : end || null,
        day_rate: rate.trim() ? Number(rate) : null,
        big_bowl_needed: Number(bb) || 0,
        small_bowl_needed: Number(sb) || 0,
        notes: notes.trim() || null,
      };
      const res = forecast
        ? await apiRequest("PATCH", `/api/forecast-jobs/${forecast.id}`, body)
        : await apiRequest("POST", "/api/forecast-jobs", body);
      const saved = await res.json();
      let unitError: string | null = null;
      const fid = forecast?.id ?? saved?.id;
      if (unitsChanged && fid) {
        try {
          await apiRequest("PUT", `/api/forecast-jobs/${fid}/units`, { asset_ids: Array.from(units) });
        } catch (e: any) {
          unitError = e.message;
        }
      }
      return { saved, unitError };
    },
    onSuccess: ({ unitError }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/forecast"] });
      if (unitError)
        toast({
          title: "Job saved, but the units were not",
          description: `${unitError}. Use Place units on the job to try again.`,
          variant: "destructive",
        });
      else toast({ title: forecast ? "Upcoming job updated" : "Upcoming job added" });
      onClose();
    },
    onError: (e: any) => toast({ title: "Could not save", description: e.message, variant: "destructive" }),
  });
  const mark = useMutation({
    mutationFn: async (kind: "Lost" | "delete") =>
      kind === "delete"
        ? apiRequest("DELETE", `/api/forecast-jobs/${forecast!.id}`)
        : apiRequest("PATCH", `/api/forecast-jobs/${forecast!.id}`, { stage: "Lost" }),
    onSuccess: (_d, kind) => {
      queryClient.invalidateQueries({ queryKey: ["/api/forecast"] });
      toast({ title: kind === "delete" ? "Upcoming job deleted" : "Marked as lost" });
      onClose();
    },
    onError: (e: any) => toast({ title: "Could not update", description: e.message, variant: "destructive" }),
  });

  const valid = rig.trim() && start && (indef || end) && (!end || indef || end >= start);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{forecast ? "Edit upcoming job" : "Add upcoming job"}</DialogTitle>
          <DialogDescription>
            Plan the work, how many centrifuges it needs, and (optionally) which units go on it. Bid PDFs can be added after you save.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <Label>Rig / job name</Label>
            <Input value={rig} onChange={(e) => setRig(e.target.value)} placeholder="e.g. Patterson 287" data-testid="input-forecast-rig" />
          </div>
          <div>
            <Label>Customer</Label>
            <Select value={customerId || "__other"} onValueChange={(v) => setCustomerId(v === "__other" ? "" : v)}>
              <SelectTrigger data-testid="select-forecast-customer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__other">Not in the list yet…</SelectItem>
                {(customers ?? [])
                  .filter((c) => c.active !== false)
                  .map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            {!customerId && (
              <Input
                className="mt-1.5"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="Customer name"
                data-testid="input-forecast-customer-name"
              />
            )}
          </div>
          <div>
            <Label>Area</Label>
            <Select value={area} onValueChange={setArea} disabled={!!lockArea}>
              <SelectTrigger data-testid="select-forecast-area">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AREAS.map((a) => (
                  <SelectItem key={a} value={a}>
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Stage</Label>
            <Select
              value={stage}
              onValueChange={(v) => {
                setStage(v);
                setOdds(String(FORECAST_DEFAULT_ODDS[v as keyof typeof FORECAST_DEFAULT_ODDS]));
              }}
            >
              <SelectTrigger data-testid="select-forecast-stage">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["Bid", "Likely", "Awarded"].map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Odds (%)</Label>
            <Input type="number" min={0} max={100} value={odds} onChange={(e) => setOdds(e.target.value)} data-testid="input-forecast-odds" />
          </div>
          <div>
            <Label>Start</Label>
            <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} data-testid="input-forecast-start" />
          </div>
          <div>
            <Label>End</Label>
            <label className="flex h-5 items-center gap-1.5 text-xs">
              <Checkbox checked={indef} onCheckedChange={(v) => setIndef(!!v)} data-testid="check-forecast-indefinite" />
              Indefinite (no end date)
            </label>
            {!indef && (
              <Input type="date" className="mt-1" value={end} onChange={(e) => setEnd(e.target.value)} data-testid="input-forecast-end" />
            )}
          </div>
          <div>
            <Label>Big Bowl Centrifuges</Label>
            <Input type="number" min={0} max={20} value={bb} onChange={(e) => setBb(e.target.value)} data-testid="input-forecast-bb" />
          </div>
          <div>
            <Label>Small Bowl Centrifuges</Label>
            <Input type="number" min={0} max={20} value={sb} onChange={(e) => setSb(e.target.value)} data-testid="input-forecast-sb" />
          </div>
          <div>
            <Label>Day rate ($/day)</Label>
            <Input type="number" min={0} value={rate} onChange={(e) => setRate(e.target.value)} placeholder="optional" data-testid="input-forecast-rate" />
          </div>
          <div className="col-span-2">
            <Label>Notes</Label>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} data-testid="input-forecast-notes" />
          </div>
          <div className="col-span-2 rounded-md border border-card-border p-3" data-testid="forecast-assign-units">
            <div className="mb-1 text-sm font-medium">Assign units (optional)</div>
            {!board ? (
              <p className="text-xs text-muted-foreground">Loading units…</p>
            ) : !start ? (
              <p className="text-xs text-muted-foreground">Pick a start date to see which units are free.</p>
            ) : (
              <UnitPicker
                board={board}
                forecastId={forecast?.id ?? null}
                area={area}
                start={start}
                end={indef ? null : end || null}
                need={{ "Big Bowl Centrifuge": Number(bb) || 0, "Small Bowl Centrifuge": Number(sb) || 0 }}
                sel={units}
                onChange={pickUnits}
                maxHeight="max-h-64"
              />
            )}
          </div>
        </div>
        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          <div className="flex gap-2">
            {forecast && (
              <>
                <Button variant="outline" size="sm" onClick={() => mark.mutate("Lost")} disabled={mark.isPending} data-testid="button-forecast-lost">
                  Mark lost
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-rose-600"
                  onClick={() => confirm("Delete this upcoming job? Use Mark lost to keep a record instead.") && mark.mutate("delete")}
                  disabled={mark.isPending}
                  data-testid="button-forecast-delete"
                >
                  Delete
                </Button>
              </>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => save.mutate()} disabled={!valid || save.isPending} data-testid="button-forecast-save">
              {save.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Place specific units -------------------------------------------------
// Shared checklist of centrifuges with free/busy notes for a date range.
function UnitPicker({
  board,
  forecastId,
  area,
  start,
  end,
  need,
  sel,
  onChange,
  maxHeight = "max-h-[55vh]",
}: {
  board: ForecastBoard;
  forecastId: string | null;
  area: string;
  start: string;
  end: string | null;
  need: Record<string, number>;
  sel: Set<string>;
  onChange: (next: Set<string>) => void;
  maxHeight?: string;
}) {
  const jobs = new Map(board.jobs.map((j) => [j.id, j]));
  // Is the unit busy (job or another forecast) during these dates?
  const busyNote = (a: ForecastBoard["assets"][number]): string | null => {
    const j = a.job_id ? jobs.get(a.job_id) : undefined;
    if (j) {
      if (!j.est_release_on) return `On ${j.job_number} (indefinite)`;
      if (j.est_release_on >= start) return `On ${j.job_number} until ${shortDate(j.est_release_on)}`;
    }
    for (const f of board.forecasts) {
      if (f.id === forecastId || !(f.asset_ids || []).includes(a.id)) continue;
      const overlap = (!f.end_on || f.end_on >= start) && (!end || f.start_on <= end);
      if (overlap) return `Planned on ${f.rig} (${f.stage})`;
    }
    return null;
  };
  const groups = FORECAST_CATEGORIES.map((c) => {
    const units = board.assets
      .filter((a) => a.category === c)
      .map((a) => ({ a, note: busyNote(a) }))
      // free units in the job's area first, then the rest in asset order
      .sort((x, y) => Number(!!x.note) - Number(!!y.note) || Number(x.a.area !== area) - Number(y.a.area !== area));
    const picked = units.filter((u) => sel.has(u.a.id)).length;
    return { c, need: need[c] ?? 0, units, picked };
  });
  return (
    <div className={`${maxHeight} space-y-4 overflow-y-auto pr-1`}>
      {groups.map((g) => (
        <div key={g.c}>
          <div className="mb-1.5 flex justify-between text-sm font-medium">
            {g.c}
            <span className={`text-xs ${g.picked < g.need ? "text-rose-600" : "text-muted-foreground"}`}>
              {g.picked} of {g.need} picked
            </span>
          </div>
          {g.units.length === 0 && <p className="text-xs text-muted-foreground">No units in the fleet.</p>}
          <div className="space-y-1">
            {g.units.map(({ a, note }) => (
              <label key={a.id} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-muted/50">
                <Checkbox
                  checked={sel.has(a.id)}
                  onCheckedChange={(v) => {
                    const n = new Set(sel);
                    v ? n.add(a.id) : n.delete(a.id);
                    onChange(n);
                  }}
                  data-testid={`check-unit-${a.tag}`}
                />
                <span className="flex w-28 items-center gap-1 font-medium">{a.tag}<RentalBadge asset={a} /></span>
                <span className="text-xs text-muted-foreground">{a.area}</span>
                <span className={`ml-auto text-xs ${note ? "text-amber-700 dark:text-amber-400" : "text-emerald-700 dark:text-emerald-400"}`}>
                  {note || "Free"}
                </span>
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function UnitsDialog({ forecast, board, onClose }: { forecast: ForecastJob; board: ForecastBoard; onClose: () => void }) {
  const { toast } = useToast();
  const [sel, setSel] = useState<Set<string>>(new Set(forecast.asset_ids || []));
  const save = useMutation({
    mutationFn: async () =>
      (await apiRequest("PUT", `/api/forecast-jobs/${forecast.id}/units`, { asset_ids: Array.from(sel) })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/forecast"] });
      toast({ title: "Units saved" });
      onClose();
    },
    onError: (e: any) => toast({ title: "Could not save", description: e.message, variant: "destructive" }),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Place units · {forecast.rig}</DialogTitle>
          <DialogDescription>
            {shortDate(forecast.start_on)} → {forecast.end_on ? shortDate(forecast.end_on) : "indefinite"}. Free units are
            listed first. A busy unit can still be picked — it will show as double-booked until the dates line up.
          </DialogDescription>
        </DialogHeader>
        <UnitPicker
          board={board}
          forecastId={forecast.id}
          area={forecast.area}
          start={forecast.start_on}
          end={forecast.end_on}
          need={{ "Big Bowl Centrifuge": forecast.big_bowl_needed, "Small Bowl Centrifuge": forecast.small_bowl_needed }}
          sel={sel}
          onChange={setSel}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="button-save-units">
            {save.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Save units
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Bid PDFs ---------------------------------------------------------------
function BidDocsDialog({ forecast, canEdit, onClose }: { forecast: ForecastJob; canEdit: boolean; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Bid PDFs · {forecast.rig}</DialogTitle>
          <DialogDescription>
            {forecast.customer_name || "No customer yet"} · {forecast.area}. If this bid becomes a job, these PDFs move to the job page.
          </DialogDescription>
        </DialogHeader>
        <BidDocuments
          listUrl={`/api/forecast-jobs/${forecast.id}/documents`}
          uploadUrl={`/api/forecast-jobs/${forecast.id}/documents`}
          canEdit={canEdit}
          alsoInvalidate={["/api/forecast"]}
          emptyText={canEdit ? "No bid PDFs yet. Add the bid, revisions or pricing sheets." : "No bid PDFs yet."}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Convert to job -------------------------------------------------------
function ConvertDialog({ forecast, board, onClose }: { forecast: ForecastJob; board: ForecastBoard; onClose: () => void }) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const { data: customers } = useQuery<Customer[]>({ queryKey: ["/api/customers"] });
  const [jobNumber, setJobNumber] = useState(forecast.rig);
  const [customerId, setCustomerId] = useState(forecast.customer_id ?? "");
  const [wellName, setWellName] = useState("");
  const jobs = new Map(board.jobs.map((j) => [j.id, j]));
  const planned = board.assets.filter((a) => (forecast.asset_ids || []).includes(a.id));
  const freeNow = (a: (typeof planned)[number]) => !a.job_id;
  const [move, setMove] = useState<Set<string>>(new Set(planned.filter(freeNow).map((a) => a.id)));

  const go = useMutation({
    mutationFn: async () =>
      (
        await apiRequest("POST", `/api/forecast-jobs/${forecast.id}/convert`, {
          job_number: jobNumber.trim(),
          customer_id: customerId,
          well_name: wellName.trim() || null,
          asset_ids: Array.from(move),
        })
      ).json(),
    onSuccess: (r: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/forecast"] });
      queryClient.invalidateQueries({ queryKey: ["/api/jobs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
      toast({
        title: `Job ${r.job?.job_number} created`,
        description: `${r.moved_asset_ids?.length ?? 0} unit(s) moved onto the job.${forecast.bid_doc_count ? " Bid PDFs moved with it." : ""}`,
      });
      onClose();
      if (r.job?.id) navigate(`/jobs/${r.job.id}`);
    },
    onError: (e: any) => toast({ title: "Could not create the job", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Convert to job · {forecast.rig}</DialogTitle>
          <DialogDescription>Everything carries over from the forecast. Review, then create the job.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <Label>Job number (matches V8 on reports)</Label>
            <Input value={jobNumber} onChange={(e) => setJobNumber(e.target.value)} data-testid="input-convert-job-number" />
          </div>
          <div>
            <Label>Customer</Label>
            <Select value={customerId} onValueChange={setCustomerId}>
              <SelectTrigger data-testid="select-convert-customer">
                <SelectValue placeholder={forecast.customer_name ? `Pick: ${forecast.customer_name}` : "Pick a customer"} />
              </SelectTrigger>
              <SelectContent>
                {(customers ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!forecast.customer_id && forecast.customer_name && (
              <div className="mt-1 text-xs text-muted-foreground">
                "{forecast.customer_name}" isn't a customer yet. An Admin can add it in Customers.
              </div>
            )}
          </div>
          <Field label="Area" value={forecast.area} />
          <Field label="Day rate" value={forecast.day_rate == null ? "—" : `$${forecast.day_rate.toLocaleString("en-US")}/day`} />
          <Field label="Start" value={shortDate(forecast.start_on)} />
          <Field label="Est. release" value={forecast.end_on ? shortDate(forecast.end_on) : "Indefinite"} />
          <div className="col-span-2">
            <Label>Well name (optional)</Label>
            <Input value={wellName} onChange={(e) => setWellName(e.target.value)} placeholder="e.g. Bond 304H" data-testid="input-convert-well" />
          </div>
        </div>
        <div className="mt-2">
          <div className="mb-1 text-sm font-medium">Planned centrifuges</div>
          {planned.length === 0 ? (
            <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs">
              <AlertTriangle className="h-4 w-4 text-amber-600" /> No units placed yet. You can assign them on the job later.
            </div>
          ) : (
            <div className="space-y-1">
              {planned.map((a) => {
                const j = a.job_id ? jobs.get(a.job_id) : undefined;
                return (
                  <label key={a.id} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm">
                    <Checkbox
                      checked={move.has(a.id)}
                      disabled={!!j}
                      onCheckedChange={(v) => {
                        const n = new Set(move);
                        v ? n.add(a.id) : n.delete(a.id);
                        setMove(n);
                      }}
                      data-testid={`check-move-${a.tag}`}
                    />
                    <span className="flex w-28 items-center gap-1 font-medium">{a.tag}<RentalBadge asset={a} /></span>
                    <span className="text-xs text-muted-foreground">{a.category.replace(" Centrifuge", "")}</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {j ? `Still on ${j.job_number} — stays planned, move it when released` : "Move onto the job now"}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
          {!!forecast.bid_doc_count && (
            <p className="text-xs text-muted-foreground" data-testid="text-convert-bid-docs">
              {forecast.bid_doc_count} bid PDF{forecast.bid_doc_count === 1 ? "" : "s"} will move to the job page.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => go.mutate()} disabled={!jobNumber.trim() || !customerId || go.isPending} data-testid="button-create-job">
            {go.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Create job
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 rounded-md border border-card-border bg-muted/30 px-2.5 py-1.5">{value}</div>
    </div>
  );
}
