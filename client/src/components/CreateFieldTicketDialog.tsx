import { useState, useEffect, useMemo, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  type Customer,
  type JobWithCustomer,
  type LineItem,
} from "@shared/schema";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Plus, Trash2, FileText } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { buildFieldTicketHtml, printFieldTicket } from "@/lib/fieldTicketExport";
import type { FieldTicketWithJob } from "@shared/schema";

interface Props {
  trigger: ReactNode;
  onCreated?: () => void;
}

// yyyy-mm-dd for today (local)
function today() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

const fmtMoney = (n: number): string =>
  n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

interface DraftLine {
  description: string;
  quantity: string;
  unit_cost: string;
}

const emptyLine = (): DraftLine => ({
  description: "",
  quantity: "",
  unit_cost: "",
});

const lineTotal = (l: DraftLine): number => {
  const q = Number(l.quantity);
  const u = Number(l.unit_cost);
  if (isNaN(q) || isNaN(u)) return 0;
  return Math.round(q * u * 100) / 100;
};

export function CreateFieldTicketDialog({ trigger, onCreated }: Props) {
  const { toast } = useToast();
  const { profile } = useAuth();
  const [open, setOpen] = useState(false);

  const { data: customers } = useQuery<Customer[]>({
    queryKey: ["/api/customers"],
    enabled: open,
  });
  const { data: jobs } = useQuery<JobWithCustomer[]>({
    queryKey: ["/api/jobs"],
    enabled: open,
  });

  const [customerId, setCustomerId] = useState("");
  const [jobId, setJobId] = useState("");
  const [ticketDate, setTicketDate] = useState(today());
  const [county, setCounty] = useState("");
  const [wellName, setWellName] = useState("");
  const [poAfe, setPoAfe] = useState("");
  const [description, setDescription] = useState("");
  const [comments, setComments] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [override, setOverride] = useState(""); // manual amount override

  const reset = () => {
    setCustomerId("");
    setJobId("");
    setTicketDate(today());
    setCounty("");
    setWellName("");
    setPoAfe("");
    setDescription("");
    setComments("");
    setLines([emptyLine()]);
    setOverride("");
  };
  useEffect(() => {
    if (open) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selectedCustomer = useMemo(
    () => (customers || []).find((c) => c.id === customerId),
    [customers, customerId],
  );

  // Only the selected customer's ACTIVE jobs can take a ticket (server rule).
  const customerJobs = useMemo(
    () =>
      (jobs || []).filter(
        (j) => j.customer_id === customerId && j.status === "Active",
      ),
    [jobs, customerId],
  );

  const selectedJob = useMemo(
    () => customerJobs.find((j) => j.id === jobId),
    [customerJobs, jobId],
  );

  // When a job is picked, default the well name from the job if blank.
  useEffect(() => {
    if (selectedJob && !wellName) setWellName(selectedJob.well_name ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // Changing customer clears the job selection.
  const onCustomerChange = (id: string) => {
    setCustomerId(id);
    setJobId("");
    setWellName("");
  };

  const updateLine = (i: number, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines((prev) => [...prev, emptyLine()]);
  const removeLine = (i: number) =>
    setLines((prev) =>
      prev.length === 1 ? [emptyLine()] : prev.filter((_, idx) => idx !== i),
    );

  const lineSum = useMemo(
    () => lines.reduce((s, l) => s + lineTotal(l), 0),
    [lines],
  );
  const overrideNum = override.trim() === "" ? null : Number(override);
  const grandTotal = overrideNum != null && !isNaN(overrideNum) ? overrideNum : lineSum;

  const validLines = lines.filter(
    (l) => l.description.trim() !== "" && l.quantity.trim() !== "" && l.unit_cost.trim() !== "",
  );

  const save = useMutation({
    mutationFn: async () => {
      const line_items = validLines.map((l) => ({
        description: l.description.trim(),
        quantity: Number(l.quantity),
        unit_cost: Number(l.unit_cost),
      }));
      const body = {
        ticket_date: ticketDate,
        county: county.trim() || null,
        well_name: wellName.trim() || null,
        po_afe: poAfe.trim() || null,
        description: description.trim() || null,
        line_items,
        amount:
          overrideNum != null && !isNaN(overrideNum) ? overrideNum : null,
        comments: comments.trim() || null,
      };
      const res = await apiRequest(
        "POST",
        `/api/jobs/${jobId}/field-tickets`,
        body,
      );
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/field-tickets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/jobs", jobId, "field-tickets"] });
      toast({ title: "Field ticket created" });
      setOpen(false);
      onCreated?.();
    },
    onError: (e: any) =>
      toast({
        title: "Could not create ticket",
        description: e.message,
        variant: "destructive",
      }),
  });

  const canSave = !!customerId && !!jobId && !!ticketDate && !save.isPending;

  // Build a draft ticket from the current form state and open the in-page PDF
  // preview — no save required. Lets the user review the printable ticket (with
  // the customer signature line) before creating it, then Download PDF.
  const previewPdf = () => {
    const draft = {
      ticket_number: "DRAFT",
      ticket_date: ticketDate,
      county: county.trim() || null,
      well_name: wellName.trim() || null,
      po_afe: poAfe.trim() || null,
      description: description.trim() || null,
      comments: comments.trim() || null,
      amount: overrideNum != null && !isNaN(overrideNum) ? overrideNum : null,
      line_items: validLines.map((l) => ({
        description: l.description.trim(),
        quantity: Number(l.quantity),
        unit_cost: Number(l.unit_cost),
      })),
      job_number: selectedJob?.job_number ?? null,
      area: selectedJob?.area ?? null,
      customer_name: selectedCustomer?.name ?? null,
      customer_contact: selectedCustomer?.primary_contact ?? null,
      customer_phone: selectedCustomer?.phone ?? null,
      customer_email: selectedCustomer?.email ?? null,
    } as unknown as FieldTicketWithJob;
    const html = buildFieldTicketHtml(draft, { generatedBy: profile?.name });
    printFieldTicket(html, "Field Ticket · Draft preview");
  };

  const canPreview = !!customerId && !!jobId && !!ticketDate;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New field ticket</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {/* Customer + job */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Customer</Label>
              <Select value={customerId} onValueChange={onCustomerChange}>
                <SelectTrigger data-testid="select-ticket-customer">
                  <SelectValue placeholder="Select customer" />
                </SelectTrigger>
                <SelectContent>
                  {(customers || []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Job No.</Label>
              <Select
                value={jobId}
                onValueChange={setJobId}
                disabled={!customerId}
              >
                <SelectTrigger data-testid="select-ticket-job">
                  <SelectValue
                    placeholder={
                      !customerId
                        ? "Select customer first"
                        : customerJobs.length === 0
                          ? "No active jobs"
                          : "Select job"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {customerJobs.map((j) => (
                    <SelectItem key={j.id} value={j.id}>
                      {j.job_number} · {j.area}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Customer info once selected */}
          {selectedCustomer && (
            <div className="rounded-md border border-card-border bg-muted/40 px-3 py-2 text-sm">
              <div className="font-medium">{selectedCustomer.name}</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {[
                  selectedCustomer.primary_contact,
                  selectedCustomer.phone,
                  selectedCustomer.email,
                ]
                  .filter(Boolean)
                  .join(" · ") || "No contact details on file"}
              </div>
            </div>
          )}

          {/* Work date / county / well / PO-AFE */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Work date</Label>
              <Input
                type="date"
                value={ticketDate}
                onChange={(e) => setTicketDate(e.target.value)}
                data-testid="input-ticket-date"
              />
            </div>
            <div className="space-y-1.5">
              <Label>County</Label>
              <Input
                value={county}
                onChange={(e) => setCounty(e.target.value)}
                placeholder="e.g. Midland"
                data-testid="input-ticket-county"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Well name</Label>
              <Input
                value={wellName}
                onChange={(e) => setWellName(e.target.value)}
                placeholder="e.g. Keg 1-0-39"
                data-testid="input-ticket-well"
              />
            </div>
            <div className="space-y-1.5">
              <Label>P.O. / A.F.E.</Label>
              <Input
                value={poAfe}
                onChange={(e) => setPoAfe(e.target.value)}
                placeholder="PO or AFE #"
                data-testid="input-ticket-po"
              />
            </div>
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <Label>Description of work</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Summary of work performed on site."
              data-testid="input-ticket-description"
            />
          </div>

          {/* Line items */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Line items</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addLine}
                data-testid="button-add-line"
              >
                <Plus className="mr-1 h-3.5 w-3.5" /> Add line
              </Button>
            </div>
            <div className="rounded-md border border-card-border overflow-hidden">
              <div className="grid grid-cols-[1fr_80px_100px_100px_36px] gap-2 bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground">
                <div>Description</div>
                <div className="text-right">Qty</div>
                <div className="text-right">Unit cost</div>
                <div className="text-right">Total</div>
                <div />
              </div>
              <div className="divide-y divide-card-border">
                {lines.map((l, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-[1fr_80px_100px_100px_36px] gap-2 px-3 py-2 items-center"
                    data-testid={`line-row-${i}`}
                  >
                    <Input
                      value={l.description}
                      onChange={(e) => updateLine(i, { description: e.target.value })}
                      placeholder="Item / service"
                      className="h-8"
                      data-testid={`input-line-desc-${i}`}
                    />
                    <Input
                      type="number"
                      min="0"
                      step="any"
                      inputMode="decimal"
                      value={l.quantity}
                      onChange={(e) => updateLine(i, { quantity: e.target.value })}
                      className="h-8 text-right"
                      placeholder="0"
                      data-testid={`input-line-qty-${i}`}
                    />
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      inputMode="decimal"
                      value={l.unit_cost}
                      onChange={(e) => updateLine(i, { unit_cost: e.target.value })}
                      className="h-8 text-right"
                      placeholder="0.00"
                      data-testid={`input-line-cost-${i}`}
                    />
                    <div
                      className="text-right text-sm tabular-nums"
                      data-testid={`text-line-total-${i}`}
                    >
                      {fmtMoney(lineTotal(l))}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={() => removeLine(i)}
                      data-testid={`button-remove-line-${i}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-end gap-3 border-t border-card-border bg-muted/30 px-3 py-2 text-sm">
                <span className="text-muted-foreground">Line items subtotal</span>
                <span className="font-semibold tabular-nums" data-testid="text-line-subtotal">
                  {fmtMoney(lineSum)}
                </span>
              </div>
            </div>
          </div>

          {/* Amount override + grand total */}
          <div className="grid grid-cols-2 gap-3 items-end">
            <div className="space-y-1.5">
              <Label>Total override (optional)</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                  $
                </span>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  className="pl-7"
                  placeholder="Auto from line items"
                  value={override}
                  onChange={(e) => setOverride(e.target.value)}
                  data-testid="input-ticket-override"
                />
              </div>
            </div>
            <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-right">
              <div className="text-xs text-muted-foreground">Ticket total</div>
              <div className="text-lg font-bold tabular-nums" data-testid="text-grand-total">
                {fmtMoney(grandTotal)}
              </div>
            </div>
          </div>

          {/* Comments */}
          <div className="space-y-1.5">
            <Label>Comments</Label>
            <Textarea
              value={comments}
              onChange={(e) => setComments(e.target.value)}
              rows={2}
              placeholder="Additional notes shown at the bottom of the ticket."
              data-testid="input-ticket-comments"
            />
          </div>

          <p className="text-xs text-muted-foreground">
            A customer signature line and date are printed on the exported PDF
            for sign-off on site.
          </p>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={previewPdf}
            disabled={!canPreview}
            data-testid="button-preview-ticket-pdf"
          >
            <FileText className="mr-2 h-4 w-4" />
            Preview PDF
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={!canSave}
            data-testid="button-save-ticket"
          >
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create ticket
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
