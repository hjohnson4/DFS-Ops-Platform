import { useState, useEffect } from "react";
import { useRoute, Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import {
  JOB_STATUS,
  CREWING,
  SERVICE_TYPES,
  type JobWithCustomer,
  type JobService,
  type ServiceType,
  type JobStatus,
  type Crewing,
  type Asset,
  type FieldTicket,
  type DailyReportWithLinks,
  type JsaWithJob,
  type PadWithDerivedWells,
  type UnassignedWell,
} from "@shared/schema";
import { FieldTicketFormDialog } from "@/components/FieldTicketFormDialog";
import { JsaFormDialog } from "@/components/JsaFormDialog";
import { SignoffControls } from "@/components/SignoffControls";
import { JobKpiTrend } from "@/components/JobKpiTrend";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Archive, ArchiveRestore, ArrowLeft, Building2, Calendar, Check, ChevronDown, ClipboardList, DollarSign, FileText, Info, Layers, Loader2, MapPin, Navigation, Pencil, Play, Plus, Power, PowerOff, ShieldAlert, Ticket, Trash2, User, Wrench, X } from "lucide-react";

const money = (n: number | null) =>
  n == null
    ? "—"
    : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });

const STATUS_TONE: Record<JobStatus, string> = {
  Active: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  "On Hold": "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  Completed: "bg-muted text-muted-foreground",
};

function fmtDate(d: string | null) {
  if (!d) return "—";
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? d : dt.toLocaleDateString();
}

