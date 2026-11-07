#!/usr/bin/env python3
"""Focused M04 genuine Windows UI acceptance on disposable local Supabase data."""

from __future__ import annotations

import argparse
import ctypes
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
import websocket
from ctypes import wintypes
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
    item = desktop.desktop_screenshot(evidence / name, hwnd, pid, display, redact_taskbar=True)
    return {"path": name, "width": item.get("width"), "height": item.get("height"),
            "fullDesktop": True, "identityRedacted": True, "redactions": item.get("redactions", [])}


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
    # Selection can scroll the job row into view while leaving its batch action
    # above the viewport. Bring the actual button into view through native wheel
    # input, then use its fresh DOM bounds for the trusted click.
    visible = desktop.ensure_onboarding_visible(observer, hwnd, pid, item["selector"])
    return desktop.native_click_observed_rect(observer, hwnd, pid, visible["rect"], item["selector"])


def wait_native_button_enabled(observer: desktop.CDPObserver, text: str, timeout: float = 15) -> dict:
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = ui_text(observer, text)
        if last and not last.get("disabled"):
            return last
        time.sleep(0.1)
    diagnostic = observer.evaluate("JSON.stringify({path:location.pathname,heading:document.querySelector('h1')?.innerText||'',"
        "claim:localStorage.getItem('jobhunt:chatgpt-operation-optimistic:v1'),"
        "button:[...document.querySelectorAll('button')].find(x=>x.innerText.trim()===" + json.dumps(text) + ")?.outerHTML||null})")
    try:
        activity = app_data(observer, "/api/chatgpt-bridge/activity")
    except Exception as exc:
        activity = {"readError": type(exc).__name__}
    raise TimeoutError("The visible action remained disabled after operation-state settling: "
                       + json.dumps({"button": last, "page": diagnostic, "activity": activity}, sort_keys=True))


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
            'assessmentAsOf', r.initial_fit_assessment_as_of,
            'status', r.status, 'jobId', r.job_id, 'fitStatus', r.initial_fit_status,
            'fitAnalysisId', r.initial_fit_analysis_id, 'fitResponseHash', r.initial_fit_response_hash,
            'fitError', r.initial_fit_error,
            'fitScore', a.fit_score, 'analysisEligibility', a.eligibility,
            'eligibilityNotes', to_json(a.eligibility_notes),
            'dispatchId', r.dispatch_request_id, 'testingMode', r.initial_fit_testing_mode, 'updatedAt', r.updated_at,
            'dispatchState', d.state, 'dispatchResponseHash', d.response_hash,
            'provenanceRecorded', d.output_refs->>'response_provenance_recorded',
            'matchHash', r.initial_fit_response_hash=d.response_hash,
            'listing', json_build_object('title',j.title,'company',s.company_name,'industry',j.industry,
              'snapshotIndustry',s.raw_metadata #>> '{{listing_extraction,industry}}','sourceUrl',j.source_url,
              'externalJobId',j.external_job_id,'atsProvider',j.ats_provider,'salaryText',j.salary_text,
              'salaryMin',j.salary_min,'salaryMax',j.salary_max,'salaryCurrency',j.salary_currency,
              'postedAt',j.posted_at,'closesAt',j.closes_at,
              'resolvedListingUrl',s.raw_metadata #>> '{{listing_extraction,resolved_listing_url}}',
              'salarySource',s.raw_metadata #>> '{{listing_extraction,salary_source}}',
              'postedAtSourceUrl',s.raw_metadata->>'posted_at_source_url',
              'postedAtEvidence',s.raw_metadata->>'posted_at_evidence',
              'closesAtSourceUrl',s.raw_metadata->>'closes_at_source_url',
              'closesAtEvidence',s.raw_metadata->>'closes_at_evidence',
              'inspectionRequestId',s.raw_metadata #>> '{{listing_extraction,inspection_request_id}}')
          ) order by r.batch_position)
          from public.job_url_inspection_requests r
          left join public.chatgpt_dispatch_requests d on d.id=r.dispatch_request_id and d.user_id=r.user_id
          left join public.jobs j on j.id=r.job_id and j.user_id=r.user_id
          left join public.job_analyses a on a.id=r.initial_fit_analysis_id
          left join public.job_snapshots s on s.id=j.current_snapshot_id
          where r.batch_id='{batch_id}'::uuid
        ), '[]'::json),
        'inspectionCount', (select count(*) from public.job_url_inspection_requests where batch_id='{batch_id}'::uuid),
        'distinctDispatchCount', (select count(distinct dispatch_request_id) from public.job_url_inspection_requests where batch_id='{batch_id}'::uuid),
        'dispatchRowCount', (select count(*) from public.chatgpt_dispatch_requests where user_id=(select user_id from public.job_url_inspection_requests where batch_id='{batch_id}'::uuid limit 1) and idempotency_key='job.inspect_url.batch:{batch_id}'),
        'batchDispatchId', (select id from public.chatgpt_dispatch_requests where user_id=(select user_id from public.job_url_inspection_requests where batch_id='{batch_id}'::uuid limit 1) and idempotency_key='job.inspect_url.batch:{batch_id}' limit 1),
        'distinctJobCount', (select count(distinct job_id) from public.job_url_inspection_requests where batch_id='{batch_id}'::uuid and job_id is not null),
        'fitAnalysisCount', (select count(*) from public.job_url_inspection_requests r join public.job_analyses a on a.id=r.initial_fit_analysis_id where r.batch_id='{batch_id}'::uuid),
        'fitAnalysisDistinctCount', (select count(distinct r.initial_fit_analysis_id) from public.job_url_inspection_requests r join public.job_analyses a on a.id=r.initial_fit_analysis_id where r.batch_id='{batch_id}'::uuid),
        'fitBatchState', (select state from public.job_fit_memory_v4_batches where id='{batch_id}'::uuid),
        'fitBatchUpdatedAt', (select updated_at from public.job_fit_memory_v4_batches where id='{batch_id}'::uuid),
        'fitChunkUpdatedAt', (select max(updated_at) from public.job_fit_memory_v4_chunks where batch_id='{batch_id}'::uuid),
        'fitItemUpdatedAt', (select max(updated_at) from public.job_fit_memory_v4_items where batch_id='{batch_id}'::uuid)
      )::text;
    """
    return m03.psql_json(container, sql)


def install_failure_trigger(container: str, run_id: str, suffix: str, table: str, event: str, when_clause: str) -> dict:
    if not re.fullmatch(r"[a-z_]+", suffix) or not re.fullmatch(r"[a-z_]+", table) \
            or not re.fullmatch(r"INSERT|UPDATE(?: OF [a-z_]+)?", event) \
            or not re.fullmatch(r"[A-Za-z0-9_. =:'()<>-]+", when_clause):
        raise RuntimeError("Refusing an invalid local M04 failure-injection identifier or condition.")
    trigger = f"jobhunt_m04_{suffix}_{run_id[:10]}"
    function = f"jobhunt_m04_{suffix}_fn_{run_id[:10]}"
    sql = f"""
      create function public.{function}() returns trigger language plpgsql as $body$
      begin raise exception 'M04 controlled local failure injection: {suffix}'; end;
      $body$;
      create trigger {trigger} before {event} on public.{table} for each row when ({when_clause})
        execute function public.{function}();
      select json_build_object('trigger','{trigger}','installed',true)::text;
    """
    result = m03.psql_json(container, sql)
    if result.get("installed") is not True:
        raise RuntimeError("The scoped local M04 failure-injection trigger was not installed.")
    return {"trigger": trigger, "function": function, "table": table, "removed": False}


def remove_failure_trigger(container: str, artifact: dict) -> None:
    if artifact.get("removed") is True:
        return
    trigger = artifact.get("trigger")
    function = artifact.get("function")
    table = artifact.get("table")
    if not all(isinstance(value, str) and re.fullmatch(r"[a-z0-9_]+", value) for value in (trigger, function, table)):
        raise RuntimeError("Refusing to remove an unrecognized M04 local failure-injection trigger.")
    sql = f"""
      drop trigger if exists {trigger} on public.{table};
      drop function if exists public.{function}();
      select json_build_object('trigger','{trigger}','removed',true)::text;
    """
    result = m03.psql_json(container, sql)
    if result.get("removed") is not True:
        raise RuntimeError("The scoped local M04 failure-injection trigger did not clean up.")
    artifact["removed"] = True


def node_job_url_instruction(repo: Path, urls: list[str], request_ids: list[str], batch_id: str,
                             assessment_as_of: str, testing_mode: bool = True) -> str:
    if len(urls) != len(request_ids) or not urls or len(urls) > 10:
        raise RuntimeError("Refusing to build a controlled M04 instruction for an invalid URL batch.")
    node = shutil.which("node.exe") or shutil.which("node")
    if not node:
        raise FileNotFoundError("Node.js is required to reproduce the exact M04 prompt boundary in the isolated runner.")
    data = json.dumps({"urls": urls, "requestIds": request_ids, "batchId": batch_id,
                       "assessmentAsOf": assessment_as_of, "testingMode": testing_mode}, separators=(",", ":"))
    script = f'''import {{ buildJobUrlInspectionInstruction }} from "./lib/job-url-inspection-prompt.ts";
const data={data};
const items=data.urls.map((sourceUrl,index)=>({{sourceUrl,requestId:data.requestIds[index]}}));
const instruction=buildJobUrlInspectionInstruction(items,{{batchId:data.batchId,assessmentAsOf:new Date(data.assessmentAsOf).toISOString()}},data.testingMode);
console.log(JSON.stringify({{instruction,length:instruction.length}}));'''
    result = subprocess.run([node, "--experimental-strip-types", "--input-type=module", "-e", script],
                            cwd=repo / "apps/web", capture_output=True, text=True, encoding="utf-8", check=True)
    try:
        value = json.loads(result.stdout.strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError) as exc:
        raise RuntimeError("The exact M04 instruction helper returned unreadable output.") from exc
    instruction = value.get("instruction")
    if not isinstance(instruction, str) or value.get("length") != js_character_count(instruction):
        raise RuntimeError("The exact M04 instruction helper returned an invalid UTF-16 character count: "
                           + json.dumps({"reported": value.get("length"),
                                         "pythonCodePoints": len(instruction) if isinstance(instruction, str) else None,
                                         "utf16CodeUnits": js_character_count(instruction) if isinstance(instruction, str) else None}))
    return instruction


def boundary_test_url(repo: Path, target_length: int, testing_mode: bool) -> tuple[str, int]:
    node = shutil.which("node.exe") or shutil.which("node")
    if not node:
        raise FileNotFoundError("Node.js is required to calculate the exact M04 Website Bridge boundary URL.")
    script = f'''import {{ buildJobUrlInspectionInstruction }} from "./lib/job-url-inspection-prompt.ts";
const target={target_length}; const testing={str(testing_mode).lower()};
const prefix="https://jobs.example.test/m04/bridge-boundary/";
const items=[{{requestId:"00000000-0000-4000-8000-000000000001",sourceUrl:""}}];
const context={{batchId:"00000000-0000-4000-8000-000000000999",assessmentAsOf:"2026-11-07T00:00:00.000Z"}};
for(let count=0;count<=2000-prefix.length;count++){{
  const url=prefix+"a".repeat(count); items[0].sourceUrl=url;
  try {{ const length=buildJobUrlInspectionInstruction(items,context,testing).length;
    if(length===target){{console.log(JSON.stringify({{url,length}}));process.exit(0);}} }} catch {{}}
}}
throw new Error("No public URL of at most 2,000 characters maps to the requested exact Bridge instruction size.");'''
    result = subprocess.run([node, "--experimental-strip-types", "--input-type=module", "-e", script],
                            cwd=repo / "apps/web", capture_output=True, text=True, check=True)
    try:
        value = json.loads(result.stdout.strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError) as exc:
        raise RuntimeError("The M04 boundary calculator returned unreadable output.") from exc
    return str(value["url"]), int(value["length"])


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


def synthetic_job(request_id: str, source_url: str, index: int, run_id: str, scenario: str = "") -> dict:
    stable_id = hashlib.sha256(source_url.encode("utf-8")).hexdigest()[:12]
    job = {
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
    if scenario == "same_ats_mirror":
        job.update({
            "resolved_listing_url": "https://greenhouse.example.test/jobs/role-431?utm_source=mirror",
            "identity_match_fields": ["company", "title", "external_job_id"],
            "identity_evidence": "The exact employer, advertised title, and Greenhouse role identifier establish this as the same public vacancy.",
            "company": "M04 Synthetic Analytics", "title": "Synthetic Product Analyst",
            "external_job_id": "ROLE-431", "ats_provider": "Greenhouse",
            "description": "Fictional Product Analyst vacancy used to test verified mirror deduplication.",
            "salary_text": "£55,000 to £65,000 per year", "salary_min": 55000, "salary_max": 65000,
            "salary_currency": "GBP", "salary_source": "advertised", "salary_confidence": "high",
            "salary_basis": ["The synthetic listing explicitly states the salary range."],
            "posted_at": "2026-10-20T00:00:00.000Z", "closes_at": None,
            "raw_metadata": {"retrieved_at": utc_now(), "posted_at_source_url": "https://greenhouse.example.test/jobs/role-431",
                             "posted_at_evidence": "The listing explicitly labels this date as posted on 20 October 2026.",
                             "closes_at_source_url": None, "closes_at_evidence": None, "fixture": True},
        })
    elif scenario == "similar_title_distinct":
        job.update({
            "identity_match_fields": ["company", "title", "location"],
            "identity_evidence": "The exact employer, advertised title, and location match this independent synthetic role.",
            "company": "M04 Synthetic Analytics", "title": "Synthetic Product Analyst",
            "external_job_id": None, "ats_provider": None,
            "description": "Fictional Product Analyst vacancy with a distinct exact source URL and no shared ATS identity.",
        })
    elif scenario == "estimated_salary":
        job.update({
            "salary_text": "Estimated £60,000 per year; not employer-advertised",
            "salary_min": 60000, "salary_max": 60000, "salary_currency": "GBP",
            "salary_source": "chatgpt_estimate", "salary_confidence": "low",
            "salary_basis": ["Synthetic estimate based on the role's fictional scope; not stated by an employer."],
        })
    return job


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
        if scenario == "malformed_nonfound_reason" and index == 1:
            results.append({"request_id": request_id, "source_url": source_url, "status": "unavailable",
                            "reason": {"unsafe": "non-string explanation"}, "job": None, "fit": None})
            continue
        if scenario == "missing_fit_sibling" and index == 1:
            fit = synthetic_fit(request_id, source_url)
            del fit["components"]["qualification"]
        elif scenario == "scored_fit" or (scenario == "primary_unknown_scored" and index == 1):
            fit = synthetic_fit(request_id, source_url, unknown=False)
        else:
            fit = synthetic_fit(request_id, source_url)
        results.append({"request_id": request_id, "source_url": source_url, "status": "found", "reason": None,
                        "job": synthetic_job(request_id, source_url, index, run_id, scenario), "fit": fit})
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


def js_character_count(value: str) -> int:
    """Match JavaScript String.length, which counts UTF-16 code units."""
    return len(value.encode("utf-16-le")) // 2


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


def arm_native_link_readback(observer: desktop.CDPObserver) -> None:
    observer.evaluate("""(() => {
      const key='jobhunt:m04-native-link-click';
      sessionStorage.removeItem(key);
      document.addEventListener('click',event=>{
        const link=event.target?.closest?.('a');
        if(!link) return;
        sessionStorage.setItem(key,JSON.stringify({href:new URL(link.href,location.href).pathname,
          trusted:event.isTrusted,tag:link.tagName,text:(link.innerText||'').trim().slice(0,80)}));
      },true);
      return true;
    })()""")


def native_link_readback(observer: desktop.CDPObserver) -> dict | None:
    return observer.evaluate("JSON.stringify((()=>{try{return JSON.parse(sessionStorage.getItem('jobhunt:m04-native-link-click')||'null')}catch{return null}})())")


def navigate_jobs_via_native_link(observer: desktop.CDPObserver, hwnd: int, pid: int) -> dict:
    arm_native_link_readback(observer)
    click = desktop.native_click_selector(observer, hwnd, pid, "nav[aria-label='Main navigation'] a[href='/jobs']")
    page = wait_jobs_workspace(observer)
    link = native_link_readback(observer)
    if not link or link.get("href") != "/jobs" or link.get("trusted") is not True:
        raise RuntimeError("The Jobs workspace was not reached through its trusted native navigation link: "
                           + json.dumps({"click": click, "readback": link}, sort_keys=True))
    return {"nativeClick": click, "page": page, "linkReadback": link}


def wait_import_page(observer: desktop.CDPObserver, description: str, timeout: float = 35) -> dict:
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            last = observer.evaluate("JSON.stringify({pathname:location.pathname,heading:document.querySelector('h1')?.innerText.trim()||'',importHeading:document.querySelector('.addJobCard h2')?.innerText.trim()||''})")
            if isinstance(last, dict) and last.get("pathname") == "/jobs/add" \
                    and last.get("heading") == "Add a job" \
                    and last.get("importHeading") == "Import from job listing URLs":
                return last
        except Exception:
            pass
        time.sleep(0.2)
    raise TimeoutError(f"Timed out waiting for {description}; last state={json.dumps(last, sort_keys=True)}")


def native_history_back(hwnd: int, pid: int) -> dict:
    native = desktop.focus_and_maximize(hwnd, pid)
    if not native.get("isForeground"):
        raise RuntimeError("The test-owned Chrome window was not foreground before the native Back action.")
    desktop.key_event(0x12, True)  # Alt
    desktop.key_event(0x25, True)  # Left
    desktop.key_event(0x25, False)
    desktop.key_event(0x12, False)
    return {"method": "Win32 Alt+Left browser history", "windowState": native}


def wait_restored_batch(observer: desktop.CDPObserver, expected_batch_id: str, expected_urls: list[str], timeout: float = 15) -> dict:
    expected = json.dumps({"batchId": expected_batch_id, "urls": expected_urls}, separators=(",", ":"))
    literal = json.dumps(expected)
    expression = "JSON.stringify((()=>{const expected=JSON.parse(" + literal + ");"
    expression += "const urls=[...document.querySelectorAll('.urlInspectionField input')].map(x=>x.value);"
    expression += "return {batchId:localStorage.getItem('jobhunt:last-job-url-import-batch:v1'),urls,pending:localStorage.getItem('jobhunt:pending-job-url-import:v1')};})())"
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = observer.evaluate(expression)
        if isinstance(last, dict) and last.get("batchId") == expected_batch_id and last.get("urls") == expected_urls:
            return last
        time.sleep(0.1)
    raise TimeoutError("The reopened import form did not restore the exact local batch identity and URL inputs: "
                       + json.dumps(last, sort_keys=True))


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
    bridge_endpoint = api_url.rstrip("/") + "/functions/v1/chatgpt-bridge"
    parsed_endpoint = urllib.parse.urlparse(bridge_endpoint)
    if parsed_endpoint.scheme != "http" or parsed_endpoint.hostname not in ("127.0.0.1", "localhost"):
        raise RuntimeError("The real Bridge acceptance requires an HTTP loopback-only Supabase endpoint.")
    # The extension source defaults persisted unpaired storage to its production
    # endpoint independently of the popup's build-time placeholder. Patch only
    # this disposable worktree copy so the test profile cannot pair to production.
    protocol_source = extension_root / "src/shared/protocol.ts"
    protocol_text = protocol_source.read_text(encoding="utf-8")
    protocol_text, replaced = re.subn(
        r'export const DEFAULT_BRIDGE_ENDPOINT = "[^"\r\n]+" as const;',
        "export const DEFAULT_BRIDGE_ENDPOINT = " + json.dumps(bridge_endpoint) + " as const;",
        protocol_text,
        count=1,
    )
    if replaced != 1:
        raise RuntimeError("The isolated extension storage default could not be safely bound to the local Bridge.")
    protocol_source.write_text(protocol_text, encoding="utf-8", newline="\n")
    environment = desktop.safe_environment(workspace)
    environment.update({
        "JOB_HUNT_ORIGIN": app_url,
        "JOB_HUNT_BRIDGE_ENDPOINT": bridge_endpoint,
    })
    result = subprocess.run([node, "build.mjs"], cwd=extension_root, env=environment,
                            capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        raise RuntimeError("The local Bridge extension build failed (exit " + str(result.returncode) + ").")
    distribution = extension_root / "dist"
    manifest = json.loads((distribution / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("version") != json.loads((extension_root / "package.json").read_text(encoding="utf-8")).get("version"):
        raise RuntimeError("The isolated extension manifest version does not match its checked-out source.")
    return distribution, {"version": manifest.get("version"), "sourcePath": "apps/chatgpt-bridge-extension",
                         "builtForLoopback": True, "persistedStorageDefaultLoopback": True,
                         "productionSourceDefaultChanged": False}


def launch_chrome_with_extension(repo: Path, run_root: Path, profile: Path, app_url: str,
                                extension_path: Path, evidence: Path):
    chrome_path = desktop.find_chrome()
    profile_root = profile.resolve()
    if not profile_root.is_relative_to(run_root.resolve()):
        raise RuntimeError("Refusing to launch the live Bridge check outside its test-owned Chrome profile.")
    if not extension_path.resolve().is_relative_to(run_root.resolve()) or not (extension_path / "manifest.json").is_file():
        raise RuntimeError("Refusing to use an extension build outside the isolated test workspace.")
    (profile_root / "DevToolsActivePort").unlink(missing_ok=True)
    chrome = subprocess.Popen([
        str(chrome_path), f"--user-data-dir={profile}", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
        "--remote-allow-origins=http://localhost", "--no-first-run", "--no-default-browser-check", "--disable-sync",
        "--disable-save-password-bubble", "--disable-background-networking", "--disable-component-update",
        "--disable-default-apps", "--new-window", app_url + "/login?next=%2Fonboarding",
    ], cwd=run_root, env=desktop.safe_environment(run_root),
       stdout=(evidence / f"chrome-live-bridge-{uuid.uuid4().hex[:6]}.log").open("wb"),
       stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
    pids = desktop.process_tree_pids(chrome)
    observer = None
    try:
        port, _ = desktop.cdp_connect(profile, chrome)
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


def accessibility_tree(observer: desktop.CDPObserver) -> list[dict]:
    result = observer.command("Accessibility.getFullAXTree")
    nodes = result.get("nodes") if isinstance(result, dict) else None
    return nodes if isinstance(nodes, list) else []


def accessibility_control(observer: desktop.CDPObserver, role: str, name: str) -> dict | None:
    return next((node for node in accessibility_tree(observer)
                 if node.get("role", {}).get("value") == role
                 and node.get("name", {}).get("value") == name
                 and node.get("ignored") is not True), None)


def accessibility_checked(node: dict) -> str | None:
    prop = next((item for item in node.get("properties", []) if item.get("name") == "checked"), None)
    value = prop.get("value", {}).get("value") if isinstance(prop, dict) else None
    return str(value).lower() if value is not None else None


def accessibility_rect(observer: desktop.CDPObserver, node: dict) -> dict:
    backend_id = node.get("backendDOMNodeId")
    if not isinstance(backend_id, int):
        raise RuntimeError("Chrome's accessibility control had no native DOM box reference.")
    model = observer.command("DOM.getBoxModel", {"backendNodeId": backend_id}).get("model", {})
    quad = model.get("content")
    if not isinstance(quad, list) or len(quad) != 8:
        raise RuntimeError("Chrome did not return a usable control rectangle from its accessibility node.")
    xs, ys = quad[0::2], quad[1::2]
    return {"x": min(xs), "y": min(ys), "width": max(xs) - min(xs), "height": max(ys) - min(ys)}


def native_click_accessibility_control(observer: desktop.CDPObserver, hwnd: int, pid: int,
                                       node: dict, label: str) -> dict:
    if not node.get("backendDOMNodeId"):
        raise RuntimeError("The requested Chrome control cannot be mapped to a native screen point.")
    rect = accessibility_rect(observer, node)
    viewport = observer.evaluate("JSON.stringify({innerWidth,innerHeight,dpr:devicePixelRatio})")
    native_window = desktop.focus_and_maximize(hwnd, pid)
    x, y, metrics = desktop.screen_point(native_window, viewport, rect)
    pointer_method = desktop.mouse_click(x, y)
    cursor = desktop.POINT()
    if not desktop.user32.GetCursorPos(ctypes.byref(cursor)) or abs(cursor.x - x) > 2 or abs(cursor.y - y) > 2:
        raise RuntimeError("The native pointer did not read back at the requested Chrome control.")
    foreground = desktop.user32.GetForegroundWindow()
    foreground_pid = wintypes.DWORD()
    if foreground:
        desktop.user32.GetWindowThreadProcessId(foreground, ctypes.byref(foreground_pid))
    if int(foreground or 0) != hwnd or foreground_pid.value != pid:
        raise RuntimeError("The test-owned Chrome window lost foreground focus during its native UI action.")
    return {"label": label, "role": node.get("role", {}).get("value"),
            "nativeClick": {"x": x, "y": y, "pointerMethod": pointer_method,
                            "cursorReadback": {"x": cursor.x, "y": cursor.y},
                            "foregroundHwnd": int(foreground or 0), "foregroundPid": foreground_pid.value,
                            "coordinateMetrics": metrics}}


def active_window_details() -> tuple[int, int, str, str]:
    hwnd = int(desktop.user32.GetForegroundWindow() or 0)
    pid = wintypes.DWORD()
    if hwnd:
        desktop.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    text_length = desktop.user32.GetWindowTextLengthW(hwnd) if hwnd else 0
    title = ctypes.create_unicode_buffer(max(1, text_length + 1))
    if hwnd:
        desktop.user32.GetWindowTextW(hwnd, title, len(title))
    class_name = ctypes.create_unicode_buffer(256)
    if hwnd:
        desktop.user32.GetClassNameW(hwnd, class_name, len(class_name))
    return hwnd, pid.value, title.value, class_name.value


def window_owner_pid(hwnd: int) -> int:
    get_window = desktop.user32.GetWindow
    get_window.argtypes = [wintypes.HWND, wintypes.UINT]
    get_window.restype = wintypes.HWND
    owner = get_window(hwnd, 4)  # GW_OWNER: the file picker must belong to this test-owned Chrome window.
    owner_pid = wintypes.DWORD()
    if owner:
        desktop.user32.GetWindowThreadProcessId(owner, ctypes.byref(owner_pid))
    return owner_pid.value


def click_dialog_control(dialog: int, control: dict) -> dict:
    rect = wintypes.RECT()
    if not desktop.user32.GetWindowRect(control["hwnd"], ctypes.byref(rect)):
        raise OSError(ctypes.get_last_error(), "Could not read the native extension-picker control bounds.")
    x, y = (rect.left + rect.right) // 2, (rect.top + rect.bottom) // 2
    pointer_method = desktop.mouse_click(x, y)
    cursor = desktop.POINT()
    if not desktop.user32.GetCursorPos(ctypes.byref(cursor)) or abs(cursor.x - x) > 2 or abs(cursor.y - y) > 2:
        raise RuntimeError("The native extension-picker pointer position did not read back correctly.")
    if int(desktop.user32.GetForegroundWindow() or 0) != dialog:
        raise RuntimeError("The native extension-picker dialog lost foreground focus during selection.")
    return {"x": x, "y": y, "pointerMethod": pointer_method,
            "cursorReadback": {"x": cursor.x, "y": cursor.y}, "controlId": control["id"]}


def load_unpacked_extension_via_native_ui(observer: desktop.CDPObserver, hwnd: int, pid: int,
                                          extension_path: Path, evidence: Path,
                                          display: tuple[int, int], app_url: str) -> dict:
    desktop.native_navigate(observer, hwnd, pid, "chrome://extensions")
    deadline = time.monotonic() + 15
    page = None
    while time.monotonic() < deadline:
        try:
            page = observer.evaluate("JSON.stringify({url:location.href,title:document.title})")
            if isinstance(page, dict) and page.get("url", "").startswith("chrome://extensions") \
                    and page.get("title") == "Extensions":
                break
        except Exception:
            pass
        time.sleep(0.2)
    if not isinstance(page, dict) or not page.get("url", "").startswith("chrome://extensions"):
        raise TimeoutError("Native navigation did not open Chrome's Extensions page in the test-owned profile.")
    observer.command("Accessibility.enable")
    observer.command("DOM.enable")
    report = {"method": "Chrome chrome://extensions Developer mode and Load unpacked via Win32 SendInput",
              "testProfileOnly": True, "commandLineExtensionLoadingUsed": False,
              "developerModeBefore": None, "developerModeAfter": None}
    control_deadline = time.monotonic() + 10
    developer = None
    while time.monotonic() < control_deadline:
        developer = accessibility_control(observer, "switch", "Developer mode")
        if developer:
            break
        time.sleep(0.1)
    if not developer:
        raise RuntimeError("Chrome did not expose its Developer mode switch to accessibility inspection.")
    initial_state = accessibility_checked(developer)
    if initial_state not in ("true", "false"):
        raise RuntimeError("Chrome did not expose the Developer mode toggle state.")
    report["developerModeBefore"] = initial_state == "true"
    report["screenshots"] = [screenshot(evidence, "02-chrome-extensions-before-load.png", hwnd, pid, display)]
    if initial_state != "true":
        report["developerModeNativeAction"] = native_click_accessibility_control(
            observer, hwnd, pid, developer, "Chrome Developer mode")
    toggle_deadline = time.monotonic() + 6
    load_button = None
    final_state = None
    while time.monotonic() < toggle_deadline:
        developer = accessibility_control(observer, "switch", "Developer mode")
        final_state = accessibility_checked(developer) if developer else None
        load_button = accessibility_control(observer, "button", "Load unpacked")
        if final_state == "true" and load_button:
            break
        time.sleep(0.1)
    if final_state != "true" or not load_button:
        raise RuntimeError("Native Developer mode click did not expose Chrome's Load unpacked control.")
    report["developerModeAfter"] = True
    report["screenshots"].append(screenshot(evidence, "03-chrome-developer-mode-enabled.png", hwnd, pid, display))
    report["loadUnpackedNativeAction"] = native_click_accessibility_control(
        observer, hwnd, pid, load_button, "Chrome Load unpacked")

    dialog = 0
    dialog_pid = 0
    dialog_title = ""
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        dialog, dialog_pid, dialog_title, dialog_class = active_window_details()
        if "extension directory" in dialog_title.casefold():
            break
        time.sleep(0.1)
    if not dialog or "extension directory" not in dialog_title.casefold() or window_owner_pid(dialog) != pid:
        raise RuntimeError("Chrome's native extension-directory picker was not owned by the test-launched browser.")
    controls = desktop.enumerate_child_controls(dialog)
    select_control = next((item for item in controls if item["class"] == "Button" and item["id"] == 1), None)
    if not select_control:
        control_summary = [{"class": item["class"], "id": item["id"]} for item in controls]
        raise RuntimeError("The native extension-directory picker did not expose its Select Folder control; "
                           + json.dumps({"title": dialog_title, "class": dialog_class, "controlClassesAndIds": control_summary}))
    report["nativeDirectoryPicker"] = {"title": dialog_title, "class": dialog_class,
                                       "foregroundPidDiffersFromChrome": dialog_pid != pid,
                                       "ownerIsTestChrome": True,
                                       "controlClassesAndIds": [{"class": item["class"], "id": item["id"]}
                                                                for item in controls
                                                                if (item["class"], item["id"]) in {
                                                                    ("Edit", 1152), ("Button", 1), ("Button", 2)}]}
    desktop.press_key(0x4C, ctrl=True)
    time.sleep(0.2)
    controls = desktop.enumerate_child_controls(dialog)
    address_control = next((item for item in controls if item["class"] == "Edit" and item["id"] == 41477), None)
    if not address_control:
        control_summary = [{"class": item["class"], "id": item["id"]} for item in controls]
        raise RuntimeError("Native Ctrl+L did not focus the extension picker address field; "
                           + json.dumps({"controlClassesAndIds": control_summary}))
    report["nativeDirectoryPicker"]["addressFocusMethod"] = "Win32 Ctrl+L; editable address control readback"
    desktop.press_key(0x41, ctrl=True)
    extension_directory = str(extension_path.resolve())
    desktop.type_unicode(extension_directory)
    if int(desktop.user32.GetForegroundWindow() or 0) != dialog:
        raise RuntimeError("The native extension picker lost foreground focus while entering the test build path.")
    address_text = ctypes.create_unicode_buffer(32768)
    expected_address = extension_directory.rstrip("\\/").casefold()
    address_deadline = time.monotonic() + 5
    address_matched = False
    while time.monotonic() < address_deadline:
        desktop.user32.SendMessageW(address_control["hwnd"], desktop.WM_GETTEXT, len(address_text),
                                    ctypes.cast(address_text, ctypes.c_void_p).value)
        actual_address = address_text.value.rstrip("\\/").casefold()
        if actual_address == expected_address:
            address_matched = True
            break
        time.sleep(0.1)
    if not address_matched:
        actual_address = address_text.value.rstrip("\\/").casefold()
        raise RuntimeError("The native extension picker did not read back the isolated build directory; "
                           + json.dumps({"typedCharacters": len(extension_directory),
                                         "readbackCharacters": len(address_text.value),
                                         "readbackIsPrefix": bool(actual_address) and expected_address.startswith(actual_address),
                                         "readbackIsSuffix": bool(actual_address) and expected_address.endswith(actual_address)}))
    report["nativeDirectoryPicker"]["typedPathLength"] = len(extension_directory)
    report["nativeDirectoryPicker"]["addressReadbackMatched"] = True
    desktop.press_key(0x0D)
    time.sleep(0.5)
    controls = desktop.enumerate_child_controls(dialog)
    breadcrumb = next((item.get("text", "") for item in controls
                       if item["class"] == "ToolbarWindow32" and item["id"] == 1001), "")
    if extension_path.name.casefold() not in breadcrumb.casefold():
        raise RuntimeError("The native extension picker did not navigate to the built extension folder.")
    select_control = next((item for item in controls if item["class"] == "Button" and item["id"] == 1), None)
    if not select_control:
        raise RuntimeError("The native extension picker lost its Select Folder action after navigation.")
    report["nativeDirectoryPicker"]["folderNavigationReadback"] = True
    report["nativeDirectoryPicker"]["selectFolderClick"] = click_dialog_control(dialog, select_control)
    close_deadline = time.monotonic() + 10
    while time.monotonic() < close_deadline and int(desktop.user32.GetForegroundWindow() or 0) == dialog:
        time.sleep(0.1)
    if int(desktop.user32.GetForegroundWindow() or 0) == dialog:
        raise TimeoutError("Chrome's native extension-directory picker did not close after Select Folder.")
    expected = json.loads((extension_path / "manifest.json").read_text(encoding="utf-8"))
    load_deadline = time.monotonic() + 20
    card_names: set[str] = set()
    while time.monotonic() < load_deadline:
        try:
            names = {str(node.get("name", {}).get("value", "")) for node in accessibility_tree(observer)}
            card_names = names
            has_name = any(expected.get("name", "") in name for name in names)
            has_version = any(expected.get("version", "") in name for name in names)
            if has_name and has_version:
                break
        except Exception:
            pass
        time.sleep(0.25)
    if not any(expected.get("name", "") in name for name in card_names) \
            or not any(expected.get("version", "") in name for name in card_names):
        raise TimeoutError("Chrome did not show the expected JobHuntAI extension name and version after native installation.")
    report["extensionManagerReadback"] = {"name": expected.get("name"), "version": expected.get("version"),
                                          "loadedFromIsolatedBuild": True}
    report["screenshots"].append(screenshot(evidence, "04-jobhuntai-extension-loaded.png", hwnd, pid, display))
    desktop.native_navigate(observer, hwnd, pid, app_url + "/diagnostics")
    wait_text(observer, "ChatGPT testing mode", "Testing Mode after returning from Chrome extension settings")
    return report


def extension_runtime_id(port: int, chrome: subprocess.Popen, expected_name: str, expected_version: str,
                         timeout: float = 20) -> str:
    deadline = time.monotonic() + timeout
    inspected_ids: set[str] = set()
    while time.monotonic() < deadline:
        if chrome.poll() is not None:
            raise RuntimeError("Test-owned Chrome exited before the unpacked Bridge extension started.")
        for target in cdp_targets(port):
            match = re.match(r"^chrome-extension://([a-p]{32})/background\.js$", str(target.get("url", "")))
            if not match or target.get("type") not in ("service_worker", "background_page"):
                continue
            extension_id = match.group(1)
            if extension_id in inspected_ids:
                continue
            inspected_ids.add(extension_id)
            observer = desktop.CDPObserver(port, chrome)
            try:
                observer.ws = websocket.create_connection(
                    target["webSocketDebuggerUrl"], timeout=5,
                    origin="http://localhost", suppress_origin=False,
                )
                manifest = observer.evaluate("chrome.runtime.getManifest()")
                if isinstance(manifest, dict) and manifest.get("name") == expected_name \
                        and manifest.get("version") == expected_version:
                    return extension_id
            except Exception:
                pass
            finally:
                observer.close()
        time.sleep(0.25)
    raise TimeoutError("The test-owned Chrome did not expose the expected JobHuntAI extension worker; inspected "
                       + str(len(inspected_ids)) + " isolated extension worker(s).")


def native_fill_css(observer: desktop.CDPObserver, hwnd: int, pid: int, selector: str, value: str) -> dict:
    item = observer.evaluate(
        "JSON.stringify((()=>{const e=document.querySelector(" + json.dumps(selector) + ");if(!e)return null;"
        "const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,disabled:e.disabled===true}})())"
    )
    if not isinstance(item, dict) or item.get("disabled"):
        diagnostic = observer.evaluate(
            "JSON.stringify({url:location.href,title:document.title,readyState:document.readyState,"
            "bodyTextLength:document.body?.innerText?.length||0,backendInputPresent:!!document.querySelector('#backendUrl'),"
            "pairCodeInputPresent:!!document.querySelector('#pairingCode'),statusText:document.querySelector('#statusText')?.innerText||null})"
        )
        raise RuntimeError("The expected real extension input is missing or disabled; safe page diagnostics="
                           + json.dumps(diagnostic, sort_keys=True))
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


def popup_pairing_state(observer: desktop.CDPObserver, expected_endpoint: str) -> dict:
    observed = observer.evaluate(
        "JSON.stringify((()=>{const endpoint=document.querySelector('#backendUrl')?.value||'';"
        "let origin='',host='',path='';try{const u=new URL(endpoint);origin=u.origin;host=u.hostname;path=u.pathname;}catch{}"
        "const status=document.querySelector('#statusText');const text=status?.innerText||'';"
        "const statusError=status?.classList.contains('error')===true;"
        "return {origin,host,path,statusCategory:text.startsWith('Paired')?'paired':"
        "statusError||text.toLowerCase().includes('error')||text.toLowerCase().includes('fail')?'error':'not_paired',"
        "statusError,"
        "pairingCodeLength:document.querySelector('#pairingCode')?.value?.length||0,"
        "pairButtonDisabled:document.querySelector('#pairButton')?.disabled===true};})())"
    )
    expected = urllib.parse.urlparse(expected_endpoint)
    expected_origin = f"{expected.scheme}://{expected.netloc}"
    if not isinstance(observed, dict):
        raise RuntimeError("The extension popup did not return a structured pairing state.")
    observed["endpointOriginMatchesLocal"] = observed.get("origin") == expected_origin \
        and observed.get("host") in ("127.0.0.1", "localhost") \
        and observed.get("path") == expected.path
    return observed


def extension_message(observer: desktop.CDPObserver, payload: dict) -> dict:
    expression = "chrome.runtime.sendMessage(" + json.dumps(payload, separators=(",", ":")) + ").then(value=>JSON.stringify(value))"
    result = observer.evaluate(expression)
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except json.JSONDecodeError:
            pass
    return result if isinstance(result, dict) else {"ok": False, "reason": "The extension returned no structured status."}


def run_real_bridge_check(repo: Path, run_root: Path, evidence: Path, app_url: str, extension_path: Path, api_url: str,
                          container: str, observer: desktop.CDPObserver, hwnd: int, chrome: subprocess.Popen,
                          chrome_pid: int, cdp_port: int, display: tuple[int, int], report: dict) -> dict:
    extension_installation = load_unpacked_extension_via_native_ui(
        observer, hwnd, chrome_pid, extension_path, evidence, display, app_url)
    report["extensionInstallation"] = {key: value for key, value in extension_installation.items() if key != "screenshots"}
    report["screenshots"].extend(extension_installation.get("screenshots", []))
    pairing = app_data(observer, "/api/chatgpt-bridge/pairing", "POST", {})
    pairing_code = pairing.get("data", {}).get("pairing_code") if pairing.get("status") == 200 else None
    if not isinstance(pairing_code, str) or not pairing_code:
        raise RuntimeError("The authenticated local app did not create a one-time Bridge pairing code.")

    extension_manifest = json.loads((repo / "apps/chatgpt-bridge-extension/package.json").read_text(encoding="utf-8"))
    extension_id = extension_runtime_id(cdp_port, chrome, "JobHuntAI ChatGPT Bridge", extension_manifest["version"])
    popup_url = f"chrome-extension://{extension_id}/popup.html"
    open_cdp_target(cdp_port, popup_url)
    extension_observer = desktop.CDPObserver(cdp_port, chrome)
    extension_observer.connect_page(popup_url)
    desktop.focus_and_maximize(hwnd, chrome_pid)
    report["screenshots"].append(screenshot(evidence, "05-extension-pair-form-before-input.png", hwnd, chrome_pid, display))
    api_endpoint = api_url.rstrip("/") + "/functions/v1/chatgpt-bridge"
    native_fill_css(extension_observer, hwnd, chrome_pid, "#backendUrl", api_endpoint)
    native_fill_css(extension_observer, hwnd, chrome_pid, "#pairingCode", pairing_code)
    pre_pair_state = popup_pairing_state(extension_observer, api_endpoint)
    if pre_pair_state.get("endpointOriginMatchesLocal") is not True or pre_pair_state.get("pairingCodeLength") != len(pairing_code):
        raise RuntimeError("The real extension popup did not read back the loopback endpoint and local one-time code; "
                           + json.dumps({key: pre_pair_state.get(key) for key in (
                               "host", "path", "endpointOriginMatchesLocal", "pairingCodeLength")}))
    pair_click = native_click_css(extension_observer, hwnd, chrome_pid, "#pairButton")
    pairing_deadline = time.monotonic() + 25
    pair_status = ""
    while time.monotonic() < pairing_deadline:
        pair_state = popup_pairing_state(extension_observer, api_endpoint)
        if pair_state.get("statusCategory") == "paired":
            break
        if pair_state.get("statusCategory") == "error":
            report["extensionPairing"] = {
                "nativeClick": pair_click,
                "endpointOriginMatchesLocal": pair_state.get("endpointOriginMatchesLocal"),
                "statusCategory": "error",
                "statusError": pair_state.get("statusError"),
                "pairingCodeCleared": pair_state.get("pairingCodeLength") == 0,
                "pairButtonDisabled": pair_state.get("pairButtonDisabled"),
            }
            raise RuntimeError("The real extension UI rejected the local Bridge pairing; safe popup state="
                               + json.dumps(report["extensionPairing"], sort_keys=True))
        time.sleep(0.2)
    if popup_pairing_state(extension_observer, api_endpoint).get("statusCategory") != "paired":
        final_pair_state = popup_pairing_state(extension_observer, api_endpoint)
        report["extensionPairing"] = {"nativeClick": pair_click,
                                       "endpointOriginMatchesLocal": final_pair_state.get("endpointOriginMatchesLocal"),
                                       "statusCategory": final_pair_state.get("statusCategory"),
                                       "statusError": final_pair_state.get("statusError"),
                                       "pairingCodeCleared": final_pair_state.get("pairingCodeLength") == 0,
                                       "pairButtonDisabled": final_pair_state.get("pairButtonDisabled")}
        raise TimeoutError("The real extension UI did not confirm local Bridge pairing; safe popup state="
                           + json.dumps(report["extensionPairing"], sort_keys=True))
    report["extensionPairing"] = {"nativeClick": pair_click,
                                   "endpointOriginMatchesLocal": True,
                                   "statusCategory": "paired",
                                   "pairingCodeCleared": True}
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


def resubmit_visible_batch(observer: desktop.CDPObserver, hwnd: int, pid: int, count: int, expected_batch_id: str) -> dict:
    observer.evaluate("""JSON.stringify((()=>{
      if (!window.__m04InspectResponses) window.__m04InspectResponses=[];
      if (!window.__m04InspectFetchWrapped) {
        const original=window.fetch.bind(window);
        window.fetch=async (...args)=>{
          const input=args[0]; const init=args[1]||{};
          const url=typeof input==='string'?input:(input?.url||'');
          const method=String(init.method||input?.method||'GET').toUpperCase();
          const response=await original(...args);
          if (method==='POST' && new URL(url,location.href).pathname==='/api/jobs/inspect') {
            try {
              const body=await response.clone().json();
              window.__m04InspectResponses.push({status:response.status,ok:body?.ok===true,
                error:typeof body?.error==='string'?body.error:null,
                diagnostic:typeof body?.diagnostic==='string'?body.diagnostic:null,
                batchId:typeof body?.batchId==='string'?body.batchId:null});
            } catch { window.__m04InspectResponses.push({status:response.status,bodyUnreadable:true}); }
          }
          return response;
        };
        window.__m04InspectFetchWrapped=true;
      }
      return true;
    })())""")
    observer.evaluate("window.__m04InspectResponses=[]")
    button = f"Inspect {count} listings with ChatGPT" if count > 1 else "Inspect with ChatGPT"
    enabled_state = wait_native_button_enabled(observer, button)
    click = native_click_text(observer, hwnd, pid, button)
    wait_text(observer, "Import progress", "visible recovered URL import batch")
    recovered_batch_id = read_local_batch_id(observer)
    if recovered_batch_id != expected_batch_id:
        raise RuntimeError("The visible pending retry did not preserve its exact original batch identity.")
    response = None
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        response = observer.evaluate("window.__m04InspectResponses?.at(-1)||null")
        if isinstance(response, dict):
            break
        time.sleep(0.08)
    return {"nativeRetryClick": click, "enabledStateReadback": enabled_state, "sameBatchIdRestored": True,
            "apiResponse": response}


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
        'fitBatches',(select count(*) from public.job_fit_memory_v4_batches where user_id='{user_id}'::uuid),
        'applications',(select count(*) from public.applications where user_id='{user_id}'::uuid),
        'documentGenerationRequests',(select count(*) from public.document_generation_requests where user_id='{user_id}'::uuid),
        'formAgentSessions',(select count(*) from public.form_agent_sessions where user_id='{user_id}'::uuid),
        'applicationPreparationRequests',(select count(*) from public.application_preparation_requests where user_id='{user_id}'::uuid),
        'emails',(select count(*) from public.emails where user_id='{user_id}'::uuid)
      )::text;
    """
    return m03.psql_json(container, sql)


