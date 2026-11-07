#!/usr/bin/env python3
"""Run native-input onboarding acceptance against a disposable local Supabase stack."""

from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import windows_web_ui_acceptance as desktop


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def json_request(url: str, method: str, body: dict | None, headers: dict[str, str]) -> tuple[int, bytes]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        # Never include response bodies in an exception or artifact: Auth and
        # Storage responses can contain user identifiers or internal details.
        return error.code, error.read()


def auth_headers(api_key: str, bearer: str | None = None) -> dict[str, str]:
    return {
        "apikey": api_key,
        "Authorization": "Bearer " + (bearer or api_key),
        "Content-Type": "application/json",
    }


def create_auth_user(api_url: str, service_key: str, email: str, password: str, display_name: str) -> str:
    status, payload = json_request(
        api_url.rstrip("/") + "/auth/v1/admin/users",
        "POST",
        {"email": email, "password": password, "email_confirm": True, "user_metadata": {"full_name": display_name}},
        auth_headers(service_key),
    )
    if status not in (200, 201):
        raise RuntimeError(f"Local Auth test user creation failed with HTTP {status}.")
    data = json.loads(payload)
    user_id = str(data.get("id") or "")
    if not user_id:
        raise RuntimeError("Local Auth returned no synthetic test user id.")
    return user_id


def psql(container: str, sql: str) -> str:
    command = [
        "wsl.exe", "-d", "Ubuntu-24.04", "-u", "root", "--", "podman", "exec", "-i", container,
        "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres",
    ]
    result = subprocess.run(command, input=sql.encode("utf-8"), capture_output=True, check=False)
    if result.returncode:
        raise RuntimeError("Local Supabase database fixture command failed (psql exit " + str(result.returncode) + ").")
    return result.stdout.decode("utf-8", errors="replace").strip()


def test_account(email: str, password: str, user_id: str, profile_id: str, display_name: str) -> dict:
    return {"email": email, "password": password, "userId": user_id, "profileId": profile_id, "displayName": display_name}


def seed_accounts(args, run_id: str) -> tuple[dict, dict]:
    api_url = os.environ["JOBHUNT_M02_SUPABASE_URL"].rstrip("/")
    service_key = os.environ["JOBHUNT_M02_SERVICE_KEY"]
    suffix = run_id[:12]
    accounts = []
    try:
        for label in ("A", "B"):
            email = f"m02-{label.lower()}-{suffix}@example.test"
            password = secrets.token_urlsafe(28)
            display_name = f"Synthetic User {label}"
            user_id = create_auth_user(api_url, service_key, email, password, display_name)
            accounts.append(test_account(email, password, user_id, str(uuid.uuid4()), display_name))

        sql_values = []
        for account in accounts:
            escaped_email = account["email"].replace("'", "''")
            escaped_name = account["displayName"].replace("'", "''")
            sql_values.append(
                "INSERT INTO private.app_memberships(user_id,email,role,status) VALUES "
                f"('{account['userId']}'::uuid,'{escaped_email}','member','active') "
                "ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,role='member',status='active';\n"
                "INSERT INTO public.candidate_profiles(id,user_id,display_name) VALUES "
                f"('{account['profileId']}'::uuid,'{account['userId']}'::uuid,'{escaped_name}') "
                "ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name;\n"
                "INSERT INTO public.candidate_preferences(profile_id,preferences) VALUES "
                f"('{account['profileId']}'::uuid,'{{}}'::jsonb) ON CONFLICT(profile_id) DO NOTHING;\n"
            )
        psql(os.environ["JOBHUNT_M02_DB_CONTAINER"], "\n".join(sql_values))
    except Exception:
        for account in accounts:
            json_request(api_url + "/auth/v1/admin/users/" + account["userId"], "DELETE", None, auth_headers(service_key))
        raise
    return accounts[0], accounts[1]


def login_token(api_url: str, publishable_key: str, account: dict) -> str:
    status, payload = json_request(
        api_url.rstrip("/") + "/auth/v1/token?grant_type=password",
        "POST",
        {"email": account["email"], "password": account["password"]},
        auth_headers(publishable_key),
    )
    if status != 200:
        raise RuntimeError(f"Synthetic user password authentication failed with HTTP {status}.")
    token = str(json.loads(payload).get("access_token") or "")
    if not token:
        raise RuntimeError("Supabase Auth returned no access token for the synthetic test user.")
    return token


