/**
 * Unit tests for the pure scheduling / provider helpers in
 * `todoist_watcher.ts` — the logic that decides whether a project is active and
 * which provider a task routes to. These are the parts most likely to regress
 * silently (a window math off-by-one quietly stops or over-runs a machine).
 */

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  detectProviderOverride,
  getLocalTime,
  inPeakWindow,
} from "./todoist_watcher.ts";

const UTC = "UTC";

// A fixed UTC instant: Wednesday 2026-06-24 14:30:00Z.
const WED_1430 = new Date("2026-06-24T14:30:00Z");
// Saturday 2026-06-27 14:30:00Z.
const SAT_1430 = new Date("2026-06-27T14:30:00Z");

// --- getLocalTime -----------------------------------------------------------

Deno.test("getLocalTime reads hours/minutes/dayOfWeek in the target zone", () => {
  const t = getLocalTime(WED_1430, UTC);
  assertEquals(t.hours, 14);
  assertEquals(t.minutes, 30);
  assertEquals(t.dayOfWeek, 3); // Wednesday
});

Deno.test("getLocalTime shifts by timezone offset", () => {
  // America/Denver is UTC-6 (MDT) in June → 14:30Z = 08:30 local.
  const t = getLocalTime(WED_1430, "America/Denver");
  assertEquals(t.hours, 8);
  assertEquals(t.minutes, 30);
  assertEquals(t.dayOfWeek, 3);
});

// --- inPeakWindow -----------------------------------------------------------

Deno.test("no schedule configured is always active", () => {
  assert(inPeakWindow(WED_1430, {} as Parameters<typeof inPeakWindow>[1], UTC));
});

Deno.test("weekday window: inside is active, outside is not", () => {
  const sched = { weekday: "06:00-23:00" } as Parameters<typeof inPeakWindow>[1];
  assert(inPeakWindow(WED_1430, sched, UTC)); // 14:30 inside 06-23
  const earlySched = { weekday: "16:00-23:00" } as Parameters<
    typeof inPeakWindow
  >[1];
  assert(!inPeakWindow(WED_1430, earlySched, UTC)); // 14:30 before 16:00
});

Deno.test("weekend uses the weekend window, not weekday", () => {
  const sched = {
    weekday: "16:00-23:00",
    weekend: "06:00-23:00",
  } as Parameters<typeof inPeakWindow>[1];
  // Saturday 14:30: weekday window would exclude it, weekend window includes it.
  assert(inPeakWindow(SAT_1430, sched, UTC));
  // Wednesday 14:30: weekday window excludes it.
  assert(!inPeakWindow(WED_1430, sched, UTC));
});

Deno.test("weekend falls back to daily when no weekend window set", () => {
  const sched = { daily: "06:00-23:00" } as Parameters<typeof inPeakWindow>[1];
  assert(inPeakWindow(SAT_1430, sched, UTC));
});

Deno.test("multi-window daily: active in one range, idle in the gap", () => {
  const sched = {
    daily: "04:30-08:00,16:00-23:00",
  } as Parameters<typeof inPeakWindow>[1];
  // 14:30 falls in the 08:00-16:00 gap → not active.
  assert(!inPeakWindow(WED_1430, sched, UTC));
  // 06:00 falls in the first range → active.
  const wed0600 = new Date("2026-06-24T06:00:00Z");
  assert(inPeakWindow(wed0600, sched, UTC));
});

Deno.test("window end is exclusive, start is inclusive", () => {
  const sched = { daily: "14:00-14:30" } as Parameters<typeof inPeakWindow>[1];
  // exactly 14:30 → excluded (end exclusive).
  assert(!inPeakWindow(WED_1430, sched, UTC));
  const wed1400 = new Date("2026-06-24T14:00:00Z");
  assert(inPeakWindow(wed1400, sched, UTC)); // start inclusive
});

// --- detectProviderOverride -------------------------------------------------

Deno.test("provider override maps aliases to canonical provider", () => {
  assertEquals(detectProviderOverride(["ollama"]), "opencode");
  assertEquals(detectProviderOverride(["anthropic"]), "claude");
  assertEquals(detectProviderOverride(["gemini"]), "gemini");
});

Deno.test("provider override is case-insensitive and returns the first match", () => {
  assertEquals(detectProviderOverride(["Claude"]), "claude");
  assertEquals(detectProviderOverride(["unrelated", "local"]), "opencode");
});

Deno.test("no recognized label yields undefined", () => {
  assertEquals(detectProviderOverride(["plan-it", "urgent"]), undefined);
  assertEquals(detectProviderOverride([]), undefined);
});
