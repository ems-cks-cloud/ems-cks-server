// EMS PT. Citra Kenyalang Sakti - Server pusat v1.4.1-online (tanpa dependensi, hanya Node.js)
// Berdasarkan server v1.3.0, ditambah: persistensi GitHub (data bertahan restart/redeploy hosting),
// header keamanan dasar, dan hook push saat berhenti (SIGTERM).
'use strict';
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto'),os=require('os');
const PORT=Number(process.env.PORT)||8787;
const ROOT=__dirname;
const DATA=process.env.EMS_DATA||path.join(ROOT,'data');
const BK=path.join(DATA,'backups'),FILES=path.join(DATA,'files');
[DATA,BK,FILES].forEach(d=>fs.mkdirSync(d,{recursive:true}));
const PH='';              // pengganti password pada data yang dikirim ke browser
const SESSION_HOURS=12;
const MITRA_ALLOWED=['dashboard','operasional','asisten','harikerja','legal'];
const SECRET_KEYS=['ems_custom_users_v2','ems_user_passwords_v2','ems_user_names_v2'];
const VERSION='1.4.6-online';

const DEFAULTS={
 ktu:{pw:'KTU2026!',name:'Administrator KTU',role:'KTU Administrator',perms:['dashboard','anggaran','kasir','pembukuan','lahan','gis','operasional','asisten','harikerja','personalia','payroll','masterplan','laporan','admin','workflow','orgmaster','aset','legal','staffinti','serveradmin']},
 manager:{pw:'MGR2026!',name:'Manager Proyek',role:'Manager Administrator',perms:['dashboard','anggaran','kasir','pembukuan','lahan','gis','operasional','asisten','harikerja','personalia','payroll','masterplan','laporan','workflow','orgmaster','aset','legal','staffinti']},
 pembukuan:{pw:'ACC2026!',name:'Staf ACC / Accounting',role:'ACC / Accounting',perms:['anggaran','pembukuan','workflow','aset']},
 kerani:{pw:'KER2026!',name:'Kerani Divisi',role:'Kerani Divisi',perms:['operasional','harikerja']},
 gis:{pw:'GIS2026!',name:'Staf GIS',role:'GIS & Pengukuran',perms:['gis']},
 pl:{pw:'PL2026!',name:'Staf Pembebasan Lahan',role:'PL',perms:['lahan']},
 kasir:{pw:'KAS2026!',name:'Kasir',role:'Kasir',perms:['kasir','workflow']},
 asisten:{pw:'ASI2026!',name:'Asisten Divisi',role:'Asisten Divisi',perms:['asisten','harikerja']},
 personalia:{pw:'PAY2026!',name:'Staf Personalia',role:'Personalia',perms:['personalia']},
 payroll:{name:'Staf Payroll',role:'Payroll',perms:['payroll']},
 stok:{name:'Staf Gudang',role:'Gudang',perms:['aset']},
 infrastruktur:{pw:'INFRA2026!',name:'Staf Infrastruktur',role:'Infrastruktur',perms:['operasional','harikerja']}
};

// ---------- persistensi GitHub: konfigurasi (fungsi detail di bawah) ----------
const GH_TOKEN=process.env.EMS_GH_TOKEN||'',GH_REPO=process.env.EMS_GH_REPO||'',GH_BRANCH=process.env.EMS_GH_BRANCH||'main';
const ghOn=!!(GH_TOKEN&&GH_REPO);
let ghStateDirty=false,ghTimer=null,ghQueue=Promise.resolve(),ghLastPushAt=0,ghLastError=null,ghPushing=false,ghReady=!ghOn;
function ghDirty(){if(ghOn){ghStateDirty=true;if(!ghReady)return;clearTimeout(ghTimer);ghTimer=setTimeout(()=>ghPushState(),15000)}}

