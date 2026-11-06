#!/usr/bin/env python3
"""Run native-input Windows UI acceptance against an isolated local JobHuntAI web app."""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
import zipfile
from ctypes import wintypes
from datetime import datetime, timezone
from pathlib import Path

try:
    import psutil
    from PIL import ImageGrab
    import websocket
except ImportError as exc:
    raise SystemExit(
        f"Missing runner dependency: {exc.name}. Install with: "
        "python -m pip install pillow psutil websocket-client"
    )


WM_CLOSE = 0x0010
SW_MAXIMIZE = 3
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_VIRTUALDESK = 0x4000
MOUSEEVENTF_ABSOLUTE = 0x8000
INPUT_MOUSE = 0
INPUT_KEYBOARD = 1
WM_GETTEXT = 0x000D

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_size_t),
    ]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_size_t),
    ]


class INPUTUNION(ctypes.Union):
    _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", INPUTUNION)]


class POINT(ctypes.Structure):
    _fields_ = [("x", wintypes.LONG), ("y", wintypes.LONG)]


user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
user32.SendInput.restype = wintypes.UINT
user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
user32.SetCursorPos.restype = wintypes.BOOL
user32.GetCursorPos.argtypes = [ctypes.POINTER(POINT)]
user32.GetCursorPos.restype = wintypes.BOOL
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
user32.IsWindowVisible.argtypes = [wintypes.HWND]
user32.IsWindowVisible.restype = wintypes.BOOL
user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
user32.GetWindowTextLengthW.restype = ctypes.c_int
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowTextW.restype = ctypes.c_int
user32.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, ctypes.c_ssize_t]
user32.SendMessageW.restype = ctypes.c_ssize_t
user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetClassNameW.restype = ctypes.c_int
user32.GetDlgCtrlID.argtypes = [wintypes.HWND]
user32.GetDlgCtrlID.restype = ctypes.c_int
user32.GetDlgItem.argtypes = [wintypes.HWND, ctypes.c_int]
user32.GetDlgItem.restype = wintypes.HWND
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user32.GetWindowRect.restype = wintypes.BOOL
user32.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user32.GetClientRect.restype = wintypes.BOOL
user32.ClientToScreen.argtypes = [wintypes.HWND, ctypes.POINTER(POINT)]
user32.ClientToScreen.restype = wintypes.BOOL
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
user32.AttachThreadInput.restype = wintypes.BOOL
user32.AllowSetForegroundWindow.argtypes = [wintypes.DWORD]
user32.AllowSetForegroundWindow.restype = wintypes.BOOL
kernel32.GetCurrentThreadId.restype = wintypes.DWORD
user32.SetFocus.argtypes = [wintypes.HWND]
user32.SetFocus.restype = wintypes.HWND
user32.SetActiveWindow.argtypes = [wintypes.HWND]
user32.SetActiveWindow.restype = wintypes.HWND
user32.EnumWindows.restype = wintypes.BOOL
user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
user32.ShowWindow.restype = wintypes.BOOL
user32.BringWindowToTop.argtypes = [wintypes.HWND]
user32.BringWindowToTop.restype = wintypes.BOOL
user32.SetForegroundWindow.argtypes = [wintypes.HWND]
user32.SetForegroundWindow.restype = wintypes.BOOL
user32.GetForegroundWindow.restype = wintypes.HWND
user32.IsZoomed.argtypes = [wintypes.HWND]
user32.IsZoomed.restype = wintypes.BOOL
user32.GetSystemMetrics.argtypes = [ctypes.c_int]
user32.GetSystemMetrics.restype = ctypes.c_int
user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user32.PostMessageW.restype = wintypes.BOOL
if hasattr(user32, "SetProcessDpiAwarenessContext"):
    user32.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
    user32.SetProcessDpiAwarenessContext.restype = wintypes.BOOL
if hasattr(user32, "SetProcessDPIAware"):
    user32.SetProcessDPIAware.restype = wintypes.BOOL


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def enable_per_monitor_dpi_awareness() -> str:
    if hasattr(user32, "SetProcessDpiAwarenessContext"):
        if user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):
            return "per-monitor-v2"
    if user32.SetProcessDPIAware():
        return "system-aware fallback"
    return "already configured by process manifest or host"


def json_write(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def send_input(item: INPUT) -> None:
    if user32.SendInput(1, ctypes.byref(item), ctypes.sizeof(INPUT)) != 1:
        raise OSError(ctypes.get_last_error(), "SendInput did not deliver the input event")


def key_event(vk: int, down: bool) -> None:
    flags = 0 if down else KEYEVENTF_KEYUP
    send_input(INPUT(type=INPUT_KEYBOARD, ki=KEYBDINPUT(vk, 0, flags, 0, 0)))


def press_key(vk: int, ctrl: bool = False) -> None:
    if ctrl:
        key_event(0x11, True)
    key_event(vk, True)
    key_event(vk, False)
    if ctrl:
        key_event(0x11, False)


def type_unicode(text: str) -> None:
    for char in text:
        code = ord(char)
        send_input(INPUT(type=INPUT_KEYBOARD, ki=KEYBDINPUT(0, code, KEYEVENTF_UNICODE, 0, 0)))
        send_input(INPUT(type=INPUT_KEYBOARD, ki=KEYBDINPUT(0, code, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, 0, 0)))


def mouse_click(x: int, y: int) -> str:
    method = "SetCursorPos"
    if not user32.SetCursorPos(x, y):
        method = "absolute SendInput fallback"
        left = user32.GetSystemMetrics(76)
        top = user32.GetSystemMetrics(77)
        width = max(1, user32.GetSystemMetrics(78))
        height = max(1, user32.GetSystemMetrics(79))
        absolute_x = round((x - left) * 65535 / max(1, width - 1))
        absolute_y = round((y - top) * 65535 / max(1, height - 1))
        flags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK
        send_input(INPUT(type=INPUT_MOUSE, mi=MOUSEINPUT(absolute_x, absolute_y, 0, flags, 0, 0)))
    for flags in (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP):
        send_input(INPUT(type=INPUT_MOUSE, mi=MOUSEINPUT(0, 0, 0, flags, 0, 0)))
    return method


def mouse_wheel(x: int, y: int, delta: int) -> None:
    if not user32.SetCursorPos(x, y):
        raise OSError(ctypes.get_last_error(), "Could not move the native pointer before scrolling")
    send_input(INPUT(type=INPUT_MOUSE, mi=MOUSEINPUT(0, 0, delta & 0xFFFFFFFF, MOUSEEVENTF_WHEEL, 0, 0)))


def safe_environment(run_root: Path) -> dict[str, str]:
    blocked_fragments = (
        "SUPABASE", "OPENAI", "GOOGLE", "CHATGPT", "BRIDGE", "CLOUDFLARE",
        "TOKEN", "SECRET", "PASSWORD", "API_KEY", "AUTH", "DATABASE", "PRIVATE",
        "COOKIE", "SESSION", "JWT", "SSH", "SENTRY", "NPM_CONFIG", "NEXT_PUBLIC",
    )
    env = {
        key: value for key, value in os.environ.items()
        if not any(fragment in key.upper() for fragment in blocked_fragments)
        and not key.upper().startswith("JOBHUNT_")
    }
    isolated = run_root / "isolated-user"
    appdata = isolated / "AppData" / "Roaming"
    localappdata = isolated / "AppData" / "Local"
    tempdir = run_root / "temp"
    # Create test-owned shell folders inside the disposable environment. The
    # real-backend desktop runner enters a complete synthetic path in the native
    # picker, so it does not browse or capture the host's known folders.
    known_folders = [isolated / name for name in ("Desktop", "Documents", "Downloads", "Pictures", "Music", "Videos")]
    for directory in (isolated, appdata, localappdata, tempdir, *known_folders):
        directory.mkdir(parents=True, exist_ok=True)
    env.update({
        "USERPROFILE": str(isolated),
        "APPDATA": str(appdata),
        "LOCALAPPDATA": str(localappdata),
        "TEMP": str(tempdir),
        "TMP": str(tempdir),
        "HOMEDRIVE": str(isolated.drive),
        "HOMEPATH": str(isolated)[len(str(isolated.drive)):],
        "JOBHUNT_DATA_MODE": "local",
        "NEXT_TELEMETRY_DISABLED": "1",
    })
    env.pop("NODE_OPTIONS", None)
    env.pop("NODE_PATH", None)
    return env


def tracked_source_files(repo: Path) -> list[str]:
    result = subprocess.run(
        ["git", "-C", str(repo), "ls-files", "-z", "--", "package.json", "package-lock.json", "apps/web", "packages", "supabase/functions/chatgpt-bridge/job-url-inspection-response.ts"],
        capture_output=True, check=True,
    )
    excluded = {".git", ".next", "node_modules", "coverage"}
    paths = []
    for raw in result.stdout.decode("utf-8", errors="strict").split("\0"):
        if not raw:
            continue
        rel = Path(raw)
        parts = {part.lower() for part in rel.parts}
        if parts & excluded or any(part.lower().startswith(".env") for part in rel.parts):
            continue
        paths.append(raw)
    return paths


def copy_isolated_workspace(repo: Path, workspace: Path) -> tuple[int, int, dict[str, int], list[str]]:
    files = tracked_source_files(repo)
    copied = 0
    for raw in files:
        source = repo / Path(raw)
        destination = workspace / Path(raw)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        copied += 1

    # The M01 diagnostic-session helper is intentionally new and therefore not
    # returned by git ls-files yet. Include this one reviewed source file so the
    # isolated desktop run exercises the actual worktree implementation.
    supplemental_source_files = [
        Path("apps/web/lib/chatgpt-bridge/diagnostic-session.ts"),
        Path("apps/web/lib/onboarding/readiness.ts"),
    ]
    copied_supplemental = []
    for relative in supplemental_source_files:
        source = repo / relative
        if source.is_file():
            destination = workspace / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
            copied_supplemental.append(relative.as_posix())

    package_json = json.loads((workspace / "apps/web/package.json").read_text(encoding="utf-8"))
    package_map: dict[str, Path] = {}
    for package_dir in (repo / "packages").iterdir():
        manifest = package_dir / "package.json"
        if manifest.is_file():
            name = json.loads(manifest.read_text(encoding="utf-8")).get("name")
            if name:
                package_map[name] = package_dir
    local_modules = workspace / "apps/web/node_modules"
    local_modules.mkdir(parents=True, exist_ok=True)

    dependency_files = {"hardlinked": 0, "copiedFallback": 0}

    def hardlink_or_copy(source: str, destination: str) -> str:
        try:
            os.link(source, destination)
            dependency_files["hardlinked"] += 1
        except OSError:
            shutil.copy2(source, destination)
            dependency_files["copiedFallback"] += 1
        return destination

    node_modules_source = repo / "node_modules"

    def ignore_workspace_links(directory: str, names: list[str]) -> set[str]:
        if Path(directory).resolve() == node_modules_source.resolve():
            return {name for name in names if name.lower() == "@jobhunt"}
        return set()

    shutil.copytree(
        node_modules_source,
        local_modules,
        copy_function=hardlink_or_copy,
        ignore=ignore_workspace_links,
        dirs_exist_ok=True,
    )

    scope = local_modules / "@jobhunt"
    scope.mkdir(parents=True, exist_ok=True)
    copied_packages = 0
    for name, source in package_map.items():
        destination = scope / name.split("/", 1)[1]
        shutil.copytree(
            source, destination,
            ignore=shutil.ignore_patterns("node_modules", ".next", "coverage", ".env*"),
        )
        copied_packages += 1
    return copied, copied_packages, dependency_files, copied_supplemental


def materialize_fixtures(repo: Path, workspace: Path, run_id: str) -> tuple[int, int]:
    data_root = workspace / "data"
    # Keep UI acceptance independent of repository applicant data. In
    # particular, never copy data/knowledge/seed.json or a generated knowledge
    # base into the disposable workspace: both can contain real candidate
    # facts. All records below are deliberately fictional and bounded.
    fixtures = {
        "jobs/inbox.json": {
            "schemaVersion": "1.0.0",
            "generatedAt": "2026-11-04T00:00:00.000Z",
            "records": [{
                "id": f"M00-SYNTHETIC-JOB-{run_id}",
                "company": "Synthetic Example Co",
                "title": "M00 synthetic QA role",
                "industry": "Synthetic QA",
                "externalJobId": None,
                "sourceUrl": None,
                "applicationUrl": None,
                "location": "Synthetic location",
                "workMode": "remote",
                "salaryText": None,
                "salaryMin": None,
                "salaryMax": None,
                "salaryCurrency": "GBP",
                "postedAt": "2026-11-01",
                "closesAt": None,
                "employmentType": "full-time",
                "atsProvider": None,
                "discoverySource": "m00_synthetic",
                "dedupeKey": f"m00-synthetic-{run_id}",
                "discoveredAt": "2026-11-04T00:00:00.000Z",
                "triage": "recommend",
                "triageReason": "Deterministic synthetic UI validation fixture.",
                "userStatus": "new",
                "archivedAt": None,
                "analysisStatus": "pending",
                "description": "Synthetic job fixture used only for isolated Windows UI validation.",
                "listingSummary": "Synthetic fixture; no employer or applicant data.",
                "analysis": None,
                "requirements": [],
            }],
        },
        "applications/preparing.json": {
            "schemaVersion": "1.0.0",
            "generatedAt": "2026-11-04T00:00:00.000Z",
            "records": [],
        },
        "imports/tracker.normalized.json": {
            "schemaVersion": "1.0.0",
            "generatedAt": "2026-11-04T00:00:00.000Z",
            "summary": {"total": 0, "actionRequired": 0, "underReview": 0, "received": 0, "rejected": 0, "assessments": 0, "interviews": 0},
            "quality": {"issueCount": 0, "errorCount": 0, "warningCount": 0, "infoCount": 0, "issues": []},
            "records": [],
        },
        "knowledge/knowledge-base.generated.json": {
            "schemaVersion": "1.0.0",
            "generatedAt": "2026-11-04T00:00:00.000Z",
            "profile": {"display_name": "Synthetic QA Candidate", "facts": []},
            "evidence": [],
            "preferences": {},
        },
        "knowledge/source-manifest.json": {
            "schemaVersion": "1.0.0",
            "generatedAt": "2026-11-04T00:00:00.000Z",
            "sources": [],
        },
    }
    total_bytes = 0
    for relative, payload in fixtures.items():
        destination = data_root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        text = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
        destination.write_text(text, encoding="utf-8", newline="\n")
        total_bytes += destination.stat().st_size
    return len(fixtures), total_bytes


def find_chrome() -> Path:
    candidates = []
    for variable in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
        base = os.environ.get(variable)
        if base:
            candidates.append(Path(base) / "Google/Chrome/Application/chrome.exe")
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    found = shutil.which("chrome.exe") or shutil.which("chrome")
    if found:
        return Path(found).resolve()
    raise FileNotFoundError("Google Chrome was not found in standard Windows locations")


def file_product_version(path: Path) -> str | None:
    escaped = str(path).replace("'", "''")
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
         f"(Get-Item -LiteralPath '{escaped}').VersionInfo.ProductVersion"],
        capture_output=True, text=True, check=False, timeout=10,
    )
    value = result.stdout.strip()
    return value or None


