const JOB_COLORS={전사:'var(--job-jeon)',도적:'var(--job-do)',주술사:'var(--job-ju)',도사:'var(--job-dosa)'};

const firebaseConfig={
  apiKey:"AIzaSyAHjDQPwU2BTdFEQvGeVu8Ui9ntKFqBr6Q",
  authDomain:"archonic-baram-party.firebaseapp.com",
  databaseURL:"https://archonic-baram-party-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId:"archonic-baram-party",
  storageBucket:"archonic-baram-party.firebasestorage.app",
  messagingSenderId:"192279783273",
  appId:"1:192279783273:web:0a9b17d589adc830d27ff8"
};

const FB_OK=(typeof firebase!=='undefined');
const pageLoadTime = Date.now();
let db=null,queueRef=null,matchRef=null,squadRef=null;
const MATCH_KEEP=30;
const DDAEPAT_MIN=7;
const GYEOK_CAP=5;

let waitingQueue=[];
let matchedParties=[];
let squads={};
let userIp = "";
let isBannedUser = false;
let isAdminAuthenticated = false;

let audioCtx = null;
let audioBuffer = null;

if(FB_OK){
  firebase.initializeApp(firebaseConfig);
  db=firebase.database();
  queueRef=db.ref('queue');
  matchRef=db.ref('matched');
  squadRef=db.ref('squads');
}

async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function triggerAdminAuth() {
  const inputPw = prompt("🔒 시스템 관리자 보안 인증\n\n액세스 비밀번호를 입력하십시오.");
  if(!inputPw) return;
  const hashedTarget = "197d43dcc040ab9a6a1b802e221c69f88420981cb61705883fed66953352bff3";
  const processedHash = await sha256(inputPw.trim());
  if(processedHash === hashedTarget) {
    isAdminAuthenticated = true;
    document.getElementById('adminPanel').classList.add('active');
    toast("최고 관리자 권한 승인 완료. 제어 콘솔을 로드합니다.", "win");
    listenAdminBlacklist();
  } else {
    toast("보안 인증 실패: 비밀번호가 일치하지 않습니다.", "warn");
  }
}

function checkIpAndDeviceBan(){
  if(localStorage.getItem('baram_banned_device') === 'true'){
    applyBanUi();
    return;
  }
  fetch('https://api.ipify.org?format=json')
    .then(res => res.json())
    .then(data => {
      userIp = data.ip;
      if(!FB_OK) return;
      db.ref('blacklist_ips').once('value', snap => {
        const blacklist = snap.val() || {};
        const safeIpKey = userIp.replace(/\./g, '_');
        if(blacklist[safeIpKey]){
          localStorage.setItem('baram_banned_device', 'true');
          applyBanUi();
        }
      });
    })
    .catch(err => console.log("IP 가져오기 오류 (무시하고 진행):", err));
}

function applyBanUi(){
  isBannedUser = true;
  const regBtn = document.getElementById('regBtn');
  if(regBtn){
    regBtn.disabled = true;
    regBtn.textContent = "등록 불가 (차단됨)";
  }
  toast("악의적인 활동이 감지되어 시스템 이용이 제한되었습니다.", "warn");
}

function reportFakeMatch(matchKey) {
  if(!FB_OK) return;
  const realScammerNick = prompt("⚠️ 허위 매칭 신고 안내\n\n매칭 리스트에 적힌 사칭 닉네임 대신, 실제 디스코드나 인게임에서 접촉해 온 '진짜 빌런 닉네임'을 입력해 주세요.\n해당 유저의 등록 IP와 현재 브라우저가 즉각 차단 조치됩니다.");
  if(!realScammerNick || !realScammerNick.trim()) {
    toast("신고가 취소되었습니다.", "info");
    return;
  }
  const targetNick = realScammerNick.trim();
  db.ref('queue_ips').child(targetNick).once('value', snap => {
    let ScammerIp = snap.val();
    if(!ScammerIp) {
      const foundInQueue = waitingQueue.find(u => u.nick === targetNick);
      if(foundInQueue && foundInQueue._ip) ScammerIp = foundInQueue._ip;
    }
    if(ScammerIp) {
      const safeIpKey = ScammerIp.replace(/\./g, '_');
      db.ref('blacklist_ips').child(safeIpKey).set({
        ip: ScammerIp, estimatedNick: targetNick, ts: Date.now()
      }).then(() => {
        toast(`허위 등록 유저 [<b>${targetNick}</b>]의 IP가 즉시 영구 차단되었습니다.`, 'warn');
      });
    } else {
      db.ref('blacklist_nicks').child(targetNick).set(true);
      toast(`[<b>${targetNick}</b>] 님이 허위 사칭 유저로 신고 및 등록 차단 처리되었습니다.`, 'warn');
    }
  });
}

