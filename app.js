// ==================== FIREBASE SETUP ====================
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-app.js";
import {
  getFirestore, doc, setDoc, getDoc, deleteDoc, updateDoc,
  collection, addDoc, onSnapshot, getDocs, serverTimestamp,
  query, orderBy
} from "https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js";
import { 
  getAuth, signInAnonymously, onAuthStateChanged,
  setPersistence, browserLocalPersistence, browserSessionPersistence, inMemoryPersistence
} from "https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyAjqMqmKUDPWHkv19Dig7PnUpHMzNf9J1A",
  authDomain: "onlinecsbwx.firebaseapp.com",
  projectId: "onlinecsbwx",
  storageBucket: "onlinecsbwx.appspot.com",
  messagingSenderId: "317019843909",
  appId: "1:317019843909:web:2d5b2b2c9dd118e0ce622c"
};

// Hindari double init jika file lain juga import Firebase
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const db  = getFirestore(app);
const auth = getAuth(app);

// === Persistence + anon auth ===
async function preparePersistence() {
  try { await setPersistence(auth, browserLocalPersistence); }
  catch { try { await setPersistence(auth, browserSessionPersistence); }
  catch { await setPersistence(auth, inMemoryPersistence); } }
}
async function ensureAnonLogin() { await preparePersistence(); await signInAnonymously(auth); }
function waitForUser(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsub(); reject(new Error("Auth timeout")); }, timeoutMs);
    const unsub = onAuthStateChanged(auth, (user) => { if (user) { clearTimeout(timer); unsub(); resolve(user); } });
  });
}

// ==================== KONFIGURASI ====================
const PAGES = { thanks: "thanks.html", busy: "maaf.html" };

// ==================== GLOBALS ====================
let localStream = null;
let remoteStream = null;
let peerConnection = null;
let roomRef = null;
let isCaller = false;
let wasCalleeConnected = false;
const ROOM_ID = (window.ROOM_ID || "cs-room");

// Queue & timer
const MAX_SESSION_SEC = 600; // 10 menit
let sessionTicker = null;
let queueUnsub = null;