// ---------- penyimpanan ----------
const DBF=path.join(DATA,'db.json'),AUTHF=path.join(DATA,'auth.json');
function readJSON(f,fb){try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch(e){if(fs.existsSync(f)){const bad=f+'.rusak-'+Date.now();fs.copyFileSync(f,bad);console.error('PERINGATAN: '+path.basename(f)+' rusak, disalin ke '+bad);}return fb}}
let db=readJSON(DBF,{rev:0,tenants:{}});
let auth=readJSON(AUTHF,{users:{},sessions:{}});
const hash=(pw,salt)=>crypto.scryptSync(String(pw),salt,32).toString('hex');
function setPw(u,pw,extra={}){const salt=crypto.randomBytes(16).toString('hex');auth.users[u]=Object.assign(auth.users[u]||{tenant:'inti'},{salt,hash:hash(pw,salt),isDefault:false},extra);}
function seedDefaults(){let seeded=false;Object.entries(DEFAULTS).forEach(([u,d])=>{if(!auth.users[u]){if(['payroll','stok'].includes(u)){const seed=readJSON(path.join(ROOT,'payroll-seed.json'),{})[u];if(seed){auth.users[u]={...seed,tenant:'inti',isDefault:true};seeded=true}}else{setPw(u,d.pw,{tenant:'inti',isDefault:true});seeded=true}}});if(seeded)saveAuth(true)}
seedDefaults();
function verify(u,pw){const a=auth.users[u];if(!a)return false;const h=Buffer.from(hash(pw,a.salt),'hex'),b=Buffer.from(a.hash,'hex');return h.length===b.length&&crypto.timingSafeEqual(h,b)}
let saveT={},dirtyRev=0;
function atomic(f,obj){const t=f+'.tmp';fs.writeFileSync(t,JSON.stringify(obj));fs.renameSync(t,f)}
function saveDB(now){ghDirty();if(now){atomic(DBF,db);return}clearTimeout(saveT.db);saveT.db=setTimeout(()=>atomic(DBF,db),200)}
function saveAuth(now){ghDirty();if(now){atomic(AUTHF,auth);return}clearTimeout(saveT.au);saveT.au=setTimeout(()=>atomic(AUTHF,auth),200)}
function tenant(t){return db.tenants[t]||(db.tenants[t]={keys:{}})}

// ---------- persistensi GitHub: implementasi (konfigurasi ada di atas) ----------
async function ghApi(method,p,body){
 const r=await fetch('https://api.github.com/repos/'+GH_REPO+p,{method,signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+GH_TOKEN,Accept:'application/vnd.github+json','User-Agent':'ems-cks-server','X-GitHub-Api-Version':'2022-11-28'},body:body?JSON.stringify(body):undefined});
 if(r.status===404)return null;
 if(!r.ok){const t=await r.text().catch(()=> '');throw new Error('GitHub '+method+' '+p+' -> '+r.status+' '+t.slice(0,200))}
 return r.json();
}
async function ghRef(){const o=await ghApi('GET','/git/ref/heads/'+encodeURIComponent(GH_BRANCH));if(!o)throw new Error('branch '+GH_BRANCH+' tidak ada di '+GH_REPO);return o.object.sha}
// files: [{path, buf}] atau [{path, del:true}]; satu commit untuk semua.
function ghCommit(files,msg){
 if(!ghOn)return Promise.resolve();
 const job=ghQueue.then(async()=>{
  for(let attempt=0;attempt<2;attempt++){
   try{
    const base=await ghRef();
    const tree=[];
    for(const f of files){
     if(f.del){tree.push({path:f.path,mode:'100644',type:'blob',sha:null});continue}
     const blob=await ghApi('POST','/git/blobs',{content:f.buf.toString('base64'),encoding:'base64'});
     tree.push({path:f.path,mode:'100644',type:'blob',sha:blob.sha});
    }
    const tr=await ghApi('POST','/git/trees',{base_tree:base,tree});
    const cm=await ghApi('POST','/git/commits',{message:msg,tree:tr.sha,parents:[base]});
    await ghApi('PATCH','/git/refs/heads/'+encodeURIComponent(GH_BRANCH),{sha:cm.sha});
    ghLastPushAt=Date.now();ghLastError=null;return;
   }catch(e){if(attempt===1)throw e;await new Promise(r=>setTimeout(r,1500))}
  }
 });
 ghQueue=job.catch(e=>{ghLastError=e.message;console.error('GitHub push gagal:',e.message)});
 return job;
}
async function ghBlobText(sha){const o=await ghApi('GET','/git/blobs/'+sha);return o?Buffer.from(o.content,'base64'):null}
async function ghPushState(){
 if(!ghOn||!ghReady||!ghStateDirty||ghPushing)return;
 ghPushing=true;ghStateDirty=false;clearTimeout(ghTimer);
 try{
  // Flush without marking the same state dirty again.
  atomic(DBF,db);atomic(AUTHF,auth);
  await ghCommit([{path:'state/db.json',buf:fs.readFileSync(DBF)},{path:'state/auth.json',buf:fs.readFileSync(AUTHF)}],'data: sinkron otomatis '+new Date().toISOString());
 }catch(e){ghStateDirty=true;ghLastError=e.message;console.error('GitHub push state gagal:',e.message)}
 finally{ghPushing=false;if(ghStateDirty){clearTimeout(ghTimer);ghTimer=setTimeout(()=>ghPushState(),ghLastError?60000:15000)}}
}
async function ghPull(){
 if(!ghOn)return;
 try{
  const base=await ghRef();
  const tr=await ghApi('GET','/git/trees/'+base+'?recursive=1');
  const paths=new Map((tr.tree||[]).filter(x=>x.type==='blob').map(x=>[x.path,x.sha]));
  if(!paths.has('state/db.json')||!paths.has('state/auth.json'))throw new Error('Snapshot utama GitHub tidak lengkap; perlu pemulihan sebelum membuka server.');
  const dbBuf=await ghBlobText(paths.get('state/db.json')),authBuf=await ghBlobText(paths.get('state/auth.json'));
  if(!dbBuf||!authBuf)throw new Error('Snapshot GitHub tidak terbaca.');
  const nextDB=JSON.parse(dbBuf.toString()),nextAuth=JSON.parse(authBuf.toString());
  if(!Number.isInteger(nextDB.rev)||!nextDB.tenants||typeof nextDB.tenants!=='object'||Array.isArray(nextDB.tenants)||!nextAuth.users||typeof nextAuth.users!=='object'||Array.isArray(nextAuth.users))throw new Error('Snapshot GitHub tidak valid.');
  db=nextDB;auth=nextAuth;auth.sessions={};atomic(DBF,db);atomic(AUTHF,auth);seedDefaults();
  let nf=0;
  for(const [p,sha] of paths){if(!p.startsWith('files/'))continue;const local=path.join(FILES,p.slice(6));if(fs.existsSync(local))continue;const b=await ghBlobText(sha);if(!b)continue;fs.mkdirSync(path.dirname(local),{recursive:true});fs.writeFileSync(local,b);nf++}
  console.log('GitHub: data dipulihkan (rev '+db.rev+', lampiran baru '+nf+').');
 }catch(e){ghLastError=e.message;console.error('GitHub pull gagal; server tidak dibuka untuk mencegah penimpaan data:',e.message);throw e}
}
function ghFilePushT(tn,id){if(!ghOn)return;try{const base=path.join(fdir(tn),id);const rel=tn.replace(/[^a-z0-9-]/g,'_')+'/'+id;const files=[{path:'files/'+rel+'.json',buf:fs.readFileSync(base+'.json')}];if(fs.existsSync(base+'.bin'))files.push({path:'files/'+rel+'.bin',buf:fs.readFileSync(base+'.bin')});ghCommit(files,'lampiran: '+rel).catch(()=>{})}catch(e){console.error('GitHub push lampiran gagal:',e.message)}}
function ghFileDel(tn,id){if(!ghOn)return;const rel=tn.replace(/[^a-z0-9-]/g,'_')+'/'+id;ghCommit([{path:'files/'+rel+'.json',del:true},{path:'files/'+rel+'.bin',del:true}],'hapus lampiran: '+rel).catch(()=>{})}
setInterval(()=>{if(ghStateDirty)ghPushState()},5*60*1000);

