import { useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { ExportReportsDialog } from "@/components/ExportReportsDialog";
import {
  exportMaintenanceReportsPdf,
  type MaintenanceExportReport,
} from "@/lib/reportExport";
import {
  WORK_TYPES,
  WORK_ORDER_TYPES,
  WORK_ORDER_PRIORITIES,
  WORK_ORDER_STATUSES,
  serviceStatusFor,
  tracksRunHours,
} from "@shared/schema";
import type {
  Asset,
  MaintenanceMatrixRow,
  MaintenanceReportFileWithLinks,
  AssetDetail,
  WorkType,
  ServiceState,
  WorkOrderWithLinks,
  WorkOrderType,
  WorkOrderPriority,
  WorkOrderStatus,
} from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  ClipboardList,
  Search,
  X,
  Wrench,
  Upload,
  FileText,
  Download,
  Trash2,
  Loader2,
  PlusCircle,
  Boxes,
  Pencil,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB client cap

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

// Service-state pill for run-hour assets.
function ServiceStatePill({ state }: { state: ServiceState }) {
  const cls =
    state === "Overdue"
      ? "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20"
      : state === "Soon"
        ? "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20"
        : state === "OK"
          ? "bg-primary/10 text-primary border-primary/20"
          : "bg-muted text-muted-foreground border-card-border";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}
    >
      {state === "No baseline" ? "No baseline" : `Service ${state.toLowerCase()}`}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Log-maintenance form (records a maintenance_reports entry via /api/reports)
// ---------------------------------------------------------------------------
function LogEntryForm({
  asset,
  onLogged,
}: {
  asset: MaintenanceMatrixRow;
  onLogged: () => void;
}) {
  const { toast } = useToast();
  const isRunHour = tracksRunHours(asset.category);
  const today = new Date().toISOString().slice(0, 10);
  const [workType, setWorkType] = useState<WorkType>("Preventive");
  const [reportDate, setReportDate] = useState(today);
  const [runHours, setRunHours] = useState("");
  const [notes, setNotes] = useState("");

  const mutation = useMutation({
    mutationFn: async () => {
      const body: any = {
        asset_id: asset.id,
        work_type: workType,
        report_date: reportDate,
        notes: notes.trim() ? notes.trim() : null,
      };
      if (isRunHour && runHours.trim() !== "")
        body.run_hours = Number(runHours);
      const res = await apiRequest("POST", "/api/reports", body);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Maintenance logged" });
      setWorkType("Preventive");
      setReportDate(today);
      setRunHours("");
      setNotes("");
      onLogged();
    },
    onError: (e: any) =>
      toast({
        title: "Could not log maintenance",
        description: e.message,
        variant: "destructive",
      }),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate();
      }}
      className="space-y-3"
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Work type</Label>
          <Select
            value={workType}
            onValueChange={(v) => setWorkType(v as WorkType)}
          >
            <SelectTrigger data-testid="select-work-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WORK_TYPES.map((w) => (
                <SelectItem key={w} value={w}>
                  {w}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="me-date">Date</Label>
          <Input
            id="me-date"
            type="date"
            value={reportDate}
            max={today}
            onChange={(e) => setReportDate(e.target.value)}
            data-testid="input-report-date"
          />
        </div>
      </div>

      {isRunHour && (
        <div className="space-y-1.5">
          <Label htmlFor="me-hours">Run-hours meter (optional)</Label>
          <Input
            id="me-hours"
            type="number"
            min={0}
            inputMode="numeric"
            value={runHours}
            onChange={(e) => setRunHours(e.target.value)}
            placeholder={
              asset.run_hours != null
                ? `Current: ${asset.run_hours.toLocaleString()}`
                : "e.g. 1200"
            }
            data-testid="input-run-hours"
          />
          <p className="text-xs text-muted-foreground">
            Updates the asset meter and resets the service baseline.
          </p>
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="me-notes">Notes</Label>
        <Textarea
          id="me-notes"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="What was done, parts replaced, findings…"
          data-testid="input-notes"
        />
      </div>

      <Button
        type="submit"
        disabled={mutation.isPending}
        className="w-full"
        data-testid="button-log-maintenance"
      >
        {mutation.isPending ? (
          <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
        ) : (
          <PlusCircle className="h-4 w-4 mr-1.5" />
        )}
        Log maintenance
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Upload-maintenance-report form (attaches a PDF to the asset)
// ---------------------------------------------------------------------------
function UploadFileForm({
  assetId,
  onUploaded,
}: {
  assetId: string;
  onUploaded: () => void;
}) {
  const { toast } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [workPerformed, setWorkPerformed] = useState("");
  const [notes, setNotes] = useState("");

  const mutation = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Choose a PDF to upload");
      if (file.size > MAX_BYTES) throw new Error("File is larger than 20 MB");
      if (!workPerformed.trim())
        throw new Error("Describe the work performed");
      const file_base64 = await fileToBase64(file);
      const res = await apiRequest(
        "POST",
        `/api/assets/${assetId}/maintenance-files`,
        {
          file_name: file.name,
          file_mime: file.type || "application/pdf",
          file_base64,
          work_performed: workPerformed.trim(),
          notes: notes.trim() ? notes.trim() : null,
        },
      );
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Report uploaded" });
      setFile(null);
      setWorkPerformed("");
      setNotes("");
      onUploaded();
    },
    onError: (e: any) =>
      toast({
        title: "Could not upload report",
        description: e.message,
        variant: "destructive",
      }),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate();
      }}
      className="space-y-3"
    >
      <div className="space-y-1.5">
        <Label htmlFor="mf-file">Maintenance report (PDF)</Label>
        <Input
          id="mf-file"
          type="file"
          accept="application/pdf,.pdf"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          data-testid="input-file"
        />
        {file && (
          <p className="text-xs text-muted-foreground">
            {file.name} · {fmtSize(file.size)}
          </p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="mf-work">
          Work performed <span className="text-red-600">*</span>
        </Label>
        <Textarea
          id="mf-work"
          rows={3}
          required
          value={workPerformed}
          onChange={(e) => setWorkPerformed(e.target.value)}
          placeholder="What maintenance was performed on this asset…"
          data-testid="input-work-performed"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="mf-notes">Notes (optional)</Label>
        <Textarea
          id="mf-notes"
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Short description of the report…"
          data-testid="input-file-notes"
        />
      </div>
      <Button
        type="submit"
        disabled={mutation.isPending || !file || !workPerformed.trim()}
        className="w-full"
        data-testid="button-upload-report"
      >
        {mutation.isPending ? (
          <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
        ) : (
          <Upload className="h-4 w-4 mr-1.5" />
        )}
        Upload report
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Per-asset detail panel (side sheet): log entry + upload + history
// ---------------------------------------------------------------------------
function AssetPanel({
  asset,
  canManage,
  onClose,
}: {
  asset: MaintenanceMatrixRow;
  canManage: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();

  // Logged maintenance entries come from the asset detail endpoint (history).
  const detailQ = useQuery<AssetDetail>({
    queryKey: ["/api/assets", asset.id],
    enabled: !!asset.id,
  });
  const filesQ = useQuery<MaintenanceReportFileWithLinks[]>({
    queryKey: ["/api/assets", asset.id, "maintenance-files"],
    enabled: !!asset.id,
  });

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["/api/assets", asset.id] });
    queryClient.invalidateQueries({
      queryKey: ["/api/assets", asset.id, "maintenance-files"],
    });
    queryClient.invalidateQueries({ queryKey: ["/api/maintenance-matrix"] });
  }

  async function viewFile(f: MaintenanceReportFileWithLinks) {
    try {
      const res = await apiRequest(
        "GET",
        `/api/maintenance-files/${f.id}/file`,
      );
      const blob = await res.blob();
      const pdfBlob =
        blob.type === "application/pdf"
          ? blob
          : new Blob([blob], { type: f.file_mime || "application/pdf" });
      const url = URL.createObjectURL(pdfBlob);
      const win = window.open(url, "_blank");
      if (!win) {
        const a = document.createElement("a");
        a.href = url;
        a.download = f.file_name || "maintenance-report.pdf";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e: any) {
      toast({
        title: "Could not open file",
        description: e.message,
        variant: "destructive",
      });
    }
  }

  const delFile = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/maintenance-files/${id}`);
    },
    onSuccess: () => {
      toast({ title: "Report removed" });
      refresh();
    },
    onError: (e: any) =>
      toast({
        title: "Could not remove report",
        description: e.message,
        variant: "destructive",
      }),
  });

  const files = filesQ.data ?? [];
  const history = detailQ.data?.history ?? [];

  return (
    <SheetContent
      side="right"
      className="w-full sm:max-w-xl overflow-y-auto"
      data-testid="panel-asset"
    >
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2">
          <Wrench className="h-4 w-4" />
          {asset.tag}
        </SheetTitle>
        <SheetDescription>
          {asset.category} · {asset.area} · {asset.status}
        </SheetDescription>
      </SheetHeader>

      <div className="mt-5 space-y-6">
        {/* Input forms (managers/supervisors/admin only) */}
        {canManage ? (
          <div className="grid grid-cols-1 gap-5">
            <section className="rounded-lg border border-card-border p-4">
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
                <PlusCircle className="h-4 w-4 text-muted-foreground" />
                Log maintenance info
              </h3>
              <LogEntryForm asset={asset} onLogged={refresh} />
            </section>
            <section className="rounded-lg border border-card-border p-4">
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
                <Upload className="h-4 w-4 text-muted-foreground" />
                Upload a maintenance report
              </h3>
              <UploadFileForm assetId={asset.id} onUploaded={refresh} />
            </section>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-4 text-sm text-muted-foreground">
            You have view-only access to this asset's maintenance records.
          </div>
        )}

        {/* Uploaded report files */}
        <section>
          <h3 className="text-sm font-semibold mb-2 flex items-center gap-1.5">
            <FileText className="h-4 w-4 text-muted-foreground" />
            Uploaded reports
            <span className="text-xs font-normal text-muted-foreground">
              ({files.length})
            </span>
          </h3>
          {filesQ.isLoading ? (
            <div className="text-sm text-muted-foreground py-4 text-center">
              Loading…
            </div>
          ) : files.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No report files uploaded for this asset yet.
            </p>
          ) : (
            <ul className="divide-y divide-card-border rounded-lg border border-card-border">
              {files.map((f) => (
                <li
                  key={f.id}
                  className="flex items-center justify-between gap-2 px-3 py-2.5"
                  data-testid={`row-mfile-${f.id}`}
                >
                  <div className="min-w-0">
                    <div className="font-medium text-sm break-all">
                      {f.file_name}
                    </div>
                    {f.work_performed && (
                      <div className="text-sm text-foreground mt-0.5 break-words">
                        {f.work_performed}
                      </div>
                    )}
                    <div className="text-xs text-muted-foreground">
                      {fmtSize(f.file_size)} · {fmtDate(f.created_at)}
                      {f.uploaded_by_name ? ` · ${f.uploaded_by_name}` : ""}
                      {f.notes ? ` · ${f.notes}` : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => viewFile(f)}
                      data-testid={`button-view-mfile-${f.id}`}
                    >
                      <Download className="mr-1.5 h-3.5 w-3.5" />
                      View
                    </Button>
                    {canManage && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          if (
                            window.confirm(
                              `Remove "${f.file_name}"? This cannot be undone.`,
                            )
                          )
                            delFile.mutate(f.id);
                        }}
                        disabled={delFile.isPending}
                        data-testid={`button-delete-mfile-${f.id}`}
                        aria-label="Remove report"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Logged maintenance entries */}
        <section>
          <h3 className="text-sm font-semibold mb-2 flex items-center gap-1.5">
            <ClipboardList className="h-4 w-4 text-muted-foreground" />
            Maintenance log
            <span className="text-xs font-normal text-muted-foreground">
              ({history.length})
            </span>
          </h3>
          {detailQ.isLoading ? (
            <div className="text-sm text-muted-foreground py-4 text-center">
              Loading…
            </div>
          ) : history.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No maintenance entries logged for this asset yet.
            </p>
          ) : (
            <ul className="divide-y divide-card-border rounded-lg border border-card-border">
              {history.map((h) => (
                <li
                  key={h.id}
                  className="px-3 py-2.5"
                  data-testid={`row-mentry-${h.id}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-sm">{h.work_type}</span>
                    <span className="text-xs text-muted-foreground">
                      {fmtDate(h.report_date)}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {h.status}
                    {h.supervisor_name ? ` · ${h.supervisor_name}` : ""}
                  </div>
                  {h.notes && (
                    <p className="text-sm text-muted-foreground mt-1">
                      {h.notes}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </SheetContent>
  );
}

// ---------------------------------------------------------------------------
// Quick-upload dialog: pick an asset, then upload a report — reachable from a
// prominent button in the page header so users don't have to open each asset.
// ---------------------------------------------------------------------------
function QuickUploadDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [assetId, setAssetId] = useState<string>("");

  // Pull the full asset list (area-scoped by the server) so a report can be
  // uploaded against ANY asset, not just those currently in the yard/shop.
  const { data: assets = [], isLoading } = useQuery<Asset[]>({
    queryKey: ["/api/assets"],
    enabled: open,
  });
  const chosen = assets.find((a) => a.id === assetId) ?? null;

  // Reset the picked asset whenever the dialog is closed.
  function handleOpenChange(o: boolean) {
    if (!o) setAssetId("");
    onOpenChange(o);
  }

  function afterUpload() {
    queryClient.invalidateQueries({ queryKey: ["/api/maintenance-matrix"] });
    if (chosen) {
      queryClient.invalidateQueries({ queryKey: ["/api/assets", chosen.id] });
      queryClient.invalidateQueries({
        queryKey: ["/api/assets", chosen.id, "maintenance-files"],
      });
    }
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-4 w-4" />
            Upload maintenance report
          </DialogTitle>
          <DialogDescription>
            Choose the asset this report is for, then attach the PDF.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>
              Asset <span className="text-red-600">*</span>
            </Label>
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading assets…</p>
            ) : assets.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                There are no assets to upload against yet.
              </p>
            ) : (
              <Select value={assetId} onValueChange={setAssetId}>
                <SelectTrigger data-testid="select-quick-upload-asset">
                  <SelectValue placeholder="Select an asset…" />
                </SelectTrigger>
                <SelectContent>
                  {assets.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.tag} · {a.category} · {a.area}
                      {a.job_id ? " · in field" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {chosen ? (
            <div className="rounded-lg border border-card-border p-4">
              <UploadFileForm assetId={chosen.id} onUploaded={afterUpload} />
            </div>
          ) : (
            assets.length > 0 && (
              <p className="text-sm text-muted-foreground">
                Select an asset above to continue.
              </p>
            )
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Work Orders — status/priority/type badge helpers
// ---------------------------------------------------------------------------
type Assignee = { id: string; name: string; role: string; area: string | null };

function woStatusClass(s: WorkOrderStatus): string {
  switch (s) {
    case "Overdue":
      return "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20";
    case "Awaiting Parts":
      return "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20";
    case "In Progress":
      return "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20";
    case "Completed":
      return "bg-primary/10 text-primary border-primary/20";
    default: // Scheduled
      return "bg-muted text-muted-foreground border-card-border";
  }
}

function woPriorityClass(p: WorkOrderPriority): string {
  switch (p) {
    case "High":
      return "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20";
    case "Medium":
      return "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20";
    default: // Low
      return "bg-muted text-muted-foreground border-card-border";
  }
}

function Pill({ text, cls }: { text: string; cls: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${cls}`}
    >
      {text}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Work Order create/edit dialog
// ---------------------------------------------------------------------------
function WorkOrderDialog({
  open,
  onOpenChange,
  editing,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  editing: WorkOrderWithLinks | null;
}) {
  const { toast } = useToast();
  const isEdit = !!editing;

  const [assetId, setAssetId] = useState("");
  const [title, setTitle] = useState("");
  const [woType, setWoType] = useState<WorkOrderType>("Preventive");
  const [priority, setPriority] = useState<WorkOrderPriority>("Medium");
  const [status, setStatus] = useState<WorkOrderStatus>("Scheduled");
  const [assignedTo, setAssignedTo] = useState<string>("");
  const [dueDate, setDueDate] = useState("");
  const [estHours, setEstHours] = useState("");
  const [notes, setNotes] = useState("");

  // Seed the form when opening (create = blank, edit = existing values).
  useMemo(() => {
    if (!open) return;
    if (editing) {
      setAssetId(editing.asset_id);
      setTitle(editing.title);
      setWoType(editing.wo_type);
      setPriority(editing.priority);
      setStatus(editing.status);
      setAssignedTo(editing.assigned_to ?? "");
      setDueDate(editing.due_date ?? "");
      setEstHours(editing.est_hours != null ? String(editing.est_hours) : "");
      setNotes(editing.notes ?? "");
    } else {
      setAssetId("");
      setTitle("");
      setWoType("Preventive");
      setPriority("Medium");
      setStatus("Scheduled");
      setAssignedTo("");
      setDueDate("");
      setEstHours("");
      setNotes("");
    }
  }, [open, editing]);

  // Asset picker (create only). Area-scoped list from the server.
  const { data: assets = [] } = useQuery<Asset[]>({
    queryKey: ["/api/assets"],
    enabled: open && !isEdit,
  });
  // Assignable people (area-scoped).
  const { data: assignees = [] } = useQuery<Assignee[]>({
    queryKey: ["/api/work-orders/assignees"],
    enabled: open,
  });

  const mutation = useMutation({
    mutationFn: async () => {
      if (!isEdit && !assetId) throw new Error("Choose an asset");
      if (!title.trim()) throw new Error("A task title is required");
      const body: any = {
        title: title.trim(),
        wo_type: woType,
        priority,
        status,
        assigned_to: assignedTo || null,
        due_date: dueDate || null,
        est_hours: estHours.trim() !== "" ? Number(estHours) : null,
        notes: notes.trim() ? notes.trim() : null,
      };
      if (isEdit) {
        const res = await apiRequest(
          "PATCH",
          `/api/work-orders/${editing!.id}`,
          body,
        );
        return res.json();
      }
      body.asset_id = assetId;
      const res = await apiRequest("POST", "/api/work-orders", body);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: isEdit ? "Work order updated" : "Work order created" });
      queryClient.invalidateQueries({ queryKey: ["/api/work-orders"] });
      onOpenChange(false);
    },
    onError: (e: any) =>
      toast({
        title: isEdit
          ? "Could not update work order"
          : "Could not create work order",
        description: e.message,
        variant: "destructive",
      }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wrench className="h-4 w-4" />
            {isEdit ? `Edit ${editing!.wo_number}` : "New work order"}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update the work order, reassign it, or change its status."
              : "Create a maintenance task against an asset."}
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
          className="space-y-3"
        >
          {isEdit ? (
            <div className="rounded-md border border-card-border bg-muted/30 px-3 py-2 text-sm">
              <span className="font-medium">{editing!.asset_tag}</span>
              <span className="text-muted-foreground">
                {" "}
                · {editing!.asset_category} · {editing!.area}
              </span>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label>
                Asset <span className="text-red-600">*</span>
              </Label>
              <Select value={assetId} onValueChange={setAssetId}>
                <SelectTrigger data-testid="select-wo-asset">
                  <SelectValue placeholder="Select an asset…" />
                </SelectTrigger>
                <SelectContent>
                  {assets.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.tag} · {a.category} · {a.area}
                      {a.job_id ? " · in field" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="wo-title">
              Task <span className="text-red-600">*</span>
            </Label>
            <Input
              id="wo-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. 500-hr service — oil, filters, coolant"
              data-testid="input-wo-title"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select
                value={woType}
                onValueChange={(v) => setWoType(v as WorkOrderType)}
              >
                <SelectTrigger data-testid="select-wo-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WORK_ORDER_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Priority</Label>
              <Select
                value={priority}
                onValueChange={(v) => setPriority(v as WorkOrderPriority)}
              >
                <SelectTrigger data-testid="select-wo-priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WORK_ORDER_PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select
                value={status}
                onValueChange={(v) => setStatus(v as WorkOrderStatus)}
              >
                <SelectTrigger data-testid="select-wo-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WORK_ORDER_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Assigned to</Label>
              <Select
                value={assignedTo || "__none"}
                onValueChange={(v) => setAssignedTo(v === "__none" ? "" : v)}
              >
                <SelectTrigger data-testid="select-wo-assignee">
                  <SelectValue placeholder="Unassigned" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">Unassigned</SelectItem>
                  {assignees.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="wo-due">Due date</Label>
              <Input
                id="wo-due"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                data-testid="input-wo-due"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wo-hours">Est. hours</Label>
              <Input
                id="wo-hours"
                type="number"
                min={0}
                inputMode="numeric"
                value={estHours}
                onChange={(e) => setEstHours(e.target.value)}
                placeholder="e.g. 6"
                data-testid="input-wo-hours"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="wo-notes">Notes</Label>
            <Textarea
              id="wo-notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Parts needed, findings, context…"
              data-testid="input-wo-notes"
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={mutation.isPending}
              data-testid="button-save-wo"
            >
              {mutation.isPending && (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              )}
              {isEdit ? "Save changes" : "Create work order"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Work Orders tab: KPI cards + filterable table
// ---------------------------------------------------------------------------
function WorkOrdersTab({ canManage }: { canManage: boolean }) {
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<WorkOrderWithLinks | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("All");

  const { data, isLoading } = useQuery<WorkOrderWithLinks[]>({
    queryKey: ["/api/work-orders"],
  });

  const delMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/work-orders/${id}`);
    },
    onSuccess: () => {
      toast({ title: "Work order deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/work-orders"] });
    },
    onError: (e: any) =>
      toast({
        title: "Could not delete work order",
        description: e.message,
        variant: "destructive",
      }),
  });

  const all = data ?? [];
  const kpis = useMemo(() => {
    const open = all.filter((w) => w.status !== "Completed").length;
    const overdue = all.filter((w) => w.status === "Overdue").length;
    const awaiting = all.filter((w) => w.status === "Awaiting Parts").length;
    const completed = all.filter((w) => w.status === "Completed").length;
    return { open, overdue, awaiting, completed };
  }, [all]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((w) => {
      if (statusFilter !== "All" && w.status !== statusFilter) return false;
      if (!q) return true;
      return [
        w.wo_number,
        w.asset_tag ?? "",
        w.title,
        w.wo_type,
        w.assigned_to_name ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [all, query, statusFilter]);

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }
  function openEdit(w: WorkOrderWithLinks) {
    setEditing(w);
    setDialogOpen(true);
  }

  return (
    <div>
      {/* KPI cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        {[
          { label: "Open work orders", value: kpis.open, icon: ClipboardList },
          { label: "Overdue", value: kpis.overdue, icon: AlertTriangle },
          { label: "Awaiting parts", value: kpis.awaiting, icon: Wrench },
          { label: "Completed", value: kpis.completed, icon: CheckCircle2 },
        ].map((k) => (
          <div
            key={k.label}
            className="rounded-lg border border-card-border p-4"
            data-testid={`kpi-${k.label}`}
          >
            <div className="flex items-center justify-between">
              <span className="text-2xl font-semibold tabular-nums">
                {k.value}
              </span>
              <k.icon className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="text-xs text-muted-foreground mt-1">{k.label}</div>
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search WO#, asset, task, tech…"
            className="pl-9"
            data-testid="input-search-wo"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[160px]" data-testid="select-wo-filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="All">All statuses</SelectItem>
            {WORK_ORDER_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {canManage && (
          <Button onClick={openCreate} data-testid="button-new-wo">
            <PlusCircle className="h-4 w-4 mr-1.5" />
            New work order
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground py-10 text-center">
          Loading…
        </div>
      ) : all.length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-10 text-center">
          <Wrench className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
          <div className="text-sm text-muted-foreground">
            No work orders yet.
          </div>
          {canManage && (
            <div className="text-xs text-muted-foreground mt-1">
              Create one to start tracking maintenance tasks.
            </div>
          )}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-10 text-center">
          <Search className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
          <div className="text-sm text-muted-foreground">
            No work orders match your filters.
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-card-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-card-border bg-muted/40 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">WO #</th>
                <th className="px-3 py-2 font-medium">Asset</th>
                <th className="px-3 py-2 font-medium">Task</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Priority</th>
                <th className="px-3 py-2 font-medium">Assigned</th>
                <th className="px-3 py-2 font-medium">Due</th>
                <th className="px-3 py-2 font-medium">Status</th>
                {canManage && (
                  <th className="px-3 py-2 font-medium text-right"></th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <tr
                  key={w.id}
                  className="border-b border-card-border last:border-0 hover:bg-muted/30"
                  data-testid={`row-wo-${w.id}`}
                >
                  <td className="px-3 py-2.5 font-medium whitespace-nowrap text-primary">
                    {w.wo_number}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <div className="font-medium">{w.asset_tag ?? "—"}</div>
                    <div className="text-xs text-muted-foreground">
                      {w.asset_category ?? ""}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 max-w-[260px]">{w.title}</td>
                  <td className="px-3 py-2.5 text-muted-foreground whitespace-nowrap">
                    {w.wo_type}
                  </td>
                  <td className="px-3 py-2.5">
                    <Pill
                      text={w.priority}
                      cls={woPriorityClass(w.priority)}
                    />
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-muted-foreground">
                    {w.assigned_to_name ?? "—"}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-muted-foreground">
                    {fmtDate(w.due_date)}
                  </td>
                  <td className="px-3 py-2.5">
                    <Pill text={w.status} cls={woStatusClass(w.status)} />
                  </td>
                  {canManage && (
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openEdit(w)}
                        data-testid={`button-edit-wo-${w.id}`}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ml-1.5"
                        onClick={() => {
                          if (
                            window.confirm(
                              `Delete ${w.wo_number}? This cannot be undone.`,
                            )
                          )
                            delMutation.mutate(w.id);
                        }}
                        disabled={delMutation.isPending}
                        data-testid={`button-delete-wo-${w.id}`}
                        aria-label="Delete work order"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canManage && (
        <WorkOrderDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          editing={editing}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Asset matrix tab (the original maintenance matrix)
// ---------------------------------------------------------------------------
function MatrixTab({ canManage }: { canManage: boolean }) {
  const { profile } = useAuth();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<MaintenanceMatrixRow | null>(null);

  const { data, isLoading } = useQuery<MaintenanceMatrixRow[]>({
    queryKey: ["/api/maintenance-matrix"],
  });

  const rows = useMemo(() => {
    const all = data ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((a) =>
      [a.tag, a.category, a.area, a.status, a.description ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [data, query]);

  return (
    <div>
      <p className="text-sm text-muted-foreground mb-4">
        Asset matrix of equipment not in the field — in the yard or shop for
        maintenance.{" "}
        {profile?.role === "admin"
          ? "You can see assets across all areas."
          : `Showing assets in ${profile?.area ?? "your area"}.`}{" "}
        {canManage
          ? "Select an asset to log maintenance info or upload a report."
          : "Select an asset to view its maintenance records."}
      </p>

      {(data?.length ?? 0) > 0 && (
        <div className="relative mb-4 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search asset #, type, area, status…"
            className="pl-9 pr-9"
            data-testid="input-search-matrix"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="text-sm text-muted-foreground py-10 text-center">
          Loading…
        </div>
      ) : (data?.length ?? 0) === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-10 text-center">
          <Boxes className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
          <div className="text-sm text-muted-foreground">
            No assets are out of the field right now.
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            Assets appear here when they are not assigned to a job.
          </div>
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-10 text-center">
          <Search className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
          <div className="text-sm text-muted-foreground">
            No assets match “{query}”.
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-card-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-card-border bg-muted/40 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Asset #</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Area</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Service</th>
                <th className="px-3 py-2 font-medium text-right">Records</th>
                <th className="px-3 py-2 font-medium">Last activity</th>
                <th className="px-3 py-2 font-medium text-right"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const svc = tracksRunHours(a.category)
                  ? serviceStatusFor(a)
                  : null;
                return (
                  <tr
                    key={a.id}
                    className="border-b border-card-border last:border-0 hover:bg-muted/30 cursor-pointer"
                    onClick={() => setSelected(a)}
                    data-testid={`row-asset-${a.id}`}
                  >
                    <td className="px-3 py-2.5 font-medium">{a.tag}</td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      {a.category}
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">{a.area}</td>
                    <td className="px-3 py-2.5">{a.status}</td>
                    <td className="px-3 py-2.5">
                      {svc ? <ServiceStatePill state={svc.state} /> : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                      {a.entry_count} logged · {a.file_count} file
                      {a.file_count === 1 ? "" : "s"}
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-muted-foreground">
                      {fmtDate(a.last_activity)}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelected(a);
                        }}
                        data-testid={`button-open-asset-${a.id}`}
                      >
                        {canManage ? "Manage" : "View"}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Sheet
        open={!!selected}
        onOpenChange={(o) => {
          if (!o) setSelected(null);
        }}
      >
        {selected && (
          <AssetPanel
            asset={selected}
            canManage={canManage}
            onClose={() => setSelected(null)}
          />
        )}
      </Sheet>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function MaintenancePage() {
  const { profile } = useAuth();
  const canManage =
    profile?.role === "admin" ||
    profile?.role === "area" ||
    profile?.role === "super";

  const [tab, setTab] = useState("matrix");
  const [quickUploadOpen, setQuickUploadOpen] = useState(false);

  return (
    <div className="p-6 max-w-6xl">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <ClipboardList className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Maintenance</h1>
        </div>
        <div className="flex items-center gap-2">
          <ExportReportsDialog<MaintenanceExportReport>
            title="Export maintenance reports"
            description="Generate a branded PDF of filed maintenance reports over a date range."
            endpoint="/api/maintenance-reports/export.json"
            helpText="Includes each report's asset, area, work type, status, supervisor, and notes. Scoped to your area."
            render={(report, generatedBy) =>
              exportMaintenanceReportsPdf(report, { generatedBy })
            }
          />
          {canManage && tab === "matrix" && (
            <Button
              onClick={() => setQuickUploadOpen(true)}
              data-testid="button-quick-upload"
            >
              <Upload className="h-4 w-4 mr-1.5" />
              Upload maintenance report
            </Button>
          )}
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="matrix" data-testid="tab-matrix">
            Asset matrix
          </TabsTrigger>
          <TabsTrigger value="work-orders" data-testid="tab-work-orders">
            Work orders
          </TabsTrigger>
        </TabsList>

        <TabsContent value="matrix">
          <MatrixTab canManage={canManage} />
        </TabsContent>
        <TabsContent value="work-orders">
          <WorkOrdersTab canManage={canManage} />
        </TabsContent>
      </Tabs>

      {canManage && (
        <QuickUploadDialog
          open={quickUploadOpen}
          onOpenChange={setQuickUploadOpen}
        />
      )}
    </div>
  );
}