def make_fixtures(directory: Path) -> dict[str, Path]:
    directory.mkdir(parents=True, exist_ok=False)
    source_a = "\n".join([
        "Fictional onboarding test source A",
        "EXPERIENCE",
        "Data Quality Engineer at Northstar Analytics | Jan 2022 to Dec 2024",
        "EDUCATION",
        "Ada Lovelace University | BSc Software Engineering | 2018 to 2021",
        "SKILLS",
        "PostgreSQL Engineering",
        "PROJECTS",
        "Synthetic Data Portal: Deterministic UI validation fixture.",
    ]) + "\n"
    source_b = "\n".join([
        "# Fictional onboarding test source B",
        "## Experience",
        "Data Quality Engineer at Northstar Analytics | Feb 2022 to Present",
        "## Skills",
        "Python Automation",
    ]) + "\n"
    def pdf_bytes(text: str) -> bytes:
        escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        content = "BT /F1 12 Tf 50 700 Td (" + escaped + ") Tj ET"
        return ("%PDF-1.4\n1 0 obj\n<< /Length " + str(len(content)) + " >>\nstream\n" + content + "\nendstream\nendobj\n%%EOF").encode("ascii")
    docx_text = "SKILLS\nData Modeling and Domain-Specific Architecture for Analytics"
    paragraphs = "".join("<w:p><w:r><w:t>" + line.replace("&", "&amp;").replace("<", "&lt;") + "</w:t></w:r></w:p>" for line in docx_text.split("\n"))
    docx_path = directory / "synthetic-modeling.docx"
    with zipfile.ZipFile(docx_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("word/document.xml", "<w:document><w:body>" + paragraphs + "</w:body></w:document>")
    fixtures = {
        "synthetic-source-a.txt": source_a.encode("utf-8"),
        "synthetic-source-b.md": source_b.encode("utf-8"),
        "synthetic-typescript.pdf": pdf_bytes("SKILLS\nAdvanced TypeScript"),
        "synthetic-modeling.docx": None,
        "synthetic-relational.rtf": ("{\\rtf1\\ansi SKILLS\\par Relational Data Modeling and Storage Architecture}").encode("ascii"),
        "synthetic-malformed.pdf": b"\x00\x01malformed synthetic pdf",
    }
    output = {}
    for name, content in fixtures.items():
        path = directory / name
        if content is not None:
            path.write_bytes(content)
        output[name] = path
    return output


def disable_test_profile_password_prompt(profile: Path) -> None:
    """Suppress Chrome's credential-save prompt in the disposable profile."""
    preferences = profile / "Default" / "Preferences"
    preferences.parent.mkdir(parents=True, exist_ok=True)
    preferences.write_text(json.dumps({
        "credentials_enable_service": False,
        "profile": {"password_manager_enabled": False},
    }), encoding="utf-8")


def state_summary(observer: desktop.CDPObserver) -> dict:
    result = observer.evaluate("""(async()=>{
      const response=await fetch('/api/onboarding/state',{cache:'no-store'});
      const state=await response.json();
      return {httpStatus:response.status,ok:state.ok===true,error:typeof state.error==='string'?state.error.slice(0,400):null,
        sourceDocuments:(state.sourceDocuments||[]).map(x=>({name:x.original_name,sourceType:x.source_type,status:x.extraction_status,format:x.extraction_format,error:Boolean(x.extraction_error)})),
        proposals:(state.extractionProposals||[]).map(x=>({type:x.proposal_type,status:x.verification_status,source:x.source_title,claim:String(x.proposed_json?.claim||x.proposed_json?.title||x.proposed_json?.name||''),employer:x.proposed_json?.employer||null,role:x.proposed_json?.role_title||null,startDate:x.proposed_json?.start_date||null,endDate:x.proposed_json?.end_date||null,current:x.proposed_json?.current===true})),
        employment:(state.employment||[]).map(x=>({employer:x.employer,role:x.role_title,startDate:x.start_date,endDate:x.end_date,current:x.current,verificationStatus:x.verification_status})),
        education:(state.education||[]).map(x=>({institution:x.institution,qualification:x.qualification,startDate:x.start_date,endDate:x.end_date,verificationStatus:x.verification_status})),
        projects:(state.projects||[]).map(x=>({title:x.title,verificationStatus:x.verification_status})),
        skills:(state.skills||[]).map(x=>({name:x.name,verificationStatus:x.verification_status})),
        readiness:state.readiness||null};})()""")
    if not isinstance(result, dict) or not result.get("ok"):
        raise RuntimeError("Authenticated onboarding state failed: " + json.dumps({"httpStatus": result.get("httpStatus") if isinstance(result, dict) else None,
                                                                                  "error": result.get("error") if isinstance(result, dict) else None}))
    return result


def safe_ui_state(observer: desktop.CDPObserver) -> dict:
    return observer.evaluate("JSON.stringify({url:location.href,heading:document.querySelector('h1')?.innerText.trim()||'',body:document.body.innerText.slice(0,12000),visible:document.visibilityState,readyState:document.readyState,viewport:{innerWidth,innerHeight,devicePixelRatio}})")


def wait_ui(observer: desktop.CDPObserver, predicate, description: str, timeout: float = 45) -> dict:
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            last = safe_ui_state(observer)
        except Exception:
            time.sleep(0.2)
            continue
        if predicate(last):
            return last
        time.sleep(0.25)
    raise TimeoutError("Timed out waiting for " + description + "; last heading=" + str((last or {}).get("heading")))


def native_fill_redacted(observer: desktop.CDPObserver, hwnd: int, pid: int, selector: str, value: str) -> dict:
    item = desktop.onboarding_element(observer, selector)
    if not item or not item.get("displayed"):
        raise RuntimeError("Expected visible input is missing: " + selector)
    focus_method = None
    click = None
    if selector == "input[name=password]" and observer.evaluate("document.activeElement?.name==='email'"):
        # Password is the next native keyboard stop after entering the email.
        # Use Tab where possible, then verify activeElement before typing.
        desktop.press_key(0x09)
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            focused = desktop.onboarding_element(observer, selector)
            if focused and focused.get("focused"):
                focus_method = "Win32 Tab from email"
                break
            time.sleep(0.05)
    if focus_method is None:
        click = desktop.native_click_observed_rect(observer, hwnd, pid, item["rect"], selector)
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            focused = desktop.onboarding_element(observer, selector)
            if focused and focused.get("focused"):
                focus_method = "Win32 mouse click"
                break
            time.sleep(0.05)
    if focus_method is None:
        active = observer.evaluate("JSON.stringify({tag:document.activeElement?.tagName||null,name:document.activeElement?.name||null,type:document.activeElement?.type||null})")
        raise RuntimeError("Native input did not focus " + selector + "; active control=" + json.dumps(active))
    observer.evaluate("(() => { const key=" + json.dumps(selector) + "; window.__m02NativeInputEvents=[]; const target=document.querySelector(key); if(!target) return false; for(const type of ['keydown','beforeinput','input','keyup']) target.addEventListener(type,event=>window.__m02NativeInputEvents.push({type,trusted:event.isTrusted,dataLength:typeof event.data==='string'?event.data.length:null,valueLength:target.value.length}),true); return true; })()")
    time.sleep(0.2)
    desktop.press_key(0x41, ctrl=True)
    desktop.press_key(0x08)
    desktop.type_unicode(value)
    time.sleep(0.25)
    observed = observer.evaluate("JSON.stringify((()=>{const e=document.querySelector(" + json.dumps(selector) + ");return {matches:e?.value===" + json.dumps(value) + ",valueLength:e?.value?.length||0,focused:document.activeElement===e,activeTag:document.activeElement?.tagName||null,activeName:document.activeElement?.name||null,events:window.__m02NativeInputEvents||[]};})())")
    if not isinstance(observed, dict) or observed.get("matches") is not True or observed.get("focused") is not True:
        diagnostics = {key: observed.get(key) for key in ("valueLength", "focused", "activeTag", "activeName", "events")} if isinstance(observed, dict) else None
        raise RuntimeError("Native typing failed readback for " + selector + "; redacted diagnostics=" + json.dumps({"click": click, **(diagnostics or {})}))
    return {"nativeClick": click, "focusMethod": focus_method,
            "activeElementReadback": True, "valueMatchedWithoutRecording": True,
            "typedLength": len(value), "trustedEventCount": sum(1 for event in observed["events"] if event.get("trusted"))}


def native_fill_date(observer: desktop.CDPObserver, hwnd: int, pid: int, selector: str, value: str) -> dict:
    date_value = datetime.strptime(value, "%Y-%m-%d")
    language = observer.evaluate("navigator.language")
    month_first = str(language).lower().endswith("-us")
    month_day_year = date_value.strftime("%m%d%Y")
    day_month_year = date_value.strftime("%d%m%Y")
    candidates = [month_day_year, day_month_year, date_value.strftime("%Y%m%d"), value]
    if not month_first:
        candidates[0], candidates[1] = candidates[1], candidates[0]
    native_clicks = []
    for candidate in candidates:
        item = desktop.ensure_onboarding_visible(observer, hwnd, pid, selector)
        click_point = (item["rect"]["x"] + min(8, item["rect"]["width"] / 3),
                       item["rect"]["y"] + item["rect"]["height"] / 2)
        native_clicks.append(desktop.native_click_observed_rect(observer, hwnd, pid, item["rect"], selector,
                                                                 click_point=click_point))
        if not desktop.onboarding_element(observer, selector).get("focused"):
            raise RuntimeError("Native click did not focus the date input.")
        observer.evaluate("(() => {const e=document.querySelector(" + json.dumps(selector)
                           + "); if(!e.__m02DateRecorder){e.__m02DateRecorder=true; for(const type of ['keydown','beforeinput','input','keyup']) e.addEventListener(type,event=>window.__m02DateEvents.push(event.isTrusted),true);} window.__m02DateEvents=[]; })()")
        desktop.press_key(0x41, ctrl=True)
        desktop.press_key(0x08)
        desktop.type_unicode(candidate)
        time.sleep(0.2)
        observed = observer.evaluate("JSON.stringify((()=>{const e=document.querySelector(" + json.dumps(selector)
                                   + ");return {value:e?.value||'',focused:document.activeElement===e,type:e?.type||'',events:window.__m02DateEvents||[]};})())")
        trusted_events = sum(1 for event in observed.get("events", []) if event) if isinstance(observed, dict) else 0
        if isinstance(observed, dict) and observed.get("value") == value and observed.get("focused") and trusted_events:
            desktop.press_key(0x09)
            time.sleep(0.15)
            persisted = desktop.onboarding_element(observer, selector)
            if persisted and persisted.get("value") == value:
                return {"nativeClicks": native_clicks, "browserLocale": language,
                        "valueReadback": value, "persistedAfterTab": True,
                        "nativeKeyboardEntry": True, "trustedEventCount": trusted_events}
    current = desktop.onboarding_element(observer, selector)
    raise RuntimeError("Native date entry did not persist the expected synthetic date; locale=" + str(language)
                       + "; observed=" + json.dumps({"value": current.get("value") if current else None,
                                                     "focused": current.get("focused") if current else None,
                                                     "attemptedFormats": len(candidates)}))


def upload_file(observer: desktop.CDPObserver, hwnd: int, pid: int, app_url: str, path: Path,
                report: dict, expected_status: str = "extracted") -> dict:
    before = state_summary(observer)
    selection = desktop.native_choose_file(observer, hwnd, pid, "input[type=file]", path,
                                           verify_fixture_event=False, full_path_in_filename=True)
    browser_file = observer.evaluate("(() => { const file=document.querySelector('input[type=file]')?.files?.[0]; return file ? {type:file.type,size:file.size} : null; })()")
    deadline = time.monotonic() + 35
    current = None
    while time.monotonic() < deadline:
        try:
            current = state_summary(observer)
            if any(item["name"] == path.name for item in current["sourceDocuments"]):
                break
        except Exception:
            pass
        time.sleep(0.25)
    source = next((item for item in (current or {}).get("sourceDocuments", []) if item["name"] == path.name), None)
    if not source:
        visible_error = observer.evaluate("document.querySelector('.errorNotice')?.textContent?.trim()?.slice(0,240)||null")
        raise TimeoutError("Local Supabase did not persist the uploaded synthetic source " + path.name
                           + "; browser MIME=" + json.dumps(browser_file)
                           + "; visible app error=" + json.dumps(visible_error))
    expected_error = expected_status == "failed"
    if source.get("status") != expected_status or bool(source.get("error")) != expected_error:
        raise RuntimeError("The synthetic file did not reach its expected extraction outcome: " + path.name
                           + "; backend status=" + json.dumps(source)
                           + "; expected status=" + expected_status)
    action = {"filename": path.name, "bytes": path.stat().st_size, "nativeFileDialog": selection["nativeDialogInput"],
              "browserFileMetadata": browser_file, "backendReadback": source, "sourceCountBefore": len(before["sourceDocuments"]),
              "sourceCountAfter": len(current["sourceDocuments"])}
    workflow_name = "native_upload_" + path.suffix.lstrip(".") if expected_status == "extracted" else "native_expected_failed_extraction_" + path.suffix.lstrip(".")
    report["workflow"].append({"name": workflow_name, "result": "PASS", "expectedExtractionStatus": expected_status, **action})
    return source


def db_summary(container: str, profile_id: str, user_id: str) -> dict:
    sql = f"""
    SELECT json_build_object(
      'sourceDocuments',(SELECT count(*) FROM public.candidate_source_documents WHERE profile_id='{profile_id}'::uuid),
      'sources',(SELECT COALESCE(json_agg(json_build_object('name',original_name,'format',extraction_format,'status',extraction_status,'error',extraction_error IS NOT NULL,'textLength',COALESCE(length(extracted_text),0)) ORDER BY original_name),'[]'::json) FROM public.candidate_source_documents WHERE profile_id='{profile_id}'::uuid),
      'proposals',(SELECT json_build_object('total',count(*),'needsReview',count(*) FILTER (WHERE verification_status='needs_review'),'verified',count(*) FILTER (WHERE verification_status='verified'),'rejected',count(*) FILTER (WHERE verification_status='rejected')) FROM public.candidate_extraction_proposals WHERE profile_id='{profile_id}'::uuid),
      'employment',(SELECT COALESCE(json_agg(json_build_object('id',id,'employer',employer,'role',role_title,'startDate',start_date,'endDate',end_date,'current',current,'verificationStatus',verification_status) ORDER BY created_at),'[]'::json) FROM public.candidate_employment WHERE profile_id='{profile_id}'::uuid),
      'education',(SELECT COALESCE(json_agg(json_build_object('id',id,'institution',institution,'qualification',qualification,'startDate',start_date,'endDate',end_date,'verificationStatus',verification_status) ORDER BY created_at),'[]'::json) FROM public.candidate_education WHERE profile_id='{profile_id}'::uuid),
      'projects',(SELECT COALESCE(json_agg(json_build_object('title',title,'verificationStatus',verification_status) ORDER BY created_at),'[]'::json) FROM public.candidate_projects WHERE profile_id='{profile_id}'::uuid),
      'skills',(SELECT COALESCE(json_agg(json_build_object('id',id,'name',name,'verificationStatus',verification_status) ORDER BY name),'[]'::json) FROM public.candidate_skills WHERE profile_id='{profile_id}'::uuid),
      'storageObjects',(SELECT count(*) FROM storage.objects WHERE bucket_id='candidate-source-documents' AND name LIKE '{user_id}/onboarding/%'),
      'membershipCount',(SELECT count(*) FROM private.app_memberships WHERE user_id='{user_id}'::uuid),
      'profileCount',(SELECT count(*) FROM public.candidate_profiles WHERE user_id='{user_id}'::uuid),
      'onboarding',(SELECT status FROM public.candidate_onboarding WHERE profile_id='{profile_id}'::uuid)
    )::text;
    """
    output = psql(container, sql)
    try:
        return json.loads(output.splitlines()[-1])
    except Exception as exc:
        raise RuntimeError("Could not parse local synthetic database verification result.") from exc


def object_keys(container: str, profile_id: str) -> list[str]:
    output = psql(container, f"SELECT COALESCE(json_agg(storage_object_key),'[]'::json)::text FROM public.candidate_source_documents WHERE profile_id='{profile_id}'::uuid;")
    return json.loads(output.splitlines()[-1])


def browser_api_request(observer: desktop.CDPObserver, path: str, method: str, body: dict | None = None) -> dict:
    expression = "(async()=>{const path=" + json.dumps(path) + ";const method=" + json.dumps(method) + ";const body=" + json.dumps(body) + ";"
    expression += "const init={method,credentials:'same-origin',headers:{'content-type':'application/json'}};if(body!==null)init.body=JSON.stringify(body);"
    expression += "const response=await fetch(path,init);const text=await response.text();let parsed=null;try{parsed=JSON.parse(text)}catch{};"
    expression += "return JSON.stringify({httpStatus:response.status,responseOk:response.ok,applicationOk:typeof parsed?.ok==='boolean'?parsed.ok:null});})()"
    result = observer.evaluate(expression)
    if not isinstance(result, dict) or not isinstance(result.get("httpStatus"), int):
        raise RuntimeError("Authenticated application API verification returned an unreadable result.")
    return result


def verify_rls(api_url: str, publishable_key: str, a: dict, b: dict, db_container: str,
               observer: desktop.CDPObserver, report: dict) -> None:
    token_a = login_token(api_url, publishable_key, a)
    token_b = login_token(api_url, publishable_key, b)
    encoded_profile = urllib.parse.quote(a["profileId"])
    encoded_user = urllib.parse.quote(a["userId"])
    base = api_url.rstrip("/") + "/rest/v1/"
    checks = []
    for label, url in [
        ("profile_read", base + "candidate_profiles?select=id&user_id=eq." + encoded_user),
        ("source_metadata_read", base + "candidate_source_documents?select=id&profile_id=eq." + encoded_profile),
    ]:
        status, payload = json_request(url, "GET", None, {"apikey": publishable_key, "Authorization": "Bearer " + token_b})
        checks.append({"name": label, "httpStatus": status, "visibleRows": len(json.loads(payload)) if status == 200 else None,
                       "result": "PASS" if status == 200 and json.loads(payload) == [] else "FAIL"})

    state = db_summary(db_container, a["profileId"], a["userId"])
    employment_id = state["employment"][0]["id"] if state["employment"] else None
    education_id = state["education"][0]["id"] if state["education"] else None
    proposal = psql(db_container, f"SELECT id::text FROM public.candidate_extraction_proposals WHERE profile_id='{a['profileId']}'::uuid ORDER BY created_at LIMIT 1;").splitlines()
    proposal_id = proposal[-1] if proposal else None
    patch_targets = [("profile_update", "candidate_profiles", a["profileId"], {"display_name": "Unauthorized synthetic edit"}),
                     ("employment_update", "candidate_employment", employment_id, {"employer": "Unauthorized synthetic edit"}),
                     ("education_update", "candidate_education", education_id, {"institution": "Unauthorized synthetic edit"}),
                     ("proposal_approval", "candidate_extraction_proposals", proposal_id, {"verification_status": "verified"})]
    for label, table, row_id, patch in patch_targets:
        if not row_id:
            checks.append({"name": label, "result": "NOT_RUN", "reason": "No synthetic target row existed."})
            continue
        url = base + table + "?id=eq." + urllib.parse.quote(row_id) + "&select=id"
        status, payload = json_request(url, "PATCH", patch, {"apikey": publishable_key, "Authorization": "Bearer " + token_b,
                                                            "Content-Type": "application/json", "Prefer": "return=representation"})
        rows = json.loads(payload) if status in (200, 201) and payload else []
        checks.append({"name": label, "httpStatus": status, "changedRows": len(rows),
                       "result": "PASS" if status in (200, 204) and not rows else "FAIL"})

    source_rows = psql(db_container, f"SELECT id::text FROM public.candidate_source_documents WHERE profile_id='{a['profileId']}'::uuid ORDER BY created_at LIMIT 1;").splitlines()
    source_id = source_rows[-1] if source_rows else None
    if source_id:
        source_url = base + "candidate_source_documents?id=eq." + urllib.parse.quote(source_id) + "&select=id"
        status, payload = json_request(source_url, "DELETE", None, {"apikey": publishable_key, "Authorization": "Bearer " + token_b,
                                                                     "Prefer": "return=representation"})
        rows = json.loads(payload) if status in (200, 201) and payload else []
        checks.append({"name": "source_delete", "httpStatus": status, "deletedRows": len(rows),
                       "result": "PASS" if status in (200, 204) and not rows else "FAIL"})
    else:
        checks.append({"name": "source_delete", "result": "NOT_RUN", "reason": "No synthetic source row existed."})

    keys = object_keys(db_container, a["profileId"])
    storage_result = "NOT_RUN"
    if keys:
        object_url = api_url.rstrip("/") + "/storage/v1/object/authenticated/candidate-source-documents/" + urllib.parse.quote(keys[0], safe="/")
        status, payload = json_request(object_url, "GET", None, {"apikey": publishable_key, "Authorization": "Bearer " + token_b})
        storage_result = "PASS" if status in (400, 401, 403, 404) else "FAIL"
        checks.append({"name": "private_source_download", "httpStatus": status, "result": storage_result,
                       "responseBytesNotRecorded": True})
        # Prove that the same file is available to its owner without recording
        # its bytes or extracted text in the report.
        owner_status, owner_payload = json_request(object_url, "GET", None, {"apikey": publishable_key, "Authorization": "Bearer " + token_a})
        checks.append({"name": "owner_source_download", "httpStatus": owner_status,
                       "bytesRead": len(owner_payload) if owner_status == 200 else 0,
                       "result": "PASS" if owner_status == 200 and len(owner_payload) > 0 else "FAIL"})

    api_checks = []
    if source_id:
        source_counts_before = json.loads(psql(db_container, f"SELECT json_build_object('documents',(SELECT count(*) FROM public.candidate_source_documents WHERE profile_id='{a['profileId']}'::uuid),'objects',(SELECT count(*) FROM storage.objects WHERE bucket_id='candidate-source-documents' AND name LIKE '{a['userId']}/onboarding/%'))::text;").splitlines()[-1])
        route = browser_api_request(observer, "/api/onboarding/import-cv?id=" + urllib.parse.quote(source_id), "DELETE")
        source_counts_after = json.loads(psql(db_container, f"SELECT json_build_object('documents',(SELECT count(*) FROM public.candidate_source_documents WHERE profile_id='{a['profileId']}'::uuid),'objects',(SELECT count(*) FROM storage.objects WHERE bucket_id='candidate-source-documents' AND name LIKE '{a['userId']}/onboarding/%'))::text;").splitlines()[-1])
        preserved = source_counts_after == source_counts_before
        api_checks.append({"name": "application_source_delete_as_user_b", **route,
                           "userARecordAndStoragePreserved": preserved,
                           "result": "PASS" if preserved else "FAIL"})
    else:
        api_checks.append({"name": "application_source_delete_as_user_b", "result": "NOT_RUN",
                           "reason": "No synthetic source row existed."})

    user_a_name_before = psql(db_container, f"SELECT display_name FROM public.candidate_profiles WHERE id='{a['profileId']}'::uuid;").splitlines()[-1]
    user_b_name_before = psql(db_container, f"SELECT display_name FROM public.candidate_profiles WHERE id='{b['profileId']}'::uuid;").splitlines()[-1]
    profile_route = browser_api_request(observer, "/api/onboarding/profile", "POST", {
        "partial": True, "profileId": a["profileId"], "displayName": "Synthetic User B API Check",
    })
    user_a_name_after = psql(db_container, f"SELECT display_name FROM public.candidate_profiles WHERE id='{a['profileId']}'::uuid;").splitlines()[-1]
    user_b_name_after = psql(db_container, f"SELECT display_name FROM public.candidate_profiles WHERE id='{b['profileId']}'::uuid;").splitlines()[-1]
    blocked_foreign_profile = (profile_route.get("httpStatus") == 403
                               and profile_route.get("applicationOk") is False
                               and user_a_name_after == user_a_name_before
                               and user_b_name_after == user_b_name_before)
    api_checks.append({"name": "application_profile_maintenance_with_foreign_profile_id", **profile_route,
                       "userAProfileUnchanged": user_a_name_after == user_a_name_before,
                       "userBProfileUnchanged": user_b_name_after == user_b_name_before,
                       "result": "PASS" if blocked_foreign_profile else "FAIL"})

    report["applicationApiBoundaryChecks"] = api_checks
    report["twoUserIsolation"] = {"userBDirectRlsChecks": checks, "realUserJwtUsed": True,
                                   "tokensStoredOrReported": False, "targetDataSynthetic": True,
                                   "applicationApiChecks": api_checks}
    if any(item.get("result") == "FAIL" for item in checks + api_checks):
        raise RuntimeError("At least one local two-user ownership/RLS check failed.")


def cleanup_accounts(api_url: str, service_key: str, db_container: str, accounts: list[dict], report: dict) -> None:
    removed_files = 0
    users_deleted = 0
    for account in accounts:
        keys = object_keys(db_container, account["profileId"])
        if keys:
            status, _ = json_request(
                api_url.rstrip("/") + "/storage/v1/object/candidate-source-documents",
                "DELETE", {"prefixes": keys}, auth_headers(service_key),
            )
            if status not in (200, 204):
                raise RuntimeError("Local Storage cleanup failed with HTTP " + str(status) + ".")
            removed_files += len(keys)
    for account in accounts:
        status, _ = json_request(
            api_url.rstrip("/") + "/auth/v1/admin/users/" + account["userId"],
            "DELETE", None, auth_headers(service_key),
        )
        if status not in (200, 204):
            raise RuntimeError("Local synthetic Auth cleanup failed with HTTP " + str(status) + ".")
        users_deleted += 1
    identities = ",".join("'" + account["userId"] + "'::uuid" for account in accounts)
    like_patterns = ",".join("'" + account["userId"] + "/onboarding/%'" for account in accounts)
    cleanup_sql = ("SELECT json_build_object('profiles',(SELECT count(*) FROM public.candidate_profiles WHERE user_id IN (" + identities + ")),"
                   "'memberships',(SELECT count(*) FROM private.app_memberships WHERE user_id IN (" + identities + ")),"
                   "'storageObjects',(SELECT count(*) FROM storage.objects WHERE name LIKE ANY(ARRAY[" + like_patterns + "])))::text;")
    cleanup_state = psql(db_container, cleanup_sql)
    verified = json.loads(cleanup_state.splitlines()[-1])
    report["syntheticDataCleanup"] = {"storageObjectsRemoved": removed_files, "authUsersDeleted": users_deleted,
                                      "postCleanupCounts": verified, "complete": users_deleted == len(accounts)
                                      and all(value == 0 for value in verified.values())}
    if not report["syntheticDataCleanup"]["complete"]:
        raise RuntimeError("Local synthetic account cleanup left records behind.")


def switch_user(observer: desktop.CDPObserver, hwnd: int, chrome_pid: int, app_url: str, account: dict, report: dict, label: str) -> dict:
    current = safe_ui_state(observer)
    if "/login" not in current.get("url", ""):
        signout = desktop.onboarding_element(observer, "form[action='/auth/signout'] button")
        if signout and signout.get("displayed"):
            desktop.native_click_selector(observer, hwnd, chrome_pid, "form[action='/auth/signout'] button")
            current = wait_ui(observer, lambda state: "/login" in state["url"] and "Sign in to local test account" in state["body"], "visible sign-out to local login")
        else:
            # A fresh profile can land on an unauthenticated route other than
            # /login. Navigate there explicitly instead of assuming that every
            # non-login page is authenticated and contains a sign-out control.
            desktop.native_navigate(observer, hwnd, chrome_pid, app_url + "/login?next=%2Fonboarding")
            current = wait_ui(observer, lambda state: "/login" in state["url"] and "Sign in to local test account" in state["body"], "fresh local test login form")
    else:
        current = wait_ui(observer, lambda state: "Sign in to local test account" in state["body"], "local test login form")
    if "next=" not in current["url"]:
        desktop.native_navigate(observer, hwnd, chrome_pid, app_url + "/login?next=%2Fonboarding")
        current = wait_ui(observer, lambda state: "/login" in state["url"] and "Sign in to local test account" in state["body"], "login destination for onboarding")
    email_action = native_fill_redacted(observer, hwnd, chrome_pid, "input[name=email]", account["email"])
    password_action = native_fill_redacted(observer, hwnd, chrome_pid, "input[name=password]", account["password"])
    submit = desktop.native_click_selector(observer, hwnd, chrome_pid, "button[type=submit]")
    page = wait_ui(observer, lambda state: state["heading"] == "Build your profile" and "/onboarding" in state["url"], label + " authenticated onboarding workspace", 60)
    if "Supabase live" not in page["body"]:
        raise RuntimeError(label + " UI did not report an authenticated Supabase session.")
    report["workflow"].append({"name": "visible_local_auth_" + label.lower(), "result": "PASS",
                               "nativeEmailEntry": email_action, "nativePasswordEntry": password_action,
                               "nativeSubmitClick": submit, "authenticatedHeading": page["heading"],
                               "sessionLabelVisible": True, "credentialsRecorded": False})
    return page


def run(args) -> dict:
    repo = Path(args.source_root).resolve()
    run_id = uuid.uuid4().hex
    started = utc_now()
    temp_root = Path(os.environ.get("TEMP", str(Path.home() / "AppData/Local/Temp")))
    run_root = temp_root / f"JobHuntAI-M02-Supabase-UI-{run_id}"
    evidence_parent = Path(args.evidence_dir).resolve() if args.evidence_dir else temp_root / "JobHuntAI-M02-Supabase-Evidence"
    evidence = evidence_parent / run_id
    evidence.mkdir(parents=True, exist_ok=False)
    workspace = run_root / "workspace"
    profile = run_root / "chrome-profile"
    run_root.mkdir(parents=True, exist_ok=False)
    report = {
        "schemaVersion": "1.0.0", "runId": run_id, "startedAtUtc": started,
        "repository": {"head": subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip(),
                       "branch": subprocess.run(["git", "-C", str(repo), "branch", "--show-current"], capture_output=True, text=True, check=True).stdout.strip()},
        "testLevel": "genuine_windows_desktop_ui_with_real_local_supabase",
        "commands": ["powershell -ExecutionPolicy Bypass -File scripts/run-m02-local-supabase-ui.ps1", "Win32 SendInput mouse/keyboard; read-only loopback CDP observation"],
        "application": {"type": "Next.js development app in test-owned Chrome; not a packaged Windows app",
                        "version": json.loads((repo / "apps/web/package.json").read_text(encoding="utf-8")).get("version"),
                        "frameworkVersion": json.loads((repo / "node_modules/next/package.json").read_text(encoding="utf-8")).get("version"),
                        "chromeExecutable": None, "chromeVersion": None, "chromePid": None, "serverPid": None,
                        "workspace": "%TEMP%\\JobHuntAI-M02-Supabase-UI-" + run_id,
                        "userProfile": "%TEMP%\\JobHuntAI-M02-Supabase-UI-" + run_id + "\\chrome-profile"},
        "backend": {"kind": "local Supabase in WSL2 Podman, loopback Windows forwarding", "apiUrl": os.environ["JOBHUNT_M02_SUPABASE_URL"],
                    "productionTouched": False, "paidResourcesCreated": False, "sourceMigrationsAppliedLocally": 140,
                    "windowsForwardedPorts": [int(value) for value in os.environ.get("JOBHUNT_M02_LOOPBACK_PORTS", "").split(",") if value.isdigit()],
                    "windowsForwardersBoundToLoopback": True, "wslNetworkMode": "NAT"},
        "environment": {"python": sys.version.split()[0], "dpiAwareness": None},
        "workflow": [], "screenshots": [], "milestones": [], "cleanup": {"chromeExited": False, "serverExited": False,
        "temporaryWorkspaceRemoved": False, "ownedProcessPids": {}}, "limitations": [], "result": "RUNNING", "error": None,
        "evidenceDirectory": f"<evidence>/{run_id}"}
    server = None
    chrome = None
    observer = None
    server_pids: list[int] = []
    chrome_pids: list[int] = []
    accounts: list[dict] = []
    api_url = os.environ["JOBHUNT_M02_SUPABASE_URL"].rstrip("/")
    service_key = os.environ["JOBHUNT_M02_SERVICE_KEY"]
    publishable_key = os.environ["JOBHUNT_M02_PUBLISHABLE_KEY"]
    db_container = os.environ["JOBHUNT_M02_DB_CONTAINER"]
    try:
        report["environment"]["dpiAwareness"] = desktop.enable_per_monitor_dpi_awareness()
        account_a, account_b = seed_accounts(args, run_id)
        accounts = [account_a, account_b]
        report["fixtures"] = {"formatFiles": {}, "accounts": 2, "applicantOrProductionDataCopied": False,
                              "allAccountsAndDocumentsFictional": True}
        fixture_dir = run_root / "fixtures"
        fixtures = make_fixtures(fixture_dir)
        report["fixtures"]["formatFiles"] = {name: {"bytes": path.stat().st_size, "synthetic": True} for name, path in fixtures.items()}
        copied, packages, dependencies, supplemental = desktop.copy_isolated_workspace(repo, workspace)
        desktop.materialize_fixtures(repo, workspace, run_id)
        report["sourceCopy"] = {"trackedFiles": copied, "localPackages": packages, "supplementalWorktreeFiles": supplemental,
                                "dependencyFilesHardlinked": dependencies["hardlinked"], "dependencyFallbackCopies": dependencies["copiedFallback"],
                                "environmentFilesCopied": False, "repositoryDataCopied": False}

        env = desktop.safe_environment(run_root)
        env.update({"NEXT_PUBLIC_SUPABASE_URL": api_url,
                    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY": publishable_key,
                    "JOBHUNT_DATA_MODE": "supabase", "JOBHUNT_TEST_AUTH": "true",
                    "NEXT_TELEMETRY_DISABLED": "1"})
        node = shutil.which("node.exe") or shutil.which("node")
        if not node:
            raise FileNotFoundError("Node.js is required to run the local JobHuntAI UI.")
        port = desktop.free_loopback_port()
        app_url = f"http://127.0.0.1:{port}"
        server_command = [node, str(workspace / "apps/web/node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", str(port)]
        server_log_path = evidence / "next-dev.log"
        server_log = server_log_path.open("wb")
        server = subprocess.Popen(server_command, cwd=workspace / "apps/web", env=env, stdout=server_log,
                                  stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
        server_pids = desktop.process_tree_pids(server)
        report["application"].update({"serverPid": server.pid, "serverCommand": "node <isolated-workspace>/apps/web/node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port <ephemeral>"})
        report["milestones"].append({"name": "next_server_process_started", "timeUtc": utc_now(), "pid": server.pid})
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            if server.poll() is not None:
                raise RuntimeError("Next.js local test server exited with code " + str(server.returncode) + ".")
            try:
                with urllib.request.urlopen(app_url + "/login?next=%2Fonboarding", timeout=4) as response:
                    body = response.read().decode("utf-8", errors="replace")
                    if response.status == 200 and "Local test email" in body:
                        report["milestones"].append({"name": "loopback_auth_ui_ready", "timeUtc": utc_now(), "httpStatus": 200})
                        break
            except Exception:
                pass
            time.sleep(0.5)
        else:
            raise TimeoutError("Local app did not expose the opt-in loopback test login.")

        chrome_path = desktop.find_chrome()
        chrome_version = desktop.file_product_version(chrome_path)
        profile.mkdir(parents=True, exist_ok=False)
        disable_test_profile_password_prompt(profile)
        chrome_command = [str(chrome_path), f"--user-data-dir={profile}", "--remote-debugging-address=127.0.0.1",
                          "--remote-debugging-port=0", "--remote-allow-origins=http://localhost", "--no-first-run",
                          "--no-default-browser-check", "--disable-sync", "--disable-save-password-bubble",
                          "--disable-extensions", "--disable-background-networking",
                          "--disable-component-update", "--disable-default-apps", "--no-proxy-server",
                          "--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE 127.0.0.1,EXCLUDE localhost",
                          "--new-window", app_url + "/login?next=%2Fonboarding"]
        chrome_log = (evidence / "chrome-launch.txt").open("w", encoding="utf-8")
        chrome = subprocess.Popen(chrome_command, cwd=run_root, env=desktop.safe_environment(run_root), stdout=chrome_log,
                                  stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
        chrome_pids = desktop.process_tree_pids(chrome)
        report["application"].update({"chromeExecutable": str(chrome_path), "chromeVersion": chrome_version, "chromePid": chrome.pid})
        report["milestones"].append({"name": "test_owned_chrome_started", "timeUtc": utc_now(), "pid": chrome.pid,
                                     "isolatedProfile": True, "cdpAddress": "127.0.0.1", "cdpPort": "ephemeral"})
        debug_port, _ = desktop.cdp_connect(profile, chrome)
        observer = desktop.CDPObserver(debug_port, chrome)
        observer.connect_page(app_url)
        window_deadline = time.monotonic() + 30
        hwnd = None
        while time.monotonic() < window_deadline:
            windows = desktop.enumerate_windows_for_pid(chrome.pid)
            candidate = next((item for item in windows if item[1]), None)
            if candidate:
                hwnd = candidate[0]
                break
            time.sleep(0.25)
        if hwnd is None:
            raise TimeoutError("No native Chrome window owned by the test process appeared.")
        window = desktop.focus_and_maximize(hwnd, chrome.pid)
        display = {"width": desktop.user32.GetSystemMetrics(0), "height": desktop.user32.GetSystemMetrics(1)}
        if desktop.ImageGrab.grab().size != (display["width"], display["height"]):
            raise RuntimeError("Full desktop capture resolution did not match Windows display metrics.")
        report["environment"]["primaryDisplay"] = display
        report["milestones"].append({"name": "chrome_window_maximized", "timeUtc": utc_now(), "window": window})
        login = wait_ui(observer, lambda state: "/login" in state["url"] and "Sign in to local test account" in state["body"], "visible local login form")
        report["milestones"].append({"name": "login_page_first_visible_frame", "timeUtc": utc_now(), "heading": login["heading"], "visible": login["visible"]})
        report["screenshots"].append(desktop.desktop_screenshot(evidence / "00-local-login.png", hwnd, chrome.pid, (display["width"], display["height"])))

        switch_user(observer, hwnd, chrome.pid, app_url, account_a, report, "User A")
        state = state_summary(observer)
        if state["sourceDocuments"]:
            raise RuntimeError("Synthetic User A unexpectedly started with onboarding source data.")
        report["screenshots"].append(desktop.desktop_screenshot(evidence / "01-user-a-empty-profile.png", hwnd, chrome.pid, (display["width"], display["height"])))

        # Opening and cancelling the real Windows file picker must not create a source.
        before_sources = len(state["sourceDocuments"])
        input_element = desktop.onboarding_element(observer, "input[type=file]")
        desktop.native_click_observed_rect(observer, hwnd, chrome.pid, input_element["rect"], "input[type=file]", allow_test_owned_modal=True)
        time.sleep(0.4)
        dialog = desktop.user32.GetForegroundWindow()
        dialog_length = desktop.user32.GetWindowTextLengthW(dialog) if dialog else 0
        dialog_title = desktop.ctypes.create_unicode_buffer(max(1, dialog_length + 1))
        if dialog:
            desktop.user32.GetWindowTextW(dialog, dialog_title, len(dialog_title))
        if dialog_title.value.strip().lower() != "open":
            raise RuntimeError("The Windows file chooser did not open for the cancellation test.")
        desktop.press_key(0x1B)
        time.sleep(0.25)
        after_cancel = state_summary(observer)
        if desktop.user32.GetForegroundWindow() == dialog or len(after_cancel["sourceDocuments"]) != before_sources:
            raise RuntimeError("Cancelling the native file chooser changed the profile or left the dialog open.")
        report["workflow"].append({"name": "native_file_picker_cancel", "result": "PASS", "dialogTitle": dialog_title.value,
                                   "nativeEscape": True, "sourceCountUnchanged": True})

        upload_list = [fixtures[name] for name in ("synthetic-source-a.txt", "synthetic-source-b.md", "synthetic-typescript.pdf", "synthetic-modeling.docx", "synthetic-relational.rtf")]
        for path in upload_list:
            upload_file(observer, hwnd, chrome.pid, app_url, path, report)
        all_sources = state_summary(observer)
        formats = {item["format"] for item in all_sources["sourceDocuments"] if item["status"] == "extracted"}
        if not {"txt", "markdown", "pdf", "docx", "rtf"}.issubset(formats):
            raise RuntimeError("One or more supported document formats did not extract through the UI: " + repr(sorted(formats)))
        if any(item["status"] != "extracted" for item in all_sources["sourceDocuments"]):
            raise RuntimeError("A deterministic supported-format fixture did not extract successfully.")
        if not all(item.get("status") == "needs_review" for item in all_sources["proposals"]):
            raise RuntimeError("Imported claims were not left in the review queue.")
        report["workflow"].append({"name": "all_supported_document_formats_extracted_and_unverified", "result": "PASS",
                                   "formats": sorted(formats), "sourceCount": len(all_sources["sourceDocuments"]),
                                   "proposalCount": len(all_sources["proposals"]), "allClaimsNeedReview": True,
                                   "proposalAudit": all_sources["proposals"]})
        scroll_before = desktop.onboarding_snapshot(observer)["viewport"]["scrollY"]
        desktop.ensure_onboarding_visible(observer, hwnd, chrome.pid, "#profile-review-queue .memoryStagedWarning")
        scroll_after = desktop.onboarding_snapshot(observer)["viewport"]["scrollY"]
        conflict_items = desktop.onboarding_snapshot(observer)["reviewItems"]
        conflicts = [item for item in conflict_items if "Possible conflict" in item["text"]]
        if len(conflicts) < 2:
            raise RuntimeError("Conflicting source dates were not presented for user review: "
                               + json.dumps(all_sources["proposals"]) + "; visible review items=" + json.dumps(conflict_items))
        report["screenshots"].append(desktop.desktop_screenshot(evidence / "02-sources-and-conflict-review.png", hwnd, chrome.pid, (display["width"], display["height"])))
        report["workflow"].append({"name": "native_scroll_to_conflict_review", "result": "PASS",
                                   "scrollYBefore": scroll_before, "scrollYAfter": scroll_after,
                                   "visibleConflictWarnings": len(conflicts), "nativeWheelInput": True})

        # Review actual extracted claims through their visible per-item controls.
        names_a = "synthetic-source-a.txt"
        names_b = "synthetic-source-b.md"
        review_plan = [
            (names_a, "Data Quality Engineer", "Add to profile"),
            (names_b, "Data Quality Engineer", "Dismiss"),
            (names_a, "Ada Lovelace University", "Add to profile"),
            (names_a, "PostgreSQL Engineering", "Add to profile"),
            (names_a, "Synthetic Data Portal", "Add to profile"),
            (fixtures["synthetic-typescript.pdf"].name, "Advanced TypeScript", "Add to profile"),
            (fixtures["synthetic-modeling.docx"].name, "Data Modeling", "Add to profile"),
            (fixtures["synthetic-relational.rtf"].name, "Relational Data Modeling", "Add to profile"),
        ]
        for source_name, fragment, action in review_plan:
            desktop.resolve_review_item(observer, hwnd, chrome.pid, source_name, fragment, action)
        # A PDF skill is approved above; the second source's Python claim remains
        # synthetic and will be removed with that source below.
        reviewed = state_summary(observer)
        if len(reviewed["employment"]) != 1 or len(reviewed["education"]) != 1:
            raise RuntimeError("Visible item review did not materialize one employment and one education record.")
        if any(item["status"] == "needs_review" for item in reviewed["proposals"]):
            remaining = [item for item in reviewed["proposals"] if item["status"] == "needs_review"]
            for item in remaining:
                page_items = desktop.onboarding_snapshot(observer)["reviewItems"]
                target = next((entry for entry in page_items if item["source"] in entry["source"] and item["claim"] in entry["text"]), None)
                if target:
                    selector = f"#profile-review-queue article.pendingReviewItem:nth-of-type({target['index']}) button.textButton"
                    desktop.native_click_selector(observer, hwnd, chrome.pid, selector)
            reviewed = state_summary(observer)
        report["workflow"].append({"name": "visible_claim_review_and_conflict_resolution", "result": "PASS",
                                   "employmentCount": len(reviewed["employment"]), "educationCount": len(reviewed["education"]),
                                   "pendingProposalCount": sum(1 for item in reviewed["proposals"] if item["status"] == "needs_review"),
                                   "conflictingSourceDismissed": True})

        # Correct the employment date and education institution in visible forms.
        details_toggles = []
        if not observer.evaluate("document.querySelector('#more-profile-details')?.open===true"):
            details_toggles.append(desktop.native_click_selector(observer, hwnd, chrome.pid, "#more-profile-details > summary"))
            if not observer.evaluate("document.querySelector('#more-profile-details')?.open===true"):
                raise RuntimeError("Native input did not open More profile details.")
        history_summary = "#more-profile-details details.onboardingDetails > summary"
        if not observer.evaluate("document.querySelector('#more-profile-details details.onboardingDetails')?.open===true"):
            details_toggles.append(desktop.native_click_selector(observer, hwnd, chrome.pid, history_summary))
            if not observer.evaluate("document.querySelector('#more-profile-details details.onboardingDetails')?.open===true"):
                raise RuntimeError("Native input did not open the Employment and education section.")
        end_date_selector = "#more-profile-details .onboardingSplit > div:first-child form.recordEditor .formGrid.two > label:nth-of-type(5) input[type=date]"
        end_date = desktop.onboarding_element(observer, end_date_selector)
        if not end_date:
            raise RuntimeError("Employment date input is unavailable in the visible profile editor.")
        date_action = native_fill_date(observer, hwnd, chrome.pid, end_date_selector, "2024-11-30")
        desktop.native_click_selector(observer, hwnd, chrome.pid, "#more-profile-details .onboardingSplit > div:first-child form.recordEditor button.secondaryButton")
        education_selector = "#more-profile-details .onboardingSplit > div:nth-child(2) form.recordEditor label:first-of-type input"
        education_action = desktop.native_replace_value(observer, hwnd, chrome.pid, education_selector, "Ada Lovelace University Synthetic Campus")
        desktop.native_click_selector(observer, hwnd, chrome.pid, "#more-profile-details .onboardingSplit > div:nth-child(2) form.recordEditor button.secondaryButton")
        corrected = state_summary(observer)
        if corrected["employment"][0]["endDate"] != "2024-11-30" or corrected["education"][0]["institution"] != "Ada Lovelace University Synthetic Campus":
            raise RuntimeError("Employment or education corrections did not persist through the authenticated API.")
        report["workflow"].append({"name": "native_profile_record_corrections", "result": "PASS",
                                   "employmentDate": corrected["employment"][0]["endDate"],
                                   "educationInstitution": corrected["education"][0]["institution"],
                                   "employmentDateInput": date_action, "educationInput": education_action,
                                   "nativeDisclosureToggles": len(details_toggles)})

        # Add and remove a synthetic skill in the visible profile editor.
        skill_summary = "#more-profile-details details.onboardingDetails:nth-of-type(2) > summary"
        desktop.native_click_selector(observer, hwnd, chrome.pid, skill_summary)
        add_skill_selector = "#more-profile-details details.onboardingDetails:nth-of-type(2) .recordAddActions button"
        if not desktop.onboarding_element(observer, add_skill_selector):
            raise RuntimeError("The visible add-skill control is missing.")
        desktop.native_click_selector(observer, hwnd, chrome.pid, add_skill_selector)
        new_skill_selector = "#more-profile-details details.onboardingDetails:nth-of-type(2) form.newRecordForm input[name=name]"
        skill_entry = desktop.native_replace_value(observer, hwnd, chrome.pid, new_skill_selector, "Synthetic Acceptance Testing")
        desktop.native_click_selector(observer, hwnd, chrome.pid, "#more-profile-details details.onboardingDetails:nth-of-type(2) form.newRecordForm button.primaryButton")
        after_skill = state_summary(observer)
        if not any(skill["name"] == "Synthetic Acceptance Testing" for skill in after_skill["skills"]):
            raise RuntimeError("Synthetic skill addition was not saved.")
        wrong_skill = next((item for item in after_skill["skills"] if item["name"] == "PostgreSQL Engineering"), None)
        if not wrong_skill:
            raise RuntimeError("Expected synthetic skill for individual removal was not found.")
        skill_index = next(index for index, item in enumerate(after_skill["skills"]) if item["name"] == "PostgreSQL Engineering")
        remove_selector = f"#more-profile-details details.onboardingDetails:nth-of-type(2) .recordList form.recordEditor:nth-of-type({skill_index + 1}) button.textButton"
        desktop.native_click_selector(observer, hwnd, chrome.pid, remove_selector)
        after_remove_skill = state_summary(observer)
        if any(skill["name"] == "PostgreSQL Engineering" for skill in after_remove_skill["skills"]):
            raise RuntimeError("Visible individual skill removal did not persist.")
        report["workflow"].append({"name": "native_skill_add_and_remove", "result": "PASS", "addedSkill": "Synthetic Acceptance Testing",
                                   "removedSkill": "PostgreSQL Engineering", "nativeInput": skill_entry})

        # Set profile-only readiness details through the visible form.
        display_name_action = desktop.native_replace_value(observer, hwnd, chrome.pid, "form.profileDetailsForm input[name=displayName]", "Synthetic User A")
        work_auth_action = desktop.native_replace_value(observer, hwnd, chrome.pid, "form.profileDetailsForm input[name=workAuthorisation]", "Synthetic fixture only; not a real person's work authorisation")
        desktop.native_click_selector(observer, hwnd, chrome.pid, "form.profileDetailsForm button.primaryButton")
        ready_state = state_summary(observer)
        if ready_state["readiness"].get("ready") is not True:
            raise RuntimeError("Profile readiness remained false after reviewed history and synthetic work authorization: " + repr(ready_state["readiness"]))
        report["workflow"].append({"name": "profile_readiness_without_search_or_gmail", "result": "PASS",
                                   "readiness": ready_state["readiness"], "searchPreferencesWereNotFilled": True,
                                   "gmailWasNotConnected": True, "nativeDisplayName": display_name_action, "nativeWorkAuthorization": work_auth_action})

        # Replace Additional Information through the visible save-for-review flow;
        # it must not invoke the ChatGPT build/dispatch control.
        text_selector = "form.sourceInputForm textarea"
        desktop.native_replace_value(observer, hwnd, chrome.pid, text_selector, "Alpha")
        desktop.native_click_selector(observer, hwnd, chrome.pid, "form.sourceInputForm button.primaryButton")
        wait_ui(observer, lambda page: "No ChatGPT message has been sent" in page["body"], "source save without ChatGPT dispatch")
        first_description = state_summary(observer)
        description_count_first = sum(1 for item in first_description["sourceDocuments"] if item["sourceType"] == "user_description")
        desktop.native_replace_value(observer, hwnd, chrome.pid, text_selector, "Beta")
        desktop.native_click_selector(observer, hwnd, chrome.pid, "form.sourceInputForm button.primaryButton")
        wait_ui(observer, lambda page: "No ChatGPT message has been sent" in page["body"], "replacement source save")
        second_description = state_summary(observer)
        description_count_second = sum(1 for item in second_description["sourceDocuments"] if item["sourceType"] == "user_description")
        if description_count_first != 1 or description_count_second != 1:
            raise RuntimeError("Additional Information replacement did not retain exactly one current source.")
        report["workflow"].append({"name": "visible_additional_information_replacement_no_dispatch", "result": "PASS",
                                   "beforeCount": description_count_first, "afterCount": description_count_second,
                                   "explicitNoChatGptSendCopy": True, "bridgeOrMemoryActionClicked": False})

        # Malformed document failure is visible and recoverable; remove it with
        # the real source confirmation dialog after the extraction error appears.
        malformed = upload_file(observer, hwnd, chrome.pid, app_url, fixtures["synthetic-malformed.pdf"], report,
                                expected_status="failed")
        if malformed["status"] != "failed" or not malformed["error"]:
            raise RuntimeError("Malformed PDF did not remain visible as a failed extraction.")
        failure_ui = wait_ui(observer, lambda page: "Some documents could not be read" in page["body"]
                             and fixtures["synthetic-malformed.pdf"].name in page["body"],
                             "visible malformed-document error")
        desktop.ensure_onboarding_visible(observer, hwnd, chrome.pid, "#profile-review-queue .errorNotice")
        report["screenshots"].append(desktop.desktop_screenshot(evidence / "03-malformed-document-recoverable-error.png", hwnd, chrome.pid, (display["width"], display["height"])))
        report["workflow"].append({"name": "malformed_document_recoverable_error", "result": "PASS",
                                   "filename": fixtures["synthetic-malformed.pdf"].name, "status": malformed["status"],
                                   "errorVisibleInUI": True, "visibleMessageLength": len(failure_ui["body"])})

        # Remove the source B through its visible per-source control, keeping the
        # source A profile history and the manual profile correction intact.
        sources_dom = observer.evaluate("JSON.stringify([...document.querySelectorAll('details.onboardingSavedSources .compactList > div')].map((el,index)=>({index:index+1,text:el.innerText,rect:(()=>{const r=el.querySelector('button.textButton').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()})))")
        source_b_row = next((item for item in sources_dom if fixtures["synthetic-source-b.md"].name in item["text"]), None)
        malformed_row = next((item for item in sources_dom if fixtures["synthetic-malformed.pdf"].name in item["text"]), None)
        if not source_b_row or not malformed_row:
            # The native save list may be collapsed; open its summary then read it again.
            desktop.native_click_selector(observer, hwnd, chrome.pid, "details.onboardingSavedSources > summary")
            sources_dom = observer.evaluate("JSON.stringify([...document.querySelectorAll('details.onboardingSavedSources .compactList > div')].map((el,index)=>({index:index+1,text:el.innerText,rect:(()=>{const r=el.querySelector('button.textButton').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()})))")
            source_b_row = next((item for item in sources_dom if fixtures["synthetic-source-b.md"].name in item["text"]), None)
            malformed_row = next((item for item in sources_dom if fixtures["synthetic-malformed.pdf"].name in item["text"]), None)
        if malformed_row:
            malformed_button_selector = f"details.onboardingSavedSources .compactList > div:nth-child({malformed_row['index']}) button.textButton"
            desktop.native_click_selector(observer, hwnd, chrome.pid, malformed_button_selector)
            desktop.press_key(0x0D)
            time.sleep(0.35)
            sources_dom = observer.evaluate("JSON.stringify([...document.querySelectorAll('details.onboardingSavedSources .compactList > div')].map((el,index)=>({index:index+1,text:el.innerText})))")
            source_b_row = next((item for item in sources_dom if fixtures["synthetic-source-b.md"].name in item["text"]), None)
        if not source_b_row:
            raise RuntimeError("Visible source removal control for source B is missing.")
        source_b_selector = f"details.onboardingSavedSources .compactList > div:nth-child({source_b_row['index']}) button.textButton"
        desktop.native_click_selector(observer, hwnd, chrome.pid, source_b_selector)
        desktop.press_key(0x0D)
        time.sleep(0.4)
        persisted = state_summary(observer)
        remaining_names = [item["name"] for item in persisted["sourceDocuments"]]
        if fixtures["synthetic-source-b.md"].name in remaining_names or fixtures["synthetic-malformed.pdf"].name in remaining_names:
            raise RuntimeError("Visible source removal did not remove the selected failed/conflicting source.")
        if len(persisted["employment"]) != 1 or persisted["employment"][0]["endDate"] != "2024-11-30" or not any(item["name"] == "Synthetic Acceptance Testing" for item in persisted["skills"]):
            raise RuntimeError("Removing a source deleted unrelated corrected profile data.")
        report["workflow"].append({"name": "individual_source_removal_preserves_unrelated_profile", "result": "PASS",
                                   "removed": [fixtures["synthetic-source-b.md"].name, fixtures["synthetic-malformed.pdf"].name],
                                   "remainingSources": remaining_names, "employmentPreserved": True, "manualSkillPreserved": True})

        after_ui = db_summary(db_container, account_a["profileId"], account_a["userId"])
        if after_ui["sourceDocuments"] != len(persisted["sourceDocuments"]) or after_ui["storageObjects"] != after_ui["sourceDocuments"]:
            raise RuntimeError("Database/Storage source rows do not match the authenticated UI state.")
        if after_ui["onboarding"] not in ("in_progress", "ready"):
            raise RuntimeError("Onboarding row did not persist in PostgreSQL.")
        report["backendVerification"] = {"userA": after_ui, "noRawExtractedTextRecorded": True,
                                          "storageObjectsPrivate": True, "databaseAndUiCountsMatch": True}
        report["screenshots"].append(desktop.desktop_screenshot(evidence / "04-user-a-reviewed-profile.png", hwnd, chrome.pid, (display["width"], display["height"])))

        # A hard refresh and an actual sign-out/sign-in preserve the authenticated
        # user's reviewed records in Postgres-backed state.
        desktop.press_key(0x52, ctrl=True)
        wait_ui(observer, lambda page: page["heading"] == "Build your profile" and "/onboarding" in page["url"], "hard-refresh of User A profile", 60)
        refresh_state = state_summary(observer)
        if refresh_state["employment"][0]["endDate"] != "2024-11-30":
            raise RuntimeError("Employment correction did not survive a native browser refresh.")
        report["workflow"].append({"name": "native_refresh_persistence", "result": "PASS", "employmentDate": refresh_state["employment"][0]["endDate"]})
        report["screenshots"].append(desktop.desktop_screenshot(evidence / "05-user-a-after-refresh.png", hwnd, chrome.pid, (display["width"], display["height"])))

        switch_user(observer, hwnd, chrome.pid, app_url, account_a, report, "User A reauthentication")
        reauth_state = state_summary(observer)
        if reauth_state["employment"][0]["endDate"] != "2024-11-30":
            raise RuntimeError("User A profile did not persist after sign-out and sign-in.")
        report["workflow"].append({"name": "signout_signin_persistence", "result": "PASS", "sourceCount": len(reauth_state["sourceDocuments"])})

        switch_user(observer, hwnd, chrome.pid, app_url, account_b, report, "User B")
        b_state = state_summary(observer)
        if b_state["sourceDocuments"] or b_state["employment"] or b_state["education"] or b_state["skills"]:
            raise RuntimeError("Synthetic User B UI showed User A's profile data.")
        report["workflow"].append({"name": "user_b_visible_profile_isolation", "result": "PASS", "sourceCount": 0,
                                   "employmentCount": 0, "educationCount": 0, "skillCount": 0})
        report["screenshots"].append(desktop.desktop_screenshot(evidence / "06-user-b-isolated-profile.png", hwnd, chrome.pid, (display["width"], display["height"])))

        verify_rls(api_url, publishable_key, account_a, account_b, db_container, observer, report)
        report["milestones"].append({"name": "two_user_rls_verified", "timeUtc": utc_now()})
        # No Memory-consent, profile-build, diagnostics-send, or Bridge controls
        # were clicked. Assert the synthetic user's dispatch queue stayed empty.
        dispatch_counts = psql(db_container, "SELECT json_build_object('dispatches',(SELECT count(*) FROM public.chatgpt_dispatch_requests WHERE user_id IN ('" + account_a["userId"] + "'::uuid,'" + account_b["userId"] + "'::uuid)))::text;")
        report["externalActions"] = {"chatgptMemoryChanged": False, "bridgeRequestsSent": False, "employerCommunicationsSent": False,
                                     "applicationsSubmitted": False, "dispatchCounts": json.loads(dispatch_counts.splitlines()[-1])}
        if report["externalActions"]["dispatchCounts"].get("dispatches") != 0:
            raise RuntimeError("A synthetic user unexpectedly created a ChatGPT Bridge dispatch.")
        # Record actual loopback browser resources; the app and Supabase origin
        # are the only permitted external origins in the page resource log.
        origins = observer.evaluate("JSON.stringify([...new Set(performance.getEntriesByType('resource').map(e=>{try{return new URL(e.name).origin}catch{return ''}}).filter(Boolean))])")
        allowed = {app_url, api_url, "http://localhost"}
        unexpected = sorted(origin for origin in origins if origin not in allowed)
        report["network"] = {"pageResourceOrigins": origins, "unexpectedOrigins": unexpected,
                             "pageResourcesLoopbackOnly": not unexpected, "cdpAddress": "127.0.0.1", "cdpPort": "ephemeral"}
        if unexpected:
            raise RuntimeError("The test page contacted an unexpected resource origin.")
        report["result"] = "PASS"
    except Exception as exc:
        report["result"] = "FAIL"
        report["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        try:
            if observer:
                observer.close()
        except Exception:
            report.setdefault("cleanupErrors", []).append("CDP detach failed.")
        if chrome:
            try:
                windows = desktop.enumerate_windows_for_pid(chrome.pid)
                hwnd = windows[0][0] if windows else None
                if hwnd:
                    desktop.user32.PostMessageW(hwnd, desktop.WM_CLOSE, 0, 0)
                    time.sleep(0.25)
            except Exception:
                pass
        chrome_left = desktop.stop_owned_process(chrome, chrome_pids, graceful=True)
        server_left = desktop.stop_owned_process(server, server_pids, graceful=True)
        report["cleanup"].update({"chromeExited": not chrome_left and (chrome is None or chrome.poll() is not None),
                                  "serverExited": not server_left and (server is None or server.poll() is not None),
                                  "chromeRemainingPids": chrome_left, "serverRemainingPids": server_left,
                                  "ownedProcessPids": {"chrome": chrome_pids, "server": server_pids}})
        if accounts:
            try:
                cleanup_accounts(api_url, service_key, db_container, accounts, report)
            except Exception as cleanup_error:
                report["cleanup"]["syntheticDataCleanupError"] = type(cleanup_error).__name__ + ": " + str(cleanup_error)
                report["result"] = "FAIL_CLEANUP"
        if report["cleanup"]["chromeExited"] and report["cleanup"]["serverExited"] and report["result"] != "FAIL_CLEANUP":
            try:
                shutil.rmtree(run_root)
                report["cleanup"]["temporaryWorkspaceRemoved"] = True
            except Exception as cleanup_error:
                report.setdefault("cleanupErrors", []).append("Temporary test workspace could not be removed: " + type(cleanup_error).__name__)
                report["result"] = "FAIL_CLEANUP"
        if not report["cleanup"]["chromeExited"] or not report["cleanup"]["serverExited"]:
            report["result"] = "FAIL_CLEANUP"
        report["finishedAtUtc"] = utc_now()
        report["evidenceDirectory"] = str(evidence)
        desktop.json_write(evidence / "supabase-desktop-ui-run.json", report)
        for path in (evidence / "chrome-launch.txt",):
            if path.exists():
                text = path.read_text(encoding="utf-8", errors="replace")
                text = text.replace(publishable_key, "<redacted local publishable key>")
                path.write_text(text, encoding="utf-8")
    print(json.dumps({"result": report["result"], "report": str(evidence / "supabase-desktop-ui-run.json"),
                      "evidence": str(evidence), "cleanup": report["cleanup"]}, indent=2))
    return report


def main() -> int:
    if os.name != "nt":
        raise SystemExit("This native Windows UI acceptance runner requires Windows.")
    required = ["JOBHUNT_M02_SUPABASE_URL", "JOBHUNT_M02_SERVICE_KEY", "JOBHUNT_M02_PUBLISHABLE_KEY", "JOBHUNT_M02_DB_CONTAINER"]
    if any(not os.environ.get(name) for name in required):
        raise SystemExit("Run scripts/run-m02-local-supabase-ui.ps1 to supply the isolated local Supabase test environment.")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", default=".")
    parser.add_argument("--evidence-dir")
    args = parser.parse_args()
    report = run(args)
    return 0 if report["result"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
