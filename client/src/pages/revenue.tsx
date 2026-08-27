import { useAuth } from "@/lib/auth";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  DollarSign,
  TrendingUp,
  Briefcase,
  Building2,
  Download,
  Activity,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { getAccessToken } from "@/lib/queryClient";

// ---- Types (shape of /api/revenue/summary) --------------------------------
type JobRow = {
  job_id: string;
  job_number: string;
  area: string;
  customer_id: string | null;
  customer_name: string;
  day_rate: number | null;
  report_days: number;
  revenue: number | null;
  has_accrued: boolean;
  active: boolean;
  last_report: string | null;
};
type AreaRow = { area: string; revenue: number | null; jobs: number };
type CustomerRow = {
  customer_id: string | null;
  name: string;
  revenue: number | null;
  jobs: number;
};
type DailyRow = { date: string; revenue: number };
type MonthlyRow = { month: string; revenue: number };
type Summary = {
  scope: string;
  totals: {
    revenue: number | null;
    jobs: number;
    active_jobs: number;
    completed_jobs: number;
    active_revenue: number | null;
    completed_revenue: number | null;
    jobs_missing_accrued: number;
  };
  by_area: AreaRow[];
  by_customer: CustomerRow[];
  by_job: JobRow[];
  top_jobs: JobRow[];
  daily: DailyRow[];
  monthly: MonthlyRow[];
};

// ---- Formatting -----------------------------------------------------------
// Honesty rule: null/absent revenue renders as an em dash, never $0.
function money(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}
function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (!m) return d;
  return `${m[2]}/${m[3]}/${m[1].slice(2)}`;
}
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
function fmtMonth(m: string): string {
  const parts = /^(\d{4})-(\d{2})$/.exec(m);
  if (!parts) return m;
  return `${MONTHS[Number(parts[2]) - 1] ?? parts[2]} ${parts[1]}`;
}

function Stat({
  icon: Icon,
  label,
  value,
  sub,
  accent,
  testid,
}: {
  icon: any;
  label: string;
  value: string | number;
  sub?: string;
  accent?: boolean;
  testid?: string;
}) {
  return (
    <div
      className={
        "rounded-lg border bg-card p-4 h-full " +
        (accent ? "border-primary/40 ring-1 ring-primary/10" : "border-card-border")
      }
      data-testid={testid}
    >
      <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1.5">
        <Icon className={"h-4 w-4 " + (accent ? "text-primary" : "")} />
        {label}
      </div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
    </div>
  );
}

