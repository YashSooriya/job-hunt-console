#!/usr/bin/env python3
"""Focused M05 authorization integration against a disposable local Supabase stack."""

from __future__ import annotations

import concurrent.futures
import hashlib
import json
import os
import secrets
import urllib.parse
import uuid

import windows_supabase_onboarding_acceptance as onboarding


def sql_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def local_request(api_url: str, api_key: str, token: str, path: str, method: str = "GET",
                  body: dict | None = None, extra_headers: dict[str, str] | None = None) -> tuple[int, bytes]:
    headers = onboarding.auth_headers(api_key, token)
    if extra_headers:
        headers.update(extra_headers)
    return onboarding.json_request(api_url.rstrip("/") + path, method, body, headers)


def response_json(status: int, payload: bytes) -> dict:
    try:
        value = json.loads(payload) if payload else {}
    except (json.JSONDecodeError, UnicodeDecodeError):
        value = {}
    return value if isinstance(value, dict) else {"data": value}


def rpc(api_url: str, api_key: str, token: str, name: str, body: dict) -> tuple[int, dict]:
    status, payload = local_request(api_url, api_key, token, "/rest/v1/rpc/" + name, "POST", body)
    return status, response_json(status, payload)


def assert_http_permission_denied(label: str, status: int, payload: bytes) -> None:
    data = response_json(status, payload)
    details = " ".join(str(data.get(key, "")) for key in ("code", "message", "details", "hint")).lower()
    if status not in (400, 401, 403) or ("42501" not in details and "permission denied" not in details):
        raise RuntimeError(f"{label} was not rejected by the authenticated PostgreSQL privilege boundary.")


