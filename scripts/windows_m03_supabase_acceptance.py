#!/usr/bin/env python3
"""Run M03 native Windows UI acceptance against disposable local Supabase data."""

from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

import windows_supabase_onboarding_acceptance as onboarding
import windows_web_ui_acceptance as desktop


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def local_json(url: str, method: str = "GET", body: dict | None = None) -> dict:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(url, data=data, headers={"content-type": "application/json"}, method=method)
    with urllib.request.urlopen(request, timeout=15) as response:
        payload = response.read()
    return json.loads(payload) if payload else {}


def seed_synthetic_account(run_id: str, label: str) -> dict:
    api_url = os.environ["JOBHUNT_M03_SUPABASE_URL"].rstrip("/")
    service_key = os.environ["JOBHUNT_M03_SERVICE_KEY"]
    suffix = run_id[:12]
    email = f"m03-{label}-{suffix}@example.test"
    password = secrets.token_urlsafe(28)
    display_name = f"Synthetic User {label.upper()}"
    user_id = onboarding.create_auth_user(api_url, service_key, email, password, display_name)
    account = onboarding.test_account(email, password, user_id, str(uuid.uuid4()), display_name)
    escaped_email = email.replace("'", "''")
    escaped_name = display_name.replace("'", "''")
    sql = (
        "INSERT INTO private.app_memberships(user_id,email,role,status) VALUES "
        f"('{user_id}'::uuid,'{escaped_email}','member','active') ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,role='member',status='active';\n"
        "INSERT INTO public.candidate_profiles(id,user_id,display_name) VALUES "
        f"('{account['profileId']}'::uuid,'{user_id}'::uuid,'{escaped_name}') ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name;\n"
        f"INSERT INTO public.candidate_preferences(profile_id,preferences) VALUES ('{account['profileId']}'::uuid,'{{}}'::jsonb) ON CONFLICT(profile_id) DO NOTHING;"
    )
    onboarding.psql(os.environ["JOBHUNT_M03_DB_CONTAINER"], sql)
    return account


def store_fake_google_grant(account: dict, label: str) -> None:
    token = onboarding.login_token(
        os.environ["JOBHUNT_M03_SUPABASE_URL"],
        os.environ["JOBHUNT_M03_PUBLISHABLE_KEY"],
        account,
    )
    status, _ = onboarding.json_request(
        os.environ["JOBHUNT_M03_SUPABASE_URL"].rstrip("/") + "/rest/v1/rpc/store_gmail_refresh_token",
        "POST",
        {"p_refresh_token": f"m03-local-provider-grant-{label}-{uuid.uuid4().hex}"},
        onboarding.auth_headers(os.environ["JOBHUNT_M03_PUBLISHABLE_KEY"], token),
    )
    if status != 200:
        raise RuntimeError("Authenticated local OAuth-grant fixture could not be stored.")


def browser_json(observer: desktop.CDPObserver, path: str, method: str = "GET", body: dict | None = None) -> dict:
    expression = (
        "(async()=>{const path=" + json.dumps(path) + ";const method=" + json.dumps(method)
        + ";const body=" + json.dumps(body) + ";const init={method,credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json'}};"
        + "if(body!==null)init.body=JSON.stringify(body);const response=await fetch(path,init);let data={};"
        + "try{data=await response.json()}catch{};const dispatch=data.dispatch&&typeof data.dispatch==='object'?data.dispatch:{};"
        + "return JSON.stringify({httpStatus:response.status,ok:data.ok===true,error:typeof data.error==='string'?data.error.slice(0,220):null,"
        + "existing:data.existing===true,runId:typeof data.runId==='string'?data.runId:null,dispatchId:typeof dispatch.id==='string'?dispatch.id:null,"
        + "dispatchState:typeof dispatch.state==='string'?dispatch.state:null,availability:data.availability||null,"
        + "testingPrefix:typeof data.website_instruction==='string'?data.website_instruction.startsWith('TEST ONLY'):false,"
        + "profileTextReturned:typeof data.website_instruction==='string'?/(?:Synthetic User|fixture work authorization)/i.test(data.website_instruction):false});})()"
    )
    result = observer.evaluate(expression)
    if not isinstance(result, dict) or not isinstance(result.get("httpStatus"), int):
        raise RuntimeError("The authenticated loopback API returned an unreadable response.")
    return result


def preference_summary(observer: desktop.CDPObserver) -> dict:
    result = observer.evaluate("""(async()=>{const response=await fetch('/api/search/preferences',{cache:'no-store'});const data=await response.json();const p=data.preferences||{};return JSON.stringify({status:response.status,ok:data.ok===true,mode:p.search_mode||null,roles:Array.isArray(p.target_roles)?p.target_roles:[],families:Array.isArray(p.role_families)?p.role_families:[],seniority:p.target_seniority||null,locations:Array.isArray(p.locations)?p.locations:[],workModes:Array.isArray(p.work_modes)?p.work_modes:[],salary:p.salary||{},sponsorship:p.sponsorship_required===true,postingAge:p.posting_age_policy?.max_days??null,excludedRoles:p.excluded_roles||[],excludedCompanies:p.excluded_companies||[],excludedKeywords:p.excluded_keywords||[],cadence:p.search_cadence||null,timezone:p.search_timezone||null,localTime:p.search_time_local||null,scheduleEnabled:p.search_schedule_enabled===true});})()""")
    if not isinstance(result, dict) or not result.get("ok"):
        raise RuntimeError("Saved search preferences could not be read through the authenticated app route.")
    return result


def wait_body(observer: desktop.CDPObserver, contains: str, description: str, timeout: float = 45) -> dict:
    return onboarding.wait_ui(observer, lambda state: contains in state.get("body", ""), description, timeout)


def wait_scheduled_search_reflection(observer: desktop.CDPObserver, timeout: float = 60) -> dict:
    """Wait for both authenticated history readback and the rendered status."""
    expression = (
        "(async()=>{const response=await fetch('/api/search/runs',{cache:'no-store'});"
        "const body=await response.json();const scheduled=(Array.isArray(body.runs)?body.runs:[])"
        ".filter(run=>run?.trigger==='scheduled').map(run=>({trigger:run.trigger,state:run.state}));"
        "const status=document.querySelector('.searchAutomationCard .searchStatusGrid > div:nth-child(3) strong')?.innerText?.trim()||null;"
        "return JSON.stringify({httpStatus:response.status,ok:body.ok===true,scheduleEnabled:body.schedule?.enabled===true,"
        "lastRunPresent:typeof body.schedule?.lastRunAt==='string',scheduledRuns:scheduled.slice(0,2),visibleStatus:status})})()"
    )
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            last = observer.evaluate(expression)
            runs = last.get("scheduledRuns") if isinstance(last, dict) else None
            if (isinstance(last, dict) and last.get("httpStatus") == 200 and last.get("ok") is True
                    and last.get("scheduleEnabled") is True and last.get("lastRunPresent") is True
                    and isinstance(runs, list) and runs and runs[0].get("state") == "queued"
                    and str(last.get("visibleStatus") or "").lower() == "queued"):
                return last
        except Exception:
            pass
        time.sleep(0.5)
    summary = last if isinstance(last, dict) else None
    raise TimeoutError("The scheduled run did not reach authenticated and rendered UI readback: "
                       + json.dumps(summary, separators=(",", ":")))


def wait_job_pool_sync_button(observer: desktop.CDPObserver, label: str = "Sync now", timeout: float = 30) -> dict:
    expression = (
        "JSON.stringify((()=>{const card=[...document.querySelectorAll('section.settingsCard')]"
        ".find(item=>item.querySelector('.cardHeader h2')?.innerText?.trim()==='Google Sheets');"
        "const button=card?.querySelector('button.primaryButton');return {exists:!!button,label:button?.innerText?.trim()||null,"
        "disabled:button?.disabled===true,badge:card?.querySelector('.cardHeader .badge')?.innerText?.trim()||null}})())"
    )
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = observer.evaluate(expression)
        if (isinstance(last, dict) and last.get("exists") and last.get("label") == label
                and last.get("disabled") is False and last.get("badge") in ("Up to date", "Sync needed")):
            return last
        time.sleep(0.2)
    raise TimeoutError("The Google Sheets action button did not become ready: " + json.dumps(last, separators=(",", ":")))


def arm_native_button_readback(observer: desktop.CDPObserver) -> None:
    observer.evaluate("(() => { window.__m03NativeButtonClicks=[]; document.addEventListener('click',event=>{"
                       "const button=event.target instanceof Element?event.target.closest('button'):null;"
                       "if(button)window.__m03NativeButtonClicks.push({trusted:event.isTrusted,text:button.innerText.trim()});"
                       "},true); return true; })()")


def wait_native_button_readback(observer: desktop.CDPObserver, label: str, timeout: float = 5) -> dict:
    deadline = time.monotonic() + timeout
    last: list[dict] = []
    while time.monotonic() < deadline:
        last = observer.evaluate("JSON.stringify((window.__m03NativeButtonClicks||[]).slice(-8))") or []
        match = next((item for item in reversed(last) if item.get("text") == label), None)
        if match:
            if match.get("trusted") is not True:
                raise RuntimeError("The Google Sheets button click was not a trusted native input event.")
            return match
        time.sleep(0.1)
    raise TimeoutError("No trusted native click reached the " + label + " button.")


def open_job_pool_from_navigation(observer: desktop.CDPObserver, hwnd: int, pid: int, description: str,
                                  expected_text: str, timeout: float = 45) -> dict:
    # Use the app's visible Jobs navigation so a native click both changes the
    # real UI state and avoids silently relying on address-bar input.
    click = desktop.native_click_selector(observer, hwnd, pid, '.nav a[href="/jobs"]')
    wait_body(observer, expected_text, description, timeout)
    return click


def wait_manual_search_button(observer: desktop.CDPObserver, description: str, *, expected_enabled: bool,
                              timeout: float = 30) -> dict:
    deadline = time.monotonic() + timeout
    last_state = None
    while time.monotonic() < deadline:
        state = observer.evaluate("JSON.stringify((()=>{const button=document.querySelector('.manualSearchControl button');"
                                   "const cooldown=document.querySelector('.manualSearchControl .cooldownLabel')?.innerText||'';"
                                   "return {exists:!!button,disabled:button?.disabled===true,label:button?.innerText||'',"
                                   "cooldown,checking:cooldown.includes('Checking availability')}})())")
        if isinstance(state, dict):
            last_state = state
            if state.get("exists") and not state.get("checking") and state.get("disabled") is (not expected_enabled):
                return state
        time.sleep(0.2)
    summary = {key: last_state.get(key) for key in ("exists", "disabled", "label", "cooldown", "checking")} if last_state else None
    raise TimeoutError(f"Timed out waiting for {description}; manual-search control={json.dumps(summary)}")


def wait_manual_search_outcome(observer: desktop.CDPObserver, timeout: float = 35) -> dict:
    deadline = time.monotonic() + timeout
    last_state = None
    while time.monotonic() < deadline:
        state = observer.evaluate("JSON.stringify((()=>{const result=document.querySelector('.manualSearchResult strong')?.innerText||'';"
                                   "const errors=[...document.querySelectorAll('.manualSearchControl .formError')].map(e=>e.innerText.trim()).filter(Boolean);"
                                   "return {result,errors}})())")
        if isinstance(state, dict):
            last_state = state
            if state.get("result") == "Search queued":
                return state
            if state.get("errors"):
                message = str(state["errors"][0])[:240]
                raise RuntimeError("Native Search jobs now displayed an application error: " + message)
        time.sleep(0.2)
    raise TimeoutError("The native Search jobs now click did not reach a queued or visible error state; last state="
                       + json.dumps(last_state))


def read_scoped_manual_search_state(observer: desktop.CDPObserver) -> dict:
    state = observer.evaluate("(async()=>{const response=await fetch('/api/search/manual',{cache:'no-store'});"
                              "const body=await response.json();const scopeId=body.availability?.scopeId||'';"
                              "const key='jobhunt:manual-search-attempt:v1:'+scopeId;"
                              "let attempt={};try{attempt=JSON.parse(localStorage.getItem(key)||'{}')}catch{};"
                              "const button=document.querySelector('.manualSearchControl button');"
                              "return JSON.stringify({scopeId:scopeId||null,runId:typeof attempt.runId==='string'?attempt.runId:null,"
                              "disabled:button?.disabled===true,label:button?.innerText||'',cooldown:document.querySelector('.manualSearchControl .cooldownLabel')?.innerText||''})})()")
    if not isinstance(state, dict) or not state.get("scopeId"):
        raise RuntimeError("Authenticated manual-search storage scope could not be read from the visible app.")
    return state


def ensure_enabled_search_source(observer: desktop.CDPObserver, hwnd: int, pid: int, report: dict, owner: str) -> dict:
    def read_sources() -> dict:
        state = observer.evaluate("(async()=>{const response=await fetch('/api/search/runs',{cache:'no-store'});"
                                  "const body=await response.json();return JSON.stringify({status:response.status,"
                                  "sources:Array.isArray(body.sources)?body.sources.map(source=>({sourceKey:source.source_key,enabled:source.enabled===true})):[]})})()")
        if not isinstance(state, dict) or state.get("status") != 200:
            raise RuntimeError(f"{owner} discovery sources could not be read from the authenticated UI.")
        return state

    state = read_sources()
    native_toggle = None
    if not state["sources"]:
        raise RuntimeError(f"{owner} has no discovery sources after saving Search settings.")
    if not any(source.get("enabled") is True for source in state["sources"]):
        opened = observer.evaluate("document.querySelector('details.searchAutomationDetails')?.open===true")
        if not opened:
            desktop.native_click_selector(observer, hwnd, pid, "details.searchAutomationDetails > summary")
        native_toggle = native_checkbox(observer, hwnd, pid,
                                        "details.searchAutomationDetails .searchSourceList input[type=checkbox]", True)
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            state = read_sources()
            if any(source.get("enabled") is True for source in state["sources"]):
                break
            time.sleep(0.2)
    if not any(source.get("enabled") is True for source in state["sources"]):
        raise RuntimeError(f"{owner} could not enable a discovery source through the visible Search settings UI.")
    result = {"owner": owner, "enabledSourceKeys": [source["sourceKey"] for source in state["sources"] if source.get("enabled") is True],
              "nativeToggle": native_toggle, "authenticatedReadback": True}
    report["workflow"].append({"name": f"{owner.lower().replace(' ', '_')}_discovery_source_ready", "result": "PASS", **result})
    return result


