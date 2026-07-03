/**
 * HealthKit sample-type identifiers and their canonical units.
 *
 * Single source of truth for the metrics this tool writes. The `id` values are
 * the HealthKit quantity-type identifiers (as surfaced by the Shortcuts
 * "Log Health Sample" action); the iOS Shortcut uses one hard-coded block per id
 * (the action's Type field cannot be a runtime variable), so the sync endpoint
 * groups its response by these keys.
 *
 * Units are documentary — the Shortcut selects the unit in each Log block. They
 * are recorded here so `mappers.ts` and the README stay consistent.
 */
export const HK = {
  /** Oura reports HRV as RMSSD (ms). HealthKit only has an SDNN field, so the raw
   *  RMSSD value is stored here unchanged — there is no valid RMSSD→SDNN formula.
   *  Never chart this against Apple Watch HRV (which is a true, ultra-short SDNN). */
  HRV_SDNN: { id: "heartRateVariabilitySDNN", unit: "ms" },
  RESTING_HR: { id: "restingHeartRate", unit: "count/min" },
  /** HealthKit stores oxygen saturation as a fraction 0.0–1.0 (0.96 == 96%). */
  OXYGEN_SATURATION: { id: "oxygenSaturation", unit: "fraction" },
  VO2_MAX: { id: "vo2Max", unit: "mL/kg·min" },
} as const;

export type HKMetric = (typeof HK)[keyof typeof HK];
