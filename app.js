// ==================== FIREBASE SETUP ====================
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-app.js";
import {
  getFirestore, doc, setDoc, getDoc, deleteDoc,
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
const ROOM_ID = (window.ROOM_ID || "cs-room"); // bisa di-overwrite dari HTML bila perlu

// ==================== INIT ====================
// [PERBAIKAN] Jangan alert saat user masih null. Tunggu sampai login berhasil.
window.onload = async () => {
  try {
    await ensureAnonLogin();
    const user = await waitForUser();
    console.log("✅ Anon login:", user.uid);
    initAfterAuth();
    // Mulai loop status panel begitu auth siap
    startStatusLoop();
    // Opsional: buka panel otomatis sekali saat halaman load
    setTimeout(()=>{ openPanel(); }, 600);
  } catch (e) {
    console.error("❌ Gagal login anonim:", e);
    alert("Tidak bisa login ke server. Silakan refresh atau coba browser lain.");
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
      // Untuk caller, biarkan manual via hangup/close action
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
      alert("Customer Service belum memulai panggilan. Silakan coba lagi nanti.");
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
          alert("Nama wajib diisi untuk bergabung ke panggilan.");
          return;
        }
        sessionStorage.setItem("calleeName", name);
        startCall(name).catch(err => {
          console.error("Gagal auto-join:", err);
          alert("Gagal auto-join. Silakan coba lagi.");
        });
      }
    } else {
      // Sudah ada answer / state lain → sibuk
      alert("Maaf, kami sedang melayani pelanggan lain saat ini.");
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
        alert("Izin kamera ditolak. Aktifkan kamera di pengaturan browser.");
        return;
      }
    } catch { /* Permissions API tidak selalu ada */ }

    // Ambil media
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    remoteStream = new MediaStream();

    document.querySelector("#localVideo").srcObject = localStream;
    document.querySelector("#remoteVideo").srcObject = remoteStream;

    // Siapkan ICE servers
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

    // Buat PeerConnection
    peerConnection = new RTCPeerConnection(servers);
    localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));
    peerConnection.ontrack = e => e.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));

    roomRef = doc(db, "rooms", ROOM_ID);
    const roomSnap = await getDoc(roomRef);

    monitorConnectionStatus();

    if (!roomSnap.exists()) {
      // ===== CALLER flow =====
      isCaller = true;

      peerConnection.onicecandidate = e => {
        if (e.candidate) addDoc(collection(db, "rooms", ROOM_ID, "callerCandidates"), e.candidate.toJSON());
      };

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      await setDoc(roomRef, { offer: { type: offer.type, sdp: offer.sdp } });

      onSnapshot(roomRef, snapshot => {
        const data = snapshot.data();
        if (!peerConnection.currentRemoteDescription && data?.answer) {
          peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        }
        // Tampilkan nama callee bila tersedia
        if (data?.calleeName) {
          const label = document.getElementById("calleeNameLabel");
          if (label && label.textContent !== data.calleeName) {
            label.textContent = `CUSTOMER: ${data.calleeName.toUpperCase()}`;
            label.style.display = "block";
          }
        }
      });

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

      // Jika room sudah punya nama callee sebelumnya (edge case)
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

        peerConnection.onicecandidate = e => {
          if (e.candidate) addDoc(collection(db, "rooms", ROOM_ID, "calleeCandidates"), e.candidate.toJSON());
        };

        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        await setDoc(roomRef, {
          answer: { type: answer.type, sdp: answer.sdp },
          calleeName: namaCallee
        }, { merge: true });

        // Dengarkan kandidat caller
        const callerCandidatesRef = collection(db, "rooms", ROOM_ID, "callerCandidates");
        onSnapshot(callerCandidatesRef, snap => {
          snap.docChanges().forEach(async change => {
            if (change.type === "added") {
              await peerConnection.addIceCandidate(new RTCIceCandidate(change.doc.data()));
            }
          });
        });

        // Room dihapus oleh caller?
        onSnapshot(roomRef, docSnap => {
          if (!docSnap.exists()) {
            console.warn("Room dihapus oleh caller, callee keluar...");
            cleanupAndRedirectCallee();
          }
        });

      } else {
        alert("Terima kasih. Silakan hubungi Customer Service bila dibutuhkan kembali.");
        location.href = PAGES.thanks;
      }
    }

  } catch (err) {
    console.error("❌ startCall error:", err);
    alert("Gagal connect: " + err.message);
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

    if (!modal) { resolve(prompt("Masukkan nama Anda:") || ""); return; }

    modal.style.display = "flex";
    if (input) { input.value = ""; input.focus(); }

    const onJoin = () => {
      const name = (input?.value || "").trim();
      if (name) {
        modal.style.display = "none";
        cleanup();
        resolve(name);
      } else {
        alert("Nama tidak boleh kosong.");
        input?.focus();
      }
    };

    const onCancel = () => {
      modal.style.display = "none";
      cleanup();
      location.href = PAGES.thanks;
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

// ==================== MONITOR STATUS (untuk label kecil di halaman) ====================
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
              if (label) {
                label.textContent = `Customer: ${formatName(name)}`;
                label.style.display = "block";
              }
            }
          }
        });

        wasCalleeConnected = true;
      } else if (snapshot.empty && wasCalleeConnected) {
        showCalleeDisconnected();
        wasCalleeConnected = false;
        const label = document.getElementById("calleeNameLabel");
        if (label) label.style.display = "none";
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
  try {
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
    const callerCandidatesRef = collection(db, "rooms", ROOM_ID, "callerCandidates");
    const calleeCandidatesRef = collection(db, "rooms", ROOM_ID, "calleeCandidates");

    const callerDocs = await getDocs(callerCandidatesRef);
    const calleeDocs = await getDocs(calleeCandidatesRef);
    const allDocs = [...callerDocs.docs, ...calleeDocs.docs];

    await Promise.all(allDocs.map(d => deleteDoc(d.ref)));
    await deleteDoc(roomRef);

    console.log("🔥 Room & subkoleksi berhasil dihapus");
  } catch (err) {
    console.warn("⚠️ Gagal hapus room:", err.message);
  }
}

async function deleteCalleeCandidates() {
  try {
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

// DOM refs (aman jika elemen belum ada; cek null)
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
  if (!touching) return;
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
    // Reuse logic caller, tapi boleh dipakai siapa pun di admin page
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
