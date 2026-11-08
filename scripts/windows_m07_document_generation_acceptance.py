#!/usr/bin/env python3
"""M07 local Windows UI and recovery acceptance; all providers stay on loopback."""

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
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from ctypes import wintypes
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import windows_m03_supabase_acceptance as m03
import windows_m04_combined_import_acceptance as m04
import windows_m05_apply_choice_acceptance as m05
import windows_m06_document_theme_smoke as m06
import windows_supabase_onboarding_acceptance as onboarding
import windows_web_ui_acceptance as desktop


REPO = Path(__file__).resolve().parent.parent
LOCAL_DB_CONTAINER = "supabase_db_jobhuntai-m02-local-20261106"
TARGET_THEME = "modern-teal"
WORKFLOW_KEY = "documents.cover_letter.create"
CV_WORKFLOW_KEY = "documents.cv.create"
SYNTHETIC_CONVERSATION_PREFIX = "https://chatgpt.com/c/m07-synthetic-"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def sql_json(container: str, sql: str) -> dict:
    try:
        return m03.psql_json(container, sql)
    except IndexError:
        return {}


def wait_for(predicate, description: str, timeout: float = 45, interval: float = 0.2):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    raise TimeoutError("Timed out waiting for " + description + ".")


def seed_job_fixture(container: str, user_id: str, profile_id: str, run_id: str) -> dict:
    company_id, job_id, snapshot_id = (str(uuid.uuid4()) for _ in range(3))
    batch_id, chunk_id, fit_item_id, analysis_id = (str(uuid.uuid4()) for _ in range(4))
    source_url = "https://example.test/m07/" + run_id[:16] + "/synthetic-engineering-role"
    title = "Synthetic Simulation Engineer"
    description = "Fictional, bounded acceptance fixture about validated simulation, numerical models and clear technical communication. No employer contact details or submission endpoint are configured."
    def q(value: str) -> str:
        return "'" + value.replace("'", "''") + "'"
    sql = f"""
      begin;
      update public.candidate_profiles set display_name='Taylor Example' where id='{profile_id}'::uuid and user_id='{user_id}'::uuid;
      insert into public.candidate_facts(profile_id,fact_key,value_json,verification_status,source_note,verified_at)
      values ('{profile_id}'::uuid,'email',to_jsonb({q('taylor.m07-' + run_id[:8] + '@example.test')}::text),'verified','synthetic_m07_local_fixture',now()),
             ('{profile_id}'::uuid,'phone',to_jsonb('+44 7700 900000'::text),'verified','synthetic_m07_local_fixture',now()),
             ('{profile_id}'::uuid,'location',to_jsonb('M07 local contact location fixture'::text),'verified','synthetic_m07_local_fixture',now());
      insert into public.companies(id,user_id,canonical_name,website)
      values ('{company_id}'::uuid,'{user_id}'::uuid,'Synthetic Example Engineering','https://example.test');
      insert into public.jobs(id,user_id,company_id,title,source_url,application_url,location_text,triage,triage_reason)
      values ('{job_id}'::uuid,'{user_id}'::uuid,'{company_id}'::uuid,{q(title)},{q(source_url)},null,'Reading, UK','recommend','Synthetic M07 document workflow fixture');
      insert into public.job_snapshots(id,job_id,title,company_name,description_text,source_url,raw_metadata)
      values ('{snapshot_id}'::uuid,'{job_id}'::uuid,{q(title)},'Synthetic Example Engineering',{q(description)},{q(source_url)},'{{}}'::jsonb);
      update public.jobs set current_snapshot_id='{snapshot_id}'::uuid where id='{job_id}'::uuid;
      insert into public.job_fit_memory_v4_batches(id,user_id,request_id,mode,state,assessment_as_of,testing_mode,requested_job_ids,requested_count)
      values ('{batch_id}'::uuid,'{user_id}'::uuid,gen_random_uuid(),'selected','completed',now(),true,ARRAY['{job_id}'::uuid],1);
      insert into public.job_fit_memory_v4_chunks(id,user_id,batch_id,ordinal,job_ids,instruction,idempotency_key,state)
      values ('{chunk_id}'::uuid,'{user_id}'::uuid,'{batch_id}'::uuid,1,ARRAY['{job_id}'::uuid],
        'Synthetic M07 local fit fixture; not a real job assessment.',{q('m07-fixture:' + run_id)},'completed');
      insert into public.job_fit_memory_v4_items(id,user_id,batch_id,chunk_id,job_id,listing_url,job_revision,state,result_json)
      select '{fit_item_id}'::uuid,'{user_id}'::uuid,'{batch_id}'::uuid,'{chunk_id}'::uuid,j.id,{q(source_url)},j.analysis_revision,
        'assessed','{{"fixture":"synthetic","eligibility":"eligible"}}'::jsonb from public.jobs j where j.id='{job_id}'::uuid;
      insert into public.job_analyses(id,job_id,contract_version,eligibility,fit_score,priority_score,fit_components,priority_components,
        recommended_cv_family,application_strategy,cover_letter_value,analysis_source,triage,triage_reason,engine_version,job_revision,
        profile_revision,input_hash,assessment_as_of,assessment_completeness,job_fit_memory_v4_item_id)
      select '{analysis_id}'::uuid,j.id,'m07-synthetic-fixture-v1','eligible',75,60,'{{}}'::jsonb,'{{}}'::jsonb,
        'scientific_software','Synthetic strategy used only by the local document acceptance.', 'medium','synthetic_test',
        'recommend','Synthetic M07 local document fixture','job-fit-memory-v4',j.analysis_revision,null,
        repeat('a',64),now(),'complete','{fit_item_id}'::uuid from public.jobs j where j.id='{job_id}'::uuid;
      update public.job_fit_memory_v4_items set analysis_id='{analysis_id}'::uuid where id='{fit_item_id}'::uuid;
      commit;
    """
    onboarding.psql(container, sql)
    return {"companyId": company_id, "jobId": job_id, "snapshotId": snapshot_id, "analysisId": analysis_id, "sourceUrl": source_url}


def database_snapshot(container: str, user_id: str, job_id: str, application_id: str | None = None) -> dict:
    app_filter = f"and a.id='{application_id}'::uuid" if application_id else ""
    return sql_json(container, f"""
      select json_build_object(
        'jobs',(select count(*) from public.jobs where user_id='{user_id}'::uuid),
        'applications',(select count(*) from public.applications where user_id='{user_id}'::uuid and job_id='{job_id}'::uuid),
        'application',(select json_build_object('id',a.id,'chosenAt',a.chosen_to_apply_at,'origin',a.preparation_origin,'snapshotId',a.job_snapshot_id,'analysisId',a.job_analysis_id)
          from public.applications a where a.user_id='{user_id}'::uuid and a.job_id='{job_id}'::uuid {app_filter}),
        'requests',(select count(*) from public.document_generation_requests where user_id='{user_id}'::uuid and application_id in (select id from public.applications where user_id='{user_id}'::uuid and job_id='{job_id}'::uuid)),
        'items',(select count(*) from public.document_generation_items where user_id='{user_id}'::uuid and application_id in (select id from public.applications where user_id='{user_id}'::uuid and job_id='{job_id}'::uuid)),
        'versions',(select count(*) from public.document_versions dv join public.documents d on d.id=dv.document_id join public.applications a on a.id=d.application_id where a.user_id='{user_id}'::uuid and a.job_id='{job_id}'::uuid),
        'formSessions',(select count(*) from public.form_agent_sessions where user_id='{user_id}'::uuid and application_id in (select id from public.applications where user_id='{user_id}'::uuid and job_id='{job_id}'::uuid)),
        'driveFolderRows',(select count(*) from public.document_application_drive_folders where user_id='{user_id}'::uuid and application_id in (select id from public.applications where user_id='{user_id}'::uuid and job_id='{job_id}'::uuid)),
        'applyAudit',(select count(*) from public.audit_events where user_id='{user_id}'::uuid and event_type='application.user_chose_to_apply' and entity_id in (select id from public.applications where user_id='{user_id}'::uuid and job_id='{job_id}'::uuid))
      )::text;
    """)


class DriveFixtureState:
    def __init__(self):
        self.lock = threading.Lock()
        self.files: list[dict] = []
        self.uploads: list[dict] = []
        self.upload_arrived = threading.Event()
        self.release_first_upload = threading.Event()
        self.block_pdf_upload = True
        self.fail_docx_once = True
        self.failure_injected = False

    def snapshot(self) -> dict:
        with self.lock:
            folders = [item for item in self.files if item.get("mimeType") == "application/vnd.google-apps.folder"]
            documents = [item for item in self.files if item.get("mimeType") != "application/vnd.google-apps.folder"]
            return {"folderCount": len(folders), "documentFileCount": len(documents),
                    "folders": [{"id": item["id"], "applicationId": item["appProperties"].get("jobhuntApplicationId")} for item in folders],
                    "documentFiles": [{"id": item["id"], "format": item["appProperties"].get("jobhuntFormat"),
                                       "itemId": item["appProperties"].get("jobhuntDocumentItemId"), "sha256": item.get("sha256")}
                                      for item in documents],
                    "uploadAttempts": list(self.uploads), "failureInjected": self.failure_injected}


class DriveFixtureServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class DriveFixtureHandler(BaseHTTPRequestHandler):
    server: DriveFixtureServer

    def log_message(self, *_args):
        return

    def _json(self, status: int, value: dict):
        payload = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", "0"))
        if length < 0 or length > 12_000_000:
            raise ValueError("bounded fixture request exceeded the accepted size")
        return self.rfile.read(length)

    def do_GET(self):
        if self.path == "/__test/health":
            return self._json(200, {"bind": "127.0.0.1"})
        if urllib.parse.urlsplit(self.path).path != "/drive/v3/files":
            return self._json(404, {"error": {"message": "not found"}})
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        drive_query = query.get("q", [""])[0]
        tags = {key: value.replace("\\'", "'").replace("\\\\", "\\") for key, value in
                re.findall(r"appProperties has \{ key='([^']+)' and value='([^']*)' \}", drive_query)}
        parent = re.search(r"'([^']+)' in parents", drive_query)
        mime_match = re.search(r"mimeType='([^']+)'", drive_query)
        with self.server.state.lock:
            found = []
            for item in self.server.state.files:
                if parent and parent.group(1) not in item.get("parents", []):
                    continue
                if mime_match and item.get("mimeType") != mime_match.group(1):
                    continue
                if any(item.get("appProperties", {}).get(key) != value for key, value in tags.items()):
                    continue
                found.append({key: item[key] for key in ("id", "name", "mimeType", "webViewLink", "appProperties") if key in item})
        self._json(200, {"files": found[:10]})

    def do_POST(self):
        if urllib.parse.urlsplit(self.path).path == "/oauth/token":
            self._read_body()
            return self._json(200, {"access_token": "m07-loopback-access", "expires_in": 3600, "token_type": "Bearer"})
        path = urllib.parse.urlsplit(self.path).path
        if path == "/drive/v3/files":
            try:
                metadata = json.loads(self._read_body())
            except Exception:
                return self._json(400, {"error": {"message": "invalid fixture JSON"}})
            identifier = "m07-folder-" + str(uuid.uuid4())
            item = {"id": identifier, "name": metadata.get("name"), "mimeType": metadata.get("mimeType"),
                    "appProperties": metadata.get("appProperties", {}), "parents": metadata.get("parents", []),
                    "webViewLink": "http://127.0.0.1/drive/folders/" + identifier}
            with self.server.state.lock:
                self.server.state.files.append(item)
            return self._json(200, {key: item[key] for key in ("id", "name", "mimeType", "webViewLink")})
        if path == "/upload/drive/v3/files":
            content_type = self.headers.get("Content-Type", "")
            boundary_match = re.search(r"boundary=([^;]+)", content_type)
            if not boundary_match:
                self._read_body()
                return self._json(400, {"error": {"message": "missing multipart boundary"}})
            boundary = boundary_match.group(1).strip('"').encode()
            body = self._read_body()
            parts = body.split(b"--" + boundary)
            try:
                metadata_part = next(part for part in parts if b"application/json" in part)
                metadata = json.loads(metadata_part.split(b"\r\n\r\n", 1)[1].rsplit(b"\r\n", 1)[0])
                document_part = next(part for part in parts if (b"Content-Type: " + str(metadata.get("mimeType", "")).encode()) in part)
                document_bytes = document_part.split(b"\r\n\r\n", 1)[1].rsplit(b"\r\n", 1)[0]
            except Exception:
                return self._json(400, {"error": {"message": "invalid bounded multipart fixture"}})
            tags = metadata.get("appProperties", {})
            format_name = str(tags.get("jobhuntFormat", ""))
            should_block = False
            with self.server.state.lock:
                attempt = {"format": format_name, "itemId": tags.get("jobhuntDocumentItemId"), "bytes": len(document_bytes)}
                self.server.state.uploads.append(attempt)
                if format_name == "pdf" and self.server.state.block_pdf_upload:
                    self.server.state.block_pdf_upload = False
                    should_block = True
                fail = format_name == "docx" and self.server.state.fail_docx_once
                if fail:
                    self.server.state.fail_docx_once = False
                    self.server.state.failure_injected = True
            if should_block:
                self.server.state.upload_arrived.set()
                self.server.state.release_first_upload.wait(40)
            if fail:
                return self._json(503, {"error": {"message": "synthetic first DOCX upload failure"}})
            key = (tags.get("jobhuntApplicationId"), tags.get("jobhuntDocumentItemId"), format_name)
            with self.server.state.lock:
                existing = next((item for item in self.server.state.files if item.get("fixtureKey") == key), None)
                if existing is None:
                    identifier = "m07-file-" + str(uuid.uuid4())
                    existing = {"id": identifier, "name": metadata.get("name"), "mimeType": metadata.get("mimeType"),
                                "parents": metadata.get("parents", []), "appProperties": tags,
                                "webViewLink": "http://127.0.0.1/drive/file/" + identifier,
                                "fixtureKey": key, "sha256": hashlib.sha256(document_bytes).hexdigest(), "size": len(document_bytes)}
                    self.server.state.files.append(existing)
            return self._json(200, {key: existing[key] for key in ("id", "name", "mimeType", "webViewLink")})
        self._json(404, {"error": {"message": "not found"}})


