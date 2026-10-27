/**
 * Render ONE worksheet of an .xlsx file so it looks like the printed report:
 * column widths, row heights, merged cells, fills, fonts, borders, alignment,
 * number formats and pictures (the DFS logo).
 *
 * Values and number formatting come from SheetJS (reading just this one tab,
 * which is fast even for 50-tab workbooks). Formatting comes straight from the
 * workbook XML (styles.xml, theme1.xml, the sheet XML and its drawing), which
 * SheetJS's free build doesn't expose. The file is unzipped with SheetJS's own
 * zip reader, so no extra library is needed.
 *
 * Output is plain HTML made of absolutely positioned boxes in four layers
 * (fills → text → borders → pictures) so geometry is exact and borders are
 * drawn once, centered on the grid lines, like Excel.
 */

export type RenderedSheet = { html: string; width: number; height: number };

// ---------- small helpers ----------
const EMU_PER_PX = 9525;
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function colToNum(letters: string) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1; // 0-based
}
function decodeAddr(a: string): { r: number; c: number } | null {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)$/.exec(a.trim().toUpperCase());
  if (!m) return null;
  return { c: colToNum(m[1]), r: Number(m[2]) - 1 };
}
function decodeRange(ref: string) {
  const [a, b] = ref.split(":");
  const s = decodeAddr(a);
  const e = decodeAddr(b ?? a);
  if (!s || !e) return null;
  return { s: { r: Math.min(s.r, e.r), c: Math.min(s.c, e.c) }, e: { r: Math.max(s.r, e.r), c: Math.max(s.c, e.c) } };
}

// Children by local name (namespace-agnostic — workbooks mix prefixes).
function kids(el: Element | null | undefined, name: string): Element[] {
  if (!el) return [];
  const out: Element[] = [];
  for (let n = el.firstElementChild; n; n = n.nextElementSibling) if (n.localName === name) out.push(n);
  return out;
}
const kid = (el: Element | null | undefined, name: string) => kids(el, name)[0] ?? null;
function all(doc: Document | Element, name: string): Element[] {
  return Array.from((doc as any).getElementsByTagNameNS("*", name)) as Element[];
}
const attrN = (el: Element | null, a: string) => (el && el.getAttribute(a) != null ? Number(el.getAttribute(a)) : undefined);
// r:id / r:embed attributes live in the relationships namespace.
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const relAttr = (el: Element, a: string) => el.getAttributeNS(REL_NS, a) || el.getAttribute(`r:${a}`) || "";

// ---------- colors ----------
const INDEXED = [
  "000000","FFFFFF","FF0000","00FF00","0000FF","FFFF00","FF00FF","00FFFF",
  "000000","FFFFFF","FF0000","00FF00","0000FF","FFFF00","FF00FF","00FFFF",
  "800000","008000","000080","808000","800080","008080","C0C0C0","808080",
  "9999FF","993366","FFFFCC","CCFFFF","660066","FF8080","0066CC","CCCCFF",
  "000080","FF00FF","FFFF00","00FFFF","800080","800000","008080","0000FF",
  "00CCFF","CCFFFF","CCFFCC","FFFF99","99CCFF","FF99CC","CC99FF","FFCC99",
  "3366FF","33CCCC","99CC00","FFCC00","FF9900","FF6600","666699","969696",
  "003366","339966","003300","333300","993300","993366","333399","333333",
];

function applyTint(hex: string, tint: number) {
  if (!tint) return hex;
  let r = parseInt(hex.slice(0, 2), 16) / 255, g = parseInt(hex.slice(2, 4), 16) / 255, b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  if (s === 0) r = g = b = l;
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    r = hue(p, q, h + 1 / 3); g = hue(p, q, h); b = hue(p, q, h - 1 / 3);
  }
  const x = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  return (x(r) + x(g) + x(b)).toUpperCase();
}

