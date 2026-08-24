import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { type JsaWithJob } from "@shared/schema";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SignoffBadge } from "@/components/SignoffControls";
import { SafetyTabs } from "@/components/SafetyTabs";
import { ShieldAlert } from "lucide-react";

type Filter = "all" | "pending" | "signed";

export default function JsasPage() {
  const [, navigate] = useLocation();
  const [filter, setFilter] = useState<Filter>("all");

  const qs = filter === "all" ? "" : `?status=${filter}`;
  const { data: rows, isLoading: loading } = useQuery<JsaWithJob[]>({
    queryKey: [`/api/jsas${qs}`],
  });

  return (
    <div className="p-6 max-w-5xl">
      <h1 className="text-xl font-semibold mb-3">Safety / JSAs</h1>
      <SafetyTabs />
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-base font-semibold">Job Safety Analyses</h2>
        <ToggleGroup
          type="single"
          value={filter}
          onValueChange={(v) => v && setFilter(v as Filter)}
          className="border border-card-border rounded-md"
        >
          <ToggleGroupItem value="all" className="text-xs px-3" data-testid="filter-all">
            All
          </ToggleGroupItem>
          <ToggleGroupItem value="pending" className="text-xs px-3" data-testid="filter-pending">
            Needs sign-off
          </ToggleGroupItem>
          <ToggleGroupItem value="signed" className="text-xs px-3" data-testid="filter-signed">
            Signed off
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      <p className="text-sm text-muted-foreground mb-5">
        Hazard and control analyses across all jobs. Create a JSA from an active
        job's detail page.
      </p>

      {loading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">Loading…</div>
      ) : !rows || rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-10 text-center">
          <ShieldAlert className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
          <div className="text-sm text-muted-foreground">
            No JSAs{filter === "pending" ? " awaiting sign-off" : filter === "signed" ? " signed off" : ""}.
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-card-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr className="text-left">
                <th className="px-4 py-2.5 font-medium">JSA</th>
                <th className="px-4 py-2.5 font-medium">Date</th>
                <th className="px-4 py-2.5 font-medium">Job</th>
                <th className="px-4 py-2.5 font-medium">Customer</th>
                <th className="px-4 py-2.5 font-medium text-center">Steps</th>
                <th className="px-4 py-2.5 font-medium">Submitted by</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((j) => (
                <tr
                  key={j.id}
                  onClick={() => navigate(`/jobs/${j.job_id}`)}
                  className="border-t border-card-border cursor-pointer hover:bg-muted/40"
                  data-testid={`row-jsa-${j.id}`}
                >
                  <td className="px-4 py-2.5 font-medium">
                    <span className="inline-flex items-center gap-1.5">
                      <ShieldAlert className="h-3.5 w-3.5 text-muted-foreground" />
                      #{j.jsa_number}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{j.jsa_date}</td>
                  <td className="px-4 py-2.5">
                    {j.job_number}
                    <span className="text-muted-foreground"> · {j.area}</span>
                  </td>
                  <td className="px-4 py-2.5">{j.customer_name}</td>
                  <td className="px-4 py-2.5 text-center tabular-nums text-muted-foreground">
                    {j.steps?.length ?? 0}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{j.submitted_by_name || "—"}</td>
                  <td className="px-4 py-2.5">
                    <SignoffBadge status={j.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