def start_drive_fixture(port: int) -> tuple[DriveFixtureServer, threading.Thread]:
    server = DriveFixtureServer(("127.0.0.1", port), DriveFixtureHandler)
    server.state = DriveFixtureState()
    thread = threading.Thread(target=server.serve_forever, name="m07-loopback-drive", daemon=True)
    thread.start()
    return server, thread


def response_payload(application_id: str, input_hash: str, local_name: str, phase: str) -> str:
    if phase == "context":
        return "CONTEXT RECEIVED"
    paragraphs = [
        "My remembered engineering work has focused on understanding how analytical models represent real systems and where their assumptions matter. I have approached technical problems by breaking them into manageable questions, checking the information available, and explaining the reasoning behind a proposed solution. That careful method is relevant to a simulation role, where useful results depend on both sound implementation and a clear account of uncertainty. I would bring curiosity, patience and a practical interest in improving engineering decisions.",
        "I also recall working with computational tools to organise technical information and make analysis repeatable. In that work, I valued simple checks that exposed errors early and clear notes that helped another person follow the result. Those habits would support collaboration with engineers who need reliable models and understandable conclusions. I would take time to learn the team's established methods, contribute consistently, and ask focused questions when the evidence or assumptions do not support a confident answer.",
        "The opportunity appeals to me because it connects detailed analysis with outcomes that people can use. I would contribute a thoughtful approach to model development, validation and communication, while remaining open about the limits of what I know. My remembered background is not a substitute for checking specific dates, tools or achievements, so this draft should be reviewed against the underlying facts before it is used. I would welcome a conversation about the work and the evidence the team considers most useful.",
    ]
    salutation, closing = "Dear Hiring Manager,", "Yours sincerely,"
    result = {"schema_version": "2.0", "source_mode": "chatgpt_memory", "document_kind": "cover_letter",
              "application_id": application_id, "input_hash": input_hash, "recipient": "", "salutation": salutation,
              "paragraphs": [{"text": text, "memory_support": ["Synthetic controlled Memory fixture for this local test."], "material": True}
                             for text in paragraphs],
              "closing": closing, "candidate_name": "",
              "plaintext": "\n\n".join([salutation, *paragraphs, closing])}
    if local_name and local_name in result["plaintext"]:
        raise RuntimeError("The controlled Bridge fixture unexpectedly contains a local contact name.")
    return json.dumps(result, ensure_ascii=False, separators=(",", ":"))


def cv_response_payload(application_id: str, input_hash: str, cv_family: str, phase: str) -> str:
    if phase == "context":
        return "CONTEXT RECEIVED"
    support = ["Synthetic controlled Memory fixture for this local test."]
    experience = [
        ("Senior Research Engineer", "Fixture Engineering Group", "2022–2025", [
            "Built a Python finite-element model that compared design alternatives against measured reference data before a prototype release.",
            "Introduced repeatable validation checks and documented model assumptions, reducing avoidable rework during engineering reviews.",
            "Presented uncertainty and sensitivity findings to mechanical engineers, helping the team prioritise tests with the greatest decision value."]),
        ("Research Associate", "North West Applied Research Centre", "2019–2022", [
            "Analysed experimental and simulated datasets in Python, checking data quality before drawing conclusions from model outputs.",
            "Worked with cross-disciplinary collaborators to translate research questions into testable engineering studies and clear reports.",
            "Maintained traceable records of analysis steps, limitations and decisions so findings could be independently reviewed."]),
        ("Mechanical Design Engineer", "Meridian Product Systems", "2016–2019", [
            "Supported product design reviews with calculations, test interpretation and concise evidence for engineering recommendations.",
            "Collaborated with manufacturing and quality colleagues to resolve technical questions and communicate practical constraints.",
            "Created reusable analysis notes that made assumptions and sources visible to future project teams."]),
        ("Graduate Engineer", "Meridian Product Systems", "2014–2016", [
            "Prepared engineering calculations and checked results against design requirements under the guidance of senior colleagues.",
            "Summarised test observations and technical findings for project files and internal design discussions."]),
    ]
    projects = [
        ("Thermal performance model", "Applied Engineering Study", "2021–2022", [
            "Compared simulated thermal behaviour with test evidence and recorded model limits before recommending design changes.",
            "Used Python to make the analysis repeatable and communicate which parameters most affected the result.",
            "Prepared a concise technical summary that allowed reviewers to trace recommendations to supporting evidence."]),
        ("Vibration-test correlation", "Product Engineering Study", "2018–2019", [
            "Compared vibration-test observations with model predictions and documented conditions affecting correlation.",
            "Summarised findings for a design review, separating measured results from assumptions and open questions."]),
        ("Reusable analysis workflow", "Research Engineering", "2020–2021", [
            "Organised Python analysis steps so input data, validation checks and plotted results could be reviewed consistently.",
            "Recorded sensitivity findings and limitations alongside conclusions to support reproducible technical decisions."]),
    ]
    result = {
        "schema_version": "2.0", "source_mode": "chatgpt_memory", "document_kind": "cv",
        "application_id": application_id, "input_hash": input_hash, "contact": {},
        "headline": "Engineering researcher", "headline_memory_support": support,
        "profile": {"text": "Engineer with modelling and research experience, focused on validated numerical methods and clear technical communication.", "memory_support": support},
        "skills": [{"category": "Engineering and computing", "memory_support": support,
                    "items": [{"text": text, "memory_support": support} for text in [
                        "Python, numerical modelling, finite-element methods, data analysis, model validation and reproducible workflows.",
                        "Technical reporting, uncertainty communication, design review support and cross-functional collaboration."]]}],
        "experience": [{"role": role, "company": company, "dates": dates, "location": "Manchester" if index < 2 else "Leeds",
                        "memory_support": support, "bullets": [{"text": text, "memory_support": support} for text in bullets]}
                       for index, (role, company, dates, bullets) in enumerate(experience)],
        "projects": [{"title": title, "details": "", "dates": dates, "institution": institution, "memory_support": support,
                       "bullets": [{"text": text, "memory_support": support} for text in bullets]}
                      for title, institution, dates, bullets in projects],
        "education": [
            {"qualification": "PhD, Mechanical Engineering", "institution": "University of Manchester", "dates": "2016–2020", "details": "Research focused on numerical modelling, validation and interpretation of engineering evidence.", "memory_support": support},
            {"qualification": "MEng, Mechanical Engineering", "institution": "University of Leeds", "dates": "2010–2014", "details": "Integrated master's degree with an engineering design and analysis focus.", "memory_support": support},
        ],
        "publications": [{"citation": "Engineering modelling and validation · technical reports and research presentations · 2019–2024", "memory_support": support}],
        "tailoring": {"emphasis": "model validation and technical communication", "omitted": "", "gaps": "Check all dates and details against source records."},
    }
    return json.dumps(result, ensure_ascii=False, separators=(",", ":"))


def controlled_bridge_complete(api_url: str, device_id: str, device_token: str, version: str, capabilities: dict,
                               dispatch_id: str, conversation_url: str, response_text: str,
                               workflow_key: str = WORKFLOW_KEY) -> dict:
    poll = m03.bridge_test_call(api_url, device_id, device_token, version, capabilities, "device_poll_v2")
    request = poll.get("request") if isinstance(poll.get("request"), dict) else {}
    if request.get("id") != dispatch_id:
        raise RuntimeError("The controlled local Bridge claimed a different document dispatch.")
    if request.get("workflow_key") != workflow_key or request.get("bound_conversation_url") != conversation_url:
        raise RuntimeError("The document dispatch was not routed to its exact bound document conversation.")
    lease, attempt, instruction = request.get("lease_token"), request.get("delivery_attempt_id"), request.get("instruction")
    if not all(isinstance(value, str) and value for value in (lease, attempt, instruction)):
        raise RuntimeError("The controlled Bridge did not return a bounded document dispatch lease.")
    common = {"requestId": dispatch_id, "leaseToken": lease, "deliveryAttemptId": attempt}
    user_fingerprint = hashlib.sha256(instruction.encode("utf-8")).hexdigest()
    assistant_id = str(uuid.uuid4())
    user_message_id = str(uuid.uuid4())
    turn_anchor = {"conversationUrl": conversation_url, "turnCount": 0,
                   "lastUserFingerprint": hashlib.sha256(b"m07-before-user-turn").hexdigest(),
                   "lastAssistantFingerprint": hashlib.sha256(b"m07-before-assistant-turn").hexdigest(),
                   "lastUserMessageId": None, "lastAssistantMessageId": None}
    m03.bridge_test_call(api_url, device_id, device_token, version, capabilities, "prepare_dispatch_v2",
                         {**common, "stage": "opening_chatgpt", "progress": {"stage": "opening_chatgpt", "testProvider": "m07_loopback"}})
    m03.bridge_test_call(api_url, device_id, device_token, version, capabilities, "prepare_dispatch_v2",
                         {**common, "stage": "composer_ready", "progress": {"stage": "composer_ready", "testProvider": "m07_loopback"}})
    authorized = m03.bridge_test_call(api_url, device_id, device_token, version, capabilities, "authorize_send",
                                      {**common, "turnAnchor": turn_anchor, "userTurnFingerprint": user_fingerprint,
                                       "userTurnMessageId": user_message_id})
    if authorized.get("may_send") is not True:
        raise RuntimeError("The synthetic local Bridge response did not satisfy the send-authorization gate.")
    m03.bridge_test_call(api_url, device_id, device_token, version, capabilities, "confirm_sent", common)
    provenance = {"conversationUrl": conversation_url, "userTurnFingerprint": user_fingerprint,
                  "userTurnMessageId": user_message_id, "assistantMessageId": assistant_id,
                  "assistantFingerprint": hashlib.sha256(response_text.encode("utf-8")).hexdigest(),
                  "artifactKey": None, "source": "assistant_turn", "generationFinished": True}
    status, result = m04.bridge_request(api_url, device_id, device_token, version, capabilities, "complete_dispatch_v3",
                                       {**common, "responseText": response_text, "responseProvenance": provenance})
    if status != 200 or result.get("ok") is not True:
        raise RuntimeError("The local Bridge did not durably capture the controlled synthetic response.")
    return {"workflowKey": request["workflow_key"], "conversationBound": True,
            "responseHash": result.get("response_hash"), "responseProvenanceRecorded": result.get("response_provenance_recorded") is True}


def dispatch_context(container: str, dispatch_id: str, user_id: str) -> dict:
    if not re.fullmatch(r"[0-9a-f-]{36}", dispatch_id, re.I):
        raise RuntimeError("Refusing to inspect a document dispatch without a synthetic UUID.")
    return sql_json(container, f"""
      select json_build_object('id',d.id,'userId',d.user_id,'actionType',d.action_type,'idempotencyKey',d.idempotency_key,
        'subjectRefs',d.subject_refs,'state',d.state,'responseHash',d.response_hash,'responseProvenance',d.response_provenance,
        'responseProvenanceRecorded',d.output_refs->>'response_provenance_recorded')::text
      from public.chatgpt_dispatch_requests d where d.id='{dispatch_id}'::uuid and d.user_id='{user_id}'::uuid;
    """)


def generation_context(container: str, request_id: str, user_id: str) -> dict:
    return sql_json(container, f"""
      select json_build_object('id',r.id,'applicationId',r.application_id,'templateId',r.template_id,'inputHash',r.input_hash,
        'currentChunk',r.current_chunk,'dispatchId',r.dispatch_id,'state',r.state,'testingMode',r.testing_mode,
        'snapshot',r.input_snapshot,'step',r.context_chunks->r.current_chunk)::text
      from public.document_generation_requests r where r.id='{request_id}'::uuid and r.user_id='{user_id}'::uuid;
    """)


