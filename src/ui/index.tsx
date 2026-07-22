import React, { useMemo, useState } from "react";
import {
  useHostLocation,
  useHostNavigation,
  usePluginAction,
  usePluginData,
} from "@paperclipai/plugin-sdk/ui";
import type {
  PluginDetailTabProps,
  PluginPageProps,
} from "@paperclipai/plugin-sdk/ui";
import { PAGE_ROUTE, agentIdFromSearch, isPluginRoute, pageHref } from "../routes.js";
import {
  type Assignment,
  type Mode,
  generateDockerVolumes,
  resolveEffectiveMode,
} from "../model.js";
import type {
  AgentProfileResponse,
  HermesAgentsResponse,
  HermesAgentSummary,
  ProfileAccessResponse,
  ProfileApplyResult,
  ProfilesResponse,
  ProfileSummary,
  SetProfileAccessResponse,
} from "../worker.js";

interface TreeEntry {
  name: string;
  path: string;
  isDir: boolean;
}

/** Presentation metadata per permission mode. `cycle` order is R → RW → D. */
const MODE_META: Record<Mode, { key: Mode; short: string; label: string }> = {
  ro: { key: "ro", short: "R", label: "Read only" },
  rw: { key: "rw", short: "RW", label: "Read / Write" },
  denied: { key: "denied", short: "D", label: "Denied" },
};

/** The single-button cycle order, matching the on-screen legend. */
const CYCLE: Mode[] = ["ro", "rw", "denied"];

function nextMode(current: Mode): Mode {
  const i = CYCLE.indexOf(current);
  return CYCLE[(i + 1) % CYCLE.length];
}

// ---------------------------------------------------------------------------
// Namespaced stylesheet. Inline styles can't express :hover / :focus-visible /
// :active / transitions, so all interaction states live here under `fam-*`
// classes. Tokens adapt to the host's light/dark theme via the host's own `.dark`
// class on <html> — never via prefers-color-scheme, which tracks the OS and can
// disagree with the host theme (see the theme-switch note above `.dark .fam-root`).
//
// Responsive strategy — two independent axes, deliberately not conflated:
//
//   1. SPACE → `@container fam (max-width: …)`. This is a plugin panel embedded
//      in the Paperclip host, so the viewport is the wrong thing to measure: a
//      400px-wide desktop side panel needs the same layout as a phone, and a
//      phone-width viewport hosting a wide panel does not. `.fam-root` declares
//      `container-type: inline-size` and every layout breakpoint queries it.
//      (Container queries must target descendants of the container, which is
//      why page padding lives on the inner `.fam-page`, not on `.fam-root`.)
//
//   2. INPUT MODALITY → `@media (pointer: coarse)` / `(hover: hover)`. Touch
//      targets and hover affordances depend on the input device, not on width.
//      All `:hover` rules are gated behind `(hover: hover) and (pointer: fine)`
//      so tapped elements don't keep a stuck hover state on touch, and the
//      hover-revealed revert button stays permanently visible when there is no
//      hover to reveal it with.
// ---------------------------------------------------------------------------