def mutate_synthetic_job_revision(container: str, job_id: str) -> dict:
    if not re.fullmatch(r"[0-9a-f-]{36}", job_id, re.I):
        raise RuntimeError("Refusing to change a non-UUID synthetic job during M04 revision validation.")
    sql = f"""
      update public.jobs set title=title||' [M04 synthetic revision change]',updated_at=now()
       where id='{job_id}'::uuid
       returning json_build_object('jobId',id,'title',title,'analysisRevision',analysis_revision)::text;
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
        "releaseGuidance": {
            "productionDeploymentPerformed": False,
            "compatibleOrder": [
                "Apply the additive M04 database migrations, including original_source_url compatibility and atomic batch dispatch recovery.",
                "Deploy the Bridge Edge Function response parser/capture contract before exposing combined-import requests from the frontend.",
                "Deploy the M04 frontend after both the schema and Edge Function are ready.",
                "The extension protocol remains compatible; release its endpoint-validation change after the Edge backend, or omit it from the M04 production release because it only enables loopback development endpoints.",
            ],
            "localMigrationFiles": ["20261106212716_combined_job_url_memory_fit.sql", "20261106220538_m04_terminal_fit_outcomes.sql",
                                    "20261106224247_skip_pool_dirty_for_deleted_users.sql", "20261107090000_m04_batch_recovery_and_identity.sql",
                                    "20261107150039_m04_dispatch_lookup_schema_cache.sql",
                                    "20261107150350_m04_batch_dispatch_lookup_rpc.sql"],
            "rollbackBoundary": "Do not roll back database functions while an M04 frontend can call them. Roll back or disable the frontend first; keep additive compatibility columns/data and do not drop them. Revert the Edge parser only after the frontend is back on the M03-compatible contract. No production change was made by this test.",
        },
        "environment": {"python": sys.version.split()[0], "dpiAwareness": None, "primaryDisplay": None},
        "workflow": [], "screenshots": [], "milestones": [], "databaseFailureInjections": [],
        "cleanup": {"chromeExited": False, "serverExited": False, "syntheticAccountsRemoved": False,
                    "temporaryWorkspaceRemoved": False, "ownedProcessPids": {}},
        "limitations": [], "result": "RUNNING", "error": None,
        "evidenceDirectory": f"<evidence>/{run_id}",
    }
    server = chrome = observer = None
    server_pids: list[int] = []
    chrome_pids: list[int] = []
    accounts: list[dict] = []
    failure_triggers: list[dict] = []
    device_id = device_token = None
    hwnd = None
    try:
        report["environment"]["dpiAwareness"] = desktop.enable_per_monitor_dpi_awareness()
        account_a, account_b = onboarding.seed_accounts(argparse.Namespace(), run_id)
        accounts = [account_a, account_b]
        copied, packages, dependency_files, supplemental = desktop.copy_isolated_workspace(
            repo, workspace, include_bridge_extension=args.real_bridge_check)
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
            bridge_outcome = run_real_bridge_check(repo, run_root, evidence, app_url, extension_path, api_url, container,
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

        # A failed dispatch INSERT leaves only the already-persisted inspection rows.
        # The page is then unmounted and reopened to prove the exact pending batch
        # and typed URLs survive; a simulated pre-transaction orphan dispatch tests
        # recovery of the historic create-before-link crash boundary.
        recovery_urls = ["https://jobs.example.test/m04/recovery-a", "https://jobs.example.test/m04/recovery-b"]
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/jobs/add")
        wait_text(observer, "Import from job listing URLs", "visible failure-injection URL form")
        dispatch_insert_trigger = install_failure_trigger(container, run_id, "dispatch_insert", "chatgpt_dispatch_requests",
            "INSERT", f"NEW.user_id='{account_a['userId']}'::uuid AND NEW.action_type='job.inspect_url' AND NEW.display_title='Inspect 2 job listings'")
        failure_triggers.append(dispatch_insert_trigger)
        failed_batch_id, failed_submit = submit_visible_batch(observer, hwnd, chrome.pid, evidence, display, recovery_urls,
                                                              "02-dispatch-insert-failure.png")
        failed_error = wait_visible_form_error(observer)
        after_inspection_insert_failure = database_batch(container, failed_batch_id)
        error_text = str(failed_error.get("error", ""))
        if after_inspection_insert_failure.get("inspectionCount") != 2 \
                or after_inspection_insert_failure.get("dispatchRowCount") != 0 \
                or after_inspection_insert_failure.get("distinctDispatchCount") != 0 \
                or failed_batch_id != read_local_batch_id(observer) \
                or "dispatch and delivery state could not be confirmed" not in error_text.lower() \
                or "no chatgpt message was sent" in error_text.lower():
            raise RuntimeError("A post-insert dispatch failure did not preserve an uncertain-but-recoverable batch safely: "
                               + json.dumps({"error": failed_error, "database": after_inspection_insert_failure}, sort_keys=True))
        remove_failure_trigger(container, dispatch_insert_trigger)
        report["databaseFailureInjections"].append({"point": "after_inspection_rows_before_dispatch_insert", "result": "RECOVERED",
            "trigger": dispatch_insert_trigger["trigger"], "removedImmediately": dispatch_insert_trigger["removed"],
            "httpFailure": failed_error, "persistedInspections": after_inspection_insert_failure.get("inspectionCount"),
            "durableDispatchRowsBeforeRetry": after_inspection_insert_failure.get("dispatchRowCount"),
            "userVisibleErrorDidNotClaimNoMessageWasSent": True})
        report["screenshots"].append(screenshot(evidence, "02-dispatch-insert-failure.png", hwnd, chrome.pid, display))

        # Navigate with the visible JobHuntAI controls. This also avoids
        # treating an omnibox keystroke as proof when Chrome fails to take the
        # keyboard focus after an inline form error.
        arm_native_link_readback(observer)
        jobs_navigation = desktop.native_click_selector(observer, hwnd, chrome.pid, 'a.secondaryButton[href="/jobs"]')
        wait_jobs_workspace(observer)
        jobs_click_readback = native_link_readback(observer)
        if not jobs_click_readback or jobs_click_readback.get("href") != "/jobs" or jobs_click_readback.get("trusted") is not True:
            raise RuntimeError("The native View job pool click did not produce a trusted exact-link event: "
                               + json.dumps({"click": jobs_navigation, "readback": jobs_click_readback}, sort_keys=True))
        add_job_navigation = native_history_back(hwnd, chrome.pid)
        reopened_import_state = wait_import_page(observer, "reopened URL import form after interruption")
        desktop.press_key(0x52, ctrl=True)
        reopened_import_state = wait_import_page(observer, "refreshed URL import form after interruption")
        recovered_fields = wait_restored_batch(observer, failed_batch_id, recovery_urls)

        # Recreate the historic state where the generic dispatch committed but the
        # route stopped before linking it. A failing link retry must leave the
        # durable dispatch intact and never claim that no message was sent.
        failed_items = after_inspection_insert_failure.get("items", [])
        request_ids = [str(item.get("requestId")) for item in failed_items]
        source_urls = [str(item.get("sourceUrl")) for item in failed_items]
        assessment_as_of = failed_items[0].get("assessmentAsOf") if failed_items else None
        if len(request_ids) != 2 or not isinstance(assessment_as_of, str):
            raise RuntimeError("The inserted failure batch could not be read back to reproduce its exact instruction.")
        orphan_instruction = node_job_url_instruction(repo, source_urls, request_ids, failed_batch_id, assessment_as_of, True)
        user_a_token_for_recovery = onboarding.login_token(api_url, publishable_key, account_a)
        recovery_headers = {"apikey": publishable_key, "authorization": "Bearer " + user_a_token_for_recovery,
                            "content-type": "application/json", "prefer": "return=representation"}
        orphan_status, orphan_dispatch = safe_json_request(api_url + "/rest/v1/rpc/create_chatgpt_dispatch_request_with_website_instruction",
            method="POST", body={"p_action_type": "job.inspect_url", "p_subject_refs": {"inspection_id": request_ids[0]},
                "p_origin": "user_click", "p_display_title": "Inspect 2 job listings",
                "p_idempotency_key": "job.inspect_url.batch:" + failed_batch_id, "p_priority": 70,
                "p_website_instruction": orphan_instruction}, headers=recovery_headers)
        orphan_id = orphan_dispatch.get("id") if isinstance(orphan_dispatch, dict) else None
        orphan_state = database_batch(container, failed_batch_id)
        if orphan_status != 200 or not isinstance(orphan_id, str) or orphan_state.get("dispatchRowCount") != 1 \
                or orphan_state.get("distinctDispatchCount") != 0:
            raise RuntimeError("The local authenticated setup could not establish the scoped historic dispatch-before-link recovery fixture: "
                               + json.dumps({"httpStatus": orphan_status, "database": orphan_state}, sort_keys=True))
        link_trigger = install_failure_trigger(container, run_id, "dispatch_link", "job_url_inspection_requests",
            "UPDATE OF dispatch_request_id", f"NEW.user_id='{account_a['userId']}'::uuid AND NEW.batch_id='{failed_batch_id}'::uuid AND OLD.dispatch_request_id IS NULL AND NEW.dispatch_request_id IS NOT NULL")
        failure_triggers.append(link_trigger)
        link_failure_retry = resubmit_visible_batch(observer, hwnd, chrome.pid, len(recovery_urls), failed_batch_id)
        link_failure_error = wait_visible_form_error(observer)
        after_link_failure = database_batch(container, failed_batch_id)
        link_error_text = str(link_failure_error.get("error", ""))
        if after_link_failure.get("dispatchRowCount") != 1 or after_link_failure.get("batchDispatchId") != orphan_id \
                or after_link_failure.get("distinctDispatchCount") != 0 \
                or "no chatgpt message was sent" in link_error_text.lower():
            raise RuntimeError("The link failure did not preserve one accurately reported orphan dispatch for recovery: "
                               + json.dumps({"error": link_failure_error, "database": after_link_failure}, sort_keys=True))
        remove_failure_trigger(container, link_trigger)
        report["databaseFailureInjections"].append({"point": "after_dispatch_commit_before_inspection_links", "result": "RECOVERED",
            "trigger": link_trigger["trigger"], "removedImmediately": link_trigger["removed"],
            "durableDispatchId": orphan_id, "linkedInspectionCountBeforeRecovery": after_link_failure.get("distinctDispatchCount"),
            "userVisibleErrorDidNotClaimNoMessageWasSent": True})
        linked_retry = resubmit_visible_batch(observer, hwnd, chrome.pid, len(recovery_urls), failed_batch_id)
        linked_state = database_batch(container, failed_batch_id)
        if linked_state.get("dispatchRowCount") != 1 or linked_state.get("batchDispatchId") != orphan_id \
                or linked_state.get("distinctDispatchCount") != 1 \
                or any(item.get("dispatchId") != orphan_id for item in linked_state.get("items", [])):
            raise RuntimeError("A retry after page reopen did not link every row to exactly the original dispatch: "
                               + json.dumps({"retry": linked_retry, "database": linked_state}, sort_keys=True))
        recovered_provider = controlled_complete(api_url, device_id, device_token, bridge_version, capabilities,
                                                  "scored_fit", run_id, orphan_id)
        recovered_ui = wait_batch(observer, failed_batch_id, timeout=90)
        recovered_database = database_batch(container, failed_batch_id)
        if recovered_database.get("distinctDispatchCount") != 1 or recovered_database.get("dispatchRowCount") != 1 \
                or recovered_database.get("inspectionCount") != 2 \
                or any(item.get("fitResponseHash") != recovered_provider.get("responseHash") for item in recovered_database.get("items", [])):
            raise RuntimeError("The recovered dispatch did not produce one exact captured response and saved fit for the full batch.")
        report["workflow"].append({"name": "failure_injection_retry_after_import_page_reopen", "result": "CONTROLLED PASS",
            "sameBatchIdRestored": recovered_fields.get("batchId") == failed_batch_id,
            "sameSourceUrlsRestored": recovered_fields.get("urls") == recovery_urls,
            "nativeNavigateToPool": jobs_navigation, "nativePoolLinkReadback": jobs_click_readback,
            "nativeNavigateBackToImport": add_job_navigation, "reopenedPage": reopened_import_state,
            "nativeTrustedLinkReadbackBeforeLeaving": jobs_click_readback,
            "firstDispatchInsertFailure": failed_submit, "firstFailureState": after_inspection_insert_failure,
            "orphanDispatchHttpStatus": orphan_status, "linkFailureRetry": link_failure_retry,
            "linkFailureState": after_link_failure, "successfulRetry": linked_retry,
            "recoveredDispatchId": orphan_id, "controlledBridge": recovered_provider,
            "batch": summarize_batch(recovered_ui), "database": recovered_database,
            "externalChatGptOrMessages": 0})
        report["screenshots"].append(screenshot(evidence, "03-recovered-batch-after-interruption.png", hwnd, chrome.pid, display))

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

        navigate_jobs_via_native_link(observer, hwnd, chrome.pid)
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
        target_request_id = after_replay.get("items", [{}])[0].get("requestId")
        single_entry_read = app_data(observer, "/api/jobs/inspect?id=" + urllib.parse.quote(str(target_request_id), safe=""))
        single_entry_body = single_entry_read.get("data", {}) if isinstance(single_entry_read.get("data"), dict) else {}
        if single_entry_read.get("status") != 200 or single_entry_body.get("inspection", {}).get("id") != target_request_id \
                or "items" in single_entry_body:
            raise RuntimeError("The single-entry status read did not return only its requested row after reconciling the batch.")
        single_read_db = database_batch(container, batch_id)
        if single_read_db.get("inspectionCount") != 2 or any(item.get("fitStatus") in (None, "pending") for item in single_read_db.get("items", [])):
            raise RuntimeError("Reading one inspection did not reconcile the complete owner-scoped batch.")
        simultaneous_batch_path = "/api/jobs/inspect?batchId=" + urllib.parse.quote(batch_id, safe="")
        simultaneous_reads = observer.evaluate(
            "Promise.all(" + json.dumps([simultaneous_batch_path, simultaneous_batch_path])
            + ".map(async path=>{const response=await fetch(path,{cache:'no-store'});const body=await response.json();"
              "return {status:response.status,ok:body.ok===true,itemCount:Array.isArray(body.items)?body.items.length:0}}))"
            ".then(rows=>JSON.stringify(rows))"
        )
        primary_db = database_batch(container, batch_id)
        terminal_timestamps_stable = all(primary_db.get(key) == single_read_db.get(key) for key in
            ("fitBatchUpdatedAt", "fitChunkUpdatedAt", "fitItemUpdatedAt")) and [
                item.get("updatedAt") for item in primary_db.get("items", [])
            ] == [item.get("updatedAt") for item in single_read_db.get("items", [])]
        if not isinstance(simultaneous_reads, list) or len(simultaneous_reads) != 2 \
                or any(item.get("status") != 200 or not item.get("ok") or item.get("itemCount") != 2 for item in simultaneous_reads) \
                or not terminal_timestamps_stable:
            raise RuntimeError("Concurrent terminal batch reads changed saved timestamps or failed to remain idempotent: "
                               + json.dumps({"reads": simultaneous_reads, "before": single_read_db, "after": primary_db}, sort_keys=True))
        primary_result = wait_batch(observer, batch_id, timeout=90)
        primary_db = database_batch(container, batch_id)
        statuses = [item.get("fitStatus") for item in primary_db.get("items", [])]
        unknown_primary_item = next((item for item in primary_db.get("items", []) if item.get("fitStatus") == "insufficient_memory"), {})
        eligibility_notes = unknown_primary_item.get("eligibilityNotes")
        if isinstance(eligibility_notes, str):
            try: eligibility_notes = json.loads(eligibility_notes)
            except json.JSONDecodeError: eligibility_notes = []
        if primary_db.get("distinctDispatchCount") != 1 or primary_db.get("inspectionCount") != 2 \
                or primary_db.get("distinctJobCount") != 2 or sorted(statuses) != ["assessed", "insufficient_memory"] \
                or any(item.get("listing", {}).get("snapshotIndustry") != "Synthetic QA" for item in primary_db.get("items", [])) \
                or any(item.get("matchHash") is not True for item in primary_db.get("items", [])) \
                or unknown_primary_item.get("fitScore") is not None \
                or unknown_primary_item.get("analysisEligibility") != "unknown" \
                or not any("verify legal or work-authorisation requirements yourself" in str(note).lower()
                           for note in (eligibility_notes if isinstance(eligibility_notes, list) else [])):
            raise RuntimeError("The captured two-listing result failed exact dispatch, identity, fit, or response-hash verification: "
                               + json.dumps({"database": primary_db, "statuses": statuses,
                                             "unknownFit": unknown_primary_item}, sort_keys=True))
        report["workflow"].append({"name": "same_response_extraction_and_initial_fit_saved", "result": "CONTROLLED PASS",
                                   "evidenceLevel": "real local Supabase/Edge persistence with controlled synthetic provider; not real ChatGPT",
                                   "controlledBridge": controlled, "batch": summarize_batch(primary_result),
                                   "database": primary_db})
        report["workflow"].append({"name": "single_entry_and_simultaneous_terminal_refresh_reconciliation", "result": "PASS",
                                    "singleEntryHttpStatus": single_entry_read.get("status"),
                                    "singleEntryResponseOnly": True, "entireBatchFitRowsFinalBeforeBatchRead": True,
                                    "simultaneousBatchReadCount": len(simultaneous_reads),
                                    "terminalDatabaseTimestampsUnchanged": terminal_timestamps_stable,
                                    "singleEntryReconciliationDatabase": single_read_db})
        report["screenshots"].append(screenshot(evidence, "05-primary-batch-completed.png", hwnd, chrome.pid, display))

        # Pause UI polling after capture, then fail one sibling's fit-link write.
        # A single-entry read must still reconcile the entire owned batch; after
        # the injected fault is removed, replaying that captured response saves
        # the sibling without creating another dispatch or response.
        partial_write_urls = ["https://jobs.example.test/m04/partial-write-good", "https://jobs.example.test/m04/partial-write-retry"]
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/jobs/add")
        wait_text(observer, "Import from job listing URLs", "visible partial-write retry test form")
        partial_write_batch, partial_write_submit = submit_visible_batch(observer, hwnd, chrome.pid, evidence, display,
            partial_write_urls, "06-partial-fit-write-queued.png")
        partial_write_before = database_batch(container, partial_write_batch)
        partial_write_dispatch = partial_write_before.get("batchDispatchId")
        partial_write_first_id = str(partial_write_before.get("items", [{}])[0].get("requestId"))
        partial_write_second_id = str(partial_write_before.get("items", [{}, {}])[1].get("requestId"))
        partial_write_pool_navigation = navigate_jobs_via_native_link(observer, hwnd, chrome.pid)
        partial_write_provider = controlled_complete(api_url, device_id, device_token, bridge_version, capabilities,
            "scored_fit", run_id, partial_write_dispatch)
        partial_fit_trigger = install_failure_trigger(container, run_id, "fit_write", "job_url_inspection_requests",
            "UPDATE OF initial_fit_response_hash", f"NEW.id='{partial_write_second_id}'::uuid AND OLD.initial_fit_response_hash IS NULL AND NEW.initial_fit_response_hash IS NOT NULL")
        failure_triggers.append(partial_fit_trigger)
        partial_single_read = app_data(observer, "/api/jobs/inspect?id=" + urllib.parse.quote(partial_write_first_id, safe=""))
        partial_after_failed_write = database_batch(container, partial_write_batch)
        partial_states = [item.get("fitStatus") for item in partial_after_failed_write.get("items", [])]
        if partial_single_read.get("status") != 200 or partial_single_read.get("data", {}).get("inspection", {}).get("id") != partial_write_first_id \
                or partial_after_failed_write.get("inspectionCount") != 2 \
                or partial_after_failed_write.get("distinctDispatchCount") != 1 \
                or sorted(str(value) for value in partial_states) != ["assessed", "pending"] \
                or sum(bool(item.get("fitResponseHash")) for item in partial_after_failed_write.get("items", [])) != 1:
            raise RuntimeError("The injected sibling write did not leave one exact saved fit and one safely retryable pending sibling: "
                               + json.dumps({"singleRead": partial_single_read.get("status"), "database": partial_after_failed_write}, sort_keys=True))
        remove_failure_trigger(container, partial_fit_trigger)
        report["databaseFailureInjections"].append({"point": "after_exact_response_capture_during_sibling_fit_persistence", "result": "RECOVERED",
            "trigger": partial_fit_trigger["trigger"], "removedImmediately": partial_fit_trigger["removed"],
            "singleEntryReadReconciledBothRows": True, "fitStatesBeforeRetry": partial_states,
            "oneExactFitHashSavedBeforeRetry": True})
        retry_single_read = app_data(observer, "/api/jobs/inspect?id=" + urllib.parse.quote(partial_write_first_id, safe=""))
        partial_after_replay = database_batch(container, partial_write_batch)
        if retry_single_read.get("status") != 200 or partial_after_replay.get("distinctDispatchCount") != 1 \
                or partial_after_replay.get("dispatchRowCount") != 1 \
                or partial_after_replay.get("fitAnalysisCount") != 2 \
                or partial_after_replay.get("fitAnalysisDistinctCount") != 2 \
                or any(item.get("fitStatus") != "assessed" or item.get("fitResponseHash") != partial_write_provider.get("responseHash")
                       for item in partial_after_replay.get("items", [])):
            raise RuntimeError("A replay of the already-captured batch did not finalize both siblings without a duplicate dispatch: "
                               + json.dumps(partial_after_replay, sort_keys=True))
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/jobs/add")
        wait_text(observer, "Import progress", "visible recovered sibling fit state")
        wait_batch(observer, partial_write_batch, timeout=45)
        report["workflow"].append({"name": "single_entry_partial_sibling_failure_replays_captured_response", "result": "CONTROLLED PASS",
            "nativeSubmit": partial_write_submit, "controlledBridge": partial_write_provider,
            "firstSingleEntryReadHttpStatus": partial_single_read.get("status"),
            "firstFitStates": partial_states, "retrySingleEntryReadHttpStatus": retry_single_read.get("status"),
            "replayedResponseHashUnchanged": all(item.get("fitResponseHash") == partial_write_provider.get("responseHash") for item in partial_after_replay.get("items", [])),
            "oneDispatchAndTwoDistinctFitAnalyses": True, "database": partial_after_replay})
        report["screenshots"].append(screenshot(evidence, "07-partial-fit-sibling-recovered.png", hwnd, chrome.pid, display))

        # Keep a captured response pending, then change its local fixture listing
        # before recovery. The exact old fit must become terminally invalid and
        # remain unattached to the new listing revision.
        revision_urls = ["https://jobs.example.test/m04/revision-change"]
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/jobs/add")
        wait_text(observer, "Import from job listing URLs", "visible listing-revision recovery form")
        revision_batch, revision_submit = submit_visible_batch(observer, hwnd, chrome.pid, evidence, display,
            revision_urls, "08-listing-revision-queued.png")
        revision_before = database_batch(container, revision_batch)
        revision_item = revision_before.get("items", [{}])[0]
        revision_request_id = str(revision_item.get("requestId"))
        revision_job_dispatch = revision_before.get("batchDispatchId")
        revision_jobs_navigation = navigate_jobs_via_native_link(observer, hwnd, chrome.pid)
        revision_provider = controlled_complete(api_url, device_id, device_token, bridge_version, capabilities,
            "scored_fit", run_id, revision_job_dispatch)
        revision_write_trigger = install_failure_trigger(container, run_id, "revision_fit_write", "job_url_inspection_requests",
            "UPDATE OF initial_fit_response_hash", f"NEW.id='{revision_request_id}'::uuid AND OLD.initial_fit_response_hash IS NULL AND NEW.initial_fit_response_hash IS NOT NULL")
        failure_triggers.append(revision_write_trigger)
        revision_first_read = app_data(observer, "/api/jobs/inspect?id=" + urllib.parse.quote(revision_request_id, safe=""))
        revision_pending = database_batch(container, revision_batch)
        revision_pending_item = revision_pending.get("items", [{}])[0]
        if revision_first_read.get("status") != 200 or revision_pending_item.get("fitStatus") != "pending" \
                or revision_pending_item.get("jobId") is None or revision_pending_item.get("fitResponseHash") is not None:
            raise RuntimeError("The revision-change fixture did not leave the captured result pending after its injected fit-link failure.")
        remove_failure_trigger(container, revision_write_trigger)
        changed_job = mutate_synthetic_job_revision(container, str(revision_pending_item.get("jobId")))
        if not isinstance(changed_job.get("title"), str) or "synthetic revision change" not in changed_job.get("title", "").lower():
            raise RuntimeError("The local synthetic listing revision was not changed before captured-response retry.")
        revision_retry = app_data(observer, "/api/jobs/inspect?id=" + urllib.parse.quote(revision_request_id, safe=""))
        revision_after = database_batch(container, revision_batch)
        revision_final_item = revision_after.get("items", [{}])[0]
        if revision_retry.get("status") != 200 or revision_after.get("dispatchRowCount") != 1 \
                or revision_after.get("distinctDispatchCount") != 1 \
                or revision_final_item.get("fitStatus") != "invalid_response" \
                or revision_final_item.get("fitAnalysisId") is not None \
                or revision_final_item.get("fitResponseHash") != revision_provider.get("responseHash") \
                or "changed after this exact bridge response was captured" not in str(revision_final_item.get("fitError", "")).lower():
            raise RuntimeError("A captured fit retry was attached despite a changed listing revision: "
                               + json.dumps({"database": revision_after}, sort_keys=True))
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/jobs/add")
        wait_text(observer, "Import progress", "visible stale-revision fit outcome")
        wait_batch(observer, revision_batch, timeout=45)
        report["workflow"].append({"name": "captured_response_retry_rejects_changed_listing_revision", "result": "CONTROLLED PASS",
            "nativeSubmit": revision_submit, "controlledBridge": revision_provider,
            "nativeJobsNavigation": revision_jobs_navigation,
            "initialFitLinkFailureHttpStatus": revision_first_read.get("status"), "changedListing": changed_job,
            "retryHttpStatus": revision_retry.get("status"), "fitNotAttachedToChangedListing": revision_final_item.get("fitAnalysisId") is None,
            "exactCapturedResponseHashRetained": revision_final_item.get("fitResponseHash") == revision_provider.get("responseHash"),
            "singleDispatchRetained": revision_after.get("dispatchRowCount") == revision_after.get("distinctDispatchCount") == 1,
            "database": revision_after})
        report["screenshots"].append(screenshot(evidence, "09-listing-revision-fit-withheld.png", hwnd, chrome.pid, display))

        scored_job = next(item["jobId"] for item in summarize_batch(primary_result)["items"] if item["fitStatus"] == "assessed")
        unknown_job = next(item["jobId"] for item in summarize_batch(primary_result)["items"] if item["fitStatus"] == "insufficient_memory")
        user_a_token = onboarding.login_token(api_url, publishable_key, account_a)
        user_a_headers = {"apikey": publishable_key, "authorization": "Bearer " + user_a_token,
                          "content-type": "application/json", "prefer": "return=representation"}
        legacy_queued_id = str(uuid.uuid4())
        legacy_queued_url = f"https://jobs.example.test/m04/legacy-queued-{run_id[:10]}"
        legacy_queued_status, legacy_queued_rows = safe_json_request(api_url + "/rest/v1/job_url_inspection_requests",
            method="POST", body={"id": legacy_queued_id, "user_id": account_a["userId"],
                                  "source_url": legacy_queued_url, "status": "queued"}, headers=user_a_headers)
        legacy_saved_id = str(uuid.uuid4())
        legacy_saved_url = f"https://jobs.example.test/m04/legacy-saved-{run_id[:10]}"
        legacy_saved_status, legacy_saved_rows = safe_json_request(api_url + "/rest/v1/job_url_inspection_requests",
            method="POST", body={"id": legacy_saved_id, "user_id": account_a["userId"],
                                  "source_url": legacy_saved_url, "status": "completed", "job_id": scored_job,
                                  "completed_at": utc_now()}, headers=user_a_headers)
        if legacy_queued_status != 201 or legacy_saved_status != 201 \
                or not isinstance(legacy_queued_rows, list) or legacy_queued_rows[0].get("original_source_url") != legacy_queued_url \
                or legacy_queued_rows[0].get("batch_id") is not None \
                or not isinstance(legacy_saved_rows, list) or legacy_saved_rows[0].get("original_source_url") != legacy_saved_url \
                or legacy_saved_rows[0].get("batch_id") is not None:
            raise RuntimeError("The upgraded schema did not accept the authenticated M03 queued and saved insert shapes without original_source_url: "
                               + json.dumps({"queuedStatus": legacy_queued_status, "savedStatus": legacy_saved_status}, sort_keys=True))
        report["workflow"].append({"name": "authenticated_m03_writer_shape_compatible_after_m04_upgrade", "result": "PASS",
                                    "queuedLegacyInsertHttpStatus": legacy_queued_status,
                                    "savedLegacyInsertHttpStatus": legacy_saved_status,
                                    "triggerFilledOriginalSourceUrl": True, "legacyBatchIdentityRemainsNull": True,
                                    "userJwtUsed": True, "syntheticRowsRemovedWithTestUser": True})
        # Subsequent fixture batches replace the import page's current progress
        # card. Open the exact previously saved job detail with native browser
        # input instead of relying on a stale result link remaining in that card.
        scored_navigation = desktop.native_navigate(observer, hwnd, chrome.pid, app_url + f"/jobs/{scored_job}")
        wait_text(observer, "Fit components", "scored synthetic job detail")
        scored_route = observer.evaluate("location.pathname")
        if scored_route != f"/jobs/{scored_job}":
            raise RuntimeError("Native navigation did not open the exact saved job detail: "
                               + json.dumps({"requested": f"/jobs/{scored_job}", "observed": scored_route}))
        scored_view = observer.evaluate("JSON.stringify({heading:document.querySelector('h1')?.innerText||'',hero:document.querySelector('.scoreHero')?.innerText||'',components:[...document.querySelectorAll('.profileGrid .scoreLine')].slice(0,6).map(x=>x.innerText.trim()),weightedText:document.querySelector('.profileGrid .card .formHint')?.innerText||''})")
        scored_text = json.dumps(scored_view, ensure_ascii=False)
        if "5.5" not in scored_text or "30% of the overall fit" not in scored_text or "20% of the overall fit" not in scored_text:
            raise RuntimeError("The visible synthetic fit details did not show the deterministic 55% weighted score and rubric weights.")
        report["workflow"].append({"name": "visible_weighted_fit_breakdown", "result": "CONTROLLED PASS",
                                   "nativeJobDetailNavigation": scored_navigation,
                                   "exactRouteReadback": scored_route,
                                   "syntheticExpectedWeightedPercent": 55,
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

        # An invalid explanation belongs to its own non-found sibling; it must
        # not turn a valid found result into a batch-wide parser failure.
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/jobs/add")
        wait_text(observer, "Import from job listing URLs", "visible malformed-sibling-reason test form")
        malformed_reason_urls = ["https://jobs.example.test/m04/malformed-reason-good", "https://jobs.example.test/m04/malformed-reason-bad"]
        malformed_reason_batch, malformed_reason_submit = submit_visible_batch(observer, hwnd, chrome.pid, evidence, display,
            malformed_reason_urls, "13a-malformed-nonfound-reason-queued.png")
        malformed_reason_before = database_batch(container, malformed_reason_batch)
        malformed_reason_provider = controlled_complete(api_url, device_id, device_token, bridge_version, capabilities,
            "malformed_nonfound_reason", run_id, malformed_reason_before.get("batchDispatchId"))
        malformed_reason_ui = wait_batch(observer, malformed_reason_batch, timeout=90)
        malformed_reason_db = database_batch(container, malformed_reason_batch)
        malformed_reason_states = {(item.get("status"), item.get("fitStatus")) for item in malformed_reason_db.get("items", [])}
        if not malformed_reason_provider.get("captured") or malformed_reason_db.get("inspectionCount") != 2 \
                or malformed_reason_db.get("dispatchRowCount") != 1 or malformed_reason_db.get("distinctJobCount") != 1 \
                or ("completed", "insufficient_memory") not in malformed_reason_states \
                or ("failed", "listing_unavailable") not in malformed_reason_states \
                or any(item.get("fitResponseHash") != malformed_reason_provider.get("responseHash") for item in malformed_reason_db.get("items", [])):
            raise RuntimeError("A malformed non-found reason incorrectly discarded a valid sibling or escaped its response identity: "
                               + json.dumps({"capture": malformed_reason_provider, "database": malformed_reason_db}, sort_keys=True))
        report["workflow"].append({"name": "malformed_nonfound_reason_isolated_to_one_sibling", "result": "CONTROLLED PASS",
            "nativeSubmit": malformed_reason_submit, "controlledBridge": malformed_reason_provider,
            "batch": summarize_batch(malformed_reason_ui), "database": malformed_reason_db,
            "edgeIngestionAndWebReconciliationBothAcceptedSiblingBoundary": True})
        report["screenshots"].append(screenshot(evidence, "13b-malformed-nonfound-reason-partial-result.png", hwnd, chrome.pid, display))

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

        # Reimport a tracked URL through a different tracking variant. It must
        # preserve the raw submitted URL while reusing the existing vacancy.
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/jobs/add")
        wait_text(observer, "Import from job listing URLs", "visible tracking-variant reimport form")
        jobs_before_reimport = read_user_counts(container, account_a["userId"]).get("jobs")
        reimport_url = duplicate_base + "?fbclid=m04synthetic"
        reimport_batch, reimport_submit = submit_visible_batch(observer, hwnd, chrome.pid, evidence, display,
            [reimport_url], "17a-tracking-variant-reimport-queued.png")
        reimport_before = database_batch(container, reimport_batch)
        reimport_provider = controlled_complete(api_url, device_id, device_token, bridge_version, capabilities,
            "scored_fit", run_id, reimport_before.get("batchDispatchId"))
        reimport_ui = wait_batch(observer, reimport_batch, timeout=90)
        reimport_after = database_batch(container, reimport_batch)
        jobs_after_reimport = read_user_counts(container, account_a["userId"]).get("jobs")
        reimport_item = reimport_after.get("items", [{}])[0]
        prior_duplicate_job = duplicate_after.get("items", [{}])[0].get("jobId")
        if reimport_after.get("inspectionCount") != 1 or reimport_after.get("distinctJobCount") != 1 \
                or reimport_item.get("jobId") != prior_duplicate_job \
                or reimport_item.get("sourceUrl") != duplicate_base \
                or reimport_item.get("originalSourceUrl") != reimport_url \
                or jobs_after_reimport != jobs_before_reimport:
            raise RuntimeError("Tracking-variant reimport did not preserve provenance and reuse the same owned vacancy: "
                               + json.dumps({"before": duplicate_after, "after": reimport_after,
                                             "jobCountBefore": jobs_before_reimport, "jobCountAfter": jobs_after_reimport}, sort_keys=True))
        report["workflow"].append({"name": "tracking_variant_reimport_reuses_existing_job_and_keeps_source", "result": "CONTROLLED PASS",
            "nativeSubmit": reimport_submit, "controlledBridge": reimport_provider, "batch": summarize_batch(reimport_ui),
            "jobCountUnchanged": jobs_before_reimport == jobs_after_reimport, "priorJobId": prior_duplicate_job,
            "reimportedJobId": reimport_item.get("jobId"), "originalSourceUrl": reimport_item.get("originalSourceUrl"),
            "normalizedSourceUrl": reimport_item.get("sourceUrl"), "database": reimport_after})
        report["screenshots"].append(screenshot(evidence, "17b-tracking-variant-reimport-result.png", hwnd, chrome.pid, display))

        # Two distinct URLs that resolve to the same Greenhouse vacancy retain
        # both entry/response identities but share one job and one v4 analysis.
        mirror_urls = ["https://jobs.example.test/m04/mirror-entry-a", "https://jobs.example.test/m04/mirror-entry-b"]
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/jobs/add")
        wait_text(observer, "Import from job listing URLs", "visible ATS-mirror identity form")
        mirror_batch, mirror_submit = submit_visible_batch(observer, hwnd, chrome.pid, evidence, display,
            mirror_urls, "17c-same-ats-mirror-queued.png")
        mirror_before = database_batch(container, mirror_batch)
        mirror_provider = controlled_complete(api_url, device_id, device_token, bridge_version, capabilities,
            "same_ats_mirror", run_id, mirror_before.get("batchDispatchId"))
        mirror_ui = wait_batch(observer, mirror_batch, timeout=90)
        mirror_after = database_batch(container, mirror_batch)
        mirror_items = mirror_after.get("items", [])
        mirror_snapshot_requests = sorted({str(item.get("listing", {}).get("inspectionRequestId")) for item in mirror_items})
        if mirror_after.get("inspectionCount") != 2 or mirror_after.get("distinctDispatchCount") != 1 \
                or mirror_after.get("distinctJobCount") != 1 or mirror_after.get("fitAnalysisCount") != 2 \
                or mirror_after.get("fitAnalysisDistinctCount") != 1 \
                or len({item.get("jobId") for item in mirror_items}) != 1 \
                or [item.get("sourceUrl") for item in mirror_items] != mirror_urls \
                or [item.get("originalSourceUrl") for item in mirror_items] != mirror_urls \
                or any(item.get("fitResponseHash") != mirror_provider.get("responseHash") or item.get("provenanceRecorded") != "true" for item in mirror_items) \
                or mirror_snapshot_requests != [str(mirror_items[-1].get("requestId"))] \
                or any(item.get("listing", {}).get("externalJobId") != "ROLE-431"
                       or item.get("listing", {}).get("atsProvider") != "Greenhouse"
                       or item.get("listing", {}).get("resolvedListingUrl") != "https://greenhouse.example.test/jobs/role-431"
                       or item.get("listing", {}).get("salarySource") != "advertised"
                       or item.get("listing", {}).get("salaryMin") != 55000
                       or item.get("listing", {}).get("salaryMax") != 65000
                       or not item.get("listing", {}).get("postedAt")
                       or item.get("listing", {}).get("closesAt") is not None
                       or not item.get("listing", {}).get("postedAtSourceUrl")
                       or not item.get("listing", {}).get("postedAtEvidence")
                       for item in mirror_items):
            raise RuntimeError("ATS mirror identity/provenance, one-analysis reuse, advertised salary, or date evidence failed: "
                               + json.dumps({"provider": mirror_provider, "database": mirror_after}, sort_keys=True))
        report["workflow"].append({"name": "distinct_urls_same_ats_vacancy_deduplicate_deterministically", "result": "CONTROLLED PASS",
            "nativeSubmit": mirror_submit, "controlledBridge": mirror_provider, "batch": summarize_batch(mirror_ui),
            "twoOriginalSourceAndResponseEntries": True, "oneOwnedJob": True, "oneDistinctFitAnalysis": True,
            "currentSnapshotUsesLastBatchEntryDeterministically": mirror_snapshot_requests[0] == str(mirror_items[-1].get("requestId")),
            "advertisedSalaryAndDateEvidenceVerified": True, "closeDateRemainsUnknown": True, "database": mirror_after})
        report["screenshots"].append(screenshot(evidence, "17d-same-ats-mirror-result.png", hwnd, chrome.pid, display))

        # Similar company/title text alone must not collapse two separate jobs.
        similar_urls = ["https://jobs.example.test/m04/similar-role-a", "https://jobs.example.test/m04/similar-role-b"]
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/jobs/add")
        wait_text(observer, "Import from job listing URLs", "visible similar-title distinct-vacancy form")
        similar_batch, similar_submit = submit_visible_batch(observer, hwnd, chrome.pid, evidence, display,
            similar_urls, "17e-similar-title-distinct-queued.png")
        similar_before = database_batch(container, similar_batch)
        similar_provider = controlled_complete(api_url, device_id, device_token, bridge_version, capabilities,
            "similar_title_distinct", run_id, similar_before.get("batchDispatchId"))
        similar_ui = wait_batch(observer, similar_batch, timeout=90)
        similar_after = database_batch(container, similar_batch)
        similar_items = similar_after.get("items", [])
        if similar_after.get("distinctJobCount") != 2 or len({item.get("jobId") for item in similar_items}) != 2 \
                or len({item.get("listing", {}).get("title") for item in similar_items}) != 1 \
                or len({item.get("listing", {}).get("company") for item in similar_items}) != 1 \
                or any(item.get("listing", {}).get("externalJobId") is not None for item in similar_items):
            raise RuntimeError("Similar company/title values incorrectly merged independent vacancies: "
                               + json.dumps(similar_after, sort_keys=True))
        report["workflow"].append({"name": "similar_company_title_does_not_merge_distinct_vacancies", "result": "CONTROLLED PASS",
            "nativeSubmit": similar_submit, "controlledBridge": similar_provider, "batch": summarize_batch(similar_ui),
            "sameCompanyAndTitle": True, "distinctExactSourceUrls": True, "differentOwnedJobIds": True,
            "database": similar_after})
        report["screenshots"].append(screenshot(evidence, "17f-similar-title-distinct-result.png", hwnd, chrome.pid, display))

        # The source-grounded estimate label and basis must survive persistence.
        estimated_urls = ["https://jobs.example.test/m04/estimated-salary"]
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/jobs/add")
        wait_text(observer, "Import from job listing URLs", "visible salary-estimate provenance form")
        estimate_batch, estimate_submit = submit_visible_batch(observer, hwnd, chrome.pid, evidence, display,
            estimated_urls, "17g-estimated-salary-queued.png")
        estimate_before = database_batch(container, estimate_batch)
        estimate_provider = controlled_complete(api_url, device_id, device_token, bridge_version, capabilities,
            "estimated_salary", run_id, estimate_before.get("batchDispatchId"))
        estimate_ui = wait_batch(observer, estimate_batch, timeout=90)
        estimate_after = database_batch(container, estimate_batch)
        estimated_item = estimate_after.get("items", [{}])[0]
        salary_text = str(estimated_item.get("listing", {}).get("salaryText") or "")
        if estimate_after.get("distinctJobCount") != 1 or estimated_item.get("listing", {}).get("salarySource") != "chatgpt_estimate" \
                or "estimated" not in salary_text.lower() or "not employer-advertised" not in salary_text.lower() \
                or estimated_item.get("listing", {}).get("salaryMin") != 60000:
            raise RuntimeError("The estimated salary was not explicitly labeled and backed by its synthetic basis: "
                               + json.dumps(estimate_after, sort_keys=True))
        report["workflow"].append({"name": "estimated_salary_stays_labeled_and_provenance_backed", "result": "CONTROLLED PASS",
            "nativeSubmit": estimate_submit, "controlledBridge": estimate_provider, "batch": summarize_batch(estimate_ui),
            "salarySource": estimated_item.get("listing", {}).get("salarySource"), "salaryText": salary_text,
            "database": estimate_after})
        report["screenshots"].append(screenshot(evidence, "17h-estimated-salary-result.png", hwnd, chrome.pid, display))

        # Exercise the real URL-import form at precisely 6,000 characters. The
        # Node helper invokes the same TypeScript prompt builder as the route and
        # the persisted ID/time lengths are checked again after submission.
        exact_url, calculated_exact_length = boundary_test_url(repo, 6000, True)
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/jobs/add")
        wait_text(observer, "Import from job listing URLs", "visible exact Bridge-limit form")
        exact_batch, exact_submit = submit_visible_batch(observer, hwnd, chrome.pid, evidence, display,
            [exact_url], "17i-exact-6000-character-queued.png")
        exact_before = database_batch(container, exact_batch)
        exact_item = exact_before.get("items", [{}])[0]
        exact_instruction = node_job_url_instruction(repo, [exact_item.get("sourceUrl", "")],
            [str(exact_item.get("requestId"))], exact_batch, str(exact_item.get("assessmentAsOf")), True)
        if calculated_exact_length != 6000 or js_character_count(exact_instruction) != 6000 \
                or exact_before.get("inspectionCount") != 1 or exact_before.get("dispatchRowCount") != 1 \
                or exact_before.get("distinctDispatchCount") != 1:
            raise RuntimeError("An exact 6,000-character Testing Mode instruction was not accepted as one durable dispatch: "
                               + json.dumps({"calculatedLength": calculated_exact_length, "actualLength": js_character_count(exact_instruction), "database": exact_before}, sort_keys=True))
        exact_provider = controlled_complete(api_url, device_id, device_token, bridge_version, capabilities,
            "scored_fit", run_id, exact_before.get("batchDispatchId"))
        exact_ui = wait_batch(observer, exact_batch, timeout=90)
        exact_after = database_batch(container, exact_batch)
        if exact_after.get("fitAnalysisCount") != 1 or exact_after.get("items", [{}])[0].get("fitResponseHash") != exact_provider.get("responseHash"):
            raise RuntimeError("The exact-boundary instruction did not reconcile its exact captured response and fit.")
        report["workflow"].append({"name": "exact_6000_character_testing_mode_ui_instruction_accepted", "result": "CONTROLLED PASS",
            "nativeSubmit": exact_submit, "instructionCharacters": js_character_count(exact_instruction), "controlledBridge": exact_provider,
            "batch": summarize_batch(exact_ui), "database": exact_after})
        report["screenshots"].append(screenshot(evidence, "17j-exact-6000-character-result.png", hwnd, chrome.pid, display))

        # Both prefix-on and prefix-off 6,001-character instructions must stop
        # before any durable row/fit/dispatch insert, while retaining the field.
        for testing_enabled in (True, False):
            if not testing_enabled:
                desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/diagnostics")
                wait_text(observer, "ChatGPT testing mode", "visible Testing Mode controls for no-prefix boundary check")
                toggle_off = m03.native_checkbox(observer, hwnd, chrome.pid,
                    "section.diagnosticCooldownCard:first-of-type input[type=checkbox]", False)
                wait_text(observer, "Testing mode is off", "Testing Mode disabled for a no-prefix preflight")
                mode_off = app_data(observer, "/api/diagnostics/testing-mode")
                if mode_off.get("status") != 200 or mode_off.get("data", {}).get("enabled") is not False:
                    raise RuntimeError("Testing Mode could not be disabled for the no-prefix preflight-only case.")
            boundary_url_value, exact_base_length = boundary_test_url(repo, 6000, testing_enabled)
            boundary_url_value += "a"
            expected_over_limit = exact_base_length + 1
            target_length = 6001
            desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/jobs/add")
            wait_text(observer, "Import from job listing URLs", "visible over-limit instruction form")
            counts_before_boundary = read_user_counts(container, account_a["userId"])
            field_input(observer, hwnd, chrome.pid, "input[name=sourceUrl-1]", boundary_url_value)
            boundary_click = native_click_text(observer, hwnd, chrome.pid, "Inspect with ChatGPT")
            boundary_error = wait_visible_form_error(observer)
            counts_after_boundary = read_user_counts(container, account_a["userId"])
            retained_boundary = observer.evaluate("JSON.stringify({value:document.querySelector('input[name=sourceUrl-1]')?.value||'',error:document.querySelector('.formError')?.innerText||''})")
            actual_over_limit = exact_base_length + 1
            if expected_over_limit != target_length or actual_over_limit != target_length \
                    or counts_before_boundary != counts_after_boundary \
                    or retained_boundary.get("value") != boundary_url_value \
                    or str(target_length) + " characters, exceeding the 6000-character" not in str(boundary_error.get("error", "")):
                raise RuntimeError("The 6,001-character preflight did not preserve its editable input without creating durable state: "
                                   + json.dumps({"testingMode": testing_enabled, "expectedLength": expected_over_limit,
                                                 "actualLength": actual_over_limit, "error": boundary_error,
                                                 "before": counts_before_boundary, "after": counts_after_boundary,
                                                 "retainedCharacters": len(retained_boundary.get("value", ""))}, sort_keys=True))
            report["workflow"].append({"name": "over_limit_6001_characters_preflight_without_persistence",
                "result": "PASS", "testingModeEnabled": testing_enabled, "nativeClick": boundary_click,
                "instructionCharacters": actual_over_limit, "visibleError": boundary_error,
                "allDurableCountsUnchanged": True, "editableInputRetained": True})
            report["screenshots"].append(screenshot(evidence,
                "17k-over-limit-testing-prefix.png" if testing_enabled else "17l-over-limit-no-prefix.png", hwnd, chrome.pid, display))
            if not testing_enabled:
                desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/diagnostics")
                wait_text(observer, "ChatGPT testing mode", "visible Testing Mode controls after no-prefix preflight")
                toggle_on = m03.native_checkbox(observer, hwnd, chrome.pid,
                    "section.diagnosticCooldownCard:first-of-type input[type=checkbox]", True)
                wait_text(observer, "Testing mode is on", "Testing Mode restored after no-prefix preflight")
                mode_on = app_data(observer, "/api/diagnostics/testing-mode")
                if mode_on.get("status") != 200 or mode_on.get("data", {}).get("enabled") is not True:
                    raise RuntimeError("Testing Mode was not restored after the no-prefix boundary check.")
                report["workflow"].append({"name": "testing_mode_restored_after_preflight", "result": "PASS",
                    "nativeToggle": toggle_on, "enabledReadback": True})

        # The public API must reject eleven items too, even if a caller bypasses
        # the form's ten-row control. No writes are permitted on that path.
        eleven_urls = [f"https://jobs.example.test/m04/eleven/{index}" for index in range(11)]
        eleven_before = read_user_counts(container, account_a["userId"])
        eleven_response = app_data(observer, "/api/jobs/inspect", "POST", {"batchId": str(uuid.uuid4()), "sourceUrls": eleven_urls})
        eleven_after = read_user_counts(container, account_a["userId"])
        if eleven_response.get("status") != 400 or eleven_before != eleven_after:
            raise RuntimeError("The import API accepted more than ten URLs or changed durable state before rejecting them.")
        report["workflow"].append({"name": "eleven_url_batch_rejected_before_persistence", "result": "PASS",
            "apiStatus": eleven_response.get("status"), "requestedUrlCount": len(eleven_urls), "durableCountsUnchanged": True})

        # The UI's maximum-size supported batch remains one ten-entry request,
        # one dispatch, and one exact correlated extraction+fit response.
        ten_urls = [f"https://jobs.example.test/m04/ten/{index}" for index in range(10)]
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/jobs/add")
        wait_text(observer, "Import from job listing URLs", "visible supported ten-URL import form")
        ten_batch, ten_submit = submit_visible_batch(observer, hwnd, chrome.pid, evidence, display,
            ten_urls, "17m-ten-url-batch-queued.png")
        ten_before = database_batch(container, ten_batch)
        ui_maximum = observer.evaluate("JSON.stringify({fieldCount:document.querySelectorAll('.urlInspectionField input').length,addButtonVisible:[...document.querySelectorAll('button')].some(x=>x.innerText.trim()==='Add another job URL'&&x.offsetParent!==null)})")
        if ten_before.get("inspectionCount") != 10 or ten_before.get("dispatchRowCount") != 1 \
                or ten_before.get("distinctDispatchCount") != 1 or ui_maximum.get("fieldCount") != 10 \
                or ui_maximum.get("addButtonVisible"):
            raise RuntimeError("The supported ten-URL UI batch did not preserve the one-dispatch contract and 10-row UI cap: "
                               + json.dumps({"database": ten_before, "uiMaximum": ui_maximum}, sort_keys=True))
        ten_provider = controlled_complete(api_url, device_id, device_token, bridge_version, capabilities,
            "scored_fit", run_id, ten_before.get("batchDispatchId"))
        ten_ui = wait_batch(observer, ten_batch, timeout=120)
        ten_after = database_batch(container, ten_batch)
        if ten_after.get("inspectionCount") != 10 or ten_after.get("distinctDispatchCount") != 1 \
                or ten_after.get("distinctJobCount") != 10 or ten_after.get("fitAnalysisCount") != 10 \
                or ten_after.get("fitAnalysisDistinctCount") != 10 \
                or any(item.get("fitStatus") != "assessed" or item.get("fitResponseHash") != ten_provider.get("responseHash")
                       for item in ten_after.get("items", [])):
            raise RuntimeError("The ten-listing response did not create ten distinct fits from one dispatch and one response.")
        report["workflow"].append({"name": "supported_ten_url_batch_one_dispatch_one_correlated_response", "result": "CONTROLLED PASS",
            "nativeSubmit": ten_submit, "visibleUiMaximum": ui_maximum, "controlledBridge": ten_provider,
            "batch": summarize_batch(ten_ui), "database": ten_after})
        report["screenshots"].append(screenshot(evidence, "17n-ten-url-batch-result.png", hwnd, chrome.pid, display))

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
        foreign_request = app_data(observer, "/api/jobs/inspect?id=" + urllib.parse.quote(request_a, safe=""))
        token_b = onboarding.login_token(api_url, publishable_key, account_b)
        token_a = onboarding.login_token(api_url, publishable_key, account_a)
        base_headers = {"apikey": publishable_key, "authorization": "Bearer " + token_b, "accept": "application/json"}
        owner_headers = {"apikey": publishable_key, "authorization": "Bearer " + token_a,
                         "accept": "application/json", "content-type": "application/json"}
        owner_dispatch_status, owner_dispatch_body = safe_json_request(api_url + "/rest/v1/rpc/get_job_url_inspection_batch_dispatch",
            method="POST", body={"p_batch_id": batch_id}, headers=owner_headers)
        foreign_dispatch_status, foreign_dispatch_body = safe_json_request(api_url + "/rest/v1/rpc/get_job_url_inspection_batch_dispatch",
            method="POST", body={"p_batch_id": batch_id}, headers={**base_headers, "content-type": "application/json"})
        request_status, request_rows = safe_json_request(api_url + "/rest/v1/job_url_inspection_requests?select=id&batch_id=eq." + urllib.parse.quote(batch_id), headers=base_headers)
        jobs_status, job_rows = safe_json_request(api_url + "/rest/v1/jobs?select=id&id=eq." + urllib.parse.quote(job_a), headers=base_headers)
        fit_status, fit_rows = safe_json_request(api_url + "/rest/v1/job_analyses?select=id&job_id=eq." + urllib.parse.quote(job_a), headers=base_headers)
        patch_headers = {**base_headers, "content-type": "application/json", "prefer": "return=representation"}
        patch_status, patch_rows = safe_json_request(api_url + "/rest/v1/job_url_inspection_requests?id=eq." + urllib.parse.quote(request_a),
            method="PATCH", body={"initial_fit_status": "assessed"}, headers=patch_headers)
        foreign_rpc_status, foreign_rpc_body = safe_json_request(api_url + "/rest/v1/rpc/create_job_url_inspection_batch_dispatch",
            method="POST", body={"p_batch_id": batch_id, "p_website_instruction": "TEST ONLY synthetic cross-owner boundary probe"}, headers=patch_headers)
        patch_rejected = patch_status in (401, 403)
        patch_empty = patch_status in (200, 204) and not patch_rows
        ownership_state = {"appBatchStatus": foreign_batch.get("status"), "requestHttpStatus": request_status,
                           "requestRows": len(request_rows or []), "jobHttpStatus": jobs_status,
                           "jobRows": len(job_rows or []), "fitHttpStatus": fit_status,
                           "fitRows": len(fit_rows or []), "patchHttpStatus": patch_status,
                           "patchRejected": patch_rejected, "patchEmpty": patch_empty,
                           "foreignRequestStatus": foreign_request.get("status"),
                           "foreignBatchDispatchRpcStatus": foreign_rpc_status,
                           "ownerBatchDispatchReadStatus": owner_dispatch_status,
                           "ownerBatchDispatchIdentityMatches": isinstance(owner_dispatch_body, dict)
                               and owner_dispatch_body.get("id") == primary_db.get("batchDispatchId"),
                           "foreignBatchDispatchReadStatus": foreign_dispatch_status,
                           "foreignBatchDispatchReadReturnedNull": foreign_dispatch_body is None}
        if foreign_batch.get("status") != 404 or request_status != 200 or request_rows \
                or foreign_request.get("status") != 404 \
                or jobs_status != 200 or job_rows or fit_status != 200 or fit_rows \
                or not (patch_rejected or patch_empty) or foreign_rpc_status not in (400, 401, 403, 404) \
                or owner_dispatch_status != 200 or not ownership_state["ownerBatchDispatchIdentityMatches"] \
                or foreign_dispatch_status != 200 or foreign_dispatch_body is not None:
            raise RuntimeError("Local User B could read or change User A's URL batch, job, or fit data: "
                               + json.dumps(ownership_state, sort_keys=True))
        unchanged = database_batch(container, batch_id)
        if unchanged.get("items", [{}])[0].get("fitStatus") != batch_a_first.get("fitStatus"):
            raise RuntimeError("User B's attempted update changed User A's fit status.")
        report["workflow"].append({"name": "two_user_url_job_fit_ownership", "result": "PASS",
                                   "userBAppBatchHttpStatus": foreign_batch.get("status"),
                                   "userBAppRequestHttpStatus": foreign_request.get("status"),
                                   "userBRestRows": {"requests": len(request_rows or []), "jobs": len(job_rows or []), "analyses": len(fit_rows or [])},
                                   "userBPatchHttpStatus": patch_status, "userBatchDispatchRpcStatus": foreign_rpc_status,
                                   "ownerBatchDispatchReadStatus": owner_dispatch_status,
                                   "userBDispatchReadStatus": foreign_dispatch_status,
                                   "userBDispatchReadReturnedNull": foreign_dispatch_body is None,
                                   "userAFitUnchanged": True,
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

        protected_side_effects = {key: counts_after_reanalysis_complete.get(key) for key in
            ("applications", "documentGenerationRequests", "applicationPreparationRequests", "formAgentSessions", "emails")}
        if any(value != 0 for value in protected_side_effects.values()):
            raise RuntimeError("The URL import or selected-job fit test created an application, document, employer-form, preparation, or email record: "
                               + json.dumps(protected_side_effects, sort_keys=True))
        report["workflow"].append({"name": "no_application_document_or_employer_action_created", "result": "PASS",
            "databaseCounts": protected_side_effects,
            "chatgptMemoryChanged": False, "documentGenerated": False, "employerContactedOrSubmitted": False})

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
        traceback = exc.__traceback__
        while traceback and traceback.tb_next:
            traceback = traceback.tb_next
        if traceback:
            report["errorLocation"] = {
                "file": Path(traceback.tb_frame.f_code.co_filename).name,
                "line": traceback.tb_lineno,
                "function": traceback.tb_frame.f_code.co_name,
            }
        report["limitations"].append("The run stopped at the first failed dependent GUI workflow; later dependent steps were not claimed as tested.")
    finally:
        failure_trigger_cleanup_errors = []
        for artifact in failure_triggers:
            try:
                remove_failure_trigger(container, artifact)
            except Exception as cleanup_error:
                failure_trigger_cleanup_errors.append(f"{artifact.get('trigger')}: {type(cleanup_error).__name__}")
        report["cleanup"]["failureInjectionTriggersRemoved"] = not failure_trigger_cleanup_errors
        if failure_trigger_cleanup_errors:
            report["cleanup"]["failureInjectionCleanupErrors"] = failure_trigger_cleanup_errors
            report["result"] = "FAIL_CLEANUP"
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
        else:
            report["cleanup"]["chromeExited"] = True
        if server:
            remaining = desktop.stop_owned_process(server, server_pids, graceful=True)
            report["cleanup"]["serverExited"] = not remaining
        else:
            report["cleanup"]["serverExited"] = True
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
