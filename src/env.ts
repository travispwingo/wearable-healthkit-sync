/**
 * Worker bindings & secrets.
 *
 * Most configuration now lives in KV, seeded by the /setup wizard (so a
 * non-technical user never touches the CLI). The only deploy-time secret is
 * SETUP_PASSWORD, which gates that wizard. The OURA_* / APP_SHARED_SECRET vars
 * remain as an optional advanced/CLI fallback (see src/config.ts) and for local
 * dev via `.dev.vars`.
 */
export interface Env {
  /** KV namespace: Oura config, rotating refresh token, app token, OAuth state. */
  OURA_KV: KVNamespace;

  /** Deploy-time secret that gates the /setup wizard. Set via the deploy button
   *  prompt or the Cloudflare dashboard. */
  SETUP_PASSWORD?: string;

  /** "true" (default) → SpO2 written as fraction 0–1; "false" → raw percent. */
  SPO2_AS_FRACTION?: string;
  /** Optional override, e.g. the Oura sandbox base, for local testing. */
  OURA_API_BASE?: string;

  // --- Optional advanced/CLI fallback (used only if the KV values are absent) ---
  OURA_CLIENT_ID?: string;
  OURA_CLIENT_SECRET?: string;
  /** Legacy fixed sync token; the wizard auto-generates one in KV instead. */
  APP_SHARED_SECRET?: string;
}

/** Thrown when Oura isn't connected yet — the user must finish /setup. */
export class NotAuthorizedError extends Error {
  constructor() {
    super("Oura is not connected yet. Open /setup to finish connecting your Oura account.");
    this.name = "NotAuthorizedError";
  }
}

/** Thrown when the backend has no Oura app credentials configured. */
export class NotConfiguredError extends Error {
  constructor() {
    super("Backend is not configured. Open /setup to add your Oura API credentials.");
    this.name = "NotConfiguredError";
  }
}

/** Non-2xx response from the Oura API. */
export class OuraApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`Oura API error ${status}: ${body.slice(0, 300)}`);
    this.name = "OuraApiError";
  }
}
