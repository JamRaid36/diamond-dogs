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
    ch.name = "Diamond Dogs Season 1"; ch.start = d(-2); ch.end = d(4); ch.createdAt = now;
    ch.goals = {
      g1: { text: "Protein 130g", addedOn: d(-2), closedOn: null, order: 1, perWeek: null },
      g2: { text: "Under 2,000 calories", addedOn: d(-2), closedOn: null, order: 2, perWeek: 5 },
      g3: { text: "Cardio or a walk", addedOn: d(-2), closedOn: null, order: 3, perWeek: 5 },
      g4: { text: "Resistance Training", addedOn: d(-2), closedOn: null, order: 4, perWeek: 2 },
    };
  }
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
    if (!["upcoming", "catchup", "today", "lostgoals", "showcase"].includes(scenario)) {
      pattern[uid].forEach((row, i) => {
        const day = d(-5 + i);
        days[day] = {};
        row.forEach((v, j) => { days[day]["g" + (j + 1)] = v === 1; });
      });
    }
    store.players[uid] = { name: names[uid], joinedAt: joined, targets: targets[uid], days };
  }
  if (scenario === "active" || scenario === "showcase" || scenario === "member") {
    const t0 = now - 3 * 3600000;
    const lines = scenario === "showcase"
      ? [["sam", "Perfect day again. Somebody keep up."], ["riley", "I was lifting while you were typing that"], ["me", "Bold talk from the guy with a blank Tuesday"]]
      : [["sam", "Six perfect days. Just saying."], ["riley", "Tomorrow. Watch."], ["me", "Talk is cheap, ticks aren't"]];
    lines.forEach(([uid, text], i) => { store.chat["s" + i] = { uid, text, at: t0 + i * 1800000 }; });
  }
  if (!["upcoming", "catchup", "today", "lostgoals", "showcase"].includes(scenario)) {
    const chWithId = Object.assign({ id: "c1" }, ch);
    for (let i = -5; i <= -2; i++) store.results[d(i)] = L.buildResult(store.players, chWithId, d(i), now);
  }
  return store;
}

export function createDemoBackend(scenario = "active", opts = {}) {
  const now = opts.now || (window.DD_NOW ? window.DD_NOW() : Date.now());
  const store = seed(scenario, now);
  const listeners = { chat: new Set(), players: new Set(), challenges: new Set(), results: new Set(), members: new Set() };
  const authListeners = new Set();
  let user = scenario === "signedout" ? null : { uid: scenario === "notmember" ? "stranger" : "me", email: scenario === "notmember" ? "stranger@example.com" : "you@example.com" };
  if (scenario === "member") user = { uid: "sam", email: "sam@example.com" }; // a player who isn't the owner
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
    async mergePlayer(uid, patch) { await wait(); if (uid !== user?.uid && store.members.ownerEmail !== user?.email) throw new Error("not yours"); store.players[uid] = deepMerge(store.players[uid] || {}, patch); emit("players"); },
    async mergeChallenge(id, patch) { patch = L.pruneEmpty(patch); await wait(); store.challenges[id] = deepMerge(store.challenges[id] || {}, patch); emit("challenges"); },
    async createChallenge(data) { await wait(); const id = "c" + Date.now().toString(36); store.challenges[id] = data; emit("challenges"); return id; },
    async createResult(date, data) { await wait(); if (store.results[date]) return false; store.results[date] = data; emit("results"); return true; },
    async postMessage(data) { await wait(); if (data.uid !== user?.uid) throw new Error("not yours"); store.chat["m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)] = data; emit("chat"); },
    async deleteMessage(id) { await wait(); const m = store.chat[id]; if (m && m.uid !== user?.uid && store.members.ownerEmail !== user?.email) throw new Error("not yours"); delete store.chat[id]; emit("chat"); },
    async setMembers(emails) { await wait(); store.members = Object.assign({}, store.members, { emails }); emit("members"); },
    _store: store,
  };
}
