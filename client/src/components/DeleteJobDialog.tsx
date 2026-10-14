import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";

type Preview = {
  job: { id: string; job_number: string; area: string };
  counts: { table: string; label: string; count: number }[];
  move_targets: { id: string; job_number: string; area: string; customer_name: string | null; same_number: boolean }[];
};

const UNLINK = "__unlink";

// Admin-only: permanently delete an ARCHIVED job. Its daily reports and intake
// JSAs are kept: they move to the active job you pick (status kept), or go
// back to "Needs job match". Everything else on the job is deleted with it.
export function DeleteJobDialog({
  jobId,
  jobNumber,
  open,
  onOpenChange,
}: {
  jobId: string;
  jobNumber: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [confirm, setConfirm] = useState("");
  const [moveTo, setMoveTo] = useState<string>(UNLINK);
  const { data, isLoading, error } = useQuery<Preview>({
    queryKey: [`/api/jobs/${jobId}/delete-preview`],
    enabled: open,
  });
  // Default the move target to the one live job with the same number.
  useEffect(() => {
    if (!data) return;
    const same = data.move_targets.filter((t) => t.same_number);
    setMoveTo(same.length === 1 ? same[0].id : UNLINK);
  }, [data]);
  useEffect(() => {
    if (!open) setConfirm("");
  }, [open]);

  const reports = data?.counts.find((c) => c.table === "daily_reports")?.count ?? 0;
  const jsas = data?.counts.find((c) => c.table === "jsa_reports")?.count ?? 0;
  const deleted = (data?.counts ?? []).filter((c) => c.table !== "daily_reports" && c.table !== "jsa_reports" && c.count > 0);
  const target = data?.move_targets.find((t) => t.id === moveTo);
  const confirmed = confirm.trim().toLowerCase() === jobNumber.trim().toLowerCase();

  const del = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/jobs/${jobId}/delete`, {
        confirm_job_number: confirm.trim(),
        move_to_job_id: moveTo === UNLINK ? null : moveTo,
      });
      return res.json();
    },
    onSuccess: (r: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/jobs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/daily-reports"] });
      queryClient.invalidateQueries({ queryKey: ["/api/jsa-intake"] });
      toast({
        title: `Job ${jobNumber} deleted`,
        description:
          r.moved_reports || r.moved_jsas
            ? r.moved_to
              ? `${r.moved_reports} daily report(s) and ${r.moved_jsas} JSA(s) moved to ${r.moved_to}.`
              : `${r.moved_reports} daily report(s) and ${r.moved_jsas} JSA(s) are back in Needs job match.`
            : undefined,
      });
      onOpenChange(false);
      navigate("/jobs");
    },
    onError: (e: any) => toast({ title: "Could not delete job", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Delete archived job {jobNumber}?</DialogTitle>
          <DialogDescription>This permanently removes the job. It can't be undone.</DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Checking what's on this job…</div>
        ) : error ? (
          <div className="text-sm text-destructive">{(error as Error).message}</div>
        ) : data ? (
          <div className="space-y-4 text-sm">
            {reports + jsas > 0 && (
              <div className="space-y-2">
                <Label>
                  Its {reports} daily report{reports === 1 ? "" : "s"}
                  {jsas ? ` and ${jsas} intake JSA${jsas === 1 ? "" : "s"}` : ""} will be kept. Move them to:
                </Label>
                <Select value={moveTo} onValueChange={setMoveTo}>
                  <SelectTrigger data-testid="select-delete-move-to">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNLINK}>No job (back to Needs job match)</SelectItem>
                    {data.move_targets.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.job_number} · {t.customer_name || "—"} · {t.area}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="text-xs text-muted-foreground">
                  {target
                    ? `They keep their status (signed off stays signed off) and move to ${target.job_number}.`
                    : "They lose their job link and wait in Needs job match to be assigned."}
                </div>
              </div>
            )}
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
              <div className="flex items-center gap-1.5 font-medium text-destructive">
                <AlertTriangle className="h-4 w-4" /> Deleted with the job
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {deleted.length
                  ? `${deleted.map((c) => `${c.count} ${c.count === 1 ? c.label.toLowerCase().replace(/s$/, "") : c.label.toLowerCase()}`).join(" · ")}.`
                  : "Nothing else is attached to this job."}{" "}
                Assets, run-hour history and forecasts are kept and just lose the link to this job.
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirm-delete-job">
                Type <span className="font-semibold">{jobNumber}</span> to confirm
              </Label>
              <Input
                id="confirm-delete-job"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="off"
                data-testid="input-confirm-delete-job"
              />
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={del.isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => del.mutate()}
            disabled={!data || !confirmed || del.isPending}
            data-testid="button-confirm-delete-job"
          >
            {del.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Trash2 className="mr-1.5 h-4 w-4" />}
            Delete job
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
