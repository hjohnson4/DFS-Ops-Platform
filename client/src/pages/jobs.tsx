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
} from "@shared/schema";
import { Button } from "@/components/ui/button";
import { JobFormDialog } from "@/components/JobFormDialog";
import { buildWellTimeline, fmtWellMoney } from "@/lib/wellTimeline";
import { Plus, Briefcase, MapPin, Activity, Archive } from "lucide-react";

const STATUS_TONE: Record<JobStatus, string> = {
  Active: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
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

  // Accrued on the current well = that well's revenue in the timeline rollup.
  const currentWellRow = timeline.currentWell
    ? timeline.wells.find((w) => w.well === timeline.currentWell)
    : undefined;
  const accruedCurrent = currentWellRow ? currentWellRow.revenue : null;

  // Job activity: latest dated report's Rig Activity section (verbatim).
  const dated = jobReports
    .filter((r) => r.report_date)
    .sort((a, b) => (a.report_date! < b.report_date! ? 1 : -1));
  const latest = dated[0];
  const activity = latest?.well_context?.rig_activity ?? null;
  const depth = latest?.well_context?.meas_depth_ft ?? null;
  const activityDate = latest?.report_date ?? null;

  return {
    hasReports: timeline.totalReportDays > 0,
    currentWell: timeline.currentWellKnown ? timeline.currentWell : null,
    accruedCurrent,
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
  const r = useJobRollup(job.id, job.day_rate ?? null, reports);

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

      {/* Day rate */}
      <td className="px-4 py-2.5 whitespace-nowrap tabular-nums" data-testid={`job-day-rate-${job.id}`}>
        {job.day_rate == null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          dayRateFmt(job.day_rate)
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

  const [view, setView] = useState<"active" | "archived">("active");
  const showingArchived = view === "archived";

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

      {/* Active / Archived view toggle */}
      <div className="mb-5 inline-flex rounded-md border border-card-border p-0.5 text-sm">
        <button
          type="button"
          onClick={() => setView("active")}
          className={`rounded px-3 py-1 font-medium transition-colors ${
            !showingArchived ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
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
      </div>

      {noCustomers && (
        <div className="mb-5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          Add a customer first — jobs must belong to one.
        </div>
      )}

      {isLoading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">Loading…</div>
      ) : jobs && jobs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-10 text-center">
          <Briefcase className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
          <div className="text-sm text-muted-foreground">
            {showingArchived ? "No archived jobs." : "No jobs yet."}
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
              {jobs?.map((j) => (
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

      <p className="mt-3 text-xs text-muted-foreground">
        “—” means no data yet: no dated daily reports for that job, or no day
        rate set (accrued can’t be computed without one).
      </p>
    </div>
  );
}
