import React,{useState,useEffect,useCallback} from 'react';
import {Routes,Route,Navigate,useNavigate,useLocation,Link} from 'react-router-dom';
import Login from './pages/Login.jsx';import Dashboard from './pages/Dashboard.jsx';import AnalysisForm from './pages/AnalysisForm.jsx';import Results from './pages/Results.jsx';import History from './pages/History.jsx';
import {LatestNews,FakeDesk,Settings,Account,Subscription,Upgrade} from './pages/Workspace.jsx';
import {getMe,getNotifications,markNotificationsRead} from './api.js';

function useAuth(){const [token,setToken]=useState(localStorage.getItem('token'));return {token,login:(t,u)=>{localStorage.setItem('token',t);localStorage.setItem('user',JSON.stringify(u));setToken(t)},logout:()=>{localStorage.removeItem('token');localStorage.removeItem('user');setToken(null)}}}
function RequireAuth({token,children}){return token?children:<Navigate to="/login" replace/>}
function Icon({name,size=17}){const p={bell:<><path d="M6 9a6 6 0 0 1 12 0c0 4 2 5 2 5H4s2-1 2-5"/><path d="M10 18h4"/></>,gem:<><path d="m12 3 7 5-7 13L5 8l7-5Z"/><path d="M5 8h14M9 8l3 13 3-13"/></>,home:<><path d="m3 9 9-7 9 7"/><path d="M5 9v11h14V9"/></>,news:<><path d="M4 4h16v16H4z"/><path d="M7 8h10M7 12h10M7 16h6"/></>,warn:<><path d="m12 3 9 18H3z"/><path d="M12 9v4M12 17h.01"/></>,clock:<><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,settings:<><circle cx="12" cy="12" r="3"/><path d="M19 15l2 1-2 3-2-1a7 7 0 0 1-3 2v2h-4v-2a7 7 0 0 1-3-2l-2 1-2-3 2-1a7 7 0 0 1 0-4l-2-1 2-3 2 1a7 7 0 0 1 3-2V3h4v2a7 7 0 0 1 3 2l2-1 2 3-2 1a7 7 0 0 1 0 4z"/></>,plus:<><path d="M12 5v14M5 12h14"/></>,logout:<><path d="M10 17l5-5-5-5M15 12H3M21 3v18"/></>};return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{p[name]}</svg>}
function Logo(){return <Link className="brand-logo" to="/"><span className="logo-mark"><span/></span><span>Deep<b>Trust</b></span></Link>}

function initials(name){const parts=(name||'').trim().split(/\s+/).filter(Boolean);if(parts.length===0)return '·';return (parts[0][0]+(parts[1]?.[0]||'')).toUpperCase()}

