import ws from "ws";

// Supabase-js instantiates a realtime client that needs a WebSocket global.
// Node 20 has no native WebSocket, so polyfill it BEFORE @supabase/supabase-js
// is imported (we don't use realtime, but its constructor runs regardless).
//
// This lives in its own module so that a static `import "./ws-polyfill"` placed
// ABOVE the supabase-js import guarantees the side effect runs first — ES module
// imports execute in source order, and a static supabase-js import in the same
// file would otherwise be hoisted above this assignment. Keeping it separate
// makes the ordering explicit and ESM-safe (no require()).
const g = globalThis as any;
if (typeof g.WebSocket === "undefined") {
  g.WebSocket = ws;
}
if (typeof g.WebSocket === "undefined") {
  throw new Error("WebSocket polyfill failed");
}

export {};
