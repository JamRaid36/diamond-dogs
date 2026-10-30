// In-memory backend with the same surface as backend-firebase.js. Used by ?demo=<scenario> (sample data,
// clearly labelled in the page) and by the Playwright suite. Nothing here leaves the browser tab.
const L = window.DDLogic;

function deepMerge(target, patch) {
  const out = Array.isArray(target) ? target.slice() : Object.assign({}, target);
  for (const [k, v] of Object.entries(patch)) {
    // Firestore semantics: a non-empty map merges; an empty map replaces the field (that's how goals got wiped once)
    out[k] = v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length && out[k] && typeof out[k] === "object" ? deepMerge(out[k], v) : v;
  }
  return out;
}

function seed(scenario, now) {
  const today = L.pacificDate(now);
  const d = (n) => L.addDays(today, n);
  const start = d(-5);
  const store = { chat: {}, players: {}, challenges: {}, results: {}, members: { ownerEmail: "you@example.com", emails: ["you@example.com", "sam@example.com", "riley@example.com"] } };
  if (scenario === "empty") return store;
  const ch = {
    name: "Fall Cut", start: scenario === "upcoming" ? d(2) : start, end: scenario === "upcoming" ? d(23) : d(15),
    createdBy: "me", createdAt: now - 6 * 86400000, // created on its start day: no catch-up window in the demo
    goals: {
      g1: { text: "Hit protein", addedOn: scenario === "upcoming" ? d(2) : start, closedOn: null, order: 1 },
      g2: { text: "Train or walk", addedOn: scenario === "upcoming" ? d(2) : start, closedOn: null, order: 2, perWeek: 5 },
      g3: { text: "No sugar", addedOn: scenario === "upcoming" ? d(2) : start, closedOn: null, order: 3 },
      g4: { text: "Lights out by 11", addedOn: scenario === "upcoming" ? d(2) : d(-2), closedOn: null, order: 4 },
    },
  };
  if (scenario === "showcase") { // marketing screenshots: Jason's real season-1 goals, sample ticks
    ch.name = "Alpha Pack Season 1"; ch.start = d(-2); ch.end = d(4); ch.createdAt = now;
    ch.pot = { buyIn: 50, strikes: 3, paid: { me: true, sam: true } };
    ch.goals = {
      g1: { text: "Protein 130g", addedOn: d(-2), closedOn: null, order: 1, perWeek: null },
      g2: { text: "Under 2,000 calories", addedOn: d(-2), closedOn: null, order: 2, perWeek: 5 },
      g3: { text: "Cardio or a walk", addedOn: d(-2), closedOn: null, order: 3, perWeek: 5 },
      g4: { text: "Resistance Training", addedOn: d(-2), closedOn: null, order: 4, perWeek: 2 },
    };
  }
  if (scenario === "pot") ch.pot = { buyIn: 50, strikes: 2, paid: {} }; // riley has missed days: out at 2
  if (scenario === "pardon") ch.pot = { buyIn: 100, strikes: 3, comeback: 50, paid: { me: true } }; // riley asks a pardon, sam voted yes
  if (scenario === "treasurer" || scenario === "treasurerm") ch.pot = { buyIn: 100, strikes: 3, treasurer: "sam", payHow: "Venmo https://venmo.com/u/sam-t", paid: { sam: true } }; // sam holds the money; you own the app
  if (scenario === "goalcheck" || scenario === "goalcheckm" || scenario === "invited" || scenario === "season1") { // upcoming, everyone sets their own: sam has 3, riley 1, you none
    ch.start = d(2); ch.end = d(23); ch.goals = {}; ch.minGoals = 3;
    const g = (t, i, pw) => ({ text: t, addedOn: d(2), closedOn: null, order: i, perWeek: pw || null });
    ch.playerGoals = { sam: { s1: g("Protein 180 g", 1), s2: g("Read a chapter", 2), s3: g("Lift", 3, 3) }, riley: { r1: g("Drink water", 1) } };
    ch.pot = { buyIn: 100, strikes: 3, comeback: 50, treasurer: "me", paid: { me: true } }; // you hold the money; sam hasn't paid
  }
  if (scenario === "invited" || scenario === "season1") { // Jason's real season 1 setup, for testers (Tabitha): next Saturday, 3 weeks, his goals and pot
    const sat = d((6 - new Date(now).getDay() + 7) % 7 || 7);
    ch.name = "Alpha Pack Season 1"; ch.start = sat; ch.end = L.addDays(sat, 20); ch.minGoals = 3;
    ch.houseRules = "Cheat Meals require a photo in trash talk";
    const g = (t, i, pw) => ({ text: t, addedOn: sat, closedOn: null, order: i, perWeek: pw || null });
    ch.playerGoals = {
      me: { j1: g("Protein 130 g", 1), j2: g("Lift", 2, 2), j3: g("Calories 2k or less", 3, 5), j4: g("Cardio/Walking", 4, 5) },
      sam: { s1: g("Read a chapter", 1), s2: g("Pray 15 min", 2), s3: g("Lift", 3, 3), s4: g("Call Mom", 4, 1) },
      riley: { r1: g("No phone after 10", 1), r2: g("Practice guitar 20 min", 2, 5), r3: g("In bed by 11", 3, 5) },
    };
    ch.pot = { buyIn: 100, strikes: 2, comeback: 50, treasurer: "me", payHow: "Venmo (test version: don't pay!)", paid: { me: true } };
  }
  if (scenario === "over") { ch.end = d(-2); ch.pot = { buyIn: 100, strikes: 3, comeback: 50, paid: {} }; } // final, not settled
  if (scenario === "lostgoals") { ch.start = d(-2); ch.createdAt = now; ch.goals = {}; }
  if (scenario === "today") { ch.start = today; ch.createdAt = now; Object.values(ch.goals).forEach((g) => { g.addedOn = today; }); }
  if (scenario === "catchup") { ch.start = d(-2); ch.createdAt = now; Object.values(ch.goals).forEach((g) => { g.addedOn = d(-2); }); }
  store.challenges.c1 = ch;
  const joined = now - 6 * 86400000;
  const pattern = {
    me: [[1, 1, 1], [1, 1, 0], [1, 1, 1], [1, 1, 1, 1], [1, 0, 1, 1], [1, 1, 0, 0]],
    sam: [[1, 1, 1], [1, 1, 1], [1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1]],
    riley: [[1, 0, 1], [0, 1, 1], [1, 1, 0], [1, 0, 1, 0], [0, 1, 1, 1], [1, 0, 0, 0]],
  };
  const names = scenario === "showcase" ? { me: "Jay", sam: "Costa", riley: "Joseph" } : { me: "Alex", sam: "Sam", riley: "Riley" };
  const targets = scenario === "showcase" ? { me: { g1: "130 g" }, sam: {}, riley: {} } : { me: { g1: "200 g", g2: "45 min" }, sam: { g1: "180 g", g2: "Lift 3x" }, riley: { g1: "150 g" } };
  for (const uid of Object.keys(pattern)) {
    const days = {};
    if (scenario === "lostgoals" && uid === "me") days[today] = { g1: true, g3: true, g4: false };
    if (scenario === "showcase") {
      const sample = { me: [[1, 1, 1, 0], [1, 1, 1, 1], [1, 0, 1, 0]], sam: [[1, 1, 0, 1], [1, 1, 1, 0], [1, 1, 1, 1]], riley: [[1, 0, 1, 0], [0, 1, 1, 1], [1, 0, 0, 0]] };
      sample[uid].forEach((row, i) => { const dd = d(-2 + i); days[dd] = {}; row.forEach((v, j) => { days[dd]["g" + (j + 1)] = v === 1; }); });
    }
    if (!["upcoming", "catchup", "today", "lostgoals", "showcase", "goalcheck", "goalcheckm", "invited", "season1"].includes(scenario)) {
      pattern[uid].forEach((row, i) => {
        const day = d(-5 + i);
        days[day] = {};
        row.forEach((v, j) => { days[day]["g" + (j + 1)] = v === 1; });
      });
    }
    store.players[uid] = { name: names[uid], joinedAt: joined, targets: targets[uid], days };
  }
  if (scenario === "pardon") {
    const st = L.potStatus(store.players, Object.assign({ id: "c1" }, ch), now);
    const rs = st.rows.find((r) => r.uid === "riley").list[0];
    store.players.riley.appeals = { [rs.pardon.key]: now - 17 * 3600000 }; // asked 17 hours ago: 31 left on the clock
    store.players.sam.pvotes = { [rs.pardon.key]: { y: true, at: now - 16 * 3600000 } };
  }
  if (scenario === "active" || scenario === "showcase" || scenario === "member") {
    const t0 = now - 3 * 3600000;
    const lines = scenario === "showcase"
      ? [["sam", "Perfect day again. Somebody keep up."], ["riley", "I was lifting while you were typing that"], ["me", "Bold talk from the guy with a blank Tuesday"]]
      : [["sam", "Six perfect days. Just saying."], ["riley", "Tomorrow. Watch."], ["me", "Talk is cheap, ticks aren't"]];
    lines.forEach(([uid, text], i) => { store.chat["s" + i] = { uid, text, at: t0 + i * 1800000 }; });
  }
  if (!["upcoming", "catchup", "today", "lostgoals", "showcase", "goalcheck", "goalcheckm", "invited", "season1"].includes(scenario)) {
    const chWithId = Object.assign({ id: "c1" }, ch);
    for (let i = -5; i <= -2; i++) store.results[d(i)] = L.buildResult(store.players, chWithId, d(i), now);
  }
  return store;
}

