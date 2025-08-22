// ==================== FIREBASE SETUP ====================
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-app.js";
import {
  getFirestore, doc, setDoc, getDoc, deleteDoc, deleteField,
  collection, addDoc, onSnapshot, getDocs
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

// === [PERBAIKAN] Persistence fallback + tunggu anon login selesai ===
async function preparePersistence() {
  try {
    await setPersistence(auth, browserLocalPersistence);
  } catch {
    try { await setPersistence(auth, browserSessionPersistence); }
    catch { await setPersistence(auth, inMemoryPersistence); }
  }
}

async function ensureAnonLogin() {
  await preparePersistence();
  await signInAnonymously(auth);
}

function waitForUser(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error("Auth timeout"));
    }, timeoutMs);
    const unsub = onAuthStateChanged(auth, (user) => {
      if (user) {
        clearTimeout(timer);
        unsub();
        resolve(user);
      }
    });
  });
}

// ==================== KONFIGURASI HALAMAN (RELATIF) ====================
const PAGES = {
  thanks: "thanks.html",
  busy:   "maaf.html"
};

// ==================== GLOBALS ====================
let localStream = null;
let remoteStream = null;
let peerConnection = null;
let roomRef = null;
let isCaller = false;
let wasCalleeConnected = false;
let wasCallerConnected = false;
let callStartTime = null;
let callTimerInterval = null;
let oneMinuteWarningShown = false;
const MAX_CALL_DURATION_SEC = 10 * 60;
const ROOM_ID = (window.ROOM_ID || "cs-room"); // bisa di-overwrite dari HTML bila perlu

// =====================================================
// ================== MODAL UTIL (CUSTOM) ==============
// =====================================================
function ensureModalHost() {
  let host = document.getElementById("appModalHost");
  if (!host) {
    host = document.createElement("div");
    host.id = "appModalHost";
    document.body.appendChild(host);
  }
  return host;
}

/**
 * Modal bergaya dark sesuai tema (mirip modal nama).
 * @param {Object} opts
 * @param {string} opts.title
 * @param {string} opts.message (boleh HTML sederhana)
 * @param {string} [opts.okText="OK"]
 * @param {string|null} [opts.cancelText=null] -> kalau ada, jadi confirm dialog
 * @param {"default"|"danger"} [opts.variant="default"] -> warna tombol OK
 * @returns {Promise<boolean>} resolve true jika OK, false jika Cancel/close
 */
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

    // Backdrop
    Object.assign(backdrop.style, {
      position: "fixed", inset: "0", background: "rgba(0,0,0,.45)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: "9999", padding: "16px"
    });

    // Modal
    Object.assign(modal.style, {
      width: "min(480px, 92vw)", background: "#111b21", color: "#e9edef",
      border: "1px solid rgba(255,255,255,.08)", borderRadius: "14px",
      boxShadow: "0 20px 60px rgba(0,0,0,.5)", overflow: "hidden"
    });

    // Header
    Object.assign(header.style, {
      display: "flex", alignItems: "center", gap: "10px",
      padding: "14px 16px", borderBottom: "1px solid rgba(255,255,255,.08)",
      fontWeight: "600"
    });
    hTitle.textContent = title || "Info";

    // Close (X)
    closeX.textContent = "✕";
    Object.assign(closeX.style, {
      marginLeft: "auto", background: "transparent", color: "#e9edef",
      border: "1px solid rgba(255,255,255,.12)", borderRadius: "8px",
      padding: "6px 10px", cursor: "pointer"
    });

    // Body
    Object.assign(body.style, { padding: "16px", lineHeight: "1.5", color: "#d1d7db" });
    body.innerHTML = message || "";

    // Actions
    Object.assign(actions.style, { display: "flex", gap: "10px", padding: "12px 16px", justifyContent: "flex-end" });

    // OK Button
    okBtn.textContent = okText;
    const okBg = (variant === "danger") ? "#f44336" : "#0ea5e9";
    const okBgHover = (variant === "danger") ? "#d32f2f" : "#0284c7";
    Object.assign(okBtn.style, {
      background: okBg, color: "#fff", border: "none",
      padding: "10px 14px", borderRadius: "10px", cursor: "pointer", fontWeight: "700"
    });
    okBtn.onmouseenter = () => okBtn.style.background = okBgHover;
    okBtn.onmouseleave = () => okBtn.style.background = okBg;

    // Cancel Button (opsional)
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
    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(actions);
    backdrop.appendChild(modal);
    document.getElementById("appModalHost").appendChild(backdrop);

    const cleanup = (result) => {
      try { backdrop.remove(); } catch {}
      document.body.style.overflow = "";
      resolve(result);
    };

    closeX.addEventListener("click", () => cleanup(false));
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) cleanup(false); });
    okBtn.addEventListener("click", () => cleanup(true));
    cancelBtn?.addEventListener("click", () => cleanup(false));

    // Trap focus sederhana
    setTimeout(() => okBtn.focus(), 0);
    document.body.style.overflow = "hidden";
  });
}