// ==================== MODAL CUSTOM ====================
function ensureModalHost() {
  let host = document.getElementById("appModalHost");
  if (!host) { host = document.createElement("div"); host.id = "appModalHost"; document.body.appendChild(host); }
  return host;
}
function showAppModal({ title, message, okText = "OK", cancelText = null, variant = "default" } = {}) {
  ensureModalHost();
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    const modal = document.createElement("div");
    const header = document.createElement("div");
    const hTitle = document.createElement("div");
    const body = document.createElement("div");
    const actions = document.createElement("div");
    const okBtn = document.createElement("button");
    const cancelBtn = cancelText ? document.createElement("button") : null;
    const closeX = document.createElement("button");

    Object.assign(backdrop.style, {
      position: "fixed", inset: "0", background: "rgba(0,0,0,.45)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: "9999", padding: "16px"
    });
    Object.assign(modal.style, {
      width: "min(480px, 92vw)", background: "#111b21", color: "#e9edef",
      border: "1px solid rgba(255,255,255,.08)", borderRadius: "14px",
      boxShadow: "0 20px 60px rgba(0,0,0,.5)", overflow: "hidden"
    });
    Object.assign(header.style, {
      display: "flex", alignItems: "center", gap: "10px",
      padding: "14px 16px", borderBottom: "1px solid rgba(255,255,255,.08)", fontWeight: "600"
    });
    hTitle.textContent = title || "Info";
    closeX.textContent = "✕";
    Object.assign(closeX.style, {
      marginLeft: "auto", background: "transparent", color: "#e9edef",
      border: "1px solid rgba(255,255,255,.12)", borderRadius: "8px",
      padding: "6px 10px", cursor: "pointer"
    });
    Object.assign(body.style, { padding: "16px", lineHeight: "1.5", color: "#d1d7db" });
    body.innerHTML = message || "";
    Object.assign(actions.style, { display: "flex", gap: "10px", padding: "12px 16px", justifyContent: "flex-end" });

    okBtn.textContent = okText;
    const okBg = (variant === "danger") ? "#f44336" : "#0ea5e9";
    const okBgHover = (variant === "danger") ? "#d32f2f" : "#0284c7";
    Object.assign(okBtn.style, {
      background: okBg, color: "#fff", border: "none",
      padding: "10px 14px", borderRadius: "10px", cursor: "pointer", fontWeight: "700"
    });
    okBtn.onmouseenter = () => okBtn.style.background = okBgHover;
    okBtn.onmouseleave = () => okBtn.style.background = okBg;

    if (cancelBtn) {
      cancelBtn.textContent = cancelText;
      Object.assign(cancelBtn.style, {
        background: "transparent", color: "#e9edef",
        border: "1px solid rgba(255,255,255,.18)", padding: "10px 14px",
        borderRadius: "10px", cursor: "pointer", fontWeight: "600"
      });
      actions.appendChild(cancelBtn);
    }
    actions.appendChild(okBtn);
    header.appendChild(hTitle);
    header.appendChild(closeX);
    modal.appendChild(header); modal.appendChild(body); modal.appendChild(actions);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const cleanup = (result) => { try { backdrop.remove(); } catch {} document.body.style.overflow = ""; resolve(result); };
    closeX.addEventListener("click", () => cleanup(false));
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) cleanup(false); });
    okBtn.addEventListener("click", () => cleanup(true));
    cancelBtn?.addEventListener("click", () => cleanup(false));
    setTimeout(() => okBtn.focus(), 0);
    document.body.style.overflow = "hidden";
  });
}
const alertModal  = (msg, title="Info", variant="default") => showAppModal({ title, message: msg, okText: "OK", cancelText: null, variant });
const confirmModal= (msg, title="Konfirmasi", variant="default") => showAppModal({ title, message: msg, okText: "Ya", cancelText: "Batal", variant });
function inputModal({ title = "Input", placeholder = "Ketik di sini...", okText = "OK", cancelText = "Batal" } = {}) {
  ensureModalHost();
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    const modal = document.createElement("div");
    Object.assign(backdrop.style, {
      position: "fixed", inset: "0", background: "rgba(0,0,0,.45)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: "9999", padding: "16px"
    });
    Object.assign(modal.style, {
      width: "min(420px, 92vw)", background: "#111b21", color: "#e9edef",
      border: "1px solid rgba(255,255,255,.08)", borderRadius: "14px",
      boxShadow: "0 20px 60px rgba(0,0,0,.5)", overflow: "hidden", padding: "16px"
    });
    const h = document.createElement("div"); h.textContent = title; Object.assign(h.style, { fontWeight: 700, marginBottom: "10px" });
    const input = document.createElement("input");
    Object.assign(input.style, {
      width: "100%", background: "#0d1418", color: "#e9edef",
      border: "1px solid rgba(255,255,255,.18)", borderRadius: "10px", padding: "10px 12px", outline: "none"
    });
    input.placeholder = placeholder;
    const err = document.createElement("div"); Object.assign(err.style, { color: "#fca5a5", fontSize: "13px", marginTop: "8px", display: "none" });
    const actions = document.createElement("div"); Object.assign(actions.style, { display: "flex", gap: "10px", justifyContent: "flex-end", marginTop: "14px" });

    const btnCancel = document.createElement("button");
    btnCancel.textContent = cancelText;
    Object.assign(btnCancel.style, { background: "transparent", color: "#e9edef", border: "1px solid rgba(255,255,255,.18)", padding: "10px 14px", borderRadius: "10px", cursor: "pointer", fontWeight: 600 });

    const btnOk = document.createElement("button");
    btnOk.textContent = okText;
    Object.assign(btnOk.style, { background: "#0ea5e9", color: "#fff", border: "none", padding: "10px 14px", borderRadius: "10px", cursor: "pointer", fontWeight: 700 });

    const cleanup = (val) => { try{ backdrop.remove(); }catch{} document.body.style.overflow=""; resolve(val); };
    btnCancel.onclick = () => cleanup("");
    btnOk.onclick = () => { const v = input.value.trim(); if (!v) { err.textContent = "Nama tidak boleh kosong."; err.style.display="block"; input.focus(); return; } cleanup(v); };
    backdrop.addEventListener("click", (e)=>{ if (e.target===backdrop) cleanup(""); });
    input.addEventListener("keypress", (e)=>{ if (e.key==="Enter") btnOk.click(); });

    actions.append(btnCancel, btnOk);
    modal.append(h, input, err, actions);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    document.body.style.overflow = "hidden";
    setTimeout(()=>input.focus(),0);
  });
}

// ==================== HELPERS ====================
function two(n){ return n<10 ? "0"+n : ""+n; }
function fmtMMSS(sec){ sec = Math.max(0, Math.floor(sec)); const m = Math.floor(sec/60), s = sec%60; return two(m)+":"+two(s); }
async function assertRoomExistsOrInform() {
  const ref = doc(db, "rooms", ROOM_ID);
  const snap = await getDoc(ref);
  if (!snap.exists()) { await alertModal("Customer Service belum memulai panggilan.", "Belum Tersedia"); return false; }
  return true;
}

// ==================== INIT ====================
window.onload = async () => {
  try {
    await ensureAnonLogin();
    await waitForUser();
    initAfterAuth();
    startStatusLoop();
    setTimeout(()=>{ openPanel(); }, 600);
  } catch (e) {
    console.error("❌ Gagal login anonim:", e);
    await alertModal("Tidak bisa login ke server. Silakan refresh atau coba browser lain.", "Gagal Login", "danger");
  }
};

