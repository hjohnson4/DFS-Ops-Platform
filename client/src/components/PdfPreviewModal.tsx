import { useEffect, useRef, useState } from "react";
import { Download, Printer, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  PDF_PREVIEW_EVENT,
  type PdfPreviewDetail,
} from "@/lib/pdfPreview";

// Mounted once in AppShell. Listens for the global PDF-preview event and shows
// the generated report HTML in an on-page iframe with a Download / Print button.
// This replaces the old pop-up-tab-and-auto-print flow, which broke whenever the
// browser blocked pop-ups.
export default function PdfPreviewModal() {
  const [detail, setDetail] = useState<PdfPreviewDetail | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    const onPreview = (e: Event) => {
      const ce = e as CustomEvent<PdfPreviewDetail>;
      if (ce.detail?.html) setDetail(ce.detail);
    };
    window.addEventListener(PDF_PREVIEW_EVENT, onPreview as EventListener);
    return () =>
      window.removeEventListener(PDF_PREVIEW_EVENT, onPreview as EventListener);
  }, []);

  // Close on Escape.
  useEffect(() => {
    if (!detail) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDetail(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail]);

  const handleDownload = () => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    try {
      win.focus();
      win.print();
    } catch {
      /* the user can still use the browser's own print shortcut */
    }
  };

  if (!detail) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-black/60 backdrop-blur-sm"
      data-testid="pdf-preview-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) setDetail(null);
      }}
    >
      <div className="mx-auto flex h-full w-full max-w-5xl flex-col p-3 sm:p-6">
        {/* Toolbar */}
        <div className="flex items-center justify-between gap-3 rounded-t-lg border border-b-0 border-border bg-card px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">
              Document preview
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {detail.fileLabel}
            </p>
          </div>
          <div className="flex flex-none items-center gap-2">
            <Button
              size="sm"
              onClick={handleDownload}
              data-testid="button-download-pdf"
            >
              <Download className="mr-1.5 h-4 w-4" />
              Download PDF
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleDownload}
              className="hidden sm:inline-flex"
              data-testid="button-print-pdf"
            >
              <Printer className="mr-1.5 h-4 w-4" />
              Print
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setDetail(null)}
              aria-label="Close preview"
              data-testid="button-close-preview"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Preview surface */}
        <div className="flex-1 overflow-hidden rounded-b-lg border border-border bg-neutral-200">
          <iframe
            ref={iframeRef}
            title="PDF preview"
            srcDoc={detail.html}
            className="h-full w-full border-0 bg-white"
            data-testid="iframe-pdf-preview"
          />
        </div>

        <p className="mt-2 text-center text-xs text-white/70">
          Click Download PDF, then choose "Save as PDF" as the destination. Press
          Esc or click outside to close.
        </p>
      </div>
    </div>
  );
}