def seed_fixtures(container: str, user_a: dict, user_b: dict, run_id: str) -> dict:
    keys = {name: str(uuid.uuid4()) for name in (
        "company", "batch", "chunk", "legacy_app", "bootstrap_batch",
        "job_create", "job_concurrent", "job_legacy",
        "job_direct_insert",
        "snapshot_create", "snapshot_concurrent", "snapshot_legacy",
        "item_create", "item_concurrent", "item_legacy",
        "analysis_create", "analysis_concurrent", "analysis_legacy",
    )}
    ids = {name: keys["job_" + name] for name in ("create", "concurrent", "legacy")}
    email_a, email_b = user_a["email"], user_b["email"]
    membership_sql = "\n".join(
        "insert into private.app_memberships(user_id,email,role,status) values "
        f"('{user['userId']}'::uuid,{sql_quote(user['email'])},'member','active') "
        "on conflict(user_id) do update set email=excluded.email,role='member',status='active';"
        for user in (user_a, user_b)
    )
    job_rows = []
    snapshot_rows = []
    for label in ("create", "concurrent", "legacy"):
        job_id = keys["job_" + label]
        snapshot_id = keys["snapshot_" + label]
        title = f"Synthetic M05 {label} authorization engineer"
        url = f"https://example.test/m05/{run_id}/{label}"
        job_rows.append(
            f"('{job_id}'::uuid,'{user_a['userId']}'::uuid,'{keys['company']}'::uuid,"
            f"{sql_quote(title)},{sql_quote(url)},'recommend','Synthetic local authorization fixture')"
        )
        snapshot_rows.append(
            f"('{snapshot_id}'::uuid,'{job_id}'::uuid,{sql_quote(title)},'Synthetic Test Company',"
            f"{sql_quote('Fictional bounded job description for local authorization testing.')},"
            f"{sql_quote(url)},'{{}}'::jsonb)"
        )

    setup_sql = f"""
      {membership_sql}
      insert into public.companies(id,user_id,canonical_name)
      values ('{keys['company']}'::uuid,'{user_a['userId']}'::uuid,'Synthetic M05 Authorization Company');
      insert into public.jobs(id,user_id,company_id,title,source_url,triage,triage_reason)
      values {','.join(job_rows)};
      insert into public.jobs(id,user_id,company_id,title,source_url,triage,triage_reason)
      values ('{keys['job_direct_insert']}'::uuid,'{user_a['userId']}'::uuid,'{keys['company']}'::uuid,
        'Synthetic M05 direct-insert authorization control',{sql_quote('https://example.test/m05/' + run_id + '/direct-insert')},
        'recommend','Valid owned job without an application');
      insert into public.job_snapshots(id,job_id,title,company_name,description_text,source_url,raw_metadata)
      values {','.join(snapshot_rows)};
      update public.jobs j set current_snapshot_id=s.id
      from public.job_snapshots s where s.job_id=j.id and j.id in ({','.join(sql_quote(v) + '::uuid' for v in ids.values())});
    """
    onboarding.psql(container, setup_sql)

    revisions_raw = onboarding.psql(container,
        "select json_object_agg(id::text,analysis_revision)::text from public.jobs "
        f"where id in ({','.join(sql_quote(v) + '::uuid' for v in ids.values())});")
    revisions = json.loads(revisions_raw)
    job_array = "ARRAY[" + ",".join(sql_quote(value) + "::uuid" for value in ids.values()) + "]"
    onboarding.psql(container, f"""
      insert into public.job_fit_memory_v4_batches(
        id,user_id,request_id,mode,state,assessment_as_of,testing_mode,requested_job_ids,requested_count
      ) values ('{keys['batch']}'::uuid,'{user_a['userId']}'::uuid,gen_random_uuid(),
        'selected','completed',now(),true,{job_array},3);
      insert into public.job_fit_memory_v4_chunks(
        id,user_id,batch_id,ordinal,job_ids,instruction,idempotency_key,state
      ) values ('{keys['chunk']}'::uuid,'{user_a['userId']}'::uuid,'{keys['batch']}'::uuid,1,
        {job_array},'Synthetic local M05 authorization fixture.',{sql_quote('m05-authz-' + run_id)},'completed');
    """ + "\n".join(
        f"insert into public.job_fit_memory_v4_items(id,user_id,batch_id,chunk_id,job_id,listing_url,job_revision,state,result_json) "
        f"values ('{keys['item_' + label]}'::uuid,'{user_a['userId']}'::uuid,'{keys['batch']}'::uuid,'{keys['chunk']}'::uuid,"
        f"'{keys['job_' + label]}'::uuid,{sql_quote('https://example.test/m05/' + run_id + '/' + label)},{int(revisions[keys['job_' + label]])},"
        f"'assessed','{{\"fixture\":\"synthetic\",\"eligibility\":\"eligible\"}}'::jsonb);"
        for label in ("create", "concurrent", "legacy")
    ) + "\n" + "\n".join(
        f"insert into public.job_analyses(id,job_id,contract_version,eligibility,fit_score,priority_score,fit_components,priority_components,"
        f"recommended_cv_family,application_strategy,cover_letter_value,analysis_source,triage,triage_reason,engine_version,job_revision,"
        f"profile_revision,input_hash,assessment_as_of,assessment_completeness,job_fit_memory_v4_item_id) values "
        f"('{keys['analysis_' + label]}'::uuid,'{keys['job_' + label]}'::uuid,'m05-authz-fixture-v1','eligible',75,60,'{{}}'::jsonb,'{{}}'::jsonb,"
        f"'scientific_software','Synthetic strategy for authorization testing.','low','synthetic_test','recommend','Synthetic fixture',"
        f"'job-fit-memory-v4',{int(revisions[keys['job_' + label]])},null,'{hashlib.sha256((run_id + label).encode()).hexdigest()}',now(),'complete',"
        f"'{keys['item_' + label]}'::uuid);"
        f"update public.job_fit_memory_v4_items set analysis_id='{keys['analysis_' + label]}'::uuid where id='{keys['item_' + label]}'::uuid;"
        for label in ("create", "concurrent", "legacy")
    ))

    onboarding.psql(container, f"""
      insert into public.applications(
        id,user_id,job_id,state,job_snapshot_id,job_analysis_id,selected_cv_family,
        preparation_origin,preparation_metadata,next_action,notes
      ) values (
        '{keys['legacy_app']}'::uuid,'{user_a['userId']}'::uuid,'{keys['job_legacy']}'::uuid,
        'preparing','{keys['snapshot_legacy']}'::uuid,'{keys['analysis_legacy']}'::uuid,
        'scientific_software','auto_prepare','{{"fixture":"synthetic legacy M22 record"}}'::jsonb,
        'Resume the saved preparation after the user chooses to apply.','Synthetic legacy history must remain intact.'
      );
      insert into public.automation_tasks(user_id,task_type,state,idempotency_key,entity_type,entity_id,attempt_count,last_error,input_json,output_json)
      select '{user_a['userId']}'::uuid,t.task_type,'needs_user',{sql_quote('m05-authz-legacy-' + run_id)}||':'||t.task_type,
        'application','{keys['legacy_app']}'::uuid,2,'Synthetic historical attempt marker',
        '{{"execution_mode":"chatgpt_plus_handoff"}}'::jsonb,
        '{{"attempt_history":["synthetic_attempt_1","synthetic_attempt_2"]}}'::jsonb
      from (values ('prepare_cv'),('prepare_cover_letter'),('prepare_screening_answers')) t(task_type);
    """)

    payload = {
        "profile": {"display_name": "Synthetic M05 Historical Import User"},
        "tracker": {"records": [{
            "sourceRow": 424242, "company": "Synthetic Historical Employer",
            "role": "Synthetic Historical Quality Engineer", "applicationState": "awaiting_response",
            "applicationDate": "2026-10-01", "notes": "Synthetic historical import fixture"
        }]}
    }
    payload_hash = hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()
    onboarding.psql(container, f"""
      insert into private.bootstrap_import_batches(id,intended_email,batch_label,payload,payload_hash)
      values ('{keys['bootstrap_batch']}'::uuid,{sql_quote(email_a)},
        {sql_quote('m05-authorization-' + run_id)},{sql_quote(json.dumps(payload))}::jsonb,{sql_quote(payload_hash)});
    """)
    keys.update({"ids": ids, "revision": revisions, "emailA": email_a, "emailB": email_b})
    return keys


