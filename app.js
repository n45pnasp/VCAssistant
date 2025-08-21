// ==================== FIREBASE SETUP ====================
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-app.js";
import {
  getFirestore, doc, setDoc, getDoc, deleteDoc,
  collection, addDoc, onSnapshot, getDocs,
  serverTimestamp, query, orderBy
} from "https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged,
  setPersistence, browserLocalPersistence, browserSessionPersistence, inMemoryPersistence
} from "https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js";

// ==================== CONFIG ====================
const firebaseConfig = {
  apiKey: "AIzaSyAjqMqmKUDPWHkv19Dig7PnUpHMzNf9J1A",
  authDomain: "onlinecsbwx.firebaseapp.com",
  projectId: "onlinecsbwx",
  storageBucket: "onlinecsbwx.appspot.com",
  messagingSenderId: "317019843909",
  appId: "1:317019843909:web:2d5b2b2c9dd118e0ce622c"
};

// TURN Proxy (Cloudflare Worker) – GANTI SESUAI punyamu
const TURN_PROXY = "https://wrangler.avsecbwx2018.workers.dev";
const TURN_SHARED_TOKEN = "N45p"; // "" jika tidak pakai

// PAGES
const PAGES = { thanks: "thanks.html", busy: "maaf.html" };

// Call limit
const MAX_CALL_SECONDS = 15 * 60; // 15 menit

// ==================== GLOBALS ====================
const app  = getApps().length ? getApp() : initializeApp(firebaseConfig);
const db   = getFirestore(app);
const auth = getAuth(app);

let localStream = null;
let remoteStream = null;
let peerConnection = null;
let roomRef = null;
let isCaller = false;
let wasCalleeConnected = false;
let callTimerInterval = null;
const ROOM_ID = (window.ROOM_ID || "cs-room");

// ==================== AUTH ====================
async function preparePersistence() {
  try { await setPersistence(auth, browserLocalPersistence); }
  catch { try { await setPersistence(auth, browserSessionPersistence); }
         catch { await setPersistence(auth, inMemoryPersistence); } }
}
async function ensureAnonLogin() { await preparePersistence(); await signInAnonymously(auth); }
function waitForUser(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(()=>{unsub(); reject(new Error("Auth timeout"));}, timeoutMs);
    const unsub = onAuthStateChanged(auth, (u)=>{ if(u){ clearTimeout(t); unsub(); resolve(u);} });
  });
}

// ==================== INIT ====================
window.onload = async () => {
  try {
    await ensureAnonLogin();
    await waitForUser();

    if (location.pathname.endsWith(PAGES.busy)) {
      initBusyPage().catch(console.error);
      return;
    }

    initAfterAuth();
    startStatusLoop();
    setTimeout(()=>{ openPanel(); }, 600);
  } catch(e) {
    console.error("Auth error:", e);
    alert("Tidak bisa login ke server. Coba refresh.");
  }
};

