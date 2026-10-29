// Alpha Pack — page controller. Renders from shared state; every write goes through the backend.
// Backends: ?demo=<scenario> uses backend-demo.js (sample data, labelled); otherwise Firebase from config.js.
const L = window.DDLogic;
const $ = (s) => document.querySelector(s);
const app = $("#app");

const state = {
  backend: null, user: null, ms: null, players: null, challenges: null, results: null, members: null, chat: {}, chatDraft: "", confirmDel: null,
  viewDay: "today", expanded: new Set(), chId: (() => { try { return localStorage.getItem("ap.chId"); } catch { return null; } })(), lastDay: null, lastFinal: null, posted: false, unsubs: [],
};
const now = () => (window.DD_NOW ? window.DD_NOW() : Date.now());
const today = () => L.pacificDate(now());

// ---------- tiny DOM helpers (text always via textContent) ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v; // only ever used with static SVG strings below
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const SVG = {
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  flame: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2c1 3.5 5 5.5 5 10.5A5 5 0 0 1 7 12.5c0-2 1-3.4 2-4.5.2 1.7 1 2.8 2 3.2C11 8 11 5 12 2z"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  google: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.5 12.3c0-.8-.1-1.5-.2-2.2H12v4.2h5.9a5 5 0 0 1-2.2 3.3v2.7h3.5c2.1-1.9 3.3-4.7 3.3-8z"/><path fill="#34A853" d="M12 23c3 0 5.4-1 7.2-2.7l-3.5-2.7c-1 .7-2.2 1.1-3.7 1.1-2.9 0-5.3-1.9-6.2-4.5H2.2v2.8A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.8 14.2a6.6 6.6 0 0 1 0-4.3V7.1H2.2a11 11 0 0 0 0 9.9z"/><path fill="#EA4335" d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.1-3.1A11 11 0 0 0 2.2 7.1l3.6 2.8C6.7 7.3 9.1 5.4 12 5.4z"/></svg>',
};
const fmtDay = (d, opts = { weekday: "short", month: "short", day: "numeric" }) =>
  new Date(d + "T12:00:00Z").toLocaleDateString("en-US", Object.assign({ timeZone: "UTC" }, opts));

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

// ---------- derived ----------
function challengeList() {
  return Object.entries(state.challenges || {}).map(([id, c]) => Object.assign({ id }, c));
}
function defaultChallenge() { return L.currentChallenge(challengeList(), today()); }
// The challenge on screen: the one picked on the Challenges screen, else the running/next/last one.
function current() { return (state.chId && state.challenges?.[state.chId] && challengeList().find((c) => c.id === state.chId)) || defaultChallenge(); }
function pick(id) {
  state.chId = id && id !== defaultChallenge()?.id ? id : null;
  state.viewDay = null; state.expanded = new Set();
  try { state.chId ? localStorage.setItem("ap.chId", state.chId) : localStorage.removeItem("ap.chId"); } catch { /* private mode */ }
  render(); window.scrollTo({ top: 0 });
}
function me() { return state.players?.[state.user?.uid]; }
function viewDate() {
  const t = today();
  const y = L.addDays(t, -1);
  const ch = current();
  return state.viewDay && state.viewDay !== t && L.editableDates(ch, now()).includes(state.viewDay) ? state.viewDay : t;
}
function packOrder(ch, date) {
  const ids = Object.keys(state.players || {}).filter((uid) => L.joinedBy(state.players[uid], date) || uid === state.user.uid);
  return ids.sort((a, b) => {
    const sa = L.dayScore(state.players[a], ch, date), sb = L.dayScore(state.players[b], ch, date);
    return sb.pct - sa.pct || sb.hit - sa.hit || (state.players[a].name || "").localeCompare(state.players[b].name || "");
  });
}

// ---------- render ----------
function render() {
  const a = document.activeElement;
  const keep = a && a.id && app.contains(a) ? { id: a.id, start: a.selectionStart, end: a.selectionEnd } : null;
  renderInner();
  if (keep) {
    const el = document.getElementById(keep.id);
    if (el && el !== document.activeElement) { el.focus({ preventScroll: true }); try { el.setSelectionRange(keep.start, keep.end); } catch { /* not a text input */ } }
  }
}

function renderInner() {
  const s = state;
  $("#dayChip").hidden = true;
  $("#menuBtn").hidden = true;
  if (!s.backend) return renderNoConfig();
  if (s.user === null) return renderSignIn();
  if (!s.ms) return renderLoading();
  if (s.ms.setupNeeded) return renderSetupGroup();
  if (!s.ms.member) return renderNotMember();
  if (!s.players || !s.challenges || !s.results) return renderLoading();
  if (!me()) return renderJoin();
  document.body.classList.remove("gated");
  const ch = current();
  $("#menuBtn").hidden = false;
  if (!ch) return renderNoChallenge();
  const t = today();
  const chip = $("#dayChip");
  chip.hidden = false;
  if (t < ch.start) chip.textContent = `Starts ${fmtDay(ch.start, { month: "short", day: "numeric" })}`;
  else if (t > ch.end) chip.textContent = "Finished";
  else chip.textContent = `Day ${L.dayNumber(ch, t)} / ${L.challengeLength(ch)}`;
  app.replaceChildren(...[ // sections that have nothing to show return null; never hand null to the DOM
    demoBanner(),
    state.chId ? h("div", { class: "viewing", role: "note" }, h("span", {}, "Viewing ", h("b", {}, ch.name)),
      h("button", { class: "link-btn", type: "button", onclick: () => pick(null) }, "Back to current")) : null,
    h("img", { class: "brand-hero", src: "logo-hero.webp", alt: "Alpha Pack", width: "720", height: "582" }),
    t < ch.start ? renderUpcoming(ch) : t > ch.end ? renderFinished(ch) : renderYou(ch),
    state.chId ? null : renderUpNext(ch),
    renderPot(ch),
    renderPack(ch),
    renderChat(),
    renderGrid(ch),
    renderBoard(ch),
    renderFoot(),
  ].filter(Boolean));
}

function demoBanner() {
  if (state.backend?.mode !== "demo" || new URLSearchParams(location.search).has("plain")) return null;
  return h("p", { class: "demo-banner" }, "Demo with sample people. Nothing you tap here is saved.");
}

function renderLoading() { app.replaceChildren(h("div", { class: "skeleton", "aria-label": "Loading" })); }

// title null = the logo carries the name (sign-in); otherwise a small badge sits above the stencil title.
function gate(title, sub, ...rest) {
  document.body.classList.add("gated");
  const head = title
    ? [h("img", { class: "gate-badge", src: "logo-96.png", alt: "", width: "96", height: "78" }), h("h1", { class: "big" }, title[0], h("span", {}, title[1]))]
    : [h("h1", { class: "hero-h" }, h("img", { class: "hero-logo", src: "logo-hero.webp", alt: "Alpha Pack", width: "720", height: "582" }))];
  app.replaceChildren(demoBanner() || "", h("section", { class: "gate" + (title ? "" : " hero") }, ...head, h("p", {}, sub), ...rest));
}

function renderNoConfig() {
  gate(null, "Not hooked up yet. Jason's finishing the setup.",
    h("a", { class: "btn ghost", href: "?demo=active" }, "See the demo"));
}

function renderSignIn() {
  const btn = h("button", { class: "btn", type: "button", onclick: async () => {
    btn.disabled = true;
    try { await state.backend.signIn(); } catch (e) { toast("Couldn't sign in. Check your connection and try again."); console.error(e); }
    btn.disabled = false;
  } });
  btn.innerHTML = SVG.google;
  btn.append("Sign in with Google");
  gate(null, "Tick your goals every day. See how the pack is doing. Nobody gets left behind.", btn,
    h("p", { class: "fine" }, "Use the Google account Jason added to the group."));
}

function renderSetupGroup() {
  const btn = h("button", { class: "btn blaze", type: "button", onclick: async () => {
    btn.disabled = true;
    try { await state.backend.setupGroup(state.user); await refreshMembership(); } catch (e) { toast("Setup didn't save. Try again."); console.error(e); btn.disabled = false; }
  } }, "Start the group");
  gate(["First", "one here"], "You're the owner. Start the group, then add the guys' Google emails from the menu.", btn);
}

function renderNotMember() {
  gate(["Not on", "the list"], `You're signed in as ${state.user.email}. Ask Jason to add that email to the group, then open this page again.`,
    h("button", { class: "btn ghost", type: "button", onclick: () => state.backend.signOut() }, "Use a different account"));
}

