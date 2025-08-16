// ==================== FIREBASE SETUP ====================
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-app.js";
import {
  getFirestore, doc, setDoc, getDoc, deleteDoc,
  collection, addDoc, onSnapshot, getDocs
} from "https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyAjqMqmKUDPWHkv19Dig7PnUpHMzNf9J1A",
  authDomain: "onlinecsbwx.firebaseapp.com",
  projectId: "onlinecsbwx",
  storageBucket: "onlinecsbwx.appspot.com",
  messagingSenderId: "317019843909",
  appId: "1:317019843909:web:2d5b2b2c9dd118e0ce622c"
};

const app = initializeApp(firebaseConfig);
const db  = getFirestore(app);
const auth = getAuth(app);

// Login anonim segera (agar rules Firestore bisa pakai request.auth != null)
signInAnonymously(auth).catch(err => console.error("Anon login gagal:", err));

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

// ==================== INIT ====================
window.onload = () => {
  // Pastikan proses setelah Auth siap
  onAuthStateChanged(auth, (user) => {
    if (!user) {
      console.error("❌ Gagal mendapatkan sesi anon.");
      alert("Tidak bisa login ke server. Silakan refresh.");
      return;
    }
    console.log("✅ Anon login:", user.uid);
    initAfterAuth();
  });
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
      // Untuk caller, biarkan manual via hangup/close.html
    } catch {}
  });

  const roomSnap = await getDoc(doc(db, "rooms", "cs-room"));

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
    } catch {
      // Permissions API tidak selalu ada
    }

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

    roomRef = doc(db, "rooms", "cs-room");
    const roomSnap = await getDoc(roomRef);

    monitorConnectionStatus();

    if (!roomSnap.exists()) {
      // ===== CALLER flow =====
      isCaller = true;

      peerConnection.onicecandidate = e => {
        if (e.candidate) addDoc(collection(db, "rooms", "cs-room", "callerCandidates"), e.candidate.toJSON());
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

      const calleeCandidatesRef = collection(db, "rooms", "cs-room", "calleeCandidates");
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
          if (e.candidate) addDoc(collection(db, "rooms", "cs-room", "calleeCandidates"), e.candidate.toJSON());
        };

        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        await setDoc(roomRef, {
          answer: { type: answer.type, sdp: answer.sdp },
          calleeName: namaCallee
        }, { merge: true });

        // Dengarkan kandidat caller
        const callerCandidatesRef = collection(db, "rooms", "cs-room", "callerCandidates");
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

// ==================== MONITOR STATUS ====================
function monitorConnectionStatus() {
  const callerCandidatesRef = collection(db, "rooms", "cs-room", "callerCandidates");
  const calleeCandidatesRef = collection(db, "rooms", "cs-room", "calleeCandidates");

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

        getDoc(doc(db, "rooms", "cs-room")).then((docSnap) => {
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
      const roomSnap = await getDoc(doc(db, "rooms", "cs-room"));
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
  if (!roomRef) return;
  try {
    const callerCandidatesRef = collection(db, "rooms", "cs-room", "callerCandidates");
    const calleeCandidatesRef = collection(db, "rooms", "cs-room", "calleeCandidates");

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
    const calleeCandidatesRef = collection(db, "rooms", "cs-room", "calleeCandidates");
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