async function initAfterAuth() {
  const isCallerPage = location.pathname.includes("caller.html");
  const isMaafPage   = location.pathname.includes("maaf.html");
  const startBtn = document.querySelector("#startCallBtn");
  const hangupBtn = document.querySelector("#hangupBtn");

  if (!isCallerPage && startBtn) startBtn.remove();
  if (hangupBtn) hangupBtn.addEventListener("click", hangUp);

  window.addEventListener("beforeunload", async () => { try { if (!isCaller) { await deleteCalleeCandidates(); } } catch {} });

  const roomDocRef = doc(db, "rooms", ROOM_ID);
  const roomSnap = await getDoc(roomDocRef);

  if (!roomSnap.exists()) {
    // === Belum ada room
    if (isCallerPage && startBtn) {
      // Admin boleh membuat room — tampilkan tombol Start
      startBtn.style.display = "inline-block";
      startBtn.disabled = false;
      startBtn.addEventListener("click", startCall);
    } else {
      // Callee diarahkan
      await alertModal("Customer Service belum memulai panggilan. Silakan coba lagi nanti.", "Belum Tersedia");
      location.href = PAGES.thanks;
      return;
    }
  } else {
    // === Sudah ada room
    const data = roomSnap.data();

    if (isCallerPage) {
      // =========================
      // ADMIN: TIDAK ADA ALERT / REDIRECT
      // =========================
      if (startBtn) {
        startBtn.style.display = "inline-block";
        // Jika sudah ada offer (sesi sedang aktif/siap), hindari double-offer
        startBtn.disabled = !!data?.offer;
        startBtn.addEventListener("click", startCall);
      }
      // lanjutkan: panel status + listener di attachCallerPanel()
    } else {
      // === Halaman callee
      if (data?.offer && !data?.answer) {
        // Ada offer menunggu answer → ajak join
        const name = await showNameInputModal();
        if (!name || name.trim() === "") { await alertModal("Nama wajib diisi untuk bergabung ke panggilan.", "Nama Diperlukan"); return; }
        sessionStorage.setItem("calleeName", name);
        startCall(name).catch(async err => { console.error("Gagal auto-join:", err); await alertModal("Gagal auto-join. Silakan coba lagi.", "Kesalahan"); });
      } else {
        // Sedang sibuk → masuk antrian (maaf.html akan menampilkan posisi)
        await offerQueueFlow();
        location.href = PAGES.thanks;
        return;
      }
    }
  }

  updateButtonStates();

  // Hook tampilan per halaman (tanpa inline script)
  if (isCallerPage){ attachCallerPanel(); }
  else if (isMaafPage){ attachMaafBindings(); }
  else { attachElapsedForCallee(); }
}