def db_json(container: str, sql: str) -> dict:
    raw = onboarding.psql(container, sql)
    return json.loads(raw) if raw else {}


def permission_matrix(container: str) -> dict:
    return db_json(container, """
      select json_build_object(
        'tableInsert',has_table_privilege('authenticated','public.applications','INSERT'),
        'tableUpdate',has_table_privilege('authenticated','public.applications','UPDATE'),
        'notesUpdate',has_column_privilege('authenticated','public.applications','notes','UPDATE'),
        'jobIdUpdate',has_column_privilege('authenticated','public.applications','job_id','UPDATE'),
        'choiceUpdate',has_column_privilege('authenticated','public.applications','chosen_to_apply_at','UPDATE'),
        'applyRpc',has_function_privilege('authenticated','public.create_application_from_job(uuid,text)','EXECUTE'),
        'applyRpcDefiner',(select prosecdef from pg_proc where oid='public.create_application_from_job(uuid,text)'::regprocedure),
        'applyRpcSearchPath',(select proconfig from pg_proc where oid='public.create_application_from_job(uuid,text)'::regprocedure),
        'claimRpc',has_function_privilege('authenticated','public.claim_bootstrap_import()','EXECUTE'),
        'claimHelper',has_function_privilege('authenticated','private.claim_bootstrap_import_internal()','EXECUTE'),
        'claimHelperService',has_function_privilege('service_role','private.claim_bootstrap_import_internal()','EXECUTE'),
        'rawFormHelper',has_function_privilege('authenticated','private.start_form_agent_session_for_user(uuid,uuid)','EXECUTE'),
        'currentUserFormHelper',has_function_privilege('authenticated','private.start_form_agent_session_current_user(uuid)','EXECUTE'),
        'publicFormRpc',has_function_privilege('authenticated','public.start_form_agent_session(uuid)','EXECUTE')
      )::text;
    """)


