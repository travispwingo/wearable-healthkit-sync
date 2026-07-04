#!/usr/bin/env node
/**
 * Oura IBI → SDNN coverage probe  (READ-ONLY diagnostic — writes nothing anywhere)
 * ---------------------------------------------------------------------------------
 * Answers ONE question before we build the real sync pipeline:
 *   "Does THIS user's ring/firmware return enough valid raw inter-beat intervals
 *    to compute a trustworthy, Apple-Watch-comparable SDNN?"
 *
 * It only performs GETs against:
 *   • /v2/usercollection/sleep              → real per-night sleep windows
 *   • /v2/usercollection/interbeat_interval → raw RR/IBI beats (scope: heartrate)
 *
 * For each night it reports: total beats, a validity histogram, how many ~60 s
 * windows pass the ≥80 %-valid gate, and the resulting nightly-median SDNN — shown
 * next to Oura's own average_hrv (RMSSD) as a sanity check. Compare the SDNN column
 * against your Apple Watch nightly HRV to see how close the trends sit.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────────
 *   OURA_TOKEN=xxxxxxxxxxxx node scripts/ibi-coverage-probe.mjs
 *
 * Get a token (read-only, your account only — satisfies the 'heartrate' scope IBI
 * needs) at:  https://cloud.ouraring.com/personal-access-tokens
 *
 * ── Optional env ─────────────────────────────────────────────────────────────────
 *   NIGHTS=7            recent nights to check                         (default 7)
 *   WINDOW_SEC=60       SDNN window length — matches Apple Watch       (default 60)
 *   MIN_VALID_FRAC=0.8  per-window valid-beat fraction required        (default 0.8)
 *   MIN_BEATS=30        per-window minimum valid beats required        (default 30)
 *   MIN_WINDOWS=10      usable windows/night to call a night "good"    (default 10)
 *   DUMP_DIR=./ibi-dump save raw sleep+IBI JSON per night (test fixtures for later)
 *   BASE=...            API base                     (default https://api.ouraring.com)
 *
 * Node 18+ required (uses global fetch). Nothing is installed or committed.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

// ── Config ───────────────────────────────────────────────────────────────────────
const TOKEN = process.env.OURA_TOKEN;
const BASE = (process.env.BASE || "https://api.ouraring.com").replace(/\/+$/, "");
const NIGHTS = int(process.env.NIGHTS, 7);
const WINDOW_SEC = int(process.env.WINDOW_SEC, 60);
const MIN_VALID_FRAC = num(process.env.MIN_VALID_FRAC, 0.8);
const MIN_BEATS = int(process.env.MIN_BEATS, 30);
const MIN_WINDOWS = int(process.env.MIN_WINDOWS, 10);
const DUMP_DIR = process.env.DUMP_DIR || null;

// Our chosen policy: trust Oura's per-beat classification, keep Good + Corrected.
// (The printed histogram lets us confirm this encoding empirically on real data.)
const VALIDITY_LABELS = { "1": "Good", "3": "Corrected", "2": "Bad", "0": "Raw/Uncorrected", "-1": "Gap", "-2": "Gap" };
const VALID_VALUES = new Set([1, 3]);

if (!TOKEN) {
  console.error("✖ Set OURA_TOKEN. Get one at https://cloud.ouraring.com/personal-access-tokens");
  process.exit(1);
}

// ── Small helpers ─────────────────────────────────────────────────────────────────
function int(v, d) { const n = parseInt(v ?? "", 10); return Number.isFinite(n) ? n : d; }
function num(v, d) { const n = parseFloat(v ?? ""); return Number.isFinite(n) ? n : d; }
function ymd(d) { return d.toISOString().slice(0, 10); }
function pad(s, n) { return String(s).padEnd(n); }
function padL(s, n) { return String(s).padStart(n); }

function sampleStd(xs) {
  const n = xs.length;
  if (n < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const varc = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(varc);
}
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function r1(x) { return x == null ? "—" : (Math.round(x * 10) / 10).toString(); }

async function ouraGet(path, params) {
  const url = new URL(`${BASE}/v2/usercollection/${path}`);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (res.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
    const text = await res.text();
    if (!res.ok) {
      const research = /research scope/i.test(text);
      const hint = research ? " (raw IBI needs Oura's 'research' scope — standard tokens/apps can't access it)"
        : res.status === 401 ? " (token invalid/expired/malformed)"
        : res.status === 403 ? " (missing required scope)"
        : res.status === 404 ? " (route not found)" : "";
      throw new Error(`GET ${path} → HTTP ${res.status}${hint}: ${text.slice(0, 200)}`);
    }
    try { return JSON.parse(text); } catch { return { data: [], next_token: null, _raw: text }; }
  }
  throw new Error(`GET ${path} → repeatedly rate-limited (429)`);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Page through a usercollection endpoint, returning all rows (bounded for a probe). */