// ==================== START CALL ====================
async function startCall(calleeNameFromInit = null) {
  try {
    showLoading(true);

    try {
      const camPerm = await navigator.permissions.query({ name: "camera" });
      if (camPerm.state === "denied") { await alertModal("Izin kamera ditolak. Aktifkan kamera di pengaturan browser.", "Kamera Ditolak", "danger"); return; }
    } catch {}

    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    remoteStream = new MediaStream();
    document.querySelector("#localVideo").srcObject = localStream;
    document.querySelector("#remoteVideo").srcObject = remoteStream;

    // ============================================================
    // NOVAN-LOCK: ICE SERVERS (Xirsys → fallback Google STUN) — JANGAN UBAH
    // ============================================================
    let servers = { iceServers: [], iceCandidatePoolSize: 10 };
    try {
      const res = await fetch("https://global.xirsys.net/_turn/WebRTC", {
        method: "PUT",
        headers: { "Authorization": "Basic " + btoa("n45pnasp:ad5ce69c-45d6-11f0-b602-b6807fc9719e"), "Content-Type": "application/json" }
      });
      const data = await res.json();
      const validIceServers = data?.v?.iceServers?.filter(s => s.urls);
      if (!validIceServers?.length) throw new Error("ICE servers kosong");
      servers.iceServers = validIceServers;
    } catch {
      console.warn("Xirsys gagal, fallback ke Google STUN");
      servers.iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
    }

    // ============================================================
    // NOVAN-LOCK: PEMBUATAN RTCPeerConnection & TRACK — JANGAN UBAH
    // ============================================================
    peerConnection = new RTCPeerConnection(servers);
    localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));
    peerConnection.ontrack = e => e.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));

    roomRef = doc(db, "rooms", ROOM_ID);
    const roomSnap = await getDoc(roomRef);

    // ============================================================
    // NOVAN-LOCK: MONITOR SNAPSHOT KONEKSI — JANGAN UBAH
    // ============================================================
    monitorConnectionStatus();

    if (!roomSnap.exists()) {
      // ===== CALLER flow =====
      isCaller = true;

      // ========================================================
      // NOVAN-LOCK: ICE CANDIDATES (CALLER) — JANGAN UBAH
      // ========================================================
      peerConnection.onicecandidate = e => { if (e.candidate) addDoc(collection(db, "rooms", ROOM_ID, "callerCandidates"), e.candidate.toJSON()); };

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      // ========================================================
      // NOVAN-LOCK: SET OFFER KE FIRESTORE — JANGAN UBAH
      // ========================================================
      await setDoc(roomRef, { 
        offer: { type: offer.type, sdp: offer.sdp },
        currentSession: { status: "active", startedAt: serverTimestamp(), maxSec: MAX_SESSION_SEC, activeQueueId: null }
      });

      // ========================================================
      // NOVAN-LOCK: LISTEN ANSWER + LABEL CALLEE — JANGAN UBAH
      // ========================================================
      onSnapshot(roomRef, snapshot => {
        const data = snapshot.data();
        if (!peerConnection.currentRemoteDescription && data?.answer) {
          peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        }
        if (data?.calleeName) {
          const label = document.getElementById("calleeNameLabel");
          if (label && label.textContent !== data.calleeName) { label.textContent = `CUSTOMER: ${data.calleeName.toUpperCase()}`; label.style.display = "block"; }
        }
      });

      const calleeCandidatesRef = collection(db, "rooms", ROOM_ID, "calleeCandidates");
      onSnapshot(calleeCandidatesRef, snap => {
        snap.docChanges().forEach(async change => { if (change.type === "added") { await peerConnection.addIceCandidate(new RTCIceCandidate(change.doc.data())); } });
      });

    } else {
      // ===== CALLEE flow =====
      const data = roomSnap.data();
      if (data?.calleeName) {
        const label = document.getElementById("calleeNameLabel");
        if (label) { label.textContent = `CUSTOMER: ${data.calleeName.toUpperCase()}`; label.style.display = "block"; }
      }

      if (data?.offer && !data?.answer) {
        isCaller = false;

        const namaCallee = calleeNameFromInit ?? await showNameInputModal();
        if (!namaCallee) throw new Error("Nama tidak diisi.");

        // ======================================================
        // NOVAN-LOCK: ICE CANDIDATES (CALLEE) — JANGAN UBAH
        // ======================================================
        peerConnection.onicecandidate = e => { if (e.candidate) addDoc(collection(db, "rooms", ROOM_ID, "calleeCandidates"), e.candidate.toJSON()); };

        // ======================================================
        // NOVAN-LOCK: SET REMOTE (OFFER) → BUAT ANSWER — JANGAN UBAH
        // ======================================================
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        // ======================================================
        // NOVAN-LOCK: SIMPAN ANSWER + NAMA CALLEE — JANGAN UBAH
        // ======================================================
        await setDoc(roomRef, { answer: { type: answer.type, sdp: answer.sdp }, calleeName: namaCallee }, { merge: true });

        const callerCandidatesRef = collection(db, "rooms", ROOM_ID, "callerCandidates");
        onSnapshot(callerCandidatesRef, snap => {
          snap.docChanges().forEach(async change => { if (change.type === "added") { await peerConnection.addIceCandidate(new RTCIceCandidate(change.doc.data())); } });
        });

        onSnapshot(roomRef, docSnap => { if (!docSnap.exists()) { console.warn("Room dihapus oleh caller, callee keluar..."); cleanupAndRedirectCallee(); } });

      } else {
        await offerQueueFlow();
      }
    }

  } catch (err) {
    console.error("❌ startCall error:", err);
    await alertModal("Gagal connect: " + err.message, "Kesalahan", "danger");
  } finally {
    showLoading(false);
    const startBtn = document.querySelector("#startCallBtn");
    if (startBtn) startBtn.disabled = true;
    updateButtonStates();
  }
}

// ==================== MODAL NAMA CALLEE ====================
function showNameInputModal() {
  return new Promise((resolve) => {
    const modal = document.getElementById("nameModal");
    const input = document.getElementById("calleeNameInput");
    const joinBtn = document.getElementById("joinBtn");
    const cancelBtn = document.getElementById("cancelBtn");
    let inlineErr = document.getElementById("nameInlineError");

    if (!modal) { inputModal({ title: "Masukkan nama Anda", placeholder: "Nama Anda", okText: "Gabung", cancelText: "Batal" }).then(v=>resolve(v||"")); return; }

    modal.style.display = "flex";
    if (input) { input.value = ""; input.focus(); }
    if (!inlineErr) { inlineErr = document.createElement("div"); inlineErr.id = "nameInlineError"; Object.assign(inlineErr.style, { color: "#fca5a5", fontSize: "13px", marginTop: "8px", display: "none" }); input?.parentElement?.appendChild(inlineErr); }

    const onJoin = () => {
      const name = (input?.value || "").trim();
      if (name) { inlineErr.style.display = "none"; modal.style.display = "none"; cleanup(); resolve(name); }
      else { inlineErr.textContent = "Nama tidak boleh kosong."; inlineErr.style.display = "block"; input?.focus(); }
    };
    const onCancel = () => { modal.style.display = "none"; cleanup(); resolve(""); };
    const onKey = (e) => { if (e.key === "Enter") onJoin(); };

    joinBtn?.addEventListener("click", onJoin);
    cancelBtn?.addEventListener("click", onCancel);
    input?.addEventListener("keypress", onKey);
    function cleanup() { joinBtn?.removeEventListener("click", onJoin); cancelBtn?.removeEventListener("click", onCancel); input?.removeEventListener("keypress", onKey); }
  });
}

