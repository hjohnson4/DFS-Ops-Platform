// Job standby billing: equipment on location with no crew (no daily reports).
// Admin / area managers put a job on standby at a standby day rate; every
// standby day bills that rate until the first daily report arrives (standby
// then ends by itself the day before that report) or it's ended by hand.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Loader2, PauseCircle, PlayCircle, Trash2, Pencil } from "lucide-react";
import type { JobWithCustomer, JobStandby, JobStandbyPeriod } from "@shared/schema";

const money = (n: number | null | undefined) =>
  n == null
    ? "—"
    : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function todayCentral(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function fmtDay(d: string | null | undefined) {
  if (!d) return "—";
  return new Date(d + "T12:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function StandbyBadge({ standby }: { standby?: JobStandby | null }) {
  if (!standby?.active) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
      data-testid="badge-standby"
      title={`On standby since ${fmtDay(standby.start_date)} at ${money(standby.rate)}/day`}
    >
      <PauseCircle className="h-3 w-3" /> Standby {money(standby.rate)}/day
    </span>
  );
}

export function JobStandbyCard({
  job,
  canManage,
}: {
  job: JobWithCustomer;
  canManage: boolean;
}) {
  const { toast } = useToast();
  const sb = job.standby ?? null;
  const today = todayCentral();
  const [startOpen, setStartOpen] = useState(false);
  const [endOpen, setEndOpen] = useState(false);
  const [rate, setRate] = useState("");
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  // Edit a standby period (dates and rate = the billed standby days).
  const [editing, setEditing] = useState<JobStandbyPeriod | null>(null);
  const [eRate, setERate] = useState("");
  const [eStart, setEStart] = useState("");
  const [eEnd, setEEnd] = useState("");
  const [eOngoing, setEOngoing] = useState(false);
  const openEdit = (p: JobStandbyPeriod) => {
    setEditing(p);
    setERate(String(p.rate));
    setEStart(p.start_date);
    setEEnd(p.end_date ?? today);
    setEOngoing(!p.end_date);
  };

  const calendarBilled =
    !!job.manual_day_rate &&
    (job.manual_billing_mode === "calendar" || job.manual_billing_mode === "spud_to_latest");
  const canStart = canManage && !job.archived_at && !calendarBilled && !sb?.active;
  const hasHistory = (sb?.periods?.length ?? 0) > 0;
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: [`/api/jobs/${job.id}`] });
    queryClient.invalidateQueries({ queryKey: ["/api/jobs"] });
    queryClient.invalidateQueries({ queryKey: ["/api/revenue/summary"] });
  };
  const onErr = (e: any) =>
    toast({
      title: "Couldn't save",
      description: String(e?.message ?? e).replace(/^\d+:\s*/, "").replace(/^\{"message":"|"\}$/g, ""),
      variant: "destructive",
    });

  const start = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", `/api/jobs/${job.id}/standby`, {
        rate: Number(rate),
        start_date: startDate,
      })).json(),
    onSuccess: (r: any) => {
      setStartOpen(false);
      refresh();
      toast({
        title: r?.standby?.active ? "Job is on standby" : "Standby saved",
        description: r?.standby?.active
          ? "Standby bills every day until the next daily report comes in."
          : "A daily report already came in after that date, so standby ended the day before it.",
      });
    },
    onError: onErr,
  });
  const end = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", `/api/jobs/${job.id}/standby/end`, { end_date: endDate })).json(),
    onSuccess: () => {
      setEndOpen(false);
      refresh();
      toast({ title: "Standby ended" });
    },
    onError: onErr,
  });
  const edit = useMutation({
    mutationFn: async () =>
      (await apiRequest("PATCH", `/api/jobs/${job.id}/standby/${editing!.id}`, {
        rate: Number(eRate),
        start_date: eStart,
        end_date: eOngoing ? null : eEnd,
      })).json(),
    onSuccess: () => {
      setEditing(null);
      refresh();
      toast({ title: "Standby days updated", description: "Job revenue now uses the new standby days." });
    },
    onError: onErr,
  });
  const remove = useMutation({
    mutationFn: async (pid: string) =>
      (await apiRequest("DELETE", `/api/jobs/${job.id}/standby/${pid}`)).json(),
    onSuccess: () => {
      refresh();
      toast({ title: "Standby period removed" });
    },
    onError: onErr,
  });

  const rateNum = Number(rate);
  const rateOk = Number.isFinite(rateNum) && rateNum > 0;
  const open = sb?.periods.find((p) => !p.end_date) ?? null;
  const eRateNum = Number(eRate);
  const eRateOk = Number.isFinite(eRateNum) && eRateNum > 0;
  const eLast = eOngoing ? today : eEnd;
  const eDays =
    eStart && eLast && eStart <= eLast
      ? Math.round((new Date(eLast + "T12:00:00Z").getTime() - new Date(eStart + "T12:00:00Z").getTime()) / 86400000) + 1
      : 0;
  const otherOpen = !!sb?.periods.some((p) => !p.end_date && p.id !== editing?.id);
  const eValid = eRateOk && !!eStart && eStart <= today && (eOngoing ? !otherOpen : !!eEnd && eEnd >= eStart && eEnd <= today);
  if (!hasHistory && !canStart) return null;

  return (
    <div className="mt-3 rounded-lg border border-card-border bg-card p-4 text-sm" data-testid="job-standby">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-medium">Standby billing</div>
          <div className="text-xs text-muted-foreground">
            Equipment on location, no crew · bills the standby rate every day until daily reports start again
          </div>
        </div>
        {canManage && sb?.active ? (
          <Button size="sm" variant="outline" onClick={() => { setEndDate(today); setEndOpen(true); }} data-testid="button-end-standby">
            <PlayCircle className="h-4 w-4 mr-1" /> End standby
          </Button>
        ) : canStart ? (
          <Button size="sm" onClick={() => { setStartDate(today); setStartOpen(true); }} data-testid="button-start-standby">
            <PauseCircle className="h-4 w-4 mr-1" /> Put on standby
          </Button>
        ) : null}
      </div>

      {hasHistory && (
        <>
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <div className="text-xs text-muted-foreground">Status</div>
              <div className="text-base font-semibold" data-testid="standby-status">
                {sb?.active ? (
                  <span className="text-amber-700 dark:text-amber-400">On standby</span>
                ) : (
                  "Off"
                )}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Standby rate</div>
              <div className="text-base font-semibold tabular-nums">
                {sb?.active ? `${money(sb.rate)}/day` : "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Standby days</div>
              <div className="text-base font-semibold tabular-nums" data-testid="standby-days">{sb?.days ?? 0}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Standby billed</div>
              <div className="text-base font-semibold tabular-nums" data-testid="standby-total">{money(sb?.total)}</div>
              <div className="text-[11px] text-muted-foreground">Included in job revenue</div>
            </div>
          </div>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="text-left">
                  <th className="py-1 pr-3 font-medium">From</th>
                  <th className="py-1 pr-3 font-medium">Through</th>
                  <th className="py-1 pr-3 font-medium text-right">Rate</th>
                  <th className="py-1 pr-3 font-medium text-right">Days</th>
                  <th className="py-1 pr-3 font-medium text-right">Amount</th>
                  <th className="py-1 pr-3 font-medium hidden sm:table-cell">Ended</th>
                  {canManage && <th className="py-1" />}
                </tr>
              </thead>
              <tbody>
                {sb!.periods.map((p) => (
                  <tr key={p.id} className="border-t border-card-border" data-testid={`standby-period-${p.id}`}>
                    <td className="py-1.5 pr-3 whitespace-nowrap">{fmtDay(p.start_date)}</td>
                    <td className="py-1.5 pr-3 whitespace-nowrap">
                      {p.end_date ? fmtDay(p.end_date) : <span className="text-amber-700 dark:text-amber-400">Today (ongoing)</span>}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{money(p.rate)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{p.days}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums font-medium">{money(p.total)}</td>
                    <td className="py-1.5 pr-3 text-muted-foreground hidden sm:table-cell">
                      {!p.end_date
                        ? `Started by ${p.created_by_name ?? "—"}`
                        : p.ended_reason === "report"
                          ? "Reports started"
                          : `By ${p.ended_by_name ?? "—"}`}
                    </td>
                    {canManage && (
                      <td className="py-1.5 text-right whitespace-nowrap">
                        {!job.archived_at && (
                          <button
                            className="mr-2 text-muted-foreground hover:text-foreground"
                            title="Edit this standby period's days and rate"
                            onClick={() => openEdit(p)}
                            data-testid={`button-edit-standby-${p.id}`}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        )}
                        <button
                          className="text-muted-foreground hover:text-destructive"
                          title="Remove this standby period (entered by mistake)"
                          onClick={() => {
                            if (confirm(`Remove the standby period starting ${fmtDay(p.start_date)}? Its ${money(p.total)} comes off job revenue.`))
                              remove.mutate(p.id);
                          }}
                          data-testid={`button-remove-standby-${p.id}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit standby days</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div>
              <Label htmlFor="edit-standby-rate">Standby day rate ($/day)</Label>
              <Input
                id="edit-standby-rate"
                type="number"
                inputMode="decimal"
                min={0}
                value={eRate}
                onChange={(e) => setERate(e.target.value)}
                data-testid="input-edit-standby-rate"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="edit-standby-start">First standby day</Label>
                <Input
                  id="edit-standby-start"
                  type="date"
                  max={today}
                  value={eStart}
                  onChange={(e) => setEStart(e.target.value)}
                  data-testid="input-edit-standby-start"
                />
              </div>
              <div>
                <Label htmlFor="edit-standby-end">Last standby day</Label>
                <Input
                  id="edit-standby-end"
                  type="date"
                  min={eStart}
                  max={today}
                  value={eOngoing ? "" : eEnd}
                  disabled={eOngoing}
                  onChange={(e) => setEEnd(e.target.value)}
                  data-testid="input-edit-standby-end"
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={eOngoing}
                disabled={otherOpen}
                onChange={(e) => setEOngoing(e.target.checked)}
                data-testid="checkbox-edit-standby-ongoing"
              />
              Still on standby (bills through today)
            </label>
            <div className="rounded-md bg-muted px-3 py-2 tabular-nums" data-testid="edit-standby-preview">
              {eDays} standby day{eDays === 1 ? "" : "s"} × {money(eRateOk ? eRateNum : 0)} ={" "}
              <span className="font-semibold">{money(eDays * (eRateOk ? eRateNum : 0))}</span>
              {editing && (
                <div className="text-xs text-muted-foreground">
                  Was {editing.days} day{editing.days === 1 ? "" : "s"} · {money(editing.total)}
                </div>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Days with a daily report already bill the report's day rate, so standby has to end the day
              before the first report.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button disabled={!eValid || edit.isPending} onClick={() => edit.mutate()} data-testid="button-save-edit-standby">
              {edit.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={startOpen} onOpenChange={setStartOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Put Job {job.job_number} on standby</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div>
              <Label htmlFor="standby-rate">Standby day rate ($/day)</Label>
              <Input
                id="standby-rate"
                type="number"
                inputMode="decimal"
                min={0}
                placeholder="e.g. 850"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                data-testid="input-standby-rate"
              />
            </div>
            <div>
              <Label htmlFor="standby-start">First standby day</Label>
              <Input
                id="standby-start"
                type="date"
                max={today}
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                data-testid="input-standby-start"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Every day from this date bills the standby rate. When the next daily report comes in, standby
              turns off by itself the day before that report, and the report's day rate takes over.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStartOpen(false)}>Cancel</Button>
            <Button
              disabled={!rateOk || !startDate || start.isPending}
              onClick={() => start.mutate()}
              data-testid="button-confirm-standby"
            >
              {start.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Start standby
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={endOpen} onOpenChange={setEndOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>End standby on Job {job.job_number}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div>
              <Label htmlFor="standby-end">Last standby day</Label>
              <Input
                id="standby-end"
                type="date"
                min={open?.start_date}
                max={today}
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                data-testid="input-standby-end"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Standby bills through this day. You don't need to do this when crews start sending daily
              reports — standby ends by itself then.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEndOpen(false)}>Cancel</Button>
            <Button disabled={!endDate || end.isPending} onClick={() => end.mutate()} data-testid="button-confirm-end-standby">
              {end.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              End standby
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
