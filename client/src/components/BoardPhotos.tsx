import { useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/queryClient";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Camera, X, Loader2, Trash2 } from "lucide-react";
import type { BoardFile } from "@shared/schema";

export const MAX_PHOTOS = 4;

/** Shrink a phone photo to at most 1600px on the long side, saved as JPEG. */
async function shrink(file: File): Promise<{ file_name: string; file_mime: string; file_base64: string }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => bad(new Error(`Couldn't read ${file.name}`));
      i.src = url;
    });
    const max = 1600;
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d")!.drawImage(img, 0, 0, w, h);
    const dataUrl = c.toDataURL("image/jpeg", 0.82);
    const base = (file.name || "photo").replace(/\.[^.]+$/, "") || "photo";
    return { file_name: `${base}.jpg`, file_mime: "image/jpeg", file_base64: dataUrl };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Upload picked photos to a post, task or comment. Returns how many failed. */
export async function uploadBoardPhotos(
  target: { post_id?: string; task_id?: string; comment_id?: string },
  files: File[],
): Promise<number> {
  let failed = 0;
  for (const f of files) {
    try {
      const small = await shrink(f);
      await apiRequest("POST", "/api/board/files", { ...target, ...small });
    } catch {
      failed++;
    }
  }
  return failed;
}

/** "Add photo" button + thumbnails of photos picked but not sent yet. */
export function PhotoPicker({
  files,
  onChange,
  compact,
  testId = "button-add-photo",
}: {
  files: File[];
  onChange: (f: File[]) => void;
  compact?: boolean;
  testId?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [previews, setPreviews] = useState<string[]>([]);
  useEffect(() => {
    const urls = files.map((f) => URL.createObjectURL(f));
    setPreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [files]);
  const full = files.length >= MAX_PHOTOS;
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const picked = Array.from(e.target.files || []).filter((f) => f.type.startsWith("image/"));
          onChange([...files, ...picked].slice(0, MAX_PHOTOS));
          e.target.value = "";
        }}
      />
      <button
        type="button"
        disabled={full}
        onClick={() => input.current?.click()}
        className={`inline-flex items-center gap-1.5 rounded-md border bg-card text-sm font-medium text-muted-foreground hover:text-foreground disabled:opacity-50 ${
          compact ? "h-9 px-2.5" : "h-9 px-3 max-sm:h-11"
        }`}
        data-testid={testId}
      >
        <Camera className="h-4 w-4" /> {full ? `${MAX_PHOTOS} photos max` : "Photo"}
      </button>
      {previews.map((u, i) => (
        <div key={u} className="relative h-14 w-14 rounded-md overflow-hidden border">
          <img src={u} alt="" className="h-full w-full object-cover" />
          <button
            type="button"
            onClick={() => onChange(files.filter((_, j) => j !== i))}
            className="absolute top-0.5 right-0.5 h-5 w-5 rounded-full bg-black/60 text-white flex items-center justify-center"
            aria-label="Remove photo"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

// Loaded photo URLs are kept for the session so lists don't re-download.
const cache = new Map<string, Promise<string>>();
function photoUrl(id: string): Promise<string> {
  if (!cache.has(id)) {
    const p = apiRequest("GET", `/api/board/files/${id}`)
      .then((r) => r.blob())
      .then((b) => URL.createObjectURL(b));
    p.catch(() => cache.delete(id));
    cache.set(id, p);
  }
  return cache.get(id)!;
}

function Thumb({ file, size, onOpen }: { file: BoardFile; size: string; onOpen: (url: string) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  useEffect(() => {
    let live = true;
    photoUrl(file.id).then((u) => live && setUrl(u)).catch(() => live && setBad(true));
    return () => {
      live = false;
    };
  }, [file.id]);
  return (
    <button
      type="button"
      onClick={() => url && onOpen(url)}
      className={`${size} shrink-0 rounded-md overflow-hidden border bg-muted flex items-center justify-center`}
      aria-label={`Open photo ${file.file_name}`}
      data-testid={`photo-${file.id}`}
    >
      {url ? (
        <img src={url} alt={file.file_name} className="h-full w-full object-cover" />
      ) : bad ? (
        <span className="text-[10px] text-muted-foreground px-1">Couldn't load</span>
      ) : (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      )}
    </button>
  );
}

/** Thumbnails; tap one to see it full screen. */
export function PhotoGrid({
  files,
  small,
  canDelete,
  onDeleted,
}: {
  files?: BoardFile[];
  small?: boolean;
  canDelete?: boolean;
  onDeleted?: () => void;
}) {
  const [open, setOpen] = useState<{ url: string; file: BoardFile } | null>(null);
  if (!files?.length) return null;
  const size = small ? "h-20 w-20" : "h-24 w-24 sm:h-28 sm:w-28";
  return (
    <>
      <div className="mt-2 flex gap-2 flex-wrap">
        {files.map((f) => (
          <Thumb key={f.id} file={f} size={size} onOpen={(url) => setOpen({ url, file: f })} />
        ))}
      </div>
      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="max-w-[min(96vw,1100px)] p-2 sm:p-3 bg-black border-0 max-sm:inset-0 max-sm:left-0 max-sm:top-0 max-sm:translate-x-0 max-sm:translate-y-0 max-sm:h-[100dvh] max-sm:max-w-none max-sm:rounded-none flex flex-col items-center justify-center [&>button]:text-white [&>button]:opacity-90">
          <DialogTitle className="sr-only">Photo</DialogTitle>
          {open && <img src={open.url} alt={open.file.file_name} className="max-h-[85dvh] max-w-full object-contain" />}
          {open && canDelete && (
            <button
              className="mt-2 inline-flex items-center gap-1.5 text-sm text-white/80 hover:text-white"
              onClick={async () => {
                if (!confirm("Remove this photo?")) return;
                try {
                  await apiRequest("DELETE", `/api/board/files/${open.file.id}`);
                  setOpen(null);
                  onDeleted?.();
                } catch (e: any) {
                  alert(e?.message || "Couldn't remove the photo.");
                }
              }}
            >
              <Trash2 className="h-4 w-4" /> Remove photo
            </button>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
