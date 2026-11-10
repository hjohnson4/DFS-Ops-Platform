import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import type { PadWithDerivedWells, UnassignedWell } from "@shared/schema";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Info, Loader2, Plus } from "lucide-react";

// ---------------------------------------------------------------------------
// New-well prompt on a daily report. Same choice as the job page's
// "New well detected" pop-up: when the well named on this report isn't on
// any pad for its job yet, offer "Add to <pad>" or "Start a new pad".
// It opens by itself the first time the report is opened in a browser
// session; after "Not now" an amber bar with a "Choose a pad" button stays
// on the report until the well is placed.
// ---------------------------------------------------------------------------

const dateFmt = (d: string | null | undefined) =>
  d
    ? new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : "—";

export function ReportNewWellPrompt({
  reportId,
  jobId,
  wellName,
}: {
  reportId: string;
  jobId: string;
  wellName: string;
}) {
  const { profile } = useAuth();
  const { toast } = useToast();
  const canManage = !!profile && ["admin", "area", "super", "field"].includes(profile.role);

  const padsKey = ["/api/jobs", jobId, "pads"];
  const wellKey = [`/api/jobs/${jobId}/unassigned-wells?well=${encodeURIComponent(wellName)}`];
  const { data: match } = useQuery<UnassignedWell[]>({ queryKey: wellKey, enabled: canManage });
  const well = match && match.length > 0 ? match[0] : null;
  const { data: pads } = useQuery<PadWithDerivedWells[]>({ queryKey: padsKey, enabled: canManage && !!well });

  const [open, setOpen] = useState(false);
  const autoKey = `dfs.padPrompt.report.${reportId}`;
  useEffect(() => {
    if (!well || pads === undefined) return;
    let seen = false;
    try {
      seen = sessionStorage.getItem(autoKey) === "1";
      sessionStorage.setItem(autoKey, "1");
    } catch {
      /* storage unavailable: just open it */
    }
    if (!seen) setOpen(true);
  }, [well, pads, autoKey]);

  const done = (title: string) => {
    setOpen(false);
    queryClient.invalidateQueries({ queryKey: padsKey });
    queryClient.invalidateQueries({ queryKey: ["/api/jobs", jobId, "unassigned-wells"] });
    queryClient.invalidateQueries({ queryKey: wellKey });
    toast({ title });
  };

  const startPad = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/jobs/${jobId}/pads`, { well_names: [well!.name] })).json(),
    onSuccess: () => done(`New pad started for ${well!.name}`),
    onError: (e: any) => toast({ title: "Could not start pad", description: e.message, variant: "destructive" }),
  });
  const addToPad = useMutation({
    mutationFn: async (padId: string) =>
      (await apiRequest("POST", `/api/pads/${padId}/wells`, { name: well!.name })).json(),
    onSuccess: (_d, padId) =>
      done(`${well!.name} added to ${(pads ?? []).find((p) => p.id === padId)?.name ?? "pad"}`),
    onError: (e: any) => toast({ title: "Could not add well", description: e.message, variant: "destructive" }),
  });

  if (!canManage || !well) return null;
  const busy = startPad.isPending || addToPad.isPending;
  const havePads = (pads ?? []).length > 0;

  return (
    <>
      {!open && (
        <div
          className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-2.5 flex flex-wrap items-center justify-between gap-2"
          data-testid="banner-report-new-well"
        >
          <div className="text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
            <Info className="h-3.5 w-3.5" />
            New well on this report: <span className="font-medium">{well.name}</span> isn't on a pad yet.
          </div>
          <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="button-report-choose-pad">
            Choose a pad
          </Button>
        </div>
      )}

      <AlertDialog open={open}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>New well detected: {well.name}</AlertDialogTitle>
            <AlertDialogDescription>
              This daily report names “{well.name}”, which isn't on any pad for this job yet
              {well.report_days > 0 &&
                ` (${well.report_days} report day${well.report_days === 1 ? "" : "s"}${
                  well.last_report ? `, latest ${dateFmt(well.last_report)}` : ""
                })`}
              . {havePads ? "Add it to an existing pad, or start a new pad for it." : "Start a new pad for it?"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {havePads && (
            <div className="flex flex-wrap gap-2">
              {(pads ?? []).map((p) => (
                <Button
                  key={p.id}
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => addToPad.mutate(p.id)}
                  data-testid={`button-report-add-to-pad-${p.id}`}
                >
                  <Plus className="h-3.5 w-3.5 mr-1" /> Add to {p.name}
                </Button>
              ))}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setOpen(false)} disabled={busy}>
              Not now
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                startPad.mutate();
              }}
              disabled={busy}
              data-testid="button-report-new-pad"
            >
              {startPad.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
              Start a new pad
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