function listenAdminBlacklist() {
  if(!FB_OK || !isAdminAuthenticated) return;
  db.ref('blacklist_ips').on('value', snap => {
    const listContainer = document.getElementById('adminBanList');
    const data = snap.val();
    if(!data) {
      listContainer.innerHTML = '<div class="empty" style="padding:14px 0;">현재 시스템에 차단된 IP가 존재하지 않습니다.</div>';
      return;
    }
    let htmlStr = '';
    Object.keys(data).forEach(key => {
      const node = data[key];
      const actualIp = node.ip ? node.ip : key.replace(/_/g, '.');
      const nick = node.estimatedNick ? node.estimatedNick : "추적 불가 유저";
      htmlStr += `
        <div class="admin-ban-item">
          <div class="admin-ban-info">
            <b>${actualIp}</b>
            <span>(추정 ID: <b style="color:var(--gold); font-size:14px;">${nick}</b>)</span>
          </div>
          <button class="admin-unban-btn" onclick="removeIpBanFromServer('${key}', '${nick}')">❌ 차단 해제</button>
        </div>
      `;
    });
    listContainer.innerHTML = htmlStr;
  });
}

function removeIpBanFromServer(safeIpKey, associatedNick) {
  if(!FB_OK || !isAdminAuthenticated) return;
  if(!confirm(`정말로 해당 유저(추정 ID: ${associatedNick})의 IP 차단을 해제하시겠습니까?`)) return;
  db.ref('blacklist_ips').child(safeIpKey).remove()
    .then(() => {
      if(associatedNick && associatedNick !== "추적 불가 유저") {
        db.ref('blacklist_nicks').child(associatedNick).remove();
      }
      toast("해당 IP의 시스템 접근 차단이 정상적으로 해제되었습니다.", "info");
    }).catch(() => {
      toast("차단 해제 중 서버 네트워크 오류 발생", "warn");
    });
}

function saveUserInfoLocal(){
  const info = {
    nick: document.getElementById('userNick').value,
    job: document.getElementById('userJob').value,
    hp: document.getElementById('userHp').value,
    mp: document.getElementById('userMp').value,
    filterHp: document.getElementById('filterHp').value,
    filterJuMp: document.getElementById('filterHyeonjaMp').value,
    filterDosaMp: document.getElementById('filterDosaMp').value
  };
  localStorage.setItem('baram_match_user_presets', JSON.stringify(info));
}

function loadUserInfoLocal(){
  const saved = localStorage.getItem('baram_match_user_presets');
  if(saved){
    try {
      const info = JSON.parse(saved);
      if(info.nick) document.getElementById('userNick').value = info.nick;
      if(info.job) { document.getElementById('userJob').value = info.job; syncJobColor(); }
      if(info.hp) document.getElementById('userHp').value = info.hp;
      if(info.mp) document.getElementById('userMp').value = info.mp;
      if(info.filterHp) document.getElementById('filterHp').value = info.filterHp;
      if(info.filterJuMp) document.getElementById('filterHyeonjaMp').value = info.filterJuMp;
      if(info.filterDosaMp) document.getElementById('filterDosaMp').value = info.filterDosaMp;
    } catch(e) { console.error("기존 입력정보 로드 실패:", e); }
  }
}

function loadBlacklistLocal(){
  const saved = localStorage.getItem('baram_match_blacklist');
  if(saved) document.getElementById('blacklistInput').value = saved;
  renderBlacklistSide();
}

function syncBlacklistFromInput(){
  const val = document.getElementById('blacklistInput').value;
  localStorage.setItem('baram_match_blacklist', val);
  renderBlacklistSide();
}

function getMyBlacklistArray(){
  const val = document.getElementById('blacklistInput').value;
  return val.split(',').map(s=>s.trim()).filter(s=>s.length>0);
}

function renderBlacklistSide(){
  const container = document.getElementById('blacklistContainer');
  const countEl = document.getElementById('bCount');
  const arr = getMyBlacklistArray();
  countEl.textContent = arr.length;
  if(!arr.length){
    container.innerHTML = '<div class="empty" style="padding:12px 0; width:100%;">차단된 유저가 없습니다.</div>';
    return;
  }
  container.innerHTML = arr.map(name => `
    <span class="b-tag">
      <span>${name}</span>
      <button class="b-del" onclick="removeBlacklistUser('${name}')" title="차단 해제">×</button>
    </span>
  `).join('');
}

function removeBlacklistUser(name){
  let arr = getMyBlacklistArray();
  arr = arr.filter(n => n !== name);
  const updatedVal = arr.join(', ');
  document.getElementById('blacklistInput').value = updatedVal;
  localStorage.setItem('baram_match_blacklist', updatedVal);
  renderBlacklistSide();
  toast(`<b>${name}</b> 님의 차단을 해제했습니다.`, 'info');
  tryAutoMatch();
}