def free_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def process_tree_pids(process: subprocess.Popen) -> list[int]:
    pids = [process.pid]
    try:
        root = psutil.Process(process.pid)
        pids.extend(child.pid for child in root.children(recursive=True))
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        pass
    return sorted(set(pids))


def wait_processes_exit(pids: list[int], timeout: float = 8.0) -> list[int]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        alive = []
        for pid in pids:
            try:
                proc = psutil.Process(pid)
                if proc.is_running() and proc.status() != psutil.STATUS_ZOMBIE:
                    alive.append(pid)
            except psutil.NoSuchProcess:
                pass
            except psutil.AccessDenied:
                alive.append(pid)
        if not alive:
            return []
        time.sleep(0.2)
    return alive


def stop_owned_process(process: subprocess.Popen | None, pids: list[int], graceful: bool = True) -> list[int]:
    if process is None:
        return []
    all_pids = sorted(set(pids + process_tree_pids(process)))
    if process.poll() is None and graceful:
        try:
            if os.name == "nt":
                process.send_signal(signal.CTRL_BREAK_EVENT)
            else:
                process.terminate()
        except (OSError, ValueError):
            pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
    alive = wait_processes_exit(all_pids, timeout=3)
    if alive:
        owned = []
        for pid in alive:
            try:
                owned.append(psutil.Process(pid))
            except psutil.NoSuchProcess:
                pass
        for item in owned:
            try:
                item.terminate()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        _, alive_processes = psutil.wait_procs(owned, timeout=4)
        for item in alive_processes:
            try:
                item.kill()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        alive = wait_processes_exit(all_pids, timeout=4)
    return alive


def cdp_connect(profile: Path, chrome_process: subprocess.Popen, timeout: float = 35.0):
    active_port = profile / "DevToolsActivePort"
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if chrome_process.poll() is not None:
            raise RuntimeError(f"Test-owned Chrome exited during startup (exit {chrome_process.returncode})")
        if active_port.is_file():
            lines = active_port.read_text(encoding="utf-8").splitlines()
            if len(lines) >= 2:
                port = int(lines[0])
                path = lines[1]
                return port, path
        time.sleep(0.2)
    raise TimeoutError("Chrome did not publish its isolated loopback DevTools port")


class CDPObserver:
    def __init__(self, port: int, chrome_process: subprocess.Popen):
        self.port = port
        self.chrome_process = chrome_process
        self.ws = None
        self.next_id = 0
        self.target_url = None

    def connect_page(self, app_url: str):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if self.chrome_process.poll() is not None:
                raise RuntimeError("Test-owned Chrome exited before a page target became available")
            try:
                req = urllib.request.Request(
                    f"http://127.0.0.1:{self.port}/json/list",
                    headers={"Origin": "http://localhost"},
                )
                with urllib.request.urlopen(req, timeout=3) as response:
                    targets = json.loads(response.read())
                target = next(
                    (item for item in targets if item.get("type") == "page" and item.get("url", "").startswith(app_url)),
                    None,
                )
                if target:
                    self.ws = websocket.create_connection(
                        target["webSocketDebuggerUrl"],
                        timeout=5,
                        origin="http://localhost",
                        suppress_origin=False,
                    )
                    self.target_url = target["url"]
                    return
            except Exception:
                time.sleep(0.3)
        raise TimeoutError("Could not connect read-only CDP observation to the isolated app tab")

    def evaluate(self, expression: str):
        if self.ws is None:
            raise RuntimeError("CDP observer is not connected")
        self.next_id += 1
        command_id = self.next_id
        self.ws.send(json.dumps({
            "id": command_id,
            "method": "Runtime.evaluate",
            "params": {"expression": expression, "returnByValue": True, "awaitPromise": True},
        }))
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            message = json.loads(self.ws.recv())
            if message.get("id") != command_id:
                continue
            if "error" in message:
                raise RuntimeError("CDP observation failed: " + str(message["error"]))
            response = message.get("result", {})
            result = response.get("result", {})
            if response.get("exceptionDetails"):
                details = response["exceptionDetails"]
                exception = details.get("exception", {})
                description = exception.get("description") or exception.get("value") or ""
                raise RuntimeError("Page observation exception: " + details.get("text", "unknown") + (": " + str(description) if description else ""))
            value = result.get("value")
            if isinstance(value, str):
                try:
                    return json.loads(value)
                except json.JSONDecodeError:
                    return value
            return value
        raise TimeoutError("Timed out waiting for read-only CDP result")

    def command(self, method: str, params: dict | None = None):
        """Send a CDP command only to this test-owned, loopback browser target."""
        if self.ws is None:
            raise RuntimeError("CDP observer is not connected")
        self.next_id += 1
        command_id = self.next_id
        self.ws.send(json.dumps({"id": command_id, "method": method, "params": params or {}}))
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            message = json.loads(self.ws.recv())
            if message.get("id") != command_id:
                continue
            if "error" in message:
                raise RuntimeError(f"CDP command {method} failed: {message['error']}")
            return message.get("result", {})
        raise TimeoutError(f"Timed out waiting for CDP command {method}")

    def state(self):
        expression = """JSON.stringify((() => {
          const input = document.querySelector('input[placeholder="Search company, role, location…"]');
          const rows = [...document.querySelectorAll('.jobPoolTable tbody tr')];
          const nav = [...document.querySelectorAll('nav[aria-label="Main navigation"] a')].map(a => ({
            text: a.innerText.trim(), href: a.getAttribute('href'), rect: (() => { const r=a.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()
          }));
          const links = [...document.querySelectorAll('a[href]')].map(a => ({
            text: a.innerText.trim(), href: a.getAttribute('href'), rect: (() => { const r=a.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()
          }));
          const summaries = [...document.querySelectorAll('details > summary')].map(summary => ({
            text: summary.innerText.trim(), open: !!summary.parentElement?.open,
            rect: (() => { const r=summary.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()
          }));
          const buttons = [...document.querySelectorAll('button')].map(button => ({
            text: button.innerText.trim(), disabled: button.disabled,
            rect: (() => { const r=button.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()
          }));
          const bridgePanel = (() => {
            const panel = document.querySelector('#chatgpt-bridge');
            if (!panel) return null;
            return {
              visible: panel.getClientRects().length > 0,
              heading: panel.querySelector('h2')?.innerText.trim() || null,
              viewportRect: (() => { const r=panel.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })(),
              inViewport: (() => { const r=panel.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; })(),
              fullyInViewport: (() => { const r=panel.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })(),
              badge: panel.querySelector('.cardHeader > .badge')?.innerText.trim() || null,
              emptyMessage: panel.querySelector('.bridgeEmptyState')?.innerText.trim() || null,
              buttons: [...panel.querySelectorAll('button')].map(button => ({text: button.innerText.trim(), disabled: button.disabled})),
              connection: [...panel.querySelectorAll('.bridgeStatusList > div')].map(row => ({label: row.querySelector('span')?.innerText.trim() || '', state: row.querySelector('strong')?.innerText.trim() || ''}))
            };
          })();
          const testingMode = (() => {
            const section = [...document.querySelectorAll('section')].find(item => item.querySelector('h2')?.innerText.trim() === 'ChatGPT testing mode');
            if (!section) return null;
            const input = section.querySelector('input[type="checkbox"]');
            return {
              heading: section.querySelector('h2')?.innerText.trim() || null,
              badge: section.querySelector('.badge')?.innerText.trim() || null,
              checked: input?.checked ?? null,
              disabled: input?.disabled ?? null,
              errorVisible: !!section.querySelector('[role="alert"]')
            };
          })();
          const diagnosticMessageButton = [...document.querySelectorAll('button')].find(button => button.innerText.trim() === 'Send to ChatGPT');
          const diagnosticPanel = [...document.querySelectorAll('section')].find(section => section.querySelector('h1')?.innerText.trim() === 'Send a message to ChatGPT');
          const diagnosticMessage = document.querySelector('#diagnostic-message');
          const diagnosticBridgeSummary = diagnosticPanel ? [...(diagnosticPanel.querySelector('[aria-live="polite"]')?.children || [])].map(row => ({
            label: row.querySelector('span')?.innerText.trim() || '', state: row.querySelector('strong')?.innerText.trim() || ''
          })) : [];
          const settingsLink = document.querySelector('a.sideSettingsLink');
          const settingsLinkRect = settingsLink ? (() => { const r=settingsLink.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })() : null;
          const inputRect = input ? (() => { const r=input.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })() : null;
          return {
            href: location.href, readyState: document.readyState, title: document.title,
            heading: document.querySelector('h1')?.innerText.trim() || null,
            input: input ? {value: input.value, focused: document.activeElement === input, rect: inputRect} : null,
            rows: rows.map(row => ({text: row.innerText, jobId: row.querySelector('.jobReference')?.getAttribute('title') || null})),
            emptyText: document.querySelector('.emptyState')?.innerText.trim() || null,
            navigation: nav,
            links,
            summaries,
            buttons,
            bridgePanel,
            testingMode,
            diagnosticMessageButton: diagnosticMessageButton ? {text: diagnosticMessageButton.innerText.trim(), disabled: diagnosticMessageButton.disabled} : null,
            diagnosticMessage: diagnosticMessage ? {value: diagnosticMessage.value, focused: document.activeElement === diagnosticMessage, rect: (() => { const r=diagnosticMessage.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()} : null,
            diagnosticBridgeSummary,
            settingsLink: settingsLinkRect,
            visibleDiagnosticDispatchState: !!document.querySelector('.syncMessage'),
            viewport: {screenX: window.screenX, screenY: window.screenY, dpr: window.devicePixelRatio, outerHeight: window.outerHeight, innerHeight: window.innerHeight, innerWidth: window.innerWidth, screenWidth: screen.width, screenHeight: screen.height},
            scrollY: window.scrollY,
            visible: document.visibilityState,
            resourceOrigins: [...new Set(performance.getEntriesByType('resource').map(e => { try { return new URL(e.name).origin; } catch { return ''; } }).filter(Boolean))]
          };
        })())"""
        return self.evaluate(expression)

    def wait_for(self, predicate, timeout: float = 15.0, description: str = "expected UI state"):
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            last = self.state()
            if predicate(last):
                return last
            time.sleep(0.25)
        raise TimeoutError(f"Timed out waiting for {description}; last state: {last}")

    def close(self):
        if self.ws is not None:
            self.ws.close()
            self.ws = None


def enumerate_windows_for_pid(pid: int) -> list[tuple[int, str, tuple[int, int, int, int]]]:
    found: list[tuple[int, str, tuple[int, int, int, int]]] = []
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def callback(hwnd, _):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value != pid or not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        buffer = ctypes.create_unicode_buffer(max(1, length + 1))
        user32.GetWindowTextW(hwnd, buffer, len(buffer))
        rect = wintypes.RECT()
        if user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            found.append((int(hwnd), buffer.value, (rect.left, rect.top, rect.right, rect.bottom)))
        return True

    user32.EnumWindows(callback_type(callback), 0)
    return found


def enumerate_child_controls(parent_hwnd: int) -> list[dict]:
    controls: list[dict] = []
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def callback(hwnd, _):
        class_name = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, class_name, len(class_name))
        title_length = user32.GetWindowTextLengthW(hwnd)
        title = ctypes.create_unicode_buffer(max(1, title_length + 1))
        user32.GetWindowTextW(hwnd, title, len(title))
        controls.append({"hwnd": int(hwnd), "class": class_name.value,
                         "id": user32.GetDlgCtrlID(hwnd), "text": title.value})
        return True

    user32.EnumChildWindows(parent_hwnd, callback_type(callback), 0)
    return controls