function renderJoin() {
  const input = h("input", { id: "joinName", maxlength: "24", autocomplete: "nickname", placeholder: "What the guys call you" });
  const err = h("p", { class: "err", hidden: true });
  const form = h("form", { onsubmit: async (e) => {
    e.preventDefault();
    const name = L.cleanText(input.value).slice(0, 24);
    if (!name) { err.textContent = "Pick a name the group will see."; err.hidden = false; return; }
    form.querySelector("button").disabled = true;
    try { await state.backend.mergePlayer(state.user.uid, { name, joinedAt: now(), targets: {}, days: {} }); }
    catch (e2) { err.textContent = "That didn't save. Try again."; err.hidden = false; form.querySelector("button").disabled = false; console.error(e2); }
  } },
  h("div", { class: "field" }, h("label", { for: "joinName" }, "Your name on the board"), input, err),
  h("button", { class: "btn blaze", type: "submit" }, "Join the pack"));
  gate(["You're", "in"], "One thing first: the name the group sees next to your checks.", form);
  input.focus();
}

function renderNoChallenge() {
  app.replaceChildren(demoBanner() || "", h("section", { class: "gate" },
    h("h1", { class: "big" }, "No", h("span", {}, "challenge yet")),
    h("p", {}, "Set the first one: a name, the dates, and the goals everybody ticks each day."),
    h("button", { class: "btn blaze", type: "button", onclick: openCreate }, "Set up a challenge")),
  renderFoot());
}

function ring(score) {
  const C = 2 * Math.PI * 28;
  const off = C * (1 - (score.of ? score.hit / score.of : 0));
  const el = h("div", { class: "ring", role: "img", "aria-label": score.off ? "Day off" : `${score.hit} of ${score.of} done` });
  el.innerHTML = `<svg viewBox="0 0 68 68" aria-hidden="true"><circle class="track" cx="34" cy="34" r="28" fill="none" stroke-width="7"/><circle class="fill" cx="34" cy="34" r="28" fill="none" stroke-width="7" stroke-linecap="round" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"/></svg>`;
  el.append(h("b", {}, score.off ? "Off" : `${score.hit}/${score.of}`));
  return el;
}

function streakEl(n, label) {
  const el = h("span", { class: "streak" + (n >= 3 ? " hot" : ""), title: label });
  el.innerHTML = SVG.flame;
  el.append(String(n));
  el.setAttribute("aria-label", `${n} day streak`);
  return el;
}

function renderYou(ch) {
  const t = today();
  const date = viewDate();
  const p = me();
  const score = L.dayScore(p, ch, date);
  const goals = L.dailyGoals(ch, date);
  const weekly = L.weeklyGoals(ch, date);
  const wk = L.weekScore(p, ch, date);
  const openDays = L.editableDates(ch, now());
  const catchUp = L.catchUpOpen(ch, now());
  const dayLabel = (d) => d === t ? "Today" : d === L.addDays(t, -1) ? "Yesterday" : fmtDay(d, { weekday: "short" });
  const perfectStreak = L.perfectStreak(p, ch, t);
  const off = L.isSkip(ch, date);
  const sub = off ? "Day off for everyone" : !goals.length ? `${wk.met} of ${wk.of} weekly goals met` :
    score.perfect ? "Perfect day. Every daily goal done." :
    score.hit === 0 ? `${goals.length} daily goal${goals.length === 1 ? "" : "s"} to tick` :
    `${score.of - score.hit} to go today`;
  const card = h("section", { class: "you", id: "you", "aria-labelledby": "youTitle" },
    h("div", { class: "perfect", "aria-hidden": "true" }),
    h("div", { class: "you-head" }, ring(off ? { hit: 0, of: 0, off: true } : goals.length ? score : { hit: wk.met, of: wk.of }),
      h("div", { class: "you-title" }, h("p", { class: "eyebrow" }, ch.name), h("h1", { id: "youTitle" }, dayLabel(date)),
        h("p", {}, `${fmtDay(date)} · ${sub}`))),
    catchUp ? catchUpBanner(ch, p, openDays, t) : null,
    !catchUp && openDays.length > 1 ? h("div", { class: "seg-wrap" },
      h("div", { class: "seg", role: "group", "aria-label": "Which day" }, openDays.slice().reverse().map((d) =>
        h("button", { type: "button", "aria-pressed": String(d === date), onclick: () => { state.viewDay = d; render(); } }, dayLabel(d)))),
      h("p", { class: "seg-note" }, "Yesterday stays open until noon.")) : null,
    goals.length ? h("ul", { class: "goals" }, goals.map((g) => goalRow(ch, p, g, date, t))) : null,
    weekly.length ? h("div", { class: "wk-head" }, h("span", {}, "This week"), h("small", {}, `${wk.met} of ${wk.of} met · resets Monday`)) : null,
    weekly.length ? h("ul", { class: "goals" }, weekly.map((g) => goalRow(ch, p, g, date, t))) : null,
    off ? h("p", { class: "empty" }, h("b", {}, "Day off. "), "Nothing counts today, and every streak picks up where it left off.") :
      !goals.length && !weekly.length ? h("p", { class: "empty" }, "No goals count today. Add one from the menu.") : null,
    h("div", { class: "you-foot" },
      h("span", { class: "foot-note" + (perfectStreak >= 3 ? " hot" : "") }, perfectStreak ? `${perfectStreak} perfect day${perfectStreak === 1 ? "" : "s"} in a row` : goals.length ? `Tick all ${goals.length} daily goals for a perfect day` : "Weekly goals only"),
      h("button", { class: "link-btn", type: "button", onclick: openSettings }, "Edit goals")));
  return card;
}

// Shown to everyone while a backdated challenge's catch-up is open, so nobody has to be told.
function catchUpBanner(ch, p, openDays, t) {
  const closes = new Date(L.catchUpClosesMs(ch));
  const when = closes.toLocaleString("en-US", { weekday: "long", hour: "numeric", minute: "2-digit" }); // viewer's own time zone
  const days = openDays.slice().reverse(); // oldest first, ending on today
  const shown = state.viewDay && openDays.includes(state.viewDay) ? state.viewDay : t;
  return h("div", { class: "catchup", role: "note" },
    h("strong", {}, "Catch up on earlier days"),
    h("p", {}, `This challenge started ${fmtDay(ch.start, { weekday: "long" })}. Tick what you already did on those days. You have until `, h("b", {}, when), ", then they lock for good."),
    h("div", { class: "catchup-days", role: "group", "aria-label": "Which day" }, days.map((d) => {
      const s = L.dayScore(p, ch, d);
      return h("button", { class: "mini-btn", type: "button", "aria-pressed": String(shown === d), onclick: () => { state.viewDay = d; render(); } },
        `${d === t ? "Today" : fmtDay(d, { weekday: "short" })} · ${L.isSkip(ch, d) ? "off" : `${s.hit}/${s.of}`}`);
    })));
}

function goalRow(ch, p, g, date, t) {
  const done = L.isDone(p, date, g.id);
  const target = p.targets?.[g.id];
  const weekly = L.isWeekly(g);
  const prog = weekly ? L.weekProgress(p, ch, g, date) : null;
  const streak = weekly ? L.weekStreak(p, ch, g.id, t) : L.goalStreak(p, ch, g.id, t);
  const btn = h("button", { class: "goal", type: "button", role: "checkbox", "aria-checked": String(done), "data-goal": g.id,
    onclick: () => tick(ch, date, g.id, !done, btn) });
  const box = h("span", { class: "box" });
  box.innerHTML = SVG.check;
  const small = [target ? `Your target: ${target}` : null, weekly ? L.cadenceLabel(g) : null].filter(Boolean).join(" · ");
  btn.append(box, h("span", { class: "goal-text" }, h("strong", {}, g.text), small ? h("small", {}, small) : null),
    weekly ? h("span", { class: "wk" + (prog.met ? " met" : ""), "aria-label": `${prog.done} of ${prog.need} this week` }, `${prog.done}/${prog.need}`) : streakEl(streak, "Days in a row"));
  return h("li", {}, btn);
}

