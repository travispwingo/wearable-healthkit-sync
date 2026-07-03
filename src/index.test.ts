import { describe, expect, it } from "vitest";
import { groupByType, resolveRange } from "./index";
import type { HealthSample } from "./providers/types";

describe("resolveRange", () => {
  const now = new Date("2026-07-03T08:00:00Z");

  it("defaults to yesterday→today (UTC)", () => {
    expect(resolveRange(new URL("https://x/"), now)).toEqual({ start: "2026-07-02", end: "2026-07-03" });
  });

  it("honors explicit start & end", () => {
    expect(resolveRange(new URL("https://x/?start=2026-06-01&end=2026-06-05"), now)).toEqual({
      start: "2026-06-01",
      end: "2026-06-05",
    });
  });

  it("supports ?days=N for backfill", () => {
    expect(resolveRange(new URL("https://x/?days=7"), now)).toEqual({ start: "2026-06-26", end: "2026-07-03" });
  });
});

describe("groupByType", () => {
  it("buckets samples by HealthKit type into {value,date} arrays", () => {
    const samples: HealthSample[] = [
      { type: "restingHeartRate", unit: "count/min", value: 52, date: "2026-07-03T03:00:00Z", source: "oura" },
      { type: "heartRateVariabilitySDNN", unit: "ms", value: 42, date: "2026-07-03T03:00:00Z", source: "oura" },
      { type: "restingHeartRate", unit: "count/min", value: 50, date: "2026-07-02T03:00:00Z", source: "oura" },
    ];
    expect(groupByType(samples)).toEqual({
      restingHeartRate: [
        { value: 52, date: "2026-07-03T03:00:00Z" },
        { value: 50, date: "2026-07-02T03:00:00Z" },
      ],
      heartRateVariabilitySDNN: [{ value: 42, date: "2026-07-03T03:00:00Z" }],
    });
  });

  it("returns an empty object for no samples", () => {
    expect(groupByType([])).toEqual({});
  });
});
