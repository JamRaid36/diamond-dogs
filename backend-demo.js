// In-memory backend with the same surface as backend-firebase.js. Used by ?demo=<scenario> (sample data,
// clearly labelled in the page) and by the Playwright suite. Nothing here leaves the browser tab.
const L = window.DDLogic;

function deepMerge(target, patch) {
  const out = Array.isArray(target) ? target.slice() : Object.assign({}, target);
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" ? deepMerge(out[k], v) : v;
  }
  return out;
}

function seed(scenario, now) {
  const today = L.pacificDate(now);
  const d = (n) => L.addDays(today, n);
  const start = d(-5);
  const store = { players: {}, challenges: {}, results: {}, members: { ownerEmail: "you@example.com", emails: ["you@example.com", "sam@example.com", "riley@example.com"] } };
  if (scenario === "empty") return store;
  const ch = {
    name: "Fall Cut", start: scenario === "upcoming" ? d(2) : start, end: scenario === "upcoming" ? d(23) : d(15),
    createdBy: "me", createdAt: now,
    goals: {
      g1: { text: "Hit protein", addedOn: scenario === "upcoming" ? d(2) : start, closedOn: null, order: 1 },
      g2: { text: "Train or walk", addedOn: scenario === "upcoming" ? d(2) : start, closedOn: null, order: 2, perWeek: 5 },
      g3: { text: "No sugar", addedOn: scenario === "upcoming" ? d(2) : start, closedOn: null, order: 3 },
      g4: { text: "Lights out by 11", addedOn: scenario === "upcoming" ? d(2) : d(-2), closedOn: null, order: 4 },
    },
  };
  store.challenges.c1 = ch;
  const joined = now - 6 * 86400000;
  const pattern = {
    me: [[1, 1, 1], [1, 1, 0], [1, 1, 1], [1, 1, 1, 1], [1, 0, 1, 1], [1, 1, 0, 0]],
    sam: [[1, 1, 1], [1, 1, 1], [1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1]],
    riley: [[1, 0, 1], [0, 1, 1], [1, 1, 0], [1, 0, 1, 0], [0, 1, 1, 1], [1, 0, 0, 0]],
  };
  const names = { me: "Alex", sam: "Sam", riley: "Riley" };
  const targets = { me: { g1: "200 g", g2: "45 min" }, sam: { g1: "180 g", g2: "Lift 3x" }, riley: { g1: "150 g" } };
  for (const uid of Object.keys(pattern)) {
    const days = {};
    if (scenario !== "upcoming") {
      pattern[uid].forEach((row, i) => {
        const day = d(-5 + i);
        days[day] = {};
        row.forEach((v, j) => { days[day]["g" + (j + 1)] = v === 1; });
      });
    }
    store.players[uid] = { name: names[uid], joinedAt: joined, targets: targets[uid], days };
  }
  if (scenario !== "upcoming") {
    const chWithId = Object.assign({ id: "c1" }, ch);
    for (let i = -5; i <= -2; i++) store.results[d(i)] = L.buildResult(store.players, chWithId, d(i), now);
  }
  return store;
}

export function createDemoBackend(scenario = "active", opts = {}) {
  const now = opts.now || (window.DD_NOW ? window.DD_NOW() : Date.now());
  const store = seed(scenario, now);
  const listeners = { players: new Set(), challenges: new Set(), results: new Set(), members: new Set() };
  const authListeners = new Set();
  let user = scenario === "signedout" ? null : { uid: scenario === "notmember" ? "stranger" : "me", email: scenario === "notmember" ? "stranger@example.com" : "you@example.com" };
  if (scenario === "newplayer") { user = { uid: "newbie", email: "sam@example.com" }; store.members.emails.push("sam@example.com"); }
  const emit = (coll) => listeners[coll].forEach((cb) => cb(coll === "members" ? store.members : Object.assign({}, store[coll])));
  const wait = () => new Promise((r) => setTimeout(r, opts.latency ?? 120));

  return {
    mode: "demo",
    scenario,
    async init() { await wait(); },
    onAuth(cb) { authListeners.add(cb); setTimeout(() => cb(user), 0); return () => authListeners.delete(cb); },
    async signIn() { await wait(); user = { uid: "me", email: "you@example.com" }; authListeners.forEach((cb) => cb(user)); },
    async signOut() { user = null; authListeners.forEach((cb) => cb(null)); },
    async membership(u) {
      await wait();
      if (!u) return { member: false, owner: false, setupNeeded: false };
      const m = store.members;
      return { member: m.emails.includes(u.email), owner: m.ownerEmail === u.email, setupNeeded: false };
    },
    async setupGroup() {},
    watch(coll, cb) { listeners[coll].add(cb); setTimeout(() => cb(coll === "members" ? store.members : Object.assign({}, store[coll])), opts.latency ?? 120); return () => listeners[coll].delete(cb); },
    async mergePlayer(uid, patch) { await wait(); if (uid !== user?.uid) throw new Error("not yours"); store.players[uid] = deepMerge(store.players[uid] || {}, patch); emit("players"); },
    async mergeChallenge(id, patch) { await wait(); store.challenges[id] = deepMerge(store.challenges[id] || {}, patch); emit("challenges"); },
    async createChallenge(data) { await wait(); const id = "c" + Date.now().toString(36); store.challenges[id] = data; emit("challenges"); return id; },
    async createResult(date, data) { await wait(); if (store.results[date]) return false; store.results[date] = data; emit("results"); return true; },
    async setMembers(emails) { await wait(); store.members = Object.assign({}, store.members, { emails }); emit("members"); },
    _store: store,
  };
}
