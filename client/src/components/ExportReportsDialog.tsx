import { useState, type ReactNode } from "react";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { FileText, Loader2 } from "lucide-react";

// Reusable date-range export dialog. Fetches a JSON report from `endpoint`
// (with ?start=&end=) and hands it to `render` which builds + opens the PDF.
export function ExportReportsDialog<Report>({
  title,
  description,
  endpoint,
  render,
  trigger,
  helpText,
}: {
  title: string;
  description: string;
  /** e.g. "/api/service-reports/export.json" */
  endpoint: string;
  /** Given the fetched report + the current user's name, open the PDF. */
  render: (report: Report, generatedBy?: string) => void;
  trigger?: ReactNode;
  helpText?: string;
}) {
  const { toast } = useToast();
  const { profile } = useAuth();
  const [open, setOpen] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 29 * 86400000)
    .toISOString()
    .slice(0, 10);
  const [start, setStart] = useState(monthAgo);
  const [end, setEnd] = useState(today);
  const [busy, setBusy] = useState(false);

  const generate = async () => {
    if (!start || !end || end < start) {
      toast({
        title: "Pick a valid date range",
        description: "End date must be on or after the start date.",
        variant: "destructive",
      });
      return;
    }
    setBusy(true);
    try {
      const res = await apiRequest(
        "GET",
        `${endpoint}?start=${start}&end=${end}`,
      );
      const report = (await res.json()) as Report;
      render(report, profile?.name);
      setOpen(false);
      toast({
        title: "Report ready",
        description:
          "Your PDF opened in a new tab — use your browser's print dialog to save it.",
      });
    } catch (e: any) {
      toast({
        title: "Export failed",
        description: e?.message ?? "Something went wrong.",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="outline" data-testid="button-export-reports">
            <FileText className="mr-1.5 h-4 w-4" />
            Export PDF
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="export-start">Start date</Label>
            <Input
              id="export-start"
              type="date"
              value={start}
              max={end}
              onChange={(e) => setStart(e.target.value)}
              data-testid="input-export-start"
            />
          </div>
          <div>
            <Label htmlFor="export-end">End date</Label>
            <Input
              id="export-end"
              type="date"
              value={end}
              min={start}
              max={today}
              onChange={(e) => setEnd(e.target.value)}
              data-testid="input-export-end"
            />
          </div>
        </div>
        {helpText && (
          <p className="text-xs text-muted-foreground">{helpText}</p>
        )}
        <DialogFooter>
          <Button
            onClick={generate}
            disabled={busy}
            data-testid="button-generate-report"
          >
            {busy ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <FileText className="mr-1.5 h-4 w-4" />
            )}
            Generate PDF
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
