# The iOS Shortcut

The Shortcut is deliberately thin: it calls your Worker, then writes each returned
sample into Apple Health. Because Apple Shortcut files are an opaque binary format
(not diffable, and importing third-party ones requires lowering a security
setting), the **durable, trustworthy artifact is the build recipe below** — you can
reconstruct the Shortcut from scratch in a few minutes.

> **Maintainer:** after building it, export via **Share → Copy iCloud Link**, add
> the link here, and commit the exported `Oura-to-Health.shortcut` alongside this
> file as a convenience.
>
> **iCloud link:** _add yours here_

---

## What it does

1. `GET` your **personal sync link** (a single URL with your key baked in — the
   setup wizard gives it to you, e.g. `https://…workers.dev/sync?k=abc123…`).
   Nothing else to paste; no separate header or secret.
2. Parse the JSON (an object keyed by HealthKit type → array of `{ value, date }`).
3. For each of the four metric types, loop the array and `Log Health Sample`.

The response is grouped by type on purpose: `Log Health Sample`'s **Type** field is
a fixed picker (it can't be a variable), so there's one small block per metric.

---

## Build it (≈5 min)

Create a new Shortcut and add these actions in order. **Name it something clear like
“Oura → Health”** so it's obvious in your Shortcuts and Automations lists. (Heads-up:
this names the *shortcut*, not the Health data source — Apple Health attributes
anything written via Shortcuts to the **“Shortcuts”** source regardless of the name.
That's still enough to tell Oura's HRV apart from your Apple Watch's true SDNN, which
shows as **“Apple Watch”** — see [the HRV caveat](../README.md#the-hrv-caveat-read-this)
in the main README.)

**A. Configuration (one value, asked on import)**
1. **Text** → paste your personal sync link here as a placeholder. Set a variable
   named `SyncURL` from it.
   - So users never edit the action: **Setup → Add New Question**, point it at this
     Text action, question = *"Paste your personal sync link"*. On import, the user
     just pastes the one link — no action editing.

**B. Fetch**
2. **Get Contents of URL**
   - URL: `SyncURL`
   - Method: **GET** (the key is in the URL, so no headers are needed)
3. **Get Dictionary from Input** (parses the JSON response).

**C. Write each metric** — repeat this 4-action pattern once per metric, changing
only the **key** and the **Log Health Sample → Type**:

| Dictionary key | Log Health Sample → Type |
|---|---|
| `heartRateVariabilitySDNN` | Heart Rate Variability |
| `restingHeartRate` | Resting Heart Rate |
| `oxygenSaturation` | Blood Oxygen |
| `vo2Max` | VO2 Max |

For each:
4. **Get Dictionary Value** → Get **Value** for **key** (e.g. `heartRateVariabilitySDNN`)
   from the parsed dictionary (step 3). This yields the array of samples.
5. **Repeat with Each** (that array):
   1. **Get Dictionary Value** → `value` from **Repeat Item**.
   2. **Get Dictionary Value** → `date` from **Repeat Item**.
   3. *(recommended)* **Get Dates from Input** (or **Format Date**) on the `date`
      text, so the next step gets a real Date rather than a string.
   4. **Log Health Sample** → **Type** = *(from the table)*, **Value** = the `value`,
      **Date** = the parsed date.

That's four `Get Dictionary Value` + `Repeat` groups. Done.

---

## First run & permissions

Run the Shortcut manually once. iOS will prompt to **allow writing each Health
data type** — allow all four. (If a type was denied, enable it in
**Health → Profile → Apps and Services → Shortcuts**, then re-run.) After the
one-time grant, the automation runs silently.

Confirm the samples appear in the **Health** app with sensible values and dates.

### Verify SpO2 representation

HealthKit stores oxygen saturation as a fraction `0–1`, and the Worker sends `0.96`
by default. If Health shows your blood oxygen as **96 %**, you're set. If it shows
something wrong (e.g. `0 %` or `9600 %`), set the Worker var `SPO2_AS_FRACTION` to
`false` (redeploy) so it sends the raw percent instead — no Shortcut change needed.

---

## Schedule it (unattended, daily)

In the **Shortcuts** app → **Automation** tab → **＋** → **Create Personal
Automation** → **Time of Day**:

- Pick a time **after** you normally open the Oura app in the morning (the Shortcut
  can only pull a night once Oura has synced it) — e.g. **9:00 AM**.
- Choose your Shortcut.
- Turn **Run Immediately** on, and **Ask Before Running** / **Notify When Run** off,
  so it runs with no tap.

> Time automations are most reliable when the phone is unlocked/awake around the
> scheduled time. If yours is flaky, nudge the time to when you're typically using
> the phone.

---

## Optional: avoid duplicate writes

To guard against an accidental double-run, add before each `Repeat` (step 5):

- **Find Health Samples** where **Type** = *(the metric)*, **Start Date** is
  **Today**, filtered to source *Shortcuts* → **Count**.
- **If** Count **is** `0`, run the `Repeat`; otherwise skip.

The once-daily + fixed-window design already prevents duplicates in normal
operation, so this is belt-and-suspenders.