const STYLE = `
.fam-root {
  container-type: inline-size;
  container-name: fam;
  --fam-pad: 16px;
  --fam-indent: 16px;
  --fam-fg: var(--foreground, #1a1d21);
  --fam-muted: #4b5563;
  --fam-faint: #6b7280;
  --fam-border: rgba(0,0,0,0.10);
  --fam-border-strong: rgba(0,0,0,0.20);
  --fam-row-hover: rgba(0,0,0,0.045);
  --fam-surface: rgba(0,0,0,0.03);
  --fam-surface-2: rgba(0,0,0,0.05);
  --fam-accent: #2563eb;
  --fam-rw: #15803d;   --fam-rw-bg: rgba(22,163,74,0.13);   --fam-rw-border: rgba(22,163,74,0.45);
  --fam-ro: #b45309;   --fam-ro-bg: rgba(217,119,6,0.13);   --fam-ro-border: rgba(217,119,6,0.45);
  --fam-den: #64748b;  --fam-den-bg: rgba(100,116,139,0.12); --fam-den-border: rgba(100,116,139,0.38);
  --fam-danger: #dc2626; --fam-danger-bg: rgba(220,38,38,0.09); --fam-danger-border: rgba(220,38,38,0.35);
  --fam-ok: #15803d;   --fam-ok-bg: rgba(22,163,74,0.13);
  color: var(--fam-fg);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
}
/* Theme switch follows the HOST, not the OS. Paperclip is a shadcn/Tailwind app
   that toggles themes with a \`.dark\` class on <html> and defines no
   \`prefers-color-scheme\` rules at all. Keying off the OS preference instead
   meant a light-OS/dark-host session rendered near-black text on the host's
   near-black background — unreadable. \`--fam-fg\` also defers to the host's own
   \`--foreground\` so our body text can never drift from the surrounding UI. */
.dark .fam-root {
  --fam-fg: var(--foreground, #e7e9ec);
  --fam-muted: #b6bcc4;
  --fam-faint: #8b9199;
  --fam-border: rgba(255,255,255,0.12);
  --fam-border-strong: rgba(255,255,255,0.24);
  --fam-row-hover: rgba(255,255,255,0.055);
  --fam-surface: rgba(255,255,255,0.035);
  --fam-surface-2: rgba(255,255,255,0.06);
  --fam-accent: #60a5fa;
  --fam-rw: #4ade80;   --fam-rw-bg: rgba(74,222,128,0.15);   --fam-rw-border: rgba(74,222,128,0.45);
  --fam-ro: #fbbf24;   --fam-ro-bg: rgba(251,191,36,0.15);   --fam-ro-border: rgba(251,191,36,0.45);
  --fam-den: #94a3b8;  --fam-den-bg: rgba(148,163,184,0.14); --fam-den-border: rgba(148,163,184,0.4);
  --fam-danger: #f87171; --fam-danger-bg: rgba(248,113,113,0.12); --fam-danger-border: rgba(248,113,113,0.4);
  --fam-ok: #4ade80;   --fam-ok-bg: rgba(74,222,128,0.15);
}

.fam-root * { box-sizing: border-box; }
/* The padded page body. Separate from .fam-root because a container query
   cannot match against its own container element. */
.fam-page { padding: var(--fam-pad); max-width: 900px; }
.fam-h1 { font-size: 18px; font-weight: 650; margin: 0 0 2px; letter-spacing: -0.01em; }
.fam-h2 { font-size: 14px; font-weight: 620; margin: 0 0 6px; }
.fam-sub { color: var(--fam-muted); margin: 0 0 14px; max-width: 62ch; }
.fam-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.fam-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.86em; padding: 1px 5px; border-radius: 4px;
  background: var(--fam-surface-2); word-break: break-word;
}

/* --- disclosure ("How this works") --- */
.fam-disclosure { margin: 0 0 12px; }
.fam-disclosure-btn {
  display: inline-flex; align-items: center; gap: 6px;
  background: none; border: none; cursor: pointer; padding: 2px 0;
  color: var(--fam-muted); font: inherit; font-size: 12px;
}
.fam-disclosure-btn svg { transition: transform .18s ease; }
.fam-disclosure-btn[aria-expanded="true"] svg { transform: rotate(90deg); }
.fam-disclosure-body {
  margin-top: 8px; padding: 10px 12px; border-radius: 8px;
  background: var(--fam-surface); color: var(--fam-muted); font-size: 12.5px;
}
.fam-disclosure-body p { margin: 0 0 6px; }
.fam-disclosure-body p:last-child { margin: 0; }

/* --- legend --- */
.fam-legend {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin: 0 0 6px; font-size: 12px; color: var(--fam-muted);
}
.fam-legend .fam-legend-label { margin-right: 2px; }

/* --- permission pill (the stateful cycle button) --- */
.fam-perm {
  display: inline-flex; align-items: center; gap: 5px;
  min-width: 62px; height: 26px; padding: 0 9px;
  border-radius: 7px; border: 1px solid var(--fam-den-border);
  background: var(--fam-den-bg); color: var(--fam-den);
  font: inherit; font-size: 11.5px; font-weight: 650; letter-spacing: 0.02em;
  cursor: pointer; user-select: none;
  transition: transform .08s ease, background .14s ease, border-color .14s ease, box-shadow .14s ease;
}
.fam-perm svg { width: 14px; height: 14px; flex: none; }
.fam-perm:active { transform: scale(0.95); }
.fam-perm:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--fam-accent); }
.fam-perm--ro  { border-color: var(--fam-ro-border);  background: var(--fam-ro-bg);  color: var(--fam-ro); }
.fam-perm--rw  { border-color: var(--fam-rw-border);  background: var(--fam-rw-bg);  color: var(--fam-rw); }
.fam-perm--denied { border-color: var(--fam-den-border); background: var(--fam-den-bg); color: var(--fam-den); }
.fam-perm--inherited { border-style: dashed; opacity: 0.72; font-weight: 550; }
.fam-perm--legend { cursor: default; min-width: 0; height: 22px; padding: 0 7px; }

/* --- tree --- */
.fam-tree {
  border: 1px solid var(--fam-border); border-radius: 10px;
  max-height: min(58vh, 520px); overflow-y: auto; overflow-x: hidden;
  background: var(--fam-surface);
  /* Touch: don't chain the scroll to the host page when the tree hits its end,
     and keep momentum scrolling on iOS. */
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}
.fam-root-group { border-top: 1px solid var(--fam-border); }
.fam-root-group:first-child { border-top: none; }

/* Depth indentation is a custom property (--fam-depth, set per row in JSX)
   times a token (--fam-indent) so narrow containers can shrink the step
   without JS knowing anything about the container width. */
.fam-row {
  display: flex; align-items: center; gap: 4px;
  padding: 3px 10px; position: relative;
  padding-left: calc(6px + var(--fam-depth, 0) * var(--fam-indent));
  border-radius: 6px; margin: 1px 4px;
  transition: background .12s ease;
}
.fam-row:focus-within { background: var(--fam-row-hover); }
.fam-row--configured::before {
  content: ""; position: absolute; left: 0; top: 4px; bottom: 4px;
  width: 3px; border-radius: 2px; background: var(--fam-accent-bar, var(--fam-den));
}
.fam-row--rw  { --fam-accent-bar: var(--fam-rw); }
.fam-row--ro  { --fam-accent-bar: var(--fam-ro); }
.fam-row--denied { --fam-accent-bar: var(--fam-den); }

.fam-caret {
  width: 24px; height: 24px; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  border: none; background: none; border-radius: 6px; cursor: pointer;
  color: var(--fam-muted); padding: 0;
  transition: background .12s ease, color .12s ease;
}
.fam-caret:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--fam-accent); }
.fam-caret svg { transition: transform .16s ease; }
.fam-caret--open svg { transform: rotate(90deg); }
.fam-caret--leaf { cursor: default; }
.fam-dot { width: 4px; height: 4px; border-radius: 50%; background: var(--fam-faint); }

.fam-name {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  flex: 0 1 auto; min-width: 0;
}
.fam-name--dir { font-weight: 600; }
.fam-name--root { font-weight: 650; font-size: 13px; }
.fam-spacer { flex: 1 1 auto; min-width: 8px; }

/* Truncates rather than squeezing the filename out of the row on narrow
   containers — both it and .fam-name are shrinkable flex items. */
.fam-inherit-tag {
  display: inline-flex; align-items: center; gap: 3px;
  font-size: 11px; color: var(--fam-faint); white-space: nowrap;
  flex: 0 1 auto; min-width: 0; max-width: 45%;
  overflow: hidden; text-overflow: ellipsis;
}
/* Visible by default: on touch there is no hover to reveal it with, so the
   only way to clear an explicit rule would otherwise be unreachable. The
   hover-to-reveal behaviour is re-applied for fine pointers further down. */
.fam-revert {
  width: 22px; height: 22px; flex: none; border-radius: 6px;
  display: inline-flex; align-items: center; justify-content: center;
  border: none; background: none; cursor: pointer; color: var(--fam-faint);
  opacity: 1; transition: opacity .12s ease, background .12s ease, color .12s ease;
}
.fam-revert:focus-visible { opacity: 1; outline: none; box-shadow: 0 0 0 2px var(--fam-accent); }

.fam-iconbtn {
  width: 24px; height: 24px; flex: none; border-radius: 6px;
  display: inline-flex; align-items: center; justify-content: center;
  border: none; background: none; cursor: pointer; color: var(--fam-faint);
  transition: background .12s ease, color .12s ease;
}
.fam-iconbtn:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--fam-accent); }

.fam-treemsg {
  padding: 4px 12px; color: var(--fam-faint); font-size: 12px; font-style: italic;
  padding-left: calc(6px + var(--fam-depth, 0) * var(--fam-indent) + 24px);
}
.fam-treemsg--err { color: var(--fam-danger); font-style: normal; }

/* --- add-root --- */
.fam-addroot { display: flex; gap: 8px; margin: 12px 0 0; }
.fam-input {
  flex: 1 1 auto; min-width: 180px; height: 34px; padding: 0 11px;
  border: 1px solid var(--fam-border-strong); border-radius: 8px;
  background: transparent; color: var(--fam-fg); font: inherit; font-size: 12.5px;
  transition: border-color .14s ease, box-shadow .14s ease;
}
.fam-input::placeholder { color: var(--fam-faint); }
.fam-input:focus { outline: none; border-color: var(--fam-accent); box-shadow: 0 0 0 3px rgba(37,99,235,0.15); }

/* --- buttons --- */
.fam-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  height: 34px; padding: 0 15px; border-radius: 8px;
  border: 1px solid var(--fam-border-strong); background: transparent;
  color: var(--fam-fg); font: inherit; font-size: 13px; font-weight: 550;
  cursor: pointer;
  transition: background .14s ease, border-color .14s ease, transform .08s ease, opacity .14s ease;
}
.fam-btn:active:not(:disabled) { transform: scale(0.98); }
.fam-btn:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(37,99,235,0.35); }
.fam-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.fam-btn--primary {
  border-color: transparent; background: var(--fam-accent); color: #fff; font-weight: 600;
  box-shadow: 0 1px 2px rgba(0,0,0,0.12);
}
.fam-btn--ghost { border-color: transparent; color: var(--fam-muted); }
/* Truncated away on narrow containers — the profile list can be long enough to
   blow out the primary button on its own. */
.fam-btn-targets { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* --- action bar (full-bleed footer; bleeds by exactly the page padding) --- */
.fam-actionbar {
  display: flex; align-items: center; gap: 10px;
  margin: 16px calc(-1 * var(--fam-pad)) calc(-1 * var(--fam-pad));
  padding: 14px var(--fam-pad);
  border-top: 1px solid var(--fam-border);
  background: var(--fam-surface);
}
.fam-dirty-dot {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--fam-muted); margin-right: auto;
}
.fam-actionbar-gap { margin-right: auto; }
.fam-dirty-dot::before {
  content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--fam-accent);
}

/* --- preview + alerts --- */
.fam-panel { margin: 14px 0 0; }
.fam-chip {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11px; font-weight: 600; padding: 1px 8px; border-radius: 20px;
  background: var(--fam-surface-2); color: var(--fam-muted);
}
.fam-preview {
  margin-top: 6px; padding: 10px 12px; border-radius: 8px;
  background: var(--fam-surface); border: 1px solid var(--fam-border);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px;
  white-space: pre-wrap; word-break: break-all; color: var(--fam-muted);
}
.fam-alert {
  display: flex; gap: 9px; align-items: flex-start;
  margin: 10px 0 0; padding: 10px 12px; border-radius: 8px;
  border: 1px solid var(--fam-danger-border); background: var(--fam-danger-bg);
  font-size: 12.5px; line-height: 1.5;
}
.fam-alert svg { flex: none; margin-top: 1px; color: var(--fam-danger); }

/* --- apply report --- */
.fam-report {
  margin: 12px 0 0; padding: 11px 13px; border-radius: 9px;
  border: 1px solid var(--fam-border); background: var(--fam-surface);
  animation: fam-fade .22s ease;
}
@keyframes fam-fade { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
.fam-report-head { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
.fam-state {
  font-size: 10.5px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
  padding: 2px 8px; border-radius: 5px;
}
.fam-state--ok { background: var(--fam-ok-bg); color: var(--fam-ok); }
.fam-state--bad { background: var(--fam-danger-bg); color: var(--fam-danger); }
.fam-step { display: flex; align-items: baseline; gap: 8px; font-size: 12.5px; padding: 2px 0; flex-wrap: wrap; }
.fam-step-icon { width: 15px; flex: none; text-align: center; }
.fam-step-detail { color: var(--fam-muted); font-size: 12px; }

/* --- profile picker --- */
.fam-profiles { display: flex; flex-direction: column; gap: 6px; margin: 4px 0 12px; }
.fam-profile {
  display: flex; align-items: center; gap: 10px; padding: 9px 12px;
  border: 1px solid var(--fam-border); border-radius: 9px; cursor: pointer;
  transition: border-color .14s ease, background .14s ease;
}
.fam-profile--on { border-color: var(--fam-accent); background: rgba(37,99,235,0.06); }
.fam-profile input { width: 16px; height: 16px; accent-color: var(--fam-accent); flex: none; }
.fam-profile-home { opacity: 0.7; }
.fam-badge {
  font-size: 10px; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase;
  padding: 2px 7px; border-radius: 5px;
}
.fam-badge--main { background: var(--fam-danger-bg); color: var(--fam-danger); }
.fam-badge--spec { background: var(--fam-ok-bg); color: var(--fam-ok); }
.fam-badge--iso { background: var(--fam-rw-bg); color: var(--fam-rw); border: 1px solid var(--fam-rw-border); }
.fam-badge--noiso { background: var(--fam-ro-bg); color: var(--fam-ro); border: 1px solid var(--fam-ro-border); }

/* --- agent picker (plugin page route) ---
   Horizontal scroller on narrow containers, wrapping row when there is room.
   Chips are anchors: each one is a real URL, so back/forward and copy-link work. */
.fam-picker {
  display: flex; gap: 6px; margin: 4px 0 14px;
  overflow-x: auto; padding-bottom: 4px;
  scrollbar-width: thin;
}
.fam-pick {
  display: flex; flex-direction: column; gap: 1px; flex: none;
  padding: 7px 12px; border-radius: 9px; text-decoration: none;
  border: 1px solid var(--fam-border); background: var(--fam-surface);
  color: inherit; transition: border-color .14s ease, background .14s ease;
}
.fam-pick:hover { border-color: var(--fam-accent); }
.fam-pick--on { border-color: var(--fam-accent); background: rgba(37,99,235,0.06); }
.fam-pick-name { font-size: 13px; font-weight: 600; white-space: nowrap; }
.fam-pick-detail { font-size: 11px; color: var(--fam-muted); white-space: nowrap; }
@container (min-width: 640px) {
  .fam-picker { flex-wrap: wrap; overflow-x: visible; }
}

/* --- inline note (backend switch hint) --- */
.fam-note {
  margin: 10px 0 0; padding: 8px 11px; border-radius: 8px;
  background: var(--fam-surface); border: 1px solid var(--fam-border);
  color: var(--fam-muted); font-size: 12px; line-height: 1.5;
}

/* --- spinner --- */
.fam-spinner {
  width: 14px; height: 14px; flex: none; border-radius: 50%;
  border: 2px solid currentColor; border-top-color: transparent;
  animation: fam-spin .6s linear infinite;
}
@keyframes fam-spin { to { transform: rotate(360deg); } }

/* ===========================================================================
   AXIS 1 — INPUT MODALITY
   =========================================================================== */

/* Hover states only where hover exists. On touch, :hover latches after a tap
   and leaves rows/buttons looking permanently focused. */
@media (hover: hover) and (pointer: fine) {
  .fam-disclosure-btn:hover { color: var(--fam-fg); }
  .fam-perm:hover { border-color: var(--fam-border-strong); filter: brightness(1.03); }
  .fam-perm--legend:hover { filter: none; }
  .fam-row:hover { background: var(--fam-row-hover); }
  .fam-caret:hover { background: var(--fam-surface-2); color: var(--fam-fg); }
  .fam-caret--leaf:hover { background: none; }
  .fam-revert { opacity: 0; }
  .fam-row:hover .fam-revert, .fam-row:focus-within .fam-revert { opacity: 1; }
  .fam-revert:hover { background: var(--fam-surface-2); color: var(--fam-fg); }
  .fam-iconbtn:hover { background: var(--fam-danger-bg); color: var(--fam-danger); }
  .fam-btn:hover:not(:disabled) { background: var(--fam-surface-2); }
  .fam-btn--primary:hover:not(:disabled) { background: var(--fam-accent); filter: brightness(1.08); }
  .fam-btn--ghost:hover:not(:disabled) { background: var(--fam-surface-2); color: var(--fam-fg); }
  .fam-btn--danger:hover:not(:disabled) { border-color: var(--fam-danger-border); color: var(--fam-danger); background: var(--fam-danger-bg); }
  .fam-profile:hover { border-color: var(--fam-border-strong); background: var(--fam-row-hover); }
}

/* Touch-sized targets. The desktop-dense 22-26px controls are well under the
   44px minimum a finger needs; a mis-tap here changes a filesystem permission
   or drops a root, so the extra row height is worth it. */
@media (pointer: coarse) {
  .fam-caret { width: 38px; height: 38px; }
  .fam-revert, .fam-iconbtn { width: 36px; height: 36px; }
  .fam-perm { height: 36px; min-width: 72px; font-size: 12.5px; }
  .fam-perm--legend { height: 24px; min-width: 0; }
  .fam-row { padding-top: 4px; padding-bottom: 4px; }
  .fam-btn { height: 44px; padding: 0 16px; }
  /* 16px is the threshold below which iOS Safari auto-zooms on focus. */
  .fam-input { height: 44px; font-size: 16px; }
  .fam-profile { padding: 12px; }
  .fam-profile input { width: 20px; height: 20px; }
  .fam-disclosure-btn { padding: 8px 0; }
}

/* ===========================================================================
   AXIS 2 — AVAILABLE SPACE (container, not viewport)
   =========================================================================== */

@container fam (max-width: 640px) {
  .fam-page { --fam-pad: 12px; --fam-indent: 10px; }
  .fam-h1 { font-size: 17px; }
  .fam-sub { margin-bottom: 12px; }
  .fam-tree { border-radius: 8px; max-height: max(240px, 52vh); }
  .fam-inherit-tag { max-width: 38%; }

  /* Input over button rather than beside it — 180px min-width + a button does
     not fit, and the input would collapse to unusable. */
  .fam-addroot { flex-direction: column; }
  .fam-addroot .fam-btn { width: 100%; }

  /* Stack: status line, then the primary action full-width, then secondaries. */
  .fam-actionbar { flex-wrap: wrap; row-gap: 10px; }
  .fam-actionbar-gap { display: none; }
  .fam-dirty-dot { order: 1; flex: 1 0 100%; margin-right: 0; }
  /* Generic rule first: the primary button matches both selectors, so the
     override has to come last to win at equal specificity. */
  .fam-actionbar .fam-btn { order: 3; flex: 1 1 auto; }
  .fam-actionbar .fam-btn--primary { order: 2; flex: 1 0 100%; }
  .fam-btn-targets { display: none; }

  /* Profile rows wrap, with the (long) Hermes home path on its own line. */
  .fam-profile { flex-wrap: wrap; row-gap: 6px; }
  .fam-profile .fam-spacer { display: none; }
  .fam-profile-home { flex: 1 0 100%; word-break: break-all; }

  .fam-step-detail { flex: 1 0 100%; padding-left: 23px; }
  .fam-preview { max-height: 40vh; overflow: auto; }
}
`;

