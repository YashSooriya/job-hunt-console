#!/usr/bin/env python3
"""Focused M05 native Windows UI and local Supabase acceptance."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

import windows_m03_supabase_acceptance as m03
import windows_supabase_onboarding_acceptance as onboarding
import windows_web_ui_acceptance as desktop
import windows_m04_combined_import_acceptance as m04


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def sql_json(container: str, sql: str) -> dict:
    return m03.psql_json(container, sql)


def scoped_database(container: str, user_id: str) -> dict:
    if not re.fullmatch(r"[0-9a-f-]{36}", user_id, re.I):
        raise RuntimeError("Refusing a database check without a synthetic user UUID.")
    return sql_json(container, f"""
      select json_build_object(
        'jobs',(select count(*) from public.jobs where user_id='{user_id}'::uuid),
        'analyses',(select count(*) from public.job_analyses a join public.jobs j on j.id=a.job_id where j.user_id='{user_id}'::uuid),
        'applications',(select count(*) from public.applications where user_id='{user_id}'::uuid),
        'tasks',(select count(*) from public.automation_tasks where user_id='{user_id}'::uuid and entity_type='application'),
        'documents',(select count(*) from public.documents d join public.applications a on a.id=d.application_id where a.user_id='{user_id}'::uuid),
        'documentRequests',(select count(*) from public.document_generation_requests where user_id='{user_id}'::uuid),
        'formSessions',(select count(*) from public.form_agent_sessions where user_id='{user_id}'::uuid)
      )::text;
    """)


def sheet_state(container: str, user_id: str) -> dict:
    return sql_json(container, f"""
      select json_build_object('sourceRevision',source_revision,'publishedRevision',published_revision,
        'syncStatus',last_sync_status,'rowCount',row_count,'spreadsheetConfigured',spreadsheet_id is not null)
      from public.job_pool_sheet_sync where user_id='{user_id}'::uuid;
    """)


def create_legacy_application(container: str, user_id: str, job_id: str) -> dict:
    for value in (user_id, job_id):
        if not re.fullmatch(r"[0-9a-f-]{36}", value, re.I):
            raise RuntimeError("Refusing a legacy application fixture without synthetic UUIDs.")
    row = sql_json(container, f"""
      with fixture as (
        select j.id as job_id,j.user_id,j.current_snapshot_id as snapshot_id,a.id as analysis_id,
          a.recommended_cv_family,a.application_strategy,a.evidence_item_ids
        from public.jobs j join lateral (
          select x.* from public.job_analyses x where x.job_id=j.id
          order by case when x.engine_version='job-fit-memory-v4' then 0 else 1 end,x.created_at desc,x.id desc limit 1
        ) a on true
        where j.id='{job_id}'::uuid and j.user_id='{user_id}'::uuid
      ), inserted as (
        insert into public.applications(user_id,job_id,state,job_snapshot_id,job_analysis_id,selected_cv_family,
          preparation_origin,preparation_metadata,next_action,notes)
        select user_id,job_id,'preparing',snapshot_id,analysis_id,recommended_cv_family,'auto_prepare',
          jsonb_build_object('fixture','synthetic historical M22 application'),'Continue legacy preparation after user choice.',
          'M05 synthetic legacy-history fixture'
        from fixture returning id,user_id,job_id,job_analysis_id
      ), strategy as (
        insert into public.application_strategies(application_id,job_analysis_id,strategy_text,evidence_item_ids)
        select i.id,f.analysis_id,coalesce(f.application_strategy,''),f.evidence_item_ids from inserted i join fixture f on f.job_id=i.job_id
        returning application_id
      ), tasks as (
        insert into public.automation_tasks(user_id,task_type,state,idempotency_key,entity_type,entity_id,
          attempt_count,last_error,input_json,output_json)
        select i.user_id,x.task_type,'pending','m05-legacy-fixture:'||i.id::text||':'||x.task_type,'application',i.id,
          2,'Synthetic historical attempt marker',jsonb_build_object('execution_mode','chatgpt_plus_handoff'),
          jsonb_build_object('attempt_history',jsonb_build_array('synthetic_attempt_1','synthetic_attempt_2'))
        from inserted i cross join (values ('prepare_cv'),('prepare_cover_letter'),('prepare_screening_answers')) x(task_type)
        returning id,state,attempt_count,last_error,output_json
      )
      select json_build_object('applicationId',(select id from inserted),'taskCount',count(*),
        'tasks',json_agg(json_build_object('id',id,'state',state,'attemptCount',attempt_count,
          'lastError',last_error,'output',output_json) order by id))::text from tasks;
    """)
    return row


def assert_no_content_side_effects(state: dict, expected_apps: int, expected_tasks: int | None = None) -> None:
    if state.get("applications") != expected_apps or state.get("documents") != 0 \
            or state.get("documentRequests") != 0 or state.get("formSessions") != 0:
        raise RuntimeError("M05 created unauthorized application content or form work: " + json.dumps(state, sort_keys=True))
    if expected_tasks is not None and state.get("tasks") != expected_tasks:
        raise RuntimeError("M05 changed legacy preparation task count: " + json.dumps(state, sort_keys=True))


def provider_read(provider_port: int, workbook_id: str) -> dict:
    workbooks = m03.local_json(f"http://127.0.0.1:{provider_port}/__test/workbooks")
    workbook = next((item for item in workbooks if isinstance(item, dict) and item.get("id") == workbook_id), None)
    tab = next((item for item in workbook.get("tabs", []) if isinstance(item, dict) and item.get("title") == "Job Pool"), None) if workbook else None
    if not isinstance(tab, dict) or int(tab.get("rows", 0)) < 1 or int(tab.get("columns", 0)) < 1:
        raise RuntimeError("The loopback Google fixture did not report the managed Job Pool grid bounds.")
    def column_label(number: int) -> str:
        result = ""
        while number:
            number, remainder = divmod(number - 1, 26)
            result = chr(65 + remainder) + result
        return result
    range_value = f"'Job Pool'!A1:{column_label(int(tab['columns']))}{int(tab['rows'])}"
    url = f"http://127.0.0.1:{provider_port}/__test/read?id={urllib.parse.quote(workbook_id)}&range={urllib.parse.quote(range_value)}"
    with urllib.request.urlopen(url, timeout=10) as response:
        return json.loads(response.read())


def wait_for(predicate, description: str, timeout: float = 35):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = predicate()
        if last:
            return last
        time.sleep(0.2)
    raise TimeoutError("Timed out waiting for " + description + ".")


def concurrent_apply(observer: desktop.CDPObserver, job_id: str, count: int = 5) -> list[dict]:
    expression = "(async()=>{const jobId=" + json.dumps(job_id) + ";const calls=Array.from({length:" + str(count) + "},()=>fetch('/api/applications/create',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({jobId,origin:'manual'})}));const rows=await Promise.all(calls.map(async p=>{const r=await p;return {status:r.status,data:await r.json()}}));return JSON.stringify(rows.map(x=>({status:x.status,ok:x.data.ok===true,applicationId:x.data.applicationId||null,created:x.data.created===true})));})()"
    result = observer.evaluate(expression)
    if not isinstance(result, list):
        raise RuntimeError("Concurrent apply responses could not be read back through the authenticated local browser.")
    return result


def apply_button_selector(observer: desktop.CDPObserver, job_id: str) -> dict:
    expression = "JSON.stringify((()=>{const path='/jobs/'+" + json.dumps(job_id) + ";const link=[...document.querySelectorAll('a.jobPoolRole')].find(e=>e.getAttribute('href')?.split('?')[0]===path);const row=link?.closest('tr');const button=row?.querySelector('button.primaryButton');const parts=[];for(let n=button;n&&n.nodeType===1;n=n.parentElement){let part=n.localName;const siblings=n.parentElement?[...n.parentElement.children].filter(x=>x.localName===n.localName):[];if(siblings.length>1)part+=':nth-of-type('+(siblings.indexOf(n)+1)+')';parts.unshift(part);if(n===document.documentElement)break;}return {exists:!!button,text:button?.innerText.trim()||null,disabled:button?.disabled===true,selector:parts.join(' > ')}})())"
    return observer.evaluate(expression)


def run(args) -> dict:
    if os.name != "nt":
        raise SystemExit("M05 desktop acceptance requires the Windows native input runner.")
    repo = Path(args.source_root).resolve()
    run_id = uuid.uuid4().hex
    temp_root = Path(os.environ.get("TEMP", str(Path.home() / "AppData/Local/Temp"))).resolve()
    run_root = temp_root / f"JobHuntAI-M05-Local-UI-{run_id}"
    workspace, profile = run_root / "workspace", run_root / "chrome-profile"
    evidence_root = Path(args.evidence_dir).resolve() if args.evidence_dir else temp_root / "JobHuntAI-M05-Evidence"
    evidence = evidence_root / run_id
    run_root.mkdir(parents=True, exist_ok=False)
    evidence.mkdir(parents=True, exist_ok=False)
    api_url = os.environ["JOBHUNT_M02_SUPABASE_URL"].rstrip("/")
    publishable_key = os.environ["JOBHUNT_M02_PUBLISHABLE_KEY"]
    service_key = os.environ["JOBHUNT_M02_SERVICE_KEY"]
    container = os.environ["JOBHUNT_M02_DB_CONTAINER"]
    provider_port = desktop.free_loopback_port()
    app_port = desktop.free_loopback_port()
    report = {
        "schemaVersion": "1.0.0", "milestone": "M05", "runId": run_id, "startedAtUtc": utc_now(),
        "repository": {"head": subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip(),
                       "branch": subprocess.run(["git", "-C", str(repo), "branch", "--show-current"], capture_output=True, text=True, check=True).stdout.strip()},
        "testLevel": "genuine_windows_desktop_ui_with_win32_input_and_authenticated_local_supabase",
        "commands": ["powershell -ExecutionPolicy Bypass -File scripts/run-m05-local-supabase-ui.ps1",
                     "Win32 SendInput mouse/keyboard; full-desktop ImageGrab; loopback CDP state readback; local Supabase Edge Bridge and Google fixture"],
        "application": {"type": "Next.js web application in test-owned Chrome", "version": json.loads((repo / "apps/web/package.json").read_text(encoding="utf-8")).get("version"),
                        "frameworkVersion": json.loads((repo / "node_modules/next/package.json").read_text(encoding="utf-8")).get("version"),
                        "chromeExecutable": None, "chromeVersion": None, "chromePid": None, "serverPid": None,
                        "window": None, "workspace": f"%TEMP%\\JobHuntAI-M05-Local-UI-{run_id}", "profileIsolated": True},
        "backend": {"kind": "loopback Supabase in WSL2 with test-owned local Bridge Edge Function", "apiOrigin": "127.0.0.1",
                    "productionTouched": False, "realChatGptActivity": False, "paidResourcesCreated": False,
                    "syntheticGoogleProvider": "loopback only"},
        "environment": {"dpiAwareness": desktop.enable_per_monitor_dpi_awareness(), "display": None},
        "fixtures": {"accountsSynthetic": True, "vacancies": 2, "candidateData": "empty synthetic profile", "bridgeResponse": "synthetic controlled provider"},
        "workflow": [], "screenshots": [], "milestones": [],
        "cleanup": {"chromeExited": False, "serverExited": False, "providerExited": False,
                    "syntheticAccountsRemoved": False, "workspaceRemoved": False},
        "result": "RUNNING", "error": None, "evidenceDirectory": f"<evidence>/{run_id}",
    }
    provider = server = chrome = observer = None
    provider_pids: list[int] = []
    server_pids: list[int] = []
    chrome_pids: list[int] = []
    accounts: list[dict] = []
    device_id = device_token = None
    hwnd = None
    try:
        account_a, account_b = onboarding.seed_accounts(argparse.Namespace(), run_id)
        accounts = [account_a, account_b]
        sensitive = [account_a["email"], account_a["password"], account_b["email"], account_b["password"], publishable_key, service_key]
        m03_env = {"JOBHUNT_M03_SUPABASE_URL": api_url, "JOBHUNT_M03_PUBLISHABLE_KEY": publishable_key,
                   "JOBHUNT_M03_SERVICE_KEY": service_key, "JOBHUNT_M03_DB_CONTAINER": container}
        previous_m03_env = {key: os.environ.get(key) for key in m03_env}
        try:
            os.environ.update(m03_env)
            m03.store_fake_google_grant(account_a, "m05")
        finally:
            for key, value in previous_m03_env.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
        copied, packages, dependency_files, supplemental = desktop.copy_isolated_workspace(repo, workspace)
        shim = workspace / "scripts/fixtures/m03-google-fetch-shim.mjs"
        shim.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(repo / "scripts/fixtures/m03-google-fetch-shim.mjs", shim)
        report["sourceCopy"] = {"trackedFiles": copied, "packages": packages, "dependencyFilesHardlinked": dependency_files["hardlinked"],
                                "dependencyFallbackCopies": dependency_files["copiedFallback"], "supplementalFiles": supplemental + ["scripts/fixtures/m03-google-fetch-shim.mjs"],
                                "environmentAndRepositoryDataCopied": False}
        node = shutil.which("node.exe") or shutil.which("node")
        if not node:
            raise FileNotFoundError("Node.js is required for the test-owned local app and Google provider.")
        safe_env = desktop.safe_environment(run_root)
        provider = subprocess.Popen([node, str(repo / "scripts/fixtures/m03-fake-google-provider.mjs"), str(provider_port)],
            cwd=run_root, env=safe_env, stdout=(evidence / "google-provider.log").open("wb"), stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
        provider_pids = desktop.process_tree_pids(provider)
        wait_for(lambda: m03.local_json(f"http://127.0.0.1:{provider_port}/__test/health").get("bind") == "127.0.0.1", "loopback Google fixture")
        env = desktop.safe_environment(run_root)
        env.update({"NEXT_PUBLIC_SUPABASE_URL": api_url, "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY": publishable_key,
                    "JOBHUNT_DATA_MODE": "supabase", "JOBHUNT_TEST_AUTH": "true", "NEXT_TELEMETRY_DISABLED": "1",
                    "GOOGLE_CLIENT_ID": "m05-local-test-client", "GOOGLE_CLIENT_SECRET": "m05-local-test-secret",
                    "JOBHUNT_M03_LOOPBACK_GOOGLE": "1", "JOBHUNT_M03_GOOGLE_PORT": str(provider_port),
                    "NODE_OPTIONS": "--import=" + shim.as_uri()})
        env.pop("NODE_PATH", None)
        app_url = f"http://127.0.0.1:{app_port}"
        next_cli = workspace / "apps/web/node_modules/next/dist/bin/next"
        server = subprocess.Popen([node, str(next_cli), "dev", "--hostname", "127.0.0.1", "--port", str(app_port)],
            cwd=workspace / "apps/web", env=env, stdout=(evidence / "next-dev.log").open("wb"), stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
        server_pids = desktop.process_tree_pids(server)
        report["application"].update({"serverPid": server.pid, "origin": app_url})
        report["milestones"].append({"name": "test_owned_server_started", "timeUtc": utc_now(), "pid": server.pid})
        def login_ready():
            try:
                with urllib.request.urlopen(app_url + "/login?next=%2Fonboarding", timeout=3) as response:
                    return response.status == 200 and b"Local test email" in response.read()
            except Exception:
                return False
        wait_for(login_ready, "authenticated local app", 120)
        profile.mkdir(parents=True, exist_ok=False)
        onboarding.disable_test_profile_password_prompt(profile)
        chrome_path = desktop.find_chrome()
        report["application"].update({"chromeExecutable": str(chrome_path), "chromeVersion": desktop.file_product_version(chrome_path)})
        chrome, chrome_pids, observer, hwnd, window = m03.launch_chrome(repo, run_root, profile, app_url, evidence)
        report["application"].update({"chromePid": chrome.pid, "window": window})
        display = (desktop.user32.GetSystemMetrics(0), desktop.user32.GetSystemMetrics(1))
        bounds = window.get("bounds", {})
        if window.get("ownerPid") != chrome.pid or window.get("maximized") is not True or window.get("isForeground") is not True \
                or bounds.get("right", 0) <= bounds.get("left", 0) or bounds.get("bottom", 0) <= bounds.get("top", 0):
            raise RuntimeError("The test-owned Chrome window was not verified as foreground, maximized, and bounded.")
        if desktop.ImageGrab.grab().size != display:
            raise RuntimeError("Full desktop screenshot dimensions differ from native Windows display metrics.")
        report["environment"]["display"] = {"width": display[0], "height": display[1]}
        report["milestones"].append({"name": "maximized_chrome_and_first_frame", "timeUtc": utc_now(), "pid": chrome.pid,
                                     "window": window, "fullDesktopResolution": display})
        report["screenshots"].append(m04.screenshot(evidence, "00-fresh-local-login.png", hwnd, chrome.pid, display))
        onboarding.switch_user(observer, hwnd, chrome.pid, app_url, account_a, report, "M05 synthetic User A")

        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/diagnostics")
        m04.wait_text(observer, "ChatGPT testing mode", "visible local Testing Mode control")
        testing_click = m03.native_checkbox(observer, hwnd, chrome.pid, "section.diagnosticCooldownCard:first-of-type input[type=checkbox]", True)
        m04.wait_text(observer, "Testing mode is on", "Testing Mode enabled")
        mode = m04.app_data(observer, "/api/diagnostics/testing-mode")
        if mode.get("status") != 200 or mode.get("data", {}).get("enabled") is not True:
            raise RuntimeError("Authenticated local Testing Mode did not read back as enabled.")
        report["workflow"].append({"name": "testing_mode_enabled_by_native_input", "result": "PASS", "click": testing_click,
                                    "authenticatedReadback": True, "syntheticProfileOnly": True})
        report["screenshots"].append(m04.screenshot(evidence, "01-testing-mode-enabled.png", hwnd, chrome.pid, display))

        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/settings")
        m03.wait_body(observer, "Google Sheets", "visible managed Sheet settings")
        sheet_status = m03.browser_private_json(observer, "/api/settings/job-pool-sheet")
        if sheet_status.get("status") != 200 or sheet_status.get("data", {}).get("googleConnection") != "connected":
            raise RuntimeError("The synthetic Google grant was not visible through the authenticated local app.")
        m03.wait_body(observer, "Create spreadsheet", "managed Sheet create action")
        sheet_click = desktop.native_click_selector(observer, hwnd, chrome.pid, "section.settingsCard button.primaryButton")
        workbook, sheet_verification = m03.verify_created_sheet(observer, provider_port, expected_workbook_count=1,
            required_tabs={"Job Pool", "Job Pool Manifest", "Applications", "Applications Manifest"})
        report["workflow"].append({"name": "managed_job_pool_sheet_created_in_loopback_fixture", "result": "PASS",
                                   "nativeClick": sheet_click, "verification": sheet_verification})
        report["screenshots"].append(m04.screenshot(evidence, "02-managed-sheet-ready.png", hwnd, chrome.pid, display))

        bridge_version = json.loads((repo / "apps/chatgpt-bridge-extension/package.json").read_text(encoding="utf-8"))["version"]
        capabilities = {"protocol_version": 2, "build_id": f"{bridge_version}-m05-local-test", "durable_dispatch_v2": True,
                        "send_authorization_v2": True, "result_outbox_v1": True, "result_completion_v3": True,
                        "response_provenance_v3": True, "concurrent_response_capture": 2, "background_focus_policy_v2": True}
        pairing = m04.app_data(observer, "/api/chatgpt-bridge/pairing", "POST", {})
        pairing_code = pairing.get("data", {}).get("pairing_code") if pairing.get("status") == 200 else None
        if not isinstance(pairing_code, str) or not pairing_code:
            raise RuntimeError("Authenticated local Bridge pairing did not return a one-time code.")
        pair_status, paired = m04.bridge_request(api_url, "", "", bridge_version, capabilities, "pair_device", {
            "pairingCode": pairing_code, "displayName": "M05 local synthetic provider", "platform": "chrome", "extensionVersion": bridge_version})
        device = paired.get("device") if isinstance(paired.get("device"), dict) else {}
        device_id, device_token = device.get("id"), paired.get("device_token")
        if pair_status != 200 or not isinstance(device_id, str) or not isinstance(device_token, str):
            raise RuntimeError("The test-owned local Bridge rejected synthetic device pairing.")
        m03.bridge_test_call(api_url, device_id, device_token, bridge_version, capabilities, "device_heartbeat")
        bound = m03.bridge_test_call(api_url, device_id, device_token, bridge_version, capabilities, "bind_conversation", {
            "workflowKey": "job.inspect_url", "conversationUrl": f"https://chatgpt.com/c/m05-local-synthetic-{run_id[:18]}",
            "projectName": "JobHuntAI", "projectVerified": True})
        if bound.get("bound_project_verified") is not True:
            raise RuntimeError("The test-only local Bridge workflow binding was not accepted.")
        m03.bridge_test_call(api_url, device_id, device_token, bridge_version, capabilities,
                             "set_automatic_send", {"enabled": True})
        report["workflow"].append({"name": "local_bridge_pairing_and_binding", "result": "CONTROLLED PASS",
                                    "localEdgeFunction": True, "syntheticAutomaticSendAllowed": True,
                                    "externalChatGptOpened": False, "externalMessages": 0})

        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/jobs")
        m04.wait_jobs_workspace(observer)
        report["screenshots"].append(m04.screenshot(evidence, "03-job-pool-before-import.png", hwnd, chrome.pid, display))
        prior_inspection_reads = observer.evaluate("JSON.stringify(performance.getEntriesByType('resource').filter(e=>new URL(e.name,location.href).pathname==='/api/jobs/inspect').map(e=>e.name))")
        if not isinstance(prior_inspection_reads, list) or prior_inspection_reads:
            raise RuntimeError("The app made an inspection status request before this Bridge import scenario: " + json.dumps(prior_inspection_reads))
        observer.evaluate("(()=>{window.__m05InspectionMethods=[];const original=window.fetch.bind(window);window.fetch=(input,init={})=>{const url=typeof input==='string'?input:input?.url||'';if(new URL(url,location.href).pathname==='/api/jobs/inspect')window.__m05InspectionMethods.push(String(init.method||input?.method||'GET').toUpperCase());return original(input,init)}})()")
        source_urls = [f"https://jobs.example.test/m05/{run_id[:12]}-apply", f"https://jobs.example.test/m05/{run_id[:12]}-legacy"]
        queued = m04.app_data(observer, "/api/jobs/inspect", "POST", {"sourceUrls": source_urls})
        queue_data = queued.get("data", {}) if isinstance(queued.get("data"), dict) else {}
        batch_id = queue_data.get("batchId")
        if queued.get("status") != 202 or not isinstance(batch_id, str):
            raise RuntimeError("The authenticated local app did not queue the synthetic URL batch.")
        pre_status_db = m04.database_batch(container, batch_id)
        dispatch_id = pre_status_db.get("batchDispatchId")
        if pre_status_db.get("inspectionCount") != 2 or pre_status_db.get("distinctJobCount") != 0 \
                or scoped_database(container, account_a["userId"]).get("applications") != 0:
            raise RuntimeError("URL discovery queued application or job rows before the Bridge response/status read.")
        controlled = m04.controlled_complete(api_url, device_id, device_token, bridge_version, capabilities,
                                              "scored_fit", run_id, expected_dispatch_id=dispatch_id)
        before_first_read = scoped_database(container, account_a["userId"])
        pre_read_sheet = sheet_state(container, account_a["userId"])
        if before_first_read.get("jobs") != 2 or before_first_read.get("applications") != 0 \
                or before_first_read.get("documents") != 0 or before_first_read.get("formSessions") != 0 \
                or pre_read_sheet.get("sourceRevision") == pre_read_sheet.get("publishedRevision"):
            raise RuntimeError("The Bridge did not save the expected unchosen vacancy and dirty Sheet state before the first web status read: "
                               + json.dumps({"database": before_first_read, "sheet": pre_read_sheet}))
        reads_before_reconciliation = observer.evaluate("JSON.stringify(window.__m05InspectionMethods||[])")
        if not isinstance(reads_before_reconciliation, list) or any(method == "GET" for method in reads_before_reconciliation):
            raise RuntimeError("An inspection status GET occurred before the Bridge response and pre-read database assertion: " + json.dumps(reads_before_reconciliation))
        report["workflow"].append({"name": "bridge_saved_before_first_status_read_without_app_creation", "result": "PASS",
                                    "bridgeResponseCaptured": controlled.get("captured") is True,
                                    "preReadDatabase": before_first_read, "preReadSheet": pre_read_sheet,
                                    "preReadHttpMethods": reads_before_reconciliation,
                                    "batchId": batch_id})
        first_read = m04.app_data(observer, "/api/jobs/inspect?batchId=" + urllib.parse.quote(batch_id, safe=""))
        if first_read.get("status") != 200 or not first_read.get("data", {}).get("ok"):
            raise RuntimeError("The first owner-authenticated web status read could not reconcile the captured Bridge import.")
        reconciled = m04.database_batch(container, batch_id)
        job_ids = [item.get("jobId") for item in reconciled.get("items", [])]
        if len(job_ids) != 2 or not all(isinstance(value, str) for value in job_ids) or reconciled.get("distinctJobCount") != 2:
            raise RuntimeError("The first status read did not save both Bridge vacancies into the Job Pool.")
        after_import = scoped_database(container, account_a["userId"])
        if after_import.get("jobs") != 2 or after_import.get("applications") != 0:
            raise RuntimeError("Import or initial fit analysis created an application without explicit choice: " + json.dumps(after_import))
        auto_prepare_attempt = m04.app_data(observer, "/api/applications/create", "POST", {"jobId": str(job_ids[0]), "origin": "auto_prepare"})
        if auto_prepare_attempt.get("status") != 400 or scoped_database(container, account_a["userId"]).get("applications") != 0:
            raise RuntimeError("The application API accepted a discovery/import-origin auto-prepare request.")
        report["workflow"].append({"name": "application_api_rejects_non_explicit_origin", "result": "PASS",
                                    "httpStatus": auto_prepare_attempt.get("status"), "noApplicationCreated": True})
        sheet_db = sheet_state(container, account_a["userId"])
        sheet = m03.browser_private_json(observer, "/api/settings/job-pool-sheet")
        sheet_read = provider_read(provider_port, workbook["id"])
        grid_text = json.dumps(sheet_read.get("values", []), ensure_ascii=False)
        expected_title = reconciled["items"][0].get("listing", {}).get("title")
        if sheet_db.get("syncStatus") != "ok" or sheet_db.get("sourceRevision") != sheet_db.get("publishedRevision") \
                or sheet.get("data", {}).get("sheet", {}).get("current") is not True \
                or not expected_title or expected_title not in grid_text:
            raise RuntimeError("First status read did not publish the Bridge-saved vacancy to the managed Sheet: " + json.dumps({
                "db": sheet_db, "apiCurrent": sheet.get("data", {}).get("sheet", {}).get("current"), "expectedTitlePresent": bool(expected_title and expected_title in grid_text)}))
        report["workflow"].append({"name": "first_status_read_published_bridge_import_to_managed_sheet", "result": "PASS",
                                    "firstStatusRead": True, "publication": sheet_db, "providerContainsImportedTitle": True,
                                    "staleRevisionSafeguardsRetained": True, "applicationCountAfterImport": 0})
        status_methods = observer.evaluate("JSON.stringify(window.__m05InspectionMethods||[])")
        if not isinstance(status_methods, list) or status_methods.count("POST") != 1 or status_methods.count("GET") != 1:
            raise RuntimeError("The first status read boundary was not exactly one initial POST followed by one GET: " + json.dumps(status_methods))
        report["screenshots"].append(m04.screenshot(evidence, "04-bridge-import-visible-in-pool.png", hwnd, chrome.pid, display))

        # Simulate a pre-M05 automatically-created record, preserving task history.
        legacy_fixture = create_legacy_application(container, account_a["userId"], str(job_ids[1]))
        legacy_id = legacy_fixture.get("applicationId")
        legacy_before = sql_json(container, f"""
          select json_build_object('application',(select json_build_object('id',id,'origin',preparation_origin,'chosenAt',chosen_to_apply_at)
            from public.applications where id='{legacy_id}'::uuid),'tasks',(select json_agg(json_build_object('id',id,'state',state,
            'attemptCount',attempt_count,'lastError',last_error,'output',output_json) order by id) from public.automation_tasks where entity_type='application' and entity_id='{legacy_id}'::uuid))::text;
        """)
        legacy_tasks = legacy_before.get("tasks") or []
        if legacy_before.get("application", {}).get("origin") != "auto_prepare" or legacy_before.get("application", {}).get("chosenAt") is not None \
                or not legacy_tasks or any(task.get("state") != "needs_user" for task in legacy_tasks):
            raise RuntimeError("The M05 legacy fixture was not preserved and parked safely: " + json.dumps(legacy_before))
        legacy_app_gate = m04.app_data(observer, f"/api/applications/{legacy_id}/documents/generate", "POST",
            {"requestKey": str(uuid.uuid4()), "kinds": ["cv"], "templateId": "classic-navy"})
        legacy_form_gate = m04.app_data(observer, f"/api/applications/{legacy_id}/form/start", "POST", {})
        if legacy_app_gate.get("status") != 409 or legacy_form_gate.get("status") not in (400, 409):
            raise RuntimeError("An unchosen legacy application did not block document generation and employer-form start.")
        parked_request = sql_json(container, f"""
          select private.prepare_application_for_user('{account_a['userId']}'::uuid,'{job_ids[1]}'::uuid,'chatgpt_task',
            '{{"fixture":"queued legacy consumer probe"}}'::jsonb)::text;
        """)
        if parked_request.get("state") != "user_required" or parked_request.get("prepared") is not False:
            raise RuntimeError("The M22 legacy preparation consumer was not parked at user_required: " + json.dumps(parked_request))
        legacy_after_consumer = scoped_database(container, account_a["userId"])
        assert_no_content_side_effects(legacy_after_consumer, 1, len(legacy_tasks))
        report["workflow"].append({"name": "legacy_auto_prepare_preserved_and_consumers_gated", "result": "PASS",
                                    "legacyApplicationIdSynthetic": True, "originPreserved": True,
                                    "taskRowsParked": len(legacy_tasks), "documentGateStatus": legacy_app_gate.get("status"),
                                    "formGateStatus": legacy_form_gate.get("status"), "legacyConsumerState": "user_required",
                                    "noDocumentsOrFormsCreated": True})

        # Job Pool row selection and explicit application choice are native clicks.
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/jobs")
        m04.wait_jobs_workspace(observer)
        first_job = str(job_ids[0])
        checkbox = m04.visible_job_checkbox(observer, first_job)
        select_click = desktop.native_click_selector(observer, hwnd, chrome.pid, checkbox["selector"])
        selected = observer.evaluate("JSON.stringify((()=>{const path='/jobs/'+" + json.dumps(first_job) + ";const row=[...document.querySelectorAll('a.jobPoolRole')].find(a=>a.getAttribute('href')?.split('?')[0]===path)?.closest('tr');return {checked:row?.querySelector('input[type=checkbox]')?.checked===true,title:row?.querySelector('a.jobPoolRole')?.innerText.trim()||null,button:row?.querySelector('button.primaryButton')?.innerText.trim()||null}})())")
        if not isinstance(selected, dict) or selected.get("checked") is not True or selected.get("button") != "Choose to apply":
            raise RuntimeError("Native Job Pool selection did not change/read back the intended row state: " + json.dumps(selected))
        report["screenshots"].append(m04.screenshot(evidence, "05-job-selected-before-apply.png", hwnd, chrome.pid, display))
        apply_button = apply_button_selector(observer, first_job)
        if not apply_button.get("exists") or apply_button.get("disabled") or apply_button.get("text") != "Choose to apply":
            raise RuntimeError("The selected Job Pool row did not expose its enabled explicit apply action.")
        apply_click = desktop.native_click_selector(observer, hwnd, chrome.pid, apply_button["selector"])
        app_path = wait_for(lambda: observer.evaluate("location.pathname.startsWith('/applications/') ? location.pathname : null"), "application page after explicit native choice", 35)
        application_id = app_path.rsplit("/", 1)[-1]
        page_state = observer.evaluate("JSON.stringify({heading:document.querySelector('h1')?.innerText.trim()||'',text:document.body.innerText.slice(0,5000),url:location.pathname})")
        if not isinstance(page_state, dict) or page_state.get("url") != app_path or "Application preparation" not in page_state.get("text", ""):
            raise RuntimeError("Explicit choice did not open the resulting application workspace.")
        app_db = sql_json(container, f"""
          select json_build_object('count',(select count(*) from public.applications where user_id='{account_a['userId']}'::uuid and job_id='{first_job}'::uuid),
            'application',(select json_build_object('id',id,'origin',preparation_origin,'chosenAt',chosen_to_apply_at,'state',state) from public.applications where user_id='{account_a['userId']}'::uuid and job_id='{first_job}'::uuid),
            'tasks',(select count(*) from public.automation_tasks where user_id='{account_a['userId']}'::uuid and entity_type='application' and entity_id=(select id from public.applications where user_id='{account_a['userId']}'::uuid and job_id='{first_job}'::uuid)),
            'documents',(select count(*) from public.documents where application_id=(select id from public.applications where user_id='{account_a['userId']}'::uuid and job_id='{first_job}'::uuid)),
            'documentRequests',(select count(*) from public.document_generation_requests where application_id=(select id from public.applications where user_id='{account_a['userId']}'::uuid and job_id='{first_job}'::uuid)),
            'formSessions',(select count(*) from public.form_agent_sessions where application_id=(select id from public.applications where user_id='{account_a['userId']}'::uuid and job_id='{first_job}'::uuid)))::text;
        """)
        if app_db.get("count") != 1 or app_db.get("application", {}).get("id") != application_id or not app_db.get("application", {}).get("chosenAt") \
                or app_db.get("documents") != 0 or app_db.get("documentRequests") != 0 or app_db.get("formSessions") != 0:
            raise RuntimeError("Choose to apply did not create exactly one marked application without document/form actions: " + json.dumps(app_db))
        report["workflow"].append({"name": "native_job_pool_selection_and_explicit_apply", "result": "PASS",
                                    "nativeCheckboxClick": select_click, "selectedRowReadback": selected,
                                    "nativeApplyClick": apply_click, "applicationIdSynthetic": True, "database": app_db})
        report["screenshots"].append(m04.screenshot(evidence, "06-application-created-after-choice.png", hwnd, chrome.pid, display))

        repeated = m04.app_data(observer, "/api/applications/create", "POST", {"jobId": first_job, "origin": "manual"})
        concurrent = concurrent_apply(observer, first_job, 5)
        if repeated.get("status") != 200 or repeated.get("data", {}).get("applicationId") != application_id \
                or repeated.get("data", {}).get("created") is not False or len(concurrent) != 5 \
                or any(item.get("status") != 200 or item.get("applicationId") != application_id for item in concurrent):
            raise RuntimeError("Repeated/concurrent explicit apply was not idempotent: " + json.dumps({
                "repeatStatus": repeated.get("status"), "repeatCreated": repeated.get("data", {}).get("created"), "concurrent": concurrent}))
        stable = sql_json(container, f"""
          select json_build_object(
            'applicationCount',(select count(*) from public.applications where user_id='{account_a['userId']}'::uuid and job_id='{first_job}'::uuid),
            'chosenAt',(select min(chosen_to_apply_at) from public.applications where user_id='{account_a['userId']}'::uuid and job_id='{first_job}'::uuid),
            'tasks',(select count(*) from public.automation_tasks where entity_type='application' and entity_id='{application_id}'::uuid),
            'documents',(select count(*) from public.documents where application_id='{application_id}'::uuid),
            'documentRequests',(select count(*) from public.document_generation_requests where application_id='{application_id}'::uuid),
            'formSessions',(select count(*) from public.form_agent_sessions where application_id='{application_id}'::uuid))::text;
        """)
        if stable.get("applicationCount") != 1 or stable.get("documents") != 0 or stable.get("documentRequests") != 0 or stable.get("formSessions") != 0:
            raise RuntimeError("Concurrent/repeated apply introduced duplicate records or unauthorized actions: " + json.dumps(stable))
        report["workflow"].append({"name": "repeated_and_concurrent_apply_idempotency", "result": "PASS",
                                    "repeatedCreated": False, "concurrentRequests": len(concurrent), "oneApplication": True,
                                    "stableChoiceTimestamp": bool(stable.get("chosenAt")), "database": stable})

        # Legacy auto_prepare adoption must update that exact record only.
        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/jobs")
        m04.wait_jobs_workspace(observer)
        legacy_checkbox = m04.visible_job_checkbox(observer, str(job_ids[1]))
        desktop.native_click_selector(observer, hwnd, chrome.pid, legacy_checkbox["selector"])
        legacy_row = observer.evaluate("JSON.stringify((()=>{const path='/jobs/'+" + json.dumps(str(job_ids[1])) + ";const row=[...document.querySelectorAll('a.jobPoolRole')].find(a=>a.getAttribute('href')?.split('?')[0]===path)?.closest('tr');return {checked:row?.querySelector('input[type=checkbox]')?.checked===true,button:row?.querySelector('button.primaryButton')?.innerText.trim()||null}})())")
        if not isinstance(legacy_row, dict) or legacy_row.get("checked") is not True or legacy_row.get("button") != "Choose to apply":
            raise RuntimeError("The unchosen legacy application did not expose a visible explicit choice: " + json.dumps(legacy_row))
        legacy_button = apply_button_selector(observer, str(job_ids[1]))
        if not legacy_button.get("exists") or legacy_button.get("disabled") or legacy_button.get("text") != "Choose to apply":
            raise RuntimeError("The legacy Job Pool row did not expose its enabled apply choice.")
        legacy_apply_click = desktop.native_click_selector(observer, hwnd, chrome.pid, legacy_button["selector"])
        legacy_path = wait_for(lambda: observer.evaluate("location.pathname.startsWith('/applications/') ? location.pathname : null"), "adopted legacy application page", 35)
        if legacy_path.rsplit("/", 1)[-1] != legacy_id:
            raise RuntimeError("Legacy adoption created/opened a different application instead of adopting the historic row.")
        legacy_after = sql_json(container, f"""
          select json_build_object('applicationCount',(select count(*) from public.applications where user_id='{account_a['userId']}'::uuid and job_id='{job_ids[1]}'::uuid),
            'application',(select json_build_object('id',id,'origin',preparation_origin,'chosenAt',chosen_to_apply_at) from public.applications where user_id='{account_a['userId']}'::uuid and job_id='{job_ids[1]}'::uuid),
            'tasks',(select json_agg(json_build_object('id',id,'state',state,'attemptCount',attempt_count,'lastError',last_error,'output',output_json) order by id) from public.automation_tasks where entity_type='application' and entity_id='{legacy_id}'::uuid),
            'documents',(select count(*) from public.documents where application_id='{legacy_id}'::uuid),
            'documentRequests',(select count(*) from public.document_generation_requests where application_id='{legacy_id}'::uuid),
            'formSessions',(select count(*) from public.form_agent_sessions where application_id='{legacy_id}'::uuid))::text;
        """)
        if legacy_after.get("applicationCount") != 1 or legacy_after.get("application", {}).get("id") != legacy_id \
                or legacy_after.get("application", {}).get("origin") != "auto_prepare" or not legacy_after.get("application", {}).get("chosenAt") \
                or legacy_after.get("tasks") != legacy_tasks or legacy_after.get("documents") != 0 \
                or legacy_after.get("documentRequests") != 0 or legacy_after.get("formSessions") != 0:
            raise RuntimeError("Legacy adoption failed to preserve identity, origin, task history, or side-effect boundaries: " + json.dumps(legacy_after))
        report["workflow"].append({"name": "native_legacy_record_adoption_preserves_history", "result": "PASS",
                                    "nativeApplyClick": legacy_apply_click, "existingApplicationIdReused": True,
                                    "originPreserved": True, "tasksUnchanged": True, "database": legacy_after})
        report["screenshots"].append(m04.screenshot(evidence, "07-legacy-application-adopted.png", hwnd, chrome.pid, display))

        # Refresh/readback through the actual visible app, then prove the other account cannot apply to A's vacancy.
        desktop.press_key(0x52, ctrl=True)
        refreshed = wait_for(lambda: observer.evaluate("location.pathname.startsWith('/applications/') ? document.querySelector('h1')?.innerText.trim()||null : null"), "refreshed application UI readback", 35)
        if not refreshed:
            raise RuntimeError("Native browser refresh did not render the adopted application again.")
        refreshed_notice = observer.evaluate("document.body.innerText.includes('You chose to apply explicitly')")
        if refreshed_notice is not True:
            raise RuntimeError("The refreshed legacy application did not show its preserved historical origin and explicit choice.")
        report["screenshots"].append(m04.screenshot(evidence, "08-application-after-native-refresh.png", hwnd, chrome.pid, display))
        onboarding.switch_user(observer, hwnd, chrome.pid, app_url, account_b, report, "M05 synthetic User B")
        denied = m04.app_data(observer, "/api/applications/create", "POST", {"jobId": first_job, "origin": "manual"})
        b_state = scoped_database(container, account_b["userId"])
        a_still = scoped_database(container, account_a["userId"])
        if denied.get("status") != 404 or b_state.get("applications") != 0 or a_still.get("applications") != 2:
            raise RuntimeError("The second local user was not denied access to the first user's application choice: " + json.dumps({
                "httpStatus": denied.get("status"), "userB": b_state, "userA": a_still}))
        report["workflow"].append({"name": "second_user_cannot_apply_to_foreign_vacancy", "result": "PASS",
                                    "httpStatus": denied.get("status"), "userBApplicationCount": 0,
                                    "userAApplicationsRemain": 2, "syntheticUsers": True})
        report["screenshots"].append(m04.screenshot(evidence, "09-second-user-denied.png", hwnd, chrome.pid, display))
        report["result"] = "PASS"
    except Exception as exc:
        report["result"] = "FAIL"
        report["error"] = {"type": type(exc).__name__, "message": str(exc)[:1200]}
        raise
    finally:
        # Stop only processes created by this runner, then verify their trees exited.
        if chrome:
            report["cleanup"]["chromeExited"] = not m03.stop_chrome(chrome, chrome_pids, observer)
        if server:
            report["cleanup"]["serverExited"] = not desktop.stop_owned_process(server, server_pids, graceful=True)
        if provider:
            report["cleanup"]["providerExited"] = not desktop.stop_owned_process(provider, provider_pids, graceful=True)
        if accounts:
            cleanup_report = {"syntheticDataCleanup": {}}
            onboarding.cleanup_accounts(api_url, service_key, container, accounts, cleanup_report)
            report["cleanup"]["syntheticAccountsRemoved"] = cleanup_report["syntheticDataCleanup"].get("complete") is True
        if args.keep_workspace:
            report["cleanup"]["workspaceRemoved"] = False
            report["cleanup"]["workspaceKeptByRequest"] = True
        elif report["cleanup"]["chromeExited"] and report["cleanup"]["serverExited"] and report["cleanup"]["providerExited"] \
                and report["cleanup"]["syntheticAccountsRemoved"]:
            resolved = run_root.resolve()
            if resolved.parent != temp_root or not resolved.name.startswith("JobHuntAI-M05-Local-UI-"):
                raise RuntimeError("Refusing to remove an unexpected M05 temporary workspace path.")
            shutil.rmtree(resolved)
            report["cleanup"]["workspaceRemoved"] = True
        report["finishedAtUtc"] = utc_now()
        (evidence / "m05-acceptance-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"result": report["result"], "report": str(evidence / "m05-acceptance-report.json"),
                          "workflow": report["workflow"], "cleanup": report["cleanup"]}, ensure_ascii=False), flush=True)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--evidence-dir")
    parser.add_argument("--keep-workspace", action="store_true")
    args = parser.parse_args()
    run(args)