async function tick(ch, date, goalId, done, btn) {
  const res = L.tickPatch(ch, date, goalId, done, now());
  if (res.error) { toast(res.error); return; }
  const p = me();
  const before = L.dayScore(p, ch, date);
  const prev = p.days?.[date]?.[goalId];
  // optimistic: show it now, undo if the save fails
  state.players[state.user.uid] = Object.assign({}, p, { days: Object.assign({}, p.days, { [date]: Object.assign({}, p.days?.[date], { [goalId]: done }) }) });
  render();
  const row = document.querySelector(`.goal[data-goal="${goalId}"]`);
  if (row && done) { row.classList.add("pop"); navigator.vibrate?.(12); }
  const after = L.dayScore(me(), ch, date);
  if (after.perfect && !before.perfect) { $("#you")?.classList.add("shine"); toast("Perfect day. The pack sees it."); }
  try { await state.backend.mergePlayer(state.user.uid, res.patch); }
  catch (e) {
    console.error(e);
    const q = me();
    state.players[state.user.uid] = Object.assign({}, q, { days: Object.assign({}, q.days, { [date]: Object.assign({}, q.days?.[date], { [goalId]: prev === true }) }) });
    render();
    toast("That tick didn't save. Check your connection and tap again.");
  }
}

function renderUpcoming(ch) {
  const goals = L.goalList(ch).filter((g) => !g.closedOn);
  return h("section", { class: "you" },
    h("div", { class: "you-head" }, h("div", { class: "you-title" }, h("h1", {}, ch.name),
      h("p", {}, `Starts ${fmtDay(ch.start, { weekday: "long", month: "short", day: "numeric" })}. Goals can still change until then.`))),
    h("ul", { class: "goals" }, goals.map((g) => h("li", {}, h("div", { class: "goal", "aria-disabled": "true" },
      h("span", { class: "box" }), h("span", { class: "goal-text" }, h("strong", {}, g.text), me().targets?.[g.id] ? h("small", {}, `Your target: ${me().targets[g.id]}`) : h("small", {}, "Set your own target in Goals & targets")))))),
    h("div", { class: "you-foot" }, h("span", { class: "foot-note" }, "Set your own number for each goal"), h("button", { class: "link-btn", type: "button", onclick: openSettings }, "Edit goals")));
}

function renderFinished(ch) {
  const ids = Object.keys(state.players);
  const days = [];
  for (let d = ch.start; d <= ch.end; d = L.addDays(d, 1)) days.push(d);
  const totals = ids.map((uid) => {
    const p = state.players[uid];
    const sc = days.map((d) => L.dayScore(p, ch, d)).filter((s) => s.of);
    const pct = sc.length ? Math.round(sc.reduce((a, s) => a + s.pct, 0) / sc.length) : 0;
    return { uid, name: p.name, pct, perfect: sc.filter((s) => s.perfect).length };
  }).sort((a, b) => b.pct - a.pct);
  return h("section", { class: "post" }, h("h3", {}, `${ch.name} · final`, h("small", {}, `${fmtDay(ch.start)} – ${fmtDay(ch.end)}`)),
    h("ol", {}, totals.map((r, i) => h("li", { class: i === 0 ? "top" : null }, h("span", { class: "rank" }, String(i + 1)),
      h("div", {}, h("span", { class: "nm" }, r.name), r.perfect ? h("span", { class: "badge" }, `${r.perfect} perfect`) : null, h("div", { class: "bar" }, h("i", { style: `width:${r.pct}%` }))),
      h("span", { class: "pct" }, `${r.pct}%`)))),
    h("div", { class: "sheet-actions" }, h("button", { class: "btn blaze", type: "button", onclick: openCreate }, "Start the next challenge")));
}

// Challenges set up to start after the one on screen. Tap to see goals, set your target, or (owner) set it up.
function renderUpNext(ch) {
  const t = today();
  const next = challengeList().filter((c) => c.id !== ch.id && c.start > t).sort((a, b) => (a.start < b.start ? -1 : 1));
  if (!next.length) return null;
  return h("section", { "aria-labelledby": "nextH" },
    h("div", { class: "sec-head" }, h("h2", { id: "nextH" }, "Up next")),
    ...next.map((c) => {
      const goals = L.goalList(c).filter((g) => !g.closedOn);
      const bits = [`Starts ${fmtDay(c.start, { weekday: "long", month: "short", day: "numeric" })}`, `${goals.length} goal${goals.length === 1 ? "" : "s"}`, c.pot?.buyIn > 0 ? `${money(c.pot.buyIn)} buy-in` : null].filter(Boolean);
      return h("button", { class: "next-card", type: "button", onclick: () => pick(c.id) },
        h("span", {}, h("b", {}, c.name), h("small", {}, bits.join(" · "))), h("span", { class: "next-go", "aria-hidden": "true" }, "›"));
    }));
}

// Every challenge in the group: running, upcoming, past. Tap one to work in it.
function openChallenges() {
  state._sheetIs = "challenges";
  const build = () => {
    const t = today();
    const all = challengeList();
    const shown = current();
    const row = (c) => {
      const st = c.pot?.buyIn > 0 ? L.potStatus(state.players, c, now()) : null;
      const status = t < c.start ? `Starts ${fmtDay(c.start, { weekday: "short", month: "short", day: "numeric" })}` : t > c.end ? `Ended ${fmtDay(c.end, { month: "short", day: "numeric" })}` : `Day ${L.dayNumber(c, t)} of ${L.challengeLength(c)}`;
      const potBit = st ? (st.final ? (st.refund ? "pot refunded" : `${money(st.share)} each to ${st.alive}`) : `${money(st.pot)} pot`) : null;
      return h("li", {}, h("button", { class: "next-card", type: "button", "aria-current": String(shown?.id === c.id), onclick: () => { sheet.close(); pick(c.id); } },
        h("span", {}, h("b", {}, c.name), h("small", {}, [status, `${fmtDay(c.start, { month: "short", day: "numeric" })} – ${fmtDay(c.end, { month: "short", day: "numeric" })}`, potBit].filter(Boolean).join(" · "))),
        h("span", { class: "next-go", "aria-hidden": "true" }, "›")));
    };
    const running = all.filter((c) => L.inChallenge(c, t)).sort((a, b) => (a.start < b.start ? 1 : -1));
    const next = all.filter((c) => c.start > t).sort((a, b) => (a.start < b.start ? -1 : 1));
    const past = all.filter((c) => c.end < t).sort((a, b) => (a.end < b.end ? 1 : -1));
    const group = (title, list) => list.length ? [h("h3", {}, title), h("ul", { class: "ch-list" }, list.map(row))] : [];
    return [
      h("h2", { id: "sheetTitle" }, "Challenges"),
      h("p", { class: "sub" }, "Tap one to open it. Its board, goals and pot come with it."),
      ...group("Running now", running), ...group("Up next", next), ...group("Past", past),
      !all.length ? h("p", { class: "empty" }, "No challenges yet.") : null,
      h("div", { class: "sheet-actions" }, closeBtn(), state.ms?.owner ? h("button", { class: "btn blaze", type: "button", onclick: openCreate }, "New challenge") : null),
    ];
  };
  openSheet(build);
}

const money = (n) => "$" + (Number.isInteger(n) ? String(n) : n.toFixed(2));

// The pot: play money. Everyone on the board is in for the buy-in; strikes knock people out; survivors split it.
function renderPot(ch) {
  const st = L.potStatus(state.players, ch, now());
  if (!st) return null;
  const strikeDots = (n) => h("span", { class: "strikes", "aria-label": `${n} of ${st.limit} strikes` }, `${n}/${st.limit}`,
    ...Array.from({ length: st.limit }, (_, i) => h("i", { class: i < n ? "on" : "" })));
  const each = st.final
    ? (st.refund ? ["Nobody made it", h("small", {}, `Everyone gets their ${money(st.buyIn)} back`)] : [`${money(st.share)} each`, h("small", {}, `${st.alive} made it to the end`)])
    : (st.refund ? ["Everyone's out", h("small", {}, `If it ended now, everyone gets ${money(st.buyIn)} back`)] : [`${money(st.share)} each`, h("small", {}, `if it ended now · ${st.alive} still in`)]);
  return h("section", { "aria-labelledby": "potH" },
    h("div", { class: "sec-head" }, h("h2", { id: "potH" }, st.final ? "The Pot · final" : "The Pot"), h("span", { class: "note" }, `${money(st.buyIn)} each · out at ${st.limit} strikes`)),
    h("div", { class: "pot" },
      h("div", { class: "pot-top" }, h("div", { class: "pot-amt" }, money(st.pot), h("small", {}, `${st.paid} of ${st.rows.length} paid`)), h("div", { class: "pot-each" }, ...each)),
      h("ol", { class: "pot-rows" }, st.rows.map((r) => h("li", { class: r.out ? "out" : null },
        h("span", {}, h("b", {}, r.uid === state.user.uid ? "You" : r.name), r.paid ? h("small", { style: "color:var(--muted)" }, " · paid") : null),
        r.out ? h("span", { class: "out-chip" }, "OUT") : strikeDots(r.strikes)))),
      h("p", { class: "seg-note" }, "A strike is a day without every daily goal done, or a weekly goal missed when its week ends. A day counts once it locks at noon the next day. Days off never count. Play money: settle up in person.")));
}