// ---------- profil & sesi ----------
function profile(u){
 const a=auth.users[u];if(!a)return null;
 if(a.tenant!=='inti')return Object.assign({username:u,tenant:a.tenant},a.profile);
 const d=DEFAULTS[u];let p=d?{name:d.name,role:d.role,perms:d.perms.slice()}:null;
 let custom={};try{custom=JSON.parse(tenant('inti').keys['ems_custom_users_v2']?.v||'{}')}catch(e){}
 if(!d&&custom[u]&&Array.isArray(custom[u].perms))p={name:custom[u].name,role:custom[u].role,perms:custom[u].perms.slice(),accountType:custom[u].accountType};
 if(!p)return null;
 try{const n=JSON.parse(tenant('inti').keys['ems_user_names_v2']?.v||'{}');if(n[u])p.name=n[u]}catch(e){}
 return Object.assign({username:u,tenant:'inti'},p);
}
const isAdmin=s=>s&&s.tenant==='inti'&&(s.username==='ktu'||(profile(s.username)?.perms||[]).includes('serveradmin'));
const fails={};
function session(req,url){
 const h=req.headers.authorization||'';let t=h.startsWith('Bearer ')?h.slice(7):url.searchParams.get('token');
 const s=t&&auth.sessions[t];if(!s)return null;
 if(Date.now()-s.t>SESSION_HOURS*3600e3){delete auth.sessions[t];return null}
 return Object.assign({token:t},s);
}
const clients=new Set();
function broadcast(tn,msg){const d='data: '+JSON.stringify(msg)+'\n\n';clients.forEach(c=>{if(c.tenant===tn)c.res.write(d)})}


