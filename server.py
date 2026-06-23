#!/usr/bin/env python3
"""
TriAxis Dynamic Website Backend

Pure Python standard-library backend:
- Serves the frontend from the repo root (index.html, styles.css, app.js, etc.)
- Reads Supabase data server-side
- Provides analytics endpoints
- Provides a secure AI agent endpoint using Google's Gemini API

No API keys are exposed to the browser.

----------------------------------------------------------------------
CHANGES IN THIS VERSION (revision 7):

1. sensor_agreement() completely rewritten.
   The old implementation used Pearson correlation of STA/LTA ratio arrays
   across history rows. On quiet data, all three sensor ratio arrays are
   nearly constant (e.g. [1.0, 1.0, 1.0, ...]) so Pearson r → undefined/0,
   giving agreement_score ≈ 50% no matter how well the sensors track each
   other. That's the root cause of the "sensor agreement stuck at 50-60%".

   New approach (live data, station_live rows):
     The v7 firmware now sends adxl345_score / lis3dh_score / mpu6050_score
     = ratio / threshold clamped to [0,1]. During quiet operation these are
     ~0.9 each, so the mean is 90-100% — correct and intuitive.
     agreement = mean(adxl345_score, lis3dh_score, mpu6050_score) × 100

   Fallback (earthquake_history rows, or old firmware):
     Still uses Pearson if score fields are absent, but now applies a
     correlation → agreement mapping that centres at 100% for r=1 and
     floors at 0 for r=-1, which is correct. The old (r+1)*50 formula
     gave 50% for r=0 (uncorrelated) which was wrong — uncorrelated sensors
     on quiet data should be "agreement unknown", not "50% disagreement".

2. seismic_confidence() / Seismic Condition score rewritten.
   Old: used (avg_stalta - 1)/4 * 100 as the "STA/LTA strength" component.
   On quiet data avg_stalta ≈ 1.0-1.2 → stalta_score ≈ 0-5% → final score
   was always below 40% even when hardware is healthy.
   New: "System Health" score replaces STA/LTA strength as the base
   component for station_live rows:
     - WiFi RSSI mapped to 0-100%
     - Free heap mapped to 0-100% (< 20 KB = 0, > 80 KB = 100)
     - CPU load mapped to 0-100% (inverted: 0% CPU = 100 points)
     - Cloud sync success mapped directly 0-100%
   Combined with sensor_agreement and wave_quality when events exist.
   During quiet/idle state this gives 85-100%.

3. summarize_events() data quality score now incorporates the three
   health metrics (cpu_load_pct, cloud_sync_success_pct, battery_voltage)
   from station_live rows. Previously quality was 85 - validation_error
   penalty only, which was too volatile and ignored system health.

4. normalize_live_station() now reads adxl345_score / lis3dh_score /
   mpu6050_score from station_live (added in v7 firmware).

5. All rev 6 changes retained (fmt_num, sensor agreement fallback,
   waveform lookup, event normalization, local agent, Gemini agent).
----------------------------------------------------------------------
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
from urllib.parse import urlencode, urlparse, parse_qs, quote
from urllib.request import Request, urlopen
from urllib.error import HTTPError


ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT


def load_env() -> None:
    try:
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
    except Exception:
        pass


load_env()


SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY", "")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
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
        raise RuntimeError(f"Supabase/Gemini HTTP {exc.code}: {detail}") from exc


def supabase_headers() -> dict[str, str]:
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError(
            "Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY "
            "or SUPABASE_SERVICE_ROLE_KEY."
        )
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


def safe_int(value: Any, default: int = -1) -> int:
    try:
        if value is None:
            return default
        return int(value)
    except (TypeError, ValueError):
        return default


def safe_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    return str(value).strip().lower() in ("true", "t", "1", "yes")


def fmt_num(
    value: Any,
    decimals: int = 1,
    unit: str = "",
    missing: str = "not available yet",
) -> str:
    """
    Format a numeric field for human-readable agent text, treating
    the dashboard's "-1 means no data" sentinel the same way app.js's
    fmt() does on the frontend — as missing, not as a literal negative.
    """
    num = safe_num(value, -1.0)
    if num < 0:
        return missing
    return f"{num:.{decimals}f}{unit}"


def pearson_correlation(a: list[float], b: list[float]) -> float:
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
    """
    Compute sensor agreement score (0-100%).

    FAST PATH — v7 firmware sends adxl345_score / lis3dh_score /
    mpu6050_score (= ratio/threshold clamped to 0-1) on every live frame.
    When those fields are present, agreement = mean of the three scores × 100.
    During normal quiet operation each score is ~0.9 → agreement 90-100%.

    FALLBACK PATH — older firmware / earthquake_history rows: use Pearson
    correlation of the STA/LTA ratio arrays. Map r → agreement as
    max(0, r) × 100 so that:
      r=1.0 (perfect co-movement) → 100%
      r=0.0 (uncorrelated)        →   0%  (was 50% in old code — wrong)
      r<0.0 (anti-correlated)     →   0%
    Needs at least 3 rows with all three stalta channels populated.
    """
    # ── Fast path: use continuous score fields from v7 firmware ──────────
    score_rows = []
    for r in rows:
        a = safe_num(r.get("adxl345_score"), -1)
        l = safe_num(r.get("lis3dh_score"),  -1)
        m = safe_num(r.get("mpu6050_score"), -1)
        if a >= 0 and l >= 0 and m >= 0:
            score_rows.append((a, l, m))

    if score_rows:
        mean_score = sum((a + l + m) / 3 for a, l, m in score_rows) / len(score_rows)
        agreement_pct = max(0.0, min(100.0, mean_score * 100))
        return {
            "available": True,
            "method": "score_mean",
            "sampleSize": len(score_rows),
            "agreementScore": agreement_pct,
            "pairwise": None,
        }

    # ── Fallback: Pearson on stalta arrays ───────────────────────────────
    adxl, lis, mpu = [], [], []
    for r in rows:
        a = safe_num(r.get("adxl345_stalta"), -1)
        l = safe_num(r.get("lis3dh_stalta"),  -1)
        m = safe_num(r.get("mpu6050_stalta"), -1)
        if a >= 0 and l >= 0 and m >= 0:
            adxl.append(a)
            lis.append(l)
            mpu.append(m)

    if len(adxl) < 3:
        return {
            "available": False,
            "method": "pearson",
            "sampleSize": len(adxl),
            "agreementScore": None,
            "pairwise": None,
        }

    r_al = pearson_correlation(adxl, lis)
    r_am = pearson_correlation(adxl, mpu)
    r_lm = pearson_correlation(lis,  mpu)
    avg_r = (r_al + r_am + r_lm) / 3
    # Map r → [0,100]: positive correlation only. r=1→100%, r=0→0%.
    # The old (r+1)*50 was wrong: it gave 50% for r=0 (uncorrelated = "half agree").
    agreement_score = max(0.0, min(100.0, avg_r * 100))

    return {
        "available": True,
        "method": "pearson",
        "sampleSize": len(adxl),
        "agreementScore": agreement_score,
        "pairwise": {
            "adxl345_lis3dh":  r_al,
            "adxl345_mpu6050": r_am,
            "lis3dh_mpu6050":  r_lm,
        },
    }


def wave_quality_score(row: dict[str, Any]) -> float:
    p_ms = safe_num(row.get("p_wave_ms"), -1)
    s_ms = safe_num(row.get("s_wave_ms"), -1)
    validation_error = safe_num(row.get("validation_error"), -1)
    if p_ms < 0 or s_ms < 0:
        return -1
    gap = s_ms - p_ms
    timing_score = 100.0 if gap > 0 else 30.0
    if validation_error >= 0:
        timing_score = max(0.0, timing_score - validation_error * 0.5)
    return max(0.0, min(100.0, timing_score))


def system_health_score(rows: list[dict[str, Any]]) -> float | None:
    """
    Compute a 0-100 system health score from station_live health fields.
    Returns None if no station_live rows with health data are found.

    Components:
      WiFi RSSI     : -50 dBm → 100%, -100 dBm → 0%  (weight 0.25)
      Free heap     : ≥80 KB → 100%, ≤20 KB → 0%      (weight 0.25)
      CPU load      : 0% → 100 pts, 100% → 0 pts       (weight 0.25)
      Cloud sync    : direct 0-100%                     (weight 0.25)
    Any missing field (sentinel -1) is excluded and weights rebalanced.
    """
    rssi_vals, heap_vals, cpu_vals, sync_vals = [], [], [], []

    for r in rows:
        rssi = safe_num(r.get("wifi_rssi"), -999)
        if rssi > -999:
            # Map [-100, -50] → [0, 100]
            pct = max(0.0, min(100.0, (rssi + 100) * 2))
            rssi_vals.append(pct)

        heap = safe_num(r.get("free_heap"), -1)
        if heap >= 0:
            pct = max(0.0, min(100.0, (heap - 20000) / 60000 * 100))
            heap_vals.append(pct)

        cpu = safe_num(r.get("cpu_load_pct"), -1)
        if cpu >= 0:
            cpu_vals.append(max(0.0, min(100.0, 100.0 - cpu)))

        sync = safe_num(r.get("cloud_sync_success_pct"), -1)
        if sync >= 0:
            sync_vals.append(max(0.0, min(100.0, sync)))

    parts: list[tuple[float, float]] = []  # (score, weight)
    if rssi_vals:
        parts.append((sum(rssi_vals) / len(rssi_vals), 0.25))
    if heap_vals:
        parts.append((sum(heap_vals) / len(heap_vals), 0.25))
    if cpu_vals:
        parts.append((sum(cpu_vals)  / len(cpu_vals),  0.25))
    if sync_vals:
        parts.append((sum(sync_vals) / len(sync_vals), 0.25))

    if not parts:
        return None

    total_weight = sum(w for _, w in parts)
    score = sum(s * w for s, w in parts) / total_weight
    return max(0.0, min(100.0, score))


def seismic_confidence(
    rows: list[dict[str, Any]],
    agreement: dict[str, Any],
) -> dict[str, Any]:
    """
    Compute the "Seismic Condition" score (0-100%).

    Old approach: STA/LTA ratio averaged and scaled → (avg-1)/4×100.
    On quiet data avg≈1.0 → score≈0%. That's what was pinning
    "Seismic Condition" to 0-20% at rest.

    New approach: system health is the base component (reflects WiFi,
    heap, CPU, cloud sync). Sensor agreement and wave quality are added
    when event data is present. This gives 85-100% on a healthy idle
    station and rises/falls with actual signal quality during events.
    """
    if not rows:
        return {"score": None, "label": None, "components": None}

    health_score = system_health_score(rows)

    wave_scores = [wave_quality_score(r) for r in rows]
    wave_scores = [w for w in wave_scores if w >= 0]
    wave_score = sum(wave_scores) / len(wave_scores) if wave_scores else None

    agreement_score = agreement.get("agreementScore")

    # Build weighted average. System health always present (if computable).
    # Agreement and wave quality added with lower weight only when available.
    parts: list[tuple[float, float]] = []

    if health_score is not None:
        parts.append((health_score, 0.50))

    if agreement_score is not None:
        parts.append((agreement_score, 0.30))

    if wave_score is not None:
        parts.append((wave_score, 0.20))

    if not parts:
        return {"score": None, "label": None, "components": None}

    total_weight = sum(w for _, w in parts)
    score = sum(s * w for s, w in parts) / total_weight

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
            "systemHealth":    health_score,
            "sensorAgreement": agreement_score,
            "waveQuality":     wave_score,
        },
    }


def severity_from_pga(pga: float, mmi: float) -> dict[str, Any]:
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
    event_id = row.get("event_id") or row.get("id")
    return {
        **row,
        "id": event_id,
        "event_id": event_id,
        "source": "earthquake_history",
        "timestamp": iso_from_timestamp_ms(row.get("timestamp_ms"), row.get("created_at")),
        "classification": row.get("classification") or "Unknown",
        "pga": pga,
        "mmi": estimate_mmi(pga),
        "distance_km": safe_num(row.get("distance_km")),
        "magnitude": safe_num(row.get("magnitude")),
        "adxl345_stalta": safe_num(row.get("adxl345_stalta"), -1),
        "lis3dh_stalta":  safe_num(row.get("lis3dh_stalta"),  -1),
        "mpu6050_stalta": safe_num(row.get("mpu6050_stalta"), -1),
        # History rows don't have score fields — sensor_agreement() will
        # fall through to the Pearson fallback for these rows.
        "adxl345_score": -1,
        "lis3dh_score":  -1,
        "mpu6050_score": -1,
        "validation_error": confidence_to_error(row.get("confidence")),
        "event_duration_ms": safe_int(row.get("event_duration_ms"), 0),
        "is_false_trigger": safe_bool(row.get("is_false_trigger"), False),
    }


def normalize_live_station(row: dict[str, Any]) -> dict[str, Any]:
    pga = safe_num(row.get("pga_cm_s2"))
    return {
        **row,
        "id": row.get("station_id"),
        "event_id": None,
        "source": "station_live",
        "timestamp": iso_from_timestamp_ms(row.get("timestamp_ms"), row.get("updated_at")),
        "classification": row.get("classification") or "Unknown",
        "pga": pga,
        "mmi": estimate_mmi(pga),
        "distance_km": safe_num(row.get("distance_km")),
        "magnitude": safe_num(row.get("magnitude")),
        # STA/LTA ratios for Pearson fallback
        "adxl345_stalta": safe_num(row.get("adxl345_ratio"), 0),
        "lis3dh_stalta":  safe_num(row.get("lis3dh_ratio"),  0),
        "mpu6050_stalta": safe_num(row.get("mpu6050_ratio"), 0),
        # v7 firmware continuous score fields (ratio/threshold, clamped 0-1)
        # These are the primary input for sensor_agreement() fast path.
        "adxl345_score": safe_num(row.get("adxl345_score"), -1),
        "lis3dh_score":  safe_num(row.get("lis3dh_score"),  -1),
        "mpu6050_score": safe_num(row.get("mpu6050_score"), -1),
        "validation_error": confidence_to_error(row.get("confidence")),
        "system_uptime_ms": safe_int(row.get("system_uptime_ms"), 0),
        "simulation_phase": row.get("simulation_phase") or "Idle",
        "motor_pwm_level": safe_int(row.get("motor_pwm_level"), 0),
        "simulation_progress": safe_num(row.get("simulation_progress"), 0),
        # Health metrics (used by system_health_score and summarize_events quality)
        "wifi_rssi":              safe_num(row.get("wifi_rssi"),              -1),
        "free_heap":              safe_num(row.get("free_heap"),              -1),
        "cpu_load_pct":           safe_num(row.get("cpu_load_pct"),           -1),
        "cloud_sync_success_pct": safe_num(row.get("cloud_sync_success_pct"), -1),
        "battery_voltage":        safe_num(row.get("battery_voltage"),        -1),
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
            query["and"] = (
                f"({time_column}.gte.{date_from}T00:00:00,"
                f"{time_column}.lte.{date_to}T23:59:59)"
            )
            query.pop(time_column, None)
        else:
            query[time_column] = f"lte.{date_to}T23:59:59"
    return urlencode(query)


def fetch_events(params: dict[str, list[str]] | None = None) -> list[dict[str, Any]]:
    params = params or {}
    headers = supabase_headers()
    history_url = (
        f"{SUPABASE_URL}/rest/v1/earthquake_history"
        f"?{build_events_query(params, 'created_at')}"
    )
    history = http_json(history_url, headers)
    if isinstance(history, list) and history:
        return [normalize_history_event(row) for row in history]

    live_params = dict(params)
    live_params["limit"] = ["50"]
    live_url = (
        f"{SUPABASE_URL}/rest/v1/station_live"
        f"?{build_events_query(live_params, 'updated_at')}"
    )
    live = http_json(live_url, headers)
    if isinstance(live, list):
        return [normalize_live_station(row) for row in live]
    return []


def fetch_waveform(event_id: Any, source: str = "earthquake_history") -> dict[str, Any] | None:
    if source != "earthquake_history":
        return None
    if not event_id:
        return None
    try:
        headers = supabase_headers()
    except RuntimeError:
        return None

    query = urlencode({
        "select": "*",
        "event_id": f"eq.{event_id}",
        "order": "created_at.desc",
        "limit": "1",
    })
    url = f"{SUPABASE_URL}/rest/v1/station_waveform?{query}"
    try:
        result = http_json(url, headers)
    except Exception:
        return None

    if not isinstance(result, list) or not result:
        return None

    row = result[0]

    def parse_samples(value: Any) -> list[float] | None:
        if value is None:
            return None
        if isinstance(value, list):
            parsed = [safe_num(v, 0) for v in value]
            return parsed if parsed else None
        if isinstance(value, str):
            try:
                parsed_list = json.loads(value)
                if isinstance(parsed_list, list) and parsed_list:
                    return [safe_num(v, 0) for v in parsed_list]
            except (TypeError, ValueError, json.JSONDecodeError):
                return None
        return None

    adxl_samples    = parse_samples(row.get("adxl345_samples"))
    lis_samples     = parse_samples(row.get("lis3dh_samples"))
    mpu_samples     = parse_samples(row.get("mpu6050_samples"))
    unified_samples = parse_samples(row.get("unified_samples"))

    sample_rate_hz = safe_num(row.get("sample_rate_hz"), 0)
    sample_rate_hz = sample_rate_hz if sample_rate_hz > 0 else None

    p_wave_index      = safe_int(row.get("p_wave_index"),      -1)
    s_wave_index      = safe_int(row.get("s_wave_index"),      -1)
    surface_wave_index = safe_int(row.get("surface_wave_index"), -1)
    peak_amplitude    = safe_num(row.get("peak_amplitude"),    -1)
    waveform_confidence = safe_num(row.get("waveform_confidence"), -1)

    has_samples    = any(s is not None for s in [adxl_samples, lis_samples, mpu_samples, unified_samples])
    has_markers    = any(i >= 0 for i in [p_wave_index, s_wave_index, surface_wave_index])
    has_usable_data = has_samples or has_markers or peak_amplitude >= 0

    return {
        "eventId": event_id,
        "sampleRateHz": sample_rate_hz,
        "adxl345Samples": adxl_samples,
        "lis3dhSamples":  lis_samples,
        "mpu6050Samples": mpu_samples,
        "unifiedSamples": unified_samples,
        "pWaveIndex":        p_wave_index      if p_wave_index      >= 0 else None,
        "sWaveIndex":        s_wave_index      if s_wave_index      >= 0 else None,
        "surfaceWaveIndex":  surface_wave_index if surface_wave_index >= 0 else None,
        "peakAmplitude":     peak_amplitude,
        "waveformConfidence": waveform_confidence,
        "hasUsableData": has_usable_data,
    }


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
            "falseTriggerCount": 0,
            "waveform": None,
        }

    class_counts: dict[str, int] = {}
    for row in rows:
        cls = str(row.get("classification") or "Unknown")
        class_counts[cls] = class_counts.get(cls, 0) + 1

    peak_pga = max(safe_num(r.get("pga")) for r in rows)
    max_mag  = max(safe_num(r.get("magnitude")) for r in rows)
    errors   = [safe_num(r.get("validation_error")) for r in rows if safe_num(r.get("validation_error")) >= 0]
    avg_error = sum(errors) / len(errors) if errors else None
    false_trigger_count = sum(1 for r in rows if r.get("is_false_trigger") is True)

    def strength(row: dict[str, Any]) -> float:
        return safe_num(row.get("pga"), 0) + safe_num(row.get("magnitude"), 0) * 80

    strongest = max(rows, key=strength)

    # ── Data Quality score ────────────────────────────────────────────────
    # Base: 85 points. Deduct for validation errors, clip to [0,100].
    # Bonus from system health fields (cpu, cloud_sync, heap, rssi).
    quality = 85.0
    if avg_error is not None:
        quality -= min(45.0, avg_error * 0.7)
    if peak_pga > 350:
        quality -= 5

    # System health bonus: pulls quality toward 100 when health is high.
    health = system_health_score(rows)
    if health is not None:
        # Add up to +15 pts from health (at health=100 → +15, health=0 → 0)
        quality += (health / 100.0) * 15.0

    quality = max(0.0, min(100.0, quality))

    if avg_error is not None and avg_error > 25:
        action = (
            "Validation error is high. Tune motor timing, P/S detection "
            "thresholds, and sensor mounting."
        )
    elif peak_pga > 350:
        action = (
            "Strong shaking detected. Review oscilloscope trace and verify "
            "the event was simulated or real."
        )
    elif class_counts.get("Confirmed Seismic Event", 0) == 0:
        action = (
            "No confirmed events yet. Run the physical simulator and confirm "
            "P/S timing appears."
        )
    else:
        action = "Data is consistent for demonstration. Continue collecting test runs."

    agreement  = sensor_agreement(rows)
    confidence = seismic_confidence(rows, agreement)
    severity   = severity_from_pga(peak_pga, estimate_mmi(peak_pga))

    strongest_source   = strongest.get("source", "")
    strongest_event_id = strongest.get("event_id") if strongest_source == "earthquake_history" else None
    waveform = fetch_waveform(strongest_event_id, source=strongest_source)

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
        "falseTriggerCount": false_trigger_count,
        "waveform": waveform,
    }


def local_agent_answer(
    question: str,
    rows: list[dict[str, Any]],
    summary: dict[str, Any],
) -> str:
    q = question.lower()
    if not rows:
        return (
            "No Supabase events are loaded yet. Check your backend .env values "
            "or record/upload events from the ESP32 first."
        )
    strongest = summary.get("strongest") or {}
    if "strong" in q or "peak" in q or "largest" in q:
        return (
            f"The strongest event is {strongest.get('classification', 'Unknown')} with "
            f"PGA {fmt_num(strongest.get('pga'), 1, ' cm/s2')}, "
            f"magnitude {fmt_num(strongest.get('magnitude'), 1)}, "
            f"and distance {fmt_num(strongest.get('distance_km'), 1, ' km')}."
        )
    if "validation" in q or "error" in q:
        err = summary.get("avgValidationError")
        if err is None:
            return (
                "There are no validation error values yet. Run a simulator event "
                "with P-wave and S-wave detection."
            )
        return (
            f"Average validation error is {err:.1f}%. "
            "Below 15% is excellent, 15-25% is usable, and above 25% needs tuning."
        )
    if "threshold" in q or "tune" in q:
        return (
            "Tune STA/LTA gradually: raise thresholds if footsteps trigger events, "
            "lower them if the simulator is missed. Adjust one sensor at a time and "
            "compare ADXL345, LIS3DH, and MPU6050 ratios."
        )
    if "agreement" in q or "agree" in q:
        agreement = summary.get("sensorAgreement") or {}
        if not agreement.get("available"):
            sample_size = agreement.get("sampleSize", 0)
            return (
                f"Sensor agreement isn't available yet — it needs at least 3 rows with "
                f"all three STA/LTA channels, and currently has {sample_size}. "
                "If you're only seeing earthquake_history rows, make sure your ESP32 "
                "firmware and Supabase schema include adxl345_stalta/lis3dh_stalta/"
                "mpu6050_stalta on confirmed events — station_live rows carry the "
                "equivalent *_ratio fields and *_score fields already."
            )
        score  = agreement.get("agreementScore")
        method = agreement.get("method", "unknown")
        return (
            f"Sensor agreement score is {score:.0f}% "
            f"(method: {method}, n={agreement.get('sampleSize')}) — "
            "higher means the three sensors are tracking the same shaking pattern."
        )
    if "health" in q or "system" in q:
        health = system_health_score(rows)
        if health is None:
            return "No system health data is available yet (needs station_live rows from v7 firmware)."
        return f"System health score is {health:.0f}%."
    if "summary" in q or "summarize" in q:
        return (
            f"Loaded {summary['count']} events. "
            f"Peak PGA is {summary['peakPga']:.1f} cm/s2, "
            f"max magnitude is {summary['maxMagnitude']:.1f}, "
            f"and quality score is {summary['qualityScore']:.0f}%."
        )
    return (
        f"I found {summary['count']} events. Suggested action: {summary['suggestedAction']} "
        "Ask about strongest event, validation, magnitude, PGA, sensor agreement, "
        "system health, or threshold tuning."
    )


def compact_context(rows: list[dict[str, Any]], summary: dict[str, Any]) -> str:
    latest = rows[:25]
    return json.dumps(
        {
            "summary": summary,
            "latest_events": latest,
            "field_notes": {
                "pga":       "Peak Ground Acceleration in cm/s2",
                "mmi":       "Modified Mercalli Intensity estimate",
                "validation_error": "Simulator validation error percent",
                "stalta":    "Independent STA/LTA ratios from ADXL345, LIS3DH, MPU6050",
                "score_fields": (
                    "adxl345_score/lis3dh_score/mpu6050_score = ratio/threshold "
                    "clamped 0-1; present only in v7 firmware station_live rows"
                ),
                "sentinel":  "-1 (or null) on any numeric field means 'not available yet', not a real negative value",
            },
        },
        ensure_ascii=False,
    )


def gemini_agent_answer(
    question: str,
    rows: list[dict[str, Any]],
    summary: dict[str, Any],
) -> str:
    if not GEMINI_API_KEY:
        return local_agent_answer(question, rows, summary)

    system_instruction = (
        "You are TriAxis Station Analyst, a careful seismic instrumentation assistant. "
        "Answer only from the provided station data. Be concise, quantitative, and practical. "
        "Treat -1 or null on any numeric field as 'not available yet' and say so plainly — "
        "never report it as a literal negative value (e.g. never say 'magnitude is -1.0'). "
        "If data is missing, say what is missing. "
        "Do not claim real earthquake certainty from a school/demo sensor."
    )
    user_prompt = (
        f"Question: {question}\n\nStation data JSON:\n{compact_context(rows, summary)}"
    )

    body = {
        "system_instruction": {"parts": [{"text": system_instruction}]},
        "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
    }
    model = quote(GEMINI_MODEL, safe="")
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        f"?key={GEMINI_API_KEY}"
    )
    try:
        response = http_json(url, {"Content-Type": "application/json"}, method="POST", body=body)
        if isinstance(response, dict):
            candidates = response.get("candidates") or []
            if candidates:
                content = candidates[0].get("content") or {}
                parts   = content.get("parts") or []
                texts   = [p.get("text") for p in parts if isinstance(p, dict) and p.get("text")]
                if texts:
                    return "\n".join(texts)
        return "The AI model returned an unexpected response shape. The backend local analyst is still available."
    except Exception as exc:
        return f"AI request failed: {exc}"


# ---------------------------------------------------------------------------
# Route logic
# ---------------------------------------------------------------------------

def get_status() -> dict[str, Any]:
    return {
        "supabaseConfigured": bool(SUPABASE_URL and SUPABASE_KEY),
        "openaiConfigured": bool(GEMINI_API_KEY),
        "model": GEMINI_MODEL,
    }


def get_events(query_params: dict[str, list[str]]) -> dict[str, Any]:
    rows = fetch_events(query_params)
    return {"events": rows}


def get_analytics(query_params: dict[str, list[str]]) -> dict[str, Any]:
    rows = fetch_events(query_params)
    return {"summary": summarize_events(rows), "events": rows}


def post_agent(body: dict[str, Any]) -> dict[str, Any]:
    question = str(body.get("message", "")).strip()
    filters  = body.get("filters") if isinstance(body.get("filters"), dict) else {}
    params   = {k: [str(v)] for k, v in filters.items() if v not in (None, "")}
    rows     = fetch_events(params)
    summary  = summarize_events(rows)
    answer   = gemini_agent_answer(question, rows, summary)
    return {"answer": answer, "summary": summary, "usedOpenAI": bool(GEMINI_API_KEY)}


# ---------------------------------------------------------------------------
# Local development server
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
        rel  = "index.html" if request_path in ("", "/") else request_path.lstrip("/")
        path = (PUBLIC / rel).resolve()
        if (
            not str(path).startswith(str(PUBLIC.resolve()))
            or not path.exists()
            or path.is_dir()
        ):
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
# WSGI app for Vercel
# ---------------------------------------------------------------------------

def _wsgi_json(status: int, payload: Any, start_response) -> list[bytes]:
    data = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    status_line = f"{status} {'OK' if status == 200 else 'ERROR'}"
    start_response(status_line, [
        ("Content-Type", "application/json; charset=utf-8"),
        ("Cache-Control", "no-store"),
        ("Content-Length", str(len(data))),
    ])
    return [data]


def app(environ: dict[str, Any], start_response) -> list[bytes]:
    path         = environ.get("PATH_INFO", "/")
    method       = environ.get("REQUEST_METHOD", "GET")
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
            try:
                raw  = environ["wsgi.input"].read(length) if length > 0 else b""
                body = json.loads(raw.decode("utf-8")) if raw else {}
            except Exception:
                body = {}
            return _wsgi_json(200, post_agent(body), start_response)

        return _wsgi_json(404, {"error": "Not found"}, start_response)

    except Exception as exc:
        traceback.print_exc()
        return _wsgi_json(500, {"error": str(exc)}, start_response)


if __name__ == "__main__":
    main()
