import { useRoute, Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import type { Customer, JobWithCustomer, JobStatus } from "@shared/schema";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { JobFormDialog } from "@/components/JobFormDialog";
import { buildCustomerReportHtml, printCustomerReport } from "@/lib/customerExport";
import { ArrowLeft, Briefcase, FileDown, Mail, Phone, Plus, User } from "lucide-react";

const STATUS_TONE: Record<JobStatus, string> = {
  Active: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  "On Hold": "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  Completed: "bg-muted text-muted-foreground",
};

export default function CustomerDetailPage() {
  const [, params] = useRoute("/customers/:id");
  const [, navigate] = useLocation();
  const { profile } = useAuth();
  const { toast } = useToast();
  const id = params?.id;
  const canManage =
    profile?.role === "admin" || profile?.role === "area" || profile?.role === "super";

  const { data: customer, isLoading, error } = useQuery<Customer>({
    queryKey: ["/api/customers", id],
    enabled: !!id,
  });

  // Jobs are area-scoped server-side; filter to this customer client-side.
  const { data: allJobs, isLoading: jobsLoading } = useQuery<JobWithCustomer[]>({
    queryKey: ["/api/jobs"],
  });
  const jobs = (allJobs || []).filter((j) => j.customer_id === id);

  const exportPdf = () => {
    if (!customer) return;
    const html = buildCustomerReportHtml([customer], allJobs || [], {
      singleCustomerId: customer.id,
      generatedBy: profile?.name,
    });
    const ok = printCustomerReport(html);
    if (!ok) {
      toast({
        title: "Allow pop-ups to export",
        description:
          "Your browser blocked the report tab. Enable pop-ups for this site, then try Export PDF again.",
        variant: "destructive",
      });
    }
  };

  if (isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }
  if (error || !customer) {
    return (
      <div className="p-6 max-w-3xl">
        <BackLink />
        <div className="mt-4 text-sm text-muted-foreground">Customer not found.</div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl">
      <BackLink />

      <div className="mt-4 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold">{customer.name}</h1>
          {!customer.active && (
            <span className="inline-block mt-1 text-xs text-muted-foreground">Inactive</span>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={exportPdf}
          data-testid="button-export-customer-pdf"
        >
          <FileDown className="mr-2 h-4 w-4" /> Export PDF
        </Button>
      </div>

      {/* Contact card */}
      <div className="mt-4 rounded-lg border border-card-border bg-card p-4 grid sm:grid-cols-3 gap-4 text-sm">
        <Field icon={User} label="Primary contact" value={customer.primary_contact} />
        <Field icon={Phone} label="Phone" value={customer.phone} />
        <Field icon={Mail} label="Email" value={customer.email} />
      </div>
      {customer.notes && (
        <div className="mt-3 rounded-lg border border-card-border bg-card p-4 text-sm">
          <div className="text-xs text-muted-foreground mb-1">Notes</div>
          <div className="whitespace-pre-wrap">{customer.notes}</div>
        </div>
      )}

      {/* Jobs */}
      <div className="mt-6 flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold">
          Jobs {!jobsLoading && <span className="text-muted-foreground font-normal">({jobs.length})</span>}
        </h2>
        {canManage && (
          <JobFormDialog
            lockedCustomer={customer}
            trigger={
              <Button size="sm" variant="outline" data-testid="button-add-job-for-customer">
                <Plus className="mr-1.5 h-4 w-4" /> Add job
              </Button>
            }
          />
        )}
      </div>

      {jobsLoading ? (
        <div className="text-sm text-muted-foreground py-6 text-center">Loading jobs…</div>
      ) : jobs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-8 text-center">
          <Briefcase className="h-5 w-5 mx-auto text-muted-foreground mb-2" />
          <div className="text-sm text-muted-foreground">
            No jobs for this customer yet.
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            You only see jobs in your operating area.
          </div>
          {canManage && (
            <div className="mt-3">
              <JobFormDialog
                lockedCustomer={customer}
                trigger={
                  <Button size="sm" variant="outline">
                    <Plus className="mr-1.5 h-4 w-4" /> Add the first job
                  </Button>
                }
              />
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-card-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr className="text-left">
                <th className="px-4 py-2.5 font-medium">Job #</th>
                <th className="px-4 py-2.5 font-medium">Area</th>
                <th className="px-4 py-2.5 font-medium">Description</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr
                  key={j.id}
                  onClick={() => navigate(`/jobs/${j.id}`)}
                  className="border-t border-card-border cursor-pointer hover:bg-muted/40"
                  data-testid={`row-job-${j.id}`}
                >
                  <td className="px-4 py-2.5 font-medium">{j.job_number}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{j.area}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{j.description || "—"}</td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_TONE[j.status]}`}>
                      {j.status}
                    </span>
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

function BackLink() {
  return (
    <Link href="/customers">
      <a className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground" data-testid="link-back-customers">
        <ArrowLeft className="h-4 w-4" /> Customers
      </a>
    </Link>
  );
}

function Field({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | null;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-0.5">
        <Icon className="h-3.5 w-3.5" /> {label}
      </div>
      <div className={value ? "" : "text-muted-foreground"}>{value || "—"}</div>
    </div>
  );
}