function initAudioSetup() {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  } catch(e) {
    console.log("AudioContext 초기화 불가:", e);
    return;
  }
  fetch('invite.mp3')
    .then(r => r.arrayBuffer())
    .then(data => audioCtx.decodeAudioData(data))
    .then(buffer => { audioBuffer = buffer; })
    .catch(err => console.log("알림음 로드 실패:", err));
}

function initConn(){
  loadUserInfoLocal();
  loadBlacklistLocal();
  checkIpAndDeviceBan();
  initAudioSetup();
  const box=document.getElementById('connState');
  const txt=document.getElementById('connText');
  if(!FB_OK){box.className='conn down';txt.textContent='서버 모듈 로드 실패';return;}
  db.ref('.info/connected').on('value',s=>{
    if(s.val()===true){box.className='conn live';txt.textContent='실시간 연결됨 · 문파 공유 중';}
    else{box.className='conn down';txt.textContent='서버 연결 끊김 · 재연결 시도 중';}
  });
  const unlockAudioContext = () => {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    window.removeEventListener('click', unlockAudioContext);
    window.removeEventListener('keydown', unlockAudioContext);
  };
  window.addEventListener('click', unlockAudioContext);
  window.addEventListener('keydown', unlockAudioContext);
}

function subscribe(){
  if(!FB_OK)return;
  queueRef.on('value',snap=>{
    const v=snap.val();
    waitingQueue=v?Object.keys(v).map(k=>({_id:k,...v[k]})):[];
    updateQueueDisplay();
    tryAutoMatch();
  });
  matchRef.on('value',snap=>{
    const v=snap.val();
    let arr=v?Object.keys(v).map(k=>({_id:k,...v[k]})):[];
    arr.sort((a,b)=>(b.ts||0)-(a.ts||0));
    matchedParties=arr;
    updateMatchedDisplay();
  });
  // 새 매칭 발생 시 모든 멤버 브라우저에서 소리+팝업
  matchRef.on('child_added', snap => {
    const party = snap.val();
    if(!party.ts || party.ts < pageLoadTime) return;
    const myNick = document.getElementById('userNick').value.trim();
    if(!myNick) return;
    if(party.members && party.members.some(m => m.nick === myNick)) {
      playMatchSound();
      openMatchModal({
        displayCategory: party.category,
        members: party.members,
        commonGrounds: party.commonGrounds || []
      });
      toast(`<b>[${party.category}]</b> 파티 매칭 완료!`, 'win');
    }
  });
  squadRef.on('value',snap=>{
    squads=snap.val()||{};
    updateMatchedDisplay();
    checkSquadComplete();
  });
}

function toast(msg,type='info'){
  const wrap=document.getElementById('toasts');
  const el=document.createElement('div');
  el.className='toast '+(type==='warn'?'warn':type==='win'?'win':'');
  const ico=type==='warn'?'⚠️':type==='win'?'🎉':'✦';
  el.innerHTML=`<span class="ti">${ico}</span><span>${msg}</span>`;
  wrap.appendChild(el);
  setTimeout(()=>{el.classList.add('out');setTimeout(()=>el.remove(),300);},type==='win'?3800:2600);
}

function bindChip(label){
  const input=label.querySelector('input');
  if(!input) return;
  const sync=()=>{
    if(input.type==='radio'){
      label.closest('.chips,.seg').querySelectorAll('label').forEach(l=>l.classList.remove('sel'));
      if(input.checked)label.classList.add('sel');
    }else{
      label.classList.toggle('sel',input.checked);
    }
  };
  input.addEventListener('change',()=>{
    if(input.type==='radio'){
      document.querySelectorAll(`input[name="${input.name}"]`).forEach(i=>{
        const l=i.closest('label');if(l)l.classList.toggle('sel',i.checked);
      });
    }else sync();
  });
}

function initBindings(){
  document.querySelectorAll('.chip, .seg label').forEach(bindChip);
  document.getElementById('userNick').addEventListener('keydown', (e) => { if(e.key === 'Enter') registerUser(); });
  document.getElementById('userHp').addEventListener('keydown', (e) => { if(e.key === 'Enter') registerUser(); });
  document.getElementById('userMp').addEventListener('keydown', (e) => { if(e.key === 'Enter') registerUser(); });
}

function syncJobColor(){
  const job=document.getElementById('userJob').value;
  document.getElementById('jobWrap').style.setProperty('--swatch',JOB_COLORS[job]||'var(--gold)');
}

