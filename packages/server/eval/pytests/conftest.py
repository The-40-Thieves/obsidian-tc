"""Test harness for eval/modal_embed_nomic.py and eval/modal_embed_gemma2.py: no GPU, no network,
no `modal` install needed.

The scripts' logic is module-level functions plus a thin Modal class. `modal` is replaced with a
stub whose decorators are identity, so the real `Embedder` classes are importable and testable with
a mock tokenizer, a mock ORT session or a fake SentenceTransformer-shaped model.
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


class _Volume:
    """`modal_embed_gemma2.py` keeps its Hugging Face cache on a Volume and commits it after the
    download; both calls are no-ops here."""

    @classmethod
    def from_name(cls, *args, **kwargs):
        return cls()

    def commit(self):
        pass


def _parameter(*args, **kwargs):
    """`precision: str = modal.parameter(default=...)` on the Embedder class: a class attribute that
    tests set directly, so the stub just returns None."""
    return None


_modal = types.ModuleType("modal")
_modal.App = _App
_modal.Image = _Image()
_modal.Volume = _Volume
_modal.parameter = _parameter
_modal.enter = _identity_decorator
_modal.method = _identity_decorator
sys.modules["modal"] = _modal
sys.path.insert(0, str(EVAL_DIR))
