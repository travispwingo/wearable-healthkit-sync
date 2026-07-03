/**
 * Pure conversion functions: Oura API v2 records → normalized HealthSample[].
 *
 * These are deliberately side-effect-free and network-free so they can be unit
 * tested against recorded Oura JSON (see mappers.test.ts). All the tool's
 * "calculated differently" handling lives here.
 */
import type { HealthSample } from "../types";
import { HK } from "../../healthkit/types";

const SOURCE = "oura";
/** Anchor time for daily records that carry only a `day` (no timestamp). */
const DAILY_ANCHOR = "T12:00:00Z";

// ---- Minimal shapes of the Oura fields we consume ----

/** From GET /v2/usercollection/sleep — one sleep period. */
export interface OuraSleepRecord {
  /** "long_sleep" | "sleep" | "late_nap" | "rest" | "deleted" */
  type: string;
  /** Average HRV during sleep. Oura HRV is RMSSD in milliseconds. */
  average_hrv: number | null;
  /** Lowest heart rate during sleep (bpm) — Oura's notion of resting HR. */
  lowest_heart_rate: number | null;
  /** ISO-8601 with timezone offset, e.g. "2026-07-02T23:41:00-07:00". */
  bedtime_start: string;
  /** Total time asleep, in seconds. */
  total_sleep_duration: number | null;
  day: string;
}

/** From GET /v2/usercollection/daily_spo2. */
export interface OuraDailySpo2 {
  day: string;
  /** Average blood-oxygen as a percentage (e.g. 96). */
  spo2_percentage: { average: number | null } | null;
}

/** From GET /v2/usercollection/vO2_max (note the capital O in the path). */
export interface OuraVo2Max {
  day: string;
  timestamp: string | null;
  /** VO2 max, mL/kg/min. */
  vo2_max: number | null;
}

/**
 * Midpoint of a sleep period as an absolute UTC instant. HRV, resting HR, and
 * (when joined) SpO2 are measured across the night, so the midpoint is a
 * defensible single timestamp. Falls back to bedtime_start if duration is absent.
 */
export function sleepMidpointISO(rec: Pick<OuraSleepRecord, "bedtime_start" | "total_sleep_duration">): string {
  const startMs = Date.parse(rec.bedtime_start);
  if (Number.isNaN(startMs)) {
    throw new Error(`invalid bedtime_start: ${rec.bedtime_start}`);
  }
  const durMs = (rec.total_sleep_duration ?? 0) * 1000;
  return new Date(startMs + durMs / 2).toISOString();
}

/**
 * HRV → HealthKit heartRateVariabilitySDNN.
 * Writes Oura's raw RMSSD value UNCHANGED. There is no valid RMSSD→SDNN
 * conversion (their ratio is person/length/state dependent), so no multiplier is
 * applied. The value is honest RMSSD; it just lives in the field Apple labels SDNN.
 */
export function mapHrv(rec: OuraSleepRecord): HealthSample | null {
  if (rec.average_hrv == null) return null;
  return {
    type: HK.HRV_SDNN.id,
    unit: HK.HRV_SDNN.unit,
    value: rec.average_hrv,
    date: sleepMidpointISO(rec),
    source: SOURCE,
  };
}

/** Lowest nightly HR → HealthKit restingHeartRate (1:1, count/min). */
export function mapRestingHr(rec: OuraSleepRecord): HealthSample | null {
  if (rec.lowest_heart_rate == null) return null;
  return {
    type: HK.RESTING_HR.id,
    unit: HK.RESTING_HR.unit,
    value: rec.lowest_heart_rate,
    date: sleepMidpointISO(rec),
    source: SOURCE,
  };
}

/**
 * Average SpO2 → HealthKit oxygenSaturation.
 * HealthKit stores oxygen saturation as a FRACTION 0.0–1.0, so by default we
 * divide the percentage by 100 (96 → 0.96). Whether the Shortcut UI wants the
 * fraction or the raw percent is the one thing to verify on-device; `asFraction`
 * flips it in a single place. daily_spo2 has no timestamp, so we anchor midday.
 */
export function mapSpo2(rec: OuraDailySpo2, asFraction = true): HealthSample | null {
  const avg = rec.spo2_percentage?.average;
  if (avg == null) return null;
  return {
    type: HK.OXYGEN_SATURATION.id,
    unit: asFraction ? "fraction" : "%",
    value: asFraction ? avg / 100 : avg,
    date: `${rec.day}${DAILY_ANCHOR}`,
    source: SOURCE,
  };
}

/** VO2 max → HealthKit vo2Max (1:1, mL/kg·min). */
export function mapVo2Max(rec: OuraVo2Max): HealthSample | null {
  if (rec.vo2_max == null) return null;
  return {
    type: HK.VO2_MAX.id,
    unit: HK.VO2_MAX.unit,
    value: rec.vo2_max,
    date: rec.timestamp ?? `${rec.day}${DAILY_ANCHOR}`,
    source: SOURCE,
  };
}