// ==================== AFTER AUTH (caller/callee page) ====================
async function initAfterAuth() {
  const isCallerPage = location.pathname.includes("caller.html");
  const startBtn = document.querySelector("#startCallBtn");
  const hangupBtn = document.querySelector("#hangupBtn");
  if (!isCallerPage && startBtn) startBtn.remove();
  if (hangupBtn) hangupBtn.addEventListener("click", hangUp);

  window.addEventListener("beforeunload", async () => {
    try { if (!isCaller) await deleteCalleeCandidates(); } catch {}
  });

  const rSnap = await getDoc(doc(db, "rooms", ROOM_ID));

  if (!rSnap.exists()) {
    // === BEHAVIOR BARU ===
    if (isCallerPage) {
      // Admin: tetap di halaman, tampilkan tombol Start
      if (startBtn) {
        startBtn.style.display = "inline-block";
        startBtn.disabled = false;
        startBtn.onclick = () => startCall();
      }
      return;
    } else {
      // Callee: arahkan ke halaman antrian
      alert("Customer Service belum online. Anda akan diarahkan ke halaman antrian.");
      location.href = PAGES.busy;
      return;
    }
  } else {
    const data = rSnap.data();

    if (isCallerPage && startBtn) {
      startBtn.style.display = "inline-block";
      // Jika sudah ada offer/answer, tombol start dinonaktifkan
      startBtn.disabled = !!data.offer;
      if (!data.offer) startBtn.onclick = () => startCall();
    }

    attachTimerFromRoom(data);

    if (data?.offer && !data?.answer) {
      // ada offer → callee boleh join
      if (!isCallerPage) {
        const name = (sessionStorage.getItem("calleeName")) || await showNameInputModal();
        if (!name?.trim()) { alert("Nama wajib diisi."); return; }
        sessionStorage.setItem("calleeName", name);
        startCall(name).catch(err => {
          console.error("Gagal auto-join:", err);
          alert("Gagal auto-join. Silakan coba lagi.");
        });
      }
    } else if (data?.answer) {
      // panggilan aktif → callee lain diarahkan ke antrian
      if (!isCallerPage) {
        alert("Maaf, CS sedang melayani pelanggan lain.");
        location.href = PAGES.busy;
        return;
      }
    }
  }

  updateButtonStates();
}

// ==================== HELPER: QUEUE & CANDIDATES ====================
async function getQueueDocs() {
  const qRef = collection(db, "rooms", ROOM_ID, "queue");
  const qs = await getDocs(query(qRef, orderBy("createdAt","asc")));
  return qs.docs;
}
async function getQueueCount() {
  const docs = await getQueueDocs();
  return docs.length;
}
async function clearQueue() {
  const docs = await getQueueDocs();
  await Promise.all(docs.map(d => deleteDoc(d.ref)));
}
async function clearCandidatesBoth() {
  const callerRef = collection(db, "rooms", ROOM_ID, "callerCandidates");
  const calleeRef = collection(db, "rooms", ROOM_ID, "calleeCandidates");
  const [c1, c2] = await Promise.all([ getDocs(callerRef), getDocs(calleeRef) ]);
  await Promise.all([...c1.docs, ...c2.docs].map(d => deleteDoc(d.ref)));
}
function hasActiveCallee(roomData) {
  return !!(roomData?.answer && roomData?.status === "active");
}