type ColorCtx = { theme: string[] };
function readColor(el: Element | null, ctx: ColorCtx, fallback: string | null): string | null {
  if (!el) return fallback;
  if (el.getAttribute("auto") === "1") return fallback;
  let hex: string | null = null;
  const rgb = el.getAttribute("rgb");
  const theme = el.getAttribute("theme");
  const indexed = el.getAttribute("indexed");
  if (rgb) hex = rgb.length === 8 ? rgb.slice(2) : rgb;
  else if (theme != null) hex = ctx.theme[Number(theme)] ?? null;
  else if (indexed != null) {
    const i = Number(indexed);
    if (i === 64) return fallback; // system foreground
    if (i === 65) return fallback; // system background
    hex = INDEXED[i] ?? null;
  }
  if (!hex) return fallback;
  const tint = Number(el.getAttribute("tint") || 0);
  return "#" + applyTint(hex.toUpperCase(), tint);
}

function readTheme(xml: string | null): string[] {
  // Theme index order: lt1, dk1, lt2, dk2, accent1..6, hlink, folHlink.
  const dflt = ["FFFFFF","000000","E7E6E6","44546A","4472C4","ED7D31","A5A5A5","FFC000","5B9BD5","70AD47","0563C1","954F72"];
  if (!xml) return dflt;
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const scheme = all(doc, "clrScheme")[0];
  if (!scheme) return dflt;
  const get = (n: string, i: number) => {
    const e = kid(scheme, n);
    const c = e?.firstElementChild;
    if (!c) return dflt[i];
    return (c.getAttribute("lastClr") || c.getAttribute("val") || dflt[i]).toUpperCase();
  };
  return [
    get("lt1", 0), get("dk1", 1), get("lt2", 2), get("dk2", 3),
    get("accent1", 4), get("accent2", 5), get("accent3", 6), get("accent4", 7),
    get("accent5", 8), get("accent6", 9), get("hlink", 10), get("folHlink", 11),
  ];
}

// ---------- styles ----------
type Edge = { w: number; style: string; color: string } | null;
type Xf = {
  font: { b: boolean; i: boolean; u: boolean; strike: boolean; sz: number; name: string; color: string };
  fill: string | null;
  border: { l: Edge; r: Edge; t: Edge; b: Edge };
  h: string; v: string; wrap: boolean; indent: number; rotate: number; shrink: boolean;
};

const BORDER_STYLES: Record<string, { w: number; style: string }> = {
  thin: { w: 1, style: "solid" }, hair: { w: 1, style: "dotted" }, dotted: { w: 1, style: "dotted" },
  dashed: { w: 1, style: "dashed" }, dashDot: { w: 1, style: "dashed" }, dashDotDot: { w: 1, style: "dashed" },
  medium: { w: 2, style: "solid" }, mediumDashed: { w: 2, style: "dashed" }, mediumDashDot: { w: 2, style: "dashed" },
  mediumDashDotDot: { w: 2, style: "dashed" }, slantDashDot: { w: 2, style: "dashed" },
  thick: { w: 3, style: "solid" }, double: { w: 3, style: "double" },
};

