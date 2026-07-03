/** Shared-secret check for the sync endpoint. The Shortcut sends the secret as
 *  `Authorization: Bearer <APP_SHARED_SECRET>`. Compared in constant time over
 *  SHA-256 digests so neither the value nor its length leaks via timing. */

function extractBearer(request: Request): string {
  const header = request.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? "";
}

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

export async function isAuthorized(request: Request, expected: string): Promise<boolean> {
  if (!expected) return false;
  const provided = extractBearer(request);
  const [pa, pb] = await Promise.all([sha256(provided), sha256(expected)]);
  return timingSafeEqual(pa, pb);
}
