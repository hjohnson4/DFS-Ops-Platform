import { useState, useMemo, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { AREAS, CREWING, type Customer, type Asset, type Crewing } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
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
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Loader2, User, PowerOff, Layers } from "lucide-react";

interface Props {
  trigger: ReactNode;
  // When set, the customer is fixed (used on the customer detail page).
  lockedCustomer?: Customer;
  onCreated?: () => void;
}

export function JobFormDialog({ trigger, lockedCustomer, onCreated }: Props) {
  const { profile } = useAuth();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  // area managers/supers are locked to their own area; admin picks
  const areaLocked = profile?.role !== "admin";

  // Only fetch the customer list when we need the picker.
  const { data: customers } = useQuery<Customer[]>({
    queryKey: ["/api/customers"],
    enabled: !lockedCustomer,
  });
  // Assets — fetched while the dialog is open so we can offer assignment.
  const { data: assets } = useQuery<Asset[]>({
    queryKey: ["/api/assets"],
    enabled: open,
  });
  // Field techs assignable to this job (scoped server-side to the caller's
  // area). Field techs are restricted to only the jobs they are assigned to.
  const { data: fieldTechs } = useQuery<
    { id: string; name: string; role: string; area: string | null }[]
  >({
    queryKey: ["/api/field-techs"],
    enabled: open,
  });
  // Supervisors assignable to this job (scoped server-side to the caller's
  // area). Assigning a supervisor lets them log drive-by / call-out services
  // on unmanned jobs.
  const { data: supervisors } = useQuery<
    { id: string; name: string; role: string; area: string | null }[]
  >({
    queryKey: ["/api/supervisors"],
    enabled: open,
  });

  const [jobNumber, setJobNumber] = useState("");
  const [area, setArea] = useState<string>(profile?.area || AREAS[0]);
  const [customerId, setCustomerId] = useState(lockedCustomer?.id || "");
  const [description, setDescription] = useState("");
  const [wellName, setWellName] = useState("");
  const [dayRate, setDayRate] = useState("");
  const [crewing, setCrewing] = useState<Crewing>("Manned");
  const [startedOn, setStartedOn] = useState("");
  const [endedOn, setEndedOn] = useState("");
  const [assetIds, setAssetIds] = useState<string[]>([]);
  const [techIds, setTechIds] = useState<string[]>([]);
  const [supIds, setSupIds] = useState<string[]>([]);
  // Optional starter pad — just enough to begin; expanded later on the job page.
  const [padName, setPadName] = useState("");
  const [padWells, setPadWells] = useState("");

  const effectiveArea = areaLocked ? profile?.area || AREAS[0] : area;

  // Assets that can be assigned: same area, and not already on another job.
  const eligibleAssets = useMemo(
    () =>
      (assets || []).filter((a) => a.area === effectiveArea && !a.job_id),
    [assets, effectiveArea],
  );

  // Field techs in the job's area, eligible for assignment.
  const eligibleTechs = useMemo(
    () => (fieldTechs || []).filter((t) => t.area === effectiveArea),
    [fieldTechs, effectiveArea],
  );

  // Supervisors in the job's area, eligible for assignment.
  const eligibleSupervisors = useMemo(
    () => (supervisors || []).filter((s) => s.area === effectiveArea),
    [supervisors, effectiveArea],
  );

  const reset = () => {
    setJobNumber("");
    setCustomerId(lockedCustomer?.id || "");
    setDescription("");
    setWellName("");
    setDayRate("");
    setCrewing("Manned");
    setStartedOn("");
    setEndedOn("");
    setAssetIds([]);
    setTechIds([]);
    setSupIds([]);
    setArea(profile?.area || AREAS[0]);
    setPadName("");
    setPadWells("");
  };

  const dateError = !!startedOn && !!endedOn && endedOn < startedOn;

  const create = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/jobs", {
        job_number: jobNumber,
        area: effectiveArea,
        customer_id: lockedCustomer?.id || customerId,
        description: description || null,
        status: "Active",
        crewing,
        started_on: startedOn || null,
        ended_on: endedOn || null,
        day_rate: dayRate.trim() === "" ? null : Number(dayRate),
        well_name: wellName.trim() || null,
        asset_ids: assetIds,
        field_tech_ids: techIds,
        supervisor_ids: supIds,
      });
      const job = await res.json();

      // Optionally seed a starter pad on the brand-new job. This is a
      // best-effort follow-on: if it fails, the job still exists and the pad
      // can be added later from the job page.
      let padWarning: string | null = null;
      if (padName.trim() && job?.id) {
        const well_names = padWells
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter(Boolean);
        try {
          await apiRequest("POST", `/api/jobs/${job.id}/pads`, {
            name: padName.trim(),
            well_names,
          });
        } catch (e: any) {
          padWarning = e?.message || "Pad could not be created.";
        }
      }
      return { job, padWarning };
    },
    onSuccess: ({ padWarning }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/jobs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
      if (padWarning) {
        toast({
          title: "Job created — pad not added",
          description: `${padWarning} You can add the pad from the job page.`,
          variant: "destructive",
        });
      } else {
        toast({
          title: padName.trim() ? "Job and starter pad created" : "Job created",
        });
      }
      setOpen(false);
      reset();
      onCreated?.();
    },
    onError: (e: any) =>
      toast({ title: "Could not create job", description: e.message, variant: "destructive" }),
  });

  const effectiveCustomerId = lockedCustomer?.id || customerId;

  const toggleAsset = (id: string) =>
    setAssetIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  const toggleTech = (id: string) =>
    setTechIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  const toggleSup = (id: string) =>
    setSupIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {lockedCustomer ? `New job for ${lockedCustomer.name}` : "Create a job"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Job number</Label>
              <Input
                value={jobNumber}
                onChange={(e) => setJobNumber(e.target.value)}
                data-testid="input-job-number"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Operating area</Label>
              <Select
                value={areaLocked ? profile?.area || "" : area}
                onValueChange={(v) => {
                  setArea(v);
                  setAssetIds([]); // clear picks when area changes
                  setTechIds([]);
                }}
                disabled={areaLocked}
              >
                <SelectTrigger data-testid="select-job-area">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AREAS.map((a) => (
                    <SelectItem key={a} value={a}>
                      {a}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {lockedCustomer ? (
            <div className="space-y-1.5">
              <Label>Customer</Label>
              <div className="rounded-md border border-card-border bg-muted/40 px-3 py-2 text-sm">
                {lockedCustomer.name}
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label>Customer</Label>
              <Select value={customerId} onValueChange={setCustomerId}>
                <SelectTrigger data-testid="select-job-customer">
                  <SelectValue placeholder="Select a customer" />
                </SelectTrigger>
                <SelectContent>
                  {customers?.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Manned / Unmanned */}
          <div className="space-y-1.5">
            <Label>Crewing</Label>
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
                  {c === "Manned" ? (
                    <User className="h-4 w-4" />
                  ) : (
                    <PowerOff className="h-4 w-4" />
                  )}
                  {c}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          {/* Start / end dates */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Start date (optional)</Label>
              <Input
                type="date"
                value={startedOn}
                onChange={(e) => setStartedOn(e.target.value)}
                data-testid="input-job-started"
              />
            </div>
            <div className="space-y-1.5">
              <Label>End date (optional)</Label>
              <Input
                type="date"
                value={endedOn}
                onChange={(e) => setEndedOn(e.target.value)}
                data-testid="input-job-ended"
              />
            </div>
          </div>
          {dateError && (
            <p className="text-xs text-destructive">
              End date can't be before the start date.
            </p>
          )}

          <div className="space-y-1.5">
            <Label>Starting day rate (optional)</Label>
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
            <p className="text-xs text-muted-foreground">
              Optional starting rate used only until daily reports arrive. Once
              reports come in, the day rate is read from each daily report
              (cell AL57), so it updates automatically when the rate changes.
            </p>
          </div>

          {/* Assign assets */}
          <div className="space-y-1.5">
            <Label>
              Assign assets{" "}
              {assetIds.length > 0 && (
                <span className="text-muted-foreground font-normal">
                  · {assetIds.length} selected
                </span>
              )}
            </Label>
            {eligibleAssets.length === 0 ? (
              <div className="rounded-md border border-dashed border-card-border bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
                No unassigned assets in {effectiveArea}. You can assign equipment
                later from the job's detail page.
              </div>
            ) : (
              <div className="max-h-40 overflow-y-auto rounded-md border border-card-border divide-y divide-card-border">
                {eligibleAssets.map((a) => (
                  <label
                    key={a.id}
                    className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer hover:bg-muted/40"
                    data-testid={`asset-option-${a.id}`}
                  >
                    <Checkbox
                      checked={assetIds.includes(a.id)}
                      onCheckedChange={() => toggleAsset(a.id)}
                    />
                    <span className="font-medium">{a.tag}</span>
                    <span className="text-muted-foreground">{a.category}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Assign field techs */}
          <div className="space-y-1.5">
            <Label>
              Assign field techs{" "}
              {techIds.length > 0 && (
                <span className="text-muted-foreground font-normal">
                  · {techIds.length} selected
                </span>
              )}
            </Label>
            <p className="text-xs text-muted-foreground">
              Assigned field techs see only this job and its data. Techs with no
              assignment fall back to their full area view.
            </p>
            {eligibleTechs.length === 0 ? (
              <div className="rounded-md border border-dashed border-card-border bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
                No field techs in {effectiveArea}. You can assign them later from
                the job's detail page.
              </div>
            ) : (
              <div className="max-h-40 overflow-y-auto rounded-md border border-card-border divide-y divide-card-border">
                {eligibleTechs.map((t) => (
                  <label
                    key={t.id}
                    className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer hover:bg-muted/40"
                    data-testid={`tech-option-${t.id}`}
                  >
                    <Checkbox
                      checked={techIds.includes(t.id)}
                      onCheckedChange={() => toggleTech(t.id)}
                    />
                    <span className="font-medium">{t.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Assign supervisors */}
          <div className="space-y-1.5">
            <Label>
              Assign supervisors{" "}
              {supIds.length > 0 && (
                <span className="text-muted-foreground font-normal">
                  · {supIds.length} selected
                </span>
              )}
            </Label>
            <p className="text-xs text-muted-foreground">
              {crewing === "Unmanned"
                ? "Assigned supervisors can log drive-by and call-out services on this unmanned job."
                : "Assign supervisors to this job. Drive-by / call-out services can only be logged once a job is unmanned."}
            </p>
            {eligibleSupervisors.length === 0 ? (
              <div className="rounded-md border border-dashed border-card-border bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
                No supervisors in {effectiveArea}. You can assign them later from
                the job's detail page.
              </div>
            ) : (
              <div className="max-h-40 overflow-y-auto rounded-md border border-card-border divide-y divide-card-border">
                {eligibleSupervisors.map((s) => (
                  <label
                    key={s.id}
                    className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer hover:bg-muted/40"
                    data-testid={`supervisor-option-${s.id}`}
                  >
                    <Checkbox
                      checked={supIds.includes(s.id)}
                      onCheckedChange={() => toggleSup(s.id)}
                    />
                    <span className="font-medium">{s.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Well name (optional)</Label>
            <Input
              value={wellName}
              onChange={(e) => setWellName(e.target.value)}
              placeholder="e.g. Keg 1-0-39-38 E 505H"
              data-testid="input-job-well-name"
            />
            <p className="text-xs text-muted-foreground">
              Used to auto-match emailed daily reports to this job.
            </p>
          </div>

          {/* Optional starter pad */}
          <div className="rounded-lg border border-card-border bg-muted/20 p-3 space-y-3">
            <div className="flex items-center gap-1.5">
              <Layers className="h-4 w-4 text-primary" />
              <Label className="text-sm font-medium">Starter pad (optional)</Label>
            </div>
            <p className="text-xs text-muted-foreground -mt-1">
              Get the job going with one pad now. Add more pads, wells, and
              open/close them later from the job page.
            </p>
            <div className="space-y-1.5">
              <Label className="text-xs">Pad name</Label>
              <Input
                value={padName}
                onChange={(e) => setPadName(e.target.value)}
                placeholder="e.g. Mustang Draw Pad"
                data-testid="input-starter-pad-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">
                Wells on the pad (optional, one per line or comma-separated)
              </Label>
              <Textarea
                value={padWells}
                onChange={(e) => setPadWells(e.target.value)}
                rows={2}
                placeholder={"Mustang Draw 12-4H\nMustang Draw 12-5H"}
                disabled={!padName.trim()}
                data-testid="input-starter-pad-wells"
              />
              <p className="text-xs text-muted-foreground">
                Wells start as Pending. Open one from the job page when the crew
                begins — only one well per pad is active at a time.
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Description (optional)</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              data-testid="input-job-description"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={() => create.mutate()}
            disabled={create.isPending || !jobNumber || !effectiveCustomerId || dateError}
            data-testid="button-save-job"
          >
            {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create job
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
