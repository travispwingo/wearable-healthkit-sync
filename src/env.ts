/** Worker bindings & secrets. Secrets are set via `wrangler secret put`; for
 *  local dev they come from `.dev.vars` (see .dev.vars.example). */
export interface Env {
  /** KV namespace holding the rotating Oura refresh token and transient OAuth state. */
  OURA_KV: KVNamespace;
  OURA_CLIENT_ID: string;
  OURA_CLIENT_SECRET: string;
  /** Must exactly match a redirect URI registered on the Oura OAuth app. */
  OURA_REDIRECT_URI: string;
  /** Shared secret the iOS Shortcut sends as `Authorization: Bearer <secret>`. */
  APP_SHARED_SECRET: string;
  /** "true" (default) → SpO2 written as fraction 0–1; "false" → raw percent. */
  SPO2_AS_FRACTION?: string;
  /** Optional override, e.g. the Oura sandbox base, for local testing. */
  OURA_API_BASE?: string;
}

/** Thrown when no refresh token is stored yet — the user must run /auth/start. */
export class NotAuthorizedError extends Error {
  constructor() {
    super("No Oura refresh token stored. Visit /auth/start to connect your Oura account.");
    this.name = "NotAuthorizedError";
  }
}

/** Non-2xx response from the Oura API. */
export class OuraApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`Oura API error ${status}: ${body.slice(0, 300)}`);
    this.name = "OuraApiError";
  }
}
