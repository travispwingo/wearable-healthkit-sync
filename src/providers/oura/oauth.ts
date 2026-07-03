/**
 * Oura OAuth2 (authorization-code flow) + token refresh.
 *
 * Oura deprecated Personal Access Tokens in Dec 2025 and supports no PKCE/public
 * client, so each self-hosted instance uses its OWN Oura app credentials
 * (client_id + client_secret), seeded via the /setup wizard into KV. The
 * redirect URI is derived from the Worker's own origin, so it always matches.
 *
 * The refresh token is SINGLE-USE / ROTATING: every refresh returns a new one
 * and invalidates the old, so we persist the new one each time.
 */
import type { Env } from "../../env";
import { NotAuthorizedError, NotConfiguredError } from "../../env";
import {
  getOuraCredentials,
  getRefreshToken,
  setRefreshToken,
  type OuraCredentials,
} from "../../config";

const AUTHORIZE_URL = "https://cloud.ouraring.com/oauth/authorize";
const TOKEN_URL = "https://api.ouraring.com/oauth/token";

/** Scopes covering the gap metrics: HRV, resting HR, VO2 max (daily); SpO2 (spo2);
 *  personal for profile/timezone. `heartrate` scope is intentionally NOT requested. */
export const OURA_SCOPES = "daily spo2 personal";

const STATE_PREFIX = "oauth_state:";
const STATE_TTL_SECONDS = 600;

interface OuraTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
}

/** The redirect URI for a given request — always this Worker's own /auth/callback. */
export function redirectUriFor(request: Request): string {
  return new URL(request.url).origin + "/auth/callback";
}

/** Build the Oura authorize URL to send the user to (step 1 of connect). */
export async function beginAuthorization(env: Env, redirectUri: string): Promise<string> {
  const creds = await getOuraCredentials(env);
  if (!creds) throw new NotConfiguredError();

  const state = crypto.randomUUID();
  await env.OURA_KV.put(STATE_PREFIX + state, "1", { expirationTtl: STATE_TTL_SECONDS });

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", creds.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", OURA_SCOPES);
  url.searchParams.set("state", state);
  return url.toString();
}

/** Exchange the authorization code for tokens and persist the refresh token (step 2). */
export async function completeAuthorization(
  env: Env,
  code: string,
  state: string,
  redirectUri: string,
): Promise<void> {
  const creds = await getOuraCredentials(env);
  if (!creds) throw new NotConfiguredError();

  const stateKey = STATE_PREFIX + state;
  if (!(await env.OURA_KV.get(stateKey))) throw new Error("Invalid or expired OAuth state.");
  await env.OURA_KV.delete(stateKey);

  const tokens = await postToken(creds, { grant_type: "authorization_code", code, redirect_uri: redirectUri });
  if (!tokens.refresh_token) throw new Error("Oura did not return a refresh token.");
  await setRefreshToken(env, tokens.refresh_token);
}

/**
 * Return a fresh access token, rotating and re-persisting the refresh token.
 * Throws NotConfiguredError (no creds) or NotAuthorizedError (not connected yet).
 */
export async function getAccessToken(env: Env): Promise<string> {
  const creds = await getOuraCredentials(env);
  if (!creds) throw new NotConfiguredError();
  const refresh = await getRefreshToken(env);
  if (!refresh) throw new NotAuthorizedError();

  const tokens = await postToken(creds, { grant_type: "refresh_token", refresh_token: refresh });
  // Oura rotates the refresh token on every use — persist the new one immediately.
  if (tokens.refresh_token) await setRefreshToken(env, tokens.refresh_token);
  return tokens.access_token;
}

async function postToken(creds: OuraCredentials, params: Record<string, string>): Promise<OuraTokenResponse> {
  const body = new URLSearchParams({
    ...params,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Oura token request failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as OuraTokenResponse;
}
