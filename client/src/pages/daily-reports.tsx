import { useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  DailyReportWithLinks,
  DailyReportStatus,
  BackfillDailyReportResult,
} from "@shared/schema";
import {
  Inbox,
  Search,
  Loader2,
  CheckCircle2,
  X,
  Upload,
  FileSpreadsheet,
  AlertTriangle,
  Eye,
  Download,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";

const STATUS_TONE: Record<DailyReportStatus, string> = {
  "Needs job match": "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  "Pending Review": "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  "Signed off": "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  "Changes requested": "bg-rose-500/15 text-rose-700 dark:text-rose-400",
};

function fmt(d: string | null) {
  if (!d) return "—";
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? d : dt.toLocaleDateString();
}

type StatusFilter = "all" | "pending" | "signed";

// Read a File as a base64 string (no data: prefix) for JSON upload.
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result || "");
      const comma = res.indexOf(",");
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Admin / area manager "Import workbook" dialog: uploads a daily-report
// workbook that already has completed day tabs and backfills every completed
// day (day 1 .. latest) in one shot. Historical days import already signed off
// and their centrifuge run hours accrue automatically.
function ImportWorkbookDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<BackfillDailyReportResult | null>(null);

  const reset = () => {
    setFile(null);
    setResult(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const importMut = useMutation({
    mutationFn: async (f: File) => {
      const attachment_base64 = await fileToBase64(f);
      const res = await apiRequest("POST", "/api/daily-reports/backfill", {
        attachment_base64,
        attachment_name: f.name,
      });
      return (await res.json()) as BackfillDailyReportResult;
    },
    onSuccess: (data) => {
      setResult(data);
      queryClient.invalidateQueries({ queryKey: ["/api/daily-reports"] });
      const parts: string[] = [`${data.days_imported} imported`];
      if (data.days_duplicate) parts.push(`${data.days_duplicate} already loaded`);
      if (data.days_error) parts.push(`${data.days_error} failed`);
      toast({
        title: data.matched_job
          ? `Backfill complete — ${parts.join(", ")}`
          : `Imported ${parts.join(", ")} — no matching job yet`,
        variant: data.days_error ? "destructive" : undefined,
      });
    },
    onError: (e: any) =>
      toast({
        title: "Import failed",
        description: e.message,
        variant: "destructive",
      }),
  });

  const handleClose = (o: boolean) => {
    if (!o) reset();
    onOpenChange(o);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5 text-muted-foreground" />
            Import daily-report workbook
          </DialogTitle>
          <DialogDescription>
            Upload a workbook that already has completed day tabs and every
            completed day is loaded at once — day 1 through the latest. Great for
            rollout and seeding a job's prior days.
          </DialogDescription>
        </DialogHeader>

        {!result ? (
          <div className="space-y-4">
            <div
              className="rounded-lg border border-dashed border-card-border bg-muted/30 p-6 text-center cursor-pointer hover:bg-muted/50 transition-colors"
              onClick={() => fileRef.current?.click()}
              data-testid="dropzone-import-workbook"
            >
              <FileSpreadsheet className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
              <div className="text-sm font-medium">
                {file ? file.name : "Choose an .xlsx workbook"}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {file ? "Click to pick a different file" : "Click to browse"}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                data-testid="input-import-workbook"
              />
            </div>

            <div className="rounded-md bg-amber-500/10 border border-amber-500/20 p-3 text-xs text-amber-800 dark:text-amber-300 flex gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <div>
                Imported days are recorded as signed off (historical) and their
                run hours are added to the job's centrifuges. The well name in
                the workbook is matched to a job automatically; if no job
                matches, the days land in the “Needs a job” queue. Re-uploading
                the same file is safe — days already loaded are skipped.
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => handleClose(false)}
                data-testid="button-cancel-import"
              >
                Cancel
              </Button>
              <Button
                onClick={() => file && importMut.mutate(file)}
                disabled={!file || importMut.isPending}
                data-testid="button-run-import"
              >
                {importMut.isPending ? (
                  <>
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                    Importing…
                  </>
                ) : (
                  <>
                    <Upload className="mr-1.5 h-4 w-4" />
                    Import all days
                  </>
                )}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-lg border border-card-border p-3 text-sm">
              <div className="font-medium">
                {result.well_name ? `Well: ${result.well_name}` : "Well name not found in workbook"}
              </div>
              <div className="text-muted-foreground text-xs mt-0.5">
                {result.matched_job
                  ? "Matched to a job — days imported as signed off."
                  : "No matching job — days are in the “Needs a job” queue."}
              </div>
              <div className="flex flex-wrap gap-2 mt-2 text-xs">
                <span className="inline-flex items-center rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 px-2 py-0.5">
                  {result.days_imported} imported
                </span>
                {result.days_duplicate > 0 && (
                  <span className="inline-flex items-center rounded-full bg-muted text-muted-foreground px-2 py-0.5">
                    {result.days_duplicate} already loaded
                  </span>
                )}
                {result.days_error > 0 && (
                  <span className="inline-flex items-center rounded-full bg-rose-500/15 text-rose-700 dark:text-rose-400 px-2 py-0.5">
                    {result.days_error} failed
                  </span>
                )}
              </div>
            </div>

            <div className="max-h-64 overflow-y-auto rounded-lg border border-card-border divide-y divide-card-border">
              {result.results.map((r) => (
                <div
                  key={r.report_day}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <div className="font-medium">{r.source_sheet}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {fmt(r.report_date)}
                      {r.run_hours_applied ? ` · ${r.run_hours_applied}` : ""}
                      {r.message ? ` · ${r.message}` : ""}
                    </div>
                  </div>
                  <span
                    className={
                      "shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-xs " +
                      (r.status === "imported"
                        ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                        : r.status === "duplicate"
                          ? "bg-muted text-muted-foreground"
                          : "bg-rose-500/15 text-rose-700 dark:text-rose-400")
                    }
                  >
                    {r.status === "imported"
                      ? "Imported"
                      : r.status === "duplicate"
                        ? "Skipped"
                        : "Failed"}
                  </span>
                </div>
              ))}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={reset} data-testid="button-import-another">
                Import another
              </Button>
              <Button onClick={() => handleClose(false)} data-testid="button-close-import">
                Done
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function DailyReportsPage() {
  const [, navigate] = useLocation();
  const { profile } = useAuth();
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const canReview =
    profile?.role === "admin" ||
    profile?.role === "area" ||
    profile?.role === "super";
  const canManage = profile?.role === "admin" || profile?.role === "area";
  const [importOpen, setImportOpen] = useState(false);
  // Which row's document is currently loading, keyed as `${id}:${mode}`.
  const [docBusy, setDocBusy] = useState<string | null>(null);

  // Fetch a report's stored workbook (authenticated) and either open it in a
  // new tab or download it. Row clicks navigate to the detail page, so callers
  // must stopPropagation on these buttons.
  async function openReportDoc(
    reportId: string,
    name: string | null,
    mode: "view" | "download",
  ) {
    setDocBusy(`${reportId}:${mode}`);
    try {
      const res = await apiRequest(
        "GET",
        `/api/daily-reports/${reportId}/attachment`,
      );
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (mode === "view") {
        window.open(url, "_blank", "noopener,noreferrer");
      } else {
        const a = document.createElement("a");
        a.href = url;
        a.download = name || "daily-report.xlsx";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e: any) {
      toast({
        title: "Could not open the document",
        description: e.message,
        variant: "destructive",
      });
    } finally {
      setDocBusy(null);
    }
  }

  const {
    data: reports,
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useQuery<DailyReportWithLinks[]>({
    queryKey: ["/api/daily-reports"],
  });

  const all = reports || [];
  const pending = all.filter((r) => r.status === "Pending Review").length;
  const needsMatch = all.filter((r) => r.status === "Needs job match").length;

  const q = search.trim().toLowerCase();
  const rows = useMemo(() => {
    return all.filter((r) => {
      if (statusFilter === "pending" && r.status === "Signed off") return false;
      if (statusFilter === "signed" && r.status !== "Signed off") return false;
      if (q) {
        const hay = [
          r.sender_name,
          r.sender_email,
          r.well_name,
          r.job_number,
          r.customer_name,
          r.area,
          r.subject,
          r.status,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [all, statusFilter, q]);

  // Bulk sign-off applies only to rows that are "Pending Review".
  const selectablePending = useMemo(
    () => rows.filter((r) => r.status === "Pending Review"),
    [rows],
  );
  const selectedPending = useMemo(
    () => selectablePending.filter((r) => selected.has(r.id)),
    [selectablePending, selected],
  );
  const allPendingSelected =
    selectablePending.length > 0 &&
    selectablePending.every((r) => selected.has(r.id));

  const toggleRow = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const toggleAll = () =>
    setSelected((prev) => {
      if (allPendingSelected) return new Set();
      return new Set(selectablePending.map((r) => r.id));
    });

  const clearSelection = () => setSelected(new Set());

  const bulkSignOff = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(
        ids.map((id) =>
          apiRequest("POST", `/api/daily-reports/${id}/review`, {
            action: "sign_off",
          }),
        ),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      return { ok: ids.length - failed, failed };
    },
    onSuccess: ({ ok, failed }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/daily-reports"] });
      clearSelection();
      toast({
        title:
          failed === 0
            ? `Signed off ${ok} report${ok === 1 ? "" : "s"}`
            : `Signed off ${ok}, ${failed} failed`,
        variant: failed === 0 ? undefined : "destructive",
      });
    },
    onError: (e: any) =>
      toast({
        title: "Bulk sign-off failed",
        description: e.message,
        variant: "destructive",
      }),
  });

  const showSelectColumn = canReview && selectablePending.length > 0;
  const colCount = showSelectColumn ? 7 : 6;

  return (
    <div className="p-4 md:p-6 max-w-5xl">
      <div className="flex items-center justify-between gap-2 mb-1">
        <h1 className="text-xl font-semibold">Daily Reports</h1>
        <div className="flex items-center gap-2">
          {canManage && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setImportOpen(true)}
              data-testid="button-import-workbook"
            >
              <Upload className="mr-1.5 h-4 w-4" />
              Import workbook
            </Button>
          )}
          {needsMatch > 0 && (
            <span className="inline-flex items-center rounded-full bg-orange-500/15 text-orange-700 dark:text-orange-400 px-2.5 py-1 text-xs font-medium">
              {needsMatch} need a job
            </span>
          )}
          {pending > 0 && (
            <span className="inline-flex items-center rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-400 px-2.5 py-1 text-xs font-medium">
              {pending} awaiting review
            </span>
          )}
        </div>
      </div>
      {canManage && (
        <ImportWorkbookDialog open={importOpen} onOpenChange={setImportOpen} />
      )}

      <p className="text-sm text-muted-foreground mb-4">
        Every crew's daily report in one place. Reports are emailed in to the
        intake inbox, with KPI values read straight from the Excel workbook's
        “Report Day” sheet and locked. Each report is matched to a job, reviewed,
        and signed off in the same flow.
      </p>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <ToggleGroup
          type="single"
          value={statusFilter}
          onValueChange={(v) => v && setStatusFilter(v as StatusFilter)}
          className="justify-start"
        >
          <ToggleGroupItem value="all" data-testid="filter-status-all">All statuses</ToggleGroupItem>
          <ToggleGroupItem value="pending" data-testid="filter-status-pending">Pending</ToggleGroupItem>
          <ToggleGroupItem value="signed" data-testid="filter-status-signed">Signed off</ToggleGroupItem>
        </ToggleGroup>

        <div className="relative ml-auto w-full sm:w-64">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search sender, well, job, customer…"
            className="pl-8"
            data-testid="input-search-daily-reports"
          />
        </div>
      </div>

      {/* Bulk action bar */}
      {showSelectColumn && selectedPending.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-3 mb-3 rounded-lg border border-card-border bg-primary/5 px-4 py-2.5"
          data-testid="bulk-action-bar"
        >
          <span className="text-sm font-medium">
            {selectedPending.length} selected
          </span>
          <Button
            size="sm"
            onClick={() => bulkSignOff.mutate(selectedPending.map((r) => r.id))}
            disabled={bulkSignOff.isPending}
            data-testid="button-bulk-signoff"
          >
            {bulkSignOff.isPending ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="mr-1.5 h-4 w-4" />
            )}
            Sign off selected
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={clearSelection}
            data-testid="button-clear-selection"
          >
            <X className="mr-1.5 h-4 w-4" />
            Clear
          </Button>
        </div>
      )}

      {isLoading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">Loading…</div>
      ) : isError ? (
        <div
          className="rounded-lg border border-dashed border-card-border bg-muted/30 p-10 text-center"
          data-testid="daily-reports-error"
        >
          <AlertTriangle className="h-6 w-6 mx-auto text-amber-500 mb-2" />
          <div className="text-sm font-medium">Couldn't load daily reports</div>
          <div className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
            The reports are still saved — the request to load them didn't go
            through. This is usually a brief network hiccup. Try again.
          </div>
          <Button
            size="sm"
            variant="outline"
            className="mt-3"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-retry-daily-reports"
          >
            {isFetching ? (
              <>
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                Retrying…
              </>
            ) : (
              "Retry"
            )}
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-10 text-center">
          <Inbox className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
          <div className="text-sm text-muted-foreground">
            {all.length === 0
              ? "No daily reports yet."
              : q
                ? "No reports match your search."
                : "No reports match these filters."}
          </div>
          {all.length === 0 && (
            <div className="text-xs text-muted-foreground mt-1">
              Reports appear here after the daily email check imports them from
              the intake inbox.
            </div>
          )}
        </div>
      ) : (
        <>
        {/* Desktop table */}
        <div className="hidden md:block rounded-lg border border-card-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr className="text-left">
                {showSelectColumn && (
                  <th className="px-3 py-2.5 w-9">
                    <Checkbox
                      checked={allPendingSelected}
                      onCheckedChange={toggleAll}
                      aria-label="Select all pending"
                      data-testid="checkbox-select-all"
                    />
                  </th>
                )}
                <th className="px-4 py-2.5 font-medium">Date</th>
                <th className="px-4 py-2.5 font-medium">From</th>
                <th className="px-4 py-2.5 font-medium">Well</th>
                <th className="px-4 py-2.5 font-medium">Job / Customer</th>
                <th className="px-4 py-2.5 font-medium">Area</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Document</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isPending = r.status === "Pending Review";
                const isSelected = selected.has(r.id);
                return (
                  <tr
                    key={r.id}
                    onClick={() => navigate(`/daily-reports/${r.id}`)}
                    className="border-t border-card-border cursor-pointer hover:bg-muted/40"
                    data-testid={`row-daily-report-${r.id}`}
                  >
                    {showSelectColumn && (
                      <td
                        className="px-3 py-2.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {isPending ? (
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={() => toggleRow(r.id)}
                            aria-label="Select report"
                            data-testid={`checkbox-report-${r.id}`}
                          />
                        ) : null}
                      </td>
                    )}
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      {fmt(r.report_date || r.received_at)}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="truncate max-w-[180px] inline-block align-middle">
                        {r.sender_name || r.sender_email || "—"}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="truncate max-w-[160px]">{r.well_name || "—"}</div>
                      {r.report_day != null && (
                        <div className="text-xs text-muted-foreground">Day {r.report_day}</div>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="font-medium">{r.job_number || "—"}</div>
                      <div className="text-xs text-muted-foreground truncate max-w-[200px]">
                        {r.customer_name || "Unlinked"}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">{r.area || "—"}</td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_TONE[r.status]}`}>
                        {r.status}
                      </span>
                    </td>
                    <td
                      className="px-4 py-2.5 whitespace-nowrap"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {r.has_attachment ? (
                        <div className="flex items-center gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2"
                            disabled={docBusy !== null}
                            onClick={() => openReportDoc(r.id, r.attachment_name, "view")}
                            data-testid={`button-view-doc-${r.id}`}
                          >
                            {docBusy === `${r.id}:view` ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Eye className="h-4 w-4" />
                            )}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2"
                            disabled={docBusy !== null}
                            onClick={() => openReportDoc(r.id, r.attachment_name, "download")}
                            data-testid={`button-download-doc-${r.id}`}
                          >
                            {docBusy === `${r.id}:download` ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Download className="h-4 w-4" />
                            )}
                          </Button>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Mobile card list */}
        <div className="md:hidden space-y-2">
          {rows.map((r) => {
            const isPending = r.status === "Pending Review";
            const isSelected = selected.has(r.id);
            return (
              <div
                key={r.id}
                onClick={() => navigate(`/daily-reports/${r.id}`)}
                className="rounded-lg border border-card-border bg-card p-3 active:bg-muted/40"
                data-testid={`card-daily-report-${r.id}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium truncate">
                      {r.well_name || "—"}
                      {r.report_day != null && (
                        <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                          Day {r.report_day}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {fmt(r.report_date || r.received_at)}
                      {r.area ? ` · ${r.area}` : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_TONE[r.status]}`}>
                      {r.status}
                    </span>
                    {showSelectColumn && isPending && (
                      <span onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleRow(r.id)}
                          aria-label="Select report"
                          data-testid={`checkbox-card-report-${r.id}`}
                        />
                      </span>
                    )}
                  </div>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                  <div>
                    <div className="text-muted-foreground">Job / Customer</div>
                    <div className="font-medium truncate">{r.job_number || "—"}</div>
                    <div className="text-muted-foreground truncate">{r.customer_name || "Unlinked"}</div>
                  </div>
                  <div className="min-w-0">
                    <div className="text-muted-foreground">From</div>
                    <div className="truncate">{r.sender_name || r.sender_email || "—"}</div>
                  </div>
                </div>
                {r.has_attachment && (
                  <div
                    className="mt-2 flex items-center gap-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7"
                      disabled={docBusy !== null}
                      onClick={() => openReportDoc(r.id, r.attachment_name, "view")}
                      data-testid={`button-view-doc-card-${r.id}`}
                    >
                      {docBusy === `${r.id}:view` ? (
                        <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                      ) : (
                        <Eye className="mr-1.5 h-4 w-4" />
                      )}
                      View
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7"
                      disabled={docBusy !== null}
                      onClick={() => openReportDoc(r.id, r.attachment_name, "download")}
                      data-testid={`button-download-doc-card-${r.id}`}
                    >
                      {docBusy === `${r.id}:download` ? (
                        <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                      ) : (
                        <Download className="mr-1.5 h-4 w-4" />
                      )}
                      Download
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        </>
      )}
    </div>
  );
}
