import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, Download, ZoomIn, ZoomOut, ChevronLeft, ChevronRight } from "lucide-react";
import { readWorkbookInfo, renderSheet, renderOptionsFor, dayTabs, SHEET_CSS } from "@/lib/xlsxSheetRender";
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
 * In-app workbook viewer. Fetches the stored workbook and draws one tab at a
 * time the way it prints — column widths, merged cells, green label fills,
 * bold headers, borders, number formats and the DFS logo — so it reads like
 * the real daily report on phones and computers, no Excel app needed.
 *
 * Opens straight on the report's own day: `sourceSheet` is either the raw tab
 * name or the importer's label "Report Day N", which maps to the Nth day tab
 * ("Report Day 1", "2", "3", …) exactly the way the importer counts them.
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
  const [wb, setWb] = useState<{ XLSX: any; buf: ArrayBuffer; info: ReturnType<typeof readWorkbookInfo> | null; names: string[] } | null>(null);
  const [sheet, setSheet] = useState<string>("");
  // null = fit to width (default); a number = manual zoom.
  const [zoom, setZoom] = useState<number | null>(null);
  const [dl, setDl] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [boxW, setBoxW] = useState(0);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setErr("");
    setWb(null);
    setZoom(null);
    (async () => {
      try {
        const res = await apiRequest("GET", `/api/daily-reports/${reportId}/attachment`);
        const buf = await res.arrayBuffer();
        const XLSX: any = await import("xlsx");
        let info: ReturnType<typeof readWorkbookInfo> | null = null;
        let names: string[];
        try {
          info = readWorkbookInfo(XLSX, buf);
          names = info.sheets.filter((x) => !x.hidden).map((x) => x.name);
        } catch {
          // Not a modern .xlsx (e.g. old .xls) — fall back to the plain grid.
          const book = XLSX.read(buf, { type: "array", bookSheets: true });
          names = book.SheetNames.filter((_n: string, i: number) => !book.Workbook?.Sheets?.[i]?.Hidden);
        }
        if (!alive) return;
        setWb({ XLSX, buf, info, names });
        setSheet(pickStartTab(names, sourceSheet));
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

  // Track the viewing area's width for fit-to-width.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBoxW(el.clientWidth));
    ro.observe(el);
    setBoxW(el.clientWidth);
    return () => ro.disconnect();
  }, [open, loading]);

  const sheetNames: string[] = wb?.names ?? [];
  const days = useMemo(() => dayTabs(sheetNames), [sheetNames]);
  const dayIdx = days.findIndex((d) => d.name === sheet);

  const rendered = useMemo(() => {
    if (!wb || !sheet) return null;
    if (wb.info) {
      try {
        const out = renderSheet(wb.XLSX, wb.buf, wb.info, sheet, renderOptionsFor(wb.info, sheet));
        if (out) return { kind: "styled" as const, ...out };
      } catch {
        /* fall through to the plain grid */
      }
    }
    try {
      const book = wb.XLSX.read(wb.buf, { type: "array", sheets: [sheet] });
      const ws = book.Sheets[sheet];
      if (!ws || !tightenRange(wb.XLSX, ws)) return null;
      return { kind: "plain" as const, html: wb.XLSX.utils.sheet_to_html(ws, { header: "", footer: "", editable: false }), width: 0, height: 0 };
    } catch {
      return null;
    }
  }, [wb, sheet]);

  const fit = rendered?.kind === "styled" && rendered.width > 0 && boxW > 0 ? Math.min(1.25, (boxW - 16) / rendered.width) : 1;
  const scale = zoom ?? fit;
  const step = (d: number) => setZoom(Math.min(2, Math.max(0.25, +((zoom ?? fit) + d).toFixed(2))));

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

  const label = (n: string) => {
    const d = days.find((x) => x.name === n);
    return d ? `Report Day ${d.day}` : n;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[98vw] w-[98vw] h-[92vh] sm:max-w-5xl p-3 sm:p-5 flex flex-col gap-2"
        data-testid="dialog-workbook-viewer"
      >
        <DialogHeader className="space-y-1 pr-8">
          <DialogTitle className="text-base truncate">{fileName || "Daily report workbook"}</DialogTitle>
          <DialogDescription className="text-xs">
            Read-only, laid out like the printed report. Use the arrows to step through days, or download the original file.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          {days.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="h-9 px-2"
              disabled={dayIdx <= 0}
              onClick={() => dayIdx > 0 && setSheet(days[dayIdx - 1].name)}
              aria-label="Previous day"
              data-testid="button-viewer-prev-day"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          )}
          {sheetNames.length > 0 && (
            <select
              className="h-9 min-w-0 max-w-[48vw] rounded-md border border-input bg-background px-2 text-sm"
              value={sheet}
              onChange={(e) => setSheet(e.target.value)}
              data-testid="select-workbook-sheet"
            >
              {sheetNames.map((n) => (
                <option key={n} value={n}>
                  {label(n)}
                </option>
              ))}
            </select>
          )}
          {days.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="h-9 px-2"
              disabled={dayIdx < 0 || dayIdx >= days.length - 1}
              onClick={() => dayIdx >= 0 && dayIdx < days.length - 1 && setSheet(days[dayIdx + 1].name)}
              aria-label="Next day"
              data-testid="button-viewer-next-day"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          )}
          <div className="flex items-center gap-1">
            <Button size="sm" variant="outline" className="h-9 px-2" onClick={() => step(-0.1)} aria-label="Zoom out">
              <ZoomOut className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="outline" className="h-9 px-2" onClick={() => step(0.1)} aria-label="Zoom in">
              <ZoomIn className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-9 px-2 text-xs"
              onClick={() => setZoom(null)}
              disabled={zoom === null}
              data-testid="button-viewer-fit"
            >
              Fit
            </Button>
          </div>
          <Button size="sm" variant="outline" className="h-9 ml-auto" onClick={download} disabled={dl} data-testid="button-viewer-download">
            {dl ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Download className="mr-1.5 h-4 w-4" />}
            Download
          </Button>
        </div>

        <div
          ref={boxRef}
          className="relative flex-1 min-h-0 overflow-auto rounded-md border border-card-border bg-neutral-100"
          data-testid="workbook-viewer-body"
        >
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Opening workbook…
            </div>
          )}
          {!loading && err && <div className="p-4 text-sm text-destructive">{err}</div>}
          {!loading && !err && wb && !rendered && (
            <div className="p-4 text-sm text-muted-foreground">This tab is empty.</div>
          )}
          {!loading && !err && rendered?.kind === "styled" && (
            <div
              className="mx-auto my-2"
              style={{ width: rendered.width * scale + 8, height: rendered.height * scale + 8 }}
              data-testid="workbook-sheet-styled"
            >
              <div
                style={{ transform: `scale(${scale})`, transformOrigin: "0 0", width: rendered.width + 8, padding: 4, background: "#fff" }}
                dangerouslySetInnerHTML={{ __html: rendered.html }}
              />
            </div>
          )}
          {!loading && !err && rendered?.kind === "plain" && (
            <div
              className="dfs-sheet p-2 text-black bg-white"
              style={{ zoom: zoom ?? 0.8 } as any}
              dangerouslySetInnerHTML={{ __html: rendered.html }}
            />
          )}
        </div>
        <style>{SHEET_CSS + `
          .dfs-sheet table { border-collapse: collapse; font-size: 12px; font-family: Arial, sans-serif; }
          .dfs-sheet td { border: 1px solid #d4d4d4; padding: 2px 5px; white-space: nowrap; vertical-align: top; color: #111; }
          .dfs-sheet td:empty { min-width: 18px; }
        `}</style>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Which tab to open first. Exact tab name wins; "Report Day N" (the label the
 * importer stores) maps to the Nth day tab; otherwise the first day tab.
 */
export function pickStartTab(names: string[], sourceSheet?: string | null): string {
  const want = (sourceSheet || "").trim();
  if (want) {
    const exact = names.find((n) => n === want) || names.find((n) => n.trim().toLowerCase() === want.toLowerCase());
    if (exact) return exact;
    const m = /^report day\s*(\d+)$/i.exec(want) || /^day\s*(\d+)$/i.exec(want);
    if (m) {
      const d = dayTabs(names).find((x) => x.day === Number(m[1]));
      if (d) return d.name;
      // Workbook numbered differently — try a tab literally named N.
      const lit = names.find((n) => n.trim() === m[1]);
      if (lit) return lit;
    }
  }
  return dayTabs(names)[0]?.name || names[0] || "";
}
