import { describe, expect, it } from "vitest";
import { checkAppToken, checkSetupPassword } from "./auth";

const TOKEN = "a".repeat(64);

describe("checkAppToken", () => {
  it("accepts the token as ?k= query param", async () => {
    const url = new URL(`https://x/sync?k=${TOKEN}`);
    expect(await checkAppToken(new Request(url), url, TOKEN)).toBe(true);
  });

  it("accepts the token as a Bearer header", async () => {
    const url = new URL("https://x/sync");
    const req = new Request(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(await checkAppToken(req, url, TOKEN)).toBe(true);
  });

  it("rejects a wrong token and a missing token", async () => {
    const wrongUrl = new URL("https://x/sync?k=nope");
    expect(await checkAppToken(new Request(wrongUrl), wrongUrl, TOKEN)).toBe(false);
    const bareUrl = new URL("https://x/sync");
    expect(await checkAppToken(new Request(bareUrl), bareUrl, TOKEN)).toBe(false);
  });
});

describe("checkSetupPassword", () => {
  it("matches the X-Setup-Password header against the secret", async () => {
    const req = new Request("https://x/setup/status", { headers: { "X-Setup-Password": "hunter2" } });
    expect(await checkSetupPassword(req, "hunter2")).toBe(true);
    expect(await checkSetupPassword(req, "wrong")).toBe(false);
  });

  it("fails closed when no password is configured", async () => {
    const req = new Request("https://x/setup/status", { headers: { "X-Setup-Password": "" } });
    expect(await checkSetupPassword(req, undefined)).toBe(false);
    expect(await checkSetupPassword(req, "")).toBe(false);
  });
});