const EMP='ems_employees_v2',PAY='ems_payroll_periods_v2',WAGE='ems_wage_standards_v1';
const employeeCategory=x=>String(x.statusKaryawan||'').replace(/[-_]/g,' ').replace(/\s+/g,' ').trim().toUpperCase();
const parseRows=v=>{const x=JSON.parse(v||'[]');if(!Array.isArray(x))throw Error('Format daftar tidak valid.');return x};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function guardRoleWrite(s,key,value,previous){
 const perms=profile(s.username)?.perms||[],ktu=s.username==='ktu',limited=['personalia','payroll','stok'].includes(s.username);
 if(['payroll','stok'].includes(s.username)&&auth.users[s.username]?.isDefault&&!['ems_user_passwords_v2','simktu_activities_v2','ems_edit_history_v2'].includes(key))throw Error('Ganti password awal sebelum menggunakan akun.');
 const common=['simktu_activities_v2','ems_edit_history_v2','ems_messages_v1','ems_messages_read_v1','ems_user_passwords_v2','ems_user_names_v2'];
 if(limited&&!common.includes(key)&&!((s.username==='personalia'&&key===EMP)||(s.username==='payroll'&&key===PAY)||(s.username==='stok'&&key==='ems_asset_register_v2')))throw Error('Akses tulis ditolak untuk peran ini.');
 if(key===WAGE&&!ktu)throw Error('Standar upah hanya dapat diubah KTU.');
 if(key!==EMP&&key!==PAY)return;
 if(!ktu&&!perms.includes(key===EMP?'personalia':'payroll'))throw Error('Akses modul ditolak.');
 const rows=parseRows(value),old=parseRows(previous),map=new Map(old.map(x=>[String(x.id),x]));
 if(new Set(rows.map(x=>String(x.id))).size!==rows.length)throw Error('ID duplikat.');
 if(ktu)return;
 if(old.some(x=>!rows.some(y=>String(x.id)===String(y.id))))throw Error('Penghapusan hanya dapat dilakukan KTU.');
 for(const x of rows){const prev=map.get(String(x.id));if(same(x,prev))continue;
  if(key===EMP){
   if(s.username==='personalia'&&!['SKU H','SKU B'].includes(employeeCategory(x)))throw Error('Personalia hanya boleh menginput SKU H dan SKU B.');
   const a={...x},b={...prev};delete a.payrollTransfer;delete b.payrollTransfer;
   const transferOnly=prev&&same(a,b)&&prev.approval==='approved';
   if(transferOnly){if(!['SKU H','SKU B','BHL'].includes(employeeCategory(x))||!x.payrollTransfer?.at)throw Error('Kategori transfer tidak valid.');continue}
   if(x.approval!=='pending'||x.approvedBy||x.approvedAt)throw Error('Perubahan karyawan wajib menunggu persetujuan KTU.');
   if(x.payrollTransfer)throw Error('Data yang diubah harus diajukan ulang sebelum transfer.');
  }else{
   if(prev&&prev.status!=='draft')throw Error('Periode terkunci sampai keputusan KTU.');
   if(!['draft','menunggu_ktu'].includes(x.status)||x.approvedBy||x.approvedAt)throw Error('Finalisasi payroll hanya KTU.');
   if(x.status==='menunggu_ktu'){if(!x.lines?.length)throw Error('Rincian payroll kosong.');const standards=parseRows(tenant(s.tenant).keys[WAGE]?.v);for(const l of x.lines){if(!standards.some(w=>w.category===employeeCategory(l)&&w.effective<=x.start&&Number(w.amount)>0))throw Error('Standar upah kategori belum diatur KTU untuk awal periode.')}}
   const employees=parseRows(tenant(s.tenant).keys[EMP]?.v);
   for(const line of x.lines||[]){if(prev?.lines?.some(l=>same(l,line)))continue;const e=employees.find(e=>String(e.nik)===String(line.nik));if(!e||e.approval!=='approved'||!e.payrollTransfer?.at)throw Error('Karyawan belum disetujui dan ditransfer ke Payroll.');if(line.statusKaryawan!==e.statusKaryawan)throw Error('Kategori payroll harus sesuai data transfer.');}
  }
 }
}

