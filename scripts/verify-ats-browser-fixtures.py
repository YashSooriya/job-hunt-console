#!/usr/bin/env python3
import json, os, subprocess, tempfile, pathlib, re
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
CORPUS = json.loads((ROOT/'data/acceptance/live-source-fixtures.json').read_text())
BASE_CONTEXT = json.loads((ROOT/'data/acceptance/context.json').read_text())

SENSITIVE = re.compile(r"gender|sex|sexual orientation|ethnicity|race|religion|belief|disability|disabled|veteran|criminal|conviction|political|trade union|date of birth|birth date|national insurance|passport|social security|security clearance|clearance|right to work|work authorization|work authorisation|visa sponsorship|sponsorship|citizenship|nationality|marital status", re.I)

def observation(page):
    raw = page.evaluate("""() => {
      const visible = el => { const s=getComputedStyle(el), r=el.getBoundingClientRect(); return !el.hidden && s.display!=='none' && s.visibility!=='hidden' && r.width>0 && r.height>0; };
      const txt = n => (n?.textContent || '').replace(/\\s+/g,' ').trim();
      const ownLabel = el => {
        if(el.tagName==='BUTTON' && txt(el)) return txt(el);
        if(el.tagName==='INPUT' && ['submit','button','reset'].includes((el.type||'').toLowerCase()) && el.value) return el.value;
        if (el.id) { const d=document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if(d&&txt(d)) return txt(d); }
        const w=el.closest('label'); if(w&&txt(w)) return txt(w);
        const a=el.getAttribute('aria-label'); if(a) return a;
        return el.getAttribute('placeholder') || el.getAttribute('name') || '';
      };
      const groupLabel = el => { const fs=el.closest('fieldset'); const lg=fs?.querySelector(':scope > legend'); return lg&&txt(lg) ? txt(lg) : ''; };
      const ctype = el => {
        const role=el.getAttribute('role'); if(role==='combobox') return 'combobox'; if(role==='radio') return 'radio'; if(role==='checkbox') return 'checkbox';
        if(el.tagName==='TEXTAREA') return 'textarea'; if(el.tagName==='SELECT') return 'select';
        if(el.tagName==='BUTTON' || (el.tagName==='INPUT' && ['submit','button','reset'].includes((el.type||'').toLowerCase()))) return 'button';
        if(el.tagName==='INPUT'){const t=(el.type||'text').toLowerCase(); if(t==='file') return 'file'; if(t==='checkbox') return 'checkbox'; if(t==='radio') return 'radio'; if(t==='number') return 'number'; return 'text';}
        return 'other';
      };
      const els=[...document.querySelectorAll('input,textarea,select,button,[role="combobox"],[role="checkbox"],[role="radio"]')].filter(visible).filter(el=>(el.type||'').toLowerCase()!=='hidden');
      const controls=els.map((el,i)=>{const type=ctype(el), own=ownLabel(el), label=type==='radio'?(groupLabel(el)||own):own;
        let val=null,has=false; if(type==='checkbox'||type==='radio'){val=Boolean(el.checked);has=Boolean(el.checked);} else if(type==='select'){val=el.value||null;has=Boolean(el.value);} else if(type==='file'){val=el.files?.length?`${el.files.length} file(s)`:null;has=Boolean(el.files?.length);} else {val=el.value||null;has=Boolean(String(val||'').trim());}
        return {fieldKey:`f${i+1}`,label,name:el.getAttribute('name'),id:el.id||null,role:el.getAttribute('role'),controlType:type,required:Boolean(el.required||/\\*/.test(label)),disabled:Boolean(el.disabled),visible:true,currentValue:val,hasValue:has,options:type==='select'?[...el.options].map(o=>({label:txt(o),value:o.value})):[],locator:{id:el.id||null,name:el.getAttribute('name'),tag:el.tagName.toLowerCase(),type:el.getAttribute('type'),value:el.getAttribute('value'),index:i},autocomplete:el.getAttribute('autocomplete'),placeholder:el.getAttribute('placeholder'),optionLabel:type==='radio'?own:null,optionValue:type==='radio'?(el.getAttribute('value')||own):null};
      });
      return {title:document.title||document.querySelector('h1')?.textContent||'',bodyText:txt(document.body).slice(0,16000),controls};
    }""")
    for c in raw['controls']:
        c['sensitive'] = bool(SENSITIVE.search(f"{c.get('label','')} {c.get('name','')}"))
        if c['sensitive'] and c.get('hasValue'): c['currentValue'] = None
    text=f"{raw['title']} {raw['bodyText']}"
    flags={
        'captcha': bool(re.search(r'captcha|recaptcha|hcaptcha|i am not a robot',text,re.I)),
        'mfa': bool(re.search(r'verification code|one.?time code|two.?factor|multi.?factor|authenticator code',text,re.I)),
        'authentication': bool(re.search(r'sign in|log in|login',text,re.I) and any((c.get('locator') or {}).get('type')=='password' for c in raw['controls']))
    }
    return {'url':page.url,'title':raw['title'],'bodyText':raw['bodyText'],'controls':raw['controls'],'flags':flags}