function renderPack(ch) {
  const t = today();
  const date = L.inChallenge(ch, t) ? t : t > ch.end ? ch.end : ch.start;
  const goals = L.dailyGoals(ch, date);
  const weekly = L.weeklyGoals(ch, date);
  const ids = packOrder(ch, date);
  const tags = ids.map((uid) => {
    const p = state.players[uid];
    const s = L.dayScore(p, ch, date);
    const open = state.expanded.has(uid);
    const isMe = uid === state.user.uid;
    const ps = L.perfectStreak(p, ch, date);
    const off = L.isSkip(ch, date);
    const potRow = L.potStatus(state.players, ch, now())?.rows.find((r) => r.uid === uid);
    const detailId = "tagd-" + uid.replace(/[^a-zA-Z0-9_-]/g, "");
    return h("article", { class: "tag" + (isMe ? " me" : "") },
      h("button", { class: "tag-btn", type: "button", "aria-expanded": String(open), "aria-controls": detailId, onclick: () => { open ? state.expanded.delete(uid) : state.expanded.add(uid); render(); } },
        h("div", { class: "tag-row" },
          h("div", { class: "tag-name" }, h("b", {}, p.name || "Player"), h("span", {}, potRow?.out ? (isMe ? "You · out of the pot" : "Out of the pot") : isMe ? "You" : off ? "Day off" : ps ? `${ps} perfect day${ps === 1 ? "" : "s"} in a row` : s.hit ? `${s.of - s.hit} to go today` : "Nothing ticked yet today")),
          h("div", { class: "tag-score" }, off ? "Off" : `${s.hit}/${s.of}`, h("small", {}, "today"))),
        h("div", { class: "pips", "aria-hidden": "true" }, goals.map((g) => h("span", { class: "pip" + (L.isDone(p, date, g.id) ? " on" : "") })),
          weekly.map((g) => { const pr = L.weekProgress(p, ch, g, date); return h("span", { class: "wbar" + (pr.met ? " met" : "") }, h("i", { style: `width:${pr.need ? Math.min(100, Math.round(pr.done / pr.need * 100)) : 0}%` })); }))),
      open ? h("div", { class: "tag-detail", id: detailId }, goals.map((g) => {
        const on = L.isDone(p, date, g.id);
        const dot = h("span", { class: "dot" + (on ? " on" : "") });
        if (on) dot.innerHTML = SVG.check;
        return h("div", {}, dot, h("span", { class: "t" }, g.text, p.targets?.[g.id] ? h("small", {}, ` · ${p.targets[g.id]}`) : null),
          streakEl(L.goalStreak(p, ch, g.id, date), "Days in a row"));
      }), weekly.map((g) => {
        const pr = L.weekProgress(p, ch, g, date);
        const dot = h("span", { class: "dot" + (pr.met ? " on" : "") });
        if (pr.met) dot.innerHTML = SVG.check;
        return h("div", {}, dot, h("span", { class: "t" }, g.text, h("small", {}, ` · ${L.cadenceLabel(g)}${p.targets?.[g.id] ? " · " + p.targets[g.id] : ""}`)),
          h("span", { class: "wk" + (pr.met ? " met" : "") }, `${pr.done}/${pr.need}`));
      }), state.ms?.owner ? ownerEditor(ch, uid, p) : null) : null);
  });
  return h("section", { "aria-labelledby": "packH" },
    h("div", { class: "sec-head" }, h("h2", { id: "packH" }, "The Pack"), h("span", { class: "note" }, "Tap a tag for details")),
    ids.length > 1 ? h("div", { class: "pack" }, tags) : h("div", { class: "pack" }, tags, h("p", { class: "empty" }, h("b", {}, "You're first here. "), "The others show up as soon as they sign in and pick a name.")));
}

function renderGrid(ch) {
  const t = today();
  const end = t > ch.end ? ch.end : t;
  const dates = L.gridDates(ch, end, 7);
  if (!dates.length) return null;
  const ids = packOrder(ch, end);
  const grid = h("div", { class: "grid", style: `grid-template-columns: minmax(56px, 88px) repeat(${dates.length}, minmax(0, 40px));`, role: "table", "aria-label": "Last seven days, share of goals done" });
  grid.append(h("span", { role: "columnheader" }), ...dates.map((d) => h("span", { class: "dh" + (d === t ? " today" : ""), role: "columnheader" }, fmtDay(d, { weekday: "narrow" }))));
  for (const uid of ids) {
    const p = state.players[uid];
    grid.append(h("span", { class: "who", role: "rowheader" }, p.name || "Player"));
    for (const d of dates) {
      const s = L.dayScore(p, ch, d);
      if (L.isSkip(ch, d)) { grid.append(h("span", { class: "cell off" + (d === t ? " today" : ""), role: "cell", title: `${fmtDay(d)}: day off`, "aria-label": `${p.name}, ${fmtDay(d)}: day off` })); continue; }
      const lvl = !s.of || !L.joinedBy(p, d) ? 0 : s.pct === 100 ? 4 : s.pct >= 67 ? 3 : s.pct >= 34 ? 2 : s.pct > 0 ? 1 : 0;
      grid.append(h("span", { class: `cell l${lvl}` + (d === t ? " today" : ""), role: "cell", title: `${p.name}, ${fmtDay(d)}: ${s.hit} of ${s.of}`, "aria-label": `${p.name}, ${fmtDay(d)}: ${s.hit} of ${s.of}` }));
    }
  }
  return h("section", { "aria-labelledby": "gridH" },
    h("div", { class: "sec-head" }, h("h2", { id: "gridH" }, "Last 7 days")),
    h("div", { class: "grid-card" }, grid,
      h("div", { class: "legend", "aria-hidden": "true" }, "None", h("span", { class: "cell l1" }), h("span", { class: "cell l2" }), h("span", { class: "cell l3" }), h("span", { class: "cell l4" }), "All")));
}

function boardPost(ch, r, live) {
  const redo = !live && state.ms?.owner ? h("button", { class: "mini-btn", type: "button", style: "min-height:44px;margin-top:10px", onclick: async () => {
    if (state.confirmRedo !== r.date) { state.confirmRedo = r.date; render(); return; }
    state.confirmRedo = null;
    try {
      await state.backend.replaceResult(L.resultId(r.date), L.buildResult(state.players, ch, r.date, now())); // one write: never a gap
      toast(`${fmtDay(r.date)} re-posted from today's ticks.`);
    } catch (e) { console.error(e); toast("That didn't save."); }
  } }, state.confirmRedo === r.date ? "Tap again to re-post it" : "Redo this day") : null;
  return h("article", { class: "post" + (live ? " live" : "") },
    h("h3", {}, h("span", {}, fmtDay(r.date), live ? h("span", { class: "live-chip" }, "Live") : null),
      h("small", {}, live ? "Open · still ticking" : `Day ${L.dayNumber(ch, r.date)}`)),
    h("ol", {}, (r.rows || []).map((row, i) => h("li", { class: i === 0 && row.pct > 0 ? "top" : null },
      h("span", { class: "rank" }, String(i + 1)),
      h("div", {}, h("span", { class: "nm" }, row.name), row.perfect ? h("span", { class: "badge" }, "Perfect") : null, h("div", { class: "bar" }, h("i", { style: `width:${row.pct}%` }))),
      h("span", { class: "pct" }, row.of ? `${row.hit}/${row.of}` : "", row.wkOf ? h("small", { class: "wkn" }, `wk ${row.wkMet}/${row.wkOf}`) : null)))), redo);
}

