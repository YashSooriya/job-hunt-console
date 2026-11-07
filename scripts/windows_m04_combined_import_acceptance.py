#!/usr/bin/env python3
"""Focused M04 genuine Windows UI acceptance on disposable local Supabase data."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

import windows_m03_supabase_acceptance as m03
import windows_supabase_onboarding_acceptance as onboarding
import windows_web_ui_acceptance as desktop


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def safe_json_request(url: str, method: str = "GET", body: dict | None = None, headers: dict | None = None):
    data = json.dumps(body, separators=(",", ":")).encode("utf-8") if body is not None else None
    request_headers = {"content-type": "application/json", **(headers or {})}
    request = urllib.request.Request(url, data=data, headers=request_headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            return error.code, json.loads(raw) if raw else {}
        except Exception:
            return error.code, {}


def app_data(observer: desktop.CDPObserver, path: str, method: str = "GET", body: dict | None = None) -> dict:
    return m03.browser_private_json(observer, path, method, body)


def screenshot(evidence: Path, name: str, hwnd: int, pid: int, display: tuple[int, int]) -> dict:
    item = desktop.desktop_screenshot(evidence / name, hwnd, pid, display)
    return {"path": name, "width": item.get("width"), "height": item.get("height"),
            "fullDesktop": True, "identityRedacted": True}


def dismiss_test_profile_password_prompt(hwnd: int, pid: int, display: tuple[int, int]) -> dict:
    from PIL import ImageGrab

    x, y = round(display[0] * 0.742), round(display[1] * 0.349)
    def blue_button_pixels(image) -> int:
        crop = image.crop((x - 12, y - 12, x + 12, y + 12)).convert("RGB")
        return sum(1 for red, green, blue in crop.getdata() if blue - red > 25 and green > 190 and blue > 220)

    before = ImageGrab.grab()
    before_pixels = blue_button_pixels(before)
    detection_deadline = time.monotonic() + 3
    while before_pixels < 300 and time.monotonic() < detection_deadline:
        time.sleep(0.2)
        before = ImageGrab.grab()
        before_pixels = blue_button_pixels(before)
    if before_pixels < 300:
        return {"promptVisible": False, "dismissed": False, "nativeInput": False}

    native = desktop.focus_and_maximize(hwnd, pid)
    pointer_method = desktop.mouse_click(x, y)
    cursor = desktop.POINT()
    if not desktop.user32.GetCursorPos(desktop.ctypes.byref(cursor)) or (cursor.x, cursor.y) != (x, y):
        raise RuntimeError("The native click did not reach Chrome's synthetic-profile password prompt.")
    time.sleep(0.35)
    after = ImageGrab.grab()
    after_pixels = blue_button_pixels(after)
    if after_pixels >= 100 or not native.get("isForeground"):
        raise RuntimeError("Chrome's synthetic-profile password prompt remained visible after native dismissal.")
    return {"promptVisible": True, "dismissed": True, "nativeInput": True,
            "nativeClick": {"x": x, "y": y, "pointerMethod": pointer_method,
                            "cursorReadback": {"x": cursor.x, "y": cursor.y},
                            "foregroundWindowVerified": True},
            "buttonBackgroundPixelsBefore": before_pixels, "after": after_pixels}


def ui_text(observer: desktop.CDPObserver, text: str) -> dict:
    wanted = text.strip()
    return observer.evaluate(
        "JSON.stringify((()=>{const e=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==="
        + json.dumps(wanted) + ");if(!e)return null;const r=e.getBoundingClientRect();"
        "const parts=[];for(let n=e;n&&n.nodeType===1;n=n.parentElement){let part=n.localName;"
        "const siblings=n.parentElement?[...n.parentElement.children].filter(x=>x.localName===n.localName):[];"
        "if(siblings.length>1)part+=':nth-of-type('+(siblings.indexOf(n)+1)+')';parts.unshift(part);"
        "if(n===document.documentElement)break;}return {x:r.x,y:r.y,width:r.width,height:r.height,"
        "disabled:e.disabled,selector:parts.join(' > ')}})())"
    )


def native_click_text(observer: desktop.CDPObserver, hwnd: int, pid: int, text: str) -> dict:
    item = ui_text(observer, text)
    if not item or item.get("disabled"):
        raise RuntimeError("The expected visible action was not enabled: " + text)
    if not item.get("selector"):
        raise RuntimeError("The expected visible button did not have a stable CSS selector: " + text)
    return desktop.native_click_observed_rect(observer, hwnd, pid, item, item["selector"])


def field_input(observer: desktop.CDPObserver, hwnd: int, pid: int, selector: str, value: str) -> dict:
    action = desktop.native_replace_value(observer, hwnd, pid, selector, value)
    return {"control": selector, "typedCharacters": len(value), "nativeClick": action.get("click"),
            "activeElementReadback": True, "valueReadbackRecorded": False}


def batch_state(observer: desktop.CDPObserver, batch_id: str) -> dict:
    response = app_data(observer, "/api/jobs/inspect?batchId=" + urllib.parse.quote(batch_id, safe=""))
    if response.get("status") != 200 or not response.get("data", {}).get("ok"):
        raise RuntimeError("The authenticated M04 batch status route failed.")
    return response["data"]


def wait_batch(observer: desktop.CDPObserver, batch_id: str, timeout: float = 45) -> dict:
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = batch_state(observer, batch_id)
        items = last.get("items", [])
        if items and all(
            item.get("inspection", {}).get("status") not in ("queued", "processing")
            and item.get("inspection", {}).get("initial_fit_status") not in ("pending", None)
            for item in items
        ):
            return last
        time.sleep(0.4)
    raise TimeoutError("The saved local M04 batch did not reach terminal per-entry outcomes; state="
                       + json.dumps(summarize_batch(last or {}), sort_keys=True))


def summarize_batch(data: dict) -> dict:
    items = []
    for row in data.get("items", []) if isinstance(data.get("items"), list) else []:
        inspection = row.get("inspection", {}) if isinstance(row, dict) else {}
        dispatch = row.get("dispatch", {}) if isinstance(row, dict) else {}
        items.append({
            "requestId": inspection.get("id"), "sourceUrl": inspection.get("source_url"),
            "originalUrlPreserved": bool(inspection.get("original_source_url")),
            "status": inspection.get("status"), "jobId": inspection.get("job_id"),
            "fitStatus": inspection.get("initial_fit_status"),
            "fitAnalysisId": inspection.get("initial_fit_analysis_id"),
            "fitErrorPresent": bool(inspection.get("initial_fit_error")),
            "dispatchId": dispatch.get("id"), "dispatchState": dispatch.get("state"),
        })
    return {"ok": data.get("ok") is True, "batchId": data.get("batchId"),
            "dispatchIds": sorted({item["dispatchId"] for item in items if item["dispatchId"]}),
            "items": items, "duplicateCount": data.get("duplicateCount", 0)}


def database_batch(container: str, batch_id: str) -> dict:
    if not re.fullmatch(r"[0-9a-f-]{36}", batch_id, re.I):
        raise RuntimeError("Refusing a database verification query without a UUID batch id.")
    sql = f"""
      select json_build_object(
        'items', coalesce((
          select json_agg(json_build_object(
            'requestId', r.id, 'sourceUrl', r.source_url, 'originalSourceUrl', r.original_source_url,
            'status', r.status, 'jobId', r.job_id, 'fitStatus', r.initial_fit_status,
            'fitAnalysisId', r.initial_fit_analysis_id, 'fitResponseHash', r.initial_fit_response_hash,
            'dispatchId', r.dispatch_request_id, 'testingMode', r.initial_fit_testing_mode,
            'dispatchState', d.state, 'dispatchResponseHash', d.response_hash,
            'provenanceRecorded', d.output_refs->>'response_provenance_recorded',
            'matchHash', r.initial_fit_response_hash=d.response_hash
          ) order by r.batch_position)
          from public.job_url_inspection_requests r
          left join public.chatgpt_dispatch_requests d on d.id=r.dispatch_request_id and d.user_id=r.user_id
          where r.batch_id='{batch_id}'::uuid
        ), '[]'::json),
        'inspectionCount', (select count(*) from public.job_url_inspection_requests where batch_id='{batch_id}'::uuid),
        'distinctDispatchCount', (select count(distinct dispatch_request_id) from public.job_url_inspection_requests where batch_id='{batch_id}'::uuid),
        'distinctJobCount', (select count(distinct job_id) from public.job_url_inspection_requests where batch_id='{batch_id}'::uuid and job_id is not null),
        'fitAnalysisCount', (select count(*) from public.job_url_inspection_requests r join public.job_analyses a on a.id=r.initial_fit_analysis_id where r.batch_id='{batch_id}'::uuid)
      )::text;
    """
    return m03.psql_json(container, sql)


def entry_component(score: int | None, state: str, explanation: str) -> dict:
    return {"score": score, "state": state, "explanation": explanation}


DIMENSIONS = ("technical", "evidence", "seniority", "domain", "role_type", "qualification")


def synthetic_fit(request_id: str, source_url: str, *, unknown: bool = True) -> dict:
    if unknown:
        components = {key: entry_component(None, "insufficient_memory", "Candidate Memory is explicitly unknown in this synthetic test.") for key in DIMENSIONS}
        return {
            "job_id": request_id, "listing_url": source_url, "status": "insufficient_memory", "memory_status": "unknown",
            "components": components,
            "eligibility": {"state": "needs_confirmation", "explanation": "Work eligibility and candidate qualifications are unknown."},
            "summary": "No candidate Memory was supplied; no fit score can be calculated.",
            "strengths": [], "limitations": ["All candidate fit dimensions remain unknown."],
        }
    scores = {"technical": 100, "evidence": 0, "seniority": 100, "domain": 0, "role_type": 100, "qualification": 0}
    components = {key: entry_component(scores[key], "assessed", "Fictional controlled fixture score; not a real candidate assessment.") for key in DIMENSIONS}
    return {
        "job_id": request_id, "listing_url": source_url, "status": "assessed", "memory_status": "sufficient",
        "components": components,
        "eligibility": {"state": "needs_confirmation", "explanation": "Synthetic fixture only; confirm any real eligibility requirement."},
        "summary": "Controlled fictional response used to exercise the existing deterministic weighted rubric.",
        "strengths": ["Synthetic capability sentinel"], "limitations": [],
    }


def synthetic_job(request_id: str, source_url: str, index: int, run_id: str) -> dict:
    stable_id = hashlib.sha256(source_url.encode("utf-8")).hexdigest()[:12]
    return {
        "request_id": request_id, "source_url": source_url, "resolved_listing_url": source_url,
        "identity_match_fields": ["company", "title", "location"],
        "identity_evidence": "Controlled fixture identity: exact supplied synthetic URL, fictional employer, role, and location.",
        "company": "M04 Synthetic Analytics",
        "title": "Synthetic Data Analyst " + stable_id,
        "industry": "Synthetic QA", "description": "Fictional analytics role for local M04 validation; no employer or applicant data.",
        "application_url": None, "external_job_id": "m04-fixture-" + stable_id,
        "location": "Synthetic test location", "work_mode": "remote",
        "salary_text": None, "salary_min": None, "salary_max": None, "salary_currency": None,
        "salary_source": "not_available", "salary_confidence": None, "salary_basis": [],
        "posted_at": None, "closes_at": None, "employment_type": "full-time", "ats_provider": "synthetic_fixture",
        "summary": "Controlled fictional listing used only for M04 local integration tests.",
        "responsibilities": ["Validate synthetic data"], "essential_requirements": ["No real candidate requirements"],
        "desirable_requirements": [], "skills": ["Synthetic QA"], "benefits": [],
        "application_instructions": None, "company_website": None,
        "raw_metadata": {"retrieved_at": utc_now(), "posted_at_source_url": None, "posted_at_evidence": None,
                         "closes_at_source_url": None, "closes_at_evidence": None, "fixture": True},
    }


def parse_prompt(instruction: str) -> tuple[str, str, list[tuple[str, str]]]:
    batch = re.search(r"Batch ID: ([0-9a-f-]{36})\. Assessment time: (.+?)\. Inspect all supplied listings", instruction)
    if not batch:
        raise RuntimeError("The controlled response provider could not find the exact M04 batch envelope.")
    items = [(match.group(1), match.group(2)) for match in re.finditer(
        r"request_id=([0-9a-f-]{36}); exact source_url=(https?://[^\s]+)", instruction, re.I)]
    if not 1 <= len(items) <= 10 or len({item[0] for item in items}) != len(items):
        raise RuntimeError("The controlled provider did not receive the complete, unique M04 request list.")
    return batch.group(1), batch.group(2), items


def make_combined_response(instruction: str, scenario: str, run_id: str) -> str:
    batch_id, assessment_as_of, items = parse_prompt(instruction)
    results = []
    for index, (request_id, source_url) in enumerate(items):
        if scenario == "malformed_json":
            return '{ "schema_version": "job-url-memory-fit-batch-v1", broken'
        if scenario in ("valid_invalid_sibling", "wrong_listing_sibling") and index == 1:
            status = "wrong_listing" if scenario == "wrong_listing_sibling" else "unavailable"
            results.append({"request_id": request_id, "source_url": source_url, "status": status,
                            "reason": "Controlled sibling fixture returned no verifiable matching vacancy.", "job": None, "fit": None})
            continue
        if scenario == "missing_fit_sibling" and index == 1:
            fit = synthetic_fit(request_id, source_url)
            del fit["components"]["qualification"]
        elif scenario == "scored_fit" or (scenario == "primary_unknown_scored" and index == 1):
            fit = synthetic_fit(request_id, source_url, unknown=False)
        else:
            fit = synthetic_fit(request_id, source_url)
        results.append({"request_id": request_id, "source_url": source_url, "status": "found", "reason": None,
                        "job": synthetic_job(request_id, source_url, index, run_id), "fit": fit})
    return json.dumps({"schema_version": "job-url-memory-fit-batch-v1", "batch_id": batch_id,
                       "assessment_as_of": assessment_as_of, "results": results}, separators=(",", ":"))


def make_insufficient_memory_fit_response(batch: dict) -> str:
    items = batch.get("items") if isinstance(batch.get("items"), list) else []
    jobs = []
    for item in items:
        if not isinstance(item, dict):
            continue
        jobs.append({
            "job_id": item.get("job_id"), "listing_url": item.get("listing_url"),
            "status": "insufficient_memory", "memory_status": "unknown",
            "components": {name: {"score": None, "state": "insufficient_memory",
                                   "explanation": "No candidate Memory was available in this isolated synthetic test."}
                           for name in ("technical", "evidence", "seniority", "domain", "role_type", "qualification")},
            "eligibility": {"state": "needs_confirmation", "explanation": "No real candidate eligibility information was used."},
            "summary": "Controlled local response for pipeline verification; this is not a candidate assessment.",
            "strengths": [], "limitations": ["Synthetic test response; real ChatGPT Memory was not accessed."],
        })
    if not jobs or any(not isinstance(job.get("job_id"), str) or not isinstance(job.get("listing_url"), str) for job in jobs):
        raise RuntimeError("The saved reanalysis batch did not contain exact synthetic job identities.")
    response = {"schema_version": "job-fit-memory-response-v1", "request_id": batch.get("request_id"),
                "batch_id": batch.get("id"), "rubric_version": "job-fit-memory-rubric-v1",
                "assessment_as_of": batch.get("assessment_as_of"), "jobs": jobs}
    return json.dumps(response, separators=(",", ":"), ensure_ascii=False)


def save_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def wait_text(observer: desktop.CDPObserver, text: str, description: str, timeout: float = 35) -> None:
    m03.wait_body(observer, text, description, timeout)


def wait_jobs_workspace(observer: desktop.CDPObserver, timeout: float = 35) -> dict:
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            last = observer.evaluate("JSON.stringify({pathname:location.pathname,heading:document.querySelector('h1')?.innerText.trim()||'',poolHeading:document.querySelector('.jobPoolHeader h2')?.innerText.trim()||'',rowCount:document.querySelectorAll('.jobPoolTable tbody tr').length})")
            if isinstance(last, dict) and last.get("pathname") == "/jobs" and last.get("heading") == "Jobs" and last.get("poolHeading") == "Job pool":
                return last
        except Exception:
            pass
        time.sleep(0.2)
    raise TimeoutError("The visible Jobs workspace did not reach its exact route and headings; last state=" + json.dumps(last, sort_keys=True))


def wait_visible_form_error(observer: desktop.CDPObserver, timeout: float = 20) -> dict:
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = observer.evaluate("JSON.stringify({error:document.querySelector('.formError')?.innerText?.trim()||'',"
                                  "inputCount:document.querySelectorAll('.urlInspectionField input').length,"
                                  "pageHeading:document.querySelector('h1')?.innerText?.trim()||''})")
        if isinstance(last, dict) and last.get("error"):
            return last
        time.sleep(0.1)
    raise TimeoutError("No visible oversized-input form error appeared: " + json.dumps(last, ensure_ascii=False))


def visible_job_checkbox(observer: desktop.CDPObserver, job_id: str, timeout: float = 25) -> dict:
    expression = "JSON.stringify((()=>{const path='/jobs/'+" + json.dumps(job_id) + ";"
    expression += "const link=[...document.querySelectorAll('a.jobPoolRole')].find(e=>e.getAttribute('href')?.split('?')[0]===path);"
    expression += "const row=link?.closest('tr');const e=row?.querySelector('input[type=checkbox]');const parts=[];"
    expression += "for(let n=e;n&&n.nodeType===1;n=n.parentElement){let part=n.localName;"
    expression += "const siblings=n.parentElement?[...n.parentElement.children].filter(x=>x.localName===n.localName):[];"
    expression += "if(siblings.length>1)part+=':nth-of-type('+(siblings.indexOf(n)+1)+')';parts.unshift(part);"
    expression += "if(n===document.documentElement)break;}return {exists:!!e,checked:e?.checked===true,disabled:e?.disabled===true,"
    expression += "selector:parts.join(' > '),rowCount:document.querySelectorAll('.jobPoolTable tbody tr').length,"
    expression += "roleLinkCount:document.querySelectorAll('a.jobPoolRole').length}})())"
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = observer.evaluate(expression)
        if isinstance(last, dict) and last.get("exists"):
            return last
        time.sleep(0.25)
    return last if isinstance(last, dict) else {"exists": False}


def native_fill_redacted(observer: desktop.CDPObserver, hwnd: int, pid: int, selector: str, value: str) -> dict:
    action = desktop.native_replace_value(observer, hwnd, pid, selector, value)
    return {"selector": selector, "typedCharacters": len(value), "nativeClick": action.get("click"),
            "activeElementReadback": True, "valueReadbackRecorded": False}


def read_local_batch_id(observer: desktop.CDPObserver) -> str:
    value = observer.evaluate("JSON.stringify(localStorage.getItem('jobhunt:last-job-url-import-batch:v1'))")
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f-]{36}", value, re.I):
        raise RuntimeError("The visible UI did not preserve a valid submitted batch id in its isolated profile.")
    return value


def build_live_bridge_extension(workspace: Path, app_url: str, api_url: str) -> tuple[Path, dict]:
    extension_root = workspace / "apps/chatgpt-bridge-extension"
    node = shutil.which("node.exe") or shutil.which("node")
    if not node:
        raise FileNotFoundError("Node.js is required to build the isolated M04 Bridge extension.")
    environment = desktop.safe_environment(workspace)
    environment.update({
        "JOB_HUNT_ORIGIN": app_url,
        "JOB_HUNT_BRIDGE_ENDPOINT": api_url.rstrip("/") + "/functions/v1/chatgpt-bridge",
    })
    result = subprocess.run([node, "build.mjs"], cwd=extension_root, env=environment,
                            capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        raise RuntimeError("The local Bridge extension build failed (exit " + str(result.returncode) + ").")
    distribution = extension_root / "dist"
    manifest = json.loads((distribution / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("version") != json.loads((extension_root / "package.json").read_text(encoding="utf-8")).get("version"):
        raise RuntimeError("The isolated extension manifest version does not match its checked-out source.")
    return distribution, {"version": manifest.get("version"), "sourcePath": "apps/chatgpt-bridge-extension", "builtForLoopback": True}


def launch_chrome_with_extension(repo: Path, run_root: Path, profile: Path, app_url: str,
                                extension_path: Path, evidence: Path):
    chrome_path = desktop.find_chrome()
    profile_root = profile.resolve()
    if not profile_root.is_relative_to(run_root.resolve()):
        raise RuntimeError("Refusing to launch the live Bridge check outside its test-owned Chrome profile.")
    (profile_root / "DevToolsActivePort").unlink(missing_ok=True)
    chrome = subprocess.Popen([
        str(chrome_path), f"--user-data-dir={profile}", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
        "--remote-allow-origins=http://localhost", f"--disable-extensions-except={extension_path}",
        f"--load-extension={extension_path}", "--no-first-run", "--no-default-browser-check", "--disable-sync",
        "--disable-save-password-bubble", "--disable-background-networking", "--disable-component-update",
        "--disable-default-apps", "--new-window", app_url + "/login?next=%2Fonboarding",
    ], cwd=run_root, env=desktop.safe_environment(run_root),
       stdout=(evidence / f"chrome-live-bridge-{uuid.uuid4().hex[:6]}.log").open("wb"),
       stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
    pids = desktop.process_tree_pids(chrome)
    observer = None
    try:
        port, _ = m03.cdp_connect(profile, chrome)
        observer = desktop.CDPObserver(port, chrome)
        observer.connect_page(app_url)
        deadline = time.monotonic() + 30
        hwnd = None
        while time.monotonic() < deadline:
            if chrome.poll() is not None:
                raise RuntimeError("The test-owned Chrome exited while loading the Bridge extension.")
            windows = desktop.enumerate_windows_for_pid(chrome.pid)
            candidate = next((item for item in windows if item[1]), None)
            if candidate:
                hwnd = candidate[0]
                break
            time.sleep(0.2)
        if hwnd is None:
            raise TimeoutError("No visible native Chrome window owned by the live Bridge test appeared.")
        window = desktop.focus_and_maximize(hwnd, chrome.pid)
        return chrome, pids, observer, hwnd, window, port
    except Exception:
        m03.stop_chrome(chrome, pids, observer)
        raise


def cdp_targets(port: int) -> list[dict]:
    request = urllib.request.Request(f"http://127.0.0.1:{port}/json/list", headers={"Origin": "http://localhost"})
    with urllib.request.urlopen(request, timeout=5) as response:
        value = json.loads(response.read())
    return value if isinstance(value, list) else []


def open_cdp_target(port: int, url: str) -> dict:
    endpoint = f"http://127.0.0.1:{port}/json/new?{urllib.parse.quote(url, safe=':/?=&') }"
    request = urllib.request.Request(endpoint, method="PUT", headers={"Origin": "http://localhost"})
    with urllib.request.urlopen(request, timeout=8) as response:
        target = json.loads(response.read())
    if not isinstance(target, dict) or target.get("url") != url:
        raise RuntimeError("The test-owned browser did not create the requested isolated tab.")
    return target


def extension_runtime_id(port: int, chrome: subprocess.Popen, timeout: float = 20) -> str:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if chrome.poll() is not None:
            raise RuntimeError("Test-owned Chrome exited before the unpacked Bridge extension started.")
        for target in cdp_targets(port):
            match = re.match(r"^chrome-extension://([a-p]{32})/", str(target.get("url", "")))
            if match and target.get("type") in ("service_worker", "background_page"):
                return match.group(1)
        time.sleep(0.25)
    raise TimeoutError("The test-owned Chrome did not start the unpacked JobHuntAI extension worker.")


def native_fill_css(observer: desktop.CDPObserver, hwnd: int, pid: int, selector: str, value: str) -> dict:
    item = observer.evaluate(
        "JSON.stringify((()=>{const e=document.querySelector(" + json.dumps(selector) + ");if(!e)return null;"
        "const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,disabled:e.disabled===true}})())"
    )
    if not isinstance(item, dict) or item.get("disabled"):
        raise RuntimeError("The expected real extension input is missing or disabled.")
    click = desktop.native_click_observed_rect(observer, hwnd, pid, item, selector)
    focused = observer.evaluate("document.activeElement===document.querySelector(" + json.dumps(selector) + ")")
    if focused is not True:
        raise RuntimeError("Native input did not focus the expected extension field.")
    desktop.press_key(0x41, ctrl=True)
    desktop.press_key(0x08)
    desktop.type_unicode(value)
    deadline = time.monotonic() + 5
    last = None
    while time.monotonic() < deadline:
        last = observer.evaluate("document.querySelector(" + json.dumps(selector) + ")?.value||''")
        if last == value:
            break
        time.sleep(0.1)
    if last != value:
        raise RuntimeError("Native input text did not persist in the extension UI.")
    return {"selector": selector, "typedCharacters": len(value), "nativeClick": click,
            "focusReadback": True, "valueReadbackRecorded": False}


def native_click_css(observer: desktop.CDPObserver, hwnd: int, pid: int, selector: str) -> dict:
    item = observer.evaluate(
        "JSON.stringify((()=>{const e=document.querySelector(" + json.dumps(selector) + ");if(!e)return null;"
        "const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,disabled:e.disabled===true}})())"
    )
    if not isinstance(item, dict) or item.get("disabled"):
        raise RuntimeError("The expected visible extension action was missing or disabled.")
    return desktop.native_click_observed_rect(observer, hwnd, pid, item, selector)


def extension_message(observer: desktop.CDPObserver, payload: dict) -> dict:
    expression = "chrome.runtime.sendMessage(" + json.dumps(payload, separators=(",", ":")) + ").then(value=>JSON.stringify(value))"
    result = observer.evaluate(expression)
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except json.JSONDecodeError:
            pass
    return result if isinstance(result, dict) else {"ok": False, "reason": "The extension returned no structured status."}


def run_real_bridge_check(repo: Path, run_root: Path, evidence: Path, app_url: str, api_url: str,
                          container: str, observer: desktop.CDPObserver, hwnd: int, chrome: subprocess.Popen,
                          chrome_pid: int, cdp_port: int, display: tuple[int, int], report: dict) -> dict:
    pairing = app_data(observer, "/api/chatgpt-bridge/pairing", "POST", {})
    pairing_code = pairing.get("data", {}).get("pairing_code") if pairing.get("status") == 200 else None
    if not isinstance(pairing_code, str) or not pairing_code:
        raise RuntimeError("The authenticated local app did not create a one-time Bridge pairing code.")

    extension_id = extension_runtime_id(cdp_port, chrome)
    popup_url = f"chrome-extension://{extension_id}/popup.html"
    open_cdp_target(cdp_port, popup_url)
    extension_observer = desktop.CDPObserver(cdp_port, chrome)
    extension_observer.connect_page(popup_url)
    desktop.focus_and_maximize(hwnd, chrome_pid)
    api_endpoint = api_url.rstrip("/") + "/functions/v1/chatgpt-bridge"
    native_fill_css(extension_observer, hwnd, chrome_pid, "#backendUrl", api_endpoint)
    native_fill_css(extension_observer, hwnd, chrome_pid, "#pairingCode", pairing_code)
    pair_click = native_click_css(extension_observer, hwnd, chrome_pid, "#pairButton")
    pairing_deadline = time.monotonic() + 25
    pair_status = ""
    while time.monotonic() < pairing_deadline:
        pair_status = extension_observer.evaluate("document.querySelector('#statusText')?.innerText||''") or ""
        if pair_status.startswith("Paired"):
            break
        if pair_status.startswith("Pairing failed") or "error" in pair_status.lower():
            raise RuntimeError("The real extension UI could not pair to the local Bridge endpoint.")
        time.sleep(0.2)
    if not pair_status.startswith("Paired"):
        raise TimeoutError("The real extension UI did not confirm local Bridge pairing.")
    extension_status = extension_message(extension_observer, {"type": "GET_EXTENSION_STATUS"})
    if extension_status.get("ok") is not True or extension_status.get("paired") is not True \
            or extension_status.get("backendUrl", "").rstrip("/") != api_endpoint:
        raise RuntimeError("The paired extension status did not read back the exact local Bridge endpoint.")

    chatgpt_target = open_cdp_target(cdp_port, "https://chatgpt.com/")
    chat_observer = desktop.CDPObserver(cdp_port, chrome)
    chat_observer.connect_page("https://chatgpt.com/")
    report["milestones"].append({"name": "isolated_chatgpt_tab_opened", "timeUtc": utc_now(), "tabCreated": True,
                                  "extensionVersion": extension_status.get("extensionVersion"),
                                  "localBridgeEndpointVerified": True})
    print("M04_LIVE_BRIDGE_ACTION_REQUIRED: sign in to ChatGPT in the test-owned Chrome window, then open the existing authorized JobHuntAI Project conversation. Do not send a message yourself.", flush=True)

    bind_deadline = time.monotonic() + 900
    bind_result = None
    seen_project_conversation = False
    while time.monotonic() < bind_deadline:
        if chrome.poll() is not None:
            raise RuntimeError("Test-owned Chrome exited while waiting for the authorized JobHuntAI Project conversation.")
        try:
            current_url = chat_observer.evaluate("location.href")
        except Exception:
            time.sleep(1)
            continue
        if isinstance(current_url, str) and "chatgpt.com/" in current_url and re.search(r"/c/[^/?#]+", current_url):
            seen_project_conversation = True
            desktop.focus_and_maximize(hwnd, chrome_pid)
            bind_result = extension_message(extension_observer, {"type": "BIND_CURRENT_CONVERSATION", "workflowKey": "job.inspect_url"})
            if bind_result.get("ok") is True:
                break
        time.sleep(1)
    if not bind_result or bind_result.get("ok") is not True:
        raise TimeoutError("The extension did not verify an existing JobHuntAI Project conversation. No URL-import dispatch was created.")
    extension_status = extension_message(extension_observer, {"type": "GET_EXTENSION_STATUS"})
    slots = extension_status.get("conversationSlots") if isinstance(extension_status.get("conversationSlots"), list) else []
    url_slot = next((slot for slot in slots if isinstance(slot, dict) and slot.get("workflowKey") == "job.inspect_url"), None)
    if not url_slot or url_slot.get("projectVerified") is not True or url_slot.get("projectName") != "JobHuntAI" \
            or extension_status.get("automaticSendEnabled") is not True:
        raise RuntimeError("The extension did not persist the verified JobHuntAI inspection-conversation binding.")
    extension_observer.close()
    chat_observer.close()

    testing = app_data(observer, "/api/diagnostics/testing-mode")
    if testing.get("status") != 200 or testing.get("data", {}).get("enabled") is not True:
        raise RuntimeError("Testing Mode was not enabled immediately before the real Bridge check.")
    observer.command("Page.bringToFront")
    desktop.focus_and_maximize(hwnd, chrome_pid)
    desktop.native_navigate(observer, hwnd, chrome_pid, app_url + "/jobs/add")
    wait_text(observer, "Import from job listing URLs", "visible live Bridge URL form")
    fixture_commit = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    if not re.fullmatch(r"[0-9a-f]{40}", fixture_commit):
        raise RuntimeError("The public synthetic fixture commit identity was unavailable.")
    fixture_root = f"https://raw.githubusercontent.com/YashSooriya/job-hunt-console/{fixture_commit}/test-fixtures/m04-synthetic-roles"
    source_urls = [fixture_root + "/data-analyst.html", fixture_root + "/scientific-software-engineer.html"]
    batch_id, native_submit = submit_live_visible_batch(observer, hwnd, chrome_pid, evidence, display, source_urls,
                                                         "m04-live-bridge-form-before-send.png")
    before = database_batch(container, batch_id)
    if before.get("inspectionCount") != 2 or before.get("distinctDispatchCount") != 1 \
            or before.get("distinctJobCount") != 0 or any(item.get("testingMode") is not True for item in before.get("items", [])):
        raise RuntimeError("The live visible batch did not create exactly one Testing Mode dispatch for its two public fixtures.")
    report["workflow"].append({"name": "live_two_url_batch_queued_to_real_extension", "result": "PASS",
                                "evidenceLevel": "native desktop UI + real local extension + local Supabase/Edge + authorized ChatGPT conversation",
                                "batchId": batch_id, "dispatchCountBeforeResponse": before.get("distinctDispatchCount"),
                                "inspectionCount": before.get("inspectionCount"), "testingModePersisted": True,
                                "fixtureCommit": fixture_commit,
                                "fixtureUrls": source_urls,
                                "nativeSubmitClick": native_submit.get("nativeSubmitClick"),
                                "extensionPairingNativeClick": pair_click,
                                "projectConversationUrlRecorded": False,
                                "candidateProfileOrMemorySent": False})
    report["screenshots"].append(native_submit["screenshot"])

    deadline = time.monotonic() + 240
    final_database = before
    while time.monotonic() < deadline:
        final_database = database_batch(container, batch_id)
        rows = final_database.get("items", [])
        if rows and all(row.get("dispatchState") in ("completed", "failed", "cancelled", "expired")
                        for row in rows):
            break
        time.sleep(1)
    else:
        raise TimeoutError("The real ChatGPT Bridge dispatch did not reach a terminal state within four minutes; it was not resent.")

    response_completed = final_database.get("distinctDispatchCount") == 1 \
        and all(row.get("dispatchState") == "completed" and row.get("provenanceRecorded") == "true"
                and row.get("matchHash") is True for row in final_database.get("items", []))
    batch_result = batch_state(observer, batch_id)
    summary = summarize_batch(batch_result)
    statuses = [item.get("fitStatus") for item in summary.get("items", [])]
    fit_safe = all(status in (None, "insufficient_memory") for status in statuses)
    if response_completed:
        observer.command("Page.bringToFront")
        desktop.focus_and_maximize(hwnd, chrome_pid)
        desktop.native_navigate(observer, hwnd, chrome_pid, app_url + "/jobs/add")
        wait_text(observer, "Import progress", "local import results after real Bridge response")
        summary = summarize_batch(batch_state(observer, batch_id))
        report["screenshots"].append(screenshot(evidence, "m04-live-bridge-result-local-app.png", hwnd, chrome_pid, display))
    else:
        report["workflow"].append({"name": "real_chatgpt_response_capture", "result": "FAIL",
                                    "evidenceLevel": "local database state only", "database": final_database})
        raise RuntimeError("The single authorized ChatGPT response was not durably captured with exact response provenance.")
    if not fit_safe:
        raise RuntimeError("The real response attempted to score candidate fit despite Testing Mode's unknown-Memory instruction.")
    report["workflow"].append({"name": "real_chatgpt_response_captured_once", "result": "PASS",
                                "evidenceLevel": "genuine extension delivery and exact ChatGPT response persisted through local Supabase/Edge",
                                "realChatGptCompletion": True, "externalMessageCount": 1,
                                "distinctDispatchCount": final_database.get("distinctDispatchCount"),
                                "responseProvenanceRecorded": True, "responseHashMatchedEveryEntry": True,
                                "perEntryStates": [{"status": item.get("status"), "fitStatus": item.get("fitStatus"),
                                                    "fitAnalysisPersisted": bool(item.get("fitAnalysisId"))}
                                                   for item in summary.get("items", [])],
                                "unknownMemoryOnly": True, "candidateProfileOrMemoryReturned": False,
                                "batch": summary})
    report["backend"].update({"realChatGptCompletion": True, "controlledProviderOnly": False,
                              "productionTouched": False, "paidResourcesCreated": False})
    return {"result": "PASS_WITH_LIMITATIONS", "externalMessageCount": 1, "batchId": batch_id,
            "responseCompleted": True, "database": final_database, "batch": summary,
            "sawProjectConversation": seen_project_conversation}


def bridge_request(api_url: str, device_id: str, device_token: str, extension_version: str,
                   capabilities: dict, operation: str, payload: dict) -> tuple[int, dict]:
    headers = {"content-type": "application/json", "x-chatgpt-bridge-device-id": device_id,
               "x-chatgpt-bridge-device-token": device_token, "x-chatgpt-bridge-version": extension_version}
    body = {"op": operation, "protocol": "v2", "extensionVersion": extension_version,
            "capabilities": capabilities, **payload}
    request = urllib.request.Request(api_url.rstrip("/") + "/functions/v1/chatgpt-bridge",
                                     data=json.dumps(body, separators=(",", ":")).encode("utf-8"),
                                     headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=35) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            return error.code, json.loads(raw) if raw else {}
        except Exception:
            return error.code, {}


def controlled_complete(api_url: str, device_id: str, device_token: str, version: str,
                        capabilities: dict, scenario: str, run_id: str, expected_dispatch_id: str | None = None,
                        response_text_override: str | None = None) -> dict:
    poll = m03.bridge_test_call(api_url, device_id, device_token, version, capabilities, "device_poll_v2")
    request = poll.get("request") if isinstance(poll.get("request"), dict) else {}
    request_id = request.get("id")
    lease = request.get("lease_token")
    attempt = request.get("delivery_attempt_id")
    instruction = request.get("instruction")
    if not all(isinstance(value, str) and value for value in (request_id, lease, attempt, instruction)):
        raise RuntimeError("The local Website Bridge did not return one bounded test-owned dispatch lease.")
    if expected_dispatch_id and request_id != expected_dispatch_id:
        raise RuntimeError("The controlled provider received a different dispatch than the visible batch created.")
    conversation = "https://chatgpt.com/c/m04-local-synthetic-" + run_id[:18]
    user_fingerprint = hashlib.sha256(instruction.encode("utf-8")).hexdigest()
    user_turn_message_id = str(uuid.uuid4())
    turn_anchor = {"conversationUrl": conversation, "turnCount": 0,
                   "lastUserFingerprint": hashlib.sha256(b"m04-before-user-turn").hexdigest(),
                   "lastAssistantFingerprint": hashlib.sha256(b"m04-before-assistant-turn").hexdigest(),
                   "lastUserMessageId": None, "lastAssistantMessageId": None}
    common = {"requestId": request_id, "leaseToken": lease, "deliveryAttemptId": attempt}
    m03.bridge_test_call(api_url, device_id, device_token, version, capabilities, "prepare_dispatch_v2",
                         {**common, "stage": "opening_chatgpt", "progress": {"stage": "opening_chatgpt", "testProvider": "controlled_local"}})
    m03.bridge_test_call(api_url, device_id, device_token, version, capabilities, "prepare_dispatch_v2",
                         {**common, "stage": "composer_ready", "progress": {"stage": "composer_ready", "testProvider": "controlled_local"}})
    authorized = m03.bridge_test_call(api_url, device_id, device_token, version, capabilities, "authorize_send",
                                      {**common, "turnAnchor": turn_anchor, "userTurnFingerprint": user_fingerprint,
                                       "userTurnMessageId": user_turn_message_id})
    if authorized.get("may_send") is not True:
        raise RuntimeError("The local controlled provider did not obtain the exact dispatch send authorization.")
    m03.bridge_test_call(api_url, device_id, device_token, version, capabilities, "confirm_sent", common)
    response_text = response_text_override if response_text_override is not None else make_combined_response(instruction, scenario, run_id)
    assistant_id = str(uuid.uuid4())
    provenance = {"conversationUrl": conversation, "userTurnFingerprint": user_fingerprint,
                  "userTurnMessageId": user_turn_message_id, "assistantMessageId": assistant_id,
                  "assistantFingerprint": hashlib.sha256(response_text.encode("utf-8")).hexdigest(),
                  "artifactKey": None, "source": "assistant_turn", "generationFinished": True}
    payload = {**common, "responseText": response_text, "responseProvenance": provenance}
    status, result = bridge_request(api_url, device_id, device_token, version, capabilities, "complete_dispatch_v3", payload)
    accepted_status = status == 200 and result.get("ok") is True
    expected_parser_failure = scenario == "malformed_json" and status == 503
    if not accepted_status and not expected_parser_failure:
        raise RuntimeError("The controlled local Bridge did not durably capture its synthetic response (HTTP " + str(status) + ").")
    response_hash = hashlib.sha256(response_text.strip().encode("utf-8")).hexdigest()
    duplicate_callback = None
    if scenario != "malformed_json":
        duplicate_status, duplicate_result = bridge_request(api_url, device_id, device_token, version, capabilities,
                                                             "complete_dispatch_v3", payload)
        duplicate_callback = {"httpStatus": duplicate_status, "accepted": duplicate_result.get("ok") is True,
                              "responseHashStable": duplicate_result.get("response_hash") == response_hash}
    return {"dispatchId": request_id, "provider": "controlled_local_synthetic_response",
            "realChatGptCompletion": False, "externalMessageSent": False,
            "responseHash": response_hash, "captured": accepted_status or expected_parser_failure,
            "expectedEdgeParserRejection": expected_parser_failure, "duplicateCallback": duplicate_callback}


def submit_visible_batch(observer: desktop.CDPObserver, hwnd: int, pid: int, evidence: Path,
                         display: tuple[int, int], source_urls: list[str], screenshot_name: str) -> tuple[str, dict]:
    for index, url in enumerate(source_urls):
        if index:
            native_click_text(observer, hwnd, pid, "Add another job URL")
            deadline = time.monotonic() + 4
            while time.monotonic() < deadline:
                if observer.evaluate(f"!!document.querySelector('input[name=sourceUrl-{index + 1}]')") is True:
                    break
                time.sleep(0.08)
            else:
                raise TimeoutError("Native Add another job URL did not add the expected visible input.")
        field_input(observer, hwnd, pid, f"input[name=sourceUrl-{index + 1}]", url)
    button = f"Inspect {len(source_urls)} listings with ChatGPT" if len(source_urls) > 1 else "Inspect with ChatGPT"
    click = native_click_text(observer, hwnd, pid, button)
    wait_text(observer, "Import progress", "visible URL import batch progress")
    batch_id = read_local_batch_id(observer)
    duplicate_notice = observer.evaluate("document.querySelector('.urlImportNotice')?.innerText?.trim()||''")
    screen = screenshot(evidence, screenshot_name, hwnd, pid, display)
    return batch_id, {"nativeSubmitClick": click, "screenshot": screen,
                      "enteredUrlCount": len(source_urls), "fixtureUrlLengths": [len(value) for value in source_urls],
                      "visibleDuplicateNotice": duplicate_notice}


def submit_live_visible_batch(observer: desktop.CDPObserver, hwnd: int, pid: int, evidence: Path,
                              display: tuple[int, int], source_urls: list[str], screenshot_name: str) -> tuple[str, dict]:
    for index, url in enumerate(source_urls):
        if index:
            native_click_text(observer, hwnd, pid, "Add another job URL")
            deadline = time.monotonic() + 4
            while time.monotonic() < deadline:
                if observer.evaluate(f"!!document.querySelector('input[name=sourceUrl-{index + 1}]')") is True:
                    break
                time.sleep(0.08)
            else:
                raise TimeoutError("Native Add another job URL did not add the second visible input.")
        field_input(observer, hwnd, pid, f"input[name=sourceUrl-{index + 1}]", url)
    form_screenshot = screenshot(evidence, screenshot_name, hwnd, pid, display)
    button = f"Inspect {len(source_urls)} listings with ChatGPT" if len(source_urls) > 1 else "Inspect with ChatGPT"
    click = native_click_text(observer, hwnd, pid, button)
    wait_text(observer, "Import progress", "visible live URL import batch progress")
    batch_id = read_local_batch_id(observer)
    return batch_id, {"nativeSubmitClick": click, "screenshot": form_screenshot,
                      "enteredUrlCount": len(source_urls), "fixtureUrlLengths": [len(value) for value in source_urls],
                      "visibleDuplicateNotice": observer.evaluate("document.querySelector('.urlImportNotice')?.innerText?.trim()||''")}


def read_user_counts(container: str, user_id: str) -> dict:
    if not re.fullmatch(r"[0-9a-f-]{36}", user_id, re.I):
        raise RuntimeError("Refusing the scoped synthetic-account database count query.")
    sql = f"""
      select json_build_object(
        'inspections',(select count(*) from public.job_url_inspection_requests where user_id='{user_id}'::uuid),
        'urlDispatches',(select count(*) from public.chatgpt_dispatch_requests where user_id='{user_id}'::uuid and action_type='job.inspect_url'),
        'jobs',(select count(*) from public.jobs where user_id='{user_id}'::uuid),
        'fitBatches',(select count(*) from public.job_fit_memory_v4_batches where user_id='{user_id}'::uuid)
      )::text;
    """
    return m03.psql_json(container, sql)


def run(args) -> dict:
    if os.name != "nt":
        raise SystemExit("This M04 native-input runner only runs on Windows.")
    repo = Path(args.source_root).resolve()
    run_id = uuid.uuid4().hex
    temp_root = Path(os.environ.get("TEMP", str(Path.home() / "AppData/Local/Temp"))).resolve()
    run_root = temp_root / f"JobHuntAI-M04-Local-UI-{run_id}"
    evidence_parent = Path(args.evidence_dir).resolve() if args.evidence_dir else temp_root / "JobHuntAI-M04-Evidence"
    evidence = evidence_parent / run_id
    evidence.mkdir(parents=True, exist_ok=False)
    run_root.mkdir(parents=True, exist_ok=False)
    workspace = run_root / "workspace"
    profile = run_root / "chrome-profile"
    api_url = os.environ["JOBHUNT_M02_SUPABASE_URL"].rstrip("/")
    publishable_key = os.environ["JOBHUNT_M02_PUBLISHABLE_KEY"]
    service_key = os.environ["JOBHUNT_M02_SERVICE_KEY"]
    container = os.environ["JOBHUNT_M02_DB_CONTAINER"]
    report = {
        "schemaVersion": "1.0.0", "runId": run_id, "startedAtUtc": utc_now(),
        "repository": {"head": subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip(),
                       "branch": subprocess.run(["git", "-C", str(repo), "branch", "--show-current"], capture_output=True, text=True, check=True).stdout.strip()},
        "testLevel": "genuine_windows_desktop_ui_with_win32_input_and_local_supabase_controlled_bridge",
        "commands": ["powershell -ExecutionPolicy Bypass -File scripts/run-m04-local-supabase-ui.ps1",
                     "Win32 SendInput mouse/keyboard; read-only loopback CDP observation; local Supabase Edge Bridge; synthetic provider"],
        "application": {"type": "Next.js web application in test-owned Chrome; no packaged Windows executable is defined by this repository",
                        "version": json.loads((repo / "apps/web/package.json").read_text(encoding="utf-8")).get("version"),
                        "frameworkVersion": json.loads((repo / "node_modules/next/package.json").read_text(encoding="utf-8")).get("version"),
                        "chromeExecutable": None, "chromeVersion": None, "chromePid": None, "serverPid": None,
                        "workspace": f"%TEMP%\\JobHuntAI-M04-Local-UI-{run_id}", "isolatedProfile": True},
        "backend": {"kind": "local Supabase in WSL2 Podman with local Edge Function", "apiOrigin": "127.0.0.1",
                    "productionTouched": False, "paidResourcesCreated": False, "realChatGptCompletion": False,
                    "controlledProviderOnly": True},
        "environment": {"python": sys.version.split()[0], "dpiAwareness": None, "primaryDisplay": None},
        "workflow": [], "screenshots": [], "milestones": [],
        "cleanup": {"chromeExited": False, "serverExited": False, "syntheticAccountsRemoved": False,
                    "temporaryWorkspaceRemoved": False, "ownedProcessPids": {}},
        "limitations": [], "result": "RUNNING", "error": None,
        "evidenceDirectory": f"<evidence>/{run_id}",
    }
    server = chrome = observer = None
    server_pids: list[int] = []
    chrome_pids: list[int] = []
    accounts: list[dict] = []
    device_id = device_token = None
    hwnd = None
    try:
        report["environment"]["dpiAwareness"] = desktop.enable_per_monitor_dpi_awareness()
        account_a, account_b = onboarding.seed_accounts(argparse.Namespace(), run_id)
        accounts = [account_a, account_b]
        copied, packages, dependency_files, supplemental = desktop.copy_isolated_workspace(repo, workspace)
        report["sourceCopy"] = {"trackedFiles": copied, "localPackages": packages,
                                "supplementalWorktreeFiles": supplemental,
                                "dependencyFilesHardlinked": dependency_files["hardlinked"],
                                "dependencyFallbackCopies": dependency_files["copiedFallback"],
                                "environmentFilesCopied": False, "repositoryDataCopied": False}
        env = desktop.safe_environment(run_root)
        env.update({"NEXT_PUBLIC_SUPABASE_URL": api_url, "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY": publishable_key,
                    "JOBHUNT_DATA_MODE": "supabase", "JOBHUNT_TEST_AUTH": "true", "NEXT_TELEMETRY_DISABLED": "1"})
        node = shutil.which("node.exe") or shutil.which("node")
        if not node:
            raise FileNotFoundError("Node.js is required for the local M04 UI.")
        port = desktop.free_loopback_port()
        app_url = f"http://127.0.0.1:{port}"
        next_cli = workspace / "apps/web/node_modules/next/dist/bin/next"
        server_log = (evidence / "next-dev.log").open("wb")
        server = subprocess.Popen([node, str(next_cli), "dev", "--hostname", "127.0.0.1", "--port", str(port)],
                                  cwd=workspace / "apps/web", env=env, stdout=server_log, stderr=subprocess.STDOUT,
                                  creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
        server_pids = desktop.process_tree_pids(server)
        report["application"].update({"serverPid": server.pid, "origin": app_url})
        report["milestones"].append({"name": "local_ui_server_started", "timeUtc": utc_now(), "pid": server.pid})
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            if server.poll() is not None:
                raise RuntimeError("The isolated Next.js server exited before it became ready.")
            try:
                with urllib.request.urlopen(app_url + "/login?next=%2Fonboarding", timeout=4) as response:
                    html = response.read().decode("utf-8", errors="replace")
                    if response.status == 200 and "Local test email" in html:
                        report["milestones"].append({"name": "loopback_auth_backend_ready", "timeUtc": utc_now(), "httpStatus": 200})
                        break
            except Exception:
                pass
            time.sleep(0.4)
        else:
            raise TimeoutError("The test-owned local auth UI did not become ready on loopback.")

        profile.mkdir(parents=True, exist_ok=False)
        cdp_port = None
        if args.real_bridge_check:
            extension_path, extension_build = build_live_bridge_extension(workspace, app_url, api_url)
            report["testLevel"] = "genuine_windows_desktop_ui_with_real_local_extension_and_authorized_chatgpt_conversation"
            report["backend"].update({"realChatGptCompletion": False, "controlledProviderOnly": False,
                                      "productionTouched": False, "paidResourcesCreated": False})
            chrome, chrome_pids, observer, hwnd, window, cdp_port = launch_chrome_with_extension(
                repo, run_root, profile, app_url, extension_path, evidence)
            report["extensionBuild"] = extension_build
        else:
            chrome, chrome_pids, observer, hwnd, window = m03.launch_chrome(repo, run_root, profile, app_url, evidence)
        chrome_path = desktop.find_chrome()
        report["application"].update({"chromeExecutable": str(chrome_path), "chromeVersion": desktop.file_product_version(chrome_path),
                                      "chromePid": chrome.pid, "window": window})
        report["milestones"].append({"name": "isolated_chrome_maximized", "timeUtc": utc_now(), "pid": chrome.pid,
                                     "nativeWindow": window, "profileIsolated": True})
        display = (desktop.user32.GetSystemMetrics(0), desktop.user32.GetSystemMetrics(1))
        from PIL import ImageGrab
        if ImageGrab.grab().size != display:
            raise RuntimeError("Full-desktop screenshot resolution did not match native display metrics.")
        report["environment"]["primaryDisplay"] = {"width": display[0], "height": display[1]}
        onboarding.switch_user(observer, hwnd, chrome.pid, app_url, account_a, report, "M04 synthetic User A")
        report["milestones"].append({"name": "authenticated_synthetic_workspace", "timeUtc": utc_now(), "accountCount": 2})
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/diagnostics")
        wait_text(observer, "ChatGPT testing mode", "visible Testing Mode controls")
        testing = m03.native_checkbox(observer, hwnd, chrome.pid,
            "section.diagnosticCooldownCard:first-of-type input[type=checkbox]", True)
        wait_text(observer, "Testing mode is on", "visible Testing Mode enabled message")
        mode_state = app_data(observer, "/api/diagnostics/testing-mode")
        if mode_state.get("status") != 200 or mode_state.get("data", {}).get("enabled") is not True:
            raise RuntimeError("Testing Mode was not persisted through the authenticated settings route.")
        report["chromePasswordPrompt"] = dismiss_test_profile_password_prompt(hwnd, chrome.pid, display)
        report["workflow"].append({"name": "testing_mode_enabled_through_native_ui", "result": "PASS", "nativeClick": testing,
                                   "authenticatedReadback": True, "syntheticUserHasNoCandidateProfileData": True})
        report["screenshots"].append(screenshot(evidence, "01-testing-mode-enabled.png", hwnd, chrome.pid, display))

        if args.real_bridge_check:
            bridge_outcome = run_real_bridge_check(repo, run_root, evidence, app_url, api_url, container,
                observer, hwnd, chrome, chrome.pid, cdp_port, display, report)
            report["performance"] = {"realChatGptMessages": bridge_outcome["externalMessageCount"],
                                      "localDispatches": bridge_outcome["database"].get("distinctDispatchCount"),
                                      "responseParsingAndPersistence": "Observed through the local Bridge response hash and owner-scoped M04 batch state."}
            report["result"] = bridge_outcome["result"]
            report["milestones"].append({"name": "real_bridge_check_finished", "timeUtc": utc_now()})
            return report

        bridge_version = json.loads((repo / "apps/chatgpt-bridge-extension/package.json").read_text(encoding="utf-8"))["version"]
        capabilities = {"protocol_version": 2, "build_id": f"{bridge_version}-m04-local-test",
                        "durable_dispatch_v2": True, "send_authorization_v2": True, "result_outbox_v1": True,
                        "result_completion_v3": True, "response_provenance_v3": True,
                        "concurrent_response_capture": 2, "background_focus_policy_v2": True}
        pairing = app_data(observer, "/api/chatgpt-bridge/pairing", "POST", {})
        pairing_code = pairing.get("data", {}).get("pairing_code") if pairing.get("status") == 200 else None
        if not isinstance(pairing_code, str) or not pairing_code:
            raise RuntimeError("The authenticated local app did not create a one-time test Bridge pairing code.")
        paired_status, paired = bridge_request(api_url, "", "", bridge_version, capabilities, "pair_device", {
            "pairingCode": pairing_code, "displayName": "M04 local synthetic provider", "platform": "chrome",
            "extensionVersion": bridge_version})
        if paired_status != 200:
            raise RuntimeError("The local Bridge rejected the one-time synthetic test pairing code.")
        device = paired.get("device") if isinstance(paired.get("device"), dict) else {}
        device_id, device_token = device.get("id"), paired.get("device_token")
        if not isinstance(device_id, str) or not isinstance(device_token, str):
            raise RuntimeError("The local Bridge did not return the synthetic test-device credentials.")
        conversation = "https://chatgpt.com/c/m04-local-synthetic-" + run_id[:18]
        m03.bridge_test_call(api_url, device_id, device_token, bridge_version, capabilities, "device_heartbeat")
        bound = m03.bridge_test_call(api_url, device_id, device_token, bridge_version, capabilities, "bind_conversation", {
            "workflowKey": "job.inspect_url", "conversationUrl": conversation,
            "projectName": "JobHuntAI", "projectVerified": True})
        if bound.get("bound_project_verified") is not True:
            raise RuntimeError("The local synthetic Website Bridge workflow did not bind to its disposable conversation.")
        analysis_conversation = "https://chatgpt.com/c/m04-local-synthetic-fit-" + run_id[:18]
        analysis_bound = m03.bridge_test_call(api_url, device_id, device_token, bridge_version, capabilities, "bind_conversation", {
            "workflowKey": "jobs.analyse_selected", "conversationUrl": analysis_conversation,
            "projectName": "JobHuntAI", "projectVerified": True})
        if analysis_bound.get("bound_project_verified") is not True:
            raise RuntimeError("The local synthetic Website Bridge did not bind the separate existing-job analysis workflow.")
        m03.bridge_test_call(api_url, device_id, device_token, bridge_version, capabilities, "set_automatic_send", {"enabled": True})
        report["workflow"].append({"name": "local_bridge_paired_through_authenticated_ui_route", "result": "CONTROLLED PASS",
                                   "bridgeFunction": "actual local Supabase Edge Function", "boundWorkflows": ["job.inspect_url", "jobs.analyse_selected"],
                                   "distinctSyntheticWorkflowConversations": True,
                                   "deviceCredentialRecorded": False,
                                   "conversationBindingSynthetic": True, "externalChatGptNotOpened": True})

        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/jobs/add")
        wait_text(observer, "Import from job listing URLs", "visible URL import form")
        report["screenshots"].append(screenshot(evidence, "02-url-import-before.png", hwnd, chrome.pid, display))
        primary_urls = ["https://jobs.example.test/m04/data-analyst-a", "https://jobs.example.test/m04/data-analyst-b"]
        batch_id, native_submit = submit_visible_batch(observer, hwnd, chrome.pid, evidence, display, primary_urls,
                                                       "03-primary-batch-queued.png")
        before = database_batch(container, batch_id)
        if before.get("inspectionCount") != 2 or before.get("distinctDispatchCount") != 1:
            raise RuntimeError("The visible two-URL submit did not create exactly one durable Bridge dispatch.")
        report["workflow"].append({"name": "two_valid_urls_one_visible_batch_one_dispatch", "result": "PASS",
                                   "batchId": batch_id, "dispatchCount": before.get("distinctDispatchCount"),
                                   "inspectionCount": before.get("inspectionCount"), **native_submit})

        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/jobs")
        wait_text(observer, "Job pool", "navigate away while the synthetic batch is queued")
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/jobs/add")
        wait_text(observer, "Import progress", "return to the saved URL-import batch")
        desktop.press_key(0x52, ctrl=True)
        wait_text(observer, "Import progress", "native refresh restoring the pending batch")
        replay = app_data(observer, "/api/jobs/inspect", "POST", {"batchId": batch_id, "sourceUrls": primary_urls})
        replay_data = replay.get("data", {}) if isinstance(replay.get("data"), dict) else {}
        after_replay = database_batch(container, batch_id)
        if replay.get("status") != 202 or replay_data.get("idempotentReplay") is not True or after_replay.get("distinctDispatchCount") != 1:
            raise RuntimeError("The same UI request replay was not idempotent or created a second dispatch.")
        report["workflow"].append({"name": "native_refresh_and_exact_request_replay_recovery", "result": "PASS",
                                   "sameBatchRestored": read_local_batch_id(observer) == batch_id,
                                   "idempotentReplay": True, "dispatchCountAfterReplay": after_replay.get("distinctDispatchCount"),
                                   "newBridgeMessageCreated": False})
        report["screenshots"].append(screenshot(evidence, "04-primary-batch-restored-after-refresh.png", hwnd, chrome.pid, display))
        primary_dispatch = after_replay.get("items", [{}])[0].get("dispatchId")
        controlled = controlled_complete(api_url, device_id, device_token, bridge_version, capabilities,
                                         "primary_unknown_scored", run_id, primary_dispatch)
        primary_result = wait_batch(observer, batch_id, timeout=90)
        primary_db = database_batch(container, batch_id)
        statuses = [item.get("fitStatus") for item in primary_db.get("items", [])]
        if primary_db.get("distinctDispatchCount") != 1 or primary_db.get("inspectionCount") != 2 \
                or primary_db.get("distinctJobCount") != 2 or sorted(statuses) != ["assessed", "insufficient_memory"] \
                or any(item.get("matchHash") is not True for item in primary_db.get("items", [])):
            raise RuntimeError("The captured two-listing result failed exact dispatch, identity, fit, or response-hash verification.")
        report["workflow"].append({"name": "same_response_extraction_and_initial_fit_saved", "result": "CONTROLLED PASS",
                                   "evidenceLevel": "real local Supabase/Edge persistence with controlled synthetic provider; not real ChatGPT",
                                   "controlledBridge": controlled, "batch": summarize_batch(primary_result),
                                   "database": primary_db})
        report["screenshots"].append(screenshot(evidence, "05-primary-batch-completed.png", hwnd, chrome.pid, display))

        scored_job = next(item["jobId"] for item in summarize_batch(primary_result)["items"] if item["fitStatus"] == "assessed")
        unknown_job = next(item["jobId"] for item in summarize_batch(primary_result)["items"] if item["fitStatus"] == "insufficient_memory")
        click_scored = desktop.native_click_selector(observer, hwnd, chrome.pid, f'.urlImportResult[href="/jobs/{scored_job}"]')
        wait_text(observer, "Fit components", "scored synthetic job detail")
        scored_view = observer.evaluate("JSON.stringify({heading:document.querySelector('h1')?.innerText||'',hero:document.querySelector('.scoreHero')?.innerText||'',components:[...document.querySelectorAll('.profileGrid .scoreLine')].slice(0,6).map(x=>x.innerText.trim()),weightedText:document.querySelector('.profileGrid .card .formHint')?.innerText||''})")
        scored_text = json.dumps(scored_view, ensure_ascii=False)
        if "5.5" not in scored_text or "30% of the overall fit" not in scored_text or "20% of the overall fit" not in scored_text:
            raise RuntimeError("The visible synthetic fit details did not show the deterministic 55% weighted score and rubric weights.")
        report["workflow"].append({"name": "visible_weighted_fit_breakdown", "result": "CONTROLLED PASS",
                                   "nativeJobLinkClick": click_scored, "syntheticExpectedWeightedPercent": 55,
                                   "displayedScoreIsControlledFixtureNotCandidateFit": True,
                                   "visibleReadback": scored_view})
        report["screenshots"].append(screenshot(evidence, "06-scored-fit-breakdown.png", hwnd, chrome.pid, display))

        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + f"/jobs/{unknown_job}")
        wait_text(observer, "Assessment with Memory unavailable", "unknown Memory fit detail")
        unknown_view = observer.evaluate("JSON.stringify((()=>{const body=document.body.innerText;const score=[...document.querySelectorAll('.scoreHero .scoreBox strong')].map(x=>x.innerText.trim());const fit=[...document.querySelectorAll('.profileGrid.jobAnalysisGrid .scoreList .scoreLine b')].slice(0,6).map(x=>x.innerText.trim());return {url:location.pathname,body,score,fit,hasNoStrengths:body.includes('Candidate Memory was unavailable, so no strengths were assessed'),hasMemoryUnavailable:body.includes('Candidate Memory was unavailable for this assessment'),showsInsufficientMemory:body.toLowerCase().includes('insufficient memory')}})())")
        unknown_text = unknown_view.get("body", "") if isinstance(unknown_view, dict) else ""
        if not unknown_view or unknown_view.get("url") != f"/jobs/{unknown_job}" \
                or "Candidate Memory was unavailable for this assessment" not in unknown_text \
                or not unknown_view.get("hasNoStrengths") or not unknown_view.get("showsInsufficientMemory") \
                or not unknown_view.get("score") or unknown_view["score"][0] not in ("—", "–", "-") \
                or not unknown_view.get("fit") or any(value not in ("—", "–", "-") for value in unknown_view["fit"]):
            debug = {key: unknown_view.get(key) for key in ("url", "score", "fit", "hasNoStrengths", "hasMemoryUnavailable", "showsInsufficientMemory")} if isinstance(unknown_view, dict) else {"readback": str(unknown_view)[:500]}
            raise RuntimeError("The unknown-Memory UI did not withhold scores and candidate strengths clearly: " + json.dumps(debug, ensure_ascii=False))
        report["workflow"].append({"name": "unknown_memory_kept_null_and_not_misrepresented", "result": "CONTROLLED PASS",
                                   "visibleReadback": {key: value for key, value in unknown_view.items() if key != "body"},
                                   "overallScoreNull": True, "allFitComponentsUnknown": True,
                                   "candidateStrengthsNotClaimed": True, "profileOrBackgroundSent": False})
        report["screenshots"].append(screenshot(evidence, "07-unknown-memory-fit.png", hwnd, chrome.pid, display))

        # A valid and unavailable sibling proves that the good extraction survives the bad entry.
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/jobs/add")
        wait_text(observer, "Import from job listing URLs", "visible partial-result test form")
        partial_urls = ["https://jobs.example.test/m04/partial-good", "https://jobs.example.test/m04/partial-unavailable"]
        partial_batch, partial_submit = submit_visible_batch(observer, hwnd, chrome.pid, evidence, display, partial_urls,
                                                             "08-partial-batch-queued.png")
        partial_dispatch = database_batch(container, partial_batch).get("items", [{}])[0].get("dispatchId")
        partial_controlled = controlled_complete(api_url, device_id, device_token, bridge_version, capabilities,
                                                  "valid_invalid_sibling", run_id, partial_dispatch)
        partial_ui = wait_batch(observer, partial_batch, timeout=90)
        partial_db = database_batch(container, partial_batch)
        partial_statuses = {(item.get("status"), item.get("fitStatus")) for item in partial_db.get("items", [])}
        if partial_db.get("inspectionCount") != 2 or partial_db.get("distinctDispatchCount") != 1 \
                or partial_db.get("distinctJobCount") != 1 or ("completed", "insufficient_memory") not in partial_statuses \
                or ("failed", "listing_unavailable") not in partial_statuses:
            raise RuntimeError("The partial-results batch did not preserve one valid listing and classify its unavailable sibling.")
        report["workflow"].append({"name": "valid_and_unavailable_sibling", "result": "CONTROLLED PASS",
                                   "controlledBridge": partial_controlled, "nativeSubmit": partial_submit,
                                   "batch": summarize_batch(partial_ui), "database": partial_db})
        report["screenshots"].append(screenshot(evidence, "09-partial-results.png", hwnd, chrome.pid, display))

        # A mismatched listing sibling must not attach its extraction to another request.
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/jobs/add")
        wait_text(observer, "Import from job listing URLs", "visible wrong-listing test form")
        wrong_urls = ["https://jobs.example.test/m04/wrong-good", "https://jobs.example.test/m04/wrong-sibling"]
        wrong_batch, wrong_submit = submit_visible_batch(observer, hwnd, chrome.pid, evidence, display, wrong_urls,
                                                         "10-wrong-listing-queued.png")
        wrong_dispatch = database_batch(container, wrong_batch).get("items", [{}])[0].get("dispatchId")
        wrong_controlled = controlled_complete(api_url, device_id, device_token, bridge_version, capabilities,
                                                "wrong_listing_sibling", run_id, wrong_dispatch)
        wrong_ui = wait_batch(observer, wrong_batch, timeout=90)
        wrong_db = database_batch(container, wrong_batch)
        if wrong_db.get("distinctJobCount") != 1 or not any(item.get("status") == "failed" and item.get("fitStatus") == "wrong_listing" for item in wrong_db.get("items", [])):
            raise RuntimeError("A wrong-listing result was not rejected independently from its valid sibling.")
        report["workflow"].append({"name": "wrong_listing_sibling_rejected", "result": "CONTROLLED PASS",
                                   "controlledBridge": wrong_controlled, "nativeSubmit": wrong_submit,
                                   "batch": summarize_batch(wrong_ui), "database": wrong_db})
        report["screenshots"].append(screenshot(evidence, "11-wrong-listing-result.png", hwnd, chrome.pid, display))

        # Missing one required fit component keeps extraction but marks the fit invalid.
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/jobs/add")
        wait_text(observer, "Import from job listing URLs", "visible incomplete-fit test form")
        missing_urls = ["https://jobs.example.test/m04/complete-fit", "https://jobs.example.test/m04/missing-fit-component"]
        missing_batch, missing_submit = submit_visible_batch(observer, hwnd, chrome.pid, evidence, display, missing_urls,
                                                             "12-missing-fit-component-queued.png")
        missing_dispatch = database_batch(container, missing_batch).get("items", [{}])[0].get("dispatchId")
        missing_controlled = controlled_complete(api_url, device_id, device_token, bridge_version, capabilities,
                                                   "missing_fit_sibling", run_id, missing_dispatch)
        missing_ui = wait_batch(observer, missing_batch, timeout=90)
        missing_db = database_batch(container, missing_batch)
        if missing_db.get("distinctJobCount") != 2 or not any(item.get("status") == "completed" and item.get("fitStatus") == "invalid_response" for item in missing_db.get("items", [])):
            raise RuntimeError("A missing required fit component did not preserve extraction and mark the fit invalid.")
        report["workflow"].append({"name": "missing_fit_component_withholds_fit", "result": "CONTROLLED PASS",
                                   "controlledBridge": missing_controlled, "nativeSubmit": missing_submit,
                                   "batch": summarize_batch(missing_ui), "database": missing_db})
        report["screenshots"].append(screenshot(evidence, "13-missing-fit-component.png", hwnd, chrome.pid, display))

        # Malformed whole-response capture must become terminal, with no permanent pending fit.
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/jobs/add")
        wait_text(observer, "Import from job listing URLs", "visible malformed-response test form")
        malformed_urls = ["https://jobs.example.test/m04/malformed-whole-response"]
        malformed_batch, malformed_submit = submit_visible_batch(observer, hwnd, chrome.pid, evidence, display, malformed_urls,
                                                                  "14-malformed-response-queued.png")
        malformed_dispatch = database_batch(container, malformed_batch).get("items", [{}])[0].get("dispatchId")
        malformed_controlled = controlled_complete(api_url, device_id, device_token, bridge_version, capabilities,
                                                     "malformed_json", run_id, malformed_dispatch)
        malformed_ui = wait_batch(observer, malformed_batch, timeout=90)
        malformed_db = database_batch(container, malformed_batch)
        malformed_item = malformed_db.get("items", [{}])[0]
        if not malformed_controlled.get("captured") or malformed_db.get("inspectionCount") != 1 \
                or malformed_item.get("fitStatus") != "invalid_response" or malformed_item.get("matchHash") is not True:
            raise RuntimeError("Malformed exact-turn capture did not become a hash-correlated terminal invalid_response result: "
                               + json.dumps({"capture": malformed_controlled, "database": malformed_db}, sort_keys=True))
        report["workflow"].append({"name": "malformed_capture_terminal_fit_state", "result": "CONTROLLED PASS",
                                   "controlledBridge": malformed_controlled, "nativeSubmit": malformed_submit,
                                   "batch": summarize_batch(malformed_ui), "database": malformed_db})
        report["screenshots"].append(screenshot(evidence, "15-malformed-response-terminal.png", hwnd, chrome.pid, display))

        # Duplicate URLs in one visible batch collapse before any durable insert or dispatch.
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/jobs/add")
        wait_text(observer, "Import from job listing URLs", "visible duplicate-URL test form")
        duplicate_base = "https://jobs.example.test/m04/duplicate-url"
        duplicate_batch, duplicate_submit = submit_visible_batch(observer, hwnd, chrome.pid, evidence, display,
            [duplicate_base + "?utm_source=first", duplicate_base + "?utm_source=second"], "16-duplicate-url-queued.png")
        duplicate_before = database_batch(container, duplicate_batch)
        duplicate_controlled = controlled_complete(api_url, device_id, device_token, bridge_version, capabilities,
                                                    "scored_fit", run_id, duplicate_before.get("items", [{}])[0].get("dispatchId"))
        duplicate_ui = wait_batch(observer, duplicate_batch, timeout=90)
        duplicate_after = database_batch(container, duplicate_batch)
        duplicate_notice = duplicate_submit.get("visibleDuplicateNotice", "")
        if duplicate_before.get("inspectionCount") != 1 or duplicate_before.get("distinctDispatchCount") != 1 \
                or "1 duplicate URL was removed" not in duplicate_notice or duplicate_after.get("distinctJobCount") != 1:
            raise RuntimeError("Canonical duplicate URLs were not collapsed to one listing and one dispatch: "
                               + json.dumps({"before": duplicate_before, "notice": duplicate_notice, "after": duplicate_after}, sort_keys=True))
        report["workflow"].append({"name": "canonical_duplicate_urls_collapsed", "result": "CONTROLLED PASS",
                                   "controlledBridge": duplicate_controlled, "nativeSubmit": duplicate_submit,
                                   "duplicateCount": 1, "database": duplicate_after})
        report["screenshots"].append(screenshot(evidence, "17-duplicate-url-result.png", hwnd, chrome.pid, display))

        # Oversized complete prompt is rejected before persistence, leaving native inputs available to edit.
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/jobs/add")
        wait_text(observer, "Import from job listing URLs", "visible oversized-batch test form")
        long_urls = [f"https://jobs.example.test/m04/oversize/{index}?q=" + (chr(97 + index) * 820) for index in range(7)]
        counts_before = read_user_counts(container, account_a["userId"])
        for index, url in enumerate(long_urls):
            if index:
                native_click_text(observer, hwnd, chrome.pid, "Add another job URL")
            field_input(observer, hwnd, chrome.pid, f"input[name=sourceUrl-{index + 1}]", url)
        native_click_text(observer, hwnd, chrome.pid, "Inspect 7 listings with ChatGPT")
        visible_preflight_error = wait_visible_form_error(observer)
        counts_after = read_user_counts(container, account_a["userId"])
        retained = observer.evaluate("JSON.stringify({count:document.querySelectorAll('.urlInspectionField input').length,values:[...document.querySelectorAll('.urlInspectionField input')].map(x=>x.value.length),error:document.querySelector('.formError')?.innerText||''})")
        if counts_before != counts_after or retained.get("count") != 7 or len(retained.get("values", [])) != 7 \
                or not all(length == len(url) for length, url in zip(retained.get("values", []), long_urls, strict=True)) \
                or "exceeding the 6000-character website bridge limit" not in visible_preflight_error.get("error", "").lower():
            raise RuntimeError("The oversized instruction was not safely rejected with all inputs retained: "
                               + json.dumps({"visibleError": visible_preflight_error, "countsBefore": counts_before,
                                             "countsAfter": counts_after, "retained": retained}, sort_keys=True))
        report["workflow"].append({"name": "oversized_complete_instruction_preflight", "result": "PASS",
                                   "errorVisible": True, "errorText": visible_preflight_error.get("error"),
                                   "nativeInputReadbackLengths": retained.get("values"),
                                   "beforeCounts": counts_before, "afterCounts": counts_after,
                                   "noInspectionOrDispatchCreated": True})
        report["screenshots"].append(screenshot(evidence, "18-oversized-preflight-error.png", hwnd, chrome.pid, display))

        # B cannot read or overwrite A's batch, rows, jobs, or saved fit analysis.
        batch_a_first = primary_db.get("items", [{}])[0]
        job_a = str(batch_a_first.get("jobId") or "")
        request_a = str(batch_a_first.get("requestId") or "")
        onboarding.switch_user(observer, hwnd, chrome.pid, app_url, account_b, report, "M04 synthetic User B")
        report.setdefault("chromePasswordPrompts", []).append(dismiss_test_profile_password_prompt(hwnd, chrome.pid, display))
        foreign_batch = app_data(observer, "/api/jobs/inspect?batchId=" + urllib.parse.quote(batch_id, safe=""))
        token_b = onboarding.login_token(api_url, publishable_key, account_b)
        base_headers = {"apikey": publishable_key, "authorization": "Bearer " + token_b, "accept": "application/json"}
        request_status, request_rows = safe_json_request(api_url + "/rest/v1/job_url_inspection_requests?select=id&batch_id=eq." + urllib.parse.quote(batch_id), headers=base_headers)
        jobs_status, job_rows = safe_json_request(api_url + "/rest/v1/jobs?select=id&id=eq." + urllib.parse.quote(job_a), headers=base_headers)
        fit_status, fit_rows = safe_json_request(api_url + "/rest/v1/job_analyses?select=id&job_id=eq." + urllib.parse.quote(job_a), headers=base_headers)
        patch_headers = {**base_headers, "content-type": "application/json", "prefer": "return=representation"}
        patch_status, patch_rows = safe_json_request(api_url + "/rest/v1/job_url_inspection_requests?id=eq." + urllib.parse.quote(request_a),
            method="PATCH", body={"initial_fit_status": "assessed"}, headers=patch_headers)
        patch_rejected = patch_status in (401, 403)
        patch_empty = patch_status in (200, 204) and not patch_rows
        ownership_state = {"appBatchStatus": foreign_batch.get("status"), "requestHttpStatus": request_status,
                           "requestRows": len(request_rows or []), "jobHttpStatus": jobs_status,
                           "jobRows": len(job_rows or []), "fitHttpStatus": fit_status,
                           "fitRows": len(fit_rows or []), "patchHttpStatus": patch_status,
                           "patchRejected": patch_rejected, "patchEmpty": patch_empty}
        if foreign_batch.get("status") != 404 or request_status != 200 or request_rows \
                or jobs_status != 200 or job_rows or fit_status != 200 or fit_rows \
                or not (patch_rejected or patch_empty):
            raise RuntimeError("Local User B could read or change User A's URL batch, job, or fit data: "
                               + json.dumps(ownership_state, sort_keys=True))
        unchanged = database_batch(container, batch_id)
        if unchanged.get("items", [{}])[0].get("fitStatus") != batch_a_first.get("fitStatus"):
            raise RuntimeError("User B's attempted update changed User A's fit status.")
        report["workflow"].append({"name": "two_user_url_job_fit_ownership", "result": "PASS",
                                   "userBAppBatchHttpStatus": foreign_batch.get("status"),
                                   "userBRestRows": {"requests": len(request_rows or []), "jobs": len(job_rows or []), "analyses": len(fit_rows or [])},
                                   "userBPatchHttpStatus": patch_status, "userAFitUnchanged": True,
                                   "ordinaryUserJwtUsed": True, "credentialsAndTokensRecorded": False})
        report["screenshots"].append(screenshot(evidence, "19-user-b-cannot-read-user-a-batch.png", hwnd, chrome.pid, display))
        onboarding.switch_user(observer, hwnd, chrome.pid, app_url, account_a, report, "M04 synthetic User A restored")
        report.setdefault("chromePasswordPrompts", []).append(dismiss_test_profile_password_prompt(hwnd, chrome.pid, display))

        # The existing-job selected-fit action remains a separate Memory-only route/dispatch.
        jobs_nav_click = desktop.native_click_selector(observer, hwnd, chrome.pid, "nav[aria-label='Main navigation'] a[href='/jobs']")
        jobs_page_state = wait_jobs_workspace(observer)
        restored_batch = app_data(observer, "/api/jobs/inspect?batchId=" + urllib.parse.quote(batch_id, safe=""))
        restored_jobs_view = observer.evaluate("JSON.stringify((()=>{const body=document.body.innerText;const table=document.querySelector('.jobPoolTable');return {heading:document.querySelector('h1')?.innerText.trim()||'',poolSummary:document.querySelector('.jobPoolHeader')?.innerText.trim()||'',emptyState:document.querySelector('.emptyState')?.innerText.trim()||'',tableRows:document.querySelectorAll('.jobPoolTable tbody tr').length,roleLinks:document.querySelectorAll('a.jobPoolRole').length,location:location.pathname,bodyContainsExpectedRole:body.includes('Synthetic Data Analyst'),poolView:document.querySelector('.jobPoolControls select')?.value||null}})())")
        report["workflow"].append({"name": "user_a_session_and_job_pool_readback_after_isolation", "result": "DIAGNOSTIC",
                                   "ownedBatchHttpStatus": restored_batch.get("status"),
                                   "ownedBatchVisibleToRestoredUser": restored_batch.get("status") == 200,
                                   "jobPool": restored_jobs_view, "exactRouteWait": jobs_page_state,
                                   "nativeNavigationClick": jobs_nav_click})
        checkbox_state = visible_job_checkbox(observer, scored_job)
        if not checkbox_state or not checkbox_state.get("exists") or checkbox_state.get("disabled") or not checkbox_state.get("selector"):
            raise RuntimeError("The visible synthetic-job row did not expose its native selection checkbox: "
                               + json.dumps(checkbox_state, sort_keys=True))
        selection_checkbox_click = desktop.native_click_selector(observer, hwnd, chrome.pid, checkbox_state["selector"])
        checked_after = observer.evaluate("document.querySelector(" + json.dumps(checkbox_state["selector"]) + ")?.checked===true")
        if checked_after is not True:
            raise RuntimeError("Native input did not select the intended existing synthetic job row.")
        selection = observer.evaluate("JSON.stringify([...document.querySelectorAll('.jobAnalysisBatchActions button')].find(button=>button.innerText.trim().startsWith('Analyse selected'))?.innerText.trim()||'')")
        if "Analyse selected (1)" not in selection:
            raise RuntimeError("The visible existing-job reanalysis action did not reflect one selected synthetic job.")
        native_click_text(observer, hwnd, chrome.pid, "Analyse selected (1)")
        wait_text(observer, "Analysing saved listing URLs", "separate existing-job fit reassessment queue")
        counts_after_reanalysis = read_user_counts(container, account_a["userId"])
        if counts_after_reanalysis.get("inspections") != counts_after.get("inspections") \
                or counts_after_reanalysis.get("urlDispatches") != counts_after.get("urlDispatches") \
                or counts_after_reanalysis.get("fitBatches", 0) <= counts_after.get("fitBatches", 0):
            raise RuntimeError("The existing-job reassessment did not stay separate from the URL-import batch flow.")
        reanalysis_get = app_data(observer, "/api/jobs/analysis/memory")
        reanalysis_batch = (reanalysis_get.get("data") or {}).get("batch") if isinstance(reanalysis_get.get("data"), dict) else None
        if reanalysis_get.get("status") != 200 or not isinstance(reanalysis_batch, dict):
            raise RuntimeError("The app did not expose its newly queued existing-job fit batch.")
        reanalysis_chunks = reanalysis_batch.get("chunks") if isinstance(reanalysis_batch.get("chunks"), list) else []
        reanalysis_dispatch = next((chunk.get("dispatch_id") for chunk in reanalysis_chunks if isinstance(chunk, dict)
                                    and isinstance(chunk.get("dispatch_id"), str)), None)
        if len(reanalysis_chunks) != 1 or not reanalysis_dispatch:
            raise RuntimeError("The selected-job fit batch did not create exactly one generic Website Bridge request.")
        reanalysis_response = make_insufficient_memory_fit_response(reanalysis_batch)
        reanalysis_provider = controlled_complete(api_url, device_id, device_token, bridge_version, capabilities,
            "memory_fit_reanalysis", run_id, reanalysis_dispatch, reanalysis_response)
        advance_response = app_data(observer, "/api/jobs/analysis/memory/advance", "POST", {"batchId": reanalysis_batch.get("id")})
        if advance_response.get("status") not in (200, 202) or not (advance_response.get("data") or {}).get("ok"):
            raise RuntimeError("The generic fit response was not captured and persisted through the app's existing reanalysis route.")
        desktop.press_key(0x74)
        wait_text(observer, "Memory-based analysis complete", "visible completion of the selected-job Memory-fit reassessment", 45)
        reanalysis_saved = app_data(observer, "/api/jobs/analysis/memory?batchId=" + urllib.parse.quote(str(reanalysis_batch.get("id")), safe=""))
        saved_batch = (reanalysis_saved.get("data") or {}).get("batch") if isinstance(reanalysis_saved.get("data"), dict) else None
        saved_items = saved_batch.get("items") if isinstance(saved_batch, dict) and isinstance(saved_batch.get("items"), list) else []
        if reanalysis_saved.get("status") != 200 or not isinstance(saved_batch, dict) or saved_batch.get("state") != "completed" \
                or len(saved_items) != 1 or saved_items[0].get("job_id") != scored_job \
                or saved_items[0].get("state") != "insufficient_memory" or not saved_items[0].get("analysis_id"):
            raise RuntimeError("The saved selected-job reanalysis did not finish with a correlated unknown-Memory result.")
        counts_after_reanalysis_complete = read_user_counts(container, account_a["userId"])
        report["workflow"].append({"name": "existing_job_reanalysis_remains_separate", "result": "CONTROLLED PASS",
                                   "visibleAction": selection, "nativeRowCheckboxClick": selection_checkbox_click,
                                   "inspectionCountUnchanged": True,
                                   "urlDispatchCountUnchanged": True,
                                   "separateMemoryFitBatchCreated": True,
                                   "newReanalysisDispatchCompleted": True,
                                   "completionProvider": "controlled local synthetic response; real ChatGPT Memory not accessed",
                                   "reanalysisResponse": reanalysis_provider,
                                   "durableBatchState": saved_batch.get("state"),
                                   "durableItemState": saved_items[0].get("state"),
                                   "fitAnalysisPersisted": bool(saved_items[0].get("analysis_id")),
                                   "unknownMemoryRemainedUnknown": saved_items[0].get("result_json", {}).get("memory_status") == "unknown",
                                   "inspectionCountAfter": counts_after_reanalysis_complete.get("inspections"),
                                   "urlDispatchCountAfter": counts_after_reanalysis_complete.get("urlDispatches"),
                                   "fitBatchCountAfter": counts_after_reanalysis_complete.get("fitBatches")})
        report["screenshots"].append(screenshot(evidence, "20-existing-job-reanalysis-complete.png", hwnd, chrome.pid, display))

        report["performance"] = {"primaryTwoUrlBatchDispatches": primary_db.get("distinctDispatchCount"),
                                  "duplicateRequestReplayDispatches": after_replay.get("distinctDispatchCount"),
                                  "primaryHttpWaitSeconds": None,
                                  "responseParsingAndPersistence": "Measured through local end-to-end runner wall time; individual phase timings were not instrumented.",
                                  "noProductionNetworkRequestsFromTestChrome": True}
        report["result"] = "PASS_WITH_LIMITATIONS"
        report["milestones"].append({"name": "desktop_acceptance_workflows_finished", "timeUtc": utc_now()})
    except Exception as exc:
        report["result"] = "FAIL"
        report["error"] = f"{type(exc).__name__}: {exc}"
        report["limitations"].append("The run stopped at the first failed dependent GUI workflow; later dependent steps were not claimed as tested.")
    finally:
        if observer:
            try:
                observer.close()
            except Exception:
                pass
        if chrome:
            try:
                report["cleanup"]["chromeExited"] = len(m03.stop_chrome(chrome, chrome_pids, None)) == 0
            except Exception:
                report["cleanup"]["chromeExited"] = False
        if server:
            remaining = desktop.stop_owned_process(server, server_pids, graceful=True)
            report["cleanup"]["serverExited"] = not remaining
        if accounts:
            try:
                onboarding.cleanup_accounts(api_url, service_key, container, accounts, report)
                report["cleanup"]["syntheticAccountsRemoved"] = bool(report.get("syntheticDataCleanup", {}).get("complete"))
            except Exception as cleanup_error:
                report["cleanup"]["syntheticAccountsRemoved"] = False
                report["cleanup"]["accountCleanupError"] = f"{type(cleanup_error).__name__}: {cleanup_error}"
                report["result"] = "FAIL_CLEANUP"
        report["cleanup"]["ownedProcessPids"] = {"chrome": chrome_pids, "server": server_pids}
        report["finishedAtUtc"] = utc_now()
        if not args.keep_workspace:
            try:
                if run_root.resolve().parent == temp_root and run_root.name.startswith("JobHuntAI-M04-Local-UI-"):
                    shutil.rmtree(run_root)
                    report["cleanup"]["temporaryWorkspaceRemoved"] = not run_root.exists()
            except Exception:
                report["cleanup"]["temporaryWorkspaceRemoved"] = False
        report["evidenceDirectory"] = str(evidence)
        save_json(evidence / "m04-desktop-run.json", report)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", default=".")
    parser.add_argument("--evidence-dir")
    parser.add_argument("--keep-workspace", action="store_true")
    parser.add_argument("--real-bridge-check", action="store_true",
                        help="Use the real loopback-configured extension and one authorized ChatGPT response instead of the controlled local provider.")
    args = parser.parse_args()
    report = run(args)
    print(json.dumps({"result": report["result"], "evidenceDirectory": report["evidenceDirectory"],
                      "workflowCount": len(report["workflow"]), "cleanup": report["cleanup"],
                      "error": report.get("error")}, indent=2))
    return 0 if report["result"] in ("PASS", "PASS_WITH_LIMITATIONS") else 1


if __name__ == "__main__":
    raise SystemExit(main())