def wait_selector(observer: desktop.CDPObserver, selector: str, description: str, timeout: float = 45, *, enabled: bool = False) -> dict:
    deadline = time.monotonic() + timeout
    last_state = None
    while time.monotonic() < deadline:
        state = observer.evaluate(
            "JSON.stringify((()=>{const e=document.querySelector(" + json.dumps(selector) + ");return {exists:!!e,visible:!!e&&e.getClientRects().length>0,disabled:!!e&&('disabled' in e)&&e.disabled===true}})())"
        )
        if isinstance(state, dict):
            last_state = state
            if state.get("exists") and state.get("visible") and (not enabled or not state.get("disabled")):
                return state
        time.sleep(0.1)
    summary = {key: last_state.get(key) for key in ("exists", "visible", "disabled")} if last_state else None
    raise RuntimeError(f"Timed out waiting for {description}; control state={summary}.")


def verify_created_sheet(observer: desktop.CDPObserver, provider_port: int, *, expected_workbook_count: int,
                         required_tabs: set[str] | None = None) -> tuple[dict, dict]:
    wait_body(observer, "Your JobHuntAI spreadsheet is ready.", "visible successful managed Sheet creation", 70)
    status = browser_private_json(observer, "/api/settings/job-pool-sheet")
    data = status.get("data", {}) if isinstance(status.get("data"), dict) else {}
    sheet = data.get("sheet", {}) if isinstance(data.get("sheet"), dict) else {}
    spreadsheet_url = sheet.get("spreadsheetUrl") if isinstance(sheet.get("spreadsheetUrl"), str) else ""
    path_parts = urllib.parse.urlparse(spreadsheet_url).path.strip("/").split("/") if spreadsheet_url else []
    spreadsheet_id = path_parts[2] if len(path_parts) >= 4 and path_parts[:2] == ["spreadsheets", "d"] else ""
    if status.get("status") != 200 or data.get("googleConnection") != "connected" \
            or sheet.get("configured") is not True or sheet.get("current") is not True or not spreadsheet_id:
        raise RuntimeError("The visible Sheet creation message was not backed by current authenticated Sheet state.")
    workbooks = local_json(f"http://127.0.0.1:{provider_port}/__test/workbooks")
    matching = [item for item in workbooks if isinstance(item, dict) and item.get("id") == spreadsheet_id]
    tabs = {tab.get("title") for tab in matching[0].get("tabs", []) if isinstance(tab, dict)} if matching else set()
    if len(workbooks) != expected_workbook_count or len(matching) != 1 or (required_tabs and not required_tabs.issubset(tabs)):
        raise RuntimeError("The local provider readback did not confirm the expected unique managed workbook and tabs.")
    return matching[0], {"authenticatedReadback": True, "configured": True, "current": True,
                         "providerWorkbookMatched": True, "providerWorkbookCount": len(workbooks),
                         "requiredManagedTabsPresent": required_tabs.issubset(tabs) if required_tabs else True}


def native_fill(observer: desktop.CDPObserver, hwnd: int, pid: int, selector: str, value: str) -> dict:
    action = desktop.native_replace_value(observer, hwnd, pid, selector, value)
    return {"selector": selector, "nativeClick": action.get("click"), "typedLength": len(value),
            "activeElementReadback": True, "valueReadbackRecorded": False}


def native_select_index(observer: desktop.CDPObserver, hwnd: int, pid: int, selector: str, index: int, expected_value: str) -> dict:
    action = desktop.native_click_selector(observer, hwnd, pid, selector)
    desktop.press_key(0x24)  # Home
    for _ in range(index):
        desktop.press_key(0x28)  # Down
    desktop.press_key(0x0D)  # Enter
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline:
        state = observer.evaluate("JSON.stringify({value:document.querySelector(" + json.dumps(selector) + ")?.value||null,focused:document.activeElement===document.querySelector(" + json.dumps(selector) + ")})")
        if state and state.get("value") == expected_value and state.get("focused"):
            return {"selector": selector, "selectedValue": expected_value, "nativeClick": action, "activeElementReadback": True}
        time.sleep(0.08)
    raise RuntimeError("Native keyboard selection did not select the expected search mode or cadence.")


def native_checkbox(observer: desktop.CDPObserver, hwnd: int, pid: int, selector: str, desired: bool) -> dict:
    # Client controls can render before their initial authenticated read finishes.
    # Wait for the actual control to become interactive instead of treating that
    # normal loading window as a failed native click.
    before = None
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        state = observer.evaluate("JSON.stringify((()=>{const e=document.querySelector(" + json.dumps(selector) + ");return {exists:!!e,checked:e?.checked===true,disabled:e?.disabled===true}})())")
        if state and state.get("exists") and not state.get("disabled"):
            before = state
            break
        time.sleep(0.1)
    if before is None:
        raise RuntimeError("Expected checkbox did not become enabled within 15 seconds for native interaction.")
    click = None
    if before["checked"] != desired:
        click = desktop.native_click_selector(observer, hwnd, pid, selector)
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline:
        after = observer.evaluate("JSON.stringify(document.querySelector(" + json.dumps(selector) + ")?.checked===true)")
        if after is desired:
            return {"selector": selector, "desired": desired, "nativeClick": click, "checkedReadback": True}
        time.sleep(0.08)
    raise RuntimeError("Native checkbox input did not persist its expected checked state.")


def save_search_preferences(observer: desktop.CDPObserver, hwnd: int, pid: int, report: dict, *, mode_index: int, mode_value: str, initial: bool = False) -> dict:
    select_action = native_select_index(observer, hwnd, pid, "select[name=searchMode]", mode_index, mode_value)
    advanced = observer.evaluate("document.querySelector('details.searchPreferenceAdvanced')?.open===true")
    if not advanced:
        desktop.native_click_selector(observer, hwnd, pid, "details.searchPreferenceAdvanced > summary")
        if observer.evaluate("document.querySelector('details.searchPreferenceAdvanced')?.open===true") is not True:
            raise RuntimeError("Native input did not open the advanced search preferences.")
    if initial:
        fields = [
            ("input[name=targetRoles]", "Synthetic Data Analyst"),
            ("input[name=roleFamilies]", "Synthetic Analytics"),
            ("input[name=targetSeniority]", "Mid-level"),
            ("input[name=locations]", "London, UK"),
            ("input[name=salaryMinimum]", "50000"),
            ("input[name=salaryTarget]", "65000"),
            ("input[name=salaryCurrency]", "GBP"),
            ("input[name=excludedRoles]", "Commission-only Sales"),
            ("input[name=excludedCompanies]", "Example Test Employer"),
            ("input[name=excludedKeywords]", "unpaid, commission-only"),
            ("input[name=postingAgeDays]", "14"),
        ]
        field_actions = [native_fill(observer, hwnd, pid, selector, value) for selector, value in fields]
        check_actions = [
            native_checkbox(observer, hwnd, pid, ".checkRow input[name=workModes][value=remote]", True),
            native_checkbox(observer, hwnd, pid, "input[name=sponsorshipRequired]", True),
            native_checkbox(observer, hwnd, pid, "input[name=scheduleEnabled]", True),
        ]
        native_select_index(observer, hwnd, pid, "select[name=searchCadence]", 0, "daily")
    else:
        field_actions = []
        check_actions = []
    save = desktop.native_click_selector(observer, hwnd, pid, ".jobPreferencesCard form button.primaryButton")
    body = onboarding.wait_ui(observer, lambda state: "preferences and schedule" in state.get("body", "").lower()
                              and "saved" in state.get("body", "").lower(),
                              "visible search-preferences save acknowledgement", 60)
    summary = preference_summary(observer)
    report["workflow"].append({"name": f"search_preferences_saved_{mode_value}", "result": "PASS",
                               "nativeModeSelection": select_action, "nativeFieldEdits": field_actions,
                               "nativeCheckboxEdits": check_actions, "nativeSaveClick": save,
                               "authenticatedReadback": {"mode": summary["mode"], "rolesRetained": summary["roles"],
                                   "workModes": summary["workModes"], "salaryConfigured": bool(summary["salary"].get("minimum")),
                                   "sponsorship": summary["sponsorship"], "excludedConstraintsRetained": bool(summary["excludedRoles"] and summary["excludedCompanies"] and summary["excludedKeywords"]),
                                   "postingAge": summary["postingAge"], "scheduleEnabled": summary["scheduleEnabled"]},
                               "setupQueued": "ChatGPT setup still needs to be queued" not in body.get("body", "")})
    if summary["mode"] != mode_value:
        raise RuntimeError("The saved search mode did not match the native UI selection.")
    return summary


