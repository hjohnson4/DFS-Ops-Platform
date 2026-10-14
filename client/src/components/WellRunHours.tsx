import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Gauge, Loader2, PlusCircle } from "lucide-react";
import { RentalBadge } from "@/components/Rental";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type CreditPreview = {
  problem: string | null;
  reports: number;
  hours: number;
  per_asset: {
    asset_id: string;
    tag: string;
    centrifuge_slot: number | null;
    hours: number;
    days: number;
    first_date: string | null;
    last_date: string | null;
    meter_now: number;
  }[];
  duplicates: number;
  unrouted: number;
};

type WellRunHoursData = {
  ready: boolean;
  assets: {
    id: string;
    tag: string;
    category: string;
    is_rental: boolean;
    rental_vendor: string | null;
    centrifuge_slot: number | null;
    on_job_now: boolean;
  }[];
  wells: {
    well_name: string;
    first_date: string | null;
    last_date: string | null;
    by_asset: Record<string, number>;
    total: number;
    awaiting_hours: number;
    uncredited_hours: number;
  }[];
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shortDate(d: string | null) {
  const m = d ? /^(\d{4})-(\d{2})-(\d{2})/.exec(d) : null;
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : "—";
}
const hrs = (n: number | undefined) =>
  n != null && n > 0 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—";

// Run hours each centrifuge has logged on each well of this job. Hours come
// from signed-off daily reports (the same log that feeds the asset meter and
// Service), routed by the centrifuge's column on the report.
export function WellRunHours({ jobId }: { jobId: string }) {
  const { data, isLoading } = useQuery<WellRunHoursData>({
    queryKey: [`/api/jobs/${jobId}/well-run-hours`],
  });
  const { profile } = useAuth();
  const canCredit = profile?.role === "admin" || profile?.role === "area";
  const [crediting, setCrediting] = useState(false);

  const assets = data?.assets ?? [];
  const wells = (data?.wells ?? []).filter(
    (w) => w.total > 0 || w.awaiting_hours > 0 || w.uncredited_hours > 0,
  );
  const showAwaiting = wells.some((w) => w.awaiting_hours > 0);
  const showUncredited = wells.some((w) => w.uncredited_hours > 0);
  // Only show columns for assets with hours here, plus centrifuges on the job now.
  const cols = assets.filter(
    (a) => a.on_job_now || wells.some((w) => (w.by_asset[a.id] ?? 0) > 0),
  );
  const assetTotal = (id: string) => wells.reduce((t, w) => t + (w.by_asset[id] ?? 0), 0);
  const grand = wells.reduce((t, w) => t + w.total, 0);
  const sumAwaiting = wells.reduce((t, w) => t + w.awaiting_hours, 0);
  const sumUncredited = wells.reduce((t, w) => t + w.uncredited_hours, 0);

  return (
    <>
      <div className="mt-6 mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold inline-flex items-center gap-1.5">
          <Gauge className="h-4 w-4 text-muted-foreground" />
          Run hours by well{" "}
          <span className="text-muted-foreground font-normal">({wells.length})</span>
        </h2>
        {canCredit && showUncredited && (
          <Button size="sm" variant="outline" onClick={() => setCrediting(true)} data-testid="button-credit-run-hours">
            <PlusCircle className="mr-1.5 h-4 w-4" /> Credit these hours
          </Button>
        )}
      </div>
      {crediting && <CreditHoursDialog jobId={jobId} onClose={() => setCrediting(false)} />}
      {isLoading ? (
        <div className="rounded-lg border border-card-border bg-card p-4 text-sm text-muted-foreground">Loading…</div>
      ) : data && !data.ready ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          The run-hours log isn't set up yet, so hours by well can't be shown.
        </div>
      ) : wells.length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-4 text-sm text-muted-foreground">
          No run hours logged on this job yet. Hours appear here once daily reports with centrifuge run hours are signed off.
        </div>
      ) : (
        <div className="rounded-lg border border-card-border bg-card overflow-x-auto" data-testid="table-well-run-hours">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="text-left font-medium px-3 py-2">Well</th>
                <th className="text-left font-medium px-3 py-2 whitespace-nowrap">Report dates</th>
                {cols.map((a) => (
                  <th key={a.id} className="text-right font-medium px-3 py-2 whitespace-nowrap">
                    <div className="inline-flex items-center gap-1 text-foreground">
                      {a.tag} <RentalBadge asset={a as any} />
                    </div>
                    <div className="font-normal">
                      {a.on_job_now
                        ? a.centrifuge_slot
                          ? `Centrifuge ${a.centrifuge_slot}`
                          : a.category.replace(" Centrifuge", "")
                        : "Released"}
                    </div>
                  </th>
                ))}
                <th className="text-right font-medium px-3 py-2 whitespace-nowrap">Well total</th>
                {showAwaiting && (
                  <th className="text-right font-medium px-3 py-2 whitespace-nowrap" title="Hours on reports still pending review. They are credited at sign-off.">
                    Awaiting sign-off
                  </th>
                )}
                {showUncredited && (
                  <th className="text-right font-medium px-3 py-2 whitespace-nowrap" title="Hours on signed-off reports that were never credited to an asset (for example, the centrifuge wasn't assigned or mapped at the time).">
                    Not credited
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {wells.map((w) => (
                <tr key={w.well_name} className="border-t border-card-border" data-testid={`row-well-hours-${w.well_name}`}>
                  <td className="px-3 py-2 font-medium">{w.well_name}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                    {shortDate(w.first_date)}
                    {w.last_date && w.last_date !== w.first_date ? ` – ${shortDate(w.last_date)}` : ""}
                  </td>
                  {cols.map((a) => (
                    <td key={a.id} className="px-3 py-2 text-right tabular-nums">{hrs(w.by_asset[a.id])}</td>
                  ))}
                  <td className="px-3 py-2 text-right tabular-nums font-semibold">{hrs(w.total)}</td>
                  {showAwaiting && (
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{hrs(w.awaiting_hours)}</td>
                  )}
                  {showUncredited && (
                    <td className="px-3 py-2 text-right tabular-nums text-amber-700 dark:text-amber-400">{hrs(w.uncredited_hours)}</td>
                  )}
                </tr>
              ))}
            </tbody>
            {wells.length > 1 && (
              <tfoot>
                <tr className="border-t border-card-border bg-muted/30">
                  <td className="px-3 py-2 font-semibold" colSpan={2}>Job total</td>
                  {cols.map((a) => (
                    <td key={a.id} className="px-3 py-2 text-right tabular-nums font-semibold">{hrs(assetTotal(a.id))}</td>
                  ))}
                  <td className="px-3 py-2 text-right tabular-nums font-semibold">{hrs(grand)}</td>
                  {showAwaiting && <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{hrs(sumAwaiting)}</td>}
                  {showUncredited && (
                    <td className="px-3 py-2 text-right tabular-nums text-amber-700 dark:text-amber-400">{hrs(sumUncredited)}</td>
                  )}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {wells.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Hours credited to each centrifuge from signed-off daily reports, using the centrifuge's column on the report.
          {showUncredited ? " “Not credited” hours are on signed-off reports but were never added to an asset." : ""}
        </p>
      )}
    </>
  );
}

// Confirm-and-credit: shows exactly which centrifuge gets how many hours,
// then adds them to the meters, the run-hours log, and marks the reports
// credited so they're never added twice.
function CreditHoursDialog({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const { toast } = useToast();
  const url = `/api/jobs/${jobId}/credit-run-hours`;
  const { data, isLoading, error } = useQuery<CreditPreview>({ queryKey: [url], staleTime: 0, gcTime: 0 });
  const go = useMutation({
    mutationFn: async () => (await apiRequest("POST", url)).json(),
    onSuccess: (r: any) => {
      queryClient.invalidateQueries({ queryKey: [`/api/jobs/${jobId}/well-run-hours`] });
      queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
      queryClient.invalidateQueries({ queryKey: [url] });
      toast({
        title: "Run hours credited",
        description: (r?.per_asset || []).map((a: any) => `${a.tag} +${hrs(a.hours)} hrs`).join(" · "),
      });
      onClose();
    },
    onError: (e: any) => toast({ title: "Could not credit the hours", description: e.message, variant: "destructive" }),
  });
  const rows = (data?.per_asset || []).filter((a) => a.hours > 0);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Credit these hours</DialogTitle>
          <DialogDescription>
            Adds the run hours from signed-off reports that were never credited to the centrifuges on this job now.
          </DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking reports…
          </div>
        ) : error ? (
          <div className="py-2 text-sm text-rose-700 dark:text-rose-400">{(error as any).message}</div>
        ) : data?.problem ? (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm" data-testid="text-credit-problem">
            {data.problem}
          </div>
        ) : !rows.length ? (
          <div className="py-2 text-sm text-muted-foreground">There are no run hours left to credit on this job.</div>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="overflow-hidden rounded-md border border-card-border">
              <table className="w-full">
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-medium">Centrifuge</th>
                    <th className="px-3 py-1.5 text-left font-medium">Report dates</th>
                    <th className="px-3 py-1.5 text-right font-medium">Adds</th>
                    <th className="px-3 py-1.5 text-right font-medium">Meter after</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => (
                    <tr key={a.asset_id} className="border-t border-card-border" data-testid={`credit-row-${a.tag}`}>
                      <td className="px-3 py-1.5">
                        <div className="font-medium">{a.tag}</div>
                        <div className="text-xs text-muted-foreground">
                          {a.centrifuge_slot ? `Centrifuge ${a.centrifuge_slot}` : "Only unit on job"} · {a.days} day{a.days === 1 ? "" : "s"}
                        </div>
                      </td>
                      <td className="px-3 py-1.5 text-xs text-muted-foreground whitespace-nowrap">
                        {shortDate(a.first_date)}
                        {a.last_date && a.last_date !== a.first_date ? ` – ${shortDate(a.last_date)}` : ""}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums font-semibold">+{hrs(a.hours)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{hrs(a.meter_now + a.hours)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">
              {data!.reports} report{data!.reports === 1 ? "" : "s"}, {hrs(data!.hours)} hours in all. Check these are the units
              that were on the job on those dates.
              {data!.duplicates > 0 ? ` ${data!.duplicates} duplicate cop${data!.duplicates === 1 ? "y" : "ies"} of an already-counted day will be skipped.` : ""}
              {data!.unrouted > 0
                ? ` ${data!.unrouted} report${data!.unrouted === 1 ? " has" : "s have"} hours only in a centrifuge column no unit is set to, so ${data!.unrouted === 1 ? "it stays" : "they stay"} not credited.`
                : ""}
            </p>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => go.mutate()}
            disabled={!rows.length || !!data?.problem || go.isPending}
            data-testid="button-confirm-credit"
          >
            {go.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}Credit {rows.length ? `${hrs(data!.hours)} hours` : "hours"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
