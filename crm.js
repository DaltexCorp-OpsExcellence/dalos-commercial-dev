/* ═══════════════════════════════════════════════════════════════════════════
   DalOS Vision — CRM island (extracted from index.html for deploy isolation).
   Defines globals: window.CRM (init/teardown/API) and injectCrmCss().
   Loaded as a classic <script src="crm.js"> before the main inline script;
   CRMView (in index.html) mounts it via window.CRM.init({...}).
   ═══════════════════════════════════════════════════════════════════════════ */
/* CRM MODULE (Step 3 - ported from crm.html mockup) */
/* ═══════════════════════════════════════════════════════════════════════════
   DalOS Vision — CRM module (ported from the approved crm.html mockup)
   Rendered as an isolated DOM "island" inside a .crmv wrapper. All styling is
   scoped to .crmv; all globals live on window.CRM. Reads live crm_voyages /
   crm_shipment_rows (region-gated server-side), writes crm_claims / crm_gradings
   / region_overrides. Season-scoped via CRM.init({seasonId}).
   ═══════════════════════════════════════════════════════════════════════════ */
window.CRM = (function(){
  var SB=null, SEASON=null, IS_ADMIN=false, USER=null, ROOT=null, MOUNTED=false;
  var IS_APPROVER=false, CLAIM_SETTINGS={threshold:0,currency:null};   /* leadership settlement-approval gate */
  var CONFIG=null, ON_OPEN_CQC=null, ON_HEADER=null, ON_TAB=null, PENDING_TAB=null;
  /* ── Access control (pass 1: UI gating; server-side RLS/RPC enforcement is pass 2) ──
     PERMS injected via CRM.init({perms}) from the host, derived from the user's role (assigned in
     Vision Admin). Gates are cosmetic — the real boundary is RLS on crm_leads / claim / grading /
     redirection tables. can() reads PERMS only, so IS_ADMIN stays a pure DATA-SCOPE signal. */
  var PERMS={};
  function can(p){ return !!PERMS[p]; }
  function canEditCRM(){ return can('editCRM'); }
  function canManageLeads(){ return can('manageLeads'); }
  function canEditLeadStatus(){ return can('editLeadStatus')||can('manageLeads'); }
  function guard(p,msg){ if(can(p)) return true; toast('<b>Not permitted</b> · '+(msg||'you don’t have access for this action')); return false; }
  function gm(fn){ return function(){ if(!guard('manageLeads','lead management (create, import, enrich, qualify, assign, campaigns) is restricted to Marketing')) return; return fn.apply(this,arguments); }; }
  function gs(fn){ return function(){ if(!canEditLeadStatus()){ toast('<b>Not permitted</b> · you have view-only access to leads'); return; } return fn.apply(this,arguments); }; }
  function ge(fn){ return function(){ if(!guard('editCRM','CRM edits (claims, grading, redirects) are restricted to the commercial team')) return; return fn.apply(this,arguments); }; }
  var SHIPMENTS=[], REDIR_IN=[], REGIONS=[], regionLabel={}, regionOwner={}, regionRouting={};
  var COUNTRY_REGION={}, REGION_OVERRIDES={country:{},client:{},shipment:{}}, BAND_MAP={};
  /* 13 countries served by >1 region — can't auto-resolve; kept for the admin panel flag. */
  var COUNTRY_OVERLAP={bahrain:['cis','ne'],canada:['cis','ga'],jibouti:['cis','ga'],jordan:['cis','ga'],panama:['cis','ga'],russia:['cis','go'],ksa:['cis','ne'],slovenia:['cis','ne','uk'],kuwait:['ne','ga'],qatar:['ne','ga'],'south africa':['ne','ga'],spain:['ne','ga'],uae:['ne','ga']};

  var currentTab='dashboard', currentRegion='all', currentProduct='all', currentQuery='';
  var showAllSubs=false, pulseOpen=true;
  var PER_PAGE=50;
  var pageState={shipments:0, grading:0, claims:0, clean:0, invoices:0};

  /* ── small utils ── */
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
  /* tonnes cell — shipments.net_weight is tonnes; credit/return rows are negative by design */
  function tonCell(v){ var n=Number(v)||0; return n.toLocaleString()+' t'; }
  /* Accepts 1,850.00 / 1.850,00 / 1 850 / 1850. Returns null when not a number,
     so a bad entry is rejected instead of silently saving 1.85 or NULL. */
  function parseNum(v){
    var s=String(v==null?'':v).trim(); if(!s) return null;
    s=s.replace(/[^0-9.,\-]/g,''); if(!s||s==='-') return null;
    var lc=s.lastIndexOf(','), ld=s.lastIndexOf('.');
    if(lc>-1&&ld>-1){ s = lc>ld ? s.replace(/\./g,'').replace(/,/g,'.') : s.replace(/,/g,''); }
    else if(lc>-1){ s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g,'') : s.replace(/,/g,'.'); }
    else if(ld>-1){ if(/^-?\d{1,3}(\.\d{3})+$/.test(s)) s=s.replace(/\./g,''); }
    var n=Number(s); return isFinite(n)?n:null;
  }
  function numOrNull(v){ var n=parseNum(v); return n===null?null:n; }
  /* '—' is a display placeholder, never a value to persist */
  function txtOrNull(v){ var s=(v==null?'':String(v)).trim(); return (!s||s==='—')?null:s; }
  function $(id){ return ROOT?ROOT.querySelector('#'+id):null; }
  function num(v){ return (v==null||isNaN(v))?0:Number(v); }
  function pct(v){ return (v==null||v==='')?null:(Math.round(Number(v)*10)/10)+'%'; }
  var MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function parseDate(d){ if(!d) return null; var t=Date.parse(d); return isNaN(t)?null:new Date(t); }
  function fmtDate(d){ var x=parseDate(d); return x?(x.getUTCDate()+' '+MONTHS[x.getUTCMonth()]):'—'; }
  function fmtLong(d){ var x=parseDate(d); return x?(x.getUTCDate()+' '+MONTHS[x.getUTCMonth()]+' '+x.getUTCFullYear()):'—'; }
  function dayKey(d){ var x=parseDate(d); return x?Math.floor(x.getTime()/86400000):0; }
  var TODAY_KEY=Math.floor(Date.now()/86400000);
  var CUR={USD:'$',EUR:'€',GBP:'£',EGP:'E£'};
  function curSym(c){ return CUR[c]||(c?c+' ':'$'); }
  function fmtMoney(v,c){ if(v==null||v==='') return null; return curSym(c)+Number(v).toLocaleString(); }
  function toast(html){ var t=$('crmToast'); if(!t) return; t.innerHTML=html; t.classList.add('show'); clearTimeout(toast._t); toast._t=setTimeout(function(){ t.classList.remove('show'); },3200); }

  /* ── quality bands (canonical 1..5) ── */
  var BANDS={1:{n:'Excellent',cls:'b-pass'},2:{n:'Good',cls:'b-pass'},3:{n:'Fair',cls:'b-warn'},4:{n:'Poor',cls:'b-fail'},5:{n:'Reject',cls:'b-fail'}};
  function bandBadge(score, rawTitle){
    var b=BANDS[score]||{n:'Unclassified',cls:'b-neutral'};
    var tail=score?' <span style="opacity:.65;font-family:var(--font-mono);font-size:10px">'+esc(score)+'</span>':'';
    return '<span class="badge '+b.cls+'" title="'+esc(rawTitle||('band '+(score||'—')+' ('+b.n+')'))+'">'+b.n+tail+'</span>';
  }
  function statusBadge(s,label){ var cls=s==='delivered'?'b-pass':(s==='in_transit'?'b-esc':(s==='returned'?'b-fail':'b-neutral')); return '<span class="badge '+cls+'">'+esc(label)+'</span>'; }
  function claimBadge(c){ if(!c) return ''; var map={open:['b-fail','Claim open'],pending:['b-warn','Settlement pending'],closed:['b-neutral','Claim closed']}; var m=map[c.status]||map.open; return '<span class="badge '+m[0]+'">'+m[1]+' · '+claimValueHtml(c,false)+'</span>'; }
  function coverageBadge(c){
    if(c.coverage==='cqc') return '<span class="coverage cov-cqc"><span class="cov-dot"></span>CQC · '+((BANDS[c.cqc&&c.cqc.score]||{}).n||'—')+'</span>';
    if(c.coverage==='graded') return '<span class="coverage cov-graded"><span class="cov-dot"></span>CRM-graded · '+esc(c.graded.grade)+'</span>';
    return '<span class="coverage cov-none"><span class="cov-dot"></span>No quality data</span>';
  }

  /* ── data mapping: crm_voyages row → internal shipment shape ── */
  function mapVoyage(r){
    var varieties=(r.variety_display||'').split(' / ').filter(Boolean);
    var s={
      key:r.container_key, cn:r.container_number||r.container_key,
      client:r.client||'—', sub:r.subclient||'—', country:r.country||'',
      region:r.region_id||'unassigned', product:r.product_id?(r.product_id.charAt(0).toUpperCase()+r.product_id.slice(1)):'—', productId:r.product_id||null,
      variety:varieties[0]||'—', varieties:varieties.length>1?varieties:null,
      cartons:num(r.carton_count), pallets:num(r.pallet_count), netTons:num(r.net_weight), grossKg:num(r.gross_weight),
      vessel:r.vessel||'—', shippingLine:r.shipping_line||'—', port:r.receiving_port||'—', departurePort:r.departure_port||'—',
      eta:fmtDate(r.eta), etaRaw:r.eta, etd:fmtDate(r.etd), arrival:fmtDate(r.arrival_date),
      invoice:r.invoice_no||'', booking:r.booking_no||'', shipper:r.shipper||'', agent:r.agent||'',
      brand:r.brand||'', size:r.size||'', dclass:r.daltex_class||'', trace:r.traceability_code||'', farmSource:r.farm_source||'',
      split:!!r.split, rowCount:num(r.row_count), cartaCount:num(r.carta_count),
      status:r.status, statusLabel:r.status==='delivered'?'Delivered':(r.status==='returned'?'Returned':'In transit'),
      sortKey:dayKey(r.eta||r.arrival_date||r.etd),
      coverage:r.coverage, insp:null, cqc:null, graded:null, claim:null, rows:null, packHouses:r.pack_houses||[],
      cqcId:r.cqc_id||null, inspId:r.insp_id||null, gradingId:r.grading_id||null,
      /* a cancelled claim must not be re-opened by "Raise claim" (F4) */
      claimId:(r.claim_id && r.claim_status!=='cancelled')?r.claim_id:null,
      claimRefRaw:r.claim_ref||null,
      bl:(r.claim_bl||r.bl_number||'')
    };
    if(r.insp_id) s.insp={id:r.insp_id, defect:(pct(r.insp_defect)||'—'), decision:r.insp_decision==='A'?'Approved':(r.insp_decision||'—')};
    if(r.cqc_id) s.cqc={id:r.cqc_number||r.cqc_id, score:r.cqc_band||0, scoreRaw:r.cqc_score_raw||'', scoreLabel:(BANDS[r.cqc_band]||{}).n||'Unclassified',
      defect:(pct(r.cqc_defect)||'—'), gap:(r.cqc_gap==null?'—':((r.cqc_gap>0?'+':'')+(Math.round(r.cqc_gap*10)/10)+'%')), gapNum:num(r.cqc_gap), maxTemp:r.cqc_max_temp, flag:!!r.cqc_flag};
    if(r.grading_id) s.graded={grade:r.grade, cause:r.grade_cause||'—'};
    if(r.claim_id && r.claim_status && r.claim_status!=='cancelled'){
      s.claim={id:r.claim_id, status:(r.claim_status==='open'?'open':(r.claim_status==='pending'?'pending':'closed')), rawStatus:r.claim_status, potential:!!r.claim_potential,
        value:fmtMoney(r.claim_value,r.claim_currency), rawValue:r.claim_value, currency:r.claim_currency||'USD'};
    }
    if(s.coverage==='graded'&&!s.graded) s.graded={grade:'—',cause:'—'};
    return s;
  }

  function shipByKey(k){ for(var i=0;i<SHIPMENTS.length;i++){ if(SHIPMENTS[i].key===k) return SHIPMENTS[i]; } return null; }

  /* ── derived / classification ── */
  function shipProduct(s){ return s.product||'—'; }
  function shipCountry(s){ return s.country||'—'; }
  function shipInvoice(s){ return s.invoice||'—'; }
  function noCqc(s){ return s.coverage!=='cqc'; }
  function needsGrading(s){ return s.coverage==='none'; }
  function hasClaim(s){ return !!s.claim; }
  function isFlagged(s){ return !!(s.cqc && s.cqc.flag); }
  /* a returned container is never billable-clean, whatever its claim/flag state */
  function isClean(s){ return !s.redirectedIn && !s.claim && !isFlagged(s) && s.status!=='returned'; }
  /* Severity used for "worst score first". A CQC score is a measurement; a CRM
     grade is a judgement made because no CQC arrived. They share a scale, so at
     equal severity the measured container is nudged ahead (+0.5) — confirmed
     problems surface before opinions, without reordering across severities. */
  function scoreNum(s){
    if(s.cqc) return (s.cqc.score||0)+0.5;
    if(s.coverage==='graded') return ({A:2,B:3,C:4})[s.graded.grade]||3;
    return 0;
  }
  function provenance(s){ return s.coverage==='cqc'?'measured':(s.coverage==='graded'?'graded':'none'); }
  function gapNum(s){ return s.cqc?s.cqc.gapNum:0; }
  function attentionInfo(s){
    if(s.claim && (s.claim.status==='open'||s.claim.status==='pending')) return {p:3,label:s.claim.status==='pending'?'settlement pending approval':'claim open'};
    if(isFlagged(s) && !s.claim) return {p:2,label:'CQC claim flag'};
    if(s.coverage==='none' && s.status==='delivered') return {p:1,label:'delivered · no quality data'};
    return null;
  }

  /* ── region resolution (client-side mirror for the admin panel counts) ── */
  function regionForCountry(co){ var k=(co||'').toString().trim().toLowerCase(); return REGION_OVERRIDES.country[k]||COUNTRY_REGION[k]||null; }

  /* ── scoping cascade: region → product → search ── */
  function matchesQuery(s){
    if(!currentQuery) return true;
    var qq=currentQuery.toLowerCase();
    var hay=[s.cn,s.client,s.sub,shipInvoice(s),(s.varieties?s.varieties.join(' '):s.variety),shipProduct(s),shipCountry(s),s.port,s.vessel,s.claimRefRaw,s.bl].join(' ').toLowerCase();
    return hay.indexOf(qq)>=0;
  }
  function baseFiltered(exclude){
    return SHIPMENTS.filter(function(s){
      if(exclude!=='region' && !(currentRegion==='all' || s.region===currentRegion)) return false;
      if(exclude!=='product' && !(currentProduct==='all' || shipProduct(s)===currentProduct)) return false;
      return matchesQuery(s);
    });
  }
  function visibleShipments(){ return baseFiltered(null); }

  /* ── switchers ── */
  function resetPages(){ pageState={shipments:0,grading:0,claims:0,clean:0,invoices:0}; }
  function renderRegions(){
    var base=baseFiltered('region'), counts={};
    base.forEach(function(s){ counts[s.region]=(counts[s.region]||0)+1; });
    counts.all=base.length;
    var el=$('regionSel'); if(!el) return;
    var cur=REGIONS.filter(function(r){return r.id===currentRegion;})[0]||REGIONS[0];
    var active=currentRegion!=='all';
    el.innerHTML='<span class="fbtn'+(active?' active':'')+'"><span class="fbtn-cap">Region</span><span class="fbtn-val">'+esc(cur.label)+(cur.admin?' (admin)':'')+'</span><span class="fbtn-count">'+(counts[currentRegion]||0).toLocaleString()+'</span><span class="fbtn-chev">▾</span>'
      +'<select class="fbtn-native" onchange="CRM.setRegion(this.value)">'+REGIONS.map(function(r){
        return '<option value="'+r.id+'"'+(r.id===currentRegion?' selected':'')+'>'+esc(r.label)+(r.admin?' (admin)':'')+' · '+(counts[r.id]||0)+'</option>';
      }).join('')+'</select></span>';
  }
  function renderProducts(){
    var list=baseFiltered('product'), counts={};
    list.forEach(function(s){ var p=shipProduct(s); counts[p]=(counts[p]||0)+1; });
    var opts=[['all','All products',list.length]];
    Object.keys(counts).sort().forEach(function(p){ opts.push([p,p,counts[p]]); });
    var el=$('productSel'); if(!el) return;
    var active=currentProduct!=='all';
    var curCount=list.length; for(var i=0;i<opts.length;i++){ if(opts[i][0]===currentProduct){ curCount=opts[i][2]; break; } }
    el.innerHTML='<span class="fbtn'+(active?' active':'')+'"><span class="fbtn-cap">Product</span><span class="fbtn-val">'+(active?esc(currentProduct):'All products')+'</span><span class="fbtn-count">'+curCount.toLocaleString()+'</span><span class="fbtn-chev">▾</span>'
      +'<select class="fbtn-native" onchange="CRM.setProduct(this.value)">'+opts.map(function(o){
        return '<option value="'+esc(o[0])+'"'+(currentProduct===o[0]?' selected':'')+'>'+esc(o[1])+' · '+o[2]+'</option>';
      }).join('')+'</select></span>';
    var clr=$('crmClear'); if(clr) clr.style.display=(currentRegion!=='all'||currentProduct!=='all'||currentQuery)?'inline':'none';
  }

  function kpi(label,val,sub,cls,onclick){
    if(typeof val==='number') val=val.toLocaleString();
    return '<div class="kpi"'+(onclick?' data-go="1" role="button" tabindex="0" onclick="'+onclick+'"':'')+'><div class="kpi-label">'+label+'</div><div class="kpi-value">'+val+'</div><div class="kpi-sub '+(cls||'')+'">'+sub+'</div></div>'; }
  function renderKpis(){
    var g=$('kpiGrid'); if(!g) return;
    if(currentTab==='dashboard'){ g.innerHTML=''; return; }
    if(LEADS_TABS.indexOf(currentTab)>=0){ g.innerHTML=''; return; }   /* Leads tabs render their own KPI strip inside viewContent */
    var filtered=currentTab==='shipments' && shipActiveFilterCount()>0;
    var list=filtered?visibleShipments().filter(shipFilterMatch):visibleShipments();
    var cqcCount=list.filter(function(s){return s.coverage==='cqc';}).length;
    var gradedCount=list.filter(function(s){return s.coverage==='graded';}).length;
    var qcBase=list.filter(function(s){return !s.redirectedIn;}).length;   /* redirected-in goods aren't QC subjects — keep them out of the coverage % */
    var covered=cqcCount+gradedCount, covPct=qcBase?Math.round(covered/qcBase*100):0;
    var openClaims=list.filter(function(s){return s.claim&&s.claim.status==='open';}).length;
    var noData=list.filter(function(s){return s.coverage==='none';}).length;
    g.innerHTML=
      kpi('Shipments',list.length.toLocaleString(),filtered?'matching filters':(currentRegion==='all'?'across all regions':'in region'))+
      kpi('Quality coverage',covPct+'%',cqcCount+' CQC · '+gradedCount+' CRM-graded')+
      kpi('Open claims',openClaims,openClaims?'need action':'none pending',openClaims?'down':'',openClaims?"CRM.setTab('claims')":null)+
      kpi('No quality data',noData,noData?'gap — grade or chase CQC':'fully covered',noData?'down':'up',noData?"CRM.pulseGo('score','none')":null);
  }

  function renderTabs(){
    var stg=/-dev|localhost|127\.0\.0\.1/.test(location.host+location.pathname) ? '<span class="staging-badge">staging</span>' : '';
    var html;
    if(LEADS_TABS.indexOf(currentTab)>=0){
      /* ── DEDICATED LEADS section under CRM ── the topbar shows a back-crumb + the active view.
         Navigation between leads views is the sidebar (CRM → Leads Managements buttons); the CRM
         commercial tabs are hidden here. */
      var _vl={ws:'Workspace',enr:'Enrichment queue',rej:'Returned by sales',inbox:'Lead inbox',pip:'My pipeline',cap:'Show mode',board:'Funnel',conv:'Conversion',campaigns:'Campaign'};
      var _cur=_vl[activeLeadKey()]||'Leads';
      html='<div class="crm-nav"><div class="ultabs" id="crmUltabs">'
        +'<span class="ulgrp"><span class="ultab ul-back" role="button" tabindex="0" title="Back to CRM" onclick="CRM.setTab(\'dashboard\')">‹ CRM</span></span>'
        +'<span class="ulgrp"><span class="ulcap">Leads</span><span class="ultab on" role="button" tabindex="0" aria-current="page">'+esc(_cur)+'</span></span>'
        +'</div>'+stg+'</div>';
    } else {
      var list=visibleShipments();
      var attCount=list.filter(function(s){return !!attentionInfo(s);}).length;
      var openClaims=list.filter(function(s){return s.claim&&s.claim.status==='open';}).length;
      var pendingCount=list.filter(function(s){return s.claim&&s.claim.status==='pending';}).length;
      var unassigned=list.filter(function(s){return s.region==='unassigned';}).length;
      /* role-grouped underline nav on the sidebar-green band (see CRM header redesign).
         Marketing is a single entry that ENTERS the dedicated Leads section — no leads pages inline here. */
      var groups=[
        {tabs:[{id:'dashboard',label:'Dashboard',dot:attCount,mut:true}]},
        {cap:'Records',tabs:[{id:'shipments',label:'Shipments'},{id:'invoices',label:'Invoices'}]},
        {cap:'Cases',tabs:[{id:'claims',label:'Claims',dot:openClaims},{id:'redirects',label:'Redirects'},{id:'grading',label:'Grading'}].concat(IS_APPROVER?[{id:'approvals',label:'Claim Approvals',dot:pendingCount}]:[])},
        {cap:'Marketing',tabs:[{id:'leads',label:'Leads',dot:leadsInboxDot(),go:"CRM.leadNav('leads','ws')"}]},
        {tabs:[{id:'clean',label:'Clean'}]}
      ];
      if(IS_ADMIN && currentRegion==='all') groups.push({cap:'Setup',tabs:[{id:'regions',label:(CRM_REGION_RULES_V2?'Region rules':'Region mapping'),dot:unassigned,mut:true}]});
      function tabHtml(t){ return '<span class="ultab'+(t.id===currentTab?' on':'')+'" role="button" tabindex="0" onclick="'+(t.go||("CRM.setTab('"+t.id+"')"))+'">'+t.label+(t.dot?'<span class="cnt '+(t.mut?'cnt-mut':'cnt-red')+'">'+t.dot.toLocaleString()+'</span>':'')+'</span>'; }
      var tabsHtml=groups.map(function(g){ return '<span class="ulgrp">'+(g.cap?'<span class="ulcap">'+g.cap+'</span>':'')+g.tabs.map(tabHtml).join('')+'</span>'; }).join('');
      html='<div class="crm-nav"><div class="ultabs" id="crmUltabs">'+tabsHtml+'</div>'+stg+'</div>';
    }
    var el=$('viewTabs'); if(el) el.innerHTML=html;          /* in-island fallback if no host header slot */
    if(ON_HEADER) ON_HEADER(html);                            /* lift the nav into the shell topbar (which is toned green for CRM) */
    /* keep the active tab visible when the row scrolls on narrow screens */
    var ut=$('crmUltabs'); if(ut){ var onEl=ut.querySelector('.ultab.on'); if(onEl&&onEl.scrollIntoView){ try{ onEl.scrollIntoView({block:'nearest',inline:'nearest'}); }catch(e){} } }
  }

  /* ── pagination ── */
  function pagerHtml(total,page,key){
    if(total<=PER_PAGE) return '';
    var pages=Math.ceil(total/PER_PAGE), from=page*PER_PAGE+1, to=Math.min(total,(page+1)*PER_PAGE);
    function pbtn(p,label,dis,cur){ return '<button '+(dis?'disabled':'')+' class="btn '+(cur?'btn-primary':'btn-secondary')+' btn-sm"'+(cur?' aria-current="page"':'')+' onclick="CRM.setPage(\''+key+'\','+p+')">'+label+'</button>'; }
    /* P2-10: numbered page jump (windowed ±2 with first/last) instead of Prev/Next only */
    var nums=[], win=2, lo=Math.max(0,page-win), hi=Math.min(pages-1,page+win), i;
    if(lo>0){ nums.push(pbtn(0,'1',false,page===0)); if(lo>1) nums.push('<span class="pager-gap">…</span>'); }
    for(i=lo;i<=hi;i++) nums.push(pbtn(i,String(i+1),false,i===page));
    if(hi<pages-1){ if(hi<pages-2) nums.push('<span class="pager-gap">…</span>'); nums.push(pbtn(pages-1,String(pages),false,page===pages-1)); }
    return '<div class="pager"><span>'+from.toLocaleString()+'–'+to.toLocaleString()+' of '+total.toLocaleString()+'</span><span class="pager-btns">'+
      pbtn(page-1,'‹ Prev',page===0,false)+nums.join('')+pbtn(page+1,'Next ›',page>=pages-1,false)+'</span></div>';
  }

  /* ── quality cells ── */
  function qualityCell(s){
    if(s.cqc){ var _b=BANDS[s.cqc.score]||{n:'Unclassified',cls:'b-neutral'}; var _raw=s.cqc.scoreRaw||s.cqc.scoreLabel||_b.n; return '<span class="badge '+_b.cls+'" title="'+esc('Client score as entered'+(s.cqc.score?' · defined band: '+_b.n+' ('+s.cqc.score+')':''))+'">'+esc(_raw)+'</span>'; } /* listing shows the raw client score as-is; the defined band is kept for the Quality-mix chart */
    if(s.coverage==='graded') return '<span class="badge b-neutral" title="CRM grade — a commercial judgement, not a measured CQC result'+(s.graded.cause&&s.graded.cause!=='—'?' · cause: '+s.graded.cause:'')+'" style="border-color:#c090e0;color:#6a10b0;background:#f0e8ff">Graded '+esc(s.graded.grade)+'</span>';
    return '<span class="cell-sub">no data</span>';
  }
  function qualityCellLinked(s){
    var qc=s.cqc?'<span class="qlink" title="Open CQC report" data-crm-act="openCqc" data-crm-key="'+esc(s.key)+'">'+qualityCell(s)+'</span>':qualityCell(s);
    var insp=s.insp?'<div class="cell-sub lot ilink" style="margin-top:3px" title="Open export inspection" data-crm-act="openInsp" data-crm-key="'+esc(s.key)+'">'+esc(s.insp.id)+' ↗</div>':'';
    return qc+insp;
  }

  /* ── Shipments tab ── */
  var SHIP_FILTER_KEYS=['status','client','sub','variety','country','score','claim','graded'];
  /* score is 'all', or an array of tokens: a raw client score, or NOCQC */
  var NOCQC='\u2400NOCQC';   /* U+2400 SYMBOL FOR NULL — attribute-safe and cannot collide with a client score */
  var shipView={status:'all',client:'all',sub:'all',variety:'all',country:'all',score:'all',claim:'all',graded:'all',sort:'eta_desc'};
  var scoreOpen=false;   /* popover open state, survives the re-render on toggle */
  function scoreTok(s){ return s.cqc ? (String(s.cqc.scoreRaw||'').trim()||'\u2400BLANK') : NOCQC; }
  function scoreSel(){ return Array.isArray(shipView.score)?shipView.score:null; }
  function shipActiveFilterCount(){ return SHIP_FILTER_KEYS.filter(function(k){return shipView[k]!=='all';}).length; }
  function shipFilterMatch(s){
    if(shipView.status!=='all'&&s.status!==shipView.status) return false;
    if(shipView.client!=='all'&&s.client!==shipView.client) return false;
    if(shipView.sub!=='all'&&s.sub!==shipView.sub) return false;
    if(shipView.variety!=='all'&&(s.varieties||[s.variety]).indexOf(shipView.variety)<0) return false;
    if(shipView.country!=='all'&&shipCountry(s)!==shipView.country) return false;
    var _ss=scoreSel();
    if(_ss){ if(!_ss.length) return false; if(_ss.indexOf(scoreTok(s))<0) return false; }
    if(shipView.claim==='yes'&&!s.claim) return false;
    if(shipView.claim==='no'&&s.claim) return false;
    if(shipView.graded==='yes'&&s.coverage!=='graded') return false;
    if(shipView.graded==='no'&&s.coverage==='graded') return false;
    return true;
  }
  function renderShipmentsTable(){
    var vc=$('viewContent'); if(!vc) return;
    var base=visibleShipments();
    var list=base.filter(shipFilterMatch);
    if(shipView.sort==='eta_desc') list.sort(function(a,b){return b.sortKey-a.sortKey;});
    else if(shipView.sort==='eta_asc') list.sort(function(a,b){return a.sortKey-b.sortKey;});
    else if(shipView.sort==='score_desc') list.sort(function(a,b){return scoreNum(b)-scoreNum(a);});
    else if(shipView.sort==='gap_desc') list.sort(function(a,b){return gapNum(b)-gapNum(a);});
    var page=pageState.shipments, slice=list.slice(page*PER_PAGE,(page+1)*PER_PAGE);
    function fp(group,val,label){ return '<span class="fpill'+(shipView[group]===val?' active':'')+'" role="button" tabindex="0" onclick="CRM.setShipFilter(\''+group+'\',\''+val+'\')">'+label+'</span>'; }
    function fsel(key,label,opts){
      var cur=String(shipView[key]);
      return '<select class="form-select flt-select" onchange="CRM.setShipFilter(\''+key+'\',this.value)">'+
        '<option value="all"'+(cur==='all'?' selected':'')+'>'+label+': All</option>'+
        opts.map(function(o){return '<option value="'+esc(o[0])+'"'+(cur===String(o[0])?' selected':'')+'>'+esc(o[1])+(o[2]!=null?' · '+o[2]:'')+'</option>';}).join('')+'</select>';
    }
    var cnt=function(arr,pred){ var n=0; arr.forEach(function(s){ if(pred(s)) n++; }); return n; };
    var uniq=function(arr){ return Array.from(new Set(arr)).sort(); };
    var clients=uniq(base.map(function(s){return s.client;}));
    var subsBase=shipView.client==='all'?base:base.filter(function(s){return s.client===shipView.client;});
    var subs=uniq(subsBase.map(function(s){return s.sub;}));
    var varieties=uniq(base.reduce(function(a,s){return a.concat(s.varieties||[s.variety]);},[]));
    var countries=uniq(base.map(function(s){return shipCountry(s);}));
    var clientOpts=clients.map(function(v){return [v,v,cnt(base,function(s){return s.client===v;})];});
    var subOpts=subs.map(function(v){return [v,v,cnt(subsBase,function(s){return s.sub===v;})];});
    var varietyOpts=varieties.map(function(v){return [v,v,cnt(base,function(s){return (s.varieties||[s.variety]).indexOf(v)>=0;})];});
    var countryOpts=countries.map(function(v){return [v,v,cnt(base,function(s){return shipCountry(s)===v;})];});
    /* Client-score multi-select. Options come from the scoped set, so the list
       only ever shows values actually present, grouped by their mapped band --
       RED / NFA / UNACCEPTABLE all mean reject but sort nowhere near each other. */
    var scTally={}, scNoCqc=0, scTotal=0;
    base.forEach(function(s){
      scTotal++;
      var t=scoreTok(s);
      if(t===NOCQC){ scNoCqc++; return; }
      if(!scTally[t]) scTally[t]={n:0,band:(s.cqc&&s.cqc.score)||0};
      scTally[t].n++;
    });
    var scByBand={};
    Object.keys(scTally).forEach(function(t){
      var b=scTally[t].band||0; (scByBand[b]=scByBand[b]||[]).push([t,scTally[t].n]);
    });
    Object.keys(scByBand).forEach(function(b){ scByBand[b].sort(function(a,c){return c[1]-a[1];}); });
    var scCqcTotal=scTotal-scNoCqc;
    var scSel=scoreSel();
    function scOn(tok){ return !scSel || scSel.indexOf(tok)>=0; }
    var scChosen = scSel ? scSel.length : null;
    var scLabel = !scSel ? 'Client score: All'
      : (scSel.length===0 ? 'Client score: none'
        : (scSel.length===1 ? 'Client score: '+(scSel[0]===NOCQC?'No CQC':scSel[0])
          : 'Client score: '+scSel.length+' selected'));
    function scRow(tok,label,n,pad,bold){
      return '<label class="sc-opt'+(bold?' sc-strong':'')+'"'+(pad?' style="padding-left:26px"':'')+'>'
        +'<input type="checkbox" data-crm-score="'+esc(tok)+'"'+(scOn(tok)?' checked':'')+'/>'
        +'<span>'+esc(label)+'</span><span class="sc-n">'+n.toLocaleString()+'</span></label>';
    }
    var scHtml='<div class="sc-pop"'+(scoreOpen?'':' hidden')+'>'
      +'<label class="sc-opt sc-strong"><input type="checkbox" data-crm-chg="scoreAll"'+(scSel?'':' checked')+'/>'
        +'<span>Select all</span><span class="sc-n">'+scTotal.toLocaleString()+'</span></label>'
      +'<div class="sc-sep"></div>'
      +scRow(NOCQC,'No CQC on file',scNoCqc,false,true)
      +'<div class="sc-sep"></div>'
      +'<div class="sc-head">Client standard score · '+scCqcTotal.toLocaleString()+'</div>';
    [1,2,3,4,5,0].forEach(function(b){
      var list=scByBand[b]; if(!list||!list.length) return;
      var nm=b?(b+' · '+((BANDS[b]||{}).n||'')):'Unmapped — set a band in Region mapping';
      scHtml+='<div class="sc-band"><span class="sc-dot b'+b+'"></span>'+esc(nm)+'</div>';
      list.forEach(function(it){ scHtml+=scRow(it[0],it[0],it[1],true,false); });
    });
    if(!Object.keys(scByBand).length) scHtml+='<div class="sc-head" style="font-weight:400;text-transform:none;letter-spacing:0">No client scores in this scope.</div>';
    scHtml+='</div>';
    var scoreCtl='<span class="sc-wrap">'
      +'<button type="button" class="form-select flt-select sc-btn'+(scSel?' on':'')+'" data-crm-act="scoreOpen">'
        +'<span>'+esc(scLabel)+'</span><span class="sc-caret">\u25be</span></button>'
      +scHtml+'</span>';
    var claimOpts=[['yes','Claim raised',cnt(base,function(s){return !!s.claim;})],['no','No claim',cnt(base,function(s){return !s.claim;})]];
    var gradedOpts=[['yes','CRM-graded',cnt(base,function(s){return s.coverage==='graded';})],['no','Not graded',cnt(base,function(s){return s.coverage!=='graded';})]];
    var activeCount=shipActiveFilterCount();
    var filters='<div class="filter-row">'+
      '<span class="filter-group">'+fp('status','all','All')+fp('status','delivered','Delivered')+fp('status','in_transit','In transit')+fp('status','returned','Returned')+'</span>'+
      fsel('client','Client',clientOpts)+fsel('sub','Sub-client',subOpts)+fsel('variety','Variety',varietyOpts)+fsel('country','Country',countryOpts)+
      scoreCtl+
      fsel('claim','Claim',claimOpts)+fsel('graded','Graded',gradedOpts)+
      (activeCount?'<span class="link-btn" onclick="CRM.resetShipFilters()">Clear filters ('+activeCount+')</span>':'')+
      '<select class="form-select sort-select" onchange="CRM.setShipSort(this.value)">'+
        [['eta_desc','Newest ETA'],['eta_asc','Oldest ETA'],['score_desc','Worst score first'],['gap_desc','Biggest gap first']].map(function(o){return '<option value="'+o[0]+'"'+(shipView.sort===o[0]?' selected':'')+'>'+o[1]+'</option>';}).join('')+
      '</select></div>';
    var rows=slice.map(function(s){
      if(s.redirectedIn){
        return '<tr class="click" role="button" tabindex="0" data-crm-act="openShipDetail" data-crm-key="'+esc(s.key)+'">'+
          '<td><span class="lot">'+esc(s.cn)+'</span> <span class="badge b-neutral" style="border-color:var(--green-border);color:var(--accent);background:var(--green-bg)" title="Redirected in from '+esc(s.originClient)+'">Redirected in</span></td>'+
          '<td>'+esc(s.client)+'<div class="cell-sub">'+esc(s.sub)+' · '+esc(regionLabel[s.region]||s.region)+'</div><div class="cell-sub">↩ '+esc(s.originClient)+' · '+esc(s.redirectRef||'')+(s.invoice?' · <span class="lot">new inv '+esc(s.invoice)+'</span>':' · <span title="fill it in the redirect">no new inv</span>')+'</div></td>'+
          '<td>'+esc(shipProduct(s))+'</td><td>'+esc(s.varieties?s.varieties.join(' / '):s.variety)+'</td>'+
          '<td class="cell-sub">—</td><td>'+statusBadge(s.status,s.statusLabel)+'</td>'+
          '<td><span class="cell-sub">—</span></td><td class="lot" style="color:var(--text2)">—</td>'+
          '<td><span class="cell-sub">—</span></td>'+
          '<td class="right"><button class="btn btn-secondary btn-sm" data-crm-act="openShipDetail" data-crm-key="'+esc(s.key)+'">View</button></td></tr>';
      }
      return '<tr class="click" role="button" tabindex="0" data-crm-act="openShipDetail" data-crm-key="'+esc(s.key)+'">'+
        '<td><span class="lot">'+esc(s.cn)+'</span>'+(s.split?' <span class="sc-split">split</span>':'')+'</td>'+
        '<td>'+esc(s.client)+'<div class="cell-sub">'+esc(s.sub)+' · '+esc(regionLabel[s.region]||s.region)+'</div></td>'+
        '<td>'+esc(shipProduct(s))+'</td><td>'+esc(s.varieties?s.varieties.join(' / '):s.variety)+'</td>'+
        '<td>'+esc(s.eta)+'</td><td>'+statusBadge(s.status,s.statusLabel)+'</td>'+
        '<td>'+qualityCellLinked(s)+'</td>'+
        '<td class="lot" style="color:'+(gapNum(s)>2?'var(--red)':'var(--text2)')+'">'+(s.cqc?s.cqc.gap:'—')+'</td>'+
        '<td>'+(s.claim?claimBadge(s.claim):'<span class="cell-sub">—</span>')+'</td>'+
        '<td class="right"><button class="btn btn-secondary btn-sm" data-crm-act="openClaim" data-crm-key="'+esc(s.key)+'">'+(s.claim?'View claim':'Raise claim')+'</button></td></tr>';
    }).join('');
    var head='<div class="section-title"><span class="section-title-bar"></span>Shipments <span class="section-count">'+list.length.toLocaleString()+' in view · click a row for the full record</span></div>';
    vc.innerHTML=head+filters+(list.length?'<div class="table-wrap"><table class="wl"><thead><tr><th>Container</th><th>Client</th><th>Product</th><th>Variety</th><th>ETA</th><th>Status</th><th>Quality</th><th>Gap</th><th>Claim</th><th class="right">Action</th></tr></thead><tbody>'+rows+'</tbody></table></div>'+pagerHtml(list.length,page,'shipments'):'<div class="table-wrap"><div class="empty-state">No shipments match these filters.</div></div>');
  }

  /* ── Grading queue ── */
  function renderGradingQueue(){
    var vc=$('viewContent'); if(!vc) return;
    var list=visibleShipments().filter(function(s){return noCqc(s)&&!s.redirectedIn;});
    var head='<div class="section-title"><span class="section-title-bar"></span>Grading queue <span class="section-count">'+list.length+' containers without a CQC</span></div>';
    if(!list.length){ vc.innerHTML=head+'<div class="table-wrap"><div class="empty-state">Every container in this scope has a CQC report — nothing to grade.</div></div>'; return; }
    list.sort(function(a,b){ return (needsGrading(b)?1:0)-(needsGrading(a)?1:0) || b.sortKey-a.sortKey; });
    var gPage=pageState.grading;
    var rows=list.slice(gPage*PER_PAGE,(gPage+1)*PER_PAGE).map(function(s){
      var gs=needsGrading(s)?'<span class="badge b-warn">Needs grading</span>':'<span class="badge b-neutral" style="border-color:#c090e0;color:#6a10b0;background:#f0e8ff">CRM-graded '+esc(s.graded.grade)+'</span>';
      var insp=s.insp?'<span class="ilink" title="Open export inspection" data-crm-act="openInsp" data-crm-key="'+esc(s.key)+'">'+esc(s.insp.defect)+' · '+esc(s.insp.decision)+' ↗</span>':'—';
      var btn='<button class="btn '+(needsGrading(s)?'btn-primary':'btn-secondary')+' btn-sm" data-crm-act="openGrade" data-crm-key="'+esc(s.key)+'">'+(needsGrading(s)?'Grade':'Edit grade')+'</button>';
      return '<tr class="click" role="button" tabindex="0" data-crm-act="openShipDetail" data-crm-key="'+esc(s.key)+'"><td><span class="lot">'+esc(s.cn)+'</span>'+(s.split?' <span class="sc-split">split</span>':'')+'</td>'+
        '<td>'+esc(s.client)+'<div class="cell-sub">'+esc(s.sub)+' · '+esc(regionLabel[s.region]||s.region)+'</div></td>'+
        '<td>'+esc(s.variety)+'</td><td>'+esc(s.eta)+'</td><td class="cell-sub">'+insp+'</td><td>'+gs+'</td><td class="right">'+btn+'</td></tr>';
    }).join('');
    vc.innerHTML=head+'<div class="table-wrap"><table class="wl"><thead><tr><th>Container</th><th>Client</th><th>Variety</th><th>ETA</th><th>Export insp</th><th>Grading</th><th class="right">Action</th></tr></thead><tbody>'+rows+'</tbody></table></div>'+pagerHtml(list.length,gPage,'grading');
  }

  /* ── Claims ── */
  function renderClaims(){
    var vc=$('viewContent'); if(!vc) return;
    var list=visibleShipments().filter(hasClaim);
    var head='<div class="section-title"><span class="section-title-bar"></span>Claims <span class="section-count">'+list.length+' containers with a claim</span></div>';
    if(!list.length){ vc.innerHTML=head+'<div class="table-wrap"><div class="empty-state">No claims raised in this scope.<div class="cell-sub" style="margin-top:6px">Open a container from <b>Shipments</b> and choose <b>Raise claim</b>.</div></div></div>'; return; }
    var lc={open:['b-fail','Open'],pending:['b-warn','Settlement pending'],closed:['b-neutral','Closed']}, lcOrder={open:0,pending:1,closed:2};
    list.sort(function(a,b){ return lcOrder[a.claim.status]-lcOrder[b.claim.status] || b.sortKey-a.sortKey; });
    var cPage=pageState.claims;
    var rows=list.slice(cPage*PER_PAGE,(cPage+1)*PER_PAGE).map(function(s){
      var m=lc[s.claim.status]||lc.open;
      var ev=s.cqc?esc(s.cqc.id):(s.coverage==='graded'?'CRM grading':'—');
      var valCell=s.claim.potential?'<span class="badge b-warn">potential</span>':'<span class="lot">'+claimValueHtml(s.claim,true)+'</span>';
      return '<tr class="click" role="button" tabindex="0" data-crm-act="openShipDetail" data-crm-key="'+esc(s.key)+'"><td><span class="lot">'+esc(s.cn)+'</span></td>'+
        '<td>'+esc(s.client)+'<div class="cell-sub">'+esc(s.sub)+' · '+esc(regionLabel[s.region]||s.region)+'</div></td>'+
        '<td class="right">'+valCell+'</td><td><span class="badge '+m[0]+'">'+m[1]+'</span></td>'+
        '<td class="lot cell-sub">'+ev+'</td><td class="right"><button class="btn btn-secondary btn-sm" data-crm-act="openClaim" data-crm-key="'+esc(s.key)+'">View</button></td></tr>';
    }).join('');
    vc.innerHTML=head+'<div class="table-wrap"><table class="wl"><thead><tr><th>Container</th><th>Client</th><th class="right">Value</th><th>Status</th><th>Evidence</th><th class="right">Action</th></tr></thead><tbody>'+rows+'</tbody></table></div>'+pagerHtml(list.length,cPage,'claims');
  }

  /* ── Approvals (leadership settlement review queue) ── */
  function loadApprover(){ return SB.rpc('crm_can_approve_claims').then(function(r){ IS_APPROVER=!(r&&r.error)&&!!(r&&r.data); }).catch(function(){ IS_APPROVER=false; }); }
  function loadClaimSettings(){ return SB.from('crm_claim_settings').select('settlement_threshold,threshold_currency').limit(1).then(function(r){ var x=(r&&r.data&&r.data[0])||{}; CLAIM_SETTINGS={threshold:Number(x.settlement_threshold)||0, currency:x.threshold_currency||null}; }).catch(function(){ CLAIM_SETTINGS={threshold:0,currency:null}; }); }
  function saveThreshold(){
    if(!IS_ADMIN){ toast('Only admins can change the threshold.'); return; }
    var v=numOrNull($('apThr')&&$('apThr').value); if(v===null||v<0){ toast('Enter a threshold of 0 or more.'); return; }
    var cur=txtOrNull($('apThrCur')&&$('apThrCur').value);
    SB.from('crm_claim_settings').update({settlement_threshold:v, threshold_currency:cur, updated_at:new Date().toISOString(), updated_by:(USER&&USER.id)||null}).eq('id',true).then(function(r){
      if(r&&r.error){ toast('Could not save threshold — '+esc(r.error.message||'')); return; }
      CLAIM_SETTINGS={threshold:v,currency:cur}; toast('Approval threshold saved.'); if(currentTab==='approvals') renderApprovals();
    }).catch(function(e){ toast('Could not save threshold — '+esc((e&&e.message)||e)); });
  }
  function renderApprovals(){
    var vc=$('viewContent'); if(!vc) return;
    var thrPanel = IS_ADMIN ? '<div class="pulse-panel" style="margin-bottom:14px"><div class="pp-title">Settlement approval threshold</div><div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap"><div><label class="form-label">Auto-approve at or below</label><input class="form-input mono" id="apThr" style="width:150px" inputmode="decimal" value="'+esc(String(CLAIM_SETTINGS.threshold||0))+'"/></div><div><label class="form-label">Currency</label><select class="form-select" id="apThrCur" style="width:110px"><option value="">any</option>'+['USD','EUR','GBP','EGP'].map(function(c){return '<option'+(CLAIM_SETTINGS.currency===c?' selected':'')+'>'+c+'</option>';}).join('')+'</select></div><button class="btn btn-secondary btn-sm" onclick="CRM.saveThreshold()">Save threshold</button><span class="cell-sub" style="max-width:260px">Settlements at or below this auto-close; above it need approval. <b>0 = every settlement needs approval.</b></span></div></div>' : '';
    vc.innerHTML='<div class="section-title"><span class="section-title-bar"></span>Claim Approvals <span class="section-count">loading…</span></div>'+thrPanel+'<div class="table-wrap"><div class="hint" style="padding:14px">Loading settlements awaiting approval…</div></div>';
    SB.from('crm_claims').select('id,claim_ref,client,sub_client,region_id,container_number,invoice_no,anchor,claimed_value,claimed_currency,settled_value,settled_currency,resolution_type,settlement_submitted_by,settlement_submitted_at').eq('season_id',SEASON).eq('status','pending').order('settlement_submitted_at',{ascending:true}).then(function(res){
      if(currentTab!=='approvals'||!MOUNTED) return;
      if(res&&res.error){ vc.innerHTML='<div class="empty-state">Failed to load approvals — '+esc(res.error.message||'')+'</div>'; return; }
      var list=(res&&res.data)||[];
      if(currentRegion!=='all') list=list.filter(function(x){return x.region_id===currentRegion;});
      var qq=(currentQuery||'').toLowerCase();
      if(qq) list=list.filter(function(x){return [x.claim_ref,x.client,x.sub_client,x.container_number,x.invoice_no].join(' ').toLowerCase().indexOf(qq)>=0;});
      var head='<div class="section-title"><span class="section-title-bar"></span>Claim Approvals <span class="section-count">'+list.length+' settlement'+(list.length===1?'':'s')+' awaiting approval</span></div>';
      if(!list.length){ vc.innerHTML=head+thrPanel+'<div class="table-wrap"><div class="empty-state">No settlements awaiting approval in this scope.<div class="cell-sub" style="margin-top:6px">Settlements appear here when the commercial team submits them for approval.</div></div></div>'; return; }
      function _ncn(v){ return String(v||'').toUpperCase().replace(/\s+/g,' ').trim(); }
      function _shipInv(cn){ var k=_ncn(cn); for(var i=0;i<SHIPMENTS.length;i++){ if(_ncn(SHIPMENTS[i].cn)===k) return SHIPMENTS[i].invoice||''; } return ''; }
      var rows=list.map(function(x){
        var claimed=x.claimed_value!=null?(Number(x.claimed_value).toLocaleString()+' '+esc(x.claimed_currency||'')):'—';
        var proposed=x.settled_value!=null?('<b>'+Number(x.settled_value).toLocaleString()+' '+esc(x.settled_currency||x.claimed_currency||'')+'</b>'):'—';
        var inv=x.invoice_no||_shipInv(x.container_number)||'—';
        var isRedir=REDIR_IN&&REDIR_IN.some(function(ri){ return _ncn(ri.originCn)===_ncn(x.container_number); });
        var redirChip=isRedir?' <span class="badge b-neutral" style="border-color:var(--green-border);color:var(--accent);background:var(--green-bg)" title="This container has a redirect — see its track history in the review">redirected</span>':'';
        var invCell='<span class="lot">'+esc(inv)+'</span>'+(x.anchor==='invoice'?'<div class="cell-sub">invoice claim</div>':'');
        var contCell=x.anchor==='invoice'?'<span class="cell-sub">multiple containers</span>':('<span class="lot">'+esc(x.container_number||'—')+'</span>'+redirChip);
        return '<tr class="click" role="button" tabindex="0" data-crm-act="reviewClaim" data-crm-key="'+esc(x.container_number||'')+'"><td><span class="lot">'+esc(x.claim_ref||'—')+'</span></td>'
          +'<td>'+esc(x.client||'—')+'<div class="cell-sub">'+esc(x.sub_client||'')+' · '+esc(regionLabel[x.region_id]||x.region_id||'')+'</div></td>'
          +'<td>'+invCell+'</td>'
          +'<td>'+contCell+'</td>'
          +'<td class="right"><span class="cell-sub" style="text-decoration:line-through">'+claimed+'</span> → '+proposed+(x.resolution_type?'<div class="cell-sub">'+esc(x.resolution_type)+'</div>':'')+'</td>'
          +'<td class="cell-sub">'+esc(fmtDate(x.settlement_submitted_at)||'')+'</td>'
          +'<td class="right"><button class="btn btn-primary btn-sm" data-crm-act="reviewClaim" data-crm-key="'+esc(x.container_number||'')+'">Review</button></td></tr>';
      }).join('');
      vc.innerHTML=head+thrPanel+'<div class="hint" style="margin:-4px 0 10px">Approve to close &amp; commit the settlement, or reject with a note to return it to the commercial team.</div><div class="table-wrap"><table class="wl"><thead><tr><th>Claim</th><th>Client</th><th>Invoice</th><th>Container</th><th class="right">Claimed → proposed</th><th>Submitted</th><th class="right">Action</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
    }).catch(function(e){ if(currentTab==='approvals') vc.innerHTML='<div class="empty-state">Failed to load approvals — '+esc((e&&e.message)||e)+'</div>'; });
  }
  /* ── Clean ── */
  function renderClean(){
    var vc=$('viewContent'); if(!vc) return;
    var list=visibleShipments().filter(isClean);
    var verified=list.filter(function(s){ return s.coverage!=='none'; });
    var nodata=list.filter(function(s){ return s.coverage==='none'; });
    var head='<div class="section-title"><span class="section-title-bar"></span>Clean <span class="section-count">'+verified.length+' verified · '+nodata.length+' with no quality data</span></div>';
    if(!list.length){ vc.innerHTML=head+'<div class="table-wrap"><div class="empty-state">No clean containers — every shipment here has a claim, a flag, or was returned.</div></div>'; return; }
    list.sort(function(a,b){ return b.sortKey-a.sortKey; });
    var clPage=pageState.clean;
    var rows=list.slice(clPage*PER_PAGE,(clPage+1)*PER_PAGE).map(function(s){
      var qc=s.cqc?bandBadge(s.cqc.score):(s.coverage==='graded'?'<span class="badge b-neutral" style="border-color:#c090e0;color:#6a10b0;background:#f0e8ff">CRM-graded '+esc(s.graded.grade)+'</span>':'<span class="cell-sub">no quality data</span>');
      return '<tr class="click" role="button" tabindex="0" data-crm-act="openShipDetail" data-crm-key="'+esc(s.key)+'"><td><span class="lot">'+esc(s.cn)+'</span></td>'+
        '<td>'+esc(s.client)+'<div class="cell-sub">'+esc(s.sub)+' · '+esc(regionLabel[s.region]||s.region)+'</div></td>'+
        '<td>'+esc(s.eta)+'</td><td>'+esc(s.statusLabel)+'</td><td>'+qc+'</td><td class="right">'
        +(s.coverage==='none'
            ?'<span class="badge b-neutral">No quality data</span>'
            :'<span class="badge b-pass">Clean (verified)</span>')+'</td></tr>';
    }).join('');
    vc.innerHTML=head+'<div class="table-wrap"><table class="wl"><thead><tr><th>Container</th><th>Client</th><th>ETA</th><th>Status</th><th>Quality</th><th class="right">Assessment</th></tr></thead><tbody>'+rows+'</tbody></table></div>'+pagerHtml(list.length,clPage,'clean');
  }

  /* ── Dashboard: region pulse + scorecards + attention cards ── */
  function streamBox(label,bodyHtml,actAttrs){
    var link=actAttrs?' link':'', open=actAttrs?'<span class="stream-open">open ↗</span>':'', attr=actAttrs||'';
    return '<div class="stream-box'+link+'"'+attr+'><div class="stream-head"><div class="stream-label">'+label+'</div>'+open+'</div>'+bodyHtml+'</div>';
  }
  function renderScorecards(){
    var list=visibleShipments(), groups={}, order=[];
    list.forEach(function(s){ if(!groups[s.sub]){ groups[s.sub]={sub:s.sub,client:s.client,ships:[]}; order.push(s.sub); } groups[s.sub].ships.push(s); });
    order.sort(function(a,b){ return groups[b].ships.length-groups[a].ships.length; });
    var visible=showAllSubs?order:order.slice(0,8);
    var cards=visible.map(function(k){
      var g=groups[k], scores;
      if(g.ships.length<=6){
        scores='<div class="scorecard-scores">'+g.ships.map(function(s){
          if(s.cqc) return '<span class="sc-chip '+(s.cqc.score&&s.cqc.score<=2?'good':(s.cqc.score===3?'fair':(s.cqc.score?'poor':'none')))+'" title="CQC · '+((BANDS[s.cqc.score]||{}).n||'')+'">'+(s.cqc.score||'?')+'</span>';
          if(s.coverage==='graded') return '<span class="sc-chip graded" title="CRM-graded">'+esc(s.graded.grade)+'</span>';
          return '<span class="sc-chip none" title="no quality data">–</span>';
        }).join('')+'</div>';
      } else {
        var d={g:0,f:0,p:0,gr:0,n:0};
        g.ships.forEach(function(s){ if(s.cqc){ if(s.cqc.score&&s.cqc.score<=2)d.g++; else if(s.cqc.score===3)d.f++; else d.p++; } else if(s.coverage==='graded')d.gr++; else d.n++; });
        var seg=function(n,cls){ return n?'<span class="'+cls+'" style="flex:'+n+'"></span>':''; };
        var leg=function(n,cls,label){ return n?'<i><b class="'+cls+'"></b>'+n+' '+label+'</i>':''; };
        scores='<div><div class="dist">'+seg(d.g,'dg')+seg(d.f,'df')+seg(d.p,'dp')+seg(d.gr,'dgr')+seg(d.n,'dn')+'</div><div class="dist-legend">'+leg(d.g,'dg','good')+leg(d.f,'df','fair')+leg(d.p,'dp','poor')+leg(d.gr,'dgr','graded')+leg(d.n,'dn','no data')+'</div></div>';
      }
      var claims=g.ships.filter(hasClaim).length;
      return '<div class="scorecard" data-crm-act="openSubDrill" data-crm-key="'+esc(k)+'"><div class="scorecard-top"><div style="min-width:0"><div class="scorecard-sub">'+esc(g.sub)+'</div><div class="scorecard-client">'+esc(g.client)+'</div></div><span class="scorecard-count">'+g.ships.length.toLocaleString()+'<small> shp</small></span></div>'+scores+'<div class="scorecard-foot">'+(claims?'<span class="badge b-fail">'+claims+' claim'+(claims>1?'s':'')+'</span>':'<span class="cell-sub">no claims</span>')+'<span class="scorecard-open">view shipments →</span></div></div>';
    }).join('');
    var more=order.length>8?'<div class="more-subs" onclick="CRM.toggleSubs()">'+(showAllSubs?'Show top 8 only':'+ '+(order.length-8)+' more sub-clients')+'</div>':'';
    return '<div class="section-title" style="padding-top:6px"><span class="section-title-bar"></span>Sub-client scorecards <span class="section-count">'+order.length+' sub-clients · sorted by volume</span></div><div class="scorecard-grid">'+cards+more+'</div>';
  }

  function pAvg(arr){ return arr.length?Math.round(arr.reduce(function(a,b){return a+b;},0)/arr.length*10)/10:null; }
  function claimAmt(v){ return num(v); }
  function sumsAdd(map,c){ if(!c.rawValue||c.potential) return; var k=curSym(c.currency); map[k]=(map[k]||0)+claimAmt(c.rawValue); }
  function sumsFmt(map){ var ks=Object.keys(map); if(!ks.length) return '—'; return ks.map(function(k){ var v=map[k]; return k+(v>=1000?(Math.round(v/100)/10)+'k':Math.round(v)); }).join('<br>'); }
  function renderRegionPulse(){
    var list=visibleShipments();
    var title='Region pulse — '+(currentRegion==='all'?'all regions':(regionLabel[currentRegion]||currentRegion));
    var head='<div class="attn-head" style="margin-top:2px"><div class="section-title" style="margin:0"><span class="section-title-bar"></span>'+title+' <span class="section-count">'+list.length.toLocaleString()+' shipments in scope</span></div><span class="link-btn" onclick="CRM.togglePulse()">'+(pulseOpen?'Hide stats':'Show stats')+'</span></div>';
    if(!pulseOpen||!list.length) return head;
    var cartons=0,netTons=0; list.forEach(function(s){ cartons+=s.cartons; netTons+=s.netTons; });
    var transit=list.filter(function(s){return s.status==='in_transit';});
    var arriving=transit.filter(function(s){return s.sortKey>=TODAY_KEY && s.sortKey<=TODAY_KEY+7;}).length;
    var delivered=list.filter(function(s){return s.status==='delivered';}).length;
    var claims=list.filter(hasClaim), openC=claims.filter(function(s){return s.claim.status==='open';}), pendingC=claims.filter(function(s){return s.claim.status==='pending';}), closedC=claims.filter(function(s){return s.claim.status==='closed';});
    var potC=claims.filter(function(s){return s.claim.potential;}).length;
    var openSums={},pendingSums={},closedSums={}; openC.forEach(function(s){sumsAdd(openSums,s.claim);}); pendingC.forEach(function(s){sumsAdd(pendingSums,s.claim);}); closedC.forEach(function(s){sumsAdd(closedSums,s.claim);});
    var cqcN=list.filter(function(s){return s.coverage==='cqc';}).length, grN=list.filter(function(s){return s.coverage==='graded';}).length;
    var noneList=list.filter(function(s){return s.coverage==='none';}), noneDelivered=noneList.filter(function(s){return s.status==='delivered';}).length;
    var tiles='<div class="kpi-grid" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr))">'+
      kpi('Shipments',list.length.toLocaleString(),cartons.toLocaleString()+' ctn · '+Math.round(netTons).toLocaleString()+' t net')+
      kpi('In transit',transit.length,arriving?arriving+' arriving ≤ 7 days':'none arriving this week',arriving?'up':'')+
      kpi('Delivered',delivered,(list.length?Math.round(delivered/list.length*100):0)+'% of shipments')+
      kpi('Claims',claims.length,openC.length+' open · '+potC+' potential',openC.length?'down':'',"CRM.setTab('claims')")+
      kpi('Awaiting approval',pendingC.length,pendingC.length?'settlements to review':'none pending',pendingC.length?'down':'up',IS_APPROVER?"CRM.setTab('approvals')":null)+
      kpi('Measured',cqcN,'CQC on file'+(grN?' · +'+grN.toLocaleString()+' CRM-graded':''))+
      kpi('Ungraded',noneList.length,noneDelivered?noneDelivered+' already delivered — chase CQC / grade':'all still in transit',noneDelivered?'down':'up',"CRM.pulseGo('score','none')")+'</div>';
    var sc=[0,0,0,0,0,0],grades={A:0,B:0,C:0},gaps=[],scores=[],flags=0;
    list.forEach(function(s){ if(s.cqc){ if(s.cqc.score) sc[s.cqc.score]++; scores.push(s.cqc.score); gaps.push(gapNum(s)); if(s.cqc.flag&&!s.claim) flags++; } else if(s.coverage==='graded' && grades[s.graded.grade]!=null) grades[s.graded.grade]++; });
    var gradeTotal=grades.A+grades.B+grades.C, maxCol=Math.max(sc[1],sc[2],sc[3],sc[4],sc[5],gradeTotal,1);
    function col(n,color,label){ return '<div class="pcol"><span style="height:'+Math.max(3,Math.round(n/maxCol*52))+'px;background:'+color+'"></span><i>'+label+'·'+n+'</i></div>'; }
    var claimsPanel='<div class="pulse-panel"><div class="pp-title">Claims pipeline · 3-state</div><div class="pipe"><span class="pstep" style="background:var(--red-bg);color:var(--red)">Open<b>'+openC.length+'</b><small>'+sumsFmt(openSums)+'</small></span><span class="pstep" style="background:var(--amber-bg);color:var(--amber)">Pending<b>'+pendingC.length+'</b><small>'+sumsFmt(pendingSums)+'</small></span><span class="pstep" style="background:var(--bg2);color:var(--text2)">Closed<b>'+closedC.length+'</b><small>'+sumsFmt(closedSums)+'</small></span></div><div class="pleg"><i>'+potC+' potential (value TBD)</i><i>'+pendingC.length+' awaiting approval</i><i>claim rate '+(list.length?Math.round(claims.length/list.length*1000)/10:0)+'%</i></div></div>';
    var qualityPanel='<div class="pulse-panel"><div class="pp-title">Quality mix · CQC scores &amp; CRM grades</div><div class="pcols">'+col(sc[1],'#4a8c62','Exc')+col(sc[2],'#7db894','Good')+col(sc[3],'#e8c87a','Fair')+col(sc[4],'#c86060','Poor')+col(sc[5],'#b03030','Rej')+col(gradeTotal,'#b490e0','ABC')+'</div><div class="pleg"><i>avg score '+(pAvg(scores.filter(Boolean))||'—')+'</i><i>avg gap '+(pAvg(gaps)!==null?'+'+pAvg(gaps)+'%':'—')+'</i>'+(flags?'<i style="color:var(--red)">'+flags+' CQC flags un-actioned</i>':'')+(gradeTotal?'<i>grades '+grades.A+'A / '+grades.B+'B / '+grades.C+'C</i>':'')+'</div></div>';
    var flowPanel='<div class="pulse-panel"><div class="pp-title">Status &amp; coverage flow</div><div class="flowbar"><span style="flex:'+transit.length+';background:#a0b4e8"></span><span style="flex:'+delivered+';background:#4a8c62"></span></div><div class="pleg" style="margin-bottom:9px"><i><b style="background:#a0b4e8"></b>'+transit.length+' in transit</i><i><b style="background:#4a8c62"></b>'+delivered+' delivered</i></div><div class="flowbar"><span style="flex:'+cqcN+';background:#4a8c62"></span><span style="flex:'+grN+';background:#b490e0"></span><span style="flex:'+noneList.length+';background:#bcb8ae"></span></div><div class="pleg"><i><b style="background:#4a8c62"></b>'+cqcN+' CQC</i><i><b style="background:#b490e0"></b>'+grN+' CRM-graded</i><i><b style="background:#bcb8ae"></b>'+noneList.length+' no data</i></div></div>';
    function rank(rows,maxN,go){
      return '<table class="rk">'+rows.map(function(r){
        var chip=r.open>0?'<span class="pchip warn">'+r.open+' open</span>':(r.rate!==undefined?'<span class="pchip '+(r.rate>10?'warn':'ok')+'">'+r.rate+'% claims</span>':'<span class="pchip mut">no claims</span>');
        return '<tr'+(go?' class="go" data-crm-act="pulseGo" data-crm-arg="'+esc(go)+'" data-crm-key="'+esc(r.k)+'"':'')+'><td class="nm">'+esc(r.k)+'</td><td class="bcol"><div class="bar"><span style="width:'+Math.round(r.n/maxN*100)+'%"></span></div></td><td class="num">'+r.n.toLocaleString()+' '+(r.unit||'shp')+'</td><td class="num"'+(r.avg!==null?' title="Average CQC score · 1 Excellent, 2 Good, 3 Fair, 4 Poor, 5 Reject — lower is better"':'')+'>'+(r.avg!==null?'avg '+r.avg:'—')+'</td><td style="text-align:right">'+chip+'</td></tr>';
      }).join('')+'</table>';
    }
    function groupStats(keyFn){
      var g={};
      list.forEach(function(s){ (keyFn(s)||[]).forEach(function(k){ if(!k) return; if(!g[k]) g[k]={k:k,n:0,scores:[],claims:0,open:0}; g[k].n++; if(s.cqc&&s.cqc.score) g[k].scores.push(s.cqc.score); if(s.claim){ g[k].claims++; if(s.claim.status==='open') g[k].open++; } }); });
      return Object.keys(g).map(function(k){ var r=g[k]; r.avg=pAvg(r.scores); r.rate=Math.round(r.claims/r.n*100); return r; }).sort(function(a,b){return b.n-a.n;}).slice(0,6);
    }
    var byClient=groupStats(function(s){return [s.sub];});
    var byVariety=groupStats(function(s){return s.varieties||[s.variety];});
    var byPh=groupStats(function(s){return s.packHouses||[];}); byPh.forEach(function(r){ r.unit='rows'; });
    var maxC=byClient.length?byClient[0].n:1, maxV=byVariety.length?byVariety[0].n:1, maxP=byPh.length?byPh[0].n:1;
    var breakdowns='<div class="pulse-panels"><div class="pulse-panel"><div class="pp-title">By sub-client · click → filtered list</div>'+rank(byClient,maxC,'sub')+'</div><div class="pulse-panel"><div class="pp-title">By variety · click → filtered list</div>'+rank(byVariety,maxV,'variety')+'</div><div class="pulse-panel"><div class="pp-title">By packhouse · from composition rows</div>'+rank(byPh,maxP,null)+'</div></div>'+'<div class="hint" style="text-align:center;margin:2px 0 4px"><b>avg</b> = average CQC score of the group · 1 Excellent → 5 Reject (lower is better) · &ldquo;—&rdquo; = no CQC yet</div>';
    var compare='';
    if(currentRegion==='all'){
      var rg={};
      list.forEach(function(s){ if(!rg[s.region]) rg[s.region]={n:0,t:0,d:0,open:0,cov:0,scores:[],claims:0}; var r=rg[s.region]; r.n++; if(s.status==='in_transit')r.t++; else if(s.status==='delivered')r.d++; if(s.coverage!=='none')r.cov++; if(s.cqc&&s.cqc.score)r.scores.push(s.cqc.score); if(s.claim){ r.claims++; if(s.claim.status==='open')r.open++; } });
      var rrows=Object.keys(rg).sort().map(function(id){ var r=rg[id]; return '<tr class="go" onclick="CRM.setRegion(\''+id+'\')"><td class="nm">'+esc(regionLabel[id]||id)+'</td><td class="num">'+r.n+'</td><td class="num">'+r.t+'</td><td class="num">'+r.d+'</td><td class="num" style="color:'+(r.open?'var(--red)':'var(--text2)')+'">'+r.open+'</td><td class="num">'+Math.round(r.cov/r.n*100)+'%</td><td class="num">'+(pAvg(r.scores)||'—')+'</td><td class="num">'+(Math.round(r.claims/r.n*1000)/10)+'%</td></tr>'; }).join('');
      compare='<div class="pulse-panel" style="margin-bottom:16px"><div class="pp-title">All-regions comparison · click a region to focus</div><table class="rk rk-compare"><tr style="font-weight:700;color:var(--text3)"><td>Region</td><td class="num">Shp</td><td class="num">Transit</td><td class="num">Delivered</td><td class="num">Open claims</td><td class="num">Coverage</td><td class="num">Avg score</td><td class="num">Claim rate</td></tr>'+rrows+'</table></div>';
    }
    return head+tiles+'<div class="pulse-panels">'+claimsPanel+qualityPanel+flowPanel+'</div>'+breakdowns+compare;
  }

  function renderCards(){
    var vc=$('viewContent'); if(!vc) return;
    var list=visibleShipments();
    var att=list.map(function(s){ var a=attentionInfo(s); return a?{s:s,a:a}:null; }).filter(Boolean).sort(function(x,y){ return y.a.p-x.a.p; });
    var cards=att.slice(0,6).map(function(x){return x.s;}).map(function(s){
      var attn=s.claim&&s.claim.status==='open'?' attn':'';
      var inspLine=s.insp?'<div class="stream-line"><span class="mono">'+esc(s.insp.id)+'</span> · '+esc(s.insp.defect)+' defect · '+esc(s.insp.decision)+'</div>':'<div class="stream-empty">no matched inspection</div>';
      var cqcLine;
      if(s.cqc){ cqcLine='<div class="stream-line" style="margin-bottom:5px">'+bandBadge(s.cqc.score)+'</div><div class="stream-line"><span class="mono">'+esc(s.cqc.id)+'</span> · '+esc(s.cqc.defect)+' defect · gap '+esc(s.cqc.gap)+'</div>'; }
      else if(s.coverage==='graded'){ cqcLine='<div class="stream-line"><span class="badge b-neutral" style="border-color:#c090e0;color:#6a10b0;background:#f0e8ff">CRM-graded '+esc(s.graded.grade)+'</span></div><div class="stream-line" style="margin-top:5px">Cause: '+esc(s.graded.cause)+'</div>'; }
      else { cqcLine='<div class="stream-empty">no CQC received</div>'; }
      var actions=(s.coverage==='none'||s.coverage==='graded')?'<button class="btn btn-secondary btn-sm" data-crm-act="openGrade" data-crm-key="'+esc(s.key)+'">'+(s.coverage==='graded'?'Edit grade':'Grade')+'</button>':'';
      actions+='<button class="btn btn-primary btn-sm" data-crm-act="openClaim" data-crm-key="'+esc(s.key)+'">'+(s.claim?'View claim':'Raise claim')+'</button>';
      return '<div class="ship-card'+attn+'"><div class="sc-head"><div class="sc-head-top"><div><span class="sc-container clickable" data-crm-act="openShipDetail" data-crm-key="'+esc(s.key)+'">'+esc(s.cn)+'</span>'+(s.split?'<span class="sc-split">split carta</span>':'')+'<div class="sc-meta">'+esc(s.vessel)+' · ETA '+esc(s.eta)+' · '+esc(s.port)+'</div></div><span class="region-chip">'+esc(regionLabel[s.region]||s.region)+'</span></div><div class="sc-client">'+esc(s.client)+' <span class="sub">· '+esc(s.sub)+' · '+esc(s.varieties?s.varieties.join(' / '):s.variety)+' · '+s.cartons.toLocaleString()+' ctn'+(s.rowCount>1?' · '+s.rowCount+' rows':'')+'</span></div></div><div class="sc-body"><div class="sc-status">'+statusBadge(s.status,s.statusLabel)+claimBadge(s.claim)+'</div><div class="stream">'+streamBox('Export inspection',inspLine,s.insp?' data-crm-act="openInsp" data-crm-key="'+esc(s.key)+'"':null)+streamBox('Client QC on arrival',cqcLine,s.cqc?' data-crm-act="openCqc" data-crm-key="'+esc(s.key)+'"':null)+'</div></div><div class="sc-foot">'+coverageBadge(s)+'<div class="sc-actions">'+actions+'</div></div></div>';
    }).join('');
    var head='<div class="attn-head"><div class="section-title" style="margin:0"><span class="section-title-bar"></span>Needs attention <span class="section-count">'+att.length.toLocaleString()+' of '+list.length.toLocaleString()+' shipments</span></div><span class="link-btn" onclick="CRM.setTab(\'shipments\')">All shipments ('+list.length.toLocaleString()+') →</span></div>';
    var body=att.length?'<div class="card-grid">'+cards+'</div>'+(att.length>6?'<div class="hint" style="text-align:center;margin-top:10px">Showing the top 6 — open claims first, then CQC flags, then coverage gaps. The rest live in the Shipments tab.</div>':''):'<div class="table-wrap"><div class="empty-state">Nothing needs attention — open claims, CQC flags and delivered-without-quality-data land here.</div></div>';
    vc.innerHTML=renderRegionPulse()+renderScorecards()+head+body;
  }

  /* ── Region mapping admin panel (writes region_overrides live) ── */
  function regionOptions(cur,includeUnassigned){
    return REGIONS.filter(function(r){ return r.id!=='all' && (includeUnassigned||r.id!=='unassigned'); }).map(function(r){ return '<option value="'+r.id+'"'+(cur===r.id?' selected':'')+'>'+esc(r.label)+'</option>'; }).join('');
  }
  function renderRegionMapping(){
    var vc=$('viewContent'); if(!vc) return;
    var counts={}; baseFiltered('region').forEach(function(s){ counts[s.region]=(counts[s.region]||0)+1; });
    var head='<div class="section-title" style="margin-top:2px"><span class="section-title-bar"></span>Region mapping <span class="section-count">seeded from Regions 2026 · overwrite assignments here</span></div>';
    var cards='<div class="scorecard-grid" style="margin-bottom:16px">'+REGIONS.filter(function(r){return r.id!=='all';}).map(function(r){
      return '<div class="scorecard" style="cursor:default"><div class="scorecard-top"><div><div class="scorecard-sub">'+esc(r.label)+'</div><div class="scorecard-client">'+(r.owner?'Owner · '+esc(r.owner):(r.id==='unassigned'?'needs a rule':''))+'</div></div><span class="scorecard-count">'+(counts[r.id]||0).toLocaleString()+'<small> shp</small></span></div></div>';
    }).join('')+'</div>';
    // Unassigned breakdown by client — the actionable lever (most unassigned have no country, so the country map can't reach them)
    var scoped=baseFiltered('region');
    var unByClient={}, unNoCountry=0, unTotal=0;
    scoped.forEach(function(s){ if(s.region==='unassigned'){ unTotal++; unByClient[s.client]=(unByClient[s.client]||0)+1; if(!s.country) unNoCountry++; } });
    var unClients=Object.keys(unByClient).sort(function(a,b){return unByClient[b]-unByClient[a];});
    var unRows=unClients.slice(0,20).map(function(c){
      return '<tr><td class="nm">'+esc(c)+'</td><td class="num">'+unByClient[c]+' shp</td><td class="right"><select class="scope-dd" data-crm-chg="setClientOverride" data-crm-key="'+esc(c)+'"><option value="">— assign region —</option>'+regionOptions('',false)+'</select></td></tr>';
    }).join('');
    var unassignedPanel=unTotal?('<div class="pulse-panel" style="margin-bottom:12px"><div class="pp-title">Unassigned · '+unTotal.toLocaleString()+' shipments · assign with a client rule'+(unNoCountry?' · <span style="color:var(--amber)">'+unNoCountry.toLocaleString()+' have no country on the shipment</span> — the country map below can\'t reach them, a client rule is the fix':'')+'</div><table class="rk"><tbody>'+unRows+'</tbody></table>'+(unClients.length>20?'<div class="hint">Showing the top 20 of '+unClients.length+' unassigned clients. Assigning a client rule moves every shipment for that client.</div>':'')+'</div>'):'';
    var clientKeys=Object.keys(REGION_OVERRIDES.client);
    var allClients=Array.from(new Set(SHIPMENTS.map(function(s){return s.client;}))).sort();
    var clientRows=clientKeys.length?clientKeys.map(function(c){
      return '<tr><td class="nm">'+esc(c)+'</td><td class="cell-sub">override</td><td class="right"><select class="scope-dd" data-crm-chg="setClientOverride" data-crm-key="'+esc(c)+'">'+regionOptions(REGION_OVERRIDES.client[c])+'<option value="__none">✕ remove rule</option></select></td></tr>';
    }).join(''):'<tr><td class="cell-sub" colspan="3">No client overrides yet.</td></tr>';
    var addClient='<div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="cell-sub">Add client rule:</span><select class="scope-dd" id="ovClient"><option value="">Client…</option>'+allClients.map(function(c){return '<option>'+esc(c)+'</option>';}).join('')+'</select><select class="scope-dd" id="ovClientRegion">'+regionOptions('ne')+'</select><button class="btn btn-secondary btn-sm" onclick="CRM.addClientOverrideFromForm()">Add</button></div>';
    var clientPanel='<div class="pulse-panel" style="margin-bottom:12px"><div class="pp-title">Client overrides · win over country defaults</div><table class="rk"><tbody>'+clientRows+'</tbody></table>'+addClient+'</div>';
    var allCountries=Object.keys(COUNTRY_REGION).concat(Object.keys(COUNTRY_OVERLAP)); allCountries.sort();
    var used={}; baseFiltered('region').forEach(function(s){ var k=(s.country||'').toLowerCase(); if(k) used[k]=(used[k]||0)+1; });
    var rows=allCountries.map(function(k){
      var overlap=COUNTRY_OVERLAP[k], eff=REGION_OVERRIDES.country[k]||COUNTRY_REGION[k]||null;
      var name=k.replace(/\b\w/g,function(m){return m.toUpperCase();});
      var flag=overlap&&!REGION_OVERRIDES.country[k]?'<span class="pchip warn">⚠ needs rule · '+overlap.map(function(x){return esc(regionLabel[x]||x);}).join(' / ')+'</span>':(REGION_OVERRIDES.country[k]?'<span class="pchip ok">override</span>':'<span class="pchip mut">default</span>');
      var sel='<select class="scope-dd" data-crm-chg="setCountryOverride" data-crm-key="'+esc(k)+'">'+(overlap&&!eff?'<option value="__def" selected>— pick region —</option>':'')+regionOptions(eff)+(REGION_OVERRIDES.country[k]?'<option value="__def">↺ back to file default</option>':'')+'</select>';
      return '<tr><td class="nm">'+esc(name)+'</td><td class="cell-sub">'+(used[k]?used[k]+' shp':'—')+'</td><td>'+flag+'</td><td class="right">'+sel+'</td></tr>';
    }).join('');
    var countryPanel='<div class="pulse-panel"><div class="pp-title">Country → region · '+Object.keys(COUNTRY_REGION).length+' mapped · '+Object.keys(COUNTRY_OVERLAP).length+' overlaps need a rule</div><div style="max-height:360px;overflow:auto"><table class="rk"><tbody>'+rows+'</tbody></table></div></div>';
    // score-band mapping panel
    var bandNames={1:'Excellent',2:'Good',3:'Fair',4:'Poor',5:'Reject'};
    function bandSel(cur,chgAttrs,withPick){ return '<select class="scope-dd"'+(chgAttrs||'')+'>'+(withPick?'<option value="">— pick band —</option>':'')+[1,2,3,4,5].map(function(n){return '<option value="'+n+'"'+(cur===n?' selected':'')+'>'+n+' · '+bandNames[n]+'</option>';}).join('')+'</select>'; }
    var bandKeys=Object.keys(BAND_MAP).sort();
    var bandRows=bandKeys.length?bandKeys.map(function(raw){ return '<tr><td class="nm">'+esc(raw)+'</td><td class="right">'+bandSel(BAND_MAP[raw],' data-crm-chg="setScoreBand" data-crm-key="'+esc(raw)+'"')+'</td><td class="right"><span class="link-btn" style="color:var(--red)" data-crm-act="removeScoreBand" data-crm-key="'+esc(raw)+'">remove</span></td></tr>'; }).join(''):'<tr><td class="cell-sub" colspan="3">No score bands mapped yet.</td></tr>';
    var unmapped={}; SHIPMENTS.forEach(function(s){ if(s.cqc&&!s.cqc.score&&s.cqc.scoreRaw){ var lc=s.cqc.scoreRaw.toLowerCase().trim(); if(!(lc in BAND_MAP)) unmapped[lc]=(unmapped[lc]||0)+1; } });
    var unmappedKeys=Object.keys(unmapped).sort();
    var unmappedRows=unmappedKeys.map(function(raw){ return '<tr><td class="nm">'+esc(raw)+' <span class="pchip warn">'+unmapped[raw]+' in view</span></td><td class="right">'+bandSel(0,' data-crm-chg="setScoreBand" data-crm-key="'+esc(raw)+'"',true)+'</td><td></td></tr>'; }).join('');
    var addBand='<div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="cell-sub">Add mapping:</span><input class="scope-dd" id="sbRaw" placeholder="raw score text (e.g. BLUE)" style="max-width:200px"/><select class="scope-dd" id="sbBand">'+[1,2,3,4,5].map(function(n){return '<option value="'+n+'"'+(n===2?' selected':'')+'>'+n+' · '+bandNames[n]+'</option>';}).join('')+'</select><button class="btn btn-secondary btn-sm" onclick="CRM.addScoreBandFromForm()">Add</button></div>';
    var scoreBandPanel='<div class="pulse-panel" style="margin-top:12px"><div class="pp-title">Score bands · raw CQC score → 1–5 canonical'+(unmappedKeys.length?' · <span style="color:var(--red)">'+unmappedKeys.length+' unmapped in view</span>':'')+'</div>'+(unmappedKeys.length?'<table class="rk"><tbody>'+unmappedRows+'</tbody></table><div class="divider" style="margin:10px 0"></div>':'')+'<table class="rk"><tbody>'+bandRows+'</tbody></table>'+addBand+'</div>';
    vc.innerHTML=rrToggleBar()+head+cards+unassignedPanel+clientPanel+countryPanel+scoreBandPanel;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     REGION RULES v2 — priority rule engine + identity bridge (behind a flag).
     Resolves region CLIENT-SIDE from region_rules + client_aliases (loaded from
     the additive Phase-2 tables). The old server-side path (crm_voyages region_id,
     region_overrides, setClientOverride/setCountryOverride) is left fully intact;
     flip CRM_REGION_RULES_V2=false to revert to it with no other change.
     ══════════════════════════════════════════════════════════════════════════ */
  /* in-app toggle: persisted in localStorage so it survives reload; default ON.
     Admins flip New⟷Old live from the Region screen — no redeploy. */
  var CRM_REGION_RULES_V2 = (function(){ try{ var v=localStorage.getItem('crm_region_rules_v2'); return v===null?true:v==='1'; }catch(e){ return true; } })();
  var RR_LIVE=[], RR_DRAFT=[], RR_HIST=[], RR_ALIASES={}, RR_CLIENTS=[], RR_SUBS=[];
  var RR_SHOWDEF=false, RR_WL=[], RR_UM=[], RR_EDIT=null;
  var RR_BAND={sub:1000, client:2000, ctyOvr:8000, ctyDef:9000};
  function rrNorm(x){ return String(x==null?'':x).trim().toLowerCase(); }
  function rrTitle(k){ return String(k==null?'':k).replace(/\b\w/g,function(m){return m.toUpperCase();}); }
  function rrRegionChip(id){ return '<span class="region-chip">'+esc(regionLabel[id]||id)+'</span>'; }
  function rrUuid(){ try{ if(window.crypto&&crypto.randomUUID) return crypto.randomUUID(); }catch(e){} return 'rr-'+Date.now()+'-'+Math.floor(Math.random()*1e9); }
  function rrClone(rs){ return rs.map(function(r){ var o={}; for(var k in r) o[k]=r[k]; return o; }); }
  function rrClientById(id){ for(var i=0;i<RR_CLIENTS.length;i++) if(RR_CLIENTS[i].id===id) return RR_CLIENTS[i]; return null; }
  function rrSubById(id){ for(var i=0;i<RR_SUBS.length;i++) if(RR_SUBS[i].id===id) return RR_SUBS[i]; return null; }
  function rrEntity(s){
    var clinorm=rrNorm(s.client), subnorm=rrNorm(s.sub);
    var aCli=RR_ALIASES[clinorm], aSub=RR_ALIASES[subnorm];
    var sid=(aSub&&aSub.sub_client_id)||null;
    var cid=(aCli&&aCli.client_id)||(aSub&&aSub.client_id)||(sid?((rrSubById(sid)||{}).client_id||null):null)||null;
    return { cid:cid, sid:sid, clc:clinorm==='—'?'':rrNorm(s.country), clinorm:clinorm, subnorm:subnorm };
  }
  function rrMatches(r, ctx){
    if(!r.enabled) return false;
    var has=false;
    if(r.sub_client_id){ has=true; if(r.sub_client_id!==ctx.sid) return false; }
    if(r.sub_client_norm){ has=true; if(r.sub_client_norm!==ctx.subnorm) return false; }
    if(r.client_id){ has=true; if(r.client_id!==ctx.cid) return false; }
    if(r.client_norm){ has=true; if(r.client_norm!==ctx.clinorm) return false; }
    if(r.country_lc){ has=true; if(r.country_lc!==ctx.clc) return false; }
    return has;
  }
  function rrResolve(rules, s){
    var ctx=rrEntity(s);
    var sorted=rules.slice().sort(function(a,b){ return a.priority-b.priority; });
    for(var i=0;i<sorted.length;i++){ if(rrMatches(sorted[i],ctx)) return {region:sorted[i].region_id, rule:sorted[i], ctx:ctx}; }
    return {region:'unassigned', rule:null, ctx:ctx};
  }
  function rrSimulate(rules){
    var counts={}, byRule={}, un=0;
    SHIPMENTS.forEach(function(s){ var r=rrResolve(rules,s); counts[r.region]=(counts[r.region]||0)+1; if(r.region==='unassigned') un++; if(r.rule) byRule[r.rule.id]=(byRule[r.rule.id]||0)+1; });
    return {counts:counts, byRule:byRule, unassigned:un};
  }
  function rrMovers(a,b){ var n=0; SHIPMENTS.forEach(function(s){ if(rrResolve(a,s).region!==rrResolve(b,s).region) n++; }); return n; }
  function rrDirty(){
    if(RR_LIVE.length!==RR_DRAFT.length) return true;
    var L={}; RR_LIVE.forEach(function(r){ L[r.id]=JSON.stringify(r); });
    for(var i=0;i<RR_DRAFT.length;i++){ var d=RR_DRAFT[i]; if(L[d.id]===undefined||L[d.id]!==JSON.stringify(d)) return true; }
    return false;
  }
  function rrPending(){
    var L={}; RR_LIVE.forEach(function(r){ L[r.id]=JSON.stringify(r); });
    var D={}; RR_DRAFT.forEach(function(r){ D[r.id]=JSON.stringify(r); });
    var n=0,k; for(k in D){ if(L[k]!==D[k]) n++; } for(k in L){ if(D[k]===undefined) n++; } return n;
  }
  function rrDraftById(id){ for(var i=0;i<RR_DRAFT.length;i++) if(RR_DRAFT[i].id===id) return RR_DRAFT[i]; return null; }
  /* app-wide region = committed (LIVE) so other tabs never shift mid-edit */
  function applyV2Regions(){ if(!CRM_REGION_RULES_V2||!RR_LIVE.length) return; SHIPMENTS.forEach(function(s){ if(s.redirectedIn) return; s.region=rrResolve(RR_LIVE,s).region; }); }
  /* the in-app engine toggle shown on the Region screen (admin only) */
  function rrToggleBar(){
    if(!IS_ADMIN) return '';
    return '<div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-bottom:8px">'+
      '<span class="pchip '+(CRM_REGION_RULES_V2?'ok':'mut')+'">Region engine · '+(CRM_REGION_RULES_V2?'New rules (v2)':'Old mapping (legacy)')+'</span>'+
      '<span class="link-btn" onclick="CRM.rrToggleEngine()">Switch to '+(CRM_REGION_RULES_V2?'old mapping':'new rules')+' →</span></div>';
  }
  function rrToggleEngine(){
    CRM_REGION_RULES_V2=!CRM_REGION_RULES_V2;
    try{ localStorage.setItem('crm_region_rules_v2', CRM_REGION_RULES_V2?'1':'0'); }catch(e){}
    var need=[loadVoyages()]; /* restores server region_id into SHIPMENTS (so OFF reverts cleanly) */
    if(CRM_REGION_RULES_V2 && !RR_LIVE.length) need=need.concat([loadRulesV2(),loadAliasesV2(),loadEntitiesV2()]);
    toast('Switching engine…');
    Promise.all(need).then(function(){ if(CRM_REGION_RULES_V2) applyV2Regions(); currentTab='regions'; render(); toast('Region engine: <b>'+(CRM_REGION_RULES_V2?'New rules (v2)':'Old mapping')+'</b>'); })
      .catch(function(e){ toast('Switch failed — '+esc(e&&e.message||e)); });
  }

  /* ── loaders (additive tables) ── */
  function loadRulesV2(){ return SB.from('region_rules').select('*').then(function(res){ if(res&&res.error) throw res.error; RR_LIVE=((res&&res.data)||[]).map(function(r){ return r; }); RR_DRAFT=rrClone(RR_LIVE); }); }
  function loadAliasesV2(){ return SB.from('client_aliases').select('alias_lc,client_id,sub_client_id').then(function(res){ if(res&&res.error) throw res.error; RR_ALIASES={}; ((res&&res.data)||[]).forEach(function(a){ RR_ALIASES[a.alias_lc]={client_id:a.client_id,sub_client_id:a.sub_client_id}; }); }); }
  function loadEntitiesV2(){ return Promise.all([
      SB.from('clients').select('id,name').then(function(r){ RR_CLIENTS=((r&&r.data)||[]); }),
      SB.from('sub_clients').select('id,client_id,name').then(function(r){ RR_SUBS=((r&&r.data)||[]); })
    ]); }

  /* ── the screen ── */
  function rrWhenChips(r){
    if(r.is_default) return '<span class="cell-sub">Country · '+esc(rrTitle(r.country_lc))+'</span>';
    var c=[];
    if(r.sub_client_id){ var s=rrSubById(r.sub_client_id); c.push('<span class="pchip mut">Sub · '+esc(s?s.name:'?')+'</span>'); }
    else if(r.sub_client_norm){ c.push('<span class="pchip mut">Sub · '+esc(r.sub_client_norm)+'</span>'); }
    if(r.client_id){ var cl=rrClientById(r.client_id); c.push('<span class="pchip mut">Client · '+esc(cl?cl.name:'?')+'</span>'); }
    else if(r.client_norm){ c.push('<span class="pchip mut">Client · '+esc(r.client_norm)+' <span style="opacity:.6">(unlinked)</span></span>'); }
    if(r.country_lc) c.push('<span class="pchip mut">Country · '+esc(rrTitle(r.country_lc))+'</span>');
    return c.join(' ') || '<span class="pchip warn">empty</span>';
  }
  function rrScoreBandPanelHtml(){
    var bandNames={1:'Excellent',2:'Good',3:'Fair',4:'Poor',5:'Reject'};
    function bandSel(cur,chg,withPick){ return '<select class="scope-dd"'+(chg||'')+'>'+(withPick?'<option value="">— pick band —</option>':'')+[1,2,3,4,5].map(function(n){return '<option value="'+n+'"'+(cur===n?' selected':'')+'>'+n+' · '+bandNames[n]+'</option>';}).join('')+'</select>'; }
    var keys=Object.keys(BAND_MAP).sort();
    var rows=keys.length?keys.map(function(raw){ return '<tr><td class="nm">'+esc(raw)+'</td><td class="right">'+bandSel(BAND_MAP[raw],' data-crm-chg="setScoreBand" data-crm-key="'+esc(raw)+'"')+'</td><td class="right"><span class="link-btn" style="color:var(--red)" data-crm-act="removeScoreBand" data-crm-key="'+esc(raw)+'">remove</span></td></tr>'; }).join(''):'<tr><td class="cell-sub" colspan="3">No score bands mapped yet.</td></tr>';
    var add='<div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="cell-sub">Add mapping:</span><input class="scope-dd" id="sbRaw" placeholder="raw score text (e.g. BLUE)" style="max-width:200px"/><select class="scope-dd" id="sbBand">'+[1,2,3,4,5].map(function(n){return '<option value="'+n+'"'+(n===2?' selected':'')+'>'+n+' · '+bandNames[n]+'</option>';}).join('')+'</select><button class="btn btn-secondary btn-sm" onclick="CRM.addScoreBandFromForm()">Add</button></div>';
    return '<div class="pulse-panel" style="margin-top:12px"><div class="pp-title">Score bands · raw CQC score → 1–5 canonical</div><table class="rk"><tbody>'+rows+'</tbody></table>'+add+'</div>';
  }
  /* ── Lead routing per region (Tarek: region-settings only, not a flip in the inbox) ──
     Claim ⇄ Assign segmented control (crm_set_region_routing) enabled for admin OR a manager of the
     region; a read-only chip otherwise. Admins also get a Members drawer to flag managers
     (crm_set_member_manager). Note: this screen is admin-gated (renderContent), so in practice admins
     drive it today; the control is written manager-aware for when/if the screen opens to managers. */
  function rrRoutingPanel(){
    var regs=REGIONS.filter(function(r){ return r.id!=='all' && !r.admin; });
    if(!regs.length) return '';
    var rows=regs.map(function(r){
      var mode=lmRoutingOf(r.id), canFlip=lmIsManagerOf(r.id);
      var seg=canFlip
        ? '<div class="region-switch"><span class="region-btn'+(mode==='claim'?' active':'')+'" onclick="CRM.rrSetRouting(\''+r.id+'\',\'claim\')">Claim</span><span class="region-btn'+(mode==='assign'?' active':'')+'" onclick="CRM.rrSetRouting(\''+r.id+'\',\'assign\')">Assign</span></div>'
        : '<span class="pchip '+(mode==='assign'?'ok':'mut')+'" title="only an admin or a manager of this region can change routing">'+(mode==='assign'?'Assign':'Claim')+'</span>';
      var mem=IS_ADMIN?'<span class="link-btn" onclick="CRM.rrMembersOpen(\''+r.id+'\')">Members ▾</span>':'';
      return '<tr><td class="nm">'+esc(r.label)+'</td><td>'+seg+'</td><td style="text-align:right">'+mem+'</td></tr>';
    }).join('');
    return '<div class="pulse-panel" style="margin-bottom:16px"><div class="pp-title">Lead routing · how each region gets its leads</div>'
      +'<div class="l-formnote" style="margin-bottom:9px"><b>Claim</b> — reps self-serve unclaimed leads from the inbox. <b>Assign</b> — a region manager assigns each lead to a member.'+(IS_ADMIN?' Use <b>Members</b> to flag who can assign.':'')+'</div>'
      +'<table class="rk"><tbody>'+rows+'</tbody></table></div>';
  }
  function rrSetRouting(region,mode){
    if(!lmIsManagerOf(region)){ toast('<b>Not permitted</b> · only an admin or a region manager can change routing.'); return; }
    mode=(mode==='assign')?'assign':'claim';
    if(lmRoutingOf(region)===mode) return;
    if(!SB){ toast('No connection.'); return; }
    var prev=regionRouting[region];
    regionRouting[region]=mode; renderRegionRulesV2();
    SB.rpc('crm_set_region_routing',{p_region:region,p_mode:mode}).then(function(res){
      if(res&&res.error){ regionRouting[region]=prev; renderRegionRulesV2(); toast('<b>Could not change routing.</b> '+esc(res.error.message||'')); return; }
      toast('Routing for <b>'+esc(regionLabel[region]||region)+'</b> → <b>'+(mode==='assign'?'Assign':'Claim')+'</b>.');
    }).catch(function(e){ regionRouting[region]=prev; renderRegionRulesV2(); toast('<b>Could not change routing.</b> '+esc(String(e))); });
  }
  /* Admin-only: mark region members as managers (crm_set_member_manager). Drawer lists members via
     crm_region_members with a Manager toggle each. */
  var rrMem={region:null,rows:[]};
  function rrMembersOpen(region){
    if(!IS_ADMIN){ toast('<b>Not permitted</b> · only admins manage region managers.'); return; }
    if(!SB){ toast('No connection.'); return; }
    rrMem={region:region,rows:[]};
    showDlv('Region members · '+(regionLabel[region]||region),'<div class="l-form"><div class="l-formnote">Loading members…</div></div>');
    SB.rpc('crm_region_members',{p_region:region}).then(function(res){
      if(res&&res.error){ toast('<b>Could not load members.</b> '+esc(res.error.message||'')); closeDlv(); return; }
      rrMem.rows=(res&&res.data)||[]; rrRenderMembers();
    }).catch(function(e){ toast('<b>Could not load members.</b> '+esc(String(e))); closeDlv(); });
  }
  function rrRenderMembers(){
    var region=rrMem.region;
    var list=rrMem.rows.length?rrMem.rows.map(function(m){
      var badge=m.is_manager?' <span class="pchip ok">Manager</span>':'';
      var btn='<button class="btn btn-'+(m.is_manager?'secondary':'primary')+' btn-sm" onclick="CRM.rrToggleManager(\''+esc(m.user_id)+'\','+(m.is_manager?'false':'true')+')">'+(m.is_manager?'Revoke manager':'Make manager')+'</button>';
      return '<div class="who" style="cursor:default"><div class="avatar">'+esc(lmInitials(m.full_name))+'</div><div style="flex:1;min-width:0"><div class="who-n">'+esc(m.full_name||'—')+badge+'</div><div class="who-s">'+esc(m.role||'member')+' · '+(m.open_load||0)+' open</div></div>'+btn+'</div>';
    }).join(''):'<div class="empty-state">No members in this region yet. Add them under Admin → Users → Region access.</div>';
    var body='<div class="l-form"><div class="l-formnote">Managers can assign leads to members and flip this region between <b>Claim</b> and <b>Assign</b> routing.</div>'
      +'<div class="l-qhdr">'+esc(regionLabel[region]||region)+'</div>'+list
      +'<div class="l-formact"><button class="btn btn-secondary" onclick="CRM.closeDlv()">Done</button></div></div>';
    var b=$('dlvBody'); if(b) b.innerHTML=body;
  }
  function rrToggleManager(userId,flag){
    var region=rrMem.region; if(!region) return;
    if(!SB){ toast('No connection.'); return; }
    SB.rpc('crm_set_member_manager',{p_region:region,p_user:userId,p_flag:!!flag}).then(function(res){
      if(res&&res.error){ toast('<b>Could not update.</b> '+esc(res.error.message||'')); return; }
      for(var i=0;i<rrMem.rows.length;i++) if(rrMem.rows[i].user_id===userId) rrMem.rows[i].is_manager=!!flag;
      rrRenderMembers(); toast('Manager '+(flag?'granted':'revoked')+'.');
    }).catch(function(e){ toast('<b>Could not update.</b> '+esc(String(e))); });
  }
  function renderRegionRulesV2(){
    var vc=$('viewContent'); if(!vc) return;
    var sim=rrSimulate(RR_DRAFT), counts=sim.counts;
    var liveUn=rrSimulate(RR_LIVE).unassigned, dirty=rrDirty();
    var head='<div class="section-title" style="margin-top:2px"><span class="section-title-bar"></span>Region rules <span class="section-count">first matching rule by priority wins · anchored to client identity</span></div>';
    var commit='';
    if(dirty){
      var mv=rrMovers(RR_LIVE,RR_DRAFT), pend=rrPending();
      commit='<div class="pulse-panel" style="margin-bottom:14px;border-color:var(--amber-border);background:var(--amber-bg)"><div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">'+
        '<div style="font-size:13px;color:var(--text)"><b style="font-family:var(--font-mono)">'+pend+'</b> pending change'+(pend===1?'':'s')+' · <b style="font-family:var(--font-mono)">'+mv.toLocaleString()+'</b> shipments will move · Unassigned <b class="mono">'+liveUn.toLocaleString()+'</b> → <b class="mono">'+sim.unassigned.toLocaleString()+'</b></div>'+
        '<div style="display:flex;gap:8px"><button class="btn btn-secondary btn-sm" onclick="CRM.rrDiscard()">Discard</button><button class="btn btn-primary btn-sm" onclick="CRM.rrCommit()">Commit</button></div></div></div>';
    } else if(RR_HIST.length){ commit='<div style="margin-bottom:12px;font-size:11px;color:var(--text3)">Committed. <span class="link-btn" onclick="CRM.rrUndo()">↺ Undo last commit</span></div>'; }
    var cards='<div class="scorecard-grid" style="margin-bottom:16px">'+REGIONS.filter(function(r){return r.id!=='all';}).map(function(r){
      var amber=r.id==='unassigned'&&(counts[r.id]||0)>0;
      return '<div class="scorecard" style="cursor:default'+(amber?';border-color:var(--amber-border);background:var(--amber-bg)':'')+'"><div class="scorecard-top"><div><div class="scorecard-sub">'+esc(r.label)+'</div><div class="scorecard-client">'+(r.owner?'Owner · '+esc(r.owner):(r.id==='unassigned'?(amber?'needs rules ↓':'clear'):''))+'</div></div><span class="scorecard-count">'+(counts[r.id]||0).toLocaleString()+'<small> shp</small></span></div></div>';
    }).join('')+'</div>';
    var active=RR_DRAFT.filter(function(r){return !r.is_default;}).sort(function(a,b){return a.priority-b.priority;});
    var ruleRows=active.length?active.map(function(r){
      var wins=sim.byRule[r.id]||0, shadow=(wins===0)?' <span class="pchip warn" title="no shipment currently matches before a higher rule">shadowed</span>':'';
      return '<tr style="'+(r.enabled?'':'opacity:.5;')+'"><td class="rr-when">'+rrWhenChips(r)+'</td><td>→ '+rrRegionChip(r.region_id)+'</td><td class="num">'+wins+shadow+'</td>'+
        '<td class="rr-act"><span class="link-btn" title="up" onclick="CRM.rrMove(\''+r.id+'\',-1)">▲</span><span class="link-btn" title="down" onclick="CRM.rrMove(\''+r.id+'\',1)">▼</span><span class="link-btn" onclick="CRM.rrToggle(\''+r.id+'\')">'+(r.enabled?'disable':'enable')+'</span><span class="link-btn" onclick="CRM.rrOpenDrawer(\''+r.id+'\')">edit</span><span class="link-btn" style="color:var(--red)" onclick="CRM.rrDelete(\''+r.id+'\')">✕</span></td></tr>';
    }).join(''):'<tr><td class="cell-sub" colspan="4">No client/sub-client/country rules yet — add one or work the queue below.</td></tr>';
    var defs=RR_DRAFT.filter(function(r){return r.is_default;}).sort(function(a,b){return a.priority-b.priority;});
    var rulePanel='<div class="pulse-panel" style="margin-bottom:12px"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:9px"><div class="pp-title" style="margin:0">Rules · precedence top → bottom</div><button class="btn btn-primary btn-sm" onclick="CRM.rrOpenDrawer(null)">+ Add rule</button></div>'+
      '<div class="rk-scroll"><table class="rk rk-rules"><thead><tr><td>When</td><td>Then</td><td class="num">Wins</td><td class="rr-act"></td></tr></thead><tbody>'+ruleRows+'</tbody></table></div>'+
      '<div style="margin-top:8px;font-size:11px;color:var(--text3)">＋ <span class="link-btn" onclick="CRM.rrToggleDefaults()">'+(RR_SHOWDEF?'Hide':'Show')+' '+defs.length+' country defaults</span> (lowest priority)</div>'+
      (RR_SHOWDEF?('<div style="max-height:240px;overflow:auto;margin-top:6px"><table class="rk rk-rules"><tbody>'+defs.map(function(r){ return '<tr><td class="rr-when">'+esc(rrTitle(r.country_lc))+'</td><td>→ '+rrRegionChip(r.region_id)+'</td><td class="num">'+(sim.byRule[r.id]||0)+'</td></tr>'; }).join('')+'</tbody></table></div>'):'')+'</div>';
    /* Unassigned worklist */
    RR_WL=[]; var seen={};
    SHIPMENTS.forEach(function(s){ if(rrResolve(RR_DRAFT,s).region!=='unassigned') return; var ctx=rrEntity(s); var key=(ctx.cid||'?')+'|'+(ctx.sid||'')+'|'+ctx.clc+'|'+s.client; if(!seen[key]){ seen[key]={cid:ctx.cid,sid:ctx.sid,clc:ctx.clc,client:s.client,sub:s.sub,country:s.country,cn:s.cn,n:0}; RR_WL.push(seen[key]); } seen[key].n++; });
    RR_WL.sort(function(a,b){return b.n-a.n;});
    var wlRows=RR_WL.length?RR_WL.slice(0,40).map(function(w,i){ var idc=w.cid?'':' <span class="pchip warn" title="not linked to a canonical client">no identity</span>'; return '<tr><td class="rr-when"><b>'+esc(w.client||'—')+'</b>'+(w.sub&&w.sub!=='—'?' <span class="cell-sub">· '+esc(w.sub)+'</span>':'')+idc+'</td><td class="cell-sub">'+esc(w.country||'—')+'</td><td class="num">'+w.n+' shp</td><td class="rr-act"><span class="link-btn" onclick="CRM.rrWhy('+i+')">why?</span><span class="link-btn" onclick="CRM.rrCreateFor('+i+')">create rule →</span></td></tr>'; }).join(''):'<tr><td class="cell-sub" colspan="4">🎉 Nothing unassigned under the current draft.</td></tr>';
    var wlPanel='<div class="pulse-panel" style="margin-bottom:12px"><div class="pp-title">Unassigned worklist · '+RR_WL.length+' to resolve ('+sim.unassigned.toLocaleString()+' shipments)'+(RR_WL.length>40?' · showing top 40':'')+'</div><div class="rk-scroll"><table class="rk rk-rules"><tbody>'+wlRows+'</tbody></table></div></div>';
    /* alias reconciliation entry */
    RR_UM=rrComputeUnmatched();
    var umPanel='<div class="pulse-panel" style="margin-bottom:12px"><div style="display:flex;align-items:center;justify-content:space-between"><div class="pp-title" style="margin:0">Alias reconciliation · '+RR_UM.length+' shipment name'+(RR_UM.length===1?'':'s')+' not linked to a client</div>'+(RR_UM.length?'<button class="btn btn-secondary btn-sm" onclick="CRM.rrOpenAlias()">Reconcile →</button>':'<span class="pchip ok">all linked</span>')+'</div>'+(RR_UM.length?'<div class="cell-sub" style="margin-top:6px">These spellings on shipments don\'t match a canonical client, so identity rules can\'t reach them. Map each to fix at the source.</div>':'')+'</div>';
    vc.innerHTML=rrToggleBar()+head+commit+cards+rrRoutingPanel()+rulePanel+wlPanel+umPanel+rrScoreBandPanelHtml();
  }
  function rrComputeUnmatched(){
    var out=[], seen={};
    SHIPMENTS.forEach(function(s){ [['client',s.client],['sub',s.sub]].forEach(function(p){ var raw=p[1]; if(!raw||raw==='—') return; var k=rrNorm(raw); if(RR_ALIASES[k]||seen[k]) return; seen[k]=1; out.push({raw:raw,key:k,kind:p[0],suggest:rrFuzzy(raw)}); }); });
    return out;
  }
  function rrFuzzy(raw){
    var r=rrNorm(raw), best=null, bs=0;
    function sc(a,b){ if(a===b) return 1; if(a.indexOf(b)>=0||b.indexOf(a)>=0) return 0.8; var ta=a.split(/\s+/),n=0; ta.forEach(function(t){ if(t.length>2&&b.indexOf(t)>=0) n++; }); return n/Math.max(ta.length,1)*0.7; }
    RR_CLIENTS.forEach(function(c){ var v=sc(r,rrNorm(c.name)); if(v>bs){bs=v;best={type:'client',id:c.id,name:c.name};} });
    RR_SUBS.forEach(function(s){ var v=sc(r,rrNorm(s.name)); if(v>bs){bs=v;best={type:'sub',id:s.id,name:s.name};} });
    return bs>=0.55?best:null;
  }
  /* ── editing (operates on RR_DRAFT; persisted on Commit) ── */
  function rrToggleDefaults(){ RR_SHOWDEF=!RR_SHOWDEF; renderRegionRulesV2(); }
  function rrToggle(id){ var r=rrDraftById(id); if(r){ r.enabled=!r.enabled; renderRegionRulesV2(); } }
  function rrDelete(id){ RR_DRAFT=RR_DRAFT.filter(function(r){return r.id!==id;}); renderRegionRulesV2(); }
  function rrMove(id,dir){ var r=rrDraftById(id); if(!r) return; var peers=RR_DRAFT.filter(function(x){return !x.is_default;}).sort(function(a,b){return a.priority-b.priority;}); var i=peers.indexOf(r), j=i+dir; if(j<0||j>=peers.length) return; var t=r.priority; r.priority=peers[j].priority; peers[j].priority=t; renderRegionRulesV2(); }
  function rrCreateFor(i){ var w=RR_WL[i]; rrOpenDrawer(null,{client_id:w.cid,sub_client_id:w.sid,country_lc:(w.cid?null:w.clc)}); }
  function rrOpenDrawer(id,prefill){
    var r=id?rrDraftById(id):null;
    RR_EDIT={ id:id||null, _tmp:id||rrUuid(), client_id:(r?r.client_id:(prefill&&prefill.client_id))||'', sub_client_id:(r?r.sub_client_id:(prefill&&prefill.sub_client_id))||'', country_lc:(r?r.country_lc:(prefill&&prefill.country_lc))||'', region_id:(r?r.region_id:'')||'', note:(r?r.note:'')||'' };
    $('dlvTitle').innerHTML=id?'Edit rule':'Add rule';
    $('dlvBody').innerHTML=rrFormHtml();
    $('dlv').classList.add('open');
    rrUpdatePreview();
  }
  function rrSubOptions(cid){ var subs=RR_SUBS.filter(function(s){return !cid||s.client_id===cid;}).sort(function(a,b){return a.name.localeCompare(b.name);}); return '<option value="">— any / whole client —</option>'+subs.map(function(s){return '<option value="'+s.id+'"'+(RR_EDIT.sub_client_id===s.id?' selected':'')+'>'+esc(s.name)+'</option>';}).join(''); }
  function rrFormHtml(){
    var clientOpts='<option value="">— any client —</option>'+RR_CLIENTS.slice().sort(function(a,b){return a.name.localeCompare(b.name);}).map(function(c){return '<option value="'+c.id+'"'+(RR_EDIT.client_id===c.id?' selected':'')+'>'+esc(c.name)+'</option>';}).join('');
    var ctys=Object.keys(COUNTRY_REGION).concat(Object.keys(COUNTRY_OVERLAP)).filter(function(v,ix,a){return a.indexOf(v)===ix;}).sort();
    var ctyOpts='<option value="">— any country —</option>'+ctys.map(function(k){return '<option value="'+esc(k)+'"'+(RR_EDIT.country_lc===k?' selected':'')+'>'+esc(rrTitle(k))+(COUNTRY_OVERLAP[k]?' ⚠':'')+'</option>';}).join('');
    return '<div style="display:flex;flex-direction:column;gap:12px">'+
      '<div><label class="cell-sub">Client</label><br><select class="scope-dd" style="max-width:none;width:100%" onchange="CRM.rrSetField(\'client_id\',this.value)">'+clientOpts+'</select></div>'+
      '<div><label class="cell-sub">Sub-client (optional — beats the client rule)</label><br><select class="scope-dd" id="rrSub" style="max-width:none;width:100%" onchange="CRM.rrSetField(\'sub_client_id\',this.value)">'+rrSubOptions(RR_EDIT.client_id)+'</select></div>'+
      '<div><label class="cell-sub">Country (optional)</label><br><select class="scope-dd" style="max-width:none;width:100%" onchange="CRM.rrSetField(\'country_lc\',this.value)">'+ctyOpts+'</select></div>'+
      '<div><label class="cell-sub">Assign to region</label><br><select class="scope-dd" style="max-width:none;width:100%" onchange="CRM.rrSetField(\'region_id\',this.value)"><option value="">— pick region —</option>'+regionOptions(RR_EDIT.region_id,true)+'</select></div>'+
      '<div><label class="cell-sub">Note (shown in “why?”)</label><br><input class="form-input" value="'+esc(RR_EDIT.note||'')+'" oninput="CRM.rrSetField(\'note\',this.value)"></div>'+
      '<div class="pulse-panel" id="rrPreview" style="background:var(--bg2)"></div>'+
      '<div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn btn-secondary" onclick="CRM.closeDlv()">Cancel</button><button class="btn btn-primary" onclick="CRM.rrSaveRule()">Save rule</button></div></div>';
  }
  function rrSetField(f,v){ RR_EDIT[f]=v; if(f==='client_id'){ RR_EDIT.sub_client_id=''; var el=$('rrSub'); if(el) el.innerHTML=rrSubOptions(v); } rrUpdatePreview(); }
  function rrDraftFromEdit(){
    var e=RR_EDIT, band=e.sub_client_id?RR_BAND.sub:(e.client_id?RR_BAND.client:RR_BAND.ctyOvr);
    var cid=e.client_id||(e.sub_client_id?((rrSubById(e.sub_client_id)||{}).client_id||null):null)||null;
    var prio=e.id?rrDraftById(e.id).priority:(band+RR_DRAFT.filter(function(r){return Math.floor(r.priority/1000)===Math.floor(band/1000);}).length+1);
    return { id:e.id||e._tmp, enabled:true, priority:prio, sub_client_id:e.sub_client_id||null, client_id:cid, sub_client_norm:null, client_norm:null, country_lc:e.country_lc||null, region_id:e.region_id, note:e.note||'', is_default:false };
  }
  function rrUpdatePreview(){
    var box=$('rrPreview'); if(!box) return;
    if(!RR_EDIT.region_id || (!RR_EDIT.client_id && !RR_EDIT.sub_client_id && !RR_EDIT.country_lc)){ box.innerHTML='<span class="cell-sub">Pick at least one condition and a target region to preview impact.</span>'; return; }
    var nr=rrDraftFromEdit();
    var temp=RR_DRAFT.filter(function(r){return r.id!==nr.id;}).map(function(r){var o={};for(var k in r)o[k]=r[k];return o;}); temp.push(nr);
    var before=rrSimulate(RR_DRAFT), after=rrSimulate(temp), wins=after.byRule[nr.id]||0, mv=rrMovers(RR_DRAFT,temp);
    box.innerHTML='<div style="font-size:12px;color:var(--text)">This rule wins <b class="mono">'+wins+'</b> shipment'+(wins===1?'':'s')+' · <b class="mono">'+mv+'</b> move · Unassigned <b class="mono">'+before.unassigned.toLocaleString()+'</b> → <b class="mono">'+after.unassigned.toLocaleString()+'</b></div>';
  }
  function rrSaveRule(){
    if(!RR_EDIT.region_id){ toast('Pick a target region.'); return; }
    if(!RR_EDIT.client_id && !RR_EDIT.sub_client_id && !RR_EDIT.country_lc){ toast('Pick at least one condition.'); return; }
    var nr=rrDraftFromEdit(); RR_DRAFT=RR_DRAFT.filter(function(r){return r.id!==nr.id;}); RR_DRAFT.push(nr);
    closeDlv(); renderRegionRulesV2(); toast('Rule staged. <b>Commit</b> to apply.');
  }
  function rrRowForDb(r){ return { id:r.id, priority:r.priority, enabled:r.enabled, sub_client_id:r.sub_client_id||null, client_id:r.client_id||null, sub_client_norm:r.sub_client_norm||null, client_norm:r.client_norm||null, country_lc:r.country_lc||null, region_id:r.region_id, note:r.note||null, is_default:!!r.is_default, set_by:(USER&&USER.id)||null, updated_at:new Date().toISOString() }; }
  function rrCommit(){
    var liveIds={}; RR_LIVE.forEach(function(r){ liveIds[r.id]=1; });
    var draftIds={}; RR_DRAFT.forEach(function(r){ draftIds[r.id]=1; });
    var removed=Object.keys(liveIds).filter(function(id){ return !draftIds[id]; });
    var rows=RR_DRAFT.map(rrRowForDb);
    toast('Committing…');
    SB.from('region_rules').upsert(rows,{onConflict:'id'}).then(function(res){
      if(res&&res.error) throw res.error;
      return removed.length ? SB.from('region_rules').delete().in('id',removed) : Promise.resolve({});
    }).then(function(res){
      if(res&&res.error) throw res.error;
      RR_HIST.push(rrClone(RR_LIVE)); RR_LIVE=rrClone(RR_DRAFT); applyV2Regions(); render();
      toast('Rules committed. <span class="link-btn" onclick="CRM.rrUndo()">Undo</span>');
    }).catch(function(e){ toast('Commit failed — '+esc(e&&e.message||e)); });
  }
  function rrDiscard(){ RR_DRAFT=rrClone(RR_LIVE); renderRegionRulesV2(); toast('Draft discarded.'); }
  function rrUndo(){
    if(!RR_HIST.length){ toast('Nothing to undo.'); return; }
    var prev=RR_HIST[RR_HIST.length-1];
    var prevIds={}; prev.forEach(function(r){ prevIds[r.id]=1; });
    var curIds={}; RR_LIVE.forEach(function(r){ curIds[r.id]=1; });
    var removed=Object.keys(curIds).filter(function(id){ return !prevIds[id]; });
    toast('Undoing…');
    SB.from('region_rules').upsert(prev.map(rrRowForDb),{onConflict:'id'}).then(function(res){
      if(res&&res.error) throw res.error;
      return removed.length ? SB.from('region_rules').delete().in('id',removed) : Promise.resolve({});
    }).then(function(res){
      if(res&&res.error) throw res.error;
      RR_HIST.pop(); RR_LIVE=rrClone(prev); RR_DRAFT=rrClone(prev); applyV2Regions(); render();
      toast('Reverted to previous committed rules.');
    }).catch(function(e){ toast('Undo failed — '+esc(e&&e.message||e)); });
  }
  /* ── alias reconciliation (applies immediately; identity is curation, not a rule) ── */
  function rrOpenAlias(){ $('dlvTitle').innerHTML='Reconcile client aliases'; $('dlvBody').innerHTML=rrAliasHtml(); $('dlv').classList.add('open'); }
  function rrAliasHtml(){
    if(!RR_UM.length) return '<div class="cell-sub">All shipment names are linked. 🎉</div>';
    return '<div class="cell-sub" style="margin-bottom:10px">Map each unlinked shipment spelling to a canonical client or sub-client. Applies immediately and re-resolves regions.</div>'+RR_UM.map(function(u,i){
      var opts='<option value="">— pick entity —</option><optgroup label="Clients">'+RR_CLIENTS.slice().sort(function(a,b){return a.name.localeCompare(b.name);}).map(function(c){return '<option value="client:'+c.id+'"'+(u.suggest&&u.suggest.type==='client'&&u.suggest.id===c.id?' selected':'')+'>'+esc(c.name)+'</option>';}).join('')+'</optgroup><optgroup label="Sub-clients">'+RR_SUBS.slice().sort(function(a,b){return a.name.localeCompare(b.name);}).map(function(s){return '<option value="sub:'+s.id+'"'+(u.suggest&&u.suggest.type==='sub'&&u.suggest.id===s.id?' selected':'')+'>'+esc(s.name)+'</option>';}).join('')+'</optgroup>';
      return '<div style="padding:9px 0;border-bottom:1px solid var(--bg2)"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><div><b>'+esc(u.raw)+'</b> <span class="pchip mut">'+u.kind+'</span></div>'+(u.suggest?'<span class="pchip ok">≈ '+esc(u.suggest.name)+'</span>':'<span class="pchip warn">no match</span>')+'</div><div style="display:flex;gap:8px;margin-top:6px"><select class="scope-dd" id="rrAl'+i+'" style="max-width:none;flex:1">'+opts+'</select><button class="btn btn-primary btn-sm" onclick="CRM.rrMapAlias('+i+')">Map</button></div></div>';
    }).join('');
  }
  function rrMapAlias(i){
    var u=RR_UM[i], el=$('rrAl'+i), val=el&&el.value; if(!val){ toast('Pick an entity.'); return; }
    var parts=val.split(':'), row={alias_lc:u.key, confidence:'manual', set_by:(USER&&USER.id)||null};
    if(parts[0]==='client'){ row.client_id=parts[1]; row.sub_client_id=null; } else { var sc=rrSubById(parts[1]); row.sub_client_id=parts[1]; row.client_id=sc?sc.client_id:null; }
    toast('Mapping…');
    SB.from('client_aliases').upsert(row,{onConflict:'alias_lc'}).then(function(res){
      if(res&&res.error) throw res.error;
      RR_ALIASES[u.key]={client_id:row.client_id,sub_client_id:row.sub_client_id||null};
      applyV2Regions(); RR_UM=rrComputeUnmatched(); $('dlvBody').innerHTML=rrAliasHtml(); render();
      toast('Alias mapped · <b>'+esc(u.raw)+'</b> linked.');
    }).catch(function(e){ toast('Map failed — '+esc(e&&e.message||e)); });
  }
  /* ── why this region? ── */
  function rrWhy(i){
    var w=RR_WL[i]; if(!w) return;
    var s=null, j; for(j=0;j<SHIPMENTS.length;j++){ if(SHIPMENTS[j].cn===w.cn){ s=SHIPMENTS[j]; break; } }
    if(!s){ return; }
    var ctx=rrEntity(s), won=rrResolve(RR_DRAFT,s);
    var sorted=RR_DRAFT.slice().sort(function(a,b){return a.priority-b.priority;}).filter(function(r){ return !r.is_default || r.country_lc===ctx.clc; });
    var lines=sorted.map(function(r){ var match=rrMatches(r,ctx), isWon=won.rule&&won.rule.id===r.id; return '<div style="display:flex;justify-content:space-between;gap:8px;padding:4px 0;'+(isWon?'background:var(--green-bg);border-radius:6px;padding-left:6px;padding-right:6px':'')+'"><span'+(isWon?' style="color:var(--accent);font-weight:600"':(match?'':' style="opacity:.5"'))+'>'+rrWhenChips(r)+' → '+rrRegionChip(r.region_id)+'</span><span class="cell-sub">'+(isWon?'✓ wins':(match?'match (lower)':'—'))+'</span></div>'; }).join('');
    $('dlvTitle').innerHTML='Why this region?';
    $('dlvBody').innerHTML='<div class="cell-sub" style="margin-bottom:8px">'+esc(w.client||'—')+(w.sub&&w.sub!=='—'?' · '+esc(w.sub):'')+' · '+esc(w.country||'—')+' · '+(ctx.cid?('linked → '+esc((rrClientById(ctx.cid)||{}).name||'?')):'<span class="pchip warn">no canonical identity</span>')+'</div><div style="margin-bottom:10px">Resolved region: '+rrRegionChip(won.region)+'</div><div class="pp-title">Rules evaluated (by priority)</div>'+(lines||'<span class="cell-sub">No rules apply — falls through to Unassigned.</span>')+(won.region==='unassigned'?'<div class="cell-sub" style="margin-top:10px">Nothing matched. '+(ctx.cid?'Add a client/sub rule above.':'Link this name in <span class="link-btn" onclick="CRM.rrOpenAlias()">alias reconciliation</span> first.')+'</div>':'');
    $('dlv').classList.add('open');
  }

  function renderContent(){
    if(currentTab==='regions' && !(IS_ADMIN&&currentRegion==='all')) currentTab='dashboard';
    if(currentTab==='approvals' && !IS_APPROVER) currentTab='dashboard';
    var _isLeads=LEADS_TABS.indexOf(currentTab)>=0;   /* Leads (draft) surfaces have their own toolbar */
    if(ROOT){ var _rn=ROOT.querySelector('.region-note'); if(_rn) _rn.style.display=_isLeads?'none':''; var _sb=ROOT.querySelector('.subbar'); if(_sb) _sb.style.display=_isLeads?'none':''; }
    if(currentTab==='leads')     return renderLeads();
    if(currentTab==='inbox')     return renderInbox();
    if(currentTab==='funnel')    return renderLeadFunnel();
    if(currentTab==='campaigns') return renderCampaigns();
    if(currentTab==='dashboard') return renderCards();
    if(currentTab==='invoices')  return renderInvoices();
    if(currentTab==='redirects') return renderRedirects();
    if(currentTab==='shipments') return renderShipmentsTable();
    if(currentTab==='grading')   return renderGradingQueue();
    if(currentTab==='claims')    return renderClaims();
    if(currentTab==='approvals') return renderApprovals();
    if(currentTab==='clean')     return renderClean();
    if(currentTab==='regions')   return (CRM_REGION_RULES_V2?renderRegionRulesV2():renderRegionMapping());
  }
  function render(){ if(!MOUNTED) return; renderRegions(); renderProducts(); renderKpis(); renderTabs(); renderContent(); }

  /* ── drawer (deep-link stand-ins → real summary data) ── */
  function showDlv(title,html){ $('dlvTitle').textContent=title; $('dlvBody').innerHTML=html; $('dlv').classList.add('open'); }
  function closeDlv(){ var d=$('dlv'); if(d) d.classList.remove('open'); }
  function kpiStrip(items){ return '<div class="kpi-grid" style="margin-bottom:14px">'+items.map(function(x){ return '<div class="kpi"><div class="kpi-label">'+x[0]+'</div><div class="kpi-value" style="font-size:22px">'+x[1]+'</div>'+(x[2]?'<div class="kpi-sub">'+x[2]+'</div>':'')+'</div>'; }).join('')+'</div>'; }
  function openInsp(k){
    var s=shipByKey(k); if(!s||!s.insp) return;
    if(window.openInspPreviewGlobal&&s.insp&&s.insp.id){ window.openInspPreviewGlobal(s.insp.id); return; }
    var dec='<span class="badge '+(s.insp.decision==='Approved'?'b-pass':'b-warn')+'">'+esc(s.insp.decision)+'</span>';
    var html='<div class="standin"><b>Open in module</b> Full export inspection lives in the Inspections module — this is the CRM summary. Inspection <span class="mono">'+esc(s.insp.id)+'</span>.</div>'+
      '<div class="dlv-head"><div><div class="dlv-id">'+esc(s.insp.id)+'</div><div class="dlv-meta">'+esc(s.cn)+' · '+esc(s.client)+' · '+esc(s.variety)+' · '+s.cartons.toLocaleString()+' ctn</div></div>'+dec+'</div>'+
      kpiStrip([['Total defect',esc(s.insp.defect),'pallet-weighted'],['Decision',esc(s.insp.decision),''],['Cartons',s.cartons.toLocaleString(),''],['Pallets',(s.pallets||'—').toLocaleString(),'']]);
    showDlv('Inspection',html);
  }
  function openCqc(k){
    var s=shipByKey(k); if(!s||!s.cqc) return;
    if(window.openCqcPreviewGlobal&&s.cqcId){ window.openCqcPreviewGlobal(s.cqcId); return; }
    var sc=bandBadge(s.cqc.score,'raw score: "'+s.cqc.scoreRaw+'"');
    var html='<div class="standin"><b>Open in module</b> Full Client QC report lives in the Client QC module — this is the CRM summary. Report <span class="mono">'+esc(s.cqc.id)+'</span>.</div>'+
      '<div class="dlv-head"><div><div class="dlv-id">'+esc(s.cqc.id)+'</div><div class="dlv-meta">'+esc(s.cn)+' · '+esc(s.client)+' · '+esc(s.sub)+' · '+esc(s.variety)+'</div></div>'+sc+'</div>'+
      kpiStrip([['Total defect',esc(s.cqc.defect),''],['Gap vs export',esc(s.cqc.gap),'arrival − loading'],['Max temp',(s.cqc.maxTemp!=null?s.cqc.maxTemp+'°C':'—'),''],['Claim flag',s.cqc.flag?'Yes':'No','']]);
    showDlv('Client QC',html);
  }

  /* ── shipment detail drawer (with live composition rows) ── */
  function dCell(kk,v,mono){ return '<div class="detail-cell"><div class="detail-k">'+kk+'</div><div class="detail-v'+(mono?' mono':'')+'">'+(v==null||v===''?'—':esc(v))+'</div></div>'; }
  function dSec(title,cells){ return '<div class="section-title" style="margin-top:14px"><span class="section-title-bar"></span>'+title+'</div><div class="detail-grid">'+cells+'</div>'; }
  function shipCompHtml(s){
    var citrus=shipProduct(s)==='Citrus';
    if(s.rows&&s.rows.length){
      var rowsHtml=s.rows.map(function(r){ return '<tr><td>'+esc(r.variety)+'</td><td>'+esc(r.mix)+'</td><td class="lot cell-sub">'+esc(r.farm)+'</td><td>'+esc(r.ph)+'</td><td>'+esc(r.ctype)+'</td><td class="lot right">'+num(r.cartons).toLocaleString()+'</td><td class="lot right">'+tonCell(num(r.netTons))+'</td></tr>'; }).join('');
      return '<div class="section-title" style="margin-top:14px"><span class="section-title-bar"></span>Container composition <span class="section-count">'+s.rows.length+' row'+(s.rows.length>1?'s':'')+'</span></div><div class="table-wrap"><table class="wl"><thead><tr><th>Variety</th><th>'+(citrus?'Size':'Single / Mixed')+'</th><th>Farm</th><th>Packhouse</th><th>Carton type</th><th class="right">Cartons</th><th class="right">Net t</th></tr></thead><tbody>'+rowsHtml+'</tbody></table></div><div class="hint">A new row is created whenever packhouse, farm, variety, '+(citrus?'size':'single/mixed')+', carton type, container # or loading date changes.</div>';
    }
    return '<div class="hint" style="margin-top:14px">Loading composition rows…</div>';
  }
  function renderRedirInDetail(s){
    var head='<div class="dlv-head"><div><div class="dlv-id">'+esc(s.cn)+'</div><div class="dlv-meta">'+esc(s.client)+' · '+esc(s.sub)+' · '+esc(regionLabel[s.region]||s.region)+'</div></div>'+statusBadge(s.status,s.statusLabel)+'</div>';
    var note='<div class="scope-lock" style="border-color:var(--green-border)">↩ Redirected in from <b>'+esc(s.originClient)+'</b>'+(s.originSub&&s.originSub!=='—'?' / '+esc(s.originSub):'')+' · origin container <span class="mono">'+esc(s.originCn||s.cn)+'</span> · '+esc(s.redirectRef||'')+(s.invoice?' · new invoice <b class="mono">'+esc(s.invoice)+'</b>':' · new invoice not issued yet')+'.</div>';
    var timeline='<div class="section-title" style="margin-top:14px"><span class="section-title-bar"></span>Lifecycle</div><div class="audit" id="dlvTimeline"><div class="hint">Loading history…</div></div>';
    var comp='<div id="dlvComp">'+shipCompHtml(s)+'</div>';
    var redir=dSec('Redirect',dCell('Target client',s.client)+dCell('Target sub-client',s.sub)+dCell('New invoice no',s.invoice||'—',true)+dCell('From (origin)',s.originClient)+dCell('Origin container',s.originCn||s.cn,true)+dCell('Redirect ref',s.redirectRef||'—',true)+dCell('Region',regionLabel[s.region]||s.region));
    var qty=dSec('Quantities',dCell('Cartons',s.cartons.toLocaleString(),true)+dCell('Net weight',tonCell(s.netTons),true));
    return head+note+timeline+comp+redir+qty;
  }
  function renderShipDetail(s){
    if(s.redirectedIn) return renderRedirInDetail(s);
    var head='<div class="dlv-head"><div><div class="dlv-id">'+esc(s.cn)+'</div><div class="dlv-meta">'+esc(s.client)+' · '+esc(s.sub)+' · '+esc(regionLabel[s.region]||s.region)+'</div></div>'+statusBadge(s.status,s.statusLabel)+'</div>';
    var lock='<div class="scope-lock">🔒 Full shipment record, shown inside CRM and scoped to your region.</div>';
    var actions='<div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">'+
      '<button class="btn btn-secondary btn-sm" data-crm-act="dlvRedirect" data-crm-key="'+esc(s.key)+'">Redirect →</button>'+
      '<button class="btn '+((s.status==='returned'||s.claim)?'btn-secondary':'btn-primary')+' btn-sm" data-crm-act="dlvClaim" data-crm-key="'+esc(s.key)+'">'+(s.claim?'View claim':'Raise claim')+'</button>'+
      (s.coverage!=='cqc'?'<button class="btn btn-secondary btn-sm" data-crm-act="dlvGrade" data-crm-key="'+esc(s.key)+'">'+(s.coverage==='graded'?'Edit grade':'Grade')+'</button>':'')+
      (s.insp?'<button class="btn btn-secondary btn-sm" data-crm-act="openInsp" data-crm-key="'+esc(s.key)+'">Export inspection ↗</button>':'')+
      (s.cqc?'<button class="btn btn-secondary btn-sm" data-crm-act="openCqc" data-crm-key="'+esc(s.key)+'">CQC report ↗</button>':'')+'</div>';
    var timeline='<div class="section-title" style="margin-top:14px"><span class="section-title-bar"></span>Lifecycle</div><div class="audit" id="dlvTimeline"><div class="hint">Loading history…</div></div>';
    var voyage=dSec('Voyage & logistics',dCell('Vessel',s.vessel)+dCell('Shipping line',s.shippingLine)+dCell('Booking no',s.booking,true)+dCell('Invoice no',s.invoice,true)+dCell('Departure port',s.departurePort)+dCell('Receiving port',s.port)+dCell('Receiving country',shipCountry(s))+dCell('Product',shipProduct(s))+dCell('ETD',s.etd)+dCell('ETA',s.eta)+dCell('Arrival',s.arrival)+dCell('Shipping status',s.statusLabel));
    var commercial=dSec('Commercial',dCell('Client',s.client)+dCell('Sub-client',s.sub)+dCell('Shipper',s.shipper||'Daltex Corp')+dCell('Forwarding agent',s.agent)+dCell('Carta',s.split?s.cartaCount+' (split)':'1',true)+dCell('Region',regionLabel[s.region]||s.region));
    var product=dSec('Product',dCell('Variety',s.varieties?s.varieties.join(' / '):s.variety)+dCell('Daltex class',s.dclass)+dCell('Brand',s.brand)+dCell('Size',s.size)+dCell('Traceability code',s.trace,true)+dCell('Farm source',s.farmSource));
    var comp='<div id="dlvComp">'+shipCompHtml(s)+'</div>';
    var qty=dSec('Quantities · totals across '+(s.rowCount||1)+' row'+((s.rowCount||1)>1?'s':''),dCell('Cartons',s.cartons.toLocaleString(),true)+dCell('Pallets',(s.pallets||'—').toLocaleString(),true)+dCell('Net weight',tonCell(s.netTons),true)+dCell('Gross weight',tonCell(s.grossKg),true));
    return head+lock+actions+timeline+comp+voyage+commercial+product+qty;
  }
  var dlvToken=0;
  function openShipDetail(k){
    var s=shipByKey(k); if(!s) return;
    var tok=++dlvToken;
    showDlv('Shipment',renderShipDetail(s));
    ensureRows(s).then(function(){ if(tok===dlvToken && $('dlv').classList.contains('open')){ var c=$('dlvComp'); if(c) c.innerHTML=shipCompHtml(s); } });
    SB.rpc('crm_container_timeline',{p_season:SEASON,p_container:s.cn}).then(function(res){
      if(tok!==dlvToken) return;                 /* drawer moved on */
      var el=$('dlvTimeline'); if(!el) return;
      if(res&&res.error){ el.innerHTML='<div class="hint">History unavailable.</div>'; return; }
      el.innerHTML=renderTimeline((res&&res.data)||[]);
    }).catch(function(){ if(tok===dlvToken){ var el=$('dlvTimeline'); if(el) el.innerHTML='<div class="hint">History unavailable.</div>'; } });
  }
  function openSubDrill(sub){
    var list=visibleShipments().filter(function(s){return s.sub===sub;});
    list.sort(function(a,b){return b.sortKey-a.sortKey;});
    var client=list[0]?list[0].client:'', total=list.length, capped=total>80; if(capped) list=list.slice(0,80);
    var rows=list.map(function(s){
      var qc=s.cqc?'<span class="qlink" title="Open CQC report" data-crm-act="openCqc" data-crm-key="'+esc(s.key)+'">'+bandBadge(s.cqc.score)+'</span>':(s.coverage==='graded'?'<span class="badge b-neutral" style="border-color:#c090e0;color:#6a10b0;background:#f0e8ff">Graded '+esc(s.graded.grade)+'</span>':'<span class="cell-sub">no data</span>');
      var cl=s.claim?claimBadge(s.claim):'<span class="cell-sub">—</span>';
      return '<tr><td><span class="lot">'+esc(s.cn)+'</span></td><td class="lot cell-sub">'+esc(shipInvoice(s))+'</td><td>'+esc(s.varieties?s.varieties.join(' / '):s.variety)+'</td><td>'+esc(s.eta)+'</td><td>'+qc+'</td><td>'+cl+'</td></tr>';
    }).join('');
    var html='<div class="dlv-head"><div><div class="dlv-id" style="font-family:var(--font-body);font-size:18px">'+esc(sub)+'</div><div class="dlv-meta">'+esc(client)+' · '+total.toLocaleString()+' shipments</div></div></div><div class="table-wrap"><table class="wl"><thead><tr><th>Container</th><th>Invoice #</th><th>Variety</th><th>ETA</th><th>CQC</th><th>Claim</th></tr></thead><tbody>'+rows+'</tbody></table></div>'+(capped?'<div class="hint" style="margin-top:8px">Showing the latest 80 — search or the Shipments tab for the rest.</div>':'');
    showDlv(sub,html);
  }

  /* ── composition rows: lazy fetch from crm_shipment_rows ── */
  function ensureRows(s){
    if(s.rows) return Promise.resolve(s.rows);
    return SB.from('crm_shipment_rows').select('variety,variety_type,farm_source,pack_house,carton_type,carton_count,net_weight').eq('season_id',SEASON).eq('container_key',s.key).then(function(res){
      var data=(res&&res.data)||[];
      s.rows=data.map(function(r){ return {variety:r.variety||'—', mix:r.variety_type||'Single', farm:r.farm_source||'—', ph:r.pack_house||'—', ctype:r.carton_type||'—', cartons:num(r.carton_count), netTons:num(r.net_weight)}; });
      return s.rows;
    }).catch(function(){ s.rows=[]; return s.rows; });
  }

  /* ── Claim modal ── */
  var claimCtx=null, claimLifecycle='open', claimScope='whole';
  function buildWholeSum(s){ var vars=s.varieties||[s.variety]; var vtxt=vars.length>1?'all varieties ('+vars.join(', ')+')':vars[0]; return '<span class="ev-check">✓</span><span>Covers the <b>whole container</b> — '+esc(vtxt)+' · '+s.cartons.toLocaleString()+' ctn</span>'; }
  /* Read-only affected part-loads for an INVOICE-anchored claim — grouped by container (approver's mixed view). */
  function invoiceClaimRowsHtml(rows){
    var by={}, order=[];
    (rows||[]).forEach(function(r){ var cn=r.ship_container||'—'; if(!by[cn]){by[cn]=[];order.push(cn);} by[cn].push(r); });
    if(!order.length) return '<div class="cell-sub">No part-load rows recorded.</div>';
    return order.map(function(cn){
      var ct=0,tn=0; by[cn].forEach(function(r){ ct+=num(r.cartons)||0; tn+=num(r.net_tons)||0; });
      var items=by[cn].map(function(r){ return '<div class="row-opt" style="cursor:default"><span class="row-opt-main"><b>'+esc(r.variety||'—')+'</b> · <span class="mono">'+esc(r.farm||'—')+'</span> · '+esc(r.packhouse||'—')+(r.carton_type?' · '+esc(r.carton_type):'')+'</span><span class="row-opt-qty">'+(num(r.cartons)||0).toLocaleString()+' ctn · '+(num(r.net_tons)||0).toLocaleString()+' t</span></div>'; }).join('');
      return '<div style="margin-bottom:10px"><div class="cell-sub mono" style="margin-bottom:4px">Container <b>'+esc(cn)+'</b> · '+ct.toLocaleString()+' ctn · '+tn.toLocaleString()+' t</div>'+items+'</div>';
    }).join('');
  }
  function buildPartFields(s){
    var citrus=shipProduct(s)==='Citrus';
    var rowsHtml=(s.rows||[]).map(function(r){ return '<label class="row-opt"><input type="checkbox" data-ctn="'+num(r.cartons)+'" data-nt="'+num(r.netTons)+'" onchange="CRM.rowSelChanged()"/><span class="row-opt-main"><b>'+esc(r.variety)+'</b> · '+esc(r.mix)+' · <span class="mono">'+esc(r.farm)+'</span> · '+esc(r.ph)+' · '+esc(r.ctype)+'</span><span class="row-opt-qty">'+num(r.cartons).toLocaleString()+' ctn · '+num(r.netTons).toLocaleString()+' t</span></label>'; }).join('');
    if(!rowsHtml) rowsHtml='<div class="cell-sub">No composition rows on file for this container.</div>';
    var totalNet=s.netTons||0, pctEnabled=totalNet>0;
    var pctInput=pctEnabled?'<input class="form-input mono" id="partNetPct" inputmode="decimal" placeholder="optional" oninput="CRM.syncNet(\'pct\')"/>':'<input class="form-input mono" id="partNetPct" placeholder="net weight not on file" disabled/>';
    return '<div style="margin-bottom:10px"><label class="form-label">Sub-client</label><div class="ctx-val">'+esc(s.sub)+'<span class="ctx-tag">from shipment</span></div></div>'+
      '<div style="margin-bottom:10px"><label class="form-label">Affected rows</label><div class="row-sel" id="rowSel">'+rowsHtml+'</div><div class="hint">Tick the composition row(s) the claim is about — pins it to variety'+(citrus?', size':'')+', farm and packhouse. Quantities below prefill from the selection (editable).</div></div>'+
      '<div class="grid2" style="margin-bottom:10px"><div><label class="form-label">Cartons affected</label><input class="form-input mono" id="partCartons" inputmode="numeric" placeholder="optional"/></div><div><label class="form-label">Pallets affected</label><input class="form-input mono" id="partPallets" inputmode="numeric" placeholder="optional"/></div></div>'+
      '<div class="grid2" id="netWrap" data-total="'+totalNet+'"><div><label class="form-label">Net weight impacted (t)</label><input class="form-input mono" id="partNetTons" inputmode="decimal" placeholder="optional" oninput="CRM.syncNet(\'kg\')"/></div><div><label class="form-label">% of net weight</label>'+pctInput+'</div></div>'+
      '<div class="hint">All part-of-load fields optional.'+(pctEnabled?' Shipment net weight <b>'+totalNet.toLocaleString()+' t</b> — weight and % update each other.':' Net weight not recorded — enter tonnes directly.')+'</div>';
  }
  /* Status/settlement UI — driven by the approval funnel (open → pending → closed), not a free toggle. */
  function _bnr(kind,html){ var map={warn:['var(--amber-bg)','var(--amber-border)','var(--amber)'],ok:['var(--green-bg)','var(--green-border)','var(--green)'],bad:['var(--red-bg)','var(--red-border)','var(--red)']}; var c=map[kind]||['var(--bg2)','var(--border)','var(--text2)']; return '<div style="background:'+c[0]+';border:1px solid '+c[1]+';color:'+c[2]+';padding:8px 10px;border-radius:8px;margin-bottom:8px;font-size:12px">'+html+'</div>'; }
  /* Lock the whole claim form for read-only review (pending/closed). Approver note + buttons live in
     #settlementBlock, which stays interactive. */
  function setClaimReadonly(on){
    var m=$('claimModal'); var body=m&&m.querySelector('.modal-body'); if(!body) return;
    body.classList.toggle('claim-ro', !!on);
    if(on){
      [].forEach.call(body.querySelectorAll('input,select,textarea'),function(el){
        if(el.closest && el.closest('#settlementBlock')) return;   /* leave the settlement/approver area alone */
        if(!el.disabled){ el.setAttribute('disabled','disabled'); el.setAttribute('data-ro-dis','1'); }
      });
    } else {
      [].forEach.call(body.querySelectorAll('[data-ro-dis]'),function(el){ el.removeAttribute('disabled'); el.removeAttribute('data-ro-dis'); });
    }
  }
  function beginSettlement(){
    var f=$('settlementForm'); if(f) f.style.display='block';
    var i=$('settlementIntro'); if(i) i.style.display='none';
    var res=$('claimResolution'), sv=$('settledValue'); if(res) res.disabled=false; if(sv){ sv.disabled=false; }
    var h=$('settlementHint'); if(h) h.innerHTML=(CLAIM_SETTINGS.threshold>0?('Auto-closes if ≤ '+Number(CLAIM_SETTINGS.threshold).toLocaleString()+(CLAIM_SETTINGS.currency?' '+CLAIM_SETTINGS.currency:'')+'; above that an approver reviews it before the claim closes.'):'Every settlement is reviewed by an approver before the claim closes.');
    var a=$('settlementActions'); if(a) a.innerHTML='<button class="btn btn-primary btn-sm" onclick="CRM.submitSettlement()">Submit for approval →</button> <button class="btn btn-secondary btn-sm" onclick="CRM.cancelSettlement()">Cancel</button>';
    if(sv) sv.focus();
  }
  function cancelSettlement(){ var f=$('settlementForm'); if(f) f.style.display='none'; renderClaimStatusUI((claimLoaded&&claimLoaded.status)||'open',claimLoaded); }
  function renderClaimStatusUI(status,c){
    var sl=$('claimStatusLine'); if(!sl) return;
    var blk=$('settlementBlock'), ban=$('settlementBanner'), intro=$('settlementIntro'), form=$('settlementForm'), act=$('settlementActions'), save=$('claimSaveBtn'), cancelB=$('claimCancelBtn'), redirB=$('claimRedirectBtn');
    var hasId=!!(claimCtx&&claimCtx.claimId);
    var st=(status==='new'||!hasId)?'new':(status||'open');
    var chip={'new':['b-neutral','New claim'],open:['b-fail','Open'],pending:['b-warn','Settlement pending approval'],closed:['b-neutral','Closed'],cancelled:['b-neutral','Cancelled']}[st]||['b-fail','Open'];
    sl.innerHTML='<span class="badge '+chip[0]+'">'+chip[1]+'</span>'+(st==='new'?' <span class="cell-sub">— will be raised as Open (active)</span>':(st==='open'?' <span class="cell-sub">— active; settle it when you\'ve agreed a value with the client</span>':''));
    if(blk) blk.style.display=(st==='new')?'none':'block';
    if(ban) ban.innerHTML=''; if(intro){ intro.innerHTML=''; intro.style.display=''; } if(act) act.innerHTML=''; if(form) form.style.display='none';
    var readonly=(st==='pending'||st==='closed');
    setClaimReadonly(readonly);
    if(save) save.style.display=(st==='new'||st==='open')?'':'none';
    if(cancelB) cancelB.style.display=(st==='new'||st==='open')?'':'none';
    if(redirB) redirB.style.display=(st==='new'||st==='open')?'':'none';
    var cur=(c&&(c.settled_currency||c.claimed_currency))||($('claimCurrency')&&$('claimCurrency').value)||'USD';
    function money(v){ return v==null?'—':(Number(v).toLocaleString()+' '+cur); }
    if(st==='open'){
      if(c&&c.rejection_reason&&ban) ban.innerHTML=_bnr('bad','↩ Settlement returned for revision — '+esc(c.rejection_reason)+'. Revise and resubmit when ready.');
      if(intro) intro.innerHTML='<button class="btn btn-primary btn-sm" onclick="CRM.beginSettlement()">'+(c&&c.rejection_reason?'Revise settlement &amp; resubmit →':'Record settlement &amp; submit for approval →')+'</button><div class="hint" style="margin-top:6px">Do this once a settled value is agreed with the client — the claim stays <b>Open</b> until then.</div>';
    } else if(st==='pending'){
      var subBy=c&&c.settlement_submitted_by, mine=subBy&&USER&&USER.id&&subBy===USER.id;
      if(ban) ban.innerHTML=_bnr('warn','⏳ Proposed settlement <b>'+money(c&&c.settled_value)+'</b>'+(c&&c.resolution_type?' · '+esc(c.resolution_type):'')+(c&&c.settlement_submitted_at?' · submitted '+esc(fmtDate(c.settlement_submitted_at)||''):'')+' — awaiting approval. Client claimed '+money(c&&c.claimed_value)+'.');
      if(act){
        if(IS_APPROVER && !(mine && !IS_ADMIN)){
          act.innerHTML='<div class="form-label" style="margin-bottom:4px">Decision note</div>'
            +'<textarea class="form-ta" id="claimDecisionNote" style="height:56px;resize:vertical" placeholder="Note — optional to approve, required to reject"></textarea>'
            +'<div style="display:flex;gap:8px;margin-top:8px"><button class="btn btn-primary btn-sm" onclick="CRM.claimApprove()">Approve &amp; close →</button><button class="btn btn-danger btn-sm" onclick="CRM.claimReject()">Reject &amp; return</button></div>'
            +'<div class="hint" style="margin-top:6px">You can approve or reject only — the claim details are locked for review.</div>';
        } else if(mine){ act.innerHTML='<div class="cell-sub">You submitted this settlement — another approver must review it.</div>'; }
        else { act.innerHTML='<div class="cell-sub">Awaiting an approver.</div>'; }
      }
    } else if(st==='closed'){
      if(ban) ban.innerHTML=_bnr('ok','✓ Settled <b>'+money(c&&c.settled_value)+'</b>'+(c&&c.resolution_type?' · '+esc(c.resolution_type):'')+(c&&c.closed_at?' · closed '+esc(fmtDate(c.closed_at)||''):'')+'.');
    }
  }
  function submitSettlement(){
    var s=claimCtx; if(!s||!s.claimId){ toast('Save the claim first, then submit its settlement.'); return; }
    if(claimBusy) return;
    var val=numOrNull($('settledValue')&&$('settledValue').value);
    if(val===null){ toast('Enter the agreed settled value to submit for approval.'); if($('settledValue')) $('settledValue').focus(); return; }
    var cur=txtOrNull($('claimCurrency')&&$('claimCurrency').value)||'USD';
    var res=txtOrNull($('claimResolution')&&$('claimResolution').value);
    claimBusy=true;
    SB.rpc('crm_submit_settlement',{payload:{ id:s.claimId, loaded_version:(claimLoaded&&claimLoaded.updated_at)||null, settled_value:val, settled_currency:cur, resolution_type:res }}).then(function(r){
      claimBusy=false;
      if(r&&r.error){ toast(claimErr(r.error)); return; }
      var out=r&&r.data||{};
      closeModal('claimModal');
      toast(out.auto_closed?('Settlement auto-closed · <b>'+esc(out.claim_ref||'')+'</b> (≤ threshold)'):('Submitted for approval · <b>'+esc(out.claim_ref||'')+'</b>'));
      reload();
    }).catch(function(e){ claimBusy=false; toast(claimErr(e)); });
  }
  function _reviewSettlement(id,decision,reason,loaded,note){ return SB.rpc('crm_review_settlement',{payload:{ id:id, decision:decision, reason:reason||null, loaded_version:loaded||null, event_detail:note||null }}); }
  function claimApprove(){ var s=claimCtx; if(!s||!s.claimId||claimBusy) return; var note=($('claimDecisionNote')&&$('claimDecisionNote').value||'').trim(); claimBusy=true; _reviewSettlement(s.claimId,'approve',null,(claimLoaded&&claimLoaded.updated_at)||null, note?('approved · '+note):null).then(function(r){ claimBusy=false; if(r&&r.error){ toast(claimErr(r.error)); return; } closeModal('claimModal'); toast('Approved &amp; closed · <b>'+esc((r.data&&r.data.claim_ref)||'')+'</b>'); reload(); }).catch(function(e){ claimBusy=false; toast(claimErr(e)); }); }
  function claimReject(){ var s=claimCtx; if(!s||!s.claimId||claimBusy) return; var reason=($('claimDecisionNote')&&$('claimDecisionNote').value||'').trim(); if(!reason){ toast('A note is required to reject — tell the commercial team why.'); if($('claimDecisionNote')) $('claimDecisionNote').focus(); return; } claimBusy=true; _reviewSettlement(s.claimId,'reject',reason,(claimLoaded&&claimLoaded.updated_at)||null,null).then(function(r){ claimBusy=false; if(r&&r.error){ toast(claimErr(r.error)); return; } closeModal('claimModal'); toast('Settlement rejected — returned to the commercial team.'); reload(); }).catch(function(e){ claimBusy=false; toast(claimErr(e)); }); }
  function setScope(sc){
    claimScope=sc;
    $('scopeWhole').className='pill'+(sc==='whole'?' sel':'');
    $('scopePart').className='pill'+(sc==='part'?' sel':'');
    $('partFields').className='part-fields'+(sc==='part'?' show':'');
    $('wholeSum').className='scope-sum'+(sc==='whole'?' show':'');
  }
  function togglePotential(){
    var on=$('potFlag').checked, v=$('claimValue'), c=$('claimCurrency');
    v.disabled=on; c.disabled=on;
    if(on){ v.value=''; v.placeholder='to be confirmed'; } else { v.placeholder='what the client is claiming'; }
    $('valueRow').style.opacity=on?'.5':'1';
  }
  /* commercial context on the claim form (mirrors mockup — display/calc only, not persisted) */
  var claimShipNetTons=0, claimPctManual=false;
  function markClaimPctManual(){ claimPctManual=true; var b=$('claimPctBasis'); if(b) b.textContent='manual override'; }
  function syncClaimPct(){
    var el=$('claimPct'); if(!el) return;
    if(claimPctManual) return;                         /* member overrode it — leave alone */
    var basis=$('claimPctBasis');
    var price=parseNum($('salePrice')?$('salePrice').value:'');
    var val=parseNum($('claimValue')?$('claimValue').value:'');
    var tons=claimShipNetTons||0;
    if(!price||!val||!tons){ el.value=''; if(basis) basis.textContent='auto from sale price × net tons'; return; }
    var cargo=price*tons;
    el.value=Math.round(val/cargo*1000)/10;
    if(basis) basis.textContent='auto · cargo value '+Math.round(cargo).toLocaleString();
  }
  function rowSelChanged(){
    var boxes=ROOT.querySelectorAll('#rowSel input:checked'), ctn=0, kg=0;
    [].forEach.call(boxes,function(b){ ctn+=Number(b.getAttribute('data-ctn'))||0; kg+=Number(b.getAttribute('data-nt'))||0; });
    var c=$('partCartons'), k=$('partNetTons');
    if(boxes.length){ c.value=ctn; k.value=kg; } else { c.value=''; k.value=''; }
    syncNet('kg');
  }
  function syncNet(from){
    var wrap=$('netWrap'); if(!wrap) return;
    var total=parseFloat(wrap.getAttribute('data-total'))||0; if(!total) return;
    var kg=$('partNetTons'), pctEl=$('partNetPct');
    if(from==='kg'){ var v=parseNum(kg.value); pctEl.value=(v===null)?'':(Math.round(v/total*1000)/10); }
    else { var p=parseNum(pctEl.value); kg.value=(p===null)?'':Math.round(total*p*10)/1000; }
  }
  var claimLoaded=null;        /* full crm_claims row for the open claim */
  var claimFiles=[];           /* crm_claim_files rows */
  var claimBusy=false;         /* in-flight guard for save + cancel */

  function loadClaimDetail(id){
    return Promise.all([
      SB.from('crm_claims').select('*').eq('id',id).limit(1),
      SB.from('crm_claim_rows').select('*').eq('claim_id',id),
      SB.from('crm_claim_events').select('*').eq('claim_id',id).order('at',{ascending:false}),
      SB.from('crm_claim_files').select('*').eq('claim_id',id).order('at',{ascending:false})
    ]).then(function(r){
      for(var x=0;x<r.length;x++){ if(r[x]&&r[x].error) throw r[x].error; }
      return { claim:((r[0]&&r[0].data)||[])[0]||null, rows:(r[1]&&r[1].data)||[],
               events:(r[2]&&r[2].data)||[], files:(r[3]&&r[3].data)||[] };
    });
  }

  function setVal(id,v){ var el=$(id); if(el) el.value=(v==null?'':String(v)); }

  /* History is read from crm_claim_events, not synthesised from current state (F10) */
  function renderClaimHistory(events){
    var el=$('claimAudit'); if(!el) return;
    if(!events||!events.length){
      el.innerHTML='<div class="audit-item"><span class="audit-dot" style="background:var(--border2)"></span><span class="audit-main cell-sub">New claim — this will be the first entry.</span></div>';
      return;
    }
    var LBL={raised:'Raised',updated:'Updated',settlement_submitted:'Submitted for approval',settlement_approved:'Approved & closed',settlement_rejected:'Settlement rejected',settlement_auto_closed:'Auto-closed (≤ threshold)',closed:'Closed',cancelled:'Cancelled'};
    function auditWhen(d){ var x=parseDate(d); if(!x) return ''; var hh=('0'+x.getUTCHours()).slice(-2), mm=('0'+x.getUTCMinutes()).slice(-2); return x.getUTCDate()+' '+MONTHS[x.getUTCMonth()]+' · '+hh+':'+mm; }
    el.innerHTML=events.map(function(e){
      var who=(USER&&USER.id===e.actor)?'you':'';
      var lbl=LBL[e.event]||e.event||'updated';
      return '<div class="audit-item"><span class="audit-dot"></span><span class="audit-main"><b>'+esc(lbl)+'</b>'
        +(e.detail?' · '+esc(e.detail):'')+(who?' · '+who:'')+'</span><span class="audit-when">'+esc(auditWhen(e.at))+'</span></div>';
    }).join('');
  }

  function renderClaimFiles(){
    var el=$('evFiles'); if(!el) return;
    if(!claimFiles.length){ el.innerHTML=''; return; }
    el.innerHTML=claimFiles.map(function(f){
      return '<div class="ev-file"><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(f.name||'file')+'</span>'
        +'<span class="link-btn" data-crm-act="evOpen" data-crm-key="'+esc(f.id)+'">open</span>'
        +'<span class="link-btn" style="color:var(--red)" data-crm-act="evDel" data-crm-key="'+esc(f.id)+'">remove</span></div>';
    }).join('');
  }

  function evOpen(id){
    var f=claimFiles.filter(function(x){return x.id===id;})[0]; if(!f) return;
    SB.storage.from('crm-claim-files').createSignedUrl(f.storage_path,60).then(function(r){
      if(r&&r.error){ toast('Could not open — '+esc(r.error.message)); return; }
      var u=r&&r.data&&(r.data.signedUrl||r.data.signedURL); if(u) window.open(u,'_blank','noopener');
    });
  }
  function evDel(id){
    var f=claimFiles.filter(function(x){return x.id===id;})[0]; if(!f) return;
    crmConfirm('Remove <b>'+esc(f.name||'this file')+'</b> from the claim?', function(){
      SB.storage.from('crm-claim-files').remove([f.storage_path]).then(function(){
        return SB.from('crm_claim_files').delete().eq('id',id);
      }).then(function(res){
        if(res&&res.error){ toast('Remove failed — '+esc(res.error.message)); return; }
        claimFiles=claimFiles.filter(function(x){return x.id!==id;});
        renderClaimFiles(); toast('Attachment removed.');
      });
    }, 'Remove');
  }

  /* Files can only be attached once the claim row exists, because storage
     authorisation is derived from {claim_id}/ in the object path. */
  function uploadEvidence(files){
    if(!claimCtx||!claimCtx.claimId){ toast('Save the claim first, then attach evidence.'); return; }
    var cid=claimCtx.claimId, list=[].slice.call(files||[]);
    if(!list.length) return;
    var MAXB=26214400, OK=['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf'];
    var bad=list.filter(function(f){ return f.size>MAXB || OK.indexOf(f.type)<0; });
    if(bad.length){ toast('Rejected — PDF or image, max 25 MB each.'); }
    var good=list.filter(function(f){ return f.size<=MAXB && OK.indexOf(f.type)>=0; });
    if(!good.length) return;
    toast('Uploading '+good.length+' file'+(good.length>1?'s':'')+'…');
    var chain=Promise.resolve();
    good.forEach(function(f){
      chain=chain.then(function(){
        var safe=String(f.name||'file').replace(/[^A-Za-z0-9._-]/g,'_').slice(-80);
        var path=cid+'/'+(Math.random().toString(36).slice(2))+'-'+safe;
        return SB.storage.from('crm-claim-files').upload(path,f,{contentType:f.type,upsert:false})
          .then(function(up){
            if(up&&up.error) throw up.error;
            return SB.from('crm_claim_files').insert({claim_id:cid,name:f.name,storage_path:path,
              content_type:f.type,uploaded_by:(USER&&USER.id)||null}).select('*');
          })
          .then(function(ins){
            if(ins&&ins.error) throw ins.error;
            var row=(ins&&ins.data&&ins.data[0]); if(row) claimFiles.unshift(row);
            renderClaimFiles();
          });
      });
    });
    chain.then(function(){ toast('Evidence attached.'); })
         .catch(function(e){ toast('Upload failed — '+esc((e&&e.message)||e)); });
  }

  function openClaim(k){
    var s=shipByKey(k); claimCtx=s; if(!s) return;
    claimLoaded=null; claimFiles=[]; claimBusy=false;
    $('claimSub').textContent=(s.claimRefRaw||'New claim')+' · '+s.cn+' · '+s.client;
    $('claimRaised').textContent=s.claimId?'on file':'today';
    $('wholeSum').innerHTML=buildWholeSum(s);
    var _hadRows=!!(s.rows&&s.rows.length);
    $('partBody').innerHTML=buildPartFields(s);
    ensureRows(s).then(function(){
      if(claimCtx===s && !_hadRows && s.rows && s.rows.length && $('partBody')) $('partBody').innerHTML=buildPartFields(s);
    });
    setScope('whole');

    /* reset every field, then repopulate from the server record if there is one */
    ['claimValue','salePrice','claimPct','blNumber','claimClaimant','claimClaimantEmail',
     'claimClientRef','claimDeadline','claimNotes','partPallets','partCartons','partNetTons','settledValue'].forEach(function(id){ setVal(id,''); });
    if($('claimReason')) $('claimReason').selectedIndex=0;
    if($('claimResolution')) $('claimResolution').selectedIndex=0;
    if($('claimIncoterm')) $('claimIncoterm').selectedIndex=0;
    var pf=$('potFlag'); if(pf){ pf.checked=false; }
    var bl=$('blNumber'); if(bl){ bl.style.borderColor=''; if($('blHint')) $('blHint').style.display='none'; }
    renderClaimStatusUI('new',null);
    renderClaimHistory(null);
    renderClaimFiles();

    /* CQC evidence line */
    var evEl=$('claimEvidence');
    if(evEl){
      if(s.cqc) evEl.innerHTML='<div class="ev-cqc"><span class="ev-check">✓</span><span class="ev-main"><span class="ev-code">'+esc(s.cqc.id)+'</span> <span class="ev-desc">— '+esc(s.cqc.scoreLabel)+' · '+esc(s.cqc.defect)+' defect'+(s.cqc.gap!=='—'?' · gap '+esc(s.cqc.gap):'')+'</span></span></div>';
      else evEl.innerHTML='<div class="ev-cqc-empty">No CQC report on file — attach client evidence below or grade the container.</div>';
    }
    var refEl=$('claimRef'); if(refEl) refEl.innerHTML=s.insp?'<span class="ev-ref-label">Reference</span><span class="ev-code">'+esc(s.insp.id)+'</span><span class="ev-desc">Export inspection · '+esc(s.insp.defect)+' · '+esc(s.insp.decision)+'</span>':'';

    claimShipNetTons=s.netTons||0; claimPctManual=false;
    if($('claimPctBasis')) $('claimPctBasis').textContent='auto from sale price × net tons';
    syncClaimPct();
    $('claimTitle').textContent = s.claimId ? ('Claim '+(s.claimRefRaw||'')) : 'Raise a claim';   /* P3: title reflects new vs existing */
    var _dz=$('dropzone'); if(_dz){ _dz.classList.toggle('dz-locked', !s.claimId); }               /* P1-4: no dropzone until the claim row exists */
    openModal('claimModal');

    /* Container track history (shipped → arrived → returned → redirected → claim events) — esp. for redirected/returned containers */
    if($('claimTimeline')){
      $('claimTimeline').innerHTML='<div class="hint">Loading track history…</div>';
      SB.rpc('crm_container_timeline',{p_season:SEASON,p_container:s.cn}).then(function(res){
        if(!claimCtx||claimCtx.key!==s.key){ return; }
        var el=$('claimTimeline'); if(!el) return;
        if(res&&res.error){ el.innerHTML='<div class="hint">Track history unavailable.</div>'; return; }
        el.innerHTML=renderTimeline((res&&res.data)||[]);
      }).catch(function(){ var el=$('claimTimeline'); if(el) el.innerHTML='<div class="hint">Track history unavailable.</div>'; });
    }

    if(!s.claimId) return;
    var _cm=$('claimModal'); if(_cm) _cm.classList.add('crm-modal-loading');                        /* P1-1: block edits until the saved record loads (prevents overwriting typed input) */
    loadClaimDetail(s.claimId).then(function(d){
      if(_cm) _cm.classList.remove('crm-modal-loading');
      if(!claimCtx || claimCtx.claimId!==s.claimId) return;   /* modal moved on */
      if(!d.claim){ closeModal('claimModal'); toast('That claim could no longer be loaded — it may have been removed or cancelled. Refresh the list.'); if(s){ s.claim=null; s.claimId=null; s.claimRefRaw=null; } render(); return; }
      claimLoaded=d.claim; claimFiles=d.files;
      var c=d.claim;
      setVal('blNumber',c.bl_number); setVal('claimValue',c.claimed_value);
      setVal('claimClaimant',c.claimant_name); setVal('claimClaimantEmail',c.claimant_email);
      setVal('claimClientRef',c.client_ref); setVal('claimDeadline',c.response_deadline);
      setVal('claimNotes',c.notes);
      setVal('partPallets',c.part_pallets); setVal('partCartons',c.part_cartons);
      setVal('partNetTons',c.part_net_tons);
      setVal('salePrice',c.sale_price_per_ton); setVal('claimPct',c.claim_pct);
      if(c.claimed_currency&&$('claimCurrency')) $('claimCurrency').value=c.claimed_currency;
      if(c.incoterm&&$('claimIncoterm')) $('claimIncoterm').value=c.incoterm;
      if(c.reason&&$('claimReason')) $('claimReason').value=c.reason;
      if(c.resolution_type&&$('claimResolution')) $('claimResolution').value=c.resolution_type;
      if(c.settled_value!=null) setVal('settledValue',c.settled_value);
      var pf2=$('potFlag'); if(pf2){ pf2.checked=!!c.potential; togglePotential(); }
      renderClaimStatusUI(c.status,c);
      if(c.claim_pct!=null) claimPctManual=true;
      /* Invoice-anchored claim: show affected part-loads grouped by container (read-only, mixed view). */
      if(c.anchor==='invoice'){
        setScope('part');
        var _conts=Object.keys((d.rows||[]).reduce(function(a,r){a[r.ship_container||'—']=1;return a;},{}));
        if($('partBody')) $('partBody').innerHTML='<div class="hint" style="margin-bottom:8px">Invoice claim — affected part-loads across <b>'+_conts.length+'</b> container'+(_conts.length===1?'':'s')+':</div>'+invoiceClaimRowsHtml(d.rows);
      }
      /* P1: restore the saved scope + re-tick the claimed composition rows. Without this, openClaim's
         unconditional setScope('whole') meant editing a part-of-load claim silently re-saved it as a
         whole-container claim and dropped the variety/farm/packhouse row pins. */
      else if(c.scope==='part'){
        setScope('part');
        ensureRows(s).then(function(){
          if(!claimCtx||claimCtx.claimId!==s.claimId) return;
          if($('partBody')){ $('partBody').innerHTML=buildPartFields(s);
            setVal('partPallets',c.part_pallets); setVal('partCartons',c.part_cartons); setVal('partNetTons',c.part_net_tons); }
          var claimed=d.rows||[];
          [].forEach.call(ROOT.querySelectorAll('#rowSel input'),function(b){
            var lab=b.closest('.row-opt'); var main=lab?lab.querySelector('.row-opt-main'):null;
            var bits=main?main.textContent.split('·').map(function(x){return x.trim();}):[];
            b.checked=claimed.some(function(cr){ return (cr.variety||'')===(bits[0]||'')&&(cr.farm||'')===(bits[2]||'')&&(cr.packhouse||'')===(bits[3]||''); });
          });
        });
      }
      $('claimSub').textContent=(c.claim_ref||'Claim')+' · '+(c.anchor==='invoice'?('invoice '+(c.invoice_no||'—')):s.cn)+' · '+s.client;
      $('claimTitle').textContent='Claim '+(c.claim_ref||'');
      $('claimRaised').textContent=fmtDate(c.raised_at)||'on file';
      if($('claimClosedOn')) $('claimClosedOn').textContent=c.closed_at?(fmtDate(c.closed_at)||'—'):'—';
      renderClaimHistory(d.events); renderClaimFiles();
    }).catch(function(e){ if(_cm) _cm.classList.remove('crm-modal-loading'); toast('Could not load the full claim — '+esc((e&&e.message)||e)); });
  }

  function cancelClaim(){
    if(!claimCtx||!claimCtx.claimId){ closeModal('claimModal'); toast('Nothing to cancel — claim not yet saved.'); return; }
    if(claimBusy) return;
    crmConfirm('Cancel claim <b>'+esc(claimCtx.claimRefRaw||'')+'</b> on <span class="mono">'+esc(claimCtx.cn)+'</span>?<br>It stays in history as Cancelled and the container can be claimed again.', function(){
      claimBusy=true;
      SB.rpc('save_crm_claim_full',{payload:{
        id:claimCtx.claimId,
        loaded_version:(claimLoaded&&claimLoaded.updated_at)||null,
        season_id:SEASON, container_number:claimCtx.cn,
        client:txtOrNull(claimCtx.client), country:txtOrNull(claimCtx.country),
        bl_number:(claimLoaded&&claimLoaded.bl_number)||'—',
        status:'cancelled', event:'cancelled', event_detail:'cancelled by user'
      }}).then(function(res){
        claimBusy=false;
        if(res&&res.error){ toast(claimErr(res.error)); return; }
        closeModal('claimModal');
        toast('Claim <b>cancelled</b> — kept in history as Cancelled.');
        reload();
      }).catch(function(e){ claimBusy=false; toast(claimErr(e)); });
    }, 'Cancel claim');
  }

  function claimErr(e){
    var m=(e&&e.message)||String(e||'');
    if(/CONFLICT/.test(m)) return 'Someone else changed this claim — reopen it to see their version.';
    if(/uq_crm_claims_live_container|uq_crm_claims_live_whole|duplicate key/i.test(m)) return 'This container already has a live claim.';
    if(/part-load already claimed/i.test(m)) return 'That part-load is already under a live claim — pick different rows.';
    if(/not authorised/i.test(m)) return 'You do not have access to this region.';
    return 'Save failed — '+esc(m);
  }

  function saveClaim(){
    var s=claimCtx; if(!s){ closeModal('claimModal'); return; }
    if(claimBusy) return;
    var bl=$('blNumber');
    if(!bl.value.trim()){ bl.style.borderColor='var(--red)'; $('blHint').style.display='block'; bl.scrollIntoView({block:'center'}); bl.focus(); return; }
    var potential=$('potFlag').checked;
    var valRaw=$('claimValue')?$('claimValue').value.trim():'';
    if(!potential && valRaw && parseNum(valRaw)===null){
      toast('Claimed value isn\'t a number — use 1850 or 1,850.00');
      $('claimValue').focus(); return;
    }
    /* only the ticked composition rows, when scope is part-of-load */
    var rows=[];
    if(claimScope==='part'){
      [].forEach.call(ROOT.querySelectorAll('#rowSel input:checked'),function(b){
        var lab=b.closest('.row-opt'); var main=lab?lab.querySelector('.row-opt-main'):null;
        var bits=main?main.textContent.split('·').map(function(x){return x.trim();}):[];
        rows.push({ ship_container:s.cn, variety:bits[0]||null, farm:bits[2]||null, packhouse:bits[3]||null,
                    cartons:Number(b.getAttribute('data-ctn'))||null, net_tons:Number(b.getAttribute('data-nt'))||null });
      });
    }
    var payload={
      id:s.claimId||null,
      loaded_version:(claimLoaded&&claimLoaded.updated_at)||null,
      season_id:SEASON,
      product_id:txtOrNull((s.product||'').toLowerCase()),
      container_number:s.cn, voyage_key:s.key,
      client:txtOrNull(s.client), sub_client:txtOrNull(s.sub), country:txtOrNull(s.country),
      bl_number:bl.value.trim(),
      scope:claimScope, status:'open', potential:potential,
      reason:txtOrNull($('claimReason')&&$('claimReason').value),
      claimed_value:potential?null:numOrNull(valRaw),
      claimed_currency:txtOrNull($('claimCurrency')&&$('claimCurrency').value),
      claimant_name:txtOrNull($('claimClaimant')&&$('claimClaimant').value),
      claimant_email:txtOrNull($('claimClaimantEmail')&&$('claimClaimantEmail').value),
      client_ref:txtOrNull($('claimClientRef')&&$('claimClientRef').value),
      cqc_report_id:s.cqcId||null,
      response_deadline:txtOrNull($('claimDeadline')&&$('claimDeadline').value),
      notes:txtOrNull($('claimNotes')&&$('claimNotes').value),
      part_pallets:numOrNull($('partPallets')&&$('partPallets').value),
      part_cartons:numOrNull($('partCartons')&&$('partCartons').value),
      part_net_tons:numOrNull($('partNetTons')&&$('partNetTons').value),
      sale_price_per_ton:numOrNull($('salePrice')&&$('salePrice').value),
      claim_pct:numOrNull($('claimPct')&&$('claimPct').value),
      incoterm:txtOrNull($('claimIncoterm')&&$('claimIncoterm').value),
      rows:rows,
      event:s.claimId?'updated':'raised',
      event_detail:'B/L '+bl.value.trim()
    };
    claimBusy=true;
    var btn=$('claimSaveBtn'); if(btn){ btn.disabled=true; btn.textContent='Saving…'; }
    SB.rpc('save_crm_claim_full',{payload:payload}).then(function(res){
      claimBusy=false;
      if(btn){ btn.disabled=false; btn.textContent='Save claim'; }
      if(res&&res.error){ toast(claimErr(res.error)); return; }
      var out=res&&res.data||{};
      var wasNew=!payload.id;
      s.claimId=out.id||s.claimId; s.claimRefRaw=out.claim_ref||s.claimRefRaw;
      if(wasNew){
        /* P1-4: keep the claim open after first save so evidence can be attached without reopening; reopen from fresh data so loaded_version is correct for further edits */
        toast('Claim saved · <b>'+esc(out.claim_ref||payload.bl_number)+'</b> — you can attach evidence now.');
        reload().then(function(){ var ns=shipByKey(s.key); if(ns&&ns.claimId){ openClaim(ns.key); } else { closeModal('claimModal'); } });
      } else {
        closeModal('claimModal');
        toast('Claim saved · <b>'+esc(out.claim_ref||payload.bl_number)+'</b>');
        reload();
      }
    }).catch(function(e){ claimBusy=false; if(btn){ btn.disabled=false; btn.textContent='Save claim'; } toast(claimErr(e)); });
  }

  /* ── Grade modal ── */
  var gradeCtx=null, gradeSel='B';
  function setGrade(g){ gradeSel=g; [].forEach.call(ROOT.querySelectorAll('#gradeModal .grade-pill'),function(el){ el.className='grade-pill'+(el.textContent.trim()===g?' sel':''); }); }
  function openGrade(k){
    var s=shipByKey(k); gradeCtx=s; if(!s) return;
    $('gradeSub').textContent=(s.gradingId?'Edit grade':'New grade')+' · '+s.cn+' · '+s.client;
    $('gradeCtx').innerHTML='<span class="mono">'+esc(s.cn)+'</span> · '+esc(s.varieties?s.varieties.join(' / '):s.variety)+' · '+esc(shipCountry(s))+((regionLabel[s.region]||s.region)===shipCountry(s)?'':' · '+esc(regionLabel[s.region]||s.region))+' · '+s.cartons.toLocaleString()+' ctn';
    var g=s.graded && s.graded.grade!=='—'?s.graded:null;
    $('gradeAudit').innerHTML=g?'<div class="audit-item"><span class="audit-dot"></span><span class="audit-main"><b>Graded '+esc(g.grade)+'</b> · '+esc(g.cause)+'</span><span class="audit-when"></span></div>':'<div class="audit-item"><span class="audit-dot" style="background:var(--border2)"></span><span class="audit-main cell-sub">Not graded yet — this will be the first entry.</span></div>';
    /* no default verdict -- two clicks must not manufacture a mid-grade (see saveGrade) */
    gradeSel=g?g.grade:null;
    [].forEach.call(ROOT.querySelectorAll('#gradeModal .grade-pill'),function(el){
      el.className='grade-pill'+(gradeSel&&el.textContent.trim()===gradeSel?' sel':''); });
    if($('gradeCause')) $('gradeCause').value=(g&&g.cause&&g.cause!=='—')?g.cause:'';
    /* editing kept wiping the previous comment; load it instead */
    if($('gradeComments')) $('gradeComments').value=(g&&g.comments)||'';
    var nb=$('gradeNoCqc');
    if(nb) nb.innerHTML = s.coverage==='cqc' ? ''
      : '<div class="badge b-neutral" style="margin-bottom:12px">No CQC on file — record a CRM grade as the quality read</div>';
    openModal('gradeModal');
    /* crm_voyages carries grade + cause but not comments, so read them directly */
    if(s.gradingId){
      SB.from('crm_gradings').select('grade,cause,comments,graded_at').eq('id',s.gradingId).limit(1).then(function(r){
        if(r&&r.error) return;
        var row=(r.data||[])[0];
        if(!row||!gradeCtx||gradeCtx.gradingId!==s.gradingId) return;
        if($('gradeComments')) $('gradeComments').value=row.comments||'';
        if(row.cause&&$('gradeCause')) $('gradeCause').value=row.cause;
        if($('gradeAudit')) $('gradeAudit').innerHTML='<div class="audit-item"><span class="audit-dot"></span><span class="audit-main"><b>Graded '+esc(row.grade||'—')+'</b> · '+esc(row.cause||'—')+'</span><span class="audit-when">'+esc(fmtDate(row.graded_at)||'')+'</span></div>';
      });
    }
  }
  function saveGrade(){
    var s=gradeCtx; if(!s){ closeModal('gradeModal'); return; }
    if(!gradeSel){ toast('Pick a grade — A, B or C.'); return; }
    var causeVal=$('gradeCause')?$('gradeCause').value:'';
    if(!causeVal){ toast('Pick a cause of grade.'); if($('gradeCause')) $('gradeCause').focus(); return; }
    var payload={ season_id:SEASON, product_id:txtOrNull((s.product||'').toLowerCase()), container_number:s.cn, voyage_key:s.key,
      client:txtOrNull(s.client), country:txtOrNull(s.country), grade:gradeSel,
      cause:causeVal, comments:txtOrNull($('gradeComments')&&$('gradeComments').value),
      graded_by:USER&&USER.id||null };
    var btn=$('gradeSaveBtn'); if(btn){ btn.disabled=true; btn.textContent='Saving…'; }
    var pr = s.gradingId ? SB.from('crm_gradings').update(payload).eq('id',s.gradingId).select('id,grade_ref') : SB.from('crm_gradings').insert(payload).select('id,grade_ref');
    pr.then(function(res){
      if(btn){ btn.disabled=false; btn.textContent='Save grading'; }
      if(res&&res.error){ toast('Save failed — '+esc(res.error.message)); return; }
      var row=(res&&res.data&&res.data[0])||{};
      closeModal('gradeModal');
      toast('Grading saved · <b>'+esc(row.grade_ref||('Grade '+gradeSel))+'</b>');
      reload();
    }).catch(function(e){ if(btn){ btn.disabled=false; btn.textContent='Save grading'; } toast('Save failed — '+esc((e&&e.message)||e)); });
  }
  /* ── modal open/close: unsaved-changes guard (P0-1) + focus management & dialog semantics (P1-5) ── */
  var GUARDED_MODALS={claimModal:1,gradeModal:1,redirModal:1,invClaimModal:1,invRedirModal:1};
  var _formDirty={}, _modalReturnFocus=null;
  function openModal(id){
    _formDirty[id]=false;
    var m=$(id); if(!m) return;
    _modalReturnFocus=(document.activeElement&&ROOT&&ROOT.contains(document.activeElement))?document.activeElement:null;
    m.classList.add('open');
    var box=m.querySelector('.modal');
    if(box){ box.setAttribute('role','dialog'); box.setAttribute('aria-modal','true'); box.setAttribute('tabindex','-1');
      var ttl=box.querySelector('.modal-title'); if(ttl){ if(!ttl.id) ttl.id=id+'Title'; box.setAttribute('aria-labelledby',ttl.id); }
      try{ box.focus(); }catch(e){} }
  }
  function closeModal(id){ var m=$(id); if(m) m.classList.remove('open'); _formDirty[id]=false;
    if(_modalReturnFocus){ try{ _modalReturnFocus.focus(); }catch(e){} _modalReturnFocus=null; } }
  function requestCloseModal(id){
    if(GUARDED_MODALS[id] && _formDirty[id]){
      crmConfirm('You have unsaved changes on this form. Closing now will discard them.', function(){ closeModal(id); }, 'Discard changes', 'Discard changes?');
      return;
    }
    closeModal(id);
  }

  /* ── region override writes ── */
  function reloadOverridesAndVoyages(){ return loadOverrides().then(loadVoyages).then(render); }
  function reloadBandsAndVoyages(){ return loadScoreBands().then(loadVoyages).then(render); }
  function setScoreBand(raw,band){ if(!band) return; SB.from('crm_score_bands').upsert({raw_lc:String(raw).toLowerCase().trim(),band:Number(band)},{onConflict:'raw_lc'}).then(function(res){ if(res&&res.error){ toast('Band save failed — '+esc(res.error.message)); return; } toast('Score band updated.'); reloadBandsAndVoyages(); }); }
  function removeScoreBand(raw){ SB.from('crm_score_bands').delete().eq('raw_lc',String(raw).toLowerCase().trim()).then(function(res){ if(res&&res.error){ toast('Remove failed — '+esc(res.error.message)); return; } toast('Score band removed.'); reloadBandsAndVoyages(); }); }
  function addScoreBandFromForm(){ var raw=$('sbRaw')?$('sbRaw').value.trim():''; var band=$('sbBand')?$('sbBand').value:''; if(!raw){ toast('Enter the raw score text.'); return; } setScoreBand(raw,band); }
  function setCountryOverride(country,region){
    var k=country.toLowerCase();
    var op = region==='__def' ? SB.from('region_overrides').delete().eq('scope','country').eq('key',k)
      : SB.from('region_overrides').upsert({scope:'country',key:k,region_id:region,set_by:USER&&USER.id||null},{onConflict:'scope,key'});
    op.then(function(res){ if(res&&res.error){ toast('Override failed — '+esc(res.error.message)); return; } toast('Country rule updated.'); reloadOverridesAndVoyages(); });
  }
  function setClientOverride(client,region){
    if(!region) return;
    var op = region==='__none' ? SB.from('region_overrides').delete().eq('scope','client').eq('key',client)
      : SB.from('region_overrides').upsert({scope:'client',key:client,region_id:region,set_by:USER&&USER.id||null},{onConflict:'scope,key'});
    op.then(function(res){ if(res&&res.error){ toast('Override failed — '+esc(res.error.message)); return; } toast('Client rule updated.'); reloadOverridesAndVoyages(); });
  }
  function addClientOverrideFromForm(){ var c=$('ovClient').value; if(c) setClientOverride(c,$('ovClientRegion').value); }

  /* ── setters ── */
  function setTab(id){
    /* P2-6: Shipments column filters are scoped to that tab only — clear them on tab change so they don't silently persist/reapply */
    SHIP_FILTER_KEYS.forEach(function(k){ shipView[k]='all'; }); scoreOpen=false;
    currentTab=id; resetPages(); render();
    if(ON_TAB) ON_TAB(id,activeLeadKey());   /* let the Vision shell sidebar reflect the active CRM tab + leads view (button highlight) */
    var vc=$('viewContent'); if(vc&&vc.scrollTo) vc.scrollTo(0,0);
    if(ROOT&&ROOT.scrollIntoView) ROOT.scrollIntoView({block:'start'});
    if(window.scrollTo) window.scrollTo(0,0);
  }
  /* Deep-link entry from the sidebar Leads dropdown: open CRM directly on a given tab.
     If not yet mounted (switching in from another view), stash it and init applies it. */
  function openTab(id){ if(MOUNTED){ setTab(id); } else { PENDING_TAB=id; } }
  function setRegion(id){ currentRegion=id; resetPages(); showAllSubs=false; render(); }
  function setProduct(p){ currentProduct=p; resetPages(); showAllSubs=false; render(); }
  function onSearch(v){ currentQuery=(v||'').trim(); var w=$('crmSearchWrap'); if(w) w.classList.toggle('has-q',!!currentQuery); resetPages(); clearTimeout(onSearch._t); onSearch._t=setTimeout(function(){ render(); },150); }
  function clearSearch(){ var el=$('crmSearch'); if(el) el.value=''; onSearch(''); }
  function clearFilters(){ currentRegion='all'; currentProduct='all'; currentQuery=''; var el=$('crmSearch'); if(el) el.value=''; var w=$('crmSearchWrap'); if(w) w.classList.remove('has-q'); SHIP_FILTER_KEYS.forEach(function(k){ shipView[k]='all'; }); scoreOpen=false; resetPages(); showAllSubs=false; render(); }   /* P2-5: one Clear resets scope AND table column filters */
  function setShipFilter(k,v){ shipView[k]=v; if(k==='client') shipView.sub='all'; pageState.shipments=0; render(); }
  /* All tokens currently offered, in the order the popover shows them. */
  function scoreAllTokens(){
    var out=[NOCQC], seen={};
    visibleShipments().forEach(function(s){ var t=scoreTok(s); if(t!==NOCQC&&!seen[t]){ seen[t]=1; out.push(t); } });
    return out;
  }
  function toggleScorePop(){ scoreOpen=!scoreOpen; render(); }
  function setScoreAll(on){ shipView.score = on ? 'all' : []; pageState.shipments=0; render(); }
  function toggleScoreTok(tok){
    var cur=scoreSel();
    if(!cur) cur=scoreAllTokens().slice();          /* was "all" -> materialise, then remove one */
    var i=cur.indexOf(tok);
    if(i>=0) cur.splice(i,1); else cur.push(tok);
    var all=scoreAllTokens();
    shipView.score = (cur.length===all.length) ? 'all' : cur;
    pageState.shipments=0; render();
  }
  function resetShipFilters(){ SHIP_FILTER_KEYS.forEach(function(k){ shipView[k]='all'; }); scoreOpen=false; pageState.shipments=0; render(); }
  function setShipSort(v){ shipView.sort=v; pageState.shipments=0; render(); }
  function setPage(k,p){ pageState[k]=p; render(); var t=$('viewTabs'); if(t) t.scrollIntoView({block:'nearest'}); }
  function toggleSubs(){ showAllSubs=!showAllSubs; render(); }
  function togglePulse(){ pulseOpen=!pulseOpen; render(); }
  function pulseGo(k,v){
    currentTab='shipments'; SHIP_FILTER_KEYS.forEach(function(x){ shipView[x]='all'; });
    shipView[k] = (k==='score' && v!=='all') ? [v==='none'?NOCQC:v] : v;
    scoreOpen=false; resetPages(); render();
  }

  /* ── data loading ── */
  function loadRegions(){
    return SB.from('regions').select('id,label,owner,is_bucket,lead_routing').then(function(res){ if(res&&res.error){ toast('Could not load regions — '+esc(res.error.message)); throw res.error; }
      var db=(res&&res.data)||[];
      db.sort(function(a,b){ if(a.is_bucket!==b.is_bucket) return a.is_bucket?1:-1; return (a.label||'').localeCompare(b.label||''); });
      REGIONS=[{id:'all',label:'All regions',admin:true}].concat(db.map(function(r){ return {id:r.id,label:r.label,owner:r.owner,admin:!!r.is_bucket,routing:(r.lead_routing==='assign'?'assign':'claim')}; }));
      regionLabel={}; regionOwner={}; regionRouting={};
      REGIONS.forEach(function(r){ regionLabel[r.id]=r.label; if(r.owner) regionOwner[r.id]=r.owner; regionRouting[r.id]=(r.routing==='assign'?'assign':'claim'); });
    });
  }
  function loadCountryMap(){
    return SB.from('region_country_map').select('country_lc,region_id').then(function(res){ if(res&&res.error){ toast('Could not load region_country_map — '+esc(res.error.message)); throw res.error; }
      COUNTRY_REGION={}; ((res&&res.data)||[]).forEach(function(r){ COUNTRY_REGION[r.country_lc]=r.region_id; });
    });
  }
  function loadOverrides(){
    return SB.from('region_overrides').select('scope,key,region_id').then(function(res){ if(res&&res.error){ toast('Could not load region_overrides — '+esc(res.error.message)); throw res.error; }
      REGION_OVERRIDES={country:{},client:{},shipment:{}};
      ((res&&res.data)||[]).forEach(function(r){ if(REGION_OVERRIDES[r.scope]) REGION_OVERRIDES[r.scope][r.key]=r.region_id; });
    });
  }
  function loadScoreBands(){
    return SB.from('crm_score_bands').select('raw_lc,band').then(function(res){ if(res&&res.error){ toast('Could not load crm_score_bands — '+esc(res.error.message)); throw res.error; }
      BAND_MAP={}; ((res&&res.data)||[]).forEach(function(r){ BAND_MAP[r.raw_lc]=r.band; });
    });
  }
  function loadVoyages(){
    var out=[];
    function page(from){
      return SB.from('crm_voyages').select('*').eq('season_id',SEASON).order('eta',{ascending:false,nullsFirst:false}).range(from,from+999).then(function(res){
        if(res&&res.error) throw res.error;
        var data=(res&&res.data)||[];
        out=out.concat(data);
        if(data.length===1000) return page(from+1000);
        SHIPMENTS=out.map(mapVoyage);
      });
    }
    return page(0);
  }
  /* ── redirected-IN goods: synthesise a target-side shipment per active redirect.
     CRM-owned only — we NEVER write shipments (the sync job orphan-deletes). These
     rows land on the TARGET client/sub/region carrying the destination invoice, and
     are injected into SHIPMENTS so they count in volume / Invoices / scorecards.
     coverage:'redirect' + redirectedIn flag keep them OUT of QC/grading/clean. ── */
  function mapRedirIn(x){
    var rws=(x.crm_redirection_rows||[]).map(function(r){ return {variety:r.variety||'—', mix:'Single', farm:r.farm||'—', ph:r.packhouse||'—', ctype:r.carton_type||'—', carta:r.carta||'', cartons:num(r.cartons), netTons:num(r.net_tons)}; });
    var vs=Array.from(new Set(rws.map(function(r){return r.variety;}).filter(function(v){return v&&v!=='—';})));
    return {
      key:'RDRIN:'+x.id, redirectedIn:true, redirectId:x.id, redirectRef:x.redirect_ref,
      cn:x.container_number||'—', originCn:x.container_number||'',
      originClient:x.origin_client||'—', originSub:x.origin_sub_client||'—', originRegion:x.origin_region_id||null,
      client:x.target_client||'—', sub:x.target_sub_client||'—', country:x.country||'',
      region:x.target_region_id||'unassigned',
      product:x.product_id?(x.product_id.charAt(0).toUpperCase()+x.product_id.slice(1)):'—', productId:x.product_id||null,
      variety:vs[0]||'—', varieties:vs.length>1?vs:null,
      cartons:num(x.total_cartons), pallets:0, netTons:num(x.total_net_tons), grossKg:0,
      vessel:'—', shippingLine:'—', port:'—', departurePort:'—',
      eta:'', etaRaw:null, etd:'', arrival:'',
      invoice:x.invoice_no||'', booking:'', shipper:'', agent:'',
      brand:'', size:'', dclass:'', trace:'', farmSource:'',
      split:false, rowCount:rws.length, cartaCount:0,
      status:'redirected_in', statusLabel:'Redirected in',
      sortKey:dayKey(x.created_at), createdAt:x.created_at, scope:x.scope,
      coverage:'redirect', insp:null, cqc:null, graded:null, claim:null, rows:rws, packHouses:[],
      cqcId:null, inspId:null, gradingId:null, claimId:null, claimRefRaw:null, bl:''
    };
  }
  function loadRedirIn(){
    return SB.from('crm_redirections')
      .select('id,redirect_ref,status,anchor,product_id,source_invoice_no,container_number,origin_client,origin_sub_client,origin_region_id,target_client,target_sub_client,target_region_id,country,invoice_no,total_cartons,total_net_tons,scope,created_at,crm_redirection_rows(variety,farm,packhouse,carton_type,carta,cartons,net_tons)')
      .eq('season_id',SEASON).neq('status','cancelled')
      .then(function(res){ if(res&&res.error) throw res.error; REDIR_IN=((res&&res.data)||[]).map(mapRedirIn); })
      .catch(function(){ REDIR_IN=[]; });   /* redirected-in is additive — never block the CRM if it fails */
  }
  /* generic paged fetch — PostgREST silently caps unpaged reads at 1000 rows (P3). makeQuery() returns a fresh builder each page. */
  function crmFetchAll(makeQuery){
    var out=[];
    function page(from){
      return makeQuery().range(from,from+999).then(function(res){
        if(res&&res.error) throw res.error;
        var data=(res&&res.data)||[]; out=out.concat(data);
        if(data.length===1000) return page(from+1000);
        return out;
      });
    }
    return page(0);
  }

  /* ── template + listeners ── */
  /* Vision-consistent loading skeleton (paper-toned shimmer) shown until data arrives — mirrors the dashboard layout so nothing jumps; render() overwrites it. */
  function crmSkel(){
    var kpi='<div class="kpi"><span class="sk" style="width:45%;height:9px"></span><span class="sk" style="width:58%;height:24px;margin-top:11px"></span><span class="sk" style="width:72%;height:8px;margin-top:11px"></span></div>';
    var panel='<div class="pulse-panel"><span class="sk" style="width:52%;height:9px;margin-bottom:13px"></span><span class="sk" style="width:100%;height:64px"></span></div>';
    var rankp='<div class="pulse-panel"><span class="sk" style="width:52%;height:9px;margin-bottom:13px"></span><span class="sk" style="width:100%;height:12px;margin-bottom:9px"></span><span class="sk" style="width:100%;height:12px;margin-bottom:9px"></span><span class="sk" style="width:100%;height:12px;margin-bottom:9px"></span><span class="sk" style="width:100%;height:12px"></span></div>';
    return '<div class="attn-head" style="margin-top:2px"><span class="sk" style="width:230px;height:12px"></span></div>'
      +'<div class="kpi-grid" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr));margin-bottom:16px">'+kpi+kpi+kpi+kpi+kpi+kpi+'</div>'
      +'<div class="pulse-panels" style="margin-bottom:16px">'+panel+panel+panel+'</div>'
      +'<div class="pulse-panels">'+rankp+rankp+rankp+'</div>';
  }
  function template(){ return ''
    /* tab bar is lifted into the shell topbar (see renderTabs → ON_HEADER); no in-island header row */
    +'<div class="subbar"><div class="subbar-inner">'
    +'<div class="crm-search crm-search-input" id="crmSearchWrap"><span class="crm-search-ic">🔍</span>'
    +'<input id="crmSearch" aria-label="Search shipments, claims and redirects" oninput="CRM.onSearch(this.value)" placeholder="Search client, container #, B/L, claim ref, invoice #, vessel, variety, country…"/>'
    +'<span class="crm-search-clear" role="button" tabindex="0" aria-label="Clear search" onclick="CRM.clearSearch()">&times;</span></div>'
    +'<span class="tool-lbl">Filter</span><span id="regionSel"></span><span id="productSel"></span>'
    +'<span class="fclear" id="crmClear" style="display:none" onclick="CRM.clearFilters()">Clear</span></div></div>'
    +'<div class="page"><div class="page-inner">'
    +'<div class="region-note" style="margin:0 0 10px">Regions from <b>Regions 2026</b> · members are locked to their region (admins see all). '+(CRM_REGION_RULES_V2?'Region resolves per shipment by the first matching rule (priority: sub-client → client → country → default → Unassigned).':'Region resolves per shipment: shipment override → client override → country default → Unassigned.')+(IS_ADMIN?' <span class="link-btn" onclick="CRM.setTab(\'regions\')">'+(CRM_REGION_RULES_V2?'Manage region rules →':'Manage region mapping →')+'</span>':'')+'</div>'
    +'<div class="kpi-grid" id="kpiGrid"></div><div id="viewContent">'+crmSkel()+'</div>'
    +'</div></div>'
    +'<div class="toast" id="crmToast" role="status" aria-live="polite"></div>'
    +'<div class="dlv" id="dlv"><div class="dlv-panel" role="dialog" aria-modal="true" aria-labelledby="dlvTitle"><div class="dlv-top"><span class="dlv-title" id="dlvTitle">Record</span><span class="dlv-x" role="button" tabindex="0" aria-label="Close" onclick="CRM.closeDlv()">&times;</span></div><div class="dlv-body"><div class="dlv-inner" id="dlvBody"></div></div></div></div>'
    +claimModalHtml()
    +gradeModalHtml()
    +redirectModalHtml()
    +invClaimModalHtml()
    +invRedirModalHtml()
    +crmConfirmModalHtml();
  }
  function claimModalHtml(){ return ''
    +'<div class="modal-bg" id="claimModal"><div class="modal"><div class="modal-head"><span class="modal-x" role="button" tabindex="0" aria-label="Close" onclick="CRM.requestCloseModal(\'claimModal\')">&times;</span><div class="modal-title" id="claimTitle">Raise a claim</div><div class="modal-sub" id="claimSub">—</div></div><div class="modal-body">'
    +'<div class="msec" style="border-top:none;padding-top:0;margin-top:0">Status</div><div id="claimStatusLine" style="margin-bottom:10px"></div>'
    +'<div class="grid3" style="margin-bottom:10px"><div><label class="form-label">Raised</label><div class="ctx-val" id="claimRaised">—</div></div><div><label class="form-label">Response deadline</label><input class="form-input" type="date" id="claimDeadline"/></div><div><label class="form-label">Closed</label><div class="ctx-val" id="claimClosedOn">—</div></div></div>'
    +'<div class="closing-block" id="settlementBlock" style="display:none"><div class="msec" style="border-top:none;padding-top:0;margin-top:0">Settlement</div><div id="settlementBanner"></div><div id="settlementIntro"></div><div id="settlementForm" style="display:none"><div class="grid2"><div><label class="form-label">Resolution type</label><select class="form-select" id="claimResolution"><option>Credit note</option><option>Replacement shipment</option><option>Price adjustment</option><option>Goodwill gesture</option><option>Insurance claim</option><option>Rejected — no fault</option></select></div><div><label class="form-label">Settled value</label><input class="form-input mono" id="settledValue" inputmode="decimal" placeholder="agreed amount"/></div></div><div class="hint" id="settlementHint"></div></div><div id="settlementActions" style="margin-top:10px"></div></div>'
    +'<div class="msec">Claim details</div><div class="form-row" style="margin-bottom:10px"><label class="form-label">B/L number <span style="color:var(--red)">*</span></label><input class="form-input mono" id="blNumber" aria-required="true" aria-describedby="blHint" placeholder="e.g. MAEU236451078"/><div class="hint" id="blHint" style="display:none;color:var(--red)">B/L number is required to save a claim.</div></div>'
    +'<div class="grid2" style="margin-bottom:10px"><div><label class="form-label">Reason</label><select class="form-select" id="claimReason"><option>Decay / rot on arrival</option><option>Temperature abuse in transit</option><option>Soft / overripe berries</option><option>Shatter / loose berries</option><option>Short weight</option><option>Wrong variety / spec</option><option>Late arrival / missed market</option><option>Documentation</option><option>Other</option></select></div><div><label class="form-label">Client\'s claim ref <span style="text-transform:none;font-weight:400;color:var(--text3)">(optional)</span></label><input class="form-input mono" id="claimClientRef" placeholder="their reference #"/></div></div>'
    +'<div class="grid2" style="margin-bottom:0"><div><label class="form-label">Claimant</label><input class="form-input" id="claimClaimant" placeholder="contact name"/></div><div><label class="form-label">Claimant email</label><input class="form-input" id="claimClaimantEmail" type="email" placeholder="name@client.com"/></div></div>'
    +'<div class="msec">Value</div><label class="chk" style="margin-bottom:9px"><input type="checkbox" id="potFlag" onchange="CRM.togglePotential()"/><span>Potential claim — flag now, value to be confirmed</span></label><div class="grid3" id="valueRow"><div style="grid-column:span 2"><label class="form-label">Claimed value</label><input class="form-input mono" id="claimValue" inputmode="decimal" placeholder="what the client is claiming" oninput="CRM.syncClaimPct()"/></div><div><label class="form-label">Currency</label><select class="form-select" id="claimCurrency"><option>USD</option><option>EUR</option><option>GBP</option><option>EGP</option></select></div></div>'
    +'<div class="msec">Commercial</div><div class="grid3"><div><label class="form-label">Sale price / ton</label><input class="form-input mono" id="salePrice" inputmode="decimal" placeholder="e.g. 1,850" oninput="CRM.syncClaimPct()"/></div><div><label class="form-label">Incoterm</label><select class="form-select" id="claimIncoterm"><option>FOB</option><option>CFR</option><option>CIF</option><option>DDP</option><option>DAP</option><option>EXW</option><option>FCA</option><option>CPT</option><option>CIP</option></select></div><div><label class="form-label">Claim % of price</label><input class="form-input mono" id="claimPct" inputmode="decimal" placeholder="auto" oninput="CRM.markClaimPctManual()"/><div class="hint" id="claimPctBasis" style="margin-top:3px">auto from price × tons</div></div></div>'
    +'<div class="msec">Scope</div><div class="pill-row"><span class="pill sel" id="scopeWhole" role="button" tabindex="0" onclick="CRM.setScope(\'whole\')">Whole container</span><span class="pill" id="scopePart" role="button" tabindex="0" onclick="CRM.setScope(\'part\')">Part of load</span></div><div class="scope-sum show" id="wholeSum"></div><div class="part-fields" id="partFields"><div id="partBody"></div></div>'
    +'<div class="msec">Quality evidence &amp; attachments</div><div id="claimEvidence"></div>'
    +'<label class="dropzone" id="dropzone"><input type="file" id="evFile" accept=".pdf,image/*" multiple style="display:none"/><div class="dz-ic">⬆</div><div class="dz-text"><b>Drop a file</b> or <span class="dz-browse">browse</span></div><div class="dz-sub">PDF, image or screenshot — client email, arrival photos, rejection note</div></label><div class="ev-files" id="evFiles"></div>'
    +'<div class="ev-ref" id="claimRef"></div><div class="hint">The CQC report is the quality evidence; the export inspection is reference only.</div>'
    +'<div class="msec">Notes</div><textarea class="form-ta" id="claimNotes" style="height:60px;resize:vertical" placeholder="Client rejected 2 pallets on arrival; decay concentrated in stems…"></textarea>'
    +'<div class="msec">Container timeline</div><div class="audit" id="claimTimeline"><div class="hint">—</div></div>'
    +'<div class="msec">Claim History</div><div class="audit" id="claimAudit"></div>'
    +'</div><div class="modal-foot" style="justify-content:space-between"><span class="link-btn" id="claimCancelBtn" style="color:var(--red)" title="Removes a claim opened in error — kept in history as Cancelled" onclick="CRM.cancelClaim()">Cancel claim</span><span style="display:flex;gap:8px"><button class="btn btn-secondary" id="claimRedirectBtn" title="Redirect these goods to another client — links this claim if it is saved" onclick="CRM.redirectFromClaim()">Redirect goods →</button><button class="btn btn-secondary" onclick="CRM.requestCloseModal(\'claimModal\')">Close</button><button class="btn btn-primary" id="claimSaveBtn" onclick="CRM.saveClaim()">Save claim</button></span></div></div></div>';
  }
  function gradeModalHtml(){ return ''
    +'<div class="modal-bg" id="gradeModal"><div class="modal"><div class="modal-head"><span class="modal-x" role="button" tabindex="0" aria-label="Close" onclick="CRM.requestCloseModal(\'gradeModal\')">&times;</span><div class="modal-title">CRM grading</div><div class="modal-sub" id="gradeSub">—</div></div><div class="modal-body">'
    +'<div id="gradeNoCqc"></div><div class="ctx-val" id="gradeCtx" style="margin-bottom:14px;font-size:12px">—</div>'
    +'<div class="form-row"><label class="form-label">Grade</label><div class="pill-row" style="margin-bottom:0"><span class="grade-pill" role="button" tabindex="0" onclick="CRM.setGrade(\'A\')">A</span><span class="grade-pill" role="button" tabindex="0" onclick="CRM.setGrade(\'B\')">B</span><span class="grade-pill" role="button" tabindex="0" onclick="CRM.setGrade(\'C\')">C</span></div></div>'
    +'<div class="form-row"><label class="form-label">Cause of grade</label><select class="form-select" id="gradeCause"><option value="">— select a cause —</option><option>Field / pre-harvest</option><option>Cold chain / transit</option><option>Packing</option><option>Overripe at loading</option><option>Undetermined</option></select></div>'
    +'<div class="form-row"><label class="form-label">Comments</label><textarea class="form-ta" id="gradeComments" style="height:72px;resize:vertical" placeholder="Container arrived without a CQC report; graded from photos + client feedback…"></textarea></div>'
    +'<div class="msec">History</div><div class="audit" id="gradeAudit"></div>'
    +'</div><div class="modal-foot"><button class="btn btn-secondary" onclick="CRM.requestCloseModal(\'gradeModal\')">Cancel</button><button class="btn btn-primary" id="gradeSaveBtn" onclick="CRM.saveGrade()">Save grading</button></div></div></div>';
  }

  /* ── Redirect modal (return a container to another client) ── */
  var redirCtx=null, redirScope='whole', redirRows=[], redirBusy=false;
  function redirectModalHtml(){ return ''
    +'<div class="modal-bg" id="redirModal"><div class="modal"><div class="modal-head"><span class="modal-x" role="button" tabindex="0" aria-label="Close" onclick="CRM.requestCloseModal(\'redirModal\')">&times;</span><div class="modal-title">Redirect goods</div><div class="modal-sub" id="redirSub">—</div></div><div class="modal-body">'
    +'<div class="msec" style="border-top:none;padding-top:0;margin-top:0">Goods to redirect</div><div id="redirSrc" style="padding:10px 12px;border:1px solid var(--border2);border-radius:8px;background:var(--bg2);font-size:12px;color:var(--text2);line-height:1.5"></div>'
    +'<div class="msec">What to redirect</div><div class="pill-row"><span class="pill sel" id="rdWhole" role="button" tabindex="0" onclick="CRM.setRedirScope(\'whole\')">Whole container</span><span class="pill" id="rdRows" role="button" tabindex="0" onclick="CRM.setRedirScope(\'rows\')">Selected rows</span><span class="pill" id="rdPart" role="button" tabindex="0" onclick="CRM.setRedirScope(\'part\')">Partial / re-sort</span></div><div class="hint" id="redirModeHint" style="margin-bottom:10px"></div><div class="row-sel" id="rdRowWrap"></div>'
    +'<div class="msec">Redirect to</div><div class="grid2"><div><label class="form-label">Client</label><select class="form-select" id="rdClient" onchange="CRM.redirClientChanged()"></select></div><div><label class="form-label">Sub-client</label><select class="form-select" id="rdSub" onchange="CRM.redirRender()"></select></div></div>'
    +'<div style="margin-top:10px"><label class="form-label">Linked claim <span style="text-transform:none;font-weight:400;color:var(--text3)">(optional)</span></label><select class="form-select" id="rdClaim" onchange="CRM.redirRender()"></select><div class="hint">A redirect can stand alone or attach to an existing claim on this container.</div></div>'
    +'<div class="msec">New invoice</div><div class="grid2"><div><label class="form-label">New invoice no. <span style="text-transform:none;font-weight:400;color:var(--text3)">(optional)</span></label><input class="form-input mono" id="rdInvoice" placeholder="fill when issued" oninput="CRM.redirRender()"/></div><div><label class="form-label">Onward date <span style="text-transform:none;font-weight:400;color:var(--text3)">(optional)</span></label><input class="form-input" type="date" id="rdDate"/></div></div>'
    +'<div class="msec">Preview</div><div class="scope-sum show" id="redirPreview" style="align-items:flex-start"><span class="ev-check">✓</span><span id="redirPreviewTxt"></span></div>'
    +'<div class="msec">Notes</div><textarea class="form-ta" id="rdNotes" style="height:52px;resize:vertical" placeholder="optional — reason for the redirect, agreed terms…"></textarea>'
    +'</div><div class="modal-foot" style="justify-content:flex-end"><button class="btn btn-secondary" onclick="CRM.requestCloseModal(\'redirModal\')">Close</button><button class="btn btn-primary" id="redirSaveBtn" onclick="CRM.saveRedirect()">Redirect</button></div></div></div>';
  }
  function redirClientOptions(sel){
    var list=(RR_CLIENTS||[]).slice().sort(function(a,b){return (a.name||'').localeCompare(b.name||'');});
    return '<option value="">— select client —</option>'+list.map(function(c){ return '<option value="'+esc(c.name)+'"'+(sel===c.name?' selected':'')+'>'+esc(c.name)+'</option>'; }).join('');
  }
  function redirSubOptions(clientName){
    var cid=((RR_CLIENTS||[]).find(function(c){return c.name===clientName;})||{}).id;
    var subs=(RR_SUBS||[]).filter(function(x){return !cid||x.client_id===cid;}).slice().sort(function(a,b){return (a.name||'').localeCompare(b.name||'');});
    return '<option value="">— none —</option>'+subs.map(function(x){ return '<option value="'+esc(x.name)+'">'+esc(x.name)+'</option>'; }).join('');
  }
  function redirClientChanged(){ var c=$('rdClient')?$('rdClient').value:''; if($('rdSub')) $('rdSub').innerHTML=redirSubOptions(c); redirRender(); }
  function redirCtn(i){ return Math.round(redirRows[i].pct/100*redirRows[i].ctn); }
  function redirTons(i){ return redirRows[i].pct/100*redirRows[i].tons; }
  function redirTotals(){ var c=0,t=0,n=0,sc=0,st=0; redirRows.forEach(function(r,i){ sc+=r.ctn; st+=r.tons; if(r.on&&r.pct>0){ c+=redirCtn(i); t+=redirTons(i); n++; } }); return {ctn:c,tons:t,rows:n,srcCtn:sc,srcTons:st}; }
  function setRedirScope(sc){
    redirScope=sc;
    var map={whole:'rdWhole',rows:'rdRows',part:'rdPart'};
    for(var kk in map){ var el=$(map[kk]); if(el) el.className='pill'+(kk===sc?' sel':''); }
    var hints={whole:'Copies every composition row at full returned quantity.',rows:'Tick the composition row(s) to redirect — each moves at its full returned quantity.',part:'Client re-sorted the load: tick a row and set the % of its net weight to redirect. The rest stays returned.'};
    if($('redirModeHint')) $('redirModeHint').textContent=hints[sc]||'';
    if(sc==='whole'){ redirRows.forEach(function(r){ r.on=true; r.pct=100; }); }
    if(sc==='rows'){ redirRows.forEach(function(r){ r.pct=100; }); }
    buildRedirRows(); redirRender();
  }
  function buildRedirRows(){
    var wrap=$('rdRowWrap'); if(!wrap) return;
    if(redirScope==='whole'){ wrap.innerHTML=''; wrap.style.display='none'; return; }
    wrap.style.display='flex';
    wrap.innerHTML=redirRows.map(function(r,i){
      var qty='';
      if(redirScope==='part'){
        qty='<div id="rdqb_'+i+'" style="display:flex;align-items:center;gap:8px;margin:6px 0 2px 23px'+(r.on?'':';opacity:.45;pointer-events:none')+'">'
          +'<span style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--text3);font-weight:600">Redirect</span>'
          +'<input class="form-input mono" id="rdpct_'+i+'" type="number" min="0" max="100" value="'+r.pct+'" style="width:74px;padding:5px 8px" oninput="CRM.redirPct('+i+',this.value)"/>'
          +'<span style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--text3);font-weight:600">% of net weight</span>'
          +'<input type="range" id="rdrng_'+i+'" min="0" max="100" value="'+r.pct+'" style="flex:1;max-width:130px;accent-color:var(--accent)" oninput="CRM.redirPct('+i+',this.value,true)"/>'
          +'<span class="mono" id="rdcp_'+i+'" style="font-size:11px;color:var(--accent);font-weight:500;white-space:nowrap">→ '+redirCtn(i).toLocaleString()+' ctn · '+redirTons(i).toFixed(2)+' t</span>'
          +'</div>';
      }
      return '<div><label class="row-opt" id="rdro_'+i+'"><input type="checkbox" id="rdck_'+i+'" '+(r.on?'checked':'')+' onchange="CRM.redirRowToggle('+i+',this.checked)"/><span class="row-opt-main"><b>'+esc(r.variety)+'</b> · <span class="mono">'+esc(r.farm)+'</span> · '+esc(r.ph)+' · '+esc(r.ctype)+'</span><span class="row-opt-qty">'+r.ctn.toLocaleString()+' ctn · '+r.tons.toFixed(2)+' t</span></label>'+qty+'</div>';
    }).join('');
  }
  function redirRowToggle(i,on){ redirRows[i].on=on; if(on&&redirScope!=='part') redirRows[i].pct=100; buildRedirRows(); redirRender(); }
  function redirPct(i,v,fromRange){
    var p=Math.max(0,Math.min(100, parseInt(v||'0',10)||0));
    redirRows[i].pct=p; redirRows[i].on=p>0;
    var ci=$('rdpct_'+i), cr=$('rdrng_'+i), cp=$('rdcp_'+i), ck=$('rdck_'+i), qb=$('rdqb_'+i);
    if(cr&&fromRange&&ci) ci.value=p;
    if(cr&&!fromRange) cr.value=p;
    if(cp) cp.textContent='→ '+redirCtn(i).toLocaleString()+' ctn · '+redirTons(i).toFixed(2)+' t';
    if(ck) ck.checked=redirRows[i].on;
    if(qb){ qb.style.opacity=redirRows[i].on?'1':'.45'; qb.style.pointerEvents=redirRows[i].on?'auto':'none'; }
    redirRender();
  }
  function redirRender(){
    var tt=redirTotals();
    var client=$('rdClient')?$('rdClient').value:''; var sub=$('rdSub')?$('rdSub').value:'';
    var inv=$('rdInvoice')?$('rdInvoice').value.trim():'';
    var target=client?(esc(client)+(sub?' / '+esc(sub):'')):'no client selected yet';
    var invClause=inv?('on new invoice <b class="mono">'+esc(inv)+'</b>'):'invoice to be issued';
    var partial=(tt.ctn>0 && tt.ctn<tt.srcCtn);
    var remCtn=Math.max(0, tt.srcCtn - tt.ctn);
    var txt='Redirecting <b>'+tt.ctn.toLocaleString()+' ctn · '+tt.tons.toFixed(2)+' t</b> ('+tt.rows+' of '+redirRows.length+' row'+(redirRows.length===1?'':'s')+(partial?', partial re-sort':'')+') → <b>'+target+'</b> '+invClause+'.<br>Traceability &amp; farm preserved; <b>'+remCtn.toLocaleString()+' ctn</b> stays returned.';
    if($('redirPreviewTxt')) $('redirPreviewTxt').innerHTML=txt;
    var btn=$('redirSaveBtn'); if(btn){ btn.textContent='Redirect '+tt.ctn.toLocaleString()+' ctn'; var dis=(tt.ctn===0||!client); btn.disabled=dis; btn.style.opacity=dis?'.6':'1'; }
  }
  function openRedirect(k){
    var s=shipByKey(k); redirCtx=s; if(!s) return;
    redirBusy=false; redirScope='whole';
    $('redirSub').textContent='New redirect · '+s.cn+' · from '+s.client;
    $('rdClient').innerHTML=redirClientOptions(''); redirClientChanged();
    $('rdClaim').innerHTML='<option value="">— none · redirect without a claim —</option>'+(s.claimId?'<option value="'+esc(s.claimId)+'" selected>'+esc(s.claimRefRaw||'this container’s claim')+'</option>':'');
    $('rdInvoice').value=''; if($('rdDate')) $('rdDate').value=''; if($('rdNotes')) $('rdNotes').value='';
    var build=function(){
      redirRows=(s.rows||[]).map(function(r){ return {variety:r.variety,farm:r.farm,ph:r.ph,ctype:r.ctype,carta:r.carta||'',ctn:Math.abs(num(r.cartons)||0),tons:Math.abs(num(r.netTons)||0),on:true,pct:100}; });
      var tc=redirRows.reduce(function(a,r){return a+r.ctn;},0), tn=redirRows.reduce(function(a,r){return a+r.tons;},0);
      var srcVerb=(s.status==='returned')?'returned across':'across';
      if($('redirSrc')) $('redirSrc').innerHTML=redirRows.length?('<b>'+tc.toLocaleString()+' ctn · '+tn.toFixed(2)+' t</b> '+srcVerb+' <b>'+redirRows.length+' composition row'+(redirRows.length>1?'s':'')+'</b>'+(s.claimId?' · claim <span class="mono">'+esc(s.claimRefRaw||'')+'</span> will be linked':'')+'. Traceability &amp; farm stay with the fruit.'):'No composition rows on file for this container yet.';
      setRedirScope('whole');
    };
    build();
    ensureRows(s).then(function(){ if(redirCtx===s) build(); });
    openModal('redirModal');
  }
  function redirErr(e){ var m=(e&&e.message)||String(e||''); if(/over-redirect/i.test(m)) return 'Over-redirect — a selected row is already fully redirected on another active redirect.'; if(/not authorised/i.test(m)) return 'You do not have access to this region.'; return 'Redirect failed — '+esc(m); }
  function saveRedirect(){
    var s=redirCtx; if(!s){ closeModal('redirModal'); return; }
    if(redirBusy) return;
    var client=$('rdClient')?$('rdClient').value:'';
    if(!client){ toast('Pick a target client for the redirect.'); return; }
    var rows=[];
    redirRows.forEach(function(r){ if(r.on&&r.pct>0){ rows.push({ variety:r.variety, farm:r.farm, packhouse:r.ph, carta:r.carta||null, carton_type:r.ctype, traceability_code:s.trace||null, source_cartons:r.ctn, source_net_tons:r.tons, redirect_pct:(redirScope==='part'?r.pct:100) }); } });
    if(!rows.length){ toast('Nothing selected to redirect.'); return; }
    var sub=$('rdSub')?$('rdSub').value:'';
    var payload={
      season_id:SEASON, product_id:txtOrNull((s.product||'').toLowerCase()),
      container_number:s.cn, voyage_key:s.key,
      origin_client:txtOrNull(s.client), origin_sub_client:txtOrNull(s.sub),
      target_client:client, target_sub_client:txtOrNull(sub), country:txtOrNull(s.country),
      scope:redirScope, status:'active',
      invoice_no:txtOrNull($('rdInvoice')&&$('rdInvoice').value),
      onward_date:txtOrNull($('rdDate')&&$('rdDate').value),
      claim_id:txtOrNull($('rdClaim')&&$('rdClaim').value),
      cqc_report_id:s.cqcId||null,
      notes:txtOrNull($('rdNotes')&&$('rdNotes').value),
      rows:rows, event:'created', event_detail:'→ '+client+(sub?' / '+sub:'')
    };
    redirBusy=true;
    var btn=$('redirSaveBtn'); if(btn){ btn.disabled=true; btn.textContent='Redirecting…'; }
    SB.rpc('save_crm_redirection_full',{payload:payload}).then(function(res){
      redirBusy=false;
      if(res&&res.error){ if(btn){ btn.disabled=false; redirRender(); } toast(redirErr(res.error)); return; }
      var out=res&&res.data||{};
      closeModal('redirModal');
      toast('Redirected · <b>'+esc(out.redirect_ref||client)+'</b> · '+((out.total_cartons)||0).toLocaleString()+' ctn');
      reload();
    }).catch(function(e){ redirBusy=false; if(btn){ btn.disabled=false; redirRender(); } toast(redirErr(e)); });
  }
  /* launch a redirect from inside the claim modal — goods needn't be Returned to be redirected.
     A saved claim (claimCtx.claimId) auto-links; an unsaved one opens the redirect unlinked. */
  function redirectFromClaim(){
    var s=claimCtx; if(!s){ return; }
    if(!s.claimId) toast('Tip: save the claim first if you want the redirect linked to it.');
    closeModal('claimModal');
    openRedirect(s.key);
  }
  function renderTimeline(evs){
    if(!evs||!evs.length) return '<div class="audit-item"><span class="audit-dot" style="background:var(--border2)"></span><span class="audit-main cell-sub">No lifecycle events yet.</span></div>';
    var dot={shipment:'var(--text3)',cqc:'var(--amber)',claim:'var(--red)',redirect:'var(--accent)'};
    return evs.map(function(e){
      var d=dot[e.source]||'var(--accent)'; if(e.event==='Returned') d='var(--red)';
      var ref=e.ref?' <span class="mono" style="color:var(--accent)">'+esc(e.ref)+'</span>':'';
      var src=e.source?'<span style="font-family:var(--font-mono);font-size:9px;text-transform:uppercase;letter-spacing:.04em;color:var(--text3);border:1px solid var(--border);border-radius:4px;padding:0 5px;margin-left:6px;white-space:nowrap">'+esc(e.source)+'</span>':'';
      return '<div class="audit-item"><span class="audit-dot" style="background:'+d+'"></span><span class="audit-main"><b>'+esc(e.event||'')+'</b>'+(e.detail?' · '+esc(e.detail):'')+ref+src+'</span><span class="audit-when">'+esc(fmtDate(e.at)||'')+'</span></div>';
    }).join('');
  }

  /* ══════════════ Invoices tab (invoice-level claims & redirects) ══════════════ */
  var invRedirMap=null;   /* {byInv:{}, byCont:{}} loaded lazily for the activity chips */
  function loadInvRedirs(){
    return crmFetchAll(function(){ return SB.from('crm_redirections').select('container_number,source_invoice_no,status').eq('season_id',SEASON).neq('status','cancelled'); }).then(function(data){
      var m={byInv:{},byCont:{}};
      (data||[]).forEach(function(x){ if(x.source_invoice_no) m.byInv[x.source_invoice_no]=true; if(x.container_number) m.byCont[invNcn(x.container_number)]=true; });
      invRedirMap=m;
    }).catch(function(){ invRedirMap={byInv:{},byCont:{}}; });
  }
  var claimSettledMap=null;   /* claim_id -> {v,c} for closed/settled claims, so the value shown reflects the negotiated amount */
  function loadClaimSettled(){
    return crmFetchAll(function(){ return SB.from('crm_claims').select('id,settled_value,settled_currency').eq('season_id',SEASON).not('settled_value','is',null); }).then(function(data){
      var m={}; (data||[]).forEach(function(x){ m[x.id]={v:x.settled_value,c:x.settled_currency}; }); claimSettledMap=m;
    }).catch(function(){ claimSettledMap={}; });
  }
  function claimValueHtml(c, withSub){
    if(!c) return '—';
    if(c.potential) return 'potential';
    if(c.status==='closed' && claimSettledMap && c.id && claimSettledMap[c.id]){
      var s=claimSettledMap[c.id]; var settled=esc(fmtMoney(s.v, s.c||c.currency));
      return withSub ? (settled+'<div class="cell-sub">settled · claimed '+esc(c.value||'—')+'</div>') : ('settled '+settled);
    }
    return esc(c.value||'—');
  }
  function renderRedirects(){
    var vc=$('viewContent'); if(!vc) return;
    vc.innerHTML='<div class="section-title"><span class="section-title-bar"></span>Redirects</div><div class="table-wrap"><div class="hint" style="padding:14px">Loading redirects…</div></div>';
    crmFetchAll(function(){ return SB.from('crm_redirections').select('id,redirect_ref,status,anchor,product_id,source_invoice_no,container_number,origin_client,origin_region_id,target_client,target_sub_client,target_region_id,invoice_no,total_cartons,total_net_tons,created_at').eq('season_id',SEASON).neq('status','cancelled').order('created_at',{ascending:false}); }).then(function(data){
      if(currentTab!=='redirects'||!MOUNTED) return;
      var list=(data||[]);
      if(currentRegion!=='all') list=list.filter(function(x){return x.origin_region_id===currentRegion||x.target_region_id===currentRegion;});
      if(currentProduct!=='all') list=list.filter(function(x){return (x.product_id||'')===String(currentProduct).toLowerCase();});
      var q=(currentQuery||'').toLowerCase();
      if(q) list=list.filter(function(x){return [x.redirect_ref,x.origin_client,x.target_client,x.target_sub_client,x.container_number,x.source_invoice_no,x.invoice_no].join(' ').toLowerCase().indexOf(q)>=0;});
      var head='<div class="section-title"><span class="section-title-bar"></span>Redirects <span class="section-count">'+list.length+' active</span></div>';
      if(!list.length){ vc.innerHTML=head+'<div class="table-wrap"><div class="empty-state">No redirects in this scope.<div class="cell-sub" style="margin-top:6px">Raise one from a returned container, a claim, or the <b>Invoices</b> tab.</div></div></div>'; return; }
      var rows=list.map(function(x){
        var tgt=esc(x.target_client||'—')+(x.target_sub_client?' <span class="cell-sub">/ '+esc(x.target_sub_client)+'</span>':'');
        var act=x.anchor==='invoice'
          ? '<button class="btn btn-secondary btn-sm" data-crm-act="invEditRedirect" data-crm-key="'+esc(x.id)+'">Edit</button>'
          : '<button class="btn btn-danger btn-sm" data-crm-act="cancelRedirect" data-crm-key="'+esc(x.id)+'">Cancel</button>';
        var rowOpen=(x.anchor!=='invoice'&&x.container_number)?' class="click" role="button" tabindex="0" aria-label="Open container '+esc(x.container_number)+'" data-crm-act="openShipByCn" data-crm-key="'+esc(x.container_number)+'"':'';
        return '<tr'+rowOpen+'><td><span class="lot">'+esc(x.redirect_ref||'—')+'</span><div class="cell-sub">'+esc(fmtDate(x.created_at)||'')+'</div></td>'
          +'<td>'+esc(x.origin_client||'—')+'<div class="cell-sub mono">'+esc(x.container_number||'')+(x.source_invoice_no?' · inv '+esc(x.source_invoice_no):'')+'</div></td>'
          +'<td><span style="color:var(--accent)">→</span> '+tgt+(x.invoice_no?'<div class="cell-sub">new inv '+esc(x.invoice_no)+'</div>':'')+'</td>'
          +'<td class="right">'+(x.total_cartons||0).toLocaleString()+' ctn<div class="cell-sub">'+tonCell(x.total_net_tons)+'</div></td>'
          +'<td class="right">'+act+'</td></tr>';
      }).join('');
      vc.innerHTML=head+'<div class="hint" style="margin:-4px 0 10px">All redirected goods for your regions — origin → target. A redirect lands here for both the sending and the receiving side.</div><div class="table-wrap"><table class="wl"><thead><tr><th>Redirect</th><th>From (origin)</th><th>To (target)</th><th class="right">Qty</th><th class="right">Action</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
    }).catch(function(e){ if(currentTab==='redirects') vc.innerHTML='<div class="empty-state">Failed to load redirects — '+esc((e&&e.message)||e)+'</div>'; });
  }
  function renderInvoices(){
    var vc=$('viewContent'); if(!vc) return;
    var list=visibleShipments(), groups={}, order=[];
    list.forEach(function(s){ var inv=s.invoice; if(!inv||inv==='—') return;
      if(!groups[inv]){ groups[inv]={inv:inv,client:s.client,region:s.region,conts:{},cns:{},ctn:0,tons:0,claim:false}; order.push(inv); }
      var g=groups[inv]; g.conts[s.key]=1; g.cns[invNcn(s.cn)]=1; g.ctn+=(s.cartons||0); g.tons+=(s.netTons||0); if(s.claim) g.claim=true; });
    var arr=order.map(function(inv){ var g=groups[inv]; g.nc=Object.keys(g.conts).length; return g; });
    arr.sort(function(a,b){ return b.ctn-a.ctn; });
    var head='<div class="section-title"><span class="section-title-bar"></span>Invoices <span class="section-count">'+arr.length.toLocaleString()+' invoices in scope</span></div>';
    if(!arr.length){ vc.innerHTML=head+'<div class="table-wrap"><div class="empty-state">No invoices in this scope.</div></div>'; return; }
    var page=pageState.invoices, slice=arr.slice(page*PER_PAGE,(page+1)*PER_PAGE);
    var rows=slice.map(function(g){
      var act='';
      if(g.claim) act+='<span class="badge b-warn" title="claim on this invoice">claim</span> ';
      var hasR=invRedirMap && (invRedirMap.byInv[g.inv] || Object.keys(g.cns).some(function(k){return invRedirMap.byCont[k];}));
      if(hasR) act+='<span class="badge b-neutral" style="border-color:var(--green-border);color:var(--accent);background:var(--green-bg)" title="redirect on this invoice">redirect</span>';
      if(!act) act='<span class="cell-sub">—</span>';
      return '<tr class="click" data-crm-act="openInvoice" data-crm-key="'+esc(g.inv)+'"><td><span class="lot">'+esc(g.inv)+'</span></td>'+
        '<td>'+esc(g.client)+'<div class="cell-sub">'+esc(regionLabel[g.region]||g.region)+'</div></td>'+
        '<td class="right">'+g.nc+'</td><td class="right">'+g.ctn.toLocaleString()+'</td><td class="right">'+tonCell(g.tons)+'</td><td>'+act+'</td></tr>';
    }).join('');
    vc.innerHTML=head+'<div class="table-wrap"><table class="wl"><thead><tr><th>Invoice #</th><th>Client</th><th class="right">Cntrs</th><th class="right">Cartons</th><th class="right">Net t</th><th>Activity</th></tr></thead><tbody>'+rows+'</tbody></table></div>'+pagerHtml(arr.length,page,'invoices');
    if(!invRedirMap) loadInvRedirs().then(function(){ if(currentTab==='invoices'&&MOUNTED) renderInvoices(); });
  }
  function invNcn(x){ return String(x||'').toUpperCase().replace(/\s+/g,' ').trim(); }
  function invMoney(n){ return n==null?'—':Number(n).toLocaleString(); }
  function loadInvoiceActivity(inv, cb){
    var conts=visibleShipments().filter(function(s){return s.invoice===inv;});
    var cnList=conts.map(function(s){return s.cn;});
    if(!cnList.length){ cb([],[]); return; }
    Promise.all([
      SB.from('crm_claims').select('id,claim_ref,status,anchor,invoice_no,container_number,claimed_value,claimed_currency,settled_value,settled_currency').in('container_number',cnList).neq('status','cancelled'),
      SB.from('crm_redirections').select('id,redirect_ref,status,anchor,source_invoice_no,container_number,target_client,target_sub_client,total_cartons').in('container_number',cnList).neq('status','cancelled')
    ]).then(function(r){ cb(((r[0]&&r[0].data)||[]),((r[1]&&r[1].data)||[])); }).catch(function(){ cb([],[]); });
  }
  function renderInvActivity(inv, conts, claims, redirs){
    var byCn={}; conts.forEach(function(s){byCn[s.cn]=s;});
    var cr = claims.length ? claims.map(function(c){
      var st=c.status==='closed'?'<span class="badge b-neutral">Closed</span>':'<span class="badge b-fail">Open</span>';
      var val=(c.status==='closed'&&c.settled_value!=null)
        ?('<b>'+invMoney(c.settled_value)+' '+esc(c.settled_currency||c.claimed_currency||'')+'</b><div class="cell-sub">settled · claimed '+invMoney(c.claimed_value)+'</div>')
        :(c.claimed_value!=null?(invMoney(c.claimed_value)+' '+esc(c.claimed_currency||'')):'—');
      var tag=c.anchor==='invoice'?'invoice':('container '+esc(c.container_number));
      var act=c.anchor==='invoice'
        ?'<button class="btn btn-secondary btn-sm" data-crm-act="invEditClaim" data-crm-key="'+esc(c.id)+'">Edit</button>'
        :'<button class="btn btn-secondary btn-sm" data-crm-act="openShipDetail" data-crm-key="'+esc((byCn[c.container_number]||{}).key||'')+'">Open →</button>';
      return '<tr><td><span class="lot">'+esc(c.claim_ref||'—')+'</span><div class="cell-sub">'+tag+'</div></td><td>'+st+'</td><td class="right">'+val+'</td><td class="right">'+act+'</td></tr>';
    }).join('') : '<tr><td colspan="4" class="cell-sub">No claims on this invoice.</td></tr>';
    var rr = redirs.length ? redirs.map(function(x){
      var act=x.anchor==='invoice'
        ?'<button class="btn btn-secondary btn-sm" data-crm-act="invEditRedirect" data-crm-key="'+esc(x.id)+'">Edit</button>'
        :'<button class="btn btn-secondary btn-sm" data-crm-act="openShipDetail" data-crm-key="'+esc((byCn[x.container_number]||{}).key||'')+'">Open →</button>';
      return '<tr><td><span class="lot">'+esc(x.redirect_ref||'—')+'</span></td><td>→ '+esc(x.target_client||'—')+(x.target_sub_client?' / '+esc(x.target_sub_client):'')+'</td><td class="right">'+(x.total_cartons||0).toLocaleString()+' ctn</td><td class="right">'+act+'</td></tr>';
    }).join('') : '<tr><td colspan="4" class="cell-sub">No redirects on this invoice.</td></tr>';
    return '<div class="section-title" style="margin-top:12px"><span class="section-title-bar"></span>Claims <span class="section-count">'+claims.length+'</span></div><div class="table-wrap"><table class="wl"><tbody>'+cr+'</tbody></table></div>'
      +'<div class="section-title" style="margin-top:12px"><span class="section-title-bar"></span>Redirects <span class="section-count">'+redirs.length+'</span></div><div class="table-wrap"><table class="wl"><tbody>'+rr+'</tbody></table></div>';
  }
  function openInvoice(inv){
    var conts=visibleShipments().filter(function(s){return s.invoice===inv;});
    if(!conts.length) return;
    var c0=conts[0];
    var ctn=conts.reduce(function(a,s){return a+(s.cartons||0);},0), tons=conts.reduce(function(a,s){return a+(s.netTons||0);},0);
    var allRedir=conts.every(function(s){return s.redirectedIn;});
    var head='<div class="dlv-head"><div><div class="dlv-id" style="font-family:var(--font-mono)">Invoice '+esc(inv)+'</div><div class="dlv-meta">'+esc(c0.client)+' · '+esc(regionLabel[c0.region]||c0.region)+' · '+conts.length+' container'+(conts.length>1?'s':'')+(allRedir?' · redirected in':'')+'</div></div></div>';
    var actions=allRedir
      ? '<div class="scope-lock" style="border-color:var(--green-border);margin:12px 0">↩ Redirected in from <b>'+esc(c0.originClient)+'</b> · '+esc(c0.redirectRef||'')+'. This invoice was created by the redirect — manage it from the <b>Redirects</b> tab.</div>'
      : '<div style="display:flex;gap:8px;margin:12px 0;flex-wrap:wrap"><button class="btn btn-primary btn-sm" data-crm-act="invClaim" data-crm-key="'+esc(inv)+'">Raise claim →</button><button class="btn btn-secondary btn-sm" data-crm-act="invRedirect" data-crm-key="'+esc(inv)+'">Redirect →</button></div>';
    var kpis=kpiStrip([['Cartons',ctn.toLocaleString(),''],['Net weight',tonCell(tons),''],['Containers',String(conts.length),'']]);
    var cl=conts.map(function(s){ return '<tr class="click" role="button" tabindex="0" data-crm-act="openShipDetail" data-crm-key="'+esc(s.key)+'"><td><span class="lot">'+esc(s.cn)+'</span></td><td>'+esc(s.varieties?s.varieties.join(' / '):s.variety)+'</td><td class="right">'+(s.cartons||0).toLocaleString()+'</td><td class="right">'+tonCell(s.netTons)+'</td></tr>'; }).join('');
    var tbl='<div class="section-title" style="margin-top:12px"><span class="section-title-bar"></span>Containers</div><div class="table-wrap"><table class="wl"><thead><tr><th>Container</th><th>Variety</th><th class="right">Cartons</th><th class="right">Net t</th></tr></thead><tbody>'+cl+'</tbody></table></div>';
    showDlv('Invoice '+inv, head+actions+kpis+'<div id="invActivity"><div class="hint" style="margin-top:12px">Loading claims &amp; redirects…</div></div>'+tbl);
    loadInvoiceActivity(inv, function(claims,redirs){ var el=$('invActivity'); if(el&&$('dlv')&&$('dlv').classList.contains('open')) el.innerHTML=renderInvActivity(inv,conts,claims,redirs); });
  }

  /* ── invoice claim & redirect modals (shared part-load picker grouped by container) ── */
  var invCtx=null, invPL=[], invMode='claim', invBusy=false;
  function _openInv(inv,then){
    var conts=visibleShipments().filter(function(s){return s.invoice===inv;});
    if(!conts.length) return;
    var c0=conts[0];
    invCtx={inv:inv,client:c0.client,sub:c0.sub,country:c0.country,region:c0.region,product:c0.product,conts:conts};
    Promise.all(conts.map(ensureRows)).then(function(){ invSeedRows(); then(); });
  }
  function invSeedRows(){
    /* aggregate composition rows into one selectable line per part-load (container · variety · farm · packhouse);
       multiple crm_shipment_rows that share these differ only by quantity and are the same commercial part-load —
       collapsing them keeps the picker clean AND makes edit/guard matching unambiguous */
    invPL=[]; var idx={};
    invCtx.conts.forEach(function(s){ (s.rows||[]).forEach(function(r){
      var key=s.cn+'|'+(r.variety||'')+'|'+(r.farm||'')+'|'+(r.ph||'');
      var e=idx[key];
      if(!e){ e={cn:s.cn, v:r.variety, farm:r.farm, ph:r.ph, ctype:r.ctype, carta:r.carta||'', trace:s.trace||null, ctn:0, tons:0, on:false, pct:100}; idx[key]=e; invPL.push(e); }
      e.ctn+=Math.abs(num(r.cartons)||0); e.tons+=Math.abs(num(r.netTons)||0);
    }); });
  }
  function invCtn(i){ return Math.round(invPL[i].pct/100*invPL[i].ctn); }
  function invTons(i){ return invPL[i].pct/100*invPL[i].tons; }
  function invPickerHtml(withPct){
    var byCn={}, order=[];
    invPL.forEach(function(r,i){ if(!byCn[r.cn]){byCn[r.cn]=[];order.push(r.cn);} byCn[r.cn].push(i); });
    return order.map(function(cn){
      var idxs=byCn[cn];
      var gc=idxs.reduce(function(a,i){return a+invPL[i].ctn;},0), gt=idxs.reduce(function(a,i){return a+invPL[i].tons;},0);
      var rowsHtml=idxs.map(function(i){
        var r=invPL[i];
        var qty=(withPct&&r.on)?('<div id="ipqb_'+i+'" style="display:flex;align-items:center;gap:8px;padding:6px 10px 4px 24px"><span style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--text3);font-weight:600">Redirect</span><input class="form-input mono" id="ippct_'+i+'" type="number" min="0" max="100" value="'+r.pct+'" style="width:66px;padding:4px 7px" oninput="CRM.invPct('+i+',this.value)"/><span style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--text3);font-weight:600">% of net wt</span><input type="range" id="iprng_'+i+'" min="0" max="100" value="'+r.pct+'" style="flex:1;max-width:110px;accent-color:var(--accent)" oninput="CRM.invPct('+i+',this.value,1)"/><span class="mono" id="ipcp_'+i+'" style="font-size:11px;color:var(--accent);font-weight:500;white-space:nowrap">→ '+invCtn(i).toLocaleString()+' ctn · '+invTons(i).toFixed(2)+' t</span></div>'):'';
        return '<label class="row-opt" style="margin:0 6px 5px"><input type="checkbox" '+(r.on?'checked':'')+' onchange="CRM.invToggle('+i+',this.checked)"/><span class="row-opt-main"><b>'+esc(r.v)+'</b> · <span class="mono">'+esc(r.farm)+'</span> · '+esc(r.ph)+(r.carta?' · carta '+esc(r.carta):'')+'</span><span class="row-opt-qty">'+r.ctn.toLocaleString()+' ctn · '+r.tons.toFixed(2)+' t</span></label>'+qty;
      }).join('');
      return '<div style="border:1px solid var(--border2);border-radius:8px;margin-bottom:8px;overflow:hidden"><div style="display:flex;align-items:center;gap:9px;padding:8px 10px;background:var(--bg2)"><span class="mono" style="font-weight:600;flex:1;font-size:12px">'+esc(cn)+'</span><span class="mono" style="font-size:11px;color:var(--text3)">'+gc.toLocaleString()+' ctn · '+gt.toFixed(2)+' t</span></div><div style="padding-top:6px">'+rowsHtml+'</div></div>';
    }).join('');
  }
  function buildInvPicker(){ var el=$(invMode==='claim'?'icPicker':'irPicker'); if(el) el.innerHTML=invPickerHtml(invMode==='redirect'); }
  function invToggle(i,on){ invPL[i].on=on; if(on&&invMode!=='redirect') invPL[i].pct=100; buildInvPicker(); invRender(); }
  function invPct(i,v,fromRange){
    var p=Math.max(0,Math.min(100,parseInt(v||'0',10)||0)); invPL[i].pct=p; invPL[i].on=p>0;
    var ci=$('ippct_'+i), cr=$('iprng_'+i), cp=$('ipcp_'+i);
    if(cr&&fromRange&&ci) ci.value=p; if(cr&&!fromRange) cr.value=p;
    if(cp) cp.textContent='→ '+invCtn(i).toLocaleString()+' ctn · '+invTons(i).toFixed(2)+' t';
    invRender();
  }
  function invRender(){
    var claim=(invMode==='claim');
    var totalC={}; invPL.forEach(function(r){ totalC[r.cn]=1; }); totalC=Object.keys(totalC).length;
    var sel=[]; invPL.forEach(function(r,i){ if(r.on&&(claim||r.pct>0)) sel.push(i); });
    var ctn=sel.reduce(function(a,i){return a+(claim?invPL[i].ctn:invCtn(i));},0);
    var tons=sel.reduce(function(a,i){return a+(claim?invPL[i].tons:invTons(i));},0);
    var cns={}; sel.forEach(function(i){cns[invPL[i].cn]=1;}); var nc=Object.keys(cns).length;
    if(claim){
      var t=sel.length?('Claiming <b>'+ctn.toLocaleString()+' ctn · '+tons.toFixed(2)+' t</b> across <b>'+nc+' of '+totalC+' containers</b> on invoice <b class="mono">'+esc(invCtx.inv)+'</b>.<br>Rows pinned to variety · farm · packhouse; the rest of the invoice stays claimable.'):'No part-loads selected yet — tick the rows this claim covers.';
      if($('icPreviewTxt')) $('icPreviewTxt').innerHTML=t;
      var cverb=(invCtx&&invCtx.claimId)?'Save claim':'Raise claim';
      var b=$('icSave'); if(b){ b.textContent=sel.length?(cverb+' · '+ctn.toLocaleString()+' ctn'):cverb; b.style.opacity=sel.length?'1':'.6'; }
    } else {
      var client=$('irClient')?$('irClient').value:'', sub=$('irSub')?$('irSub').value:'';
      var target=client?(esc(client)+(sub?' / '+esc(sub):'')):'no client selected yet';
      var t2=sel.length?('Redirecting <b>'+ctn.toLocaleString()+' ctn · '+tons.toFixed(2)+' t</b> across <b>'+nc+' of '+totalC+' containers</b> → <b>'+target+'</b>.<br>Traceability &amp; farm preserved; each part-load capped at 100% across active redirects.'):'No part-loads selected yet — tick the rows to redirect.';
      if($('irPreviewTxt')) $('irPreviewTxt').innerHTML=t2;
      var rverb=(invCtx&&invCtx.redirectId)?'Save redirect':'Redirect';
      var b2=$('irSave'); if(b2){ var ok=sel.length&&client; b2.textContent=sel.length?(rverb+' · '+ctn.toLocaleString()+' ctn'):rverb; b2.style.opacity=ok?'1':'.6'; }
    }
  }
  var invLifecycle='open';
  function setInvLifecycle(lc){ invLifecycle=lc; [].forEach.call(ROOT.querySelectorAll('#icLifecycle .lc-step'),function(el){ el.className='lc-step'+(el.getAttribute('data-lc')===lc?' sel-'+lc:''); }); var cf=$('icClosing'); if(cf) cf.style.display=lc==='closed'?'block':'none'; }
  function openInvClaim(inv){ invMode='claim'; _openInv(inv,function(){
    invCtx.claimId=null; invCtx.loaded=null;
    $('icInv').textContent=invCtx.inv; $('icSub').textContent=invCtx.client+' · '+(regionLabel[invCtx.region]||invCtx.region)+' · '+invCtx.conts.length+' containers';
    ['icBl','icVal','icRef','icNotes','icSettled'].forEach(function(id){ setVal(id,''); }); if($('icReason'))$('icReason').selectedIndex=0; if($('icCur'))$('icCur').selectedIndex=0; if($('icRes'))$('icRes').selectedIndex=0;
    if($('icCancel'))$('icCancel').style.display='none'; if($('icSave'))$('icSave').textContent='Raise claim';
    buildInvPicker(); invRender(); openModal('invClaimModal'); }); }
  function openInvEditClaim(id){ invMode='claim';
    Promise.all([SB.from('crm_claims').select('*').eq('id',id).limit(1), SB.from('crm_claim_rows').select('*').eq('claim_id',id)]).then(function(r){
      var c=((r[0]&&r[0].data)||[])[0]; if(!c){ toast('Claim not found.'); return; } var crows=(r[1]&&r[1].data)||[];
      /* Once submitted/closed, invoice claims are reviewed/settled through the same gate as container claims — open the (read-only for approvers) claim modal instead of the editable invoice modal. */
      if(c.status!=='open'){ var _sh=null; for(var _i=0;_i<SHIPMENTS.length;_i++){ if(SHIPMENTS[_i].cn===c.container_number){ _sh=SHIPMENTS[_i]; break; } } if(_sh){ closeDlv(); openClaim(_sh.key); } else { toast('Open this claim from Shipments — container '+esc(c.container_number)+'.'); } return; }
      _openInv(c.invoice_no, function(){
        invCtx.claimId=c.id; invCtx.loaded=c.updated_at;
        invPL.forEach(function(pr){ pr.on=crows.some(function(cr){ return invNcn(cr.ship_container)===invNcn(pr.cn)&&(cr.variety||'')===(pr.v||'')&&(cr.farm||'')===(pr.farm||'')&&(cr.packhouse||'')===(pr.ph||''); }); });
        $('icInv').textContent=c.invoice_no; $('icSub').textContent=invCtx.client+' · edit '+(c.claim_ref||'');
        setVal('icBl',c.bl_number); setVal('icVal',c.claimed_value); setVal('icRef',c.client_ref); setVal('icNotes',c.notes); setVal('icSettled',c.settled_value);
        if(c.reason&&$('icReason'))$('icReason').value=c.reason; if(c.claimed_currency&&$('icCur'))$('icCur').value=c.claimed_currency; if(c.resolution_type&&$('icRes'))$('icRes').value=c.resolution_type;
        if($('icCancel'))$('icCancel').style.display='inline'; if($('icSave'))$('icSave').textContent='Save claim';
        buildInvPicker(); invRender(); openModal('invClaimModal');
      });
    }).catch(function(e){ toast('Could not load claim — '+esc((e&&e.message)||e)); });
  }
  function invCancelClaim(){ if(!invCtx||!invCtx.claimId){ closeModal('invClaimModal'); return; } if(invBusy) return;
    crmConfirm('Cancel this claim? It stays in history as Cancelled and frees the part-loads.', function(){
      invBusy=true; SB.rpc('save_crm_claim_full',{payload:{ id:invCtx.claimId, loaded_version:invCtx.loaded, season_id:SEASON, container_number:invCtx.conts[0].cn, anchor:'invoice', invoice_no:invCtx.inv, bl_number:'—', status:'cancelled', event:'cancelled', event_detail:'cancelled' }}).then(function(res){ invBusy=false; if(res&&res.error){ toast(claimErr(res.error)); return; } closeModal('invClaimModal'); toast('Claim cancelled.'); reload(); }).catch(function(e){ invBusy=false; toast(claimErr(e)); });
    }, 'Cancel claim'); }
  function openInvRedirect(inv){ invMode='redirect'; _openInv(inv,function(){
    invCtx.redirectId=null; invCtx.loaded=null;
    $('irInvNo').textContent=invCtx.inv; $('irSubT').textContent=invCtx.client+' · '+(regionLabel[invCtx.region]||invCtx.region)+' · '+invCtx.conts.length+' containers';
    $('irClient').innerHTML=redirClientOptions(''); $('irSub').innerHTML=redirSubOptions(''); setVal('irInv',''); setVal('irNotes','');
    if($('irCancel'))$('irCancel').style.display='none'; if($('irSave'))$('irSave').textContent='Redirect';
    buildInvPicker(); invRender(); openModal('invRedirModal'); }); }
  function openInvEditRedirect(id){ invMode='redirect';
    Promise.all([SB.from('crm_redirections').select('*').eq('id',id).limit(1), SB.from('crm_redirection_rows').select('*').eq('redirect_id',id)]).then(function(r){
      var x=((r[0]&&r[0].data)||[])[0]; if(!x){ toast('Redirect not found.'); return; } var xrows=(r[1]&&r[1].data)||[];
      _openInv(x.source_invoice_no, function(){
        invCtx.redirectId=x.id; invCtx.loaded=x.updated_at;
        invPL.forEach(function(pr){ var m=xrows.filter(function(cr){ return invNcn(cr.ship_container)===invNcn(pr.cn)&&(cr.variety||'')===(pr.v||'')&&(cr.farm||'')===(pr.farm||'')&&(cr.packhouse||'')===(pr.ph||''); })[0]; if(m){ pr.on=true; pr.pct=Number(m.redirect_pct)||100; } });
        $('irInvNo').textContent=x.source_invoice_no||invCtx.inv; $('irSubT').textContent=invCtx.client+' · edit '+(x.redirect_ref||'');
        $('irClient').innerHTML=redirClientOptions(x.target_client||''); $('irSub').innerHTML=redirSubOptions(x.target_client||''); if(x.target_sub_client&&$('irSub'))$('irSub').value=x.target_sub_client;
        setVal('irInv',x.invoice_no); setVal('irNotes',x.notes);
        if($('irCancel'))$('irCancel').style.display='inline'; if($('irSave'))$('irSave').textContent='Save redirect';
        buildInvPicker(); invRender(); openModal('invRedirModal');
      });
    }).catch(function(e){ toast('Could not load redirect — '+esc((e&&e.message)||e)); });
  }
  function invCancelRedirect(){ if(!invCtx||!invCtx.redirectId){ closeModal('invRedirModal'); return; } if(invBusy) return;
    crmConfirm('Cancel this redirect? It stays in history and frees the part-loads.', function(){
      invBusy=true; SB.rpc('save_crm_redirection_full',{payload:{ id:invCtx.redirectId, loaded_version:invCtx.loaded, season_id:SEASON, container_number:invCtx.conts[0].cn, anchor:'invoice', source_invoice_no:invCtx.inv, target_client:($('irClient')&&$('irClient').value)||invCtx.client, status:'cancelled', event:'cancelled', event_detail:'cancelled' }}).then(function(res){ invBusy=false; if(res&&res.error){ toast(redirErr(res.error)); return; } closeModal('invRedirModal'); invRedirMap=null; toast('Redirect cancelled.'); reload(); }).catch(function(e){ invBusy=false; toast(redirErr(e)); });
    }, 'Cancel redirect'); }
  function invRedirClientChanged(){ var c=$('irClient')?$('irClient').value:''; if($('irSub')) $('irSub').innerHTML=redirSubOptions(c); invRender(); }
  /* cancel a container-anchored redirect from the Redirects list (invoice ones cancel from their modal) — P0-2 */
  function cancelRedirect(id){
    SB.from('crm_redirections').select('id,updated_at,season_id,anchor,source_invoice_no,container_number,target_client,redirect_ref,status').eq('id',id).limit(1).then(function(r){
      var x=((r&&r.data)||[])[0]; if(!x){ toast('Redirect not found.'); return; }
      if(x.status==='cancelled'){ toast('Already cancelled.'); return; }
      crmConfirm('Cancel redirect <b>'+esc(x.redirect_ref||'')+'</b> on <span class="mono">'+esc(x.container_number||'')+'</span>?<br>It stays in history as Cancelled and the goods are freed to redirect again.', function(){
        SB.rpc('save_crm_redirection_full',{payload:{ id:x.id, loaded_version:x.updated_at||null, season_id:x.season_id, container_number:x.container_number, anchor:x.anchor||'container', source_invoice_no:x.source_invoice_no||null, target_client:x.target_client, status:'cancelled', event:'cancelled', event_detail:'cancelled by user' }}).then(function(res){
          if(res&&res.error){ toast(redirErr(res.error)); return; }
          toast('Redirect <b>cancelled</b>.'); reload();
        }).catch(function(e){ toast(redirErr(e)); });
      }, 'Cancel redirect');
    }).catch(function(e){ toast('Could not load redirect — '+esc((e&&e.message)||e)); });
  }
  /* open the source container's drawer from a redirect row (best-effort by container number) — P0-2 / interaction #12 */
  function openShipByCn(cn){ var hit=null; for(var i=0;i<SHIPMENTS.length;i++){ if(SHIPMENTS[i].cn===cn){ hit=SHIPMENTS[i]; break; } } if(hit) openShipDetail(hit.key); else toast('That container is not in the current region/season view.'); }
  function saveInvClaim(){
    if(invBusy) return;
    var bl=$('icBl'); if(!bl.value.trim()){ toast('B/L number is required.'); bl.focus(); return; }
    var rows=[]; invPL.forEach(function(r){ if(r.on){ rows.push({ship_container:r.cn, ship_carta:r.carta||null, variety:r.v, farm:r.farm, packhouse:r.ph, cartons:r.ctn, net_tons:r.tons}); } });
    if(!rows.length){ toast('Tick at least one part-load.'); return; }
    var payload={ id:invCtx.claimId||null, loaded_version:invCtx.loaded||null,
      season_id:SEASON, product_id:txtOrNull((invCtx.product||'').toLowerCase()), container_number:rows[0].ship_container,
      anchor:'invoice', invoice_no:invCtx.inv, scope:'part', status:'open',
      client:txtOrNull(invCtx.client), sub_client:txtOrNull(invCtx.sub), country:txtOrNull(invCtx.country),
      bl_number:bl.value.trim(), reason:txtOrNull($('icReason')&&$('icReason').value), client_ref:txtOrNull($('icRef')&&$('icRef').value),
      claimed_value:numOrNull($('icVal')&&$('icVal').value), claimed_currency:txtOrNull($('icCur')&&$('icCur').value),
      notes:txtOrNull($('icNotes')&&$('icNotes').value), rows:rows,
      event:(invCtx.claimId?'updated':'raised'), event_detail:'invoice '+invCtx.inv };
    invBusy=true; var b=$('icSave'); if(b){b.disabled=true;b.textContent='Saving…';}
    SB.rpc('save_crm_claim_full',{payload:payload}).then(function(res){ invBusy=false; if(b)b.disabled=false;
      if(res&&res.error){ if(b)b.textContent=(invCtx.claimId?'Save claim':'Raise claim'); toast(claimErr(res.error)); return; }
      closeModal('invClaimModal'); toast('Claim saved · <b>'+esc((res.data&&res.data.claim_ref)||invCtx.inv)+'</b>'); reload(); }).catch(function(e){ invBusy=false; if(b){b.disabled=false;b.textContent=(invCtx.claimId?'Save claim':'Raise claim');} toast(claimErr(e)); });
  }
  function saveInvRedirect(){
    if(invBusy) return;
    var client=$('irClient')?$('irClient').value:''; if(!client){ toast('Pick a target client.'); return; }
    var rows=[]; invPL.forEach(function(r){ if(r.on&&r.pct>0){ rows.push({ship_container:r.cn, variety:r.v, farm:r.farm, packhouse:r.ph, carta:r.carta||null, carton_type:r.ctype, traceability_code:r.trace||null, source_cartons:r.ctn, source_net_tons:r.tons, redirect_pct:r.pct}); } });
    if(!rows.length){ toast('Tick at least one part-load.'); return; }
    var sub=$('irSub')?$('irSub').value:'';
    var payload={ id:invCtx.redirectId||null, loaded_version:invCtx.loaded||null,
      season_id:SEASON, product_id:txtOrNull((invCtx.product||'').toLowerCase()), container_number:rows[0].ship_container,
      anchor:'invoice', source_invoice_no:invCtx.inv, scope:'part', status:'active',
      origin_client:txtOrNull(invCtx.client), origin_sub_client:txtOrNull(invCtx.sub), country:txtOrNull(invCtx.country),
      target_client:client, target_sub_client:txtOrNull(sub), invoice_no:txtOrNull($('irInv')&&$('irInv').value),
      notes:txtOrNull($('irNotes')&&$('irNotes').value), rows:rows, event:(invCtx.redirectId?'updated':'created'), event_detail:'invoice '+invCtx.inv+' → '+client };
    invBusy=true; var b=$('irSave'); if(b){b.disabled=true;b.textContent='Saving…';}
    SB.rpc('save_crm_redirection_full',{payload:payload}).then(function(res){ invBusy=false; if(b)b.disabled=false;
      if(res&&res.error){ if(b)b.textContent=(invCtx.redirectId?'Save redirect':'Redirect'); toast(redirErr(res.error)); return; }
      closeModal('invRedirModal'); invRedirMap=null; toast('Redirect saved · <b>'+esc((res.data&&res.data.redirect_ref)||client)+'</b>'); reload(); }).catch(function(e){ invBusy=false; if(b){b.disabled=false;b.textContent=(invCtx.redirectId?'Save redirect':'Redirect');} toast(redirErr(e)); });
  }
  function invClaimModalHtml(){ return ''
    +'<div class="modal-bg" id="invClaimModal"><div class="modal"><div class="modal-head"><span class="modal-x" role="button" tabindex="0" aria-label="Close" onclick="CRM.requestCloseModal(\'invClaimModal\')">&times;</span><div class="modal-title">Claim — invoice <span class="mono" id="icInv"></span></div><div class="modal-sub" id="icSub">—</div></div><div class="modal-body">'
    +'<div class="msec" style="border-top:none;padding-top:0;margin-top:0">Status</div><div class="hint" style="margin:-4px 0 10px">Raising an invoice claim opens it as <b>Active</b>. Settle it later from the claim (Record settlement) — the settlement goes through approval before the claim closes.</div>'
    +'<div class="msec">Affected part-loads</div><div class="hint" style="margin:-4px 0 10px">Tick the composition rows this claim covers — across the invoice\'s containers.</div><div id="icPicker"></div>'
    +'<div class="msec">Claim details</div><div class="form-row" style="margin-bottom:10px"><label class="form-label">B/L number <span style="color:var(--red)">*</span></label><input class="form-input mono" id="icBl" placeholder="e.g. MAEU236451078"/></div>'
    +'<div class="grid2" style="margin-bottom:10px"><div><label class="form-label">Reason</label><select class="form-select" id="icReason"><option>Decay / rot on arrival</option><option>Temperature abuse in transit</option><option>Soft / overripe berries</option><option>Short weight</option><option>Wrong variety / spec</option><option>Late arrival / missed market</option><option>Documentation</option><option>Other</option></select></div><div><label class="form-label">Client\'s claim ref <span style="text-transform:none;font-weight:400;color:var(--text3)">(optional)</span></label><input class="form-input mono" id="icRef" placeholder="their reference #"/></div></div>'
    +'<div class="grid3"><div style="grid-column:span 2"><label class="form-label">Claimed value</label><input class="form-input mono" id="icVal" inputmode="decimal" placeholder="what the client is claiming"/></div><div><label class="form-label">Currency</label><select class="form-select" id="icCur"><option>USD</option><option>EUR</option><option>GBP</option><option>EGP</option></select></div></div>'
    +'<div class="msec">Notes</div><textarea class="form-ta" id="icNotes" style="height:54px;resize:vertical" placeholder="optional"></textarea>'
    +'<div class="msec">Preview</div><div class="scope-sum show" id="icPreview" style="align-items:flex-start"><span class="ev-check">✓</span><span id="icPreviewTxt"></span></div>'
    +'</div><div class="modal-foot" style="justify-content:space-between"><span class="link-btn" id="icCancel" style="color:var(--red);display:none" onclick="CRM.invCancelClaim()">Cancel claim</span><span style="display:flex;gap:8px"><button class="btn btn-secondary" onclick="CRM.requestCloseModal(\'invClaimModal\')">Close</button><button class="btn btn-primary" id="icSave" onclick="CRM.saveInvClaim()">Raise claim</button></span></div></div></div>';
  }
  function invRedirModalHtml(){ return ''
    +'<div class="modal-bg" id="invRedirModal"><div class="modal"><div class="modal-head"><span class="modal-x" role="button" tabindex="0" aria-label="Close" onclick="CRM.requestCloseModal(\'invRedirModal\')">&times;</span><div class="modal-title">Redirect — invoice <span class="mono" id="irInvNo"></span></div><div class="modal-sub" id="irSubT">—</div></div><div class="modal-body">'
    +'<div class="msec" style="border-top:none;padding-top:0;margin-top:0">Part-loads to redirect</div><div class="hint" style="margin:-4px 0 10px">Tick rows across the invoice\'s containers; set a % of net weight per row for a re-sort (default 100%). Traceability &amp; farm stay with the fruit.</div><div id="irPicker"></div>'
    +'<div class="msec">Redirect to</div><div class="grid2"><div><label class="form-label">Client</label><select class="form-select" id="irClient" onchange="CRM.invRedirClientChanged()"></select></div><div><label class="form-label">Sub-client</label><select class="form-select" id="irSub" onchange="CRM.invRender()"></select></div></div>'
    +'<div style="margin-top:10px"><label class="form-label">New invoice no. <span style="text-transform:none;font-weight:400;color:var(--text3)">(optional)</span></label><input class="form-input mono" id="irInv" placeholder="fill when issued"/></div>'
    +'<div class="msec">Notes</div><textarea class="form-ta" id="irNotes" style="height:54px;resize:vertical" placeholder="optional"></textarea>'
    +'<div class="msec">Preview</div><div class="scope-sum show" id="irPreview" style="align-items:flex-start"><span class="ev-check">✓</span><span id="irPreviewTxt"></span></div>'
    +'</div><div class="modal-foot" style="justify-content:space-between"><span class="link-btn" id="irCancel" style="color:var(--red);display:none" onclick="CRM.invCancelRedirect()">Cancel redirect</span><span style="display:flex;gap:8px"><button class="btn btn-secondary" onclick="CRM.requestCloseModal(\'invRedirModal\')">Close</button><button class="btn btn-primary" id="irSave" onclick="CRM.saveInvRedirect()">Redirect</button></span></div></div></div>';
  }

  /* ── reusable in-page confirm (replaces window.confirm, which is unstyled and blocks the renderer) ── */
  var _crmConfirmCb=null;
  function crmConfirmModalHtml(){ return ''
    +'<div class="modal-bg" id="crmConfirmModal" style="z-index:70"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="crmConfirmTitle" style="max-width:420px"><div class="modal-head"><div class="modal-title" id="crmConfirmTitle">Please confirm</div></div><div class="modal-body"><div id="crmConfirmMsg" style="font-size:13px;color:var(--text2);line-height:1.55"></div></div><div class="modal-foot" style="justify-content:flex-end"><button class="btn btn-secondary" onclick="CRM.closeModal(\'crmConfirmModal\')">Keep it</button><button class="btn btn-primary" id="crmConfirmOkBtn" style="background:var(--red);border-color:var(--red)" onclick="CRM.crmConfirmOk()">Confirm</button></div></div></div>';
  }
  function crmConfirm(msgHtml, onOk, okLabel, title){
    _crmConfirmCb=(typeof onOk==='function')?onOk:null;
    if($('crmConfirmTitle')) $('crmConfirmTitle').textContent=title||'Please confirm';
    if($('crmConfirmMsg')) $('crmConfirmMsg').innerHTML=msgHtml;
    if($('crmConfirmOkBtn')) $('crmConfirmOkBtn').textContent=okLabel||'Confirm';
    var m=$('crmConfirmModal'); if(m) m.classList.add('open');
  }
  function crmConfirmOk(){ var cb=_crmConfirmCb; _crmConfirmCb=null; closeModal('crmConfirmModal'); if(cb) cb(); }
  function trapTab(e,m){
    var sel='a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    var vis=[]; [].forEach.call(m.querySelectorAll(sel),function(el){ if(el.offsetParent!==null) vis.push(el); });
    if(!vis.length) return;
    var first=vis[0], last=vis[vis.length-1], a=document.activeElement;
    if(e.shiftKey){ if(a===first||!m.contains(a)){ e.preventDefault(); last.focus(); } }
    else { if(a===last||!m.contains(a)){ e.preventDefault(); first.focus(); } }
  }

  function attachListeners(){
    var d=$('dlv'); if(d) d.addEventListener('click',function(e){ if(e.target===d) closeDlv(); });
    [].forEach.call(ROOT.querySelectorAll('.modal-bg'),function(m){ m.addEventListener('click',function(e){ if(e.target===m) requestCloseModal(m.id); }); });
    /* mark guarded modals dirty on any field edit so closing them prompts before discarding (P0-1) */
    function _markDirty(e){ var m=e.target&&e.target.closest&&e.target.closest('.modal-bg'); if(m&&GUARDED_MODALS[m.id]) _formDirty[m.id]=true; }
    ROOT.addEventListener('input',_markDirty);
    /* keyboard activation for role=button spans (tabs, filter/claim/grade pills, KPI tiles) — delegated on ROOT so it survives innerHTML re-renders */
    ROOT.addEventListener('keydown',function(e){
      var opens=ROOT.querySelectorAll('.modal-bg.open'); var openM=opens.length?opens[opens.length-1]:null;   /* last in DOM = topmost (crmConfirm is last) */
      if(e.key==='Escape'){
        if(openM){ e.preventDefault(); if(openM.id==='crmConfirmModal') closeModal('crmConfirmModal'); else requestCloseModal(openM.id); return; }
        var dd=$('dlv'); if(dd&&dd.classList.contains('open')){ e.preventDefault(); closeDlv(); return; }
        if(scoreOpen){ scoreOpen=false; render(); return; }
        return;
      }
      if(e.key==='Tab' && openM){ trapTab(e,openM); return; }   /* keep focus inside the open dialog */
      if(e.key!=='Enter'&&e.key!==' '&&e.key!=='Spacebar') return; var b=e.target&&e.target.closest&&e.target.closest('[role="button"]'); if(!b||!ROOT.contains(b)) return; e.preventDefault(); b.click(); });
    /* Container numbers and client/country/score keys are attacker-controllable
       (shipments RLS is WITH CHECK true for any authenticated user), so they
       travel as data-* attributes instead of being interpolated into inline
       handlers. closest() gives innermost-wins, which is what the old
       event.stopPropagation() calls were for. Delegated on ROOT so this
       survives innerHTML re-renders. */
    ROOT.addEventListener('click',function(e){
      /* P3: pill / lifecycle-step / grade-pill toggles aren't <input>s, so the 'input' dirty-tracker misses them — mark dirty on a real user click (programmatic set* calls dispatch no click, so no spurious prompt on open/load) */
      var _gm=e.target&&e.target.closest&&e.target.closest('.modal-bg.open');
      if(_gm&&GUARDED_MODALS[_gm.id]&&e.target.closest('.pill,.lc-step,.grade-pill,.row-opt')) _formDirty[_gm.id]=true;
      if(scoreOpen && !(e.target.closest&&e.target.closest('.sc-wrap'))){ scoreOpen=false; render(); return; }
      var t=e.target&&e.target.closest&&e.target.closest('[data-crm-act]');
      if(!t||!ROOT.contains(t)) return;
      var k=t.getAttribute('data-crm-key')||'', a=t.getAttribute('data-crm-act');
      /* editCRM gate — claim/grade/redirect write drawers (defense-in-depth; buttons also hidden via .perm-ro-crm). Read actions (openShipDetail/openInsp/openCqc/openInvoice/drills) pass through. */
      var CRM_WRITE_ACTS={openClaim:1,openGrade:1,dlvClaim:1,dlvGrade:1,dlvRedirect:1,invClaim:1,invRedirect:1,invEditClaim:1,invEditRedirect:1,cancelRedirect:1};
      if(CRM_WRITE_ACTS[a] && !guard('editCRM','CRM edits (claims, grading, redirects) are restricted to the commercial team')) return;
      if(a==='openShipDetail') openShipDetail(k);
      else if(a==='openClaim') openClaim(k);
      else if(a==='reviewClaim'){ var _sh=null; for(var _i=0;_i<SHIPMENTS.length;_i++){ if(SHIPMENTS[_i].cn===k){ _sh=SHIPMENTS[_i]; break; } } if(_sh) openClaim(_sh.key); else toast('That container isn’t in the current view — set Region to “All”.'); }
      else if(a==='openGrade') openGrade(k);
      else if(a==='openInsp') openInsp(k);
      else if(a==='openCqc') openCqc(k);
      else if(a==='openSubDrill') openSubDrill(k);
      else if(a==='removeScoreBand') removeScoreBand(k);
      else if(a==='pulseGo') pulseGo(t.getAttribute('data-crm-arg')||'',k);
      else if(a==='dlvClaim'){ closeDlv(); openClaim(k); }
      else if(a==='dlvGrade'){ closeDlv(); openGrade(k); }
      else if(a==='dlvRedirect'){ closeDlv(); openRedirect(k); }
      else if(a==='openInvoice') openInvoice(k);
      else if(a==='invClaim'){ closeDlv(); openInvClaim(k); }
      else if(a==='invRedirect'){ closeDlv(); openInvRedirect(k); }
      else if(a==='invEditClaim'){ closeDlv(); openInvEditClaim(k); }
      else if(a==='invEditRedirect'){ closeDlv(); openInvEditRedirect(k); }
      else if(a==='cancelRedirect') cancelRedirect(k);
      else if(a==='openShipByCn') openShipByCn(k);
      else if(a==='scoreOpen'){ e.stopPropagation(); toggleScorePop(); }
      else if(a==='evOpen') evOpen(k);
      else if(a==='evDel') evDel(k);
    });
    var _ev=$('evFile');
    if(_ev) _ev.addEventListener('change',function(e){ uploadEvidence(e.target.files); e.target.value=''; });
    ROOT.addEventListener('change',function(e){
      var sc=e.target&&e.target.getAttribute&&e.target.getAttribute('data-crm-score');
      if(sc!=null){ toggleScoreTok(sc); return; }
      var t=e.target&&e.target.closest&&e.target.closest('[data-crm-chg]');
      if(!t||!ROOT.contains(t)) return;
      var k=t.getAttribute('data-crm-key')||'', a=t.getAttribute('data-crm-chg');
      if(a==='scoreAll'){ setScoreAll(!!t.checked); return; }
      if(a==='setClientOverride') setClientOverride(k,t.value);
      else if(a==='setCountryOverride') setCountryOverride(k,t.value);
      else if(a==='setScoreBand') setScoreBand(k,t.value);
    });
  }

  /* ── lifecycle ── */
  function reload(){ invRedirMap=null; return Promise.all([loadVoyages(),loadClaimSettled(),loadRedirIn()]).then(function(){ if(CRM_REGION_RULES_V2) applyV2Regions(); SHIPMENTS=SHIPMENTS.concat(REDIR_IN); render(); }).catch(function(e){ var vc=$('viewContent'); if(vc) vc.innerHTML='<div class="empty-state">Failed to load CRM data — '+esc(e&&e.message||e)+'</div>'; }); }
  function init(opts){
    SB=opts.supabase; SEASON=opts.seasonId; IS_ADMIN=!!opts.isAdmin; USER=opts.currentUser||null; ROOT=opts.root; MOUNTED=true;
    PERMS=opts.perms||{};
    /* perm modifier classes drive CSS visibility of write affordances. They must sit on the .crmv
       element the stylesheet targets — which is ROOT in Vision but a .crmv ANCESTOR of ROOT in the
       Commercial host (ROOT is an inner content div). Resolve to the nearest .crmv either way. */
    var permHost=(ROOT&&ROOT.classList&&ROOT.classList.contains('crmv'))?ROOT:((ROOT&&ROOT.closest&&ROOT.closest('.crmv'))||ROOT);
    if(permHost&&permHost.classList){ permHost.classList.toggle('perm-ro-crm',!canEditCRM()); permHost.classList.toggle('perm-no-manage-leads',!canManageLeads()); permHost.classList.toggle('perm-no-lead-status',!canEditLeadStatus()); }
    CONFIG=opts.config||null; ON_OPEN_CQC=opts.onOpenCqc||null; ON_HEADER=opts.onHeader||null; ON_TAB=opts.onTab||null;
    currentTab='dashboard'; currentRegion='all'; currentProduct='all'; currentQuery=''; showAllSubs=false; pulseOpen=true; resetPages();
    if(PENDING_TAB){ currentTab=PENDING_TAB; PENDING_TAB=null; }   /* sidebar deep-link into a Leads tab on first mount */
    if(ON_TAB) ON_TAB(currentTab,activeLeadKey());
    ROOT.innerHTML=template();
    attachListeners();
    /* loadVoyages has no data dependency on the four lookups, so fire it alongside them instead of chaining — removes one round-trip from time-to-dashboard */
    var loaders=[loadRegions(),loadCountryMap(),loadOverrides(),loadScoreBands(),loadVoyages(),loadClaimSettled(),loadRedirIn(),loadApprover(),loadClaimSettings()];
    if(CRM_REGION_RULES_V2) loaders.push(loadRulesV2(),loadAliasesV2(),loadEntitiesV2());
    Promise.all(loaders).then(function(){ if(CRM_REGION_RULES_V2) applyV2Regions(); SHIPMENTS=SHIPMENTS.concat(REDIR_IN); render(); }).catch(function(e){ var vc=$('viewContent'); if(vc) vc.innerHTML='<div class="empty-state">Failed to load CRM data — '+esc(e&&e.message||e)+'</div>'; });
  }
  function setSeason(seasonId){ if(seasonId===SEASON) return; /* skip the redundant mount-time call so CRM open fetches voyages once, not twice */ SEASON=seasonId; if(MOUNTED) reload(); }
  function teardown(){ MOUNTED=false; ROOT=null; if(ON_HEADER){ ON_HEADER(''); } }



  /* ═══════════════════════════════════════════════════════════════════════
     LEADS — Marketing Leads Portal & Funnel (DRAFT · dummy data · UI/UX only)
     Ported from the dalos-crm-leads-portal-mockup design. No DB, no network —
     in-memory demo state that resets on reload. Reached through the sidebar
     Leads dropdown (Leads / Funnel / Campaigns) and the CRM Leads-inbox tab;
     each destination carries its own in-view sub-tabs.
     ═══════════════════════════════════════════════════════════════════════ */
  var LEADS_TABS=['leads','inbox','funnel','campaigns'];
  /* in-view sub-tab per destination */
  var LSUB={leads:'ws', funnel:'board', inbox:'inbox'};

  /* stage model (matches the mockup) */
  var L_STAGES=[
    {i:0,key:'captured', label:'Captured',      badge:'badge-hold'},
    {i:1,key:'qualified',label:'Qualified',     badge:'badge-warn'},
    {i:2,key:'accepted', label:'Accepted',      badge:'badge-pass'},
    {i:3,key:'engaged',  label:'Engaged',       badge:'badge-esc'},
    {i:4,key:'samples',  label:'Specs / samples',badge:'badge-n'},
    {i:5,key:'quoted',   label:'Quoted',        badge:'badge-sa'},
    {i:6,key:'shipped',  label:'Shipped',       badge:'badge-pass'},
    {i:7,key:'repeat',   label:'Repeat',        badge:'badge-pass'}
  ];
  function stageAt(i){ return L_STAGES[i]||L_STAGES[0]; }
  function stageBadge(l){
    if(l.returnClass==='A') return '<span class="badge badge-fail">Rejected · A</span>';
    var s=stageAt(l.stage); return '<span class="badge '+s.badge+'">'+esc(s.label)+'</span>';
  }

  var L_TYPES={event:'Event',inbound:'Inbound',referral:'Referral',outbound_sourced:'Sourced',win_back:'Win-back'};
  var L_BANDS=['—','1–5','5–20','20+'];
  var L_REGIONS=['UK & Ireland','N. Europe','Gulf','Russia & CIS','E. Med','Far East'];
  var L_C2R={'United Kingdom':'UK & Ireland',UK:'UK & Ireland',Ireland:'UK & Ireland',
    Germany:'N. Europe',Netherlands:'N. Europe',Belgium:'N. Europe',France:'N. Europe',Estonia:'N. Europe',
    UAE:'Gulf','Saudi Arabia':'Gulf',Qatar:'Gulf',Kuwait:'Gulf',
    Russia:'Russia & CIS',Ukraine:'Russia & CIS',
    Turkey:'E. Med',Greece:'E. Med',
    China:'Far East',India:'Far East','Hong Kong':'Far East'};
  var L_CLIENTS=['Greenyard Fresh','Univeg','Bakker Barendrecht','Natures Pride','AMC Fresh','Total Produce','Emirates Fruit Hub'];

  var L_GATES=[
    {k:'receiver', label:'Verified receiver',            src:'marketing'},
    {k:'contact',  label:'Named decision-maker contact', src:'marketing'},
    {k:'dest',     label:'Destination port confirmed',   src:'marketing'},
    {k:'season',   label:'Product × season fit',         src:'auto'},
    {k:'volume',   label:'Volume floor (≥1 container)',  src:'marketing'},
    {k:'cert',     label:'Packhouse certification',      src:'auto'},
    {k:'payment',  label:'Payment expectation',          src:'marketing'},
    {k:'active',   label:'Not an active client',         src:'auto'}
  ];

  var L_CAMPAIGNS=[
    {id:'C1',name:'Fruit Attraction 26',type:'Exhibition',dates:'30 Sep – 02 Oct',cost:41200,cur:'€',reg:74,qual:61,acc:51,shipped:5,cq:675,weighted:78},
    {id:'C2',name:'Gulfood 26',type:'Exhibition',dates:'17 – 21 Feb',cost:28500,cur:'€',reg:46,qual:39,acc:34,shipped:6,cq:731,weighted:52},
    {id:'C3',name:'Grapes pre-season mailer',type:'Digital',dates:'01 – 30 Apr',cost:4100,cur:'€',reg:38,qual:27,acc:22,shipped:2,cq:152,weighted:24},
    {id:'C4',name:'Website inbound (always-on)',type:'Digital',dates:'year-round',cost:9800,cur:'€',reg:58,qual:44,acc:37,shipped:2,cq:223,weighted:19},
    {id:'C5',name:'Agent referral programme',type:'Referral',dates:'year-round',cost:6400,cur:'€',reg:31,qual:28,acc:25,shipped:3,cq:229,weighted:31},
    {id:'C6',name:'Gulf research list Q3',type:'Research',dates:'01 Jul – 15 Aug',cost:6200,cur:'€',reg:1420,qual:19,acc:9,shipped:1,cq:326,weighted:6}
  ];
  function campById(id){ for(var i=0;i<L_CAMPAIGNS.length;i++) if(L_CAMPAIGNS[i].id===id) return L_CAMPAIGNS[i]; return null; }

  var ME='You';
  var ME_REGIONS=['UK & Ireland','Gulf'];

  /* gate factory */
  function G(o){ var g={receiver:'todo',contact:'todo',dest:'todo',season:'pass',volume:'todo',cert:'pass',payment:'todo',active:'pass'};
    if(o) for(var k in o) g[k]=o[k]; return g; }

  var LEADS=[];
  function mk(id,company,country,product,type,band,stage,by,age,opt){
    opt=opt||{};
    return {id:id,company:company,country:country,region:opt.region||(L_C2R[country]||'unmapped'),
      product:product,type:type,band:band,stage:stage,sourcedBy:by,age:age,
      contact:opt.contact||'',role:opt.role||'',port:opt.port||'',campaign:opt.campaign||'C4',
      rep:opt.rep||null,sla:(opt.sla==null?null:opt.sla),assigned:!!opt.assigned,
      passCount:opt.passCount||0,passes:opt.passes||[],gates:opt.gates||G(stage>=1?{receiver:'pass',contact:'pass',dest:'pass',volume:'pass',payment:'pass'}:null),
      returnClass:opt.returnClass||null,returnReason:opt.returnReason||'',returnBy:opt.returnBy||'',
      missing:opt.missing||'',autochk:opt.autochk||null,note:opt.note||'',
      nextAction:opt.nextAction||'',due:opt.due||'',est:opt.est||'',owned:opt.owned||''};
  }
  function seed(){
    LEADS=[
      /* shipped / accepted / mid-funnel (workspace + pipeline + kanban) */
      mk('LD-2026-0142','Gulf Green Import Co','UAE','Mango','event',3,6,'Hoda S.','96d',{rep:'You',contact:'A. Mansour',role:'GM',port:'Jebel Ali',campaign:'C2',nextAction:'Post-arrival QC review',due:'in 9d',est:'14',owned:'2026-05-11',note:'Promoted to client · first inspection MN-2026-0311'}),
      mk('LD-2026-0151','Kingsway Produce Ltd','UK','Pomegranate','event',2,5,'Hoda S.','71d',{rep:'You',contact:'D. Clarke',role:'Buyer',port:'Portsmouth',campaign:'C1',nextAction:'Chase offer · CFR wk 40',due:'overdue 3d',est:'12',owned:'2026-06-04'}),
      mk('LD-2026-0163','Nordfrucht GmbH','Germany','Grapes','inbound',2,3,'Amr K.','54d',{rep:'You',contact:'S. Bauer',role:'Head of Procurement',port:'Hamburg',campaign:'C4',nextAction:'Send spec sheet',due:'tomorrow',est:'10',owned:'2026-06-19'}),
      mk('LD-2026-0170','Al Rayyan Trading WLL','Qatar','Mango','referral',2,2,'Hoda S.','40d',{rep:'Karim F.',contact:'N. Al Kuwari',role:'Buyer',port:'Hamad',campaign:'C5'}),
      mk('LD-2026-0196','Levant Foods DMCC','UAE','Pomegranate','inbound',2,4,'Amr K.','9d',{rep:'You',contact:'R. Haddad',role:'Buyer',port:'Jebel Ali',campaign:'C4',nextAction:'Follow up on sample feedback',due:'in 4d',est:'8',owned:'2026-07-02'}),
      /* qualified + assigned (inbox) */
      mk('LD-2026-0181','Meridian Fresh Ltd','UK','Grapes','event',3,1,'Hoda S.','22d',{assigned:true,sla:4,region:'UK & Ireland',contact:'J. Whitfield',role:'Procurement Manager',port:'Portsmouth',campaign:'C1',
        gates:G({receiver:'pass',contact:'pass',dest:'pass',volume:'pass',payment:'pass',cert:'warn'})}),
      mk('LD-2026-0203','Kingsway Produce Ltd (UK2)','UK','Pomegranate','event',2,1,'Hoda S.','5d',{assigned:true,sla:1,region:'UK & Ireland',contact:'P. Reed',role:'Buyer',port:'Felixstowe',campaign:'C1',passCount:1,
        gates:G({receiver:'pass',contact:'pass',dest:'pass',volume:'pass',payment:'pass'})}),
      mk('LD-2026-0210','Doha Fresh Market','Qatar','Mango','inbound',2,1,'Karim F.','6d',{assigned:true,sla:3,region:'Gulf',contact:'N. Kuwari',role:'Buyer',port:'Hamad',campaign:'C4',
        gates:G({receiver:'pass',contact:'pass',dest:'pass',volume:'pass',payment:'pass'})}),
      /* captured / enrichment (stage 0) */
      mk('LD-2026-0188','Batavia Import BV','Netherlands','Grapes','outbound_sourced',0,0,'Amr K.','15d',{missing:'Contact role · volume band · payment',autochk:[['pass','season ok'],['pass','cert ok']]}),
      mk('LD-2026-0190','Vostok Fruit LLC','Russia','Citrus','outbound_sourced',0,0,'Amr K.','11d',{region:'unmapped',missing:'Receiver evidence · destination port',autochk:[['pass','season ok'],['warn','agent territory']]}),
      mk('LD-2026-0196b','Levant Foods DMCC','UAE','Mango','inbound',0,0,'Amr K.','9d',{missing:'Volume band',autochk:[['pass','season ok'],['pass','cert ok']]}),
      mk('LD-2026-0199','Sunrise Fruits Co','Saudi Arabia','Mango','event',0,0,'Amr K.','7d',{missing:'Contact name · role',autochk:[['pass','season ok'],['pass','cert ok']]}),
      mk('LD-2026-0201','Baltic Produce OÜ','Estonia','Citrus','outbound_sourced',0,0,'Amr K.','4d',{missing:'Receiver evidence',autochk:[['fail','season mismatch']]}),
      mk('LD-2026-0205','Fresh Horizon Ltd','UK','Grapes','inbound',0,0,'Hoda S.','2d',{region:'UK & Ireland',missing:'Payment expectation',autochk:[['pass','season ok'],['fail','cert not held']]}),
      /* returned by sales */
      mk('LD-2026-0194','Anatolia Meyve A.Ş.','Turkey','Citrus','referral',1,1,'Amr K.','6d',{returnClass:'A',returnReason:'Not a real importer — re-exporter, no cold chain',returnBy:'Karim F.'}),
      mk('LD-2026-0176','Zenith Foods Ltd','UK','Grapes','event',1,1,'Hoda S.','30d',{returnClass:'B',returnReason:'No capacity — grapes wk 30–34 fully committed',returnBy:'Karim F.'}),
      mk('LD-2026-0168','Caspian Trade LLC','Russia','Citrus','outbound_sourced',1,1,'Amr K.','33d',{region:'Russia & CIS',returnClass:'B',returnReason:'Credit risk — no acceptable payment terms',returnBy:'Nour A.'}),
      mk('LD-2026-0185','Volga Fresh OOO','Russia','Citrus','outbound_sourced',1,1,'Amr K.','20d',{region:'Russia & CIS',returnClass:'NR',returnReason:'SLA expired · no rep opened it',returnBy:'region: Russia & CIS'}),
      /* repeat */
      mk('LD-2026-0120','Emirates Fruit Hub','UAE','Mango','win_back',3,7,'Hoda S.','120d',{rep:'You',campaign:'C2',note:'season 2'})
    ];
  }
  seed();
  function leadById(id){ for(var i=0;i<LEADS.length;i++) if(LEADS[i].id===id) return LEADS[i]; return null; }

  /* ── filter state ── */
  var leadView={type:'all',market:'all',stage:'all'};

  /* ── shared bits ── */
  function bdg(cls,txt){ return '<span class="badge '+cls+'">'+esc(txt)+'</span>'; }
  function typeBadge(t){ return bdg('badge-n',L_TYPES[t]||t); }
  function slaBadge(l){
    if(l.sla==null) return '';
    var cls=l.sla<=0?'sla-x':(l.sla<=1?'sla-w':'sla-ok');
    var txt=l.sla<=0?('SLA breached · '+(7)+'d'):(l.sla+'d left');
    return '<span class="sla '+cls+'">'+txt+'</span>';
  }
  function gateIcon(v){ return v==='pass'?'<span class="gate-i gate-ok">✓</span>':(v==='warn'?'<span class="gate-i gate-w">!</span>':(v==='fail'?'<span class="gate-i gate-no">✕</span>':'<span class="gate-i" style="background:var(--border2)">·</span>')); }
  /* In-page section tab row — carries ALL nine Leads views (mockup parity), scrollable. */
  function leadTabBar(){
    var enrN=LEADS.filter(function(l){return l.stage===0;}).length;
    var rejN=LEADS.filter(function(l){return l.returnClass;}).length;
    var inbN=leadsInboxDot();
    var T=[
      ['leads','ws','Workspace',0,''],
      ['leads','enr','Enrichment queue',enrN,'badge-warn'],
      ['leads','rej','Returned by sales',rejN,'badge-fail'],
      ['inbox','inbox','Sales · lead inbox',inbN,'badge-fail'],
      ['inbox','pip','Sales · my pipeline',0,''],
      ['leads','cap','Capture · show mode',0,''],
      ['campaigns','','Campaigns',0,''],
      ['funnel','board','Funnel board',0,''],
      ['funnel','conv','Conversion',0,'']
    ];
    function on(n){ if(currentTab!==n[0]) return false; if(!n[1]) return true; var def=(n[0]==='leads'?'ws':(n[0]==='inbox'?'inbox':'board')); return (LSUB[n[0]]||def)===n[1]; }
    return '<div class="lsub">'+T.map(function(n){
      var dot=n[3]?' <span class="badge '+(n[4]||'badge-n')+'" style="margin-left:5px">'+n[3]+'</span>':'';
      return '<span class="lsubt'+(on(n)?' on':'')+'" role="button" tabindex="0" onclick="CRM.leadNav(\''+n[0]+'\',\''+n[1]+'\')">'+esc(n[2])+dot+'</span>';
    }).join('')+'</div>';
  }
  function liveBar(){
    return '<div class="livebar" onclick="CRM.leadSub(\'leads\',\'cap\')">'
      +'<span class="livedot"></span>'
      +'<span><strong>Fruit Logistica 27</strong> is live · day 2 of 4 · <span class="mono">7 queued offline</span></span>'
      +'<button class="btn btn-primary btn-sm livebtn">Capture</button></div>';
  }
  function draftBanner(){ return '<div class="l-draft"><b>Draft</b> · Marketing Leads Portal — dummy data, UI/UX only; a reload resets it. <span class="link-btn" onclick="CRM.leadReset()">Reset demo data</span></div>'; }

  /* ═══════════════════════════════════════════════════════════════════════
     LM — REAL leads (crm_leads via crm_leads_list RPC). Phase 1.
     Powers Workspace, Enrichment queue and My-pipeline off live data, and
     persists Enrich / Qualify / Assign / Return / Re-queue via authed crm_leads
     UPDATEs (RLS: crm_is_admin OR commercial). Returned-by-sales is REAL too
     (a recoverable list; A/B/No-response classification deferred). The dummy
     LEADS array + lead* handlers below still power the DEFERRED views (Lead
     inbox, Funnel, Conversion) — demo-only until the Phase-2 rules land.
     ═══════════════════════════════════════════════════════════════════════ */
  var LM={rows:[],loaded:false,loading:false,q:'',f:{source:'all',region:'all',stage:'all'},myRegions:null,myManagerRegions:null,pipeAsg:'all',parkFilter:'all',xsFrom:'all',xsWants:'all',xsParked:true};
  /* Leads use the SAME region model as Tracking & Claims: regions (slug id + label) + region_members.
     Assignable regions = real regions from the loaded REGIONS list, excluding 'all' and the bucket. */
  function lmRealRegions(){ return REGIONS.filter(function(r){ return r.id!=='all' && !r.admin; }).map(function(r){ return [r.id,r.label]; }); }
  function lmRegionName(slug){ return slug?(regionLabel[slug]||slug):''; }
  /* Current user's region slugs (from region_members; RLS allows reading own rows). Admins bypass. */
  function lmLoadMyRegions(){
    if(IS_ADMIN||!SB||!(USER&&USER.id)){ LM.myRegions={}; LM.myManagerRegions={}; return Promise.resolve(); }
    return SB.from('region_members').select('region_id,is_manager').eq('user_id',USER.id).then(function(res){
      var m={}, mm={}; ((res&&res.data)||[]).forEach(function(r){ if(r.region_id){ m[r.region_id]=true; if(r.is_manager) mm[r.region_id]=true; } }); LM.myRegions=m; LM.myManagerRegions=mm;
    }).catch(function(){ LM.myRegions={}; LM.myManagerRegions={}; });
  }
  /* Region routing mode ('claim'|'assign') and the caller's manager status.
     lmIsManagerOf = admin OR flagged is_manager for that region (server RPCs re-check). */
  function lmRoutingOf(slug){ return regionRouting[slug]==='assign'?'assign':'claim'; }
  function lmIsManagerOf(region){ return IS_ADMIN || !!(region && LM.myManagerRegions && LM.myManagerRegions[region]); }
  function lmInitials(name){ var p=String(name||'').trim().split(/\s+/); if(!p[0]) return '?'; return ((p[0][0]||'')+(p.length>1?(p[p.length-1][0]||''):'')).toUpperCase(); }
  /* Region scope for the Leads page. Commercial (incl. regional managers) see ONLY leads routed to
     region(s) they belong to; marketing (editCRM:0) and admins see all. canEditCRM() distinguishes
     commercial from marketing without a role field. Presentational only — crm_leads_list already
     returns everything; server-side RLS region scoping is a Phase-2 item. */
  function lmRegionScoped(){ return !IS_ADMIN && canEditCRM(); }
  function lmScope(rows){
    if(!lmRegionScoped()) return rows;
    var m=LM.myRegions||{};
    return rows.filter(function(l){ return l.assignedRegion && m[l.assignedRegion]; });
  }
  /* region-filter options, narrowed to the user's own regions when scoped */
  function lmScopedRegions(){ if(!lmRegionScoped()) return lmRealRegions(); var m=LM.myRegions||{}; return lmRealRegions().filter(function(r){ return m[r[0]]; }); }
  var LM_SOURCES=[['manual','Manual'],['qr_vcard','QR / vCard'],['ocr_card','Card OCR'],['public_form','Public form'],['csv_import','CSV import']];
  function lmSourceLabel(s){ for(var i=0;i<LM_SOURCES.length;i++) if(LM_SOURCES[i][0]===s) return LM_SOURCES[i][1]; return s||'—'; }
  function lmAge(ts){ if(!ts) return '—'; var d=Math.floor((Date.now()-new Date(ts).getTime())/86400000); if(d<=0) return 'today'; if(d===1) return '1d'; if(d<30) return d+'d'; return Math.floor(d/30)+'mo'; }
  function lmDays(ts){ if(!ts) return 0; var d=Math.floor((Date.now()-new Date(ts).getTime())/86400000); return d<0?0:d; }
  /* "waited Nd" phrasing off the inbox clock (assignedAt = when it was routed to the region) */
  function lmWaited(ts){ var d=lmDays(ts); return d<=0?'today':(d===1?'1d':d+'d'); }
  function lmDate(ts){ if(!ts) return '—'; try{ return new Date(ts).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}); }catch(e){ return String(ts).slice(0,10); } }
  function lmMap(r){
    return {id:r.id, ref:'#'+String(r.id||'').slice(0,8),
      company:r.company_name||'—', country:r.country||'—',
      product:(r.product_interest&&r.product_interest.length?r.product_interest.join(', '):'—'), products:r.product_interest||[],
      source:r.source||'', status:r.status||'', stage:r.stage||0, disposition:r.disposition||null,
      assignedRegion:r.assigned_region||'', assignedTo:r.assigned_to||null, assignedToName:r.assigned_to_name||'', assignedBy:r.assigned_by||null, assignedByName:r.assigned_by_name||'', assignedAt:r.assigned_at||null,
      qualifiedAt:r.qualified_at||null,
      returnReason:r.return_reason||'', returnedAt:r.returned_at||null, returnedBy:r.returned_by||null, returnedByName:r.returned_by_name||'',
      parkProducts:r.park_products||[], parkReason:r.park_reason||'', parkRevisit:r.park_revisit||'', parkedAt:r.parked_at||null, parkedByName:r.parked_by_name||'',
      thread:(r.handoff_log&&r.handoff_log.length?r.handoff_log:[]),
      contact:r.contact_name||'', role:r.contact_role||'', email:r.email||'', phone:r.phone||'',
      port:r.destination_port||'', band:r.expected_volume_band||'', season:r.season_window||'', notes:r.notes||'',
      website:r.website||'', campaign:r.campaign_name||'', campaignId:r.campaign_id||null, campaignProducts:r.campaign_products||[],
      cardPath:r.card_image_path||null, groupPath:r.group_image_path||null,
      capturedAt:r.captured_at, capturedBy:r.captured_by, capturedByName:r.captured_by_name||'', age:lmAge(r.captured_at), raw:r};
  }
  function lmById(id){ for(var i=0;i<LM.rows.length;i++) if(LM.rows[i].id===id) return LM.rows[i]; return null; }
  /* A leads-list load should only re-render views that actually show LM.rows. The Show Mode
     CAPTURE sub-view (LSUB.leads==='cap') renders its own form + a campaign roster (capLoadCampaign),
     so re-rendering it here would rebuild the form and WIPE an in-progress OCR/QR prefill. */
  function lmNeedsRender(){
    if(currentTab==='inbox'||currentTab==='funnel') return true;
    if(currentTab==='leads') return LSUB.leads!=='cap';
    return false;
  }
  function lmLoad(){
    if(!SB){ LM.loaded=true; return; }
    LM.loading=true;
    var pMine=(LM.myRegions===null)?lmLoadMyRegions():Promise.resolve();
    Promise.all([pMine, SB.rpc('crm_leads_list')]).then(function(r){
      var res=r[1]; LM.loading=false; LM.loaded=true;
      if(res&&res.error) toast('<b>Could not load leads.</b> '+esc(res.error.message||''));
      else LM.rows=((res&&res.data)||[]).map(lmMap);
      if(lmNeedsRender()) render();
    }).catch(function(){ LM.loading=false; LM.loaded=true; if(lmNeedsRender()) render(); });
  }
  function lmEnsure(){ if(!LM.loaded && !LM.loading) lmLoad(); }
  function lmReload(){ LM.loaded=false; LM.loading=false; lmLoad(); }
  function lmRefresh(btn){ if(btn){ btn.disabled=true; btn.textContent='↻ Refreshing…'; } lmReload(); }
  function lmSkel(){
    var k='<div class="kpi"><span class="sk" style="width:45%;height:9px"></span><span class="sk" style="width:58%;height:24px;margin-top:11px"></span></div>';
    return '<div class="kpi-grid" style="margin-bottom:12px">'+k+k+k+k+'</div><div class="card"><span class="sk" style="width:100%;height:220px;display:block"></span></div>';
  }
  /* Single source of truth for lead state — a lead is exactly one of returned / assigned / qualified / captured.
     Derived from (disposition, assignedTo, stage) so badge, KPIs and action gates never disagree
     (e.g. a re-queued lead has disposition=null but stage>=1 → still Qualified and assignable). */
  function lmIsReturned(l){ return l.disposition==='returned'; }
  /* Parked = a customer-initiated "come back next season" hold. Like returned, it's a side-exit:
     excluded from the active funnel/inbox/pipeline; lives in the product-keyed backlog. */
  function lmIsParked(l){ return l.disposition==='parked'; }
  /* Assigned is the STAGE = assigned to a REGION (not to a user). The owning rep is a separate
     flag (l.assignedTo, set by Claim) that does NOT change the stage. Unclaimed = assigned stage
     with no owner flag → shows in the region Lead inbox; claimed → shows in that rep's My pipeline. */
  function lmIsAssigned(l){ return !lmIsReturned(l) && !lmIsParked(l) && (!!l.assignedRegion || l.stage>=2); }
  function lmIsQualified(l){ return !lmIsReturned(l) && !lmIsParked(l) && !lmIsAssigned(l) && (l.disposition==='qualified'||l.stage>=1); }
  function lmIsCaptured(l){ return !lmIsReturned(l) && !lmIsParked(l) && !lmIsAssigned(l) && !lmIsQualified(l); }
  function lmIsUnclaimed(l){ return lmIsAssigned(l) && !l.assignedTo; }
  function lmIsMine(l){ var uid=(USER&&USER.id)||null; return !!l.assignedTo && uid && l.assignedTo===uid && !lmIsReturned(l) && !lmIsParked(l); }
  function lmStageBadge(l){
    if(lmIsReturned(l)) return bdg('badge-fail','Returned');
    if(lmIsParked(l)) return bdg('badge-park','Parked');
    /* Has an owner (claimed by a member OR assigned to a member by a manager) = Accepted,
       and stays Accepted / advances through the deal stages until it's returned to marketing. */
    if(l.assignedTo){
      if(l.stage>=3){ var s=L_STAGES[l.stage]; if(s) return bdg(s.badge||'badge-pass',s.label); }
      return bdg('badge-pass','Accepted');
    }
    /* Routed to a region but not yet owned — waiting in that region's inbox to be claimed/assigned. */
    if(lmIsAssigned(l)) return bdg('badge-n','Assigned to region');
    if(lmIsQualified(l)) return bdg('badge-warn','Qualified');
    return bdg('badge-hold','Captured');
  }
  function lmMissing(l){ var m=[]; if(!l.contact) m.push('contact'); if(!l.role) m.push('role'); if(!l.band) m.push('volume'); if(!l.port) m.push('port'); return m.length?m.join(' · '):'—'; }
  function lmVal(id){ var el=$(id); if(!el) return null; var v=(el.value||'').trim(); return v||null; }
  function lmUpdate(id,patch,msg){
    if(!canEditLeadStatus()){ toast('<b>Not permitted</b> · you have view-only access to leads'); return; }
    if(!SB){ toast('No connection.'); return; }
    patch.updated_at=new Date().toISOString();
    SB.from('crm_leads').update(patch).eq('id',id).then(function(res){
      if(res&&res.error){ toast('<b>Save failed.</b> '+esc(res.error.message||'')); return; }
      closeDlv(); toast(msg||'Saved.'); lmReload();
    }).catch(function(e){ toast('<b>Save failed.</b> '+esc(String(e))); });
  }

  /* ── deal-stage progression (Accepted → Engaged → Specs → Quoted → Shipped → Repeat) ──
     Advanceable only once a lead has an owner (Accepted). Who: the owner, a manager of the lead's
     region, or an admin (lmIsManagerOf already folds in admin). Persists in crm_leads.stage (3–7). */
  function lmCanAdvance(l){ return !lmIsReturned(l) && !!l.assignedTo && (lmIsMine(l)||lmIsManagerOf(l.assignedRegion)); }
  /* Deal progress — ALWAYS shown (read-only until the lead is Accepted). Maps the lead onto the
     8-stage funnel via lmFunnelStage; advance controls appear only for the owner/manager/admin. */
  function lmDealStepperHtml(l){
    if(lmIsReturned(l)) return '<div class="l-qsec">Deal progress</div><div class="cell-sub">Returned to marketing'+(l.returnReason?' · '+esc(l.returnReason):'')+'. Re-queue to resume the funnel.</div>';
    if(lmIsParked(l)) return '<div class="l-qsec">Deal progress</div><div class="cell-sub">Parked for '+((l.parkProducts&&l.parkProducts.length)?esc(l.parkProducts.join(', ')):'a later season')+'. Reactivate from the backlog to resume the funnel.</div>';
    var cur=lmFunnelStage(l);
    var steps=L_STAGES.map(function(s,ix){
      var st=s.i<cur?'done':(s.i===cur?'now':'todo');
      return '<span class="l-step '+st+'">'+esc(s.label)+'</span>'+(ix<L_STAGES.length-1?'<span class="l-stepbar'+(s.i<cur?' done':'')+'"></span>':'');
    }).join('');
    var ctl='';
    if(lmCanAdvance(l)){
      var c=(l.stage>=2?l.stage:2), parts=[];
      if(c>2) parts.push('<button class="btn btn-secondary btn-sm" onclick="CRM.lmSetDealStage(\''+l.id+'\','+(c-1)+')">← '+esc(L_STAGES[c-1].label)+'</button>');
      if(c<7) parts.push('<button class="btn btn-primary btn-sm" onclick="CRM.lmSetDealStage(\''+l.id+'\','+(c+1)+')">'+esc(L_STAGES[c+1].label)+' →</button>');
      ctl='<div style="display:flex;gap:6px;margin-top:10px">'+parts.join('')+'</div>';
    } else if(!l.assignedTo){
      ctl='<div class="cell-sub" style="margin-top:8px">Deal stages open once the lead is accepted (claimed or assigned to a rep).</div>';
    }
    return '<div class="l-qsec">Deal progress</div><div class="l-stepper">'+steps+'</div>'+ctl;
  }
  /* Activity timeline — lifecycle events (from timestamps already fetched) merged with the
     handoff_log thread (return / requeue / note / call), newest-first, + an inline composer. */
  function lmActivityHtml(l){
    var evs=[];
    if(l.capturedAt) evs.push({at:l.capturedAt,title:'Captured via '+esc(lmSourceLabel(l.source)),who:l.capturedByName?esc(l.capturedByName):''});
    if(l.qualifiedAt) evs.push({at:l.qualifiedAt,title:'Qualified',who:''});
    if(l.assignedAt && l.assignedRegion) evs.push({at:l.assignedAt,title:'Assigned to '+esc(lmRegionName(l.assignedRegion)||l.assignedRegion),who:l.assignedByName?esc(l.assignedByName):''});
    (l.thread||[]).forEach(function(e){
      var map={return:'Returned to marketing',requeue:'Re-queued to sales',parked:'Parked for later',reactivated:'Reactivated from backlog',note:'Note',call:'Call logged',meeting:'Meeting logged'};
      var who=e.byName?esc(e.byName)
        :(e.kind==='return'?(l.returnedByName?esc(l.returnedByName):'Sales')
        :(e.kind==='requeue'?'Marketing':''));
      evs.push({at:e.at,title:map[e.kind]||'Update',who:who,note:e.note||''});
    });
    evs.sort(function(a,b){ return (b.at||'').localeCompare(a.at||''); });
    var rows=evs.map(function(e){
      return '<div class="l-ev"><span class="l-ev-dot"></span><div class="l-ev-b">'
        +'<div class="l-ev-t">'+e.title+'</div>'
        +(e.note?'<div class="l-ev-n">'+esc(e.note).replace(/\n/g,'<br>')+'</div>':'')
        +'<div class="l-ev-m">'+[e.who,e.at?esc(lmDate(e.at)):''].filter(Boolean).join(' · ')+'</div></div></div>';
    }).join('') || '<div class="cell-sub" style="padding:4px 0">No activity yet.</div>';
    var composer=canEditLeadStatus()
      ? '<div class="l-compose"><select id="lm_note_kind" class="form-select"><option value="note">Note</option><option value="call">Call</option><option value="meeting">Meeting</option></select>'
        +'<input id="lm_note_body" class="form-input" placeholder="Add a note or log a call…" onkeydown="if(event.key===\'Enter\'){event.preventDefault();CRM.lmNoteSave(\''+l.id+'\');}"/>'
        +'<button class="btn btn-primary btn-sm" onclick="CRM.lmNoteSave(\''+l.id+'\')">Post</button></div>'
      : '';
    return '<div class="l-qsec">Activity</div>'+composer+'<div class="l-acts">'+rows+'</div>';
  }
  /* Append a note / call / meeting to crm_leads.handoff_log (reuse the jsonb, no schema change).
     Read-modify-write like return/requeue; keeps the drawer open and re-renders it. */
  function lmNoteSave(id){
    if(!canEditLeadStatus()){ toast('<b>Not permitted</b> · you have view-only access to leads'); return; }
    var l=lmById(id); if(!l) return;
    var kSel=$('lm_note_kind'), bEl=$('lm_note_body');
    var kind=(kSel&&kSel.value)||'note', txt=((bEl&&bEl.value)||'').trim();
    if(!txt){ if(bEl) bEl.focus(); return; }
    if(!SB){ toast('No connection.'); return; }
    var entry={ at:new Date().toISOString(), by:(USER&&USER.id)||null, byName:(USER&&(USER.name||USER.email))||'You', kind:kind, note:txt };
    var thread=(l.thread?l.thread.slice():[]); thread.push(entry);
    SB.from('crm_leads').update({ handoff_log:thread, updated_at:new Date().toISOString() }).eq('id',id).then(function(res){
      if(res&&res.error){ toast('<b>Save failed.</b> '+esc(res.error.message||'')); return; }
      l.thread=thread; lmOpen(id); toast(kind==='call'?'Call logged.':(kind==='meeting'?'Meeting logged.':'Note added.'));
    }).catch(function(e){ toast('<b>Save failed.</b> '+esc(String(e))); });
  }
  function lmSetDealStage(id,n){
    var l=lmById(id); if(!l) return;
    if(!lmCanAdvance(l)){ toast('<b>Not permitted</b> · only the owner, a region manager or an admin can move the deal stage.'); return; }
    n=Math.max(2,Math.min(7,n|0)); var s=L_STAGES[n];
    lmUpdate(id,{ stage:n },'<b>'+esc(l.company)+'</b> → '+esc(s?s.label:('stage '+n))+'.');
  }

  /* ── New lead — REAL manual capture, mirrors Show Mode's field set + card photo, inserts crm_leads ── */
  var LMN={products:{},cardData:null,force:false};
  function lmNewProdChips(){ return CAP_PRODUCTS.map(function(p){ return '<button type="button" class="capchip'+(LMN.products[p]?' on':'')+'" data-prod="'+esc(p)+'" onclick="CRM.lmNewChip(this)">'+esc(p)+'</button>'; }).join(''); }
  function lmNewChip(btn){ var p=btn.getAttribute('data-prod'); LMN.products[p]=!LMN.products[p]; btn.classList.toggle('on',!!LMN.products[p]); }
  function lmNewCardChip(){ var el=$('lmn_card_chip'); if(!el) return;
    el.innerHTML=LMN.cardData?'<div style="display:flex;align-items:center;gap:9px;margin-top:6px;padding:7px;background:var(--bg2);border:1px solid var(--border);border-radius:var(--r2)"><img src="'+LMN.cardData+'" style="height:46px;max-width:80px;border-radius:6px;border:1px solid var(--border);object-fit:cover"/><span class="cell-sub">Card / badge photo attached</span><span class="link-btn" style="margin-left:auto" onclick="CRM.lmNewCardRemove()">Remove</span></div>':''; }
  function lmNewCardRemove(){ LMN.cardData=null; lmNewCardChip(); var fi=$('lmn_card'); if(fi) fi.value=''; }
  function lmNewCardPick(input){ var f=input&&input.files&&input.files[0]; if(!f) return; input.value='';
    var rd=new FileReader(); rd.onload=function(ev){ var img=new Image(); img.onload=function(){ var max=1400,w=img.width,h=img.height,sc=Math.min(1,max/Math.max(w,h)); w=Math.round(w*sc); h=Math.round(h*sc); var cv=document.createElement('canvas'); cv.width=w; cv.height=h; cv.getContext('2d').drawImage(img,0,0,w,h); try{ LMN.cardData=cv.toDataURL('image/jpeg',0.72); }catch(e){ LMN.cardData=ev.target.result; } lmNewCardChip(); }; img.onerror=function(){}; img.src=ev.target.result; }; rd.readAsDataURL(f);
  }
  function lmNewOpen(){
    if(!canManageLeads()){ toast('<b>Not permitted</b> · you can’t create leads'); return; }
    LMN={products:{},cardData:null,force:false};
    var camps=(CAMP.items||[]).filter(function(c){return c.active;});
    var body='<div class="l-form"><div class="l-formnote">Create a lead directly (source: manual). Company is required — everything else can be enriched later. Saves to the real leads list.</div>'
      +field('lmn_company','Company','','e.g. Meridian Fresh Ltd')
      +'<div class="grid2" style="gap:8px">'+field('lmn_contact','Contact name','','J. Whitfield')+field('lmn_role','Role / title','','Procurement Manager')+'</div>'
      +'<div class="grid2" style="gap:8px">'+field('lmn_email','Email','','')+field('lmn_phone','Phone','','')+'</div>'
      +'<div class="grid2" style="gap:8px">'+field('lmn_country','Country','','')+field('lmn_website','Website','','')+'</div>'
      +'<label class="form-label" style="margin-top:8px">Product interest</label><div style="display:flex;flex-wrap:wrap;gap:6px">'+lmNewProdChips()+'</div>'
      +'<div class="grid2" style="gap:8px">'+field('lmn_port','Destination port','','e.g. Jebel Ali')+field('lmn_band','Volume band','','e.g. 1–5 containers')+'</div>'
      +field('lmn_season','Season window','','e.g. wk 40–48')
      +(camps.length?selField('lmn_campaign','Campaign (optional)',[['','— none —']].concat(camps.map(function(c){return [c.id,c.name];})),''):'')
      +'<label class="form-label" style="margin-top:8px">Business card / badge photo</label><input type="file" accept="image/*" capture="environment" id="lmn_card" onchange="CRM.lmNewCardPick(this)" class="form-input"/><div id="lmn_card_chip"></div>'
      +'<div class="l-qsec" style="cursor:pointer" onclick="var m=this.nextSibling;if(m)m.style.display=(m.style.display===\'none\'?\'block\':\'none\')">More details ▾</div>'
      +'<div id="lmn_more" style="display:none">'
        +'<div class="grid2" style="gap:8px">'+field('lmn_exp','Exporter type','','Grower / Trader…')+field('lmn_imp','Importer type','','Agent / Retailer…')+'</div>'
        +field('lmn_industries','Products · industries','','')
        +field('lmn_trade','Trade countries','','')
        +field('lmn_qty','Annual quantity','','')
      +'</div>'
      +'<label class="form-label" style="margin-top:8px">Notes</label><textarea class="form-input" id="lmn_notes" rows="3"></textarea>'
      +'<div id="lmn_warn"></div>'
      +'<div class="l-formact"><button class="btn btn-primary" onclick="CRM.lmNewSave()">Register lead</button><button class="btn btn-secondary" onclick="CRM.closeDlv()">Cancel</button></div></div>';
    showDlv('New lead',body); lmNewCardChip();
  }
  function lmNewForce(){ LMN.force=true; lmNewSave(); }
  function lmNewSave(){
    if(!canManageLeads()){ toast('<b>Not permitted</b> · you can’t create leads'); return; }
    if(!SB){ toast('No connection.'); return; }
    var co=(($('lmn_company')||{}).value||'').trim(), w=$('lmn_warn'); if(w) w.innerHTML='';
    if(!co){ if(w) w.innerHTML='<div class="alert-fail" style="margin-top:10px">Company is required.</div>'; return; }
    var dup=LM.rows.filter(function(l){ return (l.company||'').toLowerCase()===co.toLowerCase(); })[0];
    if(dup && !LMN.force){ if(w) w.innerHTML='<div class="alert-warn" style="margin-top:10px"><b>Possible duplicate</b> — '+esc(dup.company)+' ('+esc(dup.ref)+'). <span class="link-btn" onclick="CRM.lmOpen(\''+dup.id+'\')">Open existing</span> · <span class="link-btn" onclick="CRM.lmNewForce()">Save anyway</span></div>'; return; }
    function v(id){ var el=$(id), x=el&&el.value?el.value.trim():''; return x||null; }
    var products=CAP_PRODUCTS.filter(function(p){return LMN.products[p];});
    var extra={};
    if(v('lmn_exp')) extra.exporter_type=v('lmn_exp');
    if(v('lmn_imp')) extra.importer_type=v('lmn_imp');
    if(v('lmn_industries')) extra.products_industries=v('lmn_industries');
    if(v('lmn_trade')) extra.trade_countries=v('lmn_trade');
    if(v('lmn_qty')) extra.annual_quantity=v('lmn_qty');
    var rec={ source:'manual', status:'captured', stage:0,
      company_name:co, contact_name:v('lmn_contact'), contact_role:v('lmn_role'),
      email:v('lmn_email'), phone:v('lmn_phone'), website:v('lmn_website'), country:v('lmn_country'),
      destination_port:v('lmn_port'), expected_volume_band:v('lmn_band'), season_window:v('lmn_season'),
      product_interest:(products.length?products:null), notes:v('lmn_notes'),
      campaign_id:(($('lmn_campaign')||{}).value||'')||null,
      raw_payload:(Object.keys(extra).length?extra:null) };
    SB.from('crm_leads').insert(rec).select('id,campaign_id').single().then(function(res){
      if(res&&res.error){ if(w) w.innerHTML='<div class="alert-fail" style="margin-top:10px"><b>Save failed.</b> '+esc(res.error.message||'')+'</div>'; return; }
      var row=res&&res.data, done=function(){ closeDlv(); toast('Lead <b>'+esc(co)+'</b> registered.'); lmReload(); };
      if(LMN.cardData && row && row.id){
        var path=(row.campaign_id||'nocamp')+'/'+row.id+'.jpg';
        SB.storage.from('crm-lead-cards').upload(path, capDataUrlToBlob(LMN.cardData), {contentType:'image/jpeg',upsert:true}).then(function(up){
          if(up&&up.error){ done(); return; }
          SB.from('crm_leads').update({card_image_path:path}).eq('id',row.id).then(function(){ done(); },function(){ done(); });
        },function(){ done(); });
      } else { done(); }
    },function(e){ if(w) w.innerHTML='<div class="alert-fail" style="margin-top:10px"><b>Save failed.</b> '+esc(String(e))+'</div>'; });
  }

  /* ── real leads · row-level actions ── */
  function lmOpen(id){
    var l=lmById(id); if(!l) return;
    function row(lbl,val){ return '<div class="l-drow"><span class="cell-sub">'+lbl+'</span><span>'+val+'</span></div>'; }
    var r0=l.raw||{}, rp=r0.raw_payload||{};
    var fuMap={}; if(typeof CAP_FOLLOWUPS!=='undefined') CAP_FOLLOWUPS.forEach(function(o){ fuMap[o[0]]=o[1]; });
    var or=function(v){ return (v==null||v===''||(Array.isArray(v)&&!v.length))?'<span class="cell-sub">—</span>':esc(Array.isArray(v)?v.join(', '):String(v)); };
    var sec=function(t){ return '<div class="l-dsec">'+t+'</div>'; };
    var withOther=function(t,o){ return or(t)+(o?' <span class="cell-sub">· other: '+esc(o)+'</span>':''); };
    var imgBlock=function(id,label,path){ return path?'<div style="margin:4px 0 10px"><div class="cell-sub" style="margin-bottom:4px">'+label+'</div><img id="'+id+'" alt="'+label+'" style="width:100%;max-height:240px;object-fit:contain;border:1px solid var(--border);border-radius:8px;background:#fff;cursor:zoom-in;display:none" onclick="if(this.src)window.open(this.src,\'_blank\')"/><div class="cell-sub" id="'+id+'note">Loading…</div></div>':''; };
    /* card photo moves into the hero (keeps the #lmdet_img id so the signed-URL fetch below still fills it);
       the group photo stays in the Photos section (#lmdet_gimg). */
    var photos=imgBlock('lmdet_gimg','Group photo with the lead',l.groupPath);
    var fu=(rp.follow_ups&&rp.follow_ups.length)?rp.follow_ups.map(function(k){return fuMap[k]||k;}):[];
    /* ── build the action set first so the sticky bar can sit under the hero ── */
    var acts=[];
    if(lmIsParked(l)){
      /* Parked = a side-exit. Only action is Reactivate (→ region inbox, or Workspace if no region). */
      acts.push('<button class="btn btn-primary" onclick="CRM.lmReactivate(\''+l.id+'\')">Reactivate'+(l.assignedRegion?' → '+esc(lmRegionName(l.assignedRegion))+' inbox':' → Workspace')+'</button>');
      acts.push('<button class="btn btn-secondary" onclick="CRM.lmEnrichOpen(\''+l.id+'\')">Enrich</button>');
    } else {
      acts.push('<button class="btn btn-secondary" onclick="CRM.lmEnrichOpen(\''+l.id+'\')">Enrich</button>');
      if(lmIsCaptured(l)) acts.push('<button class="btn btn-primary" onclick="CRM.lmQualify(\''+l.id+'\')">Qualify</button>');
      if(lmIsQualified(l)) acts.push('<button class="btn btn-primary" onclick="CRM.lmAssignOpen(\''+l.id+'\')">Assign to region…</button>');
      if(lmIsUnclaimed(l)){
        var uMode=lmRoutingOf(l.assignedRegion), uMgr=lmIsManagerOf(l.assignedRegion);
        if(uMode==='claim') acts.push('<button class="btn btn-primary" onclick="CRM.lmClaim(\''+l.id+'\')">Claim (assign to me)</button>');
        if(uMgr) acts.push('<button class="btn btn-'+(uMode==='assign'?'primary':'secondary')+'" onclick="CRM.lmAssignMemberOpen(\''+l.id+'\')">Assign to member…</button>');
      }
      if(lmIsAssigned(l) && l.assignedTo && lmIsManagerOf(l.assignedRegion)) acts.push('<button class="btn btn-secondary" onclick="CRM.lmAssignMemberOpen(\''+l.id+'\')">Re-assign</button>');
      if(lmIsReturned(l)) acts.push('<button class="btn btn-primary" onclick="CRM.lmRequeueOpen(\''+l.id+'\')">Re-queue</button>');
      if(!lmIsReturned(l)) acts.push('<button class="btn btn-secondary" onclick="CRM.lmParkOpen(\''+l.id+'\')">Park for later…</button>');
      if(!lmIsReturned(l)) acts.push('<button class="btn btn-secondary" onclick="CRM.lmReturnOpen(\''+l.id+'\')">Return to marketing</button>');
    }
    /* ── hero: photo-forward + company + contact + status/region/product chips + provenance strip ── */
    var mono=esc(((l.company||'?').trim().charAt(0)||'?').toUpperCase());
    var heroPhoto=l.cardPath
      ? '<div class="l-hero-photo"><img id="lmdet_img" alt="Business card / badge" style="display:none" onclick="if(this.src)window.open(this.src,\'_blank\')"/><div class="cell-sub" id="lmdet_imgnote">Loading…</div><span class="l-hero-badge">'+esc(lmSourceLabel(l.source))+'</span></div>'
      : '<div class="l-hero-photo l-hero-mono"><span>'+mono+'</span><span class="l-hero-badge">'+esc(lmSourceLabel(l.source))+'</span></div>';
    var heroStatus=lmIsUnclaimed(l)
      ? '<span class="l-hero-status">Unclaimed · '+(lmRoutingOf(l.assignedRegion)==='assign'?'Assign':'Claim')+'</span>'
      : lmStageBadge(l);
    var heroChips=heroStatus
      +(l.assignedRegion?bdg('badge-n',lmRegionName(l.assignedRegion)):'')
      +(l.product&&l.product!=='—'?bdg('badge-n',l.product):'')
      +(l.band?bdg('badge-n',esc(l.band)):'');
    var prov='Source: '+esc(lmSourceLabel(l.source))+(l.campaign?' · Campaign: '+esc(l.campaign):'')+' · captured '+esc(l.age||lmAge(l.capturedAt));
    var hero='<div class="l-hero">'+heroPhoto
      +'<div class="l-hero-main"><div class="l-hero-co">'+esc(l.company)+'</div>'
      +(l.contact?'<div class="l-hero-sub">'+esc(l.contact)+(l.role?' · '+esc(l.role):'')+'</div>':'')
      +'<div class="l-hero-chips">'+heroChips+'</div>'
      +'<div class="l-hero-prov">'+prov+' · <span class="lot">'+esc(l.ref)+'</span></div></div></div>';
    var actbar='<div class="l-actbar">'+acts.join('')+'</div>';
    var body='<div class="l-form l-detail">'+hero+actbar
      +sec('Identity')
      +row('Lead','<span class="lot">'+esc(l.ref)+'</span>')
      +row('Stage',lmStageBadge(l))
      +(l.disposition==='returned'?row('Returned',esc(l.returnReason||'—')+(l.returnedAt?' · '+esc(lmDate(l.returnedAt)):'')):'')
      +(lmIsParked(l)?row('Parked for',((l.parkProducts&&l.parkProducts.length)?l.parkProducts.map(function(p){return bdg('badge-park',p);}).join(' '):'<span class="cell-sub">later season</span>')+(l.parkRevisit?' <span class="cell-sub">· revisit '+esc(lmMonthLabel(l.parkRevisit))+'</span>':'')+(l.parkReason?' <span class="cell-sub">· '+esc(l.parkReason)+'</span>':'')):'')
      +row('Country · region',or(l.country)+' · '+(l.assignedRegion?esc(lmRegionName(l.assignedRegion)):'<span class="cell-sub">unassigned</span>'))
      +(lmIsAssigned(l)?row('Owner',l.assignedTo?((lmIsMine(l)?'You':esc(l.assignedToName||'Another rep'))+(l.assignedByName?' <span class="cell-sub">· by '+esc(l.assignedByName)+'</span>':'')):'<span class="cell-sub">Unclaimed · in the region inbox</span>'):'')
      +row('Contact · role',or(l.contact)+(l.role?' · '+esc(l.role):''))
      +row('Importer type',withOther(rp.importer_type,rp.importer_other))
      +row('Exporter type',withOther(rp.exporter_type,rp.exporter_other))
      +sec('How to reach')
      +row('Email',or(l.email))
      +row('Phone',or(l.phone))
      +row('Website',or(l.website))
      +row('Address',or(r0.address))
      +sec('Their business')
      +row('Products / industries',or(rp.products_industries))
      +row('Export / import countries',or(rp.trade_countries))
      +row('Annual quantity',or(rp.annual_quantity))
      +sec('Interest & signal')
      +row('Products of interest',or(l.products&&l.products.length?l.products:''))
      +row('Other products',or(rp.products_other))
      +row('Volume band',or(l.band))
      +row('Destination port',or(l.port))
      +row('Season window',or(l.season))
      +row('Lead signal',or(rp.tags))
      +row('Follow-up actions',or(fu))
      +row('Follow-up · other',or(rp.followup_other))
      +sec('Notes')
      +row('Notes',l.notes?esc(l.notes).replace(/\n/g,'<br>'):'<span class="cell-sub">—</span>')
      +sec('Photos / files')
      +(l.cardPath?row('Business card / badge','<span class="cell-sub">shown above</span>'):'')
      +(photos||(!l.cardPath?row('Uploaded','<span class="cell-sub">none</span>'):''))
      +sec('Provenance')
      +row('Source · campaign',or(lmSourceLabel(l.source))+(l.campaign?' · '+esc(l.campaign):''))
      +row('Captured',or(lmDate(l.capturedAt))+' · '+esc(l.age))
      +lmDealStepperHtml(l)
      +lmActivityHtml(l);
    body+='<div class="l-formact"><button class="btn btn-secondary" onclick="CRM.closeDlv()">Close</button></div></div>';
    showDlv('Lead',body);
    /* fetch a signed URL for the stored business-card photo (private bucket) */
    if(l.cardPath && SB){
      try{ SB.storage.from('crm-lead-cards').createSignedUrl(l.cardPath,3600).then(function(res){
        var im=$('lmdet_img'), nt=$('lmdet_imgnote');
        if(res&&res.data&&res.data.signedUrl){ if(im){ im.src=res.data.signedUrl; im.style.display='block'; } if(nt&&nt.parentNode) nt.parentNode.removeChild(nt); }
        else if(nt){ nt.textContent='Card photo unavailable.'; }
      },function(){ var nt=$('lmdet_imgnote'); if(nt) nt.textContent='Card photo unavailable.'; }); }catch(e){}
    }
    if(l.groupPath && SB){
      try{ SB.storage.from('crm-lead-cards').createSignedUrl(l.groupPath,3600).then(function(res){
        var im=$('lmdet_gimg'), nt=$('lmdet_gimgnote');
        if(res&&res.data&&res.data.signedUrl){ if(im){ im.src=res.data.signedUrl; im.style.display='block'; } if(nt&&nt.parentNode) nt.parentNode.removeChild(nt); }
        else if(nt){ nt.textContent='Photo unavailable.'; }
      },function(){ var nt=$('lmdet_gimgnote'); if(nt) nt.textContent='Photo unavailable.'; }); }catch(e){}
    }
  }
  function lmEnrichProdChips(sel){ sel=sel||[]; var s={}; sel.forEach(function(p){s[p]=1;}); return CAP_PRODUCTS.map(function(p){ return '<button type="button" class="capchip'+(s[p]?' on':'')+'" data-prod="'+esc(p)+'" onclick="CRM.lmEnrichChip(this)">'+esc(p)+'</button>'; }).join(''); }
  function lmEnrichChip(btn){ btn.classList.toggle('on'); }
  function lmEnrichOpen(id){
    var l=lmById(id); if(!l) return; var r=l.raw||{}, rp=r.raw_payload||{};
    var typeOpts=function(a){ return [['','—']].concat(a.map(function(x){return [x,x];})); };
    var body='<div class="l-form"><div class="l-formnote">Complete anything left blank at the stand — every capture field is here, and it all saves to the lead. Fill the empties, then Qualify.</div>'
      +'<div class="l-qhdr">'+esc(l.company)+'</div>'
      +field('lm_contact','Contact name',r.contact_name,'e.g. J. Whitfield')
      +field('lm_role','Contact role / title',r.contact_role,'e.g. Procurement Manager')
      +'<div class="grid2">'+field('lm_email','Email',r.email,'name@company.com')+field('lm_phone','Phone',r.phone,'')+'</div>'
      +'<div class="grid2">'+field('lm_website','Website',r.website,'www.company.com')+field('lm_country','Country',r.country,'')+'</div>'
      +field('lm_address','Address',r.address,'street, city, country')
      +'<label class="form-label" style="margin-top:8px">Products of interest</label><div class="capchips" id="lm_products">'+lmEnrichProdChips(r.product_interest)+'</div>'
      +'<div class="grid2">'+field('lm_band','Expected volume band',r.expected_volume_band,'e.g. 1–5 containers')+field('lm_qty','Annual quantity',rp.annual_quantity,'e.g. 300 cont. / season')+'</div>'
      +'<div class="grid2">'+field('lm_port','Destination port',r.destination_port,'e.g. Jebel Ali')+field('lm_season','Season window',r.season_window,'e.g. wk 40–48')+'</div>'
      +'<div class="grid2">'+selField('lm_exp','Exporter type',typeOpts(['Grower','Trader','Association','Other']),rp.exporter_type||'')+selField('lm_imp','Importer type',typeOpts(['Agent','Retailer','Wholesaler','Other']),rp.importer_type||'')+'</div>'
      +field('lm_industries','Products / industries they deal in',rp.products_industries,'what they trade')
      +field('lm_trade','Countries of export / import',rp.trade_countries,'e.g. UK, Germany, UAE')
      +'<label class="form-label" style="margin-top:8px">Notes</label><textarea class="form-input" id="lm_notes" rows="3">'+esc(r.notes||'')+'</textarea>'
      +'<div class="l-formact"><button class="btn btn-primary" onclick="CRM.lmEnrichSave(\''+l.id+'\')">Save enrichment</button><button class="btn btn-secondary" onclick="CRM.closeDlv()">Cancel</button></div></div>';
    showDlv('Enrich lead',body);
  }
  function lmEnrichSave(id){
    var l=lmById(id), r=(l&&l.raw)||{}, rp=Object.assign({},r.raw_payload||{});
    function setrp(k,v){ if(v) rp[k]=v; else delete rp[k]; }
    setrp('exporter_type',lmVal('lm_exp')); setrp('importer_type',lmVal('lm_imp'));
    setrp('products_industries',lmVal('lm_industries')); setrp('trade_countries',lmVal('lm_trade')); setrp('annual_quantity',lmVal('lm_qty'));
    var prods=[]; var box=$('lm_products'); if(box){ var on=box.querySelectorAll('.capchip.on'); for(var i=0;i<on.length;i++) prods.push(on[i].getAttribute('data-prod')); }
    lmUpdate(id,{ contact_name:lmVal('lm_contact'), contact_role:lmVal('lm_role'), email:lmVal('lm_email'), phone:lmVal('lm_phone'),
      website:lmVal('lm_website'), country:lmVal('lm_country'), address:lmVal('lm_address'),
      expected_volume_band:lmVal('lm_band'), destination_port:lmVal('lm_port'), season_window:lmVal('lm_season'),
      product_interest:(prods.length?prods:null), notes:lmVal('lm_notes'),
      raw_payload:(Object.keys(rp).length?rp:null) },'Enrichment saved.');
  }
  function lmQualify(id){ var l=lmById(id); if(!l) return; lmUpdate(id,{ stage:1, disposition:'qualified', qualified_at:new Date().toISOString() },'<b>'+esc(l.company)+'</b> qualified → assign it to a region.'); }
  var lmAsg=null;
  function lmAssignOpen(id){
    lmAsg={id:id,region:null};
    var regs=lmRealRegions();
    var body='<div class="l-form"><div class="l-formnote">Choose the CRM region. The lead lands unclaimed in that region’s Lead inbox for a rep to claim.</div>'
      +'<div class="l-qhdr">Assign to CRM region</div>'
      +(regs.length?regs.map(function(r,i){return '<div class="who" onclick="CRM.lmPickRegion(this,'+i+')"><div><div class="who-n">'+esc(r[1])+'</div><div class="who-s">'+(regionOwner[r[0]]?'owner · '+esc(regionOwner[r[0]]):'region')+'</div></div></div>';}).join(''):'<div class="empty-state">No regions configured.</div>')
      +'<div class="l-formact"><button class="btn btn-primary" onclick="CRM.lmAssignSave()">Assign</button><button class="btn btn-secondary" onclick="CRM.closeDlv()">Cancel</button></div></div>';
    showDlv('Assign to region',body);
  }
  function lmPickRegion(el,i){ if(!lmAsg) return; var regs=lmRealRegions(); lmAsg.region=regs[i]&&regs[i][0]; var ps=el.parentNode.querySelectorAll('.who'); for(var j=0;j<ps.length;j++) ps[j].classList.remove('sel'); el.classList.add('sel'); }
  function lmAssignSave(){
    if(!lmAsg||!lmAsg.region){ toast('Pick a region first.'); return; }
    /* Region assignment = the Assigned stage. Does NOT set an owner — the lead lands unclaimed in
       that region's Lead inbox until a rep claims it. */
    lmUpdate(lmAsg.id,{ assigned_region:lmAsg.region, assigned_at:new Date().toISOString(), stage:2 },'Assigned to '+esc(lmRegionName(lmAsg.region))+' · now in the region lead inbox to claim.');
  }
  /* Claim = flag the lead to a rep (the owner). Separate from the stage; moves it into that rep's pipeline. */
  function lmClaim(id){ var l=lmById(id); if(!l) return; lmUpdate(id,{ assigned_to:(USER&&USER.id)||null },'<b>'+esc(l.company)+'</b> claimed — it’s in your pipeline.'); }
  /* ── Assign mode · manager assigns an unclaimed/owned lead to a region member ──
     Picker is fed by crm_region_members(region); the pick calls crm_assign_lead(lead,user) (or NULL to
     release). Both RPCs re-check admin/manager-of-region server-side, so the client gate (lmIsManagerOf)
     is cosmetic — a non-manager who forces the call gets the RPC error surfaced via the toast. */
  var lmMem={id:null,region:null,to:null,rows:[]};
  function lmAssignMemberOpen(id){
    var l=lmById(id); if(!l) return;
    var region=l.assignedRegion;
    if(!region){ toast('Assign the lead to a region first.'); return; }
    if(!lmIsManagerOf(region)){ toast('<b>Not permitted</b> · only a region manager can assign leads.'); return; }
    if(!SB){ toast('No connection.'); return; }
    lmMem={id:id,region:region,to:null,rows:[]};
    showDlv('Assign to member','<div class="l-form"><div class="l-formnote">Loading '+esc(regionLabel[region]||region)+' members…</div></div>');
    SB.rpc('crm_region_members',{p_region:region}).then(function(res){
      if(res&&res.error){ toast('<b>Could not load members.</b> '+esc(res.error.message||'')); closeDlv(); return; }
      lmMem.rows=(res&&res.data)||[]; lmRenderMemberPicker(l);
    }).catch(function(e){ toast('<b>Could not load members.</b> '+esc(String(e))); closeDlv(); });
  }
  function lmRenderMemberPicker(l){
    var region=lmMem.region, curOwner=l.assignedTo;
    var rows=lmMem.rows.length?lmMem.rows.map(function(m){
      var sel=(lmMem.to?lmMem.to===m.user_id:(curOwner&&curOwner===m.user_id));
      var badge=m.is_manager?' <span class="pchip ok">Manager</span>':'';
      var owns=(curOwner&&curOwner===m.user_id)?' <span class="pchip mut">current owner</span>':'';
      return '<div class="who'+(sel?' sel':'')+'" onclick="CRM.lmMemberPick(\''+esc(m.user_id)+'\')"><div class="avatar">'+esc(lmInitials(m.full_name))+'</div>'
        +'<div style="flex:1;min-width:0"><div class="who-n">'+esc(m.full_name||'—')+badge+owns+'</div><div class="who-s">'+esc(m.role||'member')+'</div></div>'
        +'<div class="who-s" style="margin-left:auto;white-space:nowrap">'+(m.open_load||0)+' open</div></div>';
    }).join(''):'<div class="empty-state">No members in this region yet. An admin can add them under Admin → Users → Region access.</div>';
    var releaseBtn=curOwner?'<button class="btn btn-secondary" onclick="CRM.lmReleaseMember()">Release to inbox</button>':'';
    var body='<div class="l-form"><div class="l-formnote">Assign <b>'+esc(l.company)+'</b> to a member of <b>'+esc(regionLabel[region]||region)+'</b>. The member owns it in their pipeline; you can re-assign later.</div>'
      +'<div class="l-qhdr">Assign to member</div>'+rows
      +'<div class="l-formact"><button class="btn btn-primary" onclick="CRM.lmAssignMemberSave()">Assign</button>'+releaseBtn+'<button class="btn btn-secondary" onclick="CRM.closeDlv()">Cancel</button></div></div>';
    $('dlvBody').innerHTML=body;
  }
  function lmMemberPick(userId){ if(!lmMem) return; lmMem.to=userId; var l=lmById(lmMem.id); if(l) lmRenderMemberPicker(l); }
  function lmAssignMemberSave(){ if(!lmMem||!lmMem.id) return; if(!lmMem.to){ toast('Pick a member first.'); return; } lmDoAssign(lmMem.id,lmMem.to); }
  function lmReleaseMember(){ if(!lmMem||!lmMem.id) return; lmDoAssign(lmMem.id,null); }
  function lmDoAssign(leadId,toUserId){
    if(!SB){ toast('No connection.'); return; }
    SB.rpc('crm_assign_lead',{p_lead:leadId,p_to:toUserId}).then(function(res){
      if(res&&res.error){ toast('<b>Assign failed.</b> '+esc(res.error.message||'')); return; }
      closeDlv(); toast(toUserId?'Lead assigned.':'Lead released back to the inbox.'); lmReload();
    }).catch(function(e){ toast('<b>Assign failed.</b> '+esc(String(e))); });
  }
  /* Return to marketing — captures a reason (why), who, and when. Drops rep ownership so the
     lead leaves the pipeline; keeps assigned_region as context for the Returned-by-sales list.
     Reasons mirror the mockup's Class A/B vocabulary; the A/B/No-response CLASSIFICATION is Phase 2. */
  var LM_RETURN_REASONS=['No capacity','Price / terms too low','Credit risk','Already sourced elsewhere','Not a genuine importer','Product / season mismatch','Volume overstated','Certification gap','Other'];
  var lmRet=null, lmRq=null;
  /* Append-only sales<->marketing handoff thread (l.thread ← crm_leads.handoff_log). Read-modify-write
     from the in-memory row; low-volume so a rare clobber is acceptable (atomic RPC is a Phase-2 item). */
  function lmThreadEntry(kind,note){ return { at:new Date().toISOString(), by:(USER&&USER.id)||null, byName:(USER&&(USER.name||USER.email))||'', kind:kind, note:(note||'') }; }
  function lmThreadHtml(l){
    var t=(l.thread||[]); if(!t.length) return '';
    var rows=t.slice().reverse().map(function(e){
      var who=e.kind==='requeue'?'Marketing · re-queued':'Sales · returned';
      var when=e.at?lmDate(e.at):'';
      var txt=e.note?esc(e.note):'<span class="cell-sub">(no note)</span>';
      return '<div class="l-drow" style="align-items:flex-start;gap:10px"><span class="cell-sub" style="min-width:132px">'+esc(who)+(when?' · '+esc(when):'')+'</span><span>'+txt+'</span></div>';
    }).join('');
    return '<div class="l-qsec">Handoff history</div>'+rows;
  }
  function lmReturnOpen(id){
    var l=lmById(id); if(!l) return; lmRet={id:id,reason:null};
    var chips=LM_RETURN_REASONS.map(function(r){ return '<button type="button" class="capchip" data-r="'+esc(r)+'" onclick="CRM.lmReturnPick(this)">'+esc(r)+'</button>'; }).join('');
    var body='<div class="l-form"><div class="l-formnote">Why is this going back to marketing? The reason shows in <b>Returned by sales</b>. The A / B / No-response classification arrives with the Phase-2 rules.</div>'
      +'<div class="l-qhdr">'+esc(l.company)+' → return to marketing</div>'
      +lmThreadHtml(l)
      +'<label class="form-label" style="margin-top:8px">Reason</label><div style="display:flex;flex-wrap:wrap;gap:6px">'+chips+'</div>'
      +'<label class="form-label" style="margin-top:10px">Note (optional)</label><textarea class="form-input" id="lm_ret_note" rows="2" placeholder="Anything marketing should know…"></textarea>'
      +'<div class="l-formact"><button class="btn btn-primary" onclick="CRM.lmReturnSave()">Return to marketing</button><button class="btn btn-secondary" onclick="CRM.closeDlv()">Cancel</button></div></div>';
    showDlv('Return to marketing',body);
  }
  function lmReturnPick(btn){ if(!lmRet) return; lmRet.reason=btn.getAttribute('data-r'); var cs=btn.parentNode.querySelectorAll('.capchip'); for(var i=0;i<cs.length;i++) cs[i].classList.remove('on'); btn.classList.add('on'); }
  function lmReturnSave(){
    if(!lmRet) return; var l=lmById(lmRet.id); var note=lmVal('lm_ret_note'); var reason=lmRet.reason||'';
    if(reason==='Other') reason=note||'Other'; else if(note) reason=(reason?reason+' — '+note:note);
    if(!reason){ toast('Pick a reason first.'); return; }
    var thread=(l&&l.thread?l.thread.slice():[]); thread.push(lmThreadEntry('return',reason));
    lmUpdate(lmRet.id,{ disposition:'returned', return_reason:reason, returned_at:new Date().toISOString(), returned_by:(USER&&USER.id)||null, assigned_to:null, assigned_at:null, handoff_log:thread },'Returned to marketing.');
  }
  /* Re-queue = marketing pushes back into the Workspace. Captures a note and PRESERVES the sales
     return note (append to the thread; do NOT wipe return_reason) so the history survives round-trips. */
  function lmRequeueOpen(id){
    var l=lmById(id); if(!l) return; lmRq={id:id};
    var lastRet=(l.thread||[]).slice().reverse().filter(function(e){return e.kind==='return';})[0];
    var lastNote=(lastRet&&lastRet.note)||l.returnReason||'';
    var body='<div class="l-form"><div class="l-formnote">Re-queue sends this back into the Workspace for re-triage. Add a note if you’re pushing back on the sales return — the handoff history is kept.</div>'
      +'<div class="l-qhdr">'+esc(l.company)+' → re-queue</div>'
      +(lastNote?'<div class="alert-warn" style="margin:2px 0 4px">Sales returned this: <b>'+esc(lastNote)+'</b></div>':'')
      +lmThreadHtml(l)
      +'<label class="form-label" style="margin-top:8px">Note to sales (optional)</label><textarea class="form-input" id="lm_rq_note" rows="2" placeholder="Why it’s going back — e.g. capacity confirmed, please re-engage"></textarea>'
      +'<div class="l-formact"><button class="btn btn-primary" onclick="CRM.lmRequeueSave()">Re-queue</button><button class="btn btn-secondary" onclick="CRM.closeDlv()">Cancel</button></div></div>';
    showDlv('Re-queue lead',body);
  }
  function lmRequeueSave(){
    if(!lmRq) return; var l=lmById(lmRq.id); var note=lmVal('lm_rq_note');
    var thread=(l&&l.thread?l.thread.slice():[]); thread.push(lmThreadEntry('requeue',note));
    /* Land it cleanly back in the Workspace: unowned, region cleared, and dropped from the Assigned
       stage back to Qualified (stage 2 -> 1) so state stays coherent. Keeps return_* as history. */
    var st=(l&&l.stage>=2)?1:((l&&l.stage)||0);
    lmUpdate(lmRq.id,{ disposition:null, assigned_region:null, assigned_to:null, assigned_at:null, stage:st, handoff_log:thread },'<b>'+esc(l?l.company:'Lead')+'</b> re-queued to the Workspace.');
  }
  /* ── Park for later → seasonal backlog (customer said "come back next season for product X") ──
     Keeps assigned_region (durable key) + last owner as history; on Reactivate the lead returns to
     the REGION inbox, never silently to a rep who may have left. */
  var lmPk=null;
  function lmParkProdChips(sel){ sel=sel||{}; return CAP_PRODUCTS.map(function(p){ return '<button type="button" class="capchip'+(sel[p]?' on':'')+'" data-p="'+esc(p)+'" onclick="CRM.lmParkChip(this)">'+esc(p)+'</button>'; }).join(''); }
  function lmParkChip(btn){ if(!lmPk) return; var p=btn.getAttribute('data-p'); lmPk.products[p]=!lmPk.products[p]; btn.classList.toggle('on',!!lmPk.products[p]); }
  function lmParkOpen(id){
    var l=lmById(id); if(!l) return;
    var seed={}; (l.products||[]).forEach(function(p){ if(p&&p!=='—') seed[p]=true; });
    lmPk={id:id,products:seed};
    var dest=l.assignedRegion?(esc(lmRegionName(l.assignedRegion))+' inbox'):'the Workspace';
    var body='<div class="l-form"><div class="l-formnote">Park a lead the customer wants revisited next season. It leaves the active inbox &amp; pipeline and waits in the product-keyed backlog. On reactivation it returns to <b>'+dest+'</b> — the region, not a specific rep.</div>'
      +'<div class="l-qhdr">'+esc(l.company)+' → park for later</div>'
      +'<label class="form-label" style="margin-top:6px">Product(s) they\'ll buy</label><div class="capchips" id="lm_park_prod">'+lmParkProdChips(seed)+'</div>'
      +'<div class="hint" style="margin-top:4px">Prefilled from their captured interest — trim to what they committed to.</div>'
      +'<label class="form-label" style="margin-top:10px">Revisit around <span class="cell-sub" style="text-transform:none;letter-spacing:0">(target month — when to reconnect)</span></label><input type="month" class="form-input" id="lm_park_when" value="'+esc(l.parkRevisit||'')+'" style="width:auto"/>'
      +'<label class="form-label" style="margin-top:10px">Note (optional)</label><textarea class="form-input" id="lm_park_note" rows="2" placeholder="e.g. Not grapes this year — mango next season, CFR terms, big volume."></textarea>'
      +'<div class="l-formact"><button class="btn btn-primary" onclick="CRM.lmParkSave()">Park lead</button><button class="btn btn-secondary" onclick="CRM.closeDlv()">Cancel</button></div></div>';
    showDlv('Park for later',body);
  }
  function lmParkSave(){
    if(!lmPk) return; var l=lmById(lmPk.id);
    var prods=Object.keys(lmPk.products).filter(function(p){return lmPk.products[p];});
    if(!prods.length){ toast('Pick at least one product they’ll buy.'); return; }
    var note=lmVal('lm_park_note'); var when=lmVal('lm_park_when');
    var thread=(l&&l.thread?l.thread.slice():[]); thread.push(lmThreadEntry('parked',prods.join(', ')+(when?' · '+lmMonthLabel(when):'')+(note?' — '+note:'')));
    lmUpdate(lmPk.id,{ disposition:'parked', park_products:prods, park_reason:note||null, park_revisit:when||null, parked_at:new Date().toISOString(), parked_by:(USER&&USER.id)||null, handoff_log:thread },'<b>'+esc(l?l.company:'Lead')+'</b> parked for '+esc(prods.join(', '))+(when?' · '+esc(lmMonthLabel(when)):'')+'.');
  }
  /* 'YYYY-MM' → 'Oct 2026' */
  function lmMonthLabel(ym){ if(!ym||!/^\d{4}-\d{2}$/.test(ym)) return ym||''; var m=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; var p=ym.split('-'); var i=(parseInt(p[1],10)||1)-1; return (m[i]||p[1])+' '+p[0]; }
  /* Reactivate = un-park into the REGION inbox (unclaimed) so the region's claim/assign routing
     re-homes it; no region on the lead → back to the Workspace (Qualified). Owner history is kept
     in the timeline, not restored, so a departed rep can't swallow the lead. */
  function lmReactivate(id){
    var l=lmById(id); if(!l||!lmIsParked(l)) return;
    var thread=(l.thread?l.thread.slice():[]); thread.push(lmThreadEntry('reactivated',(l.parkProducts&&l.parkProducts.length)?l.parkProducts.join(', '):''));
    var hasRegion=!!l.assignedRegion;
    var patch={ disposition:null, assigned_to:null, assigned_at:null, stage:hasRegion?2:1,
      park_products:null, park_reason:null, park_revisit:null, parked_at:null, parked_by:null, handoff_log:thread };
    lmUpdate(id,patch, '<b>'+esc(l.company)+'</b> reactivated'+(hasRegion?' → '+esc(lmRegionName(l.assignedRegion))+' inbox':' → Workspace')+'.');
  }
  function lmSearch(v){ LM.q=v; clearTimeout(lmSearch._t); lmSearch._t=setTimeout(function(){ render(); var el=$('lm_q'); if(el){ el.focus(); el.value=LM.q; try{ el.selectionStart=el.selectionEnd=el.value.length; }catch(e){} } },160); }
  function lmSetF(k,v){ LM.f[k]=v; render(); }

  /* In-view segment tabs for the consolidated Leads / My Work / Funnel views (5-item sidebar).
     Reuses the .lsub/.lsubt styling; each tab drives leadNav(dest,key) and highlights against
     activeLeadKey(). tabs = [ [key, label, count|'' , countBadgeClass], … ]. */
  function lsegBar(dest,tabs){
    var cur=activeLeadKey();
    return '<div class="lsub">'+tabs.map(function(t){
      var on=(t[0]===cur);
      var c=(t[2]!=null&&t[2]!=='')?' <span class="badge '+(t[3]||'badge-n')+'" style="margin-left:5px">'+esc(String(t[2]))+'</span>':'';
      return '<span class="lsubt'+(on?' on':'')+'" role="button" tabindex="0" onclick="CRM.leadNav(\''+dest+'\',\''+t[0]+'\')">'+esc(t[1])+c+'</span>';
    }).join('')+'</div>';
  }

  /* ═══════════════════ LEADS destination ═══════════════════ */
  function renderLeads(){
    var vc=$('viewContent'); if(!vc) return;
    var pane, bar='';
    if(LSUB.leads==='enr') pane=paneEnrichment();
    else if(LSUB.leads==='rej') pane=paneReturned();
    else if(LSUB.leads==='park') pane=paneParked();
    else if(LSUB.leads==='xsell') pane=paneCrossSell();
    else if(LSUB.leads==='cap') pane=paneCapture();
    else pane=paneWorkspace();
    /* Segment tabs: All leads · Needs enrichment · Returned · Parked · Cross-sell. Capture (Show
       Mode) is its own sidebar item, so it carries NO segment bar. */
    if(LSUB.leads!=='cap'){
      var sc=LM.loaded?lmScope(LM.rows):[];
      var allN=LM.loaded?sc.filter(function(l){return !lmIsReturned(l)&&!lmIsParked(l);}).length:'';
      var enrN=LM.loaded?sc.filter(lmIsCaptured).length:'';
      var rejN=LM.loaded?sc.filter(lmIsReturned).length:'';
      var parkN=LM.loaded?sc.filter(lmIsParked).length:'';
      var xsN=LM.loaded?sc.filter(function(l){return !!lmCrossSell(l);}).length:'';
      bar=lsegBar('leads',[['ws',lmRegionScoped()?'My region':'All leads',allN,'badge-n'],['enr','Needs enrichment',enrN,'badge-warn'],['rej','Returned',rejN,'badge-fail'],['park','Parked',parkN,'badge-park'],['xsell','Cross-sell',xsN,'badge-n']]);
    }
    /* All Leads views (Workspace/Enrichment/Returned/Capture) are REAL now — no dummy draft/live chrome. */
    vc.innerHTML='<div class="lead-portal">'+bar+pane+'</div>';
  }

  function paneWorkspace(){
    if(!LM.loaded){ lmEnsure(); return lmSkel(); }
    var base=lmScope(LM.rows);
    var all=base.filter(function(l){return !lmIsReturned(l)&&!lmIsParked(l);});
    var enrN=base.filter(lmIsCaptured).length;
    var qualN=base.filter(lmIsQualified).length;
    var asgN=base.filter(lmIsAssigned).length;
    var kpis=
      kcard('Leads captured',String(base.length),'all capture sources')+
      kcard('In enrichment',String(enrN),'stage 0 · needs fields')+
      kcard('Qualified',String(qualN),'ready to assign')+
      kcard('Assigned',String(asgN),'to a region');
    var q=(LM.q||'').toLowerCase();
    var list=all.filter(function(l){
      if(LM.f.source!=='all'&&l.source!==LM.f.source) return false;
      if(LM.f.region!=='all'&&(l.assignedRegion||'')!==LM.f.region) return false;
      if(LM.f.stage!=='all'&&String(l.stage)!==LM.f.stage) return false;
      if(q){ var hay=(l.company+' '+l.contact+' '+l.email+' '+l.country).toLowerCase(); if(hay.indexOf(q)<0) return false; }
      return true;
    });
    function fsel(key,label,opts){
      return '<select class="form-select" style="width:auto" onchange="CRM.lmSetF(\''+key+'\',this.value)">'
        +'<option value="all">'+label+'</option>'
        +opts.map(function(o){return '<option value="'+esc(o[0])+'"'+(String(LM.f[key])===String(o[0])?' selected':'')+'>'+esc(o[1])+'</option>';}).join('')+'</select>';
    }
    var filters='<div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:11px">'
      +fsel('source','All sources',LM_SOURCES)
      +fsel('region','All regions',lmScopedRegions())
      +fsel('stage','All stages',[['0','Captured'],['1','Qualified'],['2','Assigned']])
      +'<input class="form-input" id="lm_q" value="'+esc(LM.q)+'" style="width:auto;flex:1;min-width:150px" placeholder="Search company, contact, email, country…" oninput="CRM.lmSearch(this.value)"/></div>';
    var rows=list.map(function(l){
      return '<tr onclick="CRM.lmOpen(\''+l.id+'\')">'
        +'<td><span class="lot">'+esc(l.ref)+'</span></td>'
        +'<td>'+esc(l.company)+'</td><td>'+esc(l.country)+'</td>'
        +'<td>'+(l.assignedRegion?bdg('badge-n',lmRegionName(l.assignedRegion)):bdg('badge-warn','unassigned'))+'</td>'
        +'<td>'+esc(l.product)+'</td>'
        +'<td>'+bdg('badge-n',lmSourceLabel(l.source))+'</td>'
        +'<td>'+(l.campaign?esc(l.campaign):'<span class="cell-sub">—</span>')+'</td>'
        +'<td class="mono">'+esc(l.band||'—')+'</td>'
        +'<td>'+lmStageBadge(l)+'</td>'
        +'<td class="mono">'+esc(l.age)+'</td></tr>';
    }).join('');
    if(!list.length) rows='<tr><td colspan="10" class="cell-sub" style="padding:16px;text-align:center">No leads match. Captures from Show Mode and the public form land here.</td></tr>';
    return '<div class="kpi-grid" style="margin-bottom:12px">'+kpis+'</div>'
      +'<div class="card" style="margin-bottom:12px"><div class="section-title"><span class="section-title-bar"></span> '+(lmRegionScoped()?'Leads in your region(s)':'All leads')+' · '+list.length
      +' <span style="margin-left:auto;display:inline-flex;gap:6px"><button class="btn btn-secondary btn-sm" onclick="CRM.lmRefresh(this)">↻ Refresh</button><button class="btn btn-secondary btn-sm" onclick="CRM.lmImportOpen()">Import CSV</button><button class="btn btn-primary btn-sm" onclick="CRM.lmNewOpen()">+ New lead</button></span></div>'
      +filters
      +'<div class="table-wrap"><table><thead><tr><th>Lead</th><th>Company</th><th>Country</th><th>CRM region</th><th>Product</th><th>Source</th><th>Campaign</th><th>Vol.</th><th>Stage</th><th>Age</th></tr></thead><tbody id="lwt">'+rows+'</tbody></table></div></div>';
  }
  function kcard(l,v,s){ return '<div class="card"><div class="kpi-l">'+l+'</div><div class="kpi-v">'+v+'</div><div class="kpi-s">'+(s||'')+'</div></div>'; }

  function leadDetailPanel(l){
    var gates=L_GATES.map(function(g){ var v=l.gates[g.k];
      var label=g.label; if(g.k==='cert'&&v==='warn') label='Certification — BRC + Tesco Nurture: 2 of 5 packhouses';
      return '<div class="gate">'+gateIcon(v)+' '+esc(label)+' <span class="gate-src">'+(g.src==='auto'?'auto · DalOS':'marketing')+'</span></div>';
    }).join('');
    var certWarn=l.gates.cert==='warn'?'<div class="alert-warn" style="margin-top:11px">Retailer programme required. Only Toshka &amp; Sinai hold Tesco Nurture — flag capacity before quoting.</div>':'';
    var left='<div class="ldp"><div class="ldp-h">Lead detail · <span class="lot">'+esc(l.id)+'</span> '+esc(l.company)+'</div>'
      +'<div style="padding:13px"><div class="section-title" style="margin-bottom:8px"><span class="section-title-bar"></span> Qualification gates</div>'
      +gates+certWarn
      /* Role bleed fix: marketing can't advance past stage 2, so the sales Accept / Reject decision
         bar is gone from the marketing lead-detail drawer. Primary actions here are Assign to region
         / Enrich; Accept / Pass lives in My Work (the sales inbox). */
      +'<div style="display:flex;gap:8px;margin-top:12px"><button class="btn btn-primary" style="flex:1" onclick="CRM.leadAssignOpen()">Assign to region</button>'
      +'<button class="btn btn-secondary" style="flex:1" onclick="CRM.leadEnrich(\''+l.id+'\')">Enrich</button></div></div></div>';
    var touch='<div class="ldp"><div class="ldp-h">Touches &amp; attribution</div><div style="padding:13px">'
      +'<div class="table-wrap"><table style="min-width:0"><thead><tr><th>When</th><th>Campaign</th><th>Source</th><th>By</th></tr></thead><tbody>'
      +'<tr><td class="mono">2026-07-13</td><td>Fruit Attraction 26</td><td>Event · stand visit</td><td>Hoda S.</td></tr>'
      +'<tr><td class="mono">2026-07-22</td><td>Grapes pre-season</td><td>Email · price list</td><td>Hoda S.</td></tr>'
      +'<tr><td class="mono">2026-08-01</td><td>—</td><td>Inbound · web form</td><td>system</td></tr>'
      +'</tbody></table></div>'
      +'<div class="alert-ok" style="margin-top:11px"><strong>Sourced by</strong> Marketing · Hoda S. · <span class="mono">2026-07-13</span> · <strong>Attribution expires</strong> <span class="mono">2028-01-13</span></div></div></div>';
    return '<div class="grid2">'+left+touch+'</div>';
  }

  function paneEnrichment(){
    if(!LM.loaded){ lmEnsure(); return lmSkel(); }
    var list=lmScope(LM.rows).filter(lmIsCaptured);
    var rows=list.map(function(l){
      return '<tr onclick="CRM.lmOpen(\''+l.id+'\')"><td><span class="lot">'+esc(l.ref)+'</span></td><td>'+esc(l.company)+'</td><td>'+esc(l.country)+'</td>'
        +'<td>'+bdg('badge-n',lmSourceLabel(l.source))+'</td>'
        +'<td>'+esc(lmMissing(l))+'</td><td>'+esc(l.product)+'</td><td class="mono">'+esc(l.age)+'</td>'
        +'<td onclick="event.stopPropagation()"><button class="btn btn-secondary btn-sm" onclick="CRM.lmEnrichOpen(\''+l.id+'\')">Enrich</button></td></tr>';
    }).join('');
    if(!list.length) rows='<tr><td colspan="8" class="cell-sub" style="padding:16px;text-align:center">Enrichment queue is clear — every captured lead has its detail.</td></tr>';
    return '<div class="card" style="margin-bottom:12px"><div class="section-title"><span class="section-title-bar"></span> Enrichment queue · '+list.length+' captured lead(s)'
      +' <span style="margin-left:auto"><button class="btn btn-secondary btn-sm" onclick="CRM.lmRefresh(this)">↻ Refresh</button></span></div>'
      +'<div class="alert-warn" style="margin-bottom:11px">Captured at the stand or via the public form. Fill in the missing detail, then <strong>Qualify</strong> to advance the lead and route it to a region.</div>'
      +'<div class="table-wrap"><table><thead><tr><th>Lead</th><th>Company</th><th>Country</th><th>Source</th><th>Missing</th><th>Product</th><th>Age</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div></div>';
  }

  /* Returned by sales — REAL (crm_leads where disposition='returned').
     Phase 1: a visible, recoverable list so returned leads don't vanish. The A/B/No-response
     classification, reason codes and Class-A analytics are DEFERRED to the Phase-2 returned-lead rules. */
  function paneReturned(){
    if(!LM.loaded){ lmEnsure(); return lmSkel(); }
    var list=lmScope(LM.rows).filter(function(l){return l.disposition==='returned';});
    var rows=list.map(function(l){
      return '<tr onclick="CRM.lmOpen(\''+l.id+'\')">'
        +'<td><span class="lot">'+esc(l.ref)+'</span></td>'
        +'<td>'+esc(l.company)+'</td>'
        +'<td>'+(l.assignedRegion?bdg('badge-n',lmRegionName(l.assignedRegion)):bdg('badge-warn','unassigned'))+'</td>'
        +'<td>'+esc(l.product)+'</td>'
        +'<td>'+bdg('badge-n',lmSourceLabel(l.source))+'</td>'
        +'<td>'+(l.returnReason?esc(l.returnReason):'<span class="cell-sub">—</span>')+'</td>'
        +'<td class="mono">'+esc(l.returnedAt?lmDate(l.returnedAt):'—')+'</td>'
        +'<td onclick="event.stopPropagation()"><button class="btn btn-secondary btn-sm" onclick="CRM.lmRequeueOpen(\''+l.id+'\')">Re-queue</button></td></tr>';
    }).join('');
    if(!list.length) rows='<tr><td colspan="8" class="cell-sub" style="padding:16px;text-align:center">No leads have been returned to marketing.</td></tr>';
    return '<div class="card" style="margin-bottom:12px"><div class="section-title"><span class="section-title-bar"></span> Returned by sales · '+list.length+' lead(s)'
      +' <span style="margin-left:auto"><button class="btn btn-secondary btn-sm" onclick="CRM.lmRefresh(this)">↻ Refresh</button></span></div>'
      +'<div class="alert-warn" style="margin-bottom:11px">Leads a rep sent back to marketing. <strong>Re-queue</strong> puts one back in the Workspace for re-triage. Reason codes and the A / B / No-response classification arrive with the Phase-2 returned-lead rules.</div>'
      +'<div class="table-wrap"><table><thead><tr><th>Lead</th><th>Company</th><th>Region</th><th>Product</th><th>Source</th><th>Reason</th><th>Returned</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div></div>';
  }
  /* Parked backlog — keyed by target product. Grouped so that at a season start you open the
     product you're launching and reactivate its leads into their region inboxes. */
  function paneParked(){
    if(!LM.loaded){ lmEnsure(); return lmSkel(); }
    var list=lmScope(LM.rows).filter(lmIsParked);
    /* group by each target product (a lead can sit under more than one) */
    var byProd={}, order=[];
    list.forEach(function(l){
      var ps=(l.parkProducts&&l.parkProducts.length)?l.parkProducts:['(unspecified)'];
      ps.forEach(function(p){ if(!byProd[p]){ byProd[p]=[]; order.push(p); } byProd[p].push(l); });
    });
    order.sort(function(a,b){ return a.localeCompare(b); });
    /* product filter (only the products actually present in the backlog) */
    var pf=LM.parkFilter||'all';
    if(pf!=='all' && order.indexOf(pf)<0) pf='all';
    var filterSel='<select class="form-select" style="width:auto" onchange="CRM.lmSetParkFilter(this.value)">'
      +'<option value="all"'+(pf==='all'?' selected':'')+'>All products ('+list.length+')</option>'
      +order.map(function(p){ return '<option value="'+esc(p)+'"'+(pf===p?' selected':'')+'>'+esc(p)+' ('+byProd[p].length+')</option>'; }).join('')+'</select>';
    var d=new Date(), curYM=d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2);
    var shownOrder=(pf==='all')?order:order.filter(function(p){return p===pf;});
    var groups=shownOrder.map(function(p){
      var g=byProd[p].slice().sort(function(a,b){ var x=a.parkRevisit||'9999-99', y=b.parkRevisit||'9999-99'; return x<y?-1:(x>y?1:0); });
      var cards=g.map(function(l){
        var region=l.assignedRegion, dest=region?(esc(lmRegionName(region))+' inbox'):'Workspace';
        var ownerHist=l.assignedToName?'<span class="tag camp">last owner: '+esc(l.assignedToName)+'</span>':'';
        var otherProds=(l.parkProducts||[]).filter(function(x){return x!==p;}).map(function(x){return bdg('badge-park',x);}).join(' ');
        var revisit=l.parkRevisit?'<span class="pk-when'+(l.parkRevisit<=curYM?' due':'')+'">revisit '+esc(lmMonthLabel(l.parkRevisit))+(l.parkRevisit<=curYM?' · due':'')+'</span>':'';
        return '<div class="inb inb-lead pk-lead"><div class="inb-h"><span class="inb-t">'+esc(l.company)+'</span>'
          +(region?'<span class="rgtag">'+esc(lmRegionName(region))+'</span>':'<span class="rgtag">no region</span>')+otherProds+revisit
          +'<span style="margin-left:auto"><span class="inb-status pk">Parked</span></span></div>'
          +'<div class="inb-meta">'+(l.contact?'<span class="wname">'+esc(l.contact)+'</span><span class="dot">·</span>':'')
          +(l.campaign?'from: '+esc(l.campaign):'no campaign')
          +(l.parkReason?'<span class="dot">·</span><span style="font-style:italic">"'+esc(l.parkReason)+'"</span>':'')+'</div>'
          +'<div class="inb-f"><span class="inb-ref"><span class="lot">'+esc(l.ref)+'</span> '+ownerHist+'</span>'
          +'<span class="gset" style="margin-left:auto;margin-top:0"><button class="btn btn-secondary btn-sm" onclick="CRM.lmOpen(\''+l.id+'\')">Open</button>'
          +'<button class="btn btn-primary btn-sm" onclick="CRM.lmReactivate(\''+l.id+'\')">Reactivate → '+dest+'</button></span></div></div>';
      }).join('');
      return '<div class="inb-rghdr"><span class="rn">'+esc(p)+'</span><span class="line"></span><span class="cnt">'+g.length+' parked</span></div>'+cards;
    }).join('');
    var empty='<div class="empty-state">No parked leads yet. Use <b>Park for later</b> on a lead the customer wants revisited next season — it lands here, grouped by the product they\'ll buy.</div>';
    return '<div class="card"><div class="section-title"><span class="section-title-bar"></span> Parked backlog · '+list.length+' lead(s) · by target product'
      +' <span style="margin-left:auto;display:inline-flex;gap:6px;align-items:center">'+(list.length?filterSel:'')+'<button class="btn btn-secondary btn-sm" onclick="CRM.lmRefresh(this)">↻ Refresh</button></span></div>'
      +'<div class="alert-warn" style="margin-bottom:12px">Leads held for a future season. When a product\'s season opens, reactivate its group — each lead returns to its <strong>region inbox</strong> (or the Workspace if it had no region), never silently to a rep who may have left. Cards are sorted by <b>revisit month</b> — soonest first; <b>due</b> = this month or earlier.</div>'
      +(list.length?groups:empty)+'</div>';
  }
  function lmSetParkFilter(v){ LM.parkFilter=v; render(); }
  /* ── Cross-sell: leads interested in a crop their SOURCE CAMPAIGN wasn't selling ──
     wanted = product_interest ∪ park_products (minus 'Other'); a lead is cross-sell when it has a
     wanted crop NOT in its campaign's products[]. Read-only over crm_leads_list — no DB change. */
  function lmWantedProducts(l){ var s={}; (l.products||[]).forEach(function(p){ if(p&&p!=='—'&&p!=='Other') s[p]=1; }); (l.parkProducts||[]).forEach(function(p){ if(p&&p!=='Other') s[p]=1; }); return Object.keys(s); }
  function lmCrossSell(l){
    if(lmIsReturned(l)) return null;
    var camp=l.campaignProducts||[]; if(!camp.length) return null;           /* need a campaign crop to compare against */
    var wanted=lmWantedProducts(l); if(!wanted.length) return null;
    var extra=wanted.filter(function(p){ return camp.indexOf(p)<0; });        /* crops they want that the campaign wasn't selling */
    return extra.length?{extra:extra,wanted:wanted,camp:camp}:null;
  }
  function lmSetXs(k,v){ LM[k]=v; render(); }
  function lmToggleXsParked(){ LM.xsParked=!LM.xsParked; render(); }
  function paneCrossSell(){
    if(!LM.loaded){ lmEnsure(); return lmSkel(); }
    var base=lmScope(LM.rows).map(function(l){ var x=lmCrossSell(l); return x?{l:l,x:x}:null; }).filter(Boolean);
    if(!LM.xsParked) base=base.filter(function(o){ return !lmIsParked(o.l); });
    /* KPI + option universes (before the from/wants filters, so dropdowns stay stable) */
    var srcCount={}, wantCount={};
    base.forEach(function(o){ o.x.camp.forEach(function(p){ srcCount[p]=(srcCount[p]||0)+1; }); o.x.extra.forEach(function(p){ wantCount[p]=(wantCount[p]||0)+1; }); });
    var topWant=Object.keys(wantCount).sort(function(a,b){return wantCount[b]-wantCount[a];})[0];
    var topSrc=Object.keys(srcCount).sort(function(a,b){return srcCount[b]-srcCount[a];})[0];
    /* apply filters */
    var shown=base.filter(function(o){
      if(LM.xsFrom!=='all' && o.x.camp.indexOf(LM.xsFrom)<0) return false;
      if(LM.xsWants!=='all' && o.x.extra.indexOf(LM.xsWants)<0) return false;
      return true;
    });
    /* group by the wanted (extra) crop, honouring the wants filter */
    var byWant={}, order=[];
    shown.forEach(function(o){ o.x.extra.forEach(function(p){ if(LM.xsWants!=='all'&&p!==LM.xsWants) return; if(!byWant[p]){ byWant[p]=[]; order.push(p); } byWant[p].push(o); }); });
    order.sort(function(a,b){ return (byWant[b].length-byWant[a].length)||a.localeCompare(b); });
    var kpis=kcard('Cross-sell leads',String(base.length),'interest ≠ campaign crop')
      +kcard('Top opportunity',topWant||'—',topWant?wantCount[topWant]+' lead(s) want it':'nothing yet')
      +kcard('Biggest source',topSrc||'—',topSrc?srcCount[topSrc]+' cross lead(s)':'—');
    var opts=function(cur,map){ return '<option value="all">'+(cur==='from'?'Any — all campaigns':'Any other crop')+'</option>'+Object.keys(map).sort().map(function(p){ var sel=(cur==='from'?LM.xsFrom:LM.xsWants); return '<option value="'+esc(p)+'"'+(sel===p?' selected':'')+'>'+esc(p)+'</option>'; }).join(''); };
    var ctrl='<div style="display:flex;gap:7px;flex-wrap:wrap;align-items:center;margin-bottom:12px">'
      +'<span class="cell-sub">From campaign crop</span><select class="form-select" style="width:auto" onchange="CRM.lmSetXs(\'xsFrom\',this.value)">'+opts('from',srcCount)+'</select>'
      +'<span class="cell-sub" style="margin-left:4px">Wants</span><select class="form-select" style="width:auto" onchange="CRM.lmSetXs(\'xsWants\',this.value)">'+opts('wants',wantCount)+'</select>'
      +'<label style="margin-left:auto;font-size:12px;color:var(--text2);display:inline-flex;gap:6px;align-items:center;cursor:pointer"><input type="checkbox"'+(LM.xsParked?' checked':'')+' style="width:auto;accent-color:var(--accent)" onclick="CRM.lmToggleXsParked()"/> include parked</label></div>';
    var legend='<div class="xs-legend"><span><span class="badge badge-n">crop</span> campaign sold</span><span><span class="badge xs-want">crop</span> wants — new opportunity</span><span><span class="badge badge-pass">crop</span> also wants the campaign crop</span></div>';
    var groups=order.map(function(p){
      var g=byWant[p];
      var cards=g.map(function(o){
        var l=o.l, x=o.x;
        var srcTags=x.camp.map(function(c){ return bdg('badge-n',c); }).join(' ');
        var wantTags=x.wanted.map(function(w){ return (x.camp.indexOf(w)<0)?'<span class="badge xs-want">'+esc(w)+'</span>':bdg('badge-pass',w); }).join(' ');
        var parkTag=lmIsParked(l)?'<span class="badge badge-park">Parked'+(l.parkRevisit?' · '+esc(lmMonthLabel(l.parkRevisit)):'')+'</span>':'';
        var acts='<button class="btn btn-secondary btn-sm" onclick="CRM.lmOpen(\''+l.id+'\')">Open</button>';
        if(lmIsParked(l)) acts+='<button class="btn btn-primary btn-sm" onclick="CRM.lmReactivate(\''+l.id+'\')">Reactivate</button>';
        else if(lmIsQualified(l)) acts+='<button class="btn btn-primary btn-sm" onclick="CRM.lmAssignOpen(\''+l.id+'\')">Assign to region…</button>';
        return '<div class="inb inb-lead xs-lead"><div class="inb-h"><span class="inb-t">'+esc(l.company)+'</span>'+parkTag+'<span style="margin-left:auto">'+lmStageBadge(l)+'</span></div>'
          +'<div class="inb-meta xs-flow">from '+(l.campaign?'<span class="tag camp">'+esc(l.campaign)+'</span> ':'')+srcTags+' <span class="xs-arrow">→</span> wants '+wantTags+'</div>'
          +'<div class="inb-f"><span class="inb-ref"><span class="lot">'+esc(l.ref)+'</span> '+(l.contact?esc(l.contact)+' · ':'')+esc(l.country||'—')+'</span>'
          +'<span class="gset" style="margin-left:auto;margin-top:0">'+acts+'</span></div></div>';
      }).join('');
      return '<div class="inb-rghdr"><span class="rn">'+esc(p)+'</span><span class="line"></span><span class="cnt">'+g.length+' lead(s) · '+esc(p)+' season target list</span></div>'+cards;
    }).join('');
    var empty='<div class="empty-state">No cross-sell leads. These appear when a lead is interested in a crop that the campaign which captured them wasn\'t selling — e.g. a Grapes-campaign lead who wants Mango. Tag campaigns with their <b>Selling product(s)</b> so the match can be computed.</div>';
    return '<div class="card"><div class="section-title"><span class="section-title-bar"></span> Cross-sell · '+base.length+' lead(s) interested beyond their source campaign'
      +' <span style="margin-left:auto"><button class="btn btn-secondary btn-sm" onclick="CRM.lmRefresh(this)">↻ Refresh</button></span></div>'
      +(base.length?(kpiStrip3(kpis)+ctrl+legend+(shown.length?groups:'<div class="empty-state">No leads match these filters.</div>')):empty)+'</div>';
  }
  function kpiStrip3(cards){ return '<div class="kpi-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:12px">'+cards+'</div>'; }
  function fnRow(label,pct,val,pctTxt,fillColor){
    return '<div class="fn-row"><div class="fn-l">'+esc(label)+'</div><div class="fn-track"><div class="fn-fill" style="width:'+pct+'%'+(fillColor?';background:'+fillColor:'')+'">'+esc(val)+'</div></div><div class="fn-pct">'+esc(pctTxt)+'</div></div>';
  }

  /* ═══════════════════ SHOW MODE — real capture (offline-safe, writes crm_leads) ═══════════════════ */
  var CAP={campaigns:[],campaignId:null,items:[],loaded:false,syncing:false,online:(typeof navigator!=='undefined'?navigator.onLine:true),_timer:null,chips:{},exporters:{},importers:{},signals:{},scanned:{},bullets:false,moreOpen:false,followups:{},notesOverlay:false,cardData:null,groupData:null,cardDirty:false,groupDirty:false,editingId:null,campaignRows:[],hidden:{},_rosterSig:''};
  var CAP_PRODUCTS=['Potatoes','Citrus','Grapes','Onions','Spring Onions','Pomegranate','Field Crops','Mango','Carrots','Sweet Potato','Pumpkin','Peanuts','Other'];
  var CAP_EXP=['Grower','Trader','Association','Other'];
  var CAP_IMP=['Agent','Retailer','Wholesaler','Other'];
  var CAP_TAGS=['🔥 Hot lead','Price-sensitive','Big volume','Decision maker','Just browsing'];
  var CAP_FOLLOWUPS=[['send_samples','Send samples'],['send_offer','Send price offer'],['send_catalogue','Send catalogue'],['schedule_call','Schedule call'],['followup_show','Follow up after show'],['mailing_list','Add to mailing list'],['other','Other']];

  function capUuid(){ try{ return crypto.randomUUID(); }catch(e){ return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){var r=Math.random()*16|0;return (c==='x'?r:(r&0x3|0x8)).toString(16);}); } }
  function capDB(){ return new Promise(function(res,rej){ var r=indexedDB.open('dalos_capture',1); r.onupgradeneeded=function(e){ var db=e.target.result; if(!db.objectStoreNames.contains('queue')) db.createObjectStore('queue',{keyPath:'client_uuid'}); }; r.onsuccess=function(){res(r.result);}; r.onerror=function(){rej(r.error);}; }); }
  function capPut(rec){ return capDB().then(function(db){ return new Promise(function(res,rej){ var tx=db.transaction('queue','readwrite'); tx.objectStore('queue').put(rec); tx.oncomplete=function(){res();}; tx.onerror=function(){rej(tx.error);}; }); }); }
  function capLoadQueue(){ return capDB().then(function(db){ return new Promise(function(res,rej){ var out=[]; var tx=db.transaction('queue','readonly'); var c=tx.objectStore('queue').openCursor(); c.onsuccess=function(e){ var cur=e.target.result; if(cur){ out.push(cur.value); cur.continue(); } else res(out); }; c.onerror=function(){rej(c.error);}; }); }); }
  function capDelDB(uuid){ return capDB().then(function(db){ return new Promise(function(res,rej){ var tx=db.transaction('queue','readwrite'); tx.objectStore('queue').delete(uuid); tx.oncomplete=function(){res();}; tx.onerror=function(){rej(tx.error);}; }); }); }
  /* lightweight session-local duplicate check (offline-safe) — company match or same email domain */
  function capNorm(s){ return String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); }
  function capEmailDom(e){ e=String(e||'').toLowerCase(); var i=e.indexOf('@'); return i>=0?e.slice(i+1):''; }
  function capFindDup(company,email,exceptUuid){
    var nc=capNorm(company), dom=capEmailDom(email);
    var pools=[CAP.items||[], CAP.campaignRows||[]];   /* this device AND the whole team's campaign roster */
    for(var p=0;p<pools.length;p++){ var arr=pools[p];
      for(var i=0;i<arr.length;i++){ var r=arr[i]; if(r.client_uuid===exceptUuid) continue;
        if(nc && capNorm(r.company_name)===nc) return r;
        if(dom && capEmailDom(r.email)===dom) return r; } }
    return null;
  }

  function capPending(){ return CAP.items.filter(function(r){return !r._synced;}); }

  /* Pick the campaign to pre-select for the rep. Among the active campaigns, prefer the first
     real one — never a "Test Campaign" — so stand captures don't mis-attribute. */
  function capDefaultCampaign(list){
    if(!list||!list.length) return null;
    var today=new Date().toISOString().slice(0,10);
    var inRange=function(c){ return c.start_date && c.end_date && c.start_date<=today && today<=c.end_date; };
    /* the exhibition running RIGHT NOW (open the stand straight onto it) */
    var live=list.filter(function(c){ return c.type==='exhibition' && inRange(c); });
    if(live.length) return live.sort(function(a,b){ return (b.start_date||'').localeCompare(a.start_date||''); })[0].id;
    var liveAny=list.filter(inRange); if(liveAny.length) return liveAny[0].id;   /* any campaign live today */
    var real=list.filter(function(c){ return !/\btest\b/i.test(c.name||''); });
    return (real[0]||list[0]).id;
  }
  /* event-day indicator for the selected exhibition (Day N of M during the event) */
  function capEventDay(c){
    if(!c || c.type!=='exhibition' || !c.start_date || !c.end_date) return null;
    var d0=function(s){ var p=String(s).slice(0,10).split('-'); return new Date(+p[0], +p[1]-1, +p[2]); };
    var t=new Date(); t=new Date(t.getFullYear(),t.getMonth(),t.getDate());
    var s=d0(c.start_date), e=d0(c.end_date);
    var total=Math.round((e-s)/86400000)+1, n=Math.round((t-s)/86400000)+1;
    if(total<1) return null;
    if(n<1) return {state:'before', in:1-n, total:total};
    if(n>total) return {state:'after', total:total};
    return {state:'live', day:n, total:total};
  }
  function capBootstrap(){
    if(CAP.loaded){ capSync(); capSyncCards(); return; }
    CAP.loaded=true;
    /* Eager preload the self-hosted capture libs the moment Show Mode mounts — while the rep still
       likely has signal — instead of at first Scan/Photo tap. Warms the SW cache for offline use. */
    try{ capLoadScript('lib/jsQR.js').catch(function(){}); capLoadScript('lib/qrcode.min.js').catch(function(){}); capLoadScript('lib/tesseract.min.js').catch(function(){}); }catch(e){}
    capLoadQueue().then(function(items){ CAP.items=items.sort(function(a,b){return (b.captured_at||'').localeCompare(a.captured_at||'');}); capRenderList(); capRenderHead(); capSync(); capSyncCards(); }).catch(function(){});
    if(SB) SB.from('crm_campaigns').select('id,name,type,active,public_token,start_date,end_date').eq('active',true).order('created_at',{ascending:false}).then(function(res){ if(res&&!res.error){ CAP.campaigns=res.data||[]; if(!CAP.campaignId && CAP.campaigns.length) CAP.campaignId=capDefaultCampaign(CAP.campaigns); capRenderHead(); capLoadCampaign(); } }).catch(function(){});
    try{ window.addEventListener('online',function(){ CAP.online=true; capRenderHead(); capSync(); capSyncDirty(); capSyncCards(); capLoadCampaign(); }); window.addEventListener('offline',function(){ CAP.online=false; capRenderHead(); }); }catch(e){}
    if(!CAP._timer) CAP._timer=setInterval(function(){ if(CAP.online && capIsActive()){ if(capPending().length) capSync(); capSyncDirty(); capSyncCards(); capLoadCampaign(); } },20000);
    /* slide the sticky Save bar out of the way while a capture field is focused (keyboard up) so it never covers what you're typing */
    if(!CAP._kbBound){ CAP._kbBound=true;
      var isField=function(t){ return t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && t.closest && t.closest('.lead-portal'); };
      var setKb=function(on){ var a=document.querySelector('.crmv .cap-actions'); if(a) a.classList.toggle('kb',!!on); };
      document.addEventListener('focusin',function(e){ if(capIsActive() && isField(e.target)) setKb(true); });
      document.addEventListener('focusout',function(){ setTimeout(function(){ if(!isField(document.activeElement)) setKb(false); },150); });
    }
    /* warn before refresh / close / hard-navigation while a capture is half-filled (in-app nav is guarded in the host's goTab/goLead) */
    if(!CAP._beforeBound){ CAP._beforeBound=true;
      window.addEventListener('beforeunload',function(e){ if(capIsActive() && capDirty()){ e.preventDefault(); e.returnValue=''; return ''; } });
    }
  }
  /* the Show Mode pane is the active view — used to avoid polling/re-rendering the roster in the background */
  function capIsActive(){ return currentTab==='leads' && LSUB.leads==='cap'; }
  /* true when the capture form has unsaved user input (any field, chip, photo, or an in-progress edit) */
  function capDirty(){
    if(CAP.editingId || CAP.cardData || CAP.groupData) return true;
    var maps=[CAP.chips,CAP.exporters,CAP.importers,CAP.signals,CAP.followups], i, k;
    for(i=0;i<maps.length;i++){ for(k in maps[i]){ if(maps[i][k]) return true; } }
    var ids=['company','contact','role','email','phone','website','country','address','products_industries','trade_countries','annual_quantity','products_other','importer_other','exporter_other','followup_other','notes'];
    for(i=0;i<ids.length;i++){ var el=$('cap_'+ids[i]); if(el&&(el.value||'').trim()) return true; }
    return false;
  }
  /* Campaign-wide roster: everyone's captures for the selected campaign, via a SECURITY DEFINER
     RPC (a commercial rep can't SELECT their own region-less captures directly under RLS).
     Only re-renders when the row set actually changed, so a scrolled roster doesn't jump every poll. */
  function capLoadCampaign(){
    if(!SB || !CAP.campaignId || !CAP.online) return;
    SB.rpc('crm_show_mode_captures',{p_campaign:CAP.campaignId}).then(function(res){
      if(res && !res.error){
        CAP.campaignRows=res.data||[];
        var sig=CAP.campaignId+'|'+CAP.campaignRows.map(function(r){ return (r.client_uuid||'')+':'+(r.captured_at||''); }).join(',');
        if(sig!==CAP._rosterSig){ CAP._rosterSig=sig; capRenderList(); }
      }
    }, function(){}).catch(function(){});
  }
  /* Merge everyone's synced campaign rows with this device's local captures (dedupe by client_uuid,
     regardless of _synced — so a just-synced row stays visible until the roster supersedes it, and
     synced rows still show while offline). Session-hidden (deleted) uuids are filtered out. */
  function capMergedRows(){
    var seen={}, out=[], hid=CAP.hidden||{};
    (CAP.campaignRows||[]).forEach(function(r){ if(r.client_uuid){ if(hid[r.client_uuid]) return; seen[r.client_uuid]=1; } out.push(r); });
    (CAP.items||[]).forEach(function(r){ if(hid[r.client_uuid]) return; if(!seen[r.client_uuid]){ seen[r.client_uuid]=1; out.push(r); } });
    out.sort(function(a,b){ return (b.captured_at||'').localeCompare(a.captured_at||''); });
    return out;
  }

  function capDataUrlToBlob(durl){ var p=durl.split(','), mime=((p[0].match(/:(.*?);/)||[])[1])||'image/jpeg', bin=atob(p[1]), n=bin.length, u8=new Uint8Array(n); for(var i=0;i<n;i++) u8[i]=bin.charCodeAt(i); return new Blob([u8],{type:mime}); }
  function capUploadCard(r){
    return new Promise(function(resolve){
      try{
        if(!r._card_data || r.card_image_path){ resolve(); return; }
        var path=(r.campaign_id||'nocamp')+'/'+r.client_uuid+'.jpg';
        SB.storage.from('crm-lead-cards').upload(path, capDataUrlToBlob(r._card_data), {contentType:'image/jpeg',upsert:true}).then(function(res){
          if(res&&res.error){ resolve(); return; }   /* leave _card_data for next-sync retry */
          r.card_image_path=path; capPut(r); resolve();
        }, function(){ resolve(); });
      }catch(e){ resolve(); }
    });
  }
  function capUploadGroup(r){
    return new Promise(function(resolve){
      try{
        if(!r._group_data || r.group_image_path){ resolve(); return; }
        var path=(r.campaign_id||'nocamp')+'/'+r.client_uuid+'-group.jpg';
        SB.storage.from('crm-lead-cards').upload(path, capDataUrlToBlob(r._group_data), {contentType:'image/jpeg',upsert:true}).then(function(res){
          if(res&&res.error){ resolve(); return; }   /* leave _group_data for next-sync retry */
          r.group_image_path=path; capPut(r); resolve();
        }, function(){ resolve(); });
      }catch(e){ resolve(); }
    });
  }
  function capSync(){
    if(CAP.syncing||!CAP.online||!SB) return;
    var pending=capPending(); if(!pending.length) return;
    CAP.syncing=true; capRenderHead();
    /* upload any attached photos (card + group) first, then upsert the lead rows (with the storage paths) */
    Promise.all(pending.map(capUploadCard).concat(pending.map(capUploadGroup))).then(function(){
      var payload=pending.map(function(r){ var o={}; for(var k in r){ if(k.charAt(0)!=='_') o[k]=r[k]; } return o; });
      return SB.from('crm_leads').upsert(payload,{onConflict:'client_uuid',ignoreDuplicates:true});
    }).then(function(res){
      CAP.syncing=false;
      if(res&&res.error){ toast('Sync will retry — '+esc(res.error.message||'')); capRenderHead(); return; }
      pending.forEach(function(r){ r._synced=true; capPut(r); });
      capRenderHead(); capRenderList(); capLoadCampaign();   /* pull the freshly-synced rows into the campaign roster */
    }).catch(function(){ CAP.syncing=false; capRenderHead(); });
  }
  /* Push edits made to ALREADY-synced rows (capSync is insert-only). Uploads any newly-attached
     photo, then UPDATEs the cloud row; clears _dirty on success so it isn't retried. Offline → the
     _dirty flag persists in IndexedDB and this fires again on reconnect / the 20s poll. */
  function capSyncDirty(){
    if(!CAP.online || !SB) return;
    var dirty=CAP.items.filter(function(r){ return r._synced && r._dirty; });
    if(!dirty.length) return;
    dirty.forEach(function(r){
      Promise.all([capUploadCard(r),capUploadGroup(r)]).then(function(){
        var upd={ company_name:r.company_name, contact_name:r.contact_name, contact_role:r.contact_role,
          email:r.email, phone:r.phone, website:r.website, country:r.country, address:r.address,
          product_interest:r.product_interest, notes:r.notes, raw_payload:r.raw_payload||null,
          card_image_path:r.card_image_path||null, group_image_path:r.group_image_path||null };
        return SB.from('crm_leads').update(upd).eq('client_uuid',r.client_uuid).then(function(res){
          if(res && !res.error){ r._dirty=false; capPut(r); }
        });
      }).then(function(){ capRenderList(); capLoadCampaign(); }).catch(function(){});
    });
  }

  /* Recover a photo that was captured but never reached the bucket — e.g. an upload that failed
     before the marketing→bucket RLS was fixed, or a transient error. capSync handles only un-synced
     rows and capSyncDirty only _dirty rows, so a SYNCED row whose card upload failed is otherwise
     stranded forever with the photo only in this device's IndexedDB. This retries the upload and,
     on success, writes the storage path onto the cloud row. Runs on load / reconnect / the poll. */
  function capSyncCards(){
    if(!CAP.online || !SB) return;
    var stuck=CAP.items.filter(function(r){ return r._synced && ((r._card_data && !r.card_image_path) || (r._group_data && !r.group_image_path)); });
    if(!stuck.length) return;
    stuck.forEach(function(r){
      Promise.all([capUploadCard(r),capUploadGroup(r)]).then(function(){
        if(!r.card_image_path && !r.group_image_path) return;   /* still failed — leave for the next pass */
        return SB.from('crm_leads').update({ card_image_path:r.card_image_path||null, group_image_path:r.group_image_path||null }).eq('client_uuid',r.client_uuid).then(function(res){ if(res && !res.error){ capPut(r); } });
      }).then(function(){ capRenderList(); capLoadCampaign(); }).catch(function(){});
    });
  }

  /* ── QR/vCard scan + card OCR (both prefill the same manual form; rep confirms then Saves) ── */
  var capSource='manual', capLibs={}, capScanState={stream:null,raf:null,active:false};

  function capLoadScript(url){
    if(capLibs[url]) return capLibs[url];
    capLibs[url]=new Promise(function(res,rej){ var s=document.createElement('script'); s.src=url; s.onload=function(){res();}; s.onerror=function(){ capLibs[url]=null; rej(new Error('load failed')); }; document.head.appendChild(s); });
    return capLibs[url];
  }
  function capPrefill(f){
    [['company','company'],['name','contact'],['role','role'],['email','email'],['phone','phone'],['website','website'],['country','country'],['address','address']].forEach(function(p){
      if(f[p[0]]){ var el=$('cap_'+p[1]); if(el){ el.value=f[p[0]]; el.classList.add('scanned'); CAP.scanned[p[1]]=true; } }
    });
    if(typeof capUpdateProgress==='function') capUpdateProgress();   /* reflect the auto-filled fields in the stage rail */
  }

  function capParseVcard(t){
    var f={}, g=function(re){ var m=t.match(re); return m?m[1].trim():''; };
    if(/BEGIN:VCARD/i.test(t)){
      f.name=g(/(?:^|\n)FN[^:\n]*:(.+)/i);
      if(!f.name){ var n=g(/(?:^|\n)N[^:\n]*:(.+)/i); if(n) f.name=n.split(';').filter(Boolean).reverse().join(' ').trim(); }
      f.company=(g(/(?:^|\n)ORG[^:\n]*:(.+)/i)||'').split(';')[0];
      f.role=g(/(?:^|\n)TITLE[^:\n]*:(.+)/i);
      f.email=g(/(?:^|\n)EMAIL[^:\n]*:(.+)/i);
      f.phone=g(/(?:^|\n)TEL[^:\n]*:(.+)/i);
      f.website=g(/(?:^|\n)URL[^:\n]*:(.+)/i);
      var adr=g(/(?:^|\n)ADR[^:\n]*:(.+)/i);
      if(adr){ var ac=adr.split(';'); f.address=[ac[2],ac[3],ac[4],ac[5]].filter(function(x){return x&&x.trim();}).join(', ').trim(); f.country=(ac[6]||'').trim(); if(!f.address) f.address=adr.replace(/;+/g,', ').replace(/(^, |, $)/g,'').trim(); }
    } else if(/^MECARD:/i.test(t)){
      f.name=g(/N:([^;]+)/i); f.company=g(/ORG:([^;]+)/i); f.email=g(/EMAIL:([^;]+)/i); f.phone=g(/TEL:([^;]+)/i); f.website=g(/URL:([^;]+)/i); f.address=g(/ADR:([^;]+)/i);
    } else {
      f.email=(t.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)||[''])[0];
      if(/^https?:/i.test(t)) f._url=t;
    }
    return f;
  }

  var CAP_COHINT=/\b(gmbh|ltd|llc|bv|sarl|inc|co|company|trading|foods?|fresh|produce|import|export|fruit|obst|handel|primeurs|ortofrutta|dmcc|wll|spa|group|market)\b/i;
  var CAP_ROLEHINT=/\b(manager|director|head|procurement|buyer|purchas|owner|ceo|cfo|coo|gm|general manager|sales|commercial|category|founder|partner)\b/i;
  function capParseOcr(text){
    var f={};
    var lines=(text||'').split(/\n+/).map(function(l){return l.replace(/\s+/g,' ').trim();}).filter(function(l){return l.length>1;});
    var joined=lines.join('\n');
    f.email=((joined.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)||[''])[0]||'').toLowerCase();
    var ph=joined.match(/(\+?\d[\d\s().\-\/]{6,}\d)/); f.phone=ph?ph[1].replace(/\s+/g,' ').trim():'';
    var comp=null,i;
    for(i=0;i<lines.length;i++){ if(CAP_COHINT.test(lines[i])){ comp=lines[i]; break; } }
    if(!comp && f.email){ var dom=(f.email.split('@')[1]||'').split('.')[0]; if(dom) comp=dom.charAt(0).toUpperCase()+dom.slice(1); }
    f.company=comp||'';
    var role=null;
    for(i=0;i<lines.length;i++){ if(CAP_ROLEHINT.test(lines[i]) && lines[i].length<40){ role=lines[i]; break; } }
    f.role=role||'';
    var name='';
    for(i=0;i<lines.length;i++){ var l=lines[i];
      if(l===f.company||l===f.role) continue;
      if(/@|\d{3}/.test(l)) continue;
      if(CAP_COHINT.test(l)||CAP_ROLEHINT.test(l)) continue;
      var w=l.split(' '); if(w.length<1||w.length>4) continue;
      if(/^[A-Z]/.test(l)){ name=l; break; }
    }
    f.name=name;
    var wm=joined.match(/((?:https?:\/\/)?(?:www\.)?[\w-]+\.(?:com|net|org|de|fr|it|es|nl|be|co|eu|uk|ae|sa|eg)\b(?:\.[a-z]{2})?)/i);
    if(wm){ var site=wm[1].replace(/^https?:\/\//i,''); if(!/@/.test(site) && site!==(f.email.split('@')[1]||'')) f.website=site; }
    if(!f.website && f.email){ var edom=f.email.split('@')[1]||''; if(edom && !/(gmail|yahoo|hotmail|outlook|icloud|gmx|web\.de|live)/i.test(edom)) f.website='www.'+edom; }
    return f;
  }

  function capScan(){
    var ov=$('cap_scan'); if(ov) ov.style.display='flex';
    capScanState.active=true;
    capLoadScript('lib/jsQR.js').then(function(){
      if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia) throw new Error('no camera API');
      return navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}}});
    }).then(function(stream){
      capScanState.stream=stream; var v=$('cap_video'); if(!v){ capScanStop(); return; }
      v.srcObject=stream; v.setAttribute('playsinline',''); v.muted=true; v.play();
      var cv=document.createElement('canvas'), cx=cv.getContext('2d');
      function loop(){
        if(!capScanState.active) return;
        if(v.readyState===v.HAVE_ENOUGH_DATA && v.videoWidth){
          cv.width=v.videoWidth; cv.height=v.videoHeight; cx.drawImage(v,0,0,cv.width,cv.height);
          try{ var img=cx.getImageData(0,0,cv.width,cv.height); var code=window.jsQR?window.jsQR(img.data,img.width,img.height,{inversionAttempts:'dontInvert'}):null; if(code&&code.data){ capScanStop(); capHandleScan(code.data); return; } }catch(e){}
        }
        capScanState.raf=requestAnimationFrame(loop);
      }
      loop();
    }).catch(function(e){ capScanStop(); toast('Camera unavailable — '+esc((e&&e.message)||'permission denied')); });
  }
  function capScanStop(){ capScanState.active=false; if(capScanState.raf){ cancelAnimationFrame(capScanState.raf); capScanState.raf=null; } if(capScanState.stream){ capScanState.stream.getTracks().forEach(function(t){t.stop();}); capScanState.stream=null; } var ov=$('cap_scan'); if(ov) ov.style.display='none'; }
  function capHandleScan(data){
    var f=capParseVcard(data);
    if(!f.email && !f.name && !f.company && !f.phone){
      if(f._url){ capScanFromLink(data); return; }   /* QR is just a link → try to read the page for contact data */
      toast('That code has no contact details.'); return;
    }
    capSource='qr_vcard'; capPrefill(f); toast('Prefilled from the scanned card — review &amp; save.');
  }
  /* QR resolved to a URL — fetch the page server-side (SSRF-guarded edge fn) and extract contact fields.
     Falls back to the old behaviour (drop the link into notes) if the page yields nothing / offline.
     REVERT: replace the body with the old one-liner — `var n=$('cap_notes'); if(n) n.value=(n.value?n.value+' · ':'')+data; toast('Scanned a link — added to notes.');` */
  function capScanFromLink(url){
    var addToNotes=function(){ var n=$('cap_notes'); if(n){ n.value=(n.value?n.value+' · ':'')+url; capUpdateProgress&&capUpdateProgress(); } toast('Scanned a link — added to notes.'); };
    if(!CAP.online || !SB || !SB.functions || !SB.functions.invoke){ addToNotes(); return; }
    capBusy('Reading the linked page…');
    SB.functions.invoke('capture-link-extract',{body:{url:url}}).then(function(r){
      var d=r&&r.data;
      if(d&&d.ok&&d.fields&&(d.fields.email||d.fields.contact||d.fields.company||d.fields.phone)){
        capSource='qr_vcard';
        capPrefill({ company:d.fields.company, name:d.fields.contact, role:d.fields.role, email:d.fields.email, phone:d.fields.phone, website:d.fields.website, country:d.fields.country, address:d.fields.address });
        toast('Read from the linked page — check the fields, then Save.');
      } else { addToNotes(); }
      capBusyDone();
    }, function(){ addToNotes(); capBusyDone(); }).catch(function(){ addToNotes(); capBusyDone(); });
  }
  function capScanOverlay(){
    return '<div id="cap_scan" style="display:none;position:fixed;inset:0;z-index:80;background:rgba(0,0,0,.86);align-items:center;justify-content:center;flex-direction:column;gap:14px">'
      +'<video id="cap_video" playsinline style="max-width:92vw;max-height:66vh;border-radius:12px;background:#000"></video>'
      +'<div style="color:#fff;font-size:13px;opacity:.9">Point the camera at the QR / vCard code…</div>'
      +'<button class="btn btn-secondary" onclick="CRM.capScanCancel()">Cancel</button></div>';
  }

  function capAttachPhoto(file,done){
    /* resize + keep the card/badge photo on the lead for documentation (saved even if OCR fails).
       done(dataUrl) fires after the photo is stored, so OCR can reuse the same resized image. */
    var rd=new FileReader();
    rd.onload=function(ev){ var img=new Image();
      img.onload=function(){ var max=1400, w=img.width, h=img.height, sc=Math.min(1,max/Math.max(w,h)); w=Math.round(w*sc); h=Math.round(h*sc);
        var cv=document.createElement('canvas'); cv.width=w; cv.height=h; cv.getContext('2d').drawImage(img,0,0,w,h);
        try{ CAP.cardData=cv.toDataURL('image/jpeg',0.72); }catch(e){ CAP.cardData=ev.target.result; }
        CAP.cardDirty=true;
        capRenderPhotoChip();
        if(done) try{ done(CAP.cardData); }catch(e){}
      };
      img.onerror=function(){ if(done) try{ done(CAP.cardData||ev.target.result); }catch(e){} }; img.src=ev.target.result;
    };
    rd.readAsDataURL(file);
  }
  function capRenderPhotoChip(){ var el=$('cap_photo_chip'); if(!el) return;
    el.innerHTML=CAP.cardData
      ? '<div style="display:flex;align-items:center;gap:9px;margin-bottom:12px;padding:7px;background:var(--bg2);border:1px solid var(--border);border-radius:var(--r2)"><img src="'+CAP.cardData+'" style="height:46px;max-width:80px;border-radius:6px;border:1px solid var(--border);object-fit:cover"/><span class="cell-sub">Card / badge photo attached to this lead</span><span class="link-btn" style="margin-left:auto" onclick="CRM.capRemovePhoto()">Remove</span></div>'
      : '';
  }
  function capRemovePhoto(){ CAP.cardData=null; CAP.cardDirty=true; capRenderPhotoChip(); }
  function capAttachGroup(file){
    /* resize + keep the group photo (you + the lead at the stand) on the lead — documentation only, no OCR */
    var rd=new FileReader();
    rd.onload=function(ev){ var img=new Image();
      img.onload=function(){ var max=1400, w=img.width, h=img.height, sc=Math.min(1,max/Math.max(w,h)); w=Math.round(w*sc); h=Math.round(h*sc);
        var cv=document.createElement('canvas'); cv.width=w; cv.height=h; cv.getContext('2d').drawImage(img,0,0,w,h);
        try{ CAP.groupData=cv.toDataURL('image/jpeg',0.72); }catch(e){ CAP.groupData=ev.target.result; }
        CAP.groupDirty=true;
        capRenderGroupChip();
      };
      img.onerror=function(){}; img.src=ev.target.result;
    };
    rd.readAsDataURL(file);
  }
  function capRenderGroupChip(){ var el=$('cap_group_chip'); if(!el) return;
    el.innerHTML=CAP.groupData
      ? '<div style="display:flex;align-items:center;gap:9px;margin-bottom:12px;padding:7px;background:var(--bg2);border:1px solid var(--border);border-radius:var(--r2)"><img src="'+CAP.groupData+'" style="height:46px;max-width:80px;border-radius:6px;border:1px solid var(--border);object-fit:cover"/><span class="cell-sub">Group photo with the lead attached</span><span class="link-btn" style="margin-left:auto" onclick="CRM.capRemoveGroup()">Remove</span></div>'
      : '';
  }
  function capRemoveGroup(){ CAP.groupData=null; CAP.groupDirty=true; capRenderGroupChip(); }
  function capGroupPick(input){ var file=input&&input.files&&input.files[0]; if(!file){ return; } input.value=''; capAttachGroup(file); toast('Group photo attached to this lead.'); }
  function capOcrPick(input){
    var file=input&&input.files&&input.files[0]; if(!file){ return; }
    input.value='';
    capSource='ocr_card';
    capBusy('Reading the card…');   /* persistent processing indicator (slow wifi can take a few seconds) */
    /* save the photo, then read it: vision-LLM edge function first (best on designed cards),
       on-device Tesseract as the offline / not-configured fallback. */
    capAttachPhoto(file,function(durl){ capOcrRun(durl); });
  }
  /* returns the fields object if the cloud vision-LLM read the card, else null (so we fall back) */
  function capOcrCloud(durl){
    return new Promise(function(res){
      try{
        if(!durl || !CAP.online || !SB || !SB.functions || !SB.functions.invoke){ res(null); return; }
        SB.functions.invoke('capture-card-ocr',{body:{image:durl}}).then(function(r){
          var d=r&&r.data;
          if(d&&d.ok&&d.fields){ res({ company:d.fields.company, name:d.fields.contact, role:d.fields.role, email:d.fields.email, phone:d.fields.phone, website:d.fields.website, country:d.fields.country, address:d.fields.address }); }
          else res(null);   /* ocr_not_configured / empty / upstream error → Tesseract */
        }, function(){ res(null); });
      }catch(e){ res(null); }
    });
  }
  /* on-device fallback: preprocess (grayscale + contrast + upscale) → Tesseract → heuristic parse */
  function capOcrLocal(durl){
    return capLoadScript('lib/tesseract.min.js').then(function(){
      if(!window.Tesseract) throw new Error('no engine');
      return capOcrPreprocess(durl);
    }).then(function(img){
      return window.Tesseract.recognize(img,'eng');
    }).then(function(res){
      var f=capParseOcr((res&&res.data&&res.data.text)||'');
      if(!f.email && !f.company && !f.name){ toast('Photo saved. Couldn’t read the card — scan the QR or type the fields.'); return; }
      capPrefill(f); toast('Photo saved &amp; text read — check the fields, then Save.');
    }).catch(function(){ toast(CAP.online?'Photo saved. Card read unavailable — scan the QR or type the fields.':'Photo saved. <b>Card read needs a signal</b> — scan the QR or type the fields.'); });
  }
  function capOcrRun(durl){
    capOcrCloud(durl).then(function(f){
      if(f && (f.email||f.company||f.name)){ capPrefill(f); toast('Read from the card by AI — check the fields, then Save.'); capBusyDone(); return; }
      return capOcrLocal(durl).then(capBusyDone,capBusyDone);
    }).catch(function(){ capOcrLocal(durl).then(capBusyDone,capBusyDone); });
  }
  /* processing indicator — animated DalOS mark; shown during the async card/link read */
  var CAP_LOGO_SVG='<svg width="100%" height="100%" viewBox="4 4 56 50" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M11 44 L25 36 L37 40 L53 17" stroke="#c9b6ff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><g fill="#a98bff"><circle cx="11" cy="44" r="3"/><circle cx="25" cy="36" r="3"/><circle cx="37" cy="40" r="3"/></g><circle cx="53" cy="17" r="5.2" fill="#e2d7ff"/></svg>';
  function capBusy(msg){ var el=$('cap_ocr_busy'); if(!el) return; var t=el.querySelector('.cap-busy-txt'); if(t) t.textContent=msg||'Reading…'; el.style.display='flex'; }
  function capBusyDone(){ var el=$('cap_ocr_busy'); if(el) el.style.display='none'; }
  /* upscale small cards + grayscale + contrast stretch — big Tesseract accuracy win over the raw photo */
  function capOcrPreprocess(durl){
    return new Promise(function(resolve){
      try{
        var img=new Image();
        img.onload=function(){
          var scale=Math.min(2, Math.max(1, 1600/Math.max(img.width,img.height)));
          var w=Math.round(img.width*scale), h=Math.round(img.height*scale);
          var cv=document.createElement('canvas'); cv.width=w; cv.height=h;
          var ctx=cv.getContext('2d'); ctx.drawImage(img,0,0,w,h);
          try{
            var d=ctx.getImageData(0,0,w,h), a=d.data, i, g;
            for(i=0;i<a.length;i+=4){ g=(a[i]*0.299+a[i+1]*0.587+a[i+2]*0.114);
              g=(g-128)*1.35+140; if(g<0)g=0; else if(g>255)g=255;   /* contrast stretch + slight lift */
              a[i]=a[i+1]=a[i+2]=g; }
            ctx.putImageData(d,0,0);
          }catch(e){}
          resolve(cv);
        };
        img.onerror=function(){ resolve(durl); };
        img.src=durl;
      }catch(e){ resolve(durl); }
    });
  }
  function capField(id){ var el=$('cap_'+id); return el?(el.value||'').trim():''; }
  function capSave(){
    if(!CAP.campaignId){ toast('Pick a campaign first.'); return; }
    var company=capField('company');
    if(!company){ toast('Company is required.'); var c0=$('cap_company'); if(c0) c0.focus(); return; }
    var products=CAP_PRODUCTS.filter(function(p){ return CAP.chips[p]; });
    var extra={};
    var exps=CAP_EXP.filter(function(v){ return CAP.exporters[v]; });
    var imps=CAP_IMP.filter(function(v){ return CAP.importers[v]; });
    if(exps.length) extra.exporter_type=exps.join(', ');   /* multi-select → comma-joined (jsonb, back-compatible with the single-value readers) */
    if(imps.length) extra.importer_type=imps.join(', ');
    var eo=capField('exporter_other'); if(eo && CAP.exporters['Other']) extra.exporter_other=eo;
    var io=capField('importer_other'); if(io && CAP.importers['Other']) extra.importer_other=io;
    var sigs=CAP_TAGS.filter(function(t){ return CAP.signals[t]; });
    if(sigs.length) extra.tags=sigs;                        /* structured lead signal — queryable, not buried in notes */
    var po=capField('products_other'); if(po && CAP.chips['Other']) extra.products_other=po;
    var pi=capField('products_industries'); if(pi) extra.products_industries=pi;
    var tc=capField('trade_countries'); if(tc) extra.trade_countries=tc;
    var aq=capField('annual_quantity'); if(aq) extra.annual_quantity=aq;
    var fu=CAP_FOLLOWUPS.filter(function(o){ return CAP.followups[o[0]]; }).map(function(o){ return o[0]; });
    if(fu.length) extra.follow_ups=fu;
    var fo=capField('followup_other'); if(fo && CAP.followups['other']) extra.followup_other=fo;
    var rp=(Object.keys(extra).length?extra:null);
    var fields={ company_name:company, contact_name:capField('contact')||null, contact_role:capField('role')||null,
      email:capField('email')||null, phone:capField('phone')||null, website:capField('website')||null,
      country:capField('country')||null, address:capField('address')||null,
      product_interest:(products.length?products:null), notes:capField('notes')||null, raw_payload:rp };
    /* ── EDIT existing capture ── */
    if(CAP.editingId){
      var ex=null; for(var i=0;i<CAP.items.length;i++){ if(CAP.items[i].client_uuid===CAP.editingId){ ex=CAP.items[i]; break; } }
      if(ex){
        for(var k in fields){ ex[k]=fields[k]; }
        /* only touch photos if the rep actually changed them this edit; null the stored path so a
           new/replaced photo re-uploads, or clear it entirely if they removed the photo */
        if(CAP.cardDirty){ ex._card_data=CAP.cardData||null; ex.card_image_path=null; }
        if(CAP.groupDirty){ ex._group_data=CAP.groupData||null; ex.group_image_path=null; }
        var wasSynced=ex._synced;
        if(wasSynced) ex._dirty=true;   /* needs a cloud UPDATE (+ any new-photo upload) — capSyncDirty handles it, online now or later */
        capPut(ex).then(function(){
          CAP.editingId=null;
          toast('Updated <b>'+esc(company)+'</b>'+((wasSynced&&!CAP.online)?' — will sync when back online':''));
          capClear(); render();
          if(wasSynced) capSyncDirty();
        }).catch(function(){ toast('Could not update on the device.'); });
        return;
      }
      CAP.editingId=null;   /* record vanished — fall through to a fresh capture */
    }
    /* ── NEW capture ── */
    var dup=capFindDup(company, fields.email, null);
    var emailBad=fields.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fields.email);   /* non-blocking format hint only */
    var rec={ client_uuid:capUuid(), campaign_id:CAP.campaignId, source:(capSource||'manual'), status:'captured',
      captured_at:new Date().toISOString(), _synced:false };
    for(var k2 in fields){ rec[k2]=fields[k2]; }
    if(CAP.cardData) rec._card_data=CAP.cardData;   /* card/badge photo → uploaded to storage on sync */
    if(CAP.groupData) rec._group_data=CAP.groupData; /* group photo with the lead → uploaded to storage on sync */
    capPut(rec).then(function(){ CAP.items.unshift(rec);
      toast('Captured <b>'+esc(company)+'</b> — '+(CAP.online?'syncing…':'queued offline')+(dup?' · <b>possible duplicate</b> of '+esc(dup.company_name||'an earlier capture'):'')+(emailBad?' · check the email':''));
      capClear(); capSync(); capRenderList(); capRenderHead(); var c=$('cap_company'); if(c) c.focus(); }).catch(function(){ toast('Could not save capture on the device.'); });
  }
  function capEditLoad(uuid){
    var r=null; for(var i=0;i<CAP.items.length;i++){ if(CAP.items[i].client_uuid===uuid){ r=CAP.items[i]; break; } }
    if(!r) return; var rp=r.raw_payload||{};
    CAP.editingId=uuid; capSource=r.source||'manual';
    CAP.chips={}; (r.product_interest||[]).forEach(function(p){ CAP.chips[p]=true; });
    CAP.exporters={}; (rp.exporter_type?String(rp.exporter_type).split(/,\s*/):[]).forEach(function(v){ if(v) CAP.exporters[v]=true; });
    CAP.importers={}; (rp.importer_type?String(rp.importer_type).split(/,\s*/):[]).forEach(function(v){ if(v) CAP.importers[v]=true; });
    CAP.signals={}; (rp.tags||[]).forEach(function(t){ CAP.signals[t]=true; });
    CAP.followups={}; (rp.follow_ups||[]).forEach(function(k){ CAP.followups[k]=true; });
    CAP.scanned={}; CAP.cardData=r._card_data||null; CAP.groupData=r._group_data||null; CAP.cardDirty=false; CAP.groupDirty=false;
    closeDlv(); render();   /* rebuild the form with chips reflecting CAP state + button = "Update lead" */
    var set=function(id,v){ var el=$('cap_'+id); if(el) el.value=v||''; };
    set('company',r.company_name); set('contact',r.contact_name); set('role',r.contact_role);
    set('email',r.email); set('phone',r.phone); set('website',r.website); set('country',r.country); set('address',r.address);
    set('products_industries',rp.products_industries); set('trade_countries',rp.trade_countries); set('annual_quantity',rp.annual_quantity); set('notes',r.notes);
    if(rp.products_other && CAP.chips['Other']){ var o=$('cap_products_other'); if(o){ o.style.display='block'; o.value=rp.products_other; } }
    if(rp.importer_other && CAP.importers['Other']){ var io=$('cap_importer_other'); if(io){ io.style.display='block'; io.value=rp.importer_other; } }
    if(rp.exporter_other && CAP.exporters['Other']){ var eo=$('cap_exporter_other'); if(eo){ eo.style.display='block'; eo.value=rp.exporter_other; } }
    if(rp.followup_other && CAP.followups['other']){ var fuo=$('cap_followup_other'); if(fuo){ fuo.style.display='block'; fuo.value=rp.followup_other; } }
    capRenderPhotoChip(); capRenderGroupChip();
    var w=$('viewContent'); if(w&&w.scrollTo) w.scrollTo(0,0); if(window.scrollTo) window.scrollTo(0,0);
    capUpdateProgress();
    toast('Editing <b>'+esc(r.company_name||'lead')+'</b> — change fields, then <b>Update</b>.');
  }
  function capCancelEdit(){ CAP.editingId=null; capClear(); render(); }
  function capDelete(uuid){
    var r=null; for(var i=0;i<CAP.items.length;i++){ if(CAP.items[i].client_uuid===uuid){ r=CAP.items[i]; break; } }
    if(!r) return;
    if(typeof confirm==='function' && !confirm('Delete this capture'+(r.company_name?' ('+r.company_name+')':'')+' from this device?')) return;
    capDelDB(uuid).then(function(){
      CAP.items=CAP.items.filter(function(x){ return x.client_uuid!==uuid; });
      CAP.hidden[uuid]=true;   /* also drop it from the campaign roster for this session (a synced lead can't be hard-deleted, so it'd otherwise reappear) */
      if(CAP.editingId===uuid) CAP.editingId=null;
      closeDlv(); capRenderList(); capRenderHead();
      toast(r._synced ? 'Removed from this list. It already synced to the lead store — delete it from <b>Leads</b> if it was a mistake.' : 'Capture deleted.');
    }).catch(function(){ toast('Could not delete on the device.'); });
  }
  function capClear(){ capSource='manual'; CAP.editingId=null; CAP.chips={}; CAP.exporters={}; CAP.importers={}; CAP.signals={}; CAP.scanned={}; CAP.followups={}; CAP.cardData=null; CAP.groupData=null; CAP.cardDirty=false; CAP.groupDirty=false; capRenderGroupChip();
    ['company','contact','role','email','phone','website','country','address','products_industries','trade_countries','annual_quantity','products_other','importer_other','exporter_other','followup_other','notes','notes_big'].forEach(function(id){ var el=$('cap_'+id); if(el){ if(el.tagName==='SELECT') el.selectedIndex=0; else el.value=''; el.classList&&el.classList.remove('scanned'); } });
    var pane=$('viewContent'); if(pane){ var ch=pane.querySelectorAll('.capchip.on,.opt-tile.on'); for(var i=0;i<ch.length;i++) ch[i].classList.remove('on'); }
    ['cap_products_other','cap_importer_other','cap_exporter_other','cap_followup_other'].forEach(function(id){ var o=$(id); if(o) o.style.display='none'; }); capRenderPhotoChip(); capBusyDone(); capUpdateProgress(); }
  function capSetCampaign(id){
    if(id===CAP.campaignId){ return; }
    /* a half-typed capture would otherwise be stamped to the newly-selected campaign on Save */
    var dirty=CAP.editingId || (($('cap_company')||{}).value||'').trim();
    if(dirty && typeof confirm==='function' && !confirm('Switch campaign? Your unsaved capture will be cleared.')){ capRenderHead(); return; }
    if(dirty) capClear();
    CAP.campaignId=id; CAP.campaignRows=[]; CAP._rosterSig=''; capRenderHead(); capRenderList(); capLoadCampaign();
  }

  function capExport(){
    var data=capMergedRows();   /* export what's shown — the whole team's campaign roster, not just this device */
    if(!data.length){ toast('Nothing to export yet.'); return; }
    var cols=['captured_at','company_name','contact_name','contact_role','email','phone','country','product_interest','notes','captured_by_name','status'];
    var q=function(v){ if(v==null) v=''; if(Array.isArray(v)) v=v.join('; '); return '"'+String(v).replace(/"/g,'""')+'"'; };
    var lines=[cols.join(',')].concat(data.map(function(r){ return cols.map(function(c){return q(r[c]);}).join(','); }));
    var blob=new Blob([lines.join('\n')],{type:'text/csv'}), url=URL.createObjectURL(blob);
    var a=document.createElement('a'); a.href=url; a.download='captured-leads.csv'; document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(function(){URL.revokeObjectURL(url);},1000);
  }

  function capStatusPill(){
    var pend=capPending().length, synced=CAP.items.length-pend;
    if(!CAP.online) return '<span class="badge badge-warn">● Offline · '+pend+' queued</span>';
    if(CAP.syncing) return '<span class="badge badge-n">● Syncing…</span>';
    if(pend) return '<span class="badge badge-warn">● '+pend+' pending</span>';
    return '<span class="badge badge-pass">● Online · '+synced+' synced</span>';
  }
  /* Running "captured today / session" tally shown by the Save button — quick reassurance
     to the rep (and a little morale) that cards are landing. Session = captures held on this
     device; today = those with today's date. */
  function capCountToday(){ var d=new Date().toISOString().slice(0,10); return CAP.items.filter(function(r){ return (r.captured_at||'').slice(0,10)===d; }).length; }
  function capTallyHtml(){
    var today=capCountToday(), sess=CAP.items.length;
    return '<div class="cap-tally"><span class="cap-tally-n">'+today+'</span><span class="cap-tally-l">captured today'+(sess>today?' <span class="cell-sub">· '+sess+' on device</span>':'')+'</span></div>';
  }
  function capRenderTally(){ var el=$('cap_tally'); if(el) el.innerHTML=capTallyHtml(); }
  function capHeadHtml(){
    var opts=CAP.campaigns.length ? CAP.campaigns.map(function(c){ return '<option value="'+esc(c.id)+'"'+(c.id===CAP.campaignId?' selected':'')+'>'+esc(c.name)+'</option>'; }).join('') : '<option value="">No active campaign yet</option>';
    var sel=null; for(var i=0;i<CAP.campaigns.length;i++){ if(CAP.campaigns[i].id===CAP.campaignId){ sel=CAP.campaigns[i]; break; } }
    var ed=capEventDay(sel), dayBadge='';
    if(ed){
      if(ed.state==='live') dayBadge='<span class="cap-dayn live">● Day '+ed.day+' of '+ed.total+'</span>';
      else if(ed.state==='before') dayBadge='<span class="cap-dayn">Starts in '+ed.in+' day'+(ed.in===1?'':'s')+'</span>';
      else dayBadge='<span class="cap-dayn">Event ended</span>';
    }
    return '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px">'
      +'<span class="badge badge-n">Campaign</span>'
      +'<select class="form-select" style="width:auto;max-width:230px" onchange="CRM.capSetCampaign(this.value)">'+opts+'</select>'
      +dayBadge
      +'<button type="button" class="cap-home" onclick="CRM.capAddToHome()">📲 Add to Home</button>'
      +'<span style="margin-left:auto">'+capStatusPill()+'</span></div>';
  }
  function capListHtml(){
    var rows=capMergedRows(); var myId=USER&&USER.id;
    var camp=(function(){ for(var j=0;j<(CAP.campaigns||[]).length;j++){ if(CAP.campaigns[j].id===CAP.campaignId) return CAP.campaigns[j].name; } return ''; })();
    if(!rows.length) return '<div class="hint" style="margin-bottom:8px">Everyone’s captures for '+(camp?'<b>'+esc(camp)+'</b>':'this campaign')+' — the whole team’s, refreshing as they sync. Tap a row for details.</div><div class="empty-state">No captures yet. Fill the form and tap <b>Save &amp; capture next</b>.</div>';
    return '<div class="hint" style="margin-bottom:8px">Everyone’s captures for '+(camp?'<b>'+esc(camp)+'</b>':'this campaign')+' — <b>'+rows.length+'</b> so far, the whole team’s. Tap a row for details.</div>'
      +'<div class="table-wrap"><table><thead><tr><th>Time</th><th>Company</th><th>By</th><th>Contact</th><th class="right">Sync</th></tr></thead><tbody>'
      +rows.slice(0,500).map(function(r){
        var t=r.captured_at?r.captured_at.slice(11,16):'';
        var deviceLocal=!r.captured_by;   /* local IndexedDB rows carry no captured_by — they're this rep's own */
        var mine=(myId && r.captured_by===myId) || deviceLocal;
        var pending=deviceLocal && !r._synced;
        var sync=pending?'<span class="badge badge-warn" title="On this device — not uploaded yet">… On device</span>':'<span class="badge badge-pass" title="Saved to the shared lead store">✓ Synced</span>';
        var tags=(r.raw_payload&&r.raw_payload.tags)||[];
        var dot=tags.indexOf('🔥 Hot lead')>=0?'<span class="cap-dot hot" title="Hot lead"></span>':(tags.length?'<span class="cap-dot warm" title="'+esc(tags.join(', '))+'"></span>':'');
        var by=mine?'<span class="cap-you">You</span>':esc(r.captured_by_name||'—');
        return '<tr style="cursor:pointer" onclick="CRM.capOpenDetail(\''+esc(r.client_uuid)+'\')"><td class="mono">'+esc(t)+'</td><td>'+dot+esc(r.company_name||'—')+(r.email?'<div class="cell-sub">'+esc(r.email)+'</div>':'')+'</td><td class="cell-sub">'+by+'</td><td>'+esc(r.contact_name||'—')+(r.contact_role?'<div class="cell-sub">'+esc(r.contact_role)+'</div>':'')+'</td><td class="right">'+sync+'</td></tr>';
      }).join('')+'</tbody></table></div>';
  }
  function capOpenDetail(uuid){
    var r=null,i,own=false; for(i=0;i<CAP.items.length;i++){ if(CAP.items[i].client_uuid===uuid){ r=CAP.items[i]; own=true; break; } }
    if(!r){ for(i=0;i<(CAP.campaignRows||[]).length;i++){ if(CAP.campaignRows[i].client_uuid===uuid){ r=CAP.campaignRows[i]; break; } } }   /* a teammate's capture — read-only */
    if(!r) return;
    var rp=r.raw_payload||{};
    var row=function(k,v){ if(v==null||v===''||(Array.isArray(v)&&!v.length)) return ''; if(Array.isArray(v)) v=v.join(', ');
      return '<div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)"><div style="flex:0 0 132px;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--text3);font-weight:700;padding-top:1px">'+esc(k)+'</div><div style="flex:1;font-size:13px;color:var(--text);word-break:break-word;white-space:pre-wrap;line-height:1.45">'+esc(v)+'</div></div>'; };
    var fuMap={}; if(typeof CAP_FOLLOWUPS!=='undefined') CAP_FOLLOWUPS.forEach(function(o){ fuMap[o[0]]=o[1]; });
    var fu=(rp.follow_ups&&rp.follow_ups.length)?rp.follow_ups.map(function(x){ return fuMap[x]||x; }):[];
    var camp=(function(){ for(var j=0;j<(CAP.campaigns||[]).length;j++){ if(CAP.campaigns[j].id===r.campaign_id) return CAP.campaigns[j].name; } return ''; })();
    var srcLabel={manual:'Typed',qr_vcard:'QR / vCard',ocr_card:'Card photo (OCR)',public_form:'Public form',csv_import:'Import'}[r.source]||r.source||'';
    var hasPhoto=!!(r._card_data||r.card_image_path);
    var photoHtml=hasPhoto
      ? '<div style="margin:6px 0 8px"><div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--text3);font-weight:700;margin-bottom:5px">Card / badge photo</div>'
        +'<img id="capdet_img" alt="card / badge" src="'+(r._card_data||'')+'" style="width:100%;max-height:260px;object-fit:contain;border:1px solid var(--border);border-radius:8px;background:#fff;cursor:zoom-in'+(r._card_data?'':';display:none')+'" onclick="if(this.src)window.open(this.src,\'_blank\')"/>'
        +(( !r._card_data && r.card_image_path)?'<div class="cell-sub" id="capdet_imgnote" style="margin-top:4px">Loading photo…</div>':'')
        +'</div>'
      : '';
    var hasGroup=!!(r._group_data||r.group_image_path);
    var groupHtml=hasGroup
      ? '<div style="margin:6px 0 8px"><div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--text3);font-weight:700;margin-bottom:5px">Group photo with the lead</div>'
        +'<img id="capdet_gimg" alt="group photo" src="'+(r._group_data||'')+'" style="width:100%;max-height:260px;object-fit:contain;border:1px solid var(--border);border-radius:8px;background:#fff;cursor:zoom-in'+(r._group_data?'':';display:none')+'" onclick="if(this.src)window.open(this.src,\'_blank\')"/>'
        +(( !r._group_data && r.group_image_path)?'<div class="cell-sub" id="capdet_gimgnote" style="margin-top:4px">Loading photo…</div>':'')
        +'</div>'
      : '';
    var body='<div style="padding:2px">'
      +'<div style="display:flex;align-items:center;gap:9px;margin-bottom:8px"><div style="font-family:var(--font-display,var(--font-body));font-size:19px;color:var(--text)">'+esc(r.company_name||'—')+'</div>'
      +((own&&!r._synced)?'<span class="badge badge-warn">pending sync</span>':'<span class="badge badge-pass">synced</span>')+'</div>'
      +photoHtml
      +groupHtml
      +row('Captured', r.captured_at?r.captured_at.replace('T',' ').slice(0,16).replace(/-/g,'/'):'')
      +row('Captured by', r.captured_by_name)
      +row('Campaign', camp)
      +row('Source', srcLabel)
      +row('Contact', r.contact_name)
      +row('Role', r.contact_role)
      +row('Email', r.email)
      +row('Phone', r.phone)
      +row('Website', r.website)
      +row('Country', r.country)
      +row('Address', r.address)
      +row('Lead signal', rp.tags)
      +row('Products of interest', r.product_interest)
      +row('Other products', rp.products_other)
      +row('Products / industries', rp.products_industries)
      +row('Exporter type', rp.exporter_type)
      +row('Exporter · other', rp.exporter_other)
      +row('Importer type', rp.importer_type)
      +row('Importer · other', rp.importer_other)
      +row('Trade countries', rp.trade_countries)
      +row('Annual quantity', rp.annual_quantity)
      +row('Follow-up actions', fu)
      +row('Follow-up · other', rp.followup_other)
      +row('Notes', r.notes)
      +'<div class="l-formact" style="margin-top:14px">'+(own?'<button class="btn btn-secondary" onclick="CRM.capEditLoad(\''+esc(r.client_uuid)+'\')">Edit</button><button class="btn btn-secondary" style="color:var(--red)" onclick="CRM.capDelete(\''+esc(r.client_uuid)+'\')">Delete</button>':'')+'<button class="btn btn-secondary" onclick="CRM.closeDlv()">Close</button></div>'
      +'</div>';
    showDlv('Captured lead', body);
    /* synced-but-not-local (e.g. reopened later): fetch a signed URL for the stored photo */
    if(!r._card_data && r.card_image_path && SB){
      try{ SB.storage.from('crm-lead-cards').createSignedUrl(r.card_image_path,3600).then(function(res){
        var im=$('capdet_img'), nt=$('capdet_imgnote');
        if(res&&res.data&&res.data.signedUrl){ if(im){ im.src=res.data.signedUrl; im.style.display='block'; } if(nt) nt.parentNode&&nt.parentNode.removeChild(nt); }
        else if(nt){ nt.textContent='Photo unavailable.'; }
      },function(){ var nt=$('capdet_imgnote'); if(nt) nt.textContent='Photo unavailable.'; }); }catch(e){}
    }
    if(!r._group_data && r.group_image_path && SB){
      try{ SB.storage.from('crm-lead-cards').createSignedUrl(r.group_image_path,3600).then(function(res){
        var im=$('capdet_gimg'), nt=$('capdet_gimgnote');
        if(res&&res.data&&res.data.signedUrl){ if(im){ im.src=res.data.signedUrl; im.style.display='block'; } if(nt) nt.parentNode&&nt.parentNode.removeChild(nt); }
        else if(nt){ nt.textContent='Photo unavailable.'; }
      },function(){ var nt=$('capdet_gimgnote'); if(nt) nt.textContent='Photo unavailable.'; }); }catch(e){}
    }
  }
  function capRenderHead(){ var el=$('cap_head'); if(el) el.innerHTML=capHeadHtml(); capRenderTally(); }
  function capRenderList(){ var el=$('cap_list'); if(el) el.innerHTML=capListHtml(); capRenderTally(); }

  function capFld(id,label,ph,type,extra){ return '<div class="fg"><label class="form-label">'+esc(label)+'</label><input class="form-input" id="cap_'+id+'"'+(type?' type="'+type+'"':'')+(ph?' placeholder="'+esc(ph)+'"':'')+' autocomplete="off"'+(extra||'')+' oninput="CRM.capUnmark(this)"/></div>'; }
  /* conversation-stage header for the show-mode form */
  function capStage(n,lbl,cue){ return '<div class="capstage" data-stage="'+n+'"><span class="num">'+n+'</span><span class="swrap"><span class="lbl">'+lbl+'</span><span class="cue">'+cue+'</span></span><span class="bar"></span></div>'; }
  function capRailHtml(){ var s=''; for(var i=1;i<=6;i++) s+='<span class="cap-rail-seg" id="cap_rail_s'+i+'"></span>'; return '<div class="cap-rail" aria-hidden="true">'+s+'<span class="cap-rail-n"><b id="cap_rail_done">0</b>/6</span></div>'; }
  /* which of the 6 stages has at least one field filled (mirror of capSave's field groups) */
  function capStageFilled(){
    var v=function(id){ var e=$('cap_'+id); return !!(e&&(e.value||'').trim()); };
    var any=function(m){ for(var k in m){ if(m[k]) return true; } return false; };
    return [ v('company')||v('country')||v('contact')||v('role')||any(CAP.importers)||any(CAP.exporters),
             v('email')||v('phone')||v('website')||v('address'),
             v('products_industries')||v('trade_countries'),
             any(CAP.chips)||v('annual_quantity'),
             any(CAP.signals)||v('notes'),
             any(CAP.followups) ];
  }
  function capUpdateProgress(){
    var f=capStageFilled(), n=0;
    for(var i=0;i<6;i++){ if(f[i]) n++;
      var seg=$('cap_rail_s'+(i+1)); if(seg) seg.classList.toggle('done',!!f[i]);
      var st=document.querySelector('.capstage[data-stage="'+(i+1)+'"]'); if(st){ st.classList.toggle('done',!!f[i]); var num=st.querySelector('.num'); if(num) num.textContent=f[i]?'✓':String(i+1); }
    }
    var c=$('cap_rail_done'); if(c) c.textContent=n;
  }
  /* consistent 16px currentColor icons for the capture tools (replaces the mixed no-icon/emoji set) */
  function capIcon(name){
    var p={ qr:'<path d="M2 2h4.5v4.5H2zM3.3 3.3v1.9h1.9V3.3zM9.5 2H14v4.5H9.5zM10.8 3.3v1.9h1.9V3.3zM2 9.5h4.5V14H2zM3.3 10.8v1.9h1.9v-1.9zM9.5 9.5H11V11H9.5zM12.5 9.5H14V11h-1.5zM9.5 12.5H11V14H9.5zM12.5 12.5H14V14h-1.5z"/>',
      card:'<rect x="1.6" y="3.6" width="12.8" height="8.8" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><line x1="4" y1="6.6" x2="8" y2="6.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="4" y1="9.2" x2="10" y2="9.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
      group:'<circle cx="5.4" cy="5" r="2.2"/><circle cx="11" cy="5.6" r="1.8"/><path d="M1.4 13.2c0-2.3 1.9-3.7 4-3.7s4 1.4 4 3.7z"/><path d="M10.2 9.7c1.9 0 4.4 1 4.4 3.5h-3.2c0-1.4-.5-2.6-1.2-3.5z"/>' }[name]||'';
    return '<svg class="capbtn-ic" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">'+p+'</svg>';
  }
  /* ── Show-mode chips / type / notes helpers ── */
  function capProdChipsHtml(){ return CAP_PRODUCTS.map(function(p){ return '<button type="button" class="opt-tile'+(CAP.chips[p]?' on':'')+'" data-prod="'+esc(p)+'" onclick="CRM.capToggleProd(this)"><span class="tk">✓</span>'+esc(p)+'</button>'; }).join(''); }
  function capToggleProd(btn){ var p=btn.getAttribute('data-prod'); CAP.chips[p]=!CAP.chips[p]; btn.classList.toggle('on',!!CAP.chips[p]); if(p==='Other'){ var o=$('cap_products_other'); if(o){ o.style.display=CAP.chips[p]?'block':'none'; if(CAP.chips[p]) o.focus(); else o.value=''; } } capUpdateProgress(); }
  function capTypeChipsHtml(kind){ var arr=kind==='exp'?CAP_EXP:CAP_IMP, map=kind==='exp'?CAP.exporters:CAP.importers; return arr.map(function(v){ return '<button type="button" class="opt-tile'+(map[v]?' on':'')+'" data-k="'+kind+'" data-v="'+esc(v)+'" onclick="CRM.capType(this)"><span class="tk">✓</span>'+esc(v)+'</button>'; }).join(''); }
  /* multi-select: a company can be more than one type (retailer AND wholesaler) */
  function capType(btn){ var k=btn.getAttribute('data-k'), v=btn.getAttribute('data-v'); var map=k==='exp'?CAP.exporters:CAP.importers; map[v]=!map[v]; btn.classList.toggle('on',!!map[v]);
    if(v==='Other'){ var o=$(k==='exp'?'cap_exporter_other':'cap_importer_other'); if(o){ o.style.display=map[v]?'block':'none'; if(map[v]) o.focus(); else o.value=''; } }
    capUpdateProgress(); }
  function capSignalHtml(){ return CAP_TAGS.map(function(t){ return '<button type="button" class="opt-tile'+(CAP.signals[t]?' on':'')+'" data-sig="'+esc(t)+'" onclick="CRM.capSignal(this)"><span class="tk">✓</span>'+esc(t)+'</button>'; }).join(''); }
  function capSignal(btn){ var t=btn.getAttribute('data-sig'); CAP.signals[t]=!CAP.signals[t]; btn.classList.toggle('on',!!CAP.signals[t]); capUpdateProgress(); }
  /* verify-me: fields filled by scan/OCR get an accent bar until the rep edits them */
  function capMarkScanned(id){ CAP.scanned[id]=true; var el=$('cap_'+id); if(el) el.classList.add('scanned'); }
  function capUnmark(el){ if(el&&el.classList) el.classList.remove('scanned'); capUpdateProgress(); }
  function capTagsHtml(){ return CAP_TAGS.map(function(t){ return '<button type="button" class="captag" data-tag="'+esc(t)+'" onclick="CRM.capQuickTag(this)">'+esc(t)+'</button>'; }).join(''); }
  function capFollowupsHtml(){ return CAP_FOLLOWUPS.map(function(o){ return '<button type="button" class="opt-tile'+(CAP.followups[o[0]]?' on':'')+'" data-fu="'+o[0]+'" onclick="CRM.capToggleFollowup(this)"><span class="tk">✓</span>'+esc(o[1])+'</button>'; }).join(''); }
  function capToggleFollowup(btn){ var k=btn.getAttribute('data-fu'); CAP.followups[k]=!CAP.followups[k]; btn.classList.toggle('on',!!CAP.followups[k]);
    if(k==='other'){ var o=$('cap_followup_other'); if(o){ o.style.display=CAP.followups[k]?'block':'none'; if(CAP.followups[k]) o.focus(); else o.value=''; } }
    capUpdateProgress(); }
  /* notes: an inline field + a full-screen pad share one value (mirrored both ways) */
  function capActiveNotes(){ return $(CAP.notesOverlay?'cap_notes_big':'cap_notes'); }
  function capNotesMirror(from){ var a=$('cap_notes'),b=$('cap_notes_big'); if(a&&b){ if(from==='big') a.value=b.value; else b.value=a.value; } capUpdateProgress(); }
  function capActiveMirror(){ capNotesMirror(CAP.notesOverlay?'big':'inline'); }
  function capQuickTag(btn){ var t=btn.getAttribute('data-tag'); var ta=capActiveNotes(); if(!ta) return; var v=ta.value.replace(/\s+$/,''); ta.value=(v?v+'\n':'')+'• '+t+'\n'; ta.focus(); ta.selectionStart=ta.selectionEnd=ta.value.length; capActiveMirror(); }
  function capBulletsToggle(){ CAP.bullets=!CAP.bullets; ['cap_bt','cap_bt_big'].forEach(function(id){ var el=$(id); if(el){ if(CAP.bullets) el.setAttribute('data-on','1'); else el.removeAttribute('data-on'); el.classList.toggle('on',CAP.bullets); } }); var ta=capActiveNotes(); if(ta){ if(CAP.bullets && !ta.value.trim()){ ta.value='• '; capActiveMirror(); } ta.focus(); ta.selectionStart=ta.selectionEnd=ta.value.length; } }
  function capNotesKey(e){ if(CAP.bullets && e.key==='Enter' && !e.shiftKey){ e.preventDefault(); var ta=e.target, p=ta.selectionStart, val=ta.value; ta.value=val.slice(0,p)+'\n• '+val.slice(p); var np=p+3; ta.selectionStart=ta.selectionEnd=np; capActiveMirror(); } }
  function capNotesExpand(){ var a=$('cap_notes'),b=$('cap_notes_big'); if(a&&b) b.value=a.value; CAP.notesOverlay=true; var ov=$('capNotesOv'); if(ov) ov.classList.add('open'); if(b){ b.focus(); b.selectionStart=b.selectionEnd=b.value.length; } }
  function capNotesClose(){ var a=$('cap_notes'),b=$('cap_notes_big'); if(a&&b) a.value=b.value; CAP.notesOverlay=false; var ov=$('capNotesOv'); if(ov) ov.classList.remove('open'); }
  function capNotesOverlay(){
    return '<div class="cap-notes-ov" id="capNotesOv"><div class="cap-notes-ovcard">'
      +'<div class="cap-notes-ovhead"><span class="cap-notes-ovt">Notes from the stand</span>'
      +'<button type="button" class="cap-bt" id="cap_bt_big"'+(CAP.bullets?' data-on="1"':'')+' onclick="CRM.capBulletsToggle()">• Bullets</button>'
      +'<button type="button" class="btn btn-primary btn-sm" style="margin-left:auto" onclick="CRM.capNotesClose()">Done</button></div>'
      +'<textarea class="form-input cap-notes-bigta" id="cap_notes_big" placeholder="Write freely while you talk — or use the keyboard mic to dictate…" oninput="CRM.capNotesMirror(\'big\')" onkeydown="CRM.capNotesKey(event)"></textarea>'
      +'<div class="hint" style="margin-top:6px">Tap <b>Done</b> to return to the form. Your notes are saved with the lead.</div>'
      +'</div></div>';
  }
  function capMore(){ CAP.moreOpen=!CAP.moreOpen; var s=$('cap_more'); if(s) s.style.display=CAP.moreOpen?'block':'none'; var b=$('cap_morebtn'); if(b) b.innerHTML=(CAP.moreOpen?'▴ Fewer details':'▾ More details')+' <span class="cell-sub" style="text-transform:none;letter-spacing:0">type · industries · trade countries · quantity · address</span>'; }
  function capMoreOpen(){ if(!CAP.moreOpen) capMore(); }
  /* Chromium (Android/desktop) fires beforeinstallprompt when the PWA is installable — stash it so
     the button can trigger the REAL native install. iOS Safari exposes no such API (manual only). */
  var CAP_BIP=null;
  try{ window.addEventListener('beforeinstallprompt',function(e){ e.preventDefault(); CAP_BIP=e; }); window.addEventListener('appinstalled',function(){ CAP_BIP=null; }); }catch(e){}
  function capDoInstall(){ if(!CAP_BIP){ toast('Use your browser menu → Install / Add to Home screen.'); return; }
    try{ CAP_BIP.prompt(); CAP_BIP.userChoice.then(function(r){ if(r&&r.outcome==='accepted') toast('Adding to home screen…'); CAP_BIP=null; closeDlv(); }); }catch(e){ toast('Use your browser menu → Install app.'); } }
  function capCaptureUrl(){
    var tok=''; for(var i=0;i<(CAP.campaigns||[]).length;i++){ if(CAP.campaigns[i].id===CAP.campaignId){ tok=CAP.campaigns[i].public_token||''; break; } }
    var base=location.href.split('#')[0].split('?')[0];
    return base+'#capture'+(tok?'='+encodeURIComponent(tok):'');
  }
  function capCopyHomeUrl(){ var el=$('cap_home_url'); if(!el) return; try{ navigator.clipboard.writeText(el.value).then(function(){ toast('Link copied.'); }); }catch(e){ try{el.select();document.execCommand('copy');}catch(e2){} toast('Copied.'); } }
  function capAddToHome(){
    var url=capCaptureUrl();
    var ua=(navigator.userAgent||'');
    var standalone=(typeof navigator!=='undefined'&&navigator.standalone===true)||(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches);
    var isIOS=/iphone|ipad|ipod/i.test(ua)||(/Macintosh/.test(ua)&&(navigator.maxTouchPoints||0)>1);
    var campName=''; for(var i=0;i<(CAP.campaigns||[]).length;i++){ if(CAP.campaigns[i].id===CAP.campaignId){ campName=CAP.campaigns[i].name; break; } }
    var head='<div class="l-formnote">Put a one-tap <b>Capture</b> icon on the home screen'+(campName?' for <b>'+esc(campName)+'</b>':'')+' — it opens straight into this stand form.</div>';
    var mid;
    if(standalone){
      mid='<div class="alert-ok" style="margin-bottom:6px">✓ You’re already running the installed app.</div>';
    } else if(CAP_BIP){
      /* Android / desktop Chromium — trigger the real native install */
      mid='<button class="btn btn-primary" style="width:100%;justify-content:center;margin-bottom:6px" onclick="CRM.capDoInstall()">📲 Add to Home Screen now</button>'
        +'<div class="hint">Taps the phone’s own install dialog. If nothing pops up, use the browser menu → <b>Install app</b>.</div>';
    } else if(isIOS){
      /* iOS Safari exposes no install API — Apple requires the manual Share flow */
      mid='<div class="hint" style="margin-bottom:6px">iPhone/iPad can’t auto-add — Apple only allows it from the Share menu:</div>'
        +'<ol style="margin:0 0 4px 18px;font-size:13px;line-height:1.75;color:var(--text2)">'
        +'<li>Open this page in <b>Safari</b> (not Chrome).</li>'
        +'<li>Tap <b>Share</b> (<span class="mono">□↑</span>) at the bottom.</li>'
        +'<li>Choose <b>Add to Home Screen</b> → <b>Add</b>.</li>'
        +'</ol>';
    } else {
      mid='<div class="hint">Open your browser menu and choose <b>Install app</b> / <b>Add to Home screen</b>.</div>';
    }
    var body='<div class="l-form">'+head+mid
      +'<label class="form-label" style="margin-top:10px">This event’s capture link</label>'
      +'<div style="display:flex;gap:6px"><input class="form-input mono" id="cap_home_url" readonly value="'+esc(url)+'" style="flex:1;font-size:12px"/><button class="btn btn-secondary btn-sm" onclick="CRM.capCopyHomeUrl()">Copy</button></div>'
      +'<div class="hint" style="margin-top:8px">Share this link (AirDrop / WhatsApp) so each rep adds their own icon.</div>'
      +'<div class="l-formact"><button class="btn btn-primary" onclick="CRM.closeDlv()">Done</button></div></div>';
    showDlv('Add to Home Screen',body);
  }
  function paneCapture(){
    capBootstrap();
    var form='<div class="card">'
      +'<div class="cap-head-row"><div class="cap-mast"><div class="cap-title">Show Mode</div><div class="cap-titlesub">stand capture</div></div><span id="cap_tally" class="cap-hstat">'+capTallyHtml()+'</span></div>'
      +capRailHtml()
      +'<div id="cap_head">'+capHeadHtml()+'</div>'
      /* capture tools — snap identity before a word is said */
      +'<div class="capgrid" style="margin-bottom:8px">'
        +'<button type="button" class="capbtn" onclick="CRM.capScan()"><span class="capt">'+capIcon('qr')+'Scan QR / vCard</span><span class="caps">Digital card → fields</span></button>'
        +'<label class="capbtn" style="cursor:pointer"><span class="capt">'+capIcon('card')+'Photo of card / badge</span><span class="caps">Saved · auto-reads text</span><input type="file" accept="image/*" capture="environment" style="position:absolute;width:1px;height:1px;opacity:0" onchange="CRM.capOcrPick(this)"/></label>'
      +'</div>'
      +'<div id="cap_photo_chip"></div>'
      +'<label class="capbtn cap-group" style="cursor:pointer;width:100%;margin-bottom:4px"><span class="capt">'+capIcon('group')+'Group photo with the lead</span><span class="caps">documentation — you &amp; the lead</span><input type="file" accept="image/*" capture="environment" style="position:absolute;width:1px;height:1px;opacity:0" onchange="CRM.capGroupPick(this)"/></label>'
      +'<div id="cap_group_chip"></div>'
      +'<div id="cap_ocr_busy" class="cap-busy" style="display:none"><span class="cap-busy-mark">'+CAP_LOGO_SVG+'</span><span class="cap-busy-txt">Reading the card…</span></div>'
      /* ① who you're meeting */
      +capStage('1','Who you’re meeting','the handshake — name, company, where they’re from')
      +'<div class="grid2">'
        +'<div class="fg"><label class="form-label">Company <span class="req">*</span></label><input class="form-input" id="cap_company" autocomplete="off" autocapitalize="words" enterkeyhint="next" placeholder="e.g. Nordfrucht GmbH" oninput="CRM.capUnmark(this)"/></div>'
        +'<div class="fg"><label class="form-label">Country</label><input class="form-input" id="cap_country" list="cap_countries" autocomplete="off" autocapitalize="words" oninput="CRM.capUnmark(this)"/></div>'
      +'</div>'
      +'<div class="grid2">'+capFld('contact','Contact name','','text',' autocapitalize="words" enterkeyhint="next"')+capFld('role','Role','Head of Procurement','text',' autocapitalize="words" enterkeyhint="next"')+'</div>'
      +'<div class="fg"><label class="form-label">Importer type <span class="lmuted">· all that apply</span></label><div class="opt-tiles" id="cap_imp">'+capTypeChipsHtml('imp')+'</div>'
        +'<input class="form-input" id="cap_importer_other" autocomplete="off" placeholder="Other — which importer type?" style="display:none;margin-top:8px" oninput="CRM.capUnmark(this)"/></div>'
      +'<div class="fg"><label class="form-label">Exporter type <span class="lmuted">· all that apply</span></label><div class="opt-tiles" id="cap_exp">'+capTypeChipsHtml('exp')+'</div>'
        +'<input class="form-input" id="cap_exporter_other" autocomplete="off" placeholder="Other — which exporter type?" style="display:none;margin-top:8px" oninput="CRM.capUnmark(this)"/></div>'
      /* ② how to reach them */
      +capStage('2','How to reach them','lock the contact in while they’re in front of you')
      +'<div class="grid2">'+capFld('email','Email','name@company.com','email',' inputmode="email" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="next"')+capFld('phone','Phone','','tel',' inputmode="tel" enterkeyhint="next"')+'</div>'
      +'<div class="grid2">'+capFld('website','Website','www.company.com','text',' inputmode="url" autocapitalize="none" autocorrect="off" spellcheck="false"')
        +'<div class="fg"><label class="form-label">Address</label><input class="form-input" id="cap_address" autocomplete="off" autocapitalize="words" placeholder="street, city, country" oninput="CRM.capUnmark(this)"/></div></div>'
      /* ③ their business */
      +capStage('3','Their business','context — what they trade &amp; where')
      +'<div class="fg"><label class="form-label">Products / industries they deal in</label><input class="form-input" id="cap_products_industries" autocomplete="off" placeholder="what they trade" oninput="CRM.capUnmark(this)"/></div>'
      +'<div class="fg"><label class="form-label">Countries of export / import</label><input class="form-input" id="cap_trade_countries" autocomplete="off" placeholder="e.g. UK, Germany, UAE" oninput="CRM.capUnmark(this)"/></div>'
      /* ④ what they're after */
      +capStage('4','What they’re after','the hook — what they want from Daltex')
      +'<div class="fg"><label class="form-label">Products of interest</label><div class="opt-tiles" id="cap_prodchips">'+capProdChipsHtml()+'</div>'
        +'<input class="form-input" id="cap_products_other" autocomplete="off" placeholder="Other — which products?" style="display:none;margin-top:6px"/></div>'
      +capFld('annual_quantity','Annual quantity','e.g. 300 cont. / season')
      /* ⑤ notes */
      +capStage('5','Notes from the stand','most valuable, shortest-lived — jot it now')
      +'<div class="fg"><label class="form-label">Lead signal <span class="lmuted">· saved as a tag</span></label><div class="opt-tiles" id="cap_signals">'+capSignalHtml()+'</div></div>'
      +'<div class="fg"><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><label class="form-label" style="margin:0">Notes</label>'
        +'<button type="button" class="cap-bt" id="cap_bt"'+(CAP.bullets?' data-on="1"':'')+' onclick="CRM.capBulletsToggle()">• Bullets</button>'
        +'<button type="button" class="cap-bt" style="margin-left:auto" onclick="CRM.capNotesExpand()">⤢ Expand</button></div>'
        +'<textarea class="form-input" id="cap_notes" rows="4" placeholder="buys 40 cont. from Peru, wants wk 8–14…" oninput="CRM.capNotesMirror(\'inline\')" onkeydown="CRM.capNotesKey(event)"></textarea>'
        +'<div class="hint" style="margin-top:4px">Tip: tap <b>⤢ Expand</b> for a full-screen pad, or use your keyboard mic to dictate.</div></div>'
      /* ⑥ follow-up */
      +capStage('6','Follow-up actions','what we owe this lead')
      +'<div class="fg"><div class="opt-tiles" id="cap_followups">'+capFollowupsHtml()+'</div>'
        +'<input class="form-input" id="cap_followup_other" autocomplete="off" placeholder="Other follow-up — what do we owe them?" style="display:none;margin-top:8px" oninput="CRM.capUnmark(this)"/></div>'
      +'<div class="gset cap-actions" style="align-items:center"><button class="btn btn-primary" id="cap_savebtn" style="flex:1" onclick="CRM.capSave()">'+(CAP.editingId?'Update lead':'Save &amp; capture next')+'</button><button class="btn btn-secondary" onclick="'+(CAP.editingId?'CRM.capCancelEdit()':'CRM.capClear()')+'">'+(CAP.editingId?'Cancel edit':'Clear')+'</button></div>'
      +'</div>';
    var list='<div class="card">'
      +'<div class="section-title"><span class="section-title-bar"></span> Campaign captures <span class="link-btn" style="margin-left:auto" onclick="CRM.capExport()">Export CSV ↓</span></div>'
      +'<div id="cap_list">'+capListHtml()+'</div></div>';
    var datalist='<datalist id="cap_countries">'+['United Kingdom','Germany','Netherlands','France','Belgium','Spain','Italy','Poland','UAE','Saudi Arabia','Qatar','Kuwait','Russia','Turkey','China','India'].map(function(c){return '<option value="'+esc(c)+'"></option>';}).join('')+'</datalist>';
    return '<div class="grid2" style="align-items:start">'+form+list+'</div>'+datalist+capScanOverlay()+capNotesOverlay();
  }

  /* ═══════════════════ INBOX destination ═══════════════════ */
  function renderInbox(){
    var vc=$('viewContent'); if(!vc) return;
    /* Both real now: Lead inbox = region-assigned & unclaimed; My pipeline = flagged (claimed) to me. */
    var inbN=LM.loaded?inboxList().length:'';
    var pipLabel=lmIsPipelineManager()?'Team pipeline':'My pipeline';
    var pipN=LM.loaded?pipelineList().length:'';
    var bar=lsegBar('inbox',[['inbox','Inbox',inbN,'badge-fail'],['pip',pipLabel,pipN,'badge-n']]);
    vc.innerHTML='<div class="lead-portal">'+bar+(LSUB.inbox==='pip'?panePipeline():paneInbox())+'</div>';
  }
  /* Lead inbox = leads at the Assigned stage (region set) with no owner flag yet.
     Per-rep region routing (each rep sees only their region), the accept-race and SLA timers are Phase-2. */
  /* Scoped to the rep's own regions (admins see all). Presentational only — every commercial can
     already read all leads via crm_leads_list; this just routes each rep's inbox to their region(s). */
  function inboxList(){ var m=LM.myRegions||{}; return LM.rows.filter(function(l){ return lmIsUnclaimed(l) && (IS_ADMIN || m[l.assignedRegion]); }); }
  function lmInboxScopeLabel(){
    if(IS_ADMIN) return 'all regions (admin)';
    var m=LM.myRegions||{}, ks=Object.keys(m);
    return ks.length?ks.map(function(s){return lmRegionName(s);}).join(' · '):'no region assigned';
  }
  /* One consolidated inbox card: company anchor + region tag + wait-age + a single
     status pill (state · routing); a plain middot metadata line replaces the chip row;
     ref + "routed by" sit quiet in the footer beside the actions. */
  function inboxCard(l){
    var region=l.assignedRegion, mode=lmRoutingOf(region), mgr=lmIsManagerOf(region);
    var days=lmDays(l.assignedAt), hot=days>=3;
    var status='<span class="inb-status '+(mode==='assign'?'':'claim')+'">Unclaimed · '+(mode==='assign'?'Assign':'Claim')+'</span>';
    var age='<span class="inb-age'+(hot?' hot':'')+'">waited '+lmWaited(l.assignedAt)+'</span>';
    /* metadata line: contact (emphasised) · product · source · campaign */
    var meta=[];
    if(l.contact) meta.push('<span class="wname">'+esc(l.contact)+(l.role?' · '+esc(l.role):'')+'</span>');
    if(l.product&&l.product!=='—') meta.push(esc(l.product));
    if(l.band) meta.push(esc(l.band));
    meta.push('Source: '+esc(lmSourceLabel(l.source)));
    if(l.campaign) meta.push('Campaign: '+esc(l.campaign));
    var acts;
    if(mode==='assign'){
      acts=mgr
        ? '<button class="btn btn-primary btn-sm" onclick="CRM.lmAssignMemberOpen(\''+l.id+'\')">Assign to member ▾</button>'
        : '<span class="pchip mut" style="padding:5px 10px">Awaiting your manager</span>';
    } else {
      acts='<button class="btn btn-primary btn-sm" onclick="CRM.lmClaim(\''+l.id+'\')">Claim &amp; own</button>';
      if(mgr) acts+='<button class="btn btn-secondary btn-sm" onclick="CRM.lmAssignMemberOpen(\''+l.id+'\')">Assign to…</button>';
    }
    var openBtn='<button class="btn btn-secondary btn-sm" onclick="CRM.lmOpen(\''+l.id+'\')">Open lead</button>';
    var routedBy=l.assignedByName?' · routed by '+esc(l.assignedByName):'';
    return '<div class="inb inb-lead">'
      +'<div class="inb-h"><span class="inb-t">'+esc(l.company)+'</span>'
        +'<span class="rgtag">'+esc(lmRegionName(region)||'—')+'</span>'+age
        +'<span style="margin-left:auto">'+status+'</span></div>'
      +'<div class="inb-meta">'+meta.join('<span class="dot">·</span>')+'</div>'
      +'<div class="inb-f"><span class="inb-ref"><span class="lot">'+esc(l.ref)+'</span>'+routedBy+'</span>'
        +'<span class="gset" style="margin-left:auto;margin-top:0">'+openBtn+acts+'</span></div></div>';
  }
  function paneInbox(){
    if(!LM.loaded){ lmEnsure(); return lmSkel(); }
    var list=inboxList();
    /* queue-health header — honest, all computed from the loaded rows */
    var oldest=list.reduce(function(m,l){ return lmDays(l.assignedAt)>lmDays(m&&m.assignedAt)?l:m; }, list[0]||null);
    var aging=list.filter(function(l){ return lmDays(l.assignedAt)>=3; }).length;
    var kpis=kpiStrip([
      ['Unclaimed',String(list.length),'in your region(s)'],
      ['Oldest waiting',oldest?lmWaited(oldest.assignedAt):'—',oldest?esc(oldest.company):'nothing waiting'],
      ['Aging 3d+',String(aging),aging?'needs attention':'all fresh']
    ]);
    /* By region when there's more than one region in view (admins, multi-region managers);
       a single-region rep sees a flat list. */
    var byRegion={}, order=[];
    list.forEach(function(l){ var r=l.assignedRegion||'—'; if(!byRegion[r]){ byRegion[r]=[]; order.push(r); } byRegion[r].push(l); });
    var grouped=order.length>1, cards;
    if(grouped){
      order.sort(function(a,b){ return (lmRegionName(a)||a).localeCompare(lmRegionName(b)||b); });
      cards=order.map(function(r){
        var g=byRegion[r], mode=lmRoutingOf(r), old=g.reduce(function(m,l){ return lmDays(l.assignedAt)>lmDays(m&&m.assignedAt)?l:m; },g[0]);
        return '<div class="inb-rghdr"><span class="rn">'+esc(lmRegionName(r)||r)+'</span>'
          +'<span class="route '+(mode==='assign'?'assign':'claim')+'">'+(mode==='assign'?'Assign':'Claim')+'</span>'
          +'<span class="line"></span><span class="cnt">'+g.length+' unclaimed · oldest '+lmWaited(old.assignedAt)+'</span></div>'
          +g.map(inboxCard).join('');
      }).join('');
    } else {
      cards=list.map(inboxCard).join('');
    }
    var emptyMsg=(!IS_ADMIN && !Object.keys(LM.myRegions||{}).length)
      ? 'You have no CRM region assigned yet — an admin can grant one under Admin → Users → Region access.'
      : 'No unclaimed leads in your region(s). Marketing qualifies a lead, then <b>Assign to region</b> to route it here.';
    return '<div class="card"><div class="section-title"><span class="section-title-bar"></span> Lead inbox · '+esc(lmInboxScopeLabel())+' · '+list.length+' unclaimed'
      +' <span style="margin-left:auto"><button class="btn btn-secondary btn-sm" onclick="CRM.lmRefresh(this)">↻ Refresh</button></span></div>'
      +(list.length?kpis+cards:'<div class="empty-state">'+emptyMsg+'</div>')+'</div>';
  }
  /* True when the user manages ≥1 region (admins always). Managers get the team pipeline. */
  function lmIsPipelineManager(){ return IS_ADMIN || !!(LM.myManagerRegions && Object.keys(LM.myManagerRegions).length); }
  /* Pipeline set: a rep sees only their own owned leads; a manager also sees every OWNED lead in
     the region(s) they manage (their team). De-duped by id (a manager's own lead in a managed
     region would otherwise appear twice). Returned leads are excluded. */
  function pipelineList(){
    var mgr=lmIsPipelineManager(), byId={};
    LM.rows.forEach(function(l){
      if(lmIsReturned(l)||lmIsParked(l)) return;
      if(lmIsMine(l) || (mgr && l.assignedTo && lmIsManagerOf(l.assignedRegion))) byId[l.id]=l;
    });
    return Object.keys(byId).map(function(k){ return byId[k]; });
  }
  function lmSetPipeAsg(v){ LM.pipeAsg=v; render(); }
  function panePipeline(){
    if(!LM.loaded){ lmEnsure(); return lmSkel(); }
    var mgr=lmIsPipelineManager(), uid=(USER&&USER.id)||null;
    var full=pipelineList();
    /* distinct assignees present → drives the "filter by assignment" dropdown */
    var asg={}; full.forEach(function(l){ if(l.assignedTo) asg[l.assignedTo]=l.assignedToName||'—'; });
    var fil=LM.pipeAsg||'all';
    var shown=full.filter(function(l){
      if(fil==='all') return true;
      if(fil==='me') return !!(uid && l.assignedTo===uid);
      return l.assignedTo===fil;
    });
    var rows=shown.map(function(l){
      var mineRow=(uid && l.assignedTo===uid);
      var owner=mineRow?'<b>You</b>':(l.assignedToName?esc(l.assignedToName):'<span class="cell-sub">—</span>');
      var byline=l.assignedByName?'<div class="cell-sub">assigned by '+esc(l.assignedByName)+'</div>':'';
      var reassign=lmIsManagerOf(l.assignedRegion)?'<button class="btn btn-secondary btn-sm" onclick="CRM.lmAssignMemberOpen(\''+l.id+'\')">Re-assign</button>':'';
      return '<tr onclick="CRM.lmOpen(\''+l.id+'\')"><td><span class="lot">'+esc(l.ref)+'</span></td><td>'+esc(l.company)+'</td>'
        +'<td>'+owner+byline+'</td>'
        +'<td>'+(l.assignedRegion?bdg('badge-n',lmRegionName(l.assignedRegion)):'—')+'</td>'
        +'<td>'+esc(l.product)+'</td><td>'+(l.campaign?esc(l.campaign):'<span class="cell-sub">—</span>')+'</td><td>'+lmStageBadge(l)+'</td><td class="mono">'+esc(lmDate(l.assignedAt||l.capturedAt))+'</td><td class="mono">'+lmWaited(l.assignedAt||l.capturedAt)+'</td>'
        +'<td onclick="event.stopPropagation()">'+(reassign||'<span class="cell-sub">—</span>')+'</td></tr>';
    }).join('');
    if(!shown.length) rows='<tr><td colspan="10" class="cell-sub" style="padding:16px;text-align:center">'+(mgr?'No leads assigned in your region(s) yet — assign one from the Lead inbox.':'Nothing claimed yet. <b>Claim</b> a region-assigned lead from the Lead inbox to add it here.')+'</td></tr>';
    /* assignment filter — managers only (a rep only ever sees themselves) */
    var asgKeys=Object.keys(asg);
    var filterSel=mgr?'<select class="form-select" style="width:auto" onchange="CRM.lmSetPipeAsg(this.value)">'
        +'<option value="all"'+(fil==='all'?' selected':'')+'>All assignees</option>'
        +'<option value="me"'+(fil==='me'?' selected':'')+'>Me</option>'
        +asgKeys.map(function(k){ return '<option value="'+esc(k)+'"'+(fil===k?' selected':'')+'>'+esc(asg[k])+(uid&&k===uid?' (you)':'')+'</option>'; }).join('')
        +'</select>':'';
    var title=mgr?('Team pipeline · '+shown.length+(fil==='all'?'':' of '+full.length)+' lead(s)'):('My pipeline · '+shown.length+' lead(s) assigned to me');
    return '<div class="card"><div class="section-title"><span class="section-title-bar"></span> '+title
      +' <span style="margin-left:auto;display:inline-flex;gap:6px;align-items:center">'+filterSel+'<button class="btn btn-secondary btn-sm" onclick="CRM.lmRefresh(this)">↻ Refresh</button></span></div>'
      +'<div class="table-wrap"><table><thead><tr><th>Lead</th><th>Company</th><th>Assigned to</th><th>Region</th><th>Product</th><th>Campaign</th><th>Stage</th><th>Assigned</th><th>Age</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div></div>';
  }

  /* ═══════════════════ FUNNEL destination ═══════════════════ */
  function renderLeadFunnel(){
    var vc=$('viewContent'); if(!vc) return;
    /* Board / Metrics toggle (Conversion is labelled "Metrics" here). REAL data (crm_leads). */
    var bar=lsegBar('funnel',[['board','Board','',''],['conv','Metrics','','']]);
    vc.innerHTML='<div class="lead-portal">'+bar+(LSUB.funnel==='conv'?paneConversion():paneBoard())+'</div>';
  }
  var STRIPE={Grapes:'#7a4ea8',Mango:'#c06030',Citrus:'#b0304a',Pomegranate:'#b0304a'};
  function lmStripe(l){ var p=(l.products&&l.products[0])||l.product||''; return STRIPE[p]||'#2b5c3f'; }
  function pct(n,d){ return d?Math.round(n/d*100):0; }
  /* Map our real lead steps onto the ORIGINAL 8-stage funnel (L_STAGES).
     0 Captured · 1 Qualified (incl. assigned-to-region but unclaimed) · 2 Accepted (has an owner:
     claimed OR assigned to a rep). Stages 3–7 (Engaged→Repeat) are deal stages we don't capture yet.
     Returned = a side exit (Rejected), not a column. */
  function lmFunnelStage(l){
    if(l.assignedTo) return (l.stage>=3?l.stage:2);   // Accepted, or a deal stage the owner advanced to (3–7)
    if(lmIsQualified(l)||lmIsAssigned(l)) return 1;   // Qualified — incl. assigned-to-region, unclaimed
    return 0;                                         // Captured
  }
  function paneBoard(){
    if(!LM.loaded){ lmEnsure(); return lmSkel(); }
    var active=LM.rows.filter(function(l){return !lmIsReturned(l)&&!lmIsParked(l);});
    var retN=LM.rows.length-active.length;
    var cols=L_STAGES.map(function(s){
      var items=active.filter(function(l){return lmFunnelStage(l)===s.i;});
      var cards=items.slice(0,8).map(function(l){
        var f=[];
        if(l.assignedRegion) f.push(bdg('badge-n',lmRegionName(l.assignedRegion)));
        if(l.assignedTo) f.push(bdg('badge-pass',lmIsMine(l)?'You':(l.assignedToName||'owned')));
        return '<div class="lc" onclick="CRM.lmOpen(\''+l.id+'\')"><div class="stripe" style="background:'+lmStripe(l)+'"></div>'
          +'<div class="lc-t">'+esc(l.company)+'</div>'
          +'<div class="lc-m">'+esc(l.product)+' · '+esc(lmSourceLabel(l.source))+'</div>'
          +(f.length?'<div class="lc-f">'+f.join('')+'</div>':'')+'</div>';
      }).join('');
      var more=items.length>8?'<div class="cell-sub" style="padding:6px 2px">+'+(items.length-8)+' more</div>':'';
      return '<div class="col"><div class="col-h">'+s.i+' · '+esc(s.label)+' <span class="col-n">'+items.length+'</span></div>'+(cards||'<div class="cell-sub" style="padding:8px 2px">—</div>')+more+'</div>';
    }).join('');
    return '<div class="card"><div class="section-title"><span class="section-title-bar"></span> Funnel board · '+active.length+' active'+(retN?' · '+retN+' rejected':'')
      +' <span style="margin-left:auto"><button class="btn btn-secondary btn-sm" onclick="CRM.lmRefresh(this)">↻ Refresh</button></span></div>'
      +'<div class="kan">'+cols+'</div>'
      +'<div class="hint" style="margin-top:8px"><b>Accepted</b> = a rep owns it (claimed or assigned to a rep). <b>Engaged → Repeat</b> are deal stages — they populate once Phase-2 deal tracking is in. Rejected (returned to marketing) shows in Returned by sales.</div></div>';
  }
  function paneConversion(){
    if(!LM.loaded){ lmEnsure(); return lmSkel(); }
    var rows=LM.rows, total=rows.length;
    /* "Ever reached" via lifecycle signals (persist through returns), mapped to the 8-stage funnel. */
    var cQual=rows.filter(function(l){return l.qualifiedAt||lmIsQualified(l)||lmIsAssigned(l)||l.assignedTo;}).length;
    var cAcc =rows.filter(function(l){return !!l.assignedTo;}).length;   // Accepted = has an owner
    var cRet =rows.filter(lmIsReturned).length;
    var reached=[total,cQual,cAcc,0,0,0,0,0];
    var funnel=L_STAGES.map(function(s,i){
      var n=reached[i], base=(i===0)?total:reached[i-1];
      var conv=(i===0)?'100%':(base?pct(n,base)+'%':'—');
      return fnRow(s.i+' '+s.label, pct(n,total), String(n), conv, i>=6?'var(--green)':'');
    }).join('');
    var kpis=
      kcard('Leads captured',String(total),'all sources')+
      kcard('Captured → Qualified',pct(cQual,total)+'%',cQual+' of '+total)+
      kcard('Qualified → Accepted',pct(cAcc,cQual)+'%',cAcc+' with an owner')+
      kcard('In deal stages','0','Engaged → Repeat · Phase 2');
    /* By source — real capture channels, aligned to the funnel (Captured / Qualified / Accepted) */
    var bySrc={}; rows.forEach(function(l){ var s=l.source||'—'; (bySrc[s]=bySrc[s]||{cap:0,q:0,acc:0}); bySrc[s].cap++; if(l.qualifiedAt||lmIsQualified(l)||lmIsAssigned(l)||l.assignedTo)bySrc[s].q++; if(l.assignedTo)bySrc[s].acc++; });
    var srcRows=Object.keys(bySrc).sort(function(a,b){return bySrc[b].cap-bySrc[a].cap;}).map(function(s){ var r=bySrc[s]; return '<tr><td>'+esc(lmSourceLabel(s))+'</td><td class="mono">'+r.cap+'</td><td class="mono">'+r.q+'</td><td class="mono">'+r.acc+'</td></tr>'; }).join('')
      || '<tr><td colspan="4" class="cell-sub" style="padding:12px;text-align:center">No leads yet.</td></tr>';
    /* By region — routing view: region-assigned leads, owned vs still-unclaimed */
    var byReg={}; rows.filter(lmIsAssigned).forEach(function(l){ var k=l.assignedRegion||'—'; (byReg[k]=byReg[k]||{a:0,o:0}); byReg[k].a++; if(l.assignedTo)byReg[k].o++; });
    var regRows=Object.keys(byReg).sort(function(a,b){return byReg[b].a-byReg[a].a;}).map(function(k){ var r=byReg[k]; return '<tr><td>'+esc(lmRegionName(k))+'</td><td class="mono">'+r.a+'</td><td class="mono">'+r.o+'</td><td class="mono">'+(r.a-r.o)+'</td></tr>'; }).join('')
      || '<tr><td colspan="4" class="cell-sub" style="padding:12px;text-align:center">Nothing assigned to a region yet.</td></tr>';
    return '<div class="kpi-grid" style="margin-bottom:12px">'+kpis+'</div>'
      +'<div class="grid2" style="margin-bottom:12px">'
      +'<div class="card"><div class="section-title"><span class="section-title-bar"></span> Stage funnel · all leads</div>'+funnel
      +'<div class="hint">Bars are share of all captured leads; the right figure is stage-to-stage conversion. <b>Accepted</b> = a rep owns it. Stages 3–7 populate with Phase-2 deal tracking.'+(cRet?' · '+cRet+' currently rejected (returned to marketing).':'')+'</div></div>'
      +'<div class="card"><div class="section-title"><span class="section-title-bar"></span> By capture source</div>'
      +'<div class="table-wrap"><table style="min-width:0"><thead><tr><th>Source</th><th>Captured</th><th>Qualified</th><th>Accepted</th></tr></thead><tbody>'+srcRows+'</tbody></table></div></div></div>'
      +'<div class="grid2"><div class="card"><div class="section-title"><span class="section-title-bar"></span> By region · assigned leads</div>'
      +'<div class="table-wrap"><table style="min-width:0"><thead><tr><th>Region</th><th>Assigned</th><th>Owned</th><th>Unclaimed</th></tr></thead><tbody>'+regRows+'</tbody></table></div></div>'
      +'<div class="card"><div class="section-title"><span class="section-title-bar"></span> Deal analytics</div>'
      +'<div class="alert-warn" style="margin-top:2px">Engaged / Specs / Quoted / Shipped / Repeat, weighted pipeline and days-to-ship need deal-stage data the CRM doesn’t capture yet. These arrive with the Phase-2 deal tracking &amp; SLA rules.</div></div></div>';
  }

  /* ═══════════════════ CAMPAIGNS destination (REAL — crm_campaigns) ═══════════════════ */
  var FORM_HOST=(/-dev|localhost|127\.0\.0\.1/.test(location.host+location.pathname)?'https://daltexcorp-opsexcellence.github.io/daltex-lead-form-dev/':'https://daltexcorp-opsexcellence.github.io/daltex-lead-form/');   /* public capture form: -dev on staging, prod form on prod — resolved by host so promote is a clean copy */
  var CAMP={items:[],loaded:false,loading:false,logoData:null,media:[],editId:null,qrToken:null,products:{}};
  function campLocalToday(tz){ try{ return new Date().toLocaleDateString('en-CA',{timeZone:tz||'UTC'}); }catch(e){ return new Date().toISOString().slice(0,10); } }
  var CAMP_TYPES=[['exhibition','Exhibition'],['digital','Digital'],['research','Research'],['referral','Referral'],['other','Other']];
  var CAMP_CUR=[['EUR','€ EUR'],['USD','$ USD'],['GBP','£ GBP']];
  /* curated IANA timezones for exhibition locations — drives tz-aware activation + lead day */
  var CAMP_TZ=[['Africa/Cairo','Cairo · Egypt (GMT+2)'],['UTC','UTC (GMT+0)'],['Europe/London','London (GMT+0/1)'],['Europe/Berlin','Berlin · Amsterdam · Paris · Madrid (GMT+1/2)'],['Europe/Athens','Athens · Istanbul (GMT+3)'],['Europe/Moscow','Moscow (GMT+3)'],['Asia/Dubai','Dubai · Abu Dhabi (GMT+4)'],['Asia/Karachi','Karachi (GMT+5)'],['Asia/Kolkata','India (GMT+5:30)'],['Asia/Bangkok','Bangkok · Jakarta (GMT+7)'],['Asia/Singapore','Singapore · Kuala Lumpur (GMT+8)'],['Asia/Hong_Kong','Hong Kong (GMT+8)'],['Asia/Shanghai','China (GMT+8)'],['Asia/Tokyo','Tokyo · Seoul (GMT+9)'],['Australia/Sydney','Sydney (GMT+10/11)'],['America/Sao_Paulo','São Paulo (GMT-3)'],['America/New_York','New York · Toronto (GMT-5/4)'],['America/Chicago','Chicago (GMT-6/5)'],['America/Los_Angeles','Los Angeles (GMT-8/7)']];
  function campCurSym(c){ return c==='USD'?'$':(c==='GBP'?'£':'€'); }
  function campLink(tok){ return FORM_HOST+'?c='+encodeURIComponent(tok||''); }
  function campLoad(){
    if(!SB){ CAMP.loaded=true; renderCampaigns(); return; }
    CAMP.loading=true;
    SB.rpc('crm_campaigns_with_stats').then(function(res){
      CAMP.loading=false; CAMP.loaded=true;
      if(res&&!res.error) CAMP.items=res.data||[];
      if(currentTab==='campaigns') renderCampaigns();
    }).catch(function(){ CAMP.loading=false; CAMP.loaded=true; if(currentTab==='campaigns') renderCampaigns(); });
  }
  function campReload(){ CAMP.loaded=false; campLoad(); }
  function campRefresh(btn){ if(btn){ btn.disabled=true; btn.textContent='↻ Refreshing…'; } campReload(); }
  function campCopy(tok){ var link=campLink(tok);
    try{ navigator.clipboard.writeText(link).then(function(){ toast('Link copied · <span class="mono">'+esc(link)+'</span>'); }); }
    catch(e){ toast('Copy failed — link: <span class="mono">'+esc(link)+'</span>'); } }
  function campToggle(id,to){ if(!SB) return;
    /* a manual toggle takes the campaign off auto-schedule (manual control wins over the date window) */
    SB.from('crm_campaigns').update({active:to,auto_schedule:false,updated_at:new Date().toISOString()}).eq('id',id).then(function(res){
      if(res&&res.error){ toast('<b>Could not update.</b> '+esc(res.error.message||'')); return; }
      toast(to?'Campaign activated (manual) — its link is live and won’t auto-close on the end date.':'Campaign deactivated (manual) — its link now rejects new leads.'); campReload();
    }); }
  function campLogoPick(input){
    var f=input&&input.files&&input.files[0]; if(!f) return;
    if(f.size>6*1024*1024){ toast('<b>Image too large.</b> Pick one under 6 MB.'); input.value=''; return; }
    var rd=new FileReader();
    rd.onload=function(ev){ var img=new Image();
      img.onload=function(){ var max=260, w=img.width, h=img.height; var sc=Math.min(1,max/Math.max(w,h)); w=Math.round(w*sc); h=Math.round(h*sc);
        var cv=document.createElement('canvas'); cv.width=w; cv.height=h; cv.getContext('2d').drawImage(img,0,0,w,h);
        try{ CAMP.logoData=cv.toDataURL('image/png'); }catch(e){ CAMP.logoData=ev.target.result; }
        var pv=$('camp_logo_pv'); if(pv){ pv.innerHTML='<img src="'+CAMP.logoData+'" style="max-height:52px;max-width:150px;border-radius:6px;background:#fff;padding:4px;border:1px solid var(--border)"/> <span class="link-btn" onclick="CRM.campLogoClear()">remove</span>'; }
      };
      img.onerror=function(){ toast('<b>Could not read that image.</b>'); };
      img.src=ev.target.result;
    };
    rd.readAsDataURL(f);
  }
  function campLogoClear(){ CAMP.logoData=null; var pv=$('camp_logo_pv'); if(pv) pv.innerHTML='<span class="cell-sub">No logo — the form shows the Daltex mark only.</span>'; var fi=$('camp_logo'); if(fi) fi.value=''; }
  /* ── supporting pictures (up to 3, stored as resized data URLs in crm_campaigns.media) ── */
  function campRenderMedia(){ var pv=$('camp_media_pv'); if(!pv) return; var m=CAMP.media||[];
    var html=m.map(function(src,i){ return '<div style="position:relative">'
      +'<img src="'+src+'" style="height:70px;width:70px;object-fit:cover;border-radius:9px;border:1px solid var(--border);cursor:zoom-in" onclick="CRM.campLightbox(this.src)"/>'
      +'<span role="button" title="Remove" onclick="CRM.campMediaClear('+i+')" style="position:absolute;top:-7px;right:-7px;width:20px;height:20px;line-height:18px;text-align:center;background:var(--card);border:1px solid var(--border);border-radius:50%;cursor:pointer;font-size:12px;color:var(--red)">✕</span></div>'; }).join('');
    if(m.length<3){ html+='<label class="capbtn" style="height:70px;width:70px;align-items:center;justify-content:center;cursor:pointer;position:relative;padding:0">'
      +'<span class="capt" style="font-size:24px;line-height:1;color:var(--text3)">+</span>'
      +'<input type="file" accept="image/*" style="position:absolute;width:1px;height:1px;opacity:0" onchange="CRM.campMediaPick(this)"/></label>'; }
    pv.innerHTML=html;
  }
  function campMediaPick(input){ var f=input&&input.files&&input.files[0]; if(!f){ return; } input.value='';
    if((CAMP.media||[]).length>=3){ toast('Up to 3 pictures.'); return; }
    if(f.size>10*1024*1024){ toast('<b>Image too large.</b> Pick one under 10 MB.'); return; }
    var rd=new FileReader();
    rd.onload=function(ev){ var img=new Image();
      img.onload=function(){ var max=1000, w=img.width, h=img.height, sc=Math.min(1,max/Math.max(w,h)); w=Math.round(w*sc); h=Math.round(h*sc);
        var cv=document.createElement('canvas'); cv.width=w; cv.height=h; cv.getContext('2d').drawImage(img,0,0,w,h);
        var data; try{ data=cv.toDataURL('image/jpeg',0.72); }catch(e){ data=ev.target.result; }
        CAMP.media=(CAMP.media||[]).concat([data]); campRenderMedia();
      };
      img.onerror=function(){ toast('<b>Could not read that image.</b>'); }; img.src=ev.target.result;
    };
    rd.readAsDataURL(f);
  }
  function campMediaClear(i){ CAMP.media=(CAMP.media||[]).filter(function(_,j){ return j!==i; }); campRenderMedia(); }
  /* full-screen picture viewer — reused by the view + edit galleries (data-URI safe, unlike window.open) */
  function campLightbox(src){
    var ov=document.createElement('div');
    ov.style.cssText='position:fixed;inset:0;z-index:99999;background:rgba(8,12,20,.93);display:flex;align-items:center;justify-content:center;padding:24px;cursor:zoom-out';
    var im=document.createElement('img'); im.src=src; im.style.cssText='max-width:94vw;max-height:92vh;border-radius:10px;box-shadow:0 24px 70px rgba(0,0,0,.6)'; ov.appendChild(im);
    function close(){ if(ov.parentNode) ov.parentNode.removeChild(ov); document.removeEventListener('keydown',onKey); }
    function onKey(e){ if(e.key==='Escape') close(); }
    ov.addEventListener('click',close); document.addEventListener('keydown',onKey);
    document.body.appendChild(ov);
  }
  /* read-only campaign detail (with an Edit button + a comfortable picture gallery) */
  function campView(id){
    var c=(CAMP.items||[]).filter(function(x){return x.id===id;})[0]; if(!c) return;
    var lt=campLocalToday(c.timezone);
    var stateLbl=c.active?'Live':(c.auto_schedule&&c.start_date&&lt<c.start_date?'Scheduled':(c.auto_schedule&&c.end_date&&lt>c.end_date?'Ended':'Off'));
    var pill=c.active?'<span class="badge badge-pass">Live</span>':(stateLbl==='Scheduled'?'<span class="badge badge-n">Scheduled</span>':(stateLbl==='Ended'?'<span class="badge badge-warn">Ended</span>':'<span class="badge badge-n">Off</span>'));
    var dates=(c.start_date||'')+(c.end_date?' → '+c.end_date:''); if(!c.start_date&&!c.end_date) dates='—';
    var sym=campCurSym(c.currency); var link=campLink(c.public_token);
    var row=function(k,v){ if(v==null||v===''||v==='—') v='—'; return '<div class="l-drow"><span class="cell-sub">'+k+'</span><span>'+v+'</span></div>'; };
    var body='<div class="l-form"><div class="l-qhdr">'+esc(c.name)+' &nbsp;'+pill+'</div>'
      +(c.logo_url?'<div style="margin:4px 0 10px"><img src="'+esc(c.logo_url)+'" style="max-height:48px;max-width:150px;background:#fff;border-radius:6px;padding:4px;border:1px solid var(--border)"/></div>':'')
      +row('Type', esc(c.type||'—'))
      +row('Selling product(s)', (c.products&&c.products.length)?(c.products.map(function(p){return bdg('badge-park',p);}).join(' ')+(c.products_other?' <span class="cell-sub">· other: '+esc(c.products_other)+'</span>':'')):'<span class="cell-sub">—</span>')
      +row('Status', esc(stateLbl)+(stateLbl==='Scheduled'&&c.start_date?' <span class="cell-sub">· opens '+esc(c.start_date)+'</span>':(stateLbl==='Ended'&&c.end_date?' <span class="cell-sub">· closed after '+esc(c.end_date)+'</span>':'')))
      +row('Dates', esc(dates))
      +row('Location', c.location?esc(c.location):'—')
      +row('Time zone', esc(c.timezone||'—'))
      +row('Cost', c.cost!=null?esc(sym+Number(c.cost).toLocaleString()):'—')
      +row('Leads', String(Number(c.lead_count||0)))
      +row('Public link', '<span class="mono" style="word-break:break-all;font-size:12px">'+esc(link)+'</span> <span class="link-btn" onclick="CRM.campCopy(\''+esc(c.public_token)+'\')">Copy</span>')
      +'<label class="form-label" style="margin-top:12px">Supporting pictures</label>'
      +'<div id="campview_media" class="cell-sub" style="margin-top:4px">Loading…</div>'
      +'<div class="l-formact" style="margin-top:14px"><button class="btn btn-primary" onclick="CRM.campNew(\''+id+'\')">Edit</button><button class="btn btn-secondary" onclick="CRM.campQr(\''+id+'\')">Link · QR</button><button class="btn btn-secondary" onclick="CRM.closeDlv()">Close</button></div></div>';
    showDlv('Campaign', body);
    if(SB) SB.from('crm_campaigns').select('media').eq('id',id).single().then(function(res){
      var el=$('campview_media'); if(!el) return;
      var m=(res&&res.data&&Array.isArray(res.data.media))?res.data.media:[];
      if(!m.length){ el.textContent='No pictures added.'; return; }
      el.className=''; el.style.cssText='display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin-top:6px';
      el.innerHTML=m.map(function(src){ return '<img src="'+src+'" style="width:100%;height:118px;object-fit:cover;border-radius:10px;border:1px solid var(--border);cursor:zoom-in" onclick="CRM.campLightbox(this.src)"/>'; }).join('');
    }).catch(function(){ var el=$('campview_media'); if(el) el.textContent='Could not load pictures.'; });
  }
  function campProdChip(btn){ var p=btn.getAttribute('data-p'); CAMP.products[p]=!CAMP.products[p]; btn.classList.toggle('on',!!CAMP.products[p]); if(p==='Other'){ var w=$('camp_other_wrap'); if(w){ w.style.display=CAMP.products['Other']?'block':'none'; if(CAMP.products['Other']){ var o=$('camp_products_other'); if(o) o.focus(); } } } }
  function campProdChipsHtml(){ return CAP_PRODUCTS.map(function(p){ return '<button type="button" class="capchip'+(CAMP.products[p]?' on':'')+'" data-p="'+esc(p)+'" onclick="CRM.campProdChip(this)">'+esc(p)+'</button>'; }).join(''); }
  function campNew(id){
    CAMP.editId=id||null; CAMP.logoData=null; CAMP.media=[]; CAMP.products={};
    var c=id?CAMP.items.filter(function(x){return x.id===id;})[0]:null;
    if(c&&c.logo_url) CAMP.logoData=c.logo_url;
    if(c&&Array.isArray(c.products)) c.products.forEach(function(p){ if(p) CAMP.products[p]=true; });
    var typeOpts=CAMP_TYPES.map(function(o){return '<option value="'+o[0]+'"'+(c&&c.type===o[0]?' selected':'')+'>'+o[1]+'</option>';}).join('');
    var curOpts=CAMP_CUR.map(function(o){return '<option value="'+o[0]+'"'+((c?c.currency:'EUR')===o[0]?' selected':'')+'>'+o[1]+'</option>';}).join('');
    var tzOpts=CAMP_TZ.map(function(o){return '<option value="'+o[0]+'"'+((((c&&c.timezone)||'Africa/Cairo')===o[0])?' selected':'')+'>'+esc(o[1])+'</option>';}).join('');
    var pv=CAMP.logoData?'<img src="'+CAMP.logoData+'" style="max-height:52px;max-width:150px;border-radius:6px;background:#fff;padding:4px;border:1px solid var(--border)"/> <span class="link-btn" onclick="CRM.campLogoClear()">remove</span>':'<span class="cell-sub">No logo — the form shows the Daltex mark only.</span>';
    var body='<div class="l-form"><div class="l-formnote">Creating a campaign generates its own <b>public capture link + QR</b> automatically. Share the QR at the stand; every scan lands as a lead tagged to this campaign.</div>'
      +field('camp_name','Event / campaign name',c?c.name:'','e.g. Fruit Logistica 2026 — Berlin')
      +'<div class="grid2"><div>'+'<label class="form-label" style="margin-top:8px">Type</label><select class="form-select" id="camp_type">'+typeOpts+'</select></div>'
      +'<div><label class="form-label" style="margin-top:8px">Currency</label><select class="form-select" id="camp_cur">'+curOpts+'</select></div></div>'
      +'<label class="form-label" style="margin-top:8px">Selling product(s) <span class="cell-sub" style="text-transform:none;letter-spacing:0">(which crop(s) this campaign targets — pick any — powers the cross-sell view)</span></label>'
      +'<div class="capchips" id="camp_products">'+campProdChipsHtml()+'</div>'
      +'<div id="camp_other_wrap" style="display:'+(CAMP.products['Other']?'block':'none')+';margin-top:6px">'+field('camp_products_other','Other product(s) — optional',(c&&c.products_other)||'','e.g. Figs, Dates')+'</div>'
      +'<div class="grid2"><div>'+dateField('camp_start','Start date',c&&c.start_date?c.start_date:'')+'</div><div>'+dateField('camp_end','End date',c&&c.end_date?c.end_date:'')+'</div></div>'
      +'<div class="grid2"><div>'+field('camp_location','Location (optional)',c&&c.location?c.location:'','e.g. Hong Kong · AsiaWorld-Expo')+'</div>'
      +'<div><label class="form-label" style="margin-top:8px">Time zone</label><select class="form-select" id="camp_tz">'+tzOpts+'</select></div></div>'
      +'<div class="l-formhint" style="margin:-2px 0 8px">Each lead&rsquo;s day follows the event&rsquo;s time zone — so a lead captured after midnight in Hong Kong records on the new local day.</div>'
      +'<label style="display:flex;gap:9px;align-items:flex-start;margin:2px 0 8px;cursor:pointer"><input type="checkbox" id="camp_autosched"'+((!c||c.auto_schedule!==false)?' checked':'')+' style="width:auto;margin-top:2px;accent-color:var(--accent)"/><span style="font-size:12.5px;color:var(--text2)">Activate &amp; deactivate automatically by the event dates <span class="cell-sub" style="text-transform:none;letter-spacing:0">— live from the start date, closes after the end date (event-local). Uncheck to switch the link on/off manually.</span></span></label>'
      +field('camp_cost','Cost (optional)',c&&c.cost!=null?String(c.cost):'','e.g. 41200')
      +'<label class="form-label" style="margin-top:10px">Event logo (optional)</label>'
      +'<div id="camp_logo_pv" style="margin:4px 0 6px">'+pv+'</div>'
      +'<label class="capbtn" style="cursor:pointer;display:inline-flex;position:relative"><span class="capt">Upload logo ↑</span><span class="caps">PNG/JPG — shown on the public form</span><input type="file" id="camp_logo" accept="image/*" style="position:absolute;width:1px;height:1px;opacity:0" onchange="CRM.campLogoPick(this)"/></label>'
      +'<label class="form-label" style="margin-top:12px">Supporting pictures <span class="cell-sub" style="text-transform:none;letter-spacing:0">(up to 3, optional — for your reference)</span></label>'
      +'<div id="camp_media_pv" style="display:flex;gap:8px;flex-wrap:wrap;margin:5px 0 6px"></div>'
      +'<div id="camp_warn"></div>'
      +'<div class="l-formact"><button class="btn btn-primary" onclick="CRM.campSave()">'+(id?'Save changes':'Create campaign')+'</button><button class="btn btn-secondary" onclick="CRM.closeDlv()">Cancel</button></div></div>';
    showDlv(id?'Edit campaign':'New campaign',body);
    campRenderMedia();
    /* media isn't in the list RPC (kept light) — fetch it when opening an existing campaign, then preview */
    if(id && SB){ SB.from('crm_campaigns').select('media').eq('id',id).single().then(function(res){ if(res&&!res.error&&res.data&&Array.isArray(res.data.media)){ CAMP.media=res.data.media; campRenderMedia(); } }).catch(function(){}); }
  }
  function campSave(){
    if(!SB){ return; }
    var name=(($('camp_name')||{}).value||'').trim();
    var w=$('camp_warn'); if(w) w.innerHTML='';
    if(!name){ if(w) w.innerHTML='<div class="alert-fail" style="margin-top:10px">A campaign name is required.</div>'; return; }
    var start=(($('camp_start')||{}).value||'').trim(), end=(($('camp_end')||{}).value||'').trim();
    var dre=/^\d{4}-\d{2}-\d{2}$/;
    if(start&&!dre.test(start)){ if(w) w.innerHTML='<div class="alert-fail" style="margin-top:10px">Start date must be YYYY-MM-DD.</div>'; return; }
    if(end&&!dre.test(end)){ if(w) w.innerHTML='<div class="alert-fail" style="margin-top:10px">End date must be YYYY-MM-DD.</div>'; return; }
    var costRaw=(($('camp_cost')||{}).value||'').replace(/[, ]/g,'').trim();
    var cost=costRaw?Number(costRaw):null; if(cost!=null&&isNaN(cost)){ if(w) w.innerHTML='<div class="alert-fail" style="margin-top:10px">Cost must be a number.</div>'; return; }
    var tz=($('camp_tz')||{}).value||'Africa/Cairo';
    var rec={ name:name, type:($('camp_type')||{}).value||'exhibition', currency:($('camp_cur')||{}).value||'EUR',
      products:(function(){ var a=Object.keys(CAMP.products||{}).filter(function(p){return CAMP.products[p];}); return a.length?a:null; })(),
      products_other:(CAMP.products&&CAMP.products['Other'])?((($('camp_products_other')||{}).value||'').trim()||null):null,
      start_date:start||null, end_date:end||null, cost:cost,
      location:(($('camp_location')||{}).value||'').trim()||null, timezone:tz,
      media:((CAMP.media&&CAMP.media.length)?CAMP.media:null),
      logo_url:CAMP.logoData||null, updated_at:new Date().toISOString() };
    var autoSched=!$('camp_autosched')||$('camp_autosched').checked;
    rec.auto_schedule=autoSched;
    /* when auto-scheduled, set active immediately from the event-local window (cron keeps it in sync hourly) */
    var localToday=campLocalToday(tz);
    var inWindow=(!start||localToday>=start)&&(!end||localToday<=end);
    if(autoSched){ rec.active=inWindow; rec.auto_deactivated_at=null; }
    else if(!CAMP.editId){ rec.active=true; }   /* manual + new → default on */
    var btn=w&&w.parentNode?w.parentNode.querySelector('.btn-primary'):null; if(btn){ btn.disabled=true; btn.textContent='Saving…'; }
    var q=CAMP.editId ? SB.from('crm_campaigns').update(rec).eq('id',CAMP.editId).select('id,public_token').single()
                      : SB.from('crm_campaigns').insert(rec).select('id,public_token').single();
    q.then(function(res){
      if(res&&res.error){ if(w) w.innerHTML='<div class="alert-fail" style="margin-top:10px"><b>Save failed.</b> '+esc(res.error.message||'')+'</div>'; if(btn){btn.disabled=false;btn.textContent=CAMP.editId?'Save changes':'Create campaign';} return; }
      var row=res&&res.data; var wasNew=!CAMP.editId; CAMP.editId=null; CAMP.logoData=null; CAMP.media=[]; closeDlv();
      toast(wasNew?'Campaign <b>'+esc(name)+'</b> created — link & QR ready.':'Campaign <b>'+esc(name)+'</b> updated.');
      campReload();
      if(wasNew && row && row.public_token) setTimeout(function(){ campQrByToken(row.public_token,name); },250);
    }).catch(function(e){ if(w) w.innerHTML='<div class="alert-fail" style="margin-top:10px"><b>Save failed.</b> '+esc(String(e))+'</div>'; if(btn){btn.disabled=false;btn.textContent=CAMP.editId?'Save changes':'Create campaign';} });
  }
  function campQr(id){ var c=CAMP.items.filter(function(x){return x.id===id;})[0]; if(!c) return; campQrByToken(c.public_token,c.name); }
  function campQrByToken(tok,name){
    CAMP.qrToken=tok;
    var link=campLink(tok);
    var body='<div class="l-form"><div class="l-formnote">Print this for the stand. Each scan opens the public registration form for <b>'+esc(name||'')+'</b> and lands as a lead here.</div>'
      +'<div id="camp_qr_box" style="display:flex;justify-content:center;padding:14px;background:#fff;border-radius:10px;border:1px solid var(--border);min-height:200px;align-items:center"><span class="cell-sub">Generating QR…</span></div>'
      +'<label class="form-label" style="margin-top:12px">Shareable link</label>'
      +'<div style="display:flex;gap:6px"><input class="form-input mono" id="camp_qr_link" readonly value="'+esc(link)+'" style="flex:1;font-size:12px"/><button class="btn btn-secondary btn-sm" onclick="CRM.campCopy(\''+esc(tok)+'\')">Copy</button></div>'
      +'<div class="l-formact"><button class="btn btn-primary" id="camp_qr_dl" onclick="CRM.campQrDownload(\''+esc(name||'campaign')+'\')" disabled>Download QR (PNG)</button><a class="btn btn-secondary" href="'+esc(link)+'" target="_blank" rel="noopener">Open form ↗</a><button class="btn btn-secondary" onclick="CRM.closeDlv()">Close</button></div></div>';
    showDlv('Campaign link & QR',body);
    capLoadScript('lib/qrcode.min.js').then(function(){
      var box=$('camp_qr_box'); if(!box) return; box.innerHTML='';
      /* correctLevel H (~30% recoverable) so the centre Daltex logo never breaks scanning */
      try{ new window.QRCode(box,{text:link,width:1000,height:1000,correctLevel:window.QRCode.CorrectLevel.H,colorDark:'#22306b',colorLight:'#ffffff'}); campQrDecorate(0); }
      catch(e){ box.innerHTML='<span class="cell-sub">QR unavailable — use the link above.</span>'; }
    }).catch(function(){ var box=$('camp_qr_box'); if(box) box.innerHTML='<span class="cell-sub">QR library blocked — use the link above.</span>'; });
  }
  function campRoundRect(ctx,x,y,w,h,r){ ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); }
  var CAMP_LOGO_SRC='daltex-logo.png';   /* same-origin Daltex logo drawn in the QR centre */
  function campDrawLogo(cv){
    try{
      var ctx=cv.getContext('2d'), W=cv.width;
      var b=Math.round(W*0.21), cx=W/2, cy=W/2;   /* clean white circle knockout, no border */
      ctx.save();
      ctx.beginPath(); ctx.arc(cx,cy,b/2,0,Math.PI*2); ctx.fillStyle='#ffffff'; ctx.fill();
      ctx.restore();
      if(CAMP_LOGO_SRC){
        var img=new Image();
        img.onload=function(){ try{
          /* fill more of the circle: 0.72·b height stays fully inscribed (max ~0.76 for this logo aspect) */
          var fit=Math.round(b*0.72), iw=fit, ih=fit, ar=(img.width||1)/(img.height||1);
          if(ar>=1){ ih=Math.round(iw/ar); } else { iw=Math.round(ih*ar); }
          ctx.drawImage(img, Math.round(cx-iw/2), Math.round(cy-ih/2), iw, ih);
          campQrSnapshot(cv); var dl=$('camp_qr_dl'); if(dl) dl.disabled=false;
        }catch(e){} };
        img.src=CAMP_LOGO_SRC;
        return;
      }
      /* interim mark until the real Daltex logo file is embedded */
      ctx.save(); ctx.textBaseline='middle';
      var fs=Math.round(b*0.24);
      ctx.font='800 '+fs+'px system-ui,-apple-system,Arial,sans-serif';
      try{ ctx.letterSpacing=Math.round(fs*0.04)+'px'; }catch(e){}
      var t1='DAL', t2='TEX', w1=ctx.measureText(t1).width, w2=ctx.measureText(t2).width, tot=w1+w2, sx=(W-tot)/2, cy=W/2;
      ctx.textAlign='left';
      ctx.fillStyle='#22306b'; ctx.fillText(t1,sx,cy);
      ctx.fillStyle='#e2662a'; ctx.fillText(t2,sx+w1,cy);
      ctx.restore();
      campQrSnapshot(cv);
    }catch(e){}
  }
  /* qrcodejs shows an <img> snapshot of the canvas (canvas is display:none) and snapshots BEFORE
     the async logo loads — so push the finished canvas (with logo) back into that visible img. */
  function campQrSnapshot(cv){ try{ var box=$('camp_qr_box'); if(!box) return; var im=box.querySelector('img'); if(im){ im.src=cv.toDataURL('image/png'); im.style.maxWidth='100%'; im.style.height='auto'; } }catch(e){} }
  function campQrDecorate(tries){
    var box=$('camp_qr_box'); if(!box) return;
    var cv=box.querySelector('canvas');
    if(!cv){ if(tries<20) return setTimeout(function(){campQrDecorate(tries+1);},40); return; }
    cv.style.maxWidth='100%'; cv.style.height='auto';
    campDrawLogo(cv);
    var dl=$('camp_qr_dl'); if(dl) dl.disabled=false;
  }
  function campQrDownload(name){
    var box=$('camp_qr_box'); if(!box) return;
    var cv=box.querySelector('canvas'); var data=null;
    if(cv){ try{ data=cv.toDataURL('image/png'); }catch(e){} }
    if(!data){ var im=box.querySelector('img'); if(im) data=im.src; }
    if(!data){ toast('QR not ready yet.'); return; }
    var a=document.createElement('a'); a.href=data; a.download='daltex-qr-'+String(name||'campaign').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')+'.png';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }
  function renderCampaigns(){
    var vc=$('viewContent'); if(!vc) return;
    if(!CAMP.loaded){ if(!CAMP.loading) campLoad();
      vc.innerHTML='<div class="lead-portal"><div class="card"><div class="cell-sub" style="padding:6px 2px">Loading campaigns…</div></div></div>'; return; }
    var items=CAMP.items;
    var active=items.filter(function(c){return c.active;}).length;
    var totLeads=items.reduce(function(a,c){return a+Number(c.lead_count||0);},0);
    var spendByCur={}; items.forEach(function(c){ if(c.cost!=null){ var k=c.currency||'EUR'; spendByCur[k]=(spendByCur[k]||0)+Number(c.cost); } });
    var spendStr=Object.keys(spendByCur).length?Object.keys(spendByCur).map(function(k){return campCurSym(k)+Number(spendByCur[k]).toLocaleString();}).join(' · '):'—';
    var kpis=kcard('Campaigns',String(items.length),active+' active')
      +kcard('Leads captured',String(totLeads),'across all campaigns')
      +kcard('Recorded spend',spendStr,'sum of entered cost');
    var rows=items.map(function(c){
      var sym=campCurSym(c.currency);
      var dates=(c.start_date||'')+(c.end_date?' → '+c.end_date:''); if(!c.start_date&&!c.end_date) dates='—';
      /* state from auto_schedule + the event-LOCAL today: Live / Scheduled (before start) / Ended (after end) / Off (manual) */
      var lt=campLocalToday(c.timezone);
      var scheduled = !c.active && c.auto_schedule && c.start_date && lt < c.start_date;
      var ended     = !c.active && c.auto_schedule && c.end_date   && lt > c.end_date;
      var pill=c.active?'<span class="badge badge-pass">Live</span>'
        :scheduled?'<span class="badge badge-n" title="Auto-activates on the start date ('+esc(c.timezone||'UTC')+')">Scheduled</span>'
        :ended?'<span class="badge badge-warn" title="Auto-closed after the end date — Reactivate to reopen">Ended</span>'
        :'<span class="badge badge-n" title="'+(c.auto_schedule?'':'Manually off')+'">Off</span>';
      var logo=c.logo_url?'<img src="'+esc(c.logo_url)+'" style="height:26px;max-width:70px;border-radius:4px;background:#fff;padding:2px;vertical-align:middle"/>':'<span class="cell-sub">—</span>';
      var acts='<div style="display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end">'
        +'<button class="btn btn-secondary btn-sm" onclick="CRM.campView(\''+c.id+'\')">View</button>'
        +'<button class="btn btn-secondary btn-sm" onclick="CRM.campQr(\''+c.id+'\')">Link · QR</button>'
        +'<button class="btn btn-secondary btn-sm" onclick="CRM.campCopy(\''+esc(c.public_token)+'\')">Copy</button>'
        +'<button class="btn btn-secondary btn-sm" onclick="CRM.campToggle(\''+c.id+'\','+(c.active?'false':'true')+')">'+(c.active?'Deactivate':(ended?'Reactivate':'Activate'))+'</button>'
        +'</div>';
      return '<tr'+(c.active?'':' style="opacity:.62"')+'><td>'+logo+'</td><td><b style="cursor:pointer" title="View campaign" onclick="CRM.campView(\''+c.id+'\')">'+esc(c.name)+'</b>'+(c.location?'<div class="cell-sub">📍 '+esc(c.location)+'</div>':'')+(c.media_count?'<div class="cell-sub">🖼 '+c.media_count+' picture'+(c.media_count>1?'s':'')+'</div>':'')+'</td><td>'+bdg('badge-n',c.type||'—')+'</td><td class="mono">'+esc(dates)+'</td><td class="mono">'+(c.cost!=null?sym+Number(c.cost).toLocaleString():'—')+'</td><td class="mono">'+Number(c.lead_count||0)+'</td><td>'+pill+'</td><td>'+acts+'</td></tr>';
    }).join('');
    if(!items.length) rows='<tr><td colspan="8" class="cell-sub" style="padding:16px;text-align:center">No campaigns yet. Create one to generate a stand QR.</td></tr>';
    vc.innerHTML='<div class="lead-portal">'
      +'<div class="kpi-grid" style="margin-bottom:12px">'+kpis+'</div>'
      +'<div class="card"><div class="section-title"><span class="section-title-bar"></span> Campaigns <span style="margin-left:auto;display:inline-flex;gap:6px"><button class="btn btn-secondary btn-sm" onclick="CRM.campRefresh(this)">↻ Refresh</button><button class="btn btn-primary btn-sm" onclick="CRM.campNew()">+ New campaign</button></span></div>'
      +'<div class="l-formhint" style="margin:0 0 10px">Each campaign carries its own capture link + QR. Deactivating a campaign instantly stops its public form from accepting leads.</div>'
      +'<div class="table-wrap"><table style="min-width:820px"><thead><tr><th>Logo</th><th>Campaign</th><th>Type</th><th>Dates</th><th>Cost</th><th>Leads</th><th>Status</th><th style="text-align:right">Actions</th></tr></thead><tbody>'+rows+'</tbody></table></div></div></div>';
  }

  /* ═══════════════════ drawers / actions ═══════════════════ */
  function field(id,label,val,ph){ return '<label class="form-label" style="margin-top:8px">'+esc(label)+'</label><input class="form-input" id="'+id+'" value="'+esc(val||'')+'" placeholder="'+esc(ph||'')+'"/>'; }
  function dateField(id,label,val){ return '<label class="form-label" style="margin-top:8px">'+esc(label)+'</label><input type="date" class="form-input" id="'+id+'" value="'+esc(val||'')+'"/>'; }
  function selField(id,label,opts,val){ return '<label class="form-label" style="margin-top:8px">'+esc(label)+'</label><select class="form-select" id="'+id+'">'+opts.map(function(o){return '<option value="'+esc(o[0])+'"'+(String(val)===String(o[0])?' selected':'')+'>'+esc(o[1])+'</option>';}).join('')+'</select>'; }

  function leadQuickAdd(){
    var body='<div class="l-form"><div class="l-formnote">Five fields. Creates a stage-0 lead assigned to you.</div>'
      +field('lqa_co','Company','','e.g. Meridian Fresh Ltd')
      +selField('lqa_country','Country',[['','— pick —']].concat(Object.keys(L_C2R).map(function(c){return [c,c];})),'')
      +selField('lqa_product','Product interest',['Grapes','Citrus','Mango','Pomegranate'].map(function(p){return [p,p];}),'Grapes')
      +selField('lqa_campaign','Source / campaign',L_CAMPAIGNS.map(function(c){return [c.id,c.name];}),'C1')
      +field('lqa_contact','Contact (name / email)','','J. Whitfield')
      +'<div id="lqa_warn"></div>'
      +'<div class="l-formact"><button class="btn btn-primary" onclick="CRM.leadSubmitQuickAdd()">Register lead</button><button class="btn btn-secondary" onclick="CRM.closeDlv()">Cancel</button></div></div>';
    showDlv('Quick add lead',body);
  }
  function leadSubmitQuickAdd(force){
    var co=($('lqa_co')||{}).value||'',country=($('lqa_country')||{}).value||'',product=($('lqa_product')||{}).value||'Grapes',campaign=($('lqa_campaign')||{}).value||'C1',contact=($('lqa_contact')||{}).value||'';
    var w=$('lqa_warn'); if(w) w.innerHTML='';
    if(!co.trim()){ if(w) w.innerHTML='<div class="alert-fail" style="margin-top:10px">Company is required.</div>'; return; }
    if(L_CLIENTS.some(function(c){return c.toLowerCase()===co.trim().toLowerCase();})){ if(w) w.innerHTML='<div class="alert-fail" style="margin-top:10px"><b>Blocked.</b> “'+esc(co)+'” is already an active client — it can’t be registered as a new lead.</div>'; return; }
    if(!force){ var dup=LEADS.filter(function(l){return l.company.toLowerCase().indexOf(co.trim().toLowerCase())>=0;})[0];
      if(dup){ if(w) w.innerHTML='<div class="alert-warn" style="margin-top:10px"><b>Possible duplicate</b> — '+esc(dup.company)+' ('+esc(dup.id)+'). <span class="link-btn" onclick="CRM.leadOpen(\''+dup.id+'\')">Open existing</span> · <span class="link-btn" onclick="CRM.leadSubmitQuickAdd(1)">Continue anyway</span></div>'; return; } }
    var n=1000+LEADS.length; var id='LD-2026-0'+n;
    LEADS.unshift(mk(id,co.trim(),country||'—',product,'inbound',0,0,ME,'now',{campaign:campaign,contact:contact,region:L_C2R[country]||'unmapped',missing:'Contact role · volume band'}));
    closeDlv(); toast('Lead <b>'+esc(co)+'</b> registered at stage 0 (enrichment queue).'); render();
  }

  var qState=null;
  function leadEnrich(id){ leadQualifyOpen(id); }
  function leadQualifyOpen(id){ var l=leadById(id); if(!l) return; qState={id:id,g:{receiver:l.gates.receiver==='pass'?'pass':'todo',contact:l.gates.contact==='pass'?'pass':'todo',dest:l.gates.dest==='pass'?'pass':'todo',volume:l.gates.volume==='pass'?'pass':'todo',payment:l.gates.payment==='pass'?'pass':'todo'}}; leadQualifyRender(); }
  function leadQualifyRender(){
    var l=leadById(qState.id); if(!l) return;
    var autoRows=L_GATES.filter(function(g){return g.src==='auto';}).map(function(g){var v=l.gates[g.k];return '<div class="l-qgate"><div><div>'+esc(g.label)+'</div><div class="cell-sub">auto · DalOS</div></div>'+(v==='pass'?bdg('badge-pass','pass'):(v==='warn'?bdg('badge-warn','warn'):bdg('badge-fail','fail')))+'</div>';}).join('');
    var mktRows=L_GATES.filter(function(g){return g.src==='marketing';}).map(function(g){var v=qState.g[g.k];return '<div class="l-qgate"><div><div>'+esc(g.label)+'</div><div class="cell-sub">marketing</div></div><span class="l-seg"><span class="l-segb'+(v==='pass'?' on-ok':'')+'" onclick="CRM.leadGate(\''+g.k+'\',\'pass\')">Pass</span><span class="l-segb'+(v==='fail'?' on-fail':'')+'" onclick="CRM.leadGate(\''+g.k+'\',\'fail\')">Fail</span></span></div>';}).join('');
    var autoFail=L_GATES.some(function(g){return g.src==='auto'&&l.gates[g.k]==='fail';});
    var mktFail=Object.keys(qState.g).some(function(k){return qState.g[k]==='fail';});
    var mktTodo=Object.keys(qState.g).some(function(k){return qState.g[k]==='todo';});
    var blocked=autoFail||mktFail||mktTodo;
    var msg=autoFail?'<div class="alert-fail" style="margin-top:10px">An automatic gate is failing — this lead can’t be qualified.</div>':(mktFail?'<div class="alert-fail" style="margin-top:10px">A marketing gate is set to Fail.</div>':(mktTodo?'<div class="alert-warn" style="margin-top:10px">Set every marketing gate to Pass to qualify.</div>':''));
    var body='<div class="l-form"><div class="l-formnote">Eight hard gates, no numeric score. Four resolve from DalOS; four are marketing’s call.</div>'
      +'<div class="l-qhdr">'+esc(l.company)+' · '+esc(l.country)+' · '+esc(l.product)+'</div>'
      +'<div class="l-qsec">Automatic · DalOS</div>'+autoRows+'<div class="l-qsec">Marketing</div>'+mktRows+msg
      +'<div class="l-formact"><button class="btn btn-primary" '+(blocked?'disabled':'')+' onclick="CRM.leadQualifySave()">Qualify → stage 1</button><button class="btn btn-secondary" onclick="CRM.closeDlv()">Cancel</button></div></div>';
    showDlv('Qualify lead',body);
  }
  function leadGate(k,v){ if(qState){ qState.g[k]=(qState.g[k]===v?'todo':v); leadQualifyRender(); } }
  function leadQualifySave(){ var l=leadById(qState.id); if(!l) return; ['receiver','contact','dest','volume','payment'].forEach(function(k){l.gates[k]='pass';}); l.stage=1; l.missing=''; if(l.region==='unmapped') l.region=L_C2R[l.country]||'unmapped'; closeDlv(); toast('<b>'+esc(l.company)+'</b> qualified → assign it to a region.'); render(); }

  function leadOpen(id){
    var l=leadById(id); if(!l) return;
    var gates=L_GATES.map(function(g){var v=l.gates[g.k];return '<div class="l-qgate"><div><div>'+esc(g.label)+'</div><div class="cell-sub">'+(g.src==='auto'?'auto · DalOS':'marketing')+'</div></div>'+(v==='pass'?bdg('badge-pass','pass'):(v==='warn'?bdg('badge-warn','warn'):(v==='fail'?bdg('badge-fail','fail'):bdg('badge-n','to check'))))+'</div>';}).join('');
    var act=l.stage===0?'<button class="btn btn-primary" onclick="CRM.leadQualifyOpen(\''+l.id+'\')">Qualify</button>':(l.stage>=2&&l.stage<6&&l.rep?'<button class="btn btn-primary" onclick="CRM.leadWonOpen(\''+l.id+'\')">Mark shipped</button>':'');
    var body='<div class="l-form"><div class="l-qhdr">'+esc(l.company)+'</div>'
      +'<div class="l-drow"><span class="cell-sub">Lead</span><span class="lot">'+esc(l.id)+'</span></div>'
      +'<div class="l-drow"><span class="cell-sub">Type</span>'+typeBadge(l.type)+'</div>'
      +'<div class="l-drow"><span class="cell-sub">Stage</span>'+stageBadge(l)+'</div>'
      +'<div class="l-drow"><span class="cell-sub">Country · region</span><span>'+esc(l.country)+' · '+esc(l.region)+'</span></div>'
      +'<div class="l-drow"><span class="cell-sub">Product · volume</span><span>'+esc(l.product)+' · '+esc(L_BANDS[l.band])+'</span></div>'
      +'<div class="l-drow"><span class="cell-sub">Contact</span><span>'+esc(l.contact||'—')+(l.role?' · '+esc(l.role):'')+'</span></div>'
      +'<div class="l-drow"><span class="cell-sub">Sourced by</span><span>M · '+esc(l.sourcedBy)+(l.rep?' · rep '+esc(l.rep):'')+'</span></div>'
      +(l.note?'<div class="l-drow"><span class="cell-sub">Note</span><span>'+esc(l.note)+'</span></div>':'')
      +'<div class="l-qsec">Qualification gates</div>'+gates
      +(act?'<div class="l-formact">'+act+'<button class="btn btn-secondary" onclick="CRM.closeDlv()">Close</button></div>':'')+'</div>';
    showDlv('Lead',body);
  }

  function leadAssignOpen(){
    var body='<div class="l-form"><div class="l-formnote">Region is pre-filled from country. Choosing a region overrides the suggestion for all selected. Assigning sets a 5-day SLA and routes to sales inboxes.</div>'
      +'<div class="l-qhdr">Assign to CRM region</div>'
      +L_REGIONS.map(function(r){return '<div class="who" onclick="CRM.leadPickRegion(this)"><div><div class="who-n">'+esc(r)+'</div><div class="who-s">region</div></div></div>';}).join('')
      +'<div class="l-formact"><button class="btn btn-primary" onclick="CRM.leadAssignSave()">Assign selected</button><button class="btn btn-secondary" onclick="CRM.closeDlv()">Cancel</button></div></div>';
    showDlv('Assign to region',body);
  }
  function leadPickRegion(el){ /* visual only in drawer */ var ps=el.parentNode.querySelectorAll('.who'); for(var i=0;i<ps.length;i++) ps[i].classList.remove('sel'); el.classList.add('sel'); }
  function leadAssignSave(){
    var n=0; LEADS.forEach(function(l){ if(l.stage===1&&!l.assigned&&!l.returnClass){ l.assigned=true; l.sla=5; n++; } });
    closeDlv(); toast((n||'Selected')+' qualified lead(s) assigned → sales inbox, 5-day SLA started.'); render();
  }

  function leadEscalateOpen(){
    var seniors=[['Hany M.','Commercial Director · Gulf, Far East'],['Nour A.','Senior Sales Manager · UK & Ireland, E. Med'],['Karim F.','Senior Sales Manager · N. Europe'],['Tarek G.','Managing Director']];
    var body='<div class="l-form"><div class="l-formnote">Escalation assigns directly to a chosen senior member with a fresh SLA, bypassing region. Every escalation is logged.</div>'
      +'<div class="l-qhdr">Escalate untouched leads</div>'
      +seniors.map(function(s){return '<div class="who" onclick="CRM.leadPickRegion(this)"><div><div class="who-n">'+esc(s[0])+'</div><div class="who-s">'+esc(s[1])+'</div></div></div>';}).join('')
      +field('le_note','Note (optional)','','why this needs a senior look')
      +selField('le_sla','New SLA',[['3','3 working days'],['5','5 working days'],['0','No SLA']],'3')
      +'<div class="l-formact"><button class="btn btn-primary" onclick="CRM.leadEscalate()">Escalate</button><button class="btn btn-secondary" onclick="CRM.closeDlv()">Cancel</button></div></div>';
    showDlv('Escalate leads',body);
  }
  function leadEscalate(){ closeDlv(); toast('Selected lead(s) escalated with a fresh SLA.'); render(); }

  function leadAccept(id){ var l=leadById(id); if(!l) return; l.rep=ME; l.stage=2; l.assigned=false; l.sla=null; closeDlv(); toast('<b>'+esc(l.company)+'</b> is now yours — removed from colleagues’ inboxes.'); render(); }

  var passState=null;
  function leadPassOpen(id){ passState={id:id,cls:'B'}; leadPassRender(); }
  function leadPassRender(){
    var l=leadById(passState.id); if(!l) return;
    var reasons=passState.cls==='A'?['Not a genuine receiver','Product/season mismatch','Volume overstated','Certification gap']:['No capacity','Price expectation too low','Credit risk / payment terms','Already sourced elsewhere'];
    var body='<div class="l-form"><div class="l-formnote">Passing keeps the lead visible to other reps; it returns to marketing only when the whole region passes. Class A affects marketing’s rate; Class B does not.</div>'
      +'<div class="l-qhdr">'+esc(l.company)+'</div>'
      +'<div class="l-seg" style="margin-top:8px"><span class="l-segb'+(passState.cls==='A'?' on-fail':'')+'" onclick="CRM.leadPassCls(\'A\')">Class A — qualification</span><span class="l-segb'+(passState.cls==='B'?' on':'')+'" onclick="CRM.leadPassCls(\'B\')">Class B — commercial</span></div>'
      +selField('lp_reason','Reason',reasons.map(function(r){return [r,r];}),reasons[0])
      +'<div class="l-formact"><button class="btn btn-primary" onclick="CRM.leadPass()">Record pass</button><button class="btn btn-secondary" onclick="CRM.closeDlv()">Cancel</button></div></div>';
    showDlv('Pass on lead',body);
  }
  function leadPassCls(c){ if(passState){ passState.cls=c; leadPassRender(); } }
  function leadPass(){
    var l=leadById(passState.id); if(!l) return; var reason=($('lp_reason')||{}).value||'';
    l.passCount=(l.passCount||0)+1;
    if(l.passCount>=3){ l.returnClass=passState.cls; l.returnReason=reason; l.returnBy='region'; l.assigned=false; l.sla=null; closeDlv(); toast('Whole region passed — <b>'+esc(l.company)+'</b> returned to marketing.'); }
    else { closeDlv(); toast('Pass recorded. '+(3-l.passCount)+' rep(s) can still take <b>'+esc(l.company)+'</b>.'); }
    render();
  }

  var wonState=null;
  /* Resolve a lead for the "Mark won" flow from EITHER the dummy funnel (leadById) or a REAL
     My-pipeline row (lmById). Returns {id,company,real}. Real leads open the same picker but
     persistence (converted_by / entity alias) is the Phase-2 job — this pass surfaces the action. */
  function leadWonResolve(id){
    var d=leadById(id); if(d) return {id:id,company:d.company,real:false};
    var r=lmById(id); if(r) return {id:id,company:r.company,real:true};
    return null;
  }
  function leadWonOpen(id){ var l=leadWonResolve(id); if(!l) return; wonState={id:id,kind:'existing',company:l.company,real:l.real}; leadWonRender(); }
  function leadWonRender(){
    if(!wonState) return; var co=wonState.company||'this lead';
    var existing=['Gulf Green Import Co','Meridian Fresh Ltd','AMC Fresh','Total Produce'];
    var body='<div class="l-form"><div class="l-formnote">The invoiced entity often differs from the lead name. Pick the client/sub-client it ships under (or create one). A persistent alias is stored so later shipments attribute automatically.</div>'
      +'<div class="l-qhdr">'+esc(co)+' → shipped</div>'
      +'<div class="l-seg" style="margin-top:8px"><span class="l-segb'+(wonState.kind==='existing'?' on':'')+'" onclick="CRM.leadWonKind(\'existing\')">Existing entity</span><span class="l-segb'+(wonState.kind==='new'?' on':'')+'" onclick="CRM.leadWonKind(\'new\')">Create new</span></div>'
      +(wonState.kind==='existing'?selField('lw_entity','Ships under',existing.map(function(e){return [e,e];}),co):field('lw_entity','New entity name',co,''))
      +'<label class="form-label" style="margin-top:8px"><input type="checkbox" id="lw_alias" checked style="width:auto;margin-right:6px"/>Store alias “'+esc(co)+'” → selected entity</label>'
      +(wonState.real?'<div class="alert-warn" style="margin-top:8px">Conversion write (<span class="mono">converted_by</span> + entity alias) lands with the Phase-2 lead rules — this records intent only.</div>':'')
      +'<div class="l-formact"><button class="btn btn-primary" onclick="CRM.leadWonSave()">Mark shipped → stage 6</button><button class="btn btn-secondary" onclick="CRM.closeDlv()">Cancel</button></div></div>';
    showDlv('Mark as shipped',body);
  }
  function leadWonKind(k){ if(wonState){ wonState.kind=k; leadWonRender(); } }
  function leadWonSave(){ if(!wonState) return; var entity=($('lw_entity')||{}).value||wonState.company; var d=leadById(wonState.id); if(d) d.stage=6; closeDlv(); toast('<b>'+esc(wonState.company)+'</b> shipped under <b>'+esc(entity)+'</b>. Alias stored.'); render(); }

  /* ── Bulk import — REAL (paste rows → INSERT crm_leads, source='csv_import') ── */
  var lmImp=null;
  function lmImportOpen(){
    if(!canManageLeads()){ toast('<b>Not permitted</b> · you can’t create leads'); return; }
    lmImp=null;
    var camps=(CAMP.items||[]).filter(function(c){return c.active;});
    var body='<div class="l-form"><div class="l-formnote">Paste one lead per line. Columns: <b>Company, Country, Product, Contact, Email, Phone</b> — only Company is required; separate multiple products with “;”. Pre-flight checks for duplicates before importing to the real leads list.</div>'
      +(camps.length?selField('li_campaign','Campaign (optional)',[['','— none —']].concat(camps.map(function(c){return [c.id,c.name];})),''):'')
      +'<label class="form-label" style="margin-top:8px">Paste rows / CSV</label><textarea class="form-input" id="li_csv" rows="6" style="font-family:var(--font-mono);font-size:12px" placeholder="Meridian Fresh Ltd, United Kingdom, Grapes, J. Whitfield, jw@meridian.co.uk\nNordfrucht GmbH, Germany, Grapes;Citrus"></textarea>'
      +'<div id="li_pre"></div>'
      +'<div class="l-formact"><button class="btn btn-secondary" onclick="CRM.lmImportPre()">Pre-flight</button><button class="btn btn-primary" id="li_go" disabled onclick="CRM.lmImportRun()">Import ready rows</button><button class="btn btn-secondary" onclick="CRM.closeDlv()">Cancel</button></div></div>';
    showDlv('Bulk import leads',body);
  }
  function lmImpParse(){
    return (($('li_csv')||{}).value||'').split('\n').map(function(x){return x.trim();}).filter(Boolean).map(function(ln){
      var p=ln.split(',').map(function(x){return x.trim();});
      return { company:p[0]||'', country:p[1]||'', product:p[2]||'', contact:p[3]||'', email:p[4]||'', phone:p[5]||'' };
    }).filter(function(r){return r.company;});
  }
  function lmImportPre(){
    var rows=lmImpParse(), ready=[], dup=[], have={}, seen={};
    LM.rows.forEach(function(l){ have[(l.company||'').toLowerCase()]=1; });
    rows.forEach(function(r){ var k=r.company.toLowerCase(); if(have[k]||seen[k]) dup.push(r); else { seen[k]=1; ready.push(r); } });
    lmImp={ready:ready,dup:dup};
    var pre=$('li_pre'); if(pre) pre.innerHTML='<div class="ldp" style="margin-top:10px"><div class="ldp-h">Pre-flight · '+rows.length+' row(s)</div><div style="padding:10px 12px">'
      +'<div class="gate"><span class="gate-i gate-ok">✓</span> '+ready.length+' new lead(s) ready to import</div>'
      +'<div class="gate"><span class="gate-i gate-w">!</span> '+dup.length+' duplicate(s) — already in leads, will be skipped</div></div></div>';
    var go=$('li_go'); if(go) go.disabled=ready.length===0;
  }
  function lmImportRun(){
    if(!canManageLeads()){ toast('<b>Not permitted</b>'); return; }
    if(!lmImp||!lmImp.ready.length){ toast('Run Pre-flight first — nothing ready.'); return; }
    if(!SB){ toast('No connection.'); return; }
    var camp=(($('li_campaign')||{}).value||'')||null;
    var recs=lmImp.ready.map(function(r){
      var prods=r.product?r.product.split(';').map(function(x){return x.trim();}).filter(Boolean).map(function(x){ var m=CAP_PRODUCTS.filter(function(p){return p.toLowerCase()===x.toLowerCase();})[0]; return m||x; }):[];
      return { source:'csv_import', status:'captured', stage:0, company_name:r.company,
        country:r.country||null, product_interest:(prods.length?prods:null),
        contact_name:r.contact||null, email:r.email||null, phone:r.phone||null, campaign_id:camp };
    });
    var btn=$('li_go'); if(btn){ btn.disabled=true; btn.textContent='Importing…'; }
    SB.from('crm_leads').insert(recs).select('id').then(function(res){
      if(res&&res.error){ var pre=$('li_pre'); if(pre) pre.innerHTML='<div class="alert-fail" style="margin-top:10px"><b>Import failed.</b> '+esc(res.error.message||'')+'</div>'; if(btn){btn.disabled=false;btn.textContent='Import ready rows';} return; }
      var n=(res&&res.data&&res.data.length)||recs.length; closeDlv(); toast(n+' lead(s) imported to the enrichment queue.'); lmReload();
    },function(e){ var pre=$('li_pre'); if(pre) pre.innerHTML='<div class="alert-fail" style="margin-top:10px"><b>Import failed.</b> '+esc(String(e))+'</div>'; if(btn){btn.disabled=false;btn.textContent='Import ready rows';} });
  }

  function leadImport(){
    var body='<div class="l-form"><div class="l-formnote">Paste rows or a CSV. Pre-flight classifies every row before anything imports.</div>'
      +selField('li_campaign','Campaign',L_CAMPAIGNS.map(function(c){return [c.id,c.name];}),'C1')
      +selField('li_type','Lead type (all rows)',Object.keys(L_TYPES).map(function(k){return [k,L_TYPES[k]];}),'event')
      +'<label class="form-label" style="margin-top:8px">Paste rows or drop a CSV</label><textarea class="form-input" id="li_csv" rows="4" style="font-family:var(--font-mono);font-size:12px">Meridian Fresh Ltd, UK, grapes\nKingsway Produce Ltd, UK, pomegranate\nNordfrucht GmbH, DE, grapes\nGulf Green Import Co, AE, mango\nNordic Fruit, SE, grapes</textarea>'
      +'<div id="li_pre"></div>'
      +'<div class="l-formact"><button class="btn btn-secondary" onclick="CRM.leadImportPre()">Pre-flight</button><button class="btn btn-primary" id="li_go" disabled onclick="CRM.leadImportRun()">Import ready rows</button><button class="btn btn-secondary" onclick="CRM.closeDlv()">Cancel</button></div></div>';
    showDlv('Bulk import',body); liLast=null;
  }
  var liLast=null;
  function leadImportPre(){
    var raw=($('li_csv')||{}).value||''; var lines=raw.split('\n').map(function(x){return x.trim();}).filter(Boolean);
    var ready=[],blocked=[],dup=[];
    lines.forEach(function(ln){var co=ln.split(',')[0].trim(); if(!co) return; if(L_CLIENTS.some(function(c){return c.toLowerCase()===co.toLowerCase();})) blocked.push(ln); else if(LEADS.some(function(l){return l.company.toLowerCase()===co.toLowerCase();})) dup.push(ln); else ready.push(ln);});
    liLast={ready:ready,blocked:blocked,dup:dup};
    var pre=$('li_pre'); if(pre) pre.innerHTML='<div class="ldp" style="margin-top:10px"><div class="ldp-h">Pre-flight · '+lines.length+' rows</div><div style="padding:10px 12px">'
      +'<div class="gate"><span class="gate-i gate-ok">✓</span> '+ready.length+' new leads ready to import</div>'
      +'<div class="gate"><span class="gate-i gate-no">✕</span> '+blocked.length+' blocked — already active clients <span class="gate-src">hard block</span></div>'
      +'<div class="gate"><span class="gate-i gate-w">!</span> '+dup.length+' possible duplicates <span class="gate-src">warn only</span></div></div></div>';
    var go=$('li_go'); if(go) go.disabled=ready.length===0;
  }
  function leadImportRun(){
    if(!liLast||!liLast.ready.length) return; var camp=($('li_campaign')||{}).value||'C1', type=($('li_type')||{}).value||'event'; var n=0;
    liLast.ready.forEach(function(ln){var p=ln.split(','); var co=(p[0]||'').trim(),country=(p[1]||'').trim(),product=(p[2]||'Grapes').trim(); var seq=1000+LEADS.length+n; LEADS.unshift(mk('LD-2026-0'+seq,co,country||'—',product,type,0,0,ME,'now',{campaign:camp,region:L_C2R[country]||'unmapped',missing:'Contact role · volume band'})); n++;});
    closeDlv(); toast(n+' lead(s) imported at stage 0 — enrichment queue.'); render();
  }

  /* selection sync (bulk bars) */
  function selCount(sel){ var els=document.querySelectorAll(sel); var n=0; for(var i=0;i<els.length;i++) if(els[i].checked) n++; return n; }
  function leadSelSync(){ var n=selCount('.lrs'); var bb=$('lbb'); if(bb) bb.classList.toggle('on',n>0); var t=$('lbbn'); if(t) t.textContent=n+' selected'; }
  function leadSelAll(cb){ var els=document.querySelectorAll('.lrs'); for(var i=0;i<els.length;i++) els[i].checked=cb.checked; leadSelSync(); }
  function leadSelClear(){ var els=document.querySelectorAll('.lrs'); for(var i=0;i<els.length;i++) els[i].checked=false; leadSelSync(); }
  function leadSelSync2(){ var n=selCount('.lrs2'); var bb=$('lbb2'); if(bb) bb.classList.toggle('on',n>0); var t=$('lbbn2'); if(t) t.textContent=n+' selected'; }
  function leadSelAll2(cb){ var els=document.querySelectorAll('.lrs2'); for(var i=0;i<els.length;i++) els[i].checked=cb.checked; leadSelSync2(); }
  function leadSelClear2(){ var els=document.querySelectorAll('.lrs2'); for(var i=0;i<els.length;i++) els[i].checked=false; leadSelSync2(); }
  function leadReturnAct(id){ toast('Action recorded (draft).'); }

  function leadSet(k,v){ leadView[k]=v; render(); }
  function leadSub(dest,key){ LSUB[dest]=key; if(dest==='leads'||dest==='funnel'||dest==='campaigns'){ if(currentTab!==dest){ if(window.CRM) window.CRM.openTab(dest); return; } } render(); }
  /* unified Leads sub-nav driver: switches CRM tab AND in-view sub in one hop (handles inbox/pip too) */
  /* single key identifying the active leads VIEW (not just the tab) so the sidebar buttons highlight precisely */
  function activeLeadKey(){
    if(currentTab==='leads') return LSUB.leads||'ws';
    if(currentTab==='inbox') return LSUB.inbox||'inbox';
    if(currentTab==='funnel') return LSUB.funnel||'board';
    if(currentTab==='campaigns') return 'campaigns';
    return '';
  }
  function leadNav(dest,key){ if(key) LSUB[dest]=key; if(currentTab!==dest){ setTab(dest); } else { render(); if(ON_TAB) ON_TAB(currentTab,activeLeadKey()); } }
  function leadReset(){ seed(); leadView={type:'all',market:'all',stage:'all'}; toast('Demo data reset.'); render(); }

  /* nav-count helpers */
  function leadsEnrichDot(){ return LEADS.filter(function(l){return l.stage===0;}).length; }
  function leadsInboxDot(){ return inboxList().length; }

  return {
    init:init, setSeason:setSeason, teardown:teardown, reload:reload,
    setTab:setTab, openTab:openTab, setRegion:setRegion, setProduct:setProduct, onSearch:onSearch, clearSearch:clearSearch, clearFilters:clearFilters,
    setShipFilter:setShipFilter, resetShipFilters:resetShipFilters, setShipSort:setShipSort, setPage:setPage,
    toggleSubs:toggleSubs, togglePulse:togglePulse, pulseGo:pulseGo, openSubDrill:openSubDrill,
    openShipDetail:openShipDetail, openInsp:openInsp, openCqc:openCqc, closeDlv:closeDlv,
    openClaim:openClaim, openGrade:openGrade, closeModal:closeModal, requestCloseModal:requestCloseModal, saveClaim:ge(saveClaim), saveGrade:ge(saveGrade), cancelClaim:ge(cancelClaim),
    submitSettlement:submitSettlement, beginSettlement:beginSettlement, cancelSettlement:cancelSettlement, claimApprove:claimApprove, claimReject:claimReject, saveThreshold:saveThreshold, setGrade:setGrade, setScope:setScope, togglePotential:togglePotential, syncNet:syncNet, rowSelChanged:rowSelChanged,
    syncClaimPct:syncClaimPct, markClaimPctManual:markClaimPctManual,
    openRedirect:openRedirect, saveRedirect:ge(saveRedirect), setRedirScope:setRedirScope, redirClientChanged:redirClientChanged, redirRowToggle:redirRowToggle, redirPct:redirPct, redirRender:redirRender,
    openInvoice:openInvoice, openInvClaim:openInvClaim, openInvRedirect:openInvRedirect, saveInvClaim:ge(saveInvClaim), saveInvRedirect:ge(saveInvRedirect), invToggle:invToggle, invPct:invPct, invRender:invRender, invRedirClientChanged:invRedirClientChanged,
    openInvEditClaim:openInvEditClaim, openInvEditRedirect:openInvEditRedirect, invCancelClaim:ge(invCancelClaim), invCancelRedirect:ge(invCancelRedirect), setInvLifecycle:setInvLifecycle, crmConfirmOk:crmConfirmOk, redirectFromClaim:ge(redirectFromClaim),
    uploadEvidence:ge(uploadEvidence), evOpen:evOpen, evDel:ge(evDel),
    setCountryOverride:setCountryOverride, setClientOverride:setClientOverride, addClientOverrideFromForm:addClientOverrideFromForm,
    setScoreBand:setScoreBand, removeScoreBand:removeScoreBand, addScoreBandFromForm:addScoreBandFromForm,
    rrOpenDrawer:rrOpenDrawer, rrSetField:rrSetField, rrSaveRule:rrSaveRule, rrToggle:rrToggle, rrDelete:rrDelete, rrMove:rrMove,
    rrToggleDefaults:rrToggleDefaults, rrCreateFor:rrCreateFor, rrCommit:rrCommit, rrDiscard:rrDiscard, rrUndo:rrUndo,
    rrOpenAlias:rrOpenAlias, rrMapAlias:rrMapAlias, rrWhy:rrWhy, rrToggleEngine:rrToggleEngine,
    rrSetRouting:rrSetRouting, rrMembersOpen:rrMembersOpen, rrToggleManager:rrToggleManager,
    lmAssignMemberOpen:lmAssignMemberOpen, lmMemberPick:lmMemberPick, lmAssignMemberSave:lmAssignMemberSave, lmReleaseMember:lmReleaseMember,
    lmRefresh:lmRefresh, lmOpen:lmOpen, lmEnrichOpen:lmEnrichOpen, lmEnrichSave:gm(lmEnrichSave), lmEnrichChip:lmEnrichChip,
    lmQualify:gm(lmQualify), lmAssignOpen:lmAssignOpen, lmPickRegion:lmPickRegion, lmAssignSave:gm(lmAssignSave),
    lmReturnOpen:lmReturnOpen, lmReturnPick:lmReturnPick, lmReturnSave:gs(lmReturnSave), lmRequeueOpen:lmRequeueOpen, lmRequeueSave:gs(lmRequeueSave), lmClaim:gs(lmClaim), lmSetDealStage:lmSetDealStage, lmNoteSave:gs(lmNoteSave), lmParkOpen:lmParkOpen, lmParkChip:lmParkChip, lmParkSave:gs(lmParkSave), lmReactivate:gs(lmReactivate), lmSetParkFilter:lmSetParkFilter, lmSetXs:lmSetXs, lmToggleXsParked:lmToggleXsParked, lmSearch:lmSearch, lmSetF:lmSetF, lmSetPipeAsg:lmSetPipeAsg,
    leadInboxCount:function(){ try{ lmEnsure(); return LM.loaded?inboxList().length:0; }catch(e){ return 0; } },
    leadSub:leadSub, leadNav:leadNav, leadSet:leadSet, leadReset:leadReset, leadOpen:leadOpen,
    leadQuickAdd:leadQuickAdd, leadSubmitQuickAdd:gm(leadSubmitQuickAdd), leadEnrich:gm(leadEnrich),
    lmNewOpen:lmNewOpen, lmNewChip:lmNewChip, lmNewCardPick:lmNewCardPick, lmNewCardRemove:lmNewCardRemove, lmNewSave:gm(lmNewSave), lmNewForce:gm(lmNewForce),
    lmImportOpen:lmImportOpen, lmImportPre:lmImportPre, lmImportRun:gm(lmImportRun),
    leadQualifyOpen:leadQualifyOpen, leadGate:leadGate, leadQualifySave:gm(leadQualifySave),
    leadAssignOpen:leadAssignOpen, leadPickRegion:leadPickRegion, leadAssignSave:gm(leadAssignSave),
    leadEscalateOpen:leadEscalateOpen, leadEscalate:gs(leadEscalate),
    leadAccept:gs(leadAccept), leadPassOpen:leadPassOpen, leadPassCls:leadPassCls, leadPass:gs(leadPass),
    leadWonOpen:leadWonOpen, leadWonKind:leadWonKind, leadWonSave:gs(leadWonSave),
    leadImport:leadImport, leadImportPre:leadImportPre, leadImportRun:gm(leadImportRun),
    leadSelSync:leadSelSync, leadSelAll:leadSelAll, leadSelClear:leadSelClear,
    leadSelSync2:leadSelSync2, leadSelAll2:leadSelAll2, leadSelClear2:leadSelClear2, leadReturnAct:gs(leadReturnAct),
    capSave:gm(capSave), capClear:capClear, capSetCampaign:capSetCampaign, capExport:capExport,
    capScan:capScan, capScanCancel:capScanStop, capOcrPick:capOcrPick,
    capToggleProd:capToggleProd, capType:capType, capQuickTag:capQuickTag, capBulletsToggle:capBulletsToggle, capNotesKey:capNotesKey, capMore:capMore,
    capToggleFollowup:capToggleFollowup, capNotesExpand:capNotesExpand, capNotesClose:capNotesClose, capNotesMirror:capNotesMirror, capOpenDetail:capOpenDetail,
    capAddToHome:capAddToHome, capCopyHomeUrl:capCopyHomeUrl, capDoInstall:capDoInstall, capRemovePhoto:capRemovePhoto,
    capGroupPick:capGroupPick, capRemoveGroup:capRemoveGroup, capSignal:capSignal, capUnmark:capUnmark, capEditLoad:capEditLoad, capDelete:capDelete, capCancelEdit:capCancelEdit, captureDirty:capDirty,
    campNew:gm(campNew), campSave:gm(campSave), campToggle:gm(campToggle), campCopy:campCopy, campQr:campQr,
    campQrDownload:campQrDownload, campLogoPick:campLogoPick, campLogoClear:campLogoClear, campMediaPick:campMediaPick, campMediaClear:campMediaClear, campView:campView, campLightbox:campLightbox, campRefresh:campRefresh, campProdChip:campProdChip
  };
})();
/* ── CRM island CSS (scoped to .crmv) — injected once ── */
function injectCrmCss(){
  if(document.getElementById('crm-island-styles')) return;
  var st=document.createElement('style'); st.id='crm-island-styles';
  st.textContent=`
.crmv{
  --bg:#f0ede6;--bg2:#e8e4da;--bg3:#ddd8cc;
  --sidebar:#1e2d22;--sidebar2:#263529;
  --sidebar-text:#c8d4c0;--sidebar-muted:#6a8068;
  --accent:#2b5c3f;--accent2:#4a8c62;
  --amber:#9a6414;--amber-bg:#fdf3e0;--amber-border:#e8c87a;   /* darkened amber text for WCAG AA on beige (P2-3) */
  --red:#b03030;--red-bg:#faeaea;--red-border:#e8a0a0;
  --green:#1e6b3a;--green-bg:#e8f5ec;--green-border:#8ecba4;
  --text:#1a1a17;--text2:#4a4840;--text3:#6a6658;   /* darkened muted text for AA (P2-3) */
  --border:#d0cbbe;--border2:#bcb8ae;--card:#ffffff;
  --font-display:'DM Serif Display',serif;
  --font-body:'Instrument Sans',sans-serif;
  --font-mono:'DM Mono',monospace;
  --r:8px;--r2:12px;
  --sidebar-w:218px;
}
.crmv *{box-sizing:border-box;margin:0;padding:0}
.crmv{font-family:var(--font-body);background:var(--bg);color:var(--text);font-size:14px;line-height:1.5}
.crmv .app{display:flex;height:100vh;overflow:hidden}

/* ── Sidebar ── */
.crmv .sidebar{width:var(--sidebar-w);background:var(--sidebar);display:flex;flex-direction:column;flex-shrink:0;padding:16px 0}
.crmv .logo{padding:0 18px 16px;border-bottom:1px solid rgba(255,255,255,.06);margin-bottom:12px}
.crmv .logo-name{font-family:var(--font-display);font-size:19px;color:#fff;line-height:1}
.crmv .logo-crop{font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:var(--sidebar-muted);margin-top:5px;display:flex;align-items:center;gap:6px}
.crmv .crop-dot{width:6px;height:6px;border-radius:50%;background:#7b4bd6}
/* season switcher — matches Vision's sidebar pattern (index.html ~L15973) */
.crmv .season-box{margin-top:8px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);border-radius:6px;padding:6px 10px}
.crmv .season-box-lbl{font-size:9px;color:var(--sidebar-muted);text-transform:uppercase;letter-spacing:.1em;margin-bottom:3px}
.crmv .season-box select{font-size:12px;font-weight:700;color:#fff;background:transparent;border:none;outline:none;cursor:pointer;font-family:var(--font-body);padding:0;width:100%}
.crmv .season-box select option{color:var(--text)}
.crmv .nav-label{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#b3aac7;padding:13px 18px 5px;font-weight:600;border-top:1px solid rgba(255,255,255,.06);margin-top:6px}
.crmv .nav-label.nav-sublabel{border-top:none;margin-top:1px;padding:6px 18px 3px 30px;font-size:9px;letter-spacing:.13em;color:var(--sidebar-muted);opacity:.85}
.crmv .nav-item{display:flex;align-items:center;gap:9px;padding:8px 18px;font-size:13px;color:var(--sidebar-text);cursor:pointer;transition:.15s}
.crmv .nav-item svg{width:14px;height:14px;opacity:.65;flex-shrink:0}
.crmv .nav-item:hover{background:var(--sidebar2)}
.crmv .nav-item.active{background:var(--accent);color:#fff;font-weight:500}
.crmv .nav-item.active svg{opacity:1}
.crmv .nav-spacer{margin-top:auto}

/* ── Main ── */
.crmv .main{flex:1;display:flex;flex-direction:column;overflow:hidden}
.crmv .topbar{height:50px;background:var(--bg);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 16px;flex-shrink:0;gap:12px}
.crmv .topbar-title{font-family:var(--font-display);font-size:17px}
.crmv .topbar-right{display:flex;align-items:center;gap:12px}
.crmv .sc-wrap{position:relative;display:inline-block}
.crmv .sc-btn{display:flex;align-items:center;gap:6px;text-align:left;cursor:pointer;width:auto !important;max-width:200px}
.crmv .sc-btn.on{border-color:var(--accent);color:var(--accent);font-weight:600}
.crmv .sc-btn .sc-caret{margin-left:auto;color:var(--text3);font-size:11px}
.crmv .sc-pop{position:absolute;top:calc(100% + 5px);left:0;z-index:60;width:288px;background:var(--card);
  border:1px solid var(--border2);border-radius:9px;box-shadow:0 8px 26px rgba(26,26,23,.16);
  padding:7px 0;max-height:390px;overflow:auto}
.crmv .sc-pop[hidden]{display:none}
.crmv .sc-opt{display:flex;align-items:center;gap:9px;padding:6px 12px;font-size:12.5px;cursor:pointer;color:var(--text2)}
.crmv .sc-opt:hover{background:var(--bg2)}
.crmv .sc-opt input{width:14px;height:14px;accent-color:var(--accent);margin:0;flex:0 0 auto}
.crmv .sc-opt.sc-strong{font-weight:600;color:var(--text)}
.crmv .sc-n{margin-left:auto;font-family:var(--font-mono);font-size:11px;color:var(--text3)}
.crmv .sc-sep{height:1px;background:var(--border);margin:5px 0}
.crmv .sc-head{padding:5px 12px 3px;font-size:9.5px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--text3)}
.crmv .sc-band{display:flex;align-items:center;gap:7px;padding:6px 12px 3px;font-size:9.5px;font-weight:700;
  letter-spacing:.08em;text-transform:uppercase;color:var(--text3)}
.crmv .sc-dot{width:6px;height:6px;border-radius:50%;background:var(--border2);flex:0 0 auto}
.crmv .sc-dot.b1,.crmv .sc-dot.b2{background:var(--green)}
.crmv .sc-dot.b3,.crmv .sc-dot.b4{background:var(--amber)}
.crmv .sc-dot.b5{background:var(--red)}
.crmv .ndot-mute{background:var(--bg2)!important;color:var(--text2)!important;border:1px solid var(--border)!important}
.crmv .staging-badge{display:inline-flex;align-items:center;gap:7px;background:linear-gradient(135deg,#ff6b35 0%,#f7c948 100%);color:#fff;padding:5px 14px 5px 10px;border-radius:20px;box-shadow:0 3px 14px rgba(255,107,53,.45);font-size:10px;font-family:'Courier New',monospace;font-weight:700;letter-spacing:.2em;text-transform:uppercase}
.crmv .staging-dot{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.9);display:inline-block;flex-shrink:0;animation:pulse 1.4s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(1.3)}}
.crmv .avatar{width:28px;height:28px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600}

.crmv .page{flex:1;overflow-y:auto;padding:0 16px 40px}
.crmv .page-inner{max-width:1180px;margin:0 auto}

/* ── Region switcher ── */
/* ── Unified segmented bars: scope bars (Region/Product) + page tabs share one family ── */
.crmv .region-bar{display:flex;align-items:center;gap:8px;margin:14px 0 10px;flex-wrap:wrap}
.crmv .region-switch{display:inline-flex;align-items:center;gap:2px;background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:3px}
.crmv .seg-lbl{font-size:9px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--text3);padding:0 7px 0 9px;user-select:none}
.crmv .region-btn{padding:5px 11px;border-radius:7px;font-size:12px;font-weight:500;color:var(--text3);cursor:pointer;border:1px solid transparent;white-space:nowrap;transition:.15s}
.crmv .region-btn:hover{color:var(--text2)}
.crmv .region-btn.active{background:var(--card);color:var(--accent);border-color:var(--border);font-weight:600}
.crmv .region-btn .rcount{font-family:var(--font-mono);font-size:10px;opacity:.7;margin-left:5px}
.crmv .region-note{font-size:11px;color:var(--text3);font-style:italic}
.crmv .season-sel{width:auto !important;padding:7px 10px !important;font-size:12px !important;border-radius:9px !important;font-weight:500}
.crmv .crm-search{position:relative}
.crmv .crm-search-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.crmv .crm-search-input{position:relative;flex:1;min-width:220px}
.crmv .crm-search-input input{width:100%;padding:9px 32px;border:1px solid var(--border2);border-radius:9px;background:var(--card);font-size:13px;color:var(--text);font-family:var(--font-body);outline:none}
.crmv .crm-search-input input:focus{border-color:var(--accent)}   /* border-only focus, matching Vision forms (no shadow ring) */
.crmv .tool-lbl{font-size:11px;color:var(--text3);white-space:nowrap}
.crmv .fbtn{position:relative;display:inline-flex;align-items:center;gap:8px;padding:7px 11px;border:1px solid var(--border2);border-radius:10px;background:var(--card);cursor:pointer;transition:.15s}
.crmv .fbtn:hover{background:var(--bg2)}
.crmv .fbtn.active{border-color:var(--accent);background:var(--green-bg)}
.crmv .fbtn-cap{font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:700}
.crmv .fbtn.active .fbtn-cap{color:var(--accent)}
.crmv .fbtn-val{font-size:12.5px;font-weight:600;color:var(--text);max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.crmv .fbtn-count{font-family:var(--font-mono);font-size:10px;color:var(--text2);background:var(--bg2);border:1px solid var(--border);border-radius:20px;padding:1px 7px}
.crmv .fbtn.active .fbtn-count{background:#fff;border-color:var(--green-border);color:var(--accent)}
.crmv .fbtn-chev{color:var(--text3);font-size:10px}
.crmv .fbtn-native{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;font-family:var(--font-body)}
.crmv .fclear{font-size:12px;color:var(--accent);font-weight:600;cursor:pointer;padding:7px 4px;white-space:nowrap}
.crmv .fclear:hover{text-decoration:underline}
.crmv .crm-search-ic{position:absolute;left:10px;top:50%;transform:translateY(-50%);font-size:13px;opacity:.55}
.crmv .crm-search-clear{position:absolute;right:9px;top:50%;transform:translateY(-50%);cursor:pointer;color:var(--text3);font-size:17px;line-height:1;display:none}
.crmv .crm-search.has-q .crm-search-clear{display:block}
.crmv .crm-search.has-q .crm-search-clear:hover{color:var(--text)}
.crmv .scope-dd{padding:8px 10px;border:1px solid var(--border2);border-radius:9px;background:var(--card);font-size:12px;font-weight:500;color:var(--text2);font-family:var(--font-body);outline:none;cursor:pointer;max-width:340px}
.crmv .scope-dd:focus{border-color:var(--accent)}

/* ── KPIs ── */
.crmv .kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}
.crmv .kpi{background:var(--card);border:1px solid var(--border);border-radius:var(--r2);padding:12px 14px}
.crmv .kpi[data-go]{cursor:pointer;transition:.15s}
.crmv .kpi[data-go]:hover{border-color:var(--accent)}   /* accent border signals clickable; no elevation shadow (Vision is border-defined) */
.crmv .kpi-label{font-size:11px;color:var(--text3);margin-bottom:4px}
.crmv .kpi-value{font-family:var(--font-display);font-size:26px;line-height:1}
.crmv .kpi-sub{font-size:11px;margin-top:4px;color:var(--text3)}
.crmv .kpi-sub.down{color:var(--red)}
.crmv .kpi-sub.up{color:var(--green)}

/* ── Section title ── */
.crmv .section-title{display:flex;align-items:center;gap:8px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.09em;color:var(--text3);margin:6px 0 10px}
.crmv .section-title-bar{width:20px;height:2px;background:var(--accent);border-radius:2px}
.crmv .section-count{font-family:var(--font-mono);color:var(--text3);font-weight:400;letter-spacing:0}

/* ── Shipment cards ── */
.crmv .card-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
.crmv .ship-card{background:var(--card);border:1px solid var(--border);border-radius:var(--r2);overflow:hidden;display:flex;flex-direction:column;transition:.15s}
.crmv .ship-card.attn{border-color:var(--red-border)}
.crmv .sc-head{padding:12px 14px 10px;border-bottom:1px solid var(--border)}
.crmv .sc-head-top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:6px}
.crmv .sc-container{font-family:var(--font-mono);font-size:14px;font-weight:500;color:var(--text)}
.crmv .sc-split{font-family:var(--font-body);font-size:10px;color:var(--amber);background:var(--amber-bg);border:1px solid var(--amber-border);padding:1px 6px;border-radius:4px;margin-left:6px;vertical-align:1px}
.crmv .sc-meta{font-size:12px;color:var(--text3)}
.crmv .sc-client{font-size:13px;color:var(--text);font-weight:500;margin-top:2px}
.crmv .sc-client .sub{color:var(--text3);font-weight:400}
.crmv .region-chip{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;padding:2px 8px;border-radius:20px;background:var(--bg2);color:var(--text2);border:1px solid var(--border);white-space:nowrap}

.crmv .sc-body{padding:10px 14px;display:flex;flex-direction:column;gap:9px;flex:1}
.crmv .sc-status{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.crmv .sc-update{font-size:11px;color:var(--text3);display:flex;align-items:center;gap:5px}
.crmv .dot-sep{color:var(--border2)}

.crmv .stream{display:flex;gap:8px}
.crmv .stream-box{flex:1;background:var(--bg);border:1px solid var(--border);border-radius:var(--r);padding:8px 10px;min-width:0}
.crmv .stream-label{font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--text3);margin-bottom:4px}
.crmv .stream-line{font-size:12px;color:var(--text2)}
.crmv .stream-line .mono{font-family:var(--font-mono);color:var(--text)}
.crmv .stream-empty{font-size:11px;color:var(--text3);font-style:italic}
.crmv .stream-head{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:4px}
.crmv .stream-head .stream-label{margin-bottom:0}
.crmv .stream-open{font-size:9px;color:var(--accent);font-weight:600;white-space:nowrap;opacity:0;transition:.15s}
.crmv .stream-box.link{cursor:pointer}
.crmv .stream-box.link:hover{border-color:var(--accent);background:var(--green-bg)}
.crmv .stream-box.link:hover .stream-open{opacity:1}
.crmv .toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);background:var(--sidebar);color:#fff;padding:9px 14px;border-radius:8px;font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,.28);z-index:80;display:none;align-items:center;gap:8px;max-width:90%}
.crmv .toast.show{display:flex}
.crmv .toast b{font-family:var(--font-mono);font-weight:500}
/* deep-link stand-in — right-side popup panel (matches Shipments detail) */
.crmv .dlv{position:fixed;inset:0;background:rgba(0,0,0,.42);z-index:70;display:none;justify-content:flex-end}
.crmv .dlv.open{display:flex}
.crmv .dlv-panel{width:560px;max-width:94vw;height:100%;background:var(--bg);box-shadow:-4px 0 22px rgba(0,0,0,.20);display:flex;flex-direction:column;animation:dlvIn .24s cubic-bezier(.32,.72,0,1)}
/* Below 700px the right-side drawer becomes a bottom sheet, matching the rest of
   Vision's mobile convention. Rounded top, grab affordance, capped at 88vh. */
@keyframes dlvUp{from{transform:translateY(100%)}to{transform:translateY(0)}}
@media(max-width:700px){
  .crmv .dlv{align-items:flex-end;justify-content:center}
  .crmv .dlv-panel{width:100%;max-width:100%;height:auto;max-height:88vh;border-radius:16px 16px 0 0;
    box-shadow:0 -4px 22px rgba(0,0,0,.22);animation:dlvUp .24s cubic-bezier(.32,.72,0,1)}
  .crmv .dlv-panel::before{content:'';display:block;flex:0 0 auto;width:38px;height:4px;border-radius:2px;
    background:var(--border2);margin:8px auto 2px}
}
@keyframes dlvIn{from{transform:translateX(36px);opacity:.5}to{transform:translateX(0);opacity:1}}
.crmv .dlv-top{height:50px;background:var(--card);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 16px;flex-shrink:0}
.crmv .dlv-title{font-family:var(--font-display);font-size:17px}
.crmv .dlv-x{cursor:pointer;color:var(--text3);font-size:22px;line-height:1;padding:2px 4px}
.crmv .dlv-x:hover{color:var(--text)}
.crmv .dlv-body{flex:1;overflow-y:auto;padding:16px}
.crmv .dlv-inner{max-width:none}
.crmv .dlv .kpi-grid{grid-template-columns:repeat(2,1fr)}
.crmv .dlv table.wl{min-width:0}
.crmv .standin{background:var(--bg2);border:1px dashed var(--border2);color:var(--text2);font-size:12px;padding:9px 13px;border-radius:8px;margin-bottom:14px;display:flex;gap:8px;align-items:center;line-height:1.4}
.crmv .standin b{color:var(--text);text-transform:uppercase;letter-spacing:.05em;font-size:10px;background:var(--amber-bg);border:1px solid var(--amber-border);color:var(--amber);padding:2px 7px;border-radius:20px;flex-shrink:0}
.crmv .dlv-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:12px}
.crmv .dlv-id{font-family:var(--font-mono);font-size:16px;font-weight:500;color:var(--text)}
.crmv .dlv-meta{font-size:13px;color:var(--text3);margin-top:3px}
.crmv .photos{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
.crmv .photo{width:96px;height:72px;border-radius:8px;background:var(--bg2);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;color:var(--text3);font-size:11px}

.crmv .sc-foot{padding:10px 14px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:8px;background:var(--bg)}
.crmv .coverage{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:500;padding:3px 9px;border-radius:20px;border:1px solid}
.crmv .cov-cqc{background:var(--green-bg);color:var(--green);border-color:var(--green-border)}
.crmv .cov-graded{background:#f0e8ff;color:#6a10b0;border-color:#c090e0}
.crmv .cov-none{background:var(--bg2);color:var(--text3);border-color:var(--border2)}
.crmv .cov-dot{width:6px;height:6px;border-radius:50%;background:currentColor}
.crmv .sc-actions{display:flex;gap:6px}

/* ── Badges ── */
.crmv .badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:500;white-space:nowrap;border:1px solid}
.crmv .b-pass{background:var(--green-bg);color:var(--green);border-color:var(--green-border)}
.crmv .b-warn{background:var(--amber-bg);color:var(--amber);border-color:var(--amber-border)}
.crmv .b-fail{background:var(--red-bg);color:var(--red);border-color:var(--red-border)}
.crmv .b-neutral{background:var(--bg2);color:var(--text2);border-color:var(--border)}
.crmv .b-hold{background:#fff3e0;color:#b06010;border-color:#e8c090}
.crmv .b-esc{background:#e8eeff;color:#2a50c0;border-color:#a0b4e8}
.crmv .mono{font-family:var(--font-mono)}

/* ── Buttons ── */
.crmv .btn{display:inline-flex;align-items:center;gap:5px;padding:7px 14px;border-radius:var(--r);font-size:13px;font-weight:500;cursor:pointer;border:1px solid transparent;white-space:nowrap;background:var(--card);color:var(--text2);transition:.15s;font-family:var(--font-body)}
.crmv .btn:focus-visible,.crmv .tab2:focus-visible,.crmv .fpill:focus-visible,.crmv .pill:focus-visible,.crmv .grade-pill:focus-visible,.crmv .kpi[data-go]:focus-visible,.crmv .region-btn:focus-visible,.crmv .scorecard:focus-visible,.crmv .fbtn:focus-visible,.crmv table.wl tbody tr[data-crm-act]:focus-visible,.crmv .modal-x:focus-visible,.crmv .dlv-x:focus-visible,.crmv .crm-search-clear:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.crmv .btn:active{transform:translateY(1px)}
.crmv .btn-primary{background:var(--accent);color:#fff;border-color:var(--accent)}
.crmv .btn-primary:hover{background:var(--accent2)}
.crmv .btn-secondary{border-color:var(--border2);color:var(--text2)}
.crmv .btn-secondary:hover{background:var(--bg2)}
.crmv .btn-danger{border-color:var(--red-border);color:var(--red);background:var(--red-bg)}
.crmv .btn-danger:hover{background:var(--red);color:#fff;border-color:var(--red)}
.crmv .btn-sm{padding:4px 10px;font-size:12px}

/* ── Modal / forms ── */
.crmv .modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.42);z-index:60;display:none;align-items:center;justify-content:center;padding:16px}
.crmv .modal-bg.open{display:flex}
.crmv .modal{background:var(--card);border-radius:14px;max-width:520px;width:100%;max-height:92vh;overflow-y:auto}
.crmv .modal-head{padding:16px 20px 12px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--card);z-index:2}
.crmv .modal-title{font-family:var(--font-display);font-size:19px}
.crmv .modal-sub{font-family:var(--font-mono);font-size:12px;color:var(--text3);margin-top:3px}
.crmv .modal-body{padding:16px 20px}
.crmv .modal-foot{padding:12px 20px 16px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end;position:sticky;bottom:0;background:var(--card)}
.crmv .modal-x{float:right;cursor:pointer;color:var(--text3);font-size:20px;line-height:1;padding:2px 4px;margin:-2px -4px 0 0}
.crmv .modal-x:hover{color:var(--text)}

.crmv .form-label{display:block;font-size:10px;text-transform:uppercase;font-weight:600;letter-spacing:.05em;color:var(--text3);margin-bottom:5px}
.crmv .form-input,.crmv .form-select,.crmv .form-ta{width:100%;padding:8px 10px;border:1px solid var(--border2);border-radius:6px;background:var(--card);outline:none;font-size:14px;color:var(--text);font-family:var(--font-body)}
.crmv .form-input:focus,.crmv .form-select:focus,.crmv .form-ta:focus{border-color:var(--accent)}
.crmv .form-input.mono{font-family:var(--font-mono)}
.crmv .form-row{margin-bottom:14px}
.crmv .grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.crmv .grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}

/* lifecycle segmented */
.crmv .lifecycle{display:flex;gap:4px;margin-bottom:4px}
.crmv .lc-step{flex:1;text-align:center;padding:8px 6px;border-radius:7px;font-size:12px;font-weight:500;cursor:pointer;border:1px solid var(--border2);background:var(--card);color:var(--text3);position:relative}
.crmv .lc-step .lc-n{display:block;font-size:9px;letter-spacing:.06em;text-transform:uppercase;opacity:.7;margin-bottom:2px}
.crmv .lc-step.sel-open{background:var(--red-bg);border-color:var(--red-border);color:var(--red)}
.crmv .lc-step.sel-ack{background:var(--amber-bg);border-color:var(--amber-border);color:var(--amber)}
.crmv .lc-step.sel-settled{background:var(--green-bg);border-color:var(--green-border);color:var(--green)}
.crmv .lc-step.sel-rejected{background:var(--bg2);border-color:var(--border2);color:var(--text2)}
.crmv .lc-step.sel-closed{background:var(--green-bg);border-color:var(--green-border);color:var(--green)}
.crmv .lc-arrow{align-self:center;color:var(--border2);font-size:12px}

/* scope pills */
.crmv .claim-ro .pill,.crmv .claim-ro .row-opt,.crmv .claim-ro .row-sel,.crmv .claim-ro .dropzone,.crmv .claim-ro .lifecycle,.crmv .claim-ro .chk{pointer-events:none;opacity:.7}
.crmv .pill{padding:5px 12px;border-radius:6px;font-size:12px;font-weight:500;cursor:pointer;border:1px solid var(--border2);background:var(--card);color:var(--text3)}
.crmv .pill.sel{background:var(--accent);color:#fff;border-color:var(--accent)}
.crmv .pill-row{display:flex;gap:6px;margin-bottom:12px}
.crmv .grade-pill{padding:6px 20px;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;border:1px solid var(--border2);background:var(--card);color:var(--text3)}
.crmv .grade-pill.sel{background:var(--accent);color:#fff;border-color:var(--accent)}
.crmv .part-fields{display:none}
.crmv .part-fields.show{display:block}
.crmv .ctx-val{padding:8px 10px;background:var(--bg2);border:1px solid var(--border);border-radius:6px;font-size:13px;color:var(--text);min-height:37px;display:flex;align-items:center;gap:6px}
/* claim: composition-row picker */
.crmv .row-sel{display:flex;flex-direction:column;gap:5px}
.crmv .row-opt{display:flex;align-items:center;gap:9px;padding:8px 10px;border:1px solid var(--border2);border-radius:7px;cursor:pointer;font-size:12px;background:var(--card)}
.crmv .row-opt:has(input:checked){border-color:var(--accent);background:var(--green-bg)}
.crmv .row-opt input{width:14px;height:14px;accent-color:var(--accent);margin:0;flex-shrink:0;cursor:pointer}
.crmv .row-opt-main{flex:1;min-width:0;color:var(--text2);line-height:1.45}
.crmv .row-opt-main b{color:var(--text);font-weight:600}
.crmv .row-opt-main .mono{font-family:var(--font-mono)}
.crmv .row-opt-qty{font-family:var(--font-mono);font-size:11px;color:var(--text3);white-space:nowrap}
.crmv .ctx-tag{font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:var(--text3);background:var(--card);border:1px solid var(--border);padding:1px 6px;border-radius:20px;margin-left:auto;white-space:nowrap}
.crmv .scope-sum{display:none;align-items:center;gap:9px;padding:9px 11px;border:1px solid var(--green-border);background:var(--green-bg);border-radius:7px;font-size:12px;color:var(--text2);line-height:1.4}
.crmv .scope-sum.show{display:flex}
.crmv .scope-sum .ev-check{width:16px;height:16px;border-radius:50%;background:var(--green);color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;flex-shrink:0}
.crmv .scope-sum b{color:var(--text)}
.crmv .chk{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--text2);cursor:pointer;user-select:none}
.crmv .chk input{width:15px;height:15px;accent-color:var(--accent);cursor:pointer;margin:0}
/* claim modal: section headers + closing block + audit trail */
.crmv .msec{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text3);margin:15px 0 9px;padding-top:13px;border-top:1px solid var(--border)}
.crmv .closing-block{border:1px solid var(--green-border);background:var(--green-bg);border-radius:8px;padding:11px;margin-bottom:10px}
.crmv .closing-block .form-label{color:var(--green)}
.crmv .audit{display:flex;flex-direction:column}
.crmv .audit-item{display:flex;gap:9px;padding:5px 0;font-size:12px;align-items:flex-start}
.crmv .audit-dot{width:8px;height:8px;border-radius:50%;background:var(--accent);margin-top:4px;flex-shrink:0;position:relative}
.crmv .audit-item:not(:last-child) .audit-dot:after{content:'';position:absolute;left:3px;top:8px;width:2px;height:100%;background:var(--border)}
.crmv .audit-main{color:var(--text2);flex:1}
.crmv .audit-main b{color:var(--text);font-weight:600}
.crmv .audit-when{color:var(--text3);font-size:11px;white-space:nowrap;font-family:var(--font-mono)}

/* evidence link */
.crmv .evidence{display:flex;flex-direction:column;gap:6px}
.crmv .ev-opt{display:flex;align-items:center;gap:9px;padding:9px 11px;border:1px solid var(--border2);border-radius:7px;cursor:pointer;font-size:12px}
.crmv .ev-opt.sel{border-color:var(--accent);background:var(--green-bg)}
.crmv .ev-opt .ev-radio{width:15px;height:15px;border-radius:50%;border:2px solid var(--border2);flex-shrink:0}
.crmv .ev-opt.sel .ev-radio{border-color:var(--accent);background:var(--accent);box-shadow:inset 0 0 0 2px #fff}
.crmv .ev-opt .ev-main{flex:1}
.crmv .ev-opt .ev-code{font-family:var(--font-mono);color:var(--text);font-size:12px}
.crmv .ev-opt .ev-desc{color:var(--text3);font-size:11px}
.crmv .ev-link{color:var(--accent);font-size:11px;text-decoration:underline;cursor:pointer;white-space:nowrap}
.crmv .ev-code{font-family:var(--font-mono);color:var(--text);font-size:12px}
.crmv .ev-desc{color:var(--text3);font-size:11px}
/* linked CQC (the evidence) */
.crmv .ev-cqc{display:flex;align-items:center;gap:9px;padding:9px 11px;border:1px solid var(--green-border);background:var(--green-bg);border-radius:7px;font-size:12px}
.crmv .ev-cqc .ev-check{width:16px;height:16px;border-radius:50%;background:var(--green);color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;flex-shrink:0}
.crmv .ev-cqc .ev-main{flex:1;min-width:0}
.crmv .ev-cqc-empty{display:flex;align-items:center;gap:8px;padding:9px 11px;border:1px dashed var(--border2);border-radius:7px;font-size:12px;color:var(--text3)}
/* upload dropzone */
.crmv .dropzone{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;text-align:center;padding:16px 12px;margin-top:8px;border:1.5px dashed var(--border2);border-radius:8px;cursor:pointer;transition:.15s;background:var(--bg)}
.crmv .dropzone:hover,.crmv .dropzone.drag{border-color:var(--accent);background:var(--green-bg)}
.crmv .dz-ic{font-size:18px;color:var(--text3);line-height:1}
.crmv .dz-text{font-size:12px;color:var(--text2)}
.crmv .dz-text b{color:var(--text);font-weight:600}
.crmv .dz-browse{color:var(--accent);text-decoration:underline}
.crmv .dz-sub{font-size:10px;color:var(--text3)}
.crmv .ev-files{display:flex;flex-direction:column;gap:5px;margin-top:8px}
.crmv .ev-file{display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid var(--border);border-radius:6px;font-size:12px;background:var(--card)}
.crmv .ev-file .ev-fic{color:var(--accent)}
.crmv .ev-file .ev-fname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text2)}
.crmv .ev-file .ev-fsize{color:var(--text3);font-size:10px;font-family:var(--font-mono)}
.crmv .ev-file .ev-fx{cursor:pointer;color:var(--text3);font-size:14px}
.crmv .ev-file .ev-fx:hover{color:var(--red)}
/* reference (accessible, not evidence) */
.crmv .ev-ref{display:flex;align-items:center;gap:8px;margin-top:10px;padding-top:9px;border-top:1px solid var(--border);font-size:11px}
.crmv .ev-ref-label{font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--text3)}

/* defect grid (grading form) */
.crmv .defect-hdr{display:grid;grid-template-columns:1fr 90px;gap:8px;font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:600;padding:0 2px 6px}
.crmv .defect-row{display:grid;grid-template-columns:1fr 90px;gap:8px;align-items:center;padding:3px 0}
.crmv .defect-row label{font-size:13px;color:var(--text2)}
.crmv .defect-row .form-input{padding:6px 8px;font-family:var(--font-mono);font-size:12px;text-align:right}
.crmv .defect-total{display:grid;grid-template-columns:1fr 90px;gap:8px;align-items:center;background:var(--bg2);border-radius:6px;padding:8px;margin-top:6px}
.crmv .defect-total label{font-size:12px;font-weight:600;color:var(--text)}
.crmv .defect-total .val{font-family:var(--font-mono);font-size:14px;font-weight:600;text-align:right;padding-right:8px}

.crmv .hint{font-size:11px;color:var(--text3);margin-top:5px;line-height:1.4}
.crmv .divider{height:1px;background:var(--border);margin:16px 0}

/* ── Option 2B: tabs live IN the topbar as centered segments; red badges = actual work ── */
/* ── green underline nav (rendered in the CRM-toned topbar) ── */
.crmv .crm-nav{display:flex;align-items:stretch;gap:12px;flex:1;min-width:0;height:100%}
.crmv .ultabs{display:flex;align-items:stretch;gap:2px;flex:1;min-width:0;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none}
.crmv .ultabs::-webkit-scrollbar{display:none}
.crmv .ulgrp{display:flex;align-items:stretch}
.crmv .ulgrp + .ulgrp{margin-left:9px;padding-left:11px;border-left:1px solid rgba(255,255,255,.12)}
.crmv .ulcap{font-family:var(--font-mono);font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:#869a80;font-weight:600;align-self:center;padding:0 7px 0 2px;white-space:nowrap}
.crmv .ultab{position:relative;display:inline-flex;align-items:center;padding:0 14px;font-size:13px;font-weight:500;color:var(--sidebar-text);cursor:pointer;white-space:nowrap;border-bottom:3px solid transparent;transition:color .15s}
.crmv .ultab:hover{color:#fff}
.crmv .ultab.on{color:#fff;border-bottom-color:var(--green-border)}
.crmv .ultab:focus-visible{outline:2px solid var(--green-border);outline-offset:-3px;border-radius:4px}
.crmv .crm-nav .cnt{font-family:var(--font-mono);font-size:10px;font-weight:700;border-radius:9px;padding:1px 5px;line-height:1.4;margin-left:6px}
.crmv .crm-nav .cnt-red{background:#c23b3b;color:#fff}
.crmv .crm-nav .cnt-mut{background:rgba(255,255,255,.16);color:#e3ece0}
.crmv .crm-nav .staging-badge{align-self:center;flex-shrink:0}
.crmv .tabs2{display:inline-flex;gap:1px;background:var(--bg2);border:1px solid var(--border);border-radius:9px;padding:2px;margin:0 auto;flex-wrap:nowrap}
.crmv .tab2{position:relative;padding:5px 13px;border-radius:7px;font-size:12.5px;font-weight:600;color:var(--text3);cursor:pointer;white-space:nowrap;transition:.15s;border:1px solid transparent}
.crmv .tab2:hover{color:var(--text);background:var(--card)}
.crmv .tab2.on{background:var(--accent);color:#fff;box-shadow:0 1px 6px rgba(43,92,63,.3)}
.crmv .ndot{position:absolute;top:-6px;right:-5px;background:var(--red);color:#fff;font-size:8.5px;font-weight:700;font-family:var(--font-mono);border-radius:9px;padding:1px 5px;line-height:1.4;border:2px solid var(--bg)}
/* slim second row fused under the topbar: search + scopes, always visible */
.crmv .subbar{background:var(--bg);border-bottom:1px solid var(--border);padding:7px 16px;flex-shrink:0;box-shadow:0 5px 7px -6px rgba(0,0,0,.1);position:sticky;top:0;z-index:5}
.crmv .subbar-inner{max-width:1180px;margin:0 auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
@media(max-width:900px){.crmv .tabs2{overflow-x:auto;max-width:52vw}}
@media(max-width:767px){.crmv .tab2{padding:4px 9px;font-size:11px}.crmv .topbar-title{display:none}}

/* ── Tables (worklists) ── */
.crmv .table-wrap{background:var(--card);border:1px solid var(--border);border-radius:var(--r2);overflow-x:auto}
.crmv table.wl{width:100%;border-collapse:collapse;min-width:640px}
.crmv table.wl th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--text3);font-weight:600;padding:9px 12px;border-bottom:2px solid var(--border2);white-space:nowrap}
.crmv table.wl td{padding:10px 12px;border-bottom:1px solid var(--border);font-size:13px;color:var(--text2);vertical-align:middle}
.crmv table.wl tbody tr:last-child td{border-bottom:none}
.crmv table.wl tbody tr:hover td{background:var(--bg)}
.crmv .lot{font-family:var(--font-mono);font-size:12px;color:var(--text);white-space:nowrap}
.crmv .cell-sub{font-size:11px;color:var(--text3)}
.crmv .empty-state{padding:34px 16px;text-align:center;color:var(--text3);font-size:13px}
.crmv .sk{display:block;background:linear-gradient(90deg,var(--bg2) 0%,var(--bg3) 50%,var(--bg2) 100%);background-size:200% 100%;animation:dh-shimmer 1.25s ease-in-out infinite;border-radius:6px}
.crmv .right{text-align:right}
.crmv table.wl th.right{text-align:right}   /* numeric headers right-align to sit above their right-aligned figures (text headers stay left via the base rule) */
.crmv table.wl tbody tr[data-crm-act],.crmv table.wl tbody tr.click{cursor:pointer}   /* clickable rows */
/* ── audit fixes: hit targets (P2-4), pager, modal-loading (P1-1), locked dropzone (P1-4), name truncation ── */
.crmv .modal-x,.crmv .dlv-x,.crmv .crm-search-clear{min-width:24px;min-height:24px;display:inline-flex;align-items:center;justify-content:center}
.crmv .link-btn,.crmv .fclear{min-height:24px;display:inline-flex;align-items:center}
@media(pointer:coarse){.crmv .modal-x,.crmv .dlv-x,.crmv .crm-search-clear,.crmv .region-btn,.crmv .fpill,.crmv .pill,.crmv .grade-pill{min-height:32px}}
.crmv .pager-gap{color:var(--text3);padding:0 4px;font-family:var(--font-mono);font-size:12px}
.crmv .modal-bg.crm-modal-loading .modal-body{opacity:.5;pointer-events:none}
.crmv .modal-bg.crm-modal-loading .modal-head::after{content:'Loading claim…';display:block;font-size:11px;color:var(--accent);font-family:var(--font-mono);margin-top:4px}
.crmv .dropzone.dz-locked{opacity:.6;pointer-events:none;position:relative}
.crmv .dropzone.dz-locked::after{content:'Save the claim first, then attach evidence';position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:0 12px;background:var(--bg2);color:var(--text2);font-size:12px;font-style:italic;border-radius:inherit}
.crmv .scorecard-sub,.crmv .scorecard-client{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ── Sub-client scorecards ── */
.crmv .scorecard-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(248px,1fr));gap:10px;margin-bottom:18px}
.crmv .scorecard{background:var(--card);border:1px solid var(--border);border-radius:var(--r2);padding:12px 13px;cursor:pointer;transition:.15s;display:flex;flex-direction:column;gap:9px}
.crmv .scorecard:hover{border-color:var(--accent);box-shadow:0 3px 14px rgba(0,0,0,.07)}
.crmv .scorecard-top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.crmv .scorecard-sub{font-size:14px;font-weight:600;color:var(--text)}
.crmv .scorecard-client{font-size:11px;color:var(--text3)}
.crmv .scorecard-count{font-family:var(--font-display);font-size:24px;line-height:1;color:var(--text);white-space:nowrap}
.crmv .scorecard-count small{font-family:var(--font-body);font-size:10px;color:var(--text3);font-weight:500}
.crmv .scorecard-scores{display:flex;flex-wrap:wrap;gap:4px}
.crmv .sc-chip{min-width:22px;height:22px;padding:0 5px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;font-family:var(--font-mono);border:1px solid}
.crmv .sc-chip.good{background:var(--green-bg);color:var(--green);border-color:var(--green-border)}
.crmv .sc-chip.fair{background:var(--amber-bg);color:var(--amber);border-color:var(--amber-border)}
.crmv .sc-chip.poor{background:var(--red-bg);color:var(--red);border-color:var(--red-border)}
.crmv .sc-chip.graded{background:#f0e8ff;color:#6a10b0;border-color:#c090e0}
.crmv .sc-chip.none{background:var(--bg2);color:var(--text3);border-color:var(--border2)}
.crmv .scorecard-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;border-top:1px solid var(--border);padding-top:8px}
.crmv .scorecard-open{font-size:11px;color:var(--accent);font-weight:600;white-space:nowrap}

/* ── Shipment detail (in-CRM drawer) ── */
.crmv .sc-container.clickable{cursor:pointer}
.crmv .sc-container.clickable:hover{color:var(--accent);text-decoration:underline}
.crmv .detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--border);border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-top:2px}
.crmv .detail-cell{background:var(--card);padding:8px 11px;min-width:0}
.crmv .detail-k{font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:var(--text3);font-weight:600;margin-bottom:2px}
.crmv .detail-v{font-size:13px;color:var(--text);word-break:break-word}
.crmv .detail-v.mono{font-family:var(--font-mono)}
.crmv .scope-lock{display:flex;align-items:center;gap:8px;padding:8px 11px;border:1px dashed var(--border2);background:var(--bg2);border-radius:7px;font-size:11px;color:var(--text3);margin-bottom:12px;line-height:1.4}

/* ── Scale UX: filters, pager, distribution bars, triage ── */
.crmv .filter-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
.crmv .filter-group{display:flex;gap:3px;align-items:center;background:var(--bg2);border:1px solid var(--border);border-radius:9px;padding:3px}
.crmv .fpill{padding:4px 10px;border-radius:6px;font-size:12px;font-weight:500;color:var(--text3);cursor:pointer;border:1px solid transparent;white-space:nowrap}
.crmv .fpill:hover{color:var(--text2)}
.crmv .fpill.active{background:var(--card);color:var(--accent);border-color:var(--border);font-weight:600}
.crmv .sort-select{margin-left:auto;width:auto !important;padding:6px 10px !important;font-size:12px !important}
.crmv .flt-select{width:auto !important;max-width:170px;padding:6px 8px !important;font-size:12px !important;border-radius:8px !important;color:var(--text2)}
.crmv .pager{display:flex;justify-content:space-between;align-items:center;padding:10px 2px 0;font-size:12px;color:var(--text3)}
.crmv .pager-btns{display:flex;gap:6px}
.crmv .pager button[disabled]{opacity:.4;cursor:default;pointer-events:none}
.crmv table.wl tbody tr.click{cursor:pointer}
.crmv .qlink{cursor:pointer;display:inline-block}
.crmv .qlink:hover{filter:brightness(.9)}
.crmv .ilink{cursor:pointer;white-space:nowrap}
.crmv .ilink:hover{color:var(--accent);text-decoration:underline}
.crmv .dist{display:flex;height:8px;border-radius:4px;overflow:hidden;background:var(--bg2)}
.crmv .dist span{display:block;height:100%}
.crmv .dg{background:#4a8c62}.crmv .df{background:#e8c87a}.crmv .dp{background:#c86060}.crmv .dgr{background:#b490e0}.crmv .dn{background:var(--border2)}
.crmv .dist-legend{display:flex;gap:9px;flex-wrap:wrap;font-size:10px;color:var(--text3);margin-top:5px}
.crmv .dist-legend i{font-style:normal;display:inline-flex;align-items:center;gap:3px}
.crmv .dist-legend b{width:7px;height:7px;border-radius:2px;display:inline-block}
.crmv .attn-head{display:flex;justify-content:space-between;align-items:center;gap:10px;margin:2px 0 10px;flex-wrap:wrap}
.crmv .link-btn{font-size:12px;color:var(--accent);font-weight:600;cursor:pointer;white-space:nowrap}
.crmv .link-btn:hover{text-decoration:underline}
.crmv .more-subs{grid-column:1/-1;text-align:center;padding:9px;border:1px dashed var(--border2);border-radius:var(--r2);color:var(--accent);font-size:12px;font-weight:600;cursor:pointer;background:var(--bg2)}
.crmv .more-subs:hover{border-color:var(--accent)}

/* ── Region pulse (Dashboard stats) ── */
.crmv .pulse-panels{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:10px;margin-bottom:16px}
.crmv .pulse-panel{background:var(--card);border:1px solid var(--border);border-radius:var(--r2);padding:11px 13px;min-width:0}
.crmv .pp-title{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);margin-bottom:9px}
.crmv .pipe{display:flex;gap:5px;align-items:stretch;margin-bottom:7px}
.crmv .pstep{flex:1;border-radius:8px;padding:6px 9px;font-size:10px;font-weight:600;min-width:0}
.crmv .pstep b{display:block;font-family:var(--font-display);font-size:18px;font-weight:400;line-height:1.2}
.crmv .pstep small{font-family:var(--font-mono);font-size:9.5px;opacity:.85;display:block;white-space:normal;overflow-wrap:break-word;line-height:1.4}
.crmv .pleg{display:flex;gap:10px;flex-wrap:wrap;font-size:10.5px;color:var(--text3)}
.crmv .pleg i{font-style:normal;display:inline-flex;align-items:center;gap:4px}
.crmv .pleg b{width:8px;height:8px;border-radius:2px;display:inline-block}
.crmv .pcols{display:flex;gap:6px;align-items:flex-end;height:58px;margin-bottom:5px}
.crmv .pcol{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:3px;min-width:0}
.crmv .pcol span{width:100%;border-radius:3px 3px 0 0}
.crmv .pcol i{font-style:normal;font-size:9px;color:var(--text3);font-family:var(--font-mono);white-space:nowrap}
.crmv .flowbar{display:flex;height:11px;border-radius:6px;overflow:hidden;margin-bottom:6px;background:var(--bg2)}
.crmv .flowbar span{height:100%}
.crmv .rk{width:100%;border-collapse:collapse;table-layout:fixed;min-width:0}
.crmv .rk td{padding:5px 4px;font-size:12px;color:var(--text2);border-bottom:1px solid var(--bg2);overflow:hidden}
.crmv .rk tr:last-child td{border-bottom:none}
.crmv .rk tr.go{cursor:pointer}
.crmv .rk tr.go:hover td{background:var(--bg)}
.crmv .rk .nm{font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.crmv .rk .bcol{width:48px}
.crmv .rk .num{font-family:var(--font-mono);font-size:11px;text-align:right;white-space:nowrap;width:74px}
.crmv .rk td:nth-child(4){width:52px}
.crmv .rk td:nth-child(5){width:82px;text-align:right}
.crmv .rk .bar{height:7px;border-radius:4px;background:var(--bg2);overflow:hidden;min-width:36px}
.crmv .rk .bar span{display:block;height:100%;background:var(--accent);opacity:.72}
.crmv .rk-compare{table-layout:auto}
.crmv .rk-compare td:nth-child(4),.crmv .rk-compare td:nth-child(5){width:auto}
.crmv .rk-compare .num{width:auto}
/* Region-rules v2 tables: content-sized columns (override the pulse-table fixed widths) */
.crmv .rk-rules{table-layout:auto}
.crmv .rk-rules td{white-space:normal;vertical-align:middle;padding:6px 8px}
.crmv .rk-rules td:nth-child(4),.crmv .rk-rules td:nth-child(5){width:auto}
.crmv .rk-rules thead td{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--text3);border-bottom:1px solid var(--border)}
.crmv .rk-rules .rr-when{width:auto}
.crmv .rk-rules .num{width:auto;text-align:right;padding-right:14px}
.crmv .rk-rules .rr-act{white-space:nowrap;text-align:right;width:1%}
.crmv .rk-rules .rr-act .link-btn{margin-left:8px}
.crmv .rk-scroll{overflow-x:auto}
.crmv .pchip{font-size:9.5px;font-weight:700;padding:1px 7px;border-radius:9px;white-space:nowrap}
.crmv .pchip.warn{background:var(--red-bg);color:var(--red)}
.crmv .pchip.ok{background:var(--green-bg);color:var(--green)}
.crmv .pchip.mut{background:var(--bg2);color:var(--text3)}

/* ── Leads (draft) ── */
.crmv .l-draft{background:var(--amber-bg);border:1px solid var(--amber-border);color:#7a4a10;border-radius:var(--r);padding:8px 12px;font-size:12px;margin-bottom:14px}
.crmv .l-draft b{color:var(--amber)}
.crmv .l-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
.crmv .l-tb-sep{width:1px;height:20px;background:var(--border2);margin:0 2px}
.crmv .l-toolbar .flt-select,.crmv .l-toolbar .sort-select{padding:5px 8px;font-size:12px;border:1px solid var(--border2);border-radius:6px;background:var(--card);color:var(--text2)}
.crmv .l-mtoggle{font-size:12px;padding:5px 10px;border:1px solid var(--border2);border-radius:20px;color:var(--text2);cursor:pointer;background:var(--card)}
.crmv .l-mtoggle.on{background:var(--accent);border-color:var(--accent);color:#fff}
.crmv .l-bulk{display:flex;gap:10px;align-items:center;background:var(--accent);color:#fff;border-radius:var(--r);padding:8px 12px;margin-bottom:10px;font-size:13px}
.crmv .l-bulk .btn-secondary{background:rgba(255,255,255,.14);border-color:rgba(255,255,255,.35);color:#fff}
.crmv .l-bulk .btn-primary{background:#fff;color:var(--accent);border-color:#fff}
.crmv .l-bulk .link-btn{color:#fff;opacity:.85}
.crmv .l-table td:first-child{text-align:center}
.crmv .l-table input[type=checkbox]{width:15px;height:15px;accent-color:var(--accent);cursor:pointer}
.crmv .l-type{display:inline-block;font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:20px;border:1px solid transparent;white-space:nowrap}
.crmv .lt-event{background:var(--green-bg);color:var(--green);border-color:var(--green-border)}
.crmv .lt-inbound{background:#e8eeff;color:#2a50c0;border-color:#a0b4e8}
.crmv .lt-ref{background:#f0e8ff;color:#6a10b0;border-color:#c090e0}
.crmv .lt-out{background:var(--amber-bg);color:var(--amber);border-color:var(--amber-border)}
.crmv .lt-win{background:var(--bg3);color:var(--text2);border-color:var(--border2)}
.crmv .l-stage{display:inline-block;font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:20px;white-space:nowrap;border:1px solid transparent}
.crmv .l-stage-mkt{background:var(--amber-bg);color:var(--amber);border-color:var(--amber-border)}
.crmv .l-stage-sales{background:var(--green-bg);color:var(--accent);border-color:var(--green-border)}
.crmv .l-stage-won{background:var(--green);color:#fff}
.crmv .l-gp{display:inline-block;font-size:10.5px;font-weight:700;padding:1px 7px;border-radius:9px;white-space:nowrap}
.crmv .l-gp-ok{background:var(--green-bg);color:var(--green)}
.crmv .l-gp-w{background:var(--amber-bg);color:var(--amber)}
.crmv .l-inbox{grid-template-columns:repeat(2,1fr)}
.crmv .l-card{background:var(--card);border:1px solid var(--border);border-radius:var(--r2);padding:13px 14px;display:flex;flex-direction:column;gap:9px}
.crmv .l-card-top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}
.crmv .l-card-co{font-family:var(--font-display);font-size:16px;line-height:1.15}
.crmv .l-gates{display:flex;flex-wrap:wrap;gap:5px}
.crmv .l-gchip{font-size:10px;font-weight:500;padding:2px 7px;border-radius:6px;white-space:nowrap}
.crmv .l-gc-ok{background:var(--green-bg);color:var(--green)}
.crmv .l-gc-w{background:var(--amber-bg);color:var(--amber)}
.crmv .l-gc-f{background:var(--red-bg);color:var(--red)}
.crmv .l-card-meta{display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:11px}
.crmv .l-card-act{display:flex;gap:8px;align-items:center;border-top:1px solid var(--border);padding-top:9px}
.crmv .l-funtabs{display:flex;gap:2px;border-bottom:2px solid var(--border2);margin-bottom:12px;flex-wrap:wrap}
.crmv .l-funhead{display:grid;grid-template-columns:130px 1fr 44px 48px;gap:10px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);padding:0 0 6px}
.crmv .l-funrow{display:grid;grid-template-columns:130px 1fr 44px 48px;gap:10px;align-items:center;padding:5px 0}
.crmv .l-funlab{font-size:12px;color:var(--text2)}
.crmv .l-funbar{background:var(--bg2);border-radius:5px;height:18px;overflow:hidden}
.crmv .l-funfill{height:100%;border-radius:5px;transition:width .2s}
.crmv .l-funfill.is-mkt{background:var(--amber)}
.crmv .l-funfill.is-sales{background:var(--accent)}
.crmv .l-funn{font-family:var(--font-mono);font-size:13px;text-align:right;color:var(--text)}
.crmv .l-funconv{font-family:var(--font-mono);font-size:12px;text-align:right;color:var(--text3)}
.crmv .l-form{font-size:13px}
.crmv .l-formnote{font-size:12px;color:var(--text3);line-height:1.45;margin-bottom:10px}
.crmv .l-formact{display:flex;gap:8px;margin-top:16px}
.crmv .l-qhdr{font-family:var(--font-display);font-size:18px;margin-bottom:6px}
/* lead-detail drawer redesign: hero + sticky action bar */
.crmv .l-detail .l-hero{display:flex;gap:14px;padding:2px 0 12px}
.crmv .l-hero-photo{position:relative;flex:0 0 92px;width:92px;height:115px}
.crmv .l-hero-photo img{width:92px;height:115px;object-fit:cover;border-radius:10px;border:1px solid var(--border);background:#fff;cursor:zoom-in;display:block}
.crmv .l-hero-photo .cell-sub{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;border:1px solid var(--border);border-radius:10px;background:var(--card);font-size:10px;padding:4px}
.crmv .l-hero-mono{display:flex;align-items:center;justify-content:center;border:1px solid var(--border);border-radius:10px;background:linear-gradient(150deg,var(--card),var(--bg2))}
.crmv .l-hero-mono>span:first-child{font-family:var(--font-display);font-size:44px;color:var(--accent);line-height:1}
.crmv .l-hero-badge{position:absolute;left:6px;bottom:6px;font-size:9px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;background:rgba(34,31,43,.72);color:#fff;border-radius:5px;padding:2px 6px}
.crmv .l-hero-status{font-size:11px;font-weight:700;letter-spacing:.01em;padding:2px 10px;border-radius:20px;white-space:nowrap;background:var(--amber-bg);color:var(--amber);border:1px solid var(--amber-border)}
.crmv .l-detail .l-drow{display:grid;grid-template-columns:150px 1fr;gap:12px;align-items:baseline}
.crmv .l-detail .l-drow>span:last-child{text-align:left}
.crmv .l-detail .l-drow>span:first-child{color:var(--text3)}
/* deal-progress stepper */
.crmv .l-stepper{display:flex;align-items:center;flex-wrap:wrap;gap:4px 0}
.crmv .l-step{font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;white-space:nowrap;background:var(--card);border:1px solid var(--border2);color:var(--text3)}
.crmv .l-step.done{background:var(--green-bg);color:var(--green);border-color:transparent}
.crmv .l-step.now{background:var(--accent);color:#fff;border-color:transparent}
.crmv .l-stepbar{width:12px;height:2px;background:var(--border);margin:0 2px;flex:0 0 auto}
.crmv .l-stepbar.done{background:var(--green)}
/* activity timeline + composer */
.crmv .l-compose{display:flex;gap:6px;margin-bottom:12px}
.crmv .l-compose .form-select{width:auto;flex:0 0 auto}
.crmv .l-compose .form-input{flex:1;min-width:0}
.crmv .l-acts{display:flex;flex-direction:column}
.crmv .l-ev{display:flex;gap:11px;padding:9px 0}
.crmv .l-ev+.l-ev{border-top:1px solid var(--border)}
.crmv .l-ev-dot{flex:0 0 8px;width:8px;height:8px;border-radius:50%;background:var(--accent);margin-top:5px}
.crmv .l-ev-b{min-width:0;flex:1}
.crmv .l-ev-t{font-size:13px;color:var(--text2);font-weight:500}
.crmv .l-ev-n{font-size:12.5px;color:var(--text);margin-top:2px;line-height:1.45}
.crmv .l-ev-m{font-size:11px;color:var(--text3);margin-top:2px}
.crmv .l-hero-main{min-width:0;flex:1}
.crmv .l-hero-co{font-family:var(--font-display);font-size:22px;line-height:1.08;color:var(--text)}
.crmv .l-hero-sub{font-size:13px;color:var(--text2);font-weight:600;margin-top:2px}
.crmv .l-hero-chips{display:flex;gap:5px;flex-wrap:wrap;margin-top:9px}
.crmv .l-hero-prov{font-size:11.5px;color:var(--text3);margin-top:9px;line-height:1.5}
.crmv .l-detail .l-actbar{position:sticky;top:0;z-index:3;display:flex;gap:8px;flex-wrap:wrap;margin:0 -16px 6px;padding:11px 16px;background:var(--bg);border-top:1px solid var(--border);border-bottom:1px solid var(--border);box-shadow:0 5px 12px -9px rgba(0,0,0,.4)}
.crmv .l-qsec{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--text3);margin:14px 0 8px}
.crmv .l-qgate{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border)}
.crmv .l-qgate>div:first-child{font-size:13px;color:var(--text2)}
.crmv .l-seg{display:inline-flex;border:1px solid var(--border2);border-radius:6px;overflow:hidden}
.crmv .l-segb{font-size:12px;padding:4px 11px;cursor:pointer;color:var(--text2);background:var(--card);border-right:1px solid var(--border2)}
.crmv .l-segb:last-child{border-right:0}
.crmv .l-segb.on{background:var(--accent);color:#fff}
.crmv .l-segb.on-ok{background:var(--green);color:#fff}
.crmv .l-segb.on-fail{background:var(--red);color:#fff}
.crmv .l-drow{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px}
.crmv .l-drow>span:last-child{text-align:right}
.crmv .l-timeline{display:flex;flex-direction:column;gap:2px}
.crmv .l-tl{display:flex;gap:10px;align-items:flex-start;padding:5px 0;opacity:.75}
.crmv .l-tl.on{opacity:1}
.crmv .l-tldot{width:9px;height:9px;border-radius:50%;background:var(--accent2);margin-top:4px;flex-shrink:0}
.crmv .l-tl.on .l-tldot{background:var(--accent)}
.crmv .l-preflight{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}

/* ── Leads portal (ported from mockup) ── */
.crmv .badge-pass{background:var(--green-bg);border:1px solid var(--green-border);color:var(--green)}
.crmv .badge-warn{background:var(--amber-bg);border:1px solid var(--amber-border);color:var(--amber)}
.crmv .badge-fail{background:var(--red-bg);border:1px solid var(--red-border);color:var(--red)}
.crmv .badge-hold{background:#fff3e0;border:1px solid #e8c090;color:#b06010}
.crmv .badge-park{background:var(--teal-bg,#d7f0ec);border:1px solid #b8e0d9;color:var(--teal,#0f766e)}
/* small metadata chip (parked "last owner", cross-sell "from campaign") */
.crmv .tag{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;padding:2px 8px;border-radius:6px;background:var(--card);color:var(--text2);border:1px solid var(--border2);white-space:nowrap}
.crmv .tag.camp{background:var(--card);color:var(--text2)}
/* cross-sell view */
.crmv .badge.xs-want{background:var(--accent-soft,#efeaff);color:var(--accent);border-color:transparent}
.crmv .xs-flow{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.crmv .xs-arrow{color:var(--border);font-weight:700;margin:0 3px}
.crmv .xs-legend{display:flex;gap:16px;flex-wrap:wrap;font-size:11.5px;color:var(--text3);margin-bottom:12px}
.crmv .xs-legend .badge{margin-right:3px}
.crmv .badge-esc{background:#e8eeff;border:1px solid #a0b4e8;color:#2a50c0}
.crmv .badge-sa{background:#f0e8ff;border:1px solid #c090e0;color:#6a10b0}
.crmv .badge-sr{background:#fff0e8;border:1px solid #e0b090;color:#b04010}
.crmv .badge-n{background:var(--bg2);border:1px solid var(--border2);color:var(--text2)}
.crmv .alert-warn{background:#fff3e0;border:1px solid #e8c090;color:#7a4a10;border-radius:6px;padding:9px 11px;font-size:12px;line-height:1.45}
.crmv .alert-fail{background:var(--red-bg);border:1px solid var(--red-border);color:var(--red);border-radius:6px;padding:9px 11px;font-size:12px;line-height:1.45}
.crmv .alert-ok{background:var(--green-bg);border:1px solid var(--green-border);color:var(--green);border-radius:6px;padding:9px 11px;font-size:12px;line-height:1.45}
.crmv .up{color:var(--green)}
.crmv .down{color:var(--red)}
.crmv .fg{margin-bottom:11px}
.crmv .ldp{border:1px solid var(--border);border-radius:var(--r2);overflow:hidden;background:#fff}
.crmv .ldp-h{background:var(--bg2);padding:9px 13px;font-size:12px;font-weight:600;display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--border)}
.crmv .gset{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
/* show-mode "captured today" tally by the Save button */
.crmv .cap-tally{display:inline-flex;align-items:baseline;gap:7px;white-space:nowrap}
.crmv .cap-tally-n{font-family:var(--font-display,var(--font-body));font-size:26px;line-height:1;font-weight:600;color:var(--accent)}
.crmv .cap-tally-l{font-size:11.5px;color:var(--text3)}
/* in-view sub-tabs */
.crmv .lsub{display:flex;gap:2px;border-bottom:2px solid var(--border2);margin-bottom:14px;overflow-x:auto}
.crmv .lsubt{font-size:13px;padding:8px 12px;cursor:pointer;color:var(--text3);border-bottom:2px solid transparent;margin-bottom:-2px;white-space:nowrap;transition:color .15s}
.crmv .lsubt:hover{color:var(--text2)}
.crmv .lsubt.on{color:var(--accent);border-bottom-color:var(--accent);font-weight:500}
/* live campaign bar */
.crmv .livebar{display:flex;align-items:center;gap:9px;background:var(--sidebar);color:#fff;padding:9px 16px;font-size:12.5px;cursor:pointer;border-radius:var(--r);margin-bottom:12px}
.crmv .livebar strong{font-weight:600}.crmv .livebar .mono{color:var(--sidebar-muted)}
.crmv .livedot{width:7px;height:7px;border-radius:50%;background:#f7c948;flex-shrink:0}
.crmv .livebtn{margin-left:auto;flex-shrink:0}
/* gates */
.crmv .gate{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border);font-size:12px;color:var(--text2)}
.crmv .gate:last-child{border-bottom:none}
.crmv .gate-i{width:15px;height:15px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;font-weight:600}
.crmv .gate-ok{background:var(--green)}.crmv .gate-no{background:var(--red)}.crmv .gate-w{background:var(--amber)}
.crmv .gate-src{margin-left:auto;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3)}
/* funnel bars */
.crmv .fn-row{display:grid;grid-template-columns:132px 1fr 60px;align-items:center;gap:10px;margin-bottom:6px}
.crmv .fn-l{font-size:12px;color:var(--text2)}
.crmv .fn-track{background:var(--bg2);border-radius:4px;height:22px;overflow:hidden;border:1px solid var(--border)}
.crmv .fn-fill{height:100%;background:var(--accent);display:flex;align-items:center;padding-left:7px;color:#fff;font-family:var(--font-mono);font-size:11px;white-space:nowrap}
.crmv .fn-pct{font-family:var(--font-mono);font-size:12px;color:var(--text3);text-align:right}
/* kanban */
.crmv .kan{display:flex;gap:9px;overflow-x:auto;padding-bottom:8px}
.crmv .col{flex:0 0 210px;background:var(--bg2);border:1px solid var(--border);border-radius:var(--r2);padding:9px;display:flex;flex-direction:column;gap:8px}
.crmv .col-h{display:flex;align-items:center;gap:6px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--text3)}
.crmv .col-n{margin-left:auto;font-family:var(--font-mono);font-size:11px;background:#fff;border:1px solid var(--border2);border-radius:4px;padding:0 5px}
.crmv .lc{background:#fff;border:1px solid var(--border);border-radius:var(--r);padding:9px 10px;cursor:pointer;transition:border-color .15s}
.crmv .lc:hover{border-color:var(--border2)}
.crmv .lc-t{font-size:13px;font-weight:500;color:var(--text);line-height:1.3}
.crmv .lc-m{font-size:11px;color:var(--text3);margin-top:3px}
.crmv .lc-f{margin-top:7px;display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.crmv .stripe{height:2px;border-radius:2px;margin:-9px -10px 8px;background:var(--accent)}
/* sla pills */
.crmv .sla{font-family:var(--font-mono);font-size:11px;padding:2px 7px;border-radius:4px;border:1px solid;white-space:nowrap}
.crmv .sla-ok{background:var(--green-bg);border-color:var(--green-border);color:var(--green)}
.crmv .sla-w{background:var(--amber-bg);border-color:var(--amber-border);color:var(--amber)}
.crmv .sla-x{background:var(--red-bg);border-color:var(--red-border);color:var(--red)}
/* inbox cards */
.crmv .inb{border:1px solid var(--border);border-radius:var(--r2);background:#fff;padding:12px 14px;margin-bottom:9px}
.crmv .inb-h{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.crmv .inb-t{font-size:14px;font-weight:600;color:var(--text)}
.crmv .chips{display:flex;gap:5px;flex-wrap:wrap;margin-top:7px;margin-bottom:2px}
/* consolidated inbox lead card (quick-wins redesign) */
.crmv .inb-lead{position:relative;padding:13px 15px 12px 16px;overflow:hidden}
.crmv .inb-lead::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--accent)}
.crmv .inb-lead .inb-t{font-family:var(--font-display,var(--font-body));font-size:18px;font-weight:400;line-height:1.15}
.crmv .rgtag{font-size:11px;font-weight:600;color:var(--text2);border:1px solid var(--border2);border-radius:6px;padding:1px 8px}
.crmv .inb-age{font-size:11px;font-weight:600;color:var(--text3);white-space:nowrap}
.crmv .inb-age.hot{color:var(--red)}
.crmv .inb-status{font-size:11px;font-weight:700;letter-spacing:.01em;padding:3px 10px;border-radius:20px;white-space:nowrap;background:var(--amber-bg);color:var(--amber);border:1px solid var(--amber-border)}
.crmv .inb-status.pk{background:var(--teal-bg,#d7f0ec);color:var(--teal,#0f766e);border-color:#b8e0d9}
.crmv .pk-lead::before{background:var(--teal,#0f766e)}
.crmv .pk-when{font-size:11px;font-weight:600;padding:2px 8px;border-radius:6px;white-space:nowrap;background:var(--bg2);color:var(--text2);border:1px solid var(--border2)}
.crmv .pk-when.due{background:var(--amber-bg);color:var(--amber);border-color:var(--amber-border)}
.crmv .inb-meta{margin-top:7px;font-size:12.5px;color:var(--text3);line-height:1.5}
.crmv .inb-meta .wname{color:var(--text2);font-weight:600}
.crmv .inb-meta .dot{color:var(--border);margin:0 7px}
.crmv .inb-f{display:flex;align-items:center;margin-top:11px;padding-top:9px;border-top:1px solid var(--border)}
.crmv .inb-ref{font-size:11px;color:var(--text3)}
.crmv .inb-ref .lot{color:var(--text3)}
.crmv .inb-rghdr{display:flex;align-items:center;gap:10px;margin:18px 2px 9px}
.crmv .inb-rghdr .rn{font-family:var(--font-display,var(--font-body));font-size:15px;font-weight:400;color:var(--text)}
.crmv .inb-rghdr .route{font-size:10px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;padding:2px 9px;border-radius:20px;background:var(--bg2);color:var(--text2)}
.crmv .inb-rghdr .route.assign{background:var(--accent-soft,var(--bg2));color:var(--accent)}
.crmv .inb-rghdr .route.claim{background:var(--green-bg);color:var(--green)}
.crmv .inb-rghdr .line{flex:1;height:1px;background:var(--border)}
.crmv .inb-rghdr .cnt{font-family:var(--font-mono);font-size:11.5px;color:var(--text3)}
/* bulk bar */
.crmv .bulkbar{display:none;align-items:center;gap:7px;flex-wrap:wrap;background:var(--bg2);border:1px solid var(--border2);border-radius:var(--r);padding:7px 10px;margin-bottom:10px;font-size:12px;color:var(--text2)}
.crmv .bulkbar.on{display:flex}
/* capture */
.crmv .capgrid{display:grid;grid-template-columns:repeat(2,1fr);gap:9px}
.crmv .capbtn{display:flex;flex-direction:column;align-items:flex-start;gap:3px;background:#fff;border:1px solid var(--border2);border-radius:var(--r2);padding:13px;cursor:pointer;font-family:var(--font-body);text-align:left;min-height:70px;transition:border-color .15s,background .15s}
.crmv .capbtn:hover{border-color:var(--accent);background:var(--green-bg)}
.crmv .capt{font-size:14px;font-weight:600;color:var(--text)}
.crmv .caps{font-size:11px;color:var(--text3);line-height:1.35}
.crmv .qr{width:88px;height:88px;flex-shrink:0;border:1px solid var(--border2);border-radius:6px;background:repeating-linear-gradient(90deg,var(--text) 0 6px,#fff 6px 12px),repeating-linear-gradient(0deg,var(--text) 0 6px,#fff 6px 12px);background-blend-mode:multiply}
/* show-mode capture chips / tags / notes */
.crmv .capchips{display:flex;flex-wrap:wrap;gap:7px;margin:3px 0 2px}
.crmv .capchip{display:inline-flex;align-items:center;gap:4px;padding:8px 13px;border:1px solid var(--border2);border-radius:999px;background:#fff;font-family:var(--font-body);font-size:13px;color:var(--text2);cursor:pointer;min-height:36px;line-height:1;transition:background .12s,border-color .12s,color .12s;-webkit-tap-highlight-color:transparent}
.crmv .capchip:hover{border-color:var(--accent)}
.crmv .capchip.on{background:var(--green);border-color:var(--green);color:#fff;font-weight:600}
.crmv .capchip.sm{padding:6px 11px;font-size:12px;min-height:32px}
.crmv .captag{display:inline-flex;align-items:center;padding:7px 12px;border:1px dashed var(--accent);border-radius:999px;background:transparent;font-family:var(--font-body);font-size:12.5px;color:var(--accent);cursor:pointer;min-height:34px;line-height:1;transition:background .12s;-webkit-tap-highlight-color:transparent}
.crmv .captag:hover{background:var(--green-bg)}
.crmv .cap-bt{margin-left:auto;padding:5px 11px;border:1px solid var(--border2);border-radius:999px;background:#fff;font-family:var(--font-body);font-size:12px;color:var(--text3);cursor:pointer;min-height:28px}
.crmv .cap-bt[data-on="1"]{background:var(--green);border-color:var(--green);color:#fff;font-weight:600}
.crmv .cap-more-btn{width:100%;text-align:left;display:flex;align-items:center;gap:8px;padding:11px 13px;margin:2px 0 10px;border:1px solid var(--border2);border-radius:var(--r2);background:var(--bg2);font-family:var(--font-body);font-size:13px;font-weight:600;color:var(--text2);cursor:pointer}
.crmv .cap-more-btn:hover{border-color:var(--accent)}
/* full-screen notes pad (Show Mode) */
.crmv .cap-notes-ov{position:fixed;inset:0;z-index:1200;background:rgba(20,30,25,.5);backdrop-filter:blur(2px);display:none;align-items:center;justify-content:center;padding:16px}
.crmv .cap-notes-ov.open{display:flex}
.crmv .cap-notes-ovcard{background:var(--bg);border:1px solid var(--border);border-radius:var(--r2);width:100%;max-width:640px;max-height:92vh;display:flex;flex-direction:column;padding:16px;box-shadow:0 20px 60px rgba(0,0,0,.3)}
.crmv .cap-notes-ovhead{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.crmv .cap-notes-ovt{font-family:var(--font-serif,var(--font-body));font-size:16px;font-weight:600;color:var(--text)}
.crmv .cap-notes-bigta{flex:1;min-height:38vh;font-size:16px !important;line-height:1.5;resize:none}
@media(max-width:767px){
  .crmv .cap-notes-ov{padding:0}
  .crmv .cap-notes-ovcard{max-width:100%;height:100dvh;max-height:100dvh;border-radius:0;border:0;padding:calc(14px + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right)) calc(14px + env(safe-area-inset-bottom)) calc(16px + env(safe-area-inset-left))}
  /* keep the Done/Bullets header tappable below the notch/status bar in installed (standalone) mode */
  .crmv .cap-notes-ovhead{position:sticky;top:0;z-index:1;background:var(--bg);padding-bottom:6px}
  .crmv .cap-notes-bigta{min-height:0}
}
/* who / region pick rows (drawers) */
.crmv .who{display:flex;align-items:center;gap:7px;padding:9px 10px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;cursor:pointer;background:#fff;transition:border-color .15s}
.crmv .who:hover{border-color:var(--border2)}
.crmv .who.sel{border-color:var(--accent);background:var(--green-bg)}
.crmv .who-n{font-size:13px;color:var(--text);font-weight:500}
.crmv .who-s{font-size:10px;color:var(--text3)}

/* ── Leads portal primitives (mockup classes the .crmv scope didn't already define) ──
   Scoped to .lead-portal so plain <table>/.card/.kpi-* don't collide with the CRM island's
   own table.wl / .kpi-label primitives. This is the fix for the leads views rendering unstyled. */
.crmv .lead-portal .card{background:var(--card);border:1px solid var(--border);border-radius:var(--r2);padding:14px 16px}
.crmv .lead-portal .kpi-grid{margin-bottom:12px}
.crmv .lead-portal .kpi-l{font-size:11px;color:var(--text3)}
.crmv .lead-portal .kpi-v{font-family:var(--font-display);font-size:26px;line-height:1.15;margin-top:2px}
.crmv .lead-portal .kpi-s{font-size:11px;margin-top:2px;color:var(--text3)}
.crmv .lead-portal .table-wrap{background:transparent;border:0;border-radius:0;overflow-x:auto}
.crmv .lead-portal table{width:100%;border-collapse:collapse;min-width:600px}
.crmv .lead-portal thead th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--text3);text-align:left;padding:0 10px 7px;border-bottom:2px solid var(--border2);font-weight:600;white-space:nowrap}
.crmv .lead-portal tbody td{font-size:13px;color:var(--text2);padding:9px 10px;border-bottom:1px solid var(--border);vertical-align:middle}
.crmv .lead-portal tbody tr:last-child td{border-bottom:none}
.crmv .lead-portal tbody tr{cursor:pointer;transition:background .15s}
.crmv .lead-portal tbody tr:hover{background:var(--bg)}
.crmv .lead-portal .note{background:var(--bg2);border:1px dashed var(--border2);border-radius:var(--r);padding:9px 11px;font-size:11px;color:var(--text2);line-height:1.5;margin-top:10px}
/* .lot renders as a mono chip inside the leads views + their drawers (the base .crmv .lot is plain text) */
.crmv .lead-portal .lot,.crmv .l-form .lot,.crmv .ldp .lot{font-family:var(--font-mono);font-size:11px;background:var(--bg2);border-radius:4px;padding:2px 5px;color:var(--text);white-space:nowrap}
/* leads sub-nav back-crumb in the toned-green header */
.crmv .ultab.ul-back{color:#93a68c;font-size:12px;padding-right:12px}
.crmv .ultab.ul-back:hover{color:#fff}

/* ── Responsive ── */
@media(max-width:1024px){
  .crmv .kpi-grid{grid-template-columns:repeat(2,1fr)}
  .crmv .card-grid{grid-template-columns:1fr}
}
@media(max-width:767px){
  .crmv .sidebar{display:none}
  .crmv .kpi-grid{grid-template-columns:repeat(2,1fr)}
  .crmv .card-grid{grid-template-columns:1fr}
  .crmv .stream{flex-direction:column}
  .crmv .grid2,.crmv .grid3{grid-template-columns:1fr}
  .crmv .l-inbox{grid-template-columns:1fr}
  .crmv .l-funhead,.crmv .l-funrow{grid-template-columns:96px 1fr 38px 42px;gap:7px}
  .crmv .capgrid{grid-template-columns:1fr}
  .crmv .fn-row{grid-template-columns:92px 1fr 44px;gap:7px}
  .crmv input,.crmv select,.crmv textarea{font-size:16px !important}
  /* phone-fit hardening: nothing in the island may exceed the viewport width */
  .crmv,.crmv .page,.crmv .page-inner,.crmv #viewContent,.crmv .lead-portal{max-width:100vw}
  .crmv .lead-portal input,.crmv .lead-portal select,.crmv .lead-portal textarea{max-width:100%;min-width:0;box-sizing:border-box}
  .crmv .grid2>*,.crmv .grid3>*{min-width:0}
  .crmv .table-wrap{max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}
  .crmv .lead-portal .card{padding:12px}
  .crmv .capbtn{min-height:auto;padding:11px 12px}
  .crmv .crm-nav,.crmv .ultabs{max-width:100vw;overflow-x:auto;-webkit-overflow-scrolling:touch}
  .crmv .form-label{white-space:normal;overflow-wrap:anywhere}
  #cap_head select{max-width:100%}
}

/* ── host-integration overrides: island flows inside Vision's page scroll ── */
.crmv{min-height:100%}
.crmv .page{overflow:visible;padding:0 16px 40px}
.crmv .crm-header{display:flex;justify-content:center;padding:12px 16px 0}

/* ── Access-control affordances (pass 1) — perm classes set on the .crmv root in init() ──
   perm-ro-crm: no editCRM → hide claim/grade/redirect write buttons so the CRM tabs read as
   view-only (behaviour is also blocked via the dispatcher/ge() guards). */
.crmv.perm-ro-crm [data-crm-act="openClaim"],
.crmv.perm-ro-crm [data-crm-act="openGrade"],
.crmv.perm-ro-crm [data-crm-act="dlvClaim"],
.crmv.perm-ro-crm [data-crm-act="dlvGrade"],
.crmv.perm-ro-crm [data-crm-act="dlvRedirect"],
.crmv.perm-ro-crm [data-crm-act="invClaim"],
.crmv.perm-ro-crm [data-crm-act="invRedirect"],
.crmv.perm-ro-crm [data-crm-act="invEditClaim"],
.crmv.perm-ro-crm [data-crm-act="invEditRedirect"],
.crmv.perm-ro-crm [data-crm-act="cancelRedirect"]{display:none!important}

/* ═══════════ SHOW MODE capture redesign (2026-08) — conversation-ordered, compact, Pewter polish ═══════════ */
.crmv .cap-head-row{display:flex;align-items:flex-start;gap:9px;margin-bottom:10px}
.crmv .cap-title{font-family:var(--font-display);font-size:20px;color:var(--text);line-height:1.05}
.crmv .cap-titlesub{font-size:11px;color:var(--text2);margin-top:1px}
/* conversation-stage headers */
.crmv .capstage{display:flex;align-items:center;gap:10px;margin:16px 0 9px}
.crmv .capstage .num{flex:0 0 auto;width:23px;height:23px;border-radius:7px;background:color-mix(in srgb,var(--accent) 15%,var(--card));color:var(--accent);font-family:var(--font-mono);font-size:12px;font-weight:700;display:inline-flex;align-items:center;justify-content:center}
.crmv .capstage .swrap{display:flex;flex-direction:column;gap:1px;min-width:0}
.crmv .capstage .lbl{font-size:13.5px;font-weight:700;color:var(--text);line-height:1.1}
.crmv .capstage .cue{font-size:11px;color:var(--text2)}
.crmv .capstage .bar{flex:1;height:1px;background:var(--border);margin-left:4px}
.crmv .req{color:var(--accent)}
.crmv .form-label .lmuted{text-transform:none;letter-spacing:0;font-weight:500;color:var(--text3)}
/* contrast + readable labels (scoped to the leads/capture portal so claims/shipments forms are untouched) */
.crmv .lead-portal .form-label{color:var(--text2);text-transform:none;letter-spacing:0;font-size:11px;font-weight:600}
.crmv .caps{color:var(--text2)}
/* selected chip state = VIOLET (was green, a Vision leftover); green now reads only as "synced" */
.crmv .capchip.on{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.crmv .cap-bt[data-on="1"]{background:var(--accent);border-color:var(--accent);color:#fff}
.crmv .capbtn:hover{background:color-mix(in srgb,var(--accent) 8%,transparent)}
/* comfortable tap targets (density comes from rhythm, not shrinking the target) */
.crmv .capchip{min-height:32px;padding:6px 12px}
.crmv .capchip.sm{min-height:30px;padding:5px 11px}
/* compact capture row: two tools side-by-side, shorter buttons; group photo single-line */
.crmv .capgrid{grid-template-columns:repeat(2,1fr);gap:7px}
.crmv .capbtn{min-height:auto;padding:8px 10px;gap:1px}
.crmv .capbtn.cap-group{flex-direction:row;align-items:center;gap:8px;padding:7px 11px}
.crmv .capbtn.cap-group .caps{margin-left:auto;text-align:right;font-size:9.5px}
.crmv .capbtn-ic{width:15px;height:15px;vertical-align:-3px;margin-right:6px;opacity:.75;color:var(--accent)}
/* option TILES — checkable cards (chosen over pills); capture pane only, enrich keeps .capchip */
.crmv .opt-tiles{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
.crmv .opt-tile{display:flex;align-items:center;gap:9px;padding:10px 12px;min-height:46px;background:#fff;border:1px solid var(--border2);border-radius:12px;font-family:var(--font-body);font-size:13px;color:var(--text2);cursor:pointer;text-align:left;line-height:1.2;transition:background .12s,border-color .12s,color .12s,box-shadow .12s,transform .08s}
.crmv .opt-tile:active{transform:scale(.98)}
.crmv .opt-tile .tk{width:19px;height:19px;flex:0 0 auto;border-radius:6px;border:1.5px solid var(--border2);display:flex;align-items:center;justify-content:center;font-size:12px;color:transparent}
.crmv .opt-tile.on{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 8%,#fff);color:var(--text);font-weight:600;box-shadow:0 1px 2px rgba(34,31,43,.10)}
.crmv .opt-tile.on .tk{background:var(--accent);border-color:var(--accent);color:#fff}
/* ── ELITE lift (materials / wells / masthead / save bar) — Pewter, additive ── */
.crmv .lead-portal .card{border-color:var(--border2);box-shadow:0 1px 2px rgba(34,31,43,.05),0 12px 32px -16px rgba(34,31,43,.20)}
.crmv .lead-portal .form-input{background:#fff;border-color:var(--border2);transition:border-color .15s,box-shadow .15s}
.crmv .lead-portal .form-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 16%,transparent);outline:none}
.crmv .lead-portal .form-input:not(:placeholder-shown){border-color:var(--border)}
.crmv .cap-title{font-size:26px;letter-spacing:-.01em}
.crmv .cap-titlesub{text-transform:uppercase;letter-spacing:.12em;color:var(--text3)}
@media(max-width:767px){ .crmv .cap-head-row .cap-title{font-size:23px} }
.crmv .cap-actions{box-shadow:0 -8px 20px -12px rgba(34,31,43,.22)}
.crmv .cap-actions .btn-primary{background:linear-gradient(180deg,var(--accent),var(--accent2));box-shadow:0 1px 2px rgba(34,31,43,.18);letter-spacing:.01em}
.crmv .cap-actions .btn-primary:hover{background:var(--accent2)}
.crmv .capbtn{background:#fff;box-shadow:0 1px 2px rgba(34,31,43,.05)}
.crmv .capbtn-ic{width:28px;height:28px;padding:6px;margin-right:8px;border-radius:8px;background:color-mix(in srgb,var(--accent) 12%,#fff);color:var(--accent);opacity:1;box-sizing:border-box;vertical-align:middle}
.crmv .form-input.scanned{background:color-mix(in srgb,var(--accent) 5%,#fff)}
.crmv .capstage{margin:22px 0 10px}
.crmv .capstage:first-of-type{margin-top:10px}
/* stage-progress rail */
.crmv .cap-rail{display:flex;align-items:center;gap:5px;margin:10px 0 2px}
.crmv .cap-rail-seg{flex:1;height:3px;border-radius:3px;background:var(--border);transition:background .25s ease}
.crmv .cap-rail-seg.done{background:var(--accent)}
.crmv .cap-rail-n{flex:0 0 auto;font-family:var(--font-mono);font-size:11px;color:var(--text3);margin-left:4px}
.crmv .cap-rail-n b{color:var(--accent);font-weight:500}
.crmv .capstage.done .num{background:var(--accent);color:#fff}
.crmv .capstage.done .bar{background:color-mix(in srgb,var(--accent) 40%,var(--border))}
/* masthead hero stat (captured today) */
.crmv .cap-head-row{align-items:flex-start}
.crmv .cap-mast{min-width:0}
.crmv .cap-hstat{margin-left:auto;text-align:center;padding:6px 13px;border:1px solid var(--border2);border-radius:var(--r2);background:color-mix(in srgb,var(--accent) 6%,#fff);flex:0 0 auto}
.crmv .cap-hstat .cap-tally{display:flex;flex-direction:column;align-items:center;gap:0}
.crmv .cap-hstat .cap-tally-n{font-family:var(--font-display);font-size:23px;color:var(--accent);line-height:1}
.crmv .cap-hstat .cap-tally-l{font-size:9.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--text2)}
.crmv .cap-hstat .cell-sub{display:none}
/* Add-to-Home pill in the context row */
.crmv .cap-home{font-size:11px;color:var(--text2);border:1px solid var(--border2);border-radius:999px;padding:5px 11px;background:transparent;cursor:pointer;font-family:var(--font-body)}
.crmv .cap-home:hover{border-color:var(--accent);color:var(--accent)}
/* keyboard-up: slide the sticky Save bar away so it can't cover the focused field */
.crmv .cap-actions{transition:transform .2s ease}
.crmv .cap-actions.kb{transform:translateY(130%)}
@media (prefers-reduced-motion: reduce){ .crmv *{animation:none!important;transition:none!important} .crmv .cap-actions.kb{transform:none;opacity:0;pointer-events:none} }
/* verify-me cue: scan/OCR-filled fields carry an accent bar until edited */
.crmv .form-input.scanned{border-left:3px solid var(--accent)}
/* lead-signal dots in the session list */
.crmv .cap-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px;vertical-align:middle}
.crmv .cap-dot.hot{background:var(--red)}
.crmv .cap-dot.warm{background:var(--amber)}
.crmv .cap-you{display:inline-block;font-size:10px;font-weight:700;color:#fff;background:var(--accent);border-radius:999px;padding:1px 8px}
/* OCR/QR processing indicator — animated DalOS mark in a dark chip + banner */
.crmv .cap-busy{display:flex;align-items:center;gap:11px;padding:10px 12px;margin-bottom:10px;background:color-mix(in srgb,var(--accent) 7%,var(--card));border:1px solid color-mix(in srgb,var(--accent) 30%,var(--border));border-radius:12px}
.crmv .cap-busy-mark{width:32px;height:32px;flex:0 0 32px;border-radius:8px;background:var(--sidebar);padding:4px;box-sizing:border-box}
.crmv .cap-busy-txt{font-size:13px;font-weight:600;color:var(--accent)}
.crmv .cap-busy-mark svg path{stroke-dasharray:58;animation:capmk-trace 1.9s ease-in-out infinite}
.crmv .cap-busy-mark svg>circle{transform-box:fill-box;transform-origin:center;animation:capmk-peak 1.9s ease-in-out infinite}
.crmv .cap-busy-mark svg g circle{transform-box:fill-box;transform-origin:center;animation:capmk-pop 1.9s ease-in-out infinite}
@keyframes capmk-trace{0%{stroke-dashoffset:58}45%{stroke-dashoffset:0}75%{stroke-dashoffset:0}100%{stroke-dashoffset:58}}
@keyframes capmk-peak{0%,100%{opacity:.5;transform:scale(.75)}45%,75%{opacity:1;transform:scale(1.15)}}
@keyframes capmk-pop{0%,100%{opacity:.35;transform:scale(.7)}45%,75%{opacity:1;transform:scale(1)}}
/* event day-# indicator on the Show Mode campaign row */
.crmv .cap-dayn{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;letter-spacing:.02em;border-radius:999px;padding:3px 10px;background:var(--bg2);color:var(--text2);border:1px solid var(--border)}
.crmv .cap-dayn.live{background:color-mix(in srgb,var(--accent) 12%,#fff);color:var(--accent);border-color:color-mix(in srgb,var(--accent) 34%,transparent)}
/* lead-drawer section headers (full dossier view) */
.crmv .l-dsec{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--accent);opacity:.85;margin:16px 0 4px;padding-top:9px;border-top:1px solid var(--border)}
.crmv .l-form .l-dsec:first-of-type{margin-top:8px;border-top:none;padding-top:0}
/* sticky Save bar inside the capture card */
.crmv .cap-actions{position:sticky;bottom:0;background:var(--card);border-top:1px solid var(--border);margin:14px -16px -14px;padding:11px 16px calc(11px + env(safe-area-inset-bottom));z-index:5}
@media(max-width:767px){ .crmv .cap-head-row .cap-title{font-size:19px} }
`;
  document.head.appendChild(st);
}