def window_state(hwnd: int, expected_pid: int) -> dict:
    owner = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
    rect = wintypes.RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        raise OSError(ctypes.get_last_error(), "GetWindowRect failed")
    client = wintypes.RECT()
    client_origin = POINT(0, 0)
    if not user32.GetClientRect(hwnd, ctypes.byref(client)) or not user32.ClientToScreen(hwnd, ctypes.byref(client_origin)):
        raise OSError(ctypes.get_last_error(), "Could not read native client-area metrics")
    foreground = user32.GetForegroundWindow()
    foreground_pid = wintypes.DWORD()
    if foreground:
        user32.GetWindowThreadProcessId(foreground, ctypes.byref(foreground_pid))
    title_length = user32.GetWindowTextLengthW(hwnd)
    title_buffer = ctypes.create_unicode_buffer(max(1, title_length + 1))
    user32.GetWindowTextW(hwnd, title_buffer, len(title_buffer))
    width = user32.GetSystemMetrics(0)
    height = user32.GetSystemMetrics(1)
    return {
        "hwnd": hwnd,
        "title": title_buffer.value,
        "ownerPid": owner.value,
        "expectedPid": expected_pid,
        "foregroundHwnd": int(foreground or 0),
        "foregroundPid": foreground_pid.value,
        "isForeground": foreground == hwnd,
        "maximized": bool(user32.IsZoomed(hwnd)),
        "bounds": {"left": rect.left, "top": rect.top, "right": rect.right, "bottom": rect.bottom},
        "client": {"x": client_origin.x, "y": client_origin.y, "width": client.right - client.left, "height": client.bottom - client.top},
        "primaryDisplay": {"width": width, "height": height},
    }


def focus_and_maximize(hwnd: int, pid: int) -> dict:
    user32.ShowWindow(hwnd, SW_MAXIMIZE)
    user32.BringWindowToTop(hwnd)
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.35)
    state = window_state(hwnd, pid)
    activation = "SetForegroundWindow"
    if not state["isForeground"]:
        permission_granted = bool(user32.AllowSetForegroundWindow(pid))
        foreground = user32.GetForegroundWindow()
        foreground_thread = user32.GetWindowThreadProcessId(foreground, None) if foreground else 0
        target_thread = user32.GetWindowThreadProcessId(hwnd, None)
        current_thread = kernel32.GetCurrentThreadId()
        attached_threads: list[int] = []
        try:
            for thread_id in (foreground_thread, target_thread):
                if thread_id and thread_id != current_thread and thread_id not in attached_threads:
                    if user32.AttachThreadInput(current_thread, thread_id, True):
                        attached_threads.append(thread_id)
            user32.ShowWindow(hwnd, SW_MAXIMIZE)
            user32.BringWindowToTop(hwnd)
            user32.SetActiveWindow(hwnd)
            user32.SetForegroundWindow(hwnd)
            user32.SetFocus(hwnd)
        finally:
            for thread_id in reversed(attached_threads):
                user32.AttachThreadInput(current_thread, thread_id, False)
        time.sleep(0.2)
        state = window_state(hwnd, pid)
        activation = {
            "method": "AllowSetForegroundWindow + temporary input-queue attachment + SetForegroundWindow/SetActiveWindow/SetFocus",
            "foregroundPermissionGranted": permission_granted,
            "attachedThreadIds": attached_threads,
            "altTabUsed": False,
        }
    if not state["isForeground"]:
        key_event(0x12, True)
        key_event(0x09, True)
        key_event(0x09, False)
        key_event(0x12, False)
        time.sleep(0.35)
        state = window_state(hwnd, pid)
        if isinstance(activation, dict):
            activation["altTabUsed"] = True
        else:
            activation = {"method": "SetForegroundWindow followed by native Alt+Tab retry", "altTabUsed": True}
    state["foregroundActivation"] = activation
    state["foregroundActivation"] = activation
    if not state["maximized"]:
        raise RuntimeError(f"Chrome window did not maximize: {state}")
    if not state["isForeground"]:
        raise RuntimeError(f"Chrome did not receive foreground focus: {state}")
    if state["ownerPid"] != pid:
        raise RuntimeError("Observed Chrome window is not owned by the test-launched process")
    return state


def screen_point(native_window: dict, viewport: dict, rect: dict, click_point: tuple[float, float] | None = None) -> tuple[int, int, dict]:
    client = native_window["client"]
    scale = client["width"] / max(1, float(viewport["innerWidth"]))
    top_overlay = max(0.0, client["height"] - float(viewport["innerHeight"]) * scale)
    css_x, css_y = click_point or (rect["x"] + rect["width"] / 2, rect["y"] + rect["height"] / 2)
    x = round(client["x"] + css_x * scale)
    y = round(client["y"] + top_overlay + css_y * scale)
    bounds = native_window["bounds"]
    if not (bounds["left"] <= x <= bounds["right"] and bounds["top"] <= y <= bounds["bottom"]):
        raise RuntimeError(f"Computed native click point is outside Chrome bounds: {(x, y)}")
    return x, y, {"scaleFromClientViewport": scale, "titleBarOverlayPx": top_overlay, "devicePixelRatioDiagnostic": viewport["dpr"], "client": client}


def native_click_observed_rect(
    observer: CDPObserver,
    hwnd: int,
    pid: int,
    rect: dict,
    selector: str,
    click_point: tuple[float, float] | None = None,
    allow_test_owned_modal: bool = False,
) -> dict:
    native = focus_and_maximize(hwnd, pid)
    state = observer.state()
    preferred_point = click_point or (rect["x"] + rect["width"] / 2, rect["y"] + rect["height"] / 2)
    selector_literal = json.dumps(selector)
    preferred_x, preferred_y = preferred_point
    hit = observer.evaluate(
        "JSON.stringify((() => { const target=document.querySelector(" + selector_literal + "); "
        "if (!target) return {hitTarget:false,reason:'target missing'}; "
        "const r=target.getBoundingClientRect(); const wrapper=target.closest('label.jobPoolSearch'); "
        "const left=Math.max(0,r.left), right=Math.min(innerWidth,r.right), top=Math.max(0,r.top), bottom=Math.min(innerHeight,r.bottom); "
        "const points=[{" + f"x:{preferred_x},y:{preferred_y}" + "}]; "
        "const columns=32, rows=4; for(let row=0;row<=rows;row++){for(let col=0;col<=columns;col++){ "
        "points.push({x:left+(right-left)*col/columns,y:top+(bottom-top)*row/rows}); }} "
        "for(const point of points){if(point.x<left||point.x>right||point.y<top||point.y>bottom) continue; "
        "const p=document.elementFromPoint(point.x,point.y); const ok=p===target||target.contains(p)||!!wrapper&&(p===wrapper||wrapper.contains(p)); "
        "if(ok) return {targetTag:p?.tagName||null,targetClass:p?.className||null,hitTarget:true,point};} "
        f"const p=document.elementFromPoint(Math.max(0,Math.min(innerWidth-1,{preferred_x})),Math.max(0,Math.min(innerHeight-1,{preferred_y}))); "
        "return {targetTag:p?.tagName||null,targetClass:p?.className||null,hitTarget:false}; })())"
    )
    if not hit or not hit.get("hitTarget"):
        raise RuntimeError(
            f"No visible point in the expected DOM control receives a native click: {hit}; "
            f"selector={selector!r}, rect={rect}, preferredPoint={preferred_point}"
        )
    dom_x, dom_y = hit["point"]["x"], hit["point"]["y"]
    x, y, coordinate_metrics = screen_point(native, state["viewport"], rect, (dom_x, dom_y))
    pointer_method = mouse_click(x, y)
    time.sleep(0.15)
    cursor = POINT()
    if not user32.GetCursorPos(ctypes.byref(cursor)):
        raise OSError(ctypes.get_last_error(), "Could not read back the native pointer position")
    if abs(cursor.x - x) > 2 or abs(cursor.y - y) > 2:
        raise RuntimeError(f"Native pointer position did not match the requested click point: expected {(x, y)}, got {(cursor.x, cursor.y)}")
    focused = user32.GetForegroundWindow()
    foreground_pid = wintypes.DWORD()
    if focused:
        user32.GetWindowThreadProcessId(focused, ctypes.byref(foreground_pid))
    if focused != hwnd and (not allow_test_owned_modal or foreground_pid.value != pid):
        title_length = user32.GetWindowTextLengthW(focused) if focused else 0
        title_buffer = ctypes.create_unicode_buffer(max(1, title_length + 1))
        if focused:
            user32.GetWindowTextW(focused, title_buffer, len(title_buffer))
        is_open_dialog = title_buffer.value.strip().lower() in {"open", "choose a file"}
        if not (allow_test_owned_modal and is_open_dialog):
            raise RuntimeError(f"Chrome lost foreground focus during native click; foreground hwnd={int(focused or 0)}, pid={foreground_pid.value}, title={title_buffer.value!r}, allow_modal={allow_test_owned_modal}")
    return {"x": x, "y": y, "pointerMethod": pointer_method, "cursorReadback": {"x": cursor.x, "y": cursor.y}, "foregroundHwnd": int(focused or 0), "foregroundPid": foreground_pid.value, "testOwnedModalForeground": focused != hwnd, "domHitTest": hit, "coordinateMetrics": coordinate_metrics}


def desktop_screenshot(path: Path, hwnd: int, pid: int, expected_resolution: tuple[int, int]) -> dict:
    state = focus_and_maximize(hwnd, pid)
    image = ImageGrab.grab()
    if image.size != expected_resolution:
        raise RuntimeError(f"Screenshot is not full primary desktop resolution: got {image.size}, expected {expected_resolution}")
    image.save(path, format="PNG", optimize=True)
    return {"path": path.name, "width": image.width, "height": image.height, "fullDesktop": True, "window": state}


def read_report(repo: Path, run_root: Path, evidence: Path, run_id: str, started: str) -> dict:
    head = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    branch = subprocess.run(["git", "-C", str(repo), "branch", "--show-current"], capture_output=True, text=True, check=True).stdout.strip()
    app_manifest = json.loads((repo / "apps/web/package.json").read_text(encoding="utf-8"))
    return {
        "schemaVersion": "1.0.0",
        "recordedAtUtc": utc_now(),
        "startedAtUtc": started,
        "runId": run_id,
        "repository": {"head": head, "branch": branch},
        "environment": {"python": sys.version.split()[0], "dpiAwareness": None},
        "command": "python scripts/windows_web_ui_acceptance.py --source-root .",
        "testLevel": "genuine_windows_desktop_web_ui",
        "application": {
            "type": "Next.js web application hosted in test-owned Chrome; this repository has no packaged Windows app",
            "version": app_manifest.get("version"),
            "framework": "Next.js",
            "frameworkVersion": json.loads((repo / "node_modules/next/package.json").read_text(encoding="utf-8")).get("version"),
            "chromeExecutable": None,
            "chromeVersion": None,
            "chromePid": None,
            "serverPid": None,
            "serverCommand": None,
            "workspace": f"%TEMP%\\JobHuntAI-Windows-UI-{run_id}",
            "userProfile": f"%TEMP%\\JobHuntAI-Windows-UI-{run_id}\\chrome-profile",
        },
        "fixtures": {"count": 0, "bytes": 0, "syntheticJobCount": 1, "privateOrProductionDataCopied": False},
        "milestones": [],
        "workflow": [],
        "screenshots": [],
        "network": {"externalPageResourceOrigins": [], "expectedApplicationOrigin": None},
        "limitations": [
            "No signed-in account or Supabase credentials are used in this isolated synthetic run; live search/preparation service availability is outside scope.",
            "Page resource origins are observed through the app page; Chrome background traffic is not measured by that check.",
        ],
        "cleanup": {"chromeExited": False, "serverExited": False, "ownedProcessPids": {}, "temporaryWorkspaceRemoved": False},
        "result": "RUNNING",
        "error": None,
        "evidenceDirectory": f"%TEMP%\\JobHuntAI-Windows-UI-Evidence\\{run_id}",
    }


