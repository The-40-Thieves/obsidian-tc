"""``docs-ingest`` command line. ``setup`` writes the endpoint config the live pipeline reads.

Stdlib only, like the rest of the package: prompts use ``input``/``getpass`` and the probes use
``urllib``. The prompt, getpass and URL opener are injectable, so tests need no TTY or network.
"""

from __future__ import annotations

import argparse
import contextlib
import getpass
import http.client
import ipaddress
import os
import sys
import urllib.error
import urllib.request
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from . import config, transport

PROBE_TIMEOUT = 5

# The credential each URL setting is probed with; named in the plain-http warning.
_CREDENTIAL_FOR = {
    "CRAWL4AI_URL": "CRAWL4AI_API_TOKEN",
    "LANGEXTRACT_BASE_URL": "LANGEXTRACT_API_KEY",
}


def _check_url(value: str) -> str | None:
    try:
        parts = urlsplit(value)
        if parts.scheme in ("http", "https") and parts.hostname:
            if "@" in parts.netloc:
                return "must not contain a username or password; use the token or key setting"
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
    return f"****{value[-4:]}" if len(value) >= 12 else "****"


def _is_loopback(url: str) -> bool:
    host = urlsplit(url).hostname or ""
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _problem(setting: _Setting, value: str) -> str | None:
    """Why ``value`` cannot be saved for ``setting``, or None. Never includes the value."""
    if not value.isprintable():
        return "must be one line of printable text"
    return setting.validate(value) if setting.validate else None


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
        error = _problem(setting, value)
        if error is None:
            return value
        print(f"{setting.name} {error}")


def _redirect_reason(exc: urllib.error.HTTPError) -> str:
    try:
        host = urlsplit((exc.headers or {}).get("Location", "") or "").hostname
    except ValueError:
        host = None
    return f"redirected to {host}" if host else "redirected"


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
        req.add_unredirected_header("Authorization", f"Bearer {token}")
    try:
        with opener(req, timeout=PROBE_TIMEOUT) as resp:
            status = resp.status
    except urllib.error.HTTPError as exc:
        reason = _redirect_reason(exc) if 300 <= exc.code < 400 else f"HTTP {exc.code}"
        with contextlib.suppress(OSError, ValueError):
            exc.close()
    except (OSError, ValueError, http.client.HTTPException) as exc:
        reason = str(getattr(exc, "reason", None) or exc)
    else:
        if 200 <= status < 300:
            return f"{label}: OK ({url})"
        reason = f"HTTP {status}"
    # The reason can carry server-sent bytes (a malformed status line); escape them so a server
    # cannot drive the terminal. Escape before masking: escaping could otherwise rebuild a
    # secret's text after the mask missed it. Longest first, so a secret that starts with
    # another is masked whole.
    reason = "".join(c if c.isprintable() else repr(c)[1:-1] for c in reason)
    for secret in sorted(secrets, key=len, reverse=True):
        reason = reason.replace(secret, _mask(secret))
    return f"{label}: FAIL ({url}): {reason}"


def _effective(values: dict[str, str], name: str) -> str:
    """The value a live run would use: each environment name first, then the same names in the
    setup file (``config.get``'s order, applied to the values setup is about to save)."""
    names = config.env_names(name)
    for source in (os.environ, values):
        for env_name in names:
            value = (source.get(env_name) or "").strip()
            if value:
                return value
    return ""