def role_raw_form_denial(container: str, user: dict, application_id: str) -> None:
    claims = json.dumps({"sub": user["userId"], "role": "authenticated", "email": user["email"], "aud": "authenticated"})
    onboarding.psql(container, f"""
      begin;
      set local role authenticated;
      select set_config('request.jwt.claim.sub',{sql_quote(user['userId'])},true);
      select set_config('request.jwt.claim.role','authenticated',true);
      select set_config('request.jwt.claims',{sql_quote(claims)},true);
      do $m05_test$
      begin
        begin
          perform private.start_form_agent_session_for_user('{user['userId']}'::uuid,'{application_id}'::uuid);
          raise exception 'M05_TEST_RAW_FORM_HELPER_WAS_EXECUTABLE';
        exception when insufficient_privilege then null;
        end;
      end
      $m05_test$;
      rollback;
    """)


def read_application(api_url: str, api_key: str, token: str, application_id: str) -> dict:
    query = urllib.parse.urlencode({"id": f"eq.{application_id}", "select": "id,user_id,job_id,preparation_origin,chosen_to_apply_at,notes"})
    status, payload = local_request(api_url, api_key, token, "/rest/v1/applications?" + query)
    if status != 200:
        raise RuntimeError("Authenticated application readback failed.")
    rows = json.loads(payload)
    if not rows:
        raise RuntimeError("The authenticated owner could not read back its application.")
    return rows[0]


def assert_rpc_error(api_url: str, api_key: str, token: str, name: str, body: dict, phrase: str) -> None:
    status, payload = rpc(api_url, api_key, token, name, body)
    text = json.dumps(payload, sort_keys=True).lower()
    if status < 400 or phrase.lower() not in text:
        raise RuntimeError(f"The {name} current-user wrapper did not enforce the expected prerequisite.")


def apply(api_url: str, api_key: str, token: str, job_id: str) -> dict:
    status, result = rpc(api_url, api_key, token, "create_application_from_job", {"p_job_id": job_id, "p_origin": "manual"})
    if status != 200 or not result.get("application_id"):
        raise RuntimeError("The authorized apply RPC did not return its owner-scoped application result.")
    return result