// ==================== START CALL (caller/callee) ====================
async function startCall(calleeNameFromInit = null) {
  try {
    showLoading(true);

    try {
      const camPerm = await navigator.permissions?.query?.({ name: "camera" });
      if (camPerm?.state === "denied") { alert("Izin kamera ditolak."); return; }
    } catch {}

    // siapkan stream
    if (!localStream) localStream  = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    remoteStream = new MediaStream();
    document.querySelector("#localVideo").srcObject = localStream;
    document.querySelector("#remoteVideo").srcObject = remoteStream;

    // ICE via TURN proxy
    let servers = { iceServers: [], iceCandidatePoolSize: 10 };
    try {
      const qs = TURN_SHARED_TOKEN ? `?channel=WebRTC&token=${encodeURIComponent(TURN_SHARED_TOKEN)}` : `?channel=WebRTC`;
      const resp = await fetch(`${TURN_PROXY}${qs}`, { method: "GET" });
      if (!resp.ok) throw new Error(`TURN proxy ${resp.status}`);
      const data = await resp.json();
      const valid = data?.iceServers?.filter(s => s?.urls);
      if (!valid?.length) throw new Error("ICE kosong");
      servers.iceServers = valid;
    } catch (e) {
      console.warn("TURN proxy gagal, fallback STUN:", e?.message||e);
      servers.iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
    }

    // PeerConnection
    peerConnection = new RTCPeerConnection(servers);
    localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));
    peerConnection.ontrack = e => e.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));

    roomRef = doc(db, "rooms", ROOM_ID);
    const rSnap = await getDoc(roomRef);
    monitorConnectionStatus();

    if (!rSnap.exists()) {
      // ===== CALLER flow (buat room + offer) =====
      isCaller = true;
      await createOfferAsCaller();

    } else {
      // ===== CALLEE flow =====
      const data = rSnap.data();
      if (data?.calleeName) {
        const label = document.getElementById("calleeNameLabel");
        if (label) { label.textContent = `CUSTOMER: ${data.calleeName.toUpperCase()}`; label.style.display = "block"; }
      }

      if (data?.offer && !data?.answer) {
        isCaller = false;
        const namaCallee = calleeNameFromInit ?? await showNameInputModal();
        if (!namaCallee) throw new Error("Nama tidak diisi.");

        peerConnection.onicecandidate = e => { if (e.candidate) addDoc(collection(db, "rooms", ROOM_ID, "calleeCandidates"), e.candidate.toJSON()); };

        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        await setDoc(roomRef, {
          answer: { type: answer.type, sdp: answer.sdp },
          calleeName: namaCallee,
          startedAt: serverTimestamp(),
          maxSeconds: MAX_CALL_SECONDS,
          status: "active"
        }, { merge: true });

        const callerCandidatesRef = collection(db, "rooms", ROOM_ID, "callerCandidates");
        onSnapshot(callerCandidatesRef, snap => {
          snap.docChanges().forEach(async ch => { if (ch.type === "added") await peerConnection.addIceCandidate(new RTCIceCandidate(ch.doc.data())); });
        });

        onSnapshot(roomRef, s => { if (!s.exists()) cleanupAndRedirectCallee(); });

      } else if (!data?.offer) {
        // belum ada offer → callee diarahkan ke antrian
        alert("Customer Service belum siap. Anda akan diarahkan ke halaman antrian.");
        location.href = PAGES.busy;
      } else {
        // sudah ada answer (aktif) → callee lain diarahkan
        alert("Maaf, CS sedang melayani pelanggan lain.");
        location.href = PAGES.busy;
      }
    }

  } catch (e) {
    console.error("startCall error:", e);
    alert("Gagal connect: " + e.message);
  } finally {
    showLoading(false);
    const startBtn = document.querySelector("#startCallBtn"); if (startBtn) startBtn.disabled = true;
    updateButtonStates();
  }
}

// ===== Helper: buat offer sebagai Caller (dipakai start & auto-next)
async function createOfferAsCaller() {
  // setup ICE outbound
  peerConnection.onicecandidate = e => {
    if (e.candidate) addDoc(collection(db, "rooms", ROOM_ID, "callerCandidates"), e.candidate.toJSON());
  };

  // tulis offer
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  await setDoc(roomRef, { offer: { type: offer.type, sdp: offer.sdp }, status: "idle" }, { merge: true });

  // dengarkan answer/nama + attach timer bila sudah aktif
  onSnapshot(roomRef, snapshot => {
    const data = snapshot.data();
    if (!peerConnection.currentRemoteDescription && data?.answer) {
      peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
    }
    if (data?.calleeName) {
      const label = document.getElementById("calleeNameLabel");
      if (label && label.textContent !== data.calleeName) {
        label.textContent = `CUSTOMER: ${data.calleeName.toUpperCase()}`; label.style.display = "block";
      }
    }
    attachTimerFromRoom(data);
  });

  // dengarkan kandidat callee
  const calleeCandidatesRef = collection(db, "rooms", ROOM_ID, "calleeCandidates");
  onSnapshot(calleeCandidatesRef, snap => {
    snap.docChanges().forEach(async ch => {
      if (ch.type === "added") await peerConnection.addIceCandidate(new RTCIceCandidate(ch.doc.data()));
    });
  });
}