def _setup(
    args: argparse.Namespace,
    input_fn: Callable[[str], str],
    getpass_fn: Callable[[str], str],
    opener: Callable[..., Any],
) -> int:
    try:
        values = config.load()
    except (OSError, UnicodeDecodeError, RuntimeError, ValueError) as exc:
        print(
            f"docs-ingest: cannot read {config.location()} ({type(exc).__name__}); "
            "fix or remove it, then run setup again",
            file=sys.stderr,
        )
        return 2
    # argparse keeps no flag order, so two `-` secrets would be read in this list's order, and a
    # reversed command line would file each secret under the other's name.
    dashes = [s.name for s in _SETTINGS if s.secret and getattr(args, s.dest) == "-"]
    if len(dashes) > 1:
        print(
            f"docs-ingest: only one secret can be read from stdin; got - for {', '.join(dashes)}",
            file=sys.stderr,
        )
        return 2
    for setting in _SETTINGS:
        raw = getattr(args, setting.dest)
        if raw is None:
            continue
        if raw == "-" and setting.secret:
            # On a terminal, read it like the prompt does: hidden, with a label.
            try:
                if sys.stdin.isatty():
                    raw = getpass_fn(f"{setting.name}: ")
                else:
                    raw = sys.stdin.readline()
            except (EOFError, KeyboardInterrupt, AttributeError, OSError, ValueError):
                # Ctrl-D/Ctrl-C at the prompt, or no usable stdin at all (closed or None).
                raw = ""
            if not raw.strip():
                print(
                    f"docs-ingest: {setting.name} is empty: stdin had no line to read",
                    file=sys.stderr,
                )
                return 2
        value = raw.strip()
        if not value:
            continue
        error = _problem(setting, value)
        if error is not None:
            print(f"docs-ingest: {setting.name} {error}", file=sys.stderr)
            return 2
        values[setting.name] = value

    if args.non_interactive:
        missing = [s.name for s in _SETTINGS if s.required and not values.get(s.name)]
        if missing:
            print(f"docs-ingest: missing required {', '.join(missing)}", file=sys.stderr)
            return 2
    else:
        try:
            for setting in _SETTINGS:
                value = _prompt(setting, values.get(setting.name, ""), input_fn, getpass_fn)
                if value:
                    values[setting.name] = value
                else:
                    values.pop(setting.name, None)
        except (EOFError, KeyboardInterrupt):
            print("\nsetup cancelled; nothing was written", file=sys.stderr)
            return 1

    for setting in _SETTINGS:
        url = values.get(setting.name, "")
        if setting.validate and urlsplit(url).scheme == "http" and not _is_loopback(url):
            credential = _CREDENTIAL_FOR.get(setting.name, "")
            consequence = (
                "its bearer key travels in clear"
                if _effective(values, credential)
                else "its traffic is unencrypted"
            )
            print(
                f"WARNING: {setting.name} is plain http to a non-localhost host; "
                f"{consequence}. Prefer https://"
            )

    try:
        saved = config.save(values)
    except (OSError, ValueError) as exc:
        # save()'s ValueError names the setting, never its value; a hand-edited file can hold
        # one setup itself would refuse.
        print(f"docs-ingest: cannot save {config.location()}: {exc}", file=sys.stderr)
        return 2
    print(f"Saved {saved}")
    for setting in _SETTINGS:
        value = values.get(setting.name)
        if not value:
            continue
        for env_name in config.env_names(setting.name):
            env_value = os.environ.get(env_name, "").strip()
            if env_value:
                if env_value != value:
                    print(
                        f"NOTE: {env_name} is set in the environment and overrides the saved "
                        f"{setting.name} at run time; unset it to use the saved value"
                    )
                break
    if args.no_probe:
        return 0

    # Probe with what a live run would send, and mask every secret either source holds.
    secrets = [values[s.name] for s in _SETTINGS if s.secret and values.get(s.name)]
    secrets += [v for s in _SETTINGS if s.secret and (v := _effective(values, s.name))]
    crawl4ai = values.get("CRAWL4AI_URL")
    if crawl4ai:
        token = _effective(values, "CRAWL4AI_API_TOKEN") or None
        url = f"{crawl4ai.rstrip('/')}/health"
        print(_probe("crawl4ai", url, token, secrets, opener))
    gateway = values.get("LANGEXTRACT_BASE_URL")
    if gateway:
        key = _effective(values, "LANGEXTRACT_API_KEY") or None
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
            "Write the endpoint config to the setup file (mode 0600 on POSIX). Environment "
            "variables still override it at run time. A secret flag given as '-' is read from "
            "one line of stdin; a value on the command line is visible in the process list and "
            "shell history, so prefer the prompt or '-'."
        ),
    )
    setup.add_argument(
        "--non-interactive",
        action="store_true",
        help="take values from flags only; never prompt",
    )
    setup.add_argument("--no-probe", action="store_true", help="skip the endpoint probes")
    for setting in _SETTINGS:
        help_text = f"sets {setting.name}"
        if setting.secret:
            help_text += "; '-' reads it from one line of stdin"
        setup.add_argument(setting.flag, help=help_text)
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
        opener=opener or transport.open_no_redirect,
    )