// Helpers ringkas
function alertModal(message, title = "Info", variant = "default") {
  return showAppModal({ title, message, okText: "OK", cancelText: null, variant });
}
function confirmModal(message, title = "Konfirmasi", variant = "default") {
  return showAppModal({ title, message, okText: "Ya", cancelText: "Batal", variant });
}

/** Modal input (fallback jika #nameModal tidak ada di HTML). */
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

    const h = document.createElement("div");
    h.textContent = title;
    Object.assign(h.style, { fontWeight: 700, marginBottom: "10px" });

    const input = document.createElement("input");
    Object.assign(input.style, {
      width: "100%", background: "#0d1418", color: "#e9edef",
      border: "1px solid rgba(255,255,255,.18)", borderRadius: "10px",
      padding: "10px 12px", outline: "none"
    });
    input.placeholder = placeholder;

    const err = document.createElement("div");
    Object.assign(err.style, { color: "#fca5a5", fontSize: "13px", marginTop: "8px", display: "none" });

    const actions = document.createElement("div");
    Object.assign(actions.style, { display: "flex", gap: "10px", justifyContent: "flex-end", marginTop: "14px" });

    const btnCancel = document.createElement("button");
    btnCancel.textContent = cancelText;
    Object.assign(btnCancel.style, {
      background: "transparent", color: "#e9edef", border: "1px solid rgba(255,255,255,.18)",
      padding: "10px 14px", borderRadius: "10px", cursor: "pointer", fontWeight: 600
    });

    const btnOk = document.createElement("button");
    btnOk.textContent = okText;
    Object.assign(btnOk.style, {
      background: "#0ea5e9", color: "#fff", border: "none",
      padding: "10px 14px", borderRadius: "10px", cursor: "pointer", fontWeight: 700
    });

    const cleanup = (val) => { try{ backdrop.remove(); }catch{} document.body.style.overflow=""; resolve(val); };
    btnCancel.onclick = () => cleanup("");
    btnOk.onclick = () => {
      const v = input.value.trim();
      if (!v) { err.textContent = "Nama tidak boleh kosong."; err.style.display="block"; input.focus(); return; }
      cleanup(v);
    };
    backdrop.addEventListener("click", (e)=>{ if (e.target===backdrop) cleanup(""); });
    input.addEventListener("keypress", (e)=>{ if (e.key==="Enter") btnOk.click(); });

    actions.append(btnCancel, btnOk);
    modal.append(h, input, err, actions);
    backdrop.appendChild(modal);
    document.getElementById("appModalHost").appendChild(backdrop);
    document.body.style.overflow = "hidden";
    setTimeout(()=>input.focus(),0);
  });
}