// Days still open (today, and yesterday until noon) show live from everyone's ticks; closed days are the posted docs.
function renderBoard(ch) {
  const t = today();
  const all = Object.values(state.results || {}).filter((r) => r.challengeId === ch.id && !L.isSkip(ch, r.date)).sort((a, b) => (a.date < b.date ? 1 : -1));
  const posted = new Set(all.map((r) => r.date));
  const live = L.editableDates(ch, now()).filter((d) => !posted.has(d) && !L.isSkip(ch, d))
    .map((d) => L.buildResult(state.players, ch, d, now()));
  const posts = all.slice(0, state.boardAll ? 60 : 3);
  const head = h("div", { class: "sec-head" }, h("h2", { id: "boardH" }, "Daily Board"), h("span", { class: "note" }, "Live all day · locks at noon next day"));
  if (!live.length && !posts.length) {
    const msg = t < ch.start ? [h("b", {}, `Scores start ${fmtDay(ch.start, { weekday: "long" })}. `), "The board goes live the moment anyone ticks."]
      : [h("b", {}, "Nothing to show yet. "), "The board fills in as the pack ticks."];
    return h("section", { "aria-labelledby": "boardH" }, head, h("p", { class: "empty" }, ...msg));
  }
  return h("section", { "aria-labelledby": "boardH" }, head, h("div", { class: "board" },
    live.map((r) => boardPost(ch, r, true)), posts.map((r) => boardPost(ch, r, false)),
    all.length > posts.length ? h("button", { class: "mini-btn more", type: "button", onclick: () => { state.boardAll = true; render(); } }, `Show ${all.length - posts.length} older`) : null));
}

function renderFoot() {
  return h("p", { class: "fine", style: "color:var(--muted);font-size:13px;text-align:center;margin:0" },
    state.user?.email ? `Signed in as ${state.user.email} · ` : "",
    h("button", { class: "link-btn", type: "button", onclick: () => state.backend.signOut() }, "Sign out"));
}

// Owner only: correct a teammate's ticks on any day of the challenge.
function ownerEditor(ch, uid, p) {
  const t = today();
  const last = t > ch.end ? ch.end : t;
  const days = [];
  for (let d = last; d >= ch.start && days.length < 60; d = L.addDays(d, -1)) days.push(d);
  const day = state.ownerDay?.[uid] && days.includes(state.ownerDay[uid]) ? state.ownerDay[uid] : last;
  const sel = h("select", { class: "cad", id: `own-${uid.replace(/[^a-zA-Z0-9_-]/g, "")}`, "aria-label": `Day to edit for ${p.name}`,
    onchange: (e) => { state.ownerDay = Object.assign({}, state.ownerDay, { [uid]: e.target.value }); render(); } },
    days.map((d) => h("option", { value: d }, d === t ? "Today" : fmtDay(d))));
  sel.value = day;
  const self = uid === state.user.uid;
  const nameIn = h("input", { id: `nm-${uid.replace(/[^a-zA-Z0-9_-]/g, "")}`, maxlength: "24", value: p.name || "", "aria-label": `Name for ${p.name || "player"}` });
  const rename = h("div", { style: "display:flex;gap:8px" }, nameIn, h("button", { class: "mini-btn", type: "button", style: "min-height:44px;flex:none", onclick: async () => {
    const v = L.cleanText(nameIn.value).slice(0, 24);
    if (!v) return toast("Give them a name.");
    try { await state.backend.mergePlayer(uid, { name: v }); toast("Renamed."); } catch (e) { console.error(e); toast("That didn't save."); }
  } }, "Rename"));
  const sure = state.confirmRemove === uid;
  const remove = self ? null : h("button", { class: "mini-btn danger", type: "button", onclick: async () => {
    if (!sure) { state.confirmRemove = uid; render(); return; }
    state.confirmRemove = null;
    try { await state.backend.deletePlayer(uid); toast(`${p.name || "They"} left the board${ch.pot?.buyIn > 0 ? " and the pot" : ""}. Remove their email in People too, or they can rejoin.`); }
    catch (e) { console.error(e); toast("That didn't save."); }
  } }, sure ? `Tap again: delete ${p.name || "them"}${ch.pot?.buyIn > 0 ? ", their ticks and their buy-in" : " and all their ticks"}` : "Take off the board");
  return h("div", { class: "owner-edit" }, h("span", { class: "tlabel" }, self ? "Owner: fix your ticks" : "Owner: fix their ticks"), sel,
    h("div", { class: "owner-ticks" }, L.activeGoals(ch, day).map((g) => {
      const on = L.isDone(p, day, g.id);
      return h("button", { class: "mini-btn" + (on ? " on" : ""), type: "button", "aria-pressed": String(on), onclick: async () => {
        const r = L.ownerTickPatch(ch, day, g.id, !on);
        if (r.error) return toast(r.error);
        try { await state.backend.mergePlayer(uid, r.patch); toast(`${p.name || "Their"} ${g.text}: ${on ? "unticked" : "ticked"}.`); }
        catch (e) { console.error(e); toast("That didn't save. Only the owner can edit other players."); }
      } }, `${on ? "✓ " : ""}${g.text}`);
    })), rename, remove);
}

// Owner only: bring back goals whose ticks still exist (ids found in players' days but missing from the challenge).
const RECOVER_GUESS = { g1: ["Protein 130g", null], g2: ["Under 2,000 calories", 5], g3: ["Cardio or a walk", 5], g4: ["Resistance Training", 2], g5: ["Never over 3,000 calories", null] };
function recoverField(ch) {
  const orphans = L.orphanGoals(state.players, ch, challengeList());
  if (!orphans.length) return null;
  const items = orphans.map((o) => ({ id: o.id, text: (RECOVER_GUESS[o.id] || [""])[0], perWeek: (RECOVER_GUESS[o.id] || [null, null])[1] }));
  return h("div", { class: "catchup", role: "note" },
    h("strong", {}, "Recover goals"),
    h("p", {}, `Found ticks for ${orphans.length} goal${orphans.length === 1 ? "" : "s"} that went missing. Check each name and how often, then recover. Every tick saved under them comes back.`),
    ...orphans.map((o, i) => h("div", { class: "gfields" },
      h("input", { id: `rec-${o.id}`, maxlength: "60", value: items[i].text, placeholder: "Goal name", "aria-label": `Name for ${o.id}`, oninput: (e) => { items[i].text = e.target.value; } }),
      cadenceSelect(`reccad-${o.id}`, items[i].perWeek, (v) => { items[i].perWeek = v; }, `How often for ${o.id}`),
      h("small", { class: "seg-note" }, `${o.ticks} tick${o.ticks === 1 ? "" : "s"} saved · ${o.days.map((d) => fmtDay(d, { weekday: "short" })).join(", ")}`))),
    h("button", { class: "btn blaze", type: "button", onclick: async () => {
      const r = L.recoverGoalsPatch(ch, items);
      if (r.error) return toast(r.error);
      try { await state.backend.mergeChallenge(ch.id, r.patch); toast("Goals recovered. Your ticks are back."); } catch (e) { console.error(e); toast("That didn't save."); }
    } }, "Recover goals"));
}

// Owner only: change the dates. Moving the start back on set-up day also opens the catch-up for everyone.
function datesField(ch) {
  const start = h("input", { id: "editStart", type: "date", value: ch.start });
  const end = h("input", { id: "editEnd", type: "date", value: ch.end });
  return h("div", { class: "field" }, h("label", {}, "Dates"),
    h("div", { class: "row2" }, h("div", {}, h("label", { class: "tlabel", for: "editStart" }, "Starts"), start), h("div", {}, h("label", { class: "tlabel", for: "editEnd" }, "Ends"), end)),
    h("button", { class: "mini-btn", type: "button", style: "min-height:44px;margin-top:8px", onclick: async () => {
      const r = L.datesPatch(ch, start.value, end.value);
      if (r.error) return toast(r.error);
      try {
        await state.backend.mergeChallenge(ch.id, r.patch);
        state.viewDay = null;
        const moved = Object.assign({}, ch, { start: start.value, end: end.value });
        toast(L.catchUpOpen(moved, now()) ? `Starts ${fmtDay(start.value, { weekday: "long" })} now. Everyone can catch up until noon tomorrow.` : "Dates saved.");
      } catch (e2) { console.error(e2); toast("That didn't save."); }
    } }, "Save dates"),
    h("p", { class: "seg-note" }, "Set the start up to a week back today, and everyone can tick those days until noon tomorrow."));
}

