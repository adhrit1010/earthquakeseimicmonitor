#!/usr/bin/env python3
"""
TriAxis Dynamic Website Backend

Pure Python standard-library backend:
- Serves the frontend from ./public
- Reads Supabase data server-side
- Provides analytics endpoints
- Provides a secure AI agent endpoint using OpenAI Responses API

No API keys are exposed to the browser.

This module exposes plain functions (get_status, get_events, get_analytics,
post_agent) that contain all the logic, plus:
  - AppHandler: a BaseHTTPRequestHandler for local `python server.py` runs
  - app: a WSGI application for Vercel's Python runtime (api/*.py import this)
"""

from __future__ import annotations

import json
import mimetypes
import os
import ssl
import sys
import traceback
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlparse, parse_qs
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError


ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"


def load_env() -> None:
    env_file = ROOT / ".env"
    if not env_file.exists():
        return
    for raw in env_file.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


load_env()


SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY", "")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-5.5")
PORT = int(os.getenv("PORT", "8787"))


def http_json(url: str, headers: dict[str, str], method: str = "GET", body: Any = None) -> Any:
    encoded_body = None
    if body is not None:
        encoded_body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers = {**headers, "Content-Type": "application/json"}
    req = Request(url, data=encoded_body, headers=headers, method=method)
    context = ssl.create_default_context()
    try:
        with urlopen(req, timeout=18, context=context) as response:
            text = response.read().decode("utf-8")
            return json.loads(text) if text else None
    except HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            payload = {}
        message = payload.get("message") if isinstance(payload, dict) else ""
        code = payload.get("code") if isinstance(payload, dict) else ""
        detail = f"{code}: {message}" if code and message else message or raw or exc.reason
        raise RuntimeError(f"Supabase/OpenAI HTTP {exc.code}: {detail}") from exc


def supabase_headers() -> dict[str, str]:
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError("Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY.")
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Accept": "application/json",
    }


def iso_from_timestamp_ms(value: Any, fallback: Any = None) -> str:
    if fallback:
        return str(fallback)
    try:
        ms = int(value)
        if ms > 0:
            return datetime.utcfromtimestamp(ms / 1000).isoformat() + "Z"
    except (TypeError, ValueError, OSError):
        pass
    return datetime.utcnow().isoformat() + "Z"


def estimate_mmi(pga: float) -> float:
    if pga < 0:
        return -1
    if pga < 1:
        return 1
    if pga < 3:
        return 2
    if pga < 8:
        return 3
    if pga < 25:
        return 4
    if pga < 80:
        return 5
    if pga < 250:
        return 6
    if pga < 400:
        return 7
    return 8


def safe_num(value: Any, default: float = -1.0) -> float:
    try:
        if value is None:
            return default
        return float(value)
    except (TypeError, ValueError):
        return default

def pearson_correlation(a: list[float], b: list[float]) -> float:
    """Pearson correlation coefficient between two equal-length lists.
    Returns 0 if either series has no variance or fewer than 2 points."""
    n = len(a)
    if n < 2 or n != len(b):
        return 0.0
    mean_a = sum(a) / n
    mean_b = sum(b) / n
    cov = sum((a[i] - mean_a) * (b[i] - mean_b) for i in range(n))
    var_a = sum((x - mean_a) ** 2 for x in a)
    var_b = sum((x - mean_b) ** 2 for x in b)
    denom = (var_a * var_b) ** 0.5
    if denom == 0:
        return 0.0
    return max(-1.0, min(1.0, cov / denom))


