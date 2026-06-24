import sys, os, traceback
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from server import get_events, _wsgi_json, parse_qs

def app(environ, start_response):
    params = parse_qs(environ.get("QUERY_STRING", ""))
    try:
        return _wsgi_json(200, get_events(params), start_response)
    except Exception as exc:
        traceback.print_exc()
        return _wsgi_json(500, {"error": str(exc)}, start_response)
