import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import type { JsaReportWithLinks, JsaStatus } from "@shared/schema";
import { SafetyTabs } from "@/components/SafetyTabs";
import { Mail, Inbox, ShieldCheck } from "lucide-react";

const STATUS_TONE: Record<JsaStatus, string> = {
  "Needs job match": "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  "Pending sign-off": "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  "Signed off": "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
};

function fmt(d: string | null) {
  if (!d) return "—";
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? d : dt.toLocaleDateString();
}

export default function JsaIntakePage() {
  const [, navigate] = useLocation();
  const { profile } = useAuth();

  const { data: jsas, isLoading } = useQuery<JsaReportWithLinks[]>({
    queryKey: ["/api/jsa-intake"],
  });

  const needsMatch = (jsas || []).filter((j) => j.status === "Needs job match").length;
  const pending = (jsas || []).filter((j) => j.status === "Pending sign-off").length;

  return (
    <div className="p-4 md:p-6 max-w-5xl">
      <h1 className="text-xl font-semibold mb-3">Safety / JSAs</h1>
      <SafetyTabs />
      <div className="flex items-center justify-between gap-2 mb-1">
        <h2 className="text-base font-semibold">JSA Intake</h2>
        <div className="flex items-center gap-2">
          {needsMatch > 0 && (
            <span className="inline-flex items-center rounded-full bg-orange-500/15 text-orange-700 dark:text-orange-400 px-2.5 py-1 text-xs font-medium">
              {needsMatch} need a job
            </span>
          )}
          {pending > 0 && (
            <span className="inline-flex items-center rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-400 px-2.5 py-1 text-xs font-medium">
              {pending} awaiting sign-off
            </span>
          )}
        </div>
      </div>
      <p className="text-sm text-muted-foreground mb-5">
        Job Safety Analyses forwarded to the reports inbox land here. Each is
        matched to a job by the job number in the email subject, logged as
        received with the original file kept as a downloadable attachment, and
        held until one supervisor or area manager in the job's area signs it off.
      </p>

      {isLoading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">Loading…</div>
      ) : jsas && jsas.length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-10 text-center">
          <Inbox className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
          <div className="text-sm text-muted-foreground">No JSAs received yet.</div>
          <div className="text-xs text-muted-foreground mt-1">
            JSAs appear here after the daily email check sorts them from the inbox
            {profile?.role === "admin" ? " — they're detected by the “JSA” keyword in the subject." : "."}
          </div>
        </div>
      ) : (
        <>
        {/* Desktop table */}
        <div className="hidden md:block rounded-lg border border-card-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr className="text-left">
                <th className="px-4 py-2.5 font-medium">Received</th>
                <th className="px-4 py-2.5 font-medium">From</th>
                <th className="px-4 py-2.5 font-medium">JSA date</th>
                <th className="px-4 py-2.5 font-medium">Job / Customer</th>
                <th className="px-4 py-2.5 font-medium">Area</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {jsas?.map((j) => (
                <tr
                  key={j.id}
                  onClick={() => navigate(`/jsa-intake/${j.id}`)}
                  className="border-t border-card-border cursor-pointer hover:bg-muted/40"
                  data-testid={`row-jsa-${j.id}`}
                >
                  <td className="px-4 py-2.5 whitespace-nowrap">{fmt(j.received_at)}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="truncate max-w-[180px]">
                        {j.sender_name || j.sender_email}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">{fmt(j.jsa_date)}</td>
                  <td className="px-4 py-2.5">
                    <div className="font-medium">{j.job_number || "—"}</div>
                    <div className="text-xs text-muted-foreground truncate max-w-[200px]">
                      {j.customer_name || "Unlinked"}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{j.area || "—"}</td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_TONE[j.status]}`}>
                      {j.status === "Signed off" && <ShieldCheck className="h-3 w-3" />}
                      {j.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile card list */}
        <div className="md:hidden space-y-2">
          {jsas?.map((j) => (
            <div
              key={j.id}
              onClick={() => navigate(`/jsa-intake/${j.id}`)}
              className="rounded-lg border border-card-border bg-card p-3 active:bg-muted/40"
              data-testid={`card-jsa-${j.id}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium truncate">{j.job_number || "—"}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {j.customer_name || "Unlinked"}
                  </div>
                </div>
                <span className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_TONE[j.status]}`}>
                  {j.status === "Signed off" && <ShieldCheck className="h-3 w-3" />}
                  {j.status}
                </span>
              </div>
              <div className="mt-2 flex items-center gap-1.5 text-xs">
                <Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="truncate">{j.sender_name || j.sender_email}</span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                Received {fmt(j.received_at)}
                {j.jsa_date ? ` · JSA ${fmt(j.jsa_date)}` : ""}
                {j.area ? ` · ${j.area}` : ""}
              </div>
            </div>
          ))}
        </div>
        </>
      )}
    </div>
  );
}