// ==================== INIT ====================
window.onload = async () => {
  try {
    await ensureAnonLogin();
    const user = await waitForUser();
    console.log("✅ Anon login:", user.uid);
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
  const startBtn = document.querySelector("#startCallBtn");
  const hangupBtn = document.querySelector("#hangupBtn");

  if (!isCallerPage && startBtn) startBtn.remove();
  if (hangupBtn) hangupBtn.addEventListener("click", hangUp);

  // Cleanup ketika tab ditutup/refresh
  window.addEventListener("beforeunload", async () => {
    try {
      if (!isCaller) {
        await deleteCalleeCandidates();
      }
    } catch {}
  });

  const roomSnap = await getDoc(doc(db, "rooms", ROOM_ID));

  if (!roomSnap.exists()) {
    // Room belum dibuat oleh CS
    if (isCallerPage && startBtn) {
      startBtn.style.display = "inline-block";
      startBtn.disabled = false;
      startBtn.addEventListener("click", startCall);
    } else {
      await alertModal("Customer Service belum memulai panggilan. Silakan coba lagi nanti.", "Belum Tersedia");
      location.href = PAGES.thanks;
    }
  } else {
    const data = roomSnap.data();

    if (isCallerPage && startBtn) {
      startBtn.style.display = "inline-block";
      startBtn.disabled = true; // room sudah ada, menunggu callee
    }

    if (data?.offer && !data?.answer) {
      // Ada offer → callee boleh join
      if (!isCallerPage) {
        const name = await showNameInputModal();
        if (!name || name.trim() === "") {
          await alertModal("Nama wajib diisi untuk bergabung ke panggilan.", "Nama Diperlukan");
          return;
        }
        sessionStorage.setItem("calleeName", name);
        startCall(name).catch(async err => {
          console.error("Gagal auto-join:", err);
          await alertModal("Gagal auto-join. Silakan coba lagi.", "Kesalahan");
        });
      }
    } else {
      await alertModal("Maaf, kami sedang melayani pelanggan lain saat ini.", "Sedang Sibuk");
      location.href = PAGES.busy;
    }
  }

  updateButtonStates();
}

// ==================== START CALL ====================
async function startCall(calleeNameFromInit = null) {
  try {
    showLoading(true);

    // Cek izin kamera (opsional)
    try {
      const camPerm = await navigator.permissions.query({ name: "camera" });
      if (camPerm.state === "denied") {
        await alertModal("Izin kamera ditolak. Aktifkan kamera di pengaturan browser.", "Kamera Ditolak", "danger");
        return;
      }
    } catch { /* Permissions API tidak selalu ada */ }

    // Ambil media
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
        headers: {
          "Authorization": "Basic " + btoa("n45pnasp:ad5ce69c-45d6-11f0-b602-b6807fc9719e"),
          "Content-Type": "application/json"
        }
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
      peerConnection.onicecandidate = e => {
        if (e.candidate) addDoc(collection(db, "rooms", ROOM_ID, "callerCandidates"), e.candidate.toJSON());
      };

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      // ========================================================
      // NOVAN-LOCK: SET OFFER KE FIRESTORE — JANGAN UBAH
      // ========================================================
      await setDoc(roomRef, { offer: { type: offer.type, sdp: offer.sdp } });

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
          if (label && label.textContent !== data.calleeName) {
            label.textContent = `CUSTOMER: ${data.calleeName.toUpperCase()}`;
            label.style.display = "block";
          }
        }
      });

      // ========================================================
      // NOVAN-LOCK: DENGARKAN CANDIDATE CALLEE — JANGAN UBAH
      // ========================================================
      const calleeCandidatesRef = collection(db, "rooms", ROOM_ID, "calleeCandidates");
      onSnapshot(calleeCandidatesRef, snap => {
        snap.docChanges().forEach(async change => {
          if (change.type === "added") {
            await peerConnection.addIceCandidate(new RTCIceCandidate(change.doc.data()));
          }
        });
      });

    } else {
      // ===== CALLEE flow =====
      const data = roomSnap.data();

      if (data?.calleeName) {
        const label = document.getElementById("calleeNameLabel");
        if (label) {
          label.textContent = `CUSTOMER: ${data.calleeName.toUpperCase()}`;
          label.style.display = "block";
        }
      }

      if (data?.offer && !data?.answer) {
        isCaller = false;

        // Popup nama (jika belum ada)
        const namaCallee = calleeNameFromInit ?? await showNameInputModal();
        if (!namaCallee) throw new Error("Nama tidak diisi.");

        // ======================================================
        // NOVAN-LOCK: ICE CANDIDATES (CALLEE) — JANGAN UBAH
        // ======================================================
        peerConnection.onicecandidate = e => {
          if (e.candidate) addDoc(collection(db, "rooms", ROOM_ID, "calleeCandidates"), e.candidate.toJSON());
        };

        // ======================================================
        // NOVAN-LOCK: SET REMOTE (OFFER) → BUAT ANSWER — JANGAN UBAH
        // ======================================================
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        // ======================================================
        // NOVAN-LOCK: SIMPAN ANSWER + NAMA CALLEE — JANGAN UBAH
        // ======================================================
        await setDoc(roomRef, {
          answer: { type: answer.type, sdp: answer.sdp },
          calleeName: namaCallee
        }, { merge: true });

        // ======================================================
        // NOVAN-LOCK: DENGARKAN CANDIDATE CALLER — JANGAN UBAH
        // ======================================================
        const callerCandidatesRef = collection(db, "rooms", ROOM_ID, "callerCandidates");
        onSnapshot(callerCandidatesRef, snap => {
          snap.docChanges().forEach(async change => {
            if (change.type === "added") {
              await peerConnection.addIceCandidate(new RTCIceCandidate(change.doc.data()));
            }
          });
        });

        // ======================================================
        // NOVAN-LOCK: ROOM DIHAPUS OLEH CALLER — JANGAN UBAH
        // ======================================================
        onSnapshot(roomRef, docSnap => {
          if (!docSnap.exists()) {
            console.warn("Room dihapus oleh caller, callee keluar...");
            cleanupAndRedirectCallee();
          }
        });

      } else {
        await alertModal("Terima kasih. Silakan hubungi Customer Service bila dibutuhkan kembali.", "Selesai");
        location.href = PAGES.thanks;
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

    // Jika tidak ada modal di HTML, pakai fallback modal input custom
    if (!modal) {
      inputModal({ title: "Masukkan nama Anda", placeholder: "Nama Anda", okText: "Gabung", cancelText: "Batal" })
        .then(v => resolve(v || ""));
      return;
    }

    modal.style.display = "flex";
    if (input) { input.value = ""; input.focus(); }
    if (!inlineErr) {
      inlineErr = document.createElement("div");
      inlineErr.id = "nameInlineError";
      Object.assign(inlineErr.style, { color: "#fca5a5", fontSize: "13px", marginTop: "8px", display: "none" });
      input?.parentElement?.appendChild(inlineErr);
    }

    const onJoin = () => {
      const name = (input?.value || "").trim();
      if (name) {
        inlineErr.style.display = "none";
        modal.style.display = "none";
        cleanup();
        resolve(name);
      } else {
        inlineErr.textContent = "Nama tidak boleh kosong.";
        inlineErr.style.display = "block";
        input?.focus();
      }
    };

    const onCancel = () => {
      modal.style.display = "none";
      cleanup();
      resolve(""); // biarkan caller memutuskan
    };

    const onKey = (e) => { if (e.key === "Enter") onJoin(); };

    joinBtn?.addEventListener("click", onJoin);
    cancelBtn?.addEventListener("click", onCancel);
    input?.addEventListener("keypress", onKey);

    function cleanup() {
      joinBtn?.removeEventListener("click", onJoin);
      cancelBtn?.removeEventListener("click", onCancel);
      input?.removeEventListener("keypress", onKey);
    }
  });
}

