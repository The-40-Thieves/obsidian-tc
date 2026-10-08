"""Test harness for eval/modal_embed_nomic.py: no GPU, no network, no `modal` install needed.

The script's logic is module-level functions plus a thin Modal class. `modal` is replaced with a
stub whose decorators are identity, so the real `Embedder` class is importable and testable with a
mock tokenizer and a mock ORT session.
"""

import sys
import types
from pathlib import Path

EVAL_DIR = Path(__file__).resolve().parent.parent


class _Image:
    """Any builder call (debian_slim, uv_pip_install, add_local_file, ...) returns this image."""

    def __getattr__(self, name):
        return lambda *args, **kwargs: self


class _App:
    def __init__(self, *args, **kwargs):
        pass

    def cls(self, **kwargs):
        return lambda cls: cls

    def local_entrypoint(self):
        return lambda fn: fn


def _identity_decorator():
    return lambda fn: fn


_modal = types.ModuleType("modal")
_modal.App = _App
_modal.Image = _Image()
_modal.enter = _identity_decorator
_modal.method = _identity_decorator
sys.modules["modal"] = _modal
sys.path.insert(0, str(EVAL_DIR))
