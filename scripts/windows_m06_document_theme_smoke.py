#!/usr/bin/env python3
"""Native Windows smoke for M06 document themes using local Supabase fixtures."""

from __future__ import annotations

import ctypes
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import windows_m03_supabase_acceptance as m03
import windows_supabase_onboarding_acceptance as onboarding
import windows_web_ui_acceptance as desktop


REPO = Path(__file__).resolve().parent.parent
LOCAL_SUPABASE_WORKDIR = "/tmp/jobhuntai-m02-local-1EJyDw"
LOCAL_DB_CONTAINER = "supabase_db_jobhuntai-m02-local-20261106"
TARGET_DEFAULT = "modern-teal"
TARGET_APPLICATION_THEME = "technical-slate"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def local_supabase() -> dict[str, str]:
    command = [
        "wsl.exe", "-d", "Ubuntu-24.04", "-u", "root", "--", "/usr/local/bin/supabase",
        "status", "--workdir", LOCAL_SUPABASE_WORKDIR, "--output", "json",
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError("Could not read the disposable local Supabase status; command output withheld.")
    try:
        status = json.loads(result.stdout)
        api_url = str(status["API_URL"]).rstrip("/")
        publishable = str(status["PUBLISHABLE_KEY"])
        service = str(status["SERVICE_ROLE_KEY"])
    except (KeyError, json.JSONDecodeError, TypeError) as exc:
        raise RuntimeError("Local Supabase did not report the expected API credentials.") from None
    parsed = urlparse(api_url)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise RuntimeError("Refusing to run M06 desktop smoke against a non-loopback Supabase URL.")
    return {"url": api_url, "publishable": publishable, "service": service}


def seed_application_fixture(container: str, user_id: str) -> tuple[str, str, str, str]:
    if not re.fullmatch(r"[0-9a-f-]{36}", user_id, re.I):
        raise RuntimeError("Refusing to seed an M06 fixture without a synthetic user UUID.")
    company_id, job_id, snapshot_id, application_id = (str(uuid.uuid4()) for _ in range(4))
    title = "Synthetic M06 Simulation Engineer"
    description = (
        "Fictional fixture vacancy for local document theme selection. The role involves numerical "
        "simulation, model validation, and technical communication. No employer contact is configured."
    )
    sql = f"""
      begin;
      insert into public.companies(id,user_id,canonical_name,website)
      values('{company_id}'::uuid,'{user_id}'::uuid,'Synthetic Example Engineering','https://example.test');
      insert into public.jobs(id,user_id,company_id,title,source_url,application_url,location_text)
      values('{job_id}'::uuid,'{user_id}'::uuid,'{company_id}'::uuid,'{title}',
        'https://example.test/jobs/m06-synthetic','https://example.test/apply/m06-synthetic','Reading');
      insert into public.job_snapshots(id,job_id,title,company_name,description_text,source_url)
      values('{snapshot_id}'::uuid,'{job_id}'::uuid,'{title}','Synthetic Example Engineering','{description}',
        'https://example.test/jobs/m06-synthetic');
      update public.jobs set current_snapshot_id='{snapshot_id}'::uuid where id='{job_id}'::uuid;
      insert into public.applications(id,user_id,job_id,state,job_snapshot_id,selected_cv_family,
        preparation_origin,chosen_to_apply_at,next_action,notes)
      values('{application_id}'::uuid,'{user_id}'::uuid,'{job_id}'::uuid,'preparing','{snapshot_id}'::uuid,
        'simulation_cae','manual',now(),'Review this synthetic application.',
        'Local M06 desktop fixture; synthetic data only.');
      commit;
    """
    onboarding.psql(container, sql)
    return company_id, job_id, snapshot_id, application_id


def database_state(container: str, user_id: str) -> dict:
    sql = f"""
      select json_build_object(
        'jobs',(select count(*) from public.jobs where user_id='{user_id}'::uuid),
        'companies',(select count(*) from public.companies where user_id='{user_id}'::uuid),
        'applications',(select count(*) from public.applications where user_id='{user_id}'::uuid),
        'requests',(select count(*) from public.document_generation_requests where user_id='{user_id}'::uuid),
        'items',(select count(*) from public.document_generation_items where user_id='{user_id}'::uuid),
        'formSessions',(select count(*) from public.form_agent_sessions where user_id='{user_id}'::uuid),
        'defaultTheme',(select default_template_id from public.document_preferences where user_id='{user_id}'::uuid)
      )::text;
    """
    return m03.psql_json(container, sql)


def page_state(observer: desktop.CDPObserver) -> dict:
    return observer.evaluate("""JSON.stringify((() => ({
      href: location.href,
      pathname: location.pathname,
      readyState: document.readyState,
      bodyText: document.body?.innerText || '',
      viewport: {width: innerWidth, height: innerHeight, dpr: devicePixelRatio},
      dialogText: document.querySelector('[role="dialog"]')?.innerText || null,
      emailField: !!document.querySelector('input[name="email"]'),
      passwordField: !!document.querySelector('input[name="password"]'),
      appThemeSelect: !!document.querySelector('select[id^="document-theme-"]'),
      selectedGalleryThemes: [...document.querySelectorAll('.documentTemplateSelect[aria-pressed="true"]')]
        .map(el => el.closest('article')?.querySelector('.documentTemplateTitle')?.textContent?.trim() || ''),
      resourceOrigins: [...new Set(performance.getEntriesByType('resource').map(item => {
        try { return new URL(item.name).origin; } catch { return ''; }
      }).filter(Boolean))]
    }))())""")


def wait_for(observer: desktop.CDPObserver, predicate, description: str, timeout: float = 35) -> dict:
    deadline = time.monotonic() + timeout
    last_path = ""
    while time.monotonic() < deadline:
        try:
            state = page_state(observer)
            last_path = str(state.get("pathname", ""))
            if predicate(state):
                return state
        except (RuntimeError, TimeoutError):
            pass
        time.sleep(0.2)
    raise TimeoutError(f"Timed out waiting for {description}; last route was {last_path!r}.")


def click_native(observer: desktop.CDPObserver, hwnd: int, pid: int, selector: str, chrome_pids: list[int]) -> dict:
    prompt_dismissed = dismiss_test_owned_password_prompt(hwnd, chrome_pids)
    item = desktop.ensure_onboarding_visible(observer, hwnd, pid, selector)
    result = desktop.native_click_observed_rect(observer, hwnd, pid, item["rect"], selector)
    result["testOwnedPasswordPromptDismissed"] = prompt_dismissed
    return result


def fill_native(observer: desktop.CDPObserver, hwnd: int, pid: int, selector: str, value: str, label: str) -> None:
    try:
        result = desktop.native_replace_value(observer, hwnd, pid, selector, value)
        if not result.get("activeElementReadback") or result.get("valueReadback") != value:
            raise RuntimeError("input readback mismatch")
    except Exception:
        # native_replace_value's error can include the password readback; never
        # propagate that detail into the console or persisted report.
        raise RuntimeError(f"Native {label} entry or readback failed; input details withheld.") from None


def dismiss_test_owned_password_prompt(hwnd: int, chrome_pids: list[int]) -> bool:
    foreground = desktop.user32.GetForegroundWindow()
    if foreground == hwnd:
        return False
    owner = desktop.wintypes.DWORD()
    desktop.user32.GetWindowThreadProcessId(foreground, ctypes.byref(owner))
    length = desktop.user32.GetWindowTextLengthW(foreground)
    title = ctypes.create_unicode_buffer(max(1, length + 1))
    desktop.user32.GetWindowTextW(foreground, title, len(title))
    if int(owner.value) not in chrome_pids or title.value.strip() != "Save password?":
        raise RuntimeError("An unexpected native window took focus; refusing to interact with it.")
    desktop.press_key(0x1B)  # Dismiss the test-owned Chrome password prompt; never save the synthetic credential.
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if desktop.user32.GetForegroundWindow() == hwnd:
            return True
        time.sleep(0.1)
    raise RuntimeError("The test-owned Chrome password prompt did not dismiss with Escape.")


def read_preferences(observer: desktop.CDPObserver) -> dict:
    return observer.evaluate("""(async () => {
      const response = await fetch('/api/documents/preferences', {cache: 'no-store'});
      const body = await response.json();
      return JSON.stringify({status: response.status, ok: body.ok === true, defaultTemplateId: body.defaultTemplateId || null});
    })()""")


def screenshot(path: Path, hwnd: int, pid: int, resolution: tuple[int, int]) -> dict:
    result = desktop.desktop_screenshot(path, hwnd, pid, resolution, redact_taskbar=True)
    result["path"] = str(path)
    return result


def safe_startup_log(path: Path, secrets_to_redact: list[str]) -> str:
    if not path.is_file():
        return "No development-server log was written."
    text = path.read_text(encoding="utf-8", errors="replace")
    for secret in secrets_to_redact:
        if secret:
            text = text.replace(secret, "<redacted>")
    text = re.sub(r"eyJ[A-Za-z0-9_=-]{32,}", "<redacted-token>", text)
    text = re.sub(r"sb_(?:publishable|secret)_[A-Za-z0-9_-]+", "<redacted-key>", text)
    text = re.sub(r"ws://127\.0\.0\.1:\d+/devtools/browser/[^\s]+", "ws://127.0.0.1:<ephemeral>/devtools/browser/<redacted>", text)
    return "\n".join(text.splitlines()[-80:]) + "\n"


def main() -> int:
    dpi_awareness = desktop.enable_per_monitor_dpi_awareness()
    run_id = uuid.uuid4().hex
    run_root = Path(tempfile.mkdtemp(prefix=f"JobHuntAI-M06-Desktop-{run_id[:8]}-"))
    evidence = Path(tempfile.gettempdir()) / f"JobHuntAI-M06-Evidence-{run_id[:8]}"
    evidence.mkdir(parents=True, exist_ok=False)
    profile = run_root / "chrome-profile"
    report_path = evidence / "report.json"
    started_at = utc_now()
    account = None
    chrome = server = observer = None
    hwnd = None
    chrome_pids: list[int] = []
    server_pids: list[int] = []
    supabase = None
    application_id = None
    user_id = None
    server_log = None
    report = {
        "schemaVersion": "1.0.0",
        "runId": run_id,
        "startedAtUtc": started_at,
        "repository": {
            "branch": subprocess.run(["git", "-C", str(REPO), "branch", "--show-current"], capture_output=True, text=True, check=True).stdout.strip(),
            "head": subprocess.run(["git", "-C", str(REPO), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip(),
        },
        "environment": {"dpiAwareness": dpi_awareness},
        "testLevel": "genuine_windows_desktop_web_ui",
        "application": {
            "type": "local Next.js web application in test-owned Chrome",
            "version": json.loads((REPO / "apps/web/package.json").read_text(encoding="utf-8")).get("version"),
            "nextVersion": json.loads((REPO / "node_modules/next/package.json").read_text(encoding="utf-8")).get("version"),
            "chromeExecutable": str(desktop.find_chrome()),
            "chromeVersion": None,
            "chromeProfileMode": "incognito with unique test-owned user-data-dir",
            "chromePid": None,
            "serverPid": None,
            "serverCommand": None,
            "userProfile": "%TEMP%\\JobHuntAI-M06-Desktop-<run>\\chrome-profile",
            "testServerAddress": None,
            "supabaseAddress": "loopback local project; secret values withheld",
        },
        "syntheticFixture": {"companies": 1, "jobs": 1, "snapshots": 1, "applications": 1, "documentRequests": 0},
        "workflow": [],
        "screenshots": [],
        "network": {"externalPageResourceOrigins": [], "allObservedOriginsLoopback": False},
        "cleanup": {
            "chromeExited": False,
            "serverExited": False,
            "syntheticAccountDeleted": False,
            "syntheticRowsRemoved": False,
            "temporaryProfileRemoved": False,
            "evidenceRetainedWithoutBrowserProfile": True,
        },
        "limitations": [
            "The application-level selection is verified in the real UI without creating a document request; its durable request/version identity is covered by focused tests and the local M06 migration.",
            "No ChatGPT generation, Drive operation, employer contact, or submission is triggered.",
        ],
        "result": "RUNNING",
    }
    try:
        supabase = local_supabase()
        os.environ["JOBHUNT_M03_SUPABASE_URL"] = supabase["url"]
        os.environ["JOBHUNT_M03_PUBLISHABLE_KEY"] = supabase["publishable"]
        os.environ["JOBHUNT_M03_SERVICE_KEY"] = supabase["service"]
        os.environ["JOBHUNT_M03_DB_CONTAINER"] = LOCAL_DB_CONTAINER

        account = m03.seed_synthetic_account(run_id, "m06")
        user_id = account["userId"]
        _, _, _, application_id = seed_application_fixture(LOCAL_DB_CONTAINER, user_id)
        report["syntheticFixture"]["databaseBeforeUi"] = database_state(LOCAL_DB_CONTAINER, user_id)
        if any(report["syntheticFixture"]["databaseBeforeUi"][key] != 0 for key in ("requests", "items", "formSessions")):
            raise RuntimeError("Synthetic account started with a document request or form session.")

        port = desktop.free_loopback_port()
        app_url = f"http://127.0.0.1:{port}"
        report["application"]["testServerAddress"] = app_url
        server_env = desktop.safe_environment(run_root)
        server_env.update({
            "NODE_ENV": "development",
            "JOBHUNT_DATA_MODE": "supabase",
            "JOBHUNT_TEST_AUTH": "true",
            "NEXT_PUBLIC_SUPABASE_URL": supabase["url"],
            "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY": supabase["publishable"],
            "NEXT_TELEMETRY_DISABLED": "1",
        })
        server_env.pop("JOBHUNT_M03_SERVICE_KEY", None)
        next_bin = REPO / "node_modules/next/dist/bin/next"
        server_log = (run_root / "next-server.log").open("wb")
        server = subprocess.Popen(
            ["node", str(next_bin), "dev", "--webpack", "--hostname", "127.0.0.1", "--port", str(port)],
            cwd=REPO / "apps/web", env=server_env, stdout=server_log,
            stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
        )
        server_pids = desktop.process_tree_pids(server)
        report["application"]["serverPid"] = server.pid
        report["application"]["serverCommand"] = f"node next dev --webpack --hostname 127.0.0.1 --port {port}"

        ready_deadline = time.monotonic() + 90
        server_ready = False
        while time.monotonic() < ready_deadline:
            if server.poll() is not None:
                raise RuntimeError("The isolated Next development server exited before becoming ready; see the redacted startup log in the evidence folder.")
            try:
                with urllib.request.urlopen(app_url + "/api/health", timeout=2) as response:
                    server_ready = response.status == 200
            except Exception:
                pass
            if server_ready:
                break
            time.sleep(0.3)
        if not server_ready:
            raise TimeoutError("The isolated local application did not reach API health readiness.")
        report["workflow"].append({"name": "isolated_app_server_ready", "result": "PASS", "address": app_url})

        chrome, chrome_pids, observer, hwnd, window = m03.launch_chrome(REPO, run_root, profile, app_url, evidence, incognito=True)
        report["application"]["chromePid"] = chrome.pid
        report["application"]["chromeVersion"] = subprocess.run(
            [str(desktop.find_chrome()), "--version"], capture_output=True, text=True, check=True,
        ).stdout.strip()
        report["application"]["initialWindowState"] = {
            "maximized": window["maximized"],
            "foreground": window["isForeground"],
            "bounds": window["bounds"],
            "client": window["client"],
        }
        if not window["maximized"] or not window["isForeground"]:
            raise RuntimeError("The test-owned Chrome window did not start maximized in the foreground.")
        for log_path in evidence.glob("chrome-launch-*.log"):
            raw = log_path.read_text(encoding="utf-8", errors="replace")
            safe = re.sub(r"ws://127\.0\.0\.1:\d+/devtools/browser/[^\s]+", "ws://127.0.0.1:<ephemeral>/devtools/browser/<redacted>", raw)
            log_path.write_text(safe, encoding="utf-8")

        login_url = app_url + "/login?next=" + urllib.parse.quote("/documents", safe="")
        desktop.native_navigate(observer, hwnd, chrome.pid, login_url)
        wait_for(observer, lambda state: state["pathname"] == "/login" and state["emailField"] and state["passwordField"], "loopback local sign-in form")
        fill_native(observer, hwnd, chrome.pid, "input[name=email]", account["email"], "synthetic email")
        fill_native(observer, hwnd, chrome.pid, "input[name=password]", account["password"], "synthetic password")
        login_click = click_native(observer, hwnd, chrome.pid, "button[type=submit]", chrome_pids)
        gallery = wait_for(observer, lambda state: state["pathname"] == "/documents" and "Choose your document style" in state["bodyText"], "authenticated document theme gallery", 60)
        password_prompt_dismissed = bool(login_click["testOwnedPasswordPromptDismissed"] or dismiss_test_owned_password_prompt(hwnd, chrome_pids))
        report["workflow"].append({"name": "native_local_sign_in_and_gallery_mount", "result": "PASS", "nativeEmailAndPasswordReadback": True, "loopbackAuthenticatedWorkspace": True})
        if password_prompt_dismissed:
            report["workflow"].append({"name": "dismiss_test_owned_password_prompt", "result": "PASS", "method": "native Escape", "credentialSaved": False})

        preview_selector = "article.documentTemplateCard:nth-of-type(5) button.textLink"
        preview_click = click_native(observer, hwnd, chrome.pid, preview_selector, chrome_pids)
        preview = wait_for(observer, lambda state: bool(state["dialogText"]) and "Modern Teal" in state["dialogText"] and "Taylor Example" in state["dialogText"], "paired modern-teal preview dialog")
        password_prompt_dismissed = bool(preview_click["testOwnedPasswordPromptDismissed"] or dismiss_test_owned_password_prompt(hwnd, chrome_pids) or password_prompt_dismissed)
        if password_prompt_dismissed and not any(item.get("name") == "dismiss_test_owned_password_prompt" for item in report["workflow"]):
            report["workflow"].append({"name": "dismiss_test_owned_password_prompt", "result": "PASS", "method": "native Escape", "credentialSaved": False})
        report["workflow"].append({"name": "native_open_paired_preview", "result": "PASS", "theme": "Modern Teal", "fictionalCandidateVisible": "Taylor Example" in preview["dialogText"]})

        resolution = desktop.ImageGrab.grab().size
        if resolution[0] < 800 or resolution[1] < 600:
            raise RuntimeError(f"Pillow did not capture a full-size desktop: {resolution}.")
        report["environment"]["desktopResolution"] = {"width": resolution[0], "height": resolution[1], "source": "Pillow ImageGrab full desktop"}
        report["screenshots"].append(screenshot(evidence / "01-paired-preview-open.png", hwnd, chrome.pid, resolution))
        click_native(observer, hwnd, chrome.pid, "section.templatePreviewDialog button.secondaryButton", chrome_pids)
        wait_for(observer, lambda state: state["dialogText"] is None, "paired preview dialog close")

        choose_selector = "article.documentTemplateCard:nth-of-type(5) button.documentTemplateSelect"
        click_native(observer, hwnd, chrome.pid, choose_selector, chrome_pids)
        selected = wait_for(observer, lambda state: "Modern Teal" in state["selectedGalleryThemes"], "native theme selection")
        if selected["selectedGalleryThemes"] != ["Modern Teal"]:
            raise RuntimeError("Native gallery click did not select the Modern Teal theme.")
        click_native(observer, hwnd, chrome.pid, ".documentTemplateFooter button.primaryButton", chrome_pids)
        wait_for(observer, lambda state: "Default theme saved" in state["bodyText"], "default theme save acknowledgement")
        preference = read_preferences(observer)
        if preference.get("status") != 200 or preference.get("defaultTemplateId") != TARGET_DEFAULT:
            raise RuntimeError("The authenticated preferences API did not read back the selected default theme.")
        saved_db = database_state(LOCAL_DB_CONTAINER, user_id)
        if saved_db.get("defaultTheme") != TARGET_DEFAULT:
            raise RuntimeError("The local database did not persist the selected default theme.")
        report["workflow"].append({"name": "native_save_default_and_api_database_readback", "result": "PASS", "defaultTheme": TARGET_DEFAULT, "authenticatedApiReadback": True, "databaseReadback": True})

        desktop.press_key(0x52, ctrl=True)
        reloaded = wait_for(observer, lambda state: state["pathname"] == "/documents" and "Choose your document style" in state["bodyText"] and "Modern Teal" in state["selectedGalleryThemes"], "reloaded saved default", 45)
        reloaded_preference = read_preferences(observer)
        if reloaded_preference.get("defaultTemplateId") != TARGET_DEFAULT:
            raise RuntimeError("The saved default was not preserved after native page refresh.")
        report["workflow"].append({"name": "native_refresh_default_persistence", "result": "PASS", "selectedAfterReload": reloaded["selectedGalleryThemes"], "apiTheme": TARGET_DEFAULT})
        report["screenshots"].append(screenshot(evidence / "02-default-saved-reloaded.png", hwnd, chrome.pid, resolution))

        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/applications/" + application_id)
        detail = wait_for(observer, lambda state: state["pathname"] == "/applications/" + application_id and state["appThemeSelect"] and "Create documents for this job" in state["bodyText"], "synthetic application theme selector", 45)
        theme_selector = "#document-theme-" + application_id
        before_select = desktop.onboarding_element(observer, theme_selector)
        if not before_select or before_select.get("value") != TARGET_DEFAULT:
            raise RuntimeError("Application document selector did not load the saved default theme.")
        click_native(observer, hwnd, chrome.pid, theme_selector, chrome_pids)
        focused_select = desktop.onboarding_element(observer, theme_selector)
        if not focused_select or not focused_select.get("focused"):
            raise RuntimeError("Native click did not focus the application theme selector.")
        desktop.press_key(0x24)  # Home
        desktop.press_key(0x28)  # Down to Clean Charcoal
        desktop.press_key(0x28)  # Down to Technical Slate
        desktop.press_key(0x0D)  # Commit the native selection
        deadline = time.monotonic() + 8
        chosen = None
        while time.monotonic() < deadline:
            chosen = desktop.onboarding_element(observer, theme_selector)
            if chosen and chosen.get("value") == TARGET_APPLICATION_THEME:
                break
            time.sleep(0.15)
        if not chosen or chosen.get("value") != TARGET_APPLICATION_THEME or not chosen.get("focused"):
            raise RuntimeError("Native keyboard input did not change and read back the application theme.")
        selected_summary = observer.evaluate("JSON.stringify(document.querySelector('.documentThemeSummary')?.textContent?.trim() || '')")
        if not selected_summary:
            raise RuntimeError("Application theme summary disappeared after selection.")
        report["workflow"].append({"name": "native_application_level_theme_selection", "result": "PASS", "theme": TARGET_APPLICATION_THEME, "activeControlReadback": True, "summaryVisible": True})
        report["screenshots"].append(screenshot(evidence / "03-application-theme-selected.png", hwnd, chrome.pid, resolution))
        final_db = database_state(LOCAL_DB_CONTAINER, user_id)
        if final_db.get("requests") != 0 or final_db.get("items") != 0 or final_db.get("formSessions") != 0:
            raise RuntimeError("The theme selection unexpectedly created a document request, item, or form session.")
        report["syntheticFixture"]["databaseAfterUi"] = final_db

        origins = sorted(set(gallery.get("resourceOrigins", []) + reloaded.get("resourceOrigins", []) + detail.get("resourceOrigins", [])))
        external = [origin for origin in origins if urlparse(origin).hostname not in {"127.0.0.1", "localhost", "::1"}]
        report["network"] = {"externalPageResourceOrigins": external, "allObservedOriginsLoopback": not external, "origins": origins}
        if external:
            raise RuntimeError("The test-owned app page observed a non-loopback resource origin.")
        report["result"] = "PASS"
    except Exception as exc:
        report["result"] = "FAIL"
        report["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        if observer:
            try:
                observer.close()
            except Exception:
                report["cleanup"]["observerCloseError"] = "The loopback CDP observer did not close cleanly."
        if chrome and hwnd:
            try:
                desktop.user32.PostMessageW(hwnd, desktop.WM_CLOSE, 0, 0)
                time.sleep(0.3)
            except Exception:
                report["cleanup"]["chromeCloseError"] = "Could not send WM_CLOSE to the test-owned Chrome window."
        chrome_remaining = m03.stop_chrome(chrome, chrome_pids, None) if chrome else []
        server_remaining = desktop.stop_owned_process(server, server_pids, graceful=True) if server else []
        if server_log:
            server_log.flush()
            server_log.close()
        server_log_path = run_root / "next-server.log"
        if report["result"] != "PASS" and server_log_path.exists():
            safe_log = safe_startup_log(server_log_path, [supabase.get("publishable", ""), supabase.get("service", "")] if supabase else [])
            startup_log_path = evidence / "startup-log-redacted.txt"
            startup_log_path.write_text(safe_log, encoding="utf-8")
            report["startupDiagnosticLog"] = str(startup_log_path)
        report["cleanup"]["chromeExited"] = bool(chrome is None or (chrome.poll() is not None and not chrome_remaining))
        report["cleanup"]["serverExited"] = bool(server is None or (server.poll() is not None and not server_remaining))
        report["cleanup"]["chromeRemainingPids"] = chrome_remaining
        report["cleanup"]["serverRemainingPids"] = server_remaining
        if account and supabase:
            try:
                cleanup = {}
                onboarding.cleanup_accounts(supabase["url"], supabase["service"], LOCAL_DB_CONTAINER, [account], cleanup)
                report["cleanup"]["syntheticAccountDeleted"] = bool(cleanup.get("syntheticDataCleanup", {}).get("complete"))
                report["cleanup"]["accountCleanupSummary"] = cleanup.get("syntheticDataCleanup", {})
                post = m03.psql_json(LOCAL_DB_CONTAINER, f"""
                  select json_build_object(
                    'jobs',(select count(*) from public.jobs where user_id='{account['userId']}'::uuid),
                    'companies',(select count(*) from public.companies where user_id='{account['userId']}'::uuid),
                    'applications',(select count(*) from public.applications where user_id='{account['userId']}'::uuid),
                    'preferences',(select count(*) from public.document_preferences where user_id='{account['userId']}'::uuid)
                  )::text;
                """)
                report["cleanup"]["syntheticRowsRemoved"] = all(value == 0 for value in post.values())
                report["cleanup"]["postCleanupRowCounts"] = post
            except Exception:
                report["cleanup"]["syntheticAccountDeleted"] = False
                report["cleanup"]["syntheticRowsRemoved"] = False
                report["cleanup"]["accountCleanupError"] = "Local synthetic account cleanup or readback failed; inspect the local test database."
        if report["cleanup"]["chromeExited"] and report["cleanup"]["serverExited"]:
            try:
                resolved_root = run_root.resolve(strict=True)
                if resolved_root.parent != Path(tempfile.gettempdir()).resolve() or "JobHuntAI-M06-Desktop-" not in resolved_root.name:
                    raise RuntimeError("Refusing to remove an unexpected M06 test workspace path.")
                shutil.rmtree(resolved_root)
                report["cleanup"]["temporaryProfileRemoved"] = not resolved_root.exists()
            except Exception:
                report["cleanup"]["temporaryWorkspaceRemovalError"] = "Could not remove the exact M06 test-owned workspace."
        else:
            report["cleanup"]["temporaryWorkspaceRemoved"] = False
        report["finishedAtUtc"] = utc_now()
        report["evidenceDirectory"] = str(evidence)
        report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    summary = {
        "result": report["result"],
        "report": str(report_path),
        "screenshots": [item["path"] for item in report["screenshots"]],
        "chromePid": report["application"].get("chromePid"),
        "serverPid": report["application"].get("serverPid"),
        "cleanup": report["cleanup"],
    }
    print(json.dumps(summary, indent=2))
    return 0 if report["result"] == "PASS" and all(report["cleanup"].get(key) for key in ("chromeExited", "serverExited", "syntheticAccountDeleted", "syntheticRowsRemoved", "temporaryProfileRemoved")) else 1


if __name__ == "__main__":
    raise SystemExit(main())