// ==================== TIMER 15 MENIT ====================
function attachTimerFromRoom(roomData) {
  if (!roomData?.startedAt || !roomData?.maxSeconds) { stopCallTimer(); removeCallTimerEl(); return; }
  const startedMs = roomData.startedAt.toMillis ? roomData.startedAt.toMillis() : Date.parse(roomData.startedAt);
  const maxSec = Number(roomData.maxSeconds || MAX_CALL_SECONDS);
  startCallTimer(startedMs, maxSec);
}
function startCallTimer(startedMs, maxSec) {
  stopCallTimer();
  ensureCallTimerEl();
  callTimerInterval = setInterval(async () => {
    const elapsed = Math.floor((Date.now() - startedMs) / 1000);
    const remain = Math.max(0, maxSec - elapsed);
    renderCallTimer(remain);
    if (remain <= 0) {
      stopCallTimer();
      // === TIMER HABIS ===
      if (isCaller) {
        await autoNextOrTearDown(); // auto-next bila ada antrian
      } else {
        try { hangUp(); } catch {}
      }
    }
  }, 1000);
}
function stopCallTimer() { if (callTimerInterval) { clearInterval(callTimerInterval); callTimerInterval = null; } }
function ensureCallTimerEl() {
  if (document.getElementById("callTimer")) return;
  const el = document.createElement("div");
  el.id = "callTimer";
  Object.assign(el.style, {
    position: "fixed", top: "16px", left: "50%", transform: "translateX(-50%)",
    background: "rgba(0,0,0,.6)", color: "#fff", padding: "6px 12px",
    borderRadius: "14px", fontWeight: "600", zIndex: 9999, fontFamily: "system-ui,Roboto,Arial"
  });
  document.body.appendChild(el);
}
function removeCallTimerEl(){ const el=document.getElementById("callTimer"); if(el) el.remove(); }
function renderCallTimer(remain) {
  const mm = String(Math.floor(remain/60)).padStart(2,"0");
  const ss = String(remain%60).padStart(2,"0");
  const el = document.getElementById("callTimer"); if (el) el.textContent = `Sisa waktu: ${mm}:${ss}`;
}

// ==================== AUTO-NEXT OR TEARDOWN (CALLER) ====================
async function autoNextOrTearDown() {
  try {
    const roomSnap = await getDoc(doc(db, "rooms", ROOM_ID));
    const data = roomSnap.exists() ? roomSnap.data() : {};
    const queueN = await getQueueCount();

    // Tutup PC & remote stream, tapi JANGAN hentikan localStream (caller tetap siaga)
    try {
      remoteStream?.getTracks().forEach(t => t.stop());
      peerConnection?.close();
    } catch {}
    peerConnection = null;

    if (queueN > 0) {
      // Auto-next → bersihkan ICE lama, reset field room, buat offer baru
      await clearCandidatesBoth();
      await setDoc(doc(db, "rooms", ROOM_ID), {
        offer: null,
        answer: null,
        calleeName: null,
        startedAt: null,
        status: "idle"
      }, { merge: true });

      // Siapkan PC baru & offer baru
      await startCall(); // ini akan masuk branch caller dan memanggil createOfferAsCaller()
    } else {
      // Tidak ada antrian
      const hadCallee = hasActiveCallee(data);
      // Jika caller benar-benar ingin tutup, hapus room & (jika belum pernah ada callee) kosongkan antrian
      await deleteRoomIfCaller({ purgeQueueIfNoActive: !hadCallee });
      // tetap stay; admin bisa klik Start lagi kapan saja
      const startBtn = document.querySelector("#startCallBtn");
      if (startBtn) { startBtn.style.display = "inline-block"; startBtn.disabled = false; startBtn.onclick = () => startCall(); }
      stopCallTimer(); removeCallTimerEl();
    }
  } catch (e) {
    console.warn("autoNextOrTearDown error:", e);
  }
}

