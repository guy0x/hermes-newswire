"""Hermes Newswire — unified plugin package.

A breaking-news ticker for Hermes Desktop. This package is a *unified*
plugin: the Python half lives in ``dashboard/`` (FastAPI router mounted at
``/api/plugins/hermes-newswire/``) and the desktop renderer half in
``desktop/plugin.js`` (runtime ESM loaded by Hermes Desktop). Neither half
registers core agent tools, hooks, or middleware — routine operation uses no
model tokens — so there is no ``register()`` entry point to probe; the
capability probe correctly finds nothing to declare.
"""


def register(ctx) -> None:
    """No-op registration for the capability probe.

    This package's real surfaces are the dashboard API router (dashboard/)
    and the desktop renderer (desktop/) — neither registers core agent
    tools/hooks/middleware. The probe requires a register() to exist; it
    records nothing, matching the empty capabilities block in plugin.yaml
    and the catalog entry.
    """
    return None