def generation_record(container: str, request_id: str, user_id: str) -> dict:
    if not re.fullmatch(r"[0-9a-f-]{36}", request_id, re.I):
        raise RuntimeError("Refusing to inspect a generation without its synthetic UUID.")
    return sql_json(container, f"""
      select json_build_object('id',r.id,'applicationId',r.application_id,'templateId',r.template_id,'inputHash',r.input_hash,
        'currentChunk',r.current_chunk,'dispatchId',r.dispatch_id,'state',r.state,'testingMode',r.testing_mode,
        'snapshot',r.input_snapshot,'chunks',r.context_chunks)::text
      from public.document_generation_requests r where r.id='{request_id}'::uuid and r.user_id='{user_id}'::uuid;
    """)


def generation_items(container: str, request_id: str, user_id: str) -> list[dict]:
    if not re.fullmatch(r"[0-9a-f-]{36}", request_id, re.I):
        raise RuntimeError("Refusing to inspect generated documents without their synthetic request UUID.")
    result = sql_json(container, f"""
      select coalesce(json_agg(json_build_object('id',i.id,'kind',i.document_kind,'state',i.state,
        'versionId',i.document_version_id,'versionNumber',i.version_number,'templateId',i.structured_content->>'document_template_id',
        'responseHash',i.response_hash,'driveState',i.drive_state,'driveFolderId',i.drive_folder_id,
        'drivePdfId',i.drive_pdf_id,'driveDocxId',i.drive_docx_id) order by i.document_kind),'[]'::json)::text
      from public.document_generation_items i where i.request_id='{request_id}'::uuid and i.user_id='{user_id}'::uuid;
    """)
    return result if isinstance(result, list) else []


def complete_authenticated_generation(observer: desktop.CDPObserver, api_url: str, device_id: str, device_token: str,
                                      bridge_version: str, capabilities: dict, conversation_url: str, user_id: str,
                                      application_id: str, kinds: list[str], request_key: str) -> dict:
    created = m04.app_data(observer, f"/api/applications/{application_id}/documents/generate", "POST",
                          {"requestKey": request_key, "kinds": kinds, "templateId": TARGET_THEME})
    if created.get("status") != 202 or not isinstance(created.get("data", {}).get("requestId"), str):
        raise RuntimeError("The authenticated local document API rejected the synthetic " + "+".join(kinds) + " request: "
                           + json.dumps(created.get("data", {}), sort_keys=True)[:400])
    request_id = created["data"]["requestId"]
    dispatched: list[dict] = []
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        request = generation_record(LOCAL_DB_CONTAINER, request_id, user_id)
        if not request:
            raise RuntimeError("The authenticated local document request disappeared before completion.")
        if request.get("state") == "ready":
            items = generation_items(LOCAL_DB_CONTAINER, request_id, user_id)
            if len(items) != len(kinds) or any(item.get("state") != "ready" or item.get("templateId") != TARGET_THEME
                                                or not item.get("versionId") or not item.get("responseHash") for item in items):
                raise RuntimeError("The saved versions did not preserve each requested kind, response and frozen theme.")
            return {"requestIdSynthetic": True, "requestedKinds": kinds, "itemCount": len(items),
                    "versions": [{"kind": item["kind"], "versionIdSynthetic": True, "versionNumber": item["versionNumber"],
                                  "theme": item["templateId"], "responseHashPresent": bool(item["responseHash"]),
                                  "driveState": item["driveState"]} for item in items],
                    "dispatchCount": len(dispatched), "dispatches": dispatched}
        if request.get("state") in ("failed", "needs_user", "cancelled"):
            raise RuntimeError("Synthetic document generation stopped in " + str(request.get("state")) + ".")
        chunk_index = int(request.get("currentChunk", 0))
        chunks = request.get("chunks") if isinstance(request.get("chunks"), list) else []
        if chunk_index >= len(chunks):
            raise RuntimeError("The synthetic document request has no current context step.")
        step = chunks[chunk_index]
        kind, phase = step.get("kind"), step.get("phase")
        if kind not in ("cv", "cover_letter") or kind not in kinds or phase not in ("context", "final"):
            raise RuntimeError("The synthetic document request step did not match its requested document kinds.")
        workflow_key = CV_WORKFLOW_KEY if kind == "cv" else WORKFLOW_KEY
        step_conversation = conversation_url + "-cv" if kind == "cv" else conversation_url
        instruction = str(step.get("text") or "")
        if request.get("testingMode") and not instruction.startswith("TEST ONLY —"):
            instruction = "TEST ONLY — The following message is a test. Do not add, save, or update anything from it to ChatGPT Memory or long-term memory. Treat the request below as a test and answer it without changing Memory.\n\n" + instruction
        idempotency_key = f"docgen-{request_id}:{chunk_index}"
        queued = m04.app_data(observer, "/api/chatgpt-bridge/dispatch", "POST", {
            "actionType": workflow_key,
            "subjectRefs": {"application_ids": [application_id]},
            "idempotencyKey": idempotency_key,
            "displayTitle": "M07 synthetic " + ("CV" if kind == "cv" else "cover letter"),
            "websiteInstruction": instruction,
            "origin": "user_click",
        })
        dispatch = queued.get("data", {}).get("dispatch") if isinstance(queued.get("data"), dict) else None
        dispatch_id = dispatch.get("id") if isinstance(dispatch, dict) else None
        if queued.get("status") != 202 or not isinstance(dispatch_id, str):
            raise RuntimeError("The authenticated local Bridge dispatch API rejected the exact saved document step.")
        if kind == "cv":
            response_text = cv_response_payload(application_id, request["inputHash"],
                                                str((request.get("snapshot") or {}).get("cv_family") or ""), phase)
        else:
            response_text = response_payload(application_id, request["inputHash"], "Taylor Example", phase)
        completed = controlled_bridge_complete(api_url, device_id, device_token, bridge_version, capabilities,
                                               dispatch_id, step_conversation, response_text, workflow_key)
        advanced = m04.app_data(observer, f"/api/document-generations/{request_id}/advance", "POST",
                                {"chunkIndex": chunk_index, "dispatchId": dispatch_id})
        if advanced.get("status") != 200 or advanced.get("data", {}).get("ok") is not True:
            raise RuntimeError("The authenticated local document API did not capture the completed exact Bridge response: "
                               + json.dumps(advanced.get("data", {}), sort_keys=True)[:400])
        dispatched.append({"kind": kind, "phase": phase, "workflowKey": workflow_key,
                           "conversationBound": completed.get("conversationBound") is True,
                           "responseProvenanceRecorded": completed.get("responseProvenanceRecorded") is True})
    raise TimeoutError("The authenticated local synthetic document request did not complete within three minutes.")


def document_state(container: str, item_id: str) -> dict:
    return sql_json(container, f"""
      select json_build_object('id',i.id,'state',i.state,'responseHash',i.response_hash,'responseText',i.response_text,
        'versionId',i.document_version_id,'versionNumber',i.version_number,'templateId',i.structured_content->>'document_template_id',
        'engineVersion',i.structured_content->>'engine_version','sourceMode',i.structured_content->>'source_mode',
        'memoryReviewRequired',i.structured_content->>'memory_review_required','plaintext',i.plaintext,
        'driveState',i.drive_state,'folderId',i.drive_folder_id,'pdfId',i.drive_pdf_id,'docxId',i.drive_docx_id,
        'pdfHash',i.pdf_sha256,'docxHash',i.docx_sha256,'pdfKey',i.pdf_object_key,'docxKey',i.docx_object_key,
        'versionModel',dv.model,'versionStructured',dv.structured_content,
        'requestId',i.request_id,'applicationId',i.application_id,'kind',i.document_kind)::text
      from public.document_generation_items i left join public.document_versions dv on dv.id=i.document_version_id
      where i.id='{item_id}'::uuid;
    """)


def latest_request(container: str, user_id: str, application_id: str) -> dict:
    return sql_json(container, f"""
      select coalesce((select json_build_object('id',id,'state',state,'templateId',template_id,'currentChunk',current_chunk,'dispatchId',dispatch_id,
        'requestKey',request_key,'contextChunks',context_chunks,'inputSnapshot',input_snapshot,'inputHash',input_hash)
        from public.document_generation_requests where user_id='{user_id}'::uuid and application_id='{application_id}'::uuid
        order by created_at desc limit 1),'{{}}'::json)::text;
    """)


def copy_clipboard_text() -> str:
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    CF_UNICODETEXT = 13
    # Clipboard handles are pointer-sized. ctypes' default c_int return type
    # truncates them on 64-bit Windows, causing GlobalLock to fail even when
    # the native Copy text action has succeeded.
    user32.OpenClipboard.argtypes = [wintypes.HWND]
    user32.OpenClipboard.restype = wintypes.BOOL
    user32.GetClipboardData.argtypes = [wintypes.UINT]
    user32.GetClipboardData.restype = wintypes.HANDLE
    user32.CloseClipboard.argtypes = []
    user32.CloseClipboard.restype = wintypes.BOOL
    kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalUnlock.restype = wintypes.BOOL
    if not user32.OpenClipboard(None):
        raise RuntimeError("Windows clipboard could not be opened for a text-only readback.")
    try:
        handle = user32.GetClipboardData(CF_UNICODETEXT)
        if not handle:
            raise RuntimeError("The native Copy text action did not place Unicode text on the clipboard.")
        pointer = kernel32.GlobalLock(handle)
        if not pointer:
            raise RuntimeError("Windows could not read back the copied text buffer.")
        try:
            return ctypes.wstring_at(pointer)
        finally:
            kernel32.GlobalUnlock(handle)
    finally:
        user32.CloseClipboard()


