import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import type { RigUpReportDetail, RigInspectionAnswer } from "@shared/schema";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  ClipboardCheck,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  ShieldCheck,
} from "lucide-react";

function fmtConducted(s: string | null | undefined): string {
  if (!s) return "—";
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!m) return s;
  const d = new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...(m[4] ? { hour: "numeric", minute: "2-digit" } : {}),
  });
}

// One photo, fetched with the user's login (the photo route needs auth).
function AuthedPhoto({ reportId, photoId, name }: { reportId: string; photoId: string; name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    apiRequest("GET", `/api/rig-up-reports/${reportId}/photos/${photoId}`)
      .then((r) => r.blob())
      .then((b) => {
        objectUrl = URL.createObjectURL(b);
        if (alive) setUrl(objectUrl);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [reportId, photoId]);
  if (failed)
    return (
      <div className="h-28 w-full rounded-md border border-card-border flex items-center justify-center text-xs text-muted-foreground">
        Could not load
      </div>
    );
  if (!url)
    return <div className="h-28 w-full rounded-md border border-card-border bg-muted animate-pulse" />;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="block">
      <img src={url} alt={name} className="h-28 w-full rounded-md object-cover border border-card-border" />
    </a>
  );
}

// Read-only view of a filed rig inspection: score, flagged items, the full
// checklist (green pass / red flagged), photos and the area-manager sign-off.
export function RigInspectionDetailDialog({
  reportId,
  onClose,
}: {
  reportId: string | null;
  onClose: () => void;
}) {
  const { profile } = useAuth();
  const { toast } = useToast();
  const { data, isLoading } = useQuery<RigUpReportDetail>({
    queryKey: [`/api/rig-up-reports/${reportId}`],
    enabled: !!reportId,
  });

  const canSignOff =
    !!data &&
    data.status !== "Signed off" &&
    (profile?.role === "admin" || (profile?.role === "area" && profile?.area === data.area));

  const signOff = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/rig-up-reports/${reportId}/sign-off`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/rig-up-reports/${reportId}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/rig-up-reports"] });
      toast({ title: "Rig inspection signed off" });
    },
    onError: (e: any) =>
      toast({ title: "Could not sign off", description: e.message, variant: "destructive" }),
  });

  const checklist: RigInspectionAnswer[] = data?.checklist ?? [];
  const flagged = checklist.filter((c) => c.flagged);
  const sections: { name: string; items: RigInspectionAnswer[] }[] = [];
  for (const c of checklist) {
    let s = sections.find((x) => x.name === c.section);
    if (!s) sections.push((s = { name: c.section, items: [] }));
    s.items.push(c);
  }
  const pct =
    data && data.score_total && data.score_total > 0
      ? Math.round(((data.score_pass ?? 0) / data.score_total) * 100)
      : null;

  return (
    <Dialog open={!!reportId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardCheck className="h-5 w-5" />
            Rig inspection{data?.rig_number ? ` · ${data.rig_number}` : ""}
          </DialogTitle>
          <DialogDescription>
            {data ? `${data.job_number ?? "—"} · ${data.customer_name ?? "—"} · ${data.area}` : " "}
          </DialogDescription>
        </DialogHeader>

        {isLoading || !data ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
            Loading…
          </div>
        ) : (
          <div className="space-y-4">
            {/* Summary */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div className="rounded-md border border-card-border p-2.5">
                <div className="text-xs text-muted-foreground">Score</div>
                <div className="text-base font-semibold">
                  {pct == null ? "—" : `${pct}%`}
                  <span className="text-xs font-normal text-muted-foreground">
                    {" "}
                    ({data.score_pass ?? 0}/{data.score_total ?? 0})
                  </span>
                </div>
              </div>
              <div className="rounded-md border border-card-border p-2.5">
                <div className="text-xs text-muted-foreground">Flagged</div>
                <div className={`text-base font-semibold ${(data.flagged_count ?? 0) > 0 ? "text-red-600 dark:text-red-400" : ""}`}>
                  {data.flagged_count ?? 0}
                </div>
              </div>
              <div className="rounded-md border border-card-border p-2.5">
                <div className="text-xs text-muted-foreground">Photos</div>
                <div className="text-base font-semibold">{data.photos.length}</div>
              </div>
              <div className="rounded-md border border-card-border p-2.5">
                <div className="text-xs text-muted-foreground">Status</div>
                <div className={`text-sm font-semibold ${data.status === "Signed off" ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400"}`}>
                  {data.status}
                </div>
              </div>
            </div>

            {/* Title page */}
            <div className="rounded-md border border-card-border divide-y divide-card-border text-sm">
              {[
                ["Site conducted", data.site_conducted],
                ["Rig number", data.rig_number],
                ["Conducted on", fmtConducted(data.conducted_on)],
                ["Prepared by", data.prepared_by],
                ["Filed by", data.uploaded_by_name],
                [
                  "Signed off",
                  data.signed_off_by_name
                    ? `${data.signed_off_by_name} · ${new Date(data.signed_off_at || "").toLocaleDateString()}`
                    : null,
                ],
              ].map(([k, v]) => (
                <div key={k as string} className="flex justify-between gap-3 px-3 py-2">
                  <span className="text-muted-foreground">{k}</span>
                  <span className="text-right">{v || "—"}</span>
                </div>
              ))}
            </div>

            {/* Flagged items */}
            {flagged.length > 0 && (
              <div className="rounded-md border border-red-300 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-3">
                <div className="flex items-center gap-1.5 text-sm font-semibold text-red-700 dark:text-red-400 mb-1.5">
                  <AlertTriangle className="h-4 w-4" />
                  Flagged items ({flagged.length})
                </div>
                <ul className="space-y-1.5 text-sm">
                  {flagged.map((c) => (
                    <li key={c.key}>
                      <span className="font-medium">{c.label}</span>{" "}
                      <span className="text-red-700 dark:text-red-400">— {c.answer}</span>
                      {c.note && <div className="text-xs text-muted-foreground">{c.note}</div>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Full checklist */}
            <div className="rounded-lg border border-card-border">
              {sections.map((sec) => (
                <div key={sec.name}>
                  <div className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground bg-muted/40 border-b border-card-border">
                    {sec.name}
                  </div>
                  <div className="divide-y divide-card-border border-b border-card-border">
                    {sec.items.map((c) => (
                      <div
                        key={c.key}
                        className={`flex items-start justify-between gap-3 px-3 py-2 text-sm ${c.flagged ? "bg-red-50 dark:bg-red-950/30" : ""}`}
                      >
                        <span>
                          {c.label}
                          {c.note && <span className="block text-xs text-muted-foreground">{c.note}</span>}
                        </span>
                        <span
                          className={`shrink-0 inline-flex items-center gap-1 font-medium ${
                            c.flagged
                              ? "text-red-700 dark:text-red-400"
                              : c.answer === "N/A" || !c.answer
                                ? "text-muted-foreground"
                                : "text-emerald-700 dark:text-emerald-400"
                          }`}
                        >
                          {c.flagged ? (
                            <AlertTriangle className="h-3.5 w-3.5" />
                          ) : c.answer && c.answer !== "N/A" ? (
                            <CheckCircle2 className="h-3.5 w-3.5" />
                          ) : null}
                          {c.answer ?? "—"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Photos */}
            {data.photos.length > 0 && (
              <div className="space-y-2">
                <div className="text-sm font-semibold">Photos</div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {data.photos.map((p) => (
                    <AuthedPhoto key={p.id} reportId={data.id} photoId={p.id} name={p.file_name} />
                  ))}
                </div>
              </div>
            )}

            {data.notes && (
              <div className="space-y-1">
                <div className="text-sm font-semibold">Additional notes</div>
                <p className="text-sm whitespace-pre-wrap">{data.notes}</p>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {canSignOff && (
            <Button
              onClick={() => signOff.mutate()}
              disabled={signOff.isPending}
              data-testid="button-sign-off-rig-inspection"
            >
              {signOff.isPending ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="mr-1.5 h-4 w-4" />
              )}
              Sign off
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
