import { useQuery } from "@tanstack/react-query";
import { fmtWoDate } from "@/components/RefurbishmentHistory";
import { ArrowRightLeft, MapPin, Truck, Warehouse } from "lucide-react";

// ---------------------------------------------------------------------------
// Move log for one asset — every job it has been on, the unassigned (yard)
// time in between, and trips out on work orders. Built from the job history
// the database keeps automatically whenever a unit goes on or off a job.
// Shown in the asset detail pop-up for admin / area / super.
// ---------------------------------------------------------------------------

type MoveEntry = {
  kind: "job" | "unassigned" | "work_order";
  start: string;
  end: string | null;
  days: number;
  current: boolean;
  job_number?: string | null;
  well_name?: string | null;
  area?: string | null;
  start_from_reports?: boolean;
  end_from_reports?: boolean;
  ended?: "moved" | "job_archived" | "job_deleted" | "taken_off" | "reports_only" | null;
  moved_to?: string | null;
  first_report?: string | null;
  last_report?: string | null;
  report_days?: number;
  wo_number?: string;
  vendor?: string | null;
  open?: boolean;
};
type MoveLog = { tracking_since: string | null; today: string; moves: MoveEntry[] };

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function whereText(m: MoveEntry): string {
  if (m.kind === "unassigned") return `Unassigned (yard)${m.area ? ` \u00b7 ${m.area}` : ""}`;
  if (m.kind === "work_order") return `Sent out \u00b7 ${m.vendor || "vendor"} (${m.wo_number})`;
  if (!m.job_number) return "Deleted job";
  return `${m.job_number}${m.area ? ` \u00b7 ${m.area}` : ""}`;
}

function endText(m: MoveEntry): string {
  if (m.current) return m.kind === "work_order" ? "Still out" : "Here now";
  if (m.kind === "unassigned") return "Put on a job";
  if (m.kind === "work_order") return "Back from vendor";
  switch (m.ended) {
    case "moved":
      return m.moved_to ? `Moved to ${m.moved_to}` : "Moved to another job";
    case "job_archived":
      return "Released when the job was archived";
    case "job_deleted":
      return "Job was deleted";
    case "reports_only":
      return "Last daily report";
    default:
      return "Taken off the job";
  }
}

function Icon({ m }: { m: MoveEntry }) {
  const cls = "h-4 w-4 shrink-0 mt-0.5";
  if (m.kind === "unassigned") return <Warehouse className={`${cls} text-muted-foreground`} />;
  if (m.kind === "work_order") return <Truck className={`${cls} text-amber-600 dark:text-amber-400`} />;
  return <MapPin className={`${cls} text-primary`} />;
}

export function AssetMoveLog({ assetId }: { assetId: string }) {
  const { data, isLoading, error } = useQuery<MoveLog>({
    queryKey: [`/api/assets/${assetId}/moves`],
  });

  return (
    <div data-testid="asset-move-log">
      <div className="flex items-center gap-1.5 text-sm font-medium mb-2">
        <ArrowRightLeft className="h-4 w-4 text-muted-foreground" />
        Move log
        {data && <span className="text-xs text-muted-foreground font-normal">({data.moves.length})</span>}
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground py-3">Loading…</div>
      ) : error ? (
        <div className="text-sm text-destructive">{(error as Error).message}</div>
      ) : !data ? null : data.moves.length === 0 ? (
        <div className="rounded-md border border-dashed border-card-border bg-muted/30 p-5 text-center text-sm text-muted-foreground">
          No moves recorded for this asset yet.
        </div>
      ) : (
        <div className="rounded-md border border-card-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-card-border bg-muted/40 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Where</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">From</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">To</th>
                <th className="px-3 py-2 font-medium hidden sm:table-cell">How it ended</th>
              </tr>
            </thead>
            <tbody>
              {data.moves.map((m, i) => (
                <tr
                  key={`${m.kind}-${m.start}-${i}`}
                  className={`border-b border-card-border last:border-0 align-top ${m.current ? "bg-primary/5" : ""}`}
                  data-testid={`move-row-${i}`}
                >
                  <td className="px-3 py-2">
                    <div className="flex gap-2">
                      <Icon m={m} />
                      <div>
                        <div className="font-medium">{whereText(m)}</div>
                        {m.kind === "job" && m.well_name && (
                          <div className="text-xs text-muted-foreground">{m.well_name}</div>
                        )}
                        {m.kind === "job" && (m.report_days ?? 0) > 0 && (
                          <div className="text-xs text-muted-foreground">
                            {plural(m.report_days!, "report day")} logged
                            {m.first_report ? ` \u00b7 ${fmtWoDate(m.first_report)} \u2013 ${fmtWoDate(m.last_report)}` : ""}
                          </div>
                        )}
                        <div className="text-xs text-muted-foreground sm:hidden mt-0.5">{endText(m)}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <div>{fmtWoDate(m.start)}</div>
                    {m.start_from_reports && (
                      <div className="text-xs text-muted-foreground">first daily report</div>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <div>{m.current ? "Now" : fmtWoDate(m.end)}</div>
                    <div className="text-xs text-muted-foreground">
                      {m.days === 0 ? (m.current ? "since today" : "same day") : plural(m.days, "day")}
                    </div>
                  </td>
                  <td className="px-3 py-2 hidden sm:table-cell text-muted-foreground">{endText(m)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data?.tracking_since && (
        <div className="text-xs text-muted-foreground mt-1.5">
          Job moves are recorded automatically starting {fmtWoDate(data.tracking_since)}. Anything earlier comes
          from daily reports.
        </div>
      )}
    </div>
  );
}
