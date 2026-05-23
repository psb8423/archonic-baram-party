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
let db=null,queueRef=null,matchRef=null,squadRef=null,pendingMatchRef=null;
const MATCH_KEEP=30;
const DDAEPAT_MIN=7;
const GYEOK_CAP=5;
const QUEUE_EXPIRE_MS = 30 * 60 * 1000; // 30분

let waitingQueue=[];
let matchedParties=[];
let squads={};
let userIp = "";
let isBannedUser = false;
let isAdminAuthenticated = false;

let audioCtx = null;
let audioBuffer = null;

let activePendingId = null;
let pendingTimerInterval = null;

if(FB_OK){
  firebase.initializeApp(firebaseConfig);
  db=firebase.database();
  queueRef=db.ref('queue');
  matchRef=db.ref('matched');
  squadRef=db.ref('squads');
  pendingMatchRef=db.ref('pending_matches');
}

function calcDecayedScore(data) {
  if(!data || !data.score) return 0;
  const hoursPassed = (Date.now() - (data.last_updated || Date.now())) / 3600000;
  const decay = Math.floor(hoursPassed / 12) * 0.1;
  return Math.max(0, (data.score || 0) - decay);
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
      const safeIpKey = data.ip.replace(/\./g, '_');
      db.ref('blacklist_ips').child(safeIpKey).once('value', snap => {
        if(snap.val()){
          localStorage.setItem('baram_banned_device', 'true');
          applyBanUi();
          return;
        }
        db.ref('users_penalty').child(safeIpKey).once('value', penSnap => {
          if(calcDecayedScore(penSnap.val()) >= 1.0){
            localStorage.setItem('baram_banned_device', 'true');
            applyBanUi();
          }
        });
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
  const rawNick = prompt("⚠️ 신고 안내\n\n신고할 대상의 닉네임을 입력하세요.");
  if(!rawNick || !rawNick.trim()) { toast("신고가 취소되었습니다.", "info"); return; }
  const targetNick = rawNick.trim();

  const reasonInput = prompt(`[${targetNick}] 신고 사유를 선택하세요:\n1 = 사칭\n2 = 비매너\n3 = 허위 매칭\n(또는 직접 입력)`);
  if(!reasonInput) { toast("신고가 취소되었습니다.", "info"); return; }
  const reason = {'1':'사칭','2':'비매너','3':'허위 매칭'}[reasonInput.trim()] || reasonInput.trim();

  db.ref('queue_ips').child(targetNick).once('value', snap => {
    let targetIp = snap.val();
    if(!targetIp) {
      const found = waitingQueue.find(u => u.nick === targetNick);
      if(found && found._ip) targetIp = found._ip;
    }

    db.ref('reports').push({ targetNick, targetIp: targetIp||'unknown', reporterIp: userIp||'unknown', reason, matchKey, ts: Date.now() });

    if(targetIp) {
      const safeKey = targetIp.replace(/\./g, '_');
      db.ref('users_penalty').child(safeKey).transaction(current => {
        const now = Date.now();
        if(!current) return { score: 1.0, last_updated: now, status: 'banned', estimatedNick: targetNick, ip: targetIp };
        const newScore = calcDecayedScore(current) + 1.0;
        return { ...current, score: newScore, last_updated: now, status: newScore >= 1.0 ? 'banned' : 'active', estimatedNick: targetNick };
      }).then(result => {
        if(!result.committed) return;
        const finalScore = calcDecayedScore(result.snapshot.val());
        if(finalScore >= 1.0) {
          db.ref('blacklist_ips').child(safeKey).set({ ip: targetIp, estimatedNick: targetNick, ts: Date.now(), source: 'penalty' });
          toast(`[<b>${targetNick}</b>] 누적 신고로 즉시 차단 처리되었습니다.`, 'warn');
        } else {
          toast(`[<b>${targetNick}</b>] 신고 접수 완료. 누적 시 자동 차단됩니다.`, 'warn');
        }
      });
    } else {
      db.ref('blacklist_nicks').child(targetNick).set(true);
      toast(`[<b>${targetNick}</b>] 신고 접수 완료.`, 'warn');
    }
  });
}

function listenAdminBlacklist() {
  if(!FB_OK || !isAdminAuthenticated) return;
  const listContainer = document.getElementById('adminBanList');

  db.ref('users_penalty').on('value', snap => {
    const data = snap.val() || {};
    const entries = Object.keys(data)
      .map(key => ({ key, ...data[key], currentScore: calcDecayedScore(data[key]) }))
      .filter(e => e.currentScore > 0)
      .sort((a, b) => b.currentScore - a.currentScore);

    if(!entries.length) {
      listContainer.innerHTML = '<div class="empty" style="padding:14px 0;">신고된 유저가 없습니다.</div>';
      return;
    }

    listContainer.innerHTML = entries.map(e => {
      const isBanned = e.currentScore >= 1.0;
      const ip = e.ip || e.key.replace(/_/g, '.');
      const nick = e.estimatedNick || '추적 불가';
      const scoreLabel = `<span class="admin-score ${isBanned?'banned':'warned'}">점수 ${e.currentScore.toFixed(1)} ${isBanned?'[차단중]':'[경고]'}</span>`;
      return `
        <div class="admin-ban-item">
          <div class="admin-ban-info">
            <b>${ip}</b>
            <span>(추정 ID: <b style="color:var(--gold);font-size:14px;">${nick}</b>)</span>
            ${scoreLabel}
          </div>
          <div class="admin-btn-row">
            <button class="admin-unban-btn" onclick="adminResetPenalty('${e.key}','${nick}')">점수 초기화</button>
            ${isBanned ? `<button class="admin-unban-btn" onclick="removeIpBanFromServer('${e.key}','${nick}')">차단 해제</button>` : ''}
          </div>
        </div>
      `;
    }).join('');
  });
}

function adminResetPenalty(safeKey, nick) {
  if(!FB_OK || !isAdminAuthenticated) return;
  if(!confirm(`[${nick}]의 신고 점수를 초기화하시겠습니까?`)) return;
  db.ref('users_penalty').child(safeKey).update({ score: 0, status: 'active', last_updated: Date.now() })
    .then(() => {
      db.ref('blacklist_ips').child(safeKey).remove();
      toast(`[${nick}] 신고 점수가 초기화되었습니다.`, 'info');
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

function addBlacklistEntry(){
  const val = document.getElementById('blacklistInput').value.trim();
  if(!val) return;
  syncBlacklistFromInput();
  toast('등록되었습니다. 취소할 수 있습니다.', 'info');
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

// ── 대기열 만료 처리 ──
function cleanExpiredQueue() {
  if(!FB_OK) return;
  const now = Date.now();
  queueRef.once('value', snap => {
    const v = snap.val();
    if(!v) return;
    Object.keys(v).forEach(k => {
      if(v[k].ts && now - v[k].ts >= QUEUE_EXPIRE_MS) queueRef.child(k).remove();
    });
  });
}

// ── 대기열 갱신 (30분 연장) ──
function refreshQueue(id) {
  if(!FB_OK) return;
  const u = waitingQueue.find(x => x._id === id);
  if(!u) return;
  if(userIp && u._ip !== userIp) { toast('본인의 대기열만 갱신할 수 있습니다.', 'warn'); return; }
  queueRef.child(id).update({ ts: firebase.database.ServerValue.TIMESTAMP })
    .then(() => toast(`<b>${u.nick}</b> 님의 대기열이 갱신되었습니다. (30분 연장)`, 'info'))
    .catch(() => toast('갱신 실패', 'warn'));
}

// ── 만료된 pending match 정리 ──
function cleanExpiredPending() {
  if(!FB_OK) return;
  const now = Date.now();
  pendingMatchRef.once('value', snap => {
    const v = snap.val();
    if(!v) return;
    Object.keys(v).forEach(k => {
      const p = v[k];
      if(p.status === 'pending' && p.pendingTs && now - p.pendingTs >= 60000) {
        pendingMatchRef.child(k).transaction(cur => {
          if(!cur || cur.status !== 'pending') return;
          return { ...cur, status: 'timeout' };
        }).then(res => { if(res.committed) pendingMatchRef.child(k).remove(); });
      }
    });
  });
}

// ── Pending 매칭 모달 ──
function openPendingModal(pendingId, pending) {
  activePendingId = pendingId;
  document.getElementById('pendingModalCat').textContent = `[${pending.category}] 파티 매칭이 성사되었습니다!`;

  const listEl = document.getElementById('pendingModalList');
  listEl.innerHTML = (pending.members || []).map(m => {
    const isSl = m.job === '전사' || m.job === '도적';
    const spec = isSl ? `체력 ${m.hp}만` : `마력 ${m.mp}만`;
    const c = JOB_COLORS[m.job] || 'var(--gold)';
    const badge = `<span class="jb" style="background:${c}22;color:${c};margin:0 0 0 5px;font-size:11px;padding:1px 6px;">${m.job}</span>`;
    const expTag = m.expBuff === 'O'
      ? `<span style="color:var(--jade);font-size:11.5px;font-weight:900;margin-left:5px;">⚡경쿠</span>`
      : '';
    return `<div class="modal-member-row">
      <div class="modal-m-info" style="flex-wrap:wrap;gap:2px;"><span style="font-weight:700;">${m.nick}</span>${badge}${expTag}</div>
      <div class="modal-m-spec">${spec}</div>
    </div>`;
  }).join('');

  if(pending.commonGrounds && pending.commonGrounds.length) {
    document.getElementById('pendingModalDest').innerHTML = `📍 공통 사냥터: <b style="color:var(--jade);">${pending.commonGrounds.join(', ')}</b>`;
  } else {
    document.getElementById('pendingModalDest').innerHTML = '';
  }

  if(pendingTimerInterval) clearInterval(pendingTimerInterval);
  let secs = 60;
  const timerEl = document.getElementById('pendingTimer');
  const tick = () => {
    timerEl.textContent = `${secs}초`;
    if(secs <= 0) { clearInterval(pendingTimerInterval); declinePending(pendingId); }
    secs--;
  };
  tick();
  pendingTimerInterval = setInterval(tick, 1000);

  document.getElementById('pendingModal').classList.add('open');
  playMatchSound();
}

function closePendingModal() {
  if(pendingTimerInterval) { clearInterval(pendingTimerInterval); pendingTimerInterval = null; }
  activePendingId = null;
  document.getElementById('pendingModal').classList.remove('open');
}

function acceptPending() {
  if(!FB_OK || !activePendingId) return;
  const myNick = document.getElementById('userNick').value.trim();
  if(!myNick) return;
  const safeNick = myNick.replace(/[.#$[\]/]/g, '_');
  const pid = activePendingId;
  pendingMatchRef.child(pid).child('acceptances').child(safeNick).set('accepted')
    .then(() => toast('수락 완료. 다른 멤버의 응답을 기다리는 중...', 'info'));
}

function declinePending(overridePid) {
  if(!FB_OK) return;
  const pid = overridePid || activePendingId;
  if(!pid) return;
  pendingMatchRef.child(pid).transaction(cur => {
    if(!cur || cur.status !== 'pending') return;
    return { ...cur, status: 'declined' };
  }).then(res => {
    if(res.committed) {
      pendingMatchRef.child(pid).remove();
      if(activePendingId === pid) {
        closePendingModal();
        toast('파티를 이미 구했거나 매칭을 거절하였습니다.', 'info');
      }
    }
  });
}

function handlePendingChange(pendingId, pending) {
  if(!pending) return;
  const myNick = document.getElementById('userNick').value.trim();

  if(pending.status === 'declined' || pending.status === 'timeout') {
    if(activePendingId === pendingId) {
      closePendingModal();
      toast('파티원이 거절하거나 시간이 초과되어 매칭이 취소되었습니다.', 'warn');
    }
    return;
  }
  if(pending.status === 'completed') {
    if(activePendingId === pendingId) closePendingModal();
    return;
  }
  if(pending.status !== 'pending') return;

  const members = pending.members || [];
  if(!myNick || !members.some(m => m.nick === myNick)) return;

  const acceptances = pending.acceptances || {};
  const hasDeclined = Object.values(acceptances).some(v => v === 'declined');
  const allAccepted = members.length > 0 && members.every(m => {
    const sn = m.nick.replace(/[.#$[\]/]/g, '_');
    return acceptances[sn] === 'accepted';
  });

  if(hasDeclined) {
    if(activePendingId === pendingId) { closePendingModal(); toast('파티원이 거절하여 매칭이 취소되었습니다.', 'warn'); }
    pendingMatchRef.child(pendingId).transaction(cur => {
      if(!cur || cur.status !== 'pending') return;
      return { ...cur, status: 'declined' };
    }).then(res => { if(res.committed) pendingMatchRef.child(pendingId).remove(); });
    return;
  }

  if(allAccepted) {
    pendingMatchRef.child(pendingId).transaction(cur => {
      if(!cur || cur.status !== 'pending') return;
      return { ...cur, status: 'completed' };
    }).then(res => {
      if(!res.committed) return;
      if(activePendingId === pendingId) closePendingModal();
      const n = new Date();
      const rec = {
        category: pending.category,
        members: pending.members,
        matchTime: `${n.getHours()}:${String(n.getMinutes()).padStart(2,'0')}`,
        commonGrounds: pending.commonGrounds || [],
        ts: Date.now()
      };
      matchRef.push(rec).then(() => {
        pendingMatchRef.child(pendingId).remove();
        matchRef.orderByChild('ts').once('value', s => {
          const all = []; s.forEach(c => all.push({k:c.key, ts:c.val().ts||0}));
          all.sort((a,b) => a.ts - b.ts);
          for(let i = 0; i < all.length - MATCH_KEEP; i++) matchRef.child(all[i].k).remove();
        });
      });
      playMatchSound();
      openMatchModal({ displayCategory: pending.category, members: pending.members, commonGrounds: pending.commonGrounds || [] });
      toast(`<b>[${pending.category}]</b> 파티 매칭 완료!`, 'win');
      setTimeout(tryAutoMatch, 150);
    });
  }
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
  pendingMatchRef.on('child_added', snap => {
    const pending = snap.val();
    if(!pending || !pending.pendingTs || pending.pendingTs < pageLoadTime) return;
    const myNick = document.getElementById('userNick').value.trim();
    if(!myNick) return;
    if(pending.members && pending.members.some(m => m.nick === myNick)) {
      openPendingModal(snap.key, pending);
    }
  });
  pendingMatchRef.on('child_changed', snap => {
    handlePendingChange(snap.key, snap.val());
  });
  pendingMatchRef.on('child_removed', snap => {
    if(activePendingId === snap.key) closePendingModal();
  });
  squadRef.on('value',snap=>{
    squads=snap.val()||{};
    updateMatchedDisplay();
    checkSquadComplete();
  });
  // 주기적 만료 처리
  setInterval(() => { cleanExpiredQueue(); cleanExpiredPending(); }, 60000);
  cleanExpiredQueue();
  cleanExpiredPending();
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

function toggleCompanionPanel(type) {
  const el = document.getElementById('companion' + type);
  const checked = document.getElementById('hasParty' + type).checked;
  if(el) el.style.display = checked ? 'block' : 'none';
}

function toggleRaidTypeCompanion() {
  const rt = document.getElementById('raidType').value;
  const wrap = document.getElementById('raidCompanionWrap');
  const ddaepatWrap = document.getElementById('raidDdaepatCompanionWrap');
  if(wrap) wrap.style.display = rt === '격도술' ? 'block' : 'none';
  if(ddaepatWrap) ddaepatWrap.style.display = rt === '떼팟' ? 'block' : 'none';
  if(rt !== '격도술') {
    const cb = document.getElementById('hasPartyRaid');
    if(cb) cb.checked = false;
    const panel = document.getElementById('companionRaid');
    if(panel) panel.style.display = 'none';
  }
  if(rt !== '떼팟') {
    const cb = document.getElementById('hasPartyDdaepat');
    if(cb) cb.checked = false;
    const panel = document.getElementById('companionDdaepat');
    if(panel) panel.style.display = 'none';
  }
}

function toggleDdaepatCompanion() {
  const checked = document.getElementById('hasPartyDdaepat').checked;
  const panel = document.getElementById('companionDdaepat');
  if(!panel) return;
  panel.style.display = checked ? 'block' : 'none';
  if(checked && document.getElementById('ddaepatCompanionList').children.length === 0) {
    addDdaepatCompanion();
  }
}

function addDdaepatCompanion() {
  const list = document.getElementById('ddaepatCompanionList');
  const row = document.createElement('div');
  row.className = 'companion-row';
  row.style.cssText = 'display:grid;grid-template-columns:1fr 1.5fr 1fr auto;gap:8px;margin-bottom:8px;align-items:end;';
  row.innerHTML = `
    <div class="field" style="margin-bottom:0;"><label class="lbl">직업</label>
      <select><option value="도사">도사</option><option value="주술사">주술사</option><option value="전사">전사</option><option value="도적">도적</option></select>
    </div>
    <div class="field" style="margin-bottom:0;"><label class="lbl">닉네임</label>
      <input type="text" placeholder="닉네임 입력">
    </div>
    <div class="field" style="margin-bottom:0;"><label class="lbl">체/마(만)</label>
      <input type="number" placeholder="0">
    </div>
    <button type="button" class="x-btn" style="margin-bottom:0;align-self:flex-end;" onclick="this.closest('.companion-row').remove()">×</button>`;
  list.appendChild(row);
}

function makeCompanionEntry(leader) {
  const m = leader.partyMember;
  const isSlayer = m.job === '전사' || m.job === '도적';
  return {
    nick: m.nick, job: m.job,
    hp: isSlayer ? (m.stat || '0') : '0',
    mp: !isSlayer ? (m.stat || '0') : '0',
    expBuff: leader.expBuff,
    playTime: leader.playTime,
    _fromParty: true
  };
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
  let hasParty=false, partyMember=null;
  let alternativeCategories = [];

  if(category==='격도술'){
    document.querySelectorAll('#panelGyukdo input[type=checkbox]:not([name=altCatGyukdo]):checked').forEach(cb=>huntingGrounds.push(cb.value));
    if(!huntingGrounds.length){toast('사냥터를 하나 이상 선택해주세요.','warn');return;}
    expBuff=document.querySelector('input[name=expBuffA]:checked').value;
    mildae=document.querySelector('input[name=mildaeA]:checked').value;
    details.push(`경쿠:${expBuff}`,`밀대:${mildae}`);
    document.querySelectorAll('input[name=altCatGyukdo]:checked').forEach(cb=>alternativeCategories.push(cb.value));
    if(document.getElementById('hasPartyGyukdo').checked){
      const partyNick=document.getElementById('partyNickGyukdo').value.trim();
      if(!partyNick){toast('일행 닉네임을 입력해주세요.','warn');return;}
      hasParty=true;
      partyMember={nick:partyNick,job:document.getElementById('partyJobGyukdo').value,stat:document.getElementById('partyStatGyukdo').value||'0'};
    }
  }else if(category==='격도1대1'){
    document.querySelectorAll('#panelGyukdo1on1 input[type=checkbox]:not([name=altCat1on1]):checked').forEach(cb=>huntingGrounds.push(cb.value));
    if(!huntingGrounds.length){toast('사냥터를 하나 이상 선택해주세요.','warn');return;}
    expBuff=document.querySelector('input[name=expBuff1on1]:checked').value;
    mildae=document.querySelector('input[name=mildae1on1]:checked').value;
    details.push(`경쿠:${expBuff}`,`밀대:${mildae}`);
    document.querySelectorAll('input[name=altCat1on1]:checked').forEach(cb=>alternativeCategories.push(cb.value));
  }else if(category==='떱헬'){
    document.querySelectorAll('#panelDdubHell input[type=checkbox]:checked').forEach(cb=>huntingGrounds.push(cb.value));
    if(!huntingGrounds.length){toast('사냥터를 하나 이상 선택해주세요.','warn');return;}
  }else if(category==='반반밀대'||category==='밀격쩔'){
    document.querySelectorAll('#panelMilgyeok input[type=checkbox]:checked').forEach(cb=>huntingGrounds.push(cb.value));
    if(!huntingGrounds.length){toast('사냥터를 하나 이상 선택해주세요.','warn');return;}
    details.push(`역할:${document.getElementById('subRole').value}`);
    if(document.getElementById('hasPartyMilgyeok').checked){
      const partyNick=document.getElementById('partyNickMilgyeok').value.trim();
      if(!partyNick){toast('일행 닉네임을 입력해주세요.','warn');return;}
      hasParty=true;
      partyMember={nick:partyNick,job:document.getElementById('partyJobMilgyeok').value,stat:document.getElementById('partyStatMilgyeok').value||'0'};
    }
  }else if(category==='흉가노노'){
    hyunggaRole=document.querySelector('input[name=hyunggaRole]:checked').value;
    details.push(`역할:${hyunggaRole}`);
  }else if(category==='차균'){
    document.querySelectorAll('#panelChagyoon input[type=checkbox]:not([name=altCatChagyoon]):checked').forEach(cb=>huntingGrounds.push(cb.value));
    if(!huntingGrounds.length){toast('단수를 선택해주세요.','warn');return;}
    document.querySelectorAll('input[name=altCatChagyoon]:checked').forEach(cb=>alternativeCategories.push(cb.value));
  }else if(category==='레이드'){
    raidBoss=document.querySelector('input[name=raidBoss]:checked').value;
    raidType=document.getElementById('raidType').value;
    details.push(`보스:${raidBoss}`,`방식:${raidType}`);
    if(raidType==='격도술' && document.getElementById('hasPartyRaid').checked){
      const partyNick=document.getElementById('partyNickRaid').value.trim();
      if(!partyNick){toast('일행 닉네임을 입력해주세요.','warn');return;}
      hasParty=true;
      partyMember={nick:partyNick,job:document.getElementById('partyJobRaid').value,stat:document.getElementById('partyStatRaid').value||'0'};
    }
  }
  if(category==='레이드' && raidType==='떼팟'){
    const ts=Date.now();
    const pushList=[{nick,job,hp,mp,playTime,ts}];
    if(document.getElementById('hasPartyDdaepat').checked){
      document.querySelectorAll('#ddaepatCompanionList .companion-row').forEach(row=>{
        const pJob=row.querySelector('select').value;
        const pNick=row.querySelector('input[type=text]').value.trim();
        const pStat=row.querySelector('input[type=number]').value||'0';
        if(pNick){
          const isSl=pJob==='전사'||pJob==='도적';
          pushList.push({nick:pNick,job:pJob,hp:isSl?pStat:'0',mp:!isSl?pStat:'0',playTime,ts,_fromParty:true});
        }
      });
    }
    const pushAll=pushList.map(m=>squadRef.child(raidBoss).child('members').push(m));
    Promise.all(pushAll)
      .then(()=>toast(`<b>${nick}</b> 님${pushList.length>1?` 외 ${pushList.length-1}명`:''} ${raidBoss} 떼팟에 합류했습니다.`,'info'))
      .catch(()=>toast('합류 실패','warn'));
    return;
  }
  const entry={
    nick,job,hp,mp,category,huntingGrounds,expBuff,mildae,raidBoss,raidType,hyunggaRole,playTime,hasParty,
    ...(partyMember && {partyMember}),
    filterHp: reqFilterHp, filterJuMp: reqFilterJuMp, filterDoMp: reqFilterDoMp,
    blacklist: myBlacklist,
    _ip: userIp,
    alternativeCategories,
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
  if(!u)return;
  if(userIp && u._ip !== userIp){
    toast('본인의 대기열만 취소할 수 있습니다.','warn');
    return;
  }
  queueRef.child(id).remove()
    .then(()=>toast(`<b>${u.nick}</b> 님의 대기를 취소했습니다.`,'info'))
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
    const matchedNicks=new Set(p.members.map(m=>m.nick));
    queueRef.once('value',snap=>{
      const q=snap.val();
      if(!q)return;
      Object.keys(q).forEach(key=>{if(matchedNicks.has(q[key].nick))queueRef.child(key).remove();});
    });
    const n=new Date();
    const members=p.members.map(({_id,ts,_fromParty,...rest})=>rest);
    const pendingRec={
      category:p.displayCategory,
      members,
      matchTime:`${n.getHours()}:${String(n.getMinutes()).padStart(2,'0')}`,
      commonGrounds:p.commonGrounds||[],
      status:'pending',
      acceptances:{},
      pendingTs:Date.now()
    };
    members.forEach(m=>{
      const sn=m.nick.replace(/[.#$[\]/]/g,'_');
      pendingRec.acceptances[sn]='waiting';
    });
    pendingMatchRef.push(pendingRec).then(()=>{
      setTimeout(tryAutoMatch,150);
    });
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
  // 사용자가 허용하는 카테고리 목록 반환
  function cats(u) { return [u.category, ...(u.alternativeCategories||[])]; }
  function isNative(u, cat) { return u.category === cat; }
  function isCrossChagyoon(u) { return u.category === '차균'; }

  // 격도술 일행있음: 리더(2인)+솔로 = 3인 매칭
  {
    const leaders=list.filter(u=>u.category==='격도술'&&u.hasParty);
    const soloPool=list.filter(u=>cats(u).includes('격도술')&&!(u.category==='격도술'&&u.hasParty));
    for(const leader of leaders){
      for(const third of soloPool){
        if(leader._id===third._id) continue;
        if(checkSpecsAndBlacklist(leader,third)){
          const cg=(leader.huntingGrounds||[]).filter(g=>(third.huntingGrounds||[]).includes(g));
          const crossCha = isCrossChagyoon(third);
          if(cg.length || crossCha){
            return{displayCategory:'격도술',members:[leader,makeCompanionEntry(leader),third],commonGrounds:cg};
          }
        }
      }
    }
  }
  // 레이드 격도술 일행있음
  {
    const pool=list.filter(u=>u.category==='레이드'&&u.raidType==='격도술'&&u.hasParty);
    const solos=list.filter(u=>u.category==='레이드'&&u.raidType==='격도술'&&!u.hasParty);
    for(const leader of pool){
      for(const third of solos){
        if(third.raidBoss!==leader.raidBoss) continue;
        if(checkSpecsAndBlacklist(leader,third)){
          return{displayCategory:`레이드-${leader.raidBoss}(격도술)`,members:[leader,makeCompanionEntry(leader),third],commonGrounds:[]};
        }
      }
    }
  }
  // 차균: 주술사 즉시 솔로 매칭
  {
    const pool=list.filter(u=>cats(u).includes('차균'));
    const sulsa=pool.find(u=>u.job==='주술사');
    if(sulsa) return{displayCategory:'차균',members:[sulsa],commonGrounds:[]};
  }
  // 차균: 격수(전사/도적)+도사 2인 매칭 (교차 카테고리 포함)
  {
    const pool=list.filter(u=>cats(u).includes('차균'));
    const gyeoks=pool.filter(u=>u.job==='전사'||u.job==='도적');
    const dosas=pool.filter(u=>u.job==='도사');
    for(const gyeok of gyeoks){
      for(const dosa of dosas){
        if(gyeok._id===dosa._id) continue;
        if(checkSpecsAndBlacklist(gyeok,dosa)){
          const bothNative = isNative(gyeok,'차균') && isNative(dosa,'차균');
          if(bothNative){
            const cg=(gyeok.huntingGrounds||[]).filter(g=>(dosa.huntingGrounds||[]).includes(g));
            if(cg.length) return{displayCategory:'차균',members:[gyeok,dosa],commonGrounds:cg};
          } else {
            // 교차 카테고리 차균 매칭 → 단수 체크 없음
            return{displayCategory:'차균',members:[gyeok,dosa],commonGrounds:[]};
          }
        }
      }
    }
  }
  // 격도1대1 (교차 카테고리 포함)
  {
    const pool=list.filter(u=>cats(u).includes('격도1대1'));
    for(const u1 of pool){
      if(u1.job==='도사') continue;
      const u2=pool.find(x=>{
        if(x.job!=='도사'||x._id===u1._id) return false;
        if(!checkSpecsAndBlacklist(u1,x)) return false;
        const hasCrossCha = isCrossChagyoon(u1) || isCrossChagyoon(x);
        if(hasCrossCha) return true;
        const cg=(u1.huntingGrounds||[]).filter(g=>(x.huntingGrounds||[]).includes(g));
        return cg.length > 0;
      });
      if(u2){
        const cg=(u1.huntingGrounds||[]).filter(g=>(u2.huntingGrounds||[]).includes(g));
        return{displayCategory:'격도(1대1)',members:[u1,u2],commonGrounds:cg};
      }
    }
  }
  // 레이드 격도1대1
  {
    const pool=list.filter(u=>u.category==='레이드'&&u.raidType==='격도1대1');
    for(const u1 of pool){
      if(u1.job==='도사') continue;
      const u2=pool.find(x=>x.job==='도사'&&x.raidBoss===u1.raidBoss&&x._id!==u1._id&&checkSpecsAndBlacklist(u1,x));
      if(u2) return{displayCategory:`레이드-${u1.raidBoss}(1대1)`,members:[u1,u2],commonGrounds:[]};
    }
  }
  // 떱헬
  {
    const pool=list.filter(u=>u.category==='떱헬'&&u.job==='주술사');
    if(pool.length>=2){
      for(let i=0;i<pool.length;i++)
        for(let j=i+1;j<pool.length;j++){
          const u1=pool[i],u2=pool[j];
          if(checkSpecsAndBlacklist(u1,u2)){
            const cg=(u1.huntingGrounds||[]).filter(g=>(u2.huntingGrounds||[]).includes(g));
            if(cg.length) return{displayCategory:'떱헬(술사+술사)',members:[u1,u2],commonGrounds:cg};
          }
        }
    }
  }
  // 흉가노노
  {
    const pool=list.filter(u=>u.category==='흉가노노');
    const a=pool.find(u=>u.hyunggaRole==='격수'),d=pool.find(u=>u.hyunggaRole==='도사'&&u!==a);
    if(a&&d&&checkSpecsAndBlacklist(a,d)) return{displayCategory:'흉가노노',members:[a,d],commonGrounds:[]};
  }
  // 레이드 격도술 3인 솔로
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
  // 반반밀대/밀격쩔 일행있음
  {
    const cats2=['반반밀대','밀격쩔'];
    for(const cat of cats2){
      const leaders=list.filter(u=>u.category===cat&&u.hasParty);
      const solos=list.filter(u=>u.category===cat&&!u.hasParty);
      for(const leader of leaders)
        for(const third of solos)
          if(checkSpecsAndBlacklist(leader,third)){
            const cg=(leader.huntingGrounds||[]).filter(g=>(third.huntingGrounds||[]).includes(g));
            if(cg.length) return{displayCategory:cat,members:[leader,makeCompanionEntry(leader),third],commonGrounds:cg};
          }
    }
  }
  // 격도술 3인 솔로 (교차 카테고리 포함)
  {
    const pool=list.filter(u=>cats(u).includes('격도술')&&!(u.category==='격도술'&&u.hasParty));
    if(pool.length>=3){
      for(let i=0;i<pool.length;i++)
        for(let j=i+1;j<pool.length;j++)
          for(let k=j+1;k<pool.length;k++){
            const p1=pool[i],p2=pool[j],p3=pool[k];
            if(!checkSpecsAndBlacklist(p1,p2,p3)) continue;
            const hasCrossCha=[p1,p2,p3].some(isCrossChagyoon);
            if(hasCrossCha){
              return{displayCategory:'격도술',members:[p1,p2,p3],commonGrounds:[]};
            }
            const cg=(p1.huntingGrounds||[]).filter(g=>
              (p2.huntingGrounds||[]).includes(g)&&(p3.huntingGrounds||[]).includes(g));
            if(cg.length) return{displayCategory:'격도술',members:[p1,p2,p3],commonGrounds:cg};
          }
    }
  }
  // 반반밀대/밀격쩔 3인 솔로
  {
    const milCats=['반반밀대','밀격쩔'];
    for(const cat of milCats){
      const pool=list.filter(u=>u.category===cat&&!u.hasParty);
      if(pool.length>=3)
        for(let i=0;i<pool.length;i++)
          for(let j=i+1;j<pool.length;j++)
            for(let k=j+1;k<pool.length;k++){
              const p1=pool[i],p2=pool[j],p3=pool[k];
              if(!checkSpecsAndBlacklist(p1,p2,p3)) continue;
              const cg=(p1.huntingGrounds||[]).filter(g=>
                (p2.huntingGrounds||[]).includes(g)&&(p3.huntingGrounds||[]).includes(g));
              if(cg.length) return{displayCategory:cat,members:[p1,p2,p3],commonGrounds:cg};
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
  const now = Date.now();
  waitingQueue.forEach((u)=>{
    let sub=u.detailsStr;
    if(u.huntingGrounds&&u.huntingGrounds.length)
      sub=`사냥터: ${u.huntingGrounds.join(', ')}`+(u.detailsStr?` · ${u.detailsStr}`:'');
    const c=JOB_COLORS[u.job]||'var(--gold)';
    const d=document.createElement('div');
    d.className='qitem';d.style.setProperty('--accent',c);
    const companionHtml = u.hasParty && u.partyMember ? (()=>{
      const m=u.partyMember;
      const isSl=m.job==='전사'||m.job==='도적';
      const statLabel=isSl?'체력':'마력';
      return `<div style="margin-top:4px;font-size:12.5px;color:var(--paper-dim);">👥 일행: ${jobBadge(m.job)} <b>${m.nick}</b>${m.stat&&m.stat!=='0'?` · ${statLabel} ${m.stat}만`:''}</div>`;
    })() : '';
    const altCatsHtml = u.alternativeCategories && u.alternativeCategories.length
      ? `<div style="margin-top:3px;font-size:12px;color:var(--gold-soft);">✓ ${u.alternativeCategories.join(' / ')} 가능</div>`
      : '';
    const isMyEntry = userIp ? u._ip === userIp : false;
    let expiryHtml = '';
    if(isMyEntry && u.ts) {
      const remaining = QUEUE_EXPIRE_MS - (now - u.ts);
      if(remaining > 0) {
        const mins = Math.floor(remaining / 60000);
        const secs = Math.floor((remaining % 60000) / 1000);
        expiryHtml = `<div style="margin-top:3px;font-size:11.5px;color:var(--paper-faint);">⏳ ${mins}분 ${secs}초 후 만료</div>`;
      }
    }
    d.innerHTML=`
      <div style="flex:1;min-width:0;">
        <div><span class="nm">${u.nick}</span>${jobBadge(u.job)}</div>
        <div class="stat">체력 ${u.hp}만 · 마력 ${u.mp}만 <span style="color:var(--gold-soft);">(${u.playTime||'30분'})</span></div>
        ${companionHtml}
        <div class="mode">➔ ${u.category} <span style="color:var(--paper-dim);">[${sub}]</span></div>
        ${altCatsHtml}
        ${expiryHtml}
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;flex-shrink:0;">
        ${isMyEntry?`<button class="refresh-btn" onclick="refreshQueue('${u._id}')" title="30분 연장">↺ 갱신</button>`:''}
        ${isMyEntry?`<button class="x-btn" onclick="cancelQueue('${u._id}')" title="대기 취소">×</button>`:''}
      </div>`;
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
