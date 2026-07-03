/**
 * Oura provider: fetches the three gap-metric endpoints, normalizes via the pure
 * mappers, and returns a flat HealthSample[]. Credentials are bound at
 * construction (the access token), keeping the HealthProvider interface clean.
 */
import type { DateRange, HealthProvider, HealthSample } from "../types";
import { OuraClient } from "./client";
import {
  mapHrv,
  mapRestingHr,
  mapSpo2,
  mapVo2Max,
  type OuraDailySpo2,
  type OuraSleepRecord,
  type OuraVo2Max,
} from "./mappers";

export interface OuraProviderOptions {
  accessToken: string;
  spo2AsFraction: boolean;
  /** Optional API base override (e.g. the Oura sandbox) for testing. */
  apiBase?: string;
}

export function createOuraProvider(opts: OuraProviderOptions): HealthProvider {
  const client = new OuraClient(opts.accessToken, opts.apiBase);

  return {
    id: "oura",
    async fetchSamples(range: DateRange): Promise<HealthSample[]> {
      const [sleep, spo2, vo2] = await Promise.all([
        client.getCollection<OuraSleepRecord>("sleep", range),
        client.getCollection<OuraDailySpo2>("daily_spo2", range),
        client.getCollection<OuraVo2Max>("vO2_max", range),
      ]);

      const samples: HealthSample[] = [];

      // HRV and resting HR come from the main nightly sleep period(s).
      for (const night of sleep.filter((s) => s.type === "long_sleep")) {
        const hrv = mapHrv(night);
        if (hrv) samples.push(hrv);
        const rhr = mapRestingHr(night);
        if (rhr) samples.push(rhr);
      }
      for (const day of spo2) {
        const s = mapSpo2(day, opts.spo2AsFraction);
        if (s) samples.push(s);
      }
      for (const v of vo2) {
        const s = mapVo2Max(v);
        if (s) samples.push(s);
      }

      return samples;
    },
  };
}
