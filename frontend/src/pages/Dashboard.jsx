import React,{useEffect,useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {getHistory} from '../api.js';
const opts=[
 {key:'newsUrl',icon:'N',title:'News URL',desc:'Verify a news article against independent evidence.'},
 {key:'videoUrl',icon:'V',title:'Video URL',desc:'Fact-check claims and compare real timeline frames for AI/manipulation signals.'},
 {key:'videoFile',icon:'VF',title:'Upload Video',desc:'Upload MP4/WEBM/MOV and run actual timeline-frame visual analysis.'},
 {key:'blogArticle',icon:'B',title:'Blog / Article',desc:'Separate factual claims from opinion and verify them.'},
 {key:'file',icon:'F',title:'Upload File',desc:'Analyze a PDF, DOCX, or TXT document.'},
 {key:'text',icon:'T',title:'Paste Text',desc:'Check a claim, post, or passage directly.'},
];
function Stat({label,value,note}){return <div className="stat-card"><div className="eyebrow">{label}</div><div className="stat-number">{value}</div><div className="stat-note">{note}</div></div>}
export default function Dashboard(){const nav=useNavigate();const [rows,setRows]=useState([]);useEffect(()=>{getHistory().then(r=>setRows(r.data.reports||[])).catch(()=>{})},[]);
 const total=rows.length, real=rows.filter(r=>r.verdict==='Likely Real').length, fake=rows.filter(r=>r.verdict==='Likely Fake').length, unclear=total-real-fake;
 return <div className="page maxw">
  <section className="hero"><div><div className="eyebrow">VERIFICATION DESK</div><h1>Verify anything before<br/><em>you believe it.</em></h1><p>DeepTrust turns articles, claims and video links into evidence-backed verification reports.</p></div><button className="primary-btn hero-btn" onClick={()=>nav('/analyze/newsUrl')}><span>Start a verification</span><span>→</span></button></section>
  <section className="stats-grid"><Stat label="TOTAL CHECKS" value={total} note="Your verification history"/><Stat label="LIKELY REAL" value={real} note="Supported by evidence"/><Stat label="LIKELY FAKE" value={fake} note="False or manipulated signals"/><Stat label="UNCLEAR" value={unclear} note="Needs more evidence"/></section>
  <section className="section-head"><div><div className="eyebrow">NEW VERIFICATION</div><h2>What do you want to check?</h2></div><div className="muted">Choose an input type</div></section>
  <div className="type-grid">
   {opts.map(o=><button className="type-card" key={o.key} onClick={()=>nav('/analyze/'+o.key)}><span className="type-icon">{o.icon}</span><span className="type-title">{o.title}</span><span className="type-desc">{o.desc}</span><span className="type-arrow">↗</span></button>)}
  </div>
  <section className="section-head recent-head"><div><div className="eyebrow">RECENT LEDGER</div><h2>Latest verification runs</h2></div><button className="text-btn" onClick={()=>nav('/history')}>View full history →</button></section>
  <div className="table-card">{rows.length===0?<div className="empty">No reports yet. Start your first verification above.</div>:<table><thead><tr><th>CONTENT</th><th>TYPE</th><th>VERDICT</th><th>SCORE</th><th>DATE</th></tr></thead><tbody>{rows.slice(0,6).map(r=><tr key={r.id} onClick={()=>nav('/results/'+r.id)}><td className="content-cell">{r.inputRef}</td><td><span className="mono">{r.inputType}</span></td><td><span className={'status '+(r.verdict==='Likely Real'?'real':r.verdict==='Likely Fake'?'fake':'unclear')}>{r.verdict||'Unclear'}</span></td><td className="score">{r.trustScore}%</td><td className="muted">{new Date(r.createdAt).toLocaleDateString()}</td></tr>)}</tbody></table>}</div>
 </div>
}
