import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  WORK_ORDER_TYPES,
  WORK_ORDER_PRIORITIES,
  WORK_ORDER_STATUSES,
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
} from "lucide-react";

// ---------------------------------------------------------------------------
// Work Orders — moved out of the (removed) Maintenance module and surfaced in
// the Service module. Backend endpoints (/api/work-orders*) are unchanged, so
// service-report flags still auto-open work orders here.
// ---------------------------------------------------------------------------

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

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
// Work Orders section: KPI cards + filterable table
// ---------------------------------------------------------------------------
export function WorkOrdersSection({ canManage }: { canManage: boolean }) {
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
      <div className="mb-3 flex items-center gap-2">
        <Wrench className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Work orders</h2>
      </div>

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
