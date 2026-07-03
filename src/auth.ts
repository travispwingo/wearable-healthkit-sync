/**
 * Constant-time credential checks.
 *
 * - The sync endpoint accepts the app token either as `?k=<token>` (the
 *   "capability URL" the Shortcut uses — one link, nothing else to paste) or as
 *   an `Authorization: Bearer <token>` header.
 * - The /setup wizard is gated by SETUP_PASSWORD, sent as an `X-Setup-Password`
 *   header from the wizard's inline JS.
 *
 * Comparisons run over SHA-256 digests so neither value nor length leaks via timing.
 */

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  // a and b are always 32 bytes (SHA-256), so length never differs.
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

async function constantTimeEquals(provided: string, expected: string): Promise<boolean> {
  if (!expected) return false;
  const [pa, pb] = await Promise.all([sha256(provided), sha256(expected)]);
  return timingSafeEqual(pa, pb);
}

function bearer(request: Request): string {
  const match = (request.headers.get("Authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? "";
}

/** Sync-endpoint auth: `?k=<token>` query param or Bearer header. */
export async function checkAppToken(request: Request, url: URL, expected: string): Promise<boolean> {
  const provided = url.searchParams.get("k") ?? bearer(request);
  return constantTimeEquals(provided, expected);
}

/** Wizard auth: `X-Setup-Password` header vs the SETUP_PASSWORD secret. */
export async function checkSetupPassword(request: Request, expected: string | undefined): Promise<boolean> {
  return constantTimeEquals(request.headers.get("X-Setup-Password") ?? "", expected ?? "");
}