// ==================== HANG UP / CLEANUP ====================
async function hangUp() {
  try {
    localStream?.getTracks().forEach(t => t.stop());
    remoteStream?.getTracks().forEach(t => t.stop());
    document.querySelector("#localVideo").srcObject = null;
    document.querySelector("#remoteVideo").srcObject = null;

    stopCallTimer(); removeCallTimerEl();

    peerConnection?.close(); peerConnection = null;

    if (isCaller) {
      // Evaluasi kebijakan purge queue sesuai kondisimu
      const roomSnap = await getDoc(doc(db, "rooms", ROOM_ID));
      const data = roomSnap.exists() ? roomSnap.data() : {};
      const hadCallee = hasActiveCallee(data);
      await deleteRoomIfCaller({ purgeQueueIfNoActive: !hadCallee });
      location.reload();
    } else {
      const rSnap = await getDoc(doc(db, "rooms", ROOM_ID));
      await deleteCalleeCandidates();
      if (rSnap.exists()) { location.href = PAGES.thanks; return; }
      location.reload();
    }
  } catch (e) {
    console.warn("hangUp error:", e);
    location.href = PAGES.thanks;
  }
}
function cleanupAndRedirectCallee() {
  try {
    localStream?.getTracks().forEach(t => t.stop());
    remoteStream?.getTracks().forEach(t => t.stop());
    peerConnection?.close();
  } catch {}
  document.querySelector("#localVideo").srcObject = null;
  document.querySelector("#remoteVideo").srcObject = null;
  stopCallTimer(); removeCallTimerEl();
  deleteCalleeCandidates().finally(()=>{ location.href = PAGES.thanks; });
}

// ==================== DELETE ROOM (CALLER) ====================
async function deleteRoomIfCaller(options = { purgeQueueIfNoActive: false }) {
  if (!roomRef) roomRef = doc(db, "rooms", ROOM_ID);
  try {
    const callerCandidatesRef = collection(db, "rooms", ROOM_ID, "callerCandidates");
    const calleeCandidatesRef = collection(db, "rooms", ROOM_ID, "calleeCandidates");
    const [callerDocs, calleeDocs] = await Promise.all([ getDocs(callerCandidatesRef), getDocs(calleeCandidatesRef) ]);
    const allDocs = [...callerDocs.docs, ...calleeDocs.docs];
    await Promise.all(allDocs.map(d => deleteDoc(d.ref)));

    // PURGE QUEUE jika diminta (no callee ever joined)
    if (options.purgeQueueIfNoActive) {
      await clearQueue();
    }

    await deleteDoc(roomRef);
    console.log("Room dihapus");
  } catch (e) { console.warn("Gagal hapus room:", e.message); }
}
async function deleteCalleeCandidates() {
  try {
    const ref = collection(db, "rooms", ROOM_ID, "calleeCandidates");
    const docs = await getDocs(ref);
    await Promise.all(docs.docs.map(d => deleteDoc(d.ref)));
  } catch (e) { console.warn("Gagal hapus calleeCandidates:", e.message); }
}

// ==================== UI HELPERS ====================
function showLoading(state) {
  const el = document.querySelector("#loading");
  if (el) el.style.display = state ? "flex" : "none";
  const hang = document.querySelector("#hangupBtn");
  if (hang) hang.disabled = state;
}
function updateButtonStates() {
  const hang = document.querySelector("#hangupBtn");
  if (hang) hang.disabled = !peerConnection;
}
function showCalleeDisconnected() {
  if (document.getElementById("calleeDisconnectedMsg")) return;
  const m = document.createElement("div");
  m.id = "calleeDisconnectedMsg"; m.innerText = "Callee telah menutup sambungan.";
  Object.assign(m.style, { position:"absolute", top:"10px", left:"50%", transform:"translateX(-50%)",
    background:"red", color:"#fff", padding:"10px 20px", borderRadius:"5px", zIndex:9999, fontSize:"16px" });
  document.body.appendChild(m);
}
function formatName(n){ return (n||"").toString().trim(); }

// ==================== SLIDE PANEL EXISTING + QUEUE (caller) ====================
const slidePanel    = document.getElementById('slidePanel');
const slideHandle   = document.getElementById('slideHandle');
const handleIcon    = document.getElementById('handleIcon');
const panelBackdrop = document.getElementById('panelBackdrop');
const closePanelBtn = document.getElementById('closePanelBtn');

const statusText    = document.getElementById('statusText');
const lastChecked   = document.getElementById('lastCheckedText');
const spinnerDots   = document.getElementById('spinnerDots');
const closeRoomBtn  = document.getElementById('closeRoomBtn');
const queueListEl   = document.getElementById('queueList');  // <ul> di slide caller