// Owner only: everything about the challenge itself, at the top of the menu.
function ownerControls(ch) {
  const t = today();
  const name = h("input", { id: "editName", maxlength: "60", value: ch.name, "aria-label": "Challenge name" });
  const end = L.endPlan(ch, t);
  const sure = state.confirmEnd === ch.id;
  return h("div", { class: "owner-block" },
    h("div", { class: "owner-actions" },
      h("button", { class: "mini-btn", type: "button", onclick: openMembers }, "People in the group"),
      h("button", { class: "mini-btn", type: "button", onclick: openCreate }, "Start a new challenge")),
    h("div", { class: "field" }, h("label", { for: "editName" }, "Name"), h("div", { style: "display:flex;gap:8px" }, name,
      h("button", { class: "mini-btn", type: "button", style: "min-height:50px;flex:none", onclick: async () => {
        const r = L.renamePatch(name.value);
        if (r.error) return toast(r.error);
        try { await state.backend.mergeChallenge(ch.id, r.patch); toast("Renamed."); } catch (e) { console.error(e); toast("That didn't save."); }
      } }, "Save"))),
    datesField(ch),
    daysOffField(ch),
    potField(ch),
    end.error ? null : h("div", { class: "field" },
      h("button", { class: "mini-btn danger", type: "button", style: "min-height:44px", onclick: async () => {
        if (!sure) { state.confirmEnd = ch.id; openSettings(state._settingsId); return; }
        state.confirmEnd = null;
        try {
          if (end.remove) { await state.backend.deleteChallenge(ch.id); sheet.close(); toast("Removed. It hadn't started."); }
          else { await state.backend.mergeChallenge(ch.id, end.patch); toast("Ends tonight. Today still counts, and the final board shows tomorrow."); }
        } catch (e) { console.error(e); toast("That didn't save."); }
      } }, sure ? (end.remove ? "Tap again to remove it" : "Tap again to end it tonight") : (end.remove ? "Cancel this challenge" : "End it early")),
      h("p", { class: "seg-note" }, end.remove ? "It hasn't started, so nothing is lost." : "Today is the last day. Every tick so far stays, and the final standings show tomorrow.")),
    end.remove ? null : h("div", { class: "field" },
      h("button", { class: "mini-btn danger", type: "button", style: "min-height:44px", onclick: async () => {
        if (state.confirmDelete !== ch.id) { state.confirmDelete = ch.id; openSettings(state._settingsId); return; }
        state.confirmDelete = null;
        try { await state.backend.deleteChallenge(ch.id); sheet.close(); pick(null); toast(`${ch.name} deleted.`); } catch (e) { console.error(e); toast("That didn't save."); }
      } }, state.confirmDelete === ch.id ? `Tap again to delete ${ch.name} for good` : "Delete this challenge"),
      h("p", { class: "seg-note" }, "Removes the challenge, its goals, days off and pot for everyone. Ticks stay on each player, but nothing shows them.")));
}

// Owner only: the pot. Buy-in 0 turns it off. Paid is a record of who settled up; the app never moves money.
function potField(ch) {
  const pot = ch.pot || {};
  const buy = h("input", { id: "potBuyIn", type: "number", inputmode: "numeric", min: "0", max: "10000", step: "1", value: pot.buyIn ?? "", placeholder: "50", "aria-label": "Buy-in per person, dollars" });
  const lim = h("select", { id: "potStrikes", class: "cad", "aria-label": "Out at how many strikes" },
    Array.from({ length: 20 }, (_, i) => h("option", { value: String(i + 1) }, `Out at ${i + 1} strike${i ? "s" : ""}`)));
  lim.value = String(pot.strikes || 3);
  const ids = Object.keys(state.players || {}).sort((a, b) => (state.players[a].name || "").localeCompare(state.players[b].name || ""));
  return h("div", { class: "field" }, h("label", { for: "potBuyIn" }, "The pot"),
    h("div", { class: "row2" }, h("div", {}, h("label", { class: "tlabel", for: "potBuyIn" }, "Buy-in ($)"), buy), h("div", {}, h("label", { class: "tlabel", for: "potStrikes" }, "Strikes"), lim)),
    h("button", { class: "mini-btn", type: "button", style: "min-height:44px;margin-top:8px", onclick: async () => {
      const r = L.potPatch(buy.value === "" ? 0 : buy.value, lim.value);
      if (r.error) return toast(r.error);
      try { await state.backend.mergeChallenge(ch.id, r.patch); toast(r.patch.pot.buyIn ? `Pot on: ${money(r.patch.pot.buyIn)} each, out at ${r.patch.pot.strikes}.` : "Pot off."); }
      catch (e) { console.error(e); toast("That didn't save."); }
    } }, "Save pot"),
    pot.buyIn > 0 ? h("ul", { class: "off-list" }, ids.map((uid) => {
      const paid = pot.paid?.[uid] === true;
      return h("li", {}, h("span", {}, state.players[uid].name || "Player"),
        h("button", { class: "mini-btn" + (paid ? " on" : ""), type: "button", "aria-pressed": String(paid), style: "min-height:44px", onclick: async () => {
          try { await state.backend.mergeChallenge(ch.id, L.paidPatch(uid, !paid).patch); } catch (e) { console.error(e); toast("That didn't save."); }
        } }, paid ? "✓ Paid" : "Mark paid"));
    })) : null,
    h("p", { class: "seg-note" }, "Play money. Everyone on the board is in. Survivors split the pot evenly at the end; if nobody makes it, everyone gets their buy-in back. 0 turns it off."));
}

// Owner only: days off. Nothing counts on them for anyone; streaks jump them; weekly goals need one day fewer.
function daysOffField(ch) {
  const t = today();
  const pick = h("input", { id: "offDay", type: "date", value: L.inChallenge(ch, t) ? t : ch.start, min: ch.start, max: ch.end, "aria-label": "Day to take off" });
  const save = async (date, off) => {
    const r = L.skipPatch(ch, date, off);
    if (r.error) return toast(r.error);
    try { await state.backend.mergeChallenge(ch.id, r.patch); toast(off ? `${fmtDay(date)} is a day off for everyone.` : `${fmtDay(date)} counts again.`); }
    catch (e) { console.error(e); toast("That didn't save."); }
  };
  const offs = L.skipDates(ch);
  return h("div", { class: "field" }, h("label", { for: "offDay" }, "Days off"),
    h("div", { style: "display:flex;gap:8px" }, pick,
      h("button", { class: "mini-btn", type: "button", style: "min-height:50px;flex:none", onclick: () => save(pick.value, true) }, "Take it off")),
    offs.length ? h("ul", { class: "off-list" }, offs.map((d) => h("li", {}, h("span", {}, fmtDay(d, { weekday: "long", month: "short", day: "numeric" })),
      h("button", { class: "mini-btn", type: "button", style: "min-height:44px", onclick: () => save(d, false) }, "Count it again")))) : null,
    h("p", { class: "seg-note" }, "Holiday, sick week, travel. Nothing counts that day for anyone, streaks skip it, and weekly goals need one day fewer that week. Ticks stay, so switching it back brings them back."));
}

// "Every day" or "N days a week". Values: "" = daily, "1".."6".
function cadenceSelect(id, perWeek, onChange, label) {
  const sel = h("select", { id, class: "cad", "aria-label": label, onchange: (e) => onChange(e.target.value ? Number(e.target.value) : null) },
    h("option", { value: "" }, "Every day"),
    [1, 2, 3, 4, 5, 6].map((n) => h("option", { value: String(n) }, `${n} day${n === 1 ? "" : "s"} a week`)));
  sel.value = perWeek ? String(perWeek) : "";
  return sel;
}

