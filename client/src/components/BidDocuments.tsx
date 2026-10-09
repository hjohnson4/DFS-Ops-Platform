import { useRef } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { BidDocument } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { FileText, Loader2, Trash2, Upload } from "lucide-react";

// Matches the server limit (the hosting service caps one upload at ~4.5 MB).
const MAX_BYTES = 3 * 1024 * 1024;

function fmtSize(bytes: number): string {
  if (!bytes) return "—";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Chicago" });
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("Could not read the file"));
    r.readAsDataURL(file);
  });
}

// Fetch through the authenticated API and open in a new tab.
async function openDoc(d: BidDocument) {
  const res = await apiRequest("GET", `/api/bid-documents/${d.id}/file`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob.type === "application/pdf" ? blob : new Blob([blob], { type: "application/pdf" }));
  const win = window.open(url, "_blank");
  if (!win) {
    const a = document.createElement("a");
    a.href = url;
    a.download = d.file_name || "bid.pdf";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Bid PDFs list. `listUrl` returns the documents; `uploadUrl` (when set and
 * `canEdit`) accepts new PDFs. `alsoInvalidate` refreshes other queries (e.g.
 * the forecast board's document counts) after a change.
 */
export function BidDocuments({
  listUrl,
  uploadUrl,
  canEdit,
  alsoInvalidate = [],
  emptyText = "No bid PDFs yet.",
}: {
  listUrl: string;
  uploadUrl: string | null;
  canEdit: boolean;
  alsoInvalidate?: string[];
  emptyText?: string;
}) {
  const { toast } = useToast();
  const input = useRef<HTMLInputElement>(null);
  const { data: docs, isLoading, error } = useQuery<BidDocument[]>({ queryKey: [listUrl] });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: [listUrl] });
    alsoInvalidate.forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
  };

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const f of files) {
        if (!/\.pdf$/i.test(f.name) && f.type !== "application/pdf") throw new Error(`${f.name} isn't a PDF`);
        if (f.size > MAX_BYTES) throw new Error(`${f.name} is over 3 MB. Save a smaller copy or split it.`);
      }
      for (const f of files) {
        await apiRequest("POST", uploadUrl!, { file_name: f.name, file_base64: await readBase64(f) });
      }
      return files.length;
    },
    onSuccess: (n) => {
      refresh();
      toast({ title: n === 1 ? "Bid PDF added" : `${n} bid PDFs added` });
    },
    onError: (e: any) => {
      refresh();
      toast({ title: "Could not add the PDF", description: e.message, variant: "destructive" });
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => apiRequest("DELETE", `/api/bid-documents/${id}`),
    onSuccess: () => {
      refresh();
      toast({ title: "Bid PDF removed" });
    },
    onError: (e: any) => toast({ title: "Could not remove the PDF", description: e.message, variant: "destructive" }),
  });

  const view = async (d: BidDocument) => {
    try {
      await openDoc(d);
    } catch (e: any) {
      toast({ title: "Could not open file", description: e.message, variant: "destructive" });
    }
  };

  return (
    <div className="space-y-2" data-testid="bid-documents">
      {isLoading ? (
        <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : error ? (
        <div className="py-2 text-sm text-rose-700 dark:text-rose-400">{(error as any).message}</div>
      ) : !docs?.length ? (
        <div className="rounded-md border border-dashed border-card-border px-3 py-4 text-center text-sm text-muted-foreground">
          {emptyText}
        </div>
      ) : (
        <ul className="divide-y divide-card-border rounded-md border border-card-border">
          {docs.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-3 py-2" data-testid={`row-bid-doc-${d.id}`}>
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <button
                type="button"
                onClick={() => view(d)}
                className="min-w-0 flex-1 text-left"
                data-testid={`button-open-bid-doc-${d.id}`}
              >
                <div className="truncate text-sm font-medium text-primary hover:underline">{d.file_name}</div>
                <div className="text-xs text-muted-foreground">
                  {fmtDate(d.created_at)} · {d.uploaded_by_name || "—"} · {fmtSize(d.file_size)}
                </div>
              </button>
              {canEdit && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-rose-600"
                  onClick={() => confirm(`Remove ${d.file_name}?`) && remove.mutate(d.id)}
                  disabled={remove.isPending}
                  aria-label={`Remove ${d.file_name}`}
                  data-testid={`button-remove-bid-doc-${d.id}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && uploadUrl && (
        <div className="flex items-center gap-3">
          <input
            ref={input}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              e.target.value = "";
              if (files.length) upload.mutate(files);
            }}
            data-testid="input-bid-doc-file"
          />
          <Button size="sm" variant="outline" onClick={() => input.current?.click()} disabled={upload.isPending} data-testid="button-add-bid-doc">
            {upload.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1.5 h-3.5 w-3.5" />}
            Add bid PDF
          </Button>
          <span className="text-xs text-muted-foreground">PDF only, up to 3 MB each</span>
        </div>
      )}
    </div>
  );
}