def launch_chrome(repo: Path, run_root: Path, profile: Path, app_url: str, evidence: Path, *, incognito: bool = False) -> tuple[subprocess.Popen, list[int], desktop.CDPObserver, int, dict]:
    chrome_path = desktop.find_chrome()
    profile_root = profile.resolve()
    if not profile_root.is_relative_to(run_root.resolve()):
        raise RuntimeError("Refusing to launch Chrome outside the M03 test-owned profile.")
    # Chrome leaves DevToolsActivePort in a reused profile after clean exit.
    # Remove this exact marker so a reconnect cannot attach to the previous
    # process's stale port before Chrome publishes its new ephemeral port.
    (profile_root / "DevToolsActivePort").unlink(missing_ok=True)
    chrome_args = [
        str(chrome_path), f"--user-data-dir={profile}", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
        "--remote-allow-origins=http://localhost", "--no-first-run", "--no-default-browser-check", "--disable-sync",
        "--disable-save-password-bubble", "--disable-extensions", "--disable-background-networking",
        "--disable-component-update", "--disable-default-apps", "--no-proxy-server",
        "--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE 127.0.0.1,EXCLUDE localhost",
        "--new-window", app_url + "/login?next=%2Fonboarding",
    ]
    if incognito:
        chrome_args.insert(1, "--incognito")
    chrome = subprocess.Popen(chrome_args, cwd=run_root, env=desktop.safe_environment(run_root), stdout=(evidence / f"chrome-launch-{uuid.uuid4().hex[:6]}.log").open("wb"),
       stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
    pids = desktop.process_tree_pids(chrome)
    observer = None
    try:
        debug_port, _ = desktop.cdp_connect(profile, chrome)
        observer = desktop.CDPObserver(debug_port, chrome)
        # A reopened, already authenticated test profile redirects /login to
        # /. Attach by isolated origin so either page is accepted.
        observer.connect_page(app_url)
        deadline = time.monotonic() + 30
        hwnd = None
        while time.monotonic() < deadline:
            windows = desktop.enumerate_windows_for_pid(chrome.pid)
            candidate = next((item for item in windows if item[1]), None)
            if candidate:
                hwnd = candidate[0]
                break
            time.sleep(0.2)
        if hwnd is None:
            raise TimeoutError("No visible native Chrome window owned by the M03 test appeared.")
        window = desktop.focus_and_maximize(hwnd, chrome.pid)
        return chrome, pids, observer, hwnd, window
    except Exception:
        # The caller cannot receive the local process handle if startup fails,
        # so close this exact test-owned Chrome tree here before re-raising.
        stop_chrome(chrome, pids, observer)
        raise


def stop_chrome(chrome, pids, observer) -> list[int]:
    try:
        if observer:
            observer.close()
    except Exception:
        pass
    if chrome:
        try:
            windows = desktop.enumerate_windows_for_pid(chrome.pid)
            if windows:
                desktop.user32.PostMessageW(windows[0][0], desktop.WM_CLOSE, 0, 0)
                time.sleep(0.2)
        except Exception:
            pass
    return desktop.stop_owned_process(chrome, pids, graceful=True) if chrome else []


def psql_json(container: str, sql: str) -> dict:
    output = onboarding.psql(container, sql)
    return json.loads(output.splitlines()[-1])


def create_fake_scheduler_secret(container: str) -> str:
    existing = onboarding.psql(container, "SELECT count(*) FROM vault.secrets WHERE name='job-pool-scheduler-secret';")
    if existing.splitlines()[-1] != "0":
        raise RuntimeError("A scheduler secret already exists in local Vault; refusing to replace it for acceptance.")
    secret = secrets.token_urlsafe(48)
    quoted = secret.replace("'", "''")
    escaped_description = "M03 local test only; removed during cleanup"
    onboarding.psql(container, f"SELECT vault.create_secret('{quoted}','job-pool-scheduler-secret','{escaped_description}');")
    return secret


def clean_test_scheduler_secret(container: str) -> None:
    onboarding.psql(container, "DELETE FROM vault.secrets WHERE name='job-pool-scheduler-secret' AND description='M03 local test only; removed during cleanup';")


def seed_memory_correction_fixture(account: dict, container: str) -> None:
    """Seed only a prior synthetic snapshot; consent and edits stay in the UI."""
    profile_id = account["profileId"]
    snapshot = {
        "profile.display_name": "Synthetic User A",
        "facts.work_authorisation": "Synthetic baseline status",
        "employment.synthetic data labs|test analyst|2021-01-01": {
            "employer": "Synthetic Data Labs",
            "role_title": "Test Analyst",
            "location": "London",
            "start_date": "2021-01-01",
            "end_date": "2023-12-31",
            "current": False,
            "details": "Unrelated synthetic professional history sentinel",
        },
    }
    profile_sql = (
        "INSERT INTO public.candidate_facts(profile_id,fact_key,value_json,verification_status,source_note,verified_at) VALUES "
        f"('{profile_id}'::uuid,'work_authorisation',to_jsonb('Synthetic baseline status'::text),'verified','m03_synthetic_fixture',now()) "
        "ON CONFLICT(profile_id,fact_key) DO UPDATE SET value_json=excluded.value_json,verification_status='verified',source_note='m03_synthetic_fixture',verified_at=now();\n"
        "INSERT INTO public.candidate_employment(profile_id,employer,role_title,location,start_date,end_date,current,details,verification_status) VALUES "
        f"('{profile_id}'::uuid,'Synthetic Data Labs','Test Analyst','London','2021-01-01','2023-12-31',false,'Unrelated synthetic professional history sentinel','verified') "
        "ON CONFLICT DO NOTHING;\n"
        "INSERT INTO public.candidate_chatgpt_memory(profile_id,memory_update_snapshot) VALUES "
        f"('{profile_id}'::uuid,'{json.dumps(snapshot, separators=(',', ':')).replace(chr(39), chr(39) * 2)}'::jsonb) "
        "ON CONFLICT(profile_id) DO UPDATE SET memory_update_snapshot=excluded.memory_update_snapshot,"
        "memory_update_pending_snapshot=null,memory_update_pending_payload=null,memory_update_dispatch_ids='{}'::uuid[],"
        "memory_update_status='not_requested',memory_update_completed_at=null;"
    )
    onboarding.psql(container, profile_sql)


def browser_private_json(observer: desktop.CDPObserver, path: str, method: str = "GET", body: dict | None = None) -> dict:
    """Read a narrowly scoped local API response without writing credentials to evidence."""
    expression = (
        "(async()=>{const path=" + json.dumps(path) + ";const method=" + json.dumps(method)
        + ";const body=" + json.dumps(body) + ";const init={method,credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json'}};"
        + "if(body!==null)init.body=JSON.stringify(body);const r=await fetch(path,init);let data={};try{data=await r.json()}catch{};"
        + "return JSON.stringify({status:r.status,data});})()"
    )
    result = observer.evaluate(expression)
    if not isinstance(result, dict) or not isinstance(result.get("status"), int) or not isinstance(result.get("data"), dict):
        raise RuntimeError("The authenticated local app API returned an unreadable response.")
    return result


def bridge_test_call(api_url: str, device_id: str, device_token: str, extension_version: str,
                     capabilities: dict, operation: str, payload: dict | None = None) -> dict:
    headers = {
        "content-type": "application/json",
        "x-chatgpt-bridge-device-id": device_id,
        "x-chatgpt-bridge-device-token": device_token,
        "x-chatgpt-bridge-version": extension_version,
    }
    body = {"op": operation, "protocol": "v2", "extensionVersion": extension_version,
            "capabilities": capabilities, **(payload or {})}
    request = urllib.request.Request(api_url.rstrip("/") + "/functions/v1/chatgpt-bridge", data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            data = response.read()
    except Exception as exc:
        raise RuntimeError("The test-owned local Website Bridge transport operation failed: " + operation) from exc
    try:
        result = json.loads(data) if data else {}
    except json.JSONDecodeError as exc:
        raise RuntimeError("The test-owned local Website Bridge returned unreadable JSON: " + operation) from exc
    if not isinstance(result, dict) or result.get("ok") is False or result.get("error"):
        raise RuntimeError("The test-owned local Website Bridge rejected operation: " + operation)
    return result


def open_next_build(repo: Path, workspace: Path, evidence: Path, env: dict[str, str]) -> None:
    cli = repo / "node_modules/@opennextjs/cloudflare/dist/cli/index.js"
    if not cli.is_file():
        raise RuntimeError("The installed OpenNext Cloudflare build tool is unavailable.")
    process = subprocess.Popen([shutil.which("node.exe") or shutil.which("node") or "node", str(cli), "build"],
                               cwd=workspace / "apps/web", env=env,
                               stdout=(evidence / "open-next-build.log").open("wb"), stderr=subprocess.STDOUT,
                               creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
    owned = desktop.process_tree_pids(process)
    deadline = time.monotonic() + 900
    while process.poll() is None and time.monotonic() < deadline:
        time.sleep(0.5)
    if process.poll() is None:
        desktop.stop_owned_process(process, owned, graceful=True)
        raise TimeoutError("The local OpenNext Worker build exceeded its 15-minute bound.")
    if process.returncode != 0:
        raise RuntimeError("The isolated OpenNext Cloudflare Worker build failed; see the sanitized build log.")
    if not (workspace / "apps/web/.open-next/worker.js").is_file():
        raise RuntimeError("OpenNext completed without producing its custom Worker entry point.")


def start_local_worker(repo: Path, workspace: Path, run_root: Path, evidence: Path, port: int,
                       provider_port: int, api_url: str, publishable_key: str,
                       scheduler_secret: str) -> tuple[subprocess.Popen, list[int], Path]:
    worker_dir = workspace / "apps/web"
    vars_file = worker_dir / ".dev.vars"
    values = {
        "NEXT_PUBLIC_SUPABASE_URL": api_url,
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY": publishable_key,
        "GOOGLE_CLIENT_ID": "m03-local-test-client",
        "GOOGLE_CLIENT_SECRET": "m03-local-test-secret",
        "JOB_POOL_SCHEDULER_SECRET": scheduler_secret,
        "JOBHUNT_M03_TEST_MODE": "1",
        "JOBHUNT_M03_TEST_GOOGLE_API_BASE": f"http://127.0.0.1:{provider_port}/",
        "JOB_FIT_V3_MODE": "disabled",
    }
    if any("\n" in value or "\r" in value for value in values.values()):
        raise RuntimeError("A local Worker test value contains a line break.")
    vars_file.write_text("".join(f"{key}={value}\n" for key, value in values.items()), encoding="utf-8")
    state_dir = run_root / "worker-state"
    state_dir.mkdir(parents=True, exist_ok=True)
    wrangler = repo / "node_modules/wrangler/bin/wrangler.js"
    if not wrangler.is_file():
        raise RuntimeError("The installed Wrangler local Worker runner is unavailable.")
    env = desktop.safe_environment(run_root)
    env.update({"WRANGLER_SEND_METRICS": "false", "CLOUDFLARE_SEND_METRICS": "false", "CI": "1", "NO_COLOR": "1"})
    node = shutil.which("node.exe") or shutil.which("node") or "node"
    command = [node, str(wrangler), "dev", "--config", "wrangler.jsonc", "--local", "--ip", "127.0.0.1",
               "--port", str(port), "--test-scheduled", "--persist-to", str(state_dir),
               "--show-interactive-dev-session=false", "--log-level", "error"]
    worker = subprocess.Popen(command, cwd=worker_dir, env=env, stdout=(evidence / "wrangler-local.log").open("wb"),
                              stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
    pids = desktop.process_tree_pids(worker)
    origin = f"http://127.0.0.1:{port}"
    deadline = time.monotonic() + 120
    last_error = "not started"
    while time.monotonic() < deadline:
        if worker.poll() is not None:
            raise RuntimeError("The test-owned local Wrangler Worker exited during startup.")
        try:
            with urllib.request.urlopen(origin + "/login", timeout=5) as response:
                if response.status == 200:
                    return worker, pids, vars_file
                last_error = f"HTTP {response.status}"
        except Exception as exc:
            last_error = type(exc).__name__
        time.sleep(0.5)
    raise TimeoutError("The isolated Cloudflare Worker did not become ready on loopback: " + last_error)


def run(args) -> dict:
    if os.name != "nt":
        raise SystemExit("This M03 native-input runner only runs on Windows.")
    repo = Path(args.source_root).resolve()
    run_id = uuid.uuid4().hex
    temp_root = Path(os.environ.get("TEMP", str(Path.home() / "AppData/Local/Temp")))
    run_root = temp_root / f"JobHuntAI-M03-Local-UI-{run_id}"
    workspace = run_root / "workspace"
    profile = run_root / "chrome-profile"
    evidence_root = Path(args.evidence_dir).resolve() if args.evidence_dir else temp_root / "JobHuntAI-M03-Evidence"
    evidence = evidence_root / run_id
    evidence.mkdir(parents=True, exist_ok=False)
    run_root.mkdir(parents=True, exist_ok=False)
    api_url = os.environ["JOBHUNT_M03_SUPABASE_URL"].rstrip("/")
    publishable_key = os.environ["JOBHUNT_M03_PUBLISHABLE_KEY"]
    service_key = os.environ["JOBHUNT_M03_SERVICE_KEY"]
    db_container = os.environ["JOBHUNT_M03_DB_CONTAINER"]
    report = {
        "schemaVersion": "1.0.0", "runId": run_id, "startedAtUtc": utc_now(),
        "repository": {"head": subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip(),
                        "branch": subprocess.run(["git", "-C", str(repo), "branch", "--show-current"], capture_output=True, text=True, check=True).stdout.strip()},
        "testLevel": "genuine_windows_desktop_ui_with_native_input_and_local_supabase",
        "application": {"type": "Next.js M03 app in test-owned Chrome", "version": json.loads((repo / "apps/web/package.json").read_text(encoding="utf-8")).get("version"),
                        "frameworkVersion": json.loads((repo / "node_modules/next/package.json").read_text(encoding="utf-8")).get("version"),
                        "serverPid": None, "chromePid": None, "chromeExecutable": None, "chromeVersion": None,
                        "workspace": "%TEMP%\\JobHuntAI-M03-Local-UI-" + run_id, "isolatedProfile": True},
        "worker": {"kind": "OpenNext Cloudflare Worker in Wrangler local runtime", "build": "NOT RUN", "pid": None,
                   "origin": None, "scheduledEvent": "NOT RUN", "productionResources": False},
        "backend": {"kind": "local Supabase in WSL2 Podman", "apiUrl": api_url, "productionTouched": False,
                    "paidResourcesCreated": False, "realUserDataCopied": False, "realGoogleOAuthUsed": False,
                    "googleProvider": "controlled local API emulator, loopback-only; app Google OAuth and Drive are not externally verified"},
        "environment": {"python": sys.version.split()[0], "dpiAwareness": desktop.enable_per_monitor_dpi_awareness(), "primaryDisplay": None},
        "fixtures": {"accounts": 3, "allSynthetic": True, "searchTermsAreFictional": True, "documentsUploaded": False},
        "workflow": [], "screenshots": [], "milestones": [], "cleanup": {"serverExited": True, "chromeExited": True,
                    "providerExited": True, "workerExited": True, "workerVariablesRemoved": True,
                    "temporaryWorkspaceRemoved": False, "syntheticAccountsRemoved": False, "localCronRestored": True},
        "limitations": [], "result": "RUNNING", "error": None, "evidenceDirectory": f"<evidence>/{run_id}",
    }
    server = provider = chrome = worker = None
    observer = None
    server_pids: list[int] = []
    provider_pids: list[int] = []
    chrome_pids: list[int] = []
    worker_pids: list[int] = []
    worker_vars_file: Path | None = None
    accounts: list[dict] = []
    scheduler_secret = None
    app_url = None
    cron_job_id_for_restore: int | None = None
    cron_job_paused = False
    provider_port = desktop.free_loopback_port()
    sensitive_values = [publishable_key, service_key]
    try:
        if not (repo / "apps/web/package.json").is_file() or not (repo / "node_modules/next/dist/bin/next").is_file():
            raise RuntimeError("The M03 source checkout or installed Next.js dependencies are missing.")
        m02_environment = {
            "JOBHUNT_M02_SUPABASE_URL": api_url,
            "JOBHUNT_M02_PUBLISHABLE_KEY": publishable_key,
            "JOBHUNT_M02_SERVICE_KEY": service_key,
            "JOBHUNT_M02_DB_CONTAINER": db_container,
        }
        previous_m02_environment = {key: os.environ.get(key) for key in m02_environment}
        try:
            os.environ.update(m02_environment)
            account_a, account_b = onboarding.seed_accounts(argparse.Namespace(), run_id)
        finally:
            for key, value in previous_m02_environment.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
        account_c = seed_synthetic_account(run_id, "c")
        # User D is a clean isolated account for the independent Bridge route
        # check. User C has an active manual-search operation by that point,
        # which correctly locks out other ChatGPT actions.
        account_d = seed_synthetic_account(run_id, "d")
        accounts = [account_a, account_b, account_c, account_d]
        seed_memory_correction_fixture(account_a, db_container)
        for label, account in zip(("a", "b", "c"), accounts[:3], strict=True):
            sensitive_values.extend((account["email"], account["password"]))
            store_fake_google_grant(account, label)
        sensitive_values.extend((account_d["email"], account_d["password"]))
        report["fixtures"]["accounts"] = 4
        report["milestones"].append({"name": "four_synthetic_local_accounts_created", "timeUtc": utc_now(), "ordinaryUserJwtUsedForGoogleGrantFixture": True})

        copied, packages, dependency_files, supplemental = desktop.copy_isolated_workspace(repo, workspace)
        shim = workspace / "scripts/fixtures/m03-google-fetch-shim.mjs"
        shim.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(repo / "scripts/fixtures/m03-google-fetch-shim.mjs", shim)
        report["sourceCopy"] = {"trackedSourceFiles": copied, "localPackages": packages,
                                "dependencyFilesHardlinked": dependency_files["hardlinked"],
                                "dependencyFallbackCopies": dependency_files["copiedFallback"],
                                "supplementalWorktreeFiles": supplemental + ["scripts/fixtures/m03-google-fetch-shim.mjs"],
                                "environmentFilesCopied": False, "repositoryDataCopied": False}

        build_env = desktop.safe_environment(run_root)
        build_env.update({
            "NEXT_PUBLIC_SUPABASE_URL": api_url,
            "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY": publishable_key,
            "JOBHUNT_DATA_MODE": "supabase",
            "GOOGLE_CLIENT_ID": "m03-local-test-client",
            "GOOGLE_CLIENT_SECRET": "m03-local-test-secret",
            "NEXT_TELEMETRY_DISABLED": "1",
        })
        build_started = time.monotonic()
        open_next_build(repo, workspace, evidence, build_env)
        report["worker"].update({"build": "PASS", "buildDurationSeconds": round(time.monotonic() - build_started, 1),
                                 "entryPointGenerated": True, "buildIsolatedInTempWorkspace": True})
        report["milestones"].append({"name": "isolated_open_next_worker_build_complete", "timeUtc": utc_now(),
                                     "durationSeconds": report["worker"]["buildDurationSeconds"]})

        node = shutil.which("node.exe") or shutil.which("node")
        if not node:
            raise FileNotFoundError("Node.js is required for the test-owned local app and provider.")
        provider = subprocess.Popen([node, str(repo / "scripts/fixtures/m03-fake-google-provider.mjs"), str(provider_port)],
                                    cwd=run_root, env=desktop.safe_environment(run_root), stdout=(evidence / "fake-google-provider.log").open("wb"),
                                    stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
        provider_pids = desktop.process_tree_pids(provider)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if provider.poll() is not None:
                raise RuntimeError("The test-owned loopback Google provider exited before readiness.")
            try:
                health = local_json(f"http://127.0.0.1:{provider_port}/__test/health")
                if health.get("bind") == "127.0.0.1":
                    break
            except Exception:
                time.sleep(0.15)
        else:
            raise TimeoutError("The test-owned fake Google provider did not bind to loopback.")
        report["milestones"].append({"name": "loopback_google_provider_ready", "timeUtc": utc_now(), "pid": provider.pid, "port": provider_port, "host": "127.0.0.1"})

        env = desktop.safe_environment(run_root)
        env.update({
            "NEXT_PUBLIC_SUPABASE_URL": api_url,
            "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY": publishable_key,
            "JOBHUNT_DATA_MODE": "supabase", "JOBHUNT_TEST_AUTH": "true", "NEXT_TELEMETRY_DISABLED": "1",
            "GOOGLE_CLIENT_ID": "m03-local-test-client", "GOOGLE_CLIENT_SECRET": "m03-local-test-secret",
            "JOBHUNT_M03_LOOPBACK_GOOGLE": "1", "JOBHUNT_M03_GOOGLE_PORT": str(provider_port),
            "NODE_OPTIONS": "--import=" + shim.as_uri(),
        })
        env.pop("NODE_PATH", None)
        port = desktop.free_loopback_port()
        app_url = f"http://127.0.0.1:{port}"
        next_cli = workspace / "apps/web/node_modules/next/dist/bin/next"
        server = subprocess.Popen([node, str(next_cli), "dev", "--hostname", "127.0.0.1", "--port", str(port)],
                                  cwd=workspace / "apps/web", env=env, stdout=(evidence / "next-dev.log").open("wb"),
                                  stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
        server_pids = desktop.process_tree_pids(server)
        report["application"].update({"serverPid": server.pid, "serverCommand": "test-owned Next dev server on loopback with isolated Supabase keys"})
        report["milestones"].append({"name": "next_server_process_started", "timeUtc": utc_now(), "pid": server.pid})
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            if server.poll() is not None:
                raise RuntimeError("The test-owned Next.js server exited before the authenticated UI became ready.")
            try:
                with urllib.request.urlopen(app_url + "/login?next=%2Fonboarding", timeout=4) as response:
                    body = response.read().decode("utf-8", errors="replace")
                    if response.status == 200 and "Local test email" in body:
                        break
            except Exception:
                pass
            time.sleep(0.4)
        else:
            raise TimeoutError("The local Supabase test login did not become available.")
        report["milestones"].append({"name": "authenticated_app_backend_ready", "timeUtc": utc_now(), "httpStatus": 200, "origin": app_url})

        profile.mkdir(parents=True, exist_ok=False)
        onboarding.disable_test_profile_password_prompt(profile)
        chrome_path = desktop.find_chrome()
        report["application"].update({"chromeExecutable": str(chrome_path), "chromeVersion": desktop.file_product_version(chrome_path)})
        chrome, chrome_pids, observer, hwnd, window_state = launch_chrome(repo, run_root, profile, app_url, evidence)
        report["application"]["chromePid"] = chrome.pid
        display = {"width": desktop.user32.GetSystemMetrics(0), "height": desktop.user32.GetSystemMetrics(1)}
        if desktop.ImageGrab.grab().size != (display["width"], display["height"]):
            raise RuntimeError("Full desktop capture dimensions do not match Windows display metrics.")
        report["environment"]["primaryDisplay"] = display
        report["milestones"].append({"name": "maximized_native_window", "timeUtc": utc_now(), "window": window_state,
                                     "fullDesktopResolution": display})
        onboarding.wait_ui(observer, lambda state: "/login" in state.get("url", "") and "Sign in to local test account" in state.get("body", ""), "visible local login page")
        report["screenshots"].append(desktop.desktop_screenshot(evidence / "00-local-login.png", hwnd, chrome.pid, (display["width"], display["height"])))
        onboarding.switch_user(observer, hwnd, chrome.pid, app_url, account_a, report, "User A")

        # Testing Mode is an actual visible account setting before any test dispatch.
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/diagnostics")
        wait_body(observer, "ChatGPT testing mode", "visible Diagnostics testing-mode control")
        native_checkbox(observer, hwnd, chrome.pid, "section.diagnosticCooldownCard:first-of-type input[type=checkbox]", True)
        wait_body(observer, "Testing mode is on", "visible Testing Mode confirmation")
        if browser_json(observer, "/api/diagnostics/testing-mode").get("ok") is not True:
            raise RuntimeError("Testing Mode could not be verified through the authenticated route.")
        report["workflow"].append({"name": "visible_testing_mode_enabled", "result": "PASS", "modeAppliesToNewBridgeMessages": True})
        report["screenshots"].append(desktop.desktop_screenshot(evidence / "01-testing-mode-enabled.png", hwnd, chrome.pid, (display["width"], display["height"])))

        # Close M02's scoped correction carry-forward with a synthetic paired
        # transport. Pairing is through the authenticated app route and the real
        # local Edge Function; no ChatGPT tab or external delivery is opened.
        bridge_version = json.loads((repo / "apps/chatgpt-bridge-extension/package.json").read_text(encoding="utf-8"))["version"]
        bridge_capabilities = {
            "protocol_version": 2, "build_id": f"{bridge_version}-m03-local-test",
            "durable_dispatch_v2": True, "send_authorization_v2": True, "result_outbox_v1": True,
            "result_completion_v3": True, "response_provenance_v3": True,
            "concurrent_response_capture": 2, "background_focus_policy_v2": True,
        }
        pairing = browser_private_json(observer, "/api/chatgpt-bridge/pairing", "POST", {})
        pairing_code = pairing.get("data", {}).get("pairing_code") if pairing.get("status") == 200 else None
        if not isinstance(pairing_code, str) or not pairing_code:
            raise RuntimeError("The authenticated local app did not create a synthetic Website Bridge pairing code.")
        pairing_request = urllib.request.Request(api_url + "/functions/v1/chatgpt-bridge", data=json.dumps({
            "op": "pair_device", "pairingCode": pairing_code, "displayName": "M03 isolated local transport",
            "platform": "chrome", "extensionVersion": bridge_version, "protocol": "v2", "capabilities": bridge_capabilities,
        }).encode("utf-8"), headers={"content-type": "application/json", "x-chatgpt-bridge-version": bridge_version}, method="POST")
        try:
            with urllib.request.urlopen(pairing_request, timeout=25) as response:
                paired = json.loads(response.read())
        except Exception as exc:
            raise RuntimeError("The test-owned local Website Bridge could not pair with its one-time code.") from exc
        bridge_device = paired.get("device") if isinstance(paired, dict) else None
        bridge_device_id = bridge_device.get("id") if isinstance(bridge_device, dict) else None
        bridge_device_token = paired.get("device_token") if isinstance(paired, dict) else None
        if not isinstance(bridge_device_id, str) or not isinstance(bridge_device_token, str) or len(bridge_device_token) < 40:
            raise RuntimeError("The local Website Bridge did not return a valid synthetic device credential.")
        sensitive_values.append(bridge_device_token)
        bridge_test_call(api_url, bridge_device_id, bridge_device_token, bridge_version, bridge_capabilities, "device_heartbeat")
        bound = bridge_test_call(api_url, bridge_device_id, bridge_device_token, bridge_version, bridge_capabilities, "bind_conversation", {
            "workflowKey": "profile.background",
            "conversationUrl": "https://chatgpt.com/c/m03-local-synthetic-background",
            "projectName": "JobHuntAI", "projectVerified": True,
        })
        if bound.get("bound_project_verified") is not True:
            raise RuntimeError("The local synthetic Website Bridge workflow did not bind through the real local protocol.")
        bridge_test_call(api_url, bridge_device_id, bridge_device_token, bridge_version, bridge_capabilities, "set_automatic_send", {"enabled": True})
        bridge_test_call(api_url, bridge_device_id, bridge_device_token, bridge_version, bridge_capabilities, "device_heartbeat")
        report["workflow"].append({"name": "synthetic_local_bridge_transport_ready", "result": "CONTROLLED PASS",
                                   "authenticatedPairingRoute": True, "actualLocalBridgeFunction": True,
                                   "syntheticDeviceOnly": True, "syntheticConversationBinding": True,
                                   "chatgptPageOpened": False, "externalDeliveryPossible": False,
                                   "deviceCredentialsRecorded": False})

        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/onboarding")
        wait_body(observer, "Build your profile", "fictional reviewed profile correction workspace")
        memory_allow_selector = "#chatgpt-memory button.primaryButton"
        wait_selector(observer, memory_allow_selector, "visible Memory consent action", enabled=True)
        memory_allow = desktop.native_click_selector(observer, hwnd, chrome.pid, memory_allow_selector)
        memory_state = browser_private_json(observer, "/api/onboarding/memory")
        memory_data = memory_state.get("data", {}).get("memory", {}) if memory_state.get("status") == 200 else {}
        if memory_data.get("confirmed") is not True or memory_data.get("memorySyncEnabled") is not True:
            raise RuntimeError("Visible consent did not enable the synthetic profile's local Memory correction workflow.")
        # The onboarding page intentionally collapses this disclosure after a
        # consent change. Reopen it with native input so the result is visibly
        # inspectable and the confirmation is not inferred from an API-only read.
        memory_details_open = observer.evaluate("document.querySelector('#chatgpt-memory')?.open===true")
        memory_consent_summary_click = None
        if memory_details_open is not True:
            memory_consent_summary_click = desktop.native_click_selector(observer, hwnd, chrome.pid, "#chatgpt-memory > summary")
            if observer.evaluate("document.querySelector('#chatgpt-memory')?.open===true") is not True:
                raise RuntimeError("Native input did not reopen the saved Memory-consent disclosure for visible verification.")
        wait_body(observer, "ChatGPT Memory is allowed", "visible local synthetic Memory consent acknowledgement")
        auth_selector = "form.profileDetailsForm input[name=workAuthorisation]"
        previous_auth = observer.evaluate("document.querySelector('" + auth_selector + "')?.value||null")
        if previous_auth != "Synthetic baseline status":
            raise RuntimeError("The local fictional profile did not show the expected previous synthetic authorization fact.")
        changed_auth = "Synthetic test fixture: eligible to work without sponsorship"
        auth_edit = native_fill(observer, hwnd, chrome.pid, auth_selector, changed_auth)
        auth_save = desktop.native_click_selector(observer, hwnd, chrome.pid, "form.profileDetailsForm button.primaryButton")
        saved_state = {}
        saved_facts = []
        verified_auth_fact = None
        readback_deadline = time.monotonic() + 10
        while time.monotonic() < readback_deadline:
            saved_state = browser_private_json(observer, "/api/onboarding/state")
            saved_facts = saved_state.get("data", {}).get("facts", []) if saved_state.get("status") == 200 else []
            verified_auth_fact = next((item for item in saved_facts if isinstance(item, dict)
                                       and item.get("fact_key") == "work_authorisation"
                                       and item.get("value_json") == changed_auth
                                       and item.get("verification_status") == "verified"), None)
            if verified_auth_fact:
                break
            time.sleep(0.25)
        if not verified_auth_fact:
            ui_value_match = observer.evaluate("document.querySelector(" + json.dumps(auth_selector) + ")?.value===" + json.dumps(changed_auth)) is True
            facts_for_key = [item for item in saved_facts if isinstance(item, dict) and item.get("fact_key") == "work_authorisation"]
            fact_summary = [{"present": True, "valueMatches": item.get("value_json") == changed_auth,
                             "verified": item.get("verification_status") == "verified"} for item in facts_for_key]
            raise RuntimeError("Authenticated profile correction readback failed: " + json.dumps({
                "uiValueMatched": ui_value_match, "apiStatus": saved_state.get("status"),
                "apiFactSummary": fact_summary, "nativeSaveClickVerified": bool(auth_save),
            }))
        memory_button = "#memory-update button.primaryButton"
        more_details_open = observer.evaluate("document.querySelector('#more-profile-details')?.open===true")
        more_details_click = None
        if more_details_open is not True:
            more_details_click = desktop.native_click_selector(observer, hwnd, chrome.pid, "#more-profile-details > summary")
            if observer.evaluate("document.querySelector('#more-profile-details')?.open===true") is not True:
                raise RuntimeError("Native input did not open More profile details for Memory synchronization.")
        wait_selector(observer, memory_button, "visible Memory synchronization action", enabled=True)
        desktop.ensure_onboarding_visible(observer, hwnd, chrome.pid, memory_button)
        memory_sync_click = desktop.native_click_selector(observer, hwnd, chrome.pid, memory_button)
        wait_body(observer, "Your new and corrected profile details were queued", "visible targeted Memory correction dispatch", 60)
        memory_after_sync = browser_private_json(observer, "/api/onboarding/memory")
        memory_after_data = memory_after_sync.get("data", {}).get("memory", {}) if memory_after_sync.get("status") == 200 else {}
        dispatch_ids = memory_after_data.get("updateDispatchIds") if isinstance(memory_after_data.get("updateDispatchIds"), list) else []
        if memory_after_sync.get("status") != 200 or len(dispatch_ids) != 1:
            raise RuntimeError("The visible correction action did not produce exactly one durable local dispatch identity.")
        correction_dispatch_id = dispatch_ids[0]
        correction_raw = psql_json(db_container, "SELECT json_build_object('id',id,'correlationId',correlation_id,'state',state,'actionType',action_type,'instruction',manual_instruction,'idempotencyKey',idempotency_key,'changedFields',coalesce((SELECT jsonb_array_length(memory_update_pending_payload->'changedFields') FROM public.candidate_chatgpt_memory WHERE profile_id='" + account_a["profileId"] + "'::uuid),0))::text FROM public.chatgpt_dispatch_requests WHERE id='" + correction_dispatch_id + "'::uuid AND user_id='" + account_a["userId"] + "'::uuid;")
        correction_instruction = correction_raw.get("instruction") if isinstance(correction_raw.get("instruction"), str) else ""
        if correction_raw.get("id") != correction_dispatch_id or correction_raw.get("changedFields") != 1 \
                or correction_raw.get("state") != "queued" or correction_raw.get("actionType") != "profile.background" \
                or not correction_raw.get("correlationId") or not correction_raw.get("idempotencyKey") \
                or not correction_instruction.startswith("TEST ONLY") \
                or "facts.work_authorisation" not in correction_instruction or changed_auth not in correction_instruction \
                or "Synthetic Data Labs" in correction_instruction or "Unrelated synthetic professional history sentinel" in correction_instruction:
            raise RuntimeError("The queued local correction instruction was not limited to one synthetic verified change or was missing its test-only boundary.")
        report["workflow"].append({"name": "m02_visible_scoped_correction_dispatch", "result": "CONTROLLED PASS",
                                   "nativeMemoryConsentClick": memory_allow, "nativeProfileCorrection": auth_edit,
                                   "nativeReopenConsentDisclosureClick": memory_consent_summary_click,
                                   "nativeProfileSaveClick": auth_save, "nativeOpenMoreProfileDetailsClick": more_details_click,
                                   "nativeSyncClick": memory_sync_click,
                                   "verifiedChangedFieldCount": 1, "unrelatedHistoryExcluded": True,
                                   "cvContentPresentInFixture": False, "dispatchState": correction_raw["state"],
                                   "dispatchId": correction_raw["id"], "correlationIdPresent": True,
                                   "idempotencyKeyPresent": True, "testingPrefixPresent": True,
                                   "realMemoryUpdateRequested": False, "instructionTextIncludedInEvidence": False})
        report["screenshots"].append(desktop.desktop_screenshot(evidence / "02-m02-correction-queued-testing-mode.png", hwnd, chrome.pid, (display["width"], display["height"])))

        # Stop the paired local transport before its ChatGPT-page/send step,
        # then recover through the visible Retry safely action. This exercises
        # the real queue state machine without crossing a send boundary.
        claimed = bridge_test_call(api_url, bridge_device_id, bridge_device_token, bridge_version, bridge_capabilities, "device_poll_v2")
        claimed_request = claimed.get("request") if isinstance(claimed.get("request"), dict) else {}
        lease_token = claimed_request.get("lease_token")
        delivery_attempt_id = claimed_request.get("delivery_attempt_id")
        if claimed_request.get("id") != correction_dispatch_id or not isinstance(lease_token, str) or not isinstance(delivery_attempt_id, str):
            raise RuntimeError("The local test bridge did not claim the exact correction dispatch with a bounded lease.")
        stopped = bridge_test_call(api_url, bridge_device_id, bridge_device_token, bridge_version, bridge_capabilities, "stop_dispatch_v2", {
            "requestId": correction_dispatch_id, "leaseToken": lease_token, "deliveryAttemptId": delivery_attempt_id,
            "code": "conversation_open_failed", "message": "Synthetic local interruption before opening ChatGPT; nothing was sent.",
        })
        if stopped.get("state") != "user_required":
            raise RuntimeError("The controlled pre-send interruption did not enter its safe recovery state.")
        wait_body(observer, "Retry safely", "safe pre-send correction recovery control", 40)
        retry_click = desktop.native_click_selector(observer, hwnd, chrome.pid, "#memory-update button.secondaryButton")
        wait_body(observer, "The correction update was safely re-queued", "visible safe recovery without a new instruction", 60)
        correction_recovered = browser_private_json(observer, "/api/onboarding/memory")
        recovered_memory = correction_recovered.get("data", {}).get("memory", {}) if correction_recovered.get("status") == 200 else {}
        if recovered_memory.get("updateStatus") != "queued" or recovered_memory.get("updateDispatchIds") != [correction_dispatch_id]:
            raise RuntimeError("The recovery action did not requeue the existing correction without creating a duplicate.")
        recovered_row = psql_json(db_container, "SELECT json_build_object('rows',(SELECT count(*) FROM public.chatgpt_dispatch_requests WHERE user_id='" + account_a["userId"] + "'::uuid AND action_type='profile.background' AND idempotency_key='" + correction_raw["idempotencyKey"] + "'),'state',d.state,'sendAttempted',d.send_attempted_at IS NOT NULL,'sent',d.sent_at IS NOT NULL,'completedAt',m.memory_update_completed_at,'baselineUnchanged',m.memory_update_snapshot->>'facts.work_authorisation'='Synthetic baseline status')::text FROM public.chatgpt_dispatch_requests d JOIN public.candidate_chatgpt_memory m ON m.profile_id='" + account_a["profileId"] + "'::uuid WHERE d.id='" + correction_dispatch_id + "'::uuid;")
        if recovered_row.get("rows") != 1 or recovered_row.get("state") != "queued" or recovered_row.get("sendAttempted") is True \
                or recovered_row.get("sent") is True or recovered_row.get("completedAt") is not None or recovered_row.get("baselineUnchanged") is not True:
            raise RuntimeError("The pre-send recovery created a second instruction, crossed a send boundary, or falsely completed Memory activation.")
        report["workflow"].append({"name": "m02_pre_send_interruption_safe_recovery", "result": "CONTROLLED PASS",
                                   "testBridgeClaimedExactRequest": True, "interruptedBeforeChatGptOpened": True,
                                   "nativeRetrySafelyClick": retry_click, "sameDispatchIdRetained": True,
                                   "idempotentInstructionCount": recovered_row["rows"], "sendBoundaryCrossed": False,
                                   "memorySnapshotStillPrevious": True, "completedAtRemainsNull": True,
                                   "testingModeDidNotMarkMemoryComplete": True, "noChatGptMemoryChanged": True})
        report["screenshots"].append(desktop.desktop_screenshot(evidence / "03-m02-correction-recovered-no-send.png", hwnd, chrome.pid, (display["width"], display["height"])))
        revoke_response = browser_private_json(observer, "/api/chatgpt-bridge/revoke", "POST", {"deviceId": bridge_device_id})
        if revoke_response.get("status") != 200 or revoke_response.get("data", {}).get("revoked") is not True:
            raise RuntimeError("The authenticated app did not revoke its temporary synthetic local Bridge device.")
        report["workflow"].append({"name": "temporary_local_bridge_device_revoked", "result": "PASS", "appOwnedRevocationRoute": True})

        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/jobs/settings")
        wait_body(observer, "Role discovery mode", "visible Search settings form")
        a0 = save_search_preferences(observer, hwnd, chrome.pid, report, mode_index=0, mode_value="keywords_and_profile", initial=True)
        a_sources = ensure_enabled_search_source(observer, hwnd, chrome.pid, report, "User A")
        a2 = save_search_preferences(observer, hwnd, chrome.pid, report, mode_index=2, mode_value="profile")
        if a2["roles"] != a0["roles"] or not a2["excludedRoles"]:
            raise RuntimeError("Profile mode discarded hidden keywords or exclusion constraints.")
        a1 = save_search_preferences(observer, hwnd, chrome.pid, report, mode_index=1, mode_value="keywords")
        if a1["roles"] != a0["roles"] or a1["excludedCompanies"] != a0["excludedCompanies"]:
            raise RuntimeError("Keywords-only mode discarded stored hidden or hard-constraint fields.")
        a0 = save_search_preferences(observer, hwnd, chrome.pid, report, mode_index=0, mode_value="keywords_and_profile")
        desktop.press_key(0x52, ctrl=True)
        wait_body(observer, "Role discovery mode", "Search settings after native refresh")
        after_refresh = preference_summary(observer)
        if after_refresh["roles"] != a0["roles"] or after_refresh["excludedKeywords"] != a0["excludedKeywords"]:
            raise RuntimeError("Search requirements did not survive a native browser refresh.")
        report["workflow"].append({"name": "three_search_modes_hidden_constraints_refresh", "result": "PASS",
                                   "modes": ["keywords_and_profile", "profile", "keywords"], "hiddenFieldsRetained": True,
                                   "constraints": ["location", "remote", "salary", "sponsorship", "posting_age", "excluded_roles", "excluded_companies", "excluded_keywords"],
                                   "timezoneAndSchedulePersisted": True})
        report["screenshots"].append(desktop.desktop_screenshot(evidence / "04-search-preferences.png", hwnd, chrome.pid, (display["width"], display["height"])))

        onboarding.switch_user(observer, hwnd, chrome.pid, app_url, account_a, report, "User A reauthentication")
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/jobs/settings")
        wait_body(observer, "Role discovery mode", "reauthenticated Search settings")
        reauthenticated = preference_summary(observer)
        if reauthenticated["roles"] != a0["roles"] or reauthenticated["mode"] != "keywords_and_profile":
            raise RuntimeError("Search preferences did not survive sign-out and a fresh sign-in.")
        report["workflow"].append({"name": "search_preferences_reauthentication_persistence", "result": "PASS", "authenticatedReadback": True})

        # User A's synthetic managed workbook tests exact provider contract and manifest rejection.
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/settings")
        wait_body(observer, "Google Sheets", "visible Google Sheets settings")
        sheet_status = {}
        sheet_connection = None
        sheet_status_deadline = time.monotonic() + 20
        while time.monotonic() < sheet_status_deadline:
            sheet_status = browser_private_json(observer, "/api/settings/job-pool-sheet")
            sheet_data = sheet_status.get("data", {}) if isinstance(sheet_status.get("data"), dict) else {}
            sheet_connection = sheet_data.get("googleConnection")
            if sheet_status.get("status") == 200 and sheet_connection == "connected":
                break
            time.sleep(0.25)
        if sheet_status.get("status") != 200 or sheet_connection != "connected":
            raise RuntimeError("The authenticated app did not read the synthetic Google grant: " + json.dumps({
                "apiStatus": sheet_status.get("status"), "googleConnection": sheet_connection,
            }))
        wait_body(observer, "Create spreadsheet", "visible synthetic Google Sheet creation action", 30)
        create_click = desktop.native_click_selector(observer, hwnd, chrome.pid, "section.settingsCard button.primaryButton")
        required_managed_tabs = {"Job Pool", "Job Pool Manifest", "Applications", "Applications Manifest"}
        a_sheet, a_sheet_verification = verify_created_sheet(observer, provider_port, expected_workbook_count=1,
                                                              required_tabs=required_managed_tabs)
        report["workflow"].append({"name": "managed_sheet_created_via_visible_ui", "result": "PASS", "nativeCreateClick": create_click,
                                   "controlledProviderOnly": True, "readbackAndManifestAccepted": True,
                                   "verification": a_sheet_verification})
        report["screenshots"].append(desktop.desktop_screenshot(evidence / "05-synthetic-sheet-created.png", hwnd, chrome.pid, (display["width"], display["height"])))
        before_manifest = local_json(f"http://127.0.0.1:{provider_port}/__test/read?id={urllib.parse.quote(a_sheet['id'])}&range={urllib.parse.quote(chr(39)+'Job Pool Manifest'+chr(39)+'!B6')}")
        original_access_token = (before_manifest.get("values") or [[""]])[0][0]
        if not isinstance(original_access_token, str) or not original_access_token:
            raise RuntimeError("The controlled manifest readback did not contain its synthetic access-check token.")
        local_json(f"http://127.0.0.1:{provider_port}/__test/mutate", "POST", {"id": a_sheet["id"], "range": "'Job Pool Manifest'!B6", "values": [["stale-synthetic-manifest-value"]]})
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/settings")
        wait_body(observer, "Google Sheets", "Google Sheet settings after controlled manifest edit")
        stale_sync_button = wait_job_pool_sync_button(observer, "Sync now")
        arm_native_button_readback(observer)
        provider_before_stale_sync = local_json(f"http://127.0.0.1:{provider_port}/__test/report")
        sync_click = desktop.native_click_selector(observer, hwnd, chrome.pid, "section.settingsCard button.primaryButton")
        sync_button_event = wait_native_button_readback(observer, "Sync now")
        stale_ui = onboarding.wait_ui(observer, lambda state: "spreadsheet" in state.get("body", "").lower()
                                      and "changed outside" in state.get("body", "").lower(),
                                      "visible managed-Sheet external-edit rejection", 45)
        if "spreadsheet" not in stale_ui.get("body", "").lower() or "changed outside" not in stale_ui.get("body", "").lower():
            raise RuntimeError("The visible app did not reject the stale synthetic Sheet manifest with an actionable message.")
        provider_after_stale_sync = local_json(f"http://127.0.0.1:{provider_port}/__test/report")
        previous_routes = provider_before_stale_sync.get("routes", [])
        following_routes = provider_after_stale_sync.get("routes", [])[len(previous_routes):]
        managed_writes = [route for route in following_routes if isinstance(route, str) and (
            route.startswith("POST /v4/spreadsheets/") or route.startswith("POST /drive/v3/files")
            or route.startswith("PATCH /drive/v3/files/") or route.startswith("DELETE /drive/v3/files/")
        )]
        if managed_writes:
            raise RuntimeError("A stale-manifest rejection issued a managed Sheet write: " + json.dumps(managed_writes))
        report["workflow"].append({"name": "visible_stale_manifest_rejected", "result": "PASS", "nativeSyncClick": sync_click,
                                   "syncButtonReadyReadback": stale_sync_button, "trustedClickEvent": sync_button_event,
                                   "noManagedSheetWriteAfterEdit": True, "noDatabaseJobWasImported": True, "controlledManifestOnly": True})
        report["screenshots"].append(desktop.desktop_screenshot(evidence / "06-stale-manifest-rejected.png", hwnd, chrome.pid, (display["width"], display["height"])))
        local_json(f"http://127.0.0.1:{provider_port}/__test/mutate", "POST", {"id": a_sheet["id"], "range": "'Job Pool Manifest'!B6", "values": [[original_access_token]]})
        wait_job_pool_sync_button(observer, "Sync now")
        arm_native_button_readback(observer)
        restored = desktop.native_click_selector(observer, hwnd, chrome.pid, "section.settingsCard button.primaryButton")
        restored_button_event = wait_native_button_readback(observer, "Sync now")
        wait_body(observer, "Your jobs and applications are up to date.", "visible recovery after restoring the synthetic manifest", 70)
        restored_status = browser_private_json(observer, "/api/settings/job-pool-sheet")
        restored_sheet = restored_status.get("data", {}).get("sheet", {}) if restored_status.get("status") == 200 else {}
        if restored_sheet.get("configured") is not True or restored_sheet.get("current") is not True:
            raise RuntimeError("Restoring the synthetic manifest did not restore current authenticated Sheet state.")
        report["workflow"].append({"name": "synthetic_sheet_manifest_restored_and_resynced", "result": "PASS", "nativeSyncClick": restored,
                                   "trustedClickEvent": restored_button_event, "accessTokenRecorded": False})

        # User B's actual GUI Search-now action creates one durable run, then the same run id is retried.
        onboarding.switch_user(observer, hwnd, chrome.pid, app_url, account_b, report, "User B")
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/diagnostics")
        wait_body(observer, "ChatGPT testing mode", "User B Diagnostics testing mode")
        native_checkbox(observer, hwnd, chrome.pid, "section.diagnosticCooldownCard:first-of-type input[type=checkbox]", True)
        wait_body(observer, "Testing mode is on", "User B Testing Mode confirmation")
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/jobs/settings")
        wait_body(observer, "Role discovery mode", "User B Search settings")
        b_preferences = save_search_preferences(observer, hwnd, chrome.pid, report, mode_index=0, mode_value="keywords_and_profile", initial=True)
        b_sources = ensure_enabled_search_source(observer, hwnd, chrome.pid, report, "User B")
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/settings")
        wait_body(observer, "Create spreadsheet", "User B managed Sheet setup")
        b_create = desktop.native_click_selector(observer, hwnd, chrome.pid, "section.settingsCard button.primaryButton")
        b_sheet, b_sheet_verification = verify_created_sheet(observer, provider_port, expected_workbook_count=2)
        if b_sheet["id"] == a_sheet["id"]:
            raise RuntimeError("User B reused User A's synthetic managed Sheet.")
        report["workflow"].append({"name": "user_b_synthetic_sheet_created", "result": "PASS", "nativeCreateClick": b_create,
                                   "sheetIsUserScoped": True, "fixtureRoleSettingsReadBack": b_preferences["mode"],
                                   "verification": b_sheet_verification})
        job_pool_nav_click = open_job_pool_from_navigation(observer, hwnd, chrome.pid,
                                                           "User B bounded manual search button", "Search jobs now")
        manual_button_before = wait_manual_search_button(observer, "User B initial Search now availability", expected_enabled=True)
        manual_click = desktop.native_click_selector(observer, hwnd, chrome.pid, ".manualSearchControl button")
        manual_outcome = wait_manual_search_outcome(observer, 35)
        manual_status = read_scoped_manual_search_state(observer)
        manual_status["result"] = observer.evaluate("document.querySelector('.manualSearchResult strong')?.innerText||''")
        if not manual_status or not manual_status.get("runId") or not manual_status.get("disabled"):
            raise RuntimeError("The native Search now did not persist a run id and show the one-hour cooldown.")
        duplicate = browser_json(observer, "/api/search/manual", "POST", {"runId": manual_status["runId"]})
        if duplicate.get("httpStatus") != 202 or duplicate.get("existing") is not True or duplicate.get("dispatchId") is None:
            raise RuntimeError("Retrying the exact manual-search id did not recover its single durable dispatch.")
        report["workflow"].append({"name": "native_manual_search_durable_and_idempotent", "result": "PASS", "nativeSearchClick": manual_click,
                                   "nativeJobPoolNavigationClick": job_pool_nav_click,
                                   "queuedUiState": manual_outcome.get("result"),
                                   "dispatchId": duplicate["dispatchId"], "runId": manual_status["runId"],
                                   "retryReturnedExisting": True, "noSecondDispatch": True, "cooldownLabelVisible": bool(manual_status["cooldown"])})
        report["screenshots"].append(desktop.desktop_screenshot(evidence / "07-manual-search-queued-and-cooled-down.png", hwnd, chrome.pid, (display["width"], display["height"])))

        # User C tests the true 429 path with an isolated synthetic timestamp and then the visible Diagnostics override.
        onboarding.switch_user(observer, hwnd, chrome.pid, app_url, account_c, report, "User C")
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/diagnostics")
        wait_body(observer, "ChatGPT testing mode", "User C Diagnostics testing mode")
        native_checkbox(observer, hwnd, chrome.pid, "section.diagnosticCooldownCard:first-of-type input[type=checkbox]", True)
        wait_body(observer, "Testing mode is on", "User C Testing Mode confirmation")
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/jobs/settings")
        wait_body(observer, "Role discovery mode", "User C Search settings")
        c_preferences = save_search_preferences(observer, hwnd, chrome.pid, report, mode_index=0, mode_value="keywords_and_profile", initial=True)
        c_sources = ensure_enabled_search_source(observer, hwnd, chrome.pid, report, "User C")
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/settings")
        wait_body(observer, "Create spreadsheet", "User C managed Sheet setup")
        c_create = desktop.native_click_selector(observer, hwnd, chrome.pid, "section.settingsCard button.primaryButton")
        c_sheet, c_sheet_verification = verify_created_sheet(observer, provider_port, expected_workbook_count=3)
        if c_sheet["id"] in {a_sheet["id"], b_sheet["id"]}:
            raise RuntimeError("User C reused another synthetic user's managed Sheet.")
        report["workflow"].append({"name": "user_c_synthetic_sheet_created", "result": "PASS", "nativeCreateClick": c_create,
                                   "sheetIsUserScoped": True, "fixtureRoleSettingsReadBack": c_preferences["mode"],
                                   "verification": c_sheet_verification})
        cooldown_sql = (
            "INSERT INTO public.job_search_controls(user_id) VALUES ('" + account_c["userId"] + "'::uuid) ON CONFLICT(user_id) DO NOTHING;"
            "UPDATE public.job_search_controls SET last_manual_search_at=now()-interval '15 minutes',last_manual_idempotency_key='m03.synthetic.clock.seed',"
            "manual_search_cooldown_disabled=false WHERE user_id='" + account_c["userId"] + "'::uuid;"
        )
        onboarding.psql(db_container, cooldown_sql)
        cooldown_nav_click = open_job_pool_from_navigation(observer, hwnd, chrome.pid,
                                                           "visible one-hour cooldown after an isolated timestamp", "Next search in", 40)
        cooldown_button_state = wait_manual_search_button(observer, "User C disabled cooldown state", expected_enabled=False)
        c_pre_override_search_state = read_scoped_manual_search_state(observer)
        if c_pre_override_search_state.get("scopeId") == manual_status.get("scopeId") or c_pre_override_search_state.get("runId") is not None:
            raise RuntimeError("User C inherited a prior account's manual-search recovery identity.")
        report["workflow"].append({"name": "manual_search_recovery_scoped_per_account", "result": "PASS",
                                   "differentAuthenticatedScopes": True, "foreignRunIdRead": False})
        disabled_attempt = browser_json(observer, "/api/search/manual", "POST", {"runId": str(uuid.uuid4())})
        if disabled_attempt.get("httpStatus") != 429 or disabled_attempt.get("availability", {}).get("allowed") is not False or not disabled_attempt.get("availability", {}).get("nextAllowedAt"):
            raise RuntimeError("The application server did not reject a distinct search inside the one-hour cooldown window.")
        report["workflow"].append({"name": "one_hour_manual_cooldown_server_enforced", "result": "PASS", "visibleSearchButtonDisabled": cooldown_button_state.get("disabled") is True,
                                   "distinctRequestHttpStatus": 429, "nextAllowedTimeReturned": True,
                                   "nativeJobPoolNavigationClick": cooldown_nav_click,
                                   "clockMethod": "timestamp seeded only for disposable synthetic User C"})
        report["screenshots"].append(desktop.desktop_screenshot(evidence / "08-manual-cooldown-server-rejection.png", hwnd, chrome.pid, (display["width"], display["height"])))

        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/diagnostics")
        wait_body(observer, "Manual-search cooldown", "visible Diagnostics cooldown override")
        override_click = native_checkbox(observer, hwnd, chrome.pid, "section.diagnosticCooldownCard:last-of-type input[type=checkbox]", True)
        wait_body(observer, "Cooldown disabled for diagnostic testing", "visible Diagnostics cooldown override confirmation")
        availability = browser_json(observer, "/api/search/manual").get("availability", {})
        if availability.get("cooldownDisabled") is not True or availability.get("allowed") is not True:
            raise RuntimeError("The visible Diagnostics override did not change the authenticated cooldown state.")
        override_nav_click = open_job_pool_from_navigation(observer, hwnd, chrome.pid,
                                                           "User C Search now after visible override", "Search jobs now")
        wait_manual_search_button(observer, "User C enabled Search now after the override", expected_enabled=True)
        override_search_click = desktop.native_click_selector(observer, hwnd, chrome.pid, ".manualSearchControl button")
        override_outcome = wait_manual_search_outcome(observer, 35)
        c_manual_status = read_scoped_manual_search_state(observer)
        if not c_manual_status.get("runId") or c_manual_status.get("runId") == manual_status.get("runId"):
            raise RuntimeError("User C did not persist a distinct user-scoped manual-search run id.")
        report["workflow"].append({"name": "visible_diagnostics_cooldown_override", "result": "PASS", "nativeOverrideClick": override_click,
                                   "nativeJobPoolNavigationClick": override_nav_click,
                                   "nativeSearchClick": override_search_click, "queuedUiState": override_outcome.get("result"),
                                   "userScopedRunIdDistinctFromUserB": True, "overrideAllowedServerReadback": True})
        report["screenshots"].append(desktop.desktop_screenshot(evidence / "09-diagnostics-cooldown-override-search.png", hwnd, chrome.pid, (display["width"], display["height"])))
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/diagnostics")
        wait_body(observer, "Manual-search cooldown", "restore Diagnostics cooldown override")
        restore_click = native_checkbox(observer, hwnd, chrome.pid, "section.diagnosticCooldownCard:last-of-type input[type=checkbox]", False)
        report["workflow"].append({"name": "diagnostics_cooldown_restored", "result": "PASS", "nativeRestoreClick": restore_click,
                                   "syntheticOverrideReset": True})

        # User C has an active queued manual search here, so its shared
        # ChatGPT-operation lock correctly blocks a second ChatGPT action.
        # Use a clean fourth synthetic user to isolate the cooldown boundary.
        onboarding.switch_user(observer, hwnd, chrome.pid, app_url, account_d, report, "User D")
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/diagnostics")
        wait_body(observer, "ChatGPT testing mode", "User D Diagnostics testing mode")
        native_checkbox(observer, hwnd, chrome.pid, "section.diagnosticCooldownCard:first-of-type input[type=checkbox]", True)
        wait_body(observer, "Testing mode is on", "User D Testing Mode confirmation")
        d_cooldown_sql = (
            "INSERT INTO public.job_search_controls(user_id) VALUES ('" + account_d["userId"] + "'::uuid) ON CONFLICT(user_id) DO NOTHING;"
            "UPDATE public.job_search_controls SET last_manual_search_at=now()-interval '15 minutes',"
            "last_manual_idempotency_key='m03.synthetic.user-d.clock.seed',manual_search_cooldown_disabled=false "
            "WHERE user_id='" + account_d["userId"] + "'::uuid;"
        )
        onboarding.psql(db_container, d_cooldown_sql)
        d_availability = browser_json(observer, "/api/search/manual").get("availability", {})
        if d_availability.get("allowed") is not False or d_availability.get("cooldownDisabled") is not False:
            raise RuntimeError("User D did not have an active one-hour manual-search cooldown for the Bridge boundary check.")
        d_cooldown_nav = open_job_pool_from_navigation(observer, hwnd, chrome.pid,
                                                       "User D visible one-hour cooldown", "Next search in")
        d_cooldown_button = wait_manual_search_button(observer, "User D disabled Search now button", expected_enabled=False)
        report["workflow"].append({"name": "user_d_cooldown_visible_before_unrelated_bridge_check", "result": "PASS",
                                   "nativeJobPoolNavigationClick": d_cooldown_nav,
                                   "searchButtonDisabled": d_cooldown_button.get("disabled") is True})
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/diagnostics")
        wait_body(observer, "ChatGPT testing mode", "User D Diagnostics after cooldown UI check")
        diagnostic_post = browser_json(observer, "/api/chatgpt-bridge/diagnostic-message", "POST", {
            "message": "M03 synthetic diagnostics route check. Do not change Memory or take external action.",
            "idempotencyKey": "m03.synthetic.diagnostics:" + run_id[:20],
        })
        if diagnostic_post.get("httpStatus") != 202 or diagnostic_post.get("ok") is not True or diagnostic_post.get("testingPrefix") is not True:
            raise RuntimeError("A harmless Testing Mode Diagnostics request was blocked by the manual cooldown or lost its test prefix; "
                               "HTTP " + str(diagnostic_post.get("httpStatus")) + ", error=" + str(diagnostic_post.get("error")))
        report["workflow"].append({"name": "unrelated_bridge_diagnostic_not_blocked_by_search_cooldown", "result": "PASS",
                                   "httpStatus": diagnostic_post["httpStatus"], "testingModePrefix": True,
                                   "manualSearchStillCoolingDown": True, "chatgptOperationWasIdle": True,
                                   "noDevicePairedOrExternalMessageSent": True, "dispatchRemainsLocalAndQueued": True})

        # User A and B/C are isolated by real local RLS and user-scoped app routes.
        user_b_token = onboarding.login_token(api_url, publishable_key, account_b)
        user_c_token = onboarding.login_token(api_url, publishable_key, account_c)
        isolation = []
        for name, token in (("B", user_b_token), ("C", user_c_token)):
            status, payload = onboarding.json_request(api_url + "/rest/v1/candidate_preferences?select=profile_id,preferences&profile_id=eq." + urllib.parse.quote(account_a["profileId"]),
                                                       "GET", None, onboarding.auth_headers(publishable_key, token))
            rows = json.loads(payload) if status == 200 else None
            isolation.append({"otherUser": name, "httpStatus": status, "foreignPreferenceRows": len(rows) if isinstance(rows, list) else None,
                              "result": "PASS" if status == 200 and rows == [] else "FAIL"})
        if any(item["result"] != "PASS" for item in isolation):
            raise RuntimeError("A different local authenticated user could read User A's search preferences.")
        report["twoUserIsolation"] = {"checks": isolation, "realLocalUserJwtUsed": True, "tokensRecorded": False,
                                      "syntheticUsers": True, "googleGrantVaultScopedByUser": True}

        # Confirm actual local Supabase Cron is installed and performing real one-minute invocations.
        cron_baseline = psql_json(db_container, "SELECT json_build_object('jobId',(SELECT jobid FROM cron.job WHERE jobname='job-search-dispatch-due-runs' AND active),'schedule',(SELECT schedule FROM cron.job WHERE jobname='job-search-dispatch-due-runs' AND active),'active',(SELECT active FROM cron.job WHERE jobname='job-search-dispatch-due-runs'),'recentRunCount',(SELECT count(*) FROM cron.job_run_details WHERE jobid=(SELECT jobid FROM cron.job WHERE jobname='job-search-dispatch-due-runs') AND start_time>now()-interval '3 minutes'),'latestStart',(SELECT max(start_time) FROM cron.job_run_details WHERE jobid=(SELECT jobid FROM cron.job WHERE jobname='job-search-dispatch-due-runs')))::text;")
        if not cron_baseline.get("jobId") or cron_baseline.get("schedule") != "* * * * *":
            raise RuntimeError("The local Supabase Cron job is not active at its expected minute cadence.")
        cron_job_id_for_restore = int(cron_baseline["jobId"])
        source_counts = psql_json(db_container, "SELECT json_build_object('enabled',(SELECT count(*) FROM public.job_search_sources WHERE user_id='" + account_a["userId"] + "'::uuid AND enabled),'runs',(SELECT count(*) FROM public.job_search_runs WHERE user_id='" + account_a["userId"] + "'::uuid))::text;")
        if not source_counts.get("enabled"):
            raise RuntimeError("No enabled synthetic discovery source is available for the actual Cron run.")

        # Refresh A's Sheet readback in the visible UI immediately before scheduling.
        onboarding.switch_user(observer, hwnd, chrome.pid, app_url, account_a, report, "User A for schedule")
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/settings")
        wait_body(observer, "Google Sheets", "User A Sheet before scheduled run")
        final_sync_click = desktop.native_click_selector(observer, hwnd, chrome.pid, "section.settingsCard button.primaryButton")
        wait_body(observer, "Up to date", "fresh verified User A Sheet for scheduled run", 70)
        report["workflow"].append({"name": "pre_schedule_sheet_version_verified", "result": "PASS", "nativeSyncClick": final_sync_click})

        # Close only the owned browser. The actual due event must run while the user browser is absent.
        report["cleanup"]["chromeExitedBeforeScheduledEvent"] = not stop_chrome(chrome, chrome_pids, observer)
        chrome = None
        observer = None
        report["cleanup"]["chromeExited"] = report["cleanup"]["chromeExitedBeforeScheduledEvent"]
        user_a_id = account_a["userId"]
        scheduler_secret = create_fake_scheduler_secret(db_container)
        worker_port = desktop.free_loopback_port()
        worker, worker_pids, worker_vars_file = start_local_worker(repo, workspace, run_root, evidence, worker_port,
                                                                  provider_port, api_url, publishable_key, scheduler_secret)
        report["worker"].update({"pid": worker.pid, "origin": f"http://127.0.0.1:{worker_port}",
                                 "scheduledEvent": "local Wrangler /__scheduled endpoint", "testMode": True,
                                 "host": "127.0.0.1", "testVariablesFile": "temporary .dev.vars (removed during cleanup)"})
        report["milestones"].append({"name": "loopback_cloudflare_worker_ready", "timeUtc": utc_now(), "pid": worker.pid,
                                     "port": worker_port, "productionResources": False})
        # Pause only the local one-minute Cron row while the Worker claims its
        # synthetic due check. Otherwise a natural Cron tick could race the
        # test event and move the due window before the isolated preflight.
        # The original active state is restored immediately after the Worker
        # proof and again from finally if any assertion fails.
        onboarding.psql(db_container, "SELECT cron.alter_job(" + str(cron_job_id_for_restore) + ", active := false);")
        cron_job_paused = True
        report["cleanup"]["localCronRestored"] = False
        due_seed = onboarding.psql(db_container, "UPDATE public.job_search_controls SET next_scheduled_search_at=now()-interval '5 seconds',last_scheduled_search_error=null WHERE user_id='" + user_a_id + "'::uuid AND search_schedule_enabled=true RETURNING user_id;")
        if user_a_id not in due_seed:
            raise RuntimeError("The synthetic User A schedule was not enabled before the due-time fixture was set.")
        # The synthetic spreadsheet was just read back by the UI. Age only this
        # disposable proof timestamp so the real Worker must perform its Drive
        # preflight before Supabase Cron may dispatch the due search.
        onboarding.psql(db_container, "UPDATE public.job_pool_sheet_sync SET drive_verified_at=now()-interval '3 minutes' WHERE user_id='" + user_a_id + "'::uuid;")
        preflight_eligibility = psql_json(db_container, "SELECT json_build_object('due',(c.next_scheduled_search_at<=now()),'scheduleEnabled',c.search_schedule_enabled,'cadence',coalesce(cp.preferences->>'search_cadence','daily'),'poolReady',(s.spreadsheet_id is not null and s.current_publication_id is not null and s.last_sync_status='ok' and s.source_revision=s.published_revision),'staleProof',(s.drive_verified_at<now()-interval '2 minutes'),'refreshCredentialPresent',exists(select 1 from private.gmail_oauth_credentials gc join vault.decrypted_secrets ds on ds.id=gc.refresh_secret_id where gc.user_id=c.user_id),'blockingRuns',(select count(*) from public.job_search_runs r where r.user_id=c.user_id and r.state in ('queued','running','importing') and not (r.dispatch_request_id is null and r.created_at<now()-interval '45 minutes')),'cronActive',(select active from cron.job where jobid=" + str(cron_job_id_for_restore) + "))::text FROM public.job_search_controls c JOIN public.candidate_profiles p ON p.user_id=c.user_id JOIN public.candidate_preferences cp ON cp.profile_id=p.id JOIN public.job_pool_sheet_sync s ON s.user_id=c.user_id WHERE c.user_id='" + user_a_id + "'::uuid;")
        if (preflight_eligibility.get("due") is not True or preflight_eligibility.get("scheduleEnabled") is not True
                or preflight_eligibility.get("cadence") not in ("daily", "weekdays", "weekly")
                or preflight_eligibility.get("poolReady") is not True or preflight_eligibility.get("staleProof") is not True
                or preflight_eligibility.get("refreshCredentialPresent") is not True or preflight_eligibility.get("blockingRuns") != 0
                or preflight_eligibility.get("cronActive") is not False):
            raise RuntimeError("The isolated scheduled Drive-check fixture was not eligible: " + json.dumps(preflight_eligibility))
        report["milestones"].append({"name": "local_worker_preflight_fixture_eligible", "timeUtc": utc_now(), **preflight_eligibility})
        provider_before_worker = local_json(f"http://127.0.0.1:{provider_port}/__test/report")
        worker_event_url = f"http://127.0.0.1:{worker_port}/__scheduled?" + urllib.parse.urlencode({"cron": "* * * * *"})
        try:
            with urllib.request.urlopen(worker_event_url, timeout=90) as response:
                worker_event_status = response.status
                worker_event_body = response.read(2000).decode("utf-8", errors="replace")
        except Exception as exc:
            raise RuntimeError("The local Cloudflare Worker did not run its isolated scheduled-event handler.") from exc
        provider_after_worker = local_json(f"http://127.0.0.1:{provider_port}/__test/report")
        new_routes = provider_after_worker.get("routes", [])[provider_before_worker.get("eventCount", 0):]
        drive_preflight_called = any(route == "POST /token" for route in new_routes) and any(route.startswith("GET /drive/v3/files/") for route in new_routes)
        worker_freshness = psql_json(db_container, "SELECT json_build_object('fresh',(SELECT drive_verified_at>now()-interval '2 minutes' AND drive_verified_version=drive_file_version FROM public.job_pool_sheet_sync WHERE user_id='" + user_a_id + "'::uuid),'lastError',(SELECT last_scheduled_search_error FROM public.job_search_controls WHERE user_id='" + user_a_id + "'::uuid))::text;")
        if worker_event_status != 200 or not drive_preflight_called or worker_freshness.get("fresh") is not True:
            raise RuntimeError("The local Cloudflare Worker failed its test-mode loopback Drive preflight: " + json.dumps({"status": worker_event_status, "providerRoutes": new_routes, "fresh": worker_freshness.get("fresh"), "lastError": worker_freshness.get("lastError"), "eligibility": preflight_eligibility}))
        onboarding.psql(db_container, "SELECT cron.alter_job(" + str(cron_job_id_for_restore) + ", active := true);")
        cron_job_paused = False
        report["cleanup"]["localCronRestored"] = True
        reactivated_cron = psql_json(db_container, "SELECT json_build_object('active',active,'schedule',schedule)::text FROM cron.job WHERE jobid=" + str(cron_job_id_for_restore) + ";")
        if reactivated_cron.get("active") is not True or reactivated_cron.get("schedule") != "* * * * *":
            raise RuntimeError("The local pg_cron row did not restore to its original active one-minute schedule.")
        report["worker"]["scheduledEvent"] = {"result": "PASS", "httpStatus": worker_event_status,
                                                "testScheduledEndpoint": "/__scheduled", "loopbackGoogleTokenAndDriveCalls": True,
                                                "freshDriveProofRecorded": True, "workerResponseLength": len(worker_event_body)}
        report["workflow"].append({"name": "cloudflare_worker_drive_preflight_local_runtime", "result": "CONTROLLED PASS",
                                   "workerRuntime": "Wrangler local Cloudflare runtime", "scheduledHandlerInvoked": True,
                                   "productionResources": False, "loopbackGoogleProvider": True,
                                   "freshDriveProofRecorded": True})
        due_started = utc_now()
        report["milestones"].append({"name": "local_cron_due_time_seeded_browser_closed", "timeUtc": due_started,
                                     "scheduleRowSynthetic": True, "directSchedulerInvocation": False,
                                     "workerPreflightAlreadyVerified": True})
        deadline = time.monotonic() + 90
        scheduled = None
        while time.monotonic() < deadline:
            candidate = psql_json(db_container, "SELECT json_build_object('runCount',(SELECT count(*) FROM public.job_search_runs WHERE user_id='" + user_a_id + "'::uuid AND trigger='scheduled'),'runId',(SELECT id FROM public.job_search_runs WHERE user_id='" + user_a_id + "'::uuid AND trigger='scheduled' ORDER BY requested_at DESC LIMIT 1),'runUser',(SELECT user_id FROM public.job_search_runs WHERE user_id='" + user_a_id + "'::uuid AND trigger='scheduled' ORDER BY requested_at DESC LIMIT 1),'dispatchUser',(SELECT d.user_id FROM public.job_search_runs r JOIN public.chatgpt_dispatch_requests d ON d.id=r.dispatch_request_id WHERE r.user_id='" + user_a_id + "'::uuid AND r.trigger='scheduled' ORDER BY r.requested_at DESC LIMIT 1),'snapshotCount',(SELECT count(*) FROM public.job_search_run_pool_snapshots s JOIN public.job_search_runs r ON r.id=s.run_id WHERE r.user_id='" + user_a_id + "'::uuid AND r.trigger='scheduled'),'lastScheduledAt',(SELECT last_scheduled_search_at FROM public.job_search_controls WHERE user_id='" + user_a_id + "'::uuid),'nextScheduledAt',(SELECT next_scheduled_search_at FROM public.job_search_controls WHERE user_id='" + user_a_id + "'::uuid),'lastError',(SELECT last_scheduled_search_error FROM public.job_search_controls WHERE user_id='" + user_a_id + "'::uuid))::text;")
            if candidate.get("runCount"):
                scheduled = candidate
                break
            time.sleep(1.2)
        if not scheduled:
            latest = psql_json(db_container, "SELECT json_build_object('lastError',(SELECT last_scheduled_search_error FROM public.job_search_controls WHERE user_id='" + user_a_id + "'::uuid),'driveFresh',(SELECT drive_verified_at>now()-interval '2 minutes' AND drive_verified_version=drive_file_version FROM public.job_pool_sheet_sync WHERE user_id='" + user_a_id + "'::uuid),'cronRuns',(SELECT count(*) FROM cron.job_run_details WHERE jobid=" + str(cron_baseline["jobId"]) + " AND start_time>now()-interval '2 minutes'))::text;")
            raise RuntimeError("The actual local Cron tick did not create the isolated scheduled run: " + json.dumps(latest))
        if scheduled.get("runCount") != 1 or scheduled.get("runUser") != user_a_id or scheduled.get("dispatchUser") != user_a_id or scheduled.get("snapshotCount") != 1:
            raise RuntimeError("The genuine scheduled event did not create exactly one correctly owned run and Sheet snapshot.")
        report["workflow"].append({"name": "genuine_pg_cron_due_run_browser_offline", "result": "PASS", "cronJobId": cron_baseline["jobId"],
                                   "cronSchedule": cron_baseline["schedule"], "scheduledRunId": scheduled["runId"],
                                   "runOwnedBySyntheticUser": True, "dispatchOwnerMatched": True, "sheetSnapshotCaptured": True,
                                   "browserWasClosed": True, "schedulerFunctionNotInvokedManually": True,
                                   "nextRunAdvanced": bool(scheduled.get("nextScheduledAt")), "error": None})
        report["milestones"].append({"name": "genuine_local_cron_run_created", "timeUtc": scheduled.get("lastScheduledAt"), "runId": scheduled["runId"]})

        # One further real minute tick must not duplicate the scheduled window.
        run_count = int(scheduled["runCount"])
        cron_deadline = time.monotonic() + 155
        after_tick = None
        while time.monotonic() < cron_deadline:
            after_tick = psql_json(db_container, "SELECT json_build_object('runCount',(SELECT count(*) FROM public.job_search_runs WHERE user_id='" + user_a_id + "'::uuid AND trigger='scheduled'),'nextScheduledAt',(SELECT next_scheduled_search_at FROM public.job_search_controls WHERE user_id='" + user_a_id + "'::uuid),'lastError',(SELECT last_scheduled_search_error FROM public.job_search_controls WHERE user_id='" + user_a_id + "'::uuid),'cronTicks',(SELECT count(*) FROM cron.job_run_details WHERE jobid=" + str(cron_baseline["jobId"]) + " AND start_time>'" + str(cron_baseline["latestStart"]) + "'::timestamptz))::text;")
            if int(after_tick.get("cronTicks") or 0) >= 2:
                break
            time.sleep(1.2)
        if not after_tick or int(after_tick.get("cronTicks") or 0) < 2:
            raise TimeoutError("A second independent pg_cron minute tick was not observed within 155 seconds.")
        if after_tick.get("runCount") != run_count:
            raise RuntimeError("A repeated Cron tick created a duplicate scheduled run.")
        report["workflow"].append({"name": "repeated_cron_tick_idempotency", "result": "PASS", "runCountBefore": run_count,
                                   "runCountAfter": after_tick["runCount"], "nextRunStillScheduled": bool(after_tick.get("nextScheduledAt")),
                                   "independentCronTicksObserved": after_tick.get("cronTicks")})

        # Reopen the same fresh test profile and verify that the offline run appears from backend state.
        chrome, chrome_pids, observer, hwnd, window_state = launch_chrome(repo, run_root, profile, app_url, evidence)
        if observer.evaluate("location.pathname") != "/login":
            desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/jobs/settings")
        else:
            onboarding.switch_user(observer, hwnd, chrome.pid, app_url, account_a, report, "User A reconnect after Cron")
            desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/jobs/settings")
        wait_body(observer, "Next search", "scheduled next-run and last-run UI after browser reconnect", 60)
        scheduled_ui = wait_scheduled_search_reflection(observer, 60)
        ui_state = onboarding.safe_ui_state(observer)
        report["workflow"].append({"name": "scheduled_run_visible_after_refresh_and_reconnect", "result": "PASS",
                                   "nextRunShown": "Next search" in ui_state.get("body", ""),
                                   "lastRunShowsQueuedState": scheduled_ui["visibleStatus"].lower() == "queued",
                                   "authenticatedReadback": True, "scheduledRunState": scheduled_ui["scheduledRuns"][0]["state"]})
        report["screenshots"].append(desktop.desktop_screenshot(evidence / "10-scheduled-run-after-browser-reconnect.png", hwnd, chrome.pid, (display["width"], display["height"])))

        # Honest security and transport report: no extension was paired, so local queued actions were not externally sent.
        google_report = local_json(f"http://127.0.0.1:{provider_port}/__test/report")
        report["controlledGoogleProvider"] = {"host": "127.0.0.1", "workbookCount": google_report.get("workbookCount"),
                                               "eventCount": google_report.get("eventCount"), "routes": google_report.get("routes"),
                                               "requestBodiesRecorded": False, "fakeRefreshGrantsInLocalVault": True,
                                               "liveGoogleOAuth": "NOT VERIFIED; no separate development OAuth client was configured"}
        report["externalActions"] = {"realGoogleFilesCreated": False, "realGoogleOAuth": False, "productionModified": False,
                                      "realChatGptMemoryChanged": False, "externalBridgeMessagesSent": False,
                                      "employerCommunications": False, "applicationsSubmitted": False,
                                      "localQueuedBridgeDispatchesOnly": True, "testingModeWasVisibleAndEnabled": True}
        report["limitations"].append("Google OAuth consent, real Drive ownership, and a real Google Sheet were not exercised; the exact app Google API calls ran against an explicit loopback emulator.")
        report["limitations"].append("Website Bridge requests remained queued in the isolated local database because the test profile had no paired extension and did not connect to ChatGPT.")
        report["result"] = "PASS_WITH_EXTERNAL_GAPS"
    except Exception as exc:
        report["result"] = "FAIL"
        message = str(exc)
        for secret in sensitive_values:
            if secret:
                message = message.replace(secret, "<redacted>")
        report["error"] = type(exc).__name__ + ": " + message[:600]
        if chrome and observer and hwnd:
            try:
                report["failureScreenshot"] = desktop.desktop_screenshot(
                    evidence / "failure-state.png", hwnd, chrome.pid,
                    (desktop.user32.GetSystemMetrics(0), desktop.user32.GetSystemMetrics(1)),
                )
                report["failureLayout"] = observer.evaluate("""JSON.stringify((()=>{
                  const target=document.querySelector('#memory-update button.primaryButton');
                  const rect=target?.getBoundingClientRect();
                  const scrollers=[...document.querySelectorAll('*')].filter(e=>{
                    const s=getComputedStyle(e);return /(auto|scroll)/.test(s.overflowY)&&e.scrollHeight>e.clientHeight+2;
                  }).slice(0,10).map(e=>({tag:e.tagName,className:String(e.className||'').slice(0,100),scrollTop:e.scrollTop,clientHeight:e.clientHeight,scrollHeight:e.scrollHeight}));
                  return {viewport:{innerHeight,scrollY,scrollHeight:document.documentElement.scrollHeight,bodyScrollHeight:document.body.scrollHeight,visualViewportHeight:visualViewport?.height||null,dpr:devicePixelRatio},
                    targetExists:!!target,targetRect:rect?{x:rect.x,y:rect.y,width:rect.width,height:rect.height}:null,
                    targetDocumentTop:rect?rect.y+scrollY:null,memoryDetailsOpen:document.querySelector('#chatgpt-memory')?.open===true,
                    moreDetailsOpen:document.querySelector('#more-profile-details')?.open===true,scrollers};
                })())""")
            except Exception:
                report["failureScreenshot"] = "unavailable"
    finally:
        chrome_left = stop_chrome(chrome, chrome_pids, observer) if chrome else []
        report["cleanup"].update({"chromeExited": not chrome_left, "chromeRemainingPids": chrome_left})
        if server:
            report["cleanup"]["serverRemainingPids"] = desktop.stop_owned_process(server, server_pids, graceful=True)
            report["cleanup"]["serverExited"] = not report["cleanup"]["serverRemainingPids"] and server.poll() is not None
        if worker:
            report["cleanup"]["workerRemainingPids"] = desktop.stop_owned_process(worker, worker_pids, graceful=True)
            report["cleanup"]["workerExited"] = not report["cleanup"]["workerRemainingPids"] and worker.poll() is not None
        if worker_vars_file:
            try:
                worker_vars_file.unlink(missing_ok=True)
                report["cleanup"]["workerVariablesRemoved"] = not worker_vars_file.exists()
            except Exception:
                report["cleanup"]["workerVariablesRemoved"] = False
        if cron_job_paused and cron_job_id_for_restore is not None:
            try:
                onboarding.psql(db_container, "SELECT cron.alter_job(" + str(cron_job_id_for_restore) + ", active := true);")
                restored = psql_json(db_container, "SELECT json_build_object('active',active,'schedule',schedule)::text FROM cron.job WHERE jobid=" + str(cron_job_id_for_restore) + ";")
                report["cleanup"]["localCronRestored"] = restored.get("active") is True and restored.get("schedule") == "* * * * *"
            except Exception:
                report["cleanup"]["localCronRestored"] = False
            if not report["cleanup"]["localCronRestored"]:
                report["result"] = "FAIL_CLEANUP"
        if provider:
            try:
                local_json(f"http://127.0.0.1:{provider_port}/__test/shutdown", "POST", {})
            except Exception:
                pass
            report["cleanup"]["providerRemainingPids"] = desktop.stop_owned_process(provider, provider_pids, graceful=True)
            report["cleanup"]["providerExited"] = not report["cleanup"]["providerRemainingPids"] and provider.poll() is not None
        try:
            if accounts:
                onboarding.cleanup_accounts(api_url, service_key, db_container, accounts, report)
                identities = ",".join("'" + account["userId"] + "'" for account in accounts)
                onboarding.psql(db_container, "DELETE FROM vault.secrets WHERE name IN (" + ",".join("'job-hunt-gmail-refresh-" + account["userId"] + "'" for account in accounts) + ");")
                remaining = psql_json(db_container, "SELECT json_build_object('runs',(SELECT count(*) FROM public.job_search_runs WHERE user_id IN (" + ",".join("'" + account["userId"] + "'::uuid" for account in accounts) + ")),'dispatches',(SELECT count(*) FROM public.chatgpt_dispatch_requests WHERE user_id IN (" + ",".join("'" + account["userId"] + "'::uuid" for account in accounts) + ")),'poolRows',(SELECT count(*) FROM public.job_pool_sheet_sync WHERE user_id IN (" + ",".join("'" + account["userId"] + "'::uuid" for account in accounts) + ")),'vaultRefreshSecrets',(SELECT count(*) FROM vault.secrets WHERE name IN (" + ",".join("'job-hunt-gmail-refresh-" + account["userId"] + "'" for account in accounts) + ")))::text;")
                report["syntheticCleanupVerification"] = remaining
                report["cleanup"]["syntheticAccountsRemoved"] = all(value == 0 for value in remaining.values()) and report.get("syntheticDataCleanup", {}).get("complete") is True
                if not report["cleanup"]["syntheticAccountsRemoved"]:
                    report["result"] = "FAIL_CLEANUP"
        except Exception as cleanup_error:
            report["cleanup"]["syntheticCleanupError"] = type(cleanup_error).__name__
            report["result"] = "FAIL_CLEANUP"
        if scheduler_secret:
            try:
                clean_test_scheduler_secret(db_container)
                remaining_secret = onboarding.psql(db_container, "SELECT count(*) FROM vault.secrets WHERE name='job-pool-scheduler-secret' AND description='M03 local test only; removed during cleanup';").splitlines()[-1]
                report["cleanup"]["schedulerSecretRemoved"] = remaining_secret == "0"
                if not report["cleanup"]["schedulerSecretRemoved"]:
                    report["result"] = "FAIL_CLEANUP"
            except Exception:
                report["cleanup"]["schedulerSecretRemoved"] = False
                report["result"] = "FAIL_CLEANUP"
        if report["cleanup"].get("serverExited") and report["cleanup"].get("chromeExited") and report["cleanup"].get("providerExited") and report["cleanup"].get("workerExited") and report["cleanup"].get("workerVariablesRemoved"):
            try:
                shutil.rmtree(run_root)
                report["cleanup"]["temporaryWorkspaceRemoved"] = True
            except Exception:
                report["cleanup"]["temporaryWorkspaceRemoved"] = False
        report["completedAtUtc"] = utc_now()
        report["evidenceDirectory"] = f"<evidence>/{run_id}"
        (evidence / "m03-desktop-run.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", default=".")
    parser.add_argument("--evidence-dir")
    args = parser.parse_args()
    report = run(args)
    print(json.dumps({"result": report["result"], "evidenceDirectory": report["evidenceDirectory"],
                      "workflowCount": len(report["workflow"]), "cleanup": report["cleanup"], "error": report["error"]}, indent=2))
    return 0 if report["result"] == "PASS_WITH_EXTERNAL_GAPS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
