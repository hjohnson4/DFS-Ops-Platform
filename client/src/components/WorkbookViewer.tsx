import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, Download, ZoomIn, ZoomOut } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

/**
 * Download a stored daily-report workbook in a way that works on phones.
 *
 * Phones (iPhone Safari especially, and home-screen apps) ignore blob downloads
 * and block window.open() after an await. Instead we ask the server for a
 * short-lived signed link and navigate to it; the server answers with
 * Content-Disposition: attachment, so the phone's own download / "Open in
 * Excel" sheet appears and the app page stays put.
 */
export async function downloadReportWorkbook(reportId: string) {
  const res = await apiRequest("POST", `/api/daily-reports/${reportId}/attachment-link`);
  const { url } = await res.json();
  window.location.href = url;
}

// Shrink a sheet's !ref to the cells that actually hold something, so a sheet
// formatted to column XFD / row 1,048,576 doesn't render a giant empty table.
function tightenRange(XLSX: any, ws: any) {
  let maxR = -1;
  let maxC = -1;
  for (const k of Object.keys(ws)) {
    if (k[0] === "!") continue;
    const c = ws[k];
    if (c == null || c.v == null || c.v === "") continue;
    const a = XLSX.utils.decode_cell(k);
    if (a.r > maxR) maxR = a.r;
    if (a.c > maxC) maxC = a.c;
  }
  if (maxR < 0) return false;
  ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
  if (Array.isArray(ws["!merges"]))
    ws["!merges"] = ws["!merges"].filter((m: any) => m.s.r <= maxR && m.s.c <= maxC);
  return true;
}

/**
 * In-app workbook viewer. Fetches the stored workbook, reads it in the
 * browser and shows one tab at a time as a scrollable table — works the same
 * on phones and computers, no Excel app needed. Opens on the report's own day
 * tab when known.
 */
export function WorkbookViewer({
  reportId,
  fileName,
  sourceSheet,
  open,
  onOpenChange,
}: {
  reportId: string;
  fileName?: string | null;
  sourceSheet?: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [wb, setWb] = useState<{ XLSX: any; book: any } | null>(null);
  const [sheet, setSheet] = useState<string>("");
  const [zoom, setZoom] = useState(0.8);
  const [dl, setDl] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setErr("");
    setWb(null);
    (async () => {
      try {
        const res = await apiRequest("GET", `/api/daily-reports/${reportId}/attachment`);
        const buf = await res.arrayBuffer();
        const XLSX: any = await import("xlsx");
        const book = XLSX.read(buf, { type: "array", cellStyles: false, cellHTML: false });
        if (!alive) return;
        const visible: string[] = book.SheetNames.filter(
          (n: string, i: number) => !book.Workbook?.Sheets?.[i]?.Hidden,
        );
        const start =
          (sourceSheet && visible.find((n) => n === sourceSheet)) ||
          (sourceSheet && visible.find((n) => n.trim().toLowerCase() === sourceSheet.trim().toLowerCase())) ||
          visible[0] ||
          book.SheetNames[0];
        setWb({ XLSX, book });
        setSheet(start);
      } catch (e: any) {
        if (alive) setErr(e?.message || "Could not open the workbook.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, reportId, sourceSheet]);

  const sheetNames: string[] = useMemo(
    () =>
      wb
        ? wb.book.SheetNames.filter((_n: string, i: number) => !wb.book.Workbook?.Sheets?.[i]?.Hidden)
        : [],
    [wb],
  );

  const html = useMemo(() => {
    if (!wb || !sheet) return "";
    const ws = wb.book.Sheets[sheet];
    if (!ws) return "";
    if (!tightenRange(wb.XLSX, ws)) return "";
    return wb.XLSX.utils.sheet_to_html(ws, { header: "", footer: "", editable: false });
  }, [wb, sheet]);

  async function download() {
    setDl(true);
    try {
      await downloadReportWorkbook(reportId);
    } catch (e: any) {
      toast({ title: "Could not download the workbook", description: e.message, variant: "destructive" });
    } finally {
      setDl(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[96vw] w-[96vw] h-[90vh] sm:max-w-5xl p-3 sm:p-5 flex flex-col gap-2"
        data-testid="dialog-workbook-viewer"
      >
        <DialogHeader className="space-y-1 pr-8">
          <DialogTitle className="text-base truncate">{fileName || "Daily report workbook"}</DialogTitle>
          <DialogDescription className="text-xs">
            Read-only view. Pick a tab below, scroll sideways, or download the original file.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          {sheetNames.length > 0 && (
            <select
              className="h-9 min-w-0 max-w-[60vw] rounded-md border border-input bg-background px-2 text-sm"
              value={sheet}
              onChange={(e) => setSheet(e.target.value)}
              data-testid="select-workbook-sheet"
            >
              {sheetNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          )}
          <div className="flex items-center gap-1">
            <Button size="sm" variant="outline" className="h-9 px-2" onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.1).toFixed(2)))} aria-label="Zoom out">
              <ZoomOut className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="outline" className="h-9 px-2" onClick={() => setZoom((z) => Math.min(1.6, +(z + 0.1).toFixed(2)))} aria-label="Zoom in">
              <ZoomIn className="h-4 w-4" />
            </Button>
          </div>
          <Button size="sm" variant="outline" className="h-9 ml-auto" onClick={download} disabled={dl} data-testid="button-viewer-download">
            {dl ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Download className="mr-1.5 h-4 w-4" />}
            Download
          </Button>
        </div>

        <div className="relative flex-1 min-h-0 overflow-auto rounded-md border border-card-border bg-white">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Opening workbook…
            </div>
          )}
          {!loading && err && <div className="p-4 text-sm text-destructive">{err}</div>}
          {!loading && !err && wb && !html && (
            <div className="p-4 text-sm text-muted-foreground">This tab is empty.</div>
          )}
          {!loading && !err && html && (
            <div
              className="dfs-sheet p-2 text-black"
              style={{ zoom } as any}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
        </div>
        <style>{`
          .dfs-sheet table { border-collapse: collapse; font-size: 12px; font-family: Arial, sans-serif; }
          .dfs-sheet td { border: 1px solid #d4d4d4; padding: 2px 5px; white-space: nowrap; vertical-align: top; color: #111; }
          .dfs-sheet td:empty { min-width: 18px; }
        `}</style>
      </DialogContent>
    </Dialog>
  );
}
