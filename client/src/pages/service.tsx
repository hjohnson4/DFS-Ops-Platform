import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { ROLE_LABELS } from "@shared/schema";
import type {
  ServiceDashboard,
  ServiceAssetRow,
  ServiceState,
  ServiceReportWithLinks,
  ServiceReportDetail,
} from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { UploadServiceReportDialog } from "@/components/UploadServiceReportDialog";
import { NewServiceReportDialog } from "@/components/NewServiceReportDialog";
import { ServiceReportDetailDialog } from "@/components/ServiceReportDetailDialog";
import { ExportReportsDialog } from "@/components/ExportReportsDialog";
import {
  exportServiceReportsPdf,
  type ServiceExportReport,
} from "@/lib/reportExport";
import {
  Activity,
  AlertTriangle,
  CalendarClock,
  ClipboardCheck,
  Check,
  Download,
  FileText,
  Trash2,
  Upload,
  Wrench,
  X,
} from "lucide-react";

// ---- KPI card --------------------------------------------------------------
function Stat({
  icon: Icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: any;
  label: string;
  value: string | number;
  sub?: string;
  tone?: "default" | "warn" | "danger";
}) {
  const valueTone =
    tone === "danger"
      ? "text-red-600 dark:text-red-400"
      : tone === "warn"
        ? "text-amber-600 dark:text-amber-400"
        : "";
  return (
    <div className="rounded-lg border border-card-border bg-card p-4">
      <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1.5">
        <Icon className="h-4 w-4" />
        {label}
      </div>
      <div className={`text-2xl font-semibold tabular-nums ${valueTone}`}>
        {value}
      </div>
      {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
    </div>
  );
}

// ---- Status badge ----------------------------------------------------------
const STATE_META: Record<
  ServiceState,
  { label: string; cls: string }
> = {
  Overdue: {
    label: "Overdue",
    cls: "bg-red-500/15 text-red-700 dark:text-red-400",
  },
  Soon: {
    label: "Service soon",
    cls: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  },
  OK: {
    label: "OK",
    cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  },
  "No baseline": {
    label: "No baseline",
    cls: "bg-muted text-muted-foreground",
  },
  "Not tracked": {
    label: "Not tracked",
    cls: "bg-muted text-muted-foreground",
  },
};

function StatusBadge({ state }: { state: ServiceState }) {
  const m = STATE_META[state];
  return (
    <span
      className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${m.cls}`}
      data-testid={`status-${state.replace(/\s+/g, "-").toLowerCase()}`}
    >
      {m.label}
    </span>
  );
}

// ---- Page ------------------------------------------------------------------
export default function Service() {
  const { profile } = useAuth();
  const { toast } = useToast();
  // Area managers and supervisors (and admins) upload and manage service
  // reports. Field techs can view within their scope but not upload/delete.
  const canManageReports =
    profile?.role === "admin" ||
    profile?.role === "area" ||
    profile?.role === "super";

  const { data, isLoading } = useQuery<ServiceDashboard>({
    queryKey: ["/api/service/dashboard"],
  });

  const { data: serviceReports, isLoading: reportsLoading } = useQuery<
    ServiceReportWithLinks[]
  >({
    queryKey: ["/api/service-reports"],
  });

  // Structured in-app service reports (the digital form).
  const { data: filedForms, isLoading: formsLoading } = useQuery<
    ServiceReportDetail[]
  >({
    queryKey: ["/api/service-forms"],
  });
  const [detailId, setDetailId] = useState<string | null>(null);
  // The live list shows only job-assigned centrifuges by default; this toggle
  // adds the unassigned ones.
  const [showUnassigned, setShowUnassigned] = useState(false);

  const m = data?.metrics;
  const rows = data?.centrifuges ?? [];
  const reports = serviceReports ?? [];
  // Job-assigned vs unassigned split for the live list.
  const assignedRows = rows.filter((r) => r.assigned);
  const unassignedRows = rows.filter((r) => !r.assigned);
  const visibleRows = showUnassigned ? rows : assignedRows;

  function fmtDate(d: string | null | undefined): string {
    if (!d) return "—";
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return "—";
    return dt.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  function fmtSize(bytes: number): string {
    if (!bytes) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  // Fetch the file through the authenticated API and open it in a new tab.
  async function viewReport(r: ServiceReportWithLinks) {
    try {
      const res = await apiRequest(
        "GET",
        `/api/service-reports/${r.id}/file`,
      );
      const blob = await res.blob();
      // Force a PDF mime so the browser previews it rather than downloading a
      // generic octet-stream blob.
      const pdfBlob =
        blob.type === "application/pdf"
          ? blob
          : new Blob([blob], { type: r.file_mime || "application/pdf" });
      const url = URL.createObjectURL(pdfBlob);
      // Open in a new tab. Do NOT pass "noopener" — browsers block blob: URLs
      // opened with noopener (and it fails outright inside the sandboxed
      // iframe). If the popup is blocked, fall back to a download anchor.
      const win = window.open(url, "_blank");
      if (!win) {
        const a = document.createElement("a");
        a.href = url;
        a.download = r.file_name || "service-report.pdf";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      // Revoke a little later so the new tab has time to load the blob.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e: any) {
      toast({
        title: "Could not open file",
        description: e.message,
        variant: "destructive",
      });
    }
  }

  const del = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/service-reports/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/service-reports"] });
      toast({ title: "Service report removed" });
    },
    onError: (e: any) =>
      toast({
        title: "Could not remove service report",
        description: e.message,
        variant: "destructive",
      }),
  });

  return (
    <div className="p-6 max-w-6xl">
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="flex items-center gap-2">
          <Wrench className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Service</h1>
        </div>
        <div className="flex items-center gap-2">
          <ExportReportsDialog<ServiceExportReport>
            title="Export service reports"
            description="Generate a branded PDF of service reports uploaded over a date range."
            endpoint="/api/service-reports/export.json"
            helpText="Includes each report's job/well, area, customer, file, and who uploaded it. Scoped to your area."
            render={(report, generatedBy) =>
              exportServiceReportsPdf(report, { generatedBy })
            }
          />
          {canManageReports && (
            <NewServiceReportDialog
              trigger={
                <Button size="sm" data-testid="button-new-service-report">
                  <ClipboardCheck className="mr-1.5 h-4 w-4" />
                  New service report
                </Button>
              }
            />
          )}
          {canManageReports && (
            <UploadServiceReportDialog
              trigger={
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="button-upload-service-report"
                >
                  <Upload className="mr-1.5 h-4 w-4" />
                  Upload PDF
                </Button>
              }
            />
          )}
        </div>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Centrifuge fleet health across{" "}
        {profile?.area ? profile.area : "all areas"}. Job-assigned centrifuges
        are on a weekly (7-day) service schedule, counted from the last filed
        service report; machines are flagged as they approach and then pass
        that weekly interval. Unassigned centrifuges are not tracked.
      </p>

      {/* Headline metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat
          icon={Activity}
          label="Active centrifuges"
          value={isLoading ? "—" : m!.active_centrifuges}
          sub={
            isLoading
              ? undefined
              : `${m!.total_centrifuges} in fleet${
                  m!.total_centrifuges > m!.active_centrifuges
                    ? ` · ${m!.total_centrifuges - m!.active_centrifuges} idle`
                    : ""
                }`
          }
        />
        <Stat
          icon={CalendarClock}
          label="Needs service soon"
          value={isLoading ? "—" : m!.due_soon}
          tone={!isLoading && m!.due_soon > 0 ? "warn" : "default"}
          sub="Within 10% of interval"
        />
        <Stat
          icon={AlertTriangle}
          label="Service overdue"
          value={isLoading ? "—" : m!.overdue}
          tone={!isLoading && m!.overdue > 0 ? "danger" : "default"}
          sub="At or past interval"
        />
        <Stat
          icon={ClipboardCheck}
          label="Reports filed"
          value={isLoading ? "—" : m!.reports_filed}
          sub={
            isLoading
              ? undefined
              : m!.reports_pending_signoff > 0
                ? `${m!.reports_pending_signoff} pending sign-off`
                : "All signed off"
          }
        />
      </div>

      {/* Active centrifuge list */}
      <div className="mt-6 mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Active centrifuges</h2>
        <div className="flex items-center gap-4">
          {!isLoading && (
            <span className="text-xs text-muted-foreground">
              {assignedRows.length} on a job
              {unassignedRows.length > 0 && ` · ${unassignedRows.length} unassigned`}
            </span>
          )}
          <div className="flex items-center gap-2">
            <Switch
              id="show-unassigned"
              checked={showUnassigned}
              onCheckedChange={setShowUnassigned}
              data-testid="toggle-show-unassigned"
            />
            <Label
              htmlFor="show-unassigned"
              className="text-xs text-muted-foreground cursor-pointer"
            >
              Show unassigned
            </Label>
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">
          Loading…
        </div>
      ) : visibleRows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-10 text-center">
          <Activity className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
          <div className="text-sm text-muted-foreground">
            {showUnassigned
              ? "No centrifuges found."
              : "No centrifuges are currently assigned to a job."}
          </div>
          {!showUnassigned && unassignedRows.length > 0 && (
            <div className="text-xs text-muted-foreground mt-1">
              {unassignedRows.length} unassigned centrifuge
              {unassignedRows.length === 1 ? "" : "s"} hidden — turn on “Show
              unassigned” to see them.
            </div>
          )}
          {!showUnassigned && unassignedRows.length === 0 && (
            <div className="text-xs text-muted-foreground mt-1">
              Centrifuges appear here once they're assigned to a job.
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-card-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-card-border bg-muted/40 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Asset</th>
                <th className="px-3 py-2 font-medium">Job / Area</th>
                <th className="px-3 py-2 font-medium">Technician</th>
                <th className="px-3 py-2 font-medium text-right">
                  Days since service
                </th>
                <th className="px-3 py-2 font-medium text-right">Interval</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-card-border last:border-0 hover:bg-muted/30"
                  data-testid={`row-centrifuge-${r.tag}`}
                >
                  <td className="px-3 py-2.5">
                    <div className="font-medium">{r.tag}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.category}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="font-medium">
                      {r.assigned ? (
                        r.job_number ?? r.job_or_well ?? "—"
                      ) : (
                        <span className="text-muted-foreground">Unassigned</span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">{r.area}</div>
                  </td>
                  <td className="px-3 py-2.5">
                    {r.technician ?? (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {!r.assigned ? (
                      <span className="text-muted-foreground">—</span>
                    ) : r.days_since_service == null ? (
                      <span
                        className="text-muted-foreground"
                        title="No service report on record yet — file one to start the weekly clock."
                      >
                        —
                      </span>
                    ) : (
                      `${r.days_since_service} ${
                        r.days_since_service === 1 ? "day" : "days"
                      }`
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {r.assigned ? (
                      "Weekly"
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <StatusBadge state={r.service_state} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted-foreground mt-4">
        Job-assigned centrifuges are serviced on a weekly (7-day) schedule,
        counted from the last filed service report. “Service soon” shows the day
        before it comes due; “Overdue” once 7 days have passed. Rows with “No
        baseline” have no service report on record yet — file one to start the
        weekly clock. Unassigned centrifuges are not tracked until they’re put
        on a job.
      </p>

      {/* Filed in-app service reports (structured form) ------------------- */}
      <div className="mt-10 mb-2 flex items-baseline justify-between">
        <div className="flex items-center gap-2">
          <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Filed service reports</h2>
        </div>
        {!formsLoading && (
          <span className="text-xs text-muted-foreground">
            {(filedForms ?? []).length} filed in-app
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Digital centrifuge inspections filed in the app. Each row shows the
        inspection score and any flagged items (which open work orders
        automatically).
      </p>
      {formsLoading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">
          Loading…
        </div>
      ) : (filedForms ?? []).length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-10 text-center">
          <ClipboardCheck className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
          <div className="text-sm text-muted-foreground">
            No in-app service reports have been filed yet.
          </div>
          {canManageReports && (
            <div className="text-xs text-muted-foreground mt-1">
              Use “New service report” to fill out an inspection in the app.
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-card-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-card-border bg-muted/40 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Asset</th>
                <th className="px-3 py-2 font-medium">Technician</th>
                <th className="px-3 py-2 font-medium">Score</th>
                <th className="px-3 py-2 font-medium">Flags</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium text-right"></th>
              </tr>
            </thead>
            <tbody>
              {(filedForms ?? []).map((r) => {
                const pct =
                  r.score_total > 0
                    ? Math.round((r.score_pass / r.score_total) * 100)
                    : null;
                return (
                  <tr
                    key={r.id}
                    className="border-b border-card-border last:border-0 hover:bg-muted/30 align-top cursor-pointer"
                    onClick={() => setDetailId(r.id)}
                    data-testid={`row-service-form-${r.id}`}
                  >
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      {fmtDate(r.report_date)}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="font-medium">{r.asset_tag ?? "—"}</div>
                      <div className="text-xs text-muted-foreground">
                        {r.asset_category ?? "—"} · {r.area ?? "—"}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">{r.supervisor_name ?? "—"}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      {r.score_total > 0
                        ? `${r.score_pass}/${r.score_total}${pct != null ? ` (${pct}%)` : ""}`
                        : "—"}
                    </td>
                    <td className="px-3 py-2.5">
                      {r.flagged_count > 0 ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-red-100 dark:bg-red-950 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-300">
                          <AlertTriangle className="h-3 w-3" />
                          {r.flagged_count}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          None
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <span
                        className={[
                          "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                          r.status === "Signed off"
                            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                            : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
                        ].join(" ")}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDetailId(r.id);
                        }}
                        data-testid={`button-view-form-${r.id}`}
                      >
                        View
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ServiceReportDetailDialog
        reportId={detailId}
        onClose={() => setDetailId(null)}
      />

      {/* Uploaded service reports ---------------------------------------- */}
      <div className="mt-10 mb-2 flex items-baseline justify-between">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Uploaded PDFs (legacy)</h2>
        </div>
        {!reportsLoading && (
          <span className="text-xs text-muted-foreground">
            {reports.length} uploaded
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Service report PDFs uploaded by area managers and supervisors for the
        jobs where they are servicing equipment.{" "}
        {profile?.role === "admin"
          ? "You can see uploads across all areas."
          : "You see uploads for jobs in your area."}
      </p>

      {reportsLoading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">
          Loading…
        </div>
      ) : reports.length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-10 text-center">
          <FileText className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
          <div className="text-sm text-muted-foreground">
            No service reports have been uploaded yet.
          </div>
          {canManageReports && (
            <div className="text-xs text-muted-foreground mt-1">
              Use “Upload service report” to attach a PDF to a job.
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-card-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-card-border bg-muted/40 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Uploaded</th>
                <th className="px-3 py-2 font-medium">Report</th>
                <th className="px-3 py-2 font-medium">Job / Well</th>
                <th className="px-3 py-2 font-medium">Area</th>
                <th className="px-3 py-2 font-medium">Uploaded by</th>
                <th className="px-3 py-2 font-medium text-right">File</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-card-border last:border-0 hover:bg-muted/30 align-top"
                  data-testid={`row-service-report-${r.id}`}
                >
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    {fmtDate(r.created_at)}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="font-medium break-all">{r.file_name}</div>
                    <div className="text-xs text-muted-foreground">
                      {fmtSize(r.file_size)}
                      {r.notes ? ` · ${r.notes}` : ""}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="font-medium">{r.job_number ?? "—"}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.well_name ?? "—"}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    {r.area ?? "—"}
                  </td>
                  <td className="px-3 py-2.5">{r.uploaded_by_name ?? "—"}</td>
                  <td className="px-3 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => viewReport(r)}
                        data-testid={`button-view-report-${r.id}`}
                      >
                        <Download className="mr-1.5 h-3.5 w-3.5" />
                        View
                      </Button>
                      {canManageReports && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            if (
                              window.confirm(
                                `Remove "${r.file_name}"? This cannot be undone.`,
                              )
                            )
                              del.mutate(r.id);
                          }}
                          disabled={del.isPending}
                          data-testid={`button-delete-report-${r.id}`}
                          aria-label="Remove service report"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
