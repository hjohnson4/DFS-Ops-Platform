import { useAuth } from "@/lib/auth";
import { ROLE_LABELS, AREAS, tracksRunHours } from "@shared/schema";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type {
  Asset,
  JobWithCustomer,
  DailyReportWithLinks,
  Profile,
  Area,
} from "@shared/schema";
import { Link } from "wouter";
import {
  Boxes,
  ClipboardList,
  CheckCircle2,
  Clock,
  Gauge,
  Briefcase,
  DollarSign,
  Activity,
  FileText,
  Ruler,
  HardHat,
  ArrowUpRight,
  AlertTriangle,
  Wrench,
  TrendingUp,
  ChevronRight,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import LockedKpiTable from "@/components/LockedKpiTable";
import { buildWellTimeline, fmtWellMoney } from "@/lib/wellTimeline";

function Stat({
  icon: Icon,
  label,
  value,
  sub,
  accent,
  href,
  testid,
}: {
  icon: any;
  label: string;
  value: string | number;
  sub?: string;
  accent?: boolean;
  href?: string;
  testid?: string;
}) {
  const body = (
    <div
      className={
        "rounded-lg border bg-card p-4 h-full transition-colors " +
        (accent
          ? "border-primary/40 ring-1 ring-primary/10"
          : "border-card-border") +
        (href ? " hover:border-primary/50 hover:bg-accent/40 cursor-pointer" : "")
      }
      data-testid={testid}
    >
      <div className="flex items-center justify-between gap-2 text-muted-foreground text-sm mb-1.5">
        <span className="flex items-center gap-2">
          <Icon className={"h-4 w-4 " + (accent ? "text-primary" : "")} />
          {label}
        </span>
        {href && <ChevronRight className="h-3.5 w-3.5 opacity-50" />}
      </div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
    </div>
  );
  return href ? (
    <Link href={href} className="block h-full">
      {body}
    </Link>
  ) : (
    body
  );
}

const usd0 = (n: number) =>
  n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  const dt = new Date(String(d).slice(0, 10) + "T00:00:00");
  return isNaN(dt.getTime()) ? String(d) : dt.toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Field-tech dashboard. Field techs are scoped to their assigned job(s), so
// their dashboard is job-centric: the latest daily report, current rig
// activity, the locked KPIs from that report, the equipment on the job, and
// the accrued cost on the well the crew is currently on.
// ---------------------------------------------------------------------------
function FieldTechDashboard({ profile }: { profile: Profile }) {
  const { data: jobs } = useQuery<JobWithCustomer[]>({
    queryKey: ["/api/jobs"],
  });
  const { data: assets } = useQuery<Asset[]>({ queryKey: ["/api/assets"] });
  const { data: reports } = useQuery<DailyReportWithLinks[]>({
    queryKey: ["/api/daily-reports"],
  });

  // A scoped field tech sees only their assigned job(s). Use the first active
  // job (or first job) as the "current" job for the header.
  const jobList = jobs || [];
  const currentJob =
    jobList.find((j) => j.status === "Active") || jobList[0] || null;

  // Daily reports for the current job, newest first (server already scopes
  // these to the tech's assigned job).
  const jobReports = (reports || [])
    .filter((r) => !currentJob || r.job_id === currentJob.id)
    .slice()
    .sort((a, b) => {
      const ad = String(a.report_date || a.received_at || "");
      const bd = String(b.report_date || b.received_at || "");
      if (ad !== bd) return ad < bd ? 1 : -1;
      return (b.report_day ?? 0) - (a.report_day ?? 0);
    });
  const latest = jobReports[0] || null;

  // Report number: prefer the field per-job sequence, fall back to the
  // emailed "Report Day N" number.
  const latestNo =
    latest?.report_number ?? latest?.report_day ?? null;

  // Rig activity from the latest emailed report's well header.
  const wc = latest?.well_context || {};
  const rigActivity = wc.rig_activity ?? null;
  const measDepth = wc.meas_depth_ft ?? null;
  const supervisor = wc.supervisor ?? wc.company_man ?? null;
  const rig = wc.rig ?? null;

  // Cost per current well up to date. The authoritative figure is workbook
  // cell AS57 (kpis.accrued_current_well) — a running cumulative total read
  // from the MOST RECENT report for the current well — same as the accrued
  // amount shown in the Field Ops / Jobs module. We fall back to the
  // day_rate×days timeline rollup only when no report for the current well
  // carries AS57 (e.g. reports imported before that field existed), so nothing
  // is fabricated.
  const timeline = buildWellTimeline(jobReports, currentJob?.day_rate ?? null);
  const currentWell = timeline.currentWell;
  const currentWellTotal =
    currentWell != null
      ? timeline.wells.find((w) => w.well === currentWell) || null
      : null;
  const currentWellDays = currentWellTotal?.reportDays ?? 0;

  // Most recent report naming the current well, by submission time then date.
  const accruedFromWorkbook = (() => {
    if (!currentWell) return null;
    const wellReports = jobReports
      .filter((r) => (r.well_name ?? "").trim() === currentWell)
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

  const currentWellCost =
    accruedFromWorkbook != null
      ? accruedFromWorkbook
      : currentWellTotal?.revenue ?? null;

  // Assets on the job.
  const jobAssets = (assets || []).filter(
    (a) => !currentJob || a.job_id === currentJob.id,
  );

  const pending = jobReports.filter((r) => r.status !== "Signed off").length;

  return (
    <div className="p-4 md:p-6 max-w-5xl">
      <h1 className="text-xl font-semibold mb-1">
        Welcome, {profile?.name.split(" ")[0]}
      </h1>
      <p className="text-sm text-muted-foreground mb-6">
        {ROLE_LABELS[profile.role]}
        {profile?.area ? ` · ${profile.area}` : ""}
        {currentJob ? (
          <>
            {" · "}
            <Link
              href={`/jobs/${currentJob.id}`}
              className="text-primary hover:underline font-medium"
              data-testid="link-current-job"
            >
              {currentJob.job_number}
            </Link>
            {currentJob.customer_name ? ` · ${currentJob.customer_name}` : ""}
          </>
        ) : null}
      </p>

      {!currentJob ? (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
          You have no active job assignment yet. Once an administrator assigns
          you to a job, its latest report, rig activity, KPIs, and equipment
          will appear here.
        </div>
      ) : (
        <>
          {/* Headline job metrics */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
            <Stat
              icon={FileText}
              label="Latest daily report"
              value={latestNo != null ? `#${latestNo}` : "—"}
              sub={
                latest
                  ? fmtDate(latest.report_date || latest.received_at)
                  : "No reports yet"
              }
            />
            <Stat
              icon={Activity}
              label="Rig activity"
              value={rigActivity || "—"}
              sub={
                measDepth != null
                  ? `${measDepth.toLocaleString("en-US")} ft MD`
                  : rig
                    ? `Rig ${rig}`
                    : latest
                      ? "Not reported"
                      : undefined
              }
            />
            <Stat
              icon={DollarSign}
              label="Cost · current well"
              value={fmtWellMoney(currentWellCost)}
              sub={
                currentWell
                  ? `${currentWell} · ${currentWellDays} report day${currentWellDays === 1 ? "" : "s"}`
                  : currentJob.day_rate == null
                    ? "No day rate set"
                    : "No reports yet"
              }
            />
            <Stat
              icon={Boxes}
              label="Assets on job"
              value={assets ? jobAssets.length : "—"}
              sub={pending > 0 ? `${pending} report${pending === 1 ? "" : "s"} pending sign-off` : undefined}
            />
          </div>

          {/* Rig activity detail (from the latest emailed report header) */}
          <div className="mt-3 rounded-lg border border-card-border bg-card p-4">
            <div className="flex items-center gap-2 text-muted-foreground text-sm mb-3">
              <HardHat className="h-4 w-4" />
              Rig activity
              {latest && (
                <span className="text-xs">
                  · from report{latestNo != null ? ` #${latestNo}` : ""} (
                  {fmtDate(latest.report_date || latest.received_at)})
                </span>
              )}
            </div>
            {latest ? (
              <dl className="grid sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-2 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-muted-foreground">Activity</dt>
                  <dd className="font-medium">{rigActivity || "—"}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-muted-foreground flex items-center gap-1">
                    <Ruler className="h-3.5 w-3.5" /> Measured depth
                  </dt>
                  <dd className="font-medium tabular-nums">
                    {measDepth != null
                      ? `${measDepth.toLocaleString("en-US")} ft`
                      : "—"}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-muted-foreground">Day supervisor</dt>
                  <dd className="font-medium">{supervisor || "—"}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-muted-foreground">Current well</dt>
                  <dd className="font-medium">{currentWell || "—"}</dd>
                </div>
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">
                No daily reports for this job yet. Rig activity is read from the
                latest emailed daily report.
              </p>
            )}
          </div>

          {/* KPIs from the latest report */}
          <div className="mt-3">
            {latest && latest.source === "email" ? (
              <LockedKpiTable
                kpis={latest.kpis}
                cellMap={latest.kpi_cell_map}
                sourceSheet={latest.source_sheet}
                attachmentName={latest.attachment_name}
              />
            ) : (
              <div className="rounded-lg border border-card-border bg-card p-4 text-sm text-muted-foreground">
                {latest
                  ? "The latest report for this job was entered in the field and carries no locked KPIs. KPIs are read from the emailed Excel daily report."
                  : "No KPIs yet — they populate from the emailed Excel daily report once one arrives for this job."}
              </div>
            )}
          </div>

          {/* Assets on the job */}
          <div className="mt-3 rounded-lg border border-card-border bg-card overflow-hidden">
            <div className="flex items-center justify-between gap-2 border-b border-card-border px-4 py-2.5">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Boxes className="h-4 w-4 text-primary" />
                Assets on {currentJob.job_number}
              </div>
              <Link
                href="/assets"
                className="text-xs text-primary hover:underline inline-flex items-center gap-0.5"
                data-testid="link-all-assets"
              >
                View all <ArrowUpRight className="h-3 w-3" />
              </Link>
            </div>
            {!assets ? (
              <div className="px-4 py-4 text-sm text-muted-foreground">
                Loading assets…
              </div>
            ) : jobAssets.length === 0 ? (
              <div className="px-4 py-4 text-sm text-muted-foreground">
                No equipment is currently assigned to this job.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Tag</th>
                    <th className="px-4 py-2 font-medium">Category</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-card-border">
                  {jobAssets.map((a) => (
                    <tr key={a.id} data-testid={`row-asset-${a.id}`}>
                      <td className="px-4 py-2 font-medium">{a.tag}</td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {a.category}
                      </td>
                      <td className="px-4 py-2">{a.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <p className="text-sm text-muted-foreground mt-6">
            This view is scoped to your assigned job. Report number, rig
            activity, and KPIs come from the latest daily report; cost on the
            current well is the cumulative accrued amount (cell AS57) from the
            most recent daily report for that well — the same figure shown in
            Field Ops / Jobs. If a well's reports predate that field, it falls
            back to the job's day rate times report days.
          </p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Manager dashboard (admin / area / super) — fleet, jobs, and revenue rollups.
// Refined: area filter (admin), actionable alerts, a report-volume trend, and
// drill-down KPI cards. Area/super managers are already server-scoped to their
// area; admins get a client-side area filter that recomputes every rollup.
// ---------------------------------------------------------------------------

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Format yyyy-mm-dd without Date() (which parses as UTC and can shift a day).
function shortDay(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (!m) return d;
  return `${MONTHS_SHORT[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`;
}

function ManagerDashboard({ profile }: { profile: Profile }) {
  const { data: assets } = useQuery<Asset[]>({ queryKey: ["/api/assets"] });
  const { data: reports } = useQuery<any[]>({ queryKey: ["/api/reports"] });
  const { data: jobs } = useQuery<JobWithCustomer[]>({
    queryKey: ["/api/jobs"],
  });
  const { data: dailyReports } = useQuery<DailyReportWithLinks[]>({
    queryKey: ["/api/daily-reports"],
  });

  // Admins can pivot the whole dashboard to a single area; area/super managers
  // are already scoped server-side, so the filter only shows for admins.
  const isAdmin = profile.role === "admin";
  const [areaFilter, setAreaFilter] = useState<"all" | Area>("all");
  const activeArea: "all" | Area = isAdmin ? areaFilter : "all";

  const inArea = <T extends { area?: Area | null }>(rows: T[] | undefined) =>
    (rows || []).filter(
      (r) => activeArea === "all" || r.area === activeArea,
    );

  const jobsScoped = inArea(jobs);
  const assetsScoped = inArea(assets);
  const reportsScoped = inArea(reports);
  const dailyScoped = inArea(dailyReports);

  const jobsLoaded = !!jobs;

  // Effective day rate for a job: cell AL57 from the most recent dated daily
  // report that carries one (the rate can change mid-job by operation/period),
  // else the job's stored fallback rate. Daily reports are the source of truth,
  // so the dashboard's revenue tracks incoming reports — mirroring the logic
  // the Jobs page uses (useJobRollup.currentDayRate) so the two never disagree.
  const effectiveDayRate = (jobId: string, fallback: any): number | null => {
    const jobReports = (dailyReports ?? [])
      .filter((r) => r.job_id === jobId && r.report_date)
      .sort((a, b) => {
        if (a.report_date !== b.report_date)
          return a.report_date! < b.report_date! ? 1 : -1; // newest first
        return (b.report_day ?? 0) - (a.report_day ?? 0);
      });
    for (const r of jobReports) {
      const v = (r.kpis as any)?.day_rate;
      if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    }
    if (fallback === null || fallback === undefined) return null;
    const n = Number(fallback);
    return Number.isFinite(n) ? n : null;
  };

  // ---- Headline rollups ---------------------------------------------------
  const activeList = jobsScoped.filter((j) => j.status === "Active");
  const activeJobs = activeList.length;

  const activeRates = activeList.map((j) => ({
    job: j,
    rate: effectiveDayRate(j.id, j.day_rate),
  }));
  const ratedActive = activeRates.filter((x) => x.rate !== null);
  const dailyRevenue = ratedActive.reduce(
    (sum, x) => sum + (x.rate as number),
    0,
  );
  const missingRates = activeJobs - ratedActive.length;

  const totalAssets = assetsScoped.length;
  // Fleet utilization is a CENTRIFUGE metric: only Big Bowl / Small Bowl
  // centrifuges count, and a centrifuge is "deployed" only when it is actually
  // assigned to a job (job_id set) — not merely staged in an area by status.
  const centrifuges = assetsScoped.filter((a) => tracksRunHours(a.category));
  const totalCentrifuges = centrifuges.length;
  const deployed = centrifuges.filter((a) => !!a.job_id).length;
  const utilization =
    totalCentrifuges > 0
      ? Math.round((deployed / totalCentrifuges) * 100)
      : null;

  // Whole-fleet idle count (any asset not assigned to a job) — powers the
  // "Assets" card and the idle-assets alert, independent of the centrifuge-only
  // utilization metric above.
  const idleAssets = assetsScoped.filter((a) => !a.job_id).length;

  const pending = reportsScoped.filter(
    (r) => r.status === "Pending Sign-off",
  ).length;
  const signed = reportsScoped.filter((r) => r.status === "Signed off").length;

  // Daily reports awaiting review (field-submitted daily reports, not service).
  const dailyPending = dailyScoped.filter(
    (r) => r.status !== "Signed off",
  ).length;

  // ---- Per-area revenue breakdown ----------------------------------------
  const breakdownAreas =
    activeArea === "all" ? AREAS : (AREAS.filter((a) => a === activeArea) as Area[]);
  const areaBreakdown = breakdownAreas
    .map((area) => {
      const inA = activeList.filter((j) => j.area === area);
      const inARates = inA.map((j) => effectiveDayRate(j.id, j.day_rate));
      const rated = inARates.filter((r) => r !== null) as number[];
      const revenue = rated.reduce((sum, r) => sum + r, 0);
      return {
        area,
        activeJobs: inA.length,
        revenue,
        missing: inA.length - rated.length,
      };
    })
    .filter((a) => a.activeJobs > 0);

  // ---- Report-volume trend (last 14 days) ---------------------------------
  const trend = useMemo(() => {
    const days: { key: string; date: string; count: number }[] = [];
    const today = new Date();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      days.push({ key, date: shortDay(key), count: 0 });
    }
    const index = new Map(days.map((d) => [d.key, d]));
    for (const r of dailyScoped) {
      const key = String(r.report_date || r.received_at || "").slice(0, 10);
      const bucket = index.get(key);
      if (bucket) bucket.count += 1;
    }
    return days;
  }, [dailyScoped]);
  const trendTotal = trend.reduce((s, d) => s + d.count, 0);

  // ---- Actionable alerts --------------------------------------------------
  const alerts: {
    key: string;
    icon: any;
    text: string;
    href: string;
    tone: "warn" | "info";
  }[] = [];
  if (dailyPending > 0)
    alerts.push({
      key: "daily-pending",
      icon: Clock,
      text: `${dailyPending} daily report${dailyPending > 1 ? "s" : ""} awaiting sign-off`,
      href: "/daily-reports",
      tone: "warn",
    });
  if (pending > 0)
    alerts.push({
      key: "service-pending",
      icon: Wrench,
      text: `${pending} service report${pending > 1 ? "s" : ""} pending review`,
      href: "/service",
      tone: "warn",
    });
  if (missingRates > 0)
    alerts.push({
      key: "missing-rates",
      icon: DollarSign,
      text: `${missingRates} active job${missingRates > 1 ? "s" : ""} missing a day rate`,
      href: "/jobs",
      tone: "warn",
    });
  if (jobsLoaded && assets && idleAssets > 0)
    alerts.push({
      key: "idle-assets",
      icon: Boxes,
      text: `${idleAssets} asset${idleAssets > 1 ? "s" : ""} idle (not on a job)`,
      href: "/assets",
      tone: "info",
    });

  const areaLabel =
    activeArea === "all" ? "All areas" : (activeArea as string);

  return (
    <div className="p-4 md:p-6 max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
        <div>
          <h1 className="text-xl font-semibold mb-1">
            Welcome, {profile?.name.split(" ")[0]}
          </h1>
          <p className="text-sm text-muted-foreground">
            {ROLE_LABELS[profile!.role]}
            {profile?.area ? ` · ${profile.area}` : ` · ${areaLabel}`}
          </p>
        </div>
        {isAdmin && (
          <Select
            value={activeArea}
            onValueChange={(v) => setAreaFilter(v as "all" | Area)}
          >
            <SelectTrigger
              className="h-9 w-[190px] text-sm"
              data-testid="select-area-filter"
            >
              <SelectValue placeholder="All areas" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All areas</SelectItem>
              {AREAS.map((a) => (
                <SelectItem key={a} value={a}>
                  {a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Actionable alerts */}
      {alerts.length > 0 && (
        <div className="mb-4 grid gap-2 sm:grid-cols-2">
          {alerts.map((a) => (
            <Link
              key={a.key}
              href={a.href}
              data-testid={`alert-${a.key}`}
              className={
                "group flex items-center justify-between gap-3 rounded-lg border px-3.5 py-2.5 text-sm transition-colors " +
                (a.tone === "warn"
                  ? "border-amber-500/40 bg-amber-500/5 hover:bg-amber-500/10"
                  : "border-card-border bg-card hover:bg-accent/40")
              }
            >
              <span className="flex items-center gap-2">
                <a.icon
                  className={
                    "h-4 w-4 " +
                    (a.tone === "warn"
                      ? "text-amber-600 dark:text-amber-500"
                      : "text-muted-foreground")
                  }
                />
                <span className="font-medium">{a.text}</span>
              </span>
              <ChevronRight className="h-4 w-4 opacity-40 group-hover:opacity-70" />
            </Link>
          ))}
        </div>
      )}

      {/* Headline operational metrics */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-3">
        <Stat
          icon={Gauge}
          label="Fleet utilization"
          value={utilization === null ? "—" : `${utilization}%`}
          sub={
            totalCentrifuges > 0
              ? `${deployed} of ${totalCentrifuges} centrifuges on jobs`
              : "No centrifuges on file yet"
          }
          href="/assets"
          testid="stat-utilization"
        />
        <Stat
          icon={Briefcase}
          label="Active jobs"
          value={jobsLoaded ? activeJobs : "—"}
          sub={jobsLoaded ? `${jobsScoped.length} total` : undefined}
          href="/jobs"
          testid="stat-active-jobs"
        />
        <Stat
          icon={DollarSign}
          label="Daily revenue"
          value={!jobsLoaded ? "—" : usd0(dailyRevenue)}
          sub={
            !jobsLoaded
              ? undefined
              : activeJobs === 0
                ? "No active jobs"
                : missingRates > 0
                  ? `${missingRates} active job${missingRates > 1 ? "s" : ""} missing a day rate`
                  : `Across ${activeJobs} active job${activeJobs > 1 ? "s" : ""}`
          }
          accent={jobsLoaded && dailyRevenue > 0}
          href="/jobs"
          testid="stat-daily-revenue"
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* Report-volume trend */}
        <div className="rounded-lg border border-card-border bg-card p-4">
          <div className="flex items-center justify-between gap-2 mb-3">
            <h3 className="text-sm font-medium inline-flex items-center gap-1.5">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
              Daily reports · last 14 days
            </h3>
            <span className="text-xs text-muted-foreground tabular-nums">
              {trendTotal} total
            </span>
          </div>
          {!dailyReports ? (
            <div className="h-[180px] flex items-center justify-center text-xs text-muted-foreground">
              Loading…
            </div>
          ) : trendTotal === 0 ? (
            <div className="h-[180px] flex items-center justify-center text-center text-xs text-muted-foreground px-6">
              No daily reports in the last 14 days
              {activeArea !== "all" ? ` for ${activeArea}` : ""}. New reports
              appear here as they arrive.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart
                data={trend}
                margin={{ top: 8, right: 8, left: -16, bottom: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="hsl(var(--border))"
                  vertical={false}
                />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                  tickLine={false}
                  axisLine={{ stroke: "hsl(var(--border))" }}
                  interval={1}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  tickLine={false}
                  axisLine={false}
                  width={32}
                />
                <Tooltip
                  cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }}
                  contentStyle={{
                    background: "hsl(var(--popover))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 8,
                    fontSize: 12,
                    color: "hsl(var(--popover-foreground))",
                  }}
                  formatter={(v: any) => [v, "Reports"]}
                />
                <Bar
                  dataKey="count"
                  name="Reports"
                  fill="#01563E"
                  radius={[3, 3, 0, 0]}
                  maxBarSize={26}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Daily revenue by area */}
        <div className="rounded-lg border border-card-border bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground text-sm mb-3">
            <DollarSign className="h-4 w-4" />
            Daily revenue by area
          </div>
          {!jobsLoaded ? (
            <div className="h-[180px] flex items-center justify-center text-xs text-muted-foreground">
              Loading…
            </div>
          ) : areaBreakdown.length === 0 ? (
            <div className="h-[180px] flex items-center justify-center text-center text-xs text-muted-foreground px-6">
              No active jobs with a day rate
              {activeArea !== "all" ? ` in ${activeArea}` : ""} yet. Set a day
              rate on a job to see its revenue here.
            </div>
          ) : (
            <div className="space-y-3">
              {areaBreakdown.map((a) => {
                const pct =
                  dailyRevenue > 0 ? (a.revenue / dailyRevenue) * 100 : 0;
                return (
                  <div key={a.area}>
                    <div className="flex items-baseline justify-between text-sm mb-1">
                      <span className="font-medium">{a.area}</span>
                      <span className="tabular-nums font-semibold">
                        {usd0(a.revenue)}
                      </span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {a.activeJobs} active job{a.activeJobs > 1 ? "s" : ""}
                      {a.missing > 0 && ` · ${a.missing} missing a day rate`}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Fleet & sign-off detail */}
      <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat
          icon={Boxes}
          label="Assets"
          value={assets ? totalAssets : "—"}
          sub={
            assets && idleAssets > 0
              ? `${idleAssets} idle`
              : assets
                ? "all deployed"
                : undefined
          }
          href="/assets"
          testid="stat-assets"
        />
        <Stat
          icon={ClipboardList}
          label="Reports"
          value={reports ? reportsScoped.length : "—"}
          href="/service"
          testid="stat-reports"
        />
        <Stat
          icon={Clock}
          label="Pending sign-off"
          value={reports ? pending : "—"}
          accent={pending > 0}
          href="/service"
          testid="stat-pending"
        />
        <Stat
          icon={CheckCircle2}
          label="Signed off"
          value={reports ? signed : "—"}
          href="/service"
          testid="stat-signed"
        />
      </div>

      <p className="text-sm text-muted-foreground mt-6">
        {isAdmin && activeArea !== "all"
          ? `Showing ${activeArea} only — `
          : ""}
        Fleet utilization, active jobs, and daily revenue update live from your
        database. Daily revenue sums the day rate of every active job — set a
        job's day rate on its detail page. Alerts and the report trend surface
        what needs attention first.
      </p>
    </div>
  );
}

export default function Dashboard() {
  const { profile } = useAuth();
  if (!profile) return null;
  return profile.role === "field" ? (
    <FieldTechDashboard profile={profile} />
  ) : (
    <ManagerDashboard profile={profile} />
  );
}