def sensor_agreement(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Pairwise correlation between the three STA/LTA channels, plus a single
    0-100 agreement score. Only uses rows where all three channels are
    present (>= 0); falls back to 'insufficient data' below 3 such rows."""
    adxl, lis, mpu = [], [], []
    for r in rows:
        a = safe_num(r.get("adxl345_stalta"), -1)
        l = safe_num(r.get("lis3dh_stalta"), -1)
        m = safe_num(r.get("mpu6050_stalta"), -1)
        if a >= 0 and l >= 0 and m >= 0:
            adxl.append(a)
            lis.append(l)
            mpu.append(m)

    if len(adxl) < 3:
        return {
            "available": False,
            "sampleSize": len(adxl),
            "agreementScore": None,
            "pairwise": None,
        }

    r_al = pearson_correlation(adxl, lis)
    r_am = pearson_correlation(adxl, mpu)
    r_lm = pearson_correlation(lis, mpu)
    avg_r = (r_al + r_am + r_lm) / 3
    # Map correlation [-1, 1] to a 0-100 agreement score, clamped.
    agreement_score = max(0.0, min(100.0, (avg_r + 1) * 50))

    return {
        "available": True,
        "sampleSize": len(adxl),
        "agreementScore": agreement_score,
        "pairwise": {
            "adxl345_lis3dh": r_al,
            "adxl345_mpu6050": r_am,
            "lis3dh_mpu6050": r_lm,
        },
    }


def wave_quality_score(row: dict[str, Any]) -> float:
    """0-100 score for how clean a P/S detection looks, from timing and
    validation error. Returns -1 if there isn't enough info to judge."""
    p_ms = safe_num(row.get("p_wave_ms"), -1)
    s_ms = safe_num(row.get("s_wave_ms"), -1)
    validation_error = safe_num(row.get("validation_error"), -1)
    if p_ms < 0 or s_ms < 0:
        return -1
    gap = s_ms - p_ms
    # A physically plausible P-S gap for a near-field demo rig is treated as
    # a positive signal; an inverted or zero gap is treated as noise.
    timing_score = 100.0 if gap > 0 else 30.0
    if validation_error >= 0:
        timing_score = max(0.0, timing_score - validation_error * 0.5)
    return max(0.0, min(100.0, timing_score))


def seismic_confidence(rows: list[dict[str, Any]], agreement: dict[str, Any]) -> dict[str, Any]:
    """Composite 0-100 confidence score blending sensor agreement, STA/LTA
    strength, and P/S wave quality across the loaded window. This is a
    heuristic for a demo rig, not a calibrated seismological estimate."""
    if not rows:
        return {"score": None, "label": None, "components": None}

    stalta_vals = []
    for r in rows:
        merged = max(
            safe_num(r.get("adxl345_stalta"), -1),
            safe_num(r.get("lis3dh_stalta"), -1),
            safe_num(r.get("mpu6050_stalta"), -1),
        )
        if merged >= 0:
            stalta_vals.append(merged)
    # STA/LTA ratios well above 1 indicate a strong trigger; normalize against
    # a ratio of 5 representing a very strong, unambiguous trigger.
    stalta_score = 0.0
    if stalta_vals:
        avg_stalta = sum(stalta_vals) / len(stalta_vals)
        stalta_score = max(0.0, min(100.0, (avg_stalta - 1) / 4 * 100))

    wave_scores = [wave_quality_score(r) for r in rows]
    wave_scores = [w for w in wave_scores if w >= 0]
    wave_score = sum(wave_scores) / len(wave_scores) if wave_scores else None

    agreement_score = agreement.get("agreementScore")

    parts = []
    weights = []
    if agreement_score is not None:
        parts.append(agreement_score)
        weights.append(0.4)
    parts.append(stalta_score)
    weights.append(0.35 if agreement_score is not None else 0.6)
    if wave_score is not None:
        parts.append(wave_score)
        weights.append(0.25)

    total_weight = sum(weights)
    score = sum(p * w for p, w in zip(parts, weights)) / total_weight if total_weight else None

    label = None
    if score is not None:
        if score < 35:
            label = "LOW"
        elif score < 60:
            label = "MEDIUM"
        elif score < 85:
            label = "HIGH"
        else:
            label = "VERY HIGH"

    return {
        "score": score,
        "label": label,
        "components": {
            "sensorAgreement": agreement_score,
            "staltaStrength": stalta_score,
            "waveQuality": wave_score,
        },
    }


def severity_from_pga(pga: float, mmi: float) -> dict[str, Any]:
    """Maps peak PGA / MMI to a five-step severity label for the gauge.
    Thresholds are tuned for a tabletop/demo simulator, not field-deployed
    instrumentation -- treat as relative, not a real hazard classification."""
    if pga < 0:
        return {"level": None, "label": None, "fraction": 0.0}
    if pga < 5:
        level, label = 1, "Minor"
    elif pga < 25:
        level, label = 2, "Weak"
    elif pga < 80:
        level, label = 3, "Moderate"
    elif pga < 250:
        level, label = 4, "Strong"
    else:
        level, label = 5, "Severe"
    return {"level": level, "label": label, "fraction": level / 5}


def confidence_to_error(value: Any) -> float:
    confidence = safe_num(value, -1)
    if confidence < 0:
        return -1
    if confidence <= 1:
        confidence *= 100
    return max(0.0, min(100.0, 100.0 - confidence))


def normalize_history_event(row: dict[str, Any]) -> dict[str, Any]:
    pga = safe_num(row.get("pga_cm_s2"))
    return {
        **row,
        "id": row.get("event_id") or row.get("id"),
        "source": "earthquake_history",
        "timestamp": iso_from_timestamp_ms(row.get("timestamp_ms"), row.get("created_at")),
        "classification": row.get("classification") or "Unknown",
        "pga": pga,
        "mmi": estimate_mmi(pga),
        "distance_km": safe_num(row.get("distance_km")),
        "magnitude": safe_num(row.get("magnitude")),
        "adxl345_stalta": -1,
        "lis3dh_stalta": -1,
        "mpu6050_stalta": -1,
        "validation_error": confidence_to_error(row.get("confidence")),
    }


def normalize_live_station(row: dict[str, Any]) -> dict[str, Any]:
    pga = safe_num(row.get("pga_cm_s2"))
    return {
        **row,
        "id": row.get("station_id"),
        "source": "station_live",
        "timestamp": iso_from_timestamp_ms(row.get("timestamp_ms"), row.get("updated_at")),
        "classification": row.get("classification") or "Unknown",
        "pga": pga,
        "mmi": estimate_mmi(pga),
        "distance_km": safe_num(row.get("distance_km")),
        "magnitude": safe_num(row.get("magnitude")),
        "adxl345_stalta": safe_num(row.get("adxl345_ratio"), 0),
        "lis3dh_stalta": safe_num(row.get("lis3dh_ratio"), 0),
        "mpu6050_stalta": safe_num(row.get("mpu6050_ratio"), 0),
        "validation_error": confidence_to_error(row.get("confidence")),
    }


def build_events_query(params: dict[str, list[str]], time_column: str) -> str:
    query: dict[str, str] = {
        "select": "*",
        "order": f"{time_column}.desc",
        "limit": params.get("limit", ["500"])[0],
    }
    classification = params.get("classification", [""])[0].strip()
    date_from = params.get("from", [""])[0].strip()
    date_to = params.get("to", [""])[0].strip()
    if classification:
        query["classification"] = f"eq.{classification}"
    if date_from:
        query[time_column] = f"gte.{date_from}T00:00:00"
    if date_to:
        if time_column in query:
            query["and"] = f"({time_column}.gte.{date_from}T00:00:00,{time_column}.lte.{date_to}T23:59:59)"
            query.pop(time_column, None)
        else:
            query[time_column] = f"lte.{date_to}T23:59:59"
    return urlencode(query)


def fetch_events(params: dict[str, list[str]] | None = None) -> list[dict[str, Any]]:
    params = params or {}
    headers = supabase_headers()
    history_url = f"{SUPABASE_URL}/rest/v1/earthquake_history?{build_events_query(params, 'created_at')}"
    history = http_json(history_url, headers)
    if isinstance(history, list) and history:
        return [normalize_history_event(row) for row in history]

    live_params = dict(params)
    live_params["limit"] = ["50"]
    live_url = f"{SUPABASE_URL}/rest/v1/station_live?{build_events_query(live_params, 'updated_at')}"
    live = http_json(live_url, headers)
    if isinstance(live, list):
        return [normalize_live_station(row) for row in live]
    return []

def summarize_events(rows: list[dict[str, Any]]) -> dict[str, Any]:
    if not rows:
        return {
            "count": 0,
            "peakPga": None,
            "maxMagnitude": None,
            "avgValidationError": None,
            "classCounts": {},
            "strongest": None,
            "qualityScore": None,
            "suggestedAction": "Load or record seismic events first.",
            "sensorAgreement": sensor_agreement(rows),
            "confidence": seismic_confidence(rows, sensor_agreement(rows)),
            "severity": severity_from_pga(-1, -1),
        }

    class_counts: dict[str, int] = {}
    for row in rows:
        cls = str(row.get("classification") or "Unknown")
        class_counts[cls] = class_counts.get(cls, 0) + 1

    peak_pga = max(safe_num(r.get("pga")) for r in rows)
    max_mag = max(safe_num(r.get("magnitude")) for r in rows)
    errors = [safe_num(r.get("validation_error")) for r in rows if safe_num(r.get("validation_error")) >= 0]
    avg_error = sum(errors) / len(errors) if errors else None

    def strength(row: dict[str, Any]) -> float:
        return safe_num(row.get("pga"), 0) + safe_num(row.get("magnitude"), 0) * 80

    strongest = max(rows, key=strength)
    quality = 85.0
    if avg_error is not None:
        quality -= min(45.0, avg_error * 0.7)
    if peak_pga > 350:
        quality -= 5
    quality = max(0.0, min(100.0, quality))

    if avg_error is not None and avg_error > 25:
        action = "Validation error is high. Tune motor timing, P/S detection thresholds, and sensor mounting."
    elif peak_pga > 350:
        action = "Strong shaking detected. Review oscilloscope trace and verify the event was simulated or real."
    elif class_counts.get("Confirmed Seismic Event", 0) == 0:
        action = "No confirmed events yet. Run the physical simulator and confirm P/S timing appears."
    else:
        action = "Data is consistent for demonstration. Continue collecting test runs."

    agreement = sensor_agreement(rows)
    confidence = seismic_confidence(rows, agreement)
    severity = severity_from_pga(peak_pga, estimate_mmi(peak_pga))

    return {
        "count": len(rows),
        "peakPga": peak_pga,
        "maxMagnitude": max_mag,
        "avgValidationError": avg_error,
        "classCounts": class_counts,
        "strongest": strongest,
        "qualityScore": quality,
        "suggestedAction": action,
        "sensorAgreement": agreement,
        "confidence": confidence,
        "severity": severity,
    }



def local_agent_answer(question: str, rows: list[dict[str, Any]], summary: dict[str, Any]) -> str:
    q = question.lower()
    if not rows:
        return "No Supabase events are loaded yet. Check your backend .env values or record/upload events from the ESP32 first."
    strongest = summary.get("strongest") or {}
    if "strong" in q or "peak" in q or "largest" in q:
        return (
            f"The strongest event is {strongest.get('classification', 'Unknown')} with "
            f"PGA {safe_num(strongest.get('pga')):.1f} cm/s2, magnitude {safe_num(strongest.get('magnitude')):.1f}, "
            f"and distance {safe_num(strongest.get('distance_km')):.1f} km."
        )
    if "validation" in q or "error" in q:
        err = summary.get("avgValidationError")
        if err is None:
            return "There are no validation error values yet. Run a simulator event with P-wave and S-wave detection."
        return f"Average validation error is {err:.1f}%. Below 15% is excellent, 15-25% is usable, and above 25% needs tuning."
    if "threshold" in q or "tune" in q:
        return "Tune STA/LTA gradually: raise thresholds if footsteps trigger events, lower them if the simulator is missed. Adjust one sensor at a time and compare ADXL345, LIS3DH, and MPU6050 ratios."
    if "summary" in q or "summarize" in q:
        return (
            f"Loaded {summary['count']} events. Peak PGA is {summary['peakPga']:.1f} cm/s2, "
            f"max magnitude is {summary['maxMagnitude']:.1f}, and quality score is {summary['qualityScore']:.0f}%."
        )
    return (
        f"I found {summary['count']} events. Suggested action: {summary['suggestedAction']} "
        "Ask about strongest event, validation, magnitude, PGA, or threshold tuning."
    )


def compact_context(rows: list[dict[str, Any]], summary: dict[str, Any]) -> str:
    latest = rows[:25]
    return json.dumps(
        {
            "summary": summary,
            "latest_events": latest,
            "field_notes": {
                "pga": "Peak Ground Acceleration in cm/s2",
                "mmi": "Modified Mercalli Intensity estimate",
                "validation_error": "Simulator validation error percent",
                "stalta": "Independent STA/LTA ratios from ADXL345, LIS3DH, MPU6050",
            },
        },
        ensure_ascii=False,
    )


def openai_agent_answer(question: str, rows: list[dict[str, Any]], summary: dict[str, Any]) -> str:
    if not OPENAI_API_KEY:
        return local_agent_answer(question, rows, summary)
    body = {
        "model": OPENAI_MODEL,
        "input": [
            {
                "role": "system",
                "content": (
                    "You are TriAxis Station Analyst, a careful seismic instrumentation assistant. "
                    "Answer only from the provided station data. Be concise, quantitative, and practical. "
                    "If data is missing, say what is missing. Do not claim real earthquake certainty from a school/demo sensor."
                ),
            },
            {
                "role": "user",
                "content": f"Question: {question}\n\nStation data JSON:\n{compact_context(rows, summary)}",
            },
        ],
    }
    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type": "application/json",
    }
    try:
        response = http_json("https://api.openai.com/v1/responses", headers, method="POST", body=body)
        if isinstance(response, dict):
            if isinstance(response.get("output_text"), str):
                return response["output_text"]
            parts: list[str] = []
            for item in response.get("output", []) or []:
                for content in item.get("content", []) or []:
                    if content.get("type") in ("output_text", "text") and "text" in content:
                        parts.append(str(content["text"]))
            if parts:
                return "\n".join(parts)
        return "The AI model returned an unexpected response shape. The backend local analyst is still available."
    except Exception:
        return f"AI request failed, so I used local analysis instead. {local_agent_answer(question, rows, summary)}"