/**
 * Renders the stylesheet. Must return the element on EVERY render — a guard that
 * returns null on re-render makes React unmount the <style> node on the first
 * state change, stripping all styling. Duplicate identical <style> tags (if two
 * entry components ever mount at once) are harmless.
 */
function FamStyles() {
  return <style dangerouslySetInnerHTML={{ __html: STYLE }} />;
}

/**
 * Every entry point renders through this: `.fam-root` is the query container
 * (it must stay unpadded — a container query can't match its own container),
 * `.fam-page` carries the padding and max-width.
 */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="fam-root">
      <FamStyles />
      <div className="fam-page">{children}</div>
    </div>
  );
}

/** Tree indentation travels as a CSS variable so the step size is a token. */
function depthVar(depth: number): React.CSSProperties {
  return { "--fam-depth": depth } as React.CSSProperties;
}

// ---------------------------------------------------------------------------
// Icons (inline SVG, 16px, stroke = currentColor)
// ---------------------------------------------------------------------------

type IconProps = { size?: number };
const svg = (size: number, children: React.ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);
const IconEye = ({ size = 14 }: IconProps) =>
  svg(size, <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>);
const IconPencil = ({ size = 14 }: IconProps) =>
  svg(size, <><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></>);
const IconBan = ({ size = 14 }: IconProps) =>
  svg(size, <><circle cx="12" cy="12" r="9" /><path d="M5.6 5.6l12.8 12.8" /></>);
