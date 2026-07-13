"""Scheduler: gates any blocking model call and rejects past the inflight cap."""

from __future__ import annotations

import asyncio
import threading

import pytest

from obsidian_tc_bge.batching import OverloadError, Scheduler


async def test_run_executes_in_executor():
    sched = Scheduler(object(), 4)
    assert await sched.run(lambda a, b: a + b, 2, 3) == 5


async def test_run_rejects_when_at_capacity():
    sched = Scheduler(object(), 1)
    release = threading.Event()

    def blocker():
        release.wait(timeout=2)
        return "done"

    first = asyncio.create_task(sched.run(blocker))
    await asyncio.sleep(0.05)  # let `first` enter the gate (inflight -> 1)
    with pytest.raises(OverloadError):
        await sched.run(lambda: 1)
    release.set()
    assert await first == "done"
