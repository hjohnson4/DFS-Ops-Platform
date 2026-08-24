import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { DailyReportWithLinks, DailyReportStatus } from "@shared/schema";
import { Inbox, Search, Loader2, CheckCircle2, X } from "lucide-react";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";

const STATUS_TONE: Record<DailyReportStatus, string> = {
  "Needs job match": "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  "Pending Review": "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  "Signed off": "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  "Changes requested": "bg-rose-500/15 text-rose-700 dark:text-rose-400",
};

function fmt(d: string | null) {
  if (!d) return "—";
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? d : dt.toLocaleDateString();
}

type StatusFilter = "all" | "pending" | "signed";

export default function DailyReportsPage() {
  const [, navigate] = useLocation();
  const { profile } = useAuth();
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const canReview =
    profile?.role === "admin" ||
    profile?.role === "area" ||
    profile?.role === "super";

  const { data: reports, isLoading } = useQuery<DailyReportWithLinks[]>({
    queryKey: ["/api/daily-reports"],
  });

  const all = reports || [];
  const pending = all.filter((r) => r.status === "Pending Review").length;
  const needsMatch = all.filter((r) => r.status === "Needs job match").length;

  const q = search.trim().toLowerCase();
  const rows = useMemo(() => {
    return all.filter((r) => {
      if (statusFilter === "pending" && r.status === "Signed off") return false;
      if (statusFilter === "signed" && r.status !== "Signed off") return false;
      if (q) {
        const hay = [
          r.sender_name,
          r.sender_email,
          r.well_name,
          r.job_number,
          r.customer_name,
          r.area,
          r.subject,
          r.status,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [all, statusFilter, q]);

  // Bulk sign-off applies only to rows that are "Pending Review".
  const selectablePending = useMemo(
    () => rows.filter((r) => r.status === "Pending Review"),
    [rows],
  );
  const selectedPending = useMemo(
    () => selectablePending.filter((r) => selected.has(r.id)),
    [selectablePending, selected],
  );
  const allPendingSelected =
    selectablePending.length > 0 &&
    selectablePending.every((r) => selected.has(r.id));

  const toggleRow = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const toggleAll = () =>
    setSelected((prev) => {
      if (allPendingSelected) return new Set();
      return new Set(selectablePending.map((r) => r.id));
    });

  const clearSelection = () => setSelected(new Set());

  const bulkSignOff = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(
        ids.map((id) =>
          apiRequest("POST", `/api/daily-reports/${id}/review`, {
            action: "sign_off",
          }),
        ),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      return { ok: ids.length - failed, failed };
    },
    onSuccess: ({ ok, failed }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/daily-reports"] });
      clearSelection();
      toast({
        title:
          failed === 0
            ? `Signed off ${ok} report${ok === 1 ? "" : "s"}`
            : `Signed off ${ok}, ${failed} failed`,
        variant: failed === 0 ? undefined : "destructive",
      });
    },
    onError: (e: any) =>
      toast({
        title: "Bulk sign-off failed",
        description: e.message,
        variant: "destructive",
      }),
  });

  const showSelectColumn = canReview && selectablePending.length > 0;
  const colCount = showSelectColumn ? 7 : 6;

  return (
    <div className="p-4 md:p-6 max-w-5xl">
      <div className="flex items-center justify-between gap-2 mb-1">
        <h1 className="text-xl font-semibold">Daily Reports</h1>
        <div className="flex items-center gap-2">
          {needsMatch > 0 && (
            <span className="inline-flex items-center rounded-full bg-orange-500/15 text-orange-700 dark:text-orange-400 px-2.5 py-1 text-xs font-medium">
              {needsMatch} need a job
            </span>
          )}
          {pending > 0 && (
            <span className="inline-flex items-center rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-400 px-2.5 py-1 text-xs font-medium">
              {pending} awaiting review
            </span>
          )}
        </div>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Every crew's daily report in one place. Reports are emailed in to the
        intake inbox, with KPI values read straight from the Excel workbook's
        “Report Day” sheet and locked. Each report is matched to a job, reviewed,
        and signed off in the same flow.
      </p>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <ToggleGroup
          type="single"
          value={statusFilter}
          onValueChange={(v) => v && setStatusFilter(v as StatusFilter)}
          className="justify-start"
        >
          <ToggleGroupItem value="all" data-testid="filter-status-all">All statuses</ToggleGroupItem>
          <ToggleGroupItem value="pending" data-testid="filter-status-pending">Pending</ToggleGroupItem>
          <ToggleGroupItem value="signed" data-testid="filter-status-signed">Signed off</ToggleGroupItem>
        </ToggleGroup>

        <div className="relative ml-auto w-full sm:w-64">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search sender, well, job, customer…"
            className="pl-8"
            data-testid="input-search-daily-reports"
          />
        </div>
      </div>

      {/* Bulk action bar */}
      {showSelectColumn && selectedPending.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-3 mb-3 rounded-lg border border-card-border bg-primary/5 px-4 py-2.5"
          data-testid="bulk-action-bar"
        >
          <span className="text-sm font-medium">
            {selectedPending.length} selected
          </span>
          <Button
            size="sm"
            onClick={() => bulkSignOff.mutate(selectedPending.map((r) => r.id))}
            disabled={bulkSignOff.isPending}
            data-testid="button-bulk-signoff"
          >
            {bulkSignOff.isPending ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="mr-1.5 h-4 w-4" />
            )}
            Sign off selected
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={clearSelection}
            data-testid="button-clear-selection"
          >
            <X className="mr-1.5 h-4 w-4" />
            Clear
          </Button>
        </div>
      )}

      {isLoading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-10 text-center">
          <Inbox className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
          <div className="text-sm text-muted-foreground">
            {all.length === 0
              ? "No daily reports yet."
              : q
                ? "No reports match your search."
                : "No reports match these filters."}
          </div>
          {all.length === 0 && (
            <div className="text-xs text-muted-foreground mt-1">
              Reports appear here after the daily email check imports them from
              the intake inbox.
            </div>
          )}
        </div>
      ) : (
        <>
        {/* Desktop table */}
        <div className="hidden md:block rounded-lg border border-card-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr className="text-left">
                {showSelectColumn && (
                  <th className="px-3 py-2.5 w-9">
                    <Checkbox
                      checked={allPendingSelected}
                      onCheckedChange={toggleAll}
                      aria-label="Select all pending"
                      data-testid="checkbox-select-all"
                    />
                  </th>
                )}
                <th className="px-4 py-2.5 font-medium">Date</th>
                <th className="px-4 py-2.5 font-medium">From</th>
                <th className="px-4 py-2.5 font-medium">Well</th>
                <th className="px-4 py-2.5 font-medium">Job / Customer</th>
                <th className="px-4 py-2.5 font-medium">Area</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isPending = r.status === "Pending Review";
                const isSelected = selected.has(r.id);
                return (
                  <tr
                    key={r.id}
                    onClick={() => navigate(`/daily-reports/${r.id}`)}
                    className="border-t border-card-border cursor-pointer hover:bg-muted/40"
                    data-testid={`row-daily-report-${r.id}`}
                  >
                    {showSelectColumn && (
                      <td
                        className="px-3 py-2.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {isPending ? (
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={() => toggleRow(r.id)}
                            aria-label="Select report"
                            data-testid={`checkbox-report-${r.id}`}
                          />
                        ) : null}
                      </td>
                    )}
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      {fmt(r.report_date || r.received_at)}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="truncate max-w-[180px] inline-block align-middle">
                        {r.sender_name || r.sender_email || "—"}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="truncate max-w-[160px]">{r.well_name || "—"}</div>
                      {r.report_day != null && (
                        <div className="text-xs text-muted-foreground">Day {r.report_day}</div>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="font-medium">{r.job_number || "—"}</div>
                      <div className="text-xs text-muted-foreground truncate max-w-[200px]">
                        {r.customer_name || "Unlinked"}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">{r.area || "—"}</td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_TONE[r.status]}`}>
                        {r.status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Mobile card list */}
        <div className="md:hidden space-y-2">
          {rows.map((r) => {
            const isPending = r.status === "Pending Review";
            const isSelected = selected.has(r.id);
            return (
              <div
                key={r.id}
                onClick={() => navigate(`/daily-reports/${r.id}`)}
                className="rounded-lg border border-card-border bg-card p-3 active:bg-muted/40"
                data-testid={`card-daily-report-${r.id}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium truncate">
                      {r.well_name || "—"}
                      {r.report_day != null && (
                        <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                          Day {r.report_day}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {fmt(r.report_date || r.received_at)}
                      {r.area ? ` · ${r.area}` : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_TONE[r.status]}`}>
                      {r.status}
                    </span>
                    {showSelectColumn && isPending && (
                      <span onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleRow(r.id)}
                          aria-label="Select report"
                          data-testid={`checkbox-card-report-${r.id}`}
                        />
                      </span>
                    )}
                  </div>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                  <div>
                    <div className="text-muted-foreground">Job / Customer</div>
                    <div className="font-medium truncate">{r.job_number || "—"}</div>
                    <div className="text-muted-foreground truncate">{r.customer_name || "Unlinked"}</div>
                  </div>
                  <div className="min-w-0">
                    <div className="text-muted-foreground">From</div>
                    <div className="truncate">{r.sender_name || r.sender_email || "—"}</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        </>
      )}
    </div>
  );
}
