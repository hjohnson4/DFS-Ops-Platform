// Mud Plant (billing calendar) job cards:
//  - MudPlantBilling: every day from the billing start date bills the set day
//    rate unless it's marked Not billing. Admin / Area Manager can switch any
//    day (past days too) and change the start date (billing back-dates).
//  - DailyCentrifugeHours: hours each centrifuge ran per day (0–24), entered
//    by hand because this job gets no daily reports.
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ChevronLeft, ChevronRight, Loader2, AlertTriangle } from "lucide-react";
import type { JobWithCustomer, ManualBilling } from "@shared/schema";

type CalDay = { day: string; billing: boolean; note: string | null; changed_by_name: string | null; changed_at: string };
type CalEvent = {
  kind: "day" | "start";
  day: string | null;
  billing: boolean | null;
  start_date: string | null;
  note: string | null;
  changed_by_name: string | null;
  created_at: string;
};
type CalData = {
  start_date: string | null;
  day_rate: number | null;
  today: string;
  days: CalDay[];
  events: CalEvent[];
  summary: ManualBilling | null;
  daily: Record<string, number>;
  can_edit: boolean;
};

const money = (n: number | null | undefined, cents = false) =>
  n == null
    ? "—"
    : n.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: cents ? 2 : 0,
        maximumFractionDigits: cents ? 2 : 0,
      });
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MON = MONTHS.map((m) => m.slice(0, 3));
const short = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${MON[m - 1]} ${d}`;
};
const mdy = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${m}/${d}/${y}`;
};
const stamp = (ts: string) =>
  new Date(ts).toLocaleString("en-US", {
    timeZone: "America/Chicago",
    month: "numeric",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const pad2 = (n: number) => String(n).padStart(2, "0");

// ---------------------------------------------------------------------------
export function MudPlantBilling({ job }: { job: JobWithCustomer }) {
  const { toast } = useToast();
  const key = ["/api/jobs", job.id, "billing-calendar"];
  const { data, isLoading } = useQuery<CalData>({ queryKey: key });
  const today = data?.today ?? new Date().toISOString().slice(0, 10);
  const [ym, setYm] = useState<string>(today.slice(0, 7));
  useEffect(() => {
    if (data?.today) setYm(data.today.slice(0, 7));
  }, [data?.today]);
  const [startDraft, setStartDraft] = useState("");
  useEffect(() => {
    setStartDraft(data?.start_date ?? "");
  }, [data?.start_date]);
  const [pick, setPick] = useState<string | null>(null);
  const [pickBilling, setPickBilling] = useState(true);
  const [note, setNote] = useState("");

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: key });
    queryClient.invalidateQueries({ queryKey: ["/api/jobs", job.id] });
    queryClient.invalidateQueries({ queryKey: ["/api/jobs"] });
    queryClient.invalidateQueries({ queryKey: ["/api/revenue/summary"] });
  };
  const saveDay = useMutation({
    mutationFn: async (v: { day: string; billing: boolean; note: string }) =>
      (await apiRequest("PUT", `/api/jobs/${job.id}/billing-calendar/day`, v)).json(),
    onSuccess: (_r, v) => {
      refresh();
      toast({ title: `${short(v.day)} set to ${v.billing ? "Billing" : "Not billing"}` });
      setPick(null);
    },
    onError: (e: any) => toast({ title: "Could not save", description: e.message, variant: "destructive" }),
  });
  const saveStart = useMutation({
    mutationFn: async (start_date: string) =>
      (await apiRequest("PUT", `/api/jobs/${job.id}/billing-calendar/start`, { start_date })).json(),
    onSuccess: (_r, v) => {
      refresh();
      toast({ title: `Billing now starts ${mdy(v)}`, description: "Billing back-dated to the new start date." });
    },
    onError: (e: any) => toast({ title: "Could not save", description: e.message, variant: "destructive" }),
  });

  const overrides = useMemo(() => {
    const m = new Map<string, CalDay>();
    for (const d of data?.days ?? []) m.set(d.day, d);
    return m;
  }, [data?.days]);
  const b = data?.summary;
  const start = data?.start_date ?? null;
  const rate = data?.day_rate ?? null;
  const canEdit = !!data?.can_edit;

  const [y, m] = ym.split("-").map(Number);
  const first = `${ym}-01`;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = new Date(first + "T12:00:00Z").getUTCDay();
  const cells: (string | null)[] = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= dim; d++) cells.push(`${ym}-${pad2(d)}`);
  while (cells.length % 7) cells.push(null);
  const shift = (n: number) => {
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    setYm(`${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`);
  };

  const openDay = (iso: string) => {
    if (!canEdit) return;
    const o = overrides.get(iso);
    const isBilling = o ? o.billing : true;
    setPick(iso);
    setPickBilling(!isBilling);
    setNote(o?.note ?? "");
  };

  return (
    <div className="mt-3 rounded-lg border border-card-border bg-card p-4 text-sm" data-testid="mud-plant-billing">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-medium">Set day rate — billing calendar</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            Every day from the billing start date bills {money(rate, true)} unless it's marked Not billing.
            {canEdit ? " Tap any day to switch it — past days too." : " Admin / Area Manager can switch days."}
          </div>
        </div>
        <div className="flex gap-6 text-right">
          <div>
            <div className="text-xs text-muted-foreground">Days billed</div>
            <div className="text-lg font-semibold tabular-nums" data-testid="cal-days-billed">
              {b?.start_date ? b.billable_days : "—"}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Not billed</div>
            <div className="text-lg font-semibold tabular-nums" data-testid="cal-days-off">
              {b?.start_date ? b.not_billed_days ?? 0 : "—"}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Billed to date</div>
            <div className="text-lg font-semibold tabular-nums text-primary" data-testid="cal-total">
              {money(b?.total, true)}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-sm">Billing starts</span>
        {canEdit ? (
          <>
            <Input
              type="date"
              className="h-8 w-[150px]"
              value={startDraft}
              max={today}
              onChange={(e) => setStartDraft(e.target.value)}
              data-testid="input-billing-start"
            />
            {startDraft && startDraft !== (start ?? "") && (
              <Button
                size="sm"
                className="h-8"
                disabled={saveStart.isPending}
                onClick={() => saveStart.mutate(startDraft)}
                data-testid="button-save-billing-start"
              >
                {saveStart.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} Save start date
              </Button>
            )}
          </>
        ) : (
          <span className="font-medium">{mdy(start)}</span>
        )}
        <span className="text-xs text-muted-foreground">changing this back-dates billing automatically</span>
        <span className="flex-1" />
        <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => shift(-1)} data-testid="button-cal-prev">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="min-w-[130px] text-center font-semibold" data-testid="text-cal-month">
          {MONTHS[m - 1]} {y}
        </span>
        <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => shift(1)} data-testid="button-cal-next">
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      {isLoading ? (
        <div className="py-8 text-center text-muted-foreground">Loading…</div>
      ) : (
        <div className="mt-3 grid grid-cols-7 gap-1.5" data-testid="billing-calendar-grid">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
            <div key={d} className="text-center text-xs font-semibold text-muted-foreground">
              {d}
            </div>
          ))}
          {cells.map((iso, i) => {
            if (!iso) return <div key={`b${i}`} />;
            const dnum = Number(iso.slice(8));
            const future = iso > today;
            const before = !start || iso < start;
            const o = overrides.get(iso);
            const off = o ? !o.billing : false;
            const live = !future && !before;
            const amt = data?.daily?.[iso];
            const cls = !live
              ? "bg-muted/40 text-muted-foreground/60 border-border"
              : off
                ? "bg-red-50 border-red-200 dark:bg-red-950/30 dark:border-red-900"
                : "bg-emerald-50 border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-900";
            return (
              <button
                key={iso}
                type="button"
                onClick={() => openDay(iso)}
                disabled={!canEdit}
                title={o?.note ? `${o.note}${o.changed_by_name ? ` — ${o.changed_by_name}` : ""}` : undefined}
                className={`relative h-16 rounded-md border px-2 py-1 text-left text-xs ${cls} ${
                  iso === today ? "ring-2 ring-primary ring-offset-1" : ""
                } ${canEdit ? "hover:brightness-95 cursor-pointer" : "cursor-default"}`}
                data-testid={`cal-day-${iso}`}
              >
                <div className="text-sm font-bold">{dnum}</div>
                {live && (
                  <>
                    <div
                      className={`absolute bottom-1 left-2 text-[11px] font-semibold ${
                        off ? "text-destructive" : "text-primary"
                      }`}
                    >
                      {off ? "Not billing" : "Billing"}
                    </div>
                    <div className="absolute bottom-1 right-2 text-[11px] text-muted-foreground tabular-nums">
                      {off ? "$0" : money(amt ?? 0)}
                    </div>
                  </>
                )}
                {!live && off && (
                  <div className="absolute bottom-1 left-2 text-[11px] font-semibold text-destructive/70">Not billing</div>
                )}
                {o?.note && <span className="absolute right-1.5 top-1 h-1.5 w-1.5 rounded-full bg-amber-500" />}
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-sm border border-emerald-200 bg-emerald-50" /> Billing
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-sm border border-red-200 bg-red-50" /> Not billing
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-sm border bg-muted/40" /> Future / before start
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" /> Has a note
        </span>
        {b?.today_status && b.today_status !== "Active" && (
          <span className="text-destructive">Job is {b.today_status} — days bill $0 until it's Active again.</span>
        )}
      </div>

      {(data?.events?.length ?? 0) > 0 && (
        <div className="mt-3 border-t pt-2 text-xs text-muted-foreground" data-testid="billing-calendar-log">
          <div className="mb-1 font-semibold text-foreground">Recent changes</div>
          <ul className="space-y-0.5">
            {data!.events.slice(0, 8).map((e, i) => (
              <li key={i}>
                {e.kind === "start"
                  ? `Billing start → ${mdy(e.start_date)}`
                  : `${short(e.day)} → ${e.billing ? "Billing" : "Not billing"}`}
                {" — "}
                {e.changed_by_name ?? "—"}, {stamp(e.created_at)}
                {e.note ? ` · "${e.note}"` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Dialog open={!!pick} onOpenChange={(o) => !o && setPick(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{pick ? `${MONTHS[Number(pick.slice(5, 7)) - 1]} ${Number(pick.slice(8))}, ${pick.slice(0, 4)}` : ""}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant={pickBilling ? "default" : "outline"}
                onClick={() => setPickBilling(true)}
                data-testid="button-day-billing"
              >
                Billing
              </Button>
              <Button
                type="button"
                variant={!pickBilling ? "destructive" : "outline"}
                onClick={() => setPickBilling(false)}
                data-testid="button-day-not-billing"
              >
                Not billing
              </Button>
            </div>
            <div className="text-xs text-muted-foreground">
              {pickBilling ? `This day bills ${money(rate, true)}.` : "This day bills $0."}
            </div>
            <Textarea
              placeholder="Note (optional) — e.g. plant shut down"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              data-testid="input-day-note"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPick(null)}>
              Cancel
            </Button>
            <Button
              disabled={saveDay.isPending}
              onClick={() => pick && saveDay.mutate({ day: pick, billing: pickBilling, note })}
              data-testid="button-save-day"
            >
              {saveDay.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
type HoursAsset = {
  id: string;
  tag: string;
  category: string;
  hours_since_service: number | null;
  service_state: string | null;
  month_hours: number;
};
type HoursEntry = { asset_id: string; report_date: string; hours: number; entered_by_name: string | null; created_at: string };
type HoursData = {
  from: string;
  to: string;
  today: string;
  assets: HoursAsset[];
  entries: HoursEntry[];
  missing_days: string[];
  can_edit: boolean;
};

async function getHours(jobId: string, from?: string, to?: string): Promise<HoursData> {
  const q = new URLSearchParams();
  if (from) q.set("from", from);
  if (to) q.set("to", to);
  const res = await apiRequest("GET", `/api/jobs/${jobId}/manual-hours${q.toString() ? `?${q}` : ""}`);
  return res.json();
}

function ServicePill({ state }: { state: string | null }) {
  if (!state) return <span className="text-muted-foreground">—</span>;
  const s = String(state);
  const cls =
    s === "Overdue"
      ? "bg-red-50 text-destructive"
      : s === "Soon"
        ? "bg-amber-50 text-amber-800"
        : s === "OK"
          ? "bg-emerald-50 text-primary"
          : "bg-muted text-muted-foreground";
  const label = s === "Soon" ? "Due soon" : s === "OK" || s === "Ok" ? "OK" : s;
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{label}</span>;
}

export function DailyCentrifugeHours({ job }: { job: JobWithCustomer }) {
  const { toast } = useToast();
  const listKey = ["/api/jobs", job.id, "manual-hours", "recent"];
  const { data: recent, isLoading } = useQuery<HoursData>({
    queryKey: listKey,
    queryFn: () => getHours(job.id),
  });
  const today = recent?.today ?? new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState<string>("");
  useEffect(() => {
    if (!date && recent?.today) setDate(recent.today);
  }, [recent?.today]);
  const dayKey = ["/api/jobs", job.id, "manual-hours", "day", date];
  const { data: dayData } = useQuery<HoursData>({
    queryKey: dayKey,
    queryFn: () => getHours(job.id, addDays(date, -1), date),
    enabled: !!date,
  });
  const [vals, setVals] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!dayData) return;
    const v: Record<string, string> = {};
    for (const a of dayData.assets) {
      const e = dayData.entries.find((x) => x.asset_id === a.id && x.report_date === date);
      v[a.id] = e ? String(Number(e.hours)) : "";
    }
    setVals(v);
  }, [dayData, date]);

  const assets = recent?.assets ?? [];
  const canEdit = !!recent?.can_edit;
  const yesterday = date ? addDays(date, -1) : "";
  const yEntries = (dayData?.entries ?? []).filter((e) => e.report_date === yesterday);
  const dayEntries = (dayData?.entries ?? []).filter((e) => e.report_date === date);
  const lastSaved = dayEntries.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];

  const save = useMutation({
    mutationFn: async () => {
      const entries = assets.map((a) => ({
        asset_id: a.id,
        hours: (vals[a.id] ?? "").trim() === "" ? null : Number(vals[a.id]),
      }));
      return (await apiRequest("PUT", `/api/jobs/${job.id}/manual-hours`, { date, entries })).json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/jobs", job.id, "manual-hours"] });
      queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/jobs", job.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
      toast({ title: `Hours saved for ${mdy(date)}` });
    },
    onError: (e: any) => toast({ title: "Could not save hours", description: e.message, variant: "destructive" }),
  });

  const bad = assets.some((a) => {
    const s = (vals[a.id] ?? "").trim();
    if (s === "") return false;
    const n = Number(s);
    return !Number.isFinite(n) || n < 0 || n > 24;
  });

  // Last 7 days table (newest first)
  const days: string[] = [];
  for (let i = 0; i < 7; i++) days.push(addDays(today, -i));
  const cell = (aid: string, d: string) => recent?.entries.find((e) => e.asset_id === aid && e.report_date === d);
  const missing = recent?.missing_days ?? [];

  return (
    <div className="mt-3 rounded-lg border border-card-border bg-card p-4 text-sm" data-testid="daily-centrifuge-hours">
      <div className="font-medium">Daily centrifuge hours</div>
      <div className="text-xs text-muted-foreground mt-0.5">
        Hours each machine ran that day (0–24). Counts toward hours since service, service alerts and utilization —
        same as hours from a daily report.
      </div>

      {isLoading ? (
        <div className="py-6 text-center text-muted-foreground">Loading…</div>
      ) : assets.length === 0 ? (
        <div className="mt-3 rounded-md border border-dashed p-4 text-center text-muted-foreground">
          No centrifuges are assigned to this job.
        </div>
      ) : (
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span>Date</span>
              <Input
                type="date"
                className="h-8 w-[150px]"
                value={date}
                max={today}
                onChange={(e) => e.target.value && setDate(e.target.value)}
                data-testid="input-hours-date"
              />
              <span className="flex-1" />
              {canEdit && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  disabled={!yEntries.length}
                  title={yEntries.length ? undefined : "No hours were entered the day before"}
                  onClick={() => {
                    const v = { ...vals };
                    for (const a of assets) {
                      const e = yEntries.find((x) => x.asset_id === a.id);
                      v[a.id] = e ? String(Number(e.hours)) : "";
                    }
                    setVals(v);
                  }}
                  data-testid="button-same-as-yesterday"
                >
                  Same as yesterday
                </Button>
              )}
            </div>
            <table className="mt-2 w-full text-sm">
              <thead>
                <tr className="bg-muted/50 text-xs text-muted-foreground">
                  <th className="px-2 py-1.5 text-left font-semibold">Centrifuge</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Hours run</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Since service</th>
                  <th className="px-2 py-1.5 text-left font-semibold">Service</th>
                </tr>
              </thead>
              <tbody>
                {assets.map((a) => (
                  <tr key={a.id} className="border-t">
                    <td className="px-2 py-1.5">
                      <div className="font-semibold">{a.tag}</div>
                      <div className="text-[11px] text-muted-foreground">{a.category}</div>
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      {canEdit ? (
                        <Input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          max={24}
                          step={0.5}
                          placeholder="—"
                          className="ml-auto h-8 w-20 text-right"
                          value={vals[a.id] ?? ""}
                          onChange={(e) => setVals({ ...vals, [a.id]: e.target.value })}
                          data-testid={`input-hours-${a.tag}`}
                        />
                      ) : (
                        <span className="tabular-nums">{vals[a.id] ? vals[a.id] : "—"}</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {a.hours_since_service == null ? "—" : Math.round(a.hours_since_service)}
                    </td>
                    <td className="px-2 py-1.5">
                      <ServicePill state={a.service_state} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {lastSaved
                  ? `Last saved ${stamp(lastSaved.created_at)}${lastSaved.entered_by_name ? ` by ${lastSaved.entered_by_name}` : ""}`
                  : "Nothing entered for this day yet. Leave a box blank if you don't know; enter 0 if it didn't run."}
              </span>
              <span className="flex-1" />
              {canEdit && (
                <Button
                  size="sm"
                  disabled={save.isPending || bad || !date}
                  onClick={() => save.mutate()}
                  data-testid="button-save-hours"
                >
                  {save.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} Save hours
                </Button>
              )}
            </div>
            {bad && <div className="mt-1 text-xs text-destructive">Hours must be between 0 and 24.</div>}
          </div>

          <div>
            {missing.length > 0 && (
              <div
                className="mb-2 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
                data-testid="hours-missing-alert"
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  {missing.length} day{missing.length === 1 ? "" : "s"} with no hours:{" "}
                  <b>{missing.slice(-6).map(short).join(", ")}{missing.length > 6 ? "…" : ""}</b> — enter hours or 0 for
                  each machine.
                </span>
              </div>
            )}
            <table className="w-full text-sm" data-testid="hours-last-7">
              <thead>
                <tr className="bg-muted/50 text-xs text-muted-foreground">
                  <th className="px-2 py-1.5 text-left font-semibold">Date</th>
                  {assets.map((a) => (
                    <th key={a.id} className="px-2 py-1.5 text-right font-semibold">
                      {a.tag}
                    </th>
                  ))}
                  <th className="px-2 py-1.5 text-right font-semibold">Total</th>
                </tr>
              </thead>
              <tbody>
                {days.map((d) => {
                  const any = assets.some((a) => cell(a.id, d));
                  const isMissing = missing.includes(d);
                  const tot = assets.reduce((t, a) => t + (Number(cell(a.id, d)?.hours) || 0), 0);
                  return (
                    <tr
                      key={d}
                      className={`border-t cursor-pointer hover:bg-muted/40 ${d === date ? "bg-muted/50" : ""}`}
                      onClick={() => setDate(d)}
                      data-testid={`hours-row-${d}`}
                    >
                      <td className={`px-2 py-1.5 ${isMissing ? "font-semibold text-amber-700" : ""}`}>{short(d)}</td>
                      {assets.map((a) => {
                        const e = cell(a.id, d);
                        return (
                          <td key={a.id} className={`px-2 py-1.5 text-right tabular-nums ${isMissing ? "text-amber-700" : ""}`}>
                            {e ? Number(e.hours) : "—"}
                          </td>
                        );
                      })}
                      <td className={`px-2 py-1.5 text-right tabular-nums ${isMissing ? "font-semibold text-amber-700" : ""}`}>
                        {any ? Math.round(tot * 100) / 100 : isMissing ? "missing" : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="mt-2 text-[11px] text-muted-foreground">
              Click any row to edit that day.
              {assets.length > 0 &&
                ` ${MONTHS[Number(today.slice(5, 7)) - 1]} to date: ` +
                  assets.map((a) => `${a.tag} ${Math.round(a.month_hours * 10) / 10} h`).join(" · ")}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