function readStyles(xml: string | null, ctx: ColorCtx): Xf[] {
  const plain: Xf = {
    font: { b: false, i: false, u: false, strike: false, sz: 11, name: "Calibri", color: "#000000" },
    fill: null, border: { l: null, r: null, t: null, b: null },
    h: "general", v: "bottom", wrap: false, indent: 0, rotate: 0, shrink: false,
  };
  if (!xml) return [plain];
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const root = doc.documentElement;
  const fonts = kids(kid(root, "fonts"), "font").map((f) => {
    const on = (n: string) => {
      const e = kid(f, n);
      return !!e && e.getAttribute("val") !== "0" && e.getAttribute("val") !== "false";
    };
    return {
      b: on("b"), i: on("i"), u: !!kid(f, "u") && kid(f, "u")!.getAttribute("val") !== "none", strike: on("strike"),
      sz: attrN(kid(f, "sz"), "val") ?? 11,
      name: kid(f, "name")?.getAttribute("val") || "Calibri",
      color: readColor(kid(f, "color"), ctx, "#000000")!,
    };
  });
  const fills = kids(kid(root, "fills"), "fill").map((f) => {
    const p = kid(f, "patternFill");
    if (p) {
      const type = p.getAttribute("patternType") || (kid(p, "fgColor") ? "solid" : "none");
      if (type === "none") return null;
      // Solid fills use fgColor; other patterns approximate with fgColor too.
      return readColor(kid(p, "fgColor"), ctx, null) ?? readColor(kid(p, "bgColor"), ctx, null);
    }
    const g = kid(f, "gradientFill");
    if (g) {
      const stop = kids(g, "stop")[0];
      return stop ? readColor(kid(stop, "color"), ctx, null) : null;
    }
    return null;
  });
  const borders = kids(kid(root, "borders"), "border").map((b) => {
    const edge = (n: string): Edge => {
      const e = kid(b, n);
      const st = e?.getAttribute("style");
      if (!e || !st || st === "none") return null;
      const bs = BORDER_STYLES[st] ?? BORDER_STYLES.thin;
      return { ...bs, color: readColor(kid(e, "color"), ctx, "#000000")! };
    };
    return { l: edge("left") ?? edge("start"), r: edge("right") ?? edge("end"), t: edge("top"), b: edge("bottom") };
  });
  return kids(kid(root, "cellXfs"), "xf").map((x) => {
    const a = kid(x, "alignment");
    return {
      font: fonts[attrN(x, "fontId") ?? 0] ?? plain.font,
      fill: fills[attrN(x, "fillId") ?? 0] ?? null,
      border: borders[attrN(x, "borderId") ?? 0] ?? plain.border,
      h: a?.getAttribute("horizontal") || "general",
      v: a?.getAttribute("vertical") || "bottom",
      wrap: a?.getAttribute("wrapText") === "1" || a?.getAttribute("wrapText") === "true",
      indent: attrN(a, "indent") ?? 0,
      rotate: attrN(a, "textRotation") ?? 0,
      shrink: a?.getAttribute("shrinkToFit") === "1",
    };
  });
}

// ---------- zip access ----------
function makeZip(XLSX: any, buf: ArrayBuffer) {
  const cfb = XLSX.CFB.read(new Uint8Array(buf), { type: "array" });
  const bytes = (path: string): Uint8Array | null => {
    const p = path.replace(/^\/+/, "");
    const f = XLSX.CFB.find(cfb, "/" + p) || XLSX.CFB.find(cfb, p);
    return f && f.content ? (f.content instanceof Uint8Array ? f.content : new Uint8Array(f.content)) : null;
  };
  const text = (path: string): string | null => {
    const b = bytes(path);
    return b ? new TextDecoder("utf-8").decode(b) : null;
  };
  return { bytes, text };
}
function resolvePath(base: string, target: string) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}
function readRels(zip: ReturnType<typeof makeZip>, partPath: string): Record<string, string> {
  const dir = partPath.split("/").slice(0, -1).join("/");
  const file = partPath.split("/").pop();
  const xml = zip.text(`${dir}/_rels/${file}.rels`);
  const out: Record<string, string> = {};
  if (!xml) return out;
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  for (const r of all(doc, "Relationship")) {
    if (r.getAttribute("TargetMode") === "External") continue;
    out[r.getAttribute("Id") || ""] = resolvePath(partPath, r.getAttribute("Target") || "");
  }
  return out;
}
function toBase64(b: Uint8Array) {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(b.subarray(i, i + 0x8000)));
  return btoa(s);
}