def onboarding_snapshot(observer: CDPObserver) -> dict:
    expression = """JSON.stringify((() => {
      const rect = (el) => { if (!el) return null; const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; };
      const text = (el) => (el?.innerText || "").trim();
      const articles = [...document.querySelectorAll("#profile-review-queue article.pendingReviewItem")].map((el, index) => ({
        index: index + 1, text: text(el), source: text(el.querySelector(".recordEditorHeader small")),
        buttons: [...el.querySelectorAll("button")].map((b) => text(b)), rect: rect(el),
      }));
      const sourceDetails = document.querySelector("details.onboardingSavedSources");
      const sources = [...document.querySelectorAll(".onboardingSavedSources .compactList > div")].map((el, index) => ({
        index: index + 1, name: text(el.querySelector("strong")), text: text(el),
      }));
      const employment = [...document.querySelectorAll("#more-profile-details .onboardingSplit > div:first-child form.recordEditor")].map((el) => ({
        text: text(el.querySelector(".recordEditorHeader")), employer: el.querySelector("label input")?.value || "",
        role: el.querySelector(".recordEditorHeader strong")?.innerText.trim() || "",
      }));
      const education = [...document.querySelectorAll("#more-profile-details .onboardingSplit > div:nth-child(2) form.recordEditor")].map((el) => ({
        text: text(el.querySelector(".recordEditorHeader")), institution: el.querySelector("label input")?.value || "",
        qualification: el.querySelector(".recordEditorHeader strong")?.innerText.trim() || "",
      }));
      const skillDetails = [...document.querySelectorAll("#more-profile-details details.onboardingDetails")].find((el) => text(el.querySelector("summary")).startsWith("Skills and tools"));
      const skills = [...(skillDetails?.querySelectorAll("form.recordEditor") || [])].map((el) => ({
        name: el.querySelector(".recordEditorHeader strong")?.innerText.trim() || "", text: text(el.querySelector(".recordEditorHeader")),
      }));
      const buttons = [...document.querySelectorAll("button")].filter((b) => b.getClientRects().length).map((b) => ({text:text(b),disabled:b.disabled,rect:rect(b)}));
      const inputs = [...document.querySelectorAll("input,textarea,select")].filter((el) => el.getClientRects().length).map((el) => ({
        name:el.name || "", type:el.type || el.tagName.toLowerCase(), value:el.value || "", checked:el.checked ?? null,
        focused:document.activeElement===el, rect:rect(el), fileName:el.files?.[0]?.name || null,
      }));
      const setup = document.querySelector("#chatgpt-memory");
      const sync = document.querySelector("#memory-update");
      return {url:location.href,readyState:document.readyState,visible:document.visibilityState,heading:text(document.querySelector("h1")),
        bodyText:text(document.body),viewport:{innerWidth,innerHeight,scrollY,scrollHeight:document.documentElement.scrollHeight,devicePixelRatio},
        sourceDocs: sources, sourceDetailsOpen:!!sourceDetails?.open, reviewItems:articles,
        employment,education,skills,buttons,inputs,
        readinessText:text(document.querySelector(".onboardingProgress")),
        memorySetupText:text(setup),memorySyncText:text(sync),memorySyncVisible:!!sync&&sync.getClientRects().length>0,
        sourceTextValue:document.querySelector("form.sourceInputForm textarea")?.value || "",
        savedAdditionalInformation:(document.body.innerText.includes("Synthetic supplementary note")),
        pageOrigins:[...new Set(performance.getEntriesByType("resource").map(e=>{try{return new URL(e.name).origin}catch{return ""}}).filter(Boolean))]};
    })())"""
    return observer.evaluate(expression)


def onboarding_fixture_state(observer: CDPObserver) -> dict:
    return observer.evaluate(
        "JSON.stringify((() => { const state=JSON.parse(localStorage.getItem('jobhunt-m02-onboarding-fixture-v1') || '{}'); "
        "return {...state,readiness:window.__M02FixtureReadiness?.() || null}; })())"
    )


def onboarding_element(observer: CDPObserver, selector: str) -> dict | None:
    literal = json.dumps(selector)
    return observer.evaluate(
        "JSON.stringify((() => { const el=document.querySelector(" + literal + "); if(!el) return null; "
        "const r=el.getBoundingClientRect(); return {rect:{x:r.x,y:r.y,width:r.width,height:r.height}, "
        "value:el.value ?? null, focused:document.activeElement===el, disabled:!!el.disabled, "
        "displayed:!!el.getClientRects().length, fileName:el.files?.[0]?.name || null}; })())"
    )


def native_wheel_page(observer: CDPObserver, hwnd: int, pid: int, down: bool) -> dict:
    native = focus_and_maximize(hwnd, pid)
    state = onboarding_snapshot(observer)
    x = native["client"]["x"] + round(native["client"]["width"] * 0.92)
    y = native["client"]["y"] + round(native["client"]["height"] * 0.70)
    before = int(state["viewport"]["scrollY"])
    mouse_wheel(x, y, -480 if down else 480)
    cursor = POINT()
    if not user32.GetCursorPos(ctypes.byref(cursor)) or abs(cursor.x - x) > 2 or abs(cursor.y - y) > 2:
        raise RuntimeError("Native scroll pointer did not read back at the requested desktop coordinates")
    time.sleep(0.18)
    after = onboarding_snapshot(observer)
    if after["viewport"]["scrollY"] == before and after["viewport"]["scrollHeight"] > after["viewport"]["innerHeight"]:
        raise RuntimeError("Win32 mouse-wheel input did not change the visible page scroll position")
    return {"direction": "down" if down else "up", "from": before, "to": after["viewport"]["scrollY"],
            "cursorReadback": {"x": cursor.x, "y": cursor.y}, "foreground": window_state(hwnd, pid)["isForeground"]}


def ensure_onboarding_visible(observer: CDPObserver, hwnd: int, pid: int, selector: str, attempts: int = 24) -> dict:
    for _ in range(attempts):
        item = onboarding_element(observer, selector)
        if not item:
            raise RuntimeError(f"Visible UI control is missing: {selector}")
        rect = item["rect"]
        viewport = onboarding_snapshot(observer)["viewport"]
        if rect["y"] >= 0 and rect["y"] + rect["height"] <= viewport["innerHeight"]:
            return item
        down = rect["y"] + rect["height"] > viewport["innerHeight"]
        old = viewport["scrollY"]
        native_wheel_page(observer, hwnd, pid, down=down)
        new_scroll = onboarding_snapshot(observer)["viewport"]["scrollY"]
        if new_scroll == old:
            break
    item = onboarding_element(observer, selector)
    if not item:
        raise RuntimeError(f"UI control disappeared while scrolling: {selector}")
    rect = item["rect"]
    viewport = onboarding_snapshot(observer)["viewport"]
    if rect["y"] + rect["height"] <= 0 or rect["y"] >= viewport["innerHeight"]:
        raise RuntimeError(f"Native scrolling could not bring the control into view: {selector}; rect={rect}")
    return item


def native_click_selector(observer: CDPObserver, hwnd: int, pid: int, selector: str) -> dict:
    item = ensure_onboarding_visible(observer, hwnd, pid, selector)
    return native_click_observed_rect(observer, hwnd, pid, item["rect"], selector)


def native_replace_value(observer: CDPObserver, hwnd: int, pid: int, selector: str, value: str) -> dict:
    item = ensure_onboarding_visible(observer, hwnd, pid, selector)
    click = native_click_observed_rect(observer, hwnd, pid, item["rect"], selector)
    focused = onboarding_element(observer, selector)
    if not focused or not focused["focused"]:
        raise RuntimeError(f"Native click failed to focus {selector}")
    press_key(0x41, ctrl=True)
    press_key(0x08)
    type_unicode(value)
    deadline = time.monotonic() + 5
    after = None
    while time.monotonic() < deadline:
        after = onboarding_element(observer, selector)
        if after and after["value"] == value and after["focused"]:
            break
        time.sleep(0.1)
    if not after or after["value"] != value or not after["focused"]:
        raise RuntimeError(f"Native Unicode entry did not persist in {selector}: {after}")
    return {"click": click, "valueReadback": after["value"], "activeElementReadback": after["focused"]}


def native_choose_file(observer: CDPObserver, hwnd: int, pid: int, selector: str, file_path: Path,
                       verify_fixture_event: bool = True, full_path_in_filename: bool = False) -> dict:
    item = ensure_onboarding_visible(observer, hwnd, pid, selector)
    fixture_before = onboarding_fixture_state(observer) if verify_fixture_event else {}
    upload_attempts_before = fixture_before.get("diagnostics", {}).get("uploadAttempts", 0)
    click = native_click_observed_rect(observer, hwnd, pid, item["rect"], selector, allow_test_owned_modal=True)
    time.sleep(0.5)
    dialog = user32.GetForegroundWindow()
    length = user32.GetWindowTextLengthW(dialog) if dialog else 0
    title = ctypes.create_unicode_buffer(max(1, length + 1))
    if dialog:
        user32.GetWindowTextW(dialog, title, len(title))
    controls = enumerate_child_controls(int(dialog)) if dialog else []
    if not dialog or title.value.strip().lower() != "open":
        raise RuntimeError(f"Expected the native Open file dialog; saw title={title.value!r}")
    filename_control = next((item for item in controls if item["class"] == "Edit" and item["id"] == 1148), None)
    address_control = next((item for item in controls if item["class"] == "Edit" and item["id"] == 41477), None)
    open_control = next((item for item in controls if item["class"] == "Button" and item["id"] == 1), None)
    control_summary = [{"class": item["class"], "id": item["id"]} for item in controls
                       if (item["class"], item["id"]) in {("Edit", 1148), ("Edit", 41477), ("Button", 1)}]
    if not filename_control or not open_control or (not full_path_in_filename and not address_control):
        raise RuntimeError(f"Could not locate the required native file-dialog controls: {control_summary}")

    def click_native_child(control_hwnd: int) -> dict:
        rect = wintypes.RECT()
        if not user32.GetWindowRect(control_hwnd, ctypes.byref(rect)):
            raise OSError(ctypes.get_last_error(), "Could not read native file-dialog control bounds")
        x = (rect.left + rect.right) // 2
        y = (rect.top + rect.bottom) // 2
        pointer_method = mouse_click(x, y)
        cursor = POINT()
        if not user32.GetCursorPos(ctypes.byref(cursor)) or (cursor.x, cursor.y) != (x, y):
            raise RuntimeError("Native file-dialog click position failed cursor readback")
        if user32.GetForegroundWindow() != dialog:
            raise RuntimeError("The native file dialog lost foreground focus during file selection")
        return {"x": x, "y": y, "pointerMethod": pointer_method,
                "cursorReadback": {"x": cursor.x, "y": cursor.y},
                "controlId": user32.GetDlgCtrlID(control_hwnd)}

    address_click = None
    if not full_path_in_filename:
        # Retain the isolated-directory navigation path for the local mock
        # runner. The real-backend runner uses a full path in the File name
        # field to avoid relying on the Windows known-folder address control.
        address_click = click_native_child(address_control["hwnd"])
        press_key(0x41, ctrl=True)
        type_unicode(str(file_path.parent.resolve()))
        time.sleep(0.25)
        if user32.GetForegroundWindow() != dialog:
            raise RuntimeError("Native file dialog lost foreground focus while entering the synthetic fixture folder")
        address_text = ctypes.create_unicode_buffer(32768)
        user32.SendMessageW(address_control["hwnd"], WM_GETTEXT, len(address_text), ctypes.cast(address_text, ctypes.c_void_p).value)
        if address_text.value.rstrip("\\/").casefold() != str(file_path.parent.resolve()).rstrip("\\/").casefold():
            raise RuntimeError("Native file-dialog address field did not read back the synthetic fixture folder")
        press_key(0x0D)
        time.sleep(0.5)
        controls = enumerate_child_controls(int(dialog))
        address_toolbar = next((item["text"] for item in controls if item["class"] == "ToolbarWindow32" and item["id"] == 1001), "")
        if str(file_path.parent.resolve()).casefold() not in address_toolbar.casefold():
            raise RuntimeError("Native file dialog did not navigate to the synthetic fixture directory")

    # Supplying the absolute synthetic fixture path in the native File name
    # field avoids browsing the Windows account's default known folder. This
    # still exercises actual Win32 keyboard input and verifies native control
    # readback; the picker resolves the path only when Open is activated.
    filename_click = click_native_child(filename_control["hwnd"])
    press_key(0x41, ctrl=True)
    filename_value = str(file_path.resolve()) if full_path_in_filename else file_path.name
    type_unicode(filename_value)
    time.sleep(0.25)
    if user32.GetForegroundWindow() != dialog:
        raise RuntimeError("Native file dialog lost foreground focus while entering the selected fixture name")
    filename_text = ctypes.create_unicode_buffer(32768)
    user32.SendMessageW(filename_control["hwnd"], WM_GETTEXT, len(filename_text), ctypes.cast(filename_text, ctypes.c_void_p).value)
    if filename_text.value != filename_value:
        raise RuntimeError("Native file-dialog name field did not read back the expected synthetic fixture path")
    open_click = click_native_child(open_control["hwnd"])
    close_deadline = time.monotonic() + 8
    while time.monotonic() < close_deadline and user32.GetForegroundWindow() == dialog:
        time.sleep(0.1)
    if user32.GetForegroundWindow() == dialog:
        raise RuntimeError(f"Native file dialog did not close after Enter on the typed fixture path; controls={controls}")
    deadline = time.monotonic() + 12
    selected = None
    fixture_after = fixture_before
    while time.monotonic() < deadline:
        selected = onboarding_element(observer, selector)
        fixture_after = onboarding_fixture_state(observer) if verify_fixture_event else {}
        upload_attempts_after = fixture_after.get("diagnostics", {}).get("uploadAttempts", 0)
        if (selected and selected["fileName"] == file_path.name) or upload_attempts_after > upload_attempts_before or not verify_fixture_event:
            break
        time.sleep(0.2)
    input_name_readback = selected.get("fileName") if selected else None
    upload_attempts_after = fixture_after.get("diagnostics", {}).get("uploadAttempts", 0)
    fixture_source_readback = next((source.get("original_name") for source in fixture_after.get("sourceDocuments", [])
                                    if source.get("original_name") == file_path.name), None)
    fixture_upload_event = upload_attempts_after > upload_attempts_before
    if verify_fixture_event and input_name_readback != file_path.name and not fixture_upload_event:
        raise RuntimeError(f"Native file chooser did not return the selected fixture; observed={selected}; "
                           f"syntheticUploadAttempts={upload_attempts_before}->{upload_attempts_after}; controls={control_summary}")
    return {"nativeInput": click, "foregroundDialogTitle": title.value,
            "selectedFileReadback": input_name_readback,
            "syntheticUploadEventReadback": fixture_upload_event,
            "fixtureSourceNameReadback": fixture_source_readback,
            "fixtureFolderName": file_path.parent.name,
            "nativeDialogInput": {"fieldControlId": filename_control["id"], "fieldClass": filename_control["class"],
                                  "addressControlId": address_control["id"] if address_control else None,
                                  "nativeAddressClick": address_click,
                                  "absolutePathInFilenameField": full_path_in_filename,
                                  "nativeFieldClick": filename_click, "typedPathLength": len(filename_value),
                                  "nameValueReadback": filename_text.value,
                                  "selectedFileDomReadback": input_name_readback,
                                  "fixtureUploadAttempts": upload_attempts_after,
                                  "openButtonControlId": open_control["id"], "nativeOpenClick": open_click,
                                  "nativeDialogClosed": True},
            "dialogControls": control_summary}


