// Firebase backend: Google sign-in + Firestore. Same surface as backend-demo.js.
// Access is enforced by the Firestore rules (kept in Firebase, not in this repo); this file only asks.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, collection, getDoc, setDoc, addDoc,
  onSnapshot, query, orderBy, limit, deleteDoc, updateDoc, FieldPath,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export function createFirebaseBackend(config) {
  const app = initializeApp(config);
  const auth = getAuth(app);
  let db;
  try {
    db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  } catch {
    db = initializeFirestore(app, {}); // private mode or no IndexedDB: memory cache only
  }
  const membersRef = doc(db, "config", "members");
  const lower = (e) => String(e || "").trim().toLowerCase();
  const asUser = (u) => (u ? { uid: u.uid, email: lower(u.email) } : null);

  return {
    mode: "firebase",
    async init() {
      try { await getRedirectResult(auth); } catch { /* a failed redirect just leaves the person signed out */ }
    },
    onAuth(cb) { return onAuthStateChanged(auth, (u) => cb(asUser(u))); },
    async signIn() {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      try {
        await signInWithPopup(auth, provider);
      } catch (e) {
        if (e && (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment")) {
          await signInWithRedirect(auth, provider);
        } else if (e && e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") {
          throw e;
        }
      }
    },
    async signOut() { await signOut(auth); },
    // member: on the group list. owner: may edit the list. setupNeeded: the owner signed in before the list exists.
    async membership(u) {
      if (!u) return { member: false, owner: false, setupNeeded: false };
      try {
        const snap = await getDoc(membersRef);
        if (!snap.exists()) return { member: true, owner: true, setupNeeded: true }; // only the owner can read a missing doc
        const m = snap.data();
        return { member: (m.emails || []).includes(u.email), owner: lower(m.ownerEmail) === u.email, setupNeeded: false };
      } catch (e) {
        if (e && e.code === "permission-denied") return { member: false, owner: false, setupNeeded: false };
        throw e;
      }
    },
    async setupGroup(u) { await setDoc(membersRef, { ownerEmail: u.email, emails: [u.email] }); },
    watch(coll, cb, onError) {
      if (coll === "members") {
        return onSnapshot(membersRef, (s) => cb(s.exists() ? s.data() : { emails: [] }), onError);
      }
      // chat is the only collection that grows without bound: keep the newest 150
      const src = coll === "chat" ? query(collection(db, "chat"), orderBy("at", "desc"), limit(150)) : collection(db, coll);
      return onSnapshot(src, (qs) => {
        const out = {};
        qs.forEach((d) => { out[d.id] = d.data(); });
        cb(out);
      }, onError);
    },
    // Player writes are left as-is: joining must create days:{} (the rules require the map), and ticks are never empty.
    async mergePlayer(uid, patch) { await setDoc(doc(db, "players", uid), patch, { merge: true }); },
    // pruneEmpty: a merge write with an empty map replaces the field; never send one to a challenge.
    async mergeChallenge(id, patch) { await setDoc(doc(db, "challenges", id), window.DDLogic.pruneEmpty(patch), { merge: true }); },
    // Replace one player's own-goals map outright (a merge can't drop a key): removing a goal before the start.
    async setOwnGoals(id, uid, goals) { await updateDoc(doc(db, "challenges", id), new FieldPath("playerGoals", uid), goals); },
    // Owner only (the rules refuse anyone else).
    async deleteChallenge(id) { await deleteDoc(doc(db, "challenges", id)); },
    // Owner only (rules): snapshots.
    async createBackup(id, data) { await setDoc(doc(db, "backups", id), data); },
    async deleteBackup(id) { await deleteDoc(doc(db, "backups", id)); },
    async deletePlayer(uid) { await deleteDoc(doc(db, "players", uid)); },
    // Owner only: re-post a day in one write (the rules allow the owner, same date, same challenge).
    async replaceResult(date, data) { await setDoc(doc(db, "results", date), data); },
    async createChallenge(data) { const ref = await addDoc(collection(db, "challenges"), data); return ref.id; },
    // Create-only: the rules refuse an update, so a second opener's write fails and is ignored.
    async createResult(date, data) {
      try { await setDoc(doc(db, "results", date), data); return true; } catch { return false; }
    },
    async postMessage(data) { await addDoc(collection(db, "chat"), data); },
    async deleteMessage(id) { await deleteDoc(doc(db, "chat", id)); },
    async setMembers(emails) { await setDoc(membersRef, { emails: emails.map(lower) }, { merge: true }); },
  };
}