function playMatchSound(){
  const doPlay = () => {
    if (audioCtx && audioBuffer) {
      try {
        const src = audioCtx.createBufferSource();
        src.buffer = audioBuffer;
        src.connect(audioCtx.destination);
        src.start(0);
        return;
      } catch(e) { console.error("Web Audio 재생 실패:", e); }
    }
    new Audio('invite.mp3').play().catch(()=>{});
  };
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().then(doPlay).catch(doPlay);
  } else {
    doPlay();
  }
}

function openMatchModal(partyData){
  const modal = document.getElementById('matchModal');
  const catEl = document.getElementById('modalCategory');
  const listContainer = document.getElementById('modalPartyList');
  const extraEl = document.getElementById('modalExtraInfo');
  catEl.textContent = `[${partyData.displayCategory}] 매칭 그룹이 결성되었습니다.`;
  let listHtml = partyData.members.map(m => {
    const isSlayer = (m.job === '전사' || m.job === '도적');
    const specStr = isSlayer ? `체력 ${m.hp}만` : `마력 ${m.mp}만`;
    const c = JOB_COLORS[m.job] || 'var(--gold)';
    const badge = `<span class="jb" style="background:${c}22;color:${c}; margin:0 0 0 5px; font-size:11px; padding:1px 6px;">${m.job}</span>`;
    const expTag = m.expBuff === 'O'
      ? `<span style="color:var(--jade);font-size:11.5px;font-weight:900;margin-left:5px;">⚡경쿠</span>`
      : `<span style="color:var(--paper-faint);font-size:11.5px;margin-left:5px;">경쿠X</span>`;
    const timeTag = `<span style="color:var(--gold-soft);font-size:11.5px;font-weight:700;margin-left:5px;">⏱${m.playTime||'30분'}</span>`;
    return `
      <div class="modal-member-row">
        <div class="modal-m-info" style="flex-wrap:wrap;gap:2px;">
          <span style="font-weight:700;">${m.nick}</span>${badge}${expTag}
        </div>
        <div class="modal-m-spec" style="white-space:nowrap;">${specStr}${timeTag}</div>
      </div>
    `;
  }).join('');
  listContainer.innerHTML = listHtml;
  let destText = '';
  if(partyData.commonGrounds && partyData.commonGrounds.length) {
    destText = `📍 <b>목적지 사냥터:</b> ${partyData.commonGrounds.join(', ')}`;
  } else {
    destText = `📍 <b>목적지:</b> 중간 지점 혹은 조건 세부 조율 필요`;
  }
  extraEl.innerHTML = `<div>${destText}</div>`;
  modal.classList.add('open');
}

function closeMatchModal(){
  document.getElementById('matchModal').classList.remove('open');
}

function togglePanels(){
  const c=document.getElementById('mainCategory').value;
  ['panelGyukdo','panelGyukdo1on1','panelDdubHell','panelMilgyeok','panelHyungga','panelChagyoon','panelRaid']
    .forEach(id=>{ const el=document.getElementById(id); if(el) el.classList.remove('on'); });
  if(c==='격도술')document.getElementById('panelGyukdo').classList.add('on');
  else if(c==='격도1대1')document.getElementById('panelGyukdo1on1').classList.add('on');
  else if(c==='떱헬')document.getElementById('panelDdubHell').classList.add('on');
  else if(c==='반반밀대'||c==='밀격쩔')document.getElementById('panelMilgyeok').classList.add('on');
  else if(c==='흉가노노')document.getElementById('panelHyungga').classList.add('on');
  else if(c==='차균')document.getElementById('panelChagyoon').classList.add('on');
  else if(c==='레이드')document.getElementById('panelRaid').classList.add('on');
}