function fmtMoney(n: number | null) {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// yyyy-mm-dd for <input type=date>; tolerates full ISO timestamps
function toDateInput(d: string | null): string {
  if (!d) return "";
  return d.slice(0, 10);
}

export default function JobDetailPage() {
  const [, params] = useRoute("/jobs/:id");
  const id = params?.id;
  const { profile } = useAuth();
  const { toast } = useToast();
  const canEdit =
    profile?.role === "admin" || profile?.role === "area" || profile?.role === "super";
  // Asset assignment is admin/area only — mirrors the backend PATCH /api/assets
  // guard (requireRole("admin","area")). Supers can view but not attach/release.
  const canManageAssets = profile?.role === "admin" || profile?.role === "area";

  const { data: job, isLoading, error } = useQuery<JobWithCustomer>({
    queryKey: ["/api/jobs", id],
    enabled: !!id,
  });

  // assets assigned to this job (filtered client-side from the area-scoped list)
  const { data: allAssets } = useQuery<Asset[]>({
    queryKey: ["/api/assets"],
    enabled: !!id,
  });
  const assignedAssets = (allAssets || []).filter((a) => a.job_id === id);
  // assets available to attach: unassigned AND in this job's operating area
  // (the backend enforces the same-area rule; we mirror it in the picker)
  const attachableAssets = (allAssets || []).filter(
    (a) => !a.job_id && a.area === job?.area,
  );

  // field tickets for this job
  const { data: tickets } = useQuery<FieldTicket[]>({
    queryKey: ["/api/jobs", id, "field-tickets"],
    enabled: !!id,
  });
  const assetTag = (aid: string) =>
    (allAssets || []).find((a) => a.id === aid)?.tag ?? "asset";

  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<JobStatus>("Active");
  const [crewing, setCrewing] = useState<Crewing>("Manned");
  const [startedOn, setStartedOn] = useState("");
  const [endedOn, setEndedOn] = useState("");
  const [dayRate, setDayRate] = useState("");

  // seed edit fields whenever the job loads / changes
  useEffect(() => {
    if (job) {
      setStatus(job.status);
      setCrewing(job.crewing ?? "Manned");
      setStartedOn(toDateInput(job.started_on));
      setEndedOn(toDateInput(job.ended_on));
      setDayRate(job.day_rate === null || job.day_rate === undefined ? "" : String(job.day_rate));
    }
  }, [job]);

  const save = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", `/api/jobs/${id}`, {
        status,
        crewing,
        started_on: startedOn || null,
        ended_on: endedOn || null,
        day_rate: dayRate.trim() === "" ? null : Number(dayRate),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/jobs", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/jobs"] });
      toast({ title: "Job updated" });
      setEditing(false);
    },
    onError: (e: any) =>
      toast({ title: "Could not update job", description: e.message, variant: "destructive" }),
  });

  const cancelEdit = () => {
    if (job) {
      setStatus(job.status);
      setCrewing(job.crewing ?? "Manned");
      setStartedOn(toDateInput(job.started_on));
      setEndedOn(toDateInput(job.ended_on));
      setDayRate(job.day_rate === null || job.day_rate === undefined ? "" : String(job.day_rate));
    }
    setEditing(false);
  };

  // release an asset from this job
  const release = useMutation({
    mutationFn: async (assetId: string) => {
      const res = await apiRequest("PATCH", `/api/assets/${assetId}`, {
        job_id: null,
        status: "Available",
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
      toast({ title: "Asset released" });
    },
    onError: (e: any) =>
      toast({ title: "Could not release asset", description: e.message, variant: "destructive" }),
  });

  // attach an available in-area asset to this job
  const [addAssetOpen, setAddAssetOpen] = useState(false);
  const [assetToAdd, setAssetToAdd] = useState("");
  const assign = useMutation({
    mutationFn: async (assetId: string) => {
      const res = await apiRequest("PATCH", `/api/assets/${assetId}`, {
        job_id: id,
        status: "Deployed",
        job_or_well: job?.job_number ?? null,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
      setAddAssetOpen(false);
      setAssetToAdd("");
      toast({ title: "Asset assigned", description: "Equipment attached to this job." });
    },
    onError: (e: any) =>
      toast({ title: "Could not assign asset", description: e.message, variant: "destructive" }),
  });

  // edit the well/location label on an already-assigned asset
  const [editAsset, setEditAsset] = useState<Asset | null>(null);
  const [editWell, setEditWell] = useState("");
  const editAssetWell = useMutation({
    mutationFn: async () => {
      if (!editAsset) return;
      const res = await apiRequest("PATCH", `/api/assets/${editAsset.id}`, {
        job_or_well: editWell.trim() === "" ? null : editWell.trim(),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
      setEditAsset(null);
      toast({ title: "Asset updated" });
    },
    onError: (e: any) =>
      toast({ title: "Could not update asset", description: e.message, variant: "destructive" }),
  });

  const archive = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/jobs/${id}/archive`, {});
      return res.json();
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/jobs", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/jobs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
      toast({ title: "Job archived", description: "Assigned assets were released back to Available." });
    },
    onError: (e: any) =>
      toast({ title: "Could not archive job", description: e.message, variant: "destructive" }),
  });

  const unarchive = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/jobs/${id}/unarchive`, {});
      return res.json();
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/jobs", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/jobs"] });
      toast({ title: "Job restored" });
    },
    onError: (e: any) =>
      toast({ title: "Could not restore job", description: e.message, variant: "destructive" }),
  });

  const deleteTicket = useMutation({
    mutationFn: async (ticketId: string) => {
      await apiRequest("DELETE", `/api/field-tickets/${ticketId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/jobs", id, "field-tickets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/field-tickets"] });
      toast({ title: "Field ticket deleted" });
    },
    onError: (e: any) =>
      toast({ title: "Could not delete ticket", description: e.message, variant: "destructive" }),
  });

  const dateError = !!startedOn && !!endedOn && endedOn < startedOn;

  if (isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }
  if (error || !job) {
    return (
      <div className="p-6 max-w-3xl">
        <BackLink />
        <div className="mt-4 text-sm text-muted-foreground">Job not found.</div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl">
      <BackLink />

      <div className="mt-4 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold">Job {job.job_number}</h1>
            {!editing && (
              <>
                <span className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_TONE[job.status]}`}>
                  {job.status}
                </span>
                <CrewingBadge crewing={job.crewing ?? "Manned"} />
                {job.archived_at && (
                  <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground" data-testid="badge-archived">
                    <Archive className="h-3 w-3" /> Archived
                  </span>
                )}
              </>
            )}
          </div>
          {job.customer_id && (
            <Link href={`/customers/${job.customer_id}`}>
              <a className="mt-1 inline-flex items-center gap-1.5 text-sm text-primary hover:underline" data-testid="link-job-customer">
                <Building2 className="h-3.5 w-3.5" /> {job.customer_name}
              </a>
            </Link>
          )}
        </div>
        {canEdit && (
          <div className="flex items-center gap-2 shrink-0">
            {editing ? (
              <>
                <Button variant="ghost" size="sm" onClick={cancelEdit} disabled={save.isPending} data-testid="button-cancel-job">
                  <X className="mr-1.5 h-4 w-4" /> Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => save.mutate()}
                  disabled={save.isPending || dateError}
                  data-testid="button-save-job-edit"
                >
                  {save.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                  Save changes
                </Button>
              </>
            ) : job.archived_at ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => unarchive.mutate()}
                disabled={unarchive.isPending}
                data-testid="button-unarchive-job"
              >
                {unarchive.isPending ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <ArchiveRestore className="mr-1.5 h-4 w-4" />
                )}
                Restore
              </Button>
            ) : (
              <>
                <Button variant="outline" size="sm" onClick={() => setEditing(true)} data-testid="button-edit-job">
                  <Pencil className="mr-1.5 h-4 w-4" /> Edit
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="sm" data-testid="button-archive-job">
                      <Archive className="mr-1.5 h-4 w-4" /> Archive
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Archive job {job.job_number}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        The job and all its history (pads, wells, field tickets,
                        daily reports, JSAs) are kept, but it's hidden from the
                        default jobs list. Any assets assigned to it are released
                        back to Available. You can restore it anytime.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel data-testid="button-archive-cancel">Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => archive.mutate()}
                        data-testid="button-archive-confirm"
                      >
                        Archive job
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </>
            )}
          </div>
        )}
      </div>

      {job.archived_at && (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-card-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground" data-testid="banner-archived">
          <Archive className="h-4 w-4 shrink-0" />
          <span>
            This job is archived and hidden from the default jobs list. Use
            Restore to bring it back.
          </span>
        </div>
      )}

      {/* Detail card */}
      <div className="mt-4 rounded-lg border border-card-border bg-card p-4 grid sm:grid-cols-3 gap-4 text-sm">
        {editing ? (
          <>
            <div>
              <Label className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                <MapPin className="h-3.5 w-3.5" /> Operating area
              </Label>
              <div className="text-sm py-1.5">{job.area}</div>
            </div>
            <div>
              <Label className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                <Calendar className="h-3.5 w-3.5" /> Started
              </Label>
              <Input
                type="date"
                value={startedOn}
                onChange={(e) => setStartedOn(e.target.value)}
                data-testid="input-job-started"
              />
            </div>
            <div>
              <Label className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                <Calendar className="h-3.5 w-3.5" /> Ended
              </Label>
              <Input
                type="date"
                value={endedOn}
                onChange={(e) => setEndedOn(e.target.value)}
                data-testid="input-job-ended"
              />
            </div>
            <div className="sm:col-span-1">
              <Label className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                Status
              </Label>
              <Select value={status} onValueChange={(v) => setStatus(v as JobStatus)}>
                <SelectTrigger data-testid="select-job-status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {JOB_STATUS.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="sm:col-span-1">
              <Label className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                <User className="h-3.5 w-3.5" /> Crewing
              </Label>
              <ToggleGroup
                type="single"
                value={crewing}
                onValueChange={(v) => v && setCrewing(v as Crewing)}
                className="justify-start gap-2"
              >
                {CREWING.map((c) => (
                  <ToggleGroupItem
                    key={c}
                    value={c}
                    aria-label={c}
                    className="gap-1.5 border border-card-border data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                    data-testid={`toggle-crewing-${c.toLowerCase()}`}
                  >
                    {c === "Manned" ? <User className="h-4 w-4" /> : <PowerOff className="h-4 w-4" />}
                    {c}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
            <div className="sm:col-span-1">
              <Label className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                <DollarSign className="h-3.5 w-3.5" /> Day rate
              </Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  className="pl-7"
                  placeholder="0.00"
                  value={dayRate}
                  onChange={(e) => setDayRate(e.target.value)}
                  data-testid="input-job-day-rate"
                />
              </div>
            </div>
            {dateError && (
              <div className="sm:col-span-3 text-xs text-destructive">
                End date can't be before the start date.
              </div>
            )}
          </>
        ) : (
          <>
            <Field icon={MapPin} label="Operating area" value={job.area} />
            <Field icon={User} label="Crewing" value={job.crewing ?? "Manned"} />
            <Field icon={DollarSign} label="Day rate" value={fmtMoney(job.day_rate)} />
            <Field icon={Calendar} label="Started" value={fmtDate(job.started_on)} />
            <Field icon={Calendar} label="Ended" value={fmtDate(job.ended_on)} />
          </>
        )}
      </div>

      {job.description && (
        <div className="mt-3 rounded-lg border border-card-border bg-card p-4 text-sm">
          <div className="text-xs text-muted-foreground mb-1">Description</div>
          <div className="whitespace-pre-wrap">{job.description}</div>
        </div>
      )}

      {/* Assigned assets */}
      <div className="mt-6 mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          Assigned assets{" "}
          <span className="text-muted-foreground font-normal">
            ({assignedAssets.length})
          </span>
        </h2>
        {canManageAssets &&
          (job.status === "Active" ? (
            <Button
              size="sm"
              onClick={() => {
                setAssetToAdd("");
                setAddAssetOpen(true);
              }}
              data-testid="button-add-asset"
            >
              <Plus className="mr-2 h-4 w-4" /> Add asset
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">
              Job not active — assets are read-only
            </span>
          ))}
      </div>
      {assignedAssets.length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-8 text-center">
          <div className="text-sm text-muted-foreground">
            No assets are assigned to this job yet.
          </div>
          {canManageAssets && job.status === "Active" && (
            <div className="text-xs text-muted-foreground mt-1">
              Use “Add asset” to attach available equipment in this area.
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-card-border bg-card divide-y divide-card-border">
          {assignedAssets.map((a) => (
            <div
              key={a.id}
              className="flex items-center gap-3 px-4 py-3 text-sm"
              data-testid={`assigned-asset-${a.id}`}
            >
              <Wrench className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="font-medium">{a.tag}</span>
              <span className="text-muted-foreground">{a.category}</span>
              {a.job_or_well && (
                <span className="text-muted-foreground">· {a.job_or_well}</span>
              )}
              <span className="ml-auto inline-flex rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                {a.status}
              </span>
              {canManageAssets && job.status === "Active" && (
                <div className="flex items-center gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground"
                    onClick={() => {
                      setEditAsset(a);
                      setEditWell(a.job_or_well ?? "");
                    }}
                    aria-label="Edit well/location"
                    data-testid={`button-edit-asset-${a.id}`}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        disabled={release.isPending}
                        aria-label="Release asset"
                        data-testid={`button-release-asset-${a.id}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Release {a.tag} from this job?</AlertDialogTitle>
                        <AlertDialogDescription>
                          The asset is unassigned from Job {job.job_number} and
                          returned to Available. It can be reassigned anytime.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel data-testid="button-cancel-release">Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => release.mutate(a.id)}
                          data-testid="button-confirm-release"
                        >
                          Release asset
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Add asset dialog */}
      <Dialog open={addAssetOpen} onOpenChange={setAddAssetOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add asset to Job {job.job_number}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Label htmlFor="add-asset-select">Available equipment in {job.area}</Label>
            {attachableAssets.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No available assets in {job.area}. Free up equipment from another
                job, or create a new asset in the Assets module.
              </p>
            ) : (
              <Select value={assetToAdd} onValueChange={setAssetToAdd}>
                <SelectTrigger id="add-asset-select" data-testid="select-add-asset">
                  <SelectValue placeholder="Choose an asset…" />
                </SelectTrigger>
                <SelectContent>
                  {attachableAssets.map((a) => (
                    <SelectItem key={a.id} value={a.id} data-testid={`option-asset-${a.id}`}>
                      {a.tag} — {a.category}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddAssetOpen(false)} data-testid="button-cancel-add-asset">
              Cancel
            </Button>
            <Button
              onClick={() => assign.mutate(assetToAdd)}
              disabled={!assetToAdd || assign.isPending}
              data-testid="button-confirm-add-asset"
            >
              {assign.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Assign to job
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit assigned-asset well/location dialog */}
      <Dialog open={!!editAsset} onOpenChange={(o) => !o && setEditAsset(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit {editAsset?.tag}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Label htmlFor="edit-asset-well">Well / location</Label>
            <Input
              id="edit-asset-well"
              value={editWell}
              onChange={(e) => setEditWell(e.target.value)}
              placeholder="e.g. well name or pad location"
              data-testid="input-edit-asset-well"
            />
            <p className="text-xs text-muted-foreground">
              Updates where this asset is working on Job {job.job_number}. To move
              it to a different job, release it and add it there.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditAsset(null)} data-testid="button-cancel-edit-asset">
              Cancel
            </Button>
            <Button
              onClick={() => editAssetWell.mutate()}
              disabled={editAssetWell.isPending}
              data-testid="button-save-edit-asset"
            >
              {editAssetWell.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Field tickets */}
      <div className="mt-6 mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          Field tickets{" "}
          <span className="text-muted-foreground font-normal">
            ({tickets?.length ?? 0})
          </span>
          {tickets && tickets.length > 0 && (
            <span className="ml-2 text-muted-foreground font-normal">
              · Billable{" "}
              <span className="font-medium text-foreground tabular-nums" data-testid="job-billable-total">
                {money(tickets.reduce((s, t) => s + Number(t.amount ?? 0), 0))}
              </span>
            </span>
          )}
        </h2>
        {canEdit &&
          (job.status === "Active" ? (
            <FieldTicketFormDialog
              job={job}
              trigger={
                <Button size="sm" data-testid="button-add-field-ticket">
                  <Plus className="mr-2 h-4 w-4" /> New ticket
                </Button>
              }
            />
          ) : (
            <span className="text-xs text-muted-foreground">
              Job not active — tickets are read-only
            </span>
          ))}
      </div>
      {!tickets || tickets.length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-8 text-center">
          <Ticket className="h-5 w-5 mx-auto text-muted-foreground mb-1.5" />
          <div className="text-sm text-muted-foreground">
            No field tickets yet.
          </div>
          {canEdit && job.status === "Active" && (
            <div className="text-xs text-muted-foreground mt-1">
              Create one to log billable field work on this job.
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-card-border bg-card divide-y divide-card-border">
          {tickets.map((t) => (
            <div key={t.id} className="px-4 py-3" data-testid={`field-ticket-${t.id}`}>
              <div className="flex items-center gap-2 text-sm">
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="font-medium">Ticket #{t.ticket_number}</span>
                <span className="text-muted-foreground">{t.ticket_date}</span>
                <span className="ml-auto font-medium tabular-nums">{money(t.amount)}</span>
                {canEdit && job.status === "Active" && (
                  <div className="flex items-center gap-0.5">
                    <FieldTicketFormDialog
                      job={job}
                      ticket={t}
                      trigger={
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground"
                          data-testid={`button-edit-ticket-${t.id}`}
                          aria-label="Edit ticket"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      }
                    />
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          data-testid={`button-delete-ticket-${t.id}`}
                          aria-label="Delete ticket"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete field ticket #{t.ticket_number}?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This permanently removes the ticket and its billable
                            amount. This can't be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => deleteTicket.mutate(t.id)}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            data-testid={`button-confirm-delete-ticket-${t.id}`}
                          >
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                )}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground pl-6">
                {t.well_name && <span>Well: {t.well_name}</span>}
                {t.po_afe && <span>PO/AFE: {t.po_afe}</span>}
                {t.asset_ids.length > 0 && (
                  <span>
                    Equipment: {t.asset_ids.map(assetTag).join(", ")}
                  </span>
                )}
              </div>
              {t.description && (
                <div className="mt-1.5 text-sm pl-6 whitespace-pre-wrap">{t.description}</div>
              )}
              {t.comments && (
                <div className="mt-1 text-xs text-muted-foreground pl-6 whitespace-pre-wrap">
                  {t.comments}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Drive-by / call-out services — unmanned jobs only */}
      {(job.crewing ?? "Manned") === "Unmanned" && <ServicesSection job={job} />}

      {/* Pads & wells — current well inferred from daily reports */}
      <PadsSection job={job} />

      {/* Field daily reports */}
      <FieldDailyReportsSection job={job} />

      {/* Job Safety Analyses */}
      <JsasSection job={job} />
    </div>
  );
}

// ---- Drive-by / call-out services (unmanned jobs) ------------------------
// Unmanned jobs have no crew logging daily work, so an assigned supervisor (or
// an area manager / admin) records the periodic drive-by and call-out visits
// here — each with a type, date, optional cost, and notes.
function ServiceFormDialog({
  job,
  service,
  trigger,
}: {
  job: JobWithCustomer;
  service?: JobService;
  trigger: React.ReactNode;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<ServiceType>(
    service?.service_type ?? SERVICE_TYPES[0],
  );
  const [date, setDate] = useState(
    service?.service_date?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
  );
  const [cost, setCost] = useState(
    service?.cost === null || service?.cost === undefined
      ? ""
      : String(service.cost),
  );
  const [notes, setNotes] = useState(service?.notes ?? "");
  const NO_WELL = "__none__";
  const [wellId, setWellId] = useState<string>(service?.well_id ?? NO_WELL);
  const servicesKey = ["/api/jobs", job.id, "services"];

  // Wells the supervisor can pick from: everything on the job that isn't
  // completed (report-derived status ≠ "Closed"). Only fetched while the
  // dialog is open.
  const { data: pads } = useQuery<PadWithDerivedWells[]>({
    queryKey: ["/api/jobs", job.id, "pads"],
    enabled: open,
  });
  const openWells = (pads ?? [])
    .flatMap((p) => p.wells)
    .filter((w) => w.status !== "Closed");
  // If editing a service whose well is now completed (or removed), keep it
  // selectable so the current value still shows.
  const currentWellMissing =
    !!service?.well_id && !openWells.some((w) => w.id === service.well_id);

  const reset = () => {
    setType(service?.service_type ?? SERVICE_TYPES[0]);
    setDate(
      service?.service_date?.slice(0, 10) ??
        new Date().toISOString().slice(0, 10),
    );
    setCost(
      service?.cost === null || service?.cost === undefined
        ? ""
        : String(service.cost),
    );
    setNotes(service?.notes ?? "");
    setWellId(service?.well_id ?? NO_WELL);
  };

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        service_type: type,
        service_date: date,
        cost: cost.trim() === "" ? null : Number(cost),
        well_id: wellId === NO_WELL ? null : wellId,
        notes: notes.trim() || null,
      };
      if (service) {
        await apiRequest(
          "PATCH",
          `/api/jobs/${job.id}/services/${service.id}`,
          body,
        );
      } else {
        await apiRequest("POST", `/api/jobs/${job.id}/services`, body);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: servicesKey });
      toast({ title: service ? "Service updated" : "Service logged" });
      setOpen(false);
      if (!service) reset();
    },
    onError: (e: any) =>
      toast({
        title: service ? "Could not update service" : "Could not log service",
        description: e.message,
        variant: "destructive",
      }),
  });

  const dateInvalid = !date;
  const costInvalid = cost.trim() !== "" && Number(cost) < 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{service ? "Edit service" : "Log a service"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Service type</Label>
            <Select
              value={type}
              onValueChange={(v) => setType(v as ServiceType)}
            >
              <SelectTrigger data-testid="select-service-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SERVICE_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Service date</Label>
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              data-testid="input-service-date"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Well (optional)</Label>
            <Select value={wellId} onValueChange={setWellId}>
              <SelectTrigger data-testid="select-service-well">
                <SelectValue placeholder="Which well was open?" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_WELL}>No specific well</SelectItem>
                {currentWellMissing && service?.well_id && (
                  <SelectItem value={service.well_id}>
                    {service.well_name ?? "Selected well"} (completed)
                  </SelectItem>
                )}
                {openWells.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                    {w.status === "Open" ? " · current" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {openWells.length === 0 && !currentWellMissing && (
              <p className="text-xs text-muted-foreground">
                No active wells on this job yet — add wells in Pads &amp; wells
                first, or leave blank.
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>Cost (optional)</Label>
            <div className="relative">
              <DollarSign className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                className="pl-8"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
                placeholder="0.00"
                data-testid="input-service-cost"
              />
            </div>
            {costInvalid && (
              <p className="text-xs text-destructive">Cost cannot be negative.</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>Notes (optional)</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="What was done on this visit?"
              data-testid="input-service-notes"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            data-testid="button-cancel-service"
          >
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={save.isPending || dateInvalid || costInvalid}
            data-testid="button-save-service"
          >
            {save.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            {service ? "Save changes" : "Log service"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ServicesSection({ job }: { job: JobWithCustomer }) {
  const { profile } = useAuth();
  const { toast } = useToast();
  const servicesKey = ["/api/jobs", job.id, "services"];

  const { data: services, isLoading } = useQuery<JobService[]>({
    queryKey: servicesKey,
  });

  // Who can manage services: admin/area always; a supervisor only if assigned
  // to this job (the job payload carries its assignments). Everyone else is
  // read-only. The server enforces this too — this only gates the UI.
  const assignments: { profile_id: string }[] =
    ((job as any).assignments as { profile_id: string }[] | undefined) ?? [];
  const canManage =
    !!profile &&
    (profile.role === "admin" ||
      profile.role === "area" ||
      (profile.role === "super" &&
        assignments.some((a) => a.profile_id === profile.id)));

  const del = useMutation({
    mutationFn: async (id: string) =>
      apiRequest("DELETE", `/api/jobs/${job.id}/services/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: servicesKey });
      toast({ title: "Service deleted" });
    },
    onError: (e: any) =>
      toast({
        title: "Could not delete service",
        description: e.message,
        variant: "destructive",
      }),
  });

  const list = services ?? [];
  const totalCost = list.reduce((s, x) => s + Number(x.cost ?? 0), 0);

  return (
    <>
      <div className="mt-6 mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          Drive-by &amp; call-out services{" "}
          <span className="text-muted-foreground font-normal">
            ({list.length})
          </span>
          {list.length > 0 && (
            <span className="ml-2 text-muted-foreground font-normal">
              · Total cost{" "}
              <span
                className="font-medium text-foreground tabular-nums"
                data-testid="job-services-total"
              >
                {money(totalCost)}
              </span>
            </span>
          )}
        </h2>
        {canManage &&
          (job.status === "Active" ? (
            <ServiceFormDialog
              job={job}
              trigger={
                <Button size="sm" data-testid="button-add-service">
                  <Plus className="mr-2 h-4 w-4" /> Log service
                </Button>
              }
            />
          ) : (
            <span className="text-xs text-muted-foreground">
              Job not active — services are read-only
            </span>
          ))}
      </div>
      {isLoading ? (
        <div className="rounded-lg border border-card-border bg-card p-8 text-center text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin mx-auto mb-1" /> Loading
          services…
        </div>
      ) : list.length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-8 text-center">
          <Navigation className="h-5 w-5 mx-auto text-muted-foreground mb-1.5" />
          <div className="text-sm text-muted-foreground">
            No services logged yet.
          </div>
          {canManage && job.status === "Active" && (
            <div className="text-xs text-muted-foreground mt-1">
              Log a drive-by or call-out visit to this unmanned job.
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-card-border bg-card divide-y divide-card-border">
          {list.map((s) => (
            <div
              key={s.id}
              className="px-4 py-3"
              data-testid={`service-row-${s.id}`}
            >
              <div className="flex items-center gap-2 text-sm">
                <Navigation className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="font-medium">{s.service_type}</span>
                <span className="text-muted-foreground">
                  {padDateFmt(s.service_date)}
                </span>
                {s.well_name && (
                  <span
                    className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                    data-testid={`service-well-${s.id}`}
                  >
                    <Layers className="h-3 w-3" />
                    {s.well_name}
                  </span>
                )}
                <span className="ml-auto font-medium tabular-nums">
                  {money(s.cost)}
                </span>
                {canManage && job.status === "Active" && (
                  <div className="flex items-center gap-0.5">
                    <ServiceFormDialog
                      job={job}
                      service={s}
                      trigger={
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          data-testid={`button-edit-service-${s.id}`}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      }
                    />
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-destructive hover:text-destructive"
                          data-testid={`button-delete-service-${s.id}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete this service?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This removes the {s.service_type.toLowerCase()} from{" "}
                            {padDateFmt(s.service_date)}. This cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => del.mutate(s.id)}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                )}
              </div>
              {s.notes && (
                <div className="mt-1 pl-6 text-sm text-muted-foreground whitespace-pre-wrap">
                  {s.notes}
                </div>
              )}
              {s.created_by_name && (
                <div className="mt-1 pl-6 text-xs text-muted-foreground">
                  Logged by {s.created_by_name}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ---- Pads & wells (report-inferred) --------------------------------------
// A job holds one or more pads; each pad holds wells. Wells are NOT opened and
// closed by hand — the crew's current well is inferred from the daily reports
// (the well named on the most recent report is "current"). Days on a well =
// number of daily reports naming it; revenue = day rate x days. Pads are just
// containers you create; wells attach to a pad once, then their activity is
// derived. When a report names a well not yet on any pad, we prompt to start a
// new pad for it.
const padDateFmt = (d: string | null) =>
  d
    ? new Date(d + "T00:00:00").toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "—";

function PadsSection({ job }: { job: JobWithCustomer }) {
  const { profile } = useAuth();
  const { toast } = useToast();
  const canManage =
    !!profile && ["admin", "area", "super", "field"].includes(profile.role);

  const padsKey = ["/api/jobs", job.id, "pads"];
  const unassignedKey = ["/api/jobs", job.id, "unassigned-wells"];
  const { data: pads, isLoading } = useQuery<PadWithDerivedWells[]>({
    queryKey: padsKey,
    enabled: !!job.id,
  });
  const { data: unassigned } = useQuery<UnassignedWell[]>({
    queryKey: unassignedKey,
    enabled: !!job.id,
  });

  const [newPadOpen, setNewPadOpen] = useState(false);
  const [padWells, setPadWells] = useState("");

  // The new-well prompt. Fires when a well name appears in this job's reports
  // that is not yet attached to any pad. We suggest a pad name from the well.
  //
  // "Not now" dismissals PERSIST per job+well in localStorage, so selecting the
  // job again does not re-spam the pop-up for a well the user already skipped.
  // The dialog auto-opens at most ONCE per job per browser session (tracked in
  // sessionStorage) — after that, un-dismissed wells surface through the calmer
  // amber "unassigned wells" banner + its Review button instead of a modal. A
  // genuinely new well the user has never skipped still prompts on first sight.
  const dismissKey = `dfs.padPrompt.dismissed.${job.id}`;
  const autoOpenedKey = `dfs.padPrompt.autoOpened.${job.id}`;

  const [promptWell, setPromptWell] = useState<UnassignedWell | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(dismissKey);
      return raw ? new Set<string>(JSON.parse(raw)) : new Set<string>();
    } catch {
      return new Set<string>();
    }
  });

  // Persist dismissals whenever they change (per job).
  useEffect(() => {
    try {
      localStorage.setItem(dismissKey, JSON.stringify(Array.from(dismissed)));
    } catch {
      /* storage unavailable — fall back to in-memory only */
    }
  }, [dismissed, dismissKey]);

  const nextPrompt = (unassigned ?? []).find(
    (w) => !dismissed.has(w.name.toLowerCase()),
  );
  // Auto-open the modal only once per job per session. On later selections of
  // the same job, the un-dismissed well shows in the banner (no modal spam).
  useEffect(() => {
    if (!nextPrompt || promptWell || newPadOpen) return;
    let alreadyAutoOpened = false;
    try {
      alreadyAutoOpened = sessionStorage.getItem(autoOpenedKey) === "1";
    } catch {
      /* ignore */
    }
    if (alreadyAutoOpened) return;
    try {
      sessionStorage.setItem(autoOpenedKey, "1");
    } catch {
      /* ignore */
    }
    setPromptWell(nextPrompt);
  }, [nextPrompt, promptWell, newPadOpen, autoOpenedKey]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: padsKey });
    queryClient.invalidateQueries({ queryKey: unassignedKey });
  };

  const createPad = useMutation({
    mutationFn: async (opts: { well_names: string[] }) => {
      const res = await apiRequest("POST", `/api/jobs/${job.id}/pads`, {
        well_names: opts.well_names,
      });
      return res.json();
    },
    onSuccess: () => {
      setNewPadOpen(false);
      setPadWells("");
      invalidate();
      toast({ title: "Pad created" });
    },
    onError: (e: any) =>
      toast({
        title: "Could not create pad",
        description: e.message,
        variant: "destructive",
      }),
  });

  // Create a pad from the detected well (the prompt's "Yes"). The pad name is
  // auto-assigned server-side; the well inside distinguishes it.
  const createPadFromWell = useMutation({
    mutationFn: async (well: UnassignedWell) => {
      const res = await apiRequest("POST", `/api/jobs/${job.id}/pads`, {
        well_names: [well.name],
      });
      return res.json();
    },
    onSuccess: (_d, well) => {
      setPromptWell(null);
      invalidate();
      toast({ title: `New pad started for ${well.name}` });
    },
    onError: (e: any) =>
      toast({
        title: "Could not start pad",
        description: e.message,
        variant: "destructive",
      }),
  });

  const dismissPrompt = () => {
    if (promptWell)
      setDismissed((s) => new Set(s).add(promptWell.name.toLowerCase()));
    setPromptWell(null);
  };

  const dayRate = job.day_rate ?? null;

  return (
    <>
      <div className="mt-8 mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          Pads &amp; wells{" "}
          <span className="text-muted-foreground font-normal">
            ({(pads ?? []).length})
          </span>
        </h2>
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Navigation className="h-3.5 w-3.5" />
          Current well inferred from daily reports
        </span>
      </div>
      <p className="text-xs text-muted-foreground -mt-1 mb-2">
        The crew's current well is the one named on the latest daily report.
        Days and revenue accrue per well from the reports — there is no manual
        open/close.
      </p>

      {/* New-well detected prompt */}
      {promptWell && (
        <AlertDialog open={!!promptWell}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                New well detected: {promptWell.name}
              </AlertDialogTitle>
              <AlertDialogDescription>
                A daily report names “{promptWell.name}”, which isn't on any pad
                for this job yet
                {promptWell.report_days > 0 &&
                  ` (${promptWell.report_days} report day${
                    promptWell.report_days === 1 ? "" : "s"
                  }${
                    promptWell.last_report
                      ? `, latest ${padDateFmt(promptWell.last_report)}`
                      : ""
                  })`}
                . Start a new pad for it?
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={dismissPrompt}>
                Not now
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => createPadFromWell.mutate(promptWell)}
                data-testid="button-confirm-new-pad"
              >
                {createPadFromWell.isPending && (
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                )}
                Start a new pad
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {/* Unassigned wells banner (when the prompt is dismissed but wells remain) */}
      {canManage &&
        !promptWell &&
        (unassigned ?? []).length > 0 && (
          <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-2.5 flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
              <Info className="h-3.5 w-3.5" />
              {(unassigned ?? []).length} well
              {(unassigned ?? []).length === 1 ? "" : "s"} from daily reports not
              on a pad yet:{" "}
              <span className="font-medium">
                {(unassigned ?? []).map((w) => w.name).join(", ")}
              </span>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setPromptWell((unassigned ?? [])[0])}
              data-testid="button-review-unassigned"
            >
              Review
            </Button>
          </div>
        )}

      {canManage && (
        <div className="mb-3">
          {newPadOpen ? (
            <div className="rounded-lg border border-card-border bg-card p-4 space-y-3">
              <p className="text-[11px] text-muted-foreground">
                Pads are numbered automatically (Pad 1, Pad 2, …). The wells you
                add below distinguish this pad.
              </p>
              <div>
                <Label htmlFor="pad-wells" className="text-xs">
                  Wells (one per line or comma-separated)
                </Label>
                <textarea
                  id="pad-wells"
                  className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[70px]"
                  value={padWells}
                  onChange={(e) => setPadWells(e.target.value)}
                  placeholder={"Mustang Draw 12-4H\nMustang Draw 12-5H"}
                  data-testid="input-pad-wells"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Well names should match how they appear on the daily reports
                  so activity attaches automatically.
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() =>
                    createPad.mutate({
                      well_names: padWells
                        .split(/[\n,]/)
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                  disabled={createPad.isPending}
                  data-testid="button-save-pad"
                >
                  {createPad.isPending && (
                    <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                  )}
                  Create pad
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setNewPadOpen(false)}
                  data-testid="button-cancel-pad"
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setNewPadOpen(true)}
              data-testid="button-new-pad"
            >
              <Plus className="h-3.5 w-3.5 mr-1" /> New pad
            </Button>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="rounded-lg border border-card-border bg-card p-6 text-center text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin mx-auto mb-1" /> Loading pads…
        </div>
      ) : (pads ?? []).length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-8 text-center">
          <Layers className="h-5 w-5 mx-auto text-muted-foreground mb-1.5" />
          <div className="text-sm text-muted-foreground">
            No pads on this job yet.
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            {(unassigned ?? []).length > 0
              ? "A well was detected on the daily reports — use the prompt above to start a pad."
              : canManage
                ? "Create a pad, or one will be suggested when a daily report names a well."
                : "A pad will appear here once a well is reported."}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {(pads ?? []).map((pad) => (
            <PadCard
              key={pad.id}
              pad={pad}
              dayRate={dayRate}
              jobId={job.id}
              canManage={canManage}
            />
          ))}
        </div>
      )}
    </>
  );
}

function PadCard({
  pad,
  dayRate,
  jobId,
  canManage,
}: {
  pad: PadWithDerivedWells;
  dayRate: number | null;
  jobId: string;
  canManage: boolean;
}) {
  const { toast } = useToast();
  const wells = pad.wells ?? [];
  const totalDays = wells.reduce((sum, w) => sum + w.report_days, 0);
  // Pad revenue = sum of each well's revenue (the accrued AS57 figure from its
  // latest report). If no well has a revenue value, show nothing.
  const revenueWells = wells.filter((w) => w.revenue != null);
  const totalRevenue =
    revenueWells.length > 0
      ? revenueWells.reduce((sum, w) => sum + (w.revenue ?? 0), 0)
      : null;
  const currentWell = wells.find((w) => w.is_current);

  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(pad.name);

  const rename = useMutation({
    mutationFn: async (name: string) => {
      const res = await apiRequest("PATCH", `/api/pads/${pad.id}`, { name });
      return res.json();
    },
    onSuccess: () => {
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: ["/api/jobs", jobId, "pads"] });
      toast({ title: "Pad renamed" });
    },
    onError: (e: any) =>
      toast({
        title: "Could not rename pad",
        description: e.message,
        variant: "destructive",
      }),
  });

  const startEdit = () => {
    setDraftName(pad.name);
    setEditing(true);
  };
  const saveEdit = () => {
    const name = draftName.trim();
    if (!name || name === pad.name) {
      setEditing(false);
      return;
    }
    rename.mutate(name);
  };

  return (
    <div
      className="rounded-lg border border-card-border bg-card overflow-hidden"
      data-testid={`pad-${pad.id}`}
    >
      {/* Pad header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-card-border bg-muted/40 px-4 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <Layers className="h-4 w-4 text-primary shrink-0" />
          {editing ? (
            <div className="flex items-center gap-1.5">
              <Input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveEdit();
                  if (e.key === "Escape") setEditing(false);
                }}
                autoFocus
                maxLength={80}
                className="h-7 w-48 text-sm"
                data-testid={`input-pad-name-${pad.id}`}
              />
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={saveEdit}
                disabled={rename.isPending}
                data-testid={`button-save-pad-name-${pad.id}`}
                aria-label="Save pad name"
              >
                {rename.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={() => setEditing(false)}
                aria-label="Cancel rename"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : (
            <>
              <span className="text-sm font-semibold">{pad.name}</span>
              {canManage && (
                <button
                  type="button"
                  onClick={startEdit}
                  className="text-muted-foreground hover:text-foreground shrink-0"
                  data-testid={`button-rename-pad-${pad.id}`}
                  aria-label="Rename pad"
                >
                  <Pencil className="h-3 w-3" />
                </button>
              )}
              {currentWell && (
                <span className="text-xs text-muted-foreground truncate">
                  · Current well:{" "}
                  <span className="font-medium text-foreground">
                    {currentWell.name}
                  </span>
                </span>
              )}
            </>
          )}
        </div>
      </div>

      {/* Wells table */}
      {wells.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-muted-foreground">
          No wells on this pad yet. Wells attach automatically as daily reports
          name them.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-card-border text-xs text-muted-foreground">
              <th className="text-left font-medium px-4 py-2">Well</th>
              <th className="text-center font-medium px-3 py-2">Status</th>
              <th className="text-right font-medium px-3 py-2">Report days</th>
              <th className="text-right font-medium px-3 py-2">Dates</th>
              <th className="text-right font-medium px-3 py-2">Revenue</th>
            </tr>
          </thead>
          <tbody>
            {wells.map((w) => {
              const isOpen = w.status === "Open";
              return (
                <tr
                  key={w.id}
                  className="border-b border-card-border last:border-0 align-top"
                  data-testid={`well-row-${w.id}`}
                >
                  <td className="px-4 py-2.5">
                    <div className="font-medium">{w.name}</div>
                    {w.is_current && (
                      <span className="mt-1 inline-flex rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                        Current well
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <span
                      className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        isOpen
                          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                          : w.status === "Closed"
                            ? "bg-muted text-muted-foreground"
                            : "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                      }`}
                    >
                      {isOpen ? "Active" : w.status === "Closed" ? "Worked" : "Pending"}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {w.report_days}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground text-[11px]">
                    {w.first_report ? (
                      <>
                        {padDateFmt(w.first_report)}
                        {w.last_report && w.last_report !== w.first_report && (
                          <> → {padDateFmt(w.last_report)}</>
                        )}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {w.revenue == null ? "—" : money(w.revenue)}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="bg-muted/40 text-xs">
              <td className="px-4 py-2 font-medium">Pad total</td>
              <td />
              <td className="px-3 py-2 text-right tabular-nums font-medium">
                {totalDays}
              </td>
              <td />
              <td className="px-3 py-2 text-right tabular-nums font-medium text-primary">
                {totalRevenue == null ? "—" : money(totalRevenue)}
              </td>
            </tr>
          </tfoot>
        </table>
      )}

      {dayRate == null && wells.length > 0 && (
        <div className="px-4 py-2 text-[11px] text-muted-foreground border-t border-card-border">
          No day rate set on this job, so revenue shows “—”. Report days are
          counted from daily reports naming each well.
        </div>
      )}
    </div>
  );
}

// ---- Daily report KPI trend (per-job) ------------------------------------
// Daily reports are emailed in to the intake inbox and reviewed under Daily
// Reports. Here we only surface this job's KPI trend, read from the emailed
// Excel "Report Day" sheets matched to this job.
function FieldDailyReportsSection({ job }: { job: JobWithCustomer }) {
  const { data: allReports } = useQuery<DailyReportWithLinks[]>({
    queryKey: ["/api/daily-reports"],
    enabled: !!job.id,
  });
  const emailReports = (allReports ?? []).filter(
    (r) => r.source === "email" && r.job_id === job.id,
  );
  const kpiPoints = emailReports.map((r) => ({
    report_date: r.report_date ?? r.received_at ?? "",
    report_number: r.report_day ?? null,
    kpis: r.kpis,
  }));

  return (
    <>
      <div className="mt-8 mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          Daily report KPIs{" "}
          <span className="text-muted-foreground font-normal">
            ({emailReports.length})
          </span>
        </h2>
        <Link
          href="/daily-reports"
          className="text-xs text-primary hover:underline"
          data-testid="link-all-daily-reports"
        >
          View all daily reports
        </Link>
      </div>
      {kpiPoints.length > 0 ? (
        <JobKpiTrend reports={kpiPoints} />
      ) : (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-8 text-center">
          <ClipboardList className="h-5 w-5 mx-auto text-muted-foreground mb-1.5" />
          <div className="text-sm text-muted-foreground">
            No daily reports for this job yet.
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            Reports emailed to the intake inbox appear here once matched to this job.
          </div>
        </div>
      )}
    </>
  );
}

// ---- Job Safety Analyses (per-job) ---------------------------------------
function JsasSection({ job }: { job: JobWithCustomer }) {
  const { toast } = useToast();
  const active = job.status === "Active";
  const { data: jsas } = useQuery<JsaWithJob[]>({
    queryKey: ["/api/jobs", job.id, "jsas"],
    enabled: !!job.id,
  });
  const del = useMutation({
    mutationFn: async (jid: string) => apiRequest("DELETE", `/api/jsas/${jid}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/jobs", job.id, "jsas"] });
      queryClient.invalidateQueries({ queryKey: ["/api/jsas"] });
    },
    onError: (e: any) =>
      toast({ title: "Could not delete", description: e.message, variant: "destructive" }),
  });

  return (
    <>
      <div className="mt-8 mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          Job Safety Analyses (JSAs){" "}
          <span className="text-muted-foreground font-normal">
            ({jsas?.length ?? 0})
          </span>
        </h2>
        {active ? (
          <JsaFormDialog
            job={job}
            trigger={
              <Button size="sm" data-testid="button-add-jsa">
                <Plus className="mr-2 h-4 w-4" /> New JSA
              </Button>
            }
          />
        ) : (
          <span className="text-xs text-muted-foreground">
            Job not active — JSAs are read-only
          </span>
        )}
      </div>
      {!jsas || jsas.length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-8 text-center">
          <ShieldAlert className="h-5 w-5 mx-auto text-muted-foreground mb-1.5" />
          <div className="text-sm text-muted-foreground">No JSAs yet.</div>
          {active && (
            <div className="text-xs text-muted-foreground mt-1">
              Document job steps, hazards, and controls before work begins.
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {jsas.map((j) => (
            <div
              key={j.id}
              className="rounded-lg border border-card-border bg-card px-4 py-3"
              data-testid={`jsa-${j.id}`}
            >
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <ShieldAlert className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="font-medium">JSA #{j.jsa_number}</span>
                <span className="text-muted-foreground">{j.jsa_date}</span>
                <div className="ml-auto flex items-center gap-2">
                  <SignoffControls
                    resource="jsas"
                    id={j.id}
                    jobId={job.id}
                    status={j.status}
                    jobActive={active}
                  />
                  {active && j.status !== "Signed off" && (
                    <div className="flex items-center gap-0.5">
                      <JsaFormDialog
                        job={job}
                        jsa={j}
                        trigger={
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground"
                            data-testid={`button-edit-jsa-${j.id}`}
                            aria-label="Edit JSA"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        }
                      />
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-destructive"
                            data-testid={`button-delete-jsa-${j.id}`}
                            aria-label="Delete JSA"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete JSA #{j.jsa_number}?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This permanently removes the JSA and its steps. This can't be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => del.mutate(j.id)}
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              data-testid={`button-confirm-delete-jsa-${j.id}`}
                            >
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  )}
                </div>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground pl-6">
                {j.well_name && <span>Well: {j.well_name}</span>}
                {j.crew?.length > 0 && (
                  <span>Crew: {j.crew.map((c) => c.name).filter(Boolean).join(", ")}</span>
                )}
                {j.ppe && <span>PPE: {j.ppe}</span>}
                {j.submitted_by_name && <span>By: {j.submitted_by_name}</span>}
                {j.signed_by_name && <span>Signed: {j.signed_by_name}</span>}
              </div>
              {j.task_description && (
                <div className="mt-1.5 text-sm pl-6 whitespace-pre-wrap">{j.task_description}</div>
              )}
              {j.steps?.length > 0 && (
                <div className="mt-2 ml-6 overflow-hidden rounded-md border border-card-border">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50 text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1.5 text-left font-medium w-8">#</th>
                        <th className="px-2 py-1.5 text-left font-medium">Step</th>
                        <th className="px-2 py-1.5 text-left font-medium">Hazards</th>
                        <th className="px-2 py-1.5 text-left font-medium">Controls</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-card-border">
                      {j.steps.map((s, i) => (
                        <tr key={s.id} className="align-top">
                          <td className="px-2 py-1.5 text-muted-foreground">{i + 1}</td>
                          <td className="px-2 py-1.5 whitespace-pre-wrap">{s.step_description}</td>
                          <td className="px-2 py-1.5 whitespace-pre-wrap text-muted-foreground">{s.hazards || "—"}</td>
                          <td className="px-2 py-1.5 whitespace-pre-wrap text-muted-foreground">{s.controls || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {j.status === "Changes requested" && j.change_notes && (
                <div className="mt-1.5 ml-6 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs">
                  <span className="font-medium">Changes requested:</span> {j.change_notes}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function CrewingBadge({ crewing }: { crewing: Crewing }) {
  const manned = crewing === "Manned";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${
        manned
          ? "bg-primary/10 text-primary"
          : "bg-muted text-muted-foreground"
      }`}
      data-testid="badge-crewing"
    >
      {manned ? <User className="h-3 w-3" /> : <PowerOff className="h-3 w-3" />}
      {crewing}
    </span>
  );
}

function BackLink() {
  return (
    <Link href="/jobs">
      <a className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground" data-testid="link-back-jobs">
        <ArrowLeft className="h-4 w-4" /> Field Ops &amp; Jobs
      </a>
    </Link>
  );
}

function Field({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | null;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-0.5">
        <Icon className="h-3.5 w-3.5" /> {label}
      </div>
      <div className={value && value !== "—" ? "" : "text-muted-foreground"}>{value || "—"}</div>
    </div>
  );
}