// ---------- tulis data ----------
function isIdArray(a){return Array.isArray(a)&&a.every(x=>x&&typeof x==='object'&&!Array.isArray(x)&&(typeof x.id==='string'||typeof x.id==='number'))}
function applyWrite(s,op){
 const T=tenant(s.tenant);const key=String(op.key||'');
 if(!/^(ems_|simktu_)[a-z0-9_]+$/i.test(key))throw new Error('kunci tidak valid');
 const admin=isAdmin(s);
 if(s.tenant!=='inti'&&SECRET_KEYS.includes(key))throw new Error('tidak diizinkan');
 let cur=T.keys[key];let value;
 if(op.op==='del'){if([EMP,PAY].includes(key)&&s.username!=='ktu')throw Error('Penghapusan hanya dapat dilakukan KTU.');guardRoleWrite(s,key,'[]',cur?.v);delete T.keys[key];db.rev++;return {key,rev:0,remote:false}}
 if(op.op==='patch'){
  let arr=[];try{arr=JSON.parse(cur?.v||'[]')}catch(e){}
  if(!Array.isArray(arr))arr=[];
  const del=new Set((op.deletes||[]).map(String));
  const idx=new Map();arr.forEach((x,i)=>idx.set(String(x.id),i));
  arr=arr.filter(x=>!del.has(String(x.id)));idx.clear();arr.forEach((x,i)=>idx.set(String(x.id),i));
  for(const x of op.upserts||[]){const k=String(x.id);if(idx.has(k))arr[idx.get(k)]=x;else{idx.set(k,arr.length);arr.push(x)}}
  value=JSON.stringify(arr);
 }else{
  value=String(op.value);
 }
 guardRoleWrite(s,key,value,cur?.v);
 if(SECRET_KEYS.includes(key))value=guardSecrets(s,key,value,admin);
 const prev=cur?cur.rev:0;
 T.keys[key]={v:value,rev:prev+1};db.rev++;
 return {key,rev:prev+1,remote:prev!==(op.baseRev||0)};
}
function guardSecrets(s,key,value,admin){
 let obj;try{obj=JSON.parse(value)}catch(e){throw new Error('format tidak valid')}
 if(key==='ems_user_passwords_v2'){
  for(const [u,pw] of Object.entries(obj)){
   if(typeof pw!=='string'||!pw||pw===PH)continue;
   if(!admin&&u!==s.username)continue;                // pengguna biasa hanya boleh ganti password sendiri
   if(!auth.users[u]||auth.users[u].tenant!=='inti')continue;
   if(!verify(u,pw))setPw(u,pw);
  }
  saveAuth();return '{}';
 }
 if(key==='ems_custom_users_v2'){
  if(!admin)throw new Error('hanya KTU yang boleh mengubah daftar akun');
  const cur=tenant('inti').keys[key];let old={};try{old=JSON.parse(cur?.v||'{}')}catch(e){}
  for(const [u,x] of Object.entries(obj)){
   if(!x||typeof x!=='object')continue;
   if(!/^[a-z0-9._-]{2,40}$/.test(u)||DEFAULTS[u]){delete obj[u];continue}
   if(x.password&&x.password!==PH){setPw(u,x.password,{tenant:'inti'})}
   else if(!auth.users[u]&&old[u]&&old[u].password===PH){/* tetap */}
   if(!auth.users[u]){delete obj[u];continue}
   x.password=PH;
  }
  saveAuth();return JSON.stringify(obj);
 }
 if(key==='ems_user_names_v2'&&!admin){
  let old={};try{old=JSON.parse(tenant('inti').keys[key]?.v||'{}')}catch(e){}
  return JSON.stringify(Object.assign({},old,s.username in obj?{[s.username]:obj[s.username]}:{}));
 }
 return value;
}

// ---------- backup ----------
function stamp(d=new Date()){const p=n=>String(n).padStart(2,'0');return d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+'-'+p(d.getHours())+p(d.getMinutes())+p(d.getSeconds())}
let lastBackupRev=-1,lastBackupAt=null;
function makeBackup(tag){
 saveDB(true);saveAuth(true);
 const name=(tag||'backup')+'-'+stamp()+'.json';
 const buf=Buffer.from(JSON.stringify({app:'EMS-CKS-SERVER',createdAt:new Date().toISOString(),db,auth:{users:auth.users}}));
 fs.writeFileSync(path.join(BK,name),buf);
 if(ghOn){const dd=String(new Date().getDate()).padStart(2,'0');ghCommit([{path:'backups/latest.json',buf},{path:'backups/daily-'+dd+'.json',buf}],'backup: '+name).catch(()=>{})}
 lastBackupRev=db.rev;lastBackupAt=new Date().toISOString();prune();return name;
}
function listBackups(){return fs.readdirSync(BK).filter(f=>f.endsWith('.json')).map(f=>{const st=fs.statSync(path.join(BK,f));return{name:f,size:st.size,time:st.mtime.toISOString()}}).sort((a,b)=>b.time.localeCompare(a.time))}
function prune(){
 const now=Date.now(),perDay={};
 for(const b of listBackups()){
  const age=now-new Date(b.time).getTime();
  if(age>90*864e5){fs.unlinkSync(path.join(BK,b.name));continue}
  if(age>2*864e5&&!b.name.startsWith('manual')&&!b.name.startsWith('sebelum')){const day=b.time.slice(0,10);if(perDay[day])fs.unlinkSync(path.join(BK,b.name));else perDay[day]=1}
 }
}
setInterval(()=>{if(db.rev!==lastBackupRev)makeBackup('otomatis')},60*60*1000);