# ---------------------------------------------------------------------------
# Route logic, shared by both the local stdlib server and the Vercel WSGI app
# ---------------------------------------------------------------------------

def get_status() -> dict[str, Any]:
    return {
        "supabaseConfigured": bool(SUPABASE_URL and SUPABASE_KEY),
        "openaiConfigured": bool(OPENAI_API_KEY),
        "model": OPENAI_MODEL,
    }


def get_events(query_params: dict[str, list[str]]) -> dict[str, Any]:
    rows = fetch_events(query_params)
    return {"events": rows}


def get_analytics(query_params: dict[str, list[str]]) -> dict[str, Any]:
    rows = fetch_events(query_params)
    return {"summary": summarize_events(rows), "events": rows}


def post_agent(body: dict[str, Any]) -> dict[str, Any]:
    question = str(body.get("message", "")).strip()
    filters = body.get("filters") if isinstance(body.get("filters"), dict) else {}
    params = {k: [str(v)] for k, v in filters.items() if v not in (None, "")}
    rows = fetch_events(params)
    summary = summarize_events(rows)
    answer = openai_agent_answer(question, rows, summary)
    return {"answer": answer, "summary": summary, "usedOpenAI": bool(OPENAI_API_KEY)}


# ---------------------------------------------------------------------------
# Local development server (python server.py)
# ---------------------------------------------------------------------------