const IconChevron = ({ size = 16 }: IconProps) => svg(size, <path d="M9 6l6 6-6 6" />);
const IconRevert = ({ size = 14 }: IconProps) =>
  svg(size, <><path d="M3 3v6h6" /><path d="M3.5 9a9 9 0 1 1-1.5 5" /></>);
const IconClose = ({ size = 14 }: IconProps) => svg(size, <><path d="M6 6l12 12" /><path d="M18 6 6 18" /></>);
const IconWarn = ({ size = 16 }: IconProps) =>
  svg(size, <><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></>);
const IconFolderLock = ({ size = 16 }: IconProps) =>
  svg(size, <><path d="M3 8V6a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.7.9L11.6 6H19a2 2 0 0 1 2 2v1" /><rect x="10" y="13" width="11" height="7" rx="1.5" /><path d="M13.5 13v-1.8a2.5 2.5 0 0 1 5 0V13" /><path d="M7 20H5a2 2 0 0 1-2-2v-6" /></>);

function ModeIcon({ mode }: { mode: Mode }) {
  if (mode === "rw") return <IconPencil />;
  if (mode === "ro") return <IconEye />;
  return <IconBan />;
}

function shortSource(source: string, homeDir: string): string {
  if (source === homeDir) return "~";
  if (source.startsWith(homeDir + "/")) return "~/" + source.slice(homeDir.length + 1);
  return source;
}

function hasExplicit(path: string, assignments: Assignment[]): boolean {
  return assignments.some((a) => a.path === path);
}

// ---------------------------------------------------------------------------
// Permission toggle — the single stateful cycle button (R → RW → D)
// ---------------------------------------------------------------------------