def native_scroll_to(observer: desktop.CDPObserver, hwnd: int, pid: int, selector: str) -> list[dict]:
    movements = []
    last_rect = None
    last_viewport = None
    for _ in range(60):
        element = desktop.onboarding_element(observer, selector)
        if not element:
            raise RuntimeError("Expected user-visible control was not mounted: " + selector)
        viewport = desktop.onboarding_snapshot(observer)["viewport"]
        rect = element["rect"]
        last_rect, last_viewport = rect, viewport
        if rect["y"] >= 0 and rect["y"] + rect["height"] <= viewport["innerHeight"]:
            return movements
        # A partially visible target can have its top inside the viewport while
        # its bottom is still clipped. In that case, continue downward instead
        # of bouncing back to the previous wheel position.
        needs_down = rect["y"] + rect["height"] > viewport["innerHeight"]
        # The right gutter avoids embedding PDF viewers that consume wheel input.
        movements.append(desktop.native_wheel_page(observer, hwnd, pid, down=needs_down, x_ratio=0.985))
    raise RuntimeError("Native mouse-wheel input could not scroll the requested control into view: " + selector
                       + "; lastBounds=" + json.dumps({"rect": last_rect, "viewport": last_viewport,
                                                        "recentWheelReadback": movements[-8:]}, sort_keys=True))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run(args) -> dict:
    if os.name != "nt":
        raise SystemExit("M07 desktop acceptance requires Windows native input.")
    dpi_awareness = desktop.enable_per_monitor_dpi_awareness()
    run_id = uuid.uuid4().hex
    temp_root = Path(tempfile.gettempdir()).resolve()
    run_root = temp_root / ("JobHuntAI-M07-Desktop-" + run_id[:12])
    profile_root = run_root / "chrome-profile"
    download_root = run_root / "downloads"
    evidence_root = Path(args.evidence_dir).resolve() if args.evidence_dir else temp_root / "JobHuntAI-M07-Evidence"
    evidence = evidence_root / run_id
    run_root.mkdir(parents=True, exist_ok=False)
    download_root.mkdir(parents=True, exist_ok=False)
    evidence.mkdir(parents=True, exist_ok=False)
    run_started = utc_now()

    supabase = m06.local_supabase()
    user_env = {
        "JOBHUNT_M03_SUPABASE_URL": supabase["url"],
        "JOBHUNT_M03_PUBLISHABLE_KEY": supabase["publishable"],
        "JOBHUNT_M03_SERVICE_KEY": supabase["service"],
        "JOBHUNT_M03_DB_CONTAINER": LOCAL_DB_CONTAINER,
    }
    previous_env = {key: os.environ.get(key) for key in user_env}
    os.environ.update(user_env)

    account = None
    fixture = None
    provider = None
    provider_thread = None
    app_server = None
    observer = None
    chrome = None
    server_pids: list[int] = []
    chrome_pids: list[int] = []
    hwnd = None
    server_log = None
    old_bucket_limit = None
    bucket_limit_changed = False
    drive_retry_event = None
    application_id = None
    request_id = None
    item_id = None
    device_id = device_token = None
    conversation_url = SYNTHETIC_CONVERSATION_PREFIX + run_id[:18]
    report = {
        "schemaVersion": "1.0.0", "milestone": "M07", "runId": run_id, "startedAtUtc": run_started,
        "repository": {
            "branch": subprocess.run(["git", "-C", str(REPO), "branch", "--show-current"], capture_output=True, text=True, check=True).stdout.strip(),
            "head": subprocess.run(["git", "-C", str(REPO), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip(),
        },
        "testLevel": "genuine_windows_desktop_with_win32_input_and_authenticated_local_supabase",
        "separation": {"unitComponentTests": "run separately with Node test runner", "browserObservation": "loopback CDP used only for readback and authenticated API calls",
                       "desktopEvidence": "Win32 SendInput, real Chrome window, full-desktop Pillow ImageGrab screenshots"},
        "application": {"type": "Next.js app in a fresh test-owned Chrome profile", "version": json.loads((REPO / "apps/web/package.json").read_text(encoding="utf-8")).get("version"),
                        "nextVersion": json.loads((REPO / "node_modules/next/package.json").read_text(encoding="utf-8")).get("version"),
                        "chromeExecutable": str(desktop.find_chrome()), "chromeVersion": None, "chromePid": None, "serverPid": None,
                        "origin": None, "workspace": f"%TEMP%\\JobHuntAI-M07-Desktop-{run_id[:12]}", "profileIsolated": True,
                        "window": None},
        "backend": {"supabase": "disposable local WSL Supabase", "bridge": "local Edge Function with controlled synthetic responses",
                    "drive": "loopback OAuth and Drive fixture", "productionTouched": False, "liveChatGptActivity": False,
                    "realGoogleDriveUsed": False, "employerCalls": 0, "externalSubmissions": 0, "paidResourcesCreated": False},
        "environment": {"dpiAwareness": dpi_awareness, "desktopResolution": None},
        "fixture": {"syntheticUser": True, "jobs": 1, "applicationsBeforeChoice": 0, "requestedDocumentKinds": ["cover_letter"],
                    "theme": TARGET_THEME, "driveFailure": "first DOCX upload returns HTTP 503 after PDF publication is allowed",
                    "storageFailure": "local Storage bucket file size limit set to one byte and then restored"},
        "workflow": [], "screenshots": [], "cleanup": {"chromeExited": False, "serverExited": False,
            "providerStopped": False, "bridgeStoppedByRunner": None, "bridgeCleanupOwner": "PowerShell local runner",
            "bridgeFunctionPid": None, "bridgeFunctionProcessExited": None,
            "bucketLimitRestored": True,
            "syntheticAccountDeleted": False, "syntheticRowsRemoved": False, "temporaryProfileRemoved": False},
        "result": "RUNNING", "error": None, "evidenceDirectory": str(evidence),
    }

    try:
        account = m03.seed_synthetic_account(run_id, "m07")
        version_write_boundary = sql_json(LOCAL_DB_CONTAINER, """
          select json_build_object(
            'securityDefiner',p.prosecdef,
            'searchPath',coalesce(array_to_string(p.proconfig,','),''),
            'authenticatedExecute',has_function_privilege('authenticated',p.oid,'EXECUTE'),
            'anonExecute',has_function_privilege('anon',p.oid,'EXECUTE'),
            'serviceRoleExecute',has_function_privilege('service_role',p.oid,'EXECUTE'))::text
          from pg_proc p where p.oid='public.create_application_document_version(uuid,jsonb,jsonb,text,jsonb)'::regprocedure;
        """)
        if not version_write_boundary.get("securityDefiner") or 'search_path=""' not in version_write_boundary.get("searchPath", "") \
                or version_write_boundary.get("authenticatedExecute") is not True \
                or version_write_boundary.get("anonExecute") is not False or version_write_boundary.get("serviceRoleExecute") is not False:
            raise RuntimeError("The privileged document-version wrapper has an unexpected role or search-path boundary.")
        report["workflow"].append({"name": "authenticated_document_version_write_boundary", "result": "PASS",
                                   "securityDefiner": True, "fixedEmptySearchPath": True,
                                   "authenticatedExecute": True, "anonExecute": False, "serviceRoleExecute": False,
                                   "perUserOwnershipAndApplyChoiceChecks": True})
        fixture = seed_job_fixture(LOCAL_DB_CONTAINER, account["userId"], account["profileId"], run_id)
        m03.store_fake_google_grant(account, "m07")
        report["fixture"].update({"jobIdSynthetic": True, "contactsVerifiedLocally": True, "preparedGoogleGrant": "fake local provider token"})

        drive_port = desktop.free_loopback_port()
        provider, provider_thread = start_drive_fixture(drive_port)
        provider_url = f"http://127.0.0.1:{drive_port}"
        wait_for(lambda: urllib.request.urlopen(provider_url + "/__test/health", timeout=2).status == 200,
                 "loopback OAuth and Drive fixture")

        node = shutil.which("node.exe") or shutil.which("node")
        if not node:
            raise RuntimeError("Node.js was not found for the isolated local Next.js process.")
        app_port = desktop.free_loopback_port()
        app_url = f"http://127.0.0.1:{app_port}"
        report["application"]["origin"] = app_url
        server_env = desktop.safe_environment(run_root)
        server_env.update({
            "NODE_ENV": "development", "JOBHUNT_DATA_MODE": "supabase", "JOBHUNT_TEST_AUTH": "true",
            "JOBHUNT_M07_DEBUG_DOCUMENT_GENERATION": "1",
            "NEXT_PUBLIC_SUPABASE_URL": supabase["url"], "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY": supabase["publishable"],
            "NEXT_TELEMETRY_DISABLED": "1", "GOOGLE_CLIENT_ID": "m07-local-fixture-client",
            "GOOGLE_CLIENT_SECRET": "m07-local-fixture-secret", "JOBHUNT_GOOGLE_OAUTH_TEST_URL": provider_url + "/oauth/token",
            "JOBHUNT_DOCUMENT_DRIVE_TEST_ORIGIN": provider_url,
        })
        next_bin = REPO / "node_modules/next/dist/bin/next"
        server_log = (run_root / "next-server.log").open("wb")
        app_server = subprocess.Popen([node, str(next_bin), "dev", "--webpack", "--hostname", "127.0.0.1", "--port", str(app_port)],
            cwd=REPO / "apps/web", env=server_env, stdout=server_log, stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
        server_pids = desktop.process_tree_pids(app_server)
        report["application"]["serverPid"] = app_server.pid
        wait_for(lambda: True if app_server.poll() is None and _http_status(app_url + "/api/health") == 200 else None,
                         "test-owned Next.js health endpoint", timeout=120, interval=0.35)

        profile_root.mkdir(parents=True, exist_ok=False)
        onboarding.disable_test_profile_password_prompt(profile_root)
        chrome_path = desktop.find_chrome()
        report["application"]["chromeVersion"] = desktop.file_product_version(chrome_path)
        chrome, chrome_pids, observer, hwnd, window = m03.launch_chrome(REPO, run_root, profile_root, app_url, evidence)
        report["application"].update({"chromePid": chrome.pid, "window": window})
        display = (desktop.user32.GetSystemMetrics(0), desktop.user32.GetSystemMetrics(1))
        if window.get("ownerPid") != chrome.pid or window.get("maximized") is not True or window.get("isForeground") is not True:
            raise RuntimeError("The test-owned Chrome window did not reach verified foreground and maximized state.")
        if desktop.ImageGrab.grab().size != display:
            raise RuntimeError("Pillow desktop capture did not match native Windows display resolution.")
        report["environment"]["desktopResolution"] = {"width": display[0], "height": display[1], "capture": "full desktop ImageGrab"}

        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/login?next=%2Fjobs")
        wait_for(lambda: _page_state(observer).get("emailField") and _page_state(observer).get("passwordField"), "local synthetic sign-in form")
        m06.fill_native(observer, hwnd, chrome.pid, "input[name=email]", account["email"], "synthetic email")
        m06.fill_native(observer, hwnd, chrome.pid, "input[name=password]", account["password"], "synthetic password")
        observer.evaluate("""(() => {
          window.__m07AuthSubmit = null;
          const form = document.querySelector('form');
          if (!form) return false;
          form.addEventListener('submit', event => {
            window.__m07AuthSubmit = {trusted: event.isTrusted, submitter: event.submitter?.innerText?.trim() || null};
          }, true);
          return true;
        })()""")
        observer.evaluate("window.__m07ExpectedEmail=" + json.dumps(account["email"]))
        login_click = m06.click_native(observer, hwnd, chrome.pid, "button[type=submit]", chrome_pids)
        try:
            jobs_page = m04.wait_jobs_workspace(observer, timeout=25)
        except TimeoutError:
            failure_state = observer.evaluate("""JSON.stringify({
              pathname: location.pathname,
              visibleError: document.querySelector('[role=alert]')?.innerText?.trim()?.slice(0,220) || null,
              submit: window.__m07AuthSubmit || null,
              buttonText: document.querySelector('button[type=submit]')?.innerText?.trim() || null,
              buttonDisabled: document.querySelector('button[type=submit]')?.disabled ?? null,
              emailMatchesFixture: document.querySelector('input[name=email]')?.value === __m07ExpectedEmail,
              passwordPresent: !!document.querySelector('input[name=password]')?.value,
              passwordLength: document.querySelector('input[name=password]')?.value?.length || 0
            })""")
            raise TimeoutError("Visible native sign-in did not reach the authenticated Jobs workspace; safe diagnostics=" + json.dumps(failure_state, sort_keys=True)) from None
        report["workflow"].append({"name": "fresh_profile_native_sign_in", "result": "PASS", "nativeInput": True,
                                   "activeFieldReadback": True, "testOwnedChromePid": chrome.pid, "maximized": True,
                                   "passwordPromptDismissed": bool(login_click.get("testOwnedPasswordPromptDismissed")),
                                   "authenticatedWorkspace": jobs_page})

        testing_mode = m04.app_data(observer, "/api/diagnostics/testing-mode", "POST", {"enabled": True})
        if testing_mode.get("status") != 200 or testing_mode.get("data", {}).get("enabled") is not True:
            raise RuntimeError("Synthetic account Testing Mode did not persist through its authenticated local API.")

        bridge_version = json.loads((REPO / "apps/chatgpt-bridge-extension/package.json").read_text(encoding="utf-8"))["version"]
        capabilities = {"protocol_version": 2, "build_id": f"{bridge_version}-m07-loopback-test",
                        "durable_dispatch_v2": True, "send_authorization_v2": True, "result_outbox_v1": True,
                        "result_completion_v3": True, "response_provenance_v3": True, "concurrent_response_capture": 2,
                        "background_focus_policy_v2": True}
        pair_data = m04.app_data(observer, "/api/chatgpt-bridge/pairing", "POST", {})
        pairing_code = (pair_data.get("data") or {}).get("pairing_code") if pair_data.get("status") == 200 else None
        if not isinstance(pairing_code, str) or not pairing_code:
            raise RuntimeError("The synthetic local account could not create a one-time Bridge pairing code.")
        pair_status, paired = m04.bridge_request(supabase["url"], "", "", bridge_version, capabilities, "pair_device", {
            "pairingCode": pairing_code, "displayName": "M07 controlled local provider", "platform": "chrome", "extensionVersion": bridge_version})
        device = paired.get("device") if isinstance(paired.get("device"), dict) else {}
        device_id, device_token = device.get("id"), paired.get("device_token")
        if pair_status != 200 or not isinstance(device_id, str) or not isinstance(device_token, str):
            raise RuntimeError("The local Edge Function rejected the synthetic test-provider pairing.")
        m03.bridge_test_call(supabase["url"], device_id, device_token, bridge_version, capabilities, "device_heartbeat")
        bound = m03.bridge_test_call(supabase["url"], device_id, device_token, bridge_version, capabilities, "bind_conversation", {
            "workflowKey": WORKFLOW_KEY, "conversationUrl": conversation_url, "projectName": "JobHuntAI", "projectVerified": True})
        if bound.get("bound_project_verified") is not True:
            raise RuntimeError("The synthetic cover-letter workflow conversation did not bind to the local Bridge device.")
        cv_bound = m03.bridge_test_call(supabase["url"], device_id, device_token, bridge_version, capabilities, "bind_conversation", {
            "workflowKey": CV_WORKFLOW_KEY, "conversationUrl": conversation_url + "-cv", "projectName": "JobHuntAI", "projectVerified": True})
        if cv_bound.get("bound_project_verified") is not True:
            raise RuntimeError("The synthetic CV workflow conversation did not bind to the local Bridge device.")
        m03.bridge_test_call(supabase["url"], device_id, device_token, bridge_version, capabilities, "set_automatic_send", {"enabled": True})
        slot = sql_json(LOCAL_DB_CONTAINER, f"""
          select json_build_object('workflowKey',workflow_key,'conversationUrl',conversation_url,
            'projectVerified',project_verified_at is not null,'active',active)::text
          from public.chatgpt_bridge_conversation_slots where device_id='{device_id}'::uuid and workflow_key='{WORKFLOW_KEY}';
        """)
        if slot.get("conversationUrl") != conversation_url or slot.get("workflowKey") != WORKFLOW_KEY or not slot.get("projectVerified") or not slot.get("active"):
            raise RuntimeError("The local Bridge database did not preserve the exact cover-letter workflow binding.")
        report["workflow"].append({"name": "isolated_bridge_workflow_binding", "result": "PASS", "workflowKey": WORKFLOW_KEY,
                                   "conversationUrl": "synthetic chatgpt.com conversation identifier; no ChatGPT site opened",
                                   "projectVerified": True, "cvWorkflowBound": True, "externalMessageCount": 0})

        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + "/jobs")
        m04.wait_jobs_workspace(observer)
        before_choice = database_snapshot(LOCAL_DB_CONTAINER, account["userId"], fixture["jobId"])
        if before_choice.get("applications") != 0 or before_choice.get("requests") != 0 or before_choice.get("formSessions") != 0:
            raise RuntimeError("Synthetic job was not free of application/document/form records before explicit apply.")
        row_checkbox = m04.visible_job_checkbox(observer, fixture["jobId"])
        select_click = desktop.native_click_selector(observer, hwnd, chrome.pid, row_checkbox["selector"])
        selected = observer.evaluate("JSON.stringify((()=>{const path='/jobs/'+" + json.dumps(fixture["jobId"]) + ";const a=[...document.querySelectorAll('a.jobPoolRole')].find(x=>x.getAttribute('href')?.split('?')[0]===path);const row=a?.closest('tr');return {checked:row?.querySelector('input[type=checkbox]')?.checked===true,button:row?.querySelector('button.primaryButton')?.innerText.trim()||null}})())")
        if not selected or selected.get("checked") is not True or selected.get("button") != "Choose to apply":
            raise RuntimeError("The native Job Pool selection did not read back as the intended explicit apply choice.")
        screenshot_path = evidence / "01-selected-job-before-apply.png"
        report["screenshots"].append(_screenshot(screenshot_path, hwnd, chrome.pid, display))
        apply_button = m05.apply_button_selector(observer, fixture["jobId"])
        if apply_button.get("text") != "Choose to apply" or apply_button.get("disabled"):
            raise RuntimeError("The selected Job Pool row did not expose the enabled explicit apply action.")
        apply_click = desktop.native_click_selector(observer, hwnd, chrome.pid, apply_button["selector"])
        application_path = wait_for(lambda: observer.evaluate("location.pathname.startsWith('/applications/')?location.pathname:null"),
                                    "application page after explicit choice", timeout=45)
        application_id = application_path.rsplit("/", 1)[-1]
        chosen = database_snapshot(LOCAL_DB_CONTAINER, account["userId"], fixture["jobId"], application_id)
        if chosen.get("applications") != 1 or not chosen.get("application", {}).get("chosenAt") or chosen.get("applyAudit") != 1 \
                or chosen.get("requests") != 0 or chosen.get("items") != 0 or chosen.get("versions") != 0 or chosen.get("formSessions") != 0:
            raise RuntimeError("Choose to apply did not record one decision without creating documents or form work.")
        report["workflow"].append({"name": "native_job_selection_and_explicit_apply", "result": "PASS",
                                   "nativeSelection": select_click, "selectedRowReadback": selected,
                                   "nativeApplyClick": apply_click, "applicationIdSynthetic": True,
                                   "applyDecisionRecorded": True, "noDocumentOrFormSideEffect": True})
        report["screenshots"].append(_screenshot(evidence / "02-explicit-application-created.png", hwnd, chrome.pid, display))

        desktop.native_navigate(observer, hwnd, chrome.pid, app_url + application_path)
        wait_for(lambda: _page_state(observer).get("pathname") == application_path and
                 "Create documents for this job" in _page_state(observer).get("bodyText", ""), "document request controls", timeout=45)
        memory_copy = observer.evaluate("JSON.stringify({heading:[...document.querySelectorAll('h2')].find(item=>item.innerText.trim()==='Saved analysis evidence')?.innerText.trim()||'',note:[...document.querySelectorAll('.cardHeader p')].map(item=>item.innerText).find(text=>text.includes('These references stay in your account'))||'',cvChoice:document.querySelector('.documentRequestChoices label:nth-child(1)')?.innerText||''})")
        if not memory_copy or memory_copy.get("heading") != "Saved analysis evidence" \
                or "not this evidence list" not in memory_copy.get("note", "") or "factual review" not in memory_copy.get("note", "") \
                or "ChatGPT Memory" not in memory_copy.get("cvChoice", "") or "factual review" not in memory_copy.get("cvChoice", "").lower() \
                or "evidence-backed" in memory_copy.get("cvChoice", "").lower():
            raise RuntimeError("The application page did not clearly explain the local evidence versus Memory-only draft boundary.")
        report["workflow"].append({"name": "memory_only_candidate_context_notice", "result": "PASS",
                                   "savedEvidenceStaysLocal": True, "memoryBasedDraftsRequireFactualReview": True})
        if database_snapshot(LOCAL_DB_CONTAINER, account["userId"], fixture["jobId"], application_id).get("requests") != 0:
            raise RuntimeError("The separate document-generation action already had a request before the user chose it.")
        native_scroll_to(observer, hwnd, chrome.pid, ".documentRequestChoices label:nth-child(1) input")
        cover = m03.native_checkbox(observer, hwnd, chrome.pid, ".documentRequestChoices label:nth-child(1) input", False)
        letter = m03.native_checkbox(observer, hwnd, chrome.pid, ".documentRequestChoices label:nth-child(2) input", True)
        theme_selector = "#document-theme-" + application_id
        native_scroll_to(observer, hwnd, chrome.pid, theme_selector)
        theme = m03.native_select_index(observer, hwnd, chrome.pid, theme_selector, 4, TARGET_THEME)
        choices = observer.evaluate("JSON.stringify({cv:document.querySelector('.documentRequestChoices label:nth-child(1) input')?.checked===true,letter:document.querySelector('.documentRequestChoices label:nth-child(2) input')?.checked===true,theme:document.querySelector('#document-theme-" + application_id + "')?.value||null})")
        if not choices or choices.get("cv") or not choices.get("letter") or choices.get("theme") != TARGET_THEME:
            raise RuntimeError("Native input did not select only a cover letter and the intended frozen theme.")
        report["workflow"].append({"name": "native_separate_document_kind_and_frozen_theme_choice", "result": "PASS",
                                   "cvUnchecked": cover.get("checkedReadback"), "coverLetterChecked": letter.get("checkedReadback"),
                                   "themeSelection": theme, "readback": choices})
        report["screenshots"].append(_screenshot(evidence / "03-letter-and-theme-selected.png", hwnd, chrome.pid, display))

        old_limit_row = sql_json(LOCAL_DB_CONTAINER, "select json_build_object('limit',file_size_limit)::text from storage.buckets where id='application-documents';")
        if "limit" not in old_limit_row:
            raise RuntimeError("The disposable application-documents Storage bucket was not found.")
        old_bucket_limit = old_limit_row["limit"]
        bucket_limit_changed = True
        onboarding.psql(LOCAL_DB_CONTAINER, "update storage.buckets set file_size_limit=1 where id='application-documents';")
        report["cleanup"]["bucketLimitRestored"] = False
        if sql_json(LOCAL_DB_CONTAINER, "select json_build_object('limit',file_size_limit)::text from storage.buckets where id='application-documents';").get("limit") != 1:
            raise RuntimeError("The test-local Storage failure injection did not read back as one byte.")

        generation_button = ".applicationDocumentGenerator .documentGenerationControls button.primaryButton"
        native_scroll_to(observer, hwnd, chrome.pid, generation_button)
        observer.evaluate("""(() => {
          const original=window.fetch.bind(window);
          window.__m07DispatchResponse=null;
          window.__m07AdvanceResponses=[];
          window.fetch=async(...args)=>{
            const input=args[0],init=args[1]||{};
            const url=typeof input==='string'?input:(input?.url||'');
            const method=String(init.method||input?.method||'GET').toUpperCase();
            const response=await original(...args);
            if(method==='POST'&&new URL(url,location.href).pathname==='/api/chatgpt-bridge/dispatch'){
              let data={};try{data=await response.clone().json()}catch{}
              window.__m07DispatchResponse={status:response.status,ok:data?.ok===true,error:typeof data?.error==='string'?data.error:null};
            }
            if(method==='POST'&&/\\/api\\/document-generations\\/[^/]+\\/advance$/.test(new URL(url,location.href).pathname)){
              let data={};try{data=await response.clone().json()}catch{}
              window.__m07AdvanceResponses.push({status:response.status,ok:data?.ok===true,error:typeof data?.error==='string'?data.error:null,
                result:data?.result&&typeof data.result==='object'?Object.fromEntries(['ok','capturedContext','capturedDocument','waiting','state','idempotent'].filter(key=>key in data.result).map(key=>[key,data.result[key]])):null});
              window.__m07AdvanceResponses=window.__m07AdvanceResponses.slice(-8);
            }
            return response;
          };
        })()""")
        generation_click = m06.click_native(observer, hwnd, chrome.pid, generation_button, chrome_pids)
        request_row = wait_for(lambda: (lambda row: row if row.get("id") else None)(latest_request(LOCAL_DB_CONTAINER, account["userId"], application_id)),
                               "user-created document-generation request", timeout=35)
        request_id = request_row.get("id")
        if not isinstance(request_id, str) or request_row.get("templateId") != TARGET_THEME:
            raise RuntimeError("The explicit document request did not freeze the selected theme.")
        report["workflow"].append({"name": "native_generation_request", "result": "PASS", "nativeGenerateClick": generation_click,
                                   "requestIdSynthetic": True, "frozenTheme": TARGET_THEME, "requestedKinds": ["cover_letter"]})

        request_prefix = "docgen-" + request_id + ":"
        final_storage_failure = False
        bridge_steps: list[dict] = []
        bridge_state_trace: list[dict] = []
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            request_row = latest_request(LOCAL_DB_CONTAINER, account["userId"], application_id)
            if not request_row:
                raise RuntimeError("The saved document request disappeared from the local database.")
            current = int(request_row.get("currentChunk", 0))
            dispatch_key = request_prefix + str(current)
            dispatch_row = sql_json(LOCAL_DB_CONTAINER, f"""
              select json_build_object('id',id,'state',state,'actionType',action_type,'idempotencyKey',idempotency_key,
                'subjectRefs',subject_refs,'errorCode',error_json->>'code')::text from public.chatgpt_dispatch_requests
              where user_id='{account['userId']}'::uuid and idempotency_key='{dispatch_key}';
            """)
            trace_row = {"chunk": current, "requestState": request_row.get("state"), "dispatchIdPresent": bool(dispatch_row.get("id")),
                         "dispatchState": dispatch_row.get("state"), "actionType": dispatch_row.get("actionType"),
                         "errorCode": dispatch_row.get("errorCode")}
            if not bridge_state_trace or bridge_state_trace[-1] != trace_row:
                bridge_state_trace.append(trace_row)
                bridge_state_trace[:] = bridge_state_trace[-12:]
            if not dispatch_row:
                visible_dispatch_error = observer.evaluate("document.querySelector('.applicationDocumentGenerator .formError[role=alert]')?.innerText||''")
                if isinstance(visible_dispatch_error, str) and visible_dispatch_error.strip():
                    raise RuntimeError("The visible document flow stopped before creating its Bridge dispatch: "
                                       + visible_dispatch_error.strip()[:300] + " "
                                       + json.dumps({"dispatchApi": observer.evaluate("JSON.stringify(window.__m07DispatchResponse||null)"), **trace_row}, sort_keys=True))
            if dispatch_row and dispatch_row.get("state") == "queued":
                step = request_row["contextChunks"][current]
                if step.get("kind") != "cover_letter" or dispatch_row.get("actionType") != WORKFLOW_KEY:
                    raise RuntimeError("A saved document step was routed to the wrong action or kind.")
                refs = dispatch_row.get("subjectRefs") or {}
                if refs.get("application_ids") != [application_id]:
                    raise RuntimeError("The controlled Bridge step was not correlated to the selected application.")
                response_text = response_payload(application_id, request_row["inputHash"], "Taylor Example", step.get("phase"))
                controlled = controlled_bridge_complete(supabase["url"], device_id, device_token, bridge_version,
                                                        capabilities, dispatch_row["id"], conversation_url, response_text)
                bridge_steps.append({"chunk": current, "dispatchId": dispatch_row["id"], "phase": step.get("phase"),
                                     "responseHash": hashlib.sha256(response_text.strip().encode()).hexdigest(),
                                     "workflowKey": controlled["workflowKey"], "conversationBound": controlled["conversationBound"],
                                     "provenanceRecorded": controlled["responseProvenanceRecorded"]})
                continue
            if dispatch_row and dispatch_row.get("state") in ("failed", "user_required", "expired", "cancelled"):
                raise RuntimeError("The isolated Bridge dispatch stopped before the controlled response: "
                                   + json.dumps(trace_row, sort_keys=True))
            current_item = sql_json(LOCAL_DB_CONTAINER, f"""
              select json_build_object('state',state,'versionId',document_version_id,'responseHash',response_hash,
                'requestState',(select state from public.document_generation_requests where id=request_id))::text
              from public.document_generation_items where request_id='{request_id}'::uuid;
            """)
            if current_item and current_item.get("state") == "validating" and request_row.get("state") == "validating":
                visible_failure = observer.evaluate("JSON.stringify({alert:document.querySelector('.applicationDocumentGenerator .formError[role=alert]')?.innerText||'',advanceApi:window.__m07AdvanceResponses||[]})")
                if visible_failure and visible_failure.get("alert") and any(int(result.get("status", 0)) >= 400 for result in visible_failure.get("advanceApi", [])):
                    report["bridgeDiagnosticTrace"] = bridge_state_trace
                    report["bridgeDiagnosticSnapshot"] = {"requestState": request_row.get("state"), "currentChunk": current,
                        "itemState": current_item.get("state"), "versionIdPresent": bool(current_item.get("versionId")),
                        "visibleError": visible_failure}
                    raise RuntimeError("Captured final response stopped before version creation: " + json.dumps(report["bridgeDiagnosticSnapshot"], sort_keys=True))
            if current_item and current_item.get("versionId") and current_item.get("state") == "rendering":
                final_storage_failure = True
                item_id = sql_json(LOCAL_DB_CONTAINER, f"select json_build_object('id',id)::text from public.document_generation_items where request_id='{request_id}'::uuid;").get("id")
                break
            if request_row.get("state") in ("ready", "failed", "needs_user"):
                raise RuntimeError("Document workflow reached a terminal state before the expected injected Storage failure.")
            time.sleep(0.25)
        if not final_storage_failure or not item_id:
            final_request = latest_request(LOCAL_DB_CONTAINER, account["userId"], application_id)
            current = int(final_request.get("currentChunk", 0)) if final_request else -1
            ui_error = observer.evaluate("JSON.stringify({alert:document.querySelector('.applicationDocumentGenerator .formError[role=alert]')?.innerText||'',savingRetry:[...document.querySelectorAll('button')].some(button=>button.innerText.trim()==='Retry saving captured response'),advanceApi:window.__m07AdvanceResponses||[]})")
            report["bridgeDiagnosticTrace"] = bridge_state_trace
            report["bridgeDiagnosticSnapshot"] = {"requestState": final_request.get("state"), "currentChunk": current,
                "dispatchIdPresent": bool(final_request.get("dispatchId")), "itemState": bool(item_id), "visibleError": ui_error}
            raise TimeoutError("The final controlled Bridge response did not reach the saved-version/Storage-failure checkpoint. "
                               + json.dumps({"trace": bridge_state_trace, "requestState": final_request.get("state"),
                                             "currentChunk": current, "dispatchIdPresent": bool(final_request.get("dispatchId")),
                                             "visibleError": ui_error}, sort_keys=True))
        checkpoint = document_state(LOCAL_DB_CONTAINER, item_id)
        expected_response = next((item for item in bridge_steps if item.get("phase") == "final"), None)
        if not checkpoint.get("responseHash") or checkpoint.get("responseHash") != (expected_response or {}).get("responseHash") \
                or checkpoint.get("state") != "rendering" or not checkpoint.get("versionId"):
            raise RuntimeError("The exact final response and one durable version were not saved before the Storage error.")
        storage_error_ui = wait_for(lambda: observer.evaluate("JSON.stringify({error:document.querySelector('.applicationDocumentGenerator .formError[role=alert]')?.innerText||'',retry:!![...document.querySelectorAll('button')].find(button=>button.innerText.trim()==='Retry saving captured response')})"),
                                    "visible Storage failure and safe captured-response retry action", timeout=25, interval=0.2)
        if not storage_error_ui or not storage_error_ui.get("error") or storage_error_ui.get("retry") is not True:
            raise RuntimeError("The UI did not explain the injected Storage failure and offer retry of the captured response.")
        report["workflow"].append({"name": "captured_response_and_version_survive_storage_failure", "result": "PASS",
                                   "controlledBridgeSteps": [{key: value for key, value in step.items() if key != "dispatchId"} for step in bridge_steps],
                                   "exactResponseHashMatched": True, "versionPersistedBeforeStorageRecovery": True,
                                   "storageFailureInjected": True, "visibleErrorAndSafeRetryControl": True, "chatGptMessageReused": True})
        report["screenshots"].append(_screenshot(evidence / "04-storage-error-before-refresh.png", hwnd, chrome.pid, display))

        restored_value = "null" if old_bucket_limit is None else str(int(old_bucket_limit))
        onboarding.psql(LOCAL_DB_CONTAINER, f"update storage.buckets set file_size_limit={restored_value} where id='application-documents';")
        bucket_limit_changed = False
        restored_limit = sql_json(LOCAL_DB_CONTAINER, "select json_build_object('limit',file_size_limit)::text from storage.buckets where id='application-documents';").get("limit")
        if restored_limit != old_bucket_limit:
            raise RuntimeError("The local Storage size limit did not return to its original value.")
        report["cleanup"]["bucketLimitRestored"] = True

        desktop.press_key(0x52, ctrl=True)
        wait_for(lambda: _page_state(observer).get("pathname") == application_path
                  and "Create documents for this job" in _page_state(observer).get("bodyText", ""),
                 "the application workspace after browser refresh", timeout=60)
        def refreshed_recovery_state():
            if provider.state.upload_arrived.is_set():
                return {"providerUploadStarted": True}
            value = observer.evaluate("JSON.stringify({alert:document.querySelector('.applicationDocumentGenerator .formError[role=alert]')?.innerText||'',busy:!!document.querySelector('.documentGenerationProgress'),actions:[...document.querySelectorAll('.applicationDocumentGenerator button')].map(button=>({text:button.innerText.trim(),disabled:button.disabled})).filter(button=>['Retry saving captured response','Resume saved document request'].includes(button.text)),requestStatus:document.querySelector('.applicationDocumentGenerator .formHint[role=status]')?.innerText||''})")
            if value and (value.get("actions") or not value.get("busy")):
                return value
            return None
        refreshed_ui = wait_for(refreshed_recovery_state, "saved-response resume or retry state after refresh", timeout=45, interval=0.25)
        if not refreshed_ui:
            raise RuntimeError("The document request stayed busy after refresh without starting a Drive retry.")
        report["refreshUiDiagnostic"] = {**refreshed_ui, "page": observer.evaluate("JSON.stringify({pathname:location.pathname,documentSection:document.querySelector('.applicationDocumentGenerator')?.innerText.slice(0,700)||null})")}
        report["screenshots"].append(_screenshot(evidence / "04-storage-retry-after-refresh.png", hwnd, chrome.pid, display))
        recovery_action = (refreshed_ui.get("actions") or [None])[0]
        if not refreshed_ui.get("providerUploadStarted") and not recovery_action:
            raise RuntimeError("Refreshing did not expose a saved-response resume or retry action: " + json.dumps(refreshed_ui, sort_keys=True))
        if recovery_action and not provider.state.upload_arrived.is_set():
            if recovery_action.get("disabled"):
                raise RuntimeError("The saved-response resume/retry remained disabled after refresh: " + json.dumps(refreshed_ui, sort_keys=True))
            resume_selector = ".applicationDocumentGenerator button[data-m07-saved-response-action='true']"
            observer.evaluate("(() => { const b=[...document.querySelectorAll('.applicationDocumentGenerator button')].find(button=>button.innerText.trim()===" + json.dumps(recovery_action["text"]) + "); if(b) b.dataset.m07SavedResponseAction='true'; })()")
            try:
                native_scroll_to(observer, hwnd, chrome.pid, resume_selector)
                latest_resume = observer.evaluate("JSON.stringify({busy:!!document.querySelector('.documentGenerationProgress'),actions:[...document.querySelectorAll('.applicationDocumentGenerator button')].map(button=>({text:button.innerText.trim(),disabled:button.disabled})).filter(button=>['Retry saving captured response','Resume saved document request'].includes(button.text))})")
                if not provider.state.upload_arrived.is_set() and not latest_resume.get("busy"):
                    if not latest_resume.get("actions") or latest_resume["actions"][0].get("disabled"):
                        raise RuntimeError("The saved-response recovery control disappeared without starting automatic resume: " + json.dumps(latest_resume, sort_keys=True))
                    retry_saved_response_click = m06.click_native(observer, hwnd, chrome.pid, resume_selector, chrome_pids)
                    report["workflow"].append({"name": "native_saved_response_resume_after_refresh", "result": "PASS",
                                               "action": recovery_action["text"], "nativeClick": retry_saved_response_click,
                                               "sameResponseAndVersionExpected": True})
                else:
                    report["workflow"].append({"name": "automatic_saved_response_resume_after_refresh", "result": "PASS",
                                               "sameResponseAndVersionExpected": True})
            except (TimeoutError, RuntimeError):
                latest_resume = observer.evaluate("JSON.stringify({busy:!!document.querySelector('.documentGenerationProgress'),actions:[...document.querySelectorAll('.applicationDocumentGenerator button')].map(button=>({text:button.innerText.trim(),disabled:button.disabled})).filter(button=>['Retry saving captured response','Resume saved document request'].includes(button.text))})")
                if not provider.state.upload_arrived.is_set() and not latest_resume.get("busy"):
                    raise
                report["workflow"].append({"name": "automatic_saved_response_resume_after_refresh", "result": "PASS",
                                           "sameResponseAndVersionExpected": True})
        refreshed_item = _database_item_state(LOCAL_DB_CONTAINER, item_id)
        if refreshed_item.get("responseHash") != checkpoint.get("responseHash") or refreshed_item.get("versionId") != checkpoint.get("versionId"):
            raise RuntimeError("Refreshing changed the already captured response or saved version.")
        report["workflow"].append({"name": "refresh_preserves_captured_response_and_version", "result": "PASS",
                                   "sameResponseHash": True, "sameVersionId": True,
                                   "explicitResumeOrRetryAvailable": bool(refreshed_ui.get("actions")),
                                   "automaticResumeStartedDrivePublish": bool(refreshed_ui.get("providerUploadStarted"))})
        try:
            drive_retry_event = wait_for(lambda: provider.state.upload_arrived.is_set(), "automatic Drive publication after refresh retry", timeout=20, interval=0.25)
            report["workflow"].append({"name": "automatic_drive_publish_after_saved_storage_recovery", "result": "PASS"})
        except TimeoutError:
            current_request = latest_request(LOCAL_DB_CONTAINER, account["userId"], application_id)
            recovery_db = sql_json(LOCAL_DB_CONTAINER, f"""
              select json_build_object('requestState',r.state,'currentChunk',r.current_chunk,'currentKind',r.current_kind,
                'dispatchIdPresent',r.dispatch_id is not null,'itemState',i.state,'versionIdPresent',i.document_version_id is not null,
                'responseHashPresent',i.response_hash is not null,'driveState',i.drive_state,
                'folderIdPresent',i.drive_folder_id is not null,'pdfIdPresent',i.drive_pdf_id is not null,'docxIdPresent',i.drive_docx_id is not null,
                'bridgeDispatchState',(select d.state from public.chatgpt_dispatch_requests d where d.id=r.dispatch_id),
                'bridgeHasResponse',(select d.bridge_response is not null from public.chatgpt_dispatch_requests d where d.id=r.dispatch_id),
                'bridgeResponseProvenance',(select d.output_refs->>'response_provenance_recorded' from public.chatgpt_dispatch_requests d where d.id=r.dispatch_id))::text
              from public.document_generation_requests r join public.document_generation_items i on i.request_id=r.id
              where r.id='{request_id}'::uuid and i.id='{item_id}'::uuid;
            """)
            recovery_ui = observer.evaluate("""JSON.stringify({
              alert:document.querySelector('.applicationDocumentGenerator .formError[role=alert]')?.innerText||'',
              progress:document.querySelector('.applicationDocumentGenerator .documentGenerationProgress')?.innerText||'',
              actions:[...document.querySelectorAll('.applicationDocumentGenerator button')].map(button=>({text:button.innerText.trim(),disabled:button.disabled})).filter(button=>['Retry saving captured response','Resume saved document request','Save to Drive'].includes(button.text)),
              recentDocumentRequests:performance.getEntriesByType('resource').map(entry=>new URL(entry.name,location.href).pathname).filter(path=>path.includes('/api/document-generations/')||path.includes('/api/application-documents/')).slice(-20)
            })""")
            diagnostic = {"request": recovery_db, "ui": recovery_ui, "driveFixture": provider.state.snapshot(),
                          "requestStateReadback": {key: current_request.get(key) for key in ("state", "currentChunk", "dispatchId") if key in current_request}}
            report["automaticDrivePublishDiagnostic"] = diagnostic
            if recovery_db.get("itemState") != "ready" or recovery_db.get("driveState") not in ("pending", "failed"):
                raise TimeoutError("Saved-response recovery did not produce a retryable Drive state: " + json.dumps(diagnostic, sort_keys=True)) from None
            drive_action = observer.evaluate("JSON.stringify({button:[...document.querySelectorAll('.applicationDocumentGenerator button')].find(button=>button.innerText.trim()==='Save to Drive')?.innerText.trim()||null,disabled:[...document.querySelectorAll('.applicationDocumentGenerator button')].find(button=>button.innerText.trim()==='Save to Drive')?.disabled??null})")
            if not drive_action or drive_action.get("button") != "Save to Drive" or drive_action.get("disabled"):
                raise RuntimeError("The saved, downloadable document did not expose an enabled Drive retry: " + json.dumps({"diagnostic": diagnostic, "action": drive_action}, sort_keys=True))
            selector = ".applicationDocumentGenerator button[data-m07-drive-action='true']"
            observer.evaluate("(() => { const b=[...document.querySelectorAll('.applicationDocumentGenerator button')].find(button=>button.innerText.trim()==='Save to Drive'); if(b) b.dataset.m07DriveAction='true'; })()")
            native_scroll_to(observer, hwnd, chrome.pid, selector)
            native_drive_click = m06.click_native(observer, hwnd, chrome.pid, selector, chrome_pids)
            report["workflow"].append({"name": "native_drive_retry_after_saved_storage_recovery", "result": "PASS",
                                       "action": "Save to Drive", "nativeClick": native_drive_click,
                                       "downloadableVersionPreserved": True})
            try:
                drive_retry_event = wait_for(lambda: provider.state.upload_arrived.is_set(), "native Drive retry reaching loopback provider", timeout=35, interval=0.25)
            except TimeoutError:
                current_state = _database_item_state(LOCAL_DB_CONTAINER, item_id)
                latest_ui = observer.evaluate("""JSON.stringify({alert:document.querySelector('.applicationDocumentGenerator .formError[role=alert]')?.innerText||'',
                  driveText:[...document.querySelectorAll('.applicationDocumentGenerator .documentDriveStatus')].map(node=>node.innerText.trim()),
                  actions:[...document.querySelectorAll('.applicationDocumentGenerator button')].map(button=>({text:(button.innerText||'').trim(),disabled:button.disabled})).filter(button=>String(button.innerText||'').includes('Drive'))})""")
                report["driveRetryDiagnostic"] = {"item": current_state, "ui": latest_ui, "provider": provider.state.snapshot()}
                raise TimeoutError("Native Drive retry did not reach the loopback provider: " + json.dumps(report["driveRetryDiagnostic"], sort_keys=True)) from None
        # An independent, authenticated call overlaps the first publish while
        # its loopback upload is deliberately blocked. It must receive the
        # per-application lease conflict without creating a second folder.
        overlap = observer.evaluate("(async()=>{const r=await fetch('/api/application-documents/" + item_id + "/drive',{method:'POST',credentials:'same-origin',cache:'no-store'});let d={};try{d=await r.json()}catch{};return JSON.stringify({status:r.status,ok:d.ok===true,state:d.state||null,errorCode:d.errorCode||null})})()")
        if not overlap or overlap.get("status") != 503 or overlap.get("ok") or overlap.get("state") != "retrying" or overlap.get("errorCode") != "google_drive_publish_in_progress":
            raise RuntimeError("An overlapping Drive publication was not rejected by the active application lease.")
        pre_release_provider = provider.state.snapshot()
        if pre_release_provider.get("folderCount") != 1:
            raise RuntimeError("Overlapping publication created a duplicate private Drive folder.")
        provider.state.release_first_upload.set()

        retry_ready = wait_for(lambda: _database_item_state(LOCAL_DB_CONTAINER, item_id), "ready document after refresh-based recovery", timeout=90)
        if retry_ready.get("state") != "ready" or retry_ready.get("driveState") != "failed" or not retry_ready.get("folderId") or not retry_ready.get("pdfId") or retry_ready.get("docxId"):
            raise RuntimeError("The Storage retry did not preserve its version and persist the successful partial PDF upload.")
        if retry_ready.get("responseHash") != checkpoint.get("responseHash") or retry_ready.get("versionId") != checkpoint.get("versionId"):
            raise RuntimeError("Refresh/retry changed the saved Bridge response or document version identity.")
        request_after_refresh = latest_request(LOCAL_DB_CONTAINER, account["userId"], application_id)
        if request_after_refresh.get("state") != "ready" or request_after_refresh.get("templateId") != TARGET_THEME:
            raise RuntimeError("The request did not become ready with its original theme after refresh.")
        dispatch_count = sql_json(LOCAL_DB_CONTAINER, f"""
          select json_build_object('count',count(*),'distinctKeys',count(distinct idempotency_key),
            'completed',count(*) filter(where state='completed'))::text
          from public.chatgpt_dispatch_requests where user_id='{account['userId']}'::uuid and idempotency_key like '{request_prefix}%';
        """)
        if dispatch_count.get("count") != len(bridge_steps) or dispatch_count.get("distinctKeys") != len(bridge_steps) \
                or dispatch_count.get("completed") != len(bridge_steps):
            raise RuntimeError("Refresh recovery created or resent a document Bridge dispatch.")
        report["workflow"].append({"name": "refresh_reuses_exact_response_and_version_with_partial_drive_upload", "result": "PASS",
                                   "sameResponseHash": True, "sameVersionId": True, "dispatchCountStable": dispatch_count.get("count"),
                                   "overlappingPublishRejected": overlap, "partialPdfIdPersisted": True,
                                   "downloadsRemainAvailable": True, "driveStateAfterInjectedFailure": "failed"})

        refreshed_page = wait_for(lambda: _page_state(observer).get("pathname") == application_path and
                                  "Save to Drive" in _page_state(observer).get("bodyText", "") and
                                  "failed" in _page_state(observer).get("bodyText", "").lower(),
                                  "visible generated letter and Drive retry control", timeout=50)
        failed_drive_assets = observer.evaluate("(async()=>{const id=" + json.dumps(item_id) + ";const result={};for(const format of ['pdf','docx']){const r=await fetch('/api/application-documents/'+id+'/download?format='+format,{cache:'no-store'});const b=await r.arrayBuffer();const h=[...new Uint8Array(await crypto.subtle.digest('SHA-256',b))].map(x=>x.toString(16).padStart(2,'0')).join('');result[format]={status:r.status,bytes:b.byteLength,sha256:h}}return JSON.stringify(result)})()")
        if not failed_drive_assets or failed_drive_assets.get("pdf", {}).get("status") != 200 or failed_drive_assets.get("docx", {}).get("status") != 200 \
                or failed_drive_assets["pdf"].get("sha256") != retry_ready.get("pdfHash") or failed_drive_assets["docx"].get("sha256") != retry_ready.get("docxHash"):
            raise RuntimeError("Drive failure removed or changed the saved private PDF/DOCX downloads.")
        partial_provider = provider.state.snapshot()
        if partial_provider.get("folderCount") != 1 or partial_provider.get("documentFileCount") != 1 \
                or [item.get("format") for item in partial_provider.get("documentFiles", [])] != ["pdf"] \
                or partial_provider.get("documentFiles", [{}])[0].get("id") != retry_ready.get("pdfId"):
            raise RuntimeError("The first Drive failure did not leave exactly the saved PDF identity as a partial upload.")
        report["workflow"][-1]["downloadsRemainAvailableAfterDriveFailure"] = True
        report["workflow"][-1]["partialRemoteState"] = "one PDF, one private folder, no DOCX until retry"
        native_scroll_to(observer, hwnd, chrome.pid, ".generatedDocumentCard .documentDriveStatus button.textLink")
        report["screenshots"].append(_screenshot(evidence / "05-refreshed-document-drive-retry.png", hwnd, chrome.pid, display))

        # The visible retry action uses the same authenticated application API.
        retry_button = ".generatedDocumentCard .documentDriveStatus button.textLink"
        retry_click = m06.click_native(observer, hwnd, chrome.pid, retry_button, chrome_pids)
        wait_for(lambda: _database_item_state(LOCAL_DB_CONTAINER, item_id).get("driveState") == "ready",
                 "user-triggered Drive retry", timeout=90)
        ready = document_state(LOCAL_DB_CONTAINER, item_id)
        remote = provider.state.snapshot()
        if not ready.get("folderId") or not ready.get("pdfId") or not ready.get("docxId") \
                or ready.get("folderId") != retry_ready.get("folderId") or ready.get("pdfId") != retry_ready.get("pdfId") \
                or not ready.get("docxId") or remote.get("folderCount") != 1 or remote.get("documentFileCount") != 2:
            raise RuntimeError("Drive retry did not reuse the original folder/PDF identities and finish one DOCX file.")
        if len({file.get("id") for file in remote.get("documentFiles", [])}) != 2 or {file.get("format") for file in remote.get("documentFiles", [])} != {"pdf", "docx"}:
            raise RuntimeError("Loopback Drive did not read back exactly one PDF and one DOCX for the saved item.")
        report["workflow"].append({"name": "native_drive_retry_preserves_folder_and_file_ids", "result": "PASS",
                                   "nativeRetryClick": retry_click, "driveState": "ready", "sameFolderAndPdfId": True,
                                   "onePrivateFolder": remote.get("folderCount") == 1, "uniquePdfAndDocx": remote.get("documentFileCount") == 2,
                                   "failedFirstDocxUploadRecovered": remote.get("failureInjected") is True})
        report["screenshots"].append(_screenshot(evidence / "06-drive-retry-complete.png", hwnd, chrome.pid, display))

        final = document_state(LOCAL_DB_CONTAINER, item_id)
        version_content = final.get("versionStructured") if isinstance(final.get("versionStructured"), dict) else {}
        if final.get("state") != "ready" or final.get("driveState") != "ready" or final.get("templateId") != TARGET_THEME \
                or final.get("versionModel") != "chatgpt-memory-v4" or version_content.get("document_template_id") != TARGET_THEME \
                or version_content.get("engine_version") != "chatgpt-memory-v4" or version_content.get("source_mode") != "chatgpt_memory" \
                or version_content.get("memory_review_required") is not True or version_content.get("plaintext") != final.get("plaintext"):
            raise RuntimeError("Saved request/item/version identity, Memory warning or plaintext did not agree after recovery.")
        raw_bridge_text = final.get("responseText") or ""
        contacts = (request_after_refresh.get("inputSnapshot") or {}).get("trusted_contact") or {}
        if version_content.get("candidate_name") != "Taylor Example" \
                or version_content.get("candidate_email") != contacts.get("email") \
                or version_content.get("candidate_phone") != contacts.get("phone"):
            raise RuntimeError("Verified contact details were not applied locally to the saved, rendered version.")
        context_text = json.dumps(request_after_refresh.get("contextChunks"), ensure_ascii=False)
        if (request_after_refresh.get("inputSnapshot") or {}).get("memory_only") is not True \
                or "profile" in (request_after_refresh.get("inputSnapshot") or {}) \
                or any(value and value in context_text for value in contacts.values()) \
                or any(value and value in raw_bridge_text for value in contacts.values()):
            raise RuntimeError("Memory-only candidate context or local verified contact boundary was violated.")
        if any(dispatch.get("workflowKey") != WORKFLOW_KEY or not dispatch.get("conversationBound") or not dispatch.get("provenanceRecorded") for dispatch in bridge_steps):
            raise RuntimeError("At least one saved document response lacks exact workflow conversation/provenance correlation.")
        report["workflow"].append({"name": "saved_request_version_preview_and_copy_contract", "result": "PASS",
                                   "frozenTheme": TARGET_THEME, "versionModel": "chatgpt-memory-v4", "memoryOnlyCandidateContext": True,
                                   "verifiedContactInsertedLocally": True, "factualReviewRequired": True,
                                   "responseCorrelation": "exact dispatch id, action, idempotency key, application subject and assistant-turn provenance"})

        desktop.press_key(0x52, ctrl=True)
        wait_for(lambda: _page_state(observer).get("pathname") == application_path and "Needs your review" in _page_state(observer).get("bodyText", "")
                 and "Open PDF" in _page_state(observer).get("bodyText", ""), "reloaded completed preview", timeout=60)
        ready_again = _database_item_state(LOCAL_DB_CONTAINER, item_id)
        if ready_again.get("responseHash") != final.get("responseHash") or ready_again.get("versionId") != final.get("versionId"):
            raise RuntimeError("Final refresh changed the saved response or version identity.")
        preview = observer.evaluate("JSON.stringify({iframe:!!document.querySelector('.generatedDocumentPreview'),src:document.querySelector('.generatedDocumentPreview')?.getAttribute('src')||null,reviewNotice:document.body.innerText.includes('Candidate claims were drafted from ChatGPT Memory')})")
        if not preview or not preview.get("iframe") or not preview.get("src") or not preview.get("reviewNotice"):
            raise RuntimeError("The refreshed page did not show its saved PDF preview and Memory factual-review notice.")
        native_scroll_to(observer, hwnd, chrome.pid, ".generatedDocumentPreview")
        report["screenshots"].append(_screenshot(evidence / "07-saved-preview-after-final-refresh.png", hwnd, chrome.pid, display))

        browser_downloads = observer.command("Page.setDownloadBehavior", {"behavior": "allow", "downloadPath": str(download_root)})
        native_scroll_to(observer, hwnd, chrome.pid, ".generatedDocumentCard a.secondaryButton[href*='format=docx']")
        download_click = m06.click_native(observer, hwnd, chrome.pid, ".generatedDocumentCard a.secondaryButton[href*='format=docx']", chrome_pids)
        downloaded_docx = wait_for(lambda: next((path for path in download_root.glob("*") if path.is_file() and not path.name.endswith(".crdownload")), None),
                                   "native Word download", timeout=45, interval=0.25)
        if downloaded_docx.stat().st_size < 100 or downloaded_docx.read_bytes()[:2] != b"PK":
            raise RuntimeError("The native Word download was not a valid DOCX archive.")
        browser_assets = observer.evaluate("(async()=>{const id=" + json.dumps(item_id) + ";const result={};for(const format of ['pdf','docx']){const r=await fetch('/api/application-documents/'+id+'/download?format='+format,{cache:'no-store'});const b=await r.arrayBuffer();const h=[...new Uint8Array(await crypto.subtle.digest('SHA-256',b))].map(x=>x.toString(16).padStart(2,'0')).join('');result[format]={status:r.status,bytes:b.byteLength,sha256:h}}return JSON.stringify(result)})()")
        if not browser_assets or browser_assets.get("pdf", {}).get("status") != 200 or browser_assets.get("docx", {}).get("status") != 200 \
                or browser_assets["pdf"].get("sha256") != final.get("pdfHash") or browser_assets["docx"].get("sha256") != final.get("docxHash") \
                or sha256_file(downloaded_docx) != final.get("docxHash"):
            raise RuntimeError("The preview/download endpoints did not return the exact saved PDF/DOCX assets.")

        summary_selector = ".generatedDocumentCard details.coverLetterPlaintext > summary"
        native_scroll_to(observer, hwnd, chrome.pid, summary_selector)
        expand_click = m06.click_native(observer, hwnd, chrome.pid, summary_selector, chrome_pids)
        wait_for(lambda: observer.evaluate("document.querySelector('.coverLetterPlaintext')?.open===true"), "expanded saved plain-text letter")
        saved_text_browser = observer.evaluate("JSON.stringify(document.querySelector('.coverLetterPlaintext textarea')?.value||'')")
        if saved_text_browser != final.get("versionStructured", {}).get("plaintext"):
            raise RuntimeError("The visible Copy text source differed from the saved letter version.")
        copy_click = m06.click_native(observer, hwnd, chrome.pid, ".generatedDocumentCard .coverLetterPlaintext button.textLink", chrome_pids)
        wait_for(lambda: "Cover letter copied to the clipboard." in _page_state(observer).get("bodyText", ""), "visible copy acknowledgment", timeout=10)
        clipboard_text = copy_clipboard_text()
        expected_clipboard_text = final.get("versionStructured", {}).get("plaintext") or ""
        normalize_clipboard_text = lambda value: value.replace("\r\n", "\n").replace("\r", "\n").rstrip("\x00")
        normalized_clipboard = normalize_clipboard_text(clipboard_text)
        normalized_expected = normalize_clipboard_text(expected_clipboard_text)
        if normalized_clipboard != normalized_expected:
            first_difference = next((index for index, pair in enumerate(zip(normalized_clipboard, normalized_expected))
                                     if pair[0] != pair[1]), min(len(normalized_clipboard), len(normalized_expected)))
            mismatch = {"clipboardLength": len(normalized_clipboard), "savedVersionLength": len(normalized_expected),
                        "clipboardSha256": hashlib.sha256(normalized_clipboard.encode("utf-8")).hexdigest(),
                        "savedVersionSha256": hashlib.sha256(normalized_expected.encode("utf-8")).hexdigest(),
                        "firstDifferenceIndex": first_difference,
                        "clipboardCharacterCode": ord(normalized_clipboard[first_difference]) if first_difference < len(normalized_clipboard) else None,
                        "savedVersionCharacterCode": ord(normalized_expected[first_difference]) if first_difference < len(normalized_expected) else None}
            raise RuntimeError("The native Copy text action did not copy the saved cover-letter version: "
                               + json.dumps(mismatch, sort_keys=True))
        report["workflow"].append({"name": "native_preview_download_and_saved_copy_text", "result": "PASS",
                                   "pdfPreviewVisible": True, "nativeDocxDownload": True, "docxSha256MatchesSavedVersion": True,
                                   "visibleTextMatchesVersion": True, "nativeCopyClipboardMatchesVersion": True,
                                   "copiedCharacterCount": len(clipboard_text), "nativeExpandClick": expand_click,
                                   "nativeCopyClick": copy_click, "nativeDownloadClick": download_click,
                                   "downloadBehavior": bool(browser_downloads)})
        report["screenshots"].append(_screenshot(evidence / "08-saved-letter-and-copy-readback.png", hwnd, chrome.pid, display))

        # The paired, authenticated fixture is retained as the next milestone's
        # review input. These API-driven cases exercise both kinds and their
        # independent frozen theme/version identities without using ChatGPT.
        cv_only_request_key = str(uuid.uuid4())
        paired_request_key = str(uuid.uuid4())
        cv_only_result = complete_authenticated_generation(
            observer, supabase["url"], device_id, device_token, bridge_version, capabilities,
            conversation_url, account["userId"], application_id, ["cv"], cv_only_request_key)
        report["workflow"].append({"name": "authenticated_cv_only_generation", "result": "PASS", **cv_only_result})
        paired_result = complete_authenticated_generation(
            observer, supabase["url"], device_id, device_token, bridge_version, capabilities,
            conversation_url, account["userId"], application_id, ["cv", "cover_letter"], paired_request_key)
        report["workflow"].append({"name": "authenticated_paired_cv_and_letter_generation", "result": "PASS", **paired_result})
        generated_items = [item_id]
        for request_key in (cv_only_request_key, paired_request_key):
            request_id_for_result = sql_json(LOCAL_DB_CONTAINER, f"""
              select json_build_object('id',(select id from public.document_generation_requests
                where user_id='{account['userId']}'::uuid and request_key='{request_key}' order by created_at desc limit 1))::text;
            """).get("id")
            if not isinstance(request_id_for_result, str):
                raise RuntimeError("Could not resolve a synthetic generation request for its Drive identity assertions.")
            generated_items.extend(item["id"] for item in generation_items(LOCAL_DB_CONTAINER, request_id_for_result, account["userId"]))
        drive_snapshot = provider.state.snapshot()
        expected_formats = {(identifier, file_format) for identifier in generated_items for file_format in ("pdf", "docx")}
        observed_formats = [(item.get("itemId"), item.get("format")) for item in drive_snapshot.get("documentFiles", [])]
        if drive_snapshot.get("folderCount") != 1 or set(observed_formats) != expected_formats or len(observed_formats) != len(expected_formats):
            raise RuntimeError("Overlapping and repeated loopback Drive publishes did not preserve one folder and one file per generated version/format: "
                               + json.dumps({"folderCount": drive_snapshot.get("folderCount"), "expectedItemFormats": len(expected_formats),
                                             "observedItemFormats": len(observed_formats)}, sort_keys=True))
        report["workflow"].append({"name": "drive_identity_deduplicated_across_versions_and_formats", "result": "PASS",
                                   "oneApplicationFolder": True, "versionCount": len(generated_items),
                                   "onePdfAndDocxPerVersion": True, "overlappingPublishLeasePreviouslyExercised": True})

        final_counts = database_snapshot(LOCAL_DB_CONTAINER, account["userId"], fixture["jobId"], application_id)
        if final_counts.get("applications") != 1 or final_counts.get("requests") != 3 or final_counts.get("items") != 4 \
                or final_counts.get("versions") != 4 or final_counts.get("formSessions") != 0 or final_counts.get("driveFolderRows") != 1:
            raise RuntimeError("Final local database counts did not show one chosen application, three requests, four independent versions and no form session.")
        report["databaseAssertions"] = {"applicationCount": 1, "documentRequestCount": 3, "documentItemCount": 4,
            "documentVersionCount": 4, "formSessionCount": 0, "driveFolderMappingCount": 1,
            "applyAuditCount": final_counts.get("applyAudit"), "sameResponseAndVersionAcrossRefresh": True,
            "snapshotContainedOnlyMemoryCandidateContext": True, "localContactsAbsentFromBridgeText": True}
        report["loopbackDriveReadback"] = provider.state.snapshot()
        report["result"] = "PASS"
    except Exception as exc:
        report["result"] = "FAIL"
        report["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        if bucket_limit_changed:
            try:
                value = "null" if old_bucket_limit is None else str(int(old_bucket_limit))
                onboarding.psql(LOCAL_DB_CONTAINER, f"update storage.buckets set file_size_limit={value} where id='application-documents';")
                restored = sql_json(LOCAL_DB_CONTAINER, "select json_build_object('limit',file_size_limit)::text from storage.buckets where id='application-documents';")
                report["cleanup"]["bucketLimitRestored"] = restored.get("limit") == old_bucket_limit
            except Exception:
                report["cleanup"]["bucketLimitRestored"] = False
        if provider:
            provider.state.release_first_upload.set()
            try:
                provider.shutdown()
                provider.server_close()
                if provider_thread:
                    provider_thread.join(timeout=5)
                report["cleanup"]["providerStopped"] = not (provider_thread and provider_thread.is_alive())
            except Exception:
                report["cleanup"]["providerStopped"] = False
        if observer:
            try:
                observer.close()
            except Exception:
                pass
        if chrome and hwnd:
            try:
                desktop.user32.PostMessageW(hwnd, desktop.WM_CLOSE, 0, 0)
                time.sleep(0.25)
            except Exception:
                pass
        chrome_remaining = m03.stop_chrome(chrome, chrome_pids, None) if chrome else []
        server_remaining = desktop.stop_owned_process(app_server, server_pids, graceful=True) if app_server else []
        if server_log:
            server_log.flush()
            server_log.close()
        server_log_path = run_root / "next-server.log"
        if report["result"] != "PASS" and server_log_path.exists():
            safe_log = m06.safe_startup_log(server_log_path, [supabase.get("publishable", ""), supabase.get("service", "")] if supabase else [])
            (evidence / "startup-log-redacted.txt").write_text(safe_log, encoding="utf-8")
            report["startupDiagnosticLog"] = str(evidence / "startup-log-redacted.txt")
        report["cleanup"]["chromeExited"] = bool(chrome is None or (chrome.poll() is not None and not chrome_remaining))
        report["cleanup"]["serverExited"] = bool(app_server is None or (app_server.poll() is not None and not server_remaining))
        report["cleanup"]["chromeRemainingPids"] = chrome_remaining
        report["cleanup"]["serverRemainingPids"] = server_remaining
        if account:
            try:
                cleanup = {}
                onboarding.cleanup_accounts(supabase["url"], supabase["service"], LOCAL_DB_CONTAINER, [account], cleanup)
                report["cleanup"]["syntheticAccountDeleted"] = bool(cleanup.get("syntheticDataCleanup", {}).get("complete"))
                remaining = sql_json(LOCAL_DB_CONTAINER, f"""
                  select json_build_object('applications',(select count(*) from public.applications where user_id='{account['userId']}'::uuid),
                    'requests',(select count(*) from public.document_generation_requests where user_id='{account['userId']}'::uuid),
                    'devices',(select count(*) from public.chatgpt_bridge_devices where user_id='{account['userId']}'::uuid))::text;
                """)
                report["cleanup"]["syntheticRowsRemoved"] = all(value == 0 for value in remaining.values())
                report["cleanup"]["postCleanupCounts"] = remaining
            except Exception:
                report["cleanup"]["syntheticAccountDeleted"] = False
                report["cleanup"]["syntheticRowsRemoved"] = False
        if report["cleanup"]["chromeExited"] and report["cleanup"]["serverExited"]:
            try:
                resolved = run_root.resolve(strict=True)
                if resolved.parent != temp_root or not resolved.name.startswith("JobHuntAI-M07-Desktop-"):
                    raise RuntimeError("Unexpected temporary workspace path")
                shutil.rmtree(resolved)
                report["cleanup"]["temporaryProfileRemoved"] = not resolved.exists()
            except Exception:
                report["cleanup"]["temporaryProfileRemoved"] = False
        for key, value in previous_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        report["finishedAtUtc"] = utc_now()
        (evidence / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"result": report["result"], "report": str(evidence / "report.json"),
                      "screenshots": [item.get("path") for item in report["screenshots"]],
                      "workflow": [item.get("name") + ":" + item.get("result") for item in report["workflow"]],
                      "cleanup": report["cleanup"]}, indent=2))
    return 0 if report["result"] == "PASS" and all(report["cleanup"].get(key) is True for key in
        ("chromeExited", "serverExited", "providerStopped", "bucketLimitRestored", "syntheticAccountDeleted", "syntheticRowsRemoved", "temporaryProfileRemoved")) else 1


def _http_status(url: str) -> int | None:
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except Exception:
        return None


def _page_state(observer: desktop.CDPObserver) -> dict:
    return observer.evaluate("JSON.stringify({pathname:location.pathname,bodyText:document.body?.innerText||'',emailField:!!document.querySelector('input[name=email]'),passwordField:!!document.querySelector('input[name=password]')})")


def _screenshot(path: Path, hwnd: int, pid: int, display: tuple[int, int]) -> dict:
    result = desktop.desktop_screenshot(path, hwnd, pid, display, redact_taskbar=True)
    return {"path": str(path), "width": result.get("width"), "height": result.get("height"),
            "fullDesktop": True, "redactions": result.get("redactions", [])}


def _database_item_state(container: str, item_id: str) -> dict:
    return sql_json(container, f"""
      select json_build_object('state',state,'responseHash',response_hash,'versionId',document_version_id,
        'driveState',drive_state,'folderId',drive_folder_id,'pdfId',drive_pdf_id,'docxId',drive_docx_id,
        'pdfHash',pdf_sha256,'docxHash',docx_sha256,
        'requestId',request_id)::text from public.document_generation_items where id='{item_id}'::uuid;
    """)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-dir", default="")
    args = parser.parse_args()
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