async function getAll(path, params, maxPages = 60) {
  const out = [];
  let next = null, pages = 0;
  do {
    const json = await ouraGet(path, { ...params, next_token: next });
    if (Array.isArray(json?.data)) out.push(...json.data);
    next = json?.next_token ?? null;
    pages++;
  } while (next && pages < maxPages);
  return { rows: out, pages, truncated: !!next };
}

/**
 * Flexible beat extractor — the live IBI response shape was not fully agreed on,
 * so handle both plausible forms and let the raw dump confirm which we hit:
 *   A) one row per beat:  { timestamp, timestamp_unix, ibi, validity }
 *   B) windowed document: { timestamp, items:[ibi…], (parallel validity array?) }
 * Returns [{ tMs, ibiMs, validity }].
 */
function extractBeats(docs) {
  const beats = [];
  for (const d of docs) {
    const scalarIbi = firstNum(d.ibi, d.interval_ms, d.rr, d.value);
    if (scalarIbi != null) {
      // Shape A — per-beat row.
      beats.push({ tMs: tsMs(d), ibiMs: scalarIbi, validity: firstDef(d.validity, d.quality, d.flag) });
      continue;
    }
    const items = d.items ?? d.ibi ?? d.rr ?? null; // Shape B — arrays of intervals.
    if (Array.isArray(items)) {
      const quals = arrOrNull(d.validity) ?? arrOrNull(d.items_quality) ?? arrOrNull(d.quality) ?? null;
      let t = tsMs(d); // reconstruct beat times by accumulating the intervals themselves
      for (let i = 0; i < items.length; i++) {
        const ibiMs = items[i];
        if (typeof ibiMs === "number") { beats.push({ tMs: t, ibiMs, validity: quals ? quals[i] : 1 }); t += ibiMs; }
      }
    }
  }
  return beats;
}
function firstNum(...vs) { for (const v of vs) if (typeof v === "number") return v; return null; }
function firstDef(...vs) { for (const v of vs) if (v !== undefined) return v; return undefined; }
function arrOrNull(v) { return Array.isArray(v) ? v : null; }
function tsMs(d) {
  if (typeof d.timestamp_unix === "number") return d.timestamp_unix;
  if (typeof d.timestamp === "string") { const t = Date.parse(d.timestamp); return Number.isNaN(t) ? null : t; }
  return null;
}

/** Bin beats into WINDOW_SEC windows; gate; compute per-window SDNN; nightly median. */
function analyze(beats) {
  const usableBeats = beats.filter((b) => b.tMs != null && typeof b.ibiMs === "number");
  const hist = {};
  for (const b of beats) { const k = String(b.validity); hist[k] = (hist[k] || 0) + 1; }
  if (!usableBeats.length) return { totalBeats: beats.length, validBeats: 0, hist, windowsTotal: 0, windowsUsable: 0, sdnn: null, sdnns: [] };

  const t0 = Math.min(...usableBeats.map((b) => b.tMs));
  const windows = new Map();
  let validBeats = 0;
  for (const b of usableBeats) {
    const idx = Math.floor((b.tMs - t0) / (WINDOW_SEC * 1000));
    let w = windows.get(idx);
    if (!w) { w = { total: 0, valid: [] }; windows.set(idx, w); }
    w.total++;
    if (VALID_VALUES.has(Number(b.validity))) { w.valid.push(b.ibiMs); validBeats++; }
  }
  const sdnns = [];
  for (const w of windows.values()) {
    const frac = w.total ? w.valid.length / w.total : 0;
    if (frac >= MIN_VALID_FRAC && w.valid.length >= MIN_BEATS) {
      const s = sampleStd(w.valid);
      if (s != null) sdnns.push(s);
    }
  }
  return { totalBeats: beats.length, validBeats, hist, windowsTotal: windows.size, windowsUsable: sdnns.length, sdnn: median(sdnns), sdnns };
}

