import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

const STATE = Symbol.for("gentle-pi.experimental-sidebar.state");
type Rail = Component & { digest?: () => string; surface?: "panel" };
type Host = { active: boolean; ownsHost: () => boolean; parts: Map<string, Rail> };
type RailTui = { mode?: string; terminal?: object; requestRender(): void };
export interface RailAttachment { isActive(): boolean; invalidate(): void; dispose(): void }

/** Wrap the current footer, preserving other extensions' wrappers. */
export function attachGentleShellRail(tui: RailTui, panel: Rail, now: () => number = Date.now): RailAttachment | undefined {
 if (tui.mode !== "fullscreen" || !tui.terminal) return undefined;
 const host = (tui.terminal as Record<symbol, unknown>)[STATE] as Host | undefined;
 if (!host || !(host.parts instanceof Map) || typeof host.ownsHost !== "function") return undefined;
 const previous = host.parts.get("footer");
 if (!previous || typeof previous.render !== "function" || typeof previous.invalidate !== "function") return undefined;
 let disposed = false, height = 0, revision = 0;
 let lastRender: number | undefined;
 let probing = false, reached = false;
 const wrapper: Rail = {
  surface: previous.surface,
  render(width) { lastRender = now(); const before = previous.render(width); height = before.length; return disposed ? before : [...before, ...panel.render(width)]; },
  invalidate() { revision++; previous.invalidate(); panel.invalidate(); },
  digest() { if (probing) { reached = true; return ""; } let a = "", b = ""; try { a = previous.digest?.() ?? ""; } catch {} try { b = panel.digest?.() ?? ""; } catch {} return JSON.stringify([a, disposed ? "" : b, revision]); },
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined { if (event.y < 0 || event.y >= height) return undefined; return previous.handleMouse?.({ ...event, height }); },
 };
 host.parts.set("footer", wrapper); tui.requestRender();
 return {
  isActive() {
   if (disposed || !host.active || tui.mode !== "fullscreen") return false;
   try { if (host.ownsHost() !== true) return false; } catch { return false; }
   const current = host.parts.get("footer");
   if (current === wrapper) return true;
   try {
    if (typeof current?.digest === "function") {
     probing = true; reached = false;
     try { current.digest(); return reached; } finally { probing = false; }
    }
   } catch { /* An incompatible digest falls back to the last render. */ }
   return lastRender !== undefined && now() - lastRender < 10_000;
  },
  invalidate() { if (!disposed) { revision++; tui.requestRender(); } },
  dispose() { if (disposed) return; disposed = true; revision++; if (host.parts.get("footer") === wrapper) host.parts.set("footer", previous); tui.requestRender(); },
 };
}
