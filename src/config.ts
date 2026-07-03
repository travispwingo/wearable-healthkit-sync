/**
 * Configuration store — KV first, env vars as an advanced/CLI fallback.
 *
 * The /setup wizard writes the Oura app credentials and an auto-generated app
 * token into KV, so a self-hoster configures everything from the browser after a
 * one-click deploy. Power users can still set OURA_CLIENT_ID/SECRET and
 * APP_SHARED_SECRET as Worker secrets and skip the wizard.
 */
import type { Env } from "./env";

const KEY = {
  clientId: "config:oura_client_id",
  clientSecret: "config:oura_client_secret",
  appToken: "config:app_token",
  refreshToken: "oura_refresh_token",
} as const;

export interface OuraCredentials {
  clientId: string;
  clientSecret: string;
}

/** Oura app credentials from KV, falling back to env vars. Null if neither set. */
export async function getOuraCredentials(env: Env): Promise<OuraCredentials | null> {
  const [kvId, kvSecret] = await Promise.all([
    env.OURA_KV.get(KEY.clientId),
    env.OURA_KV.get(KEY.clientSecret),
  ]);
  const clientId = kvId ?? env.OURA_CLIENT_ID ?? "";
  const clientSecret = kvSecret ?? env.OURA_CLIENT_SECRET ?? "";
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export async function setOuraCredentials(env: Env, clientId: string, clientSecret: string): Promise<void> {
  await Promise.all([
    env.OURA_KV.put(KEY.clientId, clientId.trim()),
    env.OURA_KV.put(KEY.clientSecret, clientSecret.trim()),
  ]);
}

/**
 * The capability token the Shortcut presents (as ?k= or a Bearer header).
 * Returns the env fallback if set, else the KV value, generating and persisting
 * one on first use so the wizard has a stable value to show.
 */
export async function getOrCreateAppToken(env: Env): Promise<string> {
  if (env.APP_SHARED_SECRET) return env.APP_SHARED_SECRET;
  const existing = await env.OURA_KV.get(KEY.appToken);
  if (existing) return existing;
  const token = randomToken();
  await env.OURA_KV.put(KEY.appToken, token);
  return token;
}

/** Read the app token without creating one (null if unset). */
export async function peekAppToken(env: Env): Promise<string | null> {
  return env.APP_SHARED_SECRET ?? (await env.OURA_KV.get(KEY.appToken));
}

export async function getRefreshToken(env: Env): Promise<string | null> {
  return env.OURA_KV.get(KEY.refreshToken);
}

export async function setRefreshToken(env: Env, token: string): Promise<void> {
  await env.OURA_KV.put(KEY.refreshToken, token);
}

/** True once credentials exist AND Oura has been connected (refresh token present). */
export async function isFullyConfigured(env: Env): Promise<boolean> {
  const [creds, refresh] = await Promise.all([getOuraCredentials(env), getRefreshToken(env)]);
  return creds !== null && refresh !== null;
}

/** 32 bytes of hex — an unguessable capability token. */
export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
