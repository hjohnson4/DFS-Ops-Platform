import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  WORK_ORDER_TYPES,
  WORK_ORDER_PRIORITIES,
  WORK_ORDER_STATUSES,
  WORK_ORDER_OPEN_STATUSES,
  WORK_ORDER_INVOICE_MAX_BYTES,
} from "@shared/schema";
import type {
  Asset,
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  ClipboardList,
  Search,
  Wrench,
  Trash2,
  Loader2,
  PlusCircle,
  Pencil,
  CheckCircle2,
  AlertTriangle,
  DollarSign,
  Upload,
  PackageCheck,
  X,
} from "lucide-react";
import { fmtMoney, fmtWoDate as fmtDate, InvoiceButton } from "@/components/RefurbishmentHistory";

// ---------------------------------------------------------------------------
// Work Orders (Service module) — machines sent to a third party for
// refurbishment. A work order records where the machine went and when; at
// close-out it records the vendor invoice (file, number, total) and what was
// done. Closed work orders roll up into refurbishment cost per asset.
// ---------------------------------------------------------------------------

const CENTRIFUGES = new Set(["Big Bowl Centrifuge", "Small Bowl Centrifuge"]);

function todayIso(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

// Open work orders past their expected-back date count as overdue even if
// nobody changed the status by hand.
function effectiveStatus(w: WorkOrderWithLinks): WorkOrderStatus {
  if (w.status !== "Completed" && w.due_date && w.due_date < todayIso()) return "Overdue";
  return w.status;
}

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

function Pill({ text, cls }: { text: string; cls: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${cls}`}
    >
      {text}
    </span>
  );
}

// Read a File into base64 (no data: prefix) for JSON upload.
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function parseMoney(v: string): number | null {
  const t = v.replace(/[$,\s]/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

function Req() {
  return <span className="text-red-600">*</span>;
}

// ---------------------------------------------------------------------------
// New / edit work order
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
  const isClosed = editing?.status === "Completed";

  const [assetId, setAssetId] = useState("");
  const [title, setTitle] = useState("");
  const [vendor, setVendor] = useState("");
  const [sentOn, setSentOn] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [woType, setWoType] = useState<WorkOrderType>("Refurbishment");
  const [priority, setPriority] = useState<WorkOrderPriority>("Medium");
  const [status, setStatus] = useState<WorkOrderStatus>("In Progress");
  const [notes, setNotes] = useState("");
  // Close-out fields (editable on a closed work order)
  const [returnedOn, setReturnedOn] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceTotal, setInvoiceTotal] = useState("");
  const [workPerformed, setWorkPerformed] = useState("");

  useEffect(() => {
    if (!open) return;
    setAssetId(editing?.asset_id ?? "");
    setTitle(editing?.title ?? "");
    setVendor(editing?.vendor ?? "");
    setSentOn(editing?.sent_on ?? todayIso());
    setDueDate(editing?.due_date ?? "");
    setWoType(editing?.wo_type ?? "Refurbishment");
    setPriority(editing?.priority ?? "Medium");
    setStatus(editing?.status ?? "In Progress");
    setNotes(editing?.notes ?? "");
    setReturnedOn(editing?.returned_on ?? "");
    setInvoiceNumber(editing?.invoice_number ?? "");
    setInvoiceTotal(editing?.invoice_total != null ? String(editing.invoice_total) : "");
    setWorkPerformed(editing?.work_performed ?? "");
  }, [open, editing]);

  const { data: assets = [] } = useQuery<Asset[]>({
    queryKey: ["/api/assets"],
    enabled: open && !isEdit,
  });
  // Centrifuges first (they're what goes out for refurbishment), then the rest.
  const sortedAssets = useMemo(
    () =>
      [...assets].sort((a, b) => {
        const ca = CENTRIFUGES.has(a.category) ? 0 : 1;
        const cb = CENTRIFUGES.has(b.category) ? 0 : 1;
        return ca - cb || a.category.localeCompare(b.category) || a.tag.localeCompare(b.tag, undefined, { numeric: true });
      }),
    [assets],
  );

  const mutation = useMutation({
    mutationFn: async () => {
      if (!isEdit && !assetId) throw new Error("Choose an asset");
      if (!title.trim()) throw new Error("Describe what the machine is going in for");
      if (!vendor.trim()) throw new Error("Enter where the machine was sent");
      if (!sentOn) throw new Error("Enter the date the machine was sent");
      if (dueDate && dueDate < sentOn) throw new Error("Expected back can't be before the date sent");
      const body: any = {
        title: title.trim(),
        vendor: vendor.trim(),
        sent_on: sentOn,
        due_date: dueDate || null,
        wo_type: woType,
        priority,
        notes: notes.trim() ? notes.trim() : null,
      };
      if (!isClosed) body.status = status;
      if (isClosed) {
        const total = parseMoney(invoiceTotal);
        if (total == null || Number.isNaN(total) || total < 0) throw new Error("Enter the invoice total");
        if (!workPerformed.trim()) throw new Error("Describe what was done to the machine");
        if (!returnedOn) throw new Error("Enter the date returned");
        Object.assign(body, {
          returned_on: returnedOn,
          invoice_number: invoiceNumber.trim() || null,
          invoice_total: total,
          work_performed: workPerformed.trim(),
        });
      }
      if (isEdit) {
        const res = await apiRequest("PATCH", `/api/work-orders/${editing!.id}`, body);
        return res.json();
      }
      body.asset_id = assetId;
      const res = await apiRequest("POST", "/api/work-orders", body);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: isEdit ? "Work order updated" : "Work order created" });
      queryClient.invalidateQueries({ queryKey: ["/api/work-orders"] });
      queryClient.invalidateQueries({ queryKey: [`/api/assets/${editing?.asset_id ?? assetId}/refurbishments`] });
      onOpenChange(false);
    },
    onError: (e: any) =>
      toast({
        title: isEdit ? "Could not update work order" : "Could not create work order",
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
              ? isClosed
                ? "This work order is closed out. You can still correct its details."
                : "Update where the machine is, when it's expected back, or its status."
              : "Record a machine going out to a third party for refurbishment."}
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
                Asset <Req />
              </Label>
              <Select value={assetId} onValueChange={setAssetId}>
                <SelectTrigger data-testid="select-wo-asset">
                  <SelectValue placeholder="Select an asset…" />
                </SelectTrigger>
                <SelectContent>
                  {sortedAssets.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.tag}
                      {a.is_rental ? " · RENTAL" : ""} · {a.category} · {a.area}
                      {a.job_id ? " · in field" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="wo-title">
              Going in for <Req />
            </Label>
            <Input
              id="wo-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Full rebuild, bowl and scroll worn"
              data-testid="input-wo-title"
            />
          </div>

          {/* Where and when it was sent */}
          <div className="rounded-md border border-card-border p-3 space-y-3">
            <div className="text-xs font-medium text-muted-foreground">Sent out</div>
            <div className="space-y-1.5">
              <Label htmlFor="wo-vendor">
                Sent to <Req />
              </Label>
              <Input
                id="wo-vendor"
                value={vendor}
                onChange={(e) => setVendor(e.target.value)}
                placeholder="Shop or company the machine went to"
                data-testid="input-wo-vendor"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="wo-sent">
                  Date sent <Req />
                </Label>
                <Input
                  id="wo-sent"
                  type="date"
                  value={sentOn}
                  onChange={(e) => setSentOn(e.target.value)}
                  data-testid="input-wo-sent"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wo-due">Expected back</Label>
                <Input
                  id="wo-due"
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  data-testid="input-wo-due"
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={woType} onValueChange={(v) => setWoType(v as WorkOrderType)}>
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
              <Select value={priority} onValueChange={(v) => setPriority(v as WorkOrderPriority)}>
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
            <div className="space-y-1.5">
              <Label>Status</Label>
              {isClosed ? (
                <div className="h-10 flex items-center">
                  <Pill text="Completed" cls={woStatusClass("Completed")} />
                </div>
              ) : (
                <Select value={status} onValueChange={(v) => setStatus(v as WorkOrderStatus)}>
                  <SelectTrigger data-testid="select-wo-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WORK_ORDER_OPEN_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>

          {isClosed && (
            <div className="rounded-md border border-card-border p-3 space-y-3">
              <div className="text-xs font-medium text-muted-foreground">Close-out</div>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="wo-ret">Date returned</Label>
                  <Input id="wo-ret" type="date" value={returnedOn} onChange={(e) => setReturnedOn(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wo-invno">Invoice #</Label>
                  <Input id="wo-invno" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wo-invtot">Invoice total</Label>
                  <Input
                    id="wo-invtot"
                    inputMode="decimal"
                    value={invoiceTotal}
                    onChange={(e) => setInvoiceTotal(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wo-done">What was done</Label>
                <Textarea id="wo-done" rows={3} value={workPerformed} onChange={(e) => setWorkPerformed(e.target.value)} />
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="wo-notes">Notes</Label>
            <Textarea
              id="wo-notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Quote, contact, shipping, context…"
              data-testid="input-wo-notes"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending} data-testid="button-save-wo">
              {mutation.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              {isEdit ? "Save changes" : "Create work order"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Close out: machine is back — invoice upload, total, and what was done.
// ---------------------------------------------------------------------------
function CloseOutDialog({
  wo,
  onOpenChange,
}: {
  wo: WorkOrderWithLinks | null;
  onOpenChange: (o: boolean) => void;
}) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [returnedOn, setReturnedOn] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceTotal, setInvoiceTotal] = useState("");
  const [workPerformed, setWorkPerformed] = useState("");

  useEffect(() => {
    if (!wo) return;
    setReturnedOn(todayIso());
    setFile(null);
    setInvoiceNumber("");
    setInvoiceTotal("");
    setWorkPerformed("");
  }, [wo]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!returnedOn) throw new Error("Enter the date the machine came back");
      if (wo?.sent_on && returnedOn < wo.sent_on) throw new Error("Date returned can't be before the date sent");
      const total = parseMoney(invoiceTotal);
      if (total == null || Number.isNaN(total) || total < 0) throw new Error("Enter the invoice total");
      if (!workPerformed.trim()) throw new Error("Describe what was done to the machine");
      let invoice_file = null;
      if (file) {
        if (file.size > WORK_ORDER_INVOICE_MAX_BYTES)
          throw new Error("The invoice file is over 3 MB. Save a smaller PDF or photo and try again.");
        invoice_file = { name: file.name, mime: file.type || "application/octet-stream", base64: await fileToBase64(file) };
      }
      const res = await apiRequest("POST", `/api/work-orders/${wo!.id}/close`, {
        returned_on: returnedOn,
        invoice_number: invoiceNumber.trim() || null,
        invoice_total: total,
        work_performed: workPerformed.trim(),
        invoice_file,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: `${wo!.wo_number} closed out`, description: `Added to ${wo!.asset_tag}'s refurbishment history.` });
      queryClient.invalidateQueries({ queryKey: ["/api/work-orders"] });
      queryClient.invalidateQueries({ queryKey: [`/api/assets/${wo!.asset_id}/refurbishments`] });
      onOpenChange(false);
    },
    onError: (e: any) => toast({ title: "Could not close out", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open={!!wo} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PackageCheck className="h-4 w-4" />
            Close out {wo?.wo_number}
          </DialogTitle>
          <DialogDescription>
            {wo ? `${wo.asset_tag} · back from ${wo.vendor || "—"} (sent ${fmtDate(wo.sent_on)})` : ""}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <Label>Vendor invoice</Label>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,image/*,.pdf,.xlsx,.xls,.doc,.docx"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              data-testid="input-wo-invoice-file"
            />
            {file ? (
              <div className="flex items-center justify-between gap-2 rounded-md border border-card-border bg-muted/30 px-3 py-2 text-sm">
                <span className="truncate">{file.name}</span>
                <span className="flex items-center gap-2 shrink-0 text-xs text-muted-foreground">
                  {(file.size / 1024 / 1024).toFixed(1)} MB
                  <button
                    type="button"
                    onClick={() => {
                      setFile(null);
                      if (fileRef.current) fileRef.current.value = "";
                    }}
                    aria-label="Remove file"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </span>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="w-full rounded-md border border-dashed border-card-border bg-muted/30 px-3 py-4 text-sm text-muted-foreground hover:bg-muted/50"
                data-testid="button-wo-invoice-pick"
              >
                <Upload className="h-4 w-4 mx-auto mb-1" />
                Upload the invoice (PDF or photo, up to 3 MB)
              </button>
            )}
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="co-ret">
                Date returned <Req />
              </Label>
              <Input id="co-ret" type="date" value={returnedOn} onChange={(e) => setReturnedOn(e.target.value)} data-testid="input-co-returned" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="co-invno">Invoice #</Label>
              <Input id="co-invno" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} data-testid="input-co-invno" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="co-total">
                Invoice total <Req />
              </Label>
              <div className="relative">
                <DollarSign className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  id="co-total"
                  inputMode="decimal"
                  className="pl-7"
                  value={invoiceTotal}
                  onChange={(e) => setInvoiceTotal(e.target.value)}
                  placeholder="0.00"
                  data-testid="input-co-total"
                />
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="co-done">
              What was done to the machine <Req />
            </Label>
            <Textarea
              id="co-done"
              rows={4}
              value={workPerformed}
              onChange={(e) => setWorkPerformed(e.target.value)}
              placeholder="e.g. Replaced bowl bearings and seals, re-hardfaced scroll, balanced rotating assembly"
              data-testid="input-co-done"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending} data-testid="button-co-save">
              {mutation.isPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-1.5" />}
              Close out
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Work Orders section: KPI cards, work order list, and cost by asset
// ---------------------------------------------------------------------------
export function WorkOrdersSection({ canManage }: { canManage: boolean }) {
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<WorkOrderWithLinks | null>(null);
  const [closing, setClosing] = useState<WorkOrderWithLinks | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("All");
  const [view, setView] = useState<"orders" | "assets">("orders");

  const { data, isLoading, error } = useQuery<WorkOrderWithLinks[]>({
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
      toast({ title: "Could not delete work order", description: e.message, variant: "destructive" }),
  });

  const all = data ?? [];
  const year = new Date().getFullYear();
  const kpis = useMemo(() => {
    const open = all.filter((w) => w.status !== "Completed");
    const overdue = open.filter((w) => effectiveStatus(w) === "Overdue").length;
    const completed = all.filter((w) => w.status === "Completed");
    const ytd = completed
      .filter((w) => (w.returned_on || "").startsWith(String(year)))
      .reduce((s, w) => s + (w.invoice_total || 0), 0);
    const allTime = completed.reduce((s, w) => s + (w.invoice_total || 0), 0);
    return { open: open.length, overdue, completed: completed.length, ytd, allTime };
  }, [all, year]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((w) => {
      if (statusFilter !== "All" && effectiveStatus(w) !== statusFilter) return false;
      if (!q) return true;
      return [w.wo_number, w.asset_tag ?? "", w.title, w.wo_type, w.vendor ?? "", w.invoice_number ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [all, query, statusFilter]);

  // Refurbishment cost rolled up per asset (closed work orders only).
  const byAsset = useMemo(() => {
    const m = new Map<
      string,
      { asset_id: string; tag: string; category: string; count: number; total: number; last_returned: string | null; last_vendor: string | null; out_now: boolean }
    >();
    for (const w of all) {
      const cur =
        m.get(w.asset_id) ??
        { asset_id: w.asset_id, tag: w.asset_tag ?? "—", category: w.asset_category ?? "", count: 0, total: 0, last_returned: null, last_vendor: null, out_now: false };
      if (w.status === "Completed") {
        cur.count += 1;
        cur.total += w.invoice_total || 0;
        if (!cur.last_returned || (w.returned_on || "") > cur.last_returned) {
          cur.last_returned = w.returned_on;
          cur.last_vendor = w.vendor;
        }
      } else cur.out_now = true;
      m.set(w.asset_id, cur);
    }
    const q = query.trim().toLowerCase();
    return Array.from(m.values())
      .filter((r) => !q || `${r.tag} ${r.category} ${r.last_vendor ?? ""}`.toLowerCase().includes(q))
      .sort((a, b) => b.total - a.total || a.tag.localeCompare(b.tag, undefined, { numeric: true }));
  }, [all, query]);

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }
  function openEdit(w: WorkOrderWithLinks) {
    setEditing(w);
    setDialogOpen(true);
  }

  const kpiCards = [
    { label: "Out for refurbishment", value: String(kpis.open), icon: ClipboardList, sub: null as string | null },
    { label: "Past expected back", value: String(kpis.overdue), icon: AlertTriangle, sub: null },
    { label: "Closed out", value: String(kpis.completed), icon: CheckCircle2, sub: null },
    ...(canManage
      ? [{ label: `Refurbishment cost ${year}`, value: fmtMoney(kpis.ytd), icon: DollarSign, sub: `All time ${fmtMoney(kpis.allTime)}` }]
      : []),
  ];

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <Wrench className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Work orders</h2>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Machines sent to a third party for refurbishment. Close one out when the machine comes back to record the
        invoice and what was done. That builds each asset's refurbishment history and cost.
      </p>

      <div className={`grid grid-cols-2 ${canManage ? "sm:grid-cols-4" : "sm:grid-cols-3"} gap-3 mb-4`}>
        {kpiCards.map((k) => (
          <div key={k.label} className="rounded-lg border border-card-border p-4" data-testid={`kpi-${k.label}`}>
            <div className="flex items-center justify-between">
              <span className="text-2xl font-semibold tabular-nums">{k.value}</span>
              <k.icon className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="text-xs text-muted-foreground mt-1">{k.label}</div>
            {k.sub && <div className="text-xs text-muted-foreground">{k.sub}</div>}
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {canManage && (
          <ToggleGroup
            type="single"
            value={view}
            onValueChange={(v) => v && setView(v as "orders" | "assets")}
            className="border border-card-border rounded-md p-0.5"
          >
            <ToggleGroupItem value="orders" className="h-8 px-3 text-xs" data-testid="toggle-wo-orders">
              Work orders
            </ToggleGroupItem>
            <ToggleGroupItem value="assets" className="h-8 px-3 text-xs" data-testid="toggle-wo-assets">
              Cost by asset
            </ToggleGroupItem>
          </ToggleGroup>
        )}
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={view === "orders" ? "Search WO#, asset, task, vendor, invoice…" : "Search asset or vendor…"}
            className="pl-9"
            data-testid="input-search-wo"
          />
        </div>
        {view === "orders" && (
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
        )}
        {canManage && (
          <Button onClick={openCreate} data-testid="button-new-wo">
            <PlusCircle className="h-4 w-4 mr-1.5" />
            New work order
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground py-10 text-center">Loading…</div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {(error as Error).message}
        </div>
      ) : all.length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-10 text-center">
          <Wrench className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
          <div className="text-sm text-muted-foreground">No work orders yet.</div>
          {canManage && (
            <div className="text-xs text-muted-foreground mt-1">
              Create one when a machine goes out to a third party for refurbishment.
            </div>
          )}
        </div>
      ) : view === "assets" ? (
        byAsset.length === 0 ? (
          <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-10 text-center text-sm text-muted-foreground">
            No assets match your search.
          </div>
        ) : (
          <div className="rounded-lg border border-card-border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-card-border bg-muted/40 text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Asset</th>
                  <th className="px-3 py-2 font-medium text-right">Refurbishments</th>
                  <th className="px-3 py-2 font-medium text-right">Total cost</th>
                  <th className="px-3 py-2 font-medium">Last returned</th>
                  <th className="px-3 py-2 font-medium">Last sent to</th>
                  <th className="px-3 py-2 font-medium">Now</th>
                </tr>
              </thead>
              <tbody>
                {byAsset.map((r) => (
                  <tr key={r.asset_id} className="border-b border-card-border last:border-0 hover:bg-muted/30" data-testid={`row-wo-asset-${r.asset_id}`}>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <div className="font-medium">{r.tag}</div>
                      <div className="text-xs text-muted-foreground">{r.category}</div>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{r.count}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-medium">{r.count ? fmtMoney(r.total, true) : "—"}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-muted-foreground">{fmtDate(r.last_returned)}</td>
                    <td className="px-3 py-2.5 text-muted-foreground">{r.last_vendor || "—"}</td>
                    <td className="px-3 py-2.5">
                      {r.out_now ? <Pill text="Out now" cls={woStatusClass("In Progress")} /> : <span className="text-xs text-muted-foreground">In fleet</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="border-t border-card-border px-3 py-2 text-xs text-muted-foreground">
              Open an asset in Assets to see its full refurbishment history.
            </div>
          </div>
        )
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-10 text-center">
          <Search className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
          <div className="text-sm text-muted-foreground">No work orders match your filters.</div>
        </div>
      ) : (
        <div className="rounded-lg border border-card-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-card-border bg-muted/40 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">WO #</th>
                <th className="px-3 py-2 font-medium">Asset</th>
                <th className="px-3 py-2 font-medium">Going in for</th>
                <th className="px-3 py-2 font-medium">Sent to</th>
                <th className="px-3 py-2 font-medium">Sent</th>
                <th className="px-3 py-2 font-medium">Back</th>
                <th className="px-3 py-2 font-medium">Status</th>
                {canManage && <th className="px-3 py-2 font-medium text-right">Cost</th>}
                {canManage && <th className="px-3 py-2 font-medium text-right"></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => {
                const st = effectiveStatus(w);
                const closed = w.status === "Completed";
                return (
                  <tr key={w.id} className="border-b border-card-border last:border-0 hover:bg-muted/30 align-top" data-testid={`row-wo-${w.id}`}>
                    <td className="px-3 py-2.5 font-medium whitespace-nowrap text-primary">{w.wo_number}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <div className="font-medium">{w.asset_tag ?? "—"}</div>
                      <div className="text-xs text-muted-foreground">{w.asset_category ?? ""}</div>
                    </td>
                    <td className="px-3 py-2.5 max-w-[260px]">
                      <div>{w.title}</div>
                      {closed && w.work_performed && (
                        <div className="text-xs text-muted-foreground line-clamp-2" title={w.work_performed}>
                          Done: {w.work_performed}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5">{w.vendor || "—"}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-muted-foreground">{fmtDate(w.sent_on)}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-muted-foreground">
                      {closed ? (
                        fmtDate(w.returned_on)
                      ) : w.due_date ? (
                        <span title="Expected back">exp. {fmtDate(w.due_date)}</span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <Pill text={st} cls={woStatusClass(st)} />
                    </td>
                    {canManage && (
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        {closed ? (
                          <>
                            <div className="font-medium tabular-nums">{fmtMoney(w.invoice_total, true)}</div>
                            {w.invoice_size ? <InvoiceButton id={w.id} /> : <div className="text-xs text-muted-foreground">No file</div>}
                          </>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    )}
                    {canManage && (
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        {!closed && (
                          <Button size="sm" onClick={() => setClosing(w)} data-testid={`button-close-wo-${w.id}`}>
                            <PackageCheck className="h-3.5 w-3.5 mr-1" />
                            Close out
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          className="ml-1.5"
                          onClick={() => openEdit(w)}
                          data-testid={`button-edit-wo-${w.id}`}
                          aria-label="Edit work order"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="ml-1"
                          onClick={() => {
                            if (window.confirm(`Delete ${w.wo_number}? This removes it from ${w.asset_tag}'s refurbishment history and can't be undone.`))
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
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {canManage && (
        <>
          <WorkOrderDialog open={dialogOpen} onOpenChange={setDialogOpen} editing={editing} />
          <CloseOutDialog wo={closing} onOpenChange={(o) => !o && setClosing(null)} />
        </>
      )}
    </div>
  );
}