// ── Main ──────────────────────────────────────────────────────────────────────────
async function main() {
const now = new Date();
const start = new Date(now.getTime() - (NIGHTS + 1) * 86400_000);
console.log(`Oura IBI → SDNN coverage probe`);
console.log(`  base=${BASE}  nights=${NIGHTS}  window=${WINDOW_SEC}s  gate=≥${MIN_VALID_FRAC * 100}% & ≥${MIN_BEATS} beats\n`);

if (DUMP_DIR) await mkdir(DUMP_DIR, { recursive: true });

// 1) Sleep periods → real per-night windows (exclude naps; keep main long sleeps).
const { rows: sleeps } = await getAll("sleep", { start_date: ymd(start), end_date: ymd(now) });
const mains = sleeps.filter((s) => s.type === "long_sleep" || (s.type === "sleep" && (s.total_sleep_duration ?? 0) > 3 * 3600))
  .sort((a, b) => (a.bedtime_start || a.day).localeCompare(b.bedtime_start || b.day))
  .slice(-NIGHTS);

if (!mains.length) { console.error("✖ No main sleep periods returned. Check the token's 'daily' scope and that the ring synced."); process.exit(1); }
console.log(`Found ${mains.length} main sleep night(s). Fetching IBI per night…\n`);

let schemaShown = false;
const summary = [];

for (const s of mains) {
  const startDt = s.bedtime_start;
  const endDt = s.bedtime_end || new Date(Date.parse(s.bedtime_start) + (s.total_sleep_duration ?? 0) * 1000).toISOString();
  let ibi;
  try {
    ibi = await getAll("interbeat_interval", { start_datetime: startDt, end_datetime: endDt });
  } catch (e) {
    console.log(`  ${s.day}: ✖ ${e.message}`);
    summary.push({ day: s.day, error: true });
    continue;
  }

  if (!schemaShown && ibi.rows.length) {
    console.log("── First raw interbeat_interval record (confirm schema) ─────────────────");
    console.log(JSON.stringify(ibi.rows[0], null, 2).split("\n").slice(0, 24).join("\n"));
    console.log("─────────────────────────────────────────────────────────────────────────\n");
    schemaShown = true;
  }
  if (DUMP_DIR) {
    await writeFile(join(DUMP_DIR, `sleep-${s.day}.json`), JSON.stringify(s, null, 2));
    await writeFile(join(DUMP_DIR, `ibi-${s.day}.json`), JSON.stringify(ibi.rows, null, 2));
  }

  const beats = extractBeats(ibi.rows);
  const a = analyze(beats);
  const good = a.windowsUsable >= MIN_WINDOWS;
  summary.push({ day: s.day, ...a, pages: ibi.pages, truncated: ibi.truncated, rmssd: s.average_hrv, good });

  const validPct = a.totalBeats ? Math.round((100 * a.validBeats) / a.totalBeats) : 0;
  console.log(
    `  ${pad(s.day, 11)} beats=${padL(a.totalBeats, 6)} valid=${padL(validPct + "%", 4)}  ` +
    `windows ${padL(a.windowsUsable, 3)}/${pad(a.windowsTotal, 3)} usable  ` +
    `SDNN(med)=${padL(r1(a.sdnn), 5)}ms  Oura-RMSSD=${padL(a.rmssd ?? "—", 4)}  ` +
    `${good ? "✓" : "· sparse"}${ibi.truncated ? " (paging truncated)" : ""}`
  );
}

// ── Verdict ─────────────────────────────────────────────────────────────────────
const nights = summary.filter((r) => !r.error);
const erroredNights = summary.filter((r) => r.error).length;
const goodNights = nights.filter((r) => r.good).length;
const withData = nights.filter((r) => (r.totalBeats || 0) > 0).length;

console.log(`\n══ Verdict ═══════════════════════════════════════════════════════════════`);
if (erroredNights === summary.length) {
  console.log(`✖ BLOCKED: every interbeat_interval request failed (see errors above) — not a data problem.`);
  console.log(`  If the error says "research scope", raw IBI is gated behind Oura's research-access tier;`);
  console.log(`  standard tokens/apps can't reach it, so a true SDNN isn't possible. Stay on raw RMSSD.`);
} else if (!withData) {
  console.log(`✖ NOT VIABLE: interbeat_interval returned no beats on any night.`);
  console.log(`  Your ring/firmware likely doesn't expose raw IBI. Stay on the honest raw-RMSSD path.`);
} else if (goodNights >= Math.ceil(nights.length * 0.7)) {
  console.log(`✓ VIABLE: ${goodNights}/${nights.length} nights yield ≥${MIN_WINDOWS} usable ${WINDOW_SEC}s windows.`);
  console.log(`  Enough coverage to compute a stable nightly-median SDNN. Green light to build the pipeline.`);
} else if (goodNights > 0) {
  console.log(`◐ PARTIAL: only ${goodNights}/${nights.length} nights clear the bar — expect some skipped nights.`);
  console.log(`  Feature works, but daily coverage will have gaps (which is fine: we skip sparse nights).`);
} else {
  console.log(`✖ MARGINAL: data exists but no night reaches ${MIN_WINDOWS} usable windows.`);
  console.log(`  Check the validity histogram below — the encoding or gate may need adjusting before we commit.`);
}

const histAll = {};
for (const r of nights) for (const [k, v] of Object.entries(r.hist || {})) histAll[k] = (histAll[k] || 0) + v;
const histStr = Object.entries(histAll).sort((a, b) => Number(b[1]) - Number(a[1]))
  .map(([k, v]) => `${VALIDITY_LABELS[k] ? `${VALIDITY_LABELS[k]}(${k})` : k}=${v}`).join("  ");
console.log(`\nValidity histogram (all nights): ${histStr || "—"}`);
console.log(`Treated as valid: ${[...VALID_VALUES].join(", ")}  →  paste this whole output back and I'll take it from here.`);
if (DUMP_DIR) console.log(`Raw JSON dumped to ${DUMP_DIR}/ (usable as unit-test fixtures).`);
}

main().catch((e) => { console.error(`\n✖ ${e.message}`); process.exit(1); });
