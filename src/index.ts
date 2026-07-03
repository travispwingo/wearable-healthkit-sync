/**
 * Cloudflare Worker entry point.
 *
 * Routes:
 *   GET /            — the sync endpoint the iOS Shortcut calls (auth required).
 *   GET /sync        — alias of /.
 *   GET /auth/start  — one-time: redirect to Oura to grant access.
 *   GET /auth/callback — one-time: exchange the code, store the refresh token.
 *   GET /health      — unauthenticated liveness check.
 *
 * The sync response is a JSON object keyed by HealthKit sample type, each an
 * array of { value, date }. It is grouped by type because the Shortcut's
 * "Log Health Sample" action needs one hard-coded block per metric type.
 */
import type { Env } from "./env";
import { NotAuthorizedError, OuraApiError } from "./env";
import { isAuthorized } from "./auth";
import type { DateRange, HealthSample } from "./providers/types";
import { getProviderFactory } from "./providers/registry";
import { beginAuthorization, completeAuthorization } from "./providers/oura/oauth";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/auth/start":
          return Response.redirect(await beginAuthorization(env), 302);
        case "/auth/callback":
          // `await` so async rejections are caught by this try/catch, not wrangler's.
          return await handleAuthCallback(url, env);
        case "/health":
          return json({ ok: true });
        case "/":
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
  if (!(await isAuthorized(request, env.APP_SHARED_SECRET))) {
    return json({ error: "unauthorized" }, 401);
  }

  const providerId = url.searchParams.get("provider") ?? "oura";
  const factory = getProviderFactory(providerId);
  if (!factory) {
    return json({ error: `unknown provider: ${providerId}` }, 400);
  }

  const range = resolveRange(url, new Date());
  const provider = await factory(env);
  const samples = await provider.fetchSamples(range);
  return json(groupByType(samples));
}

async function handleAuthCallback(url: URL, env: Env): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  if (error) return html(`<h1>Authorization failed</h1><p>${escapeHtml(error)}</p>`, 400);
  if (!code || !state) return html("<h1>Missing code or state</h1>", 400);

  await completeAuthorization(env, code, state);
  return html(
    "<h1>✅ Connected</h1><p>Your Oura account is linked. You can close this tab and run the Shortcut.</p>",
  );
}

/** Determine the query window. Defaults to yesterday→today (UTC), which reliably
 *  captures last night regardless of Oura's wake-day dating. Overridable with
 *  ?start=YYYY-MM-DD&end=YYYY-MM-DD or ?days=N (start = today-N, end = today). */
export function resolveRange(url: URL, now: Date): DateRange {
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  if (start && end) return { start, end };

  const daysParam = url.searchParams.get("days");
  const days = daysParam ? Math.max(0, parseInt(daysParam, 10) || 0) : 1;
  return {
    start: ymd(new Date(now.getTime() - days * 86_400_000)),
    end: ymd(now),
  };
}

export function groupByType(samples: HealthSample[]): Record<string, { value: number; date: string }[]> {
  const out: Record<string, { value: number; date: string }[]> = {};
  for (const s of samples) {
    (out[s.type] ??= []).push({ value: s.value, date: s.date });
  }
  return out;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function handleError(err: unknown): Response {
  if (err instanceof NotAuthorizedError) return json({ error: err.message }, 409);
  if (err instanceof OuraApiError) return json({ error: err.message }, 502);
  const message = err instanceof Error ? err.message : "internal error";
  return json({ error: message }, 500);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function html(body: string, status = 200): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:2rem">${body}</body>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