// ---------- Trash Talk: the group's message board ----------
function fmtWhen(ms) {
  const d = new Date(ms);
  const sameDay = L.pacificDate(ms) === today();
  return d.toLocaleString("en-US", sameDay ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" });
}

function renderChat() {
  const msgs = Object.entries(state.chat || {}).map(([id, m]) => Object.assign({ id }, m)).sort((a, b) => a.at - b.at).slice(-60);
  const input = h("input", { id: "chatInput", maxlength: String(L.MAX_POST), autocomplete: "off", enterkeyhint: "send", placeholder: "Say something to the pack", value: state.chatDraft, "aria-label": "Message",
    oninput: (e) => { state.chatDraft = e.target.value; } });
  const send = async (e) => {
    e.preventDefault();
    const text = L.cleanPost(state.chatDraft);
    if (!text) return;
    state.chatDraft = "";
    input.value = "";
    try { await state.backend.postMessage({ uid: state.user.uid, text, at: now() }); }
    catch (err) { console.error(err); state.chatDraft = text; render(); toast("That didn't post. Check your connection and try again."); }
  };
  const list = h("ol", { class: "chat-list", "aria-live": "polite" }, msgs.map((m) => {
    const mine = m.uid === state.user.uid;
    const canDelete = mine || state.ms?.owner;
    const name = state.players?.[m.uid]?.name || "Player";
    return h("li", { class: "msg" + (mine ? " mine" : "") },
      h("div", { class: "msg-meta" }, h("b", {}, mine ? "You" : name), h("span", {}, fmtWhen(m.at)),
        canDelete ? h("button", { class: "msg-del", type: "button", "aria-label": state.confirmDel === m.id ? "Tap again to delete" : "Delete message", onclick: async () => {
          if (state.confirmDel !== m.id) { state.confirmDel = m.id; render(); return; }
          state.confirmDel = null;
          try { await state.backend.deleteMessage(m.id); } catch (err) { console.error(err); toast("That didn't delete."); }
        } }, state.confirmDel === m.id ? "Delete?" : "×") : null),
      h("p", { class: "msg-text" }, m.text));
  }));
  return h("section", { "aria-labelledby": "chatH" },
    h("div", { class: "sec-head" }, h("h2", { id: "chatH" }, "Trash Talk"), h("span", { class: "note" }, "Everyone in the group sees this")),
    h("div", { class: "chat-card" },
      msgs.length ? list : h("p", { class: "empty" }, h("b", {}, "Quiet in here. "), "Somebody start it."),
      h("form", { class: "chat-form", onsubmit: send }, input, h("button", { class: "btn blaze", type: "submit" }, "Send"))));
}

// ---------- sheets ----------
const sheet = $("#sheet");
function openSheet(build) {
  const body = $("#sheetBody");
  body.replaceChildren(h("div", { class: "grab", "aria-hidden": "true" }), ...build().filter(Boolean)); // builders return null for hidden parts
  if (!sheet.open) sheet.showModal();
}
sheet.addEventListener("click", (e) => { if (e.target === sheet) sheet.close(); });
$("#menuBtn").addEventListener("click", openSettings);
$("#dayChip").addEventListener("click", openChallenges);

function closeBtn() { return h("button", { class: "btn ghost", type: "button", onclick: () => sheet.close() }, "Done"); }

function openCreate() {
  const t = today();
  state._handoffFor = null;
  const goals = [{ text: "", perWeek: null }, { text: "", perWeek: null }, { text: "", perWeek: null }];
  let errors = {};
  const build = () => {
    const name = h("input", { id: "chName", maxlength: "60", placeholder: "Fall Cut", value: state._draftName || "" });
    const start = h("input", { id: "chStart", type: "date", value: state._draftStart || t, min: L.addDays(t, -L.MAX_BACKDATE) });
    const end = h("input", { id: "chEnd", type: "date", value: state._draftEnd || L.addDays(t, 20), min: t });
    const list = h("ul", { class: "glist" }, goals.map((g, i) => h("li", { class: "gitem" }, h("span", { class: "n" }, String(i + 1)),
      h("div", { class: "gfields" },
        h("input", { id: `chGoal${i}`, maxlength: "60", value: g.text, placeholder: ["Protein 200g", "Lift", "No sugar"][i] || "Another goal", "aria-label": `Goal ${i + 1}`, oninput: (e) => { goals[i].text = e.target.value; } }),
        cadenceSelect(`chCad${i}`, g.perWeek, (v) => { goals[i].perWeek = v; }, `How often for goal ${i + 1}`)))));
    const err = (k) => errors[k] ? h("p", { class: "err" }, errors[k]) : null;
    const plan = state._handoffFor ? L.handoffPlan(challengeList(), state._handoffFor) : [];
    const keep = () => { state._draftName = name.value; state._draftStart = start.value; state._draftEnd = end.value; };
    return [
      h("h2", { id: "sheetTitle" }, "New challenge"),
      h("p", { class: "sub" }, "Goals lock when it starts. After that you can add a goal or close one, and everyone sets their own target. Start up to a week back and everyone can catch up those days until noon tomorrow."),
      h("div", { class: "field" }, h("label", { for: "chName" }, "Name"), name, err("name")),
      h("div", { class: "row2" }, h("div", { class: "field" }, h("label", { for: "chStart" }, "Starts"), start, err("start")), h("div", { class: "field" }, h("label", { for: "chEnd" }, "Ends"), end, err("end"))),
      h("div", { class: "field", style: "margin-bottom:6px" }, h("label", {}, "Daily goals"), err("goals")), list,
      h("button", { class: "mini-btn", type: "button", disabled: goals.length >= L.MAX_GOALS, onclick: () => { keep(); goals.push({ text: "", perWeek: null }); openSheet(build); document.getElementById(`chGoal${goals.length - 1}`)?.focus(); } }, "Add another goal"),
      plan.length ? h("div", { class: "lockline", role: "note" }, h("span", {}, plan.map((x) => x.remove
        ? `"${x.name}" hasn't started yet, so it gets removed. `
        : `"${x.name}" ends ${fmtDay(x.patch.end, { weekday: "long", month: "short", day: "numeric" })}. Its ticks and standings stay. `).join(""))) : null,
      h("div", { class: "sheet-actions", style: "margin-top:18px" }, closeBtn(), h("button", { class: "btn blaze", type: "button", onclick: async (e) => {
        keep();
        const v = L.validateChallenge({ name: name.value, start: start.value, end: end.value, goals }, t, now());
        errors = v.errors;
        if (!v.ok) { openSheet(build); return; }
        const handoff = L.handoffPlan(challengeList(), start.value);
        if (handoff.length && state._handoffFor !== start.value) { state._handoffFor = start.value; openSheet(build); return; } // show what it replaces first
        e.target.disabled = true;
        try {
          await state.backend.createChallenge(Object.assign(v.value, { createdBy: state.user.uid, createdAt: now() }));
          for (const x of handoff) { if (x.remove) await state.backend.deleteChallenge(x.id); else await state.backend.mergeChallenge(x.id, x.patch); }
          state._draftName = state._draftStart = state._draftEnd = state._handoffFor = null;
          sheet.close();
          toast(v.value.start > t && current() && current().start <= t ? `Set for ${fmtDay(v.value.start, { weekday: "long" })}. It's under Up next.` : "Challenge set. Go get it.");
        } catch (e2) { console.error(e2); e.target.disabled = false; toast("That didn't save. Try again."); }
      } }, plan.length && state._handoffFor === start.value ? "Tap again to start it" : "Start it")),
    ];
  };
  openSheet(build);
}

// The menu for one challenge: the current one, or (id) an upcoming one opened from Up next.
function settingsChallenge() { return (state._settingsId && challengeList().find((c) => c.id === state._settingsId)) || current(); }
function openSettings(id) {
  state._settingsId = typeof id === "string" ? id : null; // called from click handlers too: an event is not an id
  if (!settingsChallenge()) return openCreate();
  let confirmClose = null;
  const build = () => {
    const ch = settingsChallenge(); // re-read on every rebuild: the shared doc changes under the open sheet
    const t = today();
    const owner = !!state.ms?.owner;
    const locked = L.isLocked(ch, t) && !owner; // the owner can edit anything, any time
    const goals = L.goalList(ch);
    const mine = me().targets || {};
    const items = goals.map((g) => {
      const closed = !!g.closedOn && g.closedOn <= t;
      const target = h("input", { id: `tgt-${g.id}`, maxlength: "40", value: mine[g.id] || "", placeholder: "Your number, e.g. 200 g", "aria-label": `Your target for ${g.text}`, disabled: closed,
        onchange: async (e) => {
          const v = L.cleanText(e.target.value).slice(0, 40);
          try { await state.backend.mergePlayer(state.user.uid, { targets: { [g.id]: v } }); toast("Target saved."); } catch (e2) { console.error(e2); toast("Target didn't save. Try again."); }
        } });
      const textField = !locked ? h("input", { id: `gtx-${g.id}`, maxlength: "60", value: g.text, "aria-label": "Goal", onchange: async (e) => {
        const r = L.editGoalPatch(ch, g.id, e.target.value, t, owner);
        if (r.error) return toast(r.error);
        try { await state.backend.mergeChallenge(ch.id, r.patch); toast("Goal updated."); } catch (e2) { console.error(e2); toast("That didn't save."); }
      } }) : null;
      return h("div", { class: "gset" + (closed ? " closed" : "") },
        h("div", { class: "gset-top" }, locked ? h("strong", {}, g.text) : h("div", { class: "field", style: "margin:0;flex:1" }, textField),
          closed ? h("small", {}, `Closed ${fmtDay(g.closedOn, { month: "short", day: "numeric" })}`) : g.addedOn > ch.start ? h("small", {}, `Added ${fmtDay(g.addedOn, { month: "short", day: "numeric" })}`) : null),
        locked ? h("span", { class: "tlabel" }, L.cadenceLabel(g)) :
          h("div", { class: "field", style: "margin:0" }, h("label", { class: "tlabel", for: `cad-${g.id}` }, "How often"),
            cadenceSelect(`cad-${g.id}`, g.perWeek, async (v) => {
              const r = L.cadencePatch(ch, g.id, v, t, owner);
              if (r.error) return toast(r.error);
              try { await state.backend.mergeChallenge(ch.id, r.patch); toast("Saved."); } catch (e2) { console.error(e2); toast("That didn't save."); }
            }, `How often for ${g.text}`)),
        h("div", { class: "field", style: "margin:0" }, h("label", { class: "tlabel", for: `tgt-${g.id}` }, "Your target"), target),
        closed ? null : h("div", {}, h("button", { class: "mini-btn danger", type: "button", onclick: async () => {
          if (confirmClose !== g.id) { confirmClose = g.id; openSheet(build); return; }
          const r = L.closeGoalPatch(ch, g.id, t);
          if (r.error) return toast(r.error);
          try { await state.backend.mergeChallenge(ch.id, r.patch); confirmClose = null; toast("Goal closed. Its history stays."); } catch (e2) { console.error(e2); toast("That didn't save."); }
        } }, confirmClose === g.id ? "Tap again to close it for everyone" : "Close this goal")));
    });
    const addInput = h("input", { id: "addGoal", maxlength: "60", placeholder: "A new goal for everyone", "aria-label": "New goal" });
    let addCad = null;
    const addSel = cadenceSelect("addCad", null, (v) => { addCad = v; }, "How often for the new goal");
    return [
      h("h2", { id: "sheetTitle" }, ch.name),
      h("p", { class: "sub" }, `${fmtDay(ch.start, { month: "short", day: "numeric" })} – ${fmtDay(ch.end, { month: "short", day: "numeric", year: "numeric" })}`),
      owner ? ownerControls(ch) : null,
      owner && L.isLocked(ch, t) ? h("div", { class: "lockline" }, "You're the owner, so you can change anything here. Edits apply to everyone, and past days re-score on the live screens. Days already posted to the board keep their post.") : null,
      locked ? (() => { const l = h("div", { class: "lockline" }); l.innerHTML = SVG.lock; l.append("Goals are locked in. You can add a goal from today, or close one: it stops counting today and its history stays."); return l; })() : null,
      h("div", { style: "display:grid;gap:10px;margin-bottom:16px" }, items),
      h("div", { class: "field" }, h("label", { for: "addGoal" }, "Add a goal"), addInput, h("div", { style: "display:flex;gap:8px" }, addSel,
        h("button", { class: "mini-btn", type: "button", style: "min-height:50px;flex:none", onclick: async () => {
          const r = L.addGoalPatch(ch, addInput.value, t, Date.now(), addCad);
          if (r.error) return toast(r.error);
          try { await state.backend.mergeChallenge(ch.id, r.patch); toast(locked ? "Goal added. It counts from today." : "Goal added."); } catch (e2) { console.error(e2); toast("That didn't save."); }
        } }, "Add"))),
      owner ? recoverField(ch) : null,
      h("div", { class: "sheet-actions" }, closeBtn(), t > ch.end && !owner ? h("button", { class: "btn blaze", type: "button", onclick: openCreate }, "New challenge") : null),
    ];
  };
  openSheet(build);
  state._sheetRebuild = () => { if (sheet.open && state._sheetIs === "settings") openSheet(build); };
  state._sheetIs = "settings";
}

function openMembers() {
  state._sheetIs = "members";
  const build = () => {
    const emails = (state.members?.emails || []).slice();
    const input = h("input", { id: "addEmail", type: "email", autocomplete: "off", placeholder: "their.google@gmail.com", "aria-label": "Google email to add" });
    return [
      h("h2", { id: "sheetTitle" }, "The group"),
      h("p", { class: "sub" }, "Only these Google accounts can open the page. Removing someone keeps their past checks."),
      h("ul", { class: "who-list" }, emails.map((em) => h("li", {}, h("span", {}, em), em === state.user.email ? h("small", { style: "color:var(--muted)" }, "you") :
        h("button", { class: "mini-btn danger", type: "button", onclick: async () => {
          try { await state.backend.setMembers(emails.filter((x) => x !== em)); toast("Removed."); openSheet(build); } catch (e) { console.error(e); toast("That didn't save."); }
        } }, "Remove")))),
      h("div", { class: "field" }, h("label", { for: "addEmail" }, "Add someone"), h("div", { style: "display:flex;gap:8px" }, input,
        h("button", { class: "mini-btn", type: "button", style: "min-height:50px", onclick: async () => {
          const em = input.value.trim().toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return toast("That doesn't look like an email.");
          if (emails.includes(em)) return toast("Already in.");
          try { await state.backend.setMembers(emails.concat(em)); toast("Added. Send them the link."); openSheet(build); } catch (e) { console.error(e); toast("That didn't save."); }
        } }, "Add"))),
      h("div", { class: "sheet-actions" }, h("button", { class: "btn ghost", type: "button", onclick: () => openSettings(state._settingsId) }, "Back")),
    ];
  };
  openSheet(build);
}
sheet.addEventListener("close", () => { state._sheetIs = null; });

// ---------- daily board posting (idempotent: results/<date> is create-only) ----------
async function postDueResults() {
  if (state.posting || !state.players || !state.challenges || !state.results) return;
  const ch = defaultChallenge(); // the board posts for the live challenge, whatever is on screen
  if (!ch) return;
  const due = L.resultsDue(ch, Object.keys(state.results), now(), 7);
  if (!due.length) return;
  state.posting = true;
  for (const d of due) {
    try { await state.backend.createResult(L.resultId(d), L.buildResult(state.players, ch, d, now())); } catch (e) { console.error(e); }
  }
  state.posting = false;
}

// ---------- boot ----------
async function refreshMembership() {
  state.ms = await state.backend.membership(state.user);
  render();
  if (state.ms.member && !state.ms.setupNeeded) subscribe();
}

function subscribe() {
  if (state.unsubs.length) return;
  for (const coll of ["players", "challenges", "results", "members", "chat"]) {
    state.unsubs.push(state.backend.watch(coll, (data) => {
      state[coll] = data;
      render();
      if (state._sheetIs === "settings") state._sheetRebuild?.();
      postDueResults();
    }, (e) => { console.error(e); toast("Lost the connection. It'll catch up when you're back online."); }));
  }
}

function unsubscribe() { state.unsubs.forEach((u) => u && u()); state.unsubs = []; state.players = state.challenges = state.results = state.members = null; state.chat = {}; }

// Roll the day (and the noon close) without a reload.
setInterval(() => {
  const d = today(), f = L.pacificHour(now()) >= L.FINAL_HOUR;
  if (d !== state.lastDay || f !== state.lastFinal) { state.lastDay = d; state.lastFinal = f; if (state.players) { render(); postDueResults(); } }
}, 30000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && state.players) { render(); postDueResults(); } });