// ==================== CALL TIMER ====================
async function fetchOrCreateCallStartTime() {
  const roomDocRef = doc(db, "rooms", ROOM_ID);
  let docSnap = await getDoc(roomDocRef);
  let start = docSnap.data()?.callStartTime;
  if (!start) {
    const now = Date.now();
    await setDoc(roomDocRef, { callStartTime: now }, { merge: true });
    docSnap = await getDoc(roomDocRef);
    start = docSnap.data()?.callStartTime || now;
  }
  return start;
}

function startCallTimer(startTimeMs) {
  if (callTimerInterval) return;
  callStartTime = startTimeMs ?? Date.now();
  oneMinuteWarningShown = false;
  const timerEl = document.getElementById("callTimer");
  if (timerEl) timerEl.style.display = "block";
  updateCallTimer();
  callTimerInterval = setInterval(updateCallTimer, 1000);
}

function updateCallTimer() {
  if (!callStartTime) return;
  const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
  const remaining = MAX_CALL_DURATION_SEC - elapsed;
  const minutes = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const seconds = String(elapsed % 60).padStart(2, "0");
  const timerEl = document.getElementById("callTimer");
  if (timerEl) timerEl.textContent = `${minutes}:${seconds}`;
  if (remaining <= 60 && remaining > 0 && !oneMinuteWarningShown) {
    oneMinuteWarningShown = true;
    alertModal("Panggilan akan berakhir dalam 1 menit.", "Peringatan");
  }
  if (remaining <= 0) {
    hangUp();
  }
}