// ==================== QUEUE (CALLEE SIDE) ====================
async function offerQueueFlow(){
  const exists = await assertRoomExistsOrInform();
  if (!exists) return;

  const accept = await confirmModal("Saat ini sedang ada panggilan yang terhubung.\nApakah Anda bersedia masuk antrian?", "Masuk Antrian");
  if (!accept) return;

  const name = await inputModal({ title:"Masukkan nama Anda", placeholder:"Nama pelanggan", okText:"Masuk Antrian" });
  if (!name) return;

  const qRef = collection(db, "rooms", ROOM_ID, "queue");
  const my = await addDoc(qRef, { name, status:"waiting", createdAt: serverTimestamp() });
  sessionStorage.setItem("myQueueId", my.id);

  return new Promise((resolve)=>{
    const unsub = onSnapshot(doc(db, "rooms", ROOM_ID, "queue", my.id), async (ds)=>{
      if (!ds.exists()) return;
      const d = ds.data();
      if (d.status === "ready"){
        unsub();
        const ok = await confirmModal("Pelanggan pertama selesai. Anda siap join?", "Siap Bergabung");
        if (ok){
          await setDoc(ds.ref, { status:"served" }, { merge:true });
          const cachedName = name;
          sessionStorage.setItem("calleeName", cachedName);
          startCall(cachedName);
          resolve();
        } else {
          await setDoc(ds.ref, { status:"cancelled" }, { merge:true });
          resolve();
        }
      }
    });
  });
}

// ==================== MONITOR STATUS ====================
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

  onSnapshot(calleeCandidatesRef, (snapshot) => {
    const el = document.querySelector("#currentRoom");
    if (isCaller) {
      if (!snapshot.empty) {
        if (el) el.textContent = "Terkoneksi";

        getDoc(doc(db, "rooms", ROOM_ID)).then((docSnap) => {
          if (docSnap.exists()) {
            const name = docSnap.data().calleeName;
            if (name) {
              const label = document.getElementById("calleeNameLabel");
              if (label) { label.textContent = `Customer: ${formatName(name)}`; label.style.display = "block"; }
            }
          }
        });

        wasCalleeConnected = true;
      } else if (snapshot.empty && wasCalleeConnected) {
        wasCalleeConnected = false;
        const label = document.getElementById("calleeNameLabel");
        if (label) label.style.display = "none";
        showCalleeDisconnected();
        // === Auto-promote ketika callee disconnect
        autoPromoteIfNeeded();
      }
    } else {
      if (!snapshot.empty) { if (el) el.textContent = "Terkoneksi"; }
    }
  });
}
function formatName(n) { return (n || "").toString().trim(); }

// ==================== CALLER PANEL (tanpa tombol khusus) ====================
function attachCallerPanel(){
  // Antrian realtime untuk ditampilkan
  const qRef = collection(db, "rooms", ROOM_ID, "queue");
  if (queueUnsub) queueUnsub();
  queueUnsub = onSnapshot(qRef, (snap)=>{
    const items = snap.docs.map(d => ({ id:d.id, ...d.data() }))
      .sort((a,b)=> (a.createdAt?.seconds||0) - (b.createdAt?.seconds||0));
    renderQueue(items);
  });

  // Timer (elapsed)
  if (!roomRef) roomRef = doc(db, "rooms", ROOM_ID);
  onSnapshot(roomRef, (snap)=>{
    const data = snap.data() || {};
    const cs = data.currentSession || { status:"idle" };
    updateSessionUI(cs);
  });
}
function renderQueue(items){
  const box = document.getElementById("queueList");
  if (!box) return;
  if (!items.length){ box.textContent = "Belum ada yang mengantri."; return; }
  const html = items.map((it, idx)=>{
    const badge =
      it.status === "waiting" ? "🟡 menunggu" :
      it.status === "ready"   ? "🟢 siap" :
      it.status === "served"  ? "⚪ selesai" :
      it.status === "cancelled" ? "⚫ batal" : it.status;
    const bold = idx===0 && it.status==="waiting" ? "font-weight:700" : "";
    return `<div style="display:flex;justify-content:space-between;margin-bottom:6px;${bold}">
      <div>${idx+1}. ${it.name || "(tanpa nama)"} <span class="last-checked">(${badge})</span></div>
      <div class="last-checked">${it.createdAt?.seconds ? new Date(it.createdAt.seconds*1000).toLocaleTimeString() : "-"}</div>
    </div>`;
  }).join("");
  box.innerHTML = html;
}
function updateSessionUI(cs){
  const tEl = document.getElementById("sessionTimer");
  if (!tEl) return;
  if (sessionTicker) { clearInterval(sessionTicker); sessionTicker = null; }
  tEl.textContent = "00:00";
  if (cs.status === "active" && cs.startedAt?.seconds){
    sessionTicker = setInterval(async ()=>{
      const elapsed = (Date.now()/1000) - cs.startedAt.seconds; // waktu berjalan
      tEl.textContent = fmtMMSS(elapsed);
      if ((cs.maxSec || MAX_SESSION_SEC) > 0 && elapsed >= (cs.maxSec || MAX_SESSION_SEC)){
        clearInterval(sessionTicker); sessionTicker = null;
        await endCurrentSessionAndAutoPromote(); // auto lanjut
      }
    }, 1000);
  }
}