def run() -> dict:
    api_url = os.environ["JOBHUNT_M02_SUPABASE_URL"].rstrip("/")
    api_key = os.environ["JOBHUNT_M02_PUBLISHABLE_KEY"]
    service_key = os.environ["JOBHUNT_M02_SERVICE_KEY"]
    container = os.environ["JOBHUNT_M02_DB_CONTAINER"]
    host = urllib.parse.urlparse(api_url).hostname
    if host not in ("127.0.0.1", "localhost"):
        raise RuntimeError("Authorization acceptance accepts only the disposable loopback Supabase API.")

    run_id = uuid.uuid4().hex
    users: list[dict] = []
    fixture: dict = {}
    bootstrap_batch_id = ""
    cleanup_ok = False
    checks: dict[str, bool] = {}
    try:
        for label in ("a", "b"):
            email = f"m05-authz-{label}-{run_id}@example.test"
            password = secrets.token_urlsafe(32)
            user_id = onboarding.create_auth_user(api_url, service_key, email, password, f"Synthetic M05 Authorization {label.upper()}")
            users.append({"email": email, "password": password, "userId": user_id})
        token_a = onboarding.login_token(api_url, api_key, users[0])
        token_b = onboarding.login_token(api_url, api_key, users[1])
        fixture = seed_fixtures(container, users[0], users[1], run_id)
        bootstrap_batch_id = fixture["bootstrap_batch"]

        matrix = permission_matrix(container)
        if matrix != {
            "tableInsert": False, "tableUpdate": False, "notesUpdate": True, "jobIdUpdate": False, "choiceUpdate": False,
            "applyRpc": True, "applyRpcDefiner": True, "applyRpcSearchPath": ["search_path=\"\""],
            "claimRpc": True, "claimHelper": False, "claimHelperService": True,
            "rawFormHelper": False, "currentUserFormHelper": True, "publicFormRpc": True,
        }:
            raise RuntimeError("The local authenticated privilege matrix differs from the M05 contract.")
        checks["authenticated_privilege_matrix"] = True

        legacy_app = fixture["legacy_app"]
        assert_rpc_error(api_url, api_key, token_a, "start_form_agent_session",
                         {"p_application_id": legacy_app}, "choose to apply")
        direct_marker_set = local_request(api_url, api_key, token_a,
            "/rest/v1/applications?" + urllib.parse.urlencode({"id": f"eq.{legacy_app}"}),
            "PATCH", {"chosen_to_apply_at": "2099-01-01T00:00:00Z"}, {"Prefer": "return=representation"})
        assert_http_permission_denied("Direct authenticated choice marker setting on an unchosen legacy row", *direct_marker_set)
        if read_application(api_url, api_key, token_a, legacy_app)["chosen_to_apply_at"] is not None:
            raise RuntimeError("A rejected direct marker set changed the unchosen legacy application.")
        role_raw_form_denial(container, users[0], legacy_app)
        checks["raw_form_helper_denied_and_current_user_wrapper_callable"] = True

        created = apply(api_url, api_key, token_a, fixture["ids"]["create"])
        repeated = apply(api_url, api_key, token_a, fixture["ids"]["create"])
        if created.get("created") is not True or repeated.get("created") is not False \
                or created.get("application_id") != repeated.get("application_id"):
            raise RuntimeError("Repeated explicit apply did not return the one idempotent owned application.")
        app_created = created["application_id"]

        rebind = local_request(api_url, api_key, token_a,
            "/rest/v1/applications?" + urllib.parse.urlencode({"id": f"eq.{app_created}"}),
            "PATCH", {"job_id": fixture["job_direct_insert"]}, {"Prefer": "return=representation"})
        assert_http_permission_denied("Direct authenticated application vacancy rebind", *rebind)
        after_rebind_attempt = read_application(api_url, api_key, token_a, app_created)
        if after_rebind_attempt.get("job_id") != fixture["ids"]["create"] or not after_rebind_attempt.get("chosen_to_apply_at"):
            raise RuntimeError("A rejected vacancy rebind changed the selected vacancy or detached its apply choice.")
        checks["chosen_application_vacancy_binding_protected"] = True

        before_legacy_tasks = db_json(container, f"""
          select json_build_object('origin',a.preparation_origin,'tasks',coalesce((
            select json_agg(json_build_object('id',t.id,'task',t.task_type,'state',t.state,
              'attemptCount',t.attempt_count,'lastError',t.last_error,'output',t.output_json) order by t.task_type)
            from public.automation_tasks t where t.entity_type='application' and t.entity_id=a.id
          ),'[]'::json))::text from public.applications a where a.id='{legacy_app}'::uuid;
        """)
        adopted = apply(api_url, api_key, token_a, fixture["ids"]["legacy"])
        legacy_after = db_json(container, f"""
          select json_build_object('origin',a.preparation_origin,'chosen',a.chosen_to_apply_at is not null,'tasks',coalesce((
            select json_agg(json_build_object('id',t.id,'task',t.task_type,'state',t.state,
              'attemptCount',t.attempt_count,'lastError',t.last_error,'output',t.output_json) order by t.task_type)
            from public.automation_tasks t where t.entity_type='application' and t.entity_id=a.id
          ),'[]'::json))::text from public.applications a where a.id='{legacy_app}'::uuid;
        """)
        if adopted.get("created") is not False or adopted.get("application_id") != legacy_app \
                or before_legacy_tasks.get("origin") != "auto_prepare" \
                or legacy_after.get("origin") != "auto_prepare" or legacy_after.get("chosen") is not True \
                or before_legacy_tasks.get("tasks") != legacy_after.get("tasks"):
            raise RuntimeError("Explicit adoption did not preserve the legacy application and task attempt history.")
        adopted_again = apply(api_url, api_key, token_a, fixture["ids"]["legacy"])
        if adopted_again.get("application_id") != legacy_app or adopted_again.get("created") is not False:
            raise RuntimeError("Repeated legacy adoption created a duplicate application.")
        assert_rpc_error(api_url, api_key, token_a, "start_form_agent_session",
                         {"p_application_id": legacy_app}, "passed gate 1")
        checks["legacy_adoption_preserved_history_and_gate1_enforced"] = True

        concurrent_job = fixture["ids"]["concurrent"]
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            concurrent_results = list(pool.map(
                lambda _: apply(api_url, api_key, token_a, concurrent_job), range(5)
            ))
        concurrent_ids = {result["application_id"] for result in concurrent_results}
        if len(concurrent_ids) != 1 or sum(result.get("created") is True for result in concurrent_results) != 1:
            raise RuntimeError("Concurrent apply requests did not serialize to one audited application.")
        app_concurrent = next(iter(concurrent_ids))
        checks["concurrent_apply_idempotent"] = True

        # Authenticated REST writes exercise the same role used by the browser.
        direct_insert = local_request(api_url, api_key, token_a, "/rest/v1/applications", "POST", {
            "id": str(uuid.uuid4()), "user_id": users[0]["userId"],
            "job_id": fixture["job_direct_insert"], "state": "preparing"
        }, {"Prefer": "return=representation"})
        assert_http_permission_denied("Direct authenticated application INSERT", *direct_insert)

        for value, label in ((None, "clear"), ("2099-01-01T00:00:00Z", "replace")):
            patch = local_request(api_url, api_key, token_a,
                "/rest/v1/applications?" + urllib.parse.urlencode({"id": f"eq.{app_created}"}),
                "PATCH", {"chosen_to_apply_at": value}, {"Prefer": "return=representation"})
            assert_http_permission_denied(f"Direct authenticated choice marker {label}", *patch)
        first_choice = read_application(api_url, api_key, token_a, app_created)["chosen_to_apply_at"]
        if not first_choice:
            raise RuntimeError("A rejected marker write changed or cleared the apply decision.")
        allowed_notes = local_request(api_url, api_key, token_a,
            "/rest/v1/applications?" + urllib.parse.urlencode({"id": f"eq.{app_created}"}),
            "PATCH", {"notes": "Synthetic authorized non-marker update"}, {"Prefer": "return=representation"})
        if allowed_notes[0] not in (200, 204):
            raise RuntimeError("A legitimate authenticated non-marker application update was blocked.")
        replace_again = local_request(api_url, api_key, token_a,
            "/rest/v1/applications?" + urllib.parse.urlencode({"id": f"eq.{app_created}"}),
            "PATCH", {"chosen_to_apply_at": "2099-01-01T00:00:00Z"}, {"Prefer": "return=representation"})
        assert_http_permission_denied("Direct authenticated choice marker replacement", *replace_again)
        if read_application(api_url, api_key, token_a, app_created)["chosen_to_apply_at"] != first_choice:
            raise RuntimeError("An unauthorized marker replacement changed the apply decision.")
        checks["direct_insert_and_marker_writes_denied_nonmarker_update_retained"] = True

        foreign_status, foreign_result = rpc(api_url, api_key, token_b, "create_application_from_job",
            {"p_job_id": fixture["ids"]["create"], "p_origin": "manual"})
        if foreign_status < 400 or "job not found" not in json.dumps(foreign_result).lower():
            raise RuntimeError("A second authenticated user accessed or applied another user's vacancy.")
        foreign_read = local_request(api_url, api_key, token_b,
            "/rest/v1/applications?" + urllib.parse.urlencode({"id": f"eq.{app_created}", "select": "id"}))
        if foreign_read[0] != 200 or json.loads(foreign_read[1]) != []:
            raise RuntimeError("A second authenticated user could read the first user's application.")
        checks["second_user_cross_owner_access_denied"] = True

        status, history = rpc(api_url, api_key, token_a, "claim_bootstrap_import", {})
        if status != 200 or history.get("claimed") is not True or history.get("applications") != 1:
            raise RuntimeError("The authorized historical tracker import path failed after direct INSERT was revoked.")
        imported = db_json(container, f"""
          select json_build_object('count',count(*),'unchosen',bool_and(chosen_to_apply_at is null),
            'sourceRow',max(source_tracker_row))::text
          from public.applications where user_id='{users[0]['userId']}'::uuid and source_tracker_row=424242;
        """)
        if imported.get("count") != 1 or imported.get("unchosen") is not True or imported.get("sourceRow") != 424242:
            raise RuntimeError("Historical import did not preserve one unchosen tracker application.")
        second_claim = rpc(api_url, api_key, token_b, "claim_bootstrap_import", {})
        if second_claim[0] != 200 or second_claim[1].get("claimed") is not False:
            raise RuntimeError("A second user claimed another email's historical import batch.")
        checks["historical_import_path_retained_and_email_scoped"] = True

        assert_rpc_error(api_url, api_key, token_a, "start_form_agent_session",
                         {"p_application_id": app_created}, "passed gate 1")

        outcomes = db_json(container, f"""
          select json_build_object(
            'createApps',(select count(*) from public.applications where user_id='{users[0]['userId']}'::uuid and job_id='{fixture['ids']['create']}'::uuid),
            'concurrentApps',(select count(*) from public.applications where user_id='{users[0]['userId']}'::uuid and job_id='{concurrent_job}'::uuid),
            'choiceAudits',(select count(*) from public.audit_events where user_id='{users[0]['userId']}'::uuid and event_type='application.user_chose_to_apply' and entity_id in ('{app_created}'::uuid,'{app_concurrent}'::uuid,'{legacy_app}'::uuid)),
            'createdAudits',(select count(*) from public.audit_events where user_id='{users[0]['userId']}'::uuid and event_type='application.created' and entity_id in ('{app_created}'::uuid,'{app_concurrent}'::uuid)),
            'documentRequests',(select count(*) from public.document_generation_requests where user_id='{users[0]['userId']}'::uuid),
            'documents',(select count(*) from public.documents d join public.applications a on a.id=d.application_id where a.user_id='{users[0]['userId']}'::uuid),
            'formSessions',(select count(*) from public.form_agent_sessions where user_id='{users[0]['userId']}'::uuid),
            'legacyOrigin',(select preparation_origin from public.applications where id='{legacy_app}'::uuid),
            'legacyChoice',(select chosen_to_apply_at is not null from public.applications where id='{legacy_app}'::uuid)
          )::text;
        """)
        if outcomes != {
            "createApps": 1, "concurrentApps": 1, "choiceAudits": 3, "createdAudits": 2,
            "documentRequests": 0, "documents": 0, "formSessions": 0,
            "legacyOrigin": "auto_prepare", "legacyChoice": True,
        }:
            raise RuntimeError("Application/audit/document/form database outcomes did not match the explicit-choice contract.")
        checks["audited_apply_has_no_document_or_form_side_effects"] = True
        checks["current_user_form_wrapper_enforces_choice_and_gate1"] = True
    finally:
        if bootstrap_batch_id:
            try:
                onboarding.psql(container, f"delete from private.bootstrap_import_batches where id='{bootstrap_batch_id}'::uuid;")
            except Exception:
                pass
        for user in users:
            try:
                onboarding.json_request(api_url + "/auth/v1/admin/users/" + user["userId"], "DELETE", None,
                                        onboarding.auth_headers(service_key))
            except Exception:
                pass
        if users:
            try:
                remaining = db_json(container, "select json_build_object(" + ",".join(
                    f"'u{index}',(select count(*) from auth.users where id='{user['userId']}'::uuid)"
                    for index, user in enumerate(users)
                ) + ")::text;")
                cleanup_ok = all(value == 0 for value in remaining.values())
            except Exception:
                cleanup_ok = False
        else:
            cleanup_ok = True
        if bootstrap_batch_id:
            try:
                remaining_batch = onboarding.psql(container,
                    f"select count(*) from private.bootstrap_import_batches where id='{bootstrap_batch_id}'::uuid;")
                cleanup_ok = cleanup_ok and remaining_batch == "0"
            except Exception:
                cleanup_ok = False

    if not cleanup_ok:
        raise RuntimeError("Synthetic local Auth users were not fully removed during test cleanup.")
    return {"result": "PASS", "syntheticUsers": 2, "checks": checks, "cleanup": "PASS",
            "productionTouched": False, "liveChatGPT": False, "employerCalls": 0}


if __name__ == "__main__":
    try:
        print(json.dumps(run(), sort_keys=True))
    except Exception as exc:
        # Keep output free of credentials, JWTs, and raw PostgREST/Auth payloads.
        print(json.dumps({"result": "FAIL", "error": str(exc)}))
        raise
