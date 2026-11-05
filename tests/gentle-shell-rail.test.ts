import { test } from "node:test";
import assert from "node:assert/strict";
import { attachGentleShellRail } from "../lib/ui/gentle-shell-rail.ts";
const key = Symbol.for("gentle-pi.experimental-sidebar.state");
function setup() { let invalidated = 0; let mouse: any; const original = { surface: "panel", render: (_width: number) => ["original"], invalidate: () => { invalidated++; }, digest: () => { throw Error("bad"); }, handleMouse: (e: any) => { mouse=e; return {handled:true}; } }; const state = {active:true, ownsHost:()=>true, parts:new Map<string, { render(width: number): string[]; invalidate(): void; digest?: () => string }>([["footer",original]])}; const tui = {mode:"fullscreen",terminal:{[key]:state},requestRender:()=>{}}; return {tui,state,original,get invalidated(){return invalidated},get mouse(){return mouse}}; }
test("S31 absence, incompatibility and regular mode fall back", () => { assert.equal(attachGentleShellRail({mode:"regular",terminal:{},requestRender(){}}, {render:()=>[],invalidate(){}}), undefined); assert.equal(attachGentleShellRail({mode:"fullscreen",terminal:{},requestRender(){}}, {render:()=>[],invalidate(){}}), undefined); });
test("S31 rail chains, routes mouse, invalidates and survives digest errors", () => { const h=setup(); const panel={render:()=>["panel"],invalidate(){},digest:()=>"p"}; const a=attachGentleShellRail(h.tui,panel)!; const wrapper:any=h.state.parts.get("footer"); assert.deepEqual(wrapper.render(20),["original","panel"]); assert.doesNotThrow(()=>wrapper.digest()); wrapper.handleMouse({y:0,height:2,width:20}); assert.equal(h.mouse.y,0); assert.equal(h.mouse.height,1); wrapper.invalidate(); assert.equal(h.invalidated,1); assert.equal(a.isActive(),true); a.dispose(); assert.equal(h.state.parts.get("footer"),h.original); });
test("S31 digest probe detects delegation even after minutes without rendering", () => {
 let now = 1000, renders = 0;
 const h = setup(); const a = attachGentleShellRail(h.tui, { render: () => { renders++; return ["panel"]; }, invalidate() {} }, () => now)!;
 const ours = h.state.parts.get("footer")!;
 const foreign = { ...h.original, digest: () => ours.digest!(), render: (width: number) => ours.render(width) };
 h.state.parts.set("footer", foreign);
 now += 300_000;
 assert.equal(a.isActive(), true); assert.equal(renders, 0, "probing must not render");
 h.state.active = false; assert.equal(a.isActive(), false);
 h.state.active = true; a.dispose(); assert.equal(a.isActive(), false);
 assert.equal(h.state.parts.get("footer"), foreign);
});
test("S31 nondelegating digest detects replacement immediately even after rendering", () => {
 const h = setup(); const a = attachGentleShellRail(h.tui, { render: () => ["panel"], invalidate() {} }, () => 1000)!;
 h.state.parts.get("footer")!.render(20);
 h.state.parts.set("footer", { ...h.original, digest: () => "replacement" });
 assert.equal(a.isActive(), false); a.dispose();
});
for (const throws of [false, true]) test(`S31 ${throws ? "throwing" : "missing"} digest falls back to ten-second render recency`, () => {
 let now = 1000; const h = setup();
 const a = attachGentleShellRail(h.tui, { render: () => ["panel"], invalidate() {} }, () => now)!;
 const ours = h.state.parts.get("footer")!;
 const foreign = { ...h.original, digest: throws ? () => { throw Error("bad"); } : undefined };
 // The fake host models optional digests, as does the actual rail interface.
 (h.state.parts as Map<string, { render(width: number): string[]; invalidate(): void; digest?: () => string }>).set("footer", foreign);
 assert.equal(a.isActive(), false);
 ours.render(20); assert.equal(a.isActive(), true);
 now += 9999; assert.equal(a.isActive(), true);
 now++; assert.equal(a.isActive(), false); a.dispose();
});
test("S31 independent wrappers detach in either order", () => { for (const reverse of [false,true]) { const h=setup(); const p=(label:string)=>({render:()=>[label],invalidate(){}}); const a=attachGentleShellRail(h.tui,p("a"))!; const b=attachGentleShellRail(h.tui,p("b"))!; const first=reverse?b:a, second=reverse?a:b; first.dispose(); const current:any=h.state.parts.get("footer"); assert.deepEqual(current.render(20),["original",reverse?"a":"b"]); second.dispose(); assert.deepEqual((h.state.parts.get("footer") as any).render(20),["original"]); } });
