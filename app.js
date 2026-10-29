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
  // An open sheet is a modal dialog in the browser's top layer: anything outside it, this toast included, sits
  // behind it. Move the toast into the sheet while it's open, and back out after.
  const host = sheet.open ? sheet : document.body;
  if (t.parentElement !== host) host.append(t);
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
    const sa = L.dayScore(state.players[a], L.chFor(ch, a), date), sb = L.dayScore(state.players[b], L.chFor(ch, b), date);
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
  $("#helpBtn").hidden = !s.backend;
  if (!s.backend) return renderNoConfig();
  if (needsInstallGate()) return renderInstallGate();
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
    potStrip(ch),
    h("img", { class: "brand-hero small", src: "logo-hero.webp", alt: "Alpha Pack", width: "720", height: "582" }),
    welcomeCard(),
    installCard(),
    quickLinks(),
    t < ch.start ? renderUpcoming(ch) : t > ch.end ? renderFinished(ch) : renderYou(ch),
    state.chId ? null : renderUpNext(ch),
    t < ch.start ? renderSignoff(ch) : null,
    renderPot(ch),
    renderPackPoints(ch),
    renderPack(ch),
    renderChat(),
    renderGrid(ch),
    renderBoard(ch),
    renderFoot(),
  ].filter(Boolean));
}

const DEV_SCENES = [["season1", "Season 1: you, the owner (send the invite)"], ["invited", "Season 1: a new player, from the invite"], ["active", "Mid-challenge (owner)"], ["goalcheck", "Before the start (owner)"], ["goalcheckm", "Before the start (player)"],
  ["pardon", "Pardon vote"], ["treasurer", "Treasurer (owner view)"], ["treasurerm", "Treasurer (his view)"], ["over", "Finished, settle the pot"],
  ["member", "A player, not the owner"], ["empty", "Brand-new player"], ["signedout", "Signed out"]];
