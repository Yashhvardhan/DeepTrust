import React,{useEffect,useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {getHistory} from '../api.js';

const opts=[
 {key:'newsUrl',icon:'N',code:'01',title:'News URL',desc:'Verify a news article against independent evidence.',tag:'WEB SOURCE'},
 {key:'videoUrl',icon:'V',code:'02',title:'Video URL',desc:'Fact-check claims and screen frames for manipulation signals.',tag:'REMOTE MEDIA'},
 {key:'videoFile',icon:'VF',code:'03',title:'Upload Video',desc:'Run timeline-frame visual analysis on MP4, WEBM or MOV.',tag:'MEDIA FILE'},
 {key:'blogArticle',icon:'B',code:'04',title:'Blog / Article',desc:'Separate factual claims from opinion and verify them.',tag:'LONGFORM'},
 {key:'file',icon:'F',code:'05',title:'Upload File',desc:'Analyze a PDF, DOCX or TXT document.',tag:'DOCUMENT'},
 {key:'text',icon:'T',code:'06',title:'Paste Text',desc:'Check a claim, post or passage directly.',tag:'TEXT INTAKE'},
];

function Stat({label,value,note,tone='neutral',mark}){return <div className={`dash-ticket ${tone}`}>
 <span className="dash-ticket-hole left"/><span className="dash-ticket-hole right"/>
 <div className="dash-ticket-top"><span>{mark}</span><small>{label}</small></div>
 <strong>{value}</strong><em>{note}</em>
 </div>}

function Verdict({value}){const tone=value==='Likely Real'?'real':value==='Likely Fake'?'fake':'unclear';return <span className={`dash-verdict ${tone}`}><i>{tone==='real'?'✓':tone==='fake'?'✕':'?'}</i>{value||'Unclear'}</span>}

export default function Dashboard(){
 const nav=useNavigate(); const [rows,setRows]=useState([]);
 useEffect(()=>{getHistory().then(r=>setRows(r.data.reports||[])).catch(()=>{})},[]);
 const total=rows.length, real=rows.filter(r=>r.verdict==='Likely Real').length, fake=rows.filter(r=>r.verdict==='Likely Fake').length, unclear=total-real-fake;
 const latest=rows[0];
 return <div className="page maxw dash-page">
   <section className="dash-intake">
    <div className="dash-paperclip" aria-hidden="true">CASE INTAKE</div>
    <div className="dash-intake-copy">
      <div className="dash-kicker"><span>DEEPTRUST / VERIFICATION DESK</span><i/>DESK OPEN</div>
      <div className="dash-case-line"><span>NEW INVESTIGATION</span><b>INTAKE FORM 001</b></div>
      <h1>Bring the claim.<br/><em>We'll bring the evidence.</em></h1>
      <p>Open a new case from a link, document, video or raw text. DeepTrust turns the material into a traceable verification dossier.</p>
      <button className="dash-primary" onClick={()=>nav('/analyze/newsUrl')}><span>Open a case</span><b>↗</b></button>
    </div>
    <div className="dash-intake-slip">
      <div className="dash-slip-stamp">INTAKE<br/>READY</div>
      <span className="dash-slip-label">CASE DESK NOTE</span>
      <strong>{latest?'Last case reviewed':'No case filed yet'}</strong>
      <p>{latest?new Date(latest.createdAt).toLocaleDateString(undefined,{day:'2-digit',month:'short',year:'numeric'}):'Start your first verification to populate the ledger.'}</p>
      <div className="dash-slip-rule"/><small>AI-assisted evidence review<br/>Human judgment remains the final call.</small>
    </div>
   </section>

   <section className="dash-stats" aria-label="Verification statistics">
    <Stat mark="A" label="TOTAL CASES" value={total} note="verification runs"/>
    <Stat mark="R" label="LIKELY REAL" value={real} note="supported by evidence" tone="real"/>
    <Stat mark="F" label="LIKELY FAKE" value={fake} note="contradicted / flagged" tone="fake"/>
    <Stat mark="?" label="UNCLEAR" value={unclear} note="needs more evidence" tone="unclear"/>
   </section>

   <section className="dash-section">
    <div className="dash-section-head"><div><span className="dash-kicker">02 · CASE INTAKE TYPES</span><h2>What are we examining today?</h2><p>Choose the source format. Each intake route feeds the same investigation pipeline.</p></div><span className="dash-index">6 INTAKE ROUTES</span></div>
    <div className="dash-type-grid">
      {opts.map(o=><button className="dash-file" key={o.key} onClick={()=>nav('/analyze/'+o.key)}>
       <span className="dash-file-tab">{o.tag}</span><span className="dash-file-code">{o.code}</span><span className="dash-file-icon">{o.icon}</span>
       <span className="dash-file-title">{o.title}</span><span className="dash-file-desc">{o.desc}</span><span className="dash-file-arrow">↗</span>
      </button>)}
    </div>
   </section>

   <section className="dash-section dash-ledger-section">
    <div className="dash-section-head"><div><span className="dash-kicker">03 · CASE LEDGER</span><h2>Latest verification runs</h2><p>A working register of your most recent investigations.</p></div><button className="dash-history" onClick={()=>nav('/history')}>Open full archive <b>→</b></button></div>
    <div className="dash-ledger">
      <div className="dash-ledger-head"><span>CASE</span><span>CONTENT / SOURCE</span><span>TYPE</span><span>VERDICT</span><span>TRUST</span><span>FILED</span></div>
      {rows.length===0?<div className="dash-empty"><span>NO CASES ON FILE</span><strong>Your ledger is waiting for its first investigation.</strong><button onClick={()=>nav('/analyze/newsUrl')}>File first case ↗</button></div>:rows.slice(0,6).map((r,i)=><button className="dash-ledger-row" key={r.id} onClick={()=>nav('/results/'+r.id)}>
        <span className="dash-case-no">#{String(i+1).padStart(2,'0')}</span>
        <span className="dash-content"><strong>{r.inputRef||'Untitled content'}</strong><small>{r.title||'Verification case'}</small></span>
        <span className="dash-type">{r.inputType||'—'}</span>
        <Verdict value={r.verdict}/>
        <span className="dash-score">{r.trustScore??0}<small>/100</small></span>
        <span className="dash-date">{r.createdAt?new Date(r.createdAt).toLocaleDateString(undefined,{day:'2-digit',month:'short',year:'numeric'}):'—'}</span>
        <span className="dash-row-arrow">→</span>
      </button>)}
    </div>
   </section>

   <footer className="dash-footer"><span><b>DEEPTRUST</b> / verification desk</span><span>Evidence first · verdict second</span></footer>
 </div>
}