function registerUser(){
  if(isBannedUser) { toast('차단된 상태이므로 등록할 수 없습니다.','warn'); return; }
  if(!FB_OK){toast('서버에 연결되지 않았습니다.','warn');return;}
  const nick=document.getElementById('userNick').value.trim();
  if(!nick){toast('닉네임을 입력해주세요.','warn');return;}
  db.ref('blacklist_nicks').child(nick).once('value', snap => {
    if(snap.val() === true) { applyBanUi(); return; }
  });
  const job=document.getElementById('userJob').value;
  const hp=document.getElementById('userHp').value||'0';
  const mp=document.getElementById('userMp').value||'0';
  const category=document.getElementById('mainCategory').value;
  if(!category){toast('매칭 항목을 선택해주세요.','warn');return;}
  const playTime=document.getElementById('playTime').value;
  const reqFilterHp = document.getElementById('filterHp').value || '0';
  const reqFilterJuMp = document.getElementById('filterHyeonjaMp').value || '0';
  const reqFilterDoMp = document.getElementById('filterDosaMp').value || '0';
  const myBlacklist = getMyBlacklistArray();
  let huntingGrounds=[],expBuff='X',mildae='X',details=[],raidBoss='',raidType='',hyunggaRole='';
  if(category==='격도술'){
    document.querySelectorAll('#panelGyukdo input[type=checkbox]:checked').forEach(cb=>huntingGrounds.push(cb.value));
    if(!huntingGrounds.length){toast('사냥터를 하나 이상 선택해주세요.','warn');return;}
    expBuff=document.querySelector('input[name=expBuffA]:checked').value;
    mildae=document.querySelector('input[name=mildaeA]:checked').value;
    details.push(`경쿠:${expBuff}`,`밀대:${mildae}`);
  }else if(category==='격도1대1'){
    document.querySelectorAll('#panelGyukdo1on1 input[type=checkbox]:checked').forEach(cb=>huntingGrounds.push(cb.value));
    if(!huntingGrounds.length){toast('사냥터를 하나 이상 선택해주세요.','warn');return;}
    expBuff=document.querySelector('input[name=expBuff1on1]:checked').value;
    mildae=document.querySelector('input[name=mildae1on1]:checked').value;
    details.push(`경쿠:${expBuff}`,`밀대:${mildae}`);
  }else if(category==='떱헬'){
    document.querySelectorAll('#panelDdubHell input[type=checkbox]:checked').forEach(cb=>huntingGrounds.push(cb.value));
    if(!huntingGrounds.length){toast('사냥터를 하나 이상 선택해주세요.','warn');return;}
  }else if(category==='반반밀대'||category==='밀격쩔'){
    document.querySelectorAll('#panelMilgyeok input[type=checkbox]:checked').forEach(cb=>huntingGrounds.push(cb.value));
    if(!huntingGrounds.length){toast('사냥터를 하나 이상 선택해주세요.','warn');return;}
    details.push(`역할:${document.getElementById('subRole').value}`);
  }else if(category==='흉가노노'){
    hyunggaRole=document.querySelector('input[name=hyunggaRole]:checked').value;
    details.push(`역할:${hyunggaRole}`);
  }else if(category==='차균'){
    document.querySelectorAll('#panelChagyoon input[type=checkbox]:checked').forEach(cb=>huntingGrounds.push(cb.value));
    if(!huntingGrounds.length){toast('단수를 선택해주세요.','warn');return;}
  }else if(category==='레이드'){
    raidBoss=document.querySelector('input[name=raidBoss]:checked').value;
    raidType=document.getElementById('raidType').value;
    details.push(`보스:${raidBoss}`,`방식:${raidType}`);
  }
  if(category==='레이드' && raidType==='떼팟'){
    const member={nick,job,hp,mp,playTime,ts:Date.now()};
    squadRef.child(raidBoss).child('members').push(member)
      .then(()=>toast(`<b>${nick}</b> 님, ${raidBoss} 떼팟에 합류했습니다.`,'info'))
      .catch(()=>toast('합류 실패','warn'));
    return;
  }
  const entry={
    nick,job,hp,mp,category,huntingGrounds,expBuff,mildae,raidBoss,raidType,hyunggaRole,playTime,
    filterHp: reqFilterHp, filterJuMp: reqFilterJuMp, filterDoMp: reqFilterDoMp,
    blacklist: myBlacklist,
    _ip: userIp,
    detailsStr:details.length?details.join(', '):huntingGrounds.join(', '),
    ts:firebase.database.ServerValue.TIMESTAMP
  };
  if(userIp) db.ref('queue_ips').child(nick).set(userIp);
  queueRef.push(entry)
    .then(()=>toast(`<b>${nick}</b> 님, 대기열에 등록되었습니다.`,'info'))
    .catch(()=>toast('등록 실패','warn'));
}

function cancelQueue(id){
  if(!FB_OK)return;
  const u=waitingQueue.find(x=>x._id===id);
  queueRef.child(id).remove()
    .then(()=>{if(u)toast(`<b>${u.nick}</b> 님의 대기를 취소했습니다.`,'info');})
    .catch(()=>toast('취소 실패','warn'));
}