def json_response(handler: BaseHTTPRequestHandler, status: int, payload: Any) -> None:
    data = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def read_body(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("Content-Length", "0") or "0")
    if length <= 0:
        return {}
    raw = handler.rfile.read(length).decode("utf-8")
    return json.loads(raw) if raw else {}


class AppHandler(BaseHTTPRequestHandler):
    server_version = "TriAxisDynamic/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/status":
            json_response(self, 200, get_status())
            return
        if parsed.path == "/api/events":
            try:
                json_response(self, 200, get_events(parse_qs(parsed.query)))
            except Exception as exc:
                json_response(self, 500, {"error": str(exc)})
            return
        if parsed.path == "/api/analytics":
            try:
                json_response(self, 200, get_analytics(parse_qs(parsed.query)))
            except Exception as exc:
                json_response(self, 500, {"error": str(exc)})
            return
        self.serve_static(parsed.path)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/api/agent":
            json_response(self, 404, {"error": "Not found"})
            return
        try:
            body = read_body(self)
            json_response(self, 200, post_agent(body))
        except Exception as exc:
            traceback.print_exc()
            json_response(self, 500, {"error": str(exc)})

    def serve_static(self, request_path: str) -> None:
        rel = "index.html" if request_path in ("", "/") else request_path.lstrip("/")
        path = (PUBLIC / rel).resolve()
        if not str(path).startswith(str(PUBLIC.resolve())) or not path.exists() or path.is_dir():
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not found")
            return
        content_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", PORT), AppHandler)
    print(f"TriAxis dynamic website running at http://127.0.0.1:{PORT}")
    print("Press Ctrl+C to stop.")
    server.serve_forever()


