// Phone alerts (web push). On iPhone this only works when DFS Ops was opened
// from its Home Screen icon (iOS 16.4+); on Android it works in Chrome too.
import { apiRequest } from "@/lib/queryClient";

export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}
export function isIos(): boolean {
  const ua = navigator.userAgent || "";
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (navigator as any).maxTouchPoints > 1);
}
export function isStandalone(): boolean {
  return (
    (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches) ||
    (navigator as any).standalone === true
  );
}

/** Register the (no-cache) service worker. Safe to call on every page load. */
export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (!/^https:|^http:\/\/localhost|^http:\/\/127\./.test(location.href)) return;
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
}

function keyBytes(b64: string): Uint8Array {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export type PushState = "unsupported" | "needs-home-screen" | "blocked" | "off" | "on";

export async function pushState(): Promise<PushState> {
  // iPhone only allows alerts from the Home Screen icon, so check that first.
  if (isIos() && !isStandalone()) return "needs-home-screen";
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? "on" : "off";
}

/**
 * Turn alerts on for this phone. Must be called straight from a button tap —
 * iPhone only shows the "Allow notifications" question in response to a tap.
 */
export async function enablePush(): Promise<PushState> {
  // Ask first, before any other waiting, so the tap still counts on iPhone.
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return perm === "denied" ? "blocked" : "off";
  const reg = (await navigator.serviceWorker.getRegistration("/")) || (await navigator.serviceWorker.register("/sw.js", { scope: "/" }));
  await navigator.serviceWorker.ready;
  const { key } = await (await apiRequest("GET", "/api/board/push/key")).json();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) as BufferSource });
  await apiRequest("POST", "/api/board/push/subscribe", sub.toJSON());
  return "on";
}

export async function disablePush(): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await apiRequest("POST", "/api/board/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
  return "off";
}