function stopCallTimer() {
  if (callTimerInterval) {
    clearInterval(callTimerInterval);
    callTimerInterval = null;
  }
  callStartTime = null;
  oneMinuteWarningShown = false;
  const timerEl = document.getElementById("callTimer");
  if (timerEl) {
    timerEl.style.display = "none";
    timerEl.textContent = "00:00";
  }
  setDoc(doc(db, "rooms", ROOM_ID), { callStartTime: deleteField() }, { merge: true }).catch(() => {});
}

// ==================== MONITOR STATUS (untuk label kecil di halaman) ====================
function monitorConnectionStatus() {
  const callerCandidatesRef = collection(db, "rooms", ROOM_ID, "callerCandidates");
  const calleeCandidatesRef = collection(db, "rooms", ROOM_ID, "calleeCandidates");

  onSnapshot(callerCandidatesRef, (snapshot) => {
    const el = document.querySelector("#currentRoom");
    if (isCaller) {
      if (!snapshot.empty) {
        if (el) el.textContent = "Online";
      }
    } else {
      if (!snapshot.empty) {
        if (el) el.textContent = "Terkoneksi";
        if (!wasCallerConnected) {
          fetchOrCreateCallStartTime().then(startCallTimer);
          wasCallerConnected = true;
        }
      } else if (snapshot.empty && wasCallerConnected) {
        stopCallTimer();
        wasCallerConnected = false;
      }
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
              if (label) {
                label.textContent = `Customer: ${formatName(name)}`;
                label.style.display = "block";
              }
            }
          }
        });

        wasCalleeConnected = true;
        fetchOrCreateCallStartTime().then(startCallTimer);
      } else if (snapshot.empty && wasCalleeConnected) {
        showCalleeDisconnected();
        wasCalleeConnected = false;
        const label = document.getElementById("calleeNameLabel");
        if (label) label.style.display = "none";
        stopCallTimer();
      }
    } else {
      if (!snapshot.empty) {
        if (el) el.textContent = "Terkoneksi";
      }
    }
  });
}

function formatName(n) {
  return (n || "").toString().trim();
}

// ==================== HANG UP ====================
async function hangUp() {
  stopCallTimer();
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
      await deleteRoomIfCaller();
      location.reload();
    } else {
      const roomSnap = await getDoc(doc(db, "rooms", ROOM_ID));
      await deleteCalleeCandidates();
      if (roomSnap.exists()) {
        location.href = PAGES.thanks;
        return;
      }
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

  deleteCalleeCandidates().finally(() => {
    location.href = PAGES.thanks;
  });
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
    position: "absolute",
    top: "10px",
    left: "50%",
    transform: "translateX(-50%)",
    background: "red",
    color: "white",
    padding: "10px 20px",
    borderRadius: "5px",
    zIndex: 9999,
    fontSize: "16px"
  });
  document.body.appendChild(message);
}

