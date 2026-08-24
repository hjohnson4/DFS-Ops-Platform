import { useState, useEffect, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { type JobWithCustomer, type Asset, type FieldTicket } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";

interface Props {
  trigger: ReactNode;
  job: JobWithCustomer;
  ticket?: FieldTicket; // when present, the dialog edits this ticket
  onSaved?: () => void;
}

// yyyy-mm-dd for today (local)
function today() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

export function FieldTicketFormDialog({ trigger, job, ticket, onSaved }: Props) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const editing = !!ticket;

  // assets assigned to this job — the equipment eligible for the ticket
  const { data: allAssets } = useQuery<Asset[]>({
    queryKey: ["/api/assets"],
    enabled: open,
  });
  // eligible = assets currently on this job, plus any already on the ticket
  const jobAssets = (allAssets || []).filter(
    (a) => a.job_id === job.id || (ticket?.asset_ids ?? []).includes(a.id),
  );

  const [ticketDate, setTicketDate] = useState(today());
  const [wellName, setWellName] = useState("");
  const [poAfe, setPoAfe] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [comments, setComments] = useState("");
  const [assetIds, setAssetIds] = useState<string[]>([]);

  // seed fields when opening (edit mode) or reset (create mode)
  const seed = () => {
    if (ticket) {
      setTicketDate(ticket.ticket_date);
      setWellName(ticket.well_name ?? "");
      setPoAfe(ticket.po_afe ?? "");
      setAmount(ticket.amount == null ? "" : String(ticket.amount));
      setDescription(ticket.description ?? "");
      setComments(ticket.comments ?? "");
      setAssetIds(ticket.asset_ids ?? []);
    } else {
      setTicketDate(today());
      setWellName("");
      setPoAfe("");
      setAmount("");
      setDescription("");
      setComments("");
      setAssetIds([]);
    }
  };
  useEffect(() => {
    if (open) seed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const toggleAsset = (id: string) =>
    setAssetIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        ticket_date: ticketDate,
        well_name: wellName.trim() || null,
        po_afe: poAfe.trim() || null,
        amount: amount.trim() === "" ? null : Number(amount),
        description: description.trim() || null,
        comments: comments.trim() || null,
        asset_ids: assetIds,
      };
      const res = editing
        ? await apiRequest("PATCH", `/api/field-tickets/${ticket!.id}`, body)
        : await apiRequest("POST", `/api/jobs/${job.id}/field-tickets`, body);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/jobs", job.id, "field-tickets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/field-tickets"] });
      toast({ title: editing ? "Field ticket updated" : "Field ticket created" });
      setOpen(false);
      onSaved?.();
    },
    onError: (e: any) =>
      toast({
        title: editing ? "Could not update ticket" : "Could not create ticket",
        description: e.message,
        variant: "destructive",
      }),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editing
              ? `Edit field ticket #${ticket!.ticket_number} · Job ${job.job_number}`
              : `New field ticket · Job ${job.job_number}`}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {/* Read-only context from the parent job */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Customer</Label>
              <div className="rounded-md border border-card-border bg-muted/40 px-3 py-2 text-sm">
                {job.customer_name}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Job number</Label>
              <div className="rounded-md border border-card-border bg-muted/40 px-3 py-2 text-sm">
                {job.job_number} · {job.area}
              </div>
            </div>
          </div>

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
              <Label>Billable amount (optional)</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  className="pl-7"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  data-testid="input-ticket-amount"
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Well name (optional)</Label>
              <Input
                value={wellName}
                onChange={(e) => setWellName(e.target.value)}
                placeholder="e.g. Keg 1-0-39"
                data-testid="input-ticket-well"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Customer PO / AFE (optional)</Label>
              <Input
                value={poAfe}
                onChange={(e) => setPoAfe(e.target.value)}
                placeholder="PO or AFE #"
                data-testid="input-ticket-po"
              />
            </div>
          </div>

          {/* Equipment used — from the job's assigned assets */}
          <div className="space-y-1.5">
            <Label>
              Equipment used{" "}
              {assetIds.length > 0 && (
                <span className="text-muted-foreground font-normal">
                  · {assetIds.length} selected
                </span>
              )}
            </Label>
            {jobAssets.length === 0 ? (
              <div className="rounded-md border border-dashed border-card-border bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
                No assets are assigned to this job. Assign equipment from the job's
                detail page to include it on tickets.
              </div>
            ) : (
              <div className="max-h-36 overflow-y-auto rounded-md border border-card-border divide-y divide-card-border">
                {jobAssets.map((a) => (
                  <label
                    key={a.id}
                    className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer hover:bg-muted/40"
                    data-testid={`ticket-asset-${a.id}`}
                  >
                    <Checkbox
                      checked={assetIds.includes(a.id)}
                      onCheckedChange={() => toggleAsset(a.id)}
                    />
                    <span className="font-medium">{a.tag}</span>
                    <span className="text-muted-foreground">{a.category}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Description of work (optional)</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Summary of work performed on site."
              data-testid="input-ticket-description"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Comments (optional)</Label>
            <Textarea
              value={comments}
              onChange={(e) => setComments(e.target.value)}
              rows={2}
              placeholder="Additional notes."
              data-testid="input-ticket-comments"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={() => save.mutate()}
            disabled={save.isPending || !ticketDate}
            data-testid="button-save-ticket"
          >
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {editing ? "Save changes" : "Create ticket"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