// ---------- HTTP ----------
const SEC_HEADERS={'X-Content-Type-Options':'nosniff','X-Frame-Options':'SAMEORIGIN','Referrer-Policy':'same-origin'};
function body(req,limit=120e6){return new Promise((res,rej)=>{const c=[];let n=0;req.on('data',d=>{n+=d.length;if(n>limit){rej(new Error('terlalu besar'));req.destroy();return}c.push(d)});req.on('end',()=>res(Buffer.concat(c)));req.on('error',rej)})}
const send=(res,code,obj,h={})=>{const b=typeof obj==='string'?obj:JSON.stringify(obj);res.writeHead(code,Object.assign({'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'},SEC_HEADERS,h));res.end(b)};
const safeId=s=>/^[A-Za-z0-9_-]{1,80}$/.test(s||'');
const fdir=t=>{const d=path.join(FILES,t.replace(/[^a-z0-9-]/g,'_'));fs.mkdirSync(d,{recursive:true});return d};
function ips(){const o=[];Object.values(os.networkInterfaces()).flat().forEach(i=>{if(i&&i.family==='IPv4'&&!i.internal)o.push(i.address)});return o}

const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://x');const p=url.pathname;
  if(p==='/'||p==='/index.html'){const f=path.join(ROOT,'public','index.html');res.writeHead(200,Object.assign({'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'},SEC_HEADERS));fs.createReadStream(f).pipe(res);return}
  if(p==='/role-split.js'){res.writeHead(200,Object.assign({'Content-Type':'application/javascript; charset=utf-8','Cache-Control':'no-store'},SEC_HEADERS));fs.createReadStream(path.join(ROOT,'public','role-split.js')).pipe(res);return}
  if(p==='/favicon.ico'){res.writeHead(204,SEC_HEADERS);res.end();return}
  if(!p.startsWith('/api/')){send(res,404,{error:'tidak ditemukan'});return}
  if(p==='/api/ping'){send(res,200,{ems:true,version:VERSION});return}
  if(p==='/api/login'&&req.method==='POST'){
   const {username,password}=JSON.parse((await body(req,1e5)).toString()||'{}');
   const u=String(username||'').trim().toLowerCase();const fk=req.socket.remoteAddress+'|'+u;const f=fails[fk]||{n:0,t:0};
   if(f.n>=8&&Date.now()-f.t<60e3){send(res,429,{error:'Terlalu banyak percobaan. Tunggu 1 menit.'});return}
   if(!auth.users[u]||!verify(u,String(password||''))){fails[fk]={n:f.n+1,t:Date.now()};send(res,401,{error:'Username atau password tidak sesuai.'});return}
   delete fails[fk];const pr=profile(u);if(!pr){send(res,403,{error:'Akun belum memiliki profil.'});return}
   if(pr.tenant!=='inti')pr.perms=pr.perms.filter(x=>MITRA_ALLOWED.includes(x));
   const token=crypto.randomBytes(24).toString('hex');auth.sessions[token]={username:u,tenant:pr.tenant,t:Date.now()};saveAuth();
   send(res,200,{token,user:Object.assign(pr,{mustChange:!!auth.users[u].isDefault})});return;
  }
  const s=session(req,url);if(!s){send(res,401,{error:'sesi berakhir'});return}
  s.profile=profile(s.username);if(!s.profile){send(res,401,{error:'akun tidak dikenal'});return}
  auth.sessions[s.token].t=Date.now();
  if(p==='/api/snapshot'){
   const out={};for(const [k,v] of Object.entries(tenant(s.tenant).keys)){if(SECRET_KEYS.includes(k)&&k==='ems_user_passwords_v2')continue;if(s.username==='personalia'&&k===PAY)continue;if(s.username==='stok'&&[EMP,PAY,WAGE].includes(k))continue;out[k]=v}
   const pr=s.profile;if(pr.tenant!=='inti')pr.perms=pr.perms.filter(x=>MITRA_ALLOWED.includes(x));
   send(res,200,{keys:out,user:Object.assign(pr,{mustChange:!!auth.users[s.username].isDefault})});return;
  }
  if(p==='/api/write'&&req.method==='POST'){
   const {ops,cid}=JSON.parse((await body(req)).toString());const results=[],errors=[];
   for(const op of ops||[]){try{results.push(applyWrite(s,op))}catch(e){errors.push({key:op.key,error:e.message})}}
   saveDB();
   if(results.length)broadcast(s.tenant,{src:cid,by:s.profile.name,keys:results.map(r=>({key:r.key,rev:r.rev}))});
   send(res,200,{results,errors,mustChange:!!auth.users[s.username].isDefault});return;
  }
  if(p==='/api/events'){
   res.writeHead(200,Object.assign({'Content-Type':'text/event-stream','Cache-Control':'no-store',Connection:'keep-alive'},SEC_HEADERS));res.write('retry: 3000\n\n');
   const c={res,tenant:s.tenant,user:s.profile.name};clients.add(c);const k=setInterval(()=>res.write(': ping\n\n'),20000);
   req.on('close',()=>{clients.delete(c);clearInterval(k)});return;
  }
  // berkas (lampiran dokumen)
  if(p==='/api/files'&&req.method==='GET'){send(res,200,{ids:fs.readdirSync(fdir(s.tenant)).filter(f=>f.endsWith('.json')).map(f=>f.slice(0,-5))});return}
  if(p==='/api/files'&&req.method==='DELETE'){if(!isAdmin(s)){send(res,403,{error:'hanya KTU'});return}fs.readdirSync(fdir(s.tenant)).forEach(f=>{const id=f.slice(0,-5);if(f.endsWith('.json'))ghFileDel(s.tenant,id)});fs.readdirSync(fdir(s.tenant)).forEach(f=>fs.unlinkSync(path.join(fdir(s.tenant),f)));send(res,200,{ok:true});return}
  let m=p.match(/^\/api\/files\/([^/]+)(\/meta)?$/);
  if(m){
   const id=m[1];if(!safeId(id)){send(res,400,{error:'id tidak valid'});return}
   const base=path.join(fdir(s.tenant),id);
   if(req.method==='PUT'){const buf=await body(req,60e6);const meta=JSON.parse(Buffer.from(String(req.headers['x-meta']||'e30='),'base64').toString('utf8'));fs.writeFileSync(base+'.bin',buf);fs.writeFileSync(base+'.json',JSON.stringify(meta));ghFilePushT(s.tenant,id);send(res,200,{ok:true});return}
   if(!fs.existsSync(base+'.json')){send(res,404,{error:'berkas tidak ada'});return}
   if(m[2]){send(res,200,fs.readFileSync(base+'.json','utf8'));return}
   if(req.method==='DELETE'){fs.unlinkSync(base+'.json');try{fs.unlinkSync(base+'.bin')}catch(e){}ghFileDel(s.tenant,id);send(res,200,{ok:true});return}
   const meta=JSON.parse(fs.readFileSync(base+'.json','utf8'));res.writeHead(200,Object.assign({'Content-Type':meta.blobType||meta.mime||'application/octet-stream','Cache-Control':'no-store'},SEC_HEADERS));fs.createReadStream(base+'.bin').pipe(res);return;
  }
  // reset password oleh KTU/Manager: server membuat password sementara acak,
  // ditampilkan sekali ke yang mereset; akun wajib menggantinya saat login berikutnya.
  if(p==='/api/admin/reset-password'&&req.method==='POST'){
   const perms=s.profile?.perms||[];
   if(!(s.tenant==='inti'&&(s.username==='ktu'||s.username==='manager'||perms.includes('serveradmin')))){send(res,403,{error:'Hanya KTU atau Manager yang dapat mereset password.'});return}
   const o=JSON.parse((await body(req,1e5)).toString()||'{}');
   const target=String(o.username||'').trim().toLowerCase();
   if(!auth.users[target]){send(res,404,{error:'Akun tidak ditemukan.'});return}
   const ABC='abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
   let temp='';
   while(temp.length<12||!/[a-z]/.test(temp)||!/[A-Z]/.test(temp)||!/[0-9]/.test(temp))temp=Array.from(crypto.randomBytes(12)).map(b=>ABC[b%ABC.length]).join('');
   setPw(target,temp,{isDefault:true});
   for(const[t,ses]of Object.entries(auth.sessions))if(ses.username===target)delete auth.sessions[t];
   saveAuth(true);
   send(res,200,{ok:true,username:target,tempPassword:temp,mustChange:true});return;
  }
  // admin
  if(p.startsWith('/api/admin/')){
   if(!isAdmin(s)){send(res,403,{error:'Hanya KTU/admin server.'});return}
   if(p==='/api/admin/status'){
    send(res,200,{rev:db.rev,online:[...clients].map(c=>c.user),backups:listBackups().slice(0,60),lastBackupAt,dataDir:DATA,addresses:ips().map(i=>'http://'+i+':'+PORT),port:PORT,version:VERSION,ghSync:ghOn?{repo:GH_REPO,pending:ghStateDirty||ghPushing,lastError:ghLastError,lastPushAt:ghLastPushAt?new Date(ghLastPushAt).toISOString():null}:false,
     users:Object.entries(auth.users).map(([u,a])=>({username:u,tenant:a.tenant,isDefault:!!a.isDefault,name:profile(u)?.name||'(tanpa profil)'})),
     tenants:Object.keys(db.tenants)});return}
   if(p==='/api/admin/backup'&&req.method==='POST'){send(res,200,{name:makeBackup('manual')});return}
   if(p==='/api/admin/backup/download'){const n=url.searchParams.get('name')||'';if(!/^[A-Za-z0-9_.-]+\.json$/.test(n)||!fs.existsSync(path.join(BK,n))){send(res,404,{error:'tidak ada'});return}
    res.writeHead(200,Object.assign({'Content-Type':'application/json','Content-Disposition':'attachment; filename="'+n+'"'},SEC_HEADERS));fs.createReadStream(path.join(BK,n)).pipe(res);return}
   if(p==='/api/admin/mitra-user'&&req.method==='POST'){
    const o=JSON.parse((await body(req,1e5)).toString());const u=String(o.username||'').toLowerCase(),t=String(o.tenant||'').toLowerCase();
    if(!/^[a-z0-9._-]{3,40}$/.test(u)||DEFAULTS[u]||(auth.users[u]&&auth.users[u].tenant==='inti'))throw new Error('Username tidak valid atau sudah dipakai akun kebun inti.');
    if(!/^mitra-[a-z0-9-]{2,30}$/.test(t))throw new Error('ID kebun mitra harus berbentuk mitra-nama (huruf kecil/angka/strip).');
    if(String(o.password||'').length<8)throw new Error('Password minimal 8 karakter.');
    const perms=(Array.isArray(o.perms)?o.perms:MITRA_ALLOWED).filter(x=>MITRA_ALLOWED.includes(x));
    setPw(u,o.password,{tenant:t,isDefault:false,profile:{name:String(o.name||u).slice(0,80),role:String(o.role||'Pengguna Kebun Mitra').slice(0,80),perms}});
    tenant(t);saveAuth(true);saveDB(true);send(res,200,{ok:true,tenant:t,perms});return;
   }
  }
  send(res,404,{error:'tidak ditemukan'});
 }catch(e){try{send(res,500,{error:e.message})}catch(_){}}
});

