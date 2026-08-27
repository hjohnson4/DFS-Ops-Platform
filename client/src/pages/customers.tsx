import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import type { Customer, JobWithCustomer } from "@shared/schema";
import { buildCustomerReportHtml, printCustomerReport } from "@/lib/customerExport";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Plus, Building2, FileDown } from "lucide-react";

export default function CustomersPage() {
  const { profile } = useAuth();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  // Creating, editing, and deleting customers is admin-only.
  const canManage = profile?.role === "admin";

  const { data: customers, isLoading } = useQuery<Customer[]>({
    queryKey: ["/api/customers"],
  });

  // Jobs are area-scoped server-side; used to build per-customer/area summaries.
  const { data: jobs } = useQuery<JobWithCustomer[]>({
    queryKey: ["/api/jobs"],
  });

  const exportPdf = () => {
    const html = buildCustomerReportHtml(customers ?? [], jobs ?? [], {
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

  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");

  const create = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/customers", {
        name,
        primary_contact: contact || null,
        phone: phone || null,
        email: email || null,
        notes: notes || null,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/customers"] });
      toast({ title: "Customer added" });
      setOpen(false);
      setName(""); setContact(""); setPhone(""); setEmail(""); setNotes("");
    },
    onError: (e: any) =>
      toast({ title: "Could not add customer", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-semibold">Customers</h1>
        <div className="flex items-center gap-2">
        <Button
          variant="outline"
          onClick={exportPdf}
          disabled={!customers || customers.length === 0}
          data-testid="button-export-customers-pdf"
        >
          <FileDown className="mr-2 h-4 w-4" /> Export PDF
        </Button>
        {canManage && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button data-testid="button-add-customer">
                <Plus className="mr-2 h-4 w-4" /> Add customer
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Add a customer</DialogTitle></DialogHeader>
              <div className="space-y-4 py-2">
                <div className="space-y-1.5">
                  <Label>Company name</Label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="input-customer-name" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>Primary contact</Label>
                    <Input value={contact} onChange={(e) => setContact(e.target.value)} data-testid="input-customer-contact" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Phone</Label>
                    <Input value={phone} onChange={(e) => setPhone(e.target.value)} data-testid="input-customer-phone" />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Email</Label>
                  <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="input-customer-email" />
                </div>
                <div className="space-y-1.5">
                  <Label>Notes</Label>
                  <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} data-testid="input-customer-notes" />
                </div>
              </div>
              <DialogFooter>
                <Button onClick={() => create.mutate()} disabled={create.isPending || !name} data-testid="button-save-customer">
                  {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Add customer
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
        </div>
      </div>
      <p className="text-sm text-muted-foreground mb-5">
        Operators and clients your crews run jobs for.
      </p>

      {isLoading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">Loading…</div>
      ) : customers && customers.length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border bg-muted/30 p-10 text-center">
          <Building2 className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
          <div className="text-sm text-muted-foreground">No customers yet.</div>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {customers?.map((c) => (
            <Link key={c.id} href={`/customers/${c.id}`}>
              <a
                className="block rounded-lg border border-card-border bg-card p-4 transition-colors hover:border-primary/50 hover:bg-muted/40"
                data-testid={`card-customer-${c.id}`}
              >
                <div className="font-medium">{c.name}</div>
                {c.primary_contact && (
                  <div className="text-sm text-muted-foreground mt-1">{c.primary_contact}</div>
                )}
                <div className="text-xs text-muted-foreground mt-2 space-y-0.5">
                  {c.phone && <div>{c.phone}</div>}
                  {c.email && <div className="truncate">{c.email}</div>}
                </div>
                {!c.active && (
                  <span className="inline-block mt-2 text-xs text-muted-foreground">Inactive</span>
                )}
              </a>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
