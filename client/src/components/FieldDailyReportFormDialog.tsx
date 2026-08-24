import { useState, useEffect, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  type JobWithCustomer,
  type Asset,
  type FieldDailyReport,
  type CrewMember,
} from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Plus, X } from "lucide-react";

interface Props {
  trigger: ReactNode;
  job: JobWithCustomer;
  report?: FieldDailyReport; // present = edit mode
  onSaved?: () => void;
}

function today() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

export function FieldDailyReportFormDialog({ trigger, job, report, onSaved }: Props) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const editing = !!report;

  const { data: allAssets } = useQuery<Asset[]>({
    queryKey: ["/api/assets"],
    enabled: open,
  });
  const jobAssets = (allAssets || []).filter(
    (a) => a.job_id === job.id || (report?.asset_ids ?? []).includes(a.id),
  );

  const [reportDate, setReportDate] = useState(today());
  const [wellName, setWellName] = useState("");
  const [workSummary, setWorkSummary] = useState("");
  const [crewHours, setCrewHours] = useState("");
  const [comments, setComments] = useState("");
  const [assetIds, setAssetIds] = useState<string[]>([]);
  const [crew, setCrew] = useState<CrewMember[]>([]);

  const seed = () => {
    if (report) {
      setReportDate(report.report_date ?? today());
      setWellName(report.well_name ?? "");
      setWorkSummary(report.work_summary ?? "");
      setCrewHours(report.crew_hours == null ? "" : String(report.crew_hours));
      setComments(report.comments ?? "");
      setAssetIds(report.asset_ids ?? []);
      setCrew(report.crew?.length ? report.crew : []);
    } else {
      setReportDate(today());
      setWellName("");
      setWorkSummary("");
      setCrewHours("");
      setComments("");
      setAssetIds([]);
      setCrew([]);
    }
  };
  useEffect(() => {
    if (open) seed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const toggleAsset = (id: string) =>
    setAssetIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  const setCrewAt = (i: number, patch: Partial<CrewMember>) =>
    setCrew((prev) => prev.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  const addCrew = () => setCrew((prev) => [...prev, { name: "", role: "" }]);
  const removeCrew = (i: number) =>
    setCrew((prev) => prev.filter((_, idx) => idx !== i));

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        report_date: reportDate,
        well_name: wellName.trim() || null,
        work_summary: workSummary.trim() || null,
        crew_hours: crewHours.trim() === "" ? null : Number(crewHours),
        comments: comments.trim() || null,
        asset_ids: assetIds,
        crew: crew
          .filter((c) => c.name.trim() !== "")
          .map((c) => ({ name: c.name.trim(), role: c.role?.trim() || null })),
      };
      const res = editing
        ? await apiRequest("PATCH", `/api/field-daily-reports/${report!.id}`, body)
        : await apiRequest("POST", `/api/jobs/${job.id}/field-daily-reports`, body);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/jobs", job.id, "field-daily-reports"],
      });
      queryClient.invalidateQueries({ queryKey: ["/api/field-daily-reports"] });
      toast({ title: editing ? "Daily report updated" : "Daily report submitted" });
      setOpen(false);
      onSaved?.();
    },
    onError: (e: any) =>
      toast({
        title: editing ? "Could not update report" : "Could not submit report",
        description: e.message,
        variant: "destructive",
      }),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {editing
              ? `Edit daily report #${report!.report_number} · Job ${job.job_number}`
              : `New daily report · Job ${job.job_number}`}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Customer</Label>
              <div className="rounded-md border border-card-border bg-muted/40 px-3 py-2 text-sm">
                {job.customer_name}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Job number</Label>
              <div className="rounded-md border border-card-border bg-muted/40 px-3 py-2 text-sm">
                {job.job_number} · {job.area}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label>Report date</Label>
              <Input
                type="date"
                value={reportDate}
                onChange={(e) => setReportDate(e.target.value)}
                data-testid="input-fdr-date"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Well name</Label>
              <Input
                value={wellName}
                onChange={(e) => setWellName(e.target.value)}
                placeholder="e.g. Keg 1-0-39"
                data-testid="input-fdr-well"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Crew hours</Label>
              <Input
                type="number"
                min="0"
                step="0.5"
                inputMode="decimal"
                value={crewHours}
                onChange={(e) => setCrewHours(e.target.value)}
                placeholder="0"
                data-testid="input-fdr-crew-hours"
              />
            </div>
          </div>

          {/* Crew on site */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>Crew on site</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addCrew}
                data-testid="button-add-crew"
              >
                <Plus className="mr-1 h-3.5 w-3.5" /> Add crew
              </Button>
            </div>
            {crew.length === 0 ? (
              <div className="rounded-md border border-dashed border-card-border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
                No crew added yet.
              </div>
            ) : (
              <div className="space-y-2">
                {crew.map((c, i) => (
                  <div key={i} className="flex gap-2" data-testid={`crew-row-${i}`}>
                    <Input
                      className="flex-1"
                      placeholder="Name"
                      value={c.name}
                      onChange={(e) => setCrewAt(i, { name: e.target.value })}
                    />
                    <Input
                      className="flex-1"
                      placeholder="Role (optional)"
                      value={c.role ?? ""}
                      onChange={(e) => setCrewAt(i, { role: e.target.value })}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeCrew(i)}
                      aria-label="Remove crew member"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Equipment used */}
          <div className="space-y-1.5">
            <Label>
              Equipment / assets used{" "}
              {assetIds.length > 0 && (
                <span className="text-muted-foreground font-normal">
                  · {assetIds.length} selected
                </span>
              )}
            </Label>
            {jobAssets.length === 0 ? (
              <div className="rounded-md border border-dashed border-card-border bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
                No assets are assigned to this job.
              </div>
            ) : (
              <div className="max-h-36 overflow-y-auto rounded-md border border-card-border divide-y divide-card-border">
                {jobAssets.map((a) => (
                  <label
                    key={a.id}
                    className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer hover:bg-muted/40"
                    data-testid={`fdr-asset-${a.id}`}
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

          <div className="space-y-1.5">
            <Label>Work summary</Label>
            <Textarea
              value={workSummary}
              onChange={(e) => setWorkSummary(e.target.value)}
              rows={3}
              placeholder="Summary of work performed on site."
              data-testid="input-fdr-summary"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Comments / notes (optional)</Label>
            <Textarea
              value={comments}
              onChange={(e) => setComments(e.target.value)}
              rows={2}
              data-testid="input-fdr-comments"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={() => save.mutate()}
            disabled={save.isPending || !reportDate}
            data-testid="button-save-fdr"
          >
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {editing ? "Save changes" : "Submit report"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
