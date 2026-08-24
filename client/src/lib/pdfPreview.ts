// Shared in-page PDF preview system.
//
// Previously every export opened a new browser tab and auto-fired window.print(),
// which silently fails when pop-ups are blocked. Instead, all exports now route
// through showPdfPreview(): it renders the generated HTML in an on-page <iframe>
// modal (mounted once in AppShell) with an explicit "Download PDF" button that
// prints the same-origin iframe. No pop-up permission required.

export interface PdfPreviewDetail {
  html: string;
  fileLabel: string;
}

export const PDF_PREVIEW_EVENT = "dfs:pdf-preview";

/**
 * Strip any auto-print bootstrap <script> from generated report HTML so the
 * document does not try to print itself when shown inside the preview iframe.
 * Printing is triggered explicitly by the modal's Download button instead.
 */
function stripAutoPrint(html: string): string {
  return html.replace(/<script>[\s\S]*?<\/script>/gi, (block) =>
    /\.print\s*\(/.test(block) ? "" : block,
  );
}

/**
 * Open the shared in-page preview modal with the given report HTML.
 * `fileLabel` is used as the suggested document title when downloading.
 */
export function showPdfPreview(html: string, fileLabel: string): void {
  if (typeof window === "undefined") return;
  const detail: PdfPreviewDetail = {
    html: stripAutoPrint(html),
    fileLabel: fileLabel || "DFS Report",
  };
  window.dispatchEvent(new CustomEvent(PDF_PREVIEW_EVENT, { detail }));
}
