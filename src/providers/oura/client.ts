/**
 * Thin Oura API v2 client: authenticated GETs against usercollection endpoints,
 * following `next_token` pagination. Endpoint records are returned raw for the
 * mappers to normalize.
 *
 * Note: the three endpoints we use (sleep, daily_spo2, vO2_max) all filter by
 * `start_date`/`end_date`. (Only heartrate/interbeat_interval use start_datetime,
 * and we don't fetch those for the gap-metric set.)
 */
import type { DateRange } from "../types";
import { OuraApiError } from "../../env";

const DEFAULT_BASE = "https://api.ouraring.com";

interface OuraCollectionResponse<T> {
  data: T[];
  next_token: string | null;
}

export class OuraClient {
  private readonly base: string;

  constructor(private readonly accessToken: string, base?: string) {
    this.base = (base || DEFAULT_BASE).replace(/\/+$/, "");
  }

  /** Fetch every page of a usercollection endpoint over the given date range. */
  async getCollection<T>(endpoint: string, range: DateRange): Promise<T[]> {
    const out: T[] = [];
    let nextToken: string | null = null;

    do {
      const url = new URL(`${this.base}/v2/usercollection/${endpoint}`);
      url.searchParams.set("start_date", range.start);
      url.searchParams.set("end_date", range.end);
      if (nextToken) url.searchParams.set("next_token", nextToken);

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
      if (!res.ok) {
        throw new OuraApiError(res.status, await res.text());
      }
      const json = (await res.json()) as OuraCollectionResponse<T>;
      out.push(...json.data);
      nextToken = json.next_token;
    } while (nextToken);

    return out;
  }
}
