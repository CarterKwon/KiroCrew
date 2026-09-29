"""The standalone Python client's calls stay registered by the real Gateway."""

from __future__ import annotations

import ast
import re
from pathlib import Path

from aiohttp import web

from kiro_crew.dashboard.routes import register_all
from kiro_crew.dashboard.server import _register_mcp_routes

_CLIENT_SOURCE = (
    Path(__file__).parents[1] / "packages" / "kirocrew-client-py" / "kirocrew_client" / "client.py"
)
_HELPER_METHODS = {
    "_get": "GET",
    "_post": "POST",
    "_put": "PUT",
    "_patch": "PATCH",
    "_delete": "DELETE",
    "_delete_with_body": "DELETE",
}
_EXPECTED_CLIENT_ROUTES = {
    ("POST", "/api/apps/{}/token"),
    ("GET", "/api/status"),
    ("GET", "/api/system"),
    ("POST", "/api/chat/slots"),
    ("GET", "/api/chat/slots"),
    ("DELETE", "/api/chat/slots/{}"),
    ("GET", "/api/chat/slots/{}"),
    ("POST", "/api/chat/slots/{}/stop"),
    ("POST", "/api/chat/slots/{}/edit-resend"),
    ("POST", "/api/chat"),
    ("POST", "/api/spawn"),
    ("GET", "/api/spawn"),
    ("GET", "/api/spawn/{}"),
    ("POST", "/api/crons"),
    ("GET", "/api/crons"),
    ("PATCH", "/api/crons/{}"),
    ("DELETE", "/api/crons/{}"),
    ("POST", "/api/crons/{}/enable"),
    ("POST", "/api/lessons"),
    ("GET", "/api/lessons"),
    ("DELETE", "/api/lessons"),
    ("POST", "/api/send-message"),
    ("GET", "/api/notifications"),
    ("POST", "/api/notifications/ack"),
    ("POST", "/api/notifications/ack-all"),
    ("GET", "/api/approvals"),
    ("POST", "/api/chat/slots/{}/approve"),
    ("POST", "/api/approvals/{}/{}"),
    ("POST", "/api/chat/mode"),
    ("GET", "/api/models"),
    ("POST", "/api/chat/slots/{}/model"),
    ("GET", "/api/config/{}"),
    ("PUT", "/api/config/{}"),
    ("POST", "/api/stt/transcribe"),
    ("GET", "/api/ws"),
    ("GET", "/api/mcp"),
    ("PUT", "/api/mcp/servers/{}"),
    ("DELETE", "/api/mcp/servers/{}"),
    ("GET", "/api/apps/{}/config"),
    ("PUT", "/api/apps/{}/config"),
    ("GET", "/api/memory/episodic/search"),
    ("POST", "/api/chat/slots/{}/context"),
}
_CONFIG_PATHS = {"kirocrew", "stt", "theme", "default-agent"}


def _path_template(node: ast.expr) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        value = node.value
    elif isinstance(node, ast.JoinedStr):
        parts: list[str] = []
        for part in node.values:
            if isinstance(part, ast.Constant) and isinstance(part.value, str):
                parts.append(part.value)
            elif isinstance(part, ast.FormattedValue):
                if isinstance(part.value, ast.Name) and part.value.id == "qs":
                    continue
                parts.append("{}")
        value = "".join(parts)
    else:
        return None
    api_start = value.find("/api/")
    if api_start < 0:
        return None
    return value[api_start:].split("?", 1)[0]


def _client_routes_from_source() -> set[tuple[str, str]]:
    source = _CLIENT_SOURCE.read_text(encoding="utf-8")
    tree = ast.parse(source)
    routes: set[tuple[str, str]] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
            continue
        method = _HELPER_METHODS.get(node.func.attr)
        if method is None and node.func.attr == "post":
            method = "POST"
        if method is None or not node.args:
            continue
        path = _path_template(node.args[0])
        if path is not None:
            routes.add((method, path))
    assert '"/api/ws"' in source, "WebSocket path disappeared from create_ws"
    routes.add(("GET", "/api/ws"))
    assert routes, "client route extraction must not pass with an empty inventory"
    return routes


def _normalize_gateway_path(path: str) -> str:
    return re.sub(r"\{[^{}]+\}", "{}", path)


def test_python_client_routes_exist_in_the_real_gateway_router() -> None:
    client_routes = _client_routes_from_source()
    assert client_routes == _EXPECTED_CLIENT_ROUTES

    app = web.Application()
    _register_mcp_routes(app)
    register_all(app)
    gateway_routes = {
        (route.method, _normalize_gateway_path(str(route.resource.canonical)))
        for route in app.router.routes()
        if route.method != "HEAD" and route.resource is not None
    }

    missing: set[tuple[str, str]] = set()
    for method, path in client_routes:
        if path == "/api/config/{}":
            missing.update(
                (method, f"/api/config/{key}")
                for key in _CONFIG_PATHS
                if (method, f"/api/config/{key}") not in gateway_routes
            )
        elif (method, path) not in gateway_routes:
            missing.add((method, path))

    assert not missing, f"Python client routes missing from Gateway: {sorted(missing)}"