/** Workbook-level facts: sheet → XML part, print areas, visibility. */
export function readWorkbookInfo(XLSX: any, buf: ArrayBuffer) {
  const zip = makeZip(XLSX, buf);
  const wbXml = zip.text("xl/workbook.xml");
  if (!wbXml) throw new Error("Not an .xlsx workbook");
  const doc = new DOMParser().parseFromString(wbXml, "application/xml");
  const rels = readRels(zip, "xl/workbook.xml");
  const sheets = all(doc, "sheet").map((s) => ({
    name: s.getAttribute("name") || "",
    part: rels[relAttr(s, "id")] || "",
    hidden: (s.getAttribute("state") || "visible") !== "visible",
  }));
  const printAreas: Record<string, string> = {};
  for (const d of all(doc, "definedName")) {
    const n = d.getAttribute("name") || "";
    if (!/^_?_xlnm\.Print_Area$/i.test(n)) continue;
    const idx = d.getAttribute("localSheetId");
    if (idx == null) continue;
    const sh = sheets[Number(idx)];
    const ref = (d.textContent || "").split(",")[0];
    if (!sh || /#REF!/i.test(ref)) continue;
    const r = ref.includes("!") ? ref.slice(ref.lastIndexOf("!") + 1) : ref;
    if (decodeRange(r.replace(/\$/g, ""))) printAreas[sh.name] = r.replace(/\$/g, "");
  }
  return { zip, sheets, printAreas };
}

/** Day tabs in workbook order, numbered the same way the importer numbers them. */
export function dayTabs(names: string[]): { day: number; name: string }[] {
  const out: { day: number; name: string }[] = [];
  let day = 0;
  for (const name of names) {
    const t = name.trim();
    if (/^Report Day 1$/i.test(t) || (/^\d+$/.test(t) && Number(t) >= 2)) out.push({ day: ++day, name });
  }
  return out;
}

/**
 * Build the styled HTML for one sheet.
 * `rangeHint` (A1:B2) limits what is drawn — normally the print area.
 */
export function renderSheet(
  XLSX: any,
  buf: ArrayBuffer,
  info: ReturnType<typeof readWorkbookInfo>,
  sheetName: string,
  opts: { printArea?: string | null; fitRows?: boolean } = {},
): RenderedSheet | null {
  const { zip, sheets } = info;
  const sh = sheets.find((s) => s.name === sheetName);
  if (!sh || !sh.part) return null;
  const sheetXml = zip.text(sh.part);
  if (!sheetXml) return null;

  const ctx: ColorCtx = { theme: readTheme(zip.text("xl/theme/theme1.xml")) };
  const xfs = readStyles(zip.text("xl/styles.xml"), ctx);
  const doc = new DOMParser().parseFromString(sheetXml, "application/xml");
  const root = doc.documentElement;

  // Values + formatted text for this tab only.
  const book = XLSX.read(buf, { type: "array", sheets: [sheetName], cellNF: true, cellDates: false });
  const ws = book.Sheets[sheetName] || {};

  const view = kid(kid(root, "sheetViews"), "sheetView");
  const showZeros = view?.getAttribute("showZeros") !== "0";

  // Geometry ------------------------------------------------------------
  const fmt = kid(root, "sheetFormatPr");
  const baseColW = attrN(fmt, "baseColWidth") ?? 8;
  const defColW = attrN(fmt, "defaultColWidth") ?? baseColW + 0.71;
  const defRowPt = attrN(fmt, "defaultRowHeight") ?? 15;
  const colW = new Map<number, number>();
  const colHidden = new Set<number>();
  const colStyle = new Map<number, number>();
  for (const c of kids(kid(root, "cols"), "col")) {
    const min = (attrN(c, "min") ?? 1) - 1, max = (attrN(c, "max") ?? 1) - 1;
    const w = attrN(c, "width");
    const hid = c.getAttribute("hidden") === "1" || c.getAttribute("hidden") === "true";
    const st = attrN(c, "style");
    for (let i = min; i <= Math.min(max, 16383); i++) {
      if (w != null) colW.set(i, w);
      if (hid) colHidden.add(i);
      if (st != null) colStyle.set(i, st);
    }
    if (max - min > 2000) break; // template filled to XFD — no need to expand further
  }
  const colPx = (c: number) => (colHidden.has(c) ? 0 : Math.floor(((256 * (colW.get(c) ?? defColW) + 18) / 256) * 7));

  const rowPt = new Map<number, number>();
  const rowHidden = new Set<number>();
  const rowStyle = new Map<number, number>();
  const cellStyle = new Map<string, number>();
  let maxR = 0, maxC = 0;
  for (const row of kids(kid(root, "sheetData"), "row")) {
    const r = (attrN(row, "r") ?? 1) - 1;
    const ht = attrN(row, "ht");
    if (ht != null) rowPt.set(r, ht);
    if (row.getAttribute("hidden") === "1" || row.getAttribute("hidden") === "true") rowHidden.add(r);
    if (row.getAttribute("customFormat") === "1" && row.getAttribute("s")) rowStyle.set(r, Number(row.getAttribute("s")));
    for (const c of kids(row, "c")) {
      const a = decodeAddr(c.getAttribute("r") || "");
      if (!a) continue;
      cellStyle.set(`${a.r},${a.c}`, Number(c.getAttribute("s") || 0));
      if (a.r > maxR) maxR = a.r;
      if (a.c > maxC) maxC = a.c;
    }
  }
  const rowPx = (r: number) => (rowHidden.has(r) ? 0 : Math.round(((rowPt.get(r) ?? defRowPt) * 96) / 72));

  // Range to draw. Normally the print area. With fitRows (day tabs), keep the
  // print area's columns but run from the first to the last filled row, so the
  // Date / Report # line on top and the KPI box at the bottom are included.
  const pa = opts.printArea ? decodeRange(opts.printArea) : null;
  let range = pa && !opts.fitRows ? pa : null;
  if (!range) {
    let r0 = Infinity, c0 = Infinity, vr = -1, vc = -1;
    for (const k of Object.keys(ws)) {
      if (k[0] === "!") continue;
      const cell = ws[k];
      if (cell == null || cell.v == null || cell.v === "") continue;
      const a = XLSX.utils.decode_cell(k);
      if (pa && (a.c < pa.s.c || a.c > pa.e.c)) continue;
      if (a.r < r0) r0 = a.r;
      if (a.c < c0) c0 = a.c;
      if (a.r > vr) vr = a.r;
      if (a.c > vc) vc = a.c;
    }
    if (vr < 0) return null;
    if (pa) {
      // Below the print area, keep going only while rows are filled in (the
      // KPI box); stop at the first blank row so crew helper notes under the
      // report are left out.
      const filledRows = new Set<number>();
      for (const k of Object.keys(ws)) {
        if (k[0] === "!") continue;
        const cell = ws[k];
        if (cell == null || cell.v == null || cell.v === "") continue;
        const a = XLSX.utils.decode_cell(k);
        if (a.c >= pa.s.c && a.c <= pa.e.c) filledRows.add(a.r);
      }
      let end = pa.e.r;
      while (filledRows.has(end + 1)) end++;
      range = { s: { r: Math.min(r0, pa.s.r), c: pa.s.c }, e: { r: end, c: pa.e.c } };
    } else range = { s: { r: r0, c: c0 }, e: { r: vr, c: vc } };
  }
  const { s: R0, e: R1 } = range;
  const nCols = R1.c - R0.c + 1, nRows = R1.r - R0.r + 1;
  if (nCols <= 0 || nRows <= 0 || nCols * nRows > 60000) return null;

  const xs: number[] = [0];
  for (let c = R0.c; c <= R1.c; c++) xs.push(xs[xs.length - 1] + colPx(c));
  const ys: number[] = [0];
  for (let r = R0.r; r <= R1.r; r++) ys.push(ys[ys.length - 1] + rowPx(r));
  const width = xs[nCols], height = ys[nRows];
  // Absolute x/y for any column/row (for pictures that start outside the range).
  const absX = (c: number) => {
    if (c >= R0.c && c <= R1.c + 1) return xs[c - R0.c];
    let x = c < R0.c ? 0 : xs[nCols];
    if (c < R0.c) for (let i = c; i < R0.c; i++) x -= colPx(i);
    else for (let i = R1.c + 1; i < c; i++) x += colPx(i);
    return x;
  };
  const absY = (r: number) => {
    if (r >= R0.r && r <= R1.r + 1) return ys[r - R0.r];
    let y = r < R0.r ? 0 : ys[nRows];
    if (r < R0.r) for (let i = r; i < R0.r; i++) y -= rowPx(i);
    else for (let i = R1.r + 1; i < r; i++) y += rowPx(i);
    return y;
  };

  // Merges --------------------------------------------------------------
  const mergeAt = new Map<string, { r1: number; c1: number; r2: number; c2: number }>();
  const covered = new Set<string>();
  for (const m of kids(kid(root, "mergeCells"), "mergeCell")) {
    const rg = decodeRange(m.getAttribute("ref") || "");
    if (!rg) continue;
    const r1 = Math.max(rg.s.r, R0.r), c1 = Math.max(rg.s.c, R0.c);
    const r2 = Math.min(rg.e.r, R1.r), c2 = Math.min(rg.e.c, R1.c);
    if (r1 > r2 || c1 > c2) continue;
    // Anchor on the real top-left cell so its value/style is used.
    mergeAt.set(`${rg.s.r},${rg.s.c}`, { r1, c1, r2, c2 });
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (r !== rg.s.r || c !== rg.s.c) covered.add(`${r},${c}`);
    if (rg.s.r < R0.r || rg.s.c < R0.c) {
      // Top-left lies outside the drawn range — draw the visible part from its first cell.
      mergeAt.set(`${r1},${c1}`, { r1, c1, r2, c2 });
      covered.delete(`${r1},${c1}`);
    }
  }

  const styleOf = (r: number, c: number) => {
    const s = cellStyle.get(`${r},${c}`) ?? rowStyle.get(r) ?? colStyle.get(c) ?? 0;
    return xfs[s] ?? xfs[0];
  };
  const textOf = (r: number, c: number): { text: string; isNum: boolean; isBool: boolean } | null => {
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    if (!cell || cell.v == null || cell.v === "") return null;
    if (cell.t === "n" && cell.v === 0 && !showZeros) return null;
    let text: string = cell.w != null ? String(cell.w) : String(cell.v);
    // Format 14 (system short date) shows a 4-digit year in US Excel.
    if (cell.t === "n" && (cell.z === "m/d/yy" || cell.z === 14)) {
      try {
        text = XLSX.SSF.format("m/d/yyyy", cell.v);
      } catch {
        /* keep SheetJS text */
      }
    }
    if (cell.t === "b") text = cell.v ? "TRUE" : "FALSE";
    if (text === "") return null;
    return { text, isNum: cell.t === "n" || cell.t === "d", isBool: cell.t === "b" };
  };
  const isEmpty = (r: number, c: number) => !textOf(r, c) && !covered.has(`${r},${c}`) && !mergeAt.has(`${r},${c}`);

  // Layers --------------------------------------------------------------
  const fills: string[] = [];
  const texts: string[] = [];
  const lines: string[] = [];
  // Borders are drawn once per grid edge; keep the heavier style when two cells disagree.
  const hEdges = new Map<string, Edge>(); // key: row-line index, col
  const vEdges = new Map<string, Edge>(); // key: row, col-line index
  const keep = (map: Map<string, Edge>, k: string, e: Edge) => {
    if (!e) return;
    const cur = map.get(k);
    if (!cur || e.w > cur.w) map.set(k, e);
  };

  for (let r = R0.r; r <= R1.r; r++) {
    for (let c = R0.c; c <= R1.c; c++) {
      const key = `${r},${c}`;
      if (covered.has(key)) continue;
      const m = mergeAt.get(key);
      const r2 = m ? m.r2 : r, c2 = m ? m.c2 : c;
      const x = xs[c - R0.c], y = ys[r - R0.r];
      const w = xs[c2 - R0.c + 1] - x, h = ys[r2 - R0.r + 1] - y;
      const st = styleOf(r, c);

      if (w > 0 && h > 0 && st.fill)
        fills.push(`<div style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;background:${st.fill}"></div>`);

      // Borders: each edge of a merged block comes from the cells along that edge.
      for (let cc = c; cc <= c2; cc++) {
        keep(hEdges, `${r - R0.r},${cc}`, styleOf(r, cc).border.t);
        keep(hEdges, `${r2 - R0.r + 1},${cc}`, styleOf(r2, cc).border.b);
      }
      for (let rr = r; rr <= r2; rr++) {
        keep(vEdges, `${rr},${c - R0.c}`, styleOf(rr, c).border.l);
        keep(vEdges, `${rr},${c2 - R0.c + 1}`, styleOf(rr, c2).border.r);
      }

      const t = textOf(r, c);
      if (!t || w <= 0 || h <= 0) continue;
      let hAlign = st.h;
      if (hAlign === "general") hAlign = t.isBool ? "center" : t.isNum ? "right" : "left";
      if (hAlign === "centerContinuous" || hAlign === "distributed") hAlign = "center";
      if (hAlign === "fill" || hAlign === "justify") hAlign = "left";

      // Unwrapped, unmerged text spills into empty neighbours like in Excel.
      let tx = x, tw = w;
      if (!st.wrap && !m) {
        if (hAlign === "left") {
          let cc = c + 1;
          while (cc <= R1.c && isEmpty(r, cc)) cc++;
          tw = xs[cc - R0.c] - x;
        } else if (hAlign === "right") {
          let cc = c - 1;
          while (cc >= R0.c && isEmpty(r, cc)) cc--;
          tx = xs[cc + 1 - R0.c];
          tw = x + w - tx;
        } else if (hAlign === "center") {
          let lc = c - 1, rc = c + 1;
          while (lc >= R0.c && isEmpty(r, lc)) lc--;
          while (rc <= R1.c && isEmpty(r, rc)) rc++;
          const room = Math.min(x - xs[lc + 1 - R0.c], xs[rc - R0.c] - (x + w));
          tx = x - room;
          tw = w + 2 * room;
        }
      }
      const f = st.font;
      const deco = [f.u ? "underline" : "", f.strike ? "line-through" : ""].filter(Boolean).join(" ");
      const css = [
        `left:${tx}px`, `top:${y}px`, `width:${tw}px`, `height:${h}px`,
        `justify-content:${hAlign === "right" ? "flex-end" : hAlign === "center" ? "center" : "flex-start"}`,
        `align-items:${st.v === "top" ? "flex-start" : st.v === "center" ? "center" : "flex-end"}`,
        `text-align:${hAlign}`,
        `font-size:${f.sz}pt`,
        `font-family:'${f.name.replace(/'/g, "")}',Calibri,Carlito,Arial,sans-serif`,
        f.b ? "font-weight:700" : "",
        f.i ? "font-style:italic" : "",
        deco ? `text-decoration:${deco}` : "",
        f.color && f.color !== "#000000" ? `color:${f.color}` : "",
        st.wrap ? "white-space:pre-wrap" : "white-space:pre",
        st.indent ? `padding-left:${st.indent * 9 + 2}px` : "",
      ].filter(Boolean).join(";");
      texts.push(`<div style="${css}"><span>${esc(t.text)}</span></div>`);
    }
  }

  hEdges.forEach((e, k) => {
    if (!e) return;
    const [li, c] = k.split(",").map(Number);
    const y = ys[li], x = xs[c - R0.c], w = xs[c - R0.c + 1] - x;
    if (w <= 0) return;
    lines.push(`<div style="left:${x}px;top:${y - Math.floor(e.w / 2)}px;width:${w + (e.w > 1 ? 1 : 0)}px;height:0;border-top:${e.w}px ${e.style} ${e.color}"></div>`);
  });
  vEdges.forEach((e, k) => {
    if (!e) return;
    const [r, li] = k.split(",").map(Number);
    const x = xs[li], y = ys[r - R0.r], h = ys[r - R0.r + 1] - y;
    if (h <= 0) return;
    lines.push(`<div style="left:${x - Math.floor(e.w / 2)}px;top:${y}px;width:0;height:${h + (e.w > 1 ? 1 : 0)}px;border-left:${e.w}px ${e.style} ${e.color}"></div>`);
  });

  // Pictures (e.g. the DFS logo) --------------------------------------------
  const pics: string[] = [];
  try {
    const drawingEl = kid(root, "drawing");
    if (drawingEl) {
      const sheetRels = readRels(zip, sh.part);
      const dPath = sheetRels[relAttr(drawingEl, "id")];
      const dXml = dPath ? zip.text(dPath) : null;
      if (dPath && dXml) {
        const dRels = readRels(zip, dPath);
        const dDoc = new DOMParser().parseFromString(dXml, "application/xml");
        const anchors = [...all(dDoc, "twoCellAnchor"), ...all(dDoc, "oneCellAnchor"), ...all(dDoc, "absoluteAnchor")];
        for (const an of anchors) {
          const blip = all(an, "blip")[0];
          if (!blip) continue;
          const media = dRels[relAttr(blip, "embed")];
          const bytes = media ? zip.bytes(media) : null;
          if (!bytes) continue;
          const pos = (el: Element | null) => {
            if (!el) return null;
            const num = (n: string) => Number(kid(el, n)?.textContent || 0);
            return { x: absX(num("col")) + num("colOff") / EMU_PER_PX, y: absY(num("row")) + num("rowOff") / EMU_PER_PX };
          };
          let p1 = pos(kid(an, "from"));
          let w = 0, h = 0;
          if (an.localName === "twoCellAnchor") {
            const p2 = pos(kid(an, "to"));
            if (!p1 || !p2) continue;
            w = p2.x - p1.x; h = p2.y - p1.y;
          } else {
            const ext = kid(an, "ext");
            w = Number(ext?.getAttribute("cx") || 0) / EMU_PER_PX;
            h = Number(ext?.getAttribute("cy") || 0) / EMU_PER_PX;
            if (an.localName === "absoluteAnchor") {
              const pe = kid(an, "pos");
              p1 = { x: Number(pe?.getAttribute("x") || 0) / EMU_PER_PX - absX(0) * 0, y: Number(pe?.getAttribute("y") || 0) / EMU_PER_PX };
            }
          }
          if (!p1 || w <= 0 || h <= 0) continue;
          if (p1.x > width || p1.y > height || p1.x + w < 0 || p1.y + h < 0) continue;
          const ext = (media.split(".").pop() || "png").toLowerCase();
          const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : ext === "svg" ? "image/svg+xml" : ext === "emf" || ext === "wmf" ? "" : "image/png";
          if (!mime) continue;
          pics.push(`<img alt="" src="data:${mime};base64,${toBase64(bytes)}" style="left:${p1.x}px;top:${p1.y}px;width:${w}px;height:${h}px">`);
        }
      }
    }
  } catch {
    /* pictures are a nice-to-have; never block the sheet */
  }

  const html =
    `<div class="xr" style="width:${width}px;height:${height}px">` +
    `<div class="xr-l">${fills.join("")}</div>` +
    `<div class="xr-l xr-t">${texts.join("")}</div>` +
    `<div class="xr-l">${lines.join("")}</div>` +
    `<div class="xr-l">${pics.join("")}</div>` +
    `</div>`;
  return { html, width, height };
}

/** CSS for the rendered sheet (inject once). */
export const SHEET_CSS = `
.xr{position:relative;background:#fff;color:#000;font-family:Calibri,Carlito,Arial,sans-serif;font-size:11pt;line-height:1.15}
.xr-l{position:absolute;inset:0;pointer-events:none}
.xr-l>*{position:absolute;box-sizing:border-box}
.xr-t{pointer-events:auto}
.xr-t>div{display:flex;overflow:hidden;padding:0 2px}
.xr-t>div>span{display:block;max-width:100%}
`;

/**
 * What to draw for a tab: its own print area; day tabs without one borrow the
 * columns of the first day tab's print area (or B:AX) and fit rows to content.
 */
export function renderOptionsFor(info: ReturnType<typeof readWorkbookInfo>, sheetName: string) {
  const days = dayTabs(info.sheets.map((s) => s.name));
  const isDay = days.some((d) => d.name === sheetName);
  if (!isDay) return { printArea: info.printAreas[sheetName] ?? null, fitRows: false };
  const area = info.printAreas[sheetName] || (days[0] && info.printAreas[days[0].name]) || "B1:AX1";
  return { printArea: area, fitRows: true };
}