function openPanel(){ if (!slidePanel) return; slidePanel.classList.add('open'); slidePanel.setAttribute('aria-hidden','false'); panelBackdrop?.classList.add('show'); if (handleIcon) handleIcon.textContent='chevron_right';}
function closePanel(){ if (!slidePanel) return; slidePanel.classList.remove('open'); slidePanel.setAttribute('aria-hidden','true'); panelBackdrop?.classList.remove('show'); if (handleIcon) handleIcon.textContent='chevron_left';}
function togglePanel(){ slidePanel?.classList.contains('open') ? closePanel() : openPanel(); }
slideHandle?.addEventListener('click', togglePanel);
closePanelBtn?.addEventListener('click', closePanel);
panelBackdrop?.addEventListener('click', closePanel);

// swipe open
let touchStartX=null, touching=false; const EDGE=24;
window.addEventListener('touchstart',(e)=>{ if(!slidePanel||slidePanel.classList.contains('open')) return;
  const t=e.touches[0]; if(window.innerWidth - t.clientX <= EDGE){ touchStartX=t.clientX; touching=true;} },{passive:true});
window.addEventListener('touchmove',(e)=>{ if(!touching) return; const t=e.touches[0]; if((touchStartX - t.clientX) > 20){ touching=false; openPanel();}}, {passive:true});
window.addEventListener('touchend',()=>{ touching=false; touchStartX=null; });

// status loop + render queue
async function checkRoomStatus(){
  if (!statusText || !lastChecked) return;
  try{
    const callerRef = collection(db, 'rooms', ROOM_ID, 'callerCandidates');
    const calleeRef = collection(db, 'rooms', ROOM_ID, 'calleeCandidates');
    const [callerSnap, calleeSnap] = await Promise.all([ getDocs(callerRef), getDocs(calleeRef) ]);
    const callerConnected = !callerSnap.empty, calleeConnected = !calleeSnap.empty;
    let msg = "";
    if (callerConnected && calleeConnected) msg = "🟢 Caller & Callee sudah terhubung.";
    else if (callerConnected)               msg = "🟡 Hanya Caller yang terhubung.";
    else if (calleeConnected)               msg = "🟡 Hanya Callee yang terhubung.";
    else                                    msg = "⚪ Belum ada koneksi.";

    statusText.textContent = msg;
    lastChecked.textContent = "Terakhir diperiksa: " + new Date().toLocaleTimeString();

    // Render queue (real-time snapshot cepat)
    if (queueListEl) {
      const qRef = collection(db, "rooms", ROOM_ID, "queue");
      const qSnap = await getDocs(query(qRef, orderBy("createdAt","asc")));
      queueListEl.innerHTML = "";
      let i = 0;
      qSnap.forEach(d => {
        const v = d.data();
        if (["waiting","accepted","notified"].includes(v.status || "waiting")) {
          i++;
          const li = document.createElement("li");
          li.textContent = `${i}. ${v.name || "(anon)"} — ${v.status || "waiting"}`;
          queueListEl.appendChild(li);
        }
      });
      if (i===0) queueListEl.innerHTML = "<li>(Tidak ada antrian)</li>";
    }
  }catch(err){
    statusText.textContent = "❌ Gagal cek status: " + err.message;
    lastChecked.textContent = "Terakhir diperiksa: -";
  }
}
let statusTimer=null;
function startStatusLoop(){ if(!statusText) return; checkRoomStatus(); if(statusTimer) clearInterval(statusTimer); statusTimer=setInterval(checkRoomStatus, 3000); }

