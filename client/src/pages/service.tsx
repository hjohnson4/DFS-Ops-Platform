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
} from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { UploadServiceReportDialog } from "@/components/UploadServiceReportDialog";
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
  Pencil,
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

// ---- Inline interval editor (admin / area only) ----------------------------
function IntervalCell({
  row,
  canEdit,
}: {
  row: ServiceAssetRow;
  canEdit: boolean;
}) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(row.service_hours_interval));

  const save = useMutation({
    mutationFn: async () => {
      const n = parseInt(val, 10);
      if (!Number.isFinite(n) || n <= 0) throw new Error("Enter a positive number of hours");
      await apiRequest("PATCH", `/api/assets/${row.id}`, {
        service_hours_interval: n,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/service/dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
      setEditing(false);
      toast({ title: "Interval updated" });
    },
    onError: (e: any) =>
      toast({ title: "Could not update", description: e.message, variant: "destructive" }),
  });

  if (!canEdit) {
    return (
      <span className="tabular-nums">
        {row.service_hours_interval.toLocaleString()} hrs
      </span>
    );
  }
  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setVal(String(row.service_hours_interval));
          setEditing(true);
        }}
        className="group inline-flex items-center gap-1 tabular-nums hover:text-primary"
        data-testid={`button-edit-interval-${row.tag}`}
      >
        {row.service_hours_interval.toLocaleString()} hrs
        <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-60" />
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <Input
        type="number"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        className="h-7 w-20 px-2 text-sm"
        min={1}
        data-testid={`input-interval-${row.tag}`}
        autoFocus
      />
      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7"
        disabled={save.isPending}
        onClick={() => save.mutate()}
        data-testid={`button-save-interval-${row.tag}`}
      >
        <Check className="h-4 w-4" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7"
        onClick={() => setEditing(false)}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}

// ---- Page ------------------------------------------------------------------
export default function Service() {
  const { profile } = useAuth();
  const { toast } = useToast();
  const canEditInterval =
    profile?.role === "admin" || profile?.role === "area";
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

  const m = data?.metrics;
  const rows = data?.centrifuges ?? [];
  const reports = serviceReports ?? [];

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
            <UploadServiceReportDialog
              trigger={
                <Button size="sm" data-testid="button-upload-service-report">
                  <Upload className="mr-1.5 h-4 w-4" />
                  Upload service report
                </Button>
              }
            />
          )}
        </div>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Centrifuge fleet health across{" "}
        {profile?.area ? profile.area : "all areas"}. Run-hours since service are
        measured from the meter reading captured at the last filed report;
        machines are flagged as they approach (within 10%) and then pass their
        service interval.
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
      <div className="mt-6 mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Active centrifuges</h2>
        {!isLoading && (
          <span className="text-xs text-muted-foreground">
            {rows.length} deployed
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">
          Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-10 text-center">
          <Activity className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
          <div className="text-sm text-muted-foreground">
            No centrifuges are currently deployed to a job.
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            Centrifuges appear here once they're assigned and marked on a job.
          </div>
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
                  Run hrs since service
                </th>
                <th className="px-3 py-2 font-medium text-right">Interval</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
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
                      {r.job_number ?? r.job_or_well ?? "—"}
                    </div>
                    <div className="text-xs text-muted-foreground">{r.area}</div>
                  </td>
                  <td className="px-3 py-2.5">
                    {r.technician ?? (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {r.run_hours_since_service == null ? (
                      <span
                        className="text-muted-foreground"
                        title="No service on record yet — file a report to set the baseline."
                      >
                        —
                      </span>
                    ) : (
                      `${r.run_hours_since_service.toLocaleString()} hrs`
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <IntervalCell row={r} canEdit={canEditInterval} />
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
        Technician shows the supervisor who last filed a service report on that
        machine. Rows with “No baseline” have no service on record yet — file a
        maintenance report to set the run-hour baseline.
        {canEditInterval && " Click an interval value to change it per machine."}
      </p>

      {/* Uploaded service reports ---------------------------------------- */}
      <div className="mt-10 mb-2 flex items-baseline justify-between">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Service reports</h2>
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
