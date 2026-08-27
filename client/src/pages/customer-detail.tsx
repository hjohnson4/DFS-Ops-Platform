import { useState } from "react";
import { useRoute, Link, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Customer, JobWithCustomer, JobStatus } from "@shared/schema";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { JobFormDialog } from "@/components/JobFormDialog";
import { buildCustomerReportHtml, printCustomerReport } from "@/lib/customerExport";
import { ArrowLeft, Briefcase, FileDown, Loader2, Mail, Pencil, Phone, Plus, Trash2, User } from "lucide-react";

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
  // Editing and deleting the customer itself is admin-only (job management above
  // keeps its own broader permission via canManage).
  const isAdmin = profile?.role === "admin";

  const { data: customer, isLoading, error } = useQuery<Customer>({
    queryKey: ["/api/customers", id],
    enabled: !!id,
  });

  // ---- Edit / delete customer (admin only) --------------------------------
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [eName, setEName] = useState("");
  const [eContact, setEContact] = useState("");
  const [ePhone, setEPhone] = useState("");
  const [eEmail, setEEmail] = useState("");
  const [eNotes, setENotes] = useState("");
  const [eActive, setEActive] = useState(true);

  const openEdit = () => {
    if (!customer) return;
    setEName(customer.name ?? "");
    setEContact(customer.primary_contact ?? "");
    setEPhone(customer.phone ?? "");
    setEEmail(customer.email ?? "");
    setENotes(customer.notes ?? "");
    setEActive(customer.active);
    setEditOpen(true);
  };

  const saveEdit = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", `/api/customers/${id}`, {
        name: eName,
        primary_contact: eContact || null,
        phone: ePhone || null,
        email: eEmail || null,
        notes: eNotes || null,
        active: eActive,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/customers", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/customers"] });
      toast({ title: "Customer updated" });
      setEditOpen(false);
    },
    onError: (e: any) =>
      toast({ title: "Could not update customer", description: e.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/customers/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/customers"] });
      toast({ title: "Customer deleted" });
      setConfirmDelete(false);
      navigate("/customers");
    },
    onError: (e: any) => {
      setConfirmDelete(false);
      toast({ title: "Could not delete customer", description: e.message, variant: "destructive" });
    },
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
        <div className="flex items-center gap-2">
          {isAdmin && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={openEdit}
                data-testid="button-edit-customer"
              >
                <Pencil className="mr-2 h-4 w-4" /> Edit
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => setConfirmDelete(true)}
                data-testid="button-delete-customer"
              >
                <Trash2 className="mr-2 h-4 w-4" /> Delete
              </Button>
            </>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={exportPdf}
            data-testid="button-export-customer-pdf"
          >
            <FileDown className="mr-2 h-4 w-4" /> Export PDF
          </Button>
        </div>
      </div>

      {/* Edit customer dialog (admin only) */}
      {isAdmin && (
        <Dialog open={editOpen} onOpenChange={setEditOpen}>
          <DialogContent>
            <DialogHeader><DialogTitle>Edit customer</DialogTitle></DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label>Company name</Label>
                <Input value={eName} onChange={(e) => setEName(e.target.value)} data-testid="input-edit-customer-name" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Primary contact</Label>
                  <Input value={eContact} onChange={(e) => setEContact(e.target.value)} data-testid="input-edit-customer-contact" />
                </div>
                <div className="space-y-1.5">
                  <Label>Phone</Label>
                  <Input value={ePhone} onChange={(e) => setEPhone(e.target.value)} data-testid="input-edit-customer-phone" />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Email</Label>
                <Input type="email" value={eEmail} onChange={(e) => setEEmail(e.target.value)} data-testid="input-edit-customer-email" />
              </div>
              <div className="space-y-1.5">
                <Label>Notes</Label>
                <Textarea value={eNotes} onChange={(e) => setENotes(e.target.value)} rows={2} data-testid="input-edit-customer-notes" />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={eActive}
                  onChange={(e) => setEActive(e.target.checked)}
                  data-testid="input-edit-customer-active"
                />
                Active customer
              </label>
            </div>
            <DialogFooter>
              <Button onClick={() => saveEdit.mutate()} disabled={saveEdit.isPending || !eName} data-testid="button-save-customer-edit">
                {saveEdit.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save changes
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Delete confirmation (admin only) */}
      {isAdmin && (
        <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this customer?</AlertDialogTitle>
              <AlertDialogDescription>
                This permanently removes {customer.name}. If the customer still
                has jobs, deletion is blocked until those jobs are removed or
                reassigned. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="button-cancel-delete-customer">Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => { e.preventDefault(); remove.mutate(); }}
                disabled={remove.isPending}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                data-testid="button-confirm-delete-customer"
              >
                {remove.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Delete customer
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

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