let matchBusy=false;
function tryAutoMatch(){
  if(!FB_OK)return;
  if(matchBusy)return;
  matchBusy=true;
  cleanOldMatchedParties();
  let plannedParty=null;
  queueRef.transaction(current=>{
    plannedParty=null;
    if(!current)return current;
    const list=Object.keys(current).map(k=>({_id:k,...current[k]}));
    const result=findParty(list);
    if(!result)return current;
    plannedParty=result;
    result.members.forEach(m=>{delete current[m._id];});
    return current;
  },(err,committed,snapshot)=>{
    matchBusy=false;
    if(err||!committed||!plannedParty)return;
    const p=plannedParty;
    const n=new Date();
    const rec={
      category:p.displayCategory,
      members:p.members.map(({_id,ts,...rest})=>rest),
      matchTime:`${n.getHours()}:${String(n.getMinutes()).padStart(2,'0')}`,
      commonGrounds:p.commonGrounds||[],
      ts:Date.now()
    };
    matchRef.push(rec).then(()=>{
      matchRef.orderByChild('ts').once('value',s=>{
        const all=[];s.forEach(c=>all.push({k:c.key,ts:c.val().ts||0}));
        all.sort((a,b)=>all.ts-b.ts);
        const over=all.length-MATCH_KEEP;
        for(let i=0; i<over; i++)matchRef.child(all[i].k).remove();
      });
    });
    setTimeout(tryAutoMatch,150);
  });
}

function cleanOldMatchedParties(){
  if(!FB_OK) return;
  const now = Date.now();
  const twoHoursMs = 2 * 60 * 60 * 1000;
  matchRef.once('value', snap => {
    const data = snap.val();
    if(!data) return;
    Object.keys(data).forEach(key => {
      const p = data[key];
      if(p.ts && (now - p.ts >= twoHoursMs)) matchRef.child(key).remove();
    });
  });
}

function checkSpecsAndBlacklist(u1, u2, u3=null) {
  const users = [u1, u2];
  if(u3) users.push(u3);
  for(let i=0; i<users.length; i++){
    const me = users[i];
    const myBanList = me.blacklist || [];
    for(let j=0; j<users.length; j++){
      if(i === j) continue;
      if(myBanList.includes(users[j].nick)) return false;
    }
  }
  for(let i=0; i<users.length; i++) {
    const target = users[i];
    const fHp = parseInt(target.filterHp || '0');
    const fJu = parseInt(target.filterJuMp || '0');
    const fDo = parseInt(target.filterDosaMp || '0');
    for(let j=0; j<users.length; j++) {
      if(i === j) continue;
      const peer = users[j];
      const peerHp = parseInt(peer.hp || '0');
      const peerMp = parseInt(peer.mp || '0');
      if((peer.job==='전사'||peer.job==='도적') && peerHp < fHp) return false;
      if(peer.job==='주술사' && peerMp < fJu) return false;
      if(peer.job==='도사' && peerMp < fDo) return false;
    }
  }
  return true;
}

function findParty(list){
  {
    const pool=list.filter(u=>u.category==='격도1대1');
    const a=pool.find(u=>u.job!=='도사'), d=pool.find(u=>u.job==='도사'&&u!==a);
    if(a && d && checkSpecsAndBlacklist(a, d)) {
      const cg=(a.huntingGrounds||[]).filter(g=>(d.huntingGrounds||[]).includes(g));
      if(cg.length > 0) return {displayCategory:'격도(1대1)', members:[a,d], commonGrounds:cg};
    }
  }
  {
    const pool=list.filter(u=>u.category==='레이드' && u.raidType==='격도1대1');
    for(const u1 of pool) {
      if(u1.job === '도사') continue;
      const u2 = pool.find(x => x.job==='도사' && x.raidBoss===u1.raidBoss && x._id!==u1._id && checkSpecsAndBlacklist(u1, x));
      if(u2) return {displayCategory:`레이드-${u1.raidBoss}(1대1)`, members:[u1, u2], commonGrounds:[]};
    }
  }
  {
    const pool=list.filter(u=>u.category==='떱헬' && u.job==='주술사');
    if(pool.length >= 2){
      for(let i=0; i<pool.length; i++){
        for(let j=i+1; j<pool.length; j++){
          const u1=pool[i]; const u2=pool[j];
          if(checkSpecsAndBlacklist(u1, u2)){
            const cg=(u1.huntingGrounds||[]).filter(g=>(u2.huntingGrounds||[]).includes(g));
            if(cg.length > 0) return {displayCategory:'떱헬(술사+술사)', members:[u1,u2], commonGrounds:cg};
          }
        }
      }
    }
  }
  {
    const pool=list.filter(u=>u.category==='흉가노노');
    const a=pool.find(u=>u.hyunggaRole==='격수'),d=pool.find(u=>u.hyunggaRole==='도사'&&u!==a);
    if(a&&d&&checkSpecsAndBlacklist(a,d))return{displayCategory:'흉가노노',members:[a,d],commonGrounds:[]};
  }
  {
    const pool=list.filter(u=>u.category==='레이드'&&u.raidType==='격도술');
    const bosses=[...new Set(pool.map(u=>u.raidBoss))];
    for(const boss of bosses){
      const sp=pool.filter(u=>u.raidBoss===boss);
      if(sp.length>=3){
        for(let i=0;i<sp.length;i++)
          for(let j=i+1;j<sp.length;j++)
            for(let k=j+1;k<sp.length;k++)
              if(checkSpecsAndBlacklist(sp[i],sp[j],sp[k]))
                return{displayCategory:`레이드-${boss}(격도술)`,members:[sp[i],sp[j],sp[k]],commonGrounds:[]};
      }
    }
  }
  {
    const cats=['격도술','반반밀대','밀격쩔','차균'];
    for(const cat of cats){
      const same=list.filter(u=>u.category===cat);
      if(same.length>=3){
        for(let i=0;i<same.length;i++)
          for(let j=i+1;j<same.length;j++)
            for(let k=j+1;k<same.length;k++){
              const p1=same[i],p2=same[j],p3=same[k];
              if(checkSpecsAndBlacklist(p1,p2,p3)){
                let cg=[];
                if(p1.huntingGrounds&&p1.huntingGrounds.length){
                  cg=p1.huntingGrounds.filter(g=>(p2.huntingGrounds||[]).includes(g)&&(p3.huntingGrounds||[]).includes(g));
                  if(!cg.length) continue;
                }
                return{displayCategory:cat,members:[p1,p2,p3],commonGrounds:cg};
              }
            }
      }
    }
  }
  return null;
}