function demoBanner() {
  if (window.DD_DEV) {
    const cur = new URLSearchParams(location.search).get("demo") || "season1";
    return h("div", { class: "dev-bar", role: "note" }, h("b", {}, "DEV PREVIEW"), " · sample players, nothing is saved. Check it, then tell Leo \u201cship it\u201d.",
      h("label", { class: "tlabel", for: "devScene", style: "display:block;margin-top:8px" }, "Try a situation"),
      (() => { const sel = h("select", { id: "devScene", class: "cad", onchange: (e) => { location.search = "?demo=" + e.target.value; } },
        DEV_SCENES.map(([v, label]) => h("option", { value: v }, label))); sel.value = cur; return sel; })(),
      cur === "invited" && !state.user ? h("div", { class: "dev-sms" }, h("small", {}, "The text they get from you:"), h("p", {}, inviteText())) : null,
      cur === "invited" ? h("p", { class: "seg-note" }, state.user ? "You're signed in as a new player. Pick a name, set goals, then vote on the others in Goal check." : "Tap Sign in with Google below. It's fake here: no Google account, nothing saved.") : null);
  }
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

// New people on a phone put it on the home screen BEFORE signing in (Jason 2026-10-29). On iPhone the home-screen app
// doesn't share Safari's sign-in, so this order saves them signing in twice. Opening from the home screen
// (standalone) is the proof: no checkbox to fake. A player already signed in is never gated. "Skip for now" is the escape hatch.
function needsInstallGate() {
  if (standalone() || seen("installSkip") || phone() === "other") return false;
  if (state.backend?.mode === "demo" && new URLSearchParams(location.search).get("demo") !== "invited") return false; // demo: only the new-player walkthrough
  return state.user === null || (state.ms?.member && state.players && !me());
}
function inAppBrowser() { return /FBAN|FBAV|Instagram|Line\/|LinkedInApp|Snapchat|GSA\//.test(navigator.userAgent); }
function renderInstallGate() {
  const kind = phone();
  gate(null, "Step 1 of 2: put Alpha Pack on your home screen. It opens like an app, and you'll sign in there.",
    inAppBrowser() ? h("p", { class: "callout" }, h("b", {}, "First, open this in " + (kind === "ios" ? "Safari" : "Chrome") + ". "), "You're inside another app's browser, which can't add to the home screen. Tap the ⋯ or share menu and choose \u201cOpen in " + (kind === "ios" ? "Safari" : "Chrome") + "\u201d.") : null,
    h("div", { class: "callout install-gate" }, h("h2", {}, kind === "ios" ? "On your iPhone" : "On your Android"),
      h("ol", { class: "steps" }, STEPS[kind].slice(0, 3).map((x) => h("li", {}, x))),
      h("p", { class: "ig-next" }, h("b", {}, "Step 2: "), "close this, then open Alpha Pack from your home screen and sign in with Google.")),
    h("button", { class: "link-btn", type: "button", onclick: () => { markSeen("installSkip"); render(); } }, "Skip for now (I'll add it later)"));
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
    state.ms?.owner ? h("p", {}, "Set the first one: a name, the dates, and the goals everybody ticks each day.")
      : h("p", {}, "The owner sets it up. It'll show here the moment they do."),
    state.ms?.owner ? h("button", { class: "btn blaze", type: "button", onclick: openCreate }, "Set up a challenge") : null),
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
  ch = L.chFor(ch, state.user.uid); // the group's goals plus mine
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
    weekly.length ? h("div", { class: "wk-head" }, h("span", {}, "This week"), h("small", {}, `${wk.met} of ${wk.of} met · resets ${fmtDay(L.addDays(L.weekStart(date, ch), 7), { weekday: "long" })}`)) : null,
    weekly.length ? h("ul", { class: "goals" }, weekly.map((g) => goalRow(ch, p, g, date, t))) : null,
    off ? h("p", { class: "empty" }, h("b", {}, "Day off. "), "Nothing counts today, and every streak picks up where it left off.") :
      !goals.length && !weekly.length ? h("p", { class: "empty" }, h("b", {}, "You have no goals. "), "Add yours under Edit goals. With none, every day counts as a strike.") : null,
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
  const small = [target ? `Your target: ${target}` : null, L.cadenceLabel(g)].filter(Boolean).join(" · "); // every goal says how often, daily ones too
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
  ch = L.chFor(ch, state.user.uid);
  const goals = L.goalList(ch).filter((g) => !g.closedOn);
  return h("section", { class: "you" },
    h("div", { class: "you-head" }, h("div", { class: "you-title" }, h("h1", {}, ch.name),
      h("p", {}, `Starts ${fmtDay(ch.start, { weekday: "long", month: "short", day: "numeric" })}. Set your own goals before then. They lock when it starts.`))),
    goals.length ? h("div", { class: "lockline", role: "note" }, `These are your goals. You can tick them from ${fmtDay(ch.start, { weekday: "long" })}. Everyone can see everyone's goals in the Goal check below.`) : null,
    goals.length ? h("ul", { class: "goals" }, goals.map((g) => h("li", {}, h("div", { class: "goal", "aria-disabled": "true" },
      h("span", { class: "box" }), h("span", { class: "goal-text" }, h("strong", {}, g.text), h("small", {}, [g.personal ? "Yours" : "Group goal", L.cadenceLabel(g), !g.personal && me().targets?.[g.id] ? `Your target: ${me().targets[g.id]}` : null].filter(Boolean).join(" · ")))))))
      : h("p", { class: "empty" }, h("b", {}, "You haven't set any goals yet. "), "Anything counts: read a chapter, pray, practice an instrument, lift, eat clean. With none, every day is a strike."),
    h("div", { class: "you-foot" }, h("span", { class: "foot-note" }, (() => { const n = goals.filter((g) => g.personal).length; return n ? `${n} goal${n === 1 ? "" : "s"} of your own · up to ${L.MAX_PERSONAL}` : "No goals of your own yet"; })()), h("button", { class: "link-btn", type: "button", onclick: openSettings }, goals.length ? "Edit goals" : "Set your goals")));
}

function renderFinished(ch) {
  const ids = Object.keys(state.players);
  const days = [];
  for (let d = ch.start; d <= ch.end; d = L.addDays(d, 1)) days.push(d);
  const totals = ids.map((uid) => {
    const p = state.players[uid];
    const pc = L.chFor(ch, uid);
    const sc = days.map((d) => L.dayScore(p, pc, d)).filter((s) => s.of);
    const pct = sc.length ? Math.round(sc.reduce((a, s) => a + s.pct, 0) / sc.length) : 0;
    return { uid, name: p.name, pct, perfect: sc.filter((s) => s.perfect).length };
  }).sort((a, b) => b.pct - a.pct);
  return h("section", { class: "post" }, h("h3", {}, `${ch.name} · final`, h("small", {}, `${fmtDay(ch.start)} – ${fmtDay(ch.end)}`)),
    h("ol", {}, totals.map((r, i) => h("li", { class: i === 0 ? "top" : null }, h("span", { class: "rank" }, String(i + 1)),
      h("div", {}, h("span", { class: "nm" }, r.name), r.perfect ? h("span", { class: "badge" }, `${r.perfect} perfect`) : null, h("div", { class: "bar" }, h("i", { style: `width:${r.pct}%` }))),
      h("span", { class: "pct" }, `${r.pct}%`)))),
    state.ms?.owner ? h("div", { class: "sheet-actions" }, h("button", { class: "btn blaze", type: "button", onclick: openCreate }, "Start the next challenge")) : null);
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

// Eyes on the prize (Jason 2026-10-29): the pot first thing on screen, one line, tap to jump to the full pot.
function potStrip(ch) {
  const st = L.potStatus(state.players, ch, now());
  if (!st) return null;
  const mine = st.rows.find((r) => r.uid === state.user.uid);
  const you = !mine ? null : mine.out ? (mine.comeback ? "you: on a comeback" : "you: out") : `you: ${mine.strikes} of ${st.limit} strike${st.limit === 1 ? "" : "s"}`;
  const each = st.settled ? "settled" : st.refund ? "everyone's out" : `${money(st.share)} each${st.final ? "" : " if it ended now"}`;
  return h("button", { class: "pot-strip", type: "button", onclick: () => document.getElementById("potH")?.scrollIntoView({ behavior: "smooth", block: "start" }) },
    h("span", { class: "ps-amt" }, money(st.pot)), h("span", { class: "ps-txt" }, `pot · ${each}`, you ? h("small", {}, you) : null), h("span", { class: "ps-go", "aria-hidden": "true" }, "›"));
}

// The pot: play money. Everyone on the board is in for the buy-in; strikes knock people out; survivors split it.
// Out at the limit with a comeback on: finish without another strike and get the comeback back (never a share).
function strikeLabel(ch, s) {
  if (s.kind === "week") return `Week ending ${fmtDay(s.date)} · ${ch.goals?.[s.goalId]?.text || "a weekly goal"}`;
  return `${fmtDay(s.date)} · not every daily goal done`;
}
function voteLine(pd) { return `${pd.yes} of ${pd.need} yes${pd.no ? ` · ${pd.no} no` : ""}`; }

function renderPot(ch) {
  const st = L.potStatus(state.players, ch, now());
  if (!st) return null;
  const strikeDots = (n) => h("span", { class: "strikes", "aria-label": `${n} of ${st.limit} strikes` }, `${n}/${st.limit}`,
    ...Array.from({ length: st.limit }, (_, i) => h("i", { class: i < n ? "on" : "" })));
  const each = st.final
    ? (st.refund ? ["Nobody made it", h("small", {}, `Everyone gets their ${money(st.buyIn)} back`)] : [`${money(st.share)} each`, h("small", {}, `${st.alive} made it to the end` + (st.comebacks ? ` · ${st.comebacks} comeback${st.comebacks === 1 ? "" : "s"} get ${money(st.comeback)}` : ""))])
    : (st.refund ? ["Everyone's out", h("small", {}, `If it ended now, everyone gets ${money(st.buyIn)} back`)] : [`${money(st.share)} each`, h("small", {}, `if it ended now · ${st.alive} still in`)]);
  const chip = (r) => !r.out ? strikeDots(r.strikes)
    : r.comeback ? h("span", { class: "out-chip comeback", title: `Finish without another strike to get ${money(st.comeback)} back` }, "COMEBACK")
    : h("span", { class: "out-chip" }, "OUT");
  return h("section", { "aria-labelledby": "potH" },
    h("div", { class: "sec-head" }, h("h2", { id: "potH" }, st.settled ? "The Pot · settled" : st.final ? "The Pot · final" : "The Pot"),
      h("span", { class: "note" }, `${money(st.buyIn)} in · out at ${st.limit}` + (st.comeback ? ` · comeback ${money(st.comeback)}` : ""))),
    h("div", { class: "pot" },
      h("div", { class: "pot-top" }, h("div", { class: "pot-amt" }, money(st.pot), h("small", {}, `${st.paid} of ${st.rows.length} paid`)), h("div", { class: "pot-each" }, ...each)),
      h("ol", { class: "pot-rows" }, st.rows.map((r) => h("li", { class: r.out ? (r.comeback ? "out cb" : "out") : null },
        h("span", {}, h("b", {}, r.uid === state.user.uid ? "You" : r.name), r.paid ? h("small", { class: "paid" }, " · paid") : null),
        chip(r)))),
      payLine(ch, st),
      renderPardons(ch, st),
      settleBlock(ch, st),
      help("How the pot works", [
        `Everyone on the board is in for ${money(st.buyIn)}. Pay whoever's holding the money. The app never touches it.`,
        "A strike is a day you didn't finish every daily goal, or a weekly goal you came up short on. A day counts at noon the next day, so you have the morning to fix your ticks. Days off never count.",
        `${st.limit} strike${st.limit === 1 ? "" : "s"} and you're out. The players still in split the pot at the end. If nobody makes it, everyone gets their money back.`,
        st.comeback ? `Comeback: once you're out, keep going. Finish without another strike and you get ${money(st.comeback)} back. You can't win the pot that way, but it cuts your loss.` : null,
        "Pardon: had a real reason? Ask for a pardon on that strike. If more than half of the other players vote yes, it's wiped. Votes stay open until the owner settles the pot.",
        "Settling: after the last day locks, the owner settles the pot. That locks every payout for good.",
      ])));
}

// Before the start: everyone's own goals, and a yes/no from the rest of the pack on each list. Keeps "one easy goal"
// out: a list counts as approved once more than half of the others say yes (or the owner does). Edit a goal and the
// votes on it reset, because the list they approved is gone.
function renderSignoff(ch) {
  const uid = state.user.uid;
  const owner = !!state.ms?.owner;
  const ids = Object.keys(state.players || {}).sort((a, b) => (a === uid ? -1 : b === uid ? 1 : (state.players[a].name || "").localeCompare(state.players[b].name || "")));
  const myVotes = me()?.votes || {};
  const rows = ids.map((pid) => {
    const p = state.players[pid];
    const so = L.signoffFor(state.players, ch, pid);
    const goals = L.goalList(L.ownView(ch, pid)).filter((g) => !(g.closedOn && g.closedOn <= ch.start));
    const isMe = pid === uid;
    const status = !so.enough ? h("span", { class: "pd-state warn" }, `${so.count} of ${so.min} goals set`)
      : so.approved ? h("span", { class: "pd-state ok" }, so.byOwner ? "✓ Approved by the owner" : `✓ Approved · ${so.yes} of ${so.need} yes`)
      : h("span", { class: "pd-state" }, `Waiting · ${so.yes} of ${so.need} yes${so.no ? ` · ${so.no} no` : ""}`);
    const v = myVotes[so.key];
    const cast = (yes) => async () => {
      try { await state.backend.mergePlayer(uid, L.signoffVotePatch(so.key, yes).patch); toast(yes ? `You approved ${p.name}'s goals.` : `You said no to ${p.name}'s goals. Tell him why in Trash Talk.`); }
      catch (e) { console.error(e); toast("That didn't save."); }
    };
    const votes = isMe || !so.enough ? null : h("span", { class: "pd-act" },
      h("button", { class: "mini-btn" + (v === true ? " on" : ""), type: "button", "aria-pressed": String(v === true), onclick: cast(true) }, "Fair"),
      h("button", { class: "mini-btn" + (v === false ? " on-no" : ""), type: "button", "aria-pressed": String(v === false), onclick: cast(false) }, "Too easy"));
    // The owner approves a list outright, or takes it back. Editing a goal also drops it (the approval is tied to the list).
    const ownerBtn = owner && so.enough ? h("button", { class: "link-btn", type: "button", onclick: async () => {
      const on = !so.byOwner;
      try { await state.backend.mergeChallenge(ch.id, L.ownerSignoffPatch(ch, pid, on).patch); toast(on ? `Approved ${isMe ? "your" : p.name + "'s"} goals as the owner.` : `Owner approval taken back for ${isMe ? "your" : p.name + "'s"} goals.`); } catch (e) { console.error(e); toast("That didn't save."); }
    } }, so.byOwner ? "Undo owner approval" : "Approve as owner") : null;
    return h("li", { class: so.approved ? "pardoned" : null },
      h("div", { class: "pd-what" }, h("b", {}, isMe ? "Your goals" : `${p.name || "Player"}'s goals`),
        goals.length ? h("ul", { class: "so-goals" }, goals.map((g) => h("li", {}, g.text, h("small", {}, ` · ${L.cadenceLabel(g)}`))))
          : h("small", {}, isMe ? "None yet. Add yours under Edit goals." : "None yet.")),
      h("div", { class: "pd-act so-act" }, status, votes, ownerBtn, isMe ? h("button", { class: "mini-btn", type: "button", onclick: openSettings }, so.count ? "Edit goals" : "Set your goals") : null));
  });
  const so = L.signoffFor(state.players, ch, uid);
  return h("section", { "aria-labelledby": "soH" },
    h("div", { class: "sec-head" }, h("h2", { id: "soH" }, "Goal check"), h("span", { class: "note" }, `Before ${fmtDay(ch.start, { weekday: "long" })}`)),
    h("div", { class: "pot so" },
      h("p", { class: "so-lead" }, !so.enough ? h("b", {}, `Set at least ${so.min} goals. `) : so.approved ? h("b", {}, "Your goals are approved. ") : h("b", {}, "Your goals are waiting on the pack. "),
        "Then tap Fair or Too easy on everyone else's list."),
      h("ul", { class: "pd-block so-list" }, rows),
      help("Why a goal check?", [
        "Everyone picks their own goals, so someone could pick easy ones. The pack keeps it fair.",
        `Each list needs at least ${so.min} goals. A day with fewer counts as a strike.`,
        "Fair = the list is a real challenge for him. Too easy = it isn't. Say why in Trash Talk.",
        "Not approved by the start? The owner decides.",
      ])));
}

// Pack goals: group goals score the pack together. Tallied from everyone's ticks, nothing to enter.
function renderPackPoints(ch) {
  const gs = L.groupScore(state.players, ch, now());
  if (!gs) return null;
  const started = today() >= ch.start;
  return h("section", { "aria-labelledby": "ppH" },
    h("div", { class: "sec-head" }, h("h2", { id: "ppH" }, "Pack goals"), h("span", { class: "note" }, "Everyone has to hit these")),
    h("div", { class: "pp" },
      h("div", { class: "pot-top" }, h("div", { class: "pot-amt" }, String(gs.total), h("small", {}, gs.possible ? `pack point${gs.total === 1 ? "" : "s"} of ${gs.possible}` : "pack points")),
        h("div", { class: "pot-each" }, started ? "One point for every day or week the whole pack hits a group goal." : `Scoring starts ${fmtDay(ch.start, { weekday: "long" })}.`)),
      h("ul", { class: "pp-list" }, gs.goals.map((g) => h("li", {},
        h("div", { class: "pp-head" }, h("b", {}, g.text), h("small", {}, ` · ${g.cadence}`), h("span", { class: "pp-pts" }, `${g.points} pt${g.points === 1 ? "" : "s"}`)),
        g.current ? h("p", { class: "pp-now" }, `${g.current.label[0].toUpperCase()}${g.current.label.slice(1)}: ${g.current.done} of ${g.current.of} there`,
          g.current.behind.length ? h("span", {}, (g.weekly ? " · " : " · still to go: ") + g.current.behind.map((x) => { const me = x.uid === state.user.uid; return `${me ? "you" : x.name}${g.weekly ? ` ${me ? "need" : "needs"} ${x.left} more` : ""}`; }).join(", ")) : h("span", { class: "ok" }, " · the whole pack!")) : null))),
      help("How pack goals work", [
        "A group goal is on everyone's list. It also scores the pack as a team.",
        "Daily group goal: 1 pack point for each day everyone did it. Weekly: 1 point for each week everyone hit the target.",
        "It counts itself from everyone's ticks once the day or week locks. Days off and days before someone joined don't count against the pack.",
        "Pack points are bragging rights for now. They don't change the pot.",
      ])));
}

// Settling: the owner freezes the payouts once the last day locks. Before that, everyone sees it's pending.
function settleBlock(ch, st) {
  const owner = !!state.ms?.owner;
  if (st.settled) {
    const me = st.rows.find((r) => r.uid === state.user.uid);
    return h("div", { class: "settle done" },
      h("p", {}, h("b", {}, "Settled. Payouts are locked."), me ? ` You get ${money(me.payout)}.` : ""),
      h("ul", { class: "payouts" }, st.rows.map((r) => h("li", {}, h("span", {}, r.uid === state.user.uid ? "You" : r.name), h("b", {}, money(r.payout))))),
      owner ? h("button", { class: "link-btn", type: "button", onclick: async () => {
        if (state.confirmUnsettle !== ch.id) { state.confirmUnsettle = ch.id; render(); return; }
        state.confirmUnsettle = null;
        try { await state.backend.mergeChallenge(ch.id, L.unsettlePatch().patch); toast("Unlocked. Votes are open again."); } catch (e) { console.error(e); toast("That didn't save."); }
      } }, state.confirmUnsettle === ch.id ? "Tap again to unlock it" : "Unlock (fix a mistake)") : null);
  }
  if (!st.final) return null;
  if (!owner) return h("p", { class: "settle" }, "It's over. Pardon votes stay open until the owner settles the pot, then payouts lock.");
  return h("div", { class: "settle" },
    h("p", {}, "It's over. Give everyone a chance to vote on last-day pardons, then settle. Settling locks every payout."),
    h("button", { class: "btn blaze", type: "button", onclick: async () => {
      if (state.confirmSettle !== ch.id) { state.confirmSettle = ch.id; render(); return; }
      state.confirmSettle = null;
      const r = L.settlePatch(st, now());
      if (r.error) return toast(r.error);
      try { await state.backend.mergeChallenge(ch.id, r.patch); toast("Settled. Payouts are locked."); } catch (e) { console.error(e); toast("That didn't save."); }
    } }, state.confirmSettle === ch.id ? "Tap again to lock the payouts" : "Settle the pot"));
}

// Only https links become buttons; the text is the owner's, but never trust it as a scheme (no javascript:).
function payUrl(how) {
  const m = /https:\/\/[^\s]+/.exec(how || "");
  if (!m) return null;
  try { const u = new URL(m[0]); return u.protocol === "https:" ? u.href : null; } catch { return null; }
}

// Who to pay, for everyone; and the treasurer's checklist right in the pot (they may have no menu powers otherwise).
function payLine(ch, st) {
  const t = L.treasurerOf(ch);
  const owner = !!state.ms?.owner;
  if (!t) return owner ? h("p", { class: "pay-line" }, h("b", {}, "No treasurer yet. "), "Pick one under Owner settings, The pot.") : null;
  const name = state.players?.[t]?.name || "the treasurer";
  const mine = st.rows.find((r) => r.uid === state.user.uid);
  const isT = t === state.user.uid;
  const how = ch.pot?.payHow;
  return h("div", { class: "pay-line" },
    h("p", {}, h("b", {}, isT ? "You're the treasurer. " : `Treasurer: ${name}. `),
      isT ? "You hold the money and mark who paid below." : mine && !mine.paid ? [`Pay ${money(st.buyIn)} to ${name}`, how && !payUrl(how) ? ` · ${how}` : "", "."] : mine?.paid ? "You're paid up." : ""),
    // A link (Venmo, Cash App, PayPal) becomes one tap to pay; anything else stays as text above.
    payUrl(how) && !isT && mine && !mine.paid ? h("a", { class: "btn blaze pay-btn", href: payUrl(how), target: "_blank", rel: "noopener noreferrer" }, `Pay ${name} ${money(st.buyIn)}`) : null,
    isT && !st.settled ? h("details", { class: "help", open: true }, h("summary", {}, h("span", { class: "help-q", "aria-hidden": "true" }, "$"), "Mark who paid"),
      paidList(ch, Object.keys(state.players || {}).sort((a, b) => (state.players[a].name || "").localeCompare(state.players[b].name || "")))) : null);
}

// Pardons: ask on your own strikes; vote on everyone else's asks. Closed once the challenge is final.
function renderPardons(ch, st) {
  const meRow = st.rows.find((r) => r.uid === state.user.uid);
  const open = !st.settled; // votes run past the last day, until the owner settles
  const mine = (meRow?.list || []).map((s) => {
    const pd = s.pardon;
    const status = pd.pardoned ? h("span", { class: "pd-state ok" }, "Pardoned")
      : pd.voters === 0 ? h("span", { class: "pd-state" }, "Nobody else to vote")
      : pd.asked ? h("span", { class: "pd-state" }, voteLine(pd)) : null;
    const btn = !open || pd.pardoned || pd.voters === 0 ? null : h("button", { class: "mini-btn" + (pd.asked ? " ghosty" : ""), type: "button", onclick: async () => {
      try { await state.backend.mergePlayer(state.user.uid, L.appealPatch(pd.key, !pd.asked).patch); toast(pd.asked ? "Ask taken back." : "Asked. The others can vote now."); }
      catch (e) { console.error(e); toast("That didn't save."); }
    } }, pd.asked ? "Take back" : "Ask for a pardon");
    return h("li", { class: pd.pardoned ? "pardoned" : null }, h("span", { class: "pd-what" }, strikeLabel(ch, s)), h("span", { class: "pd-act" }, status, btn));
  });
  const myVotes = me()?.votes || {};
  const asks = [];
  st.rows.filter((r) => r.uid !== state.user.uid).forEach((r) => r.list.forEach((s) => {
    if (s.pardon.asked && !s.pardon.pardoned) asks.push({ r, s });
  }));
  const voteBtns = ({ s }) => {
    const v = myVotes[s.pardon.key];
    const cast = (yes) => async () => {
      try { await state.backend.mergePlayer(state.user.uid, L.votePatch(s.pardon.key, yes).patch); toast(yes ? "Voted yes." : "Voted no."); }
      catch (e) { console.error(e); toast("That didn't save."); }
    };
    return h("span", { class: "pd-act" },
      h("button", { class: "mini-btn" + (v === true ? " on" : ""), type: "button", "aria-pressed": String(v === true), disabled: !open, onclick: cast(true) }, "Yes"),
      h("button", { class: "mini-btn" + (v === false ? " on-no" : ""), type: "button", "aria-pressed": String(v === false), disabled: !open, onclick: cast(false) }, "No"));
  };
  if (!mine.length && !asks.length) return null;
  return h("div", { class: "pardons" },
    asks.length ? h("div", { class: "pd-block" }, h("h3", {}, open ? "Vote on a pardon" : "Pardon asks"),
      h("ul", {}, asks.map((a) => h("li", {}, h("span", { class: "pd-what" }, h("b", {}, a.r.name), ` asks: ${strikeLabel(ch, a.s)}`, h("small", {}, voteLine(a.s.pardon))), voteBtns(a))))) : null,
    mine.length ? h("div", { class: "pd-block" }, h("h3", {}, "Your strikes"), h("ul", {}, mine)) : null);
}

// A tap-to-open explainer. Plain words, one idea per line.
function help(title, lines) {
  return h("details", { class: "help" }, h("summary", {}, h("span", { class: "help-q", "aria-hidden": "true" }, "?"), title),
    h("ul", {}, lines.filter(Boolean).map((l) => h("li", {}, l))));
}

// One player's dog tag. ch is that player's view (group goals plus their own); chAll is the challenge itself.
function packTag(ch, chAll, uid, date, t) {
  const p = state.players[uid];
  const goals = L.dailyGoals(ch, date);
  const weekly = L.weeklyGoals(ch, date);
  const s = L.dayScore(p, ch, date);
  const open = state.expanded.has(uid);
  const isMe = uid === state.user.uid;
  const ps = L.perfectStreak(p, ch, date);
  const off = L.isSkip(ch, date);
  const potRow = L.potStatus(state.players, chAll, now())?.rows.find((r) => r.uid === uid);
  const detailId = "tagd-" + uid.replace(/[^a-zA-Z0-9_-]/g, "");
  return h("article", { class: "tag" + (isMe ? " me" : "") },
    h("button", { class: "tag-btn", type: "button", "aria-expanded": String(open), "aria-controls": detailId, onclick: () => { open ? state.expanded.delete(uid) : state.expanded.add(uid); render(); } },
      h("div", { class: "tag-row" },
        h("div", { class: "tag-name" }, h("b", {}, p.name || "Player"), h("span", {}, potRow?.out ? (potRow.comeback ? (isMe ? "You · on a comeback" : "On a comeback") : isMe ? "You · out of the pot" : "Out of the pot") : isMe ? "You" : off ? "Day off" : ps ? `${ps} perfect day${ps === 1 ? "" : "s"} in a row` : s.hit ? `${s.of - s.hit} to go today` : "Nothing ticked yet today")),
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
}

function renderPack(ch) {
  const t = today();
  const date = L.inChallenge(ch, t) ? t : t > ch.end ? ch.end : ch.start;
  const ids = packOrder(ch, date);
  const tags = ids.map((uid) => packTag(L.chFor(ch, uid), ch, uid, date, t));
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
      const s = L.dayScore(p, L.chFor(ch, uid), d);
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
  return h("article", { class: "post" + (live ? " live" : "") },
    h("h3", {}, h("span", {}, fmtDay(r.date), live ? h("span", { class: "live-chip" }, "Live") : null),
      h("small", {}, live ? "Open · still ticking" : `Day ${L.dayNumber(ch, r.date)}`)),
    h("ol", {}, (r.rows || []).map((row, i) => h("li", { class: i === 0 && row.pct > 0 ? "top" : null },
      h("span", { class: "rank" }, String(i + 1)),
      h("div", {}, h("span", { class: "nm" }, row.name), row.perfect ? h("span", { class: "badge" }, "Perfect") : null, h("div", { class: "bar" }, h("i", { style: `width:${row.pct}%` }))),
      h("span", { class: "pct" }, row.of ? `${row.hit}/${row.of}` : "", row.wkOf ? h("small", { class: "wkn" }, `wk ${row.wkMet}/${row.wkOf}`) : null)))));
}

// Every day on the board is scored from everyone's ticks, so an owner's tick fix shows by itself.
function renderBoard(ch) {
  const t = today();
  // Every final day of this challenge, newest first, scored from the ticks. Results docs aren't read at all, so a post
  // made under another (copycat) challenge, or with made-up rows, can't hide or fake a day.
  const finals = [];
  for (let d = (t < ch.end ? t : ch.end); d >= ch.start && finals.length < 400; d = L.addDays(d, -1)) {
    if (L.isFinal(d, now(), ch) && !L.isSkip(ch, d)) finals.push(d);
  }
  const live = L.editableDates(ch, now()).filter((d) => !L.isSkip(ch, d)).map((d) => L.buildResult(state.players, ch, d, now()));
  const limit = state.boardLimit || 3;
  const shown = finals.slice(0, limit);
  const head = h("div", { class: "sec-head" }, h("h2", { id: "boardH" }, "Daily Board"), h("span", { class: "note" }, "Live all day · locks at noon next day"));
  if (!live.length && !shown.length) {
    const msg = t < ch.start ? [h("b", {}, `Scores start ${fmtDay(ch.start, { weekday: "long" })}. `), "The board goes live the moment anyone ticks."]
      : [h("b", {}, "Nothing to show yet. "), "The board fills in as the pack ticks."];
    return h("section", { "aria-labelledby": "boardH" }, head, h("p", { class: "empty" }, ...msg));
  }
  const more = finals.length - shown.length;
  return h("section", { "aria-labelledby": "boardH" }, head, h("div", { class: "board" },
    live.map((r) => boardPost(ch, r, true)), shown.map((d) => boardPost(ch, L.buildResult(state.players, ch, d, now()), false)),
    more > 0 ? h("button", { class: "mini-btn more", type: "button", onclick: () => { state.boardLimit = limit + 30; render(); } }, `Show ${Math.min(more, 30)} older`) : null));
}

function renderFoot() {
  return h("p", { class: "fine", style: "color:var(--muted);font-size:13px;text-align:center;margin:0" },
    state.user?.email ? `Signed in as ${state.user.email} · ` : "",
    h("button", { class: "link-btn", type: "button", onclick: () => state.backend.signOut() }, "Sign out"));
}

// Owner only: correct a teammate's ticks on any day of the challenge.
// Creator only: change another player's own goals, before or after the start (Jason 2026-10-29).
function ownerGoalsFor(ch, uid, p) {
  const t = today();
  const started = L.isLocked(ch, t);
  const view = L.ownView(ch, uid);
  const goals = L.goalList(view).filter((g) => !(g.closedOn && g.closedOn <= g.addedOn));
  const save = async (patch, ok) => { try { await state.backend.mergeChallenge(ch.id, patch); toast(ok); } catch (e) { console.error(e); toast("That didn't save."); } };
  const key = uid.replace(/[^a-zA-Z0-9_-]/g, "");
  const add = h("input", { id: `oga-${key}`, "data-keep": true, autocomplete: "off", maxlength: "60", placeholder: "Add a goal for them…", "aria-label": `New goal for ${p.name}` });
  return h("div", { class: "owner-goals" }, h("span", { class: "tlabel" }, `Owner: ${p.name || "their"}'s goals`),
    goals.length ? h("ul", { class: "off-list" }, goals.map((g) => {
      const closed = !!g.closedOn && g.closedOn <= t;
      const text = h("input", { id: `ogt-${key}-${g.id}`, autocomplete: "off", maxlength: "60", value: g.text, "aria-label": `Goal for ${p.name}`, disabled: closed,
        onchange: (e) => { const r = L.ownPatch(uid, L.editGoalPatch(view, g.id, e.target.value, t, true)); if (r.error) return toast(r.error); save(r.patch, "Goal updated."); } });
      return h("li", {}, text, closed ? h("small", {}, "closed") : h("button", { class: "mini-btn danger", type: "button", style: "min-height:44px;flex:none", onclick: async () => {
        if (!started) { try { await state.backend.setOwnGoals(ch.id, uid, L.ownGoalsWithout(ch, uid, g.id)); toast("Goal removed."); } catch (e) { console.error(e); toast("That didn't save."); } return; }
        const r = L.ownPatch(uid, L.closeGoalPatch(view, g.id, t)); if (r.error) return toast(r.error); save(r.patch, "Goal closed. Its history stays.");
      } }, started ? "Close" : "Remove"));
    })) : h("small", {}, "No goals yet."),
    h("div", { style: "display:flex;gap:8px;margin-top:6px" }, add, h("button", { class: "mini-btn", type: "button", style: "min-height:44px;flex:none", onclick: async () => {
      const r = L.ownPatch(uid, L.addGoalPatch(view, add.value, t, Date.now(), null));
      if (r.error) return toast(r.error);
      add.value = "";
      save(r.patch, started ? "Goal added. It counts from today." : "Goal added.");
    } }, "Add")));
}

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
  return h("div", { class: "owner-edit" }, self ? null : ownerGoalsFor(ch, uid, p),
    days.length ? h("span", { class: "tlabel" }, self ? "Owner: fix your ticks" : "Owner: fix their ticks") : null, days.length ? sel : null,
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
  const wk = L.weeksOf(ch);
  const end = h("select", { id: "editWeeks", class: "cad", "aria-label": "How many weeks" },
    Number.isInteger(wk) ? null : h("option", { value: "" }, `Now ${L.challengeLength(ch)} days (not whole weeks)`),
    Array.from({ length: 12 }, (_, i) => h("option", { value: String(i + 1) }, `${i + 1} week${i ? "s" : ""}`)));
  end.value = Number.isInteger(wk) && wk >= 1 && wk <= 12 ? String(wk) : "";
  const endsOn = () => (L.isDate(start.value) && end.value ? L.endForWeeks(start.value, Number(end.value)) : ch.end);
  return h("div", { class: "field" }, h("label", {}, "Dates"),
    h("div", { class: "row2" }, h("div", {}, h("label", { class: "tlabel", for: "editStart" }, "Starts"), start), h("div", {}, h("label", { class: "tlabel", for: "editWeeks" }, "How long"), end)),
    h("button", { class: "mini-btn", type: "button", style: "min-height:44px;margin-top:8px", onclick: async () => {
      const r = L.datesPatch(ch, start.value, endsOn());
      if (r.error) return toast(r.error);
      try {
        await state.backend.mergeChallenge(ch.id, r.patch);
        state.viewDay = null;
        toast(`Dates saved: ${fmtDay(r.patch.start, { month: "short", day: "numeric" })} to ${fmtDay(r.patch.end, { month: "short", day: "numeric" })}.`);
      } catch (e2) { console.error(e2); toast("That didn't save."); }
    } }, "Save dates"),
    h("p", { class: "seg-note" }, "Whole weeks, so every week is a full 7 days. Start today or later. Once a day locks at noon the next day, only you can change its ticks."));
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
    minGoalsField(ch),
    houseRulesField(ch),
    backupsField(),
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
  const back = h("input", { id: "potComeback", type: "number", inputmode: "numeric", min: "0", max: "10000", step: "1", value: pot.comeback || "", placeholder: "0 = off", "aria-label": "Comeback, dollars back" });
  const ids = Object.keys(state.players || {}).sort((a, b) => (state.players[a].name || "").localeCompare(state.players[b].name || ""));
  return h("div", { class: "field" }, h("label", { for: "potBuyIn" }, "The pot"),
    h("div", { class: "row2" }, h("div", {}, h("label", { class: "tlabel", for: "potBuyIn" }, "Buy-in ($)"), buy), h("div", {}, h("label", { class: "tlabel", for: "potStrikes" }, "Strikes"), lim)),
    h("div", { style: "margin-top:8px" }, h("label", { class: "tlabel", for: "potComeback" }, "Comeback ($ back)"), back),
    h("button", { class: "mini-btn", type: "button", style: "min-height:44px;margin-top:8px", onclick: async () => {
      const r = L.potPatch(buy.value === "" ? 0 : buy.value, lim.value, back.value);
      if (r.error) return toast(r.error);
      const pp = r.patch.pot;
      try { await state.backend.mergeChallenge(ch.id, r.patch); toast(pp.buyIn ? `Pot on: ${money(pp.buyIn)} each, out at ${pp.strikes}` + (pp.comeback ? `, comeback ${money(pp.comeback)}.` : ".") : "Pot off."); }
      catch (e) { console.error(e); toast("That didn't save."); }
    } }, "Save pot"),
    pot.buyIn > 0 ? treasurerField(ch, ids) : null,
    pot.buyIn > 0 ? paidList(ch, ids) : null,
    h("p", { class: "seg-note" }, "Play money. Everyone on the board is in. Survivors split the pot evenly at the end; if nobody makes it, everyone gets their buy-in back. Comeback: what someone who's out gets back if they finish without another strike (up to the buy-in; 0 = off). Buy-in 0 turns the pot off."));
}

// Who holds the money. Separate from the owner on purpose: once someone else is treasurer, only they mark who paid.
function treasurerField(ch, ids) {
  const sel = h("select", { id: "potTreasurer", class: "cad", "aria-label": "Treasurer" },
    h("option", { value: "" }, "No treasurer yet"), ids.map((uid) => h("option", { value: uid }, (state.players[uid].name || "Player") + (uid === state.user.uid ? " (you)" : ""))));
  sel.value = L.treasurerOf(ch) || "";
  const how = h("input", { id: "potPayHow", autocomplete: "off", maxlength: String(L.MAX_PAYHOW), value: ch.pot?.payHow || "", placeholder: "e.g. Venmo @costa-d…", "aria-label": "How to pay the treasurer" });
  return h("div", { class: "treas" },
    h("label", { class: "tlabel", for: "potTreasurer" }, "Treasurer (holds the money)"), sel,
    h("label", { class: "tlabel", for: "potPayHow", style: "margin-top:8px;display:block" }, "How to pay them"), how,
    h("button", { class: "mini-btn", type: "button", style: "min-height:44px;margin-top:8px", onclick: async () => {
      const r = L.treasurerPatch(state.players, sel.value, how.value);
      if (r.error) return toast(r.error);
      const tu = r.patch.pot.treasurer;
      try { await state.backend.mergeChallenge(ch.id, r.patch); toast(tu ? `${tu === state.user.uid ? "You hold" : (state.players[tu]?.name || "They") + " holds"} the money and marks who paid.` : "No treasurer set."); }
      catch (e) { console.error(e); toast("That didn't save."); }
    } }, "Save treasurer"),
    h("p", { class: "seg-note" }, "Whoever holds the money marks who paid, and nobody else can, except you as creator."));
}

// Mark who paid. Two separate records, each with its own button showing its own value: the treasurer's confirmation
// (pot.paid) and, when someone else is treasurer, the owner's visible override (pot.ownerPaid). Paid = either one.
function paidList(ch, ids) {
  const pot = ch.pot || {};
  const t = L.treasurerOf(ch);
  // The creator ticks like the treasurer, unlabeled (Jason 2026-10-29: "hide the label").
  const iAmT = !t || t === state.user.uid || !!state.ms?.owner;
  return h("ul", { class: "off-list" }, ids.map((uid) => {
    const conf = pot.paid?.[uid] === true;
    const over = pot.ownerPaid?.[uid] === true;
    const name = state.players[uid].name || "Player";
    const confirmKey = `${ch.id}:${uid}`;
    const note = state.ms?.owner && conf && over && t && t !== state.user.uid ? " · marked by you" : iAmT ? "" : (conf ? " · treasurer confirmed" : "");
    const on = iAmT ? conf : over;
    const label = iAmT ? (conf ? "✓ Paid" : "Mark paid")
      : state.confirmOverride === confirmKey ? (over ? "Tap again: remove override" : "Tap again: override as owner")
      : over ? "✓ Owner override" : "Override: paid";
    const noteEl = note ? h("small", { class: iAmT ? "override" : "confirmed" }, note) : null;
    // The treasurer already confirmed: nothing for the owner to override.
    if (!iAmT && conf && !over) return h("li", {}, h("span", {}, name, noteEl), h("span", { class: "pd-state ok" }, "✓ Paid"));
    return h("li", {}, h("span", {}, name, noteEl),
      h("button", { class: "mini-btn" + (on ? " on" : ""), type: "button", "aria-pressed": String(on), style: "min-height:44px", onclick: async () => {
        if (!iAmT && state.confirmOverride !== confirmKey) { state.confirmOverride = confirmKey; render(); state._sheetRebuild?.(); return; }
        state.confirmOverride = null;
        // The creator's tick on someone else's watch also leaves a marker only the creator sees ("marked by you").
        const creatorTick = iAmT && !!state.ms?.owner && t && t !== state.user.uid;
        const r = iAmT ? L.paidPatch(uid, !conf) : L.ownerPaidPatch(uid, !over);
        if (creatorTick) r.patch.pot.ownerPaid = { [uid]: !conf };
        const msg = iAmT ? (conf ? `${name}: your confirmation removed.` : `${name}: paid, confirmed by you.`)
          : (over ? `Owner override removed for ${name}.` : `Owner override saved for ${name}. Everyone sees it.`);
        try { await state.backend.mergeChallenge(ch.id, r.patch); toast(msg); } catch (e) { console.error(e); toast("That didn't save."); }
      } }, label));
  }));
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
  // The sheet rebuilds whenever shared data changes (someone else ticks, votes, saves). Half-typed text in a
  // [data-keep] field survives that, and so does focus; otherwise other people's activity wipes what you're typing.
  const kept = sheet.open ? [...body.querySelectorAll("[data-keep]")].filter((el) => el.id && el.value).map((el) => [el.id, el.value]) : [];
  const focused = sheet.open && document.activeElement && body.contains(document.activeElement) ? document.activeElement.id : null;
  body.replaceChildren(h("div", { class: "grab", "aria-hidden": "true" }), ...build().filter(Boolean)); // builders return null for hidden parts
  for (const [id, v] of kept) { const el = document.getElementById(id); if (el && !el.value) el.value = v; }
  if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
  if (!sheet.open) sheet.showModal();
}
sheet.addEventListener("click", (e) => { if (e.target === sheet) sheet.close(); });
$("#menuBtn").addEventListener("click", openSettings);
$("#helpBtn").addEventListener("click", () => openHelp());
$("#dayChip").addEventListener("click", openChallenges);

function closeBtn() { return h("button", { class: "btn ghost", type: "button", onclick: () => sheet.close() }, "Done"); }

function openCreate() {
  const t = today();
  state._handoffFor = null;
  const goals = []; // group goals are optional: by default everyone sets their own
  let errors = {};
  const build = () => {
    const name = h("input", { id: "chName", maxlength: "60", placeholder: "Fall Cut", value: state._draftName || "" });
    const start = h("input", { id: "chStart", type: "date", value: state._draftStart || t, min: L.addDays(t, -L.MAX_BACKDATE) });
    // Length in whole weeks, so every week is a full 7 days (end = start + 7 x weeks - 1).
    const end = h("select", { id: "chWeeks", class: "cad", "aria-label": "How many weeks" },
      Array.from({ length: 12 }, (_, i) => h("option", { value: String(i + 1) }, `${i + 1} week${i ? "s" : ""}`)));
    end.value = String(state._draftWeeks || 3);
    const list = h("ul", { class: "glist" }, goals.map((g, i) => h("li", { class: "gitem" }, h("span", { class: "n" }, String(i + 1)),
      h("div", { class: "gfields" },
        h("input", { id: `chGoal${i}`, maxlength: "60", value: g.text, autocomplete: "off", placeholder: "e.g. 8 hours of sleep…", "aria-label": `Group goal ${i + 1}`, oninput: (e) => { goals[i].text = e.target.value; } }),
        cadenceSelect(`chCad${i}`, g.perWeek, (v) => { goals[i].perWeek = v; }, `How often for goal ${i + 1}`)))));
    const err = (k) => errors[k] ? h("p", { class: "err" }, errors[k]) : null;
    const plan = state._handoffFor ? L.handoffPlan(challengeList(), state._handoffFor) : [];
    const keep = () => { state._draftName = name.value; state._draftStart = start.value; state._draftWeeks = end.value; };
    return [
      h("h2", { id: "sheetTitle" }, "New challenge"),
      h("p", { class: "sub" }, "Everyone sets their own goals before it starts, and the pack checks each list. Start today or later."),
      h("div", { class: "field" }, h("label", { for: "chName" }, "Name"), name, err("name")),
      h("div", { class: "row2" }, h("div", { class: "field" }, h("label", { for: "chStart" }, "Starts"), start, err("start")), h("div", { class: "field" }, h("label", { for: "chWeeks" }, "How long"), end, err("end"))),
      h("p", { class: "seg-note", style: "margin-top:-8px" }, "Whole weeks, so every week is a full 7 days. It ends the day before the same weekday it starts on."),
      h("div", { class: "field", style: "margin-bottom:6px" }, h("label", {}, "Group goals (optional)"),
        h("p", { class: "seg-note", style: "margin:0" }, "Leave this empty and everyone just sets their own. A group goal goes on everyone's list, and everyone has to do it."), err("goals")),
      goals.length ? list : null,
      h("button", { class: "mini-btn", type: "button", disabled: goals.length >= L.MAX_GOALS, onclick: () => { keep(); goals.push({ text: "", perWeek: null }); openSheet(build); document.getElementById(`chGoal${goals.length - 1}`)?.focus(); } }, goals.length ? "Add another group goal" : "Add a group goal"),
      plan.length ? h("div", { class: "lockline", role: "note" }, h("span", {}, plan.map((x) => x.remove
        ? `"${x.name}" hasn't started yet, so it gets removed. `
        : `"${x.name}" ends ${fmtDay(x.patch.end, { weekday: "long", month: "short", day: "numeric" })}. Its ticks and standings stay. `).join(""))) : null,
      h("div", { class: "sheet-actions", style: "margin-top:18px" }, closeBtn(), h("button", { class: "btn blaze", type: "button", onclick: async (e) => {
        keep();
        const v = L.validateChallenge({ name: name.value, start: start.value, end: L.isDate(start.value) ? L.endForWeeks(start.value, Number(end.value)) : "", goals }, t, now());
        errors = v.errors;
        if (!v.ok) { openSheet(build); return; }
        const handoff = L.handoffPlan(challengeList(), start.value);
        if (handoff.length && state._handoffFor !== start.value) { state._handoffFor = start.value; openSheet(build); return; } // show what it replaces first
        e.target.disabled = true;
        try {
          await state.backend.createChallenge(Object.assign(v.value, { minGoals: 3, createdBy: state.user.uid, createdAt: now() }));
          for (const x of handoff) { if (x.remove) await state.backend.deleteChallenge(x.id); else await state.backend.mergeChallenge(x.id, x.patch); }
          state._draftName = state._draftStart = state._draftWeeks = state._handoffFor = null;
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
  if (!settingsChallenge()) return state.ms?.owner ? openCreate() : toast("No challenge yet. The owner sets it up.");
  let confirmClose = null;
  const build = () => {
    const ch = settingsChallenge(); // re-read on every rebuild: the shared doc changes under the open sheet
    const t = today();
    const owner = !!state.ms?.owner;
    const uid = state.user.uid;
    const started = L.isLocked(ch, t);
    const mineLocked = started && !owner; // your own goals lock at the start; the owner can still change them
    const targets = me().targets || {};
    // Group goals live on the challenge; your own under playerGoals[you]. Same editor, different write target.
    const write = async (patch, ok) => {
      try { await state.backend.mergeChallenge(ch.id, patch); toast(ok); } catch (e2) { console.error(e2); toast("That didn't save."); }
    };
    const goalEditor = (g, own) => {
      const view = own ? L.ownView(ch, uid) : ch;
      const wrap = (r) => (own ? L.ownPatch(uid, r) : r);
      const canEdit = own ? !mineLocked : owner;
      const closed = !!g.closedOn && g.closedOn <= t;
      const textField = canEdit ? h("input", { id: `gtx-${g.id}`, autocomplete: "off", maxlength: "60", value: g.text, "aria-label": "Goal", onchange: async (e) => {
        const r = wrap(L.editGoalPatch(view, g.id, e.target.value, t, true));
        if (r.error) return toast(r.error);
        write(r.patch, "Goal updated.");
      } }) : null;
      const target = own ? null : h("input", { id: `tgt-${g.id}`, maxlength: "40", value: targets[g.id] || "", autocomplete: "off", placeholder: "Your number, e.g. 200 g…", "aria-label": `Your target for ${g.text}`, disabled: closed,
        onchange: async (e) => {
          const v = L.cleanText(e.target.value).slice(0, 40);
          try { await state.backend.mergePlayer(uid, { targets: { [g.id]: v } }); toast("Target saved."); } catch (e2) { console.error(e2); toast("Target didn't save. Try again."); }
        } });
      return h("div", { class: "gset" + (closed ? " closed" : "") },
        h("div", { class: "gset-top" }, canEdit ? h("div", { class: "field", style: "margin:0;flex:1" }, textField) : h("strong", {}, g.text),
          closed ? h("small", {}, `Closed ${fmtDay(g.closedOn, { month: "short", day: "numeric" })}`) : g.addedOn > ch.start ? h("small", {}, `Added ${fmtDay(g.addedOn, { month: "short", day: "numeric" })}`) : null),
        canEdit ? h("div", { class: "field", style: "margin:0" }, h("label", { class: "tlabel", for: `cad-${g.id}` }, "How often"),
          cadenceSelect(`cad-${g.id}`, g.perWeek, async (v) => {
            const r = wrap(L.cadencePatch(view, g.id, v, t, true));
            if (r.error) return toast(r.error);
            write(r.patch, "Saved.");
          }, `How often for ${g.text}`)) : h("span", { class: "tlabel" }, L.cadenceLabel(g)),
        target ? h("div", { class: "field", style: "margin:0" }, h("label", { class: "tlabel", for: `tgt-${g.id}` }, "Your target"), target) : null,
        closed || !canEdit ? null : h("div", {}, h("button", { class: "mini-btn danger", type: "button", onclick: async () => {
          if (confirmClose !== g.id) { confirmClose = g.id; openSheet(build); return; }
          confirmClose = null;
          if (own && !started) { // before the start, a removed goal is gone for good: it never counted
            try { await state.backend.setOwnGoals(ch.id, uid, L.ownGoalsWithout(ch, uid, g.id)); toast("Goal removed."); } catch (e2) { console.error(e2); toast("That didn't save."); }
            return;
          }
          const r = wrap(L.closeGoalPatch(view, g.id, t));
          if (r.error) return toast(r.error);
          write(r.patch, "Goal closed. Its history stays.");
        } }, confirmClose === g.id ? (own ? "Tap again to remove it" : "Tap again to close it for everyone") : (own ? (started ? "Close this goal" : "Remove") : "Close this goal"))));
    };
    // A goal removed before the start never counted: hide it.
    const shown = (list) => list.filter((g) => !(g.closedOn && g.closedOn <= g.addedOn));
    const own = shown(L.goalList(L.ownView(ch, uid)));
    const group = shown(L.goalList(ch));
    const openOwn = own.filter((g) => !g.closedOn || g.closedOn > t).length;
    const adder = (id, own) => {
      const input = h("input", { id, "data-keep": true, maxlength: "60", autocomplete: "off", placeholder: own ? "e.g. Read a chapter, Pray 15 min, Protein 150 g…" : "e.g. 8 hours of sleep, No phone at dinner…", "aria-label": own ? "New goal of yours" : "New group goal" });
      let cad = null;
      return h("div", { class: "field" }, h("label", { for: id }, own ? "Add a goal of yours" : "Add a group goal (everyone must do it)"), input,
        h("div", { style: "display:flex;gap:8px" }, cadenceSelect(id + "Cad", null, (v) => { cad = v; }, "How often for the new goal"),
          h("button", { class: "mini-btn", type: "button", style: "min-height:50px;flex:none", onclick: async (ev) => {
            if (ev.currentTarget.disabled) return; // a double tap must not add the goal twice
            if (own && (openOwn >= L.MAX_PERSONAL || !L.canAddOwn(ch, uid))) return toast(`${L.MAX_PERSONAL} goals of your own at most. Remove one first.`);
            const view = own ? L.ownView(ch, uid) : ch;
            const r = own ? L.ownPatch(uid, L.addGoalPatch(view, input.value, t, Date.now(), cad)) : L.addGoalPatch(view, input.value, t, Date.now(), cad);
            if (r.error) return toast(r.error);
            input.value = ""; // cleared before the save lands, so the rebuild doesn't put it back
            const btn = ev.currentTarget;
            btn.disabled = true; btn.textContent = "Adding…";
            await write(r.patch, started ? "Goal added. It counts from today." : "Goal added.");
            btn.disabled = false; btn.textContent = own ? "Add my goal" : "Add for everyone";
          } }, own ? "Add my goal" : "Add for everyone")));
    };
    return [
      h("h2", { id: "sheetTitle" }, ch.name),
      h("p", { class: "sub" }, `${fmtDay(ch.start, { month: "short", day: "numeric" })} – ${fmtDay(ch.end, { month: "short", day: "numeric", year: "numeric" })}`),
      h("h3", { class: "gsec" }, "Your goals"),
      mineLocked ? null : h("p", { class: "seg-note", style: "margin:-4px 2px 10px" }, `Anything that's a real challenge for you: fitness, reading, prayer, sleep. Up to ${L.MAX_PERSONAL}. They lock when it starts.`),
      mineLocked ? (() => { const l = h("div", { class: "lockline" }); l.innerHTML = SVG.lock; l.append("Your goals are locked, because they're scored. Ask the owner in Trash Talk if one needs to change."); return l; })() : null,
      own.length ? h("div", { style: "display:grid;gap:10px;margin-bottom:12px" }, own.map((g) => goalEditor(g, true)))
        : h("p", { class: "empty", style: "margin-bottom:12px" }, h("b", {}, "No goals yet. "), "Ideas: read a chapter, pray 15 minutes, practice guitar, call your mom, no phone after 10, lift, 10k steps. With none, every day counts as a strike."),
      mineLocked ? null : adder("addGoal", true),
      group.length || owner ? h("h3", { class: "gsec" }, "Group goals") : null,
      group.length || owner ? h("p", { class: "seg-note", style: "margin:-4px 2px 10px" }, owner ? "Optional. A group goal lands on everyone's list and everyone has to do it." : "Set by the owner. Everyone has to do these.") : null,
      group.length ? h("div", { style: "display:grid;gap:10px;margin-bottom:12px" }, group.map((g) => goalEditor(g, false))) : null,
      owner ? adder("addGroupGoal", false) : null,
      owner ? h("details", { class: "owner-wrap", open: state._ownerOpen !== false || null, ontoggle: (e) => { state._ownerOpen = e.target.open; } },
        h("summary", {}, h("span", {}, "Owner settings"), h("small", {}, "Pot, dates, days off, minimum goals, house rules, people")), ownerControls(ch)) : null,
      owner ? recoverField(ch) : null,
      h("div", { class: "sheet-actions" }, closeBtn(), h("button", { class: "btn ghost", type: "button", onclick: () => location.reload() }, "Refresh the app")),
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
      h("div", { class: "field" }, h("label", {}, "The invite"), inviteBox(),
        h("p", { class: "seg-note" }, "Copy it into a text to the pack. Add their emails above first.")),
      h("div", { class: "sheet-actions" }, h("button", { class: "btn ghost", type: "button", onclick: () => openSettings(state._settingsId) }, "Back")),
    ];
  };
  openSheet(build);
}
sheet.addEventListener("close", () => { state._sheetIs = null; });

// ---------- help, rules, invites, home screen ----------
// On the dev preview the invite opens the new-player walkthrough (fake sign-in, sample data), never the real app.
const appLink = () => location.origin + location.pathname + (window.DD_DEV ? "?demo=invited" : "");
const phone = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) ? "ios"
  : /Android/.test(navigator.userAgent) ? "android" : "other";
const standalone = () => window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
const seen = (k) => { try { return localStorage.getItem("ap." + k) === "1"; } catch { return false; } };
const markSeen = (k) => { try { localStorage.setItem("ap." + k, "1"); } catch { /* private mode: it shows again, harmless */ } };

const STEPS = {
  ios: ["Open the link in Safari.", "Tap the Share button (the square with the arrow pointing up).", "Scroll down and tap “Add to Home Screen”, then “Add”.", "Open Alpha Pack from your home screen from now on."],
  android: ["Open the link in Chrome.", "Tap the ⋮ menu, top right.", "Tap “Add to Home screen” (or “Install app”), then “Install”.", "Open Alpha Pack from your home screen from now on."],
};
function stepsList(kind) { return h("ol", { class: "steps" }, STEPS[kind].map((x) => h("li", {}, x))); }

// Shown once per phone, in the browser only: an installed app never sees it.
function installCard() {
  if (standalone() || seen("installDone") || state.backend?.mode === "demo" && !new URLSearchParams(location.search).has("install") && new URLSearchParams(location.search).get("demo") !== "invited") return null;
  const kind = phone();
  if (kind === "other") return null;
  return h("section", { class: "callout", "aria-labelledby": "instH" },
    h("h2", { id: "instH" }, "Put it on your home screen"),
    h("p", {}, "It opens like an app, full screen, one tap from your home screen."),
    stepsList(kind),
    h("div", { class: "callout-actions" }, h("button", { class: "mini-btn", type: "button", onclick: () => { markSeen("installDone"); render(); } }, "Done, hide this")));
}

// Shown once after joining: the whole game in three lines.
function welcomeCard() {
  if (seen("welcomed")) return null;
  return h("section", { class: "callout welcome", "aria-labelledby": "welH" },
    h("h2", { id: "welH" }, "Welcome to the pack"),
    h("ol", { class: "steps" },
      h("li", {}, h("b", {}, "Set your own goals"), " before it starts, then the pack checks they're fair. Anything counts: lift, read, sleep."),
      h("li", {}, h("b", {}, "Tick your goals"), " every day. Tap a goal to check it off. You have until noon the next day to fix it."),
      h("li", {}, h("b", {}, "Miss one and it's a strike."), " Too many strikes and you're out of the pot."),
      h("li", {}, h("b", {}, "Talk trash"), " and watch the Daily Board. Everyone sees everyone.")),
    h("div", { class: "callout-actions" },
      h("button", { class: "mini-btn", type: "button", onclick: () => openRules() }, "Read the rules"),
      h("button", { class: "mini-btn", type: "button", onclick: () => { markSeen("welcomed"); render(); } }, "Got it")));
}

function quickLinks() {
  const owner = !!state.ms?.owner;
  return h("nav", { class: "quick" + (owner ? " three" : ""), "aria-label": "Rules, help and invite" },
    h("button", { class: "quick-btn", type: "button", onclick: () => openRules() }, h("span", { "aria-hidden": "true" }, "\u2696"), "Rules"),
    h("button", { class: "quick-btn", type: "button", onclick: () => openHelp() }, h("span", { "aria-hidden": "true" }, "?"), owner ? "Help" : "How it works"),
    // Owner: the invite lives behind a pill (Jason 2026-10-29), not a big card on the main screen.
    owner ? h("button", { class: "quick-btn", type: "button", onclick: openInvite }, h("span", { "aria-hidden": "true" }, "+"), "Invite") : null);
}
function openInvite() {
  state._sheetIs = "invite";
  openSheet(() => [
    h("h2", { id: "sheetTitle" }, "Invite the pack"),
    h("p", { class: "sub" }, "Copy it and text it to the guys. The app teaches them the rest."),
    inviteBox(),
    h("p", { class: "seg-note" }, "Add each player's Google email first (Menu, People in the group). The link only opens for emails on the list."),
    h("div", { class: "sheet-actions" }, h("button", { class: "btn ghost", type: "button", onclick: openMembers }, "People in the group"), closeBtn()),
  ]);
}

// The Rules page: written from the challenge's own settings, so it can never drift from what the app scores.
function rulesFor(ch) {
  const daily = L.goalList(ch).filter((g) => !g.closedOn && !L.isWeekly(g));
  const weekly = L.goalList(ch).filter((g) => !g.closedOn && L.isWeekly(g));
  const pot = ch.pot?.buyIn > 0 ? ch.pot : null;
  const lim = pot ? (pot.strikes >= 1 ? pot.strikes : 3) : 0;
  const back = pot?.comeback > 0 ? Math.min(pot.comeback, pot.buyIn) : 0;
  const offs = L.skipDates(ch);
  const sec = (title, lines) => h("section", { class: "rule" }, h("h3", {}, title), h("ul", {}, lines.filter(Boolean).map((l) => h("li", {}, l))));
  return [
    sec("The challenge", [
      `${ch.name}: ${fmtDay(ch.start, { month: "short", day: "numeric" })} to ${fmtDay(ch.end, { month: "short", day: "numeric" })} (${L.challengeLength(ch)} days).`,
      "Days run midnight to midnight, Pacific time.",
      "You can tick or fix a day until noon the next day. Then it locks for good and posts to the Daily Board.",
      offs.length ? `Days off: ${offs.map((d) => fmtDay(d, { month: "short", day: "numeric" })).join(", ")}. Nothing counts on them.` : null,
    ]),
    sec("The goals", [
      `Everyone sets their own goals before it starts, at least ${L.minGoalsOn(Object.assign({ playerGoals: {} }, ch))}. Anything counts: fitness, reading, prayer, sleep. Each one is every day or N days a week. Weeks run from the start day, and a short last week asks for its share.`,
      "The goal check: the pack looks at each list and taps Fair or Too easy. A list needs a yes from more than half of the others. Change a goal and its votes reset. Not approved by the start? The owner decides.",
      "Your goals lock when it starts. After that only the owner can change them.",
      "A day with fewer goals than the minimum counts as a strike, so nobody can play it safe with one easy goal.",
      daily.length || weekly.length ? `Group goals (everyone has to do these): ${daily.concat(weekly).map((g) => g.text + (L.isWeekly(g) ? ` (${L.cadenceLabel(g)})` : "")).join(", ")}.` : null,
      "Ticking is on your honor. Everyone sees everyone's goals and ticks.",
    ]),
    pot ? sec("The pot", [
      `Buy-in: ${money(pot.buyIn)} each, paid up front to ${L.treasurerOf(ch) ? `the treasurer, ${state.players?.[L.treasurerOf(ch)]?.name || "?"}${pot.payHow ? ` (${pot.payHow})` : ""}` : "the treasurer"}. Only the treasurer marks who paid. The app never moves money.`,
      "A strike is a day you didn't finish every daily goal, or a weekly goal you came up short on when the week locks.",
      `Out at ${lim} strike${lim === 1 ? "" : "s"}.`,
      "Everyone still in at the end splits the pot evenly. If nobody makes it, everyone gets their buy-in back.",
      back ? `Comeback: once you're out, finish without another strike and you get ${money(back)} back. It cuts your loss; it never wins you a share.` : "No comeback this time: once you're out, you're out.",
    ]) : sec("The pot", ["No pot on this challenge. Bragging rights only."]),
    pot ? sec("Pardons", [
      "Had a real reason for a strike? Ask for a pardon on it (The Pot, Your strikes).",
      "Everyone else votes yes or no. More than half of the other players saying yes wipes the strike.",
      "You can't vote on your own. Voting stays open after the last day until the owner settles the pot, so last-day strikes can be pardoned too.",
    ]) : null,
    ch.houseRules ? h("section", { class: "rule house" }, h("h3", {}, "House rules"), h("p", { class: "house-text" }, ch.houseRules)) : null,
  ];
}
function openRules() {
  const ch = current();
  state._sheetIs = "rules";
  openSheet(() => [
    h("h2", { id: "sheetTitle" }, "The rules"),
    h("p", { class: "sub" }, ch ? `For ${ch.name}. This page writes itself from the challenge settings.` : "No challenge yet."),
    ...(ch ? rulesFor(ch) : []),
    h("div", { class: "sheet-actions" }, closeBtn()),
  ]);
}

function openHelp(open = null) {
  state._sheetIs = "help";
  const q = (id, title, ...body) => h("details", { class: "help", id: "help-" + id, open: open === id }, h("summary", {}, h("span", { class: "help-q", "aria-hidden": "true" }, "?"), title), h("div", { class: "help-body" }, ...body));
  const p = (t) => h("p", {}, t);
  const kind = phone();
  openSheet(() => [
    h("h2", { id: "sheetTitle" }, "How it works"),
    h("p", { class: "sub" }, "Everything in one place. Tap a question."),
    q("tick", "How do I check off a goal?", p("Tap it on the main screen. Tap again to undo. You can fix yesterday until noon today: use the Yesterday button above your goals.")),
    q("goals", "Who sets the goals?", p("You do. Before it starts, add your own under Edit goals: anything that's a real challenge for you, fitness or not. Read a chapter counts. The owner can add group goals that land on everyone's list too.")),
    q("goalcheck", "What's the goal check?", p("Before the start, the pack looks at each list and taps Fair or Too easy. A list needs a yes from more than half of the others, or the owner's OK. Change a goal and its votes reset. Each list needs a minimum number of goals; a day with fewer counts as a strike.")),
    q("target", "What's “your target”?", p("On a group goal, your own number, like 180 g of protein. Set it under Edit goals. Your own goals don't need one: the goal is the target.")),
    q("weekly", "How do weekly goals work?", p("Some goals are “N days a week” instead of every day. Weeks run from the challenge's start day (a Saturday start means Saturday to Friday). A short last week asks for its share. The bar shows how close you are.")),
    q("strike", "What's a strike?", p("A day you didn't finish every daily goal, or a weekly goal you came up short on when the week ends. A day only counts once it locks at noon the next day. Days off never count.")),
    q("pot", "How does the pot work?", p("Everyone pays the buy-in up front to the treasurer (the pot shows who and how). Only the treasurer marks who paid. Too many strikes and you're out. Whoever is still in at the end splits it. If nobody makes it, everyone gets their money back.")),
    q("comeback", "I'm out. Now what?", p("Keep going. If the challenge has a comeback, finish without another strike and you get that amount back. You can't win the pot that way, but it cuts your loss.")),
    q("pardon", "Can a strike be forgiven?", p("Yes. Under The Pot, Your strikes, tap Ask for a pardon. The others vote. More than half of them saying yes wipes it. You can't vote on your own.")),
    q("packpoints", "What are pack points?", p("Group goals score the pack as a team: 1 point for each day (or week) everyone hits one. The app counts it from everyone's ticks. Bragging rights for now; they don't change the pot.")),
    q("board", "What's the Daily Board?", p("Each day's final scores, posted once the day locks at noon. The top of the list is a live view of today.")),
    q("chat", "What's Trash Talk?", p("A group message board. Everyone in the group sees it. You can delete your own posts.")),
    q("home", "How do I put it on my home screen?",
      h("p", {}, h("b", {}, "iPhone")), stepsList("ios"), h("p", {}, h("b", {}, "Android")), stepsList("android"),
      kind !== "other" ? p(kind === "ios" ? "You're on an iPhone: use the first set." : "You're on Android: use the second set.") : null),
    q("signin", "It won't let me in.", p("Sign in with the same Google account the group owner added. If it still says you're not on the list, ask the owner to check your email under People in the group.")),
    h("div", { class: "sheet-actions" }, h("button", { class: "btn blaze", type: "button", onclick: () => openRules() }, "Read the rules"), closeBtn()),
  ]);
}

// The invite: one message that answers every first-day question.
// Short on purpose: a wall of text scares people off. The app does the teaching: the install card shows their own
// phone's home-screen steps on first open, and the welcome card covers goals and strikes.
function inviteText() {
  const c = current();
  const t = L.treasurerOf(c);
  const pay = c?.pot?.buyIn > 0 ? `Buy-in is ${money(c.pot.buyIn)}` + (t ? `, to ${state.players?.[t]?.name || "the treasurer"}${c.pot.payHow ? ` (${c.pot.payHow})` : ""}.` : ".") : null;
  return [
    window.DD_DEV ? "You're in the Alpha Pack \u{1F43A}\u{1F4AA} (test version: sample players, nothing is saved)" : "You're in the Alpha Pack \u{1F43A}\u{1F4AA}",
    appLink(),
    "Sign in with Google using this email. The app walks you through the rest, even putting it on your home screen.",
    pay,
  ].filter(Boolean).join("\n");
}
// The invite as text you can see, copy and paste into a group text, or share from the phone's share sheet.
// navigator.share needs a tap and https; canceling it rejects with AbortError, which is not a failure.
async function copyInvite() {
  try { await navigator.clipboard.writeText(inviteText()); toast("Invite copied. Paste it into a text to the pack."); }
  catch { const box = document.getElementById("inviteText"); if (box) { const r = document.createRange(); r.selectNodeContents(box); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); } toast("Couldn't copy automatically. It's selected: tap Copy."); }
}
async function shareInvite() {
  try { await navigator.share({ title: "Alpha Pack", text: inviteText() }); }
  catch (e) { if (e && e.name === "AbortError") return; copyInvite(); }
}
async function sendInvite() { return navigator.share ? shareInvite() : copyInvite(); }
function inviteBox() {
  return h("div", { class: "invite" },
    h("pre", { class: "invite-text", id: "inviteText", tabindex: "0", "aria-label": "Invite message" }, inviteText()),
    h("div", { class: "callout-actions" },
      h("button", { class: "btn blaze", type: "button", onclick: copyInvite }, "Copy invite"),
      navigator.share ? h("button", { class: "mini-btn", type: "button", onclick: shareInvite }, "Share…") : null));
}

// Owner only: the fewest goals each player needs. A day with fewer counts as a strike.
function minGoalsField(ch) {
  const sel = h("select", { id: "minGoals", class: "cad", "aria-label": "Fewest goals each player needs" },
    Array.from({ length: L.MAX_PERSONAL }, (_, i) => h("option", { value: String(i + 1) }, `At least ${i + 1} goal${i ? "s" : ""} each`)));
  sel.value = String(L.minGoalsOn(Object.assign({ playerGoals: {} }, ch)));
  return h("div", { class: "field" }, h("label", { for: "minGoals" }, "Goals per player"), sel,
    h("button", { class: "mini-btn", type: "button", style: "min-height:44px", onclick: async () => {
      const r = L.minGoalsPatch(sel.value);
      if (r.error) return toast(r.error);
      try { await state.backend.mergeChallenge(ch.id, r.patch); toast(`Saved: at least ${r.patch.minGoals} each.`); } catch (e) { console.error(e); toast("That didn't save."); }
    } }, "Save minimum"),
    h("p", { class: "seg-note" }, "Everyone sets their own goals. A day with fewer than this counts as a strike, so nobody can play it safe with one easy goal."));
}

// Owner only: the snapshots. Download one as a file. If something ever breaks, Leo rebuilds from it with Jason;
// there is deliberately no restore button (GPT review: a one-tap restore can't be made safe for votes and players).
function backupsField() {
  const b = state.backups;
  const ids = Object.keys(b || {}).sort((x, y) => (b[y].at || 0) - (b[x].at || 0));
  const when = (ms) => new Date(ms).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const download = async (id) => {
    let parts;
    try { parts = await state.backend.readBackup(id); } catch (e) { console.error(e); return toast("Couldn't read that backup. Try again."); }
    const snap = L.assembleSnapshot(b[id], parts);
    if (!snap.complete) toast("Heads up: that backup is missing pieces (it's marked in the file). Try an older one too, and tell Leo.");
    const blob = new Blob([JSON.stringify(snap, null, 2)], { type: "application/json" });
    const a = h("a", { href: URL.createObjectURL(blob), download: `alpha-pack-backup-${id}.json` });
    document.body.append(a); a.click(); a.remove();
  };
  return h("div", { class: "field" }, h("label", {}, "Backups"),
    h("p", { class: "seg-note", style: "margin-top:0" }, `A full copy of everything (challenges, goals, ticks, votes, payments, the group list), taken every 6 hours when you open the app. The last ${L.BACKUP_KEEP} are kept. Only you can see them. If something ever breaks, download the latest good one and send it to Leo.`),
    b == null ? h("p", { class: "seg-note" }, "Loading backups…")
      : ids.length ? h("ul", { class: "backups" }, ids.map((id) => h("li", {},
        h("span", {}, when(b[id].at), h("small", {}, ` · ${b[id].challenges || 0} challenge(s), ${b[id].players || 0} players${(b[id].failed || []).length ? ` · incomplete (${b[id].failed.length} missing)` : " · complete"}`)),
        h("span", { class: "pd-act" },
          h("button", { class: "mini-btn", type: "button", style: "min-height:44px", onclick: () => download(id) }, "Download")))))
      : h("p", { class: "seg-note" }, "No snapshots yet."),
    h("button", { class: "mini-btn", type: "button", style: "min-height:44px", onclick: async () => { const id = await autoBackup(true, "manual"); toast(id ? "Snapshot saved." : "That didn't save."); } }, "Back up now"));
}

// Owner only: house rules. Words only; the app never scores them.
function houseRulesField(ch) {
  const ta = h("textarea", { id: "houseRules", rows: "5", maxlength: String(L.MAX_RULES), autocomplete: "off", placeholder: "e.g. Cheat meals need a photo in Trash Talk…", "aria-label": "House rules" });
  ta.value = ch.houseRules || "";
  return h("div", { class: "field" }, h("label", { for: "houseRules" }, "House rules"), ta,
    h("button", { class: "mini-btn", type: "button", style: "min-height:44px", onclick: async () => {
      const r = L.houseRulesPatch(ta.value);
      if (r.error) return toast(r.error);
      try { await state.backend.mergeChallenge(ch.id, r.patch); toast(r.patch.houseRules ? "House rules saved. They're on the Rules page." : "House rules cleared."); }
      catch (e) { console.error(e); toast("That didn't save."); }
    } }, "Save house rules"),
    h("p", { class: "seg-note" }, "Anything the app doesn't count: everyone reads it on the Rules page. Strikes, the pot and votes come from the settings above."));
}

// ---------- daily board posting: retired ----------
// The board scores every locked day from the ticks, so nothing reads results docs any more, and members can't write
// them (a copycat challenge could jam a date). Kept as a no-op so the callers stay put; season-1 docs are untouched.
async function postDueResults() {
  return;
  /* eslint-disable no-unreachable */
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
      autoBackup();
    }, (e) => { console.error(e); toast("Lost the connection. It'll catch up when you're back online."); }));
  }
  subscribeBackups();
}

// The owner also watches backups (members can't read them, so only the owner subscribes).
function subscribeBackups() {
  if (!state.ms?.owner || state._backupsUnsub) return;
  state._backupsUnsub = state.backend.watch("backups", (data) => { state.backups = data; autoBackup(); if (state._sheetIs === "settings") state._sheetRebuild?.(); },
    (e) => { console.error(e); state.backups = null; });
}
// Every 6 hours of the owner using the app: one snapshot of every challenge, every player's ticks and name, and the
// group list. Keeps the newest BACKUP_KEEP.
async function autoBackup(force, label) {
  if (!state.ms?.owner || !state.backups || !state.players || !state.challenges || !state.members || state._backingUp) return null;
  const plan = L.backupPlan(state.backups, now());
  if (!plan.due && !force) return null;
  state._backingUp = true;
  try {
    const id = new Date(now()).toISOString().replace(/[:.]/g, "-") + (label ? "-" + label : "");
    const src = await state.backend.backupSource(); // fresh from the server; throws (no backup) if it can't
    const snap = L.snapshotOf(src.challenges, src.players, src.members, now());
    const failed = await state.backend.createBackup(id, { at: snap.at, challenges: Object.keys(snap.challenges).length, players: Object.keys(snap.players).length }, L.snapshotParts(snap));
    if (failed.length && !state._backupWarned) { state._backupWarned = true; toast(`Heads up: ${failed.length} part(s) of today's backup didn't save. Tell Leo.`); }
    for (const old of plan.prune) await state.backend.deleteBackup(old).catch(() => {});
    return id;
  } catch (e) {
    console.error(e);
    if (!state._backupWarned) { state._backupWarned = true; toast("Heads up: today's backup didn't save. Tell Leo."); }
    return null;
  } finally { state._backingUp = false; }
}

function unsubscribe() { state._backupsUnsub?.(); state._backupsUnsub = null; state.backups = null; state.unsubs.forEach((u) => u && u()); state.unsubs = []; state.players = state.challenges = state.results = state.members = null; state.chat = {}; }

// Roll the day (and the noon close) without a reload.
setInterval(() => {
  const d = today(), f = L.pacificHour(now()) >= L.FINAL_HOUR;
  if (d !== state.lastDay || f !== state.lastFinal) { state.lastDay = d; state.lastFinal = f; if (state.players) { render(); postDueResults(); } }
}, 30000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && state.players) { render(); postDueResults(); } });

async function boot() {
  const params = new URLSearchParams(location.search);
  // The dev preview site (config sets DD_DEV, no Firebase) always runs on sample data: real data can't be touched.
  const demo = params.get("demo") || (window.DD_DEV ? "season1" : null);
  try {
    if (demo) {
      const { createDemoBackend } = await import("./backend-demo.js");
      state.backend = createDemoBackend(demo, { latency: Number(params.get("latency") || 120) });
      window.__ddBackend = state.backend; // demo only: lets the UI tests tamper with the sample store
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
// ---------- updates: nobody stays stuck on an old copy ----------
// At boot, fingerprint the app code as served; every 5 minutes and whenever the app comes back to the screen, fetch it
// again past every cache (no-store + a fresh query, which also skips GitHub's 10-minute CDN copy). Different = a new
// release: show the update bar, and reload on our own when it's safe (the app was just reopened, nothing half-typed).
const VERSION_FILES = ["app.js", "logic.js", "index.html"];
async function codePrint() {
  try {
    const parts = await Promise.all(VERSION_FILES.map((f) => fetch(`${f}?v=${Date.now()}`, { cache: "no-store" }).then((r) => (r.ok ? r.text() : ""))));
    let h1 = 5381; for (const c of parts.join("\u0000")) h1 = ((h1 * 33) ^ c.charCodeAt(0)) >>> 0;
    return h1.toString(36);
  } catch { return null; } // offline: no news is no news
}
let bootPrint = null;
async function checkForUpdate(reopened, force) {
  if (!force && new URLSearchParams(location.search).has("demo") && !window.DD_DEV) return; // tests: no network chatter
  const p = await codePrint();
  if (!p) return;
  if (!bootPrint) { bootPrint = p; return; }
  if (p === bootPrint) return;
  const busy = sheet.open || (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName));
  if (reopened && !busy) { location.reload(); return; }
  if (document.getElementById("updateBar")) return;
  const bar = h("button", { id: "updateBar", class: "update-bar", type: "button", onclick: () => location.reload() }, "New version ready · Tap to update");
  document.body.append(bar);
}
window.__checkForUpdate = checkForUpdate; // the UI tests drive it directly
checkForUpdate(false);
setInterval(() => checkForUpdate(false), 5 * 60 * 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkForUpdate(true); });

boot();
