import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import {
  type Customer,
  type JobWithCustomer,
  type JobStatus,
  type DailyReportWithLinks,
  AREAS,
} from "@shared/schema";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { JobFormDialog } from "@/components/JobFormDialog";
import { buildWellTimeline, fmtWellMoney } from "@/lib/wellTimeline";
import { ForecastView } from "@/components/ForecastView";
import { Plus, Briefcase, MapPin, Activity, Archive, CalendarRange } from "lucide-react";

const STATUS_TONE: Record<JobStatus, string> = {
  Active: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  "Rig Move": "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  "On Hold": "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  Completed: "bg-muted text-muted-foreground",
};

const dayRateFmt = (n: number | null) =>
  n == null
    ? "—"
    : `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}/day`;

const numFmt = (n: number | null | undefined) =>
  n == null ? null : n.toLocaleString("en-US", { maximumFractionDigits: 0 });

// Per-job rollup derived from this job's emailed daily reports. "Current well"
// and "Accrued" come from the report-inferred well timeline; "Job activity"
// is the Rig Activity read from the most recent report's workbook.
function useJobRollup(jobId: string, dayRate: number | null, reports?: DailyReportWithLinks[]) {
  const jobReports = (reports ?? []).filter((r) => r.job_id === jobId);
  const timeline = buildWellTimeline(jobReports, dayRate);

  // Accrued on the current well. The authoritative figure is workbook cell
  // AS57 (kpis.accrued_current_well) — a running cumulative total that grows
  // each report day — read from the MOST RECENT report for the current well.
  // We fall back to the day_rate×days timeline rollup only when no report for
  // the current well carries AS57 (e.g. reports imported before this field
  // existed), so nothing is fabricated.
  const currentWellRow = timeline.currentWell
    ? timeline.wells.find((w) => w.well === timeline.currentWell)
    : undefined;

  // Most recent report naming the current well, by submission time then date.
  const accruedFromWorkbook = (() => {
    if (!timeline.currentWell) return null;
    const wellReports = jobReports
      .filter((r) => (r.well_name ?? "").trim() === timeline.currentWell)
      .sort((a, b) => {
        const sa = String(a.created_at || a.received_at || a.report_date || "");
        const sb = String(b.created_at || b.received_at || b.report_date || "");
        if (sa !== sb) return sa < sb ? 1 : -1; // newest first
        return (b.report_day ?? 0) - (a.report_day ?? 0);
      });
    for (const r of wellReports) {
      const v = (r.kpis as any)?.accrued_current_well;
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return null;
  })();

  const accruedCurrent =
    accruedFromWorkbook != null
      ? accruedFromWorkbook
      : currentWellRow
        ? currentWellRow.revenue
        : null;

  // Job activity: latest dated report's Rig Activity section (verbatim).
  const dated = jobReports
    .filter((r) => r.report_date)
    .sort((a, b) => (a.report_date! < b.report_date! ? 1 : -1));
  const latest = dated[0];
  const activity = latest?.well_context?.rig_activity ?? null;
  const depth = latest?.well_context?.meas_depth_ft ?? null;
  const activityDate = latest?.report_date ?? null;

  // Current day rate: cell AL57 from the most recent dated report that carries
  // one (the rate can change mid-job by operation/period), else the job's
  // stored fallback rate. Reports are the source of truth for the day rate.
  const currentDayRate = (() => {
    const byDate = jobReports
      .filter((r) => r.report_date)
      .sort((a, b) => {
        if (a.report_date !== b.report_date)
          return a.report_date! < b.report_date! ? 1 : -1; // newest first
        return (b.report_day ?? 0) - (a.report_day ?? 0);
      });
    for (const r of byDate) {
      const v = (r.kpis as any)?.day_rate;
      if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    }
    return dayRate;
  })();

  return {
    hasReports: timeline.totalReportDays > 0,
    currentWell: timeline.currentWellKnown ? timeline.currentWell : null,
    accruedCurrent,
    currentDayRate,
    activity,
    depth,
    activityDate,
  };
}

function dateShort(d: string | null) {
  if (!d) return "";
  return new Date(d + "T00:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function JobRow({
  job,
  reports,
  onClick,
}: {
  job: JobWithCustomer;
  reports?: DailyReportWithLinks[];
  onClick: () => void;
}) {
  const rollup = useJobRollup(job.id, job.day_rate ?? null, reports);
  // Set day rate jobs (e.g. Verdun): the job's own rate, billed every Active
  // day — not read from the daily report.
  const mb = job.manual_day_rate ? job.manual_billing : null;
  const r = job.manual_day_rate
    ? {
        ...rollup,
        currentDayRate: job.day_rate == null ? null : Number(job.day_rate),
        accruedCurrent: mb ? mb.current_well_revenue : null,
      }
    : rollup;

  return (
    <tr
      onClick={onClick}
      className="border-t border-card-border cursor-pointer hover:bg-muted/40"
      data-testid={`row-job-${job.id}`}
    >
      <td className="px-4 py-2.5 font-medium whitespace-nowrap">{job.job_number}</td>
      <td className="px-4 py-2.5">{job.customer_name}</td>
      <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap">{job.area}</td>
      <td className="px-4 py-2.5">
        <span className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_TONE[job.status]}`}>
          {job.status}
        </span>
      </td>

      {/* Current well (inferred from daily reports) */}
      <td className="px-4 py-2.5" data-testid={`job-current-well-${job.id}`}>
        {r.currentWell ? (
          <span className="inline-flex items-center gap-1">
            <MapPin className="h-3.5 w-3.5 text-primary shrink-0" />
            {r.currentWell}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>

      {/* Day rate — current AL57 rate from the latest daily report, else the
          job's stored fallback rate. */}
      <td className="px-4 py-2.5 whitespace-nowrap tabular-nums" data-testid={`job-day-rate-${job.id}`}>
        {r.currentDayRate == null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className="inline-flex flex-col leading-tight">
            {dayRateFmt(r.currentDayRate)}
            {job.manual_day_rate && (
              <span className="text-xs text-muted-foreground" data-testid={`job-set-rate-${job.id}`}>
                {job.status === "Active" ? "Set rate" : `Set rate · $0 on ${job.status}`}
              </span>
            )}
          </span>
        )}
      </td>

      {/* Accrued on current pad/well */}
      <td className="px-4 py-2.5 whitespace-nowrap tabular-nums" data-testid={`job-accrued-${job.id}`}>
        {r.accruedCurrent == null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className="font-medium text-primary">{fmtWellMoney(r.accruedCurrent)}</span>
        )}
      </td>

      {/* Job activity — Rig Activity from the emailed daily report */}
      <td className="px-4 py-2.5" data-testid={`job-activity-${job.id}`}>
        {r.activity ? (
          <span className="inline-flex flex-col leading-tight">
            <span className="inline-flex items-center gap-1 font-medium">
              <Activity className="h-3.5 w-3.5 text-primary shrink-0" />
              {r.activity}
            </span>
            <span className="text-xs text-muted-foreground">
              {r.depth != null && `${numFmt(r.depth)} ft`}
              {r.depth != null && r.activityDate && " · "}
              {r.activityDate && dateShort(r.activityDate)}
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
    </tr>
  );
}

export default function JobsPage() {
  const { profile } = useAuth();
  const [, navigate] = useLocation();
  const canManage =
    profile?.role === "admin" || profile?.role === "area" || profile?.role === "super";

  const [view, setViewState] = useState<"active" | "archived" | "forecast">(() => {
    try {
      const v = sessionStorage.getItem("jobs-view");
      return v === "archived" || v === "forecast" ? v : "active";
    } catch {
      return "active";
    }
  });
  const setView = (v: "active" | "archived" | "forecast") => {
    setViewState(v);
    try {
      sessionStorage.setItem("jobs-view", v);
    } catch {}
  };
  const canForecast = canManage; // admin, area manager, supervisor (view-only)
  const showingForecast = view === "forecast" && canForecast;
  const showingArchived = view === "archived";

  // Admins see every area, so they get an area filter. Other roles are
  // already limited to their own area by the server. The choice is kept for
  // the browser session so it survives opening a job and coming back.
  const isAdmin = profile?.role === "admin";
  const [areaFilter, setAreaFilterState] = useState<string>(() => {
    try {
      return sessionStorage.getItem("jobs-area-filter") || "all";
    } catch {
      return "all";
    }
  });
  const setAreaFilter = (v: string) => {
    setAreaFilterState(v);
    try {
      sessionStorage.setItem("jobs-area-filter", v);
    } catch {}
  };

  const { data: jobs, isLoading } = useQuery<JobWithCustomer[]>({
    queryKey: showingArchived ? ["/api/jobs", "archived"] : ["/api/jobs"],
    queryFn: async () => {
      const url = showingArchived ? "/api/jobs?archived=true" : "/api/jobs";
      const res = await apiRequest("GET", url);
      return res.json();
    },
  });
  const { data: customers } = useQuery<Customer[]>({ queryKey: ["/api/customers"] });
  const { data: reports } = useQuery<DailyReportWithLinks[]>({
    queryKey: ["/api/daily-reports"],
  });
  const noCustomers = customers && customers.length === 0;
  const activeArea = isAdmin ? areaFilter : "all";
  const visibleJobs =
    activeArea === "all"
      ? jobs
      : (jobs ?? []).filter((j) => j.area === activeArea);
  const areaCount = (a: string) => (jobs ?? []).filter((j) => j.area === a).length;

  return (
    <div className="p-6 max-w-7xl">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-semibold">Field Ops &amp; Jobs</h1>
        {canManage && (
          <JobFormDialog
            trigger={
              <Button data-testid="button-add-job" disabled={noCustomers}>
                <Plus className="mr-2 h-4 w-4" /> New job
              </Button>
            }
          />
        )}
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        A job is identified by its number and operating area, and belongs to a
        customer. Current well and accrued amount are inferred from the emailed
        daily reports; job activity is the Rig Activity from the latest report.
      </p>

      <div className="mb-5 flex flex-wrap items-center gap-3">
      {/* Active / Archived view toggle */}
      <div className="inline-flex rounded-md border border-card-border p-0.5 text-sm">
        <button
          type="button"
          onClick={() => setView("active")}
          className={`rounded px-3 py-1 font-medium transition-colors ${
            !showingArchived && !showingForecast ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
          data-testid="tab-jobs-active"
        >
          Active
        </button>
        <button
          type="button"
          onClick={() => setView("archived")}
          className={`inline-flex items-center gap-1.5 rounded px-3 py-1 font-medium transition-colors ${
            showingArchived ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
          data-testid="tab-jobs-archived"
        >
          <Archive className="h-3.5 w-3.5" /> Archived
        </button>
        {canForecast && (
          <button
            type="button"
            onClick={() => setView("forecast")}
            className={`inline-flex items-center gap-1.5 rounded px-3 py-1 font-medium transition-colors ${
              showingForecast ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
            data-testid="tab-jobs-forecast"
          >
            <CalendarRange className="h-3.5 w-3.5" /> Forecast
          </button>
        )}
      </div>
      {isAdmin && (
        <Select value={areaFilter} onValueChange={setAreaFilter}>
          <SelectTrigger className="h-9 w-[210px]" data-testid="select-jobs-area">
            <MapPin className="h-3.5 w-3.5 mr-1.5 text-muted-foreground" />
            <SelectValue placeholder="All areas" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All areas ({(jobs ?? []).length})</SelectItem>
            {AREAS.map((a) => (
              <SelectItem key={a} value={a}>
                {a} ({areaCount(a)})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      </div>

      {noCustomers && (
        <div className="mb-5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          Add a customer first — jobs must belong to one.
        </div>
      )}

      {showingForecast ? (
        <ForecastView area={activeArea} />
      ) : isLoading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">Loading…</div>
      ) : visibleJobs && visibleJobs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-10 text-center">
          <Briefcase className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
          <div className="text-sm text-muted-foreground">
            {activeArea !== "all"
              ? `No ${showingArchived ? "archived " : ""}jobs in ${activeArea}.`
              : showingArchived
                ? "No archived jobs."
                : "No jobs yet."}
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-card-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr className="text-left">
                <th className="px-4 py-2.5 font-medium">Job #</th>
                <th className="px-4 py-2.5 font-medium">Customer</th>
                <th className="px-4 py-2.5 font-medium">Area</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Current well</th>
                <th className="px-4 py-2.5 font-medium">Day rate</th>
                <th className="px-4 py-2.5 font-medium">Accrued (current well)</th>
                <th className="px-4 py-2.5 font-medium">Job activity</th>
              </tr>
            </thead>
            <tbody>
              {visibleJobs?.map((j) => (
                <JobRow
                  key={j.id}
                  job={j}
                  reports={reports}
                  onClick={() => navigate(`/jobs/${j.id}`)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!showingForecast && <p className="mt-3 text-xs text-muted-foreground">
        “—” means no data yet: no dated daily reports for that job, or no day
        rate set (accrued can’t be computed without one).
      </p>}
    </div>
  );
}
