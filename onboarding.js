/* ─────────────────────────────────────────────────────────────────────────
   DalOS Commercial — new-user onboarding (guided tour + Help hub)
   Self-contained vanilla module (mirrors crm.js). No dependencies.
   Wired from the React shell: window.__crmNav {toTab,toLead} drives real
   navigation; window.DalosOnboarding.init({role,isAdmin,perms}) boots it and
   auto-starts once per user (localStorage). Reversible: remove the two
   <script>/init lines in index.html and this file.
   ───────────────────────────────────────────────────────────────────────── */
(function(){
  'use strict';
  var KEY='dalos_commercial_onboarding_v1';   /* bump the suffix to re-trigger the tour after a big release */
  var OPTS={}, STEPS=[], idx=0, built=false;

  /* ---------- styles (Pewter tokens are global on :root in index.html) ---------- */
  function injectCss(){
    if(document.getElementById('dalos-ob-css')) return;
    var st=document.createElement('style'); st.id='dalos-ob-css';
    st.textContent=''
    +'.cm-help{display:flex;align-items:center;gap:9px;width:100%;padding:8px 11px;border-radius:9px;background:transparent;border:1px solid rgba(124,77,255,.4);color:#d9cfff;font:600 13px var(--font-body);cursor:pointer;text-align:left}'
    +'.cm-help:hover{background:rgba(124,77,255,.16)}'
    +'.dob-tour{position:fixed;inset:0;z-index:9500;display:none}'
    +'.dob-tour.on{display:block}'
    +'.dob-dim{position:fixed;inset:0;background:rgba(24,18,34,.60)}'
    +'.dob-spot{position:fixed;border-radius:12px;box-shadow:0 0 0 9999px rgba(24,18,34,.60);border:2px solid #a98bff;pointer-events:none;transition:left .28s cubic-bezier(.4,0,.2,1),top .28s cubic-bezier(.4,0,.2,1),width .28s cubic-bezier(.4,0,.2,1),height .28s cubic-bezier(.4,0,.2,1);display:none}'
    +'.dob-tip{position:fixed;z-index:9502;width:322px;max-width:calc(100vw - 24px);background:var(--card);border:1px solid var(--border);border-radius:14px;box-shadow:0 18px 50px rgba(20,14,30,.42);padding:16px 16px 13px;transition:left .28s cubic-bezier(.4,0,.2,1),top .28s cubic-bezier(.4,0,.2,1)}'
    +'.dob-tip-head{display:flex;align-items:center;gap:8px;margin-bottom:9px}'
    +'.dob-role{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.09em;color:#6a3ded;background:rgba(124,77,255,.14);padding:2px 8px;border-radius:20px}'
    +'.dob-count{margin-left:auto;font-size:10px;font-family:var(--font-mono);color:var(--text3)}'
    +'.dob-title{font-family:var(--font-display);font-size:19px;line-height:1.2;margin-bottom:6px;color:var(--text);text-wrap:balance}'
    +'.dob-body{font-size:13px;color:var(--text2);line-height:1.55}'
    +'.dob-body b{color:var(--text)}'
    +'.dob-note{margin-top:9px;font-size:11.5px;color:#8a5713;background:rgba(183,121,31,.13);border:1px solid rgba(183,121,31,.34);border-radius:8px;padding:7px 9px;display:none}'
    +'.dob-foot{display:flex;align-items:center;gap:8px;margin-top:14px}'
    +'.dob-dots{display:flex;gap:4px;margin-right:auto;flex-wrap:wrap;max-width:150px}'
    +'.dob-dot{width:6px;height:6px;border-radius:50%;background:var(--border2)}'
    +'.dob-dot.on{background:var(--accent);width:16px;border-radius:3px}'
    +'.dob-btn{padding:6px 13px;border-radius:8px;font-size:12.5px;font-weight:600;cursor:pointer;border:1px solid transparent;font-family:var(--font-body)}'
    +'.dob-next{background:var(--accent);color:#fff}'
    +'.dob-next:hover{background:var(--accent2)}'
    +'.dob-back{background:transparent;color:var(--text3);border:1px solid var(--border)}'
    +'.dob-skip{position:fixed;top:16px;right:18px;z-index:9503;background:rgba(255,255,255,.92);border:1px solid var(--border);color:var(--text2);border-radius:8px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font-body)}'
    +'.dob-help{position:fixed;inset:0;z-index:9400;display:none}'
    +'.dob-help.on{display:block}'
    +'.dob-help-bd{position:absolute;inset:0;background:rgba(24,18,34,.35)}'
    +'.dob-help-panel{position:absolute;top:0;right:0;bottom:0;width:400px;max-width:92vw;background:var(--card);box-shadow:-8px 0 40px rgba(20,14,30,.35);display:flex;flex-direction:column;animation:dobslide .26s cubic-bezier(.32,.72,0,1)}'
    +'@keyframes dobslide{from{transform:translateX(100%)}to{transform:translateX(0)}}'
    +'.dob-help-top{padding:16px 18px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px}'
    +'.dob-help-title{font-family:var(--font-display);font-size:19px}'
    +'.dob-help-x{margin-left:auto;cursor:pointer;color:var(--text3);font-size:22px;line-height:1;background:none;border:none}'
    +'.dob-help-replay{margin:12px 18px 4px;display:flex;align-items:center;gap:8px;width:calc(100% - 36px);padding:10px 12px;border-radius:10px;background:rgba(124,77,255,.10);border:1px solid rgba(124,77,255,.3);color:#5a34c9;font:600 13px var(--font-body);cursor:pointer}'
    +'.dob-help-body{flex:1;overflow-y:auto;padding:8px 18px 24px}'
    +'.dob-help-grp{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.09em;color:var(--text3);margin:16px 0 6px}'
    +'.dob-help-item{border:1px solid var(--border);border-radius:9px;background:#fff;margin-bottom:6px;overflow:hidden}'
    +'.dob-help-q{padding:10px 12px;font-size:13px;font-weight:500;cursor:pointer;display:flex;align-items:center;gap:8px;color:var(--text)}'
    +'.dob-help-q .chev{margin-left:auto;color:var(--text3);transition:.15s}'
    +'.dob-help-item.open .chev{transform:rotate(90deg)}'
    +'.dob-help-a{display:none;padding:0 12px 11px;font-size:12.5px;color:var(--text2);line-height:1.55}'
    +'.dob-help-item.open .dob-help-a{display:block}'
    +'@media(prefers-reduced-motion:reduce){.dob-spot,.dob-tip,.dob-help-panel{transition:none;animation:none}}';
    document.head.appendChild(st);
  }

  /* ---------- DOM ---------- */
  function build(){
    if(built) return; injectCss();
    var tour=document.createElement('div'); tour.id='dalosTour'; tour.className='dob-tour';
    tour.innerHTML=''
     +'<button class="dob-skip" type="button">Skip tour ✕</button>'
     +'<div class="dob-dim"></div>'
     +'<div class="dob-spot" id="dobSpot"></div>'
     +'<div class="dob-tip" id="dobTip">'
       +'<div class="dob-tip-head"><span class="dob-role" id="dobRole"></span><span class="dob-count" id="dobCount"></span></div>'
       +'<div class="dob-title" id="dobTitle"></div>'
       +'<div class="dob-body" id="dobBody"></div>'
       +'<div class="dob-note" id="dobNote"></div>'
       +'<div class="dob-foot"><div class="dob-dots" id="dobDots"></div>'
         +'<button class="dob-btn dob-back" id="dobBack" type="button">Back</button>'
         +'<button class="dob-btn dob-next" id="dobNext" type="button">Next</button></div>'
     +'</div>';
    document.body.appendChild(tour);
    var help=document.createElement('div'); help.id='dalosHelp'; help.className='dob-help';
    help.innerHTML=''
     +'<div class="dob-help-bd"></div>'
     +'<div class="dob-help-panel">'
       +'<div class="dob-help-top"><div class="dob-help-title">Help &amp; guides</div><button class="dob-help-x" type="button">×</button></div>'
       +'<button class="dob-help-replay" type="button">↻ Replay the guided tour</button>'
       +'<div class="dob-help-body" id="dobHelpBody"></div>'
     +'</div>';
    document.body.appendChild(help);

    tour.querySelector('.dob-skip').addEventListener('click',finish);
    document.getElementById('dobBack').addEventListener('click',function(){go(-1);});
    document.getElementById('dobNext').addEventListener('click',function(){go(1);});
    help.querySelector('.dob-help-x').addEventListener('click',closeHelp);
    help.querySelector('.dob-help-bd').addEventListener('click',closeHelp);
    help.querySelector('.dob-help-replay').addEventListener('click',function(){ closeHelp(); start(); });
    help.querySelector('.dob-help-body').addEventListener('click',function(e){
      var q=e.target.closest && e.target.closest('.dob-help-q'); if(q&&q.parentNode) q.parentNode.classList.toggle('open');
    });
    document.addEventListener('keydown',function(e){
      if(e.key==='Escape'){ if(document.getElementById('dalosHelp').classList.contains('on')) closeHelp();
        else if(document.getElementById('dalosTour').classList.contains('on')) finish(); }
    });
    window.addEventListener('resize',function(){ if(document.getElementById('dalosTour').classList.contains('on')) position(STEPS[idx]); });
    built=true;
  }

  /* ---------- navigation ---------- */
  function nav(s){
    try{
      if(s.tab){ if(window.__crmNav&&window.__crmNav.toTab) window.__crmNav.toTab(s.tab); else if(window.CRM&&window.CRM.setTab) window.CRM.setTab(s.tab); }
      else if(s.lead){ if(window.__crmNav&&window.__crmNav.toLead) window.__crmNav.toLead(s.lead); else if(window.CRM&&window.CRM.leadNav) window.CRM.leadNav(s.lead.dest,s.lead.key); }
    }catch(e){}
  }

  /* ---------- render + position ---------- */
  function render(){
    var s=STEPS[idx]; if(!s) return;
    if(s.tab||s.lead) nav(s);
    document.getElementById('dobRole').textContent=roleLabel();
    document.getElementById('dobTitle').textContent=s.t;
    document.getElementById('dobBody').innerHTML=s.b;
    document.getElementById('dobCount').textContent=(idx+1)+' / '+STEPS.length;
    var note=document.getElementById('dobNote');
    if(s.note){ note.style.display='block'; note.innerHTML='⚠ '+s.note; } else note.style.display='none';
    document.getElementById('dobNext').textContent = idx===STEPS.length-1?'Finish':'Next';
    document.getElementById('dobBack').style.visibility = idx===0?'hidden':'visible';
    document.getElementById('dobDots').innerHTML=STEPS.map(function(_,i){return '<span class="dob-dot'+(i===idx?' on':'')+'"></span>';}).join('');
    requestAnimationFrame(function(){ position(s); });
  }
  function position(s){
    var spot=document.getElementById('dobSpot'), dim=document.querySelector('.dob-dim'), tip=document.getElementById('dobTip');
    var el=s.anchor?document.querySelector(s.anchor):null;
    if(!el){ spot.style.display='none'; dim.style.display='block'; tip.style.left='50%'; tip.style.top='50%'; tip.style.transform='translate(-50%,-50%)'; return; }
    dim.style.display='none'; spot.style.display='block'; tip.style.transform='none';
    var r=el.getBoundingClientRect(), pad=6;
    spot.style.left=(r.left-pad)+'px'; spot.style.top=(r.top-pad)+'px'; spot.style.width=(r.width+pad*2)+'px'; spot.style.height=(r.height+pad*2)+'px';
    var tw=322, th=tip.offsetHeight||210, gap=14, vw=window.innerWidth, vh=window.innerHeight, L, T, place=s.place||'bottom';
    if(place==='right'){ L=r.right+gap; T=r.top; }
    else if(place==='left'){ L=r.left-tw-gap; T=r.top-th/2+r.height/2; }
    else { L=r.left; T=r.bottom+gap; }
    L=Math.max(12,Math.min(L,vw-tw-12)); T=Math.max(12,Math.min(T,vh-th-12));
    tip.style.left=L+'px'; tip.style.top=T+'px';
  }

  function start(){ build(); STEPS=buildSteps(OPTS); idx=0; document.getElementById('dalosTour').classList.add('on'); render(); }
  function finish(){ try{ localStorage.setItem(KEY,'done'); }catch(e){} var t=document.getElementById('dalosTour'); if(t) t.classList.remove('on'); }
  function go(d){ idx+=d; if(idx>=STEPS.length){ finish(); return; } if(idx<0) idx=0; render(); }

  function roleLabel(){ var r=(OPTS.role||'').replace('_',' '); return r?(r.charAt(0).toUpperCase()+r.slice(1)):'Welcome'; }

  /* ---------- step list (role-adaptive) ---------- */
  function buildSteps(o){
    var edit=!!(o.perms&&o.perms.editCRM), admin=!!o.isAdmin, S=[];
    S.push({t:'Welcome to DalOS Commercial',b:'A quick walk through the pages you’ll use. Skip anytime — you can replay it later from <b>Help &amp; guides</b>.',anchor:null});
    S.push({t:'Two sides, one CRM',b:'The sidebar splits into <b>Tracking &amp; Claims</b> (shipments, invoices, claims, redirects, grading, clean) and <b>Lead Generation</b> (the sales/marketing pipeline).',anchor:'.crmv .sidebar',place:'right'});
    S.push({t:'The season sets your view',b:'Tracking &amp; Claims always shows <b>one season</b>. Change it in the sidebar; this bar shows which one is open. <b>Leads are not affected by the season.</b>',anchor:'[data-tour="season"]',place:'bottom',note:'If shipments seem to “disappear”, first check you’re on the right season.'});
    S.push({t:'Find &amp; scope anything',b:'Search by container, client, B/L, claim ref or vessel — then narrow by <b>Region</b> and <b>Product</b>. Every list obeys this scope.',anchor:'#crmSearch',place:'bottom'});
    S.push({t:'Dashboard — your triage home',b:'Your region’s pulse (coverage, open claims, quality gaps) plus a <b>Needs attention</b> list of the containers to act on first.',anchor:'[data-tour="m-dashboard"]',place:'right',tab:'dashboard'});
    S.push({t:'Shipments — every container',b:'The full register for your region. Filter, then click any row to open its full record — '+(edit?'where you raise a claim, grade, or redirect.':'where you view the claim, quality and history.'),anchor:'[data-tour="m-shipments"]',place:'right',tab:'shipments',note:edit?'To claim: open a container → Raise claim. Save the claim first — the evidence upload unlocks after it exists.':null});
    S.push({t:'Invoices — across containers',b:'Shipments grouped by invoice — '+(edit?'raise a claim or redirect that spans several containers at once.':'see invoice-level claims and redirects.'),anchor:'[data-tour="m-invoices"]',place:'right',tab:'invoices'});
    S.push({t:'Claims — the register',b:'Every claim in your scope with its value and open/closed state.'+(edit?' Reopen one to record the settlement.':''),anchor:'[data-tour="m-claims"]',place:'right',tab:'claims'});
    S.push({t:'Redirects — returned goods',b:'When goods come back, they can be redirected to another client (whole, selected rows, or a % re-sort).'+(edit?' Cancel a container redirect here.':''),anchor:'[data-tour="m-redirects"]',place:'right',tab:'redirects'});
    S.push({t:'Grading — close quality gaps',b:'Containers that arrived without a client-QC report'+(edit?' — record a CRM grade (A/B/C) + cause so every container has a quality read.':'.'),anchor:'[data-tour="m-grading"]',place:'right',tab:'grading'});
    S.push({t:'Clean — nothing to action',b:'Containers with no claim, flag or return. “Verified” have a passing quality read; the rest simply have no quality data yet.',anchor:'[data-tour="m-clean"]',place:'right',tab:'clean'});
    if(admin) S.push({t:'Region rules — setup',b:'Map clients &amp; countries to regions with a priority rule engine (draft → <b>Commit</b>). Keeps shipments out of the Unassigned bucket.',anchor:'[data-tour="m-regions"]',place:'right',tab:'regions'});
    S.push({t:'Your leads live in My Work',b:'Qualified leads for your region land here. '+(edit?'Depending on your region’s setup you <b>Claim &amp; own</b> them, or a manager assigns them to you.':'Marketing captures, enriches and assigns leads to regions from here.'),anchor:'[data-tour="l-inbox-inbox"]',place:'right',lead:{dest:'inbox',key:'inbox'},note:edit?'Inbox empty? You may not have a region assigned yet — ask an admin.':null});
    S.push({t:'That’s the tour',b:'Every page here — plus step-by-step guides and answers to common questions — is always in <b>Help &amp; guides</b>. You’re set.',anchor:'[data-tour="help"]',place:'right',tab:'dashboard'});
    return S;
  }

  /* ---------- Help hub ---------- */
  function helpData(){
    var edit=!!(OPTS.perms&&OPTS.perms.editCRM), admin=!!OPTS.isAdmin, G=[];
    G.push(['Getting started',[
      ['Your role: '+roleLabel(), edit?'You track shipments and raise claims for your region(s), and work leads assigned to your region in My Work.':'You have full lead management; the Tracking &amp; Claims pages are read-only for you.'],
      ['Why is a screen empty?','You switched to a season with no data, or you have no region assigned yet — ask an admin to add you under Users → Region access.']
    ]]);
    G.push(['The pages',[
      ['Dashboard','Your daily triage home: region-pulse KPIs + a Needs-attention list of containers to act on.'],
      ['Shipments','The full container register for your region. Search/filter, click a row for the record.'],
      ['Invoices','Shipments grouped by invoice — act on a claim or redirect spanning several containers at once.'],
      ['Claims','Every claim in scope, open or closed, with values.'],
      ['Redirects','Returned goods sent to another client (whole/rows/%). Cancel a container redirect here.'],
      ['Grading','Containers with no client-QC report — record a CRM grade A/B/C + cause.'],
      ['Clean','Containers with no claim/flag/return — nothing to action. Verified = passing quality read.'],
      ['My Work','Your lead inbox (unclaimed region leads) + pipeline (leads you own).']
    ]]);
    if(edit) G.push(['How-to',[
      ['Raise &amp; close a claim','Row or drawer → Raise claim → whole or part of load → B/L + value → Save. Reopen and flip to Closed to record the settlement.'],
      ['Attach evidence','Save the claim first, then the dropzone unlocks — drop the client email, arrival photos or rejection note.'],
      ['Redirect goods','From a returned container or Invoices → choose client + rows/% → Save. Cancellable from the Redirects tab.'],
      ['Claim vs Assign (leads)','“Assign” routes a lead to a region’s inbox — not a person. You then Claim &amp; own it, or a manager assigns it to you.']
    ]]);
    if(admin) G.push(['Admin',[
      ['Region rules','Map clients/countries to regions; edits stage as a draft and apply only when you Commit.'],
      ['Members &amp; routing','A region runs in Claim or Assign mode; managers assign leads to members. Membership is seeded under Users → Region access.']
    ]]);
    G.push(['Common questions',[
      ['Where did my shipments go?','You probably switched season — use “Back to active” on the season bar.'],
      ['I edited something and nothing changed','Region rules use draft → Commit; changes apply only after you Commit.']
    ]]);
    return G;
  }
  function openHelp(){ build();
    document.getElementById('dobHelpBody').innerHTML=helpData().map(function(grp){
      return '<div class="dob-help-grp">'+grp[0]+'</div>'+grp[1].map(function(it){
        return '<div class="dob-help-item"><div class="dob-help-q">'+it[0]+'<span class="chev">›</span></div><div class="dob-help-a">'+it[1]+'</div></div>';
      }).join('');
    }).join('');
    document.getElementById('dalosHelp').classList.add('on');
  }
  function closeHelp(){ var h=document.getElementById('dalosHelp'); if(h) h.classList.remove('on'); }

  /* ---------- public API ---------- */
  window.DalosOnboarding={
    init:function(o){ OPTS=o||{}; build(); STEPS=buildSteps(OPTS);
      var done=false; try{ done=localStorage.getItem(KEY)==='done'; }catch(e){}
      if(!done) setTimeout(start,1000);   /* let the app settle, then first-run auto-start */
    },
    start:start,
    replay:start,
    openHelp:openHelp,
    reset:function(){ try{ localStorage.removeItem(KEY); }catch(e){} }   /* for testing */
  };
})();
