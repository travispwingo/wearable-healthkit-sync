import { afterEach, describe, expect, it, vi } from "vitest";
import { createOuraProvider } from "./index";

function mockResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const longSleep = {
  type: "long_sleep",
  average_hrv: 42,
  lowest_heart_rate: 52,
  bedtime_start: "2026-07-02T23:00:00+00:00",
  total_sleep_duration: 8 * 3600,
  day: "2026-07-03",
};
const nap = { ...longSleep, type: "sleep", average_hrv: 99, lowest_heart_rate: 70 };
const spo2 = { day: "2026-07-03", spo2_percentage: { average: 96 } };
const vo2 = { day: "2026-07-03", timestamp: "2026-07-03T09:15:00Z", vo2_max: 48 };

const range = { start: "2026-07-02", end: "2026-07-03" };

afterEach(() => vi.unstubAllGlobals());

describe("createOuraProvider.fetchSamples", () => {
  it("fetches all three endpoints, keeps only the main sleep period, and normalizes", async () => {
    const calls: { url: string; auth: string | undefined }[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      const headers = new Headers(init?.headers);
      calls.push({ url, auth: headers.get("Authorization") ?? undefined });
      if (url.includes("/usercollection/sleep")) return mockResponse({ data: [longSleep, nap], next_token: null });
      if (url.includes("/usercollection/daily_spo2")) return mockResponse({ data: [spo2], next_token: null });
      if (url.includes("/usercollection/vO2_max")) return mockResponse({ data: [vo2], next_token: null });
      throw new Error(`unexpected url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOuraProvider({ accessToken: "test-access", spo2AsFraction: true });
    const samples = await provider.fetchSamples(range);

    // The nap (type "sleep") is excluded → exactly one HRV + one resting HR.
    expect(samples).toEqual([
      { type: "heartRateVariabilitySDNN", unit: "ms", value: 42, date: "2026-07-03T03:00:00.000Z", source: "oura" },
      { type: "restingHeartRate", unit: "count/min", value: 52, date: "2026-07-03T03:00:00.000Z", source: "oura" },
      { type: "oxygenSaturation", unit: "fraction", value: 0.96, date: "2026-07-03T12:00:00Z", source: "oura" },
      { type: "vo2Max", unit: "mL/kg·min", value: 48, date: "2026-07-03T09:15:00Z", source: "oura" },
    ]);

    // Bearer token forwarded, and the date window is passed as query params.
    expect(calls.every((c) => c.auth === "Bearer test-access")).toBe(true);
    expect(calls.every((c) => c.url.includes("start_date=2026-07-02") && c.url.includes("end_date=2026-07-03"))).toBe(true);
    expect(calls.map((c) => new URL(c.url).pathname).sort()).toEqual([
      "/v2/usercollection/daily_spo2",
      "/v2/usercollection/sleep",
      "/v2/usercollection/vO2_max",
    ]);
  });

  it("follows next_token pagination", async () => {
    let sleepCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.includes("/usercollection/sleep")) {
        sleepCalls++;
        return url.includes("next_token=PAGE2")
          ? mockResponse({ data: [{ ...longSleep, average_hrv: 40, day: "2026-07-02" }], next_token: null })
          : mockResponse({ data: [longSleep], next_token: "PAGE2" });
      }
      if (url.includes("/usercollection/daily_spo2")) return mockResponse({ data: [], next_token: null });
      if (url.includes("/usercollection/vO2_max")) return mockResponse({ data: [], next_token: null });
      throw new Error(`unexpected url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOuraProvider({ accessToken: "t", spo2AsFraction: true });
    const samples = await provider.fetchSamples(range);

    expect(sleepCalls).toBe(2); // two pages fetched
    const hrv = samples.filter((s) => s.type === "heartRateVariabilitySDNN").map((s) => s.value);
    expect(hrv).toEqual([42, 40]); // both pages' nights normalized
  });

  it("propagates a non-2xx Oura response as an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mockResponse("nope", false, 401)),
    );
    const provider = createOuraProvider({ accessToken: "t", spo2AsFraction: true });
    await expect(provider.fetchSamples(range)).rejects.toThrow(/Oura API error 401/);
  });
});