export default function RevenuePage() {
  const { profile } = useAuth();
  const [downloading, setDownloading] = useState(false);
  const { data, isLoading, error } = useQuery<Summary>({
    queryKey: ["/api/revenue/summary"],
  });

  async function exportCsv() {
    try {
      setDownloading(true);
      const base = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";
      const t = getAccessToken();
      const res = await fetch(`${base}/api/revenue/export`, {
        headers: t ? { Authorization: `Bearer ${t}` } : {},
      });
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `revenue-${data?.scope ?? "all"}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      // Surfacing the failure inline keeps the honesty rule — no silent no-op.
      alert("Could not export CSV. Please try again.");
    } finally {
      setDownloading(false);
    }
  }

  const scopeLabel =
    profile?.role === "admin" ? "All areas" : profile?.area ?? "Your area";

  return (
    <div className="p-4 md:p-6 space-y-6" data-testid="page-revenue">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <DollarSign className="h-5 w-5 text-primary" />
            Revenue
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Accrued actuals (from the latest daily report per well) · {scopeLabel}
          </p>
        </div>
        <button
          onClick={exportCsv}
          disabled={downloading || isLoading}
          className="inline-flex items-center gap-2 rounded-md border border-card-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent/50 disabled:opacity-50"
          data-testid="button-export-csv"
        >
          <Download className="h-4 w-4" />
          {downloading ? "Exporting…" : "Export CSV"}
        </button>
      </div>

      {isLoading && (
        <div className="text-sm text-muted-foreground" data-testid="text-loading">
          Loading revenue…
        </div>
      )}
      {error && (
        <div className="text-sm text-destructive" data-testid="text-error">
          Could not load revenue: {(error as Error).message}
        </div>
      )}

      {data && (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat
              icon={DollarSign}
              label="Total revenue"
              value={money(data.totals.revenue)}
              sub={`${data.totals.jobs} job${data.totals.jobs === 1 ? "" : "s"} in scope`}
              accent
              testid="stat-total-revenue"
            />
            <Stat
              icon={Activity}
              label="Active jobs"
              value={data.totals.active_jobs}
              sub={money(data.totals.active_revenue)}
              testid="stat-active"
            />
            <Stat
              icon={CheckCircle2}
              label="Completed jobs"
              value={data.totals.completed_jobs}
              sub={money(data.totals.completed_revenue)}
              testid="stat-completed"
            />
            <Stat
              icon={AlertTriangle}
              label="Jobs missing accrued"
              value={data.totals.jobs_missing_accrued}
              sub="No AS57 on any report yet"
              testid="stat-missing"
            />
          </div>

          {/* Daily & monthly trend */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="rounded-lg border border-card-border bg-card p-4">
              <div className="text-sm font-medium mb-3 flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-primary" />
                Daily revenue (day rate × report days)
              </div>
              {data.daily.length === 0 ? (
                <div className="text-sm text-muted-foreground py-10 text-center">
                  No daily revenue yet
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={data.daily} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                    <XAxis dataKey="date" tickFormatter={fmtDate} fontSize={11} />
                    <YAxis
                      tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                      fontSize={11}
                      width={48}
                    />
                    <Tooltip
                      formatter={(v: any) => money(Number(v))}
                      labelFormatter={(l) => fmtDate(String(l))}
                    />
                    <Line
                      type="monotone"
                      dataKey="revenue"
                      stroke="hsl(var(--primary))"
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>

            <div className="rounded-lg border border-card-border bg-card p-4">
              <div className="text-sm font-medium mb-3 flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-primary" />
                Monthly revenue
              </div>
              {data.monthly.length === 0 ? (
                <div className="text-sm text-muted-foreground py-10 text-center">
                  No monthly revenue yet
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={data.monthly} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                    <XAxis dataKey="month" tickFormatter={fmtMonth} fontSize={11} />
                    <YAxis
                      tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                      fontSize={11}
                      width={48}
                    />
                    <Tooltip
                      formatter={(v: any) => money(Number(v))}
                      labelFormatter={(l) => fmtMonth(String(l))}
                    />
                    <Bar dataKey="revenue" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* By area + by customer */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="rounded-lg border border-card-border bg-card overflow-hidden">
              <div className="text-sm font-medium px-4 py-3 border-b border-card-border flex items-center gap-2">
                <Building2 className="h-4 w-4 text-primary" />
                Revenue by area
              </div>
              <table className="w-full text-sm">
                <thead className="text-muted-foreground text-xs">
                  <tr className="border-b border-card-border">
                    <th className="text-left font-medium px-4 py-2">Area</th>
                    <th className="text-right font-medium px-4 py-2">Jobs</th>
                    <th className="text-right font-medium px-4 py-2">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {data.by_area.length === 0 && (
                    <tr>
                      <td colSpan={3} className="px-4 py-6 text-center text-muted-foreground">
                        No data
                      </td>
                    </tr>
                  )}
                  {data.by_area.map((r) => (
                    <tr
                      key={r.area}
                      className="border-b border-card-border/50 last:border-0"
                      data-testid={`row-area-${r.area}`}
                    >
                      <td className="px-4 py-2">{r.area}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{r.jobs}</td>
                      <td className="px-4 py-2 text-right tabular-nums font-medium">
                        {money(r.revenue)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="rounded-lg border border-card-border bg-card overflow-hidden">
              <div className="text-sm font-medium px-4 py-3 border-b border-card-border flex items-center gap-2">
                <Briefcase className="h-4 w-4 text-primary" />
                Revenue by customer
              </div>
              <table className="w-full text-sm">
                <thead className="text-muted-foreground text-xs">
                  <tr className="border-b border-card-border">
                    <th className="text-left font-medium px-4 py-2">Customer</th>
                    <th className="text-right font-medium px-4 py-2">Jobs</th>
                    <th className="text-right font-medium px-4 py-2">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {data.by_customer.length === 0 && (
                    <tr>
                      <td colSpan={3} className="px-4 py-6 text-center text-muted-foreground">
                        No data
                      </td>
                    </tr>
                  )}
                  {data.by_customer.map((r) => (
                    <tr
                      key={r.customer_id ?? "none"}
                      className="border-b border-card-border/50 last:border-0"
                      data-testid={`row-customer-${r.customer_id ?? "none"}`}
                    >
                      <td className="px-4 py-2">{r.name}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{r.jobs}</td>
                      <td className="px-4 py-2 text-right tabular-nums font-medium">
                        {money(r.revenue)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* By job (full breakdown) */}
          <div className="rounded-lg border border-card-border bg-card overflow-hidden">
            <div className="text-sm font-medium px-4 py-3 border-b border-card-border flex items-center gap-2">
              <Briefcase className="h-4 w-4 text-primary" />
              Revenue by job
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-muted-foreground text-xs">
                  <tr className="border-b border-card-border">
                    <th className="text-left font-medium px-4 py-2">Job</th>
                    <th className="text-left font-medium px-4 py-2">Area</th>
                    <th className="text-left font-medium px-4 py-2">Customer</th>
                    <th className="text-right font-medium px-4 py-2">Report days</th>
                    <th className="text-left font-medium px-4 py-2">Last report</th>
                    <th className="text-center font-medium px-4 py-2">Status</th>
                    <th className="text-right font-medium px-4 py-2">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {data.by_job.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-6 text-center text-muted-foreground">
                        No jobs in scope
                      </td>
                    </tr>
                  )}
                  {data.by_job.map((j) => (
                    <tr
                      key={j.job_id}
                      className="border-b border-card-border/50 last:border-0"
                      data-testid={`row-job-${j.job_id}`}
                    >
                      <td className="px-4 py-2 font-medium">{j.job_number}</td>
                      <td className="px-4 py-2">{j.area}</td>
                      <td className="px-4 py-2">{j.customer_name || "—"}</td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {j.report_days || "—"}
                      </td>
                      <td className="px-4 py-2">{fmtDate(j.last_report)}</td>
                      <td className="px-4 py-2 text-center">
                        {j.active ? (
                          <span className="inline-flex items-center gap-1 text-xs text-primary">
                            <Activity className="h-3 w-3" /> Active
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                            <CheckCircle2 className="h-3 w-3" /> Completed
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums font-medium">
                        {money(j.revenue)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Revenue is the cumulative accrued figure (cell AS57) from the most
            recent daily report carrying a value for each well, summed to the
            job. Jobs with no AS57 value yet show “—”. Daily and monthly trends
            use a day-rate basis (each report day × the job’s day rate).
          </p>
        </>
      )}
    </div>
  );
}
