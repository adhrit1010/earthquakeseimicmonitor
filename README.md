# TremorLab — TriAxis Dynamic Station

A full-stack dashboard for a three-axis seismic monitoring station. An ESP32 with
three IMUs (ADXL345, LIS3DH, MPU6050) streams detections to Supabase; this app
reads that data server-side, summarizes it, and serves a live dashboard with an
AI station analyst you can ask questions like *"what was the strongest event?"*

No Supabase or OpenAI keys are ever sent to the browser — the Python backend is
the only thing that talks to either service.

## How it fits together

```text
triaxis_dynamic_site/
  server.py              Standard-library Python backend (no dependencies)
  api/                   Thin wrappers so the same handler also works as
    agent.py             Vercel serverless functions (one file per route)
    analytics.py
    events.py
    status.py
  public/
    index.html            Dashboard markup
    styles.css            Visual design (the "instrument panel" look)
    app.js                Fetches from /api/*, draws charts, runs the chat
  supabase_schema.sql     Run once in the Supabase SQL editor to create tables
  .env.example            Copy to .env and fill in your keys
  vercel.json              Deployment config if you host this on Vercel
```

The same `server.py` file works two ways:
- **Locally**, `python server.py` starts one process that serves both the
  static frontend and the `/api/*` routes.
- **On Vercel**, each file in `api/` is deployed as its own serverless
  function and imports the shared `AppHandler` from `server.py`.

You don't need to touch `api/*.py` — they're one-line wrappers and exist only
for the Vercel deployment path.

## Setup

1. Copy the example environment file:
```bash
   cp .env.example .env
```
2. In Supabase, go to **Project Settings → API** and copy:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY` (the public anon key)

   Paste both into `.env`.
3. Run `supabase_schema.sql` once in the Supabase SQL editor (Dashboard →
   SQL Editor → paste the file → Run). This creates three tables:
   `station_live`, `earthquake_history`, `station_waveform`, with row-level
   security policies that let the ESP32 write to them anonymously.
4. *(Optional)* Add `OPENAI_API_KEY` to `.env` if you want the AI agent to
   use a real language model instead of the built-in rule-based analyst.
   The dashboard works fully without this — see [AI agent behavior](#ai-agent-behavior).
5. *(Optional)* If you'd rather the backend read Supabase with elevated
   permissions instead of the public anon key, set
   `SUPABASE_SERVICE_ROLE_KEY` in `.env`. **Never put the service role key
   anywhere in `public/`** — it must only exist server-side.

## Run it locally

From this folder:

```bash
python server.py
```

Then open:

```text
http://127.0.0.1:8787
```

The port is configurable via `PORT` in `.env` (defaults to `8787`).

### What you should see

- The status pill in the top-right corner turns green once Supabase is
  configured. If it stays amber/red, check the message under it — it
  echoes the backend's error verbatim (usually a missing or malformed
  `.env` value).
- The live trace strip at the top animates immediately, using your most
  recent STA/LTA samples once data loads (and gentle simulated drift before
  that, so the page never looks frozen).
- If no `earthquake_history` rows exist yet, the dashboard falls back to
  whatever is in `station_live` — useful for watching the station in
  real time before you've logged any confirmed events.

## API reference

All routes are served from the same origin as the dashboard.

| Method | Route | Returns |
|---|---|---|
| `GET` | `/api/status` | Whether Supabase/OpenAI are configured, and which model is active |
| `GET` | `/api/events` | Raw event rows, optionally filtered |
| `GET` | `/api/analytics` | Same rows, plus a computed `summary` object (peak PGA, quality score, etc.) |
| `POST` | `/api/agent` | Natural-language answer from the station analyst |

`/api/events` and `/api/analytics` accept the same query parameters:

| Param | Example | Effect |
|---|---|---|
| `from` | `2026-06-01` | Only events on/after this date |
| `to` | `2026-06-20` | Only events on/before this date |
| `classification` | `Confirmed Seismic Event` | Exact match on the classification field |
| `limit` | `500` | Max rows returned (default 500) |

`POST /api/agent` body:

```json
{
  "message": "What was the strongest event?",
  "filters": { "classification": "Confirmed Seismic Event" }
}
```

Response:

```json
{
  "answer": "...",
  "summary": { "...": "the same summary object /api/analytics returns" },
  "usedOpenAI": true
}
```

## AI agent behavior

Every question is answered from the currently loaded station data — the
agent never claims general earthquake knowledge beyond what's in your
Supabase tables.

- **With `OPENAI_API_KEY` set:** the backend sends a compact JSON summary
  (the computed stats plus the 25 most recent events) to the OpenAI
  Responses API and returns its answer.
- **Without it:** a local, deterministic analyst answers using simple
  keyword matching — no network call, no API cost, works offline. It
  covers the same ground: strongest event, validation error, sensor
  agreement, threshold tuning, and general summaries.
- **If the OpenAI call fails** (bad key, network issue, rate limit), the
  backend automatically falls back to the local analyst and prefixes the
  answer so you know it happened.

Try the five quick-question buttons in the dashboard to see the range of
what it can answer, or type your own.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Status pill stays red, message says "Supabase is not configured" | `.env` is missing, or `SUPABASE_URL`/`SUPABASE_ANON_KEY` weren't filled in |
| Status pill is green but the table says "No matching events" | Your date/classification filters are excluding everything — clear them and hit Refresh |
| Charts are blank but the table has rows | A field used by that chart (e.g. `pga`, `magnitude`) is `-1` or missing on every row — check what your ESP32 is writing to Supabase |
| Agent always uses the local analyst even with `OPENAI_API_KEY` set | Check `server.out.log` / your terminal output for an `AI request failed` message — the backend logs the underlying error there |
| `python server.py` exits immediately | Another process is already using the port in `.env` — change `PORT` or stop the other process |

## Notes on the sensors

The dashboard expects three independent STA/LTA ratios per event
(`adxl345_stalta`, `lis3dh_stalta`, `mpu6050_stalta`). These come from the
ESP32 running adaptive STA/LTA detection per sensor, so a single shake
producing agreement across all three is a much stronger signal than any
one sensor alone — that's what the "Sensor agreement" quick-question on
the AI agent is checking for.