if(process.argv[2]==='--restore'){try{restoreFile(path.resolve(process.argv[3]));console.log('Restore berhasil. Jalankan server lagi.');}catch(e){console.error('Restore gagal: '+e.message)}process.exit(0)}
function restoreFile(file){
 const b=JSON.parse(fs.readFileSync(file,'utf8'));if(b.app!=='EMS-CKS-SERVER')throw new Error('Bukan file backup server.');
 makeBackup('sebelum-restore');db=b.db;auth.users=b.auth.users;auth.sessions={};saveDB(true);saveAuth(true);
}

(async()=>{
 await ghPull();ghReady=true;if(ghStateDirty)ghDirty();
 if(db.rev>0)makeBackup('start');
 setTimeout(()=>{if(db.rev!==lastBackupRev&&db.rev>0)makeBackup('otomatis')},2*60*1000);
 server.listen(PORT,'0.0.0.0',()=>{
  console.log('\n=== EMS PT. Citra Kenyalang Sakti - Server berjalan ('+VERSION+') ===');
  console.log('Buka di komputer ini  : http://localhost:'+PORT);
  ips().forEach(i=>console.log('Buka dari komputer lain di jaringan kantor: http://'+i+':'+PORT));
  console.log('Folder data & backup  : '+DATA);
  console.log('Sinkron GitHub        : '+(ghOn?GH_REPO+' (aktif)':'nonaktif'));
 });
})().catch(e=>{clearTimeout(ghTimer);console.error('Startup dihentikan: backup GitHub belum dapat diverifikasi.');process.exit(1)});
const bye=async()=>{if(!ghReady){process.exit(0);return}try{clearTimeout(ghTimer);saveDB(true);saveAuth(true);if(ghOn&&ghStateDirty){ghStateDirty=false;await Promise.race([ghCommit([{path:'state/db.json',buf:fs.readFileSync(DBF)},{path:'state/auth.json',buf:fs.readFileSync(AUTHF)}],'data: sinkron saat berhenti '+new Date().toISOString()),new Promise(r=>setTimeout(r,9000))])}}catch(e){}process.exit(0)};
process.on('SIGINT',()=>{bye()});process.on('SIGTERM',()=>{bye()});
