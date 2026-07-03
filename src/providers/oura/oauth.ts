/**
 * Oura OAuth2 (authorization-code flow) + token refresh.
 *
 * Oura deprecated Personal Access Tokens in Dec 2025, so OAuth2 is the only path.
 * The refresh token is SINGLE-USE / ROTATING: every refresh returns a new refresh
 * token and invalidates the old one, so we must persist the new one each time.
 *
 * KV keys:
 *   oura_refresh_token  — the long-lived (rotating) refresh token
 *   oauth_state:<state> — transient CSRF state during the one-time connect flow
 */
import type { Env } from "../../env";
import { NotAuthorizedError } from "../../env";

const AUTHORIZE_URL = "https://cloud.ouraring.com/oauth/authorize";
const TOKEN_URL = "https://api.ouraring.com/oauth/token";

/** Scopes covering the gap metrics: HRV, resting HR, VO2 max (daily); SpO2 (spo2);
 *  personal for profile/timezone. `heartrate` scope is intentionally NOT requested. */
export const OURA_SCOPES = "daily spo2 personal";

const REFRESH_KEY = "oura_refresh_token";
const STATE_PREFIX = "oauth_state:";
const STATE_TTL_SECONDS = 600;

interface OuraTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
}

/** Build the URL to send the user to, to grant access (step 1 of connect). */
export async function beginAuthorization(env: Env): Promise<string> {
  const state = crypto.randomUUID();
  await env.OURA_KV.put(STATE_PREFIX + state, "1", { expirationTtl: STATE_TTL_SECONDS });
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.OURA_CLIENT_ID);
  url.searchParams.set("redirect_uri", env.OURA_REDIRECT_URI);
  url.searchParams.set("scope", OURA_SCOPES);
  url.searchParams.set("state", state);
  return url.toString();
}

/** Exchange the authorization code for tokens and persist the refresh token (step 2). */
export async function completeAuthorization(env: Env, code: string, state: string): Promise<void> {
  const stateKey = STATE_PREFIX + state;
  const stored = await env.OURA_KV.get(stateKey);
  if (!stored) throw new Error("Invalid or expired OAuth state.");
  await env.OURA_KV.delete(stateKey);

  const tokens = await postToken(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: env.OURA_REDIRECT_URI,
  });
  if (!tokens.refresh_token) throw new Error("Oura did not return a refresh token.");
  await env.OURA_KV.put(REFRESH_KEY, tokens.refresh_token);
}

/**
 * Return a fresh access token, rotating and re-persisting the refresh token.
 * Throws NotAuthorizedError if the connect flow hasn't been run.
 */
export async function getAccessToken(env: Env): Promise<string> {
  const refresh = await env.OURA_KV.get(REFRESH_KEY);
  if (!refresh) throw new NotAuthorizedError();
  const tokens = await postToken(env, { grant_type: "refresh_token", refresh_token: refresh });
  // Oura rotates the refresh token on every use — persist the new one immediately.
  if (tokens.refresh_token) {
    await env.OURA_KV.put(REFRESH_KEY, tokens.refresh_token);
  }
  return tokens.access_token;
}

async function postToken(env: Env, params: Record<string, string>): Promise<OuraTokenResponse> {
  const body = new URLSearchParams({
    ...params,
    client_id: env.OURA_CLIENT_ID,
    client_secret: env.OURA_CLIENT_SECRET,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Oura token request failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as OuraTokenResponse;
}