// === Auto-promote helper ===
async function autoPromoteIfNeeded(){
  // Saat callee disconnect: tandai served kalau ada activeQueueId, reset jejak, dan panggil antrian berikutnya otomatis
  if (!roomRef) roomRef = doc(db, "rooms", ROOM_ID);
  const snap = await getDoc(roomRef);
  if (!snap.exists()) return;
  const data = snap.data() || {};
  const cs = data.currentSession;

  if (cs?.status === "active") {
    if (cs.activeQueueId){
      await setDoc(doc(db,"rooms",ROOM_ID,"queue", cs.activeQueueId), { status:"served" }, { merge:true });
    }
    await resetForNextCallee();
    await setDoc(roomRef, { currentSession: { status:"idle" } }, { merge:true });
    await startNextFromQueue(); // lanjut otomatis
  }
}

async function startNextFromQueue(){
  if (!roomRef) roomRef = doc(db, "rooms", ROOM_ID);
  const qRef = collection(db, "rooms", ROOM_ID, "queue");
  const snap = await getDocs(qRef);
  const items = snap.docs.map(d => ({ id:d.id, ...d.data() }))
    .filter(d => d.status === "waiting")
    .sort((a,b)=> (a.createdAt?.seconds||0)-(b.createdAt?.seconds||0));
  if (!items.length) return;

  const candidate = items[0];
  await resetForNextCallee(); // clear jejak callee sebelumnya (jawaban + candidates)
  await setDoc(doc(db, "rooms", ROOM_ID, "queue", candidate.id), { status:"ready" }, { merge:true });
  await setDoc(roomRef, {
    currentSession: { status: "active", startedAt: serverTimestamp(), maxSec: MAX_SESSION_SEC, activeQueueId: candidate.id }
  }, { merge:true });
}

// Reset jejak callee & answer, pertahankan OFFER caller
async function resetForNextCallee(){
  const callerCandidatesRef = collection(db, "rooms", ROOM_ID, "callerCandidates");
  const calleeCandidatesRef = collection(db, "rooms", ROOM_ID, "calleeCandidates");
  const [callerDocs, calleeDocs] = await Promise.all([ getDocs(callerCandidatesRef), getDocs(calleeCandidatesRef) ]);
  const allDocs = [...callerDocs.docs, ...calleeDocs.docs];
  await Promise.all(allDocs.map(d => deleteDoc(d.ref)));
  if (!roomRef) roomRef = doc(db, "rooms", ROOM_ID);
  await setDoc(roomRef, { answer: null, calleeName: null }, { merge:true });
}

async function endCurrentSessionAndAutoPromote(){
  await alertModal("Waktu sesi sudah 10 menit. Sesi diakhiri.", "Sesi Berakhir");
  const snap = await getDoc(roomRef);
  const data = snap.data() || {};
  const cs = data.currentSession;
  if (cs?.activeQueueId){
    await setDoc(doc(db,"rooms",ROOM_ID,"queue", cs.activeQueueId), { status:"served" }, { merge:true });
  }
  await resetForNextCallee();
  await setDoc(roomRef, { currentSession: { status:"idle" } }, { merge:true });
  await startNextFromQueue(); // otomatis lanjut
}

// ==================== HANG UP ====================
async function hangUp() {
  try {
    // ====================================================
    // NOVAN-LOCK: CLEAN TRACKS & PEER DISCONNECT — JANGAN UBAH
    // ====================================================
    localStream?.getTracks().forEach(t => t.stop());
    remoteStream?.getTracks().forEach(t => t.stop());
    document.querySelector("#localVideo").srcObject = null;
    document.querySelector("#remoteVideo").srcObject = null;
    peerConnection?.close();
    peerConnection = null;

    if (isCaller) {
      // Kosongkan queue + beri notifikasi pembatalan
      const qRef = collection(db, "rooms", ROOM_ID, "queue");
      const snap = await getDocs(qRef);
      await Promise.all(snap.docs.map(d => setDoc(d.ref, { status:"cancelled" }, { merge:true })));

      await deleteRoomIfCaller();
      await setDoc(doc(db,"rooms",ROOM_ID), { currentSession:{ status:"idle" } }, { merge:true });

      await alertModal("Admin menghentikan layanan. Antrian dikosongkan.", "Layanan Dihentikan", "danger");
      location.reload();
    } else {
      const roomSnap = await getDoc(doc(db, "rooms", ROOM_ID));
      await deleteCalleeCandidates();
      if (roomSnap.exists()) { location.href = PAGES.thanks; return; }
      location.reload();
    }
  } catch (e) {
    console.warn("hangUp error:", e);
    location.href = PAGES.thanks;
  }
}

