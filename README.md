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
iOS Shortcut  ──GET  /sync?k=<your key>  (capability URL)──►  Cloudflare Worker
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

## Setup — no terminal required

You self-host your own copy. There's **no CLI**: deploy with a button, then finish
in a browser wizard. Two steps are unavoidable (platform limits, not this tool):
creating your own free Oura API app, and adding the daily automation on your iPhone.

### 1. Deploy the Worker

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/travispwingo/wearable-healthkit-sync)

Click the button → sign in / sign up for a **free Cloudflare account** → authorize
the Cloudflare app on your **GitHub** account (it copies the repo there) → when
prompted, choose a **Setup Password** (`SETUP_PASSWORD`) → **Deploy**. Cloudflare
auto-creates the KV namespace. You'll get a Worker URL like
`https://wearable-healthkit-sync.<you>.workers.dev`.

### 2. Finish in the browser wizard

Open your Worker URL — it lands on the **setup wizard**. Enter your Setup Password,
then:

1. **Create a free Oura API app.** The wizard shows the exact **Redirect URI** to
   paste (it's your own Worker's `/auth/callback`) and links to Oura's
   [applications page](https://cloud.ouraring.com/oauth/applications). Paste the
   **Client ID** and **Client Secret** back into the wizard. *(Oura deprecated
   Personal Access Tokens in Dec 2025 and doesn't allow a shared app, so each
   self-hoster registers their own — a personal app serves up to 10 users with no
   approval.)*
2. **Sign in with Oura** — one click; stores a rotating refresh token.
3. **Copy your personal sync link** and add the iPhone Shortcut (next step).

### 3. Add the iPhone Shortcut

The wizard gives you a **single personal sync link** (your Worker URL with your
key in it) and a link to add the Shortcut. See
**[`shortcut/README.md`](shortcut/README.md)**: you tap to add the Shortcut, paste
that one link when it asks, grant the four Health permissions once, and set a
once-a-day automation (the illustrated ~10-tap step that can't be automated).

> **Requires:** a free Cloudflare account, a GitHub account, and an active Oura
> membership (Oura requires membership for API access on current rings).

---

## Local development

```bash
npm test          # unit tests (pure mappers + helpers)
npm run typecheck # tsc --noEmit
cp .dev.vars.example .dev.vars   # fill in values
npm run dev       # wrangler dev on http://localhost:8787
```

Set `SETUP_PASSWORD` in `.dev.vars`, then open `http://localhost:8787/setup` and
run the wizard locally (register a throwaway Oura app with a
`http://localhost:8787/auth/callback` redirect URI). Config is stored in local KV.
For parsing/shape work without a ring, Oura also offers a
[sandbox](https://cloud.ouraring.com/v2/docs) with static demo data
(point `OURA_API_BASE` at it).

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
