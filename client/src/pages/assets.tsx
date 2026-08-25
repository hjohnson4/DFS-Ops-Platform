import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { exportUtilizationPdf, type UtilizationReport } from "@/lib/utilizationExport";
import {
  CATEGORIES,
  AREAS,
  SCHEDULE_CADENCE,
  CADENCE_LABELS,
  scheduleSummary,
  tracksRunHours,
  assetLocation,
} from "@shared/schema";
import type {
  AssetWithSchedule,
  AssetDetail,
  MaintenanceSchedule,
  ScheduleCadence,
} from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  Boxes,
  Plus,
  Loader2,
  CalendarClock,
  Settings2,
  Search,
  X,
  Download,
  MapPin,
  DollarSign,
  Wrench,
  FileText,
  Pencil,
} from "lucide-react";

const NO_SCHEDULE = "__none__";

// Format a numeric day rate as USD/day, or an em-dash when unset.
function fmtDayRate(v: number | null): string {
  if (v === null || v === undefined) return "\u2014";
  return `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}/day`;
}

function fmtDate(s: string | null): string {
  if (!s) return "\u2014";
  const d = new Date(s.length <= 10 ? s + "T00:00:00" : s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Manage-schedules dialog: create the named templates assets can link to.
// ---------------------------------------------------------------------------
function ManageSchedulesDialog({
  schedules,
}: {
  schedules: MaintenanceSchedule[];
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [cadence, setCadence] = useState<ScheduleCadence>("run_hours");
  const [interval, setInterval] = useState("250");
  const [notes, setNotes] = useState("");

  const create = useMutation({
    mutationFn: async () => {
      const n = parseInt(interval, 10);
      if (!name.trim()) throw new Error("Give the schedule a name");
      if (!Number.isFinite(n) || n <= 0) throw new Error("Interval must be a positive number");
      await apiRequest("POST", "/api/maintenance-schedules", {
        name: name.trim(),
        cadence,
        interval_value: n,
        notes: notes.trim() || null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/maintenance-schedules"] });
      setName("");
      setNotes("");
      setInterval("250");
      setCadence("run_hours");
      toast({ title: "Schedule added" });
    },
    onError: (e: any) =>
      toast({ title: "Could not add schedule", description: e.message, variant: "destructive" }),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/maintenance-schedules/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/maintenance-schedules"] });
      queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
      toast({ title: "Schedule removed" });
    },
    onError: (e: any) =>
      toast({ title: "Could not remove", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid="button-manage-schedules">
          <Settings2 className="h-4 w-4 mr-1.5" />
          Maintenance schedules
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Maintenance schedules</DialogTitle>
          <DialogDescription>
            Reusable schedule templates you can link to any asset. Run-hours
            suit centrifuges (metered); calendar days suit everything else.
          </DialogDescription>
        </DialogHeader>

        {/* Existing schedules */}
        <div className="space-y-1.5 max-h-48 overflow-y-auto">
          {schedules.length === 0 ? (
            <div className="text-sm text-muted-foreground py-2">
              No schedules yet — add one below.
            </div>
          ) : (
            schedules.map((s) => (
              <div
                key={s.id}
                className="flex items-center justify-between rounded border border-card-border px-3 py-2"
                data-testid={`row-schedule-${s.id}`}
              >
                <div>
                  <div className="text-sm font-medium">{s.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {scheduleSummary(s)}
                    {s.notes ? ` · ${s.notes}` : ""}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-red-600 hover:text-red-700"
                  disabled={del.isPending}
                  onClick={() => del.mutate(s.id)}
                  data-testid={`button-delete-schedule-${s.id}`}
                >
                  Delete
                </Button>
              </div>
            ))
          )}
        </div>

        {/* Add new schedule */}
        <div className="border-t border-card-border pt-3 space-y-3">
          <div>
            <Label htmlFor="sched-name">Name</Label>
            <Input
              id="sched-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. 250-hr centrifuge PM"
              data-testid="input-schedule-name"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Cadence</Label>
              <Select value={cadence} onValueChange={(v) => setCadence(v as ScheduleCadence)}>
                <SelectTrigger data-testid="select-schedule-cadence">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCHEDULE_CADENCE.map((c) => (
                    <SelectItem key={c} value={c}>
                      {CADENCE_LABELS[c]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="sched-interval">
                Interval ({cadence === "run_hours" ? "hours" : "days"})
              </Label>
              <Input
                id="sched-interval"
                type="number"
                min={1}
                value={interval}
                onChange={(e) => setInterval(e.target.value)}
                data-testid="input-schedule-interval"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="sched-notes">Notes (optional)</Label>
            <Input
              id="sched-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              data-testid="input-schedule-notes"
            />
          </div>
          <Button
            className="w-full"
            disabled={create.isPending}
            onClick={() => create.mutate()}
            data-testid="button-add-schedule"
          >
            {create.isPending ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : (
              <Plus className="h-4 w-4 mr-1.5" />
            )}
            Add schedule
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Create-asset dialog
// ---------------------------------------------------------------------------
function CreateAssetDialog({
  schedules,
  defaultArea,
  areaLocked,
}: {
  schedules: MaintenanceSchedule[];
  defaultArea: string;
  areaLocked: boolean;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [tag, setTag] = useState("");
  const [category, setCategory] = useState<string>("");
  const [area, setArea] = useState<string>(defaultArea);
  const [scheduleId, setScheduleId] = useState<string>(NO_SCHEDULE);
  const [description, setDescription] = useState("");
  const [dayRate, setDayRate] = useState("");

  const reset = () => {
    setTag("");
    setCategory("");
    setArea(defaultArea);
    setScheduleId(NO_SCHEDULE);
    setDescription("");
    setDayRate("");
  };

  const create = useMutation({
    mutationFn: async () => {
      if (!tag.trim()) throw new Error("Enter an asset number");
      if (!category) throw new Error("Choose an equipment type");
      if (!area) throw new Error("Choose a deployable area");
      const rateStr = dayRate.trim();
      if (rateStr && (isNaN(Number(rateStr)) || Number(rateStr) < 0))
        throw new Error("Day rate must be a non-negative number");
      await apiRequest("POST", "/api/assets", {
        tag: tag.trim(),
        category,
        area,
        description: description.trim() || null,
        maintenance_schedule_id: scheduleId === NO_SCHEDULE ? null : scheduleId,
        day_rate: rateStr === "" ? null : Number(rateStr),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
      setOpen(false);
      reset();
      toast({ title: "Asset created" });
    },
    onError: (e: any) =>
      toast({ title: "Could not create asset", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" data-testid="button-new-asset">
          <Plus className="h-4 w-4 mr-1.5" />
          New asset
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Create asset</DialogTitle>
          <DialogDescription>
            Add a piece of equipment to the fleet.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 overflow-y-auto flex-1 -mx-6 px-6">
          {/* Equipment type */}
          <div>
            <Label>Type of equipment</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger data-testid="select-asset-category">
                <SelectValue placeholder="Choose equipment type…" />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Asset number */}
          <div>
            <Label htmlFor="asset-tag">Asset number</Label>
            <Input
              id="asset-tag"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              placeholder="e.g. BBC-104"
              data-testid="input-asset-tag"
            />
          </div>

          {/* Deployable area (changeable) */}
          <div>
            <Label>Deployable area</Label>
            <Select value={area} onValueChange={setArea} disabled={areaLocked}>
              <SelectTrigger data-testid="select-asset-area">
                <SelectValue placeholder="Choose an area…" />
              </SelectTrigger>
              <SelectContent>
                {AREAS.map((a) => (
                  <SelectItem key={a} value={a}>
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              {areaLocked
                ? "Area managers add assets in their own area."
                : "Can be changed later as equipment is redeployed."}
            </p>
          </div>

          {/* Maintenance schedule */}
          <div>
            <Label>Maintenance schedule</Label>
            <Select value={scheduleId} onValueChange={setScheduleId}>
              <SelectTrigger data-testid="select-asset-schedule">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_SCHEDULE}>No schedule</SelectItem>
                {schedules.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name} · {scheduleSummary(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {schedules.length === 0 && (
              <p className="text-xs text-muted-foreground mt-1">
                No schedules yet — create one from “Maintenance schedules”.
              </p>
            )}
            {category && tracksRunHours(category) && (
              <p className="text-xs text-muted-foreground mt-1">
                Centrifuges also track a per-machine service interval on the
                Service dashboard.
              </p>
            )}
          </div>

          {/* Rental day rate */}
          <div>
            <Label htmlFor="asset-rate">Rental day rate (optional)</Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
              <Input
                id="asset-rate"
                type="number"
                min="0"
                step="1"
                value={dayRate}
                onChange={(e) => setDayRate(e.target.value)}
                placeholder="e.g. 1200"
                className="pl-6"
                data-testid="input-asset-day-rate"
              />
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Daily rental price for this unit. Used for utilization revenue.
            </p>
          </div>

          {/* Description */}
          <div>
            <Label htmlFor="asset-desc">Equipment description (optional)</Label>
            <Textarea
              id="asset-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Make, model, serial, or notes about this unit…"
              rows={3}
              data-testid="input-asset-description"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            disabled={create.isPending}
            onClick={() => create.mutate()}
            data-testid="button-submit-asset"
          >
            {create.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            Create asset
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Status badge — colors free-string statuses without assuming an enum.
// ---------------------------------------------------------------------------
function statusClasses(status: string): string {
  const s = status.toLowerCase();
  if (s.includes("job") || s.includes("active") || s.includes("deploy"))
    return "bg-primary/10 text-primary border-primary/20";
  if (s.includes("repair") || s.includes("down") || s.includes("service"))
    return "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20";
  if (s.includes("avail") || s.includes("yard") || s.includes("idle"))
    return "bg-muted text-muted-foreground border-card-border";
  return "bg-muted text-foreground border-card-border";
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${statusClasses(status)}`}
      data-testid={`status-${status.replace(/\s+/g, "-").toLowerCase()}`}
    >
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Edit asset dialog — admin/area only. Mirrors CreateAssetDialog but prefilled
// from the selected asset and PATCHes /api/assets/:id. Editable: asset number
// (name), type, deployable area, maintenance schedule, service interval (run-
// hour assets), day rate, and description.
// ---------------------------------------------------------------------------
function EditAssetDialog({
  asset,
  open,
  onOpenChange,
}: {
  asset: AssetDetail;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { toast } = useToast();
  const { profile } = useAuth();
  const areaLocked = profile?.role === "area";

  const { data: schedules } = useQuery<MaintenanceSchedule[]>({
    queryKey: ["/api/maintenance-schedules"],
  });
  const scheduleList = schedules ?? [];

  const [tag, setTag] = useState(asset.tag);
  const [category, setCategory] = useState<string>(asset.category);
  const [area, setArea] = useState<string>(asset.area);
  const [scheduleId, setScheduleId] = useState<string>(
    asset.maintenance_schedule_id ?? NO_SCHEDULE,
  );
  const [interval, setInterval] = useState<string>(
    asset.service_hours_interval != null ? String(asset.service_hours_interval) : "",
  );
  const [description, setDescription] = useState(asset.description ?? "");
  const [dayRate, setDayRate] = useState(
    asset.day_rate != null ? String(asset.day_rate) : "",
  );

  // Re-seed the form whenever a different asset is opened.
  useEffect(() => {
    setTag(asset.tag);
    setCategory(asset.category);
    setArea(asset.area);
    setScheduleId(asset.maintenance_schedule_id ?? NO_SCHEDULE);
    setInterval(
      asset.service_hours_interval != null
        ? String(asset.service_hours_interval)
        : "",
    );
    setDescription(asset.description ?? "");
    setDayRate(asset.day_rate != null ? String(asset.day_rate) : "");
  }, [asset]);

  const onJob = !!asset.job_id;

  const save = useMutation({
    mutationFn: async () => {
      if (!tag.trim()) throw new Error("Enter an asset number");
      if (!category) throw new Error("Choose an equipment type");
      if (!area) throw new Error("Choose a deployable area");
      const rateStr = dayRate.trim();
      if (rateStr && (isNaN(Number(rateStr)) || Number(rateStr) < 0))
        throw new Error("Day rate must be a non-negative number");
      const body: any = {
        tag: tag.trim(),
        category,
        area,
        description: description.trim() || null,
        maintenance_schedule_id: scheduleId === NO_SCHEDULE ? null : scheduleId,
        day_rate: rateStr === "" ? null : Number(rateStr),
      };
      // Only send a service interval for run-hour assets, and only if provided.
      if (tracksRunHours(category as any)) {
        const iv = interval.trim();
        if (iv) {
          if (isNaN(Number(iv)) || Number(iv) <= 0)
            throw new Error("Service interval must be a positive number of hours");
          body.service_hours_interval = Number(iv);
        }
      }
      await apiRequest("PATCH", `/api/assets/${asset.id}`, body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/assets", asset.id] });
      onOpenChange(false);
      toast({ title: "Asset updated" });
    },
    onError: (e: any) =>
      toast({ title: "Could not update asset", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Edit asset</DialogTitle>
          <DialogDescription>Update this equipment's details.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 overflow-y-auto flex-1 -mx-6 px-6">
          {/* Equipment type */}
          <div>
            <Label>Type of equipment</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger data-testid="edit-select-asset-category">
                <SelectValue placeholder="Choose equipment type…" />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Asset number (name) */}
          <div>
            <Label htmlFor="edit-asset-tag">Asset number</Label>
            <Input
              id="edit-asset-tag"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              placeholder="e.g. BBC-104"
              data-testid="edit-input-asset-tag"
            />
          </div>

          {/* Deployable area */}
          <div>
            <Label>Deployable area</Label>
            <Select
              value={area}
              onValueChange={setArea}
              disabled={areaLocked || onJob}
            >
              <SelectTrigger data-testid="edit-select-asset-area">
                <SelectValue placeholder="Choose an area…" />
              </SelectTrigger>
              <SelectContent>
                {AREAS.map((a) => (
                  <SelectItem key={a} value={a}>
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {onJob ? (
              <p className="text-xs text-muted-foreground mt-1">
                This asset is on a job. Unassign it from the job to change its
                area.
              </p>
            ) : areaLocked ? (
              <p className="text-xs text-muted-foreground mt-1">
                Area managers keep assets within their own area.
              </p>
            ) : null}
          </div>

          {/* Maintenance schedule */}
          <div>
            <Label>Maintenance schedule</Label>
            <Select value={scheduleId} onValueChange={setScheduleId}>
              <SelectTrigger data-testid="edit-select-asset-schedule">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_SCHEDULE}>No schedule</SelectItem>
                {scheduleList.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name} · {scheduleSummary(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Service interval — run-hour assets only */}
          {tracksRunHours(category as any) && (
            <div>
              <Label htmlFor="edit-asset-interval">
                Service interval (run hours)
              </Label>
              <Input
                id="edit-asset-interval"
                type="number"
                min="1"
                step="1"
                value={interval}
                onChange={(e) => setInterval(e.target.value)}
                placeholder="e.g. 250"
                data-testid="edit-input-asset-interval"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Hours between full services for this centrifuge.
              </p>
            </div>
          )}

          {/* Rental day rate */}
          <div>
            <Label htmlFor="edit-asset-rate">Rental day rate (optional)</Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
              <Input
                id="edit-asset-rate"
                type="number"
                min="0"
                step="1"
                value={dayRate}
                onChange={(e) => setDayRate(e.target.value)}
                placeholder="e.g. 1200"
                className="pl-6"
                data-testid="edit-input-asset-day-rate"
              />
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Daily rental price for this unit. Used for utilization revenue.
            </p>
          </div>

          {/* Description */}
          <div>
            <Label htmlFor="edit-asset-desc">Equipment description (optional)</Label>
            <Textarea
              id="edit-asset-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Make, model, serial, or notes about this unit…"
              rows={3}
              data-testid="edit-input-asset-description"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="edit-button-cancel"
          >
            Cancel
          </Button>
          <Button
            disabled={save.isPending}
            onClick={() => save.mutate()}
            data-testid="edit-button-submit-asset"
          >
            {save.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Asset detail pop-up — full asset info + maintenance/inspection history.
// ---------------------------------------------------------------------------
function AssetDetailDialog({
  assetId,
  onClose,
}: {
  assetId: string | null;
  onClose: () => void;
}) {
  const { profile } = useAuth();
  const canManage = profile?.role === "admin" || profile?.role === "area";
  const [editing, setEditing] = useState(false);
  const { data, isLoading } = useQuery<AssetDetail>({
    queryKey: ["/api/assets", assetId],
    enabled: !!assetId,
  });

  const loc = data ? assetLocation(data) : "\u2014";

  return (
    <Dialog open={!!assetId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Boxes className="h-5 w-5 text-muted-foreground" />
            {data ? data.tag : "Asset"}
          </DialogTitle>
          <DialogDescription>
            {data ? `${data.category} \u00b7 ${data.area}` : "Equipment detail"}
          </DialogDescription>
        </DialogHeader>

        {canManage && data && (
          <div className="flex justify-end -mt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditing(true)}
              data-testid="button-edit-asset"
            >
              <Pencil className="h-4 w-4 mr-1.5" />
              Edit asset
            </Button>
          </div>
        )}

        {isLoading || !data ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 mx-auto animate-spin mb-2" />
            Loading asset…
          </div>
        ) : (
          <div className="space-y-5">
            {/* Key facts */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <div>
                <div className="text-xs text-muted-foreground mb-0.5">Status</div>
                <StatusBadge status={data.status} />
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-0.5 flex items-center gap-1">
                  <MapPin className="h-3 w-3" /> Location
                </div>
                <div data-testid="detail-location">{loc}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-0.5 flex items-center gap-1">
                  <DollarSign className="h-3 w-3" /> Rental day rate
                </div>
                <div data-testid="detail-day-rate">{fmtDayRate(data.day_rate)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-0.5">Run hours</div>
                <div>{data.run_hours ?? "\u2014"}</div>
                {tracksRunHours(data.category) && (
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {data.run_hours_since_service != null
                      ? `${data.run_hours_since_service.toLocaleString()} hrs since last service`
                      : "\u2014 since last service"}
                    {data.service_hours_interval
                      ? ` (service every ${data.service_hours_interval.toLocaleString()} hrs)`
                      : ""}
                  </div>
                )}
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-0.5 flex items-center gap-1">
                  <CalendarClock className="h-3 w-3" /> Maintenance schedule
                </div>
                <div>
                  {data.maintenance_schedule
                    ? `${data.maintenance_schedule.name} \u00b7 ${scheduleSummary(data.maintenance_schedule)}`
                    : "\u2014"}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-0.5">Last maintained</div>
                <div>{fmtDate(data.last_maintained)}</div>
              </div>
            </div>

            {data.description && (
              <div className="text-sm">
                <div className="text-xs text-muted-foreground mb-0.5">Description</div>
                <div className="text-muted-foreground">{data.description}</div>
              </div>
            )}

            {/* Maintenance / inspection history */}
            <div>
              <div className="flex items-center gap-1.5 text-sm font-medium mb-2">
                <Wrench className="h-4 w-4 text-muted-foreground" />
                Maintenance & inspection history
                <span className="text-xs text-muted-foreground font-normal">
                  ({data.history.length})
                </span>
              </div>
              {data.history.length === 0 ? (
                <div className="rounded-md border border-dashed border-card-border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
                  <FileText className="h-5 w-5 mx-auto mb-1.5 opacity-60" />
                  No maintenance or inspection reports filed for this asset yet.
                </div>
              ) : (
                <div className="rounded-md border border-card-border overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-card-border bg-muted/40 text-left text-xs text-muted-foreground">
                        <th className="px-3 py-2 font-medium">Date</th>
                        <th className="px-3 py-2 font-medium">Work type</th>
                        <th className="px-3 py-2 font-medium">Status</th>
                        <th className="px-3 py-2 font-medium">Technician</th>
                        <th className="px-3 py-2 font-medium">Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.history.map((h) => (
                        <tr
                          key={h.id}
                          className="border-b border-card-border last:border-0 align-top"
                          data-testid={`history-row-${h.id}`}
                        >
                          <td className="px-3 py-2 whitespace-nowrap">{fmtDate(h.report_date)}</td>
                          <td className="px-3 py-2">{h.work_type}</td>
                          <td className="px-3 py-2">
                            <span className="text-xs text-muted-foreground">{h.status}</span>
                          </td>
                          <td className="px-3 py-2">{h.supervisor_name ?? "\u2014"}</td>
                          <td className="px-3 py-2 text-muted-foreground max-w-xs">
                            {h.notes || "\u2014"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {data && (
          <EditAssetDialog
            asset={data}
            open={editing}
            onOpenChange={setEditing}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Export utilization dialog — pick a date range, open a branded PDF report.
// ---------------------------------------------------------------------------
function ExportUtilizationDialog() {
  const { toast } = useToast();
  const { profile } = useAuth();
  const [open, setOpen] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  const [start, setStart] = useState(monthAgo);
  const [end, setEnd] = useState(today);
  const [busy, setBusy] = useState(false);

  const download = async () => {
    if (!start || !end || end < start) {
      toast({ title: "Pick a valid date range", description: "End date must be on or after the start date.", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      // Fetch structured rows + summary, then render a branded PDF client-side.
      const res = await apiRequest(
        "GET",
        `/api/assets/utilization.json?start=${start}&end=${end}`,
      );
      const report = (await res.json()) as UtilizationReport;
      exportUtilizationPdf(report, { generatedBy: profile?.name });
      setOpen(false);
      toast({ title: "Report ready", description: "Your utilization PDF opened in a new tab — use your browser's print dialog to save it." });
    } catch (e: any) {
      toast({ title: "Export failed", description: e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" data-testid="button-export-utilization">
          <FileText className="h-4 w-4 mr-1.5" />
          Export utilization
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Export utilization report</DialogTitle>
          <DialogDescription>
            Generate a branded PDF of each asset's deployment, day rate, and
            estimated revenue over a date range.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="util-start">Start date</Label>
            <Input
              id="util-start"
              type="date"
              value={start}
              max={end}
              onChange={(e) => setStart(e.target.value)}
              data-testid="input-util-start"
            />
          </div>
          <div>
            <Label htmlFor="util-end">End date</Label>
            <Input
              id="util-end"
              type="date"
              value={end}
              min={start}
              max={today}
              onChange={(e) => setEnd(e.target.value)}
              data-testid="input-util-end"
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Days deployed is measured from each asset's assigned job dates
          overlapping the window. Assets not on a job show “—”.
        </p>
        <DialogFooter>
          <Button onClick={download} disabled={busy} data-testid="button-download-utilization">
            {busy ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : (
              <FileText className="h-4 w-4 mr-1.5" />
            )}
            Generate PDF
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function AssetsPage() {
  const { profile } = useAuth();
  const canManage = profile?.role === "admin" || profile?.role === "area";
  const areaLocked = profile?.role === "area";
  const isField = profile?.role === "field";
  const defaultArea = profile?.area ?? "";

  const { data: assets, isLoading } = useQuery<AssetWithSchedule[]>({
    queryKey: ["/api/assets"],
  });
  const { data: schedules } = useQuery<MaintenanceSchedule[]>({
    queryKey: ["/api/maintenance-schedules"],
  });

  const rows = assets ?? [];
  const scheduleList = schedules ?? [];

  // Currently opened asset detail pop-up (null = closed).
  const [detailId, setDetailId] = useState<string | null>(null);

  // Client-side search across the visible asset fields + linked schedule name.
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = q
    ? rows.filter((a) =>
        [
          a.tag,
          a.category,
          a.area,
          a.status,
          a.description,
          a.maintenance_schedule?.name,
        ]
          .filter(Boolean)
          .some((v) => (v as string).toLowerCase().includes(q)),
      )
    : rows;

  return (
    <div className="p-6 max-w-6xl">
      <div className="flex items-start justify-between mb-1 gap-3">
        <div className="flex items-center gap-2">
          <Boxes className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Assets</h1>
        </div>
        <div className="flex items-center gap-2">
          {rows.length > 0 && !isField && <ExportUtilizationDialog />}
          {canManage && (
            <>
              <ManageSchedulesDialog schedules={scheduleList} />
              <CreateAssetDialog
                schedules={scheduleList}
                defaultArea={defaultArea}
                areaLocked={areaLocked}
              />
            </>
          )}
        </div>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        {isField
          ? "Equipment on the jobs you're assigned to."
          : `Your equipment fleet across ${profile?.area ? profile.area : "all areas"}.`}
      </p>

      {/* Search */}
      {rows.length > 0 && (
        <div className="relative mb-4 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search asset #, type, area, status, description…"
            className="pl-9 pr-9"
            data-testid="input-search-assets"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
              data-testid="button-clear-search"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">
          Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-10 text-center">
          <Boxes className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
          <div className="text-sm text-muted-foreground">
            {isField
              ? "No equipment is currently on your assigned jobs."
              : "No assets on file yet."}
          </div>
          {canManage && (
            <div className="text-xs text-muted-foreground mt-1">
              Use “New asset” to add your first piece of equipment.
            </div>
          )}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-10 text-center">
          <Search className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
          <div className="text-sm text-muted-foreground">
            No assets match “{query}”.
          </div>
          <button
            type="button"
            onClick={() => setQuery("")}
            className="text-xs text-primary hover:underline mt-1"
            data-testid="button-clear-search-empty"
          >
            Clear search
          </button>
        </div>
      ) : (
        <div className="rounded-lg border border-card-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-card-border bg-muted/40 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Asset #</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Location</th>
                <th className="px-3 py-2 font-medium text-right">Day rate</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => (
                <tr
                  key={a.id}
                  className="border-b border-card-border last:border-0 hover:bg-muted/40 cursor-pointer"
                  data-testid={`row-asset-${a.tag}`}
                  onClick={() => setDetailId(a.id)}
                >
                  <td className="px-3 py-2.5">
                    <div className="font-medium">{a.tag}</div>
                  </td>
                  <td className="px-3 py-2.5">{a.category}</td>
                  <td className="px-3 py-2.5">
                    <StatusBadge status={a.status} />
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="flex items-center gap-1.5">
                      <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      {assetLocation(a)}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">
                    {a.day_rate === null || a.day_rate === undefined ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      fmtDayRate(a.day_rate)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1">
        {!isLoading && rows.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Showing {filtered.length} of {rows.length} asset
            {rows.length > 1 ? "s" : ""}
            {q ? ` matching “${query}”` : ""}.
          </p>
        )}
        {scheduleList.length > 0 && (
          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
            <CalendarClock className="h-3.5 w-3.5" />
            {scheduleList.length} maintenance schedule
            {scheduleList.length > 1 ? "s" : ""} available to link.
          </p>
        )}
        {rows.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Click any asset for full detail and maintenance history.
          </p>
        )}
      </div>

      <AssetDetailDialog assetId={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}
