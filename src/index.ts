/**
 * Cloudflare Worker entry point.
 *
 * Routes:
 *   GET  /                    — redirect to the setup wizard.
 *   GET  /setup               — the browser setup wizard (no CLI needed).
 *   POST /setup/status|oura|authorize-url — wizard actions (gated by SETUP_PASSWORD).
 *   GET  /auth/callback       — OAuth return; stores the refresh token.
 *   GET  /sync?k=<token>      — the endpoint the iOS Shortcut calls (capability URL).
 *   GET  /health              — unauthenticated liveness check.
 *
 * /sync returns a JSON object keyed by HealthKit sample type, each an array of
 * { value, date } — grouped because the Shortcut's "Log Health Sample" needs one
 * block per metric type.
 */
import type { Env } from "./env";
import { NotAuthorizedError, NotConfiguredError, OuraApiError } from "./env";
import { checkAppToken } from "./auth";
import { getOrCreateAppToken } from "./config";
import type { DateRange, HealthSample } from "./providers/types";
import { getProviderFactory } from "./providers/registry";
import { completeAuthorization, redirectUriFor } from "./providers/oura/oauth";
import { handleSetupAuthorizeUrl, handleSetupSaveOura, handleSetupStatus, renderSetupPage } from "./setup";
import { escapeHtml, html, json } from "./http";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/":
          return Response.redirect(url.origin + "/setup", 302);
        case "/setup":
          return renderSetupPage();
        case "/setup/status":
          return await handleSetupStatus(request, env);
        case "/setup/oura":
          return await handleSetupSaveOura(request, env);
        case "/setup/authorize-url":
          return await handleSetupAuthorizeUrl(request, env);
        case "/auth/callback":
          return await handleAuthCallback(request, url, env);
        case "/health":
          return json({ ok: true });
        case "/sync":
          return await handleSync(request, url, env);
        default:
          return new Response("Not found", { status: 404 });
      }
    } catch (err) {
      return handleError(err);
    }
  },
};

async function handleSync(request: Request, url: URL, env: Env): Promise<Response> {
  const expected = await getOrCreateAppToken(env);
  if (!(await checkAppToken(request, url, expected))) {
    return json({ error: "unauthorized" }, 401);
  }

  const providerId = url.searchParams.get("provider") ?? "oura";
  const factory = getProviderFactory(providerId);
  if (!factory) return json({ error: `unknown provider: ${providerId}` }, 400);

  const range = resolveRange(url, new Date());
  const provider = await factory(env);
  const samples = await provider.fetchSamples(range);
  return json(groupByType(samples));
}

async function handleAuthCallback(request: Request, url: URL, env: Env): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  if (error) return html(page(`<h1>Authorization failed</h1><p>${escapeHtml(error)}</p>`), 400);
  if (!code || !state) return html(page("<h1>Missing code or state</h1>"), 400);

  await completeAuthorization(env, code, state, redirectUriFor(request));
  // Back to the wizard; its JS re-reads status (password is in sessionStorage).
  return Response.redirect(url.origin + "/setup?connected=1", 302);
}

/** Query window. Defaults to yesterday→today (UTC), which reliably captures last
 *  night regardless of Oura's wake-day dating. Override with ?start&end or ?days=N. */
export function resolveRange(url: URL, now: Date): DateRange {
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  if (start && end) return { start, end };
  const daysParam = url.searchParams.get("days");
  const days = daysParam ? Math.max(0, parseInt(daysParam, 10) || 0) : 1;
  return { start: ymd(new Date(now.getTime() - days * 86_400_000)), end: ymd(now) };
}

export function groupByType(samples: HealthSample[]): Record<string, { value: number; date: string }[]> {
  const out: Record<string, { value: number; date: string }[]> = {};
  for (const s of samples) (out[s.type] ??= []).push({ value: s.value, date: s.date });
  return out;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function handleError(err: unknown): Response {
  if (err instanceof NotConfiguredError || err instanceof NotAuthorizedError) {
    return json({ error: err.message }, 409);
  }
  if (err instanceof OuraApiError) return json({ error: err.message }, 502);
  return json({ error: err instanceof Error ? err.message : "internal error" }, 500);
}

function page(body: string): string {
  return `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:2rem">${body}</body>`;
}
