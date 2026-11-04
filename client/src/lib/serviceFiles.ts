// Turn a picked file into { name, mime, base64 } for upload. Phone photos are
// shrunk (longest side 1800px, JPEG) so they upload quickly and fit the limit;
// other files (PDF, Word, Excel…) are sent as-is.
export interface PreparedFile {
  name: string;
  mime: string;
  base64: string;
  bytes: number;
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Could not read the file"));
    r.readAsDataURL(file);
  });
}

function stripPrefix(dataUrl: string) {
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

const b64Bytes = (b64: string) => Math.floor((b64.length * 3) / 4);

async function shrinkImage(file: File): Promise<PreparedFile | null> {
  try {
    const url = URL.createObjectURL(file);
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("bad image"));
      i.src = url;
    });
    const max = 1800;
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    const b64 = stripPrefix(canvas.toDataURL("image/jpeg", 0.8));
    const base = file.name.replace(/\.[^.]+$/, "") || "photo";
    return { name: `${base}.jpg`, mime: "image/jpeg", base64: b64, bytes: b64Bytes(b64) };
  } catch {
    return null; // e.g. HEIC the browser can't draw — send the original
  }
}

export async function prepareFile(file: File): Promise<PreparedFile> {
  if (file.type.startsWith("image/") && file.type !== "image/gif" && file.type !== "image/svg+xml") {
    const small = await shrinkImage(file);
    if (small) return small;
  }
  const b64 = stripPrefix(await readAsDataUrl(file));
  return {
    name: file.name || "file",
    mime: file.type || "application/octet-stream",
    base64: b64,
    bytes: b64Bytes(b64),
  };
}

export function fileSizeLabel(n: number | null | undefined) {
  if (!n && n !== 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
