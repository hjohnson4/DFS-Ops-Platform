import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, Upload, AlertTriangle, FileSpreadsheet } from "lucide-react";

// Read a File into a base64 string (no data: prefix) for JSON upload.
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Uploads go through a serverless function with a ~4.5 MB request limit;
// base64 adds about a third, so cap the workbook at 3 MB.
const MAX_BYTES = 3 * 1024 * 1024;

type Preview = {
  source_sheet: string;
  report_date: string | null;
  well_name: string | null;
  changes: string[];
  missing_fields: string[];
  warnings: string[];
};

export function ReplaceWorkbookDialog({
  reportId,
  reportDay,
  signedOff,
}: {
  reportId: string;
  reportDay: number | null;
  signedOff: boolean;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<{ name: string; b64: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [readErr, setReadErr] = useState<string | null>(null);

  const reset = () => {
    setFile(null);
    setPreview(null);
    setReadErr(null);
  };

  const check = useMutation({
    mutationFn: async (f: { name: string; b64: string }) => {
      const res = await apiRequest("POST", `/api/daily-reports/${reportId}/replace-workbook/preview`, {
        attachment_base64: f.b64,
        attachment_name: f.name,
      });
      return (await res.json()) as Preview;
    },
    onSuccess: (p) => setPreview(p),
    onError: (e: any) => setReadErr(e.message),
  });

  const save = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/daily-reports/${reportId}/replace-workbook`, {
        attachment_base64: file!.b64,
        attachment_name: file!.name,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/daily-reports"] });
      toast({
        title: "Workbook replaced",
        description: "The report has the corrected values and is back in Pending Review.",
      });
      setOpen(false);
      reset();
    },
    onError: (e: any) =>
      toast({ title: "Could not replace the workbook", description: e.message, variant: "destructive" }),
  });

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    reset();
    if (!f) return;
    if (!/\.xlsx?$/i.test(f.name)) {
      setReadErr("Choose the daily report Excel workbook (.xlsx).");
      return;
    }
    if (f.size > MAX_BYTES) {
      setReadErr("That file is larger than 3 MB. Email it in instead, and it will replace the report automatically.");
      return;
    }
    try {
      const b64 = await fileToBase64(f);
      const picked = { name: f.name, b64 };
      setFile(picked);
      check.mutate(picked);
    } catch (err: any) {
      setReadErr(err?.message || "Could not read the file.");
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" data-testid="button-replace-workbook">
          <Upload className="mr-1.5 h-4 w-4" /> Replace workbook
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Replace workbook</DialogTitle>
          <DialogDescription>
            Upload the corrected workbook. DFS Ops reads the same tab
            {reportDay != null ? ` (Report Day ${reportDay})` : ""} and shows
            you what will change before anything is saved.
          </DialogDescription>
        </DialogHeader>

        <label
          className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-card-border p-3 text-sm hover:bg-muted/40"
          data-testid="label-replace-file"
        >
          <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
          <span className="truncate">{file ? file.name : "Choose the .xlsx file…"}</span>
          <input
            type="file"
            accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={onPick}
            data-testid="input-replace-file"
          />
        </label>

        {check.isPending && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading the workbook…
          </div>
        )}
        {readErr && (
          <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-sm" data-testid="text-replace-error">
            {readErr}
          </div>
        )}

        {preview && (
          <div className="space-y-3 text-sm" data-testid="section-replace-preview">
            {preview.warnings.map((w) => (
              <div key={w} className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5">
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
                <span>{w}</span>
              </div>
            ))}
            <div>
              <div className="font-medium mb-1">
                {preview.changes.length
                  ? `What will change (${preview.changes.length})`
                  : "No values are different from the current report."}
              </div>
              {preview.changes.length > 0 && (
                <ul className="max-h-56 overflow-y-auto list-disc space-y-0.5 rounded-md border border-card-border p-2.5 pl-7">
                  {preview.changes.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              )}
            </div>
            {preview.missing_fields.length > 0 && (
              <div className="text-muted-foreground">
                Still missing: {preview.missing_fields.join("; ")}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              {signedOff
                ? "This report is signed off. Replacing clears the sign-off and sends it back to Pending Review. "
                : "The report goes back to Pending Review. "}
              Run hours already added to the centrifuges are not added again.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={!preview || !file || save.isPending}
            data-testid="button-confirm-replace"
          >
            {save.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Replace
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
