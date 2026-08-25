import { useState } from "react";
import { useRoute, Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import type {
  JsaReport,
  JsaReportEvent,
  JsaStatus,
  JobWithCustomer,
} from "@shared/schema";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  Building2,
  Briefcase,
  CheckCircle2,
  Loader2,
  Mail,
  MapPin,
  CalendarDays,
  History,
  Link2,
  ShieldCheck,
  Download,
  Eye,
  FileText,
  Inbox,
  Table2,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

type DetailResponse = JsaReport & {
  customer_name: string | null;
  job_number: string | null;
  events: JsaReportEvent[];
};

type PreviewSheet = { name: string; rows: string[][]; truncated: boolean };
type PreviewTable = { columns: string[]; rows: string[][] };
type PreviewResponse =
  | {
      previewable: true;
      structured: true;
      attachment_name: string;
      header: { label: string; value: string }[];
      table: PreviewTable | null;
    }
  | {
      previewable: true;
      structured: false;
      attachment_name: string;
      sheets: PreviewSheet[];
    }
  | {
      previewable: false;
      reason: string;
      attachment_name: string;
      attachment_mime: string | null;
    };

const STATUS_TONE: Record<JsaStatus, string> = {
  "Needs job match": "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  "Pending sign-off": "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  "Signed off": "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
};

function fmtDateTime(d: string | null) {
  if (!d) return "—";
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? d : dt.toLocaleString();
}
function fmtDate(d: string | null) {
  if (!d) return "—";
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? d : dt.toLocaleDateString();
}
function fmtBytes(n: number | null) {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function JsaIntakeDetailPage() {
  const [, params] = useRoute("/jsa-intake/:id");
  const id = params?.id;
  const { profile } = useAuth();
  const { toast } = useToast();
  const canSign =
    profile?.role === "admin" || profile?.role === "area" || profile?.role === "super";

  const { data: jsa, isLoading, error } = useQuery<DetailResponse>({
    queryKey: ["/api/jsa-intake", id],
    enabled: !!id,
  });

  const [assignJobId, setAssignJobId] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [viewing, setViewing] = useState(false);
  const [showPreview, setShowPreview] = useState(true);

  const { data: preview, isLoading: previewLoading } = useQuery<PreviewResponse>({
    queryKey: ["/api/jsa-intake", id, "preview"],
    enabled: !!id,
  });

  const needsMatch = jsa?.status === "Needs job match";

  const { data: jobs } = useQuery<JobWithCustomer[]>({
    queryKey: ["/api/jobs"],
    enabled: !!needsMatch && canSign,
  });

  const assign = useMutation({
    mutationFn: async (job_id: string) => {
      const res = await apiRequest("POST", `/api/jsa-intake/${id}/assign-job`, { job_id });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/jsa-intake", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/jsa-intake"] });
      toast({ title: "JSA assigned to job", description: "It's now pending sign-off." });
      setAssignJobId("");
    },
    onError: (e: any) =>
      toast({ title: "Could not assign JSA", description: e.message, variant: "destructive" }),
  });

  const signOff = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/jsa-intake/${id}/sign-off`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/jsa-intake", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/jsa-intake"] });
      toast({ title: "JSA signed off" });
    },
    onError: (e: any) =>
      toast({ title: "Could not sign off JSA", description: e.message, variant: "destructive" }),
  });

  async function downloadAttachment() {
    if (!id) return;
    setDownloading(true);
    try {
      const res = await apiRequest("GET", `/api/jsa-intake/${id}/attachment`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = jsa?.attachment_name || "jsa";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast({ title: "Could not download attachment", description: e.message, variant: "destructive" });
    } finally {
      setDownloading(false);
    }
  }

  // Open the original JSA document in a new tab (PDFs preview inline; Excel
  // files download via the browser). Authenticated, so fetch as a blob first.
  async function viewAttachment() {
    if (!id) return;
    setViewing(true);
    try {
      const res = await apiRequest("GET", `/api/jsa-intake/${id}/attachment`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e: any) {
      toast({ title: "Could not open attachment", description: e.message, variant: "destructive" });
    } finally {
      setViewing(false);
    }
  }

  if (isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }
  if (error || !jsa) {
    return (
      <div className="p-6 max-w-3xl">
        <BackLink />
        <div className="mt-4 text-sm text-muted-foreground">JSA not found.</div>
      </div>
    );
  }

  const signedOff = jsa.status === "Signed off";

  return (
    <div className="p-6 max-w-4xl">
      <BackLink />

      {/* Header */}
      <div className="mt-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-xl font-semibold truncate">
              {jsa.subject || "Job Safety Analysis"}
            </h1>
            <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_TONE[jsa.status]}`}>
              {signedOff && <ShieldCheck className="h-3 w-3" />}
              {jsa.status}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
            <Mail className="h-3.5 w-3.5" />
            {jsa.sender_name ? `${jsa.sender_name} · ` : ""}
            {jsa.sender_email}
            <span className="mx-1">·</span>
            {fmtDateTime(jsa.received_at)}
          </div>
        </div>
      </div>

      {/* Acknowledgement card — received confirmation + the four captured facts */}
      <div className="mt-4 rounded-lg border border-card-border bg-card p-4">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Inbox className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          JSA received
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Receipt of this JSA is logged. It records the job it came from, the JSA
          date, and the sender, and keeps the original file attached below. One
          area supervisor's sign-off completes it.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          {jsa.job_id ? (
            <Link href={`/jobs/${jsa.job_id}`}>
              <a className="inline-flex items-center gap-1.5 rounded-full border border-card-border px-2.5 py-1 text-primary hover:bg-muted/50" data-testid="link-jsa-job">
                <Briefcase className="h-3.5 w-3.5" /> Job {jsa.job_number}
              </a>
            </Link>
          ) : (
            <Chip icon={Briefcase}>
              {jsa.job_number_raw ? `Job ${jsa.job_number_raw} (unmatched)` : "Job not identified"}
            </Chip>
          )}
          <Chip icon={CalendarDays}>JSA date: {fmtDate(jsa.jsa_date)}</Chip>
          <Chip icon={MapPin}>{jsa.area || "Area not identified"}</Chip>
          {jsa.customer_id ? (
            <Link href={`/customers/${jsa.customer_id}`}>
              <a className="inline-flex items-center gap-1.5 rounded-full border border-card-border px-2.5 py-1 text-primary hover:bg-muted/50" data-testid="link-jsa-customer">
                <Building2 className="h-3.5 w-3.5" /> {jsa.customer_name}
              </a>
            </Link>
          ) : (
            <Chip icon={Building2}>{jsa.customer_name || "Customer not linked"}</Chip>
          )}
        </div>

        {/* Attachment */}
        <div className="mt-4 flex items-center justify-between gap-3 rounded-md border border-card-border bg-background/50 px-3 py-2.5">
          <div className="flex items-center gap-2 min-w-0">
            <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{jsa.attachment_name}</div>
              <div className="text-xs text-muted-foreground">
                {jsa.attachment_mime || "file"}
                {jsa.attachment_size ? ` · ${fmtBytes(jsa.attachment_size)}` : ""}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={viewAttachment}
              disabled={viewing || downloading}
              data-testid="button-view-attachment"
            >
              {viewing ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Eye className="mr-1.5 h-4 w-4" />
              )}
              View
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={downloadAttachment}
              disabled={downloading || viewing}
              data-testid="button-download-attachment"
            >
              {downloading ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Download className="mr-1.5 h-4 w-4" />
              )}
              Download
            </Button>
          </div>
        </div>
      </div>

      {/* Inline preview of the spreadsheet contents */}
      <div className="mt-4 rounded-lg border border-card-border bg-card">
        <button
          type="button"
          onClick={() => setShowPreview((v) => !v)}
          className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
          data-testid="button-toggle-preview"
        >
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <Table2 className="h-4 w-4 text-muted-foreground" />
            File preview
          </span>
          {showPreview ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </button>
        {showPreview && (
          <div className="border-t border-card-border px-4 py-3">
            {previewLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading preview…
              </div>
            ) : preview && preview.previewable && preview.structured ? (
              <JsaStructuredPreview header={preview.header} table={preview.table} />
            ) : preview && preview.previewable ? (
              <div className="space-y-5">
                {preview.sheets.map((sheet) => (
                  <SheetPreview key={sheet.name} sheet={sheet} />
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">
                {preview?.reason === "parse_error"
                  ? "This file couldn't be parsed for preview. Use Download to open the original."
                  : "Inline preview isn't available for this file type. Use Download to open the original."}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Needs-job-match queue action */}
      {needsMatch && (
        <div className="mt-4 rounded-lg border border-orange-500/30 bg-orange-500/10 p-4">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <Link2 className="h-4 w-4" /> This JSA isn't linked to a job yet
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            The job number{" "}
            <span className="font-medium text-foreground">
              {jsa.job_number_raw || "(none found in the subject)"}
            </span>{" "}
            didn't match any job. Assign it to the right job so the area's
            supervisor can sign it off.
          </p>
          {canSign ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Select value={assignJobId} onValueChange={setAssignJobId}>
                <SelectTrigger className="w-72" data-testid="select-assign-job">
                  <SelectValue placeholder="Choose a job…" />
                </SelectTrigger>
                <SelectContent>
                  {(jobs || []).map((j) => (
                    <SelectItem key={j.id} value={j.id}>
                      {j.job_number} · {j.area} · {j.customer_name}
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
              A supervisor or area manager can assign this JSA to a job.
            </p>
          )}
        </div>
      )}

      {/* Signed-off banner */}
      {signedOff && (
        <div className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm">
          <div className="font-medium flex items-center gap-1.5">
            <CheckCircle2 className="h-4 w-4" /> Signed off by {jsa.signed_off_by_name}
          </div>
          <div className="text-muted-foreground mt-0.5">{fmtDateTime(jsa.signed_off_at)}</div>
        </div>
      )}

      {/* Sign-off action — available once linked to a job */}
      {canSign && jsa.status === "Pending sign-off" && (
        <div className="mt-4 rounded-lg border border-card-border bg-card p-4">
          <div className="text-sm font-medium mb-1">Sign off this JSA</div>
          <p className="text-sm text-muted-foreground mb-3">
            As a supervisor or area manager for {jsa.area}, your sign-off
            acknowledges the JSA for job {jsa.job_number}.
          </p>
          <Button
            onClick={() => signOff.mutate()}
            disabled={signOff.isPending}
            data-testid="button-sign-off"
          >
            {signOff.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            <ShieldCheck className="mr-1.5 h-4 w-4" /> Sign off
          </Button>
        </div>
      )}

      {/* Audit trail */}
      <div className="mt-6 mb-2 flex items-center gap-1.5">
        <History className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Activity</h2>
      </div>
      <div className="rounded-lg border border-card-border overflow-hidden">
        {jsa.events.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">No activity recorded.</div>
        ) : (
          <ul className="divide-y divide-card-border">
            {jsa.events.map((ev) => (
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
    case "received": return "received this JSA";
    case "ingested": return "received this JSA";
    case "assigned": return "assigned this JSA to a job";
    case "signed_off": return "signed off the JSA";
    default: return action;
  }
}

function JsaStructuredPreview({
  header,
  table,
}: {
  header: { label: string; value: string }[];
  table: PreviewTable | null;
}) {
  if (!header.length && !table) {
    return (
      <div className="text-sm text-muted-foreground">
        No entered information was found in this JSA. Use Download to open the
        original.
      </div>
    );
  }
  return (
    <div className="space-y-5">
      {header.length > 0 && (
        <div>
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Header
          </div>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
            {header.map((f, i) => (
              <div
                key={i}
                className="flex flex-col border-b border-card-border pb-1.5"
                data-testid={`preview-header-${i}`}
              >
                <dt className="text-xs text-muted-foreground">{f.label}</dt>
                <dd className="text-sm font-medium">{f.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {table && table.rows.length > 0 && (
        <div>
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Activity / Hazard / Control
          </div>
          <div className="overflow-x-auto rounded-md border border-card-border">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-muted/40">
                  {table.columns.map((c, i) => (
                    <th
                      key={i}
                      className="border border-card-border px-2 py-1.5 text-left font-medium"
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, ri) => (
                  <tr key={ri} data-testid={`preview-activity-row-${ri}`}>
                    {row.map((cellVal, ci) => (
                      <td
                        key={ci}
                        className="border border-card-border px-2 py-1 align-top"
                      >
                        <span className="block max-w-[22rem] whitespace-pre-wrap break-words">
                          {cellVal}
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function SheetPreview({ sheet }: { sheet: PreviewSheet }) {
  if (!sheet.rows.length) return null;
  return (
    <div className="min-w-0" data-testid={`preview-sheet-${sheet.name}`}>
      <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {sheet.name}
      </div>
      <div className="overflow-x-auto rounded-md border border-card-border">
        <table className="w-full border-collapse text-sm">
          <tbody>
            {sheet.rows.map((row, ri) => (
              <tr key={ri} className={ri === 0 ? "bg-muted/40" : ""}>
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    className={`border border-card-border px-2 py-1 align-top ${
                      ri === 0 ? "font-medium" : ""
                    }`}
                  >
                    <span className="block max-w-[22rem] whitespace-pre-wrap break-words">
                      {cell}
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sheet.truncated && (
        <div className="mt-1 text-xs text-muted-foreground">
          Preview truncated — download the file to see everything.
        </div>
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/jsa-intake">
      <a className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground" data-testid="link-back-jsa-intake">
        <ArrowLeft className="h-4 w-4" /> JSA Intake
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