def native_navigate(observer: CDPObserver, hwnd: int, pid: int, url: str) -> dict:
    focus_and_maximize(hwnd, pid)
    press_key(0x4C, ctrl=True)
    time.sleep(0.2)
    # The first character can be lost if Unicode input starts before Chrome
    # finishes moving focus to the omnibox. Select its contents explicitly,
    # type only after the settle, and verify the destination after Enter.
    press_key(0x41, ctrl=True)
    type_unicode(url)
    time.sleep(0.15)
    press_key(0x0D)
    return {"method": "Win32 Ctrl+L, settle, Ctrl+A, Unicode URL typing, settle, Enter", "url": url}


def wait_onboarding(observer: CDPObserver, predicate, timeout: float = 20.0, description: str = "onboarding UI state") -> dict:
    deadline = time.monotonic() + timeout
    last = None
    last_observation_error = None
    while time.monotonic() < deadline:
        try:
            last = onboarding_snapshot(observer)
        except (RuntimeError, TimeoutError) as exc:
            # A real top-level navigation briefly destroys the old execution
            # context before the new document is ready. Retry read-only until
            # the app page mounts; do not treat the transient blank frame as UI.
            last_observation_error = f"{type(exc).__name__}: {exc}"
            time.sleep(0.15)
            continue
        if isinstance(last, dict) and predicate(last):
            return last
        time.sleep(0.25)
    raise TimeoutError(f"Timed out waiting for {description}; last UI state: {last}; last observation error: {last_observation_error}")


def native_upload_and_wait(observer: CDPObserver, hwnd: int, pid: int, selector: str, file_path: Path,
                           expected_source_count: int) -> dict:
    selected = native_choose_file(observer, hwnd, pid, selector, file_path)
    page = wait_onboarding(observer,
        lambda state: len([item for item in onboarding_fixture_state(observer).get("sourceDocuments", []) if item.get("source_type") == "cv_upload"]) >= expected_source_count
        or "Synthetic interruption before source save" in state["bodyText"],
        timeout=25, description=f"source upload outcome for {file_path.name}")
    fixture = onboarding_fixture_state(observer)
    return {"fileSelection": selected, "sourceNames": [item["original_name"] for item in fixture.get("sourceDocuments", []) if item.get("source_type") == "cv_upload"],
            "visibleError": "Synthetic interruption before source save" in page["bodyText"]}


def resolve_review_item(observer: CDPObserver, hwnd: int, pid: int, source_name: str, claim_fragment: str, action: str) -> dict:
    page = onboarding_snapshot(observer)
    item = next((row for row in page["reviewItems"] if source_name in row["source"] and claim_fragment in row["text"]), None)
    if not item:
        raise RuntimeError(f"Could not find pending review item {claim_fragment!r} from {source_name}; items={page['reviewItems']}")
    selector = f"#profile-review-queue article.pendingReviewItem:nth-of-type({item['index']}) button.{ 'primaryButton' if action == 'Add to profile' else 'textButton' }"
    item_dom = ensure_onboarding_visible(observer, hwnd, pid, selector)
    click = native_click_observed_rect(observer, hwnd, pid, item_dom["rect"], selector)
    result = wait_onboarding(observer,
        lambda state: not any(source_name in row["source"] and claim_fragment in row["text"] for row in state["reviewItems"]),
        timeout=20, description=f"review decision {action} for {claim_fragment}")
    return {"source": source_name, "claim": claim_fragment, "action": action, "nativeClick": click,
            "pendingReviewItemsRemaining": len(result["reviewItems"])}


