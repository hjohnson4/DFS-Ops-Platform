import { useQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { RentalBadge } from "@/components/Rental";

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
      </div>
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