// =====================================================
// =============== SLIDE PANEL (MERGED) ================
// =====================================================

// DOM refs
const slidePanel    = document.getElementById('slidePanel');
const slideHandle   = document.getElementById('slideHandle');
const handleIcon    = document.getElementById('handleIcon');
const panelBackdrop = document.getElementById('panelBackdrop');
const closePanelBtn = document.getElementById('closePanelBtn');

const statusText    = document.getElementById('statusText');
const lastChecked   = document.getElementById('lastCheckedText');
const spinnerDots   = document.getElementById('spinnerDots');
const closeRoomBtn  = document.getElementById('closeRoomBtn');

function openPanel(){
  if (!slidePanel) return;
  slidePanel.classList.add('open');
  slidePanel.setAttribute('aria-hidden', 'false');
  panelBackdrop?.classList.add('show');
  if (handleIcon) handleIcon.textContent = 'chevron_right';
}
function closePanel(){
  if (!slidePanel) return;
  slidePanel.classList.remove('open');
  slidePanel.setAttribute('aria-hidden', 'true');
  panelBackdrop?.classList.remove('show');
  if (handleIcon) handleIcon.textContent = 'chevron_left';
}
function togglePanel(){ slidePanel?.classList.contains('open') ? closePanel() : openPanel(); }

slideHandle?.addEventListener('click', togglePanel);
closePanelBtn?.addEventListener('click', closePanel);
panelBackdrop?.addEventListener('click', closePanel);

// Gesture: swipe from right edge to open
let touchStartX = null, touching = false;
const EDGE = 24; // px dari sisi kanan utk trigger
window.addEventListener('touchstart', (e)=>{
  if (!slidePanel || slidePanel.classList.contains('open')) return;
  const t = e.touches[0];
  if (window.innerWidth - t.clientX <= EDGE){
    touchStartX = t.clientX; touching = true;
  }
}, {passive:true});
window.addEventListener('touchmove', (e)=>{
  if ((touchStartX===null) || !touching) return;
  const t = e.touches[0];
  if ((touchStartX - t.clientX) > 20){
    touching = false; openPanel();
  }
}, {passive:true});
window.addEventListener('touchend', ()=>{ touching=false; touchStartX=null; });

// === Status cek untuk panel ===
async function checkRoomStatus(){
  if (!statusText || !lastChecked) return; // panel belum dipasang
  try{
    const callerRef = collection(db, 'rooms', ROOM_ID, 'callerCandidates');
    const calleeRef = collection(db, 'rooms', ROOM_ID, 'calleeCandidates');

    const [callerSnap, calleeSnap] = await Promise.all([
      getDocs(callerRef), getDocs(calleeRef)
    ]);

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
function startStatusLoop(){
  if (!statusText) return; // panel belum ada
  checkRoomStatus();
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(checkRoomStatus, 3000);
}

// === Tombol "Tutup Koneksi" di panel ===
async function deleteRoomData(){
  if (spinnerDots) spinnerDots.style.display = 'flex';
  if (statusText)  statusText.textContent = "Menghapus data…";
  if (closeRoomBtn) closeRoomBtn.disabled = true;
  try{
    await deleteRoomIfCaller();
    if (statusText) statusText.textContent = "✅ Room berhasil dihapus!";
  }catch(err){
    if (statusText) statusText.textContent = "❌ Gagal menghapus room: " + err.message;
  }finally{
    if (spinnerDots) spinnerDots.style.display = 'none';
    if (closeRoomBtn) closeRoomBtn.disabled = false;
  }
}
closeRoomBtn?.addEventListener('click', deleteRoomData);