// Tombol "Tutup Koneksi" (admin)
async function deleteRoomData(){
  if (spinnerDots) spinnerDots.style.display = 'flex';
  if (statusText)  statusText.textContent = "Menghapus data…";
  if (closeRoomBtn) closeRoomBtn.disabled = true;
  try{
    // cek apakah pernah ada callee aktif
    const r = await getDoc(doc(db,"rooms",ROOM_ID));
    const had = r.exists() ? hasActiveCallee(r.data()) : false;
    await deleteRoomIfCaller({ purgeQueueIfNoActive: !had });
    if(statusText) statusText.textContent="✅ Room & data berhasil dihapus!";
  }
  catch(err){ if(statusText) statusText.textContent = "❌ " + err.message; }
  finally{ if (spinnerDots) spinnerDots.style.display='none'; if (closeRoomBtn) closeRoomBtn.disabled=false; }
}

// ==================== BUSY PAGE (maaf.html) ====================
async function initBusyPage(){
  const user = auth.currentUser;

  const name = sessionStorage.getItem("queueName") || await askNameForQueue();
  sessionStorage.setItem("queueName", name);

  const myRef = doc(db, "rooms", ROOM_ID, "queue", user.uid);
  await setDoc(myRef, {
    uid: user.uid,
    name,
    status: "waiting",
    createdAt: serverTimestamp()
  }, { merge: true });

  const callTimerEl  = byId("currentCallTimer");
  const posEl        = byId("queuePositionText");
  const etaEl        = byId("etaText");
  const modal        = byId("offerModal");
  const modalText    = byId("offerText");
  const acceptBtn    = byId("acceptBtn");
  const declineBtn   = byId("declineBtn");
  const modalCountdown = byId("offerCountdown");

  const roomDocRef = doc(db, "rooms", ROOM_ID);
  onSnapshot(roomDocRef, (snap)=>{
    if (!snap.exists()) { callTimerEl.textContent = "Admin belum online."; return; }
    const d = snap.data();
    if (d?.startedAt && d?.maxSeconds) {
      const startedMs = d.startedAt.toMillis ? d.startedAt.toMillis() : Date.parse(d.startedAt);
      const maxSec = Number(d.maxSeconds || MAX_CALL_SECONDS);
      renderBusyCallCountdown(callTimerEl, startedMs, maxSec);
    } else if (d?.offer && !d?.answer) {
      callTimerEl.textContent = "CS siap. Menunggu pelanggan masuk…";
    } else {
      callTimerEl.textContent = "Panggilan belum terhubung.";
    }
  });

  const qRef = collection(db, "rooms", ROOM_ID, "queue");
  onSnapshot(query(qRef, orderBy("createdAt","asc")), async (snap)=>{
    const arr = [];
    snap.forEach(d => { const v=d.data(); if (!["skipped"].includes(v.status)) arr.push({ id:d.id, ...v }); });

    const myIndex = arr.findIndex(x => x.id === user.uid);
    const position = myIndex >= 0 ? myIndex + 1 : "-";
    posEl.textContent = position === "-" ? "Anda belum terdaftar di antrian" : `Anda antrian ke-${position}`;

    const r = await getDoc(roomDocRef);
    const roomExists = r.exists();
    const rd = r.data() || {};
    const hasActiveCall = !!(rd?.startedAt && rd?.maxSeconds);
    const hasOffer = !!(roomExists && rd?.offer && !rd?.answer);

    if (hasActiveCall) {
      const startedMs = rd.startedAt.toMillis ? rd.startedAt.toMillis() : Date.parse(rd.startedAt);
      const maxSec = Number(rd.maxSeconds || MAX_CALL_SECONDS);
      const elapsed = Math.floor((Date.now() - startedMs)/1000);
      const remain = Math.max(0, maxSec - elapsed);
      const ahead = Math.max(0, (position === "-" ? 0 : position - 1));
      const etaSec = remain + (ahead * MAX_CALL_SECONDS);
      etaEl.textContent = `Estimasi waktu: ${formatMMSS(etaSec)}`;
    } else if (hasOffer) {
      if (position === 1) etaEl.textContent = `Estimasi waktu: 00:00 (CS sudah siap)`;
      else if (position !== "-") {
        const ahead = Math.max(0, position - 1);
        const etaSec = ahead * MAX_CALL_SECONDS;
        etaEl.textContent = `Estimasi waktu: ~${formatMMSS(etaSec)}`;
      } else etaEl.textContent = `Estimasi waktu: —`;
    } else {
      etaEl.textContent = `Menunggu admin online…`;
    }

    if (position === 1 && hasOffer) {
      let countdown = 10;
      modal.style.display = "flex";
      modalText.textContent = "Giliran Anda. Masuk sekarang?";
      modalCountdown.textContent = countdown;

      const t = setInterval(()=>{
        countdown--; modalCountdown.textContent = countdown;
        if (countdown <= 0) {
          clearInterval(t);
          modal.style.display = "none";
          setDoc(myRef, { status:"skipped" }, { merge:true }).then(()=>deleteDoc(myRef));
        }
      }, 1000);

      acceptBtn.onclick = async ()=>{
        clearInterval(t);
        modal.style.display = "none";
        await setDoc(myRef, { status:"accepted", notiExpiresAt: serverTimestamp() }, { merge:true });
        location.href = "./";
      };

      declineBtn.onclick = async ()=>{
        clearInterval(t);
        modal.style.display = "none";
        await setDoc(myRef, { status:"skipped" }, { merge:true });
        await deleteDoc(myRef);
      };

    } else {
      modal.style.display = "none";
    }
  });
}