// ==================== CLEANUP CALLEE ====================
function cleanupAndRedirectCallee() {
  try {
    localStream?.getTracks().forEach(t => t.stop());
    remoteStream?.getTracks().forEach(t => t.stop());
    peerConnection?.close();
  } catch {}
  document.querySelector("#localVideo").srcObject = null;
  document.querySelector("#remoteVideo").srcObject = null;
  deleteCalleeCandidates().finally(() => { location.href = PAGES.thanks; });
}

// ==================== DELETE ROOM (CALLER) ====================
async function deleteRoomIfCaller() {
  if (!roomRef) roomRef = doc(db, "rooms", ROOM_ID);
  try {
    // ====================================================
    // NOVAN-LOCK: HAPUS SUBKOLEKSI CANDIDATES — JANGAN UBAH
    // ====================================================
    const callerCandidatesRef = collection(db, "rooms", ROOM_ID, "callerCandidates");
    const calleeCandidatesRef = collection(db, "rooms", ROOM_ID, "calleeCandidates");
    const callerDocs = await getDocs(callerCandidatesRef);
    const calleeDocs = await getDocs(calleeCandidatesRef);
    const allDocs = [...callerDocs.docs, ...calleeDocs.docs];
    await Promise.all(allDocs.map(d => deleteDoc(d.ref)));

    // ====================================================
    // NOVAN-LOCK: HAPUS ROOM DOC — JANGAN UBAH
    // ====================================================
    await deleteDoc(roomRef);
    console.log("🔥 Room & subkoleksi berhasil dihapus");
  } catch (err) {
    console.warn("⚠️ Gagal hapus room:", err.message);
  }
}
async function deleteCalleeCandidates() {
  try {
    // ====================================================
    // NOVAN-LOCK: HAPUS CALLEE CANDIDATES — JANGAN UBAH
    // ====================================================
    const calleeCandidatesRef = collection(db, "rooms", ROOM_ID, "calleeCandidates");
    const calleeDocs = await getDocs(calleeCandidatesRef);
    await Promise.all(calleeDocs.docs.map(d => deleteDoc(d.ref)));
    console.log("🧹 calleeCandidates dihapus");
  } catch (err) {
    console.warn("⚠️ Gagal hapus calleeCandidates:", err.message);
  }
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
  const existing = document.querySelector("#calleeDisconnectedMsg");
  if (existing) return;
  const message = document.createElement("div");
  message.id = "calleeDisconnectedMsg";
  message.innerText = "Callee telah menutup sambungan.";
  Object.assign(message.style, {
    position: "absolute", top: "10px", left: "50%", transform: "translateX(-50%)",
    background: "red", color: "white", padding: "10px 20px", borderRadius: "5px",
    zIndex: 9999, fontSize: "16px"
  });
  document.body.appendChild(message);
}

// ==================== SLIDE PANEL (UI) ====================
const slidePanel    = document.getElementById('slidePanel');
const slideHandle   = document.getElementById('slideHandle');
const handleIcon    = document.getElementById('handleIcon');
const panelBackdrop = document.getElementById('panelBackdrop');
const closePanelBtn = document.getElementById('closePanelBtn');
const statusText    = document.getElementById('statusText');
const lastChecked   = document.getElementById('lastCheckedText');
const spinnerDots   = document.getElementById('spinnerDots');
const closeRoomBtn  = document.getElementById('closeRoomBtn');

function openPanel(){ if (!slidePanel) return; slidePanel.classList.add('open'); slidePanel.setAttribute('aria-hidden','false'); panelBackdrop?.classList.add('show'); if (handleIcon) handleIcon.textContent = 'chevron_right'; }
function closePanel(){ if (!slidePanel) return; slidePanel.classList.remove('open'); slidePanel.setAttribute('aria-hidden','true'); panelBackdrop?.classList.remove('show'); if (handleIcon) handleIcon.textContent = 'chevron_left'; }
function togglePanel(){ slidePanel?.classList.contains('open') ? closePanel() : openPanel(); }
slideHandle?.addEventListener('click', togglePanel);
closePanelBtn?.addEventListener('click', closePanel);
panelBackdrop?.addEventListener('click', closePanel);

// Status cepat untuk panel
async function checkRoomStatus(){
  if (!statusText || !lastChecked) return;
  try{
    const callerRef = collection(db, 'rooms', ROOM_ID, 'callerCandidates');
    const calleeRef = collection(db, 'rooms', ROOM_ID, 'calleeCandidates');
    const [callerSnap, calleeSnap] = await Promise.all([ getDocs(callerRef), getDocs(calleeRef) ]);
    const callerConnected = !callerSnap.empty;
    const calleeConnected = !calleeSnap.empty;

    let msg = "";
    if (callerConnected && calleeConnected)      msg = "🟢 Caller & Callee sudah terhubung.";
    else if (callerConnected)                    msg = "🟡 Hanya Caller yang terhubung.";
    else if (calleeConnected)                    msg = "🟡 Hanya Callee yang terhubung.";
    else                                         msg = "⚪ Belum ada koneksi dari Caller maupun Callee.";

    statusText.textContent = msg;
    lastChecked.textContent = "Terakhir diperiksa: " + new Date().toLocaleTimeString();
  }catch(err){
    statusText.textContent = "❌ Gagal mengecek status: " + err.message;
    lastChecked.textContent = "Terakhir diperiksa: -";
  }
}
let statusTimer = null;
function startStatusLoop(){ if (!statusText) return; checkRoomStatus(); if (statusTimer) clearInterval(statusTimer); statusTimer = setInterval(checkRoomStatus, 3000); }

