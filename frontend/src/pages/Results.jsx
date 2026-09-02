import React,{useEffect,useMemo,useRef,useState} from 'react';
import {useLocation,useNavigate,useParams} from 'react-router-dom';
import {getReport} from '../api.js';
import {jsPDF} from 'jspdf';

const cat={faceIdentity:'Face identity',lipSyncAndExpression:'Mouth / expression',handsAndObjects:'Hands & objects',backgroundGeometry:'Background geometry',temporalConsistency:'Temporal consistency',renderingArtifacts:'Rendering artifacts',textAndOverlays:'Text & overlays'};

function downloadReportPdf(r){
 const doc=new jsPDF({unit:'pt',format:'a4'}); const mx=48; let y=56; const H=doc.internal.pageSize.getHeight(), W=doc.internal.pageSize.getWidth();
 const space=h=>{if(y+h>H-48){doc.addPage();y=56;}};
 const head=(t,sz=13)=>{space(sz+14);doc.setFont('helvetica','bold');doc.setFontSize(sz);doc.text(t,mx,y);y+=sz+8;doc.setFont('helvetica','normal')};
 const para=(t,sz=10)=>{if(!t)return;doc.setFontSize(sz);doc.setTextColor(45,45,45);doc.splitTextToSize(String(t),W-mx*2).forEach(l=>{space(sz+4);doc.text(l,mx,y);y+=sz+4});doc.setTextColor(0,0,0)};
 head('DeepTrust Verification Report',18); para(r.title||'Untitled content'); y+=8;
 head('Bottom line'); para(`${r.verdict||'Unclear'} · ${r.verdictConfidence||0}% confidence · Trust score ${r.trustScore||0}/100`); para(r.summary); para(`Recommendation: ${r.recommendation||'Verify further before sharing.'}`);
 head('Claims'); (r.claims||[]).forEach((c,i)=>{head(`${i+1}. ${c.claim}`,11);para(`${String(c.verdict||'unverifiable').toUpperCase()} · ${c.confidence||0}% confidence`);para(c.explanation||'');(c.sources||[]).forEach(s=>para(`• ${s.title||s.hostname||'Source'} — ${s.url||''}`,9))});
 if(r.visualAnalysis?.performed){head('Media screening');para(`${r.visualAnalysis.aiGenerationVerdict||r.visualAnalysis.verdict||'Inconclusive'} · ${r.visualAnalysis.confidence||0}% confidence`);para(r.visualAnalysis.summary||r.visualAnalysis.reason)}
 doc.save(`deeptrust-report-${new Date().toISOString().slice(0,10)}.pdf`);
}

function scoreTone(score){return score>=75?'good':score>=50?'warn':'bad'}
function verdictWord(v){return v==='Likely Real'?'Likely Real':v==='Likely Fake'?'Likely Fake':'Unclear'}
function verdictTone(v){return v==='Likely Real'?'good':v==='Likely Fake'?'bad':'warn'}
function verdictMeta(v){
 const map={verified:{label:'SUPPORTED',title:'Evidence supports this claim',icon:'✓',tone:'good'},false:{label:'FALSE',title:'Evidence contradicts this claim',icon:'✕',tone:'bad'},suspicious:{label:'QUESTIONABLE',title:'Evidence is mixed or incomplete',icon:'!',tone:'warn'},unverifiable:{label:'UNVERIFIABLE',title:'Not enough evidence to make a call',icon:'?',tone:'neutral'},'not-applicable':{label:'NOT CHECKED',title:'This item was not fact-checked',icon:'—',tone:'neutral'}};
 return map[v]||map.unverifiable;
}
function Pill({v,large=false}){const m=verdictMeta(v);return <span className={`dtr-pill ${m.tone} ${large?'lg':''}`} title={m.title}><i>{m.icon}</i>{m.label}</span>}