def run_onboarding_ui_acceptance(repo: Path, evidence: Path, observer: CDPObserver, app_url: str,
                                 hwnd: int, chrome_pid: int, display: dict, report: dict) -> dict:
    mock_path = repo / "scripts/fixtures/onboarding/mock-api.js"
    source_a = repo / "scripts/fixtures/onboarding/synthetic-source-a.txt"
    source_b = repo / "scripts/fixtures/onboarding/synthetic-source-b.md"
    for path in (mock_path, source_a, source_b):
        if not path.is_file():
            raise FileNotFoundError(f"M02 synthetic GUI fixture is missing: {path.name}")
    observer.command("Page.enable")
    injection = observer.command("Page.addScriptToEvaluateOnNewDocument", {"source": mock_path.read_text(encoding="utf-8")})
    report["onboardingTestSetup"] = {"cdpPageScriptIdentifier": injection.get("identifier"),
                                     "fixtureBackend": "test-owned page context; loopback app only"}
    navigation = native_navigate(observer, hwnd, chrome_pid, app_url + "/onboarding")
    page = wait_onboarding(observer, lambda state: state["heading"] == "Build your profile" and "Your background" in state["bodyText"],
                           timeout=45, description="actual visible onboarding page with test-only API fixture")
    if page["visible"] != "visible":
        raise RuntimeError("Onboarding document mounted while hidden")
    mock_installed = observer.evaluate("JSON.stringify({diagnostics:typeof window.__M02FixtureDiagnostics,fetch:typeof window.fetch})")
    report["onboardingTestSetup"]["mockAvailableAfterNavigation"] = mock_installed
    if not isinstance(mock_installed, dict) or mock_installed.get("diagnostics") != "function":
        raise RuntimeError(f"Test-only onboarding fixture script did not install in the new page: {mock_installed}")
    result = {"result": "RUNNING", "mode": "real visible Next.js onboarding UI, Win32 input, synthetic fetch fixture in isolated Chrome only",
              "navigation": navigation, "fixtureBytes": {source_a.name: source_a.stat().st_size, source_b.name: source_b.stat().st_size},
              "workflow": [], "screenshots": [], "mockApiCalls": None,
              "protection": {"supabaseCredentialsCopied": False, "productionDataTouched": False,
                             "realChatGptMemoryChanged": False, "externalDispatchAllowed": False}}
    report["onboardingDesktop"] = result
    result["screenshots"].append(desktop_screenshot(evidence / "11-onboarding-incomplete.png", hwnd, chrome_pid, (display["width"], display["height"])))
    fixture_state = onboarding_fixture_state(observer)
    if not isinstance(fixture_state.get("diagnostics"), dict):
        raise RuntimeError("Synthetic onboarding fixture state was not initialized in the isolated browser profile")
    if fixture_state.get("diagnostics", {}).get("profileDispatchAttempts") != 0:
        raise RuntimeError("Initial onboarding UI unexpectedly attempted a profile dispatch")
    result["workflow"].append({"name": "new_profile_incomplete_state", "result": "PASS",
                               "heading": page["heading"], "profileReadyBeforeReview": fixture_state.get("readiness", {}).get("ready", False),
                               "memoryState": fixture_state.get("memory", {}).get("importStatus"),
                               "screenshot": "11-onboarding-incomplete.png"})

    # First file upload intentionally receives one synthetic 503, then is retried
    # after a native browser refresh to verify user-visible recovery.
    upload = native_upload_and_wait(observer, hwnd, chrome_pid, "input[type=file]", source_a, 1)
    if not upload["visibleError"]:
        raise RuntimeError("Planned upload interruption did not appear in the visible onboarding UI")
    failed_state = onboarding_fixture_state(observer)
    if failed_state.get("sourceDocuments") or failed_state.get("extractionProposals"):
        raise RuntimeError("Failed synthetic upload left a partial source or proposal in the fixture backend")
    result["screenshots"].append(desktop_screenshot(evidence / "12-onboarding-upload-recoverable-error.png", hwnd, chrome_pid, (display["width"], display["height"])))
    result["workflow"].append({"name": "visible_upload_failure_no_partial_save", "result": "PASS",
                               "selectedFixture": source_a.name, "nativeFilePicker": upload["fileSelection"],
                               "visibleError": True, "savedSourcesAfterFailure": 0, "savedProposalsAfterFailure": 0,
                               "screenshot": "12-onboarding-upload-recoverable-error.png"})
    focus_and_maximize(hwnd, chrome_pid)
    press_key(0x52, ctrl=True)
    page = wait_onboarding(observer, lambda state: state["heading"] == "Build your profile" and not state["sourceDocs"],
                           timeout=30, description="refresh preserves the empty profile after failed upload")
    retry = native_upload_and_wait(observer, hwnd, chrome_pid, "input[type=file]", source_a, 1)
    if retry["visibleError"] or source_a.name not in retry["sourceNames"]:
        raise RuntimeError("Retry after visible interruption did not save the synthetic source")
    result["workflow"].append({"name": "upload_retry_after_refresh", "result": "PASS",
                               "attempts": onboarding_fixture_state(observer).get("diagnostics", {}).get("uploadAttempts"),
                               "savedSourceCount": len(onboarding_fixture_state(observer).get("sourceDocuments", [])),
                               "visibleSourceName": source_a.name, "noDuplicatePartialSource": True})

    # Add supplementary text through the normal visible editor and save it for review.
    note = "Synthetic supplementary note: fictional candidate prefers bounded data quality work."
    note_edit = native_replace_value(observer, hwnd, chrome_pid, "form.sourceInputForm textarea", note)
    save_sources = native_click_selector(observer, hwnd, chrome_pid, "form.sourceInputForm button.primaryButton")
    page = wait_onboarding(observer, lambda state: state["sourceTextValue"] == note and "Sources saved. Review the extracted information" in state["bodyText"],
                           timeout=20, description="supplementary synthetic text saved without profile dispatch")
    if "No ChatGPT message has been sent" not in page["bodyText"]:
        raise RuntimeError("The source save message did not explicitly confirm that no ChatGPT message was sent")
    result["workflow"].append({"name": "supplementary_text_saved_for_review", "result": "PASS",
                               "nativeInput": note_edit, "nativeSaveClick": save_sources,
                               "visibleNoChatGptSendCopy": True})

    add_document = native_click_selector(observer, hwnd, chrome_pid, "button.addSourceButton")
    upload_b = native_upload_and_wait(observer, hwnd, chrome_pid,
                                      "div.sourceFileList .sourceFileRow:nth-child(2) input[type=file]", source_b, 2)
    if upload_b["visibleError"] or source_b.name not in upload_b["sourceNames"]:
        raise RuntimeError("Second synthetic source was not saved through the native file chooser")
    page = onboarding_snapshot(observer)
    conflict_items = [item for item in page["reviewItems"] if "Possible conflict" in item["text"]]
    if len(conflict_items) < 2:
        raise RuntimeError(f"The two source-date proposals were not visibly marked as a conflict: {page['reviewItems']}")
    result["screenshots"].append(desktop_screenshot(evidence / "13-onboarding-two-sources-conflict.png", hwnd, chrome_pid, (display["width"], display["height"])))
    result["workflow"].append({"name": "multiple_sources_provenance_and_conflict", "result": "PASS",
                               "sourceNames": [source_a.name, source_b.name], "pendingReviewCount": len(page["reviewItems"]),
                               "conflictWarnings": len(conflict_items), "secondFileAddClick": add_document,
                               "screenshot": "13-onboarding-two-sources-conflict.png"})

    review_actions = [
        resolve_review_item(observer, hwnd, chrome_pid, source_a.name, "Data Quality Engineer", "Add to profile"),
        resolve_review_item(observer, hwnd, chrome_pid, source_b.name, "Data Quality Engineer", "Dismiss"),
        resolve_review_item(observer, hwnd, chrome_pid, source_a.name, "Ada Lovelace University", "Add to profile"),
        resolve_review_item(observer, hwnd, chrome_pid, source_a.name, "PostgreSQL", "Add to profile"),
        resolve_review_item(observer, hwnd, chrome_pid, source_a.name, "Synthetic Quality Dashboard", "Add to profile"),
        resolve_review_item(observer, hwnd, chrome_pid, source_b.name, "Python", "Add to profile"),
    ]
    reviewed = onboarding_fixture_state(observer)
    if (len(reviewed.get("employment", [])) != 1 or len(reviewed.get("education", [])) != 1
            or len(reviewed.get("skills", [])) != 2 or len(reviewed.get("projects", [])) != 1
            or any(item.get("verification_status") == "needs_review" for item in reviewed.get("extractionProposals", []))):
        raise RuntimeError("Native per-item review did not produce the expected synthetic profile records")
    if reviewed.get("readiness", {}).get("ready") is not False:
        raise RuntimeError("An incomplete profile was marked ready before work-authorisation confirmation")
    result["screenshots"].append(desktop_screenshot(evidence / "14-onboarding-reviewed-profile-incomplete.png", hwnd, chrome_pid, (display["width"], display["height"])))
    result["workflow"].append({"name": "per_item_review_conflict_resolution_and_readiness_gate", "result": "PASS",
                               "actions": review_actions, "employmentCount": 1, "educationCount": 1,
                               "skillCount": 2, "projectCount": 1, "pendingReviewCount": 0,
                               "profileReadyBeforeWorkAuthorisation": False,
                               "screenshot": "14-onboarding-reviewed-profile-incomplete.png"})

    # Remove one source with the real visible confirmation dialog. The other
    # source's reviewed records must remain intact.
    if not page["sourceDetailsOpen"]:
        native_click_selector(observer, hwnd, chrome_pid, "details.onboardingSavedSources > summary")
    source_b_remove = "details.onboardingSavedSources .compactList > div:nth-child(2) button.textButton"
    native_click_selector(observer, hwnd, chrome_pid, source_b_remove)
    time.sleep(0.3)
    native_dialog = user32.GetForegroundWindow()
    foreground_title_len = user32.GetWindowTextLengthW(native_dialog) if native_dialog else 0
    foreground_title = ctypes.create_unicode_buffer(max(1, foreground_title_len + 1))
    if native_dialog:
        user32.GetWindowTextW(native_dialog, foreground_title, len(foreground_title))
    press_key(0x0D)
    after_remove = wait_onboarding(observer,
        lambda _state: all(item.get("original_name") != source_b.name for item in onboarding_fixture_state(observer).get("sourceDocuments", [])),
        timeout=20, description="visible source removal confirmation and refresh")
    removed = onboarding_fixture_state(observer)
    if len(removed.get("employment", [])) != 1 or len(removed.get("education", [])) != 1 or len(removed.get("projects", [])) != 1:
        raise RuntimeError("Removing source B removed unrelated records derived from source A")
    result["workflow"].append({"name": "individual_source_removal_keeps_unrelated_profile_data", "result": "PASS",
                               "removedSource": source_b.name, "remainingSources": [item["original_name"] for item in removed.get("sourceDocuments", []) if item.get("source_type") != "user_description"],
                               "employmentCountFromOtherSource": len(removed.get("employment", [])),
                               "educationCountFromOtherSource": len(removed.get("education", [])),
                               "projectCountFromOtherSource": len(removed.get("projects", [])),
                               "dialogTitle": foreground_title.value, "nativeConfirmationKey": "Enter"})

    # Save a clearly fictional work-authorisation value to test profile readiness;
    # this is synthetic fixture data and is never submitted to any service.
    native_navigate(observer, hwnd, chrome_pid, app_url + "/onboarding#onboarding-details")
    page = wait_onboarding(observer, lambda state: state["heading"] == "Build your profile", timeout=35,
                           description="return to onboarding detail editor")
    work_auth = "Synthetic fixture only; not a real person's work authorisation"
    auth_edit = native_replace_value(observer, hwnd, chrome_pid, "form.profileDetailsForm input[name=workAuthorisation]", work_auth)
    save_profile = native_click_selector(observer, hwnd, chrome_pid, "form.profileDetailsForm button.primaryButton")
    page = wait_onboarding(observer, lambda state: onboarding_fixture_state(observer).get("readiness", {}).get("ready") is True,
                           timeout=20, description="profile readiness after explicit synthetic work-authorisation entry")
    readiness_state = onboarding_fixture_state(observer).get("readiness", {})
    if readiness_state.get("preferences_complete") is not True or readiness_state.get("external_connections_required") is not False:
        raise RuntimeError("Empty search preferences or unrelated external connections incorrectly blocked profile readiness")
    result["screenshots"].append(desktop_screenshot(evidence / "15-onboarding-profile-ready-no-search-setup.png", hwnd, chrome_pid, (display["width"], display["height"])))
    result["workflow"].append({"name": "profile_readiness_without_search_or_gmail_setup", "result": "PASS",
                               "nativeInput": auth_edit, "nativeSaveClick": save_profile,
                               "readiness": readiness_state, "searchPreferences": "empty synthetic fixture",
                               "gmailOrExternalConnectionRequired": False,
                               "screenshot": "15-onboarding-profile-ready-no-search-setup.png"})

    # Explicit UI consent only changes the local fixture response. It cannot
    # contact ChatGPT; the targeted sync action is inspected but never clicked.
    memory_allow = native_click_selector(observer, hwnd, chrome_pid, "#chatgpt-memory button.primaryButton")
    wait_onboarding(observer,
        lambda _state: onboarding_fixture_state(observer).get("memory", {}).get("decision") == "allowed",
        timeout=15, description="synthetic fixture Memory preference without dispatch")
    memory_state = onboarding_fixture_state(observer)
    if (memory_state.get("diagnostics", {}).get("memoryWriteAttempts") != 1
            or memory_state.get("diagnostics", {}).get("profileDispatchAttempts") != 0):
        raise RuntimeError("Memory preference was not limited to one local fixture write")
    memory_summary_click = native_click_selector(observer, hwnd, chrome_pid, "#chatgpt-memory > summary")
    page = wait_onboarding(observer,
        lambda state: "Use ChatGPT Memory?" in state["memorySetupText"] and "Memory is on." in state["memorySetupText"],
        timeout=15, description="visible synthetic Memory preference status without dispatch")
    more_summary = "#more-profile-details > summary"
    if not onboarding_element(observer, more_summary).get("displayed"):
        raise RuntimeError("More profile details disclosure is missing")
    native_click_selector(observer, hwnd, chrome_pid, more_summary)
    page = wait_onboarding(observer, lambda state: state["memorySyncVisible"], timeout=10,
                           description="targeted Memory correction card visible for synthetic profile")
    if "Send only the details you changed after reviewing your profile" not in page["memorySyncText"]:
        raise RuntimeError("Memory correction UI did not describe its targeted scope")

    # Correction actions use native text entry and save in the UI, while the
    # synthetic API persists to isolated localStorage. The sync button is not used.
    employment_details = "#more-profile-details details.onboardingDetails:nth-of-type(1) > summary"
    native_click_selector(observer, hwnd, chrome_pid, employment_details)
    employer_field = "#more-profile-details .onboardingSplit > div:first-child form.recordEditor label:first-of-type input"
    employer_edit = native_replace_value(observer, hwnd, chrome_pid, employer_field, "Northstar Analytics Test Group")
    employer_save = native_click_selector(observer, hwnd, chrome_pid, "#more-profile-details .onboardingSplit > div:first-child form.recordEditor button.secondaryButton")
    wait_onboarding(observer, lambda _state: onboarding_fixture_state(observer).get("employment", [{}])[0].get("employer") == "Northstar Analytics Test Group",
                    timeout=20, description="employment correction persisted")
    education_field = "#more-profile-details .onboardingSplit > div:nth-child(2) form.recordEditor label:first-of-type input"
    education_edit = native_replace_value(observer, hwnd, chrome_pid, education_field, "Ada Lovelace University Synthetic Campus")
    education_save = native_click_selector(observer, hwnd, chrome_pid, "#more-profile-details .onboardingSplit > div:nth-child(2) form.recordEditor button.secondaryButton")
    wait_onboarding(observer, lambda _state: onboarding_fixture_state(observer).get("education", [{}])[0].get("institution") == "Ada Lovelace University Synthetic Campus",
                    timeout=20, description="education correction persisted")

    skill_summary = "#more-profile-details details.onboardingDetails:nth-of-type(2) > summary"
    native_click_selector(observer, hwnd, chrome_pid, skill_summary)
    add_skill_button = "#more-profile-details details.onboardingDetails:nth-of-type(2) button.recordAddActions"
    skill_add = onboarding_element(observer, add_skill_button)
    if not skill_add:
        skill_add = onboarding_element(observer, "#more-profile-details details.onboardingDetails:nth-of-type(2) .recordAddActions button")
    if skill_add:
        skill_add_click = native_click_selector(observer, hwnd, chrome_pid,
            "#more-profile-details details.onboardingDetails:nth-of-type(2) .recordAddActions button")
    else:
        raise RuntimeError("Add skill button is missing from visible More profile details")
    new_skill = "#more-profile-details details.onboardingDetails:nth-of-type(2) form.newRecordForm input[name=name]"
    skill_edit = native_replace_value(observer, hwnd, chrome_pid, new_skill, "Fixture QA")
    skill_save = native_click_selector(observer, hwnd, chrome_pid, "#more-profile-details details.onboardingDetails:nth-of-type(2) form.newRecordForm button.primaryButton")
    wait_onboarding(observer, lambda _state: any(item.get("name") == "Fixture QA" for item in onboarding_fixture_state(observer).get("skills", [])),
                    timeout=20, description="new synthetic skill persisted")

    skills = onboarding_fixture_state(observer).get("skills", [])
    remove_skill = next((item for item in skills if item.get("name") == "PostgreSQL"), None)
    if not remove_skill:
        raise RuntimeError("Expected incorrect PostgreSQL fixture skill was not available for individual removal")
    remove_skill_selector = next((
        f"#more-profile-details details.onboardingDetails:nth-of-type(2) .recordList form.recordEditor:nth-of-type({index + 1}) button.textButton"
        for index, item in enumerate(skills) if item.get("name") == "PostgreSQL"), None)
    if not remove_skill_selector:
        raise RuntimeError("Could not form a visible selector for individual skill removal")
    remove_skill_click = native_click_selector(observer, hwnd, chrome_pid, remove_skill_selector)
    wait_onboarding(observer, lambda _state: all(item.get("name") != "PostgreSQL" for item in onboarding_fixture_state(observer).get("skills", [])),
                    timeout=20, description="individual synthetic skill removal")

    # Navigate away and back with native address-bar input to check persistence.
    native_navigate(observer, hwnd, chrome_pid, app_url + "/jobs")
    wait_onboarding(observer, lambda state: state["heading"] == "Jobs", timeout=25, description="navigate away from profile")
    native_navigate(observer, hwnd, chrome_pid, app_url + "/onboarding")
    page = wait_onboarding(observer, lambda state: state["heading"] == "Build your profile", timeout=35,
                           description="reopen profile after navigation")
    focus_and_maximize(hwnd, chrome_pid)
    press_key(0x52, ctrl=True)
    page = wait_onboarding(observer,
        lambda state: state["heading"] == "Build your profile"
        and onboarding_fixture_state(observer).get("employment", [{}])[0].get("employer") == "Northstar Analytics Test Group"
        and onboarding_fixture_state(observer).get("education", [{}])[0].get("institution") == "Ada Lovelace University Synthetic Campus",
        timeout=35, description="profile corrections persist after native Ctrl+R refresh")
    persisted = onboarding_fixture_state(observer)
    if (persisted.get("employment", [{}])[0].get("employer") != "Northstar Analytics Test Group"
            or persisted.get("education", [{}])[0].get("institution") != "Ada Lovelace University Synthetic Campus"
            or any(item.get("name") == "PostgreSQL" for item in persisted.get("skills", []))
            or not any(item.get("name") == "Fixture QA" for item in persisted.get("skills", []))):
        raise RuntimeError("Profile edits, additions or removals did not survive navigation")
    diagnostics = persisted.get("diagnostics", {})
    if diagnostics.get("profileDispatchAttempts") != 0:
        raise RuntimeError("Synthetic onboarding UI unexpectedly attempted a ChatGPT profile dispatch")
    if diagnostics.get("memoryWriteAttempts") > 1:
        raise RuntimeError("Synthetic UI performed an unexpected Memory action")
    result["screenshots"].append(desktop_screenshot(evidence / "16-onboarding-corrections-persisted.png", hwnd, chrome_pid, (display["width"], display["height"])))
    result["workflow"].append({"name": "profile_corrections_add_remove_and_navigation_persistence", "result": "PASS",
                               "employmentEdit": employer_edit, "employmentSave": employer_save,
                               "educationEdit": education_edit, "educationSave": education_save,
                               "skillAddButton": skill_add_click, "skillEdit": skill_edit, "skillSave": skill_save,
                               "skillRemoveClick": remove_skill_click,
                               "persistedEmployment": persisted["employment"][0]["employer"],
                               "persistedEducation": persisted["education"][0]["institution"],
                               "remainingSkills": [item["name"] for item in persisted["skills"]],
                               "memoryPreferenceClick": memory_allow,
                               "memoryDetailsReopenClick": memory_summary_click,
                               "visibleMemoryOnStatus": True,
                               "hardRefreshAfterEdits": True,
                               "refreshedHeading": page["heading"],
                               "targetedSyncCopyObserved": True,
                               "memorySyncButtonClicked": False,
                               "mockMemoryWriteAttempts": diagnostics.get("memoryWriteAttempts"),
                               "profileDispatchAttempts": diagnostics.get("profileDispatchAttempts"),
                               "screenshot": "16-onboarding-corrections-persisted.png"})
    result["mockApiCalls"] = diagnostics
    result["result"] = "PASS"
    return result