function jobBadge(job){
  const c=JOB_COLORS[job]||'var(--gold)';
  return `<span class="jb" style="background:${c}22;color:${c};">${job}</span>`;
}

function computeSquad(boss){
  const node=(squads&&squads[boss]&&squads[boss].members)||{};
  const members=Object.keys(node).map(k=>({_id:k,...node[k]})).sort((a,b)=>(b.ts||0)-(b.ts||0));
  const gyeokAll=members.filter(m=>m.job==='전사'||m.job==='도적');
  const dosaAll=members.filter(m=>m.job==='도사');
  const sulsaAll=members.filter(m=>m.job==='주술사');
  let gIn=Math.min(gyeokAll.length,dosaAll.length,GYEOK_CAP);
  let dIn=dosaAll.length;
  while(gIn+dIn>10){ if(dIn>gIn) dIn--; else gIn--; }
  let sIn=Math.min(sulsaAll.length,10-gIn-dIn);
  const main=[...gyeokAll.slice(0,gIn),...dosaAll.slice(0,dIn),...sulsaAll.slice(0,sIn)];
  const reserveGyeok=gyeokAll.slice(gIn);
  return {members,main,reserveGyeok,gyeok:gIn,dosa:dIn,sulsa:sIn};
}

let squadCompleting={};
function checkSquadComplete(){
  if(!FB_OK||!squads)return;
  Object.keys(squads).forEach(boss=>{
    const s=computeSquad(boss);
    if(s.main.length>=10 && !squadCompleting[boss]){
      squadCompleting[boss]=true;
      const n=new Date();
      const rec={
        category:`레이드-${boss}(떼팟)`,
        members:s.main.slice(0,10).map(({_id,ts,...r})=>r),
        matchTime:`${n.getHours()}:${String(n.getMinutes()).padStart(2,'0')}`,
        commonGrounds:[],ts:Date.now()
      };
      matchRef.push(rec).then(()=>{
        const updates={};
        s.main.slice(0,10).forEach(m=>{updates[m._id]=null;});
        squadRef.child(boss).child('members').update(updates).then(()=>{squadCompleting[boss]=false;});
        matchRef.orderByChild('ts').once('value',ss=>{
          const all=[];ss.forEach(c=>all.push({k:c.key,ts:c.val().ts||0}));
          all.sort((a,b)=>all.ts-b.ts);
          for(let i=0;i<all.length-MATCH_KEEP;i++)matchRef.child(all[i].k).remove();
        });
      }).catch(()=>{squadCompleting[boss]=false;});
    }
  });
}

function cancelSquadMember(boss,id){
  if(!FB_OK)return;
  squadRef.child(boss).child('members').child(id).remove()
    .then(()=>toast('떼팟 구성에서 빠졌습니다.','info'))
    .catch(()=>toast('취소 실패','warn'));
}

