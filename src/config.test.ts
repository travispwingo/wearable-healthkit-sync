import { describe, expect, it } from "vitest";
import type { Env } from "./env";
import {
  getOrCreateAppToken,
  getOuraCredentials,
  getRefreshToken,
  isFullyConfigured,
  peekAppToken,
  randomToken,
  setOuraCredentials,
  setRefreshToken,
} from "./config";

function makeEnv(overrides: Partial<Env> = {}): Env {
  const store = new Map<string, string>();
  const kv = {
    get: async (k: string) => (store.has(k) ? store.get(k)! : null),
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  };
  return { OURA_KV: kv as unknown as KVNamespace, ...overrides } as Env;
}

describe("Oura credentials", () => {
  it("returns null when neither KV nor env has them", async () => {
    expect(await getOuraCredentials(makeEnv())).toBeNull();
  });

  it("round-trips through KV (trimmed)", async () => {
    const env = makeEnv();
    await setOuraCredentials(env, "  id123  ", "  secret456 ");
    expect(await getOuraCredentials(env)).toEqual({ clientId: "id123", clientSecret: "secret456" });
  });

  it("falls back to env vars when KV is empty", async () => {
    const env = makeEnv({ OURA_CLIENT_ID: "envid", OURA_CLIENT_SECRET: "envsecret" });
    expect(await getOuraCredentials(env)).toEqual({ clientId: "envid", clientSecret: "envsecret" });
  });

  it("KV wins over env", async () => {
    const env = makeEnv({ OURA_CLIENT_ID: "envid", OURA_CLIENT_SECRET: "envsecret" });
    await setOuraCredentials(env, "kvid", "kvsecret");
    expect(await getOuraCredentials(env)).toEqual({ clientId: "kvid", clientSecret: "kvsecret" });
  });

  it("needs BOTH id and secret", async () => {
    const env = makeEnv({ OURA_CLIENT_ID: "only-id" });
    expect(await getOuraCredentials(env)).toBeNull();
  });
});

describe("app token", () => {
  it("generates once and stays stable, and persists", async () => {
    const env = makeEnv();
    expect(await peekAppToken(env)).toBeNull();
    const t1 = await getOrCreateAppToken(env);
    expect(t1).toMatch(/^[0-9a-f]{64}$/);
    expect(await getOrCreateAppToken(env)).toBe(t1);
    expect(await peekAppToken(env)).toBe(t1);
  });

  it("env APP_SHARED_SECRET overrides the generated token", async () => {
    const env = makeEnv({ APP_SHARED_SECRET: "fixed-token" });
    expect(await getOrCreateAppToken(env)).toBe("fixed-token");
    expect(await peekAppToken(env)).toBe("fixed-token");
  });
});

describe("isFullyConfigured", () => {
  it("requires both credentials and a refresh token", async () => {
    const env = makeEnv();
    expect(await isFullyConfigured(env)).toBe(false);
    await setOuraCredentials(env, "id", "secret");
    expect(await isFullyConfigured(env)).toBe(false);
    await setRefreshToken(env, "refresh-abc");
    expect(await getRefreshToken(env)).toBe("refresh-abc");
    expect(await isFullyConfigured(env)).toBe(true);
  });
});

describe("randomToken", () => {
  it("is 64 hex chars and non-repeating", () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});