export function createDemoBackend(scenario = "active", opts = {}) {
  const now = opts.now || (window.DD_NOW ? window.DD_NOW() : Date.now());
  const store = seed(scenario, now);
  store.backups = store.backups || {};
  const listeners = { chat: new Set(), players: new Set(), challenges: new Set(), results: new Set(), members: new Set(), backups: new Set() };
  const authListeners = new Set();
  let user = scenario === "signedout" ? null : { uid: scenario === "notmember" ? "stranger" : "me", email: scenario === "notmember" ? "stranger@example.com" : "you@example.com" };
  if (scenario === "member" || scenario === "goalcheckm" || scenario === "treasurerm") user = { uid: "sam", email: "sam@example.com" }; // a player who isn't the owner
  // From the invite: signed out, on the list, never joined. Signing in is fake (no Google) and lands as a new player.
  const invited = scenario === "invited";
  if (invited) { user = null; store.members.emails.push("you.invited@example.com"); store.players.me.name = "Jay"; }
  if (scenario === "season1") store.players.me.name = "Jay"; // the owner's own view of the same test season
  if (scenario === "newplayer") { user = { uid: "newbie", email: "sam@example.com" }; store.members.emails.push("sam@example.com"); }
  const emit = (coll) => listeners[coll].forEach((cb) => cb(coll === "members" ? store.members : Object.assign({}, store[coll])));
  const wait = () => new Promise((r) => setTimeout(r, opts.latency ?? 120));

  return {
    mode: "demo",
    scenario,
    async init() { await wait(); },
    onAuth(cb) { authListeners.add(cb); setTimeout(() => cb(user), 0); return () => authListeners.delete(cb); },
    async signIn() { await wait(); user = invited ? { uid: "invitee", email: "you.invited@example.com" } : { uid: "me", email: "you@example.com" }; authListeners.forEach((cb) => cb(user)); },
    async signOut() { user = null; authListeners.forEach((cb) => cb(null)); },
    async membership(u) {
      await wait();
      if (!u) return { member: false, owner: false, setupNeeded: false };
      const m = store.members;
      return { member: m.emails.includes(u.email), owner: m.ownerEmail === u.email, setupNeeded: false };
    },
    async setupGroup() {},
    watch(coll, cb) { listeners[coll].add(cb); setTimeout(() => cb(coll === "members" ? store.members : Object.assign({}, store[coll])), opts.latency ?? 120); return () => listeners[coll].delete(cb); },
    async mergePlayer(uid, patch) { await wait(); if (uid !== user?.uid && store.members.ownerEmail !== user?.email) throw new Error("not yours"); store.players[uid] = deepMerge(store.players[uid] || {}, patch); emit("players"); },
    async mergeChallenge(id, patch) { patch = L.pruneEmpty(patch); await wait(); store.challenges[id] = deepMerge(store.challenges[id] || {}, patch); emit("challenges"); },
    async setOwnGoals(id, uid, goals) { await wait(); const c = store.challenges[id]; store.challenges[id] = Object.assign({}, c, { playerGoals: Object.assign({}, c.playerGoals, { [uid]: goals }) }); emit("challenges"); },
    async createBackup(id, manifest, parts) {
      await wait(); if (store.members.ownerEmail !== user?.email) throw new Error("owner only");
      store.backupParts = store.backupParts || {};
      store.backupParts[id] = JSON.parse(JSON.stringify(parts.map((p) => ({ kind: p.kind, docId: p.docId, json: p.json }))));
      store.backups[id] = Object.assign({}, manifest, { parts: parts.length, failed: [] }); emit("backups"); return [];
    },
    async backupSource() { await wait(); return JSON.parse(JSON.stringify({ challenges: store.challenges, players: store.players, members: store.members })); },
    async readBackup(id) { await wait(); return JSON.parse(JSON.stringify((store.backupParts || {})[id] || [])); },
    async deleteBackup(id) { await wait(); delete store.backups[id]; if (store.backupParts) delete store.backupParts[id]; emit("backups"); },
    async deleteChallenge(id) { await wait(); if (store.members.ownerEmail !== user?.email) throw new Error("owner only"); delete store.challenges[id]; emit("challenges"); },
    async replaceResult(date, data) { await wait(); if (store.members.ownerEmail !== user?.email) throw new Error("owner only"); if (store.results[date] && store.results[date].challengeId !== data.challengeId) throw new Error("other challenge"); store.results[date] = data; emit("results"); },
    async deletePlayer(uid) { await wait(); if (store.members.ownerEmail !== user?.email) throw new Error("owner only"); delete store.players[uid]; emit("players"); },
    async createChallenge(data) { await wait(); const id = "c" + Date.now().toString(36); store.challenges[id] = data; emit("challenges"); return id; },
    async createResult(date, data) { await wait(); if (store.results[date]) return false; store.results[date] = data; emit("results"); return true; },
    async postMessage(data) { await wait(); if (data.uid !== user?.uid) throw new Error("not yours"); store.chat["m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)] = data; emit("chat"); },
    async deleteMessage(id) { await wait(); const m = store.chat[id]; if (m && m.uid !== user?.uid && store.members.ownerEmail !== user?.email) throw new Error("not yours"); delete store.chat[id]; emit("chat"); },
    async setMembers(emails) { await wait(); store.members = Object.assign({}, store.members, { emails }); emit("members"); },
    _store: store,
  };
}
