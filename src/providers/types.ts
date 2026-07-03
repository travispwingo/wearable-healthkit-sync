/**
 * The normalized data model every provider produces, and the provider seam that
 * makes the tool extensible to other wearables (Garmin, etc.).
 *
 * A provider's only job is to turn a date range into a flat array of
 * `HealthSample`s. All unit conversion / normalization lives inside the
 * provider's own `mappers.ts` as pure functions, so the HTTP handler and the
 * iOS Shortcut never change when a provider is added.
 */

export interface HealthSample {
  /** HealthKit sample-type identifier — see `healthkit/types.ts` (HK.*.id). */
  type: string;
  /** Canonical unit for the value (documentary; the Shortcut sets it per block). */
  unit: string;
  value: number;
  /** ISO-8601 instant the sample is recorded at (absolute; HealthKit is UTC-internal). */
  date: string;
  /** Provider id, e.g. "oura". */
  source: string;
}

/** Inclusive calendar-day range in YYYY-MM-DD (Oura's start_date/end_date semantics). */
export interface DateRange {
  start: string;
  end: string;
}

export interface HealthProvider {
  readonly id: string;
  fetchSamples(range: DateRange): Promise<HealthSample[]>;
}