function renderBusyCallCountdown(el, startedMs, maxSec){
  const remain = Math.max(0, Math.floor(maxSec - (Date.now()-startedMs)/1000));
  el.textContent = `Sisa panggilan aktif: ${formatMMSS(remain)}`;
  if (!el._timer) {
    el._timer = setInterval(()=>{
      const r = Math.max(0, Math.floor(maxSec - (Date.now()-startedMs)/1000));
      el.textContent = `Sisa panggilan aktif: ${formatMMSS(r)}`;
      if (r<=0){ clearInterval(el._timer); el._timer=null; }
    }, 1000);
  }
}
function formatMMSS(sec){
  const mm = String(Math.floor(sec/60)).padStart(2,"0");
  const ss = String(sec%60).padStart(2,"0");
  return `${mm}:${ss}`;
}
function byId(id){ return document.getElementById(id); }
async function askNameForQueue(){
  if (document.getElementById("nameModal")) {
    return await showNameInputModal();
  }
  const p = prompt("Masukkan nama Anda untuk mendaftar antrian:") || "";
  if (!p.trim()) return await askNameForQueue();
  return p.trim();
}

// ==================== MONITOR STATUS (kecil di halaman) ====================
function monitorConnectionStatus() {
  const callerCandidatesRef = collection(db, "rooms", ROOM_ID, "callerCandidates");
  const calleeCandidatesRef = collection(db, "rooms", ROOM_ID, "calleeCandidates");

  onSnapshot(callerCandidatesRef, (snapshot) => {
    if (!isCaller) return;
    if (!snapshot.empty) {
      const el = document.querySelector("#currentRoom");
      if (el) el.textContent = "Online";
    }
  });

  onSnapshot(calleeCandidatesRef, async (snapshot) => {
    const el = document.querySelector("#currentRoom");
    if (isCaller) {
      if (!snapshot.empty) {
        if (el) el.textContent = "Terkoneksi";

        const docSnap = await getDoc(doc(db, "rooms", ROOM_ID));
        if (docSnap.exists()) {
          const name = docSnap.data().calleeName;
          if (name) {
            const label = document.getElementById("calleeNameLabel");
            if (label) { label.textContent = `Customer: ${formatName(name)}`; label.style.display = "block"; }
          }
          attachTimerFromRoom(docSnap.data());
        }
        wasCalleeConnected = true;
      } else if (snapshot.empty && wasCalleeConnected) {
        // Callee terputus → auto-next jika ada antrian
        showCalleeDisconnected(); wasCalleeConnected = false;
        const label = document.getElementById("calleeNameLabel"); if (label) label.style.display = "none";
        stopCallTimer(); removeCallTimerEl();
        await autoNextOrTearDown();
      }
    } else {
      if (!snapshot.empty) { if (el) el.textContent = "Terkoneksi"; }
    }
  });
}