# ---------------------------------------------------------------------------
# WSGI app for Vercel's Python runtime (imported by api/*.py)
# ---------------------------------------------------------------------------

def _wsgi_json(status: int, payload: Any, start_response) -> list[bytes]:
    data = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    status_line = f"{status} {('OK' if status == 200 else 'ERROR')}"
    start_response(status_line, [
        ("Content-Type", "application/json; charset=utf-8"),
        ("Cache-Control", "no-store"),
        ("Content-Length", str(len(data))),
    ])
    return [data]


def app(environ: dict[str, Any], start_response) -> list[bytes]:
    """Single WSGI entrypoint. Each api/*.py file imports this directly."""
    path = environ.get("PATH_INFO", "/")
    method = environ.get("REQUEST_METHOD", "GET")
    query_params = parse_qs(environ.get("QUERY_STRING", ""))

    try:
        if method == "GET" and path == "/api/status":
            return _wsgi_json(200, get_status(), start_response)

        if method == "GET" and path == "/api/events":
            return _wsgi_json(200, get_events(query_params), start_response)

        if method == "GET" and path == "/api/analytics":
            return _wsgi_json(200, get_analytics(query_params), start_response)

        if method == "POST" and path == "/api/agent":
            try:
                length = int(environ.get("CONTENT_LENGTH") or 0)
            except (TypeError, ValueError):
                length = 0
            raw = environ["wsgi.input"].read(length) if length > 0 else b""
            body = json.loads(raw.decode("utf-8")) if raw else {}
            return _wsgi_json(200, post_agent(body), start_response)

        return _wsgi_json(404, {"error": "Not found"}, start_response)
    except Exception as exc:
        traceback.print_exc()
        return _wsgi_json(500, {"error": str(exc)}, start_response)


if __name__ == "__main__":
    main()
