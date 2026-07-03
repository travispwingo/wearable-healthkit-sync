# wearable-healthkit-sync

Automatically import the Oura Ring metrics that Apple Health **doesn't** already
get — **HRV, SpO2, VO2 Max, and Resting Heart Rate** — into Apple HealthKit,
once a day, hands-free, via an iOS Shortcut. Built with a provider seam so other
wearables (Garmin, …) can be added later.

- **Backend:** a tiny [Cloudflare Worker](https://developers.cloudflare.com/workers/) (TypeScript) that holds your Oura OAuth credentials, fetches yesterday's data, normalizes it, and returns a flat JSON payload.
- **Client:** a thin iOS Shortcut that calls the Worker daily and writes each sample into Health with `Log Health Sample`.

---

## Why only those four metrics?

The **official Oura app already syncs** Sleep (with stages), Steps, Heart Rate,
Respiratory Rate, Active Energy, and Workouts to Apple Health natively — turn it
on in **Oura app → Settings → Apple Health**. Re-importing those would duplicate
data and clutter Health with a second source.

What Oura's native sync leaves out is exactly this tool's job:

| Metric | Oura source | HealthKit type · unit | Conversion |
|---|---|---|---|
| **HRV** | `sleep.average_hrv` (RMSSD, ms) | `heartRateVariabilitySDNN` · ms | Raw RMSSD, **no conversion** (see below) |
| **SpO2** | `daily_spo2.spo2_percentage.average` (%) | `oxygenSaturation` · fraction 0–1 | ÷100 (96 → 0.96) |
| **VO2 Max** | `vO2_max.vo2_max` (mL/kg/min) | `vo2Max` · mL/(kg·min) | 1:1 |
| **Resting HR** | `sleep.lowest_heart_rate` (bpm) | `restingHeartRate` · count/min | 1:1 |

### The HRV caveat (read this)

Oura reports HRV as **RMSSD**; Apple Health only has an **SDNN** field. These are
different measures and **there is no valid formula to convert RMSSD to SDNN** (the
ratio depends on the person, recording length, and autonomic state). This tool
writes Oura's **raw RMSSD value into the SDNN field, unchanged**, tagged as coming
from Oura.

**Consequence:** the number is honest RMSSD, but it is *not* comparable to Apple
Watch's HRV (a true, ~60-second SDNN). **Never chart the two together** — you'd get
a meaningless line. This is precisely why Oura's own native sync omits HRV.

*(A more correct alternative — computing a genuine SDNN from Oura's raw
`interbeat_interval` series — is possible and noted under [Roadmap](#roadmap), but
is intentionally out of scope for v1.)*

### Temperature is intentionally skipped

Oura reports temperature only as a **deviation from a personal baseline** (e.g.
−0.3 °C). Apple Health has no "deviation" field — only absolute temperatures — so
any mapping fabricates data. Skipped by design.

---

## How it works

```
iOS Shortcut  ──GET  Authorization: Bearer <APP_SHARED_SECRET>──►  Cloudflare Worker
(daily, thin)                                                        OAuth2 refresh (KV)
  Get Contents of URL                                                normalize (pure fns) ──► Oura API v2
  Get Dictionary from Input     ◄──── grouped JSON ────             group by HealthKit type
  4 × [Repeat → Log Health Sample]
  └─► Apple HealthKit  (on-device write — the only way into Health)
```

Only on-device code can write to HealthKit, so the Worker never touches Health —
it just returns data; the Shortcut does the writing. The response is grouped by
HealthKit type because the Shortcut's `Log Health Sample` action needs one
hard-coded block per metric (its Type field can't be a variable):

```json
{
  "heartRateVariabilitySDNN": [{ "value": 42, "date": "2026-07-03T03:00:00.000Z" }],
  "restingHeartRate":         [{ "value": 52, "date": "2026-07-03T03:00:00.000Z" }],
  "oxygenSaturation":         [{ "value": 0.96, "date": "2026-07-03T12:00:00Z" }],
  "vo2Max":                   [{ "value": 48, "date": "2026-07-03T09:15:00Z" }]
}
```

---

## Setup

### 1. Register an Oura OAuth app

Oura **deprecated Personal Access Tokens in Dec 2025**, so OAuth2 is required.

1. Go to <https://cloud.ouraring.com/oauth/applications> and create an application.
2. Add a **Redirect URI** — your Worker's callback, e.g.
   `https://wearable-healthkit-sync.<you>.workers.dev/auth/callback`
   (and `http://localhost:8787/auth/callback` for local dev).
3. Note the **Client ID** and **Client Secret**.

> A personal app serves up to 10 users before Oura requires approval — fine for
> self-hosting.

### 2. Deploy the Worker

```bash
npm install
npx wrangler login
npx wrangler kv namespace create OURA_KV      # paste the printed id into wrangler.toml
npx wrangler secret put OURA_CLIENT_ID
npx wrangler secret put OURA_CLIENT_SECRET
npx wrangler secret put OURA_REDIRECT_URI     # the https callback from step 1
npx wrangler secret put APP_SHARED_SECRET     # e.g. `openssl rand -hex 32`
npm run deploy
```

### 3. Connect your Oura account (one time)

Visit `https://<your-worker-url>/auth/start` in a browser, approve access, and
you'll see "✅ Connected". This stores a (rotating) refresh token in KV.

Verify the endpoint returns data:

```bash
curl -H "Authorization: Bearer <APP_SHARED_SECRET>" https://<your-worker-url>/
```

### 4. Install & schedule the Shortcut

See **[`shortcut/README.md`](shortcut/README.md)** to import (or rebuild) the
Shortcut, paste your Worker URL + shared secret, grant the four Health
permissions, and set a daily automation.

---

## Local development

```bash
npm test          # unit tests (pure mappers + helpers)
npm run typecheck # tsc --noEmit
cp .dev.vars.example .dev.vars   # fill in values
npm run dev       # wrangler dev on http://localhost:8787
```

You can exercise the full flow locally against `http://localhost:8787/auth/start`
once `.dev.vars` has your Oura client credentials and a matching localhost
redirect URI. For parsing/shape work without a ring, Oura also offers a
[sandbox](https://cloud.ouraring.com/v2/docs) with static demo data.

---

## Idempotency

HealthKit does **not** de-duplicate writes made from Shortcuts. This tool avoids
duplicates structurally: the Worker returns a fixed window (yesterday→today) and
the automation runs once a day, so each night is written once. The Shortcut also
includes an optional "already logged today? then skip" guard (see the Shortcut
guide) against accidental double-runs. Manually re-running for the same day can
still create duplicates.

---

## Extending to other wearables

Adding a provider is one folder + one line:

1. Create `src/providers/<name>/` with an `index.ts` exporting a factory that
   returns a `HealthProvider` (`fetchSamples(range) → HealthSample[]`), plus pure
   `mappers.ts` for that source's conversions.
2. Register it in `src/providers/registry.ts`.

The Worker router and the iOS Shortcut don't change.

**Garmin reality check:** Garmin's official Health API is commercial-only (~$5k).
The only individual route is the unofficial
[`python-garminconnect`](https://github.com/cyberjunky/python-garminconnect) — which
is **ToS-gray and breaks whenever Garmin rotates its auth**, and is Python (so a
Garmin provider would likely be a separate small service). Also, Garmin Connect
already syncs most vitals to Apple Health for free; the only real gap is HRV
series / VO2 Max history / Body Battery. Treat Garmin support as best-effort.

---

## Roadmap

- **Real SDNN from IBI (opt-in):** compute a genuine SDNN from Oura's raw
  `/v2/usercollection/interbeat_interval` series (windowed to ~60 s to mirror
  Apple Watch), instead of storing raw RMSSD. Depends on IBI coverage/quality.
- **Missed-day catch-up:** a KV-stored cursor so a skipped day is backfilled on the
  next run.
- **Optional daily scores** (readiness/sleep/activity) as informational samples.

---

## Prior art & thanks

- [`James-2879/OuraAppleHealth`](https://github.com/James-2879/OuraAppleHealth) — the
  canonical Shortcuts approach for the same gap metrics (this project adds the
  OAuth2 backend it predates).
- [Open Wearables](https://openwearables.io) — normalized multi-wearable schema
  conventions (`hrv_rmssd_ms`, …).

## License

MIT — see [LICENSE](LICENSE).