/* ---------- Trust gauge: semicircle dial with colour zones + needle ---------- */
function polarPoint(cx,cy,r,v){const a=(180-1.8*v)*Math.PI/180;return {x:cx+r*Math.cos(a),y:cy-r*Math.sin(a)}}
function gaugeArc(cx,cy,r,v1,v2){const s=polarPoint(cx,cy,r,v1),e=polarPoint(cx,cy,r,v2);return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${r} ${r} 0 0 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`}
function TrustGauge({score,thresholds}){
 const val=Math.max(0,Math.min(100,Number(score)||0));
 const fakeT=thresholds?.fake??40, realT=thresholds?.real??75;
 const cx=110,cy=114,r=90,needleR=72;
 const needle=polarPoint(cx,cy,needleR,val);
 return <div className="dtr-gauge">
  <svg viewBox="0 0 220 130" aria-hidden="true">
   <path d={gaugeArc(cx,cy,r,0,fakeT)} className="band bad" strokeLinecap="round"/>
   <path d={gaugeArc(cx,cy,r,fakeT,realT)} className="band warn" strokeLinecap="round"/>
   <path d={gaugeArc(cx,cy,r,realT,100)} className="band good" strokeLinecap="round"/>
   {[0,25,50,75,100].map(t=>{const p1=polarPoint(cx,cy,r+11,t),p2=polarPoint(cx,cy,r+2,t);return <line key={t} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} className="tick"/>})}
   <line x1={cx} y1={cy} x2={needle.x} y2={needle.y} className="needle"/>
   <circle cx={cx} cy={cy} r="6.5" className="pivot"/>
  </svg>
  <div className="dtr-gauge-read"><strong>{val}</strong><span>TRUST / 100</span></div>
 </div>
}
function Metric({value,label,sub,tone=''}){return <div className={`dtr-ticket ${tone}`}><strong>{value}</strong><span>{label}</span>{sub&&<small>{sub}</small>}</div>}

/* ---------- Evidence source rendered as a scattered index card ---------- */
function EvidenceSource({s,i}){
 const stance=s.stance||'neutral'; const label=stance==='supports'?'Supports':stance==='refutes'?'Refutes':'Neutral';
 return <a className={`dtr-index-card ${stance}`} style={{'--tilt':(i%2?1:-1)*(1+ (i%3))+'deg'}} href={s.url||'#'} target="_blank" rel="noreferrer">
   <div className="dtr-index-pin"/>
   <div className="dtr-index-top"><span>{label}</span><b>↗</b></div>
   <strong>{s.title||s.hostname||'Source'}</strong>
   <p>{s.snippet||'Open the original source to inspect its context.'}</p>
   <footer><span>{s.hostname||'External source'}</span>{s.reliabilityScore!=null&&<span>Reliability {s.reliabilityScore}</span>}</footer>
 </a>
}

/* ---------- Claim rendered as a case-file with a folder tab ---------- */
function ClaimResult({c,index}){
 const m=verdictMeta(c.verdict); const sourceCount=(c.sources||[]).length; const [showQueries,setShowQueries]=useState(false);
 return <article className={`dtr-case ${m.tone}`}>
   <div className="dtr-case-tab"><span>CASE FILE {String(index+1).padStart(2,'0')}</span><Pill v={c.verdict}/></div>
   <div className="dtr-case-body">
     <div className="dtr-case-head"><h3>{c.claim}</h3><div className="dtr-case-conf"><b>{c.confidence||0}%</b><span>confidence</span></div></div>
     <div className="dtr-case-grid">
      <div className="dtr-case-why">
        <span className="dtr-micro">WHY DEEPTRUST SAYS THIS</span>
        <p>{c.explanation||'No explanation was returned for this claim.'}</p>
        <div className="dtr-strips">
          {c.evidenceConfidence!=null&&<div className="dtr-strip"><span>Evidence confidence</span><div className="dtr-strip-track"><i style={{width:`${Math.max(0,Math.min(100,c.evidenceConfidence))}%`}}/></div><b>{c.evidenceConfidence}%</b></div>}
          {c.llmStatedConfidence!=null&&<div className="dtr-strip"><span>Model confidence</span><div className="dtr-strip-track"><i style={{width:`${Math.max(0,Math.min(100,c.llmStatedConfidence))}%`}}/></div><b>{c.llmStatedConfidence}%</b></div>}
        </div>
        {c.queriesUsed?.length>0&&<button className="dtr-query-toggle" onClick={()=>setShowQueries(!showQueries)}>{showQueries?'Hide':'Show'} verification searches <span>⌄</span></button>}
        {showQueries&&<div className="dtr-query-list">{c.queriesUsed.map((q,i)=><span key={i}>⌕ {q}</span>)}</div>}
      </div>
      <div className="dtr-case-evidence">
        <span className="dtr-micro">EVIDENCE FOUND — {sourceCount} SOURCE{sourceCount===1?'':'S'}</span>
        {sourceCount?<div className="dtr-index-stack">{c.sources.map((s,j)=><EvidenceSource s={s} i={j} key={j}/>)}</div>:<div className="dtr-no-evidence"><strong>No reliable source found</strong><span>DeepTrust keeps this as <b>Unverifiable</b> instead of calling it false.</span></div>}
      </div>
     </div>
     {c.signals?.length>0&&<div className="dtr-signals">{c.signals.map((s,i)=><span className={s.status} key={i}><i>{s.status==='pass'?'✓':s.status==='flag'?'!':'i'}</i>{s.label}</span>)}</div>}
   </div>
 </article>
}

/* ---------- Agent pipeline rendered as a zig-zag investigation trail ---------- */
function TrailNode({n,icon,name,detail,body,above}){
 return <div className={`dtr-trail-node ${above?'above':'below'}`}>
  <div className="dtr-trail-card"><h3>{name}</h3><span>{detail}</span><p>{body}</p></div>
  <div className="dtr-trail-dot">{icon}<small>{n}</small></div>
 </div>
}
function Factor({label,value,weight}){if(value==null)return null;return <div className="dtr-factor"><div><span>{label}</span><b>{value}%</b></div><div className="dtr-factor-track"><i style={{width:`${Math.max(0,Math.min(100,value))}%`}}/></div>{weight!=null&&<small>{weight}% weight</small>}</div>}

function ResultSkeleton(){
 return <div className="page maxw dtr-page">
  <div className="dtr-nav"><span className="sk" style={{width:120,height:14}}/><div className="dtr-brand"><span className="dtr-brand-dot"/>DEEP<span>TRUST</span></div><span className="sk" style={{width:160,height:30}}/></div>
  <div className="dtr-hero sk-hero"><div className="dtr-hero-copy"><span className="sk sk-line" style={{width:'160px',height:'10px'}}/><span className="sk sk-line" style={{width:'70%',height:'30px',marginTop:'16px'}}/><span className="sk sk-line" style={{width:'40%',height:'16px',marginTop:'12px'}}/><span className="sk sk-block" style={{marginTop:'22px'}}/></div><div className="dtr-hero-side"><span className="sk sk-ring" style={{width:180,height:110,borderRadius:'90px 90px 0 0'}}/></div></div>
  <div className="dtr-metrics sk-metrics">{Array.from({length:6}).map((_,i)=><div key={i} className="dtr-ticket"><span className="sk sk-line" style={{width:'34px',height:'20px'}}/><span className="sk sk-line" style={{width:'60px',height:'8px',marginTop:'8px'}}/></div>)}</div>
  <div className="sk sk-section"/>
  <div className="sk sk-section" style={{height:'220px'}}/>
  <p className="dt-loading-caption">Pulling together the case file…</p>
 </div>
}

const SECTIONS=[{key:'decision',label:'Decision'},{key:'claims',label:'Claims'},{key:'media',label:'Media',needs:'visualAnalysis'},{key:'agents',label:'Trail'},{key:'scoring',label:'Scoring'}];

export default function Results(){
 const {id}=useParams(),loc=useLocation(),nav=useNavigate(); const [report,setReport]=useState(loc.state?.report||null); const [filter,setFilter]=useState('all'); const [feedback,setFeedback]=useState(false); const [certificateOpen,setCertificateOpen]=useState(false);
 const [activeSection,setActiveSection]=useState('decision'); const [subnavVisible,setSubnavVisible]=useState(false); const [linkCopied,setLinkCopied]=useState(false); const [showTop,setShowTop]=useState(false);
 const heroRef=useRef(null); const sectionRefs=useRef({});
 useEffect(()=>{if(!report)getReport(id).then(x=>setReport(x.data.report)).catch(()=>{})},[id,report]);
 useEffect(()=>{
  if(!report)return;
  const onScroll=()=>{
   const heroBottom=heroRef.current?heroRef.current.getBoundingClientRect().bottom:0;
   setSubnavVisible(heroBottom<0); setShowTop(window.scrollY>900);
   let current=null;
   for(const s of SECTIONS){const el=sectionRefs.current[s.key]; if(!el)continue; const top=el.getBoundingClientRect().top; if(top-120<=0)current=s.key;}
   if(current)setActiveSection(current);
  };
  onScroll(); window.addEventListener('scroll',onScroll,{passive:true});
  return ()=>window.removeEventListener('scroll',onScroll);
 },[report]);
 const jumpTo=k=>{const el=sectionRefs.current[k]; if(el)window.scrollTo({top:el.getBoundingClientRect().top+window.scrollY-84,behavior:'smooth'})};
 const copyLink=async()=>{try{await navigator.clipboard.writeText(window.location.href); setLinkCopied(true); setTimeout(()=>setLinkCopied(false),2000)}catch{}};
 if(!report)return <ResultSkeleton/>;
 const r=report,b=r.breakdown||{},sb=r.scoringBreakdown||{},weights=sb.activeWeights||r.scoringPolicy?.weights||{},claims=r.claims||[],sources=claims.flatMap(c=>c.sources||[]);
 const flagged=claims.filter(c=>c.verdict==='false'||c.verdict==='suspicious'), unver=claims.filter(c=>c.verdict==='unverifiable');
 const visibleClaims=filter==='all'?claims:filter==='flagged'?flagged:filter==='unverifiable'?unver:claims.filter(c=>c.verdict==='verified');
 const vTone=verdictTone(r.verdict);
 const summary=r.summary||'No summary was returned. Review the claim evidence below before making a decision.';
 const sourceUrl=r.sourceUrl;
 const availableSections=SECTIONS.filter(s=>!s.needs||r[s.needs]);
 const caseNo=(r.id||id||'').toString().replace(/-/g,'').slice(0,8).toUpperCase()||'PENDING';
 const filedOn=r.generatedAt?new Date(r.generatedAt):null;

 return <div className="page maxw dtr-page">

   <div className={`dtr-subnav ${subnavVisible?'visible':''}`}>
     <div className="dtr-subnav-inner">
       <button className="dtr-subnav-verdict" onClick={()=>window.scrollTo({top:0,behavior:'smooth'})}><Pill v={r.verdict==='Likely Real'?'verified':r.verdict==='Likely Fake'?'false':'unverifiable'}/><b>{r.trustScore||0}<small>/100</small></b></button>
       <div className="dtr-subnav-links">{availableSections.map(s=><button key={s.key} className={activeSection===s.key?'active':''} onClick={()=>jumpTo(s.key)}>{s.label}</button>)}</div>
       <button className="dtr-subnav-share" onClick={copyLink}>{linkCopied?'✓ Copied':'⇗ Share'}</button>
     </div>
   </div>

   <nav className="dtr-nav">
     <button className="dtr-back" onClick={()=>nav('/')}>← Back to workspace</button>
     <div className="dtr-brand"><span className="dtr-brand-dot"/>DEEP<span>TRUST</span></div>
     <div className="dtr-nav-actions"><button onClick={copyLink}>{linkCopied?'✓ Link copied':'⇗ Share'}</button><button onClick={()=>setCertificateOpen(true)}>◎ Certificate</button><button onClick={()=>downloadReportPdf(r)}>↓ Export report</button><button className="dtr-new-btn" onClick={()=>nav('/analyze/newsUrl')}>+ New verification</button></div>
   </nav>

   <header className={`dtr-hero ${vTone}`} ref={heroRef}>
    <div className="dtr-watermark" aria-hidden="true">{r.verdict==='Likely Real'?'REAL':r.verdict==='Likely Fake'?'FAKE':'UNCLEAR'}</div>
    <div className="dtr-hero-copy">
      <div className="dtr-case-meta">CASE #{caseNo} <i>·</i> FILED {filedOn?filedOn.toLocaleDateString(undefined,{day:'2-digit',month:'short',year:'numeric'}):'—'} <i>·</i> <span className="dtr-live-dot"/>VERIFICATION COMPLETE</div>
      <h1>{r.title||'Untitled content'}</h1>
      <div className="dtr-answer-statement"><span>THE BOTTOM LINE</span><p>{summary}</p></div>
    </div>
    <div className="dtr-hero-side">
      <div className="dtr-stamp-wrap"><VerdictStamp verdict={r.verdict} confidence={r.verdictConfidence||0}/></div>
      <TrustGauge score={r.trustScore} thresholds={r.scoringPolicy?.thresholds}/>
      <p className="dtr-coverage">{r.evidenceCoverage||0}% of checkable claims have evidence attached.</p>
    </div>
   </header>

   <section className="dtr-metrics"><Metric value={b.verified||0} label="Supported" sub="claims" tone="good"/><Metric value={b.suspicious||0} label="Questionable" sub="claims" tone="warn"/><Metric value={b.false||0} label="Contradicted" sub="claims" tone="bad"/><Metric value={b.unverifiable||0} label="Unverifiable" sub="claims" tone="neutral"/><Metric value={sources.length} label="Sources" sub="retained"/><Metric value={`${r.evidenceCoverage||0}%`} label="Evidence coverage" sub="checkable claims"/></section>

   <section className="dtr-section" id="decision" ref={el=>sectionRefs.current.decision=el}>
     <div className="dtr-intro"><div><span className="dtr-kicker">01 · DECISION</span><h2>So, what should I believe?</h2><p>Start here. DeepTrust separates the final verdict from how certain the system is.</p></div></div>
     <div className="dtr-memo">
       <div className="dtr-memo-main"><span className="dtr-micro">RECOMMENDATION</span><h3>{r.recommendation||'Verify further before sharing.'}</h3><p>Use the claim evidence below to understand exactly what is supported, contradicted, or still unknown.</p></div>
       <div className="dtr-memo-side"><span>Verdict confidence</span><b>{r.verdictConfidence||0}%</b><div className="dtr-big-progress"><i style={{width:`${Math.max(0,Math.min(100,r.verdictConfidence||0))}%`}}/></div><small>Confidence describes certainty in the verdict — it is not the same thing as truth.</small></div>
     </div>
   </section>

   <section className="dtr-section" id="claims" ref={el=>sectionRefs.current.claims=el}>
     <div className="dtr-intro"><div><span className="dtr-kicker">02 · THE ANSWER, CLAIM BY CLAIM</span><h2>What did the bot actually find?</h2><p>Every claim gets a visible verdict, explanation, confidence and evidence trail. Nothing important is hidden behind an accordion.</p></div>
       <div className="dtr-filters">{[['all','All'],['verified','Supported'],['flagged','Needs attention'],['unverifiable','Unverifiable']].map(([k,label])=><button key={k} className={filter===k?'active':''} onClick={()=>setFilter(k)}>{label}<b>{k==='all'?claims.length:k==='verified'?b.verified||0:k==='flagged'?flagged.length:unver.length}</b></button>)}</div>
     </div>
     <div className="dtr-case-stack">{visibleClaims.length?visibleClaims.map((c,i)=><ClaimResult c={c} index={claims.indexOf(c)} key={c.id||i}/>):<div className="dtr-empty">No claims in this view.</div>}</div>
   </section>

   {unver.length>0&&<section className="dtr-unver-banner"><div className="dtr-unver-icon">?</div><div><strong>Unverifiable is a result — not a failure.</strong><p>{unver.length} claim{unver.length!==1?'s':''} did not have enough reliable evidence to make a trustworthy call. DeepTrust does not silently convert missing evidence into “False”.</p></div></section>}

   {r.visualAnalysis&&<section className="dtr-section" id="media" ref={el=>sectionRefs.current.media=el}>
     <div className="dtr-intro"><div><span className="dtr-kicker">03 · MEDIA SCREENING</span><h2>What the visual agent saw</h2><p>Heuristic screening only — this is not forensic proof.</p></div><Pill v={r.visualAnalysis.verdict==='likely_authentic'?'verified':r.visualAnalysis.verdict==='likely_ai_generated'||r.visualAnalysis.verdict==='likely_manipulated'?'false':'suspicious'}/></div>
     <div className="dtr-media"><div className="dtr-media-verdict"><div className="dtr-media-symbol">{r.visualAnalysis.verdict==='likely_authentic'?'✓':'!'}</div><div><strong>{r.visualAnalysis.aiGenerationVerdict||r.visualAnalysis.verdict||'Inconclusive'}</strong><span>{r.visualAnalysis.confidence||0}% confidence</span><p>{r.visualAnalysis.summary||r.visualAnalysis.reason||'No visual assessment returned.'}</p></div></div>{r.visualAnalysis.performed&&<div className="dtr-visual-signals">{Object.entries(r.visualAnalysis.categories||{}).map(([k,v])=><div key={k}><b>{v.flagged?'!':'✓'}</b><span>{cat[k]||k}<small>{v.note||'Screening signal recorded.'}</small></span></div>)}</div>}</div>
   </section>}

   <section className="dtr-section" id="agents" ref={el=>sectionRefs.current.agents=el}>
    <div className="dtr-intro"><div><span className="dtr-kicker">04 · THE INVESTIGATION TRAIL</span><h2>See the work, not just the answer.</h2><p>This is the part a normal chatbot answer cannot show: the run-level work performed by each DeepTrust agent, in order.</p></div></div>
    <div className="dtr-trail">
      <TrailNode n="1" icon="R" name="Content Reader" above detail={`Parsed ${r.contentCategory||'content'}`} body={r.title?'Read the supplied material and prepared it for structured claim extraction.':'Prepared the supplied content for analysis.'}/>
      <TrailNode n="2" icon="C" name="Claim Extractor" detail={`${r.pipelineTrace?.claimsExtracted??r.claimsFound??claims.length} claims extracted`} body={`${r.pipelineTrace?.claimsMerged??0} duplicate claims merged before verification.`}/>
      <TrailNode n="3" icon="V" name="Fact Verification" above detail={`${r.pipelineTrace?.searchQueriesRun??0} live searches`} body={`${r.pipelineTrace?.rawSourcesFound??sources.length} sources found → ${r.pipelineTrace?.sourcesKeptAfterRanking??sources.length} retained after ranking.`}/>
      {r.visualAnalysis&&<TrailNode n="4" icon="M" name="Visual Agent" detail={r.visualAnalysis.performed?`Screened ${r.visualAnalysis.frameCount||1} frame(s)`:'Not performed'} body={r.visualAnalysis.performed?`${r.visualAnalysis.aiGenerationVerdict||r.visualAnalysis.verdict||'Inconclusive'} · ${r.visualAnalysis.confidence||0}% confidence.`:(r.visualAnalysis.reason||'No visual screen available.')}/>}
      <TrailNode n={r.visualAnalysis?'5':'4'} icon="S" name="Report Generator" above={!r.visualAnalysis} detail={`Trust score ${r.trustScore||0}/100`} body="Combined claim, evidence, source and screening signals into the final result."/>
    </div>
   </section>

   <section className="dtr-section" id="scoring" ref={el=>sectionRefs.current.scoring=el}>
    <div className="dtr-intro"><div><span className="dtr-kicker">05 · WHY THIS SCORE</span><h2>Open the scoring logic.</h2><p>The score is a summary of the evidence quality — not a replacement for the evidence.</p></div></div>
    <div className="dtr-score-panel">
      <div className="dtr-ruler-wrap">
        <div className="dtr-ruler-marker" style={{left:`${Math.max(2,Math.min(98,r.trustScore||0))}%`}}><b>{r.trustScore||0}</b></div>
        <div className="dtr-ruler"><i style={{width:`${r.scoringPolicy?.thresholds?.fake??40}%`}} className="bad"/><i style={{width:`${(r.scoringPolicy?.thresholds?.real??75)-(r.scoringPolicy?.thresholds?.fake??40)}%`}} className="warn"/><i style={{width:`${100-(r.scoringPolicy?.thresholds?.real??75)}%`}} className="good"/></div>
        <div className="dtr-ruler-labels"><span>Likely Fake &lt; {r.scoringPolicy?.thresholds?.fake??40}</span><span>Unclear</span><span>Likely Real ≥ {r.scoringPolicy?.thresholds?.real??75}</span></div>
      </div>
      <details className="dtr-details"><summary><span>View score components & weights</span><b>{r.trustScore||0}/100</b></summary>
        <div className="dtr-factor-list">
          <Factor label="Claim quality" value={sb.claims} weight={weights.claims}/>
          <Factor label="Evidence coverage" value={sb.evidence??r.evidenceCoverage} weight={weights.evidence}/>
          <Factor label="Source reliability" value={sb.source} weight={weights.source}/>
          <Factor label="Visual screening" value={sb.visual} weight={weights.visual}/>
          {sb.penalties>0&&<p className="dtr-penalty">−{sb.penalties} penalty points were applied.</p>}
        </div>
      </details>
    </div>
   </section>

   <footer className="dtr-footer"><div><strong>DeepTrust</strong><span>AI-assisted verification, not a legal or journalistic verdict.</span></div><div className="dtr-footer-actions">{sourceUrl&&<a href={sourceUrl} target="_blank" rel="noreferrer">Open original content ↗</a>}<button onClick={()=>setFeedback(!feedback)}>{feedback?'Thanks — feedback recorded':'Report incorrect verdict'}</button></div></footer>

   <button className={`dtr-top-btn ${showTop?'visible':''}`} onClick={()=>window.scrollTo({top:0,behavior:'smooth'})} aria-label="Back to top">↑</button>
   {certificateOpen&&<VerdictCertificate r={r} caseNo={caseNo} onClose={()=>setCertificateOpen(false)}/>} 
 </div>
}

function VerdictCertificate({r,caseNo,onClose}){
 const tone=verdictTone(r.verdict); const claims=r.claims||[]; const supported=claims.filter(c=>c.verdict==='verified').length; const flagged=claims.filter(c=>c.verdict==='false'||c.verdict==='suspicious').length;
 const printCertificate=()=>window.print();
 return <div className="dtr-cert-overlay" role="dialog" aria-modal="true" aria-label="Verdict certificate">
   <div className={`dtr-certificate ${tone}`}>
     <div className="dtr-cert-actions"><button onClick={onClose}>× Close</button><button onClick={printCertificate}>Print / Save PDF ↗</button></div>
     <div className="dtr-cert-inner">
       <div className="dtr-cert-brand"><span className="dtr-brand-dot"/> DEEP<span>TRUST</span><small>VERIFICATION OFFICE</small></div>
       <div className="dtr-cert-rule"/>
       <div className="dtr-cert-kicker">OFFICIAL CASE RECORD · #{caseNo}</div>
       <h2>Verdict Certificate</h2>
       <p className="dtr-cert-title">{r.title||'Untitled content'}</p>
       <div className="dtr-cert-verdict"><div className="dtr-cert-seal">{r.verdict==='Likely Real'?'✓':r.verdict==='Likely Fake'?'✕':'?'}</div><div><span>FINAL ASSESSMENT</span><strong>{r.verdict||'Unclear'}</strong><small>{r.verdictConfidence||0}% verdict confidence</small></div></div>
       <div className="dtr-cert-grid"><div><span>TRUST SCORE</span><b>{r.trustScore||0}<small>/100</small></b></div><div><span>CLAIMS REVIEWED</span><b>{claims.length}</b></div><div><span>SUPPORTED</span><b>{supported}</b></div><div><span>FLAGGED</span><b>{flagged}</b></div></div>
       <div className="dtr-cert-bottom"><div><span>RECOMMENDATION</span><p>{r.recommendation||'Verify further before sharing.'}</p></div><div className="dtr-cert-date"><span>ISSUED</span><b>{r.generatedAt?new Date(r.generatedAt).toLocaleDateString(undefined,{day:'2-digit',month:'short',year:'numeric'}):new Date().toLocaleDateString(undefined,{day:'2-digit',month:'short',year:'numeric'})}</b><small>AI-assisted verification record</small></div></div>
       <div className="dtr-cert-foot"><span>Evidence-backed analysis · not a legal or journalistic verdict</span><b>DEEPTRUST / CASE #{caseNo}</b></div>
     </div>
   </div>
 </div>
}

function VerdictStamp({verdict,confidence}){
 const map={'Likely Real':{label:'VERIFIED REAL',tone:'good',icon:'✓'},'Likely Fake':{label:'FLAGGED FAKE',tone:'bad',icon:'✕'}};
 const m=map[verdict]||{label:'UNCLEAR',tone:'warn',icon:'?'};
 return <div className={`dtr-stamp ${m.tone}`}>
   <div className="dtr-stamp-ring">
     <span className="dtr-stamp-icon">{m.icon}</span>
     <strong>{m.label}</strong>
     <small>{confidence}% conf.</small>
   </div>
 </div>
}
