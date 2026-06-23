import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from server import get_live, _wsgi_json

def app(environ, start_response):
    return _wsgi_json(200, get_live(), start_response)
