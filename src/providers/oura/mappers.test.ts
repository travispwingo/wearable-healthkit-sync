import { describe, expect, it } from "vitest";
import {
  mapHrv,
  mapRestingHr,
  mapSpo2,
  mapVo2Max,
  sleepMidpointISO,
  type OuraDailySpo2,
  type OuraSleepRecord,
  type OuraVo2Max,
} from "./mappers";

const night: OuraSleepRecord = {
  type: "long_sleep",
  average_hrv: 42, // RMSSD ms
  lowest_heart_rate: 52,
  bedtime_start: "2026-07-02T23:00:00+00:00",
  total_sleep_duration: 8 * 3600, // 8h → midpoint at 03:00Z
  day: "2026-07-03",
};

describe("sleepMidpointISO", () => {
  it("returns bedtime_start + half the sleep duration as a UTC instant", () => {
    expect(sleepMidpointISO(night)).toBe("2026-07-03T03:00:00.000Z");
  });

  it("honors the source timezone offset", () => {
    // 23:00 at -07:00 == 06:00Z; +4h midpoint == 10:00Z
    expect(
      sleepMidpointISO({ bedtime_start: "2026-07-02T23:00:00-07:00", total_sleep_duration: 8 * 3600 }),
    ).toBe("2026-07-03T10:00:00.000Z");
  });

  it("falls back to bedtime_start when duration is missing", () => {
    expect(sleepMidpointISO({ bedtime_start: "2026-07-02T23:00:00Z", total_sleep_duration: null })).toBe(
      "2026-07-02T23:00:00.000Z",
    );
  });

  it("throws on an unparseable bedtime_start", () => {
    expect(() => sleepMidpointISO({ bedtime_start: "not-a-date", total_sleep_duration: 0 })).toThrow();
  });
});

describe("mapHrv", () => {
  it("writes raw RMSSD unchanged into the SDNN field (no multiplier)", () => {
    expect(mapHrv(night)).toEqual({
      type: "heartRateVariabilitySDNN",
      unit: "ms",
      value: 42,
      date: "2026-07-03T03:00:00.000Z",
      source: "oura",
    });
  });

  it("returns null when HRV is absent", () => {
    expect(mapHrv({ ...night, average_hrv: null })).toBeNull();
  });
});

describe("mapRestingHr", () => {
  it("maps lowest_heart_rate 1:1 to restingHeartRate", () => {
    expect(mapRestingHr(night)).toMatchObject({ type: "restingHeartRate", value: 52, unit: "count/min" });
  });

  it("returns null when lowest_heart_rate is absent", () => {
    expect(mapRestingHr({ ...night, lowest_heart_rate: null })).toBeNull();
  });
});

describe("mapSpo2", () => {
  const rec: OuraDailySpo2 = { day: "2026-07-03", spo2_percentage: { average: 96 } };

  it("converts percent → fraction by default and anchors midday", () => {
    expect(mapSpo2(rec)).toEqual({
      type: "oxygenSaturation",
      unit: "fraction",
      value: 0.96,
      date: "2026-07-03T12:00:00Z",
      source: "oura",
    });
  });

  it("keeps raw percent when asFraction is false", () => {
    expect(mapSpo2(rec, false)).toMatchObject({ value: 96, unit: "%" });
  });

  it("returns null when the average is missing", () => {
    expect(mapSpo2({ day: "2026-07-03", spo2_percentage: null })).toBeNull();
    expect(mapSpo2({ day: "2026-07-03", spo2_percentage: { average: null } })).toBeNull();
  });
});

describe("mapVo2Max", () => {
  it("maps 1:1 and prefers the record timestamp", () => {
    const rec: OuraVo2Max = { day: "2026-07-03", timestamp: "2026-07-03T09:15:00Z", vo2_max: 48 };
    expect(mapVo2Max(rec)).toEqual({
      type: "vo2Max",
      unit: "mL/kg·min",
      value: 48,
      date: "2026-07-03T09:15:00Z",
      source: "oura",
    });
  });

  it("anchors midday when timestamp is null", () => {
    expect(mapVo2Max({ day: "2026-07-03", timestamp: null, vo2_max: 50 })).toMatchObject({
      date: "2026-07-03T12:00:00Z",
    });
  });

  it("returns null when vo2_max is absent", () => {
    expect(mapVo2Max({ day: "2026-07-03", timestamp: null, vo2_max: null })).toBeNull();
  });
});
