"""Fixtures for the folder-picker E2E.

The island is a WebView2 surface, which UI Automation cannot read into, so
these tests do not drive the chat chip. They drive the one thing that *is* a
native window — the shell folder dialog — and they reach it by running the
`#[ignore]`d Rust tests that call `platform::pick_folder()` directly.

The test binary is built and launched by us rather than left to `cargo test`,
because `cargo` runs it as a child: the dialog would belong to a pid we never
saw, and every lookup here is scoped to a pid.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

WINDOWS_DIR = Path(__file__).resolve().parents[2]
ARTIFACTS = Path(__file__).resolve().parent / "artifacts"


def _test_binary() -> Path:
    """Builds the lib test binary and returns its path.

    `--message-format=json` is how we learn where Cargo put it; parsing the
    human output would break the first time Cargo reworded a line.
    """
    proc = subprocess.run(
        [
            "cargo", "test", "--no-run", "-p", "coucou", "--lib",
            "--message-format=json",
        ],
        cwd=WINDOWS_DIR,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        pytest.fail(f"cargo test --no-run failed:\n{proc.stderr[-4000:]}")

    for line in proc.stdout.splitlines():
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if msg.get("reason") != "compiler-artifact" or not msg.get("profile", {}).get("test"):
            continue
        exe = msg.get("executable")
        if exe:
            return Path(exe)
    pytest.fail("cargo reported no test executable for the coucou lib target")


@pytest.fixture(scope="session")
def test_binary() -> Path:
    return _test_binary()


@pytest.fixture
def run_ignored(test_binary: Path):
    """Runs one `#[ignore]`d Rust test and hands back the live process.

    The test is started and *not* waited on: it blocks inside the modal dialog,
    which is the whole point — the caller drives that dialog and only then
    collects the exit status.
    """
    started: list[subprocess.Popen] = []

    def start(name: str) -> subprocess.Popen:
        proc = subprocess.Popen(
            [str(test_binary), name, "--ignored", "--exact", "--nocapture", "--test-threads=1"],
            cwd=WINDOWS_DIR,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        started.append(proc)
        return proc

    yield start

    for proc in started:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)


@pytest.fixture(autouse=True)
def _artifacts_dir():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    return ARTIFACTS


def pytest_configure(config):
    if sys.platform != "win32":
        pytest.exit("the folder-picker E2E only means anything on Windows", returncode=0)
    # pywinauto needs a real interactive session; a service or SSH shell has none.
    if os.environ.get("CI") and not os.environ.get("E2E_HAS_DESKTOP"):
        pytest.exit("no interactive desktop: set E2E_HAS_DESKTOP=1 to force", returncode=0)