// Tombol panel default (hapus data room total) — opsional tetap ada
async function deleteRoomData(){
  if (spinnerDots) spinnerDots.style.display = 'flex';
  if (statusText)  statusText.textContent = "Menghapus data…";
  if (closeRoomBtn) closeRoomBtn.disabled = true;
  try{ await deleteRoomIfCaller(); if (statusText) statusText.textContent = "✅ Room berhasil dihapus!"; }
  catch(err){ if (statusText) statusText.textContent = "❌ Gagal menghapus room: " + err.message; }
  finally{ if (spinnerDots) spinnerDots.style.display = 'none'; if (closeRoomBtn) closeRoomBtn.disabled = false; }
}
closeRoomBtn?.addEventListener('click', deleteRoomData);

// ==================== CALLEE/UI (tanpa inline script) ====================
function attachElapsedForCallee(){
  const el = document.getElementById("waktuPanggilan");
  if (!el) return;
  function two(n){ return n<10?"0"+n:""+n; }
  function fmt(sec){ sec=Math.max(0,Math.floor(sec));return two(Math.floor(sec/60))+":"+two(sec%60); }
  let tick = null;
  onSnapshot(doc(db,"rooms",ROOM_ID),(snap)=>{
    if (!snap.exists()){
      el.textContent = "Customer Service belum memulai panggilan.";
      if (tick) { clearInterval(tick); tick = null; }
      return;
    }
    const cs = (snap.data()||{}).currentSession || {status:"idle"};
    if (tick) { clearInterval(tick); tick=null; }
    if (cs.status==="active" && cs.startedAt?.seconds){
      tick = setInterval(()=>{
        const elapsed = (Date.now()/1000) - cs.startedAt.seconds;
        el.textContent = "Waktu panggilan berjalan: " + fmt(elapsed);
      }, 1000);
    } else {
      el.textContent = "Tidak ada panggilan aktif.";
    }
  });
}

function attachMaafBindings(){
  const posEl   = document.getElementById("antrianPos");
  const timerEl = document.getElementById("antrianTimer");
  if (!posEl || !timerEl) return;

  function two(n){ return n<10?"0"+n:""+n; }
  function fmt(sec){ sec=Math.max(0,Math.floor(sec));return two(Math.floor(sec/60))+":"+two(sec%60); }

  // Elapsed
  let tick = null;
  onSnapshot(doc(db,"rooms",ROOM_ID),(snap)=>{
    if (!snap.exists()){
      timerEl.textContent = "Customer Service belum memulai panggilan.";
      if (tick) { clearInterval(tick); tick = null; }
      return;
    }
    const cs = (snap.data()||{}).currentSession || {status:"idle"};
    if (tick) { clearInterval(tick); tick=null; }
    if (cs.status==="active" && cs.startedAt?.seconds){
      tick = setInterval(()=>{
        const elapsed = (Date.now()/1000) - cs.startedAt.seconds;
        timerEl.textContent = "Waktu panggilan berjalan: " + fmt(elapsed);
      }, 1000);
    } else {
      timerEl.textContent = "Tidak ada panggilan aktif.";
    }
  });

  // Posisi antrian user (dinamis)
  const myQueueId = sessionStorage.getItem("myQueueId");
  const qRef = collection(db,"rooms",ROOM_ID,"queue");
  async function refreshPos(){
    try{
      const q = query(qRef, orderBy("createdAt","asc"));
      const snap = await getDocs(q);
      const list = snap.docs.map(d=>({ id:d.id, ...d.data() }));
      if (!myQueueId){ posEl.textContent = "Anda belum masuk antrian."; return; }
      const waitingLike = list.filter(it => it.status === "waiting" || it.status === "ready");
      const idx = waitingLike.findIndex(it => it.id === myQueueId);
      if (idx === -1){
        const me = list.find(it => it.id === myQueueId);
        if (me?.status === "served")   posEl.textContent = "Antrian Anda sudah dipanggil (selesai).";
        else if (me?.status === "cancelled") posEl.textContent = "Antrian Anda dibatalkan.";
        else posEl.textContent = "Menunggu informasi antrian…";
      } else {
        posEl.textContent = "Posisi Antrian Anda: " + (idx+1);
      }
    }catch{ posEl.textContent = "Gagal memuat antrian."; }
  }
  onSnapshot(qRef, refreshPos);
  refreshPos();
}