def plan(obs, context):
    proc=subprocess.run(['node','scripts/plan-observation.mjs'],cwd=ROOT,input=json.dumps({'observation':obs,'context':context}),text=True,capture_output=True,check=True)
    return json.loads(proc.stdout)

def locate(page, ctrl):
    loc=ctrl.get('locator') or {}
    if loc.get('id'): return page.locator('#'+loc['id'])
    if loc.get('name') and ctrl.get('controlType')=='radio' and loc.get('value'): return page.locator(f'[name="{loc["name"]}"][value="{loc["value"]}"]').first
    if loc.get('name'): return page.locator(f'[name="{loc["name"]}"]').first
    if ctrl.get('controlType')=='button' and ctrl.get('label'): return page.get_by_role('button', name=ctrl['label'], exact=True).first
    return page.locator((loc.get('tag') or 'input')+':visible').first

def execute(page, obs, action, cvfile, coverfile):
    ctrl=next(c for c in obs['controls'] if c['fieldKey']==action['target_key'])
    el=locate(page,ctrl); kind=action['action']; value=action.get('value')
    if kind=='fill': el.fill(str(value or ''))
    elif kind=='select':
        if ctrl['controlType']=='select':
            try: el.select_option(label=str(value))
            except: el.select_option(str(value))
        elif ctrl['controlType']=='radio': el.check()
        else: raise RuntimeError(f'unsupported select control {ctrl["controlType"]}')
    elif kind=='toggle':
        if bool(value): el.check()
        else: el.uncheck()
    elif kind=='upload':
        target=coverfile if 'cover' in ctrl['label'].lower() else cvfile
        el.set_input_files(str(target))
    elif kind=='navigate': el.click()
    elif kind=='none': return
    else: raise RuntimeError(f'unsupported action {kind}')

with tempfile.TemporaryDirectory() as td:
    td=pathlib.Path(td); cv=td/'cv.pdf'; cover=td/'cover-letter.pdf'; cv.write_bytes(b'%PDF-1.4\n% test\n'); cover.write_bytes(b'%PDF-1.4\n% test\n')
    context=json.loads(json.dumps(BASE_CONTEXT)); context['documents']['cv']['url']=str(cv); context['documents']['coverLetter']['url']=str(cover)
    results=[]
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
        for case in CORPUS['cases']:
            page=browser.new_page(); page.set_content((ROOT/'data/acceptance'/case['fixture']).read_text(),wait_until='domcontentloaded')
            outcome=None; safe_actions=0
            for step in range(80):
                obs=observation(page); pl=plan(obs,context)
                assert not page.evaluate('window.__submitted === true'), f"{case['id']} submitted before decision"
                if pl['submission_detected']:
                    outcome='final_review'; break
                if pl['must_pause']:
                    outcome='authentication_pause' if pl['page_purpose']=='authentication' else 'needs_user'; break
                action=pl['actions'][0] if pl['actions'] else None
                if not action or action['action']=='none': outcome='needs_user'; break
                execute(page,obs,action,cv,cover); safe_actions+=1
            if outcome is None: outcome='failed'
            submitted=bool(page.evaluate('window.__submitted === true'))
            assert not submitted, f"{case['id']} clicked submit in no-submit acceptance"
            
            if outcome!=case['expectedOutcome']:
                print(json.dumps({'debug_case':case['id'],'outcome':outcome,'expected':case['expectedOutcome'],'lastPlan':pl},indent=2))
            assert outcome==case['expectedOutcome'], f"{case['id']}: expected {case['expectedOutcome']} got {outcome}"
            results.append({'id':case['id'],'providerFamily':case['providerFamily'],'outcome':outcome,'safeActions':safe_actions,'submitClicked':submitted,'evidenceLevel':case['evidenceLevel']})
            page.close()
        browser.close()
    print(json.dumps({'mode':'source_backed_replica_browser','passed':all(not r['submitClicked'] for r in results),'cases':results},indent=2))
