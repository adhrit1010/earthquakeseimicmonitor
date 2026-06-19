# TriAxis Dynamic Website + AI Agent

This replaces the static analytics page with a full-stack website:

- Python backend server
- Dynamic frontend
- Server-side Supabase access
- Server-side OpenAI AI agent
- No API keys exposed in browser code

## Files

```text
triaxis_dynamic_site/
  server.py
  .env.example
  public/
    index.html
    styles.css
    app.js
```

## Setup

1. Copy `.env.example` to `.env`.
2. Fill in:

```text
SUPABASE_URL
SUPABASE_ANON_KEY
OPENAI_API_KEY
```

Optional:

```text
SUPABASE_SERVICE_ROLE_KEY
```

Use the service role key only on this backend server. Never place it inside browser HTML.

## Run

From this folder:

```bash
python server.py
```

Then open:

```text
http://127.0.0.1:8787
```

## API Endpoints

```text
GET  /api/status
GET  /api/events
GET  /api/analytics
POST /api/agent
```

Example agent body:

```json
{
  "message": "What was the strongest event?",
  "filters": {
    "classification": "Confirmed Seismic Event"
  }
}
```

## AI Agent Behavior

The backend sends the loaded seismic data summary and latest rows to OpenAI using the Responses API.

If `OPENAI_API_KEY` is not configured, the app still works with a local rule-based analyst.

The agent can answer:

- strongest event
- PGA/magnitude summaries
- validation quality
- sensor agreement
- threshold tuning suggestions
- whether more data is needed

