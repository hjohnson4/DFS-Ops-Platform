import { useState } from "react";
import { useRoute, Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import type {
  Asset,
  DailyReport,
  DailyReportEvent,
  DailyReportStatus,
  JobWithCustomer,
  ReportRunHoursContext,
} from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import LockedKpiTable from "@/components/LockedKpiTable";
import {
  ArrowLeft,
  Building2,
  Briefcase,
  CheckCircle2,
  Clock,
  Loader2,
  Mail,
  HardHat,
  MapPin,
  MessageSquareWarning,
  History,
  Users,
  Waypoints,
  Wrench,
  Link2,
} from "lucide-react";

type DetailResponse = DailyReport & {
  customer_name: string | null;
  job_number: string | null;
  has_attachment?: boolean;
  events: DailyReportEvent[];
};

const STATUS_TONE: Record<DailyReportStatus, string> = {
  "Needs job match": "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  "Pending Review": "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  "Signed off": "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  "Changes requested": "bg-rose-500/15 text-rose-700 dark:text-rose-400",
};

function fmtDateTime(d: string | null) {
  if (!d) return "—";
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? d : dt.toLocaleString();
}

export default function DailyReportDetailPage() {
  const [, params] = useRoute("/daily-reports/:id");
  const id = params?.id;
  const { profile } = useAuth();
  const { toast } = useToast();
  const canReview =
    profile?.role === "admin" || profile?.role === "area" || profile?.role === "super";

  const { data: report, isLoading, error } = useQuery<DetailResponse>({
    queryKey: ["/api/daily-reports", id],
    enabled: !!id,
  });

  const [showChanges, setShowChanges] = useState(false);
  const [changeNotes, setChangeNotes] = useState("");
  const [assignJobId, setAssignJobId] = useState("");
  // Per-asset run-hour split, keyed by asset id (as strings for the inputs).
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [docBusy, setDocBusy] = useState<"view" | "download" | null>(null);

  // Open the stored source workbook. Requests are authenticated, so we fetch
  // the bytes as a blob (not a plain <a href>) and either open them in a new
  // tab (view) or save them (download).
  async function openSourceDocument(mode: "view" | "download") {
    if (!id) return;
    setDocBusy(mode);
    try {
      const res = await apiRequest("GET", `/api/daily-reports/${id}/attachment`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (mode === "view") {
        window.open(url, "_blank", "noopener,noreferrer");
      } else {
        const a = document.createElement("a");
        a.href = url;
        a.download = report?.attachment_name || "daily-report.xlsx";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      // Give the new tab / download a moment to grab the URL before revoking.
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e: any) {
      toast({
        title: "Could not open the document",
        description: e.message,
        variant: "destructive",
      });
    } finally {
      setDocBusy(null);
    }
  }

  const needsMatch = report?.status === "Needs job match";
  // Emailed reports pending review can roll run hours onto centrifuges at
  // sign-off. Field reports use a different flow and don't apply here.
  const wantsRunHours =
    report?.source !== "field" && report?.status === "Pending Review" && canReview;

  const { data: runCtx } = useQuery<ReportRunHoursContext>({
    queryKey: ["/api/daily-reports", id, "centrifuges"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/daily-reports/${id}/centrifuges`);
      return res.json();
    },
    enabled: !!id && !!wantsRunHours,
  });

  const multiCent = (runCtx?.centrifuges?.length ?? 0) >= 2;
  const dailyHrs = runCtx?.daily_run_hours ?? null;
  const allocSum = multiCent
    ? (runCtx?.centrifuges ?? []).reduce(
        (s, c) => s + (parseFloat(alloc[c.id] || "") || 0),
        0,
      )
    : 0;
  const allocValid =
    !multiCent ||
    dailyHrs == null ||
    dailyHrs <= 0 ||
    Math.abs(allocSum - dailyHrs) < 0.01;

  // Only load the jobs list when we actually need to assign one.
  const { data: jobs } = useQuery<JobWithCustomer[]>({
    queryKey: ["/api/jobs"],
    enabled: !!needsMatch && canReview,
  });

  // Assets, only needed to render tag names for a field report's asset list.
  const { data: assets } = useQuery<Asset[]>({
    queryKey: ["/api/assets"],
    enabled: report?.source === "field" && (report?.asset_ids?.length ?? 0) > 0,
  });

  const assign = useMutation({
    mutationFn: async (job_id: string) => {
      const res = await apiRequest("POST", `/api/daily-reports/${id}/assign-job`, { job_id });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/daily-reports", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/daily-reports"] });
      toast({ title: "Report assigned to job", description: "It's now pending review." });
      setAssignJobId("");
    },
    onError: (e: any) =>
      toast({ title: "Could not assign report", description: e.message, variant: "destructive" }),
  });

  // Field reports use the field sign-off endpoint; emailed reports use the
  // emailed review endpoint (which also emails suggestions back to the sender).
  const isField = report?.source === "field";
  const review = useMutation({
    mutationFn: async (body: {
      action: "sign_off" | "request_changes";
      change_notes?: string;
      run_hour_allocations?: { asset_id: string; hours: number }[];
    }) => {
      const url = report?.source === "field"
        ? `/api/field-daily-reports/${id}/signoff`
        : `/api/daily-reports/${id}/review`;
      const res = await apiRequest("POST", url, body);
      return res.json();
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/daily-reports", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/daily-reports"] });
      // Centrifuge run hours may have changed — refresh asset/service views.
      queryClient.invalidateQueries({ queryKey: ["/api/assets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/service"] });
      toast({
        title: vars.action === "sign_off" ? "Report signed off" : "Changes requested",
        description:
          vars.action === "request_changes"
            ? "Your suggestions were sent back to the sender."
            : undefined,
      });
      setShowChanges(false);
      setChangeNotes("");
    },
    onError: (e: any) =>
      toast({ title: "Could not submit review", description: e.message, variant: "destructive" }),
  });

  if (isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }
  if (error || !report) {
    return (
      <div className="p-6 max-w-3xl">
        <BackLink />
        <div className="mt-4 text-sm text-muted-foreground">Report not found.</div>
      </div>
    );
  }

  const reviewed = report.status === "Signed off" || report.status === "Changes requested";
  const ctx = report.well_context || {};
  const hasCtx =
    ctx.operator || ctx.company_man || ctx.mud_company || ctx.mud_engineer || ctx.rig;

  return (
    <div className="p-6 max-w-4xl">
      <BackLink />

      {/* Header */}
      <div className="mt-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-xl font-semibold truncate">
              {isField
                ? `Field report${report.report_number != null ? ` #${report.report_number}` : ""}`
                : report.subject || "Daily report"}
            </h1>
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
              isField
                ? "bg-sky-500/15 text-sky-700 dark:text-sky-400"
                : "bg-violet-500/15 text-violet-700 dark:text-violet-400"
            }`}>
              {isField ? <><HardHat className="h-3 w-3" /> Field</> : <><Mail className="h-3 w-3" /> Emailed</>}
            </span>
            <span className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_TONE[report.status]}`}>
              {report.status}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
            {isField ? (
              <>
                <HardHat className="h-3.5 w-3.5" />
                {report.submitted_by_name || "Crew"}
                <span className="mx-1">·</span>
                {fmtDateTime(report.report_date || report.created_at)}
              </>
            ) : (
              <>
                <Mail className="h-3.5 w-3.5" />
                {report.sender_name ? `${report.sender_name} · ` : ""}
                {report.sender_email}
                <span className="mx-1">·</span>
                {fmtDateTime(report.received_at)}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Linkage chips */}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        {report.well_name && (
          <Chip icon={Waypoints}>Well: {report.well_name}</Chip>
        )}
        {report.report_day != null && (
          <Chip icon={Briefcase}>Report Day {report.report_day}</Chip>
        )}
        <Chip icon={MapPin}>{report.area || "Area not identified"}</Chip>
        {report.job_id ? (
          <Link href={`/jobs/${report.job_id}`}>
            <a className="inline-flex items-center gap-1.5 rounded-full border border-card-border px-2.5 py-1 text-primary hover:bg-muted/50" data-testid="link-report-job">
              <Briefcase className="h-3.5 w-3.5" /> Job {report.job_number}
            </a>
          </Link>
        ) : (
          <Chip icon={Briefcase}>{report.job_number ? `Job ${report.job_number}` : "Job not linked"}</Chip>
        )}
        {report.customer_id ? (
          <Link href={`/customers/${report.customer_id}`}>
            <a className="inline-flex items-center gap-1.5 rounded-full border border-card-border px-2.5 py-1 text-primary hover:bg-muted/50" data-testid="link-report-customer">
              <Building2 className="h-3.5 w-3.5" /> {report.customer_name}
            </a>
          </Link>
        ) : (
          <Chip icon={Building2}>{report.customer_name || "Customer not linked"}</Chip>
        )}
      </div>

      {/* Needs-job-match review queue action */}
      {needsMatch && (
        <div className="mt-4 rounded-lg border border-orange-500/30 bg-orange-500/10 p-4">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <Link2 className="h-4 w-4" /> This report isn't linked to a job yet
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            The well{" "}
            <span className="font-medium text-foreground">
              {report.well_name || "(none found on the sheet)"}
            </span>{" "}
            didn't match any job's well name. Assign it to the right job to move
            it into the review flow. Tip: set a job's well name to auto-match
            future imports.
          </p>
          {canReview ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Select value={assignJobId} onValueChange={setAssignJobId}>
                <SelectTrigger className="w-72" data-testid="select-assign-job">
                  <SelectValue placeholder="Choose a job…" />
                </SelectTrigger>
                <SelectContent>
                  {(jobs || []).map((j) => (
                    <SelectItem key={j.id} value={j.id}>
                      {j.job_number} · {j.area} · {j.customer_name}
                      {j.well_name ? ` · ${j.well_name}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                onClick={() => assign.mutate(assignJobId)}
                disabled={!assignJobId || assign.isPending}
                data-testid="button-assign-job"
              >
                {assign.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                Assign to job
              </Button>
            </div>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              A supervisor or area manager can assign this report to a job.
            </p>
          )}
        </div>
      )}

      {isField ? (
        <FieldReportBody report={report} assets={assets} />
      ) : (
        <>
          {/* Locked KPI table — read straight from the emailed Excel sheet */}
          <div className="mt-4">
            <LockedKpiTable
              kpis={report.kpis}
              cellMap={report.kpi_cell_map as any}
              sourceSheet={report.source_sheet}
              attachmentName={report.attachment_name}
            />
          </div>

          {/* Source document — link to the actual submitted workbook */}
          {report.attachment_name && (
            <div className="mt-3 rounded-lg border border-card-border bg-card p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                Source document
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex items-center gap-2 text-sm">
                  <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium">
                    {report.attachment_name}
                  </span>
                </div>
                {report.has_attachment ? (
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={docBusy !== null}
                      onClick={() => openSourceDocument("view")}
                      data-testid="button-view-source-document"
                    >
                      {docBusy === "view" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        "View"
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={docBusy !== null}
                      onClick={() => openSourceDocument("download")}
                      data-testid="button-download-source-document"
                    >
                      {docBusy === "download" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        "Download"
                      )}
                    </Button>
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    Original file not stored for this report.
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Well header context (also read from the sheet) */}
          {hasCtx && (
            <div className="mt-3 rounded-lg border border-card-border bg-card p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                Well header
              </div>
              <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
                <CtxRow label="Operator" value={ctx.operator} />
                <CtxRow label="Company man" value={ctx.company_man} />
                <CtxRow label="Mud company" value={ctx.mud_company} />
                <CtxRow label="Mud engineer" value={ctx.mud_engineer} />
                <CtxRow label="Rig" value={ctx.rig} />
              </dl>
            </div>
          )}
        </>
      )}

      {/* Review outcome banner */}
      {reviewed && (
        <div className={`mt-4 rounded-lg border p-4 text-sm ${
          report.status === "Signed off"
            ? "border-emerald-500/30 bg-emerald-500/10"
            : "border-rose-500/30 bg-rose-500/10"
        }`}>
          <div className="font-medium flex items-center gap-1.5">
            {report.status === "Signed off" ? (
              <><CheckCircle2 className="h-4 w-4" /> Signed off by {report.reviewed_by_name}</>
            ) : (
              <><MessageSquareWarning className="h-4 w-4" /> Changes requested by {report.reviewed_by_name}</>
            )}
          </div>
          <div className="text-muted-foreground mt-0.5">{fmtDateTime(report.reviewed_at)}</div>
          {report.status === "Changes requested" && report.change_notes && (
            <div className="mt-2">
              <div className="text-xs text-muted-foreground mb-1">
                {isField
                  ? "Requested changes for the crew:"
                  : `Suggested changes sent to ${report.sender_email}:`}
              </div>
              <div className="whitespace-pre-wrap rounded bg-background/60 p-2 border border-card-border">{report.change_notes}</div>
              {!isField && report.email_out_status && (
                <div className="text-xs text-muted-foreground mt-1.5">
                  Email: {report.email_out_status}
                  {report.email_out_status === "Pending send" && " (delivers once Resend is connected)"}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Review actions (only once the report is linked to a job) */}
      {canReview && report.status === "Pending Review" && (
        <div className="mt-4 rounded-lg border border-card-border bg-card p-4">
          <div className="text-sm font-medium mb-3">Review this report</div>
          {!showChanges ? (
            <>
            {/* Run-hours roll-up onto the job's centrifuges at sign-off. */}
            {!isField && dailyHrs != null && dailyHrs > 0 &&
              (runCtx?.centrifuges?.length ?? 0) > 0 && !runCtx?.already_applied && (
              <div className="mb-3 rounded-md border border-card-border bg-background/60 p-3 text-sm">
                <div className="flex items-center gap-1.5 font-medium">
                  <Wrench className="h-4 w-4" />
                  Run hours for this day: {dailyHrs} hrs
                </div>
                {!multiCent ? (
                  <div className="text-muted-foreground mt-1">
                    Signing off adds {dailyHrs} hrs to{" "}
                    <span className="font-medium text-foreground">
                      {runCtx?.centrifuges?.[0]?.tag}
                    </span>{" "}
                    ({runCtx?.centrifuges?.[0]?.category}).
                  </div>
                ) : (
                  <div className="mt-2 space-y-2">
                    <div className="text-muted-foreground">
                      This job has {runCtx?.centrifuges?.length} centrifuges.
                      Split the {dailyHrs} hrs across the units that ran:
                    </div>
                    {(runCtx?.centrifuges ?? []).map((c) => (
                      <div key={c.id} className="flex items-center gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate">{c.tag}</div>
                          <div className="text-xs text-muted-foreground">
                            {c.category} · current {c.run_hours ?? 0} hrs
                          </div>
                        </div>
                        <input
                          type="number"
                          min={0}
                          step="0.5"
                          inputMode="decimal"
                          className="w-24 rounded-md border border-card-border bg-background px-2 py-1 text-right text-sm"
                          value={alloc[c.id] ?? ""}
                          onChange={(e) =>
                            setAlloc((p) => ({ ...p, [c.id]: e.target.value }))
                          }
                          placeholder="0"
                          data-testid={`input-alloc-${c.id}`}
                        />
                        <span className="text-xs text-muted-foreground w-8">hrs</span>
                      </div>
                    ))}
                    <div
                      className={`text-xs ${allocValid ? "text-muted-foreground" : "text-rose-600 dark:text-rose-400"}`}
                      data-testid="text-alloc-sum"
                    >
                      Allocated {allocSum} of {dailyHrs} hrs
                      {!allocValid && " — must add up to the day's total"}
                    </div>
                  </div>
                )}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() =>
                  review.mutate({
                    action: "sign_off",
                    ...(multiCent && dailyHrs != null && dailyHrs > 0
                      ? {
                          run_hour_allocations: (runCtx?.centrifuges ?? []).map(
                            (c) => ({
                              asset_id: c.id,
                              hours: parseFloat(alloc[c.id] || "") || 0,
                            }),
                          ),
                        }
                      : {}),
                  })
                }
                disabled={review.isPending || !allocValid}
                data-testid="button-sign-off"
              >
                {review.isPending && review.variables?.action === "sign_off" && (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                )}
                <CheckCircle2 className="mr-1.5 h-4 w-4" /> Sign off
              </Button>
              <Button
                variant="outline"
                onClick={() => setShowChanges(true)}
                disabled={review.isPending}
                data-testid="button-request-changes"
              >
                <MessageSquareWarning className="mr-1.5 h-4 w-4" /> Suggest changes
              </Button>
            </div>
            </>
          ) : (
            <div className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">
                  {isField
                    ? "Changes requested (sent back to the crew)"
                    : `Suggested changes (emailed back to ${report.sender_email})`}
                </label>
                <Textarea
                  value={changeNotes}
                  onChange={(e) => setChangeNotes(e.target.value)}
                  placeholder="Describe what needs to be corrected or added…"
                  rows={5}
                  data-testid="input-change-notes"
                />
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() => review.mutate({ action: "request_changes", change_notes: changeNotes })}
                  disabled={review.isPending || !changeNotes.trim()}
                  data-testid="button-send-changes"
                >
                  {review.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                  {isField ? "Request changes" : "Send changes to sender"}
                </Button>
                <Button variant="ghost" onClick={() => setShowChanges(false)} disabled={review.isPending}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Audit trail */}
      <div className="mt-6 mb-2 flex items-center gap-1.5">
        <History className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Activity</h2>
      </div>
      <div className="rounded-lg border border-card-border overflow-hidden">
        {report.events.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">No activity recorded.</div>
        ) : (
          <ul className="divide-y divide-card-border">
            {report.events.map((ev) => (
              <li key={ev.id} className="px-4 py-2.5 text-sm flex items-start justify-between gap-4">
                <div>
                  <span className="font-medium">{ev.actor_name}</span>{" "}
                  <span className="text-muted-foreground">{describe(ev.action)}</span>
                  {ev.detail && <div className="text-xs text-muted-foreground mt-0.5">{ev.detail}</div>}
                </div>
                <div className="text-xs text-muted-foreground whitespace-nowrap">{fmtDateTime(ev.occurred_at)}</div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function describe(action: string): string {
  switch (action) {
    case "ingested": return "imported this report";
    case "submitted": return "submitted this report";
    case "assigned": return "assigned this report to a job";
    case "signed_off": return "signed off the report";
    case "changes_requested": return "requested changes";
    case "email_sent": return "sent an email";
    default: return action;
  }
}

function FieldReportBody({
  report,
  assets,
}: {
  report: DetailResponse;
  assets: Asset[] | undefined;
}) {
  const crew = report.crew || [];
  const assetIds = report.asset_ids || [];
  const byId = new Map((assets || []).map((a) => [a.id, a]));
  return (
    <div className="mt-4 space-y-4">
      {/* Crew hours + summary */}
      <div className="rounded-lg border border-card-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <div className="flex items-center gap-1.5">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground">Crew hours:</span>
            <span className="font-medium">
              {report.crew_hours != null ? report.crew_hours : "—"}
            </span>
          </div>
        </div>
        <div className="mt-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
            Work summary
          </div>
          <div className="text-sm whitespace-pre-wrap">
            {report.work_summary || <span className="text-muted-foreground">—</span>}
          </div>
        </div>
      </div>

      {/* Crew */}
      <div className="rounded-lg border border-card-border bg-card p-4">
        <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          <Users className="h-3.5 w-3.5" /> Crew on site
        </div>
        {crew.length === 0 ? (
          <div className="text-sm text-muted-foreground">No crew recorded.</div>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {crew.map((c, i) => (
              <li
                key={i}
                className="inline-flex items-center gap-1.5 rounded-full border border-card-border px-2.5 py-1 text-sm"
                data-testid={`crew-member-${i}`}
              >
                <span className="font-medium">{c.name}</span>
                {c.role && <span className="text-muted-foreground text-xs">{c.role}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Assets used */}
      <div className="rounded-lg border border-card-border bg-card p-4">
        <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          <Wrench className="h-3.5 w-3.5" /> Equipment on site
        </div>
        {assetIds.length === 0 ? (
          <div className="text-sm text-muted-foreground">No equipment recorded.</div>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {assetIds.map((aid) => {
              const a = byId.get(aid);
              return (
                <li
                  key={aid}
                  className="inline-flex items-center gap-1.5 rounded-full border border-card-border px-2.5 py-1 text-sm"
                  data-testid={`asset-chip-${aid}`}
                >
                  <span className="font-medium">{a?.tag || "Unknown"}</span>
                  {a?.category && (
                    <span className="text-muted-foreground text-xs">{a.category}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Comments */}
      {report.comments && (
        <div className="rounded-lg border border-card-border bg-card p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
            Comments
          </div>
          <div className="text-sm whitespace-pre-wrap">{report.comments}</div>
        </div>
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/daily-reports">
      <a className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground" data-testid="link-back-daily-reports">
        <ArrowLeft className="h-4 w-4" /> Daily Reports
      </a>
    </Link>
  );
}

function Chip({ icon: Icon, children }: { icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-card-border px-2.5 py-1 text-muted-foreground">
      <Icon className="h-3.5 w-3.5" /> {children}
    </span>
  );
}

function CtxRow({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value || "—"}</dd>
    </div>
  );
}
