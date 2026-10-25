"""``docs-ingest`` command line. ``setup`` writes the endpoint config the live pipeline reads.

Stdlib only, like the rest of the package: prompts use ``input``/``getpass`` and the probes use
``urllib``. The prompt, getpass and URL opener are injectable, so tests need no TTY or network.
"""

from __future__ import annotations

import argparse
import getpass
import http.client
import ipaddress
import sys
import urllib.error
import urllib.request
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from . import config

PROBE_TIMEOUT = 5


def _check_url(value: str) -> str | None:
    try:
        parts = urlsplit(value)
        if parts.scheme in ("http", "https") and parts.hostname:
            return None
    except ValueError:
        pass
    return "must be an http:// or https:// URL with a host"


def _check_gateway_url(value: str) -> str | None:
    error = _check_url(value)
    if error is None and not urlsplit(value).path.rstrip("/").endswith("/v1"):
        return "must end in /v1, e.g. http://localhost:4001/v1"
    return error


@dataclass(frozen=True)
class _Setting:
    name: str
    flag: str
    validate: Callable[[str], str | None] | None = None
    secret: bool = False
    required: bool = False

    @property
    def dest(self) -> str:
        return self.flag[2:].replace("-", "_")


_SETTINGS = (
    _Setting("CRAWL4AI_URL", "--crawl4ai-url", _check_url, required=True),
    _Setting("CRAWL4AI_API_TOKEN", "--crawl4ai-token", secret=True),
    _Setting("LANGEXTRACT_BASE_URL", "--langextract-base-url", _check_gateway_url, required=True),
    _Setting("LANGEXTRACT_API_KEY", "--langextract-api-key", secret=True),
    _Setting("LANGEXTRACT_MODEL_ID", "--langextract-model-id"),
)


def _mask(value: str) -> str:
    return f"****{value[-4:]}" if len(value) > 4 else "****"


def _is_loopback(url: str) -> bool:
    host = urlsplit(url).hostname or ""
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _prompt(
    setting: _Setting,
    current: str,
    input_fn: Callable[[str], str],
    getpass_fn: Callable[[str], str],
) -> str:
    shown = _mask(current) if setting.secret and current else current
    label = f"{setting.name} [{shown}]: " if current else f"{setting.name}: "
    ask = getpass_fn if setting.secret else input_fn
    while True:
        value = ask(label).strip() or current
        if not value and not setting.required:
            return ""
        if not value:
            print(f"{setting.name} is required")
            continue
        error = setting.validate(value) if setting.validate else None
        if error is None:
            return value
        print(f"{setting.name} {error}")


def _probe(
    label: str,
    url: str,
    token: str | None,
    secrets: Sequence[str],
    opener: Callable[..., Any],
) -> str:
    """One OK/FAIL line. Never raises, and no configured secret is ever part of the line."""
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with opener(req, timeout=PROBE_TIMEOUT) as resp:
            status = resp.status
    except urllib.error.HTTPError as exc:
        reason = f"HTTP {exc.code}"
    except (OSError, ValueError, http.client.HTTPException) as exc:
        reason = str(getattr(exc, "reason", None) or exc)
    else:
        if 200 <= status < 300:
            return f"{label}: OK ({url})"
        reason = f"HTTP {status}"
    for secret in secrets:
        reason = reason.replace(secret, _mask(secret))
    return f"{label}: FAIL ({url}): {reason}"


def _setup(
    args: argparse.Namespace,
    input_fn: Callable[[str], str],
    getpass_fn: Callable[[str], str],
    opener: Callable[..., Any],
) -> int:
    values = config.load()
    if args.non_interactive:
        for setting in _SETTINGS:
            value = (getattr(args, setting.dest) or "").strip()
            if not value:
                continue
            error = setting.validate(value) if setting.validate else None
            if error is not None:
                print(f"docs-ingest: {setting.name} {error}", file=sys.stderr)
                return 2
            values[setting.name] = value
        missing = [s.name for s in _SETTINGS if s.required and not values.get(s.name)]
        if missing:
            print(f"docs-ingest: missing required {', '.join(missing)}", file=sys.stderr)
            return 2
    else:
        try:
            for setting in _SETTINGS:
                current = values.get(setting.name, "")
                value = _prompt(setting, current, input_fn, getpass_fn)
                if value:
                    values[setting.name] = value
                else:
                    values.pop(setting.name, None)
        except (EOFError, KeyboardInterrupt):
            print("\nsetup cancelled; nothing was written", file=sys.stderr)
            return 1

    for setting in _SETTINGS:
        url = values.get(setting.name, "")
        if setting.validate and url.startswith("http://") and not _is_loopback(url):
            print(
                f"WARNING: {setting.name} is plain http to a non-localhost host; "
                "its bearer key travels in clear. Prefer https://"
            )

    saved = config.save(values)
    print(f"Saved {saved}")
    if args.no_probe:
        return 0

    secrets = [values[s.name] for s in _SETTINGS if s.secret and values.get(s.name)]
    crawl4ai = values.get("CRAWL4AI_URL")
    if crawl4ai:
        token = values.get("CRAWL4AI_API_TOKEN") or None
        url = f"{crawl4ai.rstrip('/')}/health"
        print(_probe("crawl4ai", url, token, secrets, opener))
    gateway = values.get("LANGEXTRACT_BASE_URL")
    if gateway:
        key = values.get("LANGEXTRACT_API_KEY") or None
        url = f"{gateway.rstrip('/')}/models"
        print(_probe("gateway", url, key, secrets, opener))
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="docs-ingest", description="Vendor/external-docs ingestion for obsidian-tc."
    )
    commands = parser.add_subparsers(dest="command", required=True)
    setup = commands.add_parser(
        "setup",
        help="write the endpoint config the live pipeline reads",
        description=(
            "Write the endpoint config to the setup file (mode 0600). Environment variables "
            "still override it at run time."
        ),
    )
    setup.add_argument(
        "--non-interactive",
        action="store_true",
        help="take values from flags only; never prompt",
    )
    setup.add_argument("--no-probe", action="store_true", help="skip the endpoint probes")
    for setting in _SETTINGS:
        setup.add_argument(setting.flag, help=f"sets {setting.name}")
    return parser


def main(
    argv: Sequence[str] | None = None,
    *,
    input_fn: Callable[[str], str] | None = None,
    getpass_fn: Callable[[str], str] | None = None,
    opener: Callable[..., Any] | None = None,
) -> int:
    args = _build_parser().parse_args(argv)
    return _setup(
        args,
        input_fn=input_fn or input,
        getpass_fn=getpass_fn or getpass.getpass,
        opener=opener or urllib.request.urlopen,
    )