function PermissionToggle({
  path,
  assignments,
  homeDir,
  onSet,
}: {
  path: string;
  assignments: Assignment[];
  homeDir: string;
  onSet: (mode: Mode) => void;
}) {
  const eff = useMemo(() => resolveEffectiveMode(path, assignments), [path, assignments]);
  const meta = MODE_META[eff.mode];
  const cls = [
    "fam-perm",
    `fam-perm--${eff.mode}`,
    eff.inherited ? "fam-perm--inherited" : "",
  ].join(" ");
  const title = eff.inherited
    ? `Inherited (${meta.label}). Click to set an explicit permission.`
    : `${meta.label}. Click to cycle: R → RW → D.`;
  return (
    <button type="button" className={cls} onClick={() => onSet(nextMode(eff.mode))} title={title}>
      <ModeIcon mode={eff.mode} />
      <span>{meta.short}</span>
    </button>
  );
}

/** Compact legend replacing the paragraph that explained the modes. */
function Legend() {
  return (
    <div className="fam-legend">
      <span className="fam-legend-label">Click to cycle:</span>
      <span className="fam-perm fam-perm--ro fam-perm--legend"><IconEye /> R</span>
      <span className="fam-mono" style={{ color: "var(--fam-faint)" }}>→</span>
      <span className="fam-perm fam-perm--rw fam-perm--legend"><IconPencil /> RW</span>
      <span className="fam-mono" style={{ color: "var(--fam-faint)" }}>→</span>
      <span className="fam-perm fam-perm--denied fam-perm--legend"><IconBan /> D</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Apply progress / report
// ---------------------------------------------------------------------------

const APPLY_PHASES = ["Write profile config", "Check Docker access", "Recreate Docker container", "Restart Hermes gateway"];
const STEP_ICON: Record<string, string> = { ok: "✓", skipped: "–", failed: "✕", running: "" };

function ApplyProgress() {
  return (
    <div className="fam-report">
      <div className="fam-report-head">
        <span className="fam-spinner" style={{ color: "var(--fam-accent)" }} />
        <strong>Applying changes…</strong>
      </div>
      {APPLY_PHASES.map((label) => (
        <div key={label} className="fam-step" style={{ opacity: 0.7 }}>
          <span className="fam-step-icon"><span className="fam-spinner" style={{ width: 11, height: 11, color: "var(--fam-muted)" }} /></span>
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}

function ApplyReport({ results }: { results: ProfileApplyResult[] }) {
  return (
    <>
      {results.map((r) => {
        const ready = r.state === "ready";
        return (
          <div key={r.profile} className="fam-report">
            <div className="fam-report-head">
              <strong className="fam-mono">{r.profile}</strong>
              <span className={`fam-state ${ready ? "fam-state--ok" : "fam-state--bad"}`}>
                {ready ? "ready" : "needs attention"}
              </span>
            </div>
            {r.steps.map((s) => (
              <div key={s.key} className="fam-step">
                <span className="fam-step-icon" style={{
                  color: s.status === "failed" ? "var(--fam-danger)"
                    : s.status === "ok" ? "var(--fam-ok)" : "var(--fam-muted)",
                }}>{STEP_ICON[s.status] ?? "•"}</span>
                <span>{s.label}</span>
                <span className="fam-step-detail">— {s.detail}</span>
              </div>
            ))}
          </div>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

interface NodeShared {
  roots: string[];
  assignments: Assignment[];
  homeDir: string;
  expanded: Set<string>;
  toggle: (path: string) => void;
  onSet: (path: string, mode: Mode) => void;
  onClear: (path: string) => void;
}

/** One tree row plus, when expanded, its lazily-loaded children. */
function TreeNode(props: NodeShared & { entry: TreeEntry; depth: number }) {
  const { entry, depth, expanded, toggle, assignments, homeDir } = props;
  const isOpen = expanded.has(entry.path);
  const eff = resolveEffectiveMode(entry.path, assignments);
  const explicit = hasExplicit(entry.path, assignments);
  const rowCls = [
    "fam-row",
    explicit ? "fam-row--configured" : "",
    explicit ? `fam-row--${eff.mode}` : "",
  ].join(" ");

  return (
    <div>
      <div className={rowCls} style={depthVar(depth)}>
        {entry.isDir ? (
          <button
            type="button"
            className={`fam-caret${isOpen ? " fam-caret--open" : ""}`}
            onClick={() => toggle(entry.path)}
            aria-expanded={isOpen}
            aria-label={`${isOpen ? "Collapse" : "Expand"} ${entry.name}`}
            title={isOpen ? "Collapse" : "Expand"}
          >
            <IconChevron />
          </button>
        ) : (
          <span className="fam-caret fam-caret--leaf"><span className="fam-dot" /></span>
        )}
        <span className={`fam-name ${entry.isDir ? "fam-name--dir" : ""}`}>
          {entry.name}{entry.isDir ? "/" : ""}
        </span>
        <span className="fam-spacer" />
        {eff.inherited && eff.source && (
          <span className="fam-inherit-tag" title={`Inherited from ${shortSource(eff.source, homeDir)}`}>
            ↳ {shortSource(eff.source, homeDir)}
          </span>
        )}
        {explicit && (
          <button
            type="button"
            className="fam-revert"
            onClick={() => props.onClear(entry.path)}
            aria-label={`Clear the explicit permission on ${entry.name}`}
            title="Clear this explicit setting — inherit from the parent"
          >
            <IconRevert />
          </button>
        )}
        <PermissionToggle
          path={entry.path}
          assignments={assignments}
          homeDir={homeDir}
          onSet={(m) => props.onSet(entry.path, m)}
        />
      </div>
      {entry.isDir && isOpen && <ChildList {...props} parentPath={entry.path} />}
    </div>
  );
}

/** Lazily fetches and renders the children of an expanded directory. */
function ChildList(props: NodeShared & { parentPath: string; depth: number }) {
  const { data, loading, error } = usePluginData<{ path: string; entries: TreeEntry[] }>(
    "list-dir",
    { path: props.parentPath, roots: props.roots },
  );
  const indent = depthVar(props.depth + 1);
  if (loading)
    return <div className="fam-treemsg" style={indent}><span className="fam-spinner" style={{ display: "inline-block", width: 11, height: 11, color: "var(--fam-faint)", verticalAlign: "-1px", marginRight: 6 }} />Loading…</div>;
  if (error) return <div className="fam-treemsg fam-treemsg--err" style={indent}>{error.message}</div>;
  if (!data || data.entries.length === 0) return <div className="fam-treemsg" style={indent}>empty</div>;
  return (
    <>
      {data.entries.map((child) => (
        <TreeNode key={child.path} {...props} entry={child} depth={props.depth + 1} />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Access editor
// ---------------------------------------------------------------------------

function AccessEditor({
  primary,
  targets,
  targetLabels,
}: {
  primary: string;
  targets: string[];
  targetLabels: string[];
}) {
  const { data, loading, error, refresh } = usePluginData<ProfileAccessResponse>(
    "profile-access",
    { profile: primary },
  );
  const save = usePluginAction("set-profile-access");

  const [draft, setDraft] = useState<Assignment[] | null>(null);
  const [draftRoots, setDraftRoots] = useState<string[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [newRoot, setNewRoot] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [applyReport, setApplyReport] = useState<ProfileApplyResult[] | null>(null);

  if (loading) return <p className="fam-sub">Loading access…</p>;
  if (error) return <p className="fam-alert"><IconWarn />{error.message}</p>;
  if (!data) return null;

  const assignments = draft ?? data.assignments;
  const roots = draftRoots ?? data.roots;
  const dirty = draft !== null || draftRoots !== null;

  const setMode = (path: string, mode: Mode) =>
    setDraft([...assignments.filter((a) => a.path !== path), { path, mode }]);
  const clearMode = (path: string) => setDraft(assignments.filter((a) => a.path !== path));
  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  const addRoot = () => {
    const value = newRoot.trim();
    if (value && !roots.includes(value)) setDraftRoots([...roots, value]);
    setNewRoot("");
  };
  const removeRoot = (r: string) => setDraftRoots(roots.filter((x) => x !== r));
  const discard = () => { setDraft(null); setDraftRoots(null); };
  // Reset clears every explicit rule (all paths revert to the secure default),
  // staged as a draft so Discard still restores the last-saved state.
  const resetAll = () => setDraft([]);

  const isolated = data.backend === "docker";
  const preview = generateDockerVolumes(assignments, { maskDir: data.maskDir });
  const grantCount = assignments.filter((a) => a.mode === "rw" || a.mode === "ro").length;
  const explicitCount = assignments.length;
  const homeGranted = assignments.some(
    (a) => (a.mode === "rw" || a.mode === "ro") && a.path === data.homeDir,
  );

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    setApplyReport(null);
    try {
      const res = (await save({ profiles: targets, roots, assignments })) as SetProfileAccessResponse;
      setApplyReport(res?.profiles ?? null);
      setDraft(null);
      setDraftRoots(null);
      refresh();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const shared: NodeShared = {
    roots, assignments, homeDir: data.homeDir, expanded, toggle, onSet: setMode, onClear: clearMode,
  };

  return (
    <div>
      <Legend />
      <div className="fam-tree">
        {roots.map((root) => {
          const eff = resolveEffectiveMode(root, assignments);
          const explicit = hasExplicit(root, assignments);
          const isOpen = expanded.has(root);
          const rowCls = ["fam-row", explicit ? "fam-row--configured" : "", explicit ? `fam-row--${eff.mode}` : ""].join(" ");
          return (
            <div key={root} className="fam-root-group">
              <div className={rowCls} style={depthVar(0)}>
                <button
                  type="button"
                  className={`fam-caret${isOpen ? " fam-caret--open" : ""}`}
                  onClick={() => toggle(root)}
                  aria-expanded={isOpen}
                  aria-label={`${isOpen ? "Collapse" : "Expand"} ${root}`}
                  title={isOpen ? "Collapse" : "Expand"}
                >
                  <IconChevron />
                </button>
                <span className="fam-name fam-name--root">{root}</span>
                <button type="button" className="fam-iconbtn" onClick={() => removeRoot(root)}
                  aria-label={`Remove the root ${root} from the tree`}
                  title="Remove this root from the tree (does not change permissions)">
                  <IconClose />
                </button>
                <span className="fam-spacer" />
                {explicit && (
                  <button type="button" className="fam-revert" onClick={() => clearMode(root)}
                    aria-label={`Clear the explicit permission on ${root}`}
                    title="Clear this explicit setting — inherit from the parent">
                    <IconRevert />
                  </button>
                )}
                <PermissionToggle path={root} assignments={assignments} homeDir={data.homeDir}
                  onSet={(m) => setMode(root, m)} />
              </div>
              {isOpen && <ChildList {...shared} parentPath={root} depth={0} />}
            </div>
          );
        })}
      </div>

      <div className="fam-addroot">
        <input
          className="fam-input"
          placeholder="/absolute/path or ~/path — add another root"
          value={newRoot}
          onChange={(e) => setNewRoot(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addRoot()}
        />
        <button type="button" className="fam-btn" onClick={addRoot} disabled={newRoot.trim().length === 0}>
          Add root
        </button>
      </div>

      <div className="fam-panel">
        <span className="fam-chip">Docker mounts · {preview.length}</span>
        <div className="fam-preview">
          {preview.length === 0 ? "(nothing mounted — all paths denied)" : preview.join("\n")}
        </div>
      </div>

      {homeGranted && (
        <div className="fam-alert">
          <IconWarn />
          <span>
            You are granting your <strong>whole home directory</strong> — the container will see
            everything under it, including secrets (<code className="fam-code">.ssh</code>,{" "}
            <code className="fam-code">.gnupg</code>, tokens, <code className="fam-code">.env</code>).
            Set sensitive subfolders to <strong>Denied</strong> to mask them, or grant specific
            subdirectories instead.
          </span>
        </div>
      )}
      {grantCount === 0 && (
        <div className="fam-alert" style={{ borderColor: "var(--fam-border-strong)", background: "var(--fam-surface)" }}>
          <IconWarn />
          <span>
            Nothing is granted R/W or Read Only. With no path mounted, agents on{" "}
            {targetLabels.length > 1 ? "these profiles" : "this profile"} can't reach the host
            filesystem — terminal, read_file, write_file, and execute_code run inside an empty
            container. Grant at least the paths the agent needs.
          </span>
        </div>
      )}

      {!isolated && (
        <div className="fam-note">
          {targetLabels.length > 1 ? "These profiles are" : "This profile is"} not sandboxed yet
          (backend <code className="fam-code">{data.backend ?? "default"}</code>). Saving switches{" "}
          {targetLabels.length > 1 ? "them" : "it"} to Hermes' Docker terminal backend so the mounts
          take effect. Docker or Podman must be reachable by the gateway — see the apply report below.
        </div>
      )}

      {!saving && applyReport && <ApplyReport results={applyReport} />}
      {saving && <ApplyProgress />}
      {saveError && <div className="fam-alert"><IconWarn />{saveError}</div>}

      <div className="fam-actionbar">
        {dirty && (
          <span className="fam-dirty-dot">
            {explicitCount} explicit {explicitCount === 1 ? "rule" : "rules"} · unsaved
          </span>
        )}
        {!dirty && <span className="fam-actionbar-gap" />}
        <button type="button" className="fam-btn fam-btn--ghost fam-btn--danger"
          onClick={resetAll} disabled={saving || explicitCount === 0}
          title="Clear every explicit rule (revert all paths to the secure default)">
          Reset
        </button>
        <button type="button" className="fam-btn" onClick={discard} disabled={saving || !dirty}>
          Discard
        </button>
        <button type="button" className="fam-btn fam-btn--primary" onClick={handleSave} disabled={!dirty || saving}>
          {saving && <span className="fam-spinner" />}
          <span>{saving ? "Applying…" : isolated ? "Save & apply" : "Enable Docker isolation"}</span>
          {/* Dropped on narrow containers — the joined profile list can be
              arbitrarily long and would otherwise blow out the button. */}
          {!saving && <span className="fam-btn-targets">· {targetLabels.join(", ")}</span>}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function ProfileBadge({ isMain }: { isMain: boolean }) {
  return (
    <span className={`fam-badge ${isMain ? "fam-badge--main" : "fam-badge--spec"}`}>
      {isMain ? "router / default" : "specialized"}
    </span>
  );
}

/** Shows whether a profile currently runs the Docker (isolated) backend. */
function BackendBadge({ backend }: { backend: string | null }) {
  const isolated = backend === "docker";
  return (
    <span
      className={`fam-badge ${isolated ? "fam-badge--iso" : "fam-badge--noiso"}`}
      title={
        isolated
          ? "Runs the Docker terminal backend — file access is sandboxed."
          : `Runs the ${backend ?? "default"} backend — not sandboxed. Saving switches it to Docker isolation.`
      }
    >
      {isolated ? "Docker · isolated" : "not isolated"}
    </span>
  );
}

/** How-it-works, collapsed by default (progressive disclosure). */
function HowItWorks() {
  const [open, setOpen] = useState(false);
  return (
    <div className="fam-disclosure">
      <button type="button" className="fam-disclosure-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <IconChevron size={13} /> How access works
      </button>
      {open && (
        <div className="fam-disclosure-body">
          <p>
            Access is enforced by <strong>Docker bind mounts</strong> per Hermes profile —
            each path is Read/Write, Read Only, or not mounted at all.
          </p>
          <p>
            Every path is <strong>Denied</strong> unless you grant it. Setting a folder applies
            to everything inside; set a child differently to override. A <span className="fam-mono">↳</span>{" "}
            tag means the row inherits from an ancestor — the toggle looks dashed. Changes only
            touch the profiles you select; each profile is an independent Hermes home.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Profile-oriented editor body, without a Shell or page heading. Shared by the
 * company settings page and the plugin page route's unscoped view.
 */
function ProfilePicker() {
  const { data, loading, error } = usePluginData<ProfilesResponse>("hermes-profiles", {});
  const [selected, setSelected] = useState<Set<string>>(new Set());

  if (loading) return <p className="fam-sub">Discovering Hermes profiles…</p>;
  if (error) return <div className="fam-alert"><IconWarn />{error.message}</div>;

  const profiles: ProfileSummary[] = data?.profiles ?? [];
  const targets = profiles.filter((p) => selected.has(p.name));
  const primary = targets[0]?.name ?? null;
  const mainSelected = targets.some((p) => p.isMain);

  const toggle = (name: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });

  return (
    <>
      <HowItWorks />

      {profiles.length === 0 ? (
        <p className="fam-sub">
          No Hermes profiles found under <code className="fam-code">~/.hermes</code>.
        </p>
      ) : (
        <>
          <h3 className="fam-h2">Profiles to configure</h3>
          <div className="fam-profiles">
            {profiles.map((p) => (
              <label key={p.name} className={`fam-profile${selected.has(p.name) ? " fam-profile--on" : ""}`}>
                <input type="checkbox" checked={selected.has(p.name)} onChange={() => toggle(p.name)} />
                <span className="fam-name" style={{ fontWeight: 600 }}>{p.name}</span>
                <ProfileBadge isMain={p.isMain} />
                <BackendBadge backend={p.backend} />
                <span className="fam-spacer" />
                <code className="fam-code fam-profile-home">{p.hermesHome}</code>
              </label>
            ))}
          </div>
        </>
      )}

      {mainSelected && (
        <div className="fam-alert">
          <IconWarn />
          <span>
            You selected the <strong>router / default</strong> profile. Saving switches the main
            Hermes profile to the Docker terminal backend — it affects every agent on the default
            profile. Only do this intentionally.
          </span>
        </div>
      )}

      {primary && targets.length > 0 && (
        <AccessEditor
          key={targets.map((t) => t.name).join(",")}
          primary={primary}
          targets={targets.map((t) => t.name)}
          targetLabels={targets.map((t) => t.name)}
        />
      )}
    </>
  );
}

export function FileAccessPage() {
  return (
    <Shell>
      <h2 className="fam-h1">File Access Manager</h2>
      <p className="fam-sub">OS-level filesystem isolation for each Hermes profile.</p>
      <ProfilePicker />
    </Shell>
  );
}

/**
 * Single-agent editor body, without a Shell. Shared by the (currently inert)
 * agent detail tab and the plugin page route, so both surfaces resolve the
 * agent the same way and cannot drift apart.
 *
 * Both ids are required non-empty by the caller — `usePluginData` has no
 * `enabled` flag, so guarding has to happen before this component mounts.
 */
/**
 * Plain-English name for the adapter-config signal that decided an agent's
 * profile. Mirrors Hermes's own resolution order (see `hermes.ts`) so the UI can
 * say *why* an agent landed where it did rather than just asserting it.
 */
function profileSourceLabel(source: AgentProfileResponse["profileSource"]): string {
  switch (source) {
    case "extra-args":
      return "from -p in extraArgs";
    case "hermes-command":
      return "from -p in the hermesCommand wrapper";
    case "env":
      return "from env.HERMES_HOME";
    case "active-profile":
      return "from the active_profile file";
    default:
      return "no profile selected in the adapter config";
  }
}

function AgentAccessView({ companyId, agentId }: { companyId: string; agentId: string }) {
  const { data, loading, error } = usePluginData<AgentProfileResponse>(
    "agent-profile",
    { companyId, agentId },
  );

  if (loading) return <p className="fam-sub">Resolving agent profile…</p>;
  if (error) return <div className="fam-alert"><IconWarn />{error.message}</div>;
  if (!data) return null;

  if (!data.configurable) {
    return (
      <p className="fam-sub">
        <strong>{data.agentName}</strong> uses the <code className="fam-code">{data.adapterType}</code>{" "}
        adapter — it does not run on Hermes, so there is no Docker terminal backend to isolate here.
      </p>
    );
  }

  if (!data.profile) {
    return (
      <div className="fam-alert">
        <IconWarn />
        <span>
          <strong>{data.agentName}</strong> resolves to{" "}
          <code className="fam-code">{data.hermesHome}</code> ({profileSourceLabel(data.profileSource)}),
          which is not a profile on this host. Configure it from the company-level{" "}
          <strong>File Access</strong> page instead of guessing — this avoids writing to the
          router/default profile by accident.
        </span>
      </div>
    );
  }

  return (
    <>
      <h3 className="fam-h1" style={{ fontSize: 16 }}>
        File access — {data.agentName}{" "}
        <span style={{ fontSize: 13, color: "var(--fam-muted)", fontWeight: 400 }}>
          (profile <code className="fam-code">{data.profile}</code>)
        </span>
      </h3>
      <div style={{ height: 6 }} />
      {data.isMain && (
        <div className="fam-alert">
          <IconWarn />
          <span>
            This agent runs on the <strong>router / default</strong> profile
            {data.profileSource === "default" && " — nothing in its adapter config selects one"}.
            Changes here affect every agent on it.
          </span>
        </div>
      )}
      {data.declaredMismatch && (
        <div className="fam-alert">
          <IconWarn />
          <span>
            This agent&apos;s Paperclip config declares profile{" "}
            <code className="fam-code">{data.declaredProfile}</code>, but it actually runs on{" "}
            <code className="fam-code">{data.profile}</code> ({profileSourceLabel(data.profileSource)}).
            The Hermes adapter ignores the <code className="fam-code">profile</code> field, so the
            effective profile is the one shown here — fix the declared value to avoid confusion.
          </span>
        </div>
      )}
      <HowItWorks />
      <AccessEditor primary={data.profile} targets={[data.profile]} targetLabels={[data.profile]} />
    </>
  );
}

export function AgentFileAccessTab({ context }: PluginDetailTabProps) {
  const companyId = context.companyId ?? "";
  const agentId = context.entityId ?? "";
  if (!companyId || !agentId) {
    return <Shell><p className="fam-sub">Missing agent context.</p></Shell>;
  }
  return <Shell><AgentAccessView companyId={companyId} agentId={agentId} /></Shell>;
}

// ---------------------------------------------------------------------------
// Sidebar nav entry + plugin page route
//
// The host mounts `sidebar` slots at the bottom of the "Work" group and
// resolves `page` + `routeSidebar` as a pair keyed on a shared routePath.
// Selection travels in the URL (`?agent=<id>`) rather than component state so
// the sidebar and the content pane — which the host renders as siblings, not
// as parent and child — stay in sync, and so a view is linkable.
// ---------------------------------------------------------------------------

/** True while the host is on our plugin page route. Route shape: `../routes.ts`. */
function useOnPluginRoute(): boolean {
  const { pathname } = useHostLocation();
  return useMemo(() => isPluginRoute(pathname), [pathname]);
}

function useSelectedAgentId(): string | null {
  const { search } = useHostLocation();
  return useMemo(() => agentIdFromSearch(search), [search]);
}

export function FileAccessNavItem() {
  const nav = useHostNavigation();
  const active = useOnPluginRoute();
  return (
    <a
      {...nav.linkProps(pageHref())}
      aria-current={active ? "page" : undefined}
      className={
        "flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 pointer-coarse:py-1 transition-colors " +
        (active
          ? "bg-accent text-foreground"
          : "text-foreground/80 hover:bg-accent/50 hover:text-foreground")
      }
    >
      <IconFolderLock size={16} />
      <span className="truncate">File Access</span>
    </a>
  );
}

/**
 * One selectable agent (or the unscoped "All profiles" entry), rendered inside
 * the page rather than in a host sidebar. See the routeSidebar decision in
 * ISA.md: on mobile the host swaps the app nav out for a plugin routeSidebar
 * entirely, which costs the user their menu, so the roster lives here.
 */
function AgentChip({
  href,
  active,
  label,
  detail,
}: {
  href: string;
  active: boolean;
  label: string;
  detail: string;
}) {
  const nav = useHostNavigation();
  return (
    <a
      {...nav.linkProps(href)}
      aria-current={active ? "page" : undefined}
      className={`fam-pick${active ? " fam-pick--on" : ""}`}
    >
      <span className="fam-pick-name">{label}</span>
      <span className="fam-pick-detail">{detail}</span>
    </a>
  );
}

function AgentPicker({ companyId, selected }: { companyId: string; selected: string | null }) {
  const { data, loading, error } = usePluginData<HermesAgentsResponse>(
    "hermes-agents",
    { companyId },
  );

  const agents: HermesAgentSummary[] = data?.agents ?? [];
  const hidden = data?.hiddenNonHermes ?? 0;

  return (
    <>
      <div className="fam-picker">
        <AgentChip
          href={pageHref()}
          active={selected === null}
          label="All profiles"
          detail="configure by profile"
        />
        {loading && <p className="fam-sub">Loading agents…</p>}
        {error && <div className="fam-alert"><IconWarn />{error.message}</div>}
        {!loading && !error && agents.length === 0 && (
          <p className="fam-sub">No Hermes-backed agents in this company.</p>
        )}
        {agents.map((a) => (
          <AgentChip
            key={a.agentId}
            href={pageHref(a.agentId)}
            active={selected === a.agentId}
            label={a.agentName}
            detail={agentChipDetail(a)}
          />
        ))}
      </div>
      {!loading && !error && hidden > 0 && (
        <p className="fam-sub">
          {hidden} other {hidden === 1 ? "agent does" : "agents do"} not run on Hermes and{" "}
          {hidden === 1 ? "is" : "are"} not listed — this plugin isolates the Hermes terminal
          backend, so there is nothing to configure for them.
        </p>
      )}
      {data?.truncated && (
        <p className="fam-sub">Showing the first page of agents only.</p>
      )}
    </>
  );
}

/** Sub-label under an agent's name: which profile, and how we know. */
function agentChipDetail(a: HermesAgentSummary): string {
  if (!a.profile) return `no profile matches ${a.hermesHome}`;
  const parts = [a.profile];
  if (a.isMain) parts.push("router");
  if (a.declaredMismatch) parts.push(`declared "${a.declaredProfile}"`);
  return parts.join(" · ");
}

export function FileAccessRoutePage({ context }: PluginPageProps) {
  const companyId = context.companyId ?? "";
  const agentId = useSelectedAgentId();

  if (!companyId) {
    return <Shell><p className="fam-sub">No active company.</p></Shell>;
  }

  return (
    <Shell>
      <h2 className="fam-h1">File Access</h2>
      <p className="fam-sub">Pick an agent, or configure Hermes profiles directly.</p>
      <AgentPicker companyId={companyId} selected={agentId} />
      {agentId ? (
        <AgentAccessView companyId={companyId} agentId={agentId} />
      ) : (
        <ProfilePicker />
      )}
    </Shell>
  );
}
