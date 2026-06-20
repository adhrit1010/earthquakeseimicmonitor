import json, sys, os, traceback
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from server import post_agent, _wsgi_json

def app(environ, start_response):
    try:
        length = int(environ.get("CONTENT_LENGTH") or 0)
    except (TypeError, ValueError):
        length = 0
    try:
        raw = environ["wsgi.input"].read(length) if length > 0 else b""
        body = json.loads(raw.decode("utf-8")) if raw else {}
    except Exception:
        body = {}
    try:
        return _wsgi_json(200, post_agent(body), start_response)
    except Exception as exc:
        traceback.print_exc()
        return _wsgi_json(500, {"error": str(exc)}, start_response)
