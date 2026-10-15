import { Fragment, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { type FieldTicketWithJob, type FieldTicketStatus, workDatesLabel, ticketDatesLabel } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Button } from "@/components/ui/button";
import { Ticket, FileText, Plus, Download, Hash, Loader2 } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { FieldTicketDialog, StatusBadge } from "@/components/FieldTicketDialog";
import { buildFieldTicketHtml, printFieldTicket } from "@/lib/fieldTicketExport";

const money = (n: number | null) =>
  n == null
    ? "—"
    : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });

type Filter = "active" | "past";
type StatusFilter = "all" | FieldTicketStatus;

// Admin: set the next automatic ticket number.
function TicketNumberingDialog() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const { data } = useQuery<{ next: number; configurable: boolean }>({
    queryKey: ["/api/field-tickets/next-number"],
    enabled: open,
  });
  const save = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", "/api/field-tickets/next-number", { next: Number(value) })).json(),
    onSuccess: (r: { next: number }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/field-tickets/next-number"] });
      toast({ title: `Next ticket will be #${r.next}` });
      setOpen(false);
    },
    onError: (e: any) => toast({ title: "Could not change numbering", description: e.message, variant: "destructive" }),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) setValue(""); }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid="button-ticket-numbering">
          <Hash className="mr-1.5 h-4 w-4" /> Ticket numbering
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Ticket numbering</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p>
            New tickets get the next number automatically:{" "}
            <b data-testid="text-next-ticket-number">{data ? `#${data.next}` : "—"}</b>.
          </p>
          <p className="text-muted-foreground">
            Set where numbering continues from, e.g. to follow on from the paper ticket books.
            It can't go below a number that's already used. Anyone creating a ticket can
            also type a specific number on it.
          </p>
          {data && !data.configurable && (
            <p className="text-amber-700">The ticket workflow database update hasn't been run yet, so this can't be changed.</p>
          )}
          <div className="space-y-1.5">
            <Label>Next ticket number</Label>
            <Input
              inputMode="numeric"
              value={value}
              onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder={data ? String(data.next) : ""}
              data-testid="input-next-ticket-number"
            />
          </div>
          <div className="flex justify-end">
            <Button onClick={() => save.mutate()} disabled={!value || save.isPending || (data && !data.configurable)} data-testid="button-save-ticket-numbering">
              {save.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function FieldTicketsPage() {
  const [, navigate] = useLocation();
  const { profile } = useAuth();
  const { toast } = useToast();
  const [filter, setFilter] = useState<Filter>("active");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  // Only Area Managers and Admins create tickets; Supervisors view.
  const canManage = profile?.role === "admin" || profile?.role === "area";
  const isAdmin = profile?.role === "admin";

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

  const { data: allRows, isLoading: loading } = useQuery<FieldTicketWithJob[]>({
    queryKey: [`/api/field-tickets?status=${filter}`],
  });
  const statusOf = (t: FieldTicketWithJob) => (t.status ?? "open") as FieldTicketStatus;
  const counts = { all: allRows?.length ?? 0, open: 0, closed: 0, approved: 0 };
  (allRows ?? []).forEach((t) => counts[statusOf(t)]++);
  const rows = (allRows ?? []).filter((t) => statusFilter === "all" || statusOf(t) === statusFilter);

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
          Billable field work logged against jobs. Area Managers open a ticket,
          add work as it's done, and close it when it's complete. An Admin then
          approves it.
        </p>
        <div className="flex items-center gap-2 shrink-0">
          {isAdmin && <TicketNumberingDialog />}
          {canManage && (
            <FieldTicketDialog
              trigger={
                <Button size="sm" data-testid="button-new-field-ticket">
                  <Plus className="mr-1.5 h-4 w-4" /> New field ticket
                </Button>
              }
            />
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        {(["all", "open", "closed", "approved"] as StatusFilter[]).map((k) => (
          <button
            key={k}
            onClick={() => setStatusFilter(k)}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${
              statusFilter === k
                ? "border-primary bg-primary text-primary-foreground"
                : "border-card-border bg-card text-muted-foreground hover:text-foreground"
            }`}
            data-testid={`filter-status-${k}`}
          >
            {k === "all" ? "All" : k === "open" ? "Open" : k === "closed" ? "Closed" : "Approved"} ({counts[k]})
          </button>
        ))}
        {isAdmin && counts.closed > 0 && (
          <button
            onClick={() => setStatusFilter("closed")}
            className="ml-auto rounded-md bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
            data-testid="badge-awaiting-approval"
          >
            {counts.closed} awaiting your approval
          </button>
        )}
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-10 text-center">
          <Ticket className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
          <div className="text-sm text-muted-foreground">
            No {statusFilter === "all" ? "" : statusFilter + " "}field tickets for {filter === "active" ? "active" : "past"} jobs.
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-card-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr className="text-left">
                <th className="px-4 py-2.5 font-medium">Ticket</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Work dates</th>
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
                    <td colSpan={5} className="px-4 py-2 font-semibold">
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
                      className="border-t border-card-border hover:bg-muted/40"
                      data-testid={`row-ticket-${t.id}`}
                    >
                      <td className="px-4 py-2.5 font-medium">
                        <FieldTicketDialog
                          ticket={t}
                          trigger={
                            <button className="inline-flex items-center gap-1.5 hover:underline" data-testid={`button-open-ticket-${t.id}`}>
                              <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                              #{t.ticket_number}
                            </button>
                          }
                        />
                      </td>
                      <td className="px-4 py-2.5"><StatusBadge status={statusOf(t)} /></td>
                      <td className="px-4 py-2.5 text-muted-foreground">{ticketDatesLabel(t)}</td>
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
                  <td colSpan={6} className="px-4 py-2.5 text-right font-semibold">
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
