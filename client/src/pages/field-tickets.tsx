import { Fragment, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { type FieldTicketWithJob } from "@shared/schema";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Button } from "@/components/ui/button";
import { Ticket, FileText, Plus, Download } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { CreateFieldTicketDialog } from "@/components/CreateFieldTicketDialog";
import { buildFieldTicketHtml, printFieldTicket } from "@/lib/fieldTicketExport";

const money = (n: number | null) =>
  n == null
    ? "—"
    : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });

type Filter = "active" | "past";

export default function FieldTicketsPage() {
  const [, navigate] = useLocation();
  const { profile } = useAuth();
  const { toast } = useToast();
  const [filter, setFilter] = useState<Filter>("active");
  const canManage =
    profile?.role === "admin" ||
    profile?.role === "area" ||
    profile?.role === "super";

  const exportTicket = (t: FieldTicketWithJob) => {
    const html = buildFieldTicketHtml(t, { generatedBy: profile?.name });
    const opened = printFieldTicket(html);
    if (!opened)
      toast({
        title: "Pop-up blocked",
        description:
          "Allow pop-ups for this site to open the printable field ticket.",
        variant: "destructive",
      });
  };

  const { data: rows, isLoading: loading } = useQuery<FieldTicketWithJob[]>({
    queryKey: [`/api/field-tickets?status=${filter}`],
  });

  // Group tickets by job, preserving the API's date-desc order, and compute a
  // billable subtotal per job plus a grand total across all shown tickets.
  const groups: {
    job_id: string;
    job_number: string;
    area: string;
    customer_name: string;
    tickets: FieldTicketWithJob[];
    total: number;
  }[] = [];
  const byJob = new Map<string, number>();
  for (const t of rows ?? []) {
    let idx = byJob.get(t.job_id);
    if (idx === undefined) {
      idx = groups.length;
      byJob.set(t.job_id, idx);
      groups.push({
        job_id: t.job_id,
        job_number: t.job_number,
        area: t.area,
        customer_name: t.customer_name,
        tickets: [],
        total: 0,
      });
    }
    groups[idx].tickets.push(t);
    groups[idx].total += Number(t.amount ?? 0);
  }
  const grandTotal = groups.reduce((s, g) => s + g.total, 0);

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-semibold">Field Tickets</h1>
        <ToggleGroup
          type="single"
          value={filter}
          onValueChange={(v) => v && setFilter(v as Filter)}
          className="border border-card-border rounded-md"
        >
          <ToggleGroupItem value="active" className="text-xs px-3" data-testid="filter-active">
            Active jobs
          </ToggleGroupItem>
          <ToggleGroupItem value="past" className="text-xs px-3" data-testid="filter-past">
            Past jobs
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div className="flex items-start justify-between mb-5 gap-4">
        <p className="text-sm text-muted-foreground">
          Billable field work logged against jobs. Create a ticket here or from
          an active job's detail page, then export it to PDF for customer
          sign-off.
        </p>
        {canManage && (
          <CreateFieldTicketDialog
            trigger={
              <Button size="sm" data-testid="button-new-field-ticket">
                <Plus className="mr-1.5 h-4 w-4" /> New field ticket
              </Button>
            }
          />
        )}
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">Loading…</div>
      ) : !rows || rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-10 text-center">
          <Ticket className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
          <div className="text-sm text-muted-foreground">
            No field tickets for {filter === "active" ? "active" : "past"} jobs.
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-card-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr className="text-left">
                <th className="px-4 py-2.5 font-medium">Ticket</th>
                <th className="px-4 py-2.5 font-medium">Date</th>
                <th className="px-4 py-2.5 font-medium">Job</th>
                <th className="px-4 py-2.5 font-medium">Customer</th>
                <th className="px-4 py-2.5 font-medium">Well</th>
                <th className="px-4 py-2.5 font-medium text-right">Amount</th>
                <th className="px-4 py-2.5 font-medium text-right">PDF</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <Fragment key={g.job_id}>
                  {/* Per-job header with billable subtotal */}
                  <tr
                    onClick={() => navigate(`/jobs/${g.job_id}`)}
                    className="border-t border-card-border bg-muted/40 cursor-pointer hover:bg-muted/60"
                    data-testid={`group-job-${g.job_id}`}
                  >
                    <td colSpan={4} className="px-4 py-2 font-semibold">
                      {g.job_number}
                      <span className="text-muted-foreground font-normal"> · {g.area}</span>
                      <span className="text-muted-foreground font-normal"> — {g.customer_name}</span>
                    </td>
                    <td className="px-4 py-2 text-right text-xs text-muted-foreground">
                      {g.tickets.length} ticket{g.tickets.length === 1 ? "" : "s"}
                    </td>
                    <td
                      className="px-4 py-2 text-right font-semibold tabular-nums"
                      data-testid={`total-job-${g.job_id}`}
                    >
                      {money(g.total)}
                    </td>
                    <td className="px-4 py-2" />
                  </tr>
                  {g.tickets.map((t) => (
                    <tr
                      key={t.id}
                      onClick={() => navigate(`/jobs/${t.job_id}`)}
                      className="border-t border-card-border cursor-pointer hover:bg-muted/40"
                      data-testid={`row-ticket-${t.id}`}
                    >
                      <td className="px-4 py-2.5 font-medium">
                        <span className="inline-flex items-center gap-1.5">
                          <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                          #{t.ticket_number}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{t.ticket_date}</td>
                      <td className="px-4 py-2.5">
                        {t.job_number}
                        <span className="text-muted-foreground"> · {t.area}</span>
                      </td>
                      <td className="px-4 py-2.5">{t.customer_name}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{t.well_name || "—"}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{money(t.amount)}</td>
                      <td className="px-4 py-2.5 text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={(e) => {
                            e.stopPropagation();
                            exportTicket(t);
                          }}
                          title="Export PDF"
                          data-testid={`button-export-ticket-${t.id}`}
                        >
                          <Download className="h-4 w-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
            {groups.length > 1 && (
              <tfoot>
                <tr className="border-t-2 border-card-border bg-muted/50">
                  <td colSpan={5} className="px-4 py-2.5 text-right font-semibold">
                    Total billable
                  </td>
                  <td
                    className="px-4 py-2.5 text-right font-semibold tabular-nums"
                    data-testid="total-grand"
                  >
                    {money(grandTotal)}
                  </td>
                  <td className="px-4 py-2.5" />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}