async function boot() {
  const params = new URLSearchParams(location.search);
  const demo = params.get("demo");
  try {
    if (demo) {
      const { createDemoBackend } = await import("./backend-demo.js");
      state.backend = createDemoBackend(demo, { latency: Number(params.get("latency") || 120) });
    } else if (window.DD_FIREBASE) {
      const { createFirebaseBackend } = await import("./backend-firebase.js");
      state.backend = createFirebaseBackend(window.DD_FIREBASE);
    } else {
      return render();
    }
    await state.backend.init();
  } catch (e) {
    console.error(e);
    app.replaceChildren(h("section", { class: "gate" }, h("h1", { class: "big" }, "Can't", h("span", {}, "connect")),
      h("p", {}, "The page couldn't reach its database. Check your connection and reload."),
      h("button", { class: "btn", type: "button", onclick: () => location.reload() }, "Reload")));
    return;
  }
  state.lastDay = today(); state.lastFinal = L.pacificHour(now()) >= L.FINAL_HOUR;
  state.backend.onAuth(async (u) => {
    state.user = u;
    state.ms = null;
    unsubscribe();
    render();
    if (u) { try { await refreshMembership(); } catch (e) { console.error(e); toast("Couldn't check the group list. Reload to try again."); } }
  });
}
state.user = undefined;
boot();