function updateQueueDisplay(){
  const L=document.getElementById('queueList');
  document.getElementById('qCount').textContent=waitingQueue.length;
  if(!waitingQueue.length){L.innerHTML='<div class="empty">대기 중인 인원이 없습니다.</div>';return;}
  L.innerHTML='';
  waitingQueue.forEach((u)=>{
    let sub=u.detailsStr;
    if(u.huntingGrounds&&u.huntingGrounds.length)
      sub=`사냥터: ${u.huntingGrounds.join(', ')}`+(u.detailsStr?` · ${u.detailsStr}`:'');
    const c=JOB_COLORS[u.job]||'var(--gold)';
    const d=document.createElement('div');
    d.className='qitem';d.style.setProperty('--accent',c);
    d.innerHTML=`
      <div style="flex:1;min-width:0;">
        <div><span class="nm">${u.nick}</span>${jobBadge(u.job)}</div>
        <div class="stat">체력 ${u.hp}만 · 마력 ${u.mp}만 <span style="color:var(--gold-soft);">(${u.playTime||'30분'})</span></div>
        <div class="mode">➔ ${u.category} <span style="color:var(--paper-dim);">[${sub}]</span></div>
      </div>
      <button class="x-btn" onclick="cancelQueue('${u._id}')" title="대기 취소">×</button>`;
    L.appendChild(d);
  });
}

function updateMatchedDisplay(){
  const M=document.getElementById('matchSuccessList');
  M.innerHTML='';
  let squadShown=false;
  if(squads){
    Object.keys(squads).forEach(boss=>{
      const s=computeSquad(boss);
      if(s.main.length<DDAEPAT_MIN)return;
      squadShown=true;
      const mainList=s.main.map(m=>`
        <span class="sq-mem">
          ${m.nick}${jobBadge(m.job)}
          <button class="sq-x" onclick="cancelSquadMember('${boss}','${m._id}')" title="빠지기">×</button>
        </span>`).join('');
      const reserve=s.reserveGyeok.length
        ? s.reserveGyeok.map((m,i)=>`
            <span class="sq-mem rsv">
              예비 격수 ${i+1}순번 · ${m.nick}
              <button class="sq-x" onclick="cancelSquadMember('${boss}','${m._id}')" title="빠지기">×</button>
            </span>`).join('')
        : '<span style="color:var(--paper-dim);font-size:13.5px;font-weight:bold;">예비 격수 없음</span>';
      const card=document.createElement('div');
      card.className='mcard squad';
      card.innerHTML=`
        <div class="top">
          <span class="mtag prog">${boss} 떼팟</span>
          <span class="sq-count">${s.main.length} / 10</span>
          <span class="mdone prog">● 구성 중</span>
        </div>
        <div class="sq-stat">격수 ${s.gyeok} · 도사 ${s.dosa} · 술사 ${s.sulsa}</div>
        <div class="sq-bar"><div class="sq-fill" style="width:${s.main.length*10}%"></div></div>
        <div class="sq-grid">${mainList}</div>
        <div class="sq-rsv-wrap">🔁 ${reserve}</div>`;
      M.appendChild(card);
    });
  }
  if(!matchedParties.length && !squadShown){
    M.innerHTML='<div class="empty">아직 결성된 파티가 없습니다.</div>';return;
  }
  matchedParties.forEach(p=>{
    const names=p.members.map(m=>`${m.nick}(${m.job})`).join(', ');
    let dest;
    if(p.commonGrounds&&p.commonGrounds.length)
      dest=`📍 목적지 사냥터: <b>${p.commonGrounds.join(', ')}</b>`;
    else if(/격도술|격도1대1|떱헬|반반밀대|밀격쩔/.test(p.category))
      dest=`📍 목적지 사냥터: <span class="none">공통 사냥터 없음 (중간지점 조율 필요)</span>`;
    else
      dest=`📍 설정 세부사항: <b>${p.members[0].detailsStr||'기본 조건 진행'}</b>`;
    const exp=p.members.filter(m=>m.expBuff==='O').map(m=>m.nick);
    const mil=p.members.filter(m=>m.mildae==='O').map(m=>m.nick);
    const times=p.members.map(m=>`${m.nick}:${m.playTime||'30분'}`).join(', ');
    const c=document.createElement('div');c.className='mcard';
    c.innerHTML=`
      <div class="top">
        <span class="mtag">${p.category}</span>
        <span class="mtime">${p.matchTime} 결성</span>
        <span class="mdone">● 결성 완료</span>
      </div>
      <button class="report-btn" onclick="reportFakeMatch('${p._id}')">⚠️ 허위 매칭 신고</button>
      <div class="mmem">👥 [${p.members.length}명] ${names}</div>
      <div class="mdest">${dest}</div>
      <div class="mdest" style="font-size:13.5px; color:var(--gold); font-weight:700;">⏱️ 희망 시간: [ ${times} ]</div>
      <div class="mfoot">⚡ 경쿠: ${exp.length?exp.join(', '):'없음'} · 밀대 진선: ${mil.length?'O ('+mil.join(', ')+')':'X'}</div>`;
    M.appendChild(c);
  });
}

initBindings();
syncJobColor();
updateQueueDisplay();
updateMatchedDisplay();
initConn();
subscribe();
