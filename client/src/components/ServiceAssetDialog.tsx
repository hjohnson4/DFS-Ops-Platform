import { Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ServiceAssetDetail, ServiceState } from "@shared/schema";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ClipboardCheck, Gauge, Loader2 } from "lucide-react";
import { parseDisplayDate } from "@/lib/utils";

function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  const dt = parseDisplayDate(d);
  if (isNaN(dt.getTime())) return "—";
  return dt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
const fmtHrs = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: 1 });

const STATE_CLS: Record<ServiceState, string> = {
  Overdue: "bg-red-500/15 text-red-700 dark:text-red-400",
  Soon: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  OK: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  "No baseline": "bg-muted text-muted-foreground",
  "Not tracked": "bg-muted text-muted-foreground",
};
const STATE_LABEL: Record<ServiceState, string> = {
  Overdue: "Overdue",
  Soon: "Service soon",
  OK: "OK",
  "No baseline": "No baseline",
  "Not tracked": "Not tracked",
};

// Service module pop-up for one centrifuge: hours since service against the
// 150-hour interval, its service history (date, supervisor, open the report)
// and run hours totalled per job and per well.
export function ServiceAssetDialog({
  assetId,
  onClose,
  onOpenReport,
}: {
  assetId: string | null;
  onClose: () => void;
  onOpenReport: (reportId: string) => void;
}) {
  const { data, isLoading, error } = useQuery<ServiceAssetDetail>({
    queryKey: [`/api/service/assets/${assetId}`],
    enabled: !!assetId,
    staleTime: 0,
  });

  const pct =
    data?.hours_since_service != null
      ? Math.min(100, (data.hours_since_service / data.service_interval_hours) * 100)
      : 0;
  const barCls =
    data?.service_state === "Overdue"
      ? "bg-red-500"
      : data?.service_state === "Soon"
        ? "bg-amber-500"
        : "bg-emerald-500";

  return (
    <Dialog open={!!assetId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Gauge className="h-5 w-5" />
            {data ? data.tag : "Centrifuge"}
            {data && (
              <span
                className={`ml-1 inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${STATE_CLS[data.service_state]}`}
                data-testid="asset-service-state"
              >
                {STATE_LABEL[data.service_state]}
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            {data
              ? `${data.category} · ${data.area} · ${
                  data.job_number ? `on ${data.job_number}` : "unassigned"
                }`
              : "Service history and run hours"}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : error || !data ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            Could not load this centrifuge.
          </div>
        ) : (
          <div className="space-y-6">
            {!data.ledger_ready && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300">
                The run-hours log isn’t set up yet, so job and well totals can’t
                be shown. Hours since service are estimated from the asset’s
                meter until the setup SQL is run.
              </div>
            )}

            {/* Summary */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="rounded-lg border border-card-border p-3 col-span-2">
                <div className="text-xs text-muted-foreground mb-1">
                  Hours since service
                </div>
                <div className="text-xl font-semibold tabular-nums" data-testid="asset-hours-since-service">
                  {fmtHrs(data.hours_since_service)}
                  <span className="text-sm font-normal text-muted-foreground">
                    {" "}
                    / {data.service_interval_hours} hrs
                  </span>
                </div>
                <div className="mt-2 h-1.5 w-full rounded bg-muted overflow-hidden">
                  <div className={`h-full ${barCls}`} style={{ width: `${pct}%` }} />
                </div>
                <div className="text-[11px] text-muted-foreground mt-1.5">
                  {data.never_serviced
                    ? "No service report on file — counting all logged run hours."
                    : data.hours_since_service != null &&
                        data.hours_since_service < data.service_interval_hours
                      ? `${fmtHrs(
                          data.service_interval_hours - data.hours_since_service,
                        )} hrs left before service is due`
                      : "Service is due now"}
                </div>
              </div>
              <div className="rounded-lg border border-card-border p-3">
                <div className="text-xs text-muted-foreground mb-1">Last service</div>
                <div className="text-sm font-medium">{fmtDate(data.last_service_date)}</div>
                <div className="text-xs text-muted-foreground">
                  {data.last_service_supervisor ?? "—"}
                </div>
              </div>
              <div className="rounded-lg border border-card-border p-3">
                <div className="text-xs text-muted-foreground mb-1">Hours on this job</div>
                <div className="text-sm font-medium tabular-nums">
                  {data.current_job_hours == null ? "—" : `${fmtHrs(data.current_job_hours)} hrs`}
                </div>
                <div className="text-xs text-muted-foreground">
                  {fmtHrs(data.total_logged_hours)} hrs logged in total
                </div>
              </div>
            </div>

            {/* Service history */}
            <div>
              <h3 className="text-sm font-semibold mb-2">Service history</h3>
              {data.history.length === 0 ? (
                <div className="rounded-md border border-dashed border-card-border p-4 text-center text-xs text-muted-foreground">
                  No service reports filed for this centrifuge yet.
                </div>
              ) : (
                <div className="rounded-lg border border-card-border overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-card-border bg-muted/40 text-left text-xs text-muted-foreground">
                        <th className="px-3 py-2 font-medium">Date</th>
                        <th className="px-3 py-2 font-medium">Supervisor</th>
                        <th className="px-3 py-2 font-medium">Score</th>
                        <th className="px-3 py-2 font-medium">Status</th>
                        <th className="px-3 py-2 font-medium text-right"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.history.map((h) => (
                        <tr
                          key={h.id}
                          className="border-b border-card-border last:border-0"
                          data-testid={`row-asset-service-${h.id}`}
                        >
                          <td className="px-3 py-2 whitespace-nowrap">{fmtDate(h.report_date)}</td>
                          <td className="px-3 py-2">{h.supervisor_name ?? "—"}</td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            {h.score_total ? `${h.score_pass ?? 0}/${h.score_total}` : "—"}
                            {h.flagged_count ? (
                              <span className="ml-1.5 text-xs text-red-600 dark:text-red-400">
                                {h.flagged_count} flagged
                              </span>
                            ) : null}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap text-xs">{h.status}</td>
                          <td className="px-3 py-2 text-right">
                            {h.has_form ? (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => onOpenReport(h.id)}
                                data-testid={`button-open-service-${h.id}`}
                              >
                                <ClipboardCheck className="mr-1.5 h-3.5 w-3.5" />
                                Open report
                              </Button>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Run hours by job and well */}
            <div>
              <h3 className="text-sm font-semibold mb-2">Run hours by job and well</h3>
              {!data.ledger_ready ? (
                <div className="text-xs text-muted-foreground">—</div>
              ) : data.jobs.length === 0 ? (
                <div className="rounded-md border border-dashed border-card-border p-4 text-center text-xs text-muted-foreground">
                  No run hours logged from signed-off daily reports yet.
                </div>
              ) : (
                <div className="rounded-lg border border-card-border overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-card-border bg-muted/40 text-left text-xs text-muted-foreground">
                        <th className="px-3 py-2 font-medium">Job / Well</th>
                        <th className="px-3 py-2 font-medium">Dates</th>
                        <th className="px-3 py-2 font-medium text-right">Report days</th>
                        <th className="px-3 py-2 font-medium text-right">Run hours</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.jobs.map((j) => (
                        <Fragment key={`job-${j.job_id ?? "none"}`}>
                          <tr
                            className="border-b border-card-border bg-muted/20"
                            data-testid={`row-job-hours-${j.job_number ?? "none"}`}
                          >
                            <td className="px-3 py-2 font-medium" colSpan={2}>
                              {j.job_number ?? "No job"}
                              {j.is_current && (
                                <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                                  Current job
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">{j.report_days}</td>
                            <td className="px-3 py-2 text-right tabular-nums font-semibold">
                              {fmtHrs(j.hours)}
                            </td>
                          </tr>
                          {j.wells.map((w) => (
                            <tr
                              key={`well-${j.job_id ?? "none"}-${w.well_name}`}
                              className="border-b border-card-border last:border-0"
                            >
                              <td className="px-3 py-2 pl-7 text-muted-foreground">{w.well_name}</td>
                              <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                                {fmtDate(w.first_date)}
                                {w.last_date && w.last_date !== w.first_date
                                  ? ` – ${fmtDate(w.last_date)}`
                                  : ""}
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums">{w.report_days}</td>
                              <td className="px-3 py-2 text-right tabular-nums">{fmtHrs(w.hours)}</td>
                            </tr>
                          ))}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
