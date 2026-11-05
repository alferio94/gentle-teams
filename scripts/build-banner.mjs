// Builds docs/images/banner.svg: the static banner (docs/images/banner.png) embedded as a
// background, with SMIL animation on top (message dots travelling along the connections,
// a pulse on the active status and on the approval badge). The paths trace the lines drawn
// in the PNG. Usage: node scripts/build-banner.mjs docs/images/banner.png docs/images/banner.svg [debug]
// "debug" also strokes the animation paths in red to check their alignment.
import { readFileSync, writeFileSync } from "node:fs";
const [png, out, debug] = process.argv.slice(2);
const b64 = readFileSync(png).toString("base64");
const left = "M941,220 C896,254 850,313 829,390";
const right = "M1000,220 C1045,262 1088,318 1110,390";
const bottom = "M920,468 Q965,492 1010,470";
const dbg = debug === "debug" ? `<g fill="none" stroke="red" stroke-width="2"><path d="${left}"/><path d="${right}"/><path d="${bottom}"/></g>` : "";
const dot = (path, color, dur, begin) => `
  <circle r="4" fill="${color}" opacity="0" filter="url(#glow)">
    <animateMotion dur="${dur}s" begin="${begin}s" repeatCount="indefinite" path="${path}" keyPoints="0;1" keyTimes="0;1" calcMode="spline" keySplines="0.4 0 0.6 1"/>
    <animate attributeName="opacity" dur="${dur}s" begin="${begin}s" repeatCount="indefinite" values="0;1;1;0" keyTimes="0;0.15;0.85;1"/>
  </circle>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="640" viewBox="0 0 1280 640" role="img" aria-label="gentle-teams: your coding agents, working as a team across repositories">
  <defs>
    <filter id="glow" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <image width="1280" height="640" href="data:image/png;base64,${b64}"/>
  ${dbg}
  ${dot(left, "#b4befe", 3.2, 0)}
  ${dot(right, "#fab387", 3.6, 1.1)}
  ${dot(bottom, "#a6e3a1", 2.4, 0.5)}
  <circle cx="1058" cy="97" r="8" fill="none" stroke="#b4befe" stroke-width="1.5" opacity="0">
    <animate attributeName="r" values="8;15" dur="2.4s" repeatCount="indefinite"/>
    <animate attributeName="opacity" values="0.7;0" dur="2.4s" repeatCount="indefinite"/>
  </circle>
  <circle cx="965" cy="480" r="14" fill="none" stroke="#a6e3a1" stroke-width="1.5" opacity="0">
    <animate attributeName="r" values="13;22" dur="2.4s" begin="1.2s" repeatCount="indefinite"/>
    <animate attributeName="opacity" values="0.6;0" dur="2.4s" begin="1.2s" repeatCount="indefinite"/>
  </circle>
</svg>
`;
writeFileSync(out, svg);
