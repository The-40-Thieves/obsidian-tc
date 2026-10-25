"""HTTP for the setup probes and the live pipeline: urllib, but a redirect is never followed.

urllib copies every request header, Authorization included, onto a redirected request, even when
the redirect points at another host or downgrades to plain http. Here a 3xx surfaces as an
``HTTPError`` instead, so a bearer key stays with the endpoint it was configured for.
"""

from __future__ import annotations

import urllib.request
from typing import Any


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str
    ) -> None:
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def open_no_redirect(req: urllib.request.Request, timeout: float) -> Any:
    """``urlopen`` with redirects refused: a 3xx raises ``HTTPError`` carrying its Location."""
    return _OPENER.open(req, timeout=timeout)