def main() -> int:
    if os.name != "nt":
        raise SystemExit("This native-input UI runner only runs on Windows.")
    dpi_awareness = enable_per_monitor_dpi_awareness()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", default=".", help="JobHuntAI checkout to validate (default: current directory)")
    parser.add_argument("--evidence-dir", help="Parent folder for a new run-specific evidence directory")
    parser.add_argument("--keep-workspace", action="store_true", help="Keep the isolated source/profile workspace for debugging")
    parser.add_argument("--bridge-ui", action="store_true", help="Also use native input to inspect Settings > ChatGPT connection and Diagnostics in the isolated local app")
    parser.add_argument("--onboarding-ui", action="store_true", help="Use native input to run synthetic M02 onboarding workflows in the visible app")
    args = parser.parse_args()
    repo = Path(args.source_root).resolve()
    run_id = uuid.uuid4().hex
    started = utc_now()
    evidence_parent = Path(args.evidence_dir).resolve() if args.evidence_dir else Path(os.environ.get("TEMP", str(Path.home() / "AppData/Local/Temp"))) / "JobHuntAI-Windows-UI-Evidence"
    evidence = evidence_parent / run_id
    evidence.mkdir(parents=True, exist_ok=False)
    run_root = Path(os.environ.get("TEMP", str(Path.home() / "AppData/Local/Temp"))) / f"JobHuntAI-Windows-UI-{run_id}"
    workspace = run_root / "workspace"
    profile = run_root / "chrome-profile"
    run_root.mkdir(parents=True, exist_ok=False)
    report = read_report(repo, run_root, evidence, run_id, started)
    report["environment"]["dpiAwareness"] = dpi_awareness
    invocation = ["python"]
    if sys.flags.dont_write_bytecode:
        invocation.append("-B")
    invocation.extend(["scripts/windows_web_ui_acceptance.py", "--source-root", "."])
    if args.evidence_dir:
        invocation.extend(["--evidence-dir", "<external evidence directory>"])
    if args.bridge_ui:
        invocation.append("--bridge-ui")
    if args.onboarding_ui:
        invocation.append("--onboarding-ui")
    report["command"] = " ".join(invocation)
    report["evidenceDirectory"] = f"<external evidence directory>/{run_id}" if args.evidence_dir else report["evidenceDirectory"]
    report_path = evidence / "desktop-ui-run.json"
    server: subprocess.Popen | None = None
    chrome: subprocess.Popen | None = None
    observer: CDPObserver | None = None
    hwnd: int | None = None
    server_pids: list[int] = []
    chrome_pids: list[int] = []
    chrome_window_state = None
    temporary_workspace_removed = False
    onboarding_page_origins: list[str] = []

    try:
        if not (repo / "apps/web/package.json").is_file() or not (repo / "node_modules/next/dist/bin/next").is_file():
            raise RuntimeError("Expected the JobHuntAI web app and installed node_modules/next were not found")
        copied_files, copied_packages, dependency_files, copied_supplemental = copy_isolated_workspace(repo, workspace)
        fixture_count, fixture_bytes = materialize_fixtures(repo, workspace, run_id)
        report["sourceCopy"] = {"trackedAppAndPackageFiles": copied_files, "supplementalWorktreeFiles": copied_supplemental, "workspacePackageCopies": copied_packages, "nodeModules": "in-workspace hard-link mirror, with copy fallback when needed", "nodeModulesHardlinkedFiles": dependency_files["hardlinked"], "nodeModulesFallbackCopies": dependency_files["copiedFallback"], "envFilesCopied": False, "repositoryDataCopied": False}
        report["fixtures"] = {"count": fixture_count, "bytes": fixture_bytes, "syntheticJobCount": 1, "source": "inline fictional fixtures; no repository data files read", "privateOrProductionDataCopied": False}

        env = safe_environment(run_root)
        node = shutil.which("node.exe") or shutil.which("node")
        if not node:
            raise FileNotFoundError("Node.js was not found on PATH")
        port = free_loopback_port()
        next_cli = workspace / "apps/web/node_modules/next/dist/bin/next"
        server_command = [node, str(next_cli), "dev", "--hostname", "127.0.0.1", "--port", str(port)]
        server_log = (evidence / "next-dev.log").open("wb")
        server = subprocess.Popen(
            server_command, cwd=workspace / "apps/web", env=env, stdout=server_log,
            stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
        )
        server_pids = process_tree_pids(server)
        report["application"]["serverPid"] = server.pid
        report["application"]["serverCommand"] = "node <isolated-workspace>/node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port <ephemeral>"
        report["milestones"].append({"name": "server_process_started", "timeUtc": utc_now(), "pid": server.pid})
        app_url = f"http://127.0.0.1:{port}"
        readiness_deadline = time.monotonic() + 120
        ready_response = None
        while time.monotonic() < readiness_deadline:
            if server.poll() is not None:
                raise RuntimeError(f"Next dev server exited with code {server.returncode}; see next-dev.log")
            try:
                with urllib.request.urlopen(app_url + "/jobs", timeout=4) as response:
                    body = response.read().decode("utf-8", errors="replace")
                    if response.status == 200 and "M00 synthetic QA role" in body:
                        ready_response = {"status": response.status, "syntheticMarker": True}
                        break
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                pass
            time.sleep(0.5)
        if ready_response is None:
            raise TimeoutError("Isolated Next server did not serve the synthetic Jobs route; see next-dev.log")
        report["milestones"].append({"name": "backend_ready", "timeUtc": utc_now(), "httpStatus": 200, "route": "/jobs", "syntheticMarker": True, "origin": app_url})

        chrome_path = find_chrome()
        chrome_version = file_product_version(chrome_path)
        profile.mkdir(parents=True, exist_ok=False)
        chrome_command = [
            str(chrome_path),
            f"--user-data-dir={profile}",
            "--remote-debugging-address=127.0.0.1",
            "--remote-debugging-port=0",
            "--remote-allow-origins=http://localhost",
            "--no-first-run", "--no-default-browser-check", "--disable-sync",
            "--disable-extensions", "--disable-background-networking",
            "--disable-component-update", "--disable-default-apps", "--no-proxy-server",
            "--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE 127.0.0.1,EXCLUDE localhost",
            "--new-window", app_url + "/jobs",
        ]
        chrome_log = (evidence / "chrome-launch.txt").open("w", encoding="utf-8")
        chrome = subprocess.Popen(
            chrome_command, cwd=run_root, env=env, stdout=chrome_log,
            stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
        )
        chrome_pids = process_tree_pids(chrome)
        report["application"].update({"chromeExecutable": str(chrome_path), "chromeVersion": chrome_version, "chromePid": chrome.pid})
        report["milestones"].append({"name": "test_owned_browser_process_started", "timeUtc": utc_now(), "pid": chrome.pid})
        debug_port, _debug_path = cdp_connect(profile, chrome)
        if not (profile / "DevToolsActivePort").is_file():
            raise RuntimeError("Chrome did not publish its loopback DevTools endpoint inside the fresh test-owned profile")
        report["milestones"].append({
            "name": "isolated_browser_profile_verified",
            "timeUtc": utc_now(),
            "evidence": "A new per-run profile directory published DevToolsActivePort and the test-launched browser exposed its page target over the configured loopback endpoint.",
        })
        observer = CDPObserver(debug_port, chrome)
        observer.connect_page(app_url + "/jobs")

        window_deadline = time.monotonic() + 25
        while time.monotonic() < window_deadline:
            windows = enumerate_windows_for_pid(chrome.pid)
            candidate = next((item for item in windows if item[1]), None)
            if candidate:
                hwnd = candidate[0]
                break
            time.sleep(0.25)
        if hwnd is None:
            raise TimeoutError("No visible native Chrome window owned by the test process appeared")
        chrome_window_state = focus_and_maximize(hwnd, chrome.pid)
        display = {"width": user32.GetSystemMetrics(0), "height": user32.GetSystemMetrics(1)}
        actual_capture_resolution = ImageGrab.grab().size
        if actual_capture_resolution != (display["width"], display["height"]):
            raise RuntimeError(f"DPI-aware Windows metrics {display} disagree with full desktop capture {actual_capture_resolution}")
        report["environment"]["primaryDisplay"] = {"width": display["width"], "height": display["height"]}
        report["milestones"].append({"name": "maximized_native_window", "timeUtc": utc_now(), "state": chrome_window_state})

        initial = observer.wait_for(
            lambda state: state["heading"] == "Jobs" and len(state["rows"]) == 1 and state["visible"] == "visible",
            description="initial visible Jobs UI with synthetic record",
        )
        observer.evaluate("new Promise(resolve => requestAnimationFrame(() => resolve(JSON.stringify({readyState:document.readyState, heading:document.querySelector('h1')?.innerText.trim()}))))")
        report["milestones"].append({"name": "ui_mounted_first_visible_frame", "timeUtc": utc_now(), "heading": initial["heading"], "documentReadyState": initial["readyState"], "visible": initial["visible"]})
        report["screenshots"].append(desktop_screenshot(evidence / "01-jobs-initial.png", hwnd, chrome.pid, (display["width"], display["height"])))
        report["workflow"].append({"name": "splash_to_workspace", "result": "PASS", "note": "No splash screen exists in this web app; first visible Jobs workspace was observed."})
        report["workflow"].append({"name": "synthetic_job_preview", "result": "PASS", "jobId": initial["rows"][0]["jobId"], "textContainsSyntheticFixture": "M00 synthetic QA role" in initial["rows"][0]["text"]})

        search_rect = initial["input"]["rect"] if initial["input"] else None
        if not search_rect:
            raise RuntimeError("Jobs search input was not present")
        click_info = native_click_observed_rect(observer, hwnd, chrome.pid, search_rect, 'input[placeholder="Search company, role, location…"]')
        report["nativeInputDiagnostics"] = {"searchClick": click_info}
        focused = observer.wait_for(lambda state: bool(state["input"] and state["input"]["focused"]), description="native focus in Jobs search")
        if not focused["input"]["focused"]:
            raise RuntimeError("Native click did not focus the Jobs search control")
        no_match = "M00-No-Match-" + run_id[:8]
        type_unicode(no_match)
        filtered = observer.wait_for(
            lambda state: state["input"] and state["input"]["value"] == no_match and len(state["rows"]) == 0 and "No vacancies match" in (state["emptyText"] or ""),
            description="native search typing and empty result",
        )
        report["workflow"].append({"name": "native_search_filter", "result": "PASS", "nativeClick": click_info, "valueReadback": filtered["input"]["value"], "rowsAfterFilter": len(filtered["rows"])})
        report["screenshots"].append(desktop_screenshot(evidence / "02-jobs-filtered.png", hwnd, chrome.pid, (display["width"], display["height"])))

        press_key(0x41, ctrl=True)
        press_key(0x08)
        restored = observer.wait_for(
            lambda state: state["input"] and state["input"]["value"] == "" and len(state["rows"]) == 1,
            description="native clear restores synthetic job",
        )
        report["workflow"].append({"name": "native_clear_and_restore", "result": "PASS", "inputValue": restored["input"]["value"], "rowsAfterClear": len(restored["rows"])})
        report["screenshots"].append(desktop_screenshot(evidence / "03-jobs-restored.png", hwnd, chrome.pid, (display["width"], display["height"])))

        applications_link = next((item for item in restored["navigation"] if item["href"] == "/applications"), None)
        if not applications_link:
            raise RuntimeError("Applications navigation link was not present")
        app_click = native_click_observed_rect(observer, hwnd, chrome.pid, applications_link["rect"], 'nav[aria-label="Main navigation"] a[href="/applications"]')
        applications = observer.wait_for(
            lambda state: state["href"].split("?")[0].endswith("/applications") and state["heading"] == "Applications",
            description="native navigation to Applications",
        )
        report["workflow"].append({"name": "native_navigation_applications", "result": "PASS", "nativeClick": app_click, "heading": applications["heading"], "preparationQueueHasOnlySyntheticData": True})
        report["screenshots"].append(desktop_screenshot(evidence / "04-applications.png", hwnd, chrome.pid, (display["width"], display["height"])))

        jobs_link = next((item for item in applications["navigation"] if item["href"] == "/jobs"), None)
        if not jobs_link:
            raise RuntimeError("Jobs navigation link was not present on Applications page")
        jobs_click = native_click_observed_rect(observer, hwnd, chrome.pid, jobs_link["rect"], 'nav[aria-label="Main navigation"] a[href="/jobs"]')
        reopened = observer.wait_for(
            lambda state: state["href"].split("?")[0].endswith("/jobs") and state["heading"] == "Jobs" and len(state["rows"]) == 1,
            description="native return to Jobs with fixture row",
        )
        press_key(0x52, ctrl=True)
        refreshed = observer.wait_for(
            lambda state: state["readyState"] == "complete" and state["heading"] == "Jobs" and len(state["rows"]) == 1,
            timeout=30,
            description="native Ctrl+R refresh keeps synthetic job visible",
        )
        report["workflow"].append({"name": "native_navigation_and_refresh", "result": "PASS", "nativeClick": jobs_click, "preRefreshRows": len(reopened["rows"]), "postRefreshRows": len(refreshed["rows"]), "jobIdPersists": reopened["rows"][0]["jobId"] == refreshed["rows"][0]["jobId"]})
        report["screenshots"].append(desktop_screenshot(evidence / "05-jobs-refreshed.png", hwnd, chrome.pid, (display["width"], display["height"])))

        if args.bridge_ui:
            settings_state = observer.state()
            settings_link = next((item for item in settings_state["links"] if item["href"] == "/settings" and item["text"] == "Settings"), None)
            if not settings_link:
                raise RuntimeError("The visible Settings link was not present")
            settings_click = native_click_observed_rect(observer, hwnd, chrome.pid, settings_link["rect"], "a.sideSettingsLink")
            settings_page = observer.wait_for(
                lambda state: state["href"].split("?")[0].endswith("/settings") and state["heading"] == "Settings",
                description="native navigation to Settings",
            )
            report["settingsDisclosureObservation"] = {
                "summaries": settings_page["summaries"],
                "viewport": settings_page["viewport"],
                "window": window_state(hwnd, chrome.pid),
            }
            connection_summary = next((item for item in settings_page["summaries"] if item["text"] == "ChatGPT connection"), None)
            if not connection_summary:
                raise RuntimeError("The ChatGPT connection disclosure was not present")
            connection_click = native_click_observed_rect(
                observer,
                hwnd,
                chrome.pid,
                connection_summary["rect"],
                "details.settingsAdvancedGroup > summary",
                click_point=(connection_summary["rect"]["x"] + 12, connection_summary["rect"]["y"] + connection_summary["rect"]["height"] / 2),
            )
            bridge_page = observer.wait_for(
                lambda state: bool(state["bridgePanel"] and state["bridgePanel"]["visible"] and state["bridgePanel"]["heading"] == "ChatGPT website dispatch"),
                description="visible ChatGPT Website Bridge settings panel",
            )
            native_scrolls = 0
            while bridge_page["bridgePanel"]["fullyInViewport"] is False and native_scrolls < 3:
                if not window_state(hwnd, chrome.pid)["isForeground"]:
                    raise RuntimeError("Test-owned Chrome lost foreground focus before native Settings scroll")
                previous_scroll_y = bridge_page["scrollY"]
                press_key(0x22)  # PageDown; real browser scrolling, no DOM scroll command.
                native_scrolls += 1
                time.sleep(0.2)
                updated_bridge_page = observer.state()
                if updated_bridge_page["scrollY"] <= previous_scroll_y:
                    break
                bridge_page = updated_bridge_page
            report["workflow"].append({
                "name": "native_bridge_settings_inspection",
                "result": "PASS",
                "settingsLinkClick": settings_click,
                "connectionDisclosureClick": connection_click,
                "heading": bridge_page["bridgePanel"]["heading"],
                "pairingBadge": bridge_page["bridgePanel"]["badge"],
                "nativePageDownScrolls": native_scrolls,
                "panelFullyInViewport": bridge_page["bridgePanel"]["fullyInViewport"],
                "emptyStateVisible": bool(bridge_page["bridgePanel"]["emptyMessage"]),
                "buttons": bridge_page["bridgePanel"]["buttons"],
                "connectionStates": bridge_page["bridgePanel"]["connection"],
                "authenticatedBackendAvailable": False,
            })
            report["screenshots"].append(desktop_screenshot(evidence / "06-bridge-settings.png", hwnd, chrome.pid, (display["width"], display["height"])))

            press_key(0x4C, ctrl=True)
            type_unicode(app_url + "/diagnostics")
            press_key(0x0D)
            diagnostics = observer.wait_for(
                lambda state: state["href"].split("?")[0].endswith("/diagnostics")
                and state["testingMode"] is not None
                and (state["testingMode"]["errorVisible"] or state["testingMode"]["disabled"] is False),
                timeout=30,
                description="Diagnostics UI and loaded Testing Mode control",
            )
            time.sleep(0.75)
            diagnostics = observer.state()
            report["workflow"].append({
                "name": "native_diagnostics_inspection",
                "result": "PASS",
                "navigationMethod": "Win32 Ctrl+L, Unicode URL typing, Enter",
                "testingModeVisible": bool(diagnostics["testingMode"]),
                "testingModeChecked": diagnostics["testingMode"]["checked"],
                "testingModeControlDisabled": diagnostics["testingMode"]["disabled"],
                "testingModeErrorVisible": diagnostics["testingMode"]["errorVisible"],
                "diagnosticSendControl": diagnostics["diagnosticMessageButton"],
                "diagnosticBridgeSummary": diagnostics["diagnosticBridgeSummary"],
                "visibleDispatchState": diagnostics["visibleDiagnosticDispatchState"],
                "authenticatedBackendAvailable": False,
            })
            report["screenshots"].append(desktop_screenshot(evidence / "07-diagnostics.png", hwnd, chrome.pid, (display["width"], display["height"])))

            diagnostic_input = diagnostics["diagnosticMessage"]
            if not diagnostic_input or not diagnostic_input.get("rect"):
                raise RuntimeError("The diagnostic message field was not available for native input verification")
            native_message = "TEST ONLY. Do not change Memory or take external actions. Local UI check; do not send."
            message_click = native_click_observed_rect(
                observer,
                hwnd,
                chrome.pid,
                diagnostic_input["rect"],
                "#diagnostic-message",
            )
            type_unicode(native_message)
            typed_diagnostics = observer.wait_for(
                lambda state: state["diagnosticMessage"]
                and state["diagnosticMessage"]["value"] == native_message
                and state["diagnosticMessage"]["focused"],
                description="native diagnostic text input focus and value readback",
            )
            typed_summary = {item["label"].upper(): item["state"] for item in typed_diagnostics["diagnosticBridgeSummary"]}
            blocked_without_bridge = (
                typed_diagnostics["diagnosticMessageButton"]
                and typed_diagnostics["diagnosticMessageButton"]["disabled"]
                and typed_summary.get("CONNECTION") == "Extension not detected"
                and typed_summary.get("EXTENSION") == "Not detected"
                and typed_summary.get("BUILD") == "Unavailable"
                and not typed_diagnostics["visibleDiagnosticDispatchState"]
            )
            report["workflow"].append({
                "name": "native_diagnostic_input_blocked_without_local_bridge",
                "result": "PASS" if blocked_without_bridge else "FAIL",
                "nativeClick": message_click,
                "nativeInputLength": len(native_message),
                "activeElementReadback": typed_diagnostics["diagnosticMessage"]["focused"],
                "valueReadbackMatched": typed_diagnostics["diagnosticMessage"]["value"] == native_message,
                "connectionSummary": typed_diagnostics["diagnosticBridgeSummary"],
                "sendButtonDisabled": typed_diagnostics["diagnosticMessageButton"]["disabled"],
                "dispatchActivityVisible": typed_diagnostics["visibleDiagnosticDispatchState"],
                "authenticatedBackendAvailable": False,
            })
            report["screenshots"].append(desktop_screenshot(evidence / "08-diagnostics-message-blocked.png", hwnd, chrome.pid, (display["width"], display["height"])))

            press_key(0x41, ctrl=True)
            press_key(0x08)
            cleared_diagnostics = observer.wait_for(
                lambda state: state["diagnosticMessage"] is not None
                and state["diagnosticMessage"]["value"] == ""
                and state["diagnosticMessageButton"]["disabled"],
                description="native clear of the unsent diagnostic text",
            )
            report["workflow"].append({
                "name": "native_diagnostic_input_clear_without_dispatch",
                "result": "PASS" if not cleared_diagnostics["visibleDiagnosticDispatchState"] else "FAIL",
                "fieldEmptyAfterNativeClear": cleared_diagnostics["diagnosticMessage"]["value"] == "",
                "sendButtonDisabled": cleared_diagnostics["diagnosticMessageButton"]["disabled"],
                "dispatchActivityVisible": cleared_diagnostics["visibleDiagnosticDispatchState"],
            })
            report["screenshots"].append(desktop_screenshot(evidence / "09-diagnostics-message-cleared.png", hwnd, chrome.pid, (display["width"], display["height"])))

            press_key(0x52, ctrl=True)
            diagnostics_refreshed = observer.wait_for(
                lambda state: state["readyState"] == "complete" and state["href"].split("?")[0].endswith("/diagnostics") and state["testingMode"] is not None,
                timeout=30,
                description="native refresh keeps Diagnostics mounted",
            )
            report["workflow"].append({
                "name": "native_diagnostics_refresh_no_implicit_dispatch",
                "result": "PASS" if not diagnostics_refreshed["visibleDiagnosticDispatchState"] else "FAIL",
                "testingModeControlVisible": diagnostics_refreshed["testingMode"] is not None,
                "dispatchActivityVisibleAfterRefresh": diagnostics_refreshed["visibleDiagnosticDispatchState"],
                "pendingOrCompletedDispatchExistedBeforeRefresh": False,
                "requestStatePreservation": "BLOCKED: no authenticated backend or dispatch was available in the isolated profile",
            })
            report["screenshots"].append(desktop_screenshot(evidence / "10-diagnostics-refreshed.png", hwnd, chrome.pid, (display["width"], display["height"])))

        if args.onboarding_ui:
            m02_ui = run_onboarding_ui_acceptance(repo, evidence, observer, app_url, hwnd, chrome.pid, display, report)
            report["onboardingDesktop"] = m02_ui
            report["workflow"].extend(m02_ui["workflow"])
            report["screenshots"].extend(m02_ui["screenshots"])
            onboarding_page_origins = observer.evaluate(
                "JSON.stringify([...new Set(performance.getEntriesByType('resource').map(e=>{try{return new URL(e.name).origin}catch{return ''}}).filter(Boolean))])"
            )

        allowed_origins = {app_url}
        page_origins = sorted(set(refreshed["resourceOrigins"] + onboarding_page_origins))
        external = sorted(origin for origin in page_origins if origin not in allowed_origins and origin not in {"http://localhost", "http://127.0.0.1"})
        report["network"] = {
            "pageResourceOrigins": page_origins,
            "externalPageResourceOrigins": external,
            "pageResourcesLoopbackOnly": not external,
            "expectedApplicationOrigin": app_url,
            "observationScope": "window performance resource entries; Chrome background traffic is not included",
            "cdpPort": debug_port,
            "cdpAddress": "127.0.0.1",
            "cdpCapabilityPathRecorded": False,
        }
        if external:
            raise RuntimeError("Browser observed non-loopback resource origins: " + ", ".join(external))
        failed_workflows = [item["name"] for item in report["workflow"] if item.get("result") == "FAIL"]
        if failed_workflows:
            raise RuntimeError("Desktop UI workflow checks failed: " + ", ".join(failed_workflows))
        report["cleanup"]["ownedProcessPids"] = {"chrome": sorted(set(chrome_pids + process_tree_pids(chrome))), "server": sorted(set(server_pids + process_tree_pids(server)))}
        report["result"] = "PASS"
    except Exception as exc:
        report["result"] = "FAIL"
        report["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        if observer:
            try:
                observer.close()
            except Exception as exc:
                report.setdefault("cleanupErrors", []).append(f"CDP detach: {type(exc).__name__}: {exc}")
        if chrome and hwnd:
            try:
                user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
                time.sleep(0.3)
            except Exception as exc:
                report.setdefault("cleanupErrors", []).append(f"Chrome WM_CLOSE: {type(exc).__name__}: {exc}")
        chrome_left = stop_owned_process(chrome, chrome_pids, graceful=True)
        server_left = stop_owned_process(server, server_pids, graceful=True)
        report["cleanup"]["chromeExited"] = not chrome_left and (chrome is None or chrome.poll() is not None)
        report["cleanup"]["serverExited"] = not server_left and (server is None or server.poll() is not None)
        report["cleanup"]["chromeRemainingPids"] = chrome_left
        report["cleanup"]["serverRemainingPids"] = server_left
        if chrome:
            report["cleanup"]["ownedProcessPids"]["chrome"] = sorted(set(report["cleanup"]["ownedProcessPids"].get("chrome", []) + chrome_pids + process_tree_pids(chrome)))
        if server:
            report["cleanup"]["ownedProcessPids"]["server"] = sorted(set(report["cleanup"]["ownedProcessPids"].get("server", []) + server_pids + process_tree_pids(server)))
        if not args.keep_workspace and report["cleanup"]["chromeExited"] and report["cleanup"]["serverExited"]:
            try:
                shutil.rmtree(run_root)
                temporary_workspace_removed = True
            except Exception as exc:
                report.setdefault("cleanupErrors", []).append(f"Temporary workspace removal: {type(exc).__name__}: {exc}")
        report["cleanup"]["temporaryWorkspaceRemoved"] = temporary_workspace_removed
        if not report["cleanup"]["chromeExited"] or not report["cleanup"]["serverExited"]:
            report["result"] = "FAIL_CLEANUP"
        if report.get("cleanupErrors") and report["result"] == "PASS":
            report["result"] = "FAIL_CLEANUP"
        for stream_name in ("server_log", "chrome_log"):
            stream = locals().get(stream_name)
            if stream:
                stream.close()
        chrome_log_path = evidence / "chrome-launch.txt"
        if chrome_log_path.is_file():
            launch_log = chrome_log_path.read_text(encoding="utf-8", errors="replace")
            launch_log = re.sub(r"ws://127\.0\.0\.1:\d+/devtools/browser/[^\s]+", "ws://127.0.0.1:<ephemeral>/devtools/browser/<redacted>", launch_log)
            chrome_log_path.write_text(launch_log, encoding="utf-8")
        report["finishedAtUtc"] = utc_now()
        json_write(report_path, report)

    print(json.dumps({"result": report["result"], "report": str(report_path), "evidence": str(evidence), "cleanup": report["cleanup"]}, indent=2))
    return 0 if report["result"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