function Shell({children,onLogout,user,refreshUser}){
 const nav=useNavigate(),loc=useLocation();
 const [q,setQ]=useState('');const [menu,setMenu]=useState(false);const [searchOpen,setSearchOpen]=useState(false);
 const [notifOpen,setNotifOpen]=useState(false);const [notifs,setNotifs]=useState([]);const [unread,setUnread]=useState(0);
 const loadNotifs=useCallback(()=>{getNotifications().then(r=>{setNotifs(r.data.notifications||[]);setUnread(r.data.unread||0)}).catch(()=>{})},[]);
 useEffect(()=>{loadNotifs();const t=setInterval(loadNotifs,60000);return ()=>clearInterval(t)},[loadNotifs]);
 const openNotifs=()=>{setNotifOpen(v=>{const next=!v;if(next){markNotificationsRead().then(()=>setUnread(0)).catch(()=>{})}return next});};
 const items=[['/','Dashboard','home'],['/latest','Latest news','news'],['/fake','Fake news','warn'],['/history','History','clock']];
 const search=()=>{const x=q.trim().toLowerCase();if(!x){setSearchOpen(true);return;}const hit=[['latest news','/latest'],['latest','/latest'],['fake news','/fake'],['fake','/fake'],['history','/history'],['settings','/settings'],['account','/account'],['subscription','/subscription'],['upgrade','/upgrade'],['video','/analyze/videoUrl'],['image','/analyze/file'],['pdf','/analyze/file'],['text','/analyze/text'],['new deeptrust','/analyze/newsUrl'],['new','/analyze/newsUrl'],['dashboard','/']].find(([k])=>x.includes(k));if(hit){nav(hit[1]);setQ('');setSearchOpen(false);}else setSearchOpen(true);};
 const limit=user?.planLimit;const used=user?.usedThisCycle||0;const pct=limit?Math.min(100,Math.round((used/limit)*100)):0;
 return <div className="app-shell"><header className="topbar"><Logo/><nav className="topnav">{items.map(([p,t,i])=><button key={p} className={'nav-i '+(loc.pathname===p?'on':'')} onClick={()=>nav(p)}><Icon name={i}/>{t}</button>)}</nav><div className="bar-spacer"/><div className="top-search"><input value={q} onChange={e=>setQ(e.target.value)} onKeyDown={e=>e.key==='Enter'&&search()} placeholder="Search workspace…"/></div><button className="bar-new" onClick={()=>nav('/analyze/newsUrl')}>⚡ Generate DeepTrust</button><button className="icon-btn" onClick={()=>nav('/upgrade')} title="Upgrade plan"><Icon name="gem" size={18}/></button><div className="account-wrap"><button className="icon-btn" onClick={()=>{openNotifs();setMenu(false)}} title="Notifications">{unread>0&&<span className="notif-dot">{unread}</span>}<Icon name="bell" size={17}/></button>{notifOpen&&<div className="account-menu notif-menu"><div className="usage-head"><span>NOTIFICATIONS</span></div>{notifs.length===0?<div className="empty" style={{padding:'14px 12px'}}>No flagged verifications in the last 7 days.</div>:notifs.map(n=><button key={n.id} className="notif-item" onClick={()=>{setNotifOpen(false);nav('/results/'+n.reportId)}}><span>{n.text}</span><small>{new Date(n.createdAt).toLocaleDateString()}</small></button>)}</div>}</div><div className="account-wrap"><button className="account-trigger" onClick={()=>{setMenu(v=>!v);setNotifOpen(false)}}><span className="avatar">{initials(user?.name)}</span><span className="chev">⌄</span></button>{menu&&<div className="account-menu"><div className="usage-head"><span>VERIFICATIONS</span><b>{used}{limit?` / ${limit}`:''}</b></div><div className="usage-bar"><i style={{width:pct+'%'}}/></div><div className="usage-reset">{user?.plan||'Free'} plan{limit?' · resets on the 1st':''}</div><div className="menu-divider"/><button onClick={()=>{setMenu(false);setSearchOpen(true)}}>⌕ <span>Search</span><kbd>⌘K</kbd></button><button onClick={()=>{nav('/subscription');setMenu(false)}}>▣ <span>My subscription</span></button><button onClick={()=>{nav('/upgrade');setMenu(false)}}>♢ <span>Upgrade plan</span></button><button onClick={()=>{nav('/account');setMenu(false)}}>♙ <span>My account</span></button><button onClick={()=>{nav('/settings');setMenu(false)}}>☼ <span>Settings</span></button><div className="menu-divider"/><button className="signout" onClick={onLogout}>⇥ <span>Sign out</span></button></div>}</div></header>{searchOpen&&<div className="search-overlay" onClick={()=>setSearchOpen(false)}><div className="search-modal" onClick={e=>e.stopPropagation()}><div className="search-modal-head"><b>Search DeepTrust</b><button onClick={()=>setSearchOpen(false)}>×</button></div><input autoFocus className="inp" value={q} onChange={e=>setQ(e.target.value)} onKeyDown={e=>e.key==='Enter'&&search()} placeholder="Search pages, reports or verification types…"/><div className="search-links">{[['Dashboard','/'],['Latest news','/latest'],['Fake news','/fake'],['History','/history'],['New DeepTrust','/analyze/newsUrl'],['Video verification','/analyze/videoUrl'],['Upload video','/analyze/videoFile'],['Settings','/settings'],['My account','/account'],['My subscription','/subscription'],['Upgrade plan','/upgrade']].filter(([t])=>!q||t.toLowerCase().includes(q.toLowerCase())).map(([t,p])=><button key={p} onClick={()=>{nav(p);setSearchOpen(false);setQ('')}}>{t}<span>→</span></button>)}</div></div></div>}<main className="main-wrap" onClick={()=>{menu&&setMenu(false);notifOpen&&setNotifOpen(false)}}>{React.isValidElement(children)?React.cloneElement(children,{user,refreshUser}):children}</main></div>}

export default function App(){
 const auth=useAuth();
 const [user,setUser]=useState(()=>JSON.parse(localStorage.getItem('user')||'null'));
 const refreshUser=useCallback(()=>{if(!auth.token)return;getMe().then(r=>{setUser(r.data.user);localStorage.setItem('user',JSON.stringify(r.data.user))}).catch(()=>{})},[auth.token]);
 useEffect(()=>{refreshUser()},[refreshUser]);
 const onLogin=(t,u)=>{auth.login(t,u);setUser(u)};
 const wrap=(el)=><RequireAuth token={auth.token}><Shell onLogout={auth.logout} user={user} refreshUser={refreshUser}>{el}</Shell></RequireAuth>;
 return <Routes>
  <Route path="/login" element={<Login onLogin={onLogin} token={auth.token}/>}/>
  <Route path="/" element={wrap(<Dashboard/>)}/>
  <Route path="/latest" element={wrap(<LatestNews/>)}/>
  <Route path="/fake" element={wrap(<FakeDesk/>)}/>
  <Route path="/history" element={wrap(<History/>)}/>
  <Route path="/settings" element={wrap(<Settings/>)}/>
  <Route path="/account" element={wrap(<Account/>)}/>
  <Route path="/subscription" element={wrap(<Subscription/>)}/>
  <Route path="/upgrade" element={wrap(<Upgrade/>)}/>
  <Route path="/analyze/:mode" element={wrap(<AnalysisForm/>)}/>
  <Route path="/results/:id" element={wrap(<Results/>)}/>
  <Route path="*" element={<Navigate to="/" replace/>}/>
 </Routes>
}
