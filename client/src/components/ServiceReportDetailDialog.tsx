import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import type { ServiceReportDetail, ServiceChecklistAnswer } from "@shared/schema";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ClipboardCheck, AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";

interface Photo {
  id: string;
  file_name: string;
  caption: string | null;
  data_url: string;
}

type Detail = ServiceReportDetail & { photos?: Photo[] };

function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return "—";
  return dt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// Read-only detail view of a filed structured service report. Renders the
// inspection checklist Mitti-style (green pass rows, red flagged rows), the
// score, photos, and free-text sections.
export function ServiceReportDetailDialog({
  reportId,
  onClose,
}: {
  reportId: string | null;
  onClose: () => void;
}) {
  const { profile } = useAuth();
  const { toast } = useToast();
  const { data, isLoading } = useQuery<Detail>({
    queryKey: [`/api/service-forms/${reportId}`],
    enabled: !!reportId,
  });

  // Sign-off is the area manager's job (admins can act anywhere). Only an area
  // manager of the report's own area, or an admin, may sign a pending report.
  const canSignOff =
    !!data &&
    data.status !== "Signed off" &&
    (profile?.role === "admin" ||
      (profile?.role === "area" && profile?.area === data.area));

  const signOff = useMutation({
    mutationFn: async () => {
      if (!reportId) throw new Error("No report");
      const res = await apiRequest("POST", `/api/reports/${reportId}/signoff`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [`/api/service-forms/${reportId}`],
      });
      queryClient.invalidateQueries({ queryKey: ["/api/service-forms"] });
      queryClient.invalidateQueries({ queryKey: ["/api/service/dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["/api/reports"] });
      toast({
        title: "Service report signed off",
        description: "The supervisor who filed it has been notified.",
      });
    },
    onError: (e: any) =>
      toast({
        title: "Could not sign off",
        description: e.message,
        variant: "destructive",
      }),
  });

  const checklist: ServiceChecklistAnswer[] = data?.checklist ?? [];
  const photos = data?.photos ?? [];
  const pct =
    data && data.score_total > 0
      ? Math.round((data.score_pass / data.score_total) * 100)
      : null;

  return (
    <Dialog open={!!reportId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardCheck className="h-5 w-5" />
            Centrifuge service report
          </DialogTitle>
          <DialogDescription>
            {data
              ? `${data.asset_tag ?? "—"} · ${data.asset_category ?? "—"} · filed ${fmtDate(
                  data.report_date,
                )} by ${data.supervisor_name ?? "—"}`
              : "Loading…"}
          </DialogDescription>
        </DialogHeader>

        {isLoading || !data ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            Loading…
          </div>
        ) : (
          <div className="space-y-4">
            {/* Summary bar */}
            <div className="grid grid-cols-3 divide-x divide-card-border rounded-lg border border-card-border overflow-hidden text-center">
              <div className="p-3">
                <div className="text-xs text-muted-foreground">Score</div>
                <div className="text-lg font-semibold">
                  {data.score_total > 0
                    ? `${data.score_pass}/${data.score_total}`
                    : "—"}
                  {pct != null && (
                    <span className="text-sm font-normal text-muted-foreground">
                      {" "}
                      ({pct}%)
                    </span>
                  )}
                </div>
              </div>
              <div className="p-3">
                <div className="text-xs text-muted-foreground">Flagged</div>
                <div
                  className={`text-lg font-semibold ${
                    data.flagged_count > 0 ? "text-red-600 dark:text-red-400" : ""
                  }`}
                >
                  {data.flagged_count}
                </div>
              </div>
              <div className="p-3">
                <div className="text-xs text-muted-foreground">Run hrs</div>
                <div className="text-lg font-semibold">
                  {data.run_hours ?? "—"}
                </div>
              </div>
            </div>

            {/* Checklist */}
            <div className="rounded-lg border border-card-border divide-y divide-card-border overflow-hidden">
              {checklist.map((c) => (
                <div
                  key={c.key}
                  className="flex items-stretch justify-between"
                >
                  <div className="flex-1 px-3 py-2.5">
                    <div className="text-sm">{c.label}</div>
                    {c.note && (
                      <div className="mt-1 flex items-start gap-1 text-xs text-muted-foreground">
                        {c.flagged && (
                          <AlertTriangle className="h-3 w-3 mt-0.5 text-red-500 shrink-0" />
                        )}
                        <span>{c.note}</span>
                      </div>
                    )}
                  </div>
                  <div
                    className={[
                      "w-24 shrink-0 flex items-center justify-center text-sm font-medium text-white",
                      c.answer === "N/A"
                        ? "bg-muted-foreground/70"
                        : c.flagged
                          ? "bg-red-600"
                          : "bg-emerald-600",
                    ].join(" ")}
                  >
                    {c.answer}
                  </div>
                </div>
              ))}
            </div>

            {/* Free-text */}
            {data.work_performed && (
              <div>
                <div className="text-xs font-semibold text-muted-foreground mb-1">
                  Work performed / parts replaced
                </div>
                <div className="text-sm whitespace-pre-wrap">
                  {data.work_performed}
                </div>
              </div>
            )}
            {data.notes && (
              <div>
                <div className="text-xs font-semibold text-muted-foreground mb-1">
                  Notes
                </div>
                <div className="text-sm whitespace-pre-wrap">{data.notes}</div>
              </div>
            )}

            {/* Photos */}
            {photos.length > 0 && (
              <div>
                <div className="text-xs font-semibold text-muted-foreground mb-2">
                  Photos ({photos.length})
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {photos.map((p) => (
                    <a
                      key={p.id}
                      href={p.data_url}
                      target="_blank"
                      rel="noreferrer"
                      className="block"
                    >
                      <img
                        src={p.data_url}
                        alt={p.caption || p.file_name}
                        className="w-full aspect-square object-cover rounded-md border border-card-border"
                      />
                      {p.caption && (
                        <div className="text-[11px] text-muted-foreground mt-1 truncate">
                          {p.caption}
                        </div>
                      )}
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {data && (
          <DialogFooter className="flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            {data.status === "Signed off" ? (
              <span className="inline-flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-4 w-4" />
                Signed off
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">
                Awaiting area manager sign-off
              </span>
            )}
            <div className="flex gap-2">
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
              {canSignOff && (
                <Button
                  onClick={() => signOff.mutate()}
                  disabled={signOff.isPending}
                  data-testid="button-sign-off-service-report"
                >
                  {signOff.isPending ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="mr-1.5 h-4 w-4" />
                  )}
                  Sign off
                </Button>
              )}
            </div>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
