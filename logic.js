/* Alpha Pack — pure game logic. No DOM, no network, no clock reads except where `now` is passed in.
 * Loaded as a classic script in the page (window.DDLogic) and required by the node test suite.
 * Data shapes (Firestore):
 *   challenges/<id>  {name, start, end, createdBy, createdAt,
 *                     goals: {<goalId>: {text, addedOn, closedOn|null, order, perWeek|null}}   group goals: everyone's
 *                     playerGoals: {<uid>: {<goalId>: {same shape}}}   each player's own goals (the default)
 *                     minGoals: 1-8 (default 3)   goalsOk: {<uid>: <goal-set key>}   the owner's sign-off on a list
 *                     pot: {buyIn, strikes, comeback, treasurer: <uid>, payHow: text, paid: {<uid>: bool}, settled: {at, rows}|null}   play money: misses are
 *                          strikes, the survivors split it; settled = the owner froze the payouts
 *                     houseRules: text   owner's free-text rules, shown on the Rules page, never scored
 *                     skips: {<YYYY-MM-DD>: bool}   days off: nothing counts, streaks jump them, weekly targets drop a day
 *                     perWeek null = a daily goal (every day counts); 1-7 = "N days a week", weeks run from the start day.
 *   players/<uid>    {name, joinedAt, targets: {<goalId>: text}, days: {<YYYY-MM-DD>: {<goalId>: bool}},
 *                     appeals: {<strikeKey>: bool}, votes: {<strikeKey>: bool}}   pardons: see pardonFor
 *   results/<date>   {date, challengeId, rows: [{uid, name, hit, of, pct, perfect}], createdAt}   (create-only)
 * Day boundary is America/Los_Angeles. A day stays editable until noon the next day, then it is final and its
 * results doc may be posted.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DDLogic = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var TZ = "America/Los_Angeles";
  var FINAL_HOUR = 12;
  var MAX_GOALS = 12;
  var MAX_TEXT = 60;
  var MAX_POST = 280;

  var dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  var hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" });

  // Never throws: a junk timestamp (text, NaN, 1e100) reads as 1970, so one bad record can't crash every screen.
  function safeMs(ms) {
    var n = Number(ms);
    return isFinite(n) && Math.abs(n) <= 8.64e15 ? n : 0;
  }

  function pacificDate(ms) {
    return dateFmt.format(new Date(safeMs(ms)));
  }

  function pacificHour(ms) {
    return Number(hourFmt.format(new Date(safeMs(ms)))) % 24;
  }

  // Calendar arithmetic on YYYY-MM-DD strings, done in UTC so DST never shifts a day.
  function addDays(date, n) {
    var p = date.split("-").map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
    return d.toISOString().slice(0, 10);
  }

  function daysBetween(a, b) {
    var pa = a.split("-").map(Number), pb = b.split("-").map(Number);
    return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
  }

  function isDate(s) {
    return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && addDays(s, 0) === s;
  }

  function inChallenge(ch, date) {
    return !!ch && date >= ch.start && date <= ch.end;
  }

  // Every goal is read through cleanGoal: a malformed one (bad dates, odd types) is dropped, never trusted, so one bad
  // record can't throw in scoring for everyone. The rules can't check map values one by one; this is the check.
  // Goal ids that collide with built-in object names would dodge plain-object lookups; they're never a real goal.
  function badId(id) { return id === "__proto__" || id in Object.prototype; }

  function cleanGoal(id, v) {
    if (badId(id) || !v || typeof v !== "object" || !isDate(v.addedOn)) return null;
    var pw = typeof v.perWeek === "number" && v.perWeek >= 1 && v.perWeek <= 7 && Math.round(v.perWeek) === v.perWeek ? v.perWeek : null;
    return {
      id: id, text: typeof v.text === "string" && v.text ? v.text.slice(0, MAX_TEXT) : "Goal", addedOn: v.addedOn,
      closedOn: isDate(v.closedOn) ? v.closedOn : null, order: typeof v.order === "number" && isFinite(v.order) ? v.order : 0, perWeek: pw,
      personal: v.personal === true,
    };
  }

  function goalList(ch) {
    var g = (ch && ch.goals) || {};
    if (typeof g !== "object") return [];
    return Object.keys(g)
      .map(function (id) { return cleanGoal(id, g[id]); }).filter(Boolean)
      .sort(function (a, b) { return (a.order || 0) - (b.order || 0) || (a.addedOn < b.addedOn ? -1 : 1); });
  }

  // One player's view of a challenge: the group goals plus their own. Every scoring function takes a challenge, so
  // scoring a player always goes through chFor(ch, uid). Own goals sort after the group's.
  var MAX_PERSONAL = 8;
  function ownGoals(ch, uid) {
    var all = (ch && ch.playerGoals) || {};
    var mine = typeof all === "object" && Object.prototype.hasOwnProperty.call(all, uid) ? all[uid] : null;
    return mine && typeof mine === "object" ? mine : {};
  }
  function chFor(ch, uid) {
    if (!ch) return ch;
    var goals = Object.create(null), shared = (ch.goals && typeof ch.goals === "object") ? ch.goals : {}, mine = ownGoals(ch, uid);
    Object.keys(shared).forEach(function (id) { goals[id] = shared[id]; });
    Object.keys(mine).forEach(function (id) {
      var g = mine[id];
      if (!badId(id) && g && typeof g === "object" && !(id in goals)) goals[id] = Object.assign({}, g, { personal: true, order: 1000 + (typeof g.order === "number" && isFinite(g.order) ? g.order : 0) });
    });
    return Object.assign({}, ch, { goals: goals });
  }
  // Only this player's own goals, as a challenge-shaped view, for building patches to them.
  function ownView(ch, uid) { return Object.assign({}, ch, { goals: ownGoals(ch, uid) }); }
  // Before the start, removing one of your goals deletes it outright (the rules cap your map at MAX_PERSONAL entries).
  // Returns the whole new map for playerGoals[uid]; the backend writes it as a replacement, not a merge.
  function ownGoalsWithout(ch, uid, goalId) {
    var out = {}, mine = ownGoals(ch, uid);
    Object.keys(mine).forEach(function (id) { if (id !== goalId) out[id] = mine[id]; });
    return out;
  }
  function canAddOwn(ch, uid) { return Object.keys(ownGoals(ch, uid)).length < MAX_PERSONAL; }
  // A goal patch ({goals: {...}}) re-aimed at one player's own goals.
  function ownPatch(uid, r) {
    if (!r || r.error) return r;
    var pg = {}; pg[uid] = r.patch.goals;
    var out = Object.assign({}, r.patch); delete out.goals; out.playerGoals = pg;
    return { patch: out };
  }

  // The fewest goals a player may have on any day. Set only by the owner's minGoals (new challenges get 3); without it
  // the minimum is 1, so nothing a member writes (an empty playerGoals map, say) can change it.
  function minGoalsOn(ch) {
    var n = ch && typeof ch.minGoals === "number" ? Math.round(ch.minGoals) : 1;
    return n >= 1 && n <= MAX_PERSONAL ? n : 1;
  }

  // A player's own goal list as one key: change any goal (text or cadence), add or remove one, and the key changes,
  // so sign-off votes on the old list stop counting. Removed-before-start goals aren't part of the list.
  function goalSetKey(ch, uid) {
    // Canonical: every field that changes what's scored (id, text, cadence, when it counts), sorted by id, as JSON.
    var list = goalList(ownView(ch, uid)).map(function (g) { return [g.id, g.text, g.perWeek || 0, g.addedOn, g.closedOn || ""]; })
      .sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
    var str = JSON.stringify(list);
    // cyrb53: a 53-bit string hash, so two different lists colliding is out of reach for a group of friends.
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  // Sign-off on a player's goal list: more than half of the OTHER entrants vote yes on its current key, or the owner
  // approves it (goalsOk[uid] === key). Votes ride the same players/<voter>.votes map as pardons.
  function signoffKey(ch, uid) { return [ch.id, uid, "goals", goalSetKey(ch, uid)].join("|"); }
  function signoffFor(players, ch, uid) {
    players = players || {};
    var entrants = Object.keys(players).filter(function (u) { return joinedBy(players[u], ch.end); });
    var key = signoffKey(ch, uid);
    // What counts on day 1, group goals plus their own. Not activeGoals: a day off on day 1 would make that zero.
    var count = goalList(chFor(ch, uid)).filter(function (g) { return g.addedOn <= ch.start && (!g.closedOn || ch.start < g.closedOn); }).length;
    var min = minGoalsOn(ch);
    var p = pardonFor(players, entrants, uid, key); // asked is irrelevant here: a list is always up for sign-off
    var byOwner = !!(ch.goalsOk && ch.goalsOk[uid] === goalSetKey(ch, uid));
    var enough = count >= min;
    return { key: key, setKey: goalSetKey(ch, uid), count: count, min: min, enough: enough, yes: p.yes, no: p.no, need: p.need, voters: p.voters,
      byOwner: byOwner, approved: enough && (byOwner || (p.voters > 0 && p.yes >= p.need)) };
  }
  function signoffVotePatch(key, yes) { return votePatch(key, yes); }
  function ownerSignoffPatch(ch, uid, on) {
    var m = {}; m[uid] = on ? goalSetKey(ch, uid) : null;
    return { patch: { goalsOk: m } };
  }
  function minGoalsPatch(n) {
    var k = Math.round(Number(n));
    if (!(k >= 1 && k <= MAX_PERSONAL)) return { error: "Minimum: 1 to " + MAX_PERSONAL + " goals." };
    return { patch: { minGoals: k } };
  }

  // A day off: the owner switched it off for everyone. Ticks on it are kept but nothing counts.
  function isSkip(ch, date) {
    return !!(ch && ch.skips && ch.skips[date] === true);
  }

  function skipDates(ch) {
    return Object.keys((ch && ch.skips) || {}).filter(function (d) { return ch.skips[d] === true && inChallenge(ch, d); }).sort();
  }

  // Owner only: switch a day off or back on.
  function skipPatch(ch, date, off) {
    if (!isDate(date)) return { error: "Pick a day." };
    if (!inChallenge(ch, date)) return { error: "Pick a day inside the challenge." };
    if (off && isSkip(ch, date)) return { error: "That day is already off." };
    var skips = {};
    skips[date] = !!off;
    return { patch: { skips: skips } };
  }

  // Goals that count on `date`: added on or before it, not closed on or before it, the date inside the challenge,
  // and not a day off.
  function activeGoals(ch, date) {
    if (!inChallenge(ch, date) || isSkip(ch, date)) return [];
    return goalList(ch).filter(function (g) {
      return g.addedOn <= date && (!g.closedOn || date < g.closedOn);
    });
  }

  // Goals are locked once the challenge has started: text can't change, but goals can be added or closed.
  function isLocked(ch, today) {
    return !!ch && today >= ch.start;
  }

  function isDone(player, date, goalId) {
    var d = player && player.days && player.days[date];
    return !!(d && d[goalId] === true);
  }

  function isWeekly(g) { return !!(g && g.perWeek); }

  // Daily goals only: weekly goals are scored by the week, so a rest day can still be a perfect day.
  function dailyGoals(ch, date) { return activeGoals(ch, date).filter(function (g) { return !isWeekly(g); }); }
  // Weekly goals that need at least one day this week (days off can waive a goal for the week).
  function weeklyGoals(ch, date) { return activeGoals(ch, date).filter(function (g) { return isWeekly(g) && weekProgress(null, ch, g, date).need > 0; }); }

  // Challenges run in whole weeks (Jason 2026-10-29; prior art: DietBet's 4-week / 28-day game): the last day is
  // start + 7*weeks - 1, so every week is a full 7 days and only late joiners and days off get scaled.
  function endForWeeks(start, weeks) { return addDays(start, 7 * weeks - 1); }
  function weeksOf(ch) { return ch && isDate(ch.start) && isDate(ch.end) ? (daysBetween(ch.start, ch.end) + 1) / 7 : 0; }

  // First day of the challenge week holding `date`. Weeks run from the challenge's own start day (Jason 2026-10-29:
  // start and finish whenever we want), so a Saturday start means Saturday-to-Friday weeks. Without a challenge,
  // Monday (only old callers).
  function weekStart(date, ch) {
    if (ch && isDate(ch.start)) {
      var k = daysBetween(ch.start, date);
      return addDays(date, -(((k % 7) + 7) % 7));
    }
    var p = date.split("-").map(Number);
    var dow = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay(); // 0 Sun .. 6 Sat
    return addDays(date, -((dow + 6) % 7));
  }

  // What a weekly goal asks for in one week. Each day off takes one off the target; then a short week (the last one,
  // or a late joiner's first) is scaled to its length, rounded up: 2 days of a 7-day week of "Lift 2x" asks 1. Never
  // more days than they actually had.
  function weekNeed(perWeek, off, counted) {
    var base = perWeek - off, room = 7 - off;
    if (base <= 0 || room <= 0 || counted <= 0) return 0;
    return Math.min(counted, Math.ceil(base * counted / room - 1e-9));
  }

  // Progress on one weekly goal in the week holding `date`, counting ticks up to `date`.
  function weekProgress(player, ch, goal, date) {
    var start = weekStart(date, ch);
    var done = 0, counted = 0, off = 0;
    for (var d = start; d <= addDays(start, 6); d = addDays(d, 1)) {
      if (isSkip(ch, d) && inChallenge(ch, d)) { off++; continue; }
      if (!activeGoals(ch, d).some(function (g) { return g.id === goal.id; })) continue;
      if (!onRecord(player, ch, d)) continue; // a late joiner's target is their own days, same as strikesFor
      counted++;
      if (d <= date && isDone(player, d, goal.id)) done++;
    }
    var need = weekNeed(goal.perWeek, off, counted);
    return { done: done, need: need, met: need > 0 && done >= need, weekStart: start };
  }

  // Weekly goals met so far this week, and how many there are.
  function weekScore(player, ch, date) {
    var goals = weeklyGoals(ch, date);
    var met = goals.filter(function (g) { return weekProgress(player, ch, g, date).met; }).length;
    return { met: met, of: goals.length };
  }

  // Consecutive met weeks for a weekly goal. This week counts once met; until then the streak through last week stands.
  function weekStreak(player, ch, goalId, today) {
    var goal = goalList(ch).filter(function (g) { return g.id === goalId; })[0];
    if (!goal) return 0;
    var wk = weekStart(today, ch);
    var cur = weekProgress(player, ch, goal, today);
    var n = 0;
    if (cur.met) n++;
    for (var d = addDays(wk, -1); inChallenge(ch, d); d = addDays(weekStart(d, ch), -1)) {
      var pr = weekProgress(player, ch, goal, addDays(weekStart(d, ch), 6));
      if (pr.need === 0 && skipDates(ch).some(function (x) { return weekStart(x, ch) === pr.weekStart; })) continue; // a week off: jump it
      if (!pr.met) break;
      n++;
    }
    return n;
  }

  function dayScore(player, ch, date) {
    var goals = dailyGoals(ch, date);
    var hit = goals.filter(function (g) { return isDone(player, date, g.id); }).length;
    var of = goals.length;
    return { hit: hit, of: of, pct: of ? Math.round((hit / of) * 100) : 0, perfect: of > 0 && hit === of };
  }

  // Current streak for one goal. Today counts if done; if today isn't done yet the streak through yesterday is
  // still alive. A day the goal wasn't active (before addedOn) ends the walk.
  function goalStreak(player, ch, goalId, today) {
    var day = isDone(player, today, goalId) ? today : addDays(today, -1);
    var n = 0;
    while (isSkip(ch, day)) day = addDays(day, -1);
    while (inChallenge(ch, day) && activeGoals(ch, day).some(function (g) { return g.id === goalId; })) {
      if (!isDone(player, day, goalId)) break;
      n++;
      day = addDays(day, -1);
      while (isSkip(ch, day)) day = addDays(day, -1);
    }
    return n;
  }

  // Perfect-day streak: consecutive days with every active goal done, same today/yesterday rule.
  function perfectStreak(player, ch, today) {
    var day = dayScore(player, ch, today).perfect ? today : addDays(today, -1);
    var n = 0;
    while (isSkip(ch, day)) day = addDays(day, -1);
    while (inChallenge(ch, day) && dayScore(player, ch, day).perfect) {
      n++;
      day = addDays(day, -1);
      while (isSkip(ch, day)) day = addDays(day, -1);
    }
    return n;
  }

  // No backdated starts: the server locks every day at noon Pacific the next day, for everyone but the owner,
  // so a start in the past would give days nobody could tick. (Catch-up existed for season 1; with money on the
  // line, backfilling days is the risk, so it's off. The owner can still tick anyone's day.)
  var MAX_BACKDATE = 0;

  // A challenge created with a start date in the past opens a one-time catch-up: its days before the creation day
  // stay tickable until noon the day after it was created, then lock like any other day.
  function catchUpOpen(ch, nowMs) {
    return false; // off: see MAX_BACKDATE. The rest is kept for the record of how season 1 ran.
    /* eslint-disable no-unreachable */
    if (!ch || !ch.createdAt) return false;
    var created = pacificDate(ch.createdAt);
    if (!(ch.start < created)) return false;
    var today = pacificDate(nowMs);
    return today === created || (today === addDays(created, 1) && pacificHour(nowMs) < FINAL_HOUR);
  }

  // The instant catch-up closes: noon Pacific the day after creation (DST-safe: try both offsets).
  function catchUpClosesMs(ch) {
    var d = addDays(pacificDate(ch.createdAt), 1).split("-").map(Number);
    for (var off = 7; off <= 8; off++) {
      var ms = Date.UTC(d[0], d[1] - 1, d[2], FINAL_HOUR + off);
      if (pacificHour(ms) === FINAL_HOUR) return ms;
    }
    return Date.UTC(d[0], d[1] - 1, d[2], FINAL_HOUR + 8);
  }

  // The day a player may still tick: today always; yesterday until noon Pacific; catch-up days while open.
  function isEditable(date, nowMs, ch) {
    var today = pacificDate(nowMs);
    if (date === today) return true;
    if (date === addDays(today, -1) && pacificHour(nowMs) < FINAL_HOUR) return true;
    // The server locks members out of anything older than 3 days back (MAX_BACKDATE keeps catch-up inside that).
    return !!ch && catchUpOpen(ch, nowMs) && date >= ch.start && date >= addDays(today, -3) && date < pacificDate(ch.createdAt || 0) && date < today;
  }

  // A date is final (the board can post it) once it's in the past and nobody can tick it any more.
  function isFinal(date, nowMs, ch) {
    return date < pacificDate(nowMs) && !isEditable(date, nowMs, ch);
  }

  // Open days in this challenge, newest first: today, yesterday until noon, and catch-up days.
  function editableDates(ch, nowMs) {
    var out = [];
    if (!ch) return out;
    var today = pacificDate(nowMs);
    for (var d = today; d >= ch.start && d >= addDays(today, -MAX_BACKDATE - 1); d = addDays(d, -1)) {
      if (inChallenge(ch, d) && isEditable(d, nowMs, ch)) out.push(d);
    }
    return out;
  }

  // Dates in this challenge that are final and have no results doc yet. Oldest first, at most `limit`.
  function resultsDue(ch, existingDates, nowMs, limit) {
    if (!ch) return [];
    var have = {};
    (existingDates || []).forEach(function (d) { have[d] = true; });
    var out = [];
    for (var d = ch.start; d <= ch.end && isFinal(d, nowMs, ch); d = addDays(d, 1)) {
      if (!have[d] && !isSkip(ch, d)) out.push(d);
    }
    return out.slice(-(limit || 7));
  }

  function resultId(date) {
    return date; // results/<date>: deterministic, so two openers can't post the same day twice
  }

  // players: {uid: playerDoc}. Rows sorted by pct desc, then hit desc, then name.
  function buildResult(players, ch, date, nowMs) {
    var rows = Object.keys(players || {}).map(function (uid) {
      var p = players[uid];
      var pc = chFor(ch, uid);
      var s = dayScore(p, pc, date);
      var w = weekScore(p, pc, date);
      return { uid: uid, name: (p && p.name) || "Player", hit: s.hit, of: s.of, pct: s.pct, perfect: s.perfect, wkMet: w.met, wkOf: w.of };
    }).filter(function (r) { return joinedBy(players[r.uid], date); });
    rows.sort(function (a, b) { return b.pct - a.pct || b.hit - a.hit || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
    return { date: date, challengeId: ch.id, rows: rows, createdAt: nowMs };
  }

  // A player counts on dates on or after the day they joined.
  function joinedBy(player, date) {
    if (!player || typeof player.joinedAt !== "number" || !isFinite(player.joinedAt)) return true; // the rules require a number; never crash on one
    return pacificDate(player.joinedAt) <= date;
  }

  // The challenge to show: the one running today (latest start wins), else the next upcoming, else the last ended.
  function currentChallenge(list, today) {
    var all = (list || []).slice().sort(function (a, b) { return a.start !== b.start ? (a.start < b.start ? 1 : -1) : (b.createdAt || 0) - (a.createdAt || 0); });
    var running = all.filter(function (c) { return inChallenge(c, today); });
    if (running.length) return running[0];
    var upcoming = all.filter(function (c) { return c.start > today; }).sort(function (a, b) { return a.start < b.start ? -1 : 1; });
    if (upcoming.length) return upcoming[0];
    return all[0] || null;
  }

  function cleanText(s) {
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  }

  // A trash-talk post: trimmed, single spaces, at most MAX_POST characters.
  function cleanPost(s) {
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, MAX_POST);
  }

  function goalId(seed) {
    return "g" + seed.toString(36);
  }

  function cleanPerWeek(v) {
    var n = Number(v);
    return n >= 1 && n <= 6 ? Math.round(n) : null; // 7 a week is the same as daily
  }

  // Validate a new challenge form. Goals are strings or {text, perWeek}. Returns {ok, errors, value}.
  function validateChallenge(input, today, seed) {
    var errors = {};
    var name = cleanText(input.name);
    var goals = (input.goals || []).map(function (g) {
      return typeof g === "string" ? { text: cleanText(g), perWeek: null } : { text: cleanText(g.text), perWeek: cleanPerWeek(g.perWeek) };
    }).filter(function (g) { return g.text; });
    if (!name) errors.name = "Give the challenge a name.";
    if (!isDate(input.start)) errors.start = "Pick a start date.";
    else if (input.start < addDays(today, -MAX_BACKDATE)) errors.start = "Start today or later.";
    if (!isDate(input.end)) errors.end = "Pick an end date.";
    else if (isDate(input.start) && input.end < input.start) errors.end = "End on or after the start date.";
    else if (isDate(input.start) && daysBetween(input.start, input.end) > 365) errors.end = "Keep it to a year or less.";
    if (goals.length > MAX_GOALS) errors.goals = "Twelve goals at most.";
    var ok = Object.keys(errors).length === 0;
    var value = null;
    if (ok) {
      var g = {};
      var prefix = seed == null ? "g" : goalId(seed) + "_";
      goals.forEach(function (x, i) { g[prefix + (i + 1)] = { text: x.text, addedOn: input.start, closedOn: null, order: i + 1, perWeek: x.perWeek }; });
      value = { name: name, start: input.start, end: input.end, goals: g };
    }
    return { ok: ok, errors: errors, value: value };
  }

  // Patch that adds a goal mid-challenge. It counts from `today` (or the start, if not started yet).
  function addGoalPatch(ch, text, today, seed, perWeek) {
    var t = cleanText(text);
    if (!t) return { error: "Type the goal first." };
    if (goalList(ch).filter(function (g) { return !g.closedOn; }).length >= MAX_GOALS) return { error: "Twelve goals at most." };
    var order = goalList(ch).reduce(function (m, g) { return Math.max(m, g.order || 0); }, 0) + 1;
    var goals = {};
    goals[goalId(seed)] = { text: t, addedOn: today > ch.start ? today : ch.start, closedOn: null, order: order, perWeek: cleanPerWeek(perWeek) };
    return { patch: { goals: goals } };
  }

  // Patch that closes a goal from `today`: it stops counting today, history before today stays.
  function closeGoalPatch(ch, id, today) {
    var g = ch.goals && ch.goals[id];
    if (!g) return { error: "That goal is gone." };
    if (g.closedOn) return { error: "Already closed." };
    var goals = {};
    goals[id] = { closedOn: today > g.addedOn ? today : g.addedOn };
    return { patch: { goals: goals } };
  }

  // Patch that edits goal text. Only before the challenge starts.
  function editGoalPatch(ch, id, text, today, owner) {
    if (!owner && isLocked(ch, today)) return { error: "Goals are locked once the challenge starts. Close it and add a new one." };
    var t = cleanText(text);
    if (!t) return { error: "Type the goal first." };
    var goals = {};
    goals[id] = { text: t };
    return { patch: { goals: goals } };
  }

  // Patch that changes a goal between daily and N-a-week. Only before the challenge starts.
  function cadencePatch(ch, id, perWeek, today, owner) {
    if (!owner && isLocked(ch, today)) return { error: "Goals are locked once the challenge starts. Close it and add a new one." };
    if (!(ch.goals && ch.goals[id])) return { error: "That goal is gone." };
    var goals = {};
    goals[id] = { perWeek: cleanPerWeek(perWeek) };
    return { patch: { goals: goals } };
  }

  function cadenceLabel(g) {
    return isWeekly(g) ? g.perWeek + (g.perWeek === 1 ? " day" : " days") + " a week" : "Every day";
  }

  // Moving the start back is allowed only while the catch-up window can still run: set-up day, or the morning after.
  function canMoveStart(ch, nowMs) {
    if (!ch || !ch.createdAt) return false;
    var created = pacificDate(ch.createdAt), today = pacificDate(nowMs);
    return today === created || (today === addDays(created, 1) && pacificHour(nowMs) < FINAL_HOUR);
  }

  // Patch that moves the start back (up to a week before set-up day). Goals that began on the old start move with it.
  function moveStartPatch(ch, newStart, nowMs) {
    if (!canMoveStart(ch, nowMs)) return { error: "The start can only move back on the day the challenge was set up." };
    if (!isDate(newStart)) return { error: "Pick a date." };
    if (newStart >= ch.start) return { error: "Pick a day before the current start." };
    if (newStart < addDays(pacificDate(ch.createdAt), -MAX_BACKDATE)) return { error: "Start today or later." };
    return datesPatch(ch, newStart, ch.end); // one code path: group and own goals move together, no empty-map writes
  }

  // Owner only: change start and/or end any time. Goals that began on the old start move with it.
  function datesPatch(ch, start, end) {
    if (!isDate(start) || !isDate(end)) return { error: "Pick both dates." };
    if (end < start) return { error: "End on or after the start date." };
    if (daysBetween(start, end) > 365) return { error: "Keep it to a year or less." };
    var patch = { start: start, end: end };
    var goals = {};
    if (start !== ch.start) goalList(ch).forEach(function (g) { if (g.addedOn === ch.start || g.addedOn < start) goals[g.id] = { addedOn: start }; });
    if (Object.keys(goals).length) patch.goals = goals; // an empty map would REPLACE the goals in Firestore
    if (start !== ch.start) {
      var pg = {};
      Object.keys((ch && ch.playerGoals) || {}).forEach(function (uid) {
        var mine = {};
        goalList(ownView(ch, uid)).forEach(function (g) { if (g.addedOn === ch.start || g.addedOn < start) mine[g.id] = { addedOn: start }; });
        if (Object.keys(mine).length) pg[uid] = mine;
      });
      if (Object.keys(pg).length) patch.playerGoals = pg;
    }
    return { patch: patch };
  }

  // ---------- backups: the owner's phone keeps snapshots of everything that matters ----------
  var BACKUP_EVERY_MS = 6 * 3600 * 1000, BACKUP_KEEP = 14;
  // Everything, verbatim: every challenge doc, every player doc (ticks, name, join time, targets, votes, pardon asks),
  // and the group list. Rebuilding from one of these is a guided job (Leo + Jason), not a button: GPT r1 showed a
  // one-tap restore can't put votes, deleted players or newer ticks back safely.
  function snapshotOf(challenges, players, members, nowMs) {
    return { at: nowMs, challenges: JSON.parse(JSON.stringify(challenges || {})), players: JSON.parse(JSON.stringify(players || {})),
      members: JSON.parse(JSON.stringify((members && members.emails) || [])) };
  }
  // Due when the newest snapshot is older than BACKUP_EVERY_MS. Old ones past BACKUP_KEEP get pruned, oldest first.
  function backupPlan(backups, nowMs) {
    var ids = Object.keys(backups || {}).sort(function (a, b) { return (backups[b].at || 0) - (backups[a].at || 0); });
    var newest = ids.length ? backups[ids[0]].at || 0 : 0;
    return { due: !ids.length || nowMs - newest >= BACKUP_EVERY_MS, prune: ids.slice(BACKUP_KEEP - 1) };
  }

  // ---------- pack points: group goals score the group together ----------
  // A daily group goal earns the pack 1 point for each locked day EVERYONE on the record did it; a weekly one, 1 point
  // for each locked week everyone met it. Computed from the ticks, nothing to enter. Days off and pre-join days are
  // skipped exactly like strikes. The open day/week shows progress: who's still short and by how much.
  function groupScore(players, ch, nowMs) {
    players = players || {};
    if (!ch || !isDate(ch.start) || !isDate(ch.end)) return null;
    // A goal removed before it ever counted (closedOn <= addedOn) is gone, here as everywhere else.
    var goals = goalList(ch).filter(function (g) { return !g.personal && !(g.closedOn && g.closedOn <= g.addedOn); });
    if (!goals.length) return null;
    var entrants = Object.keys(players).filter(function (u) { return joinedBy(players[u], ch.end); });
    var today = pacificDate(nowMs);
    var name = function (u) { return (players[u] && players[u].name) || "Player"; };
    var out = goals.map(function (g) {
      var points = 0, of = 0, current = null;
      if (!isWeekly(g)) {
        for (var d = ch.start; d <= ch.end && d <= today; d = addDays(d, 1)) {
          if (isSkip(ch, d) || !(g.addedOn <= d && (!g.closedOn || d < g.closedOn))) continue;
          var who = entrants.filter(function (u) { return onRecord(players[u], ch, d); });
          if (!who.length) continue;
          var missing = who.filter(function (u) { return !isDone(players[u], d, g.id); });
          if (isFinal(d, nowMs, ch)) { of++; if (!missing.length) points++; }
          else if (d === today || !current) current = { label: d === today ? "today" : "yesterday", done: who.length - missing.length, of: who.length, behind: missing.map(function (u) { return { uid: u, name: name(u), left: 1 }; }) };
        }
      } else {
        for (var ws = ch.start; ws <= ch.end && ws <= today; ws = addDays(ws, 7)) {
          var last = addDays(ws, 6) < ch.end ? addDays(ws, 6) : ch.end;
          var rows = entrants.map(function (u) { return { u: u, pr: weekProgress(players[u], chFor(ch, u), g, last < today ? last : today) }; })
            .filter(function (r) { return r.pr.need > 0; });
          if (!rows.length) continue;
          var short = rows.filter(function (r) { return r.pr.done < r.pr.need; });
          if (isFinal(last, nowMs, ch)) { of++; if (!short.length) points++; }
          else current = { label: "this week", done: rows.length - short.length, of: rows.length, behind: short.map(function (r) { return { uid: r.u, name: name(r.u), left: r.pr.need - r.pr.done }; }) };
        }
      }
      return { id: g.id, text: g.text, cadence: cadenceLabel(g), weekly: isWeekly(g), points: points, of: of, current: current };
    });
    return { goals: out, total: out.reduce(function (a, g) { return a + g.points; }, 0), possible: out.reduce(function (a, g) { return a + g.of; }, 0) };
  }

  // ---------- the pot ----------
  // A day is on a player's record from the day they joined, plus the catch-up days if they joined while catch-up was open.
  // (Catch-up is off now, but season 1 ran with it, so its records still score the way they did.)
  function onRecord(player, ch, date) {
    if (joinedBy(player, date)) return true;
    return !!(ch.createdAt && date < pacificDate(ch.createdAt) && ch.start < pacificDate(ch.createdAt) && player.joinedAt < catchUpClosesMs(ch));
  }

  // A strike: a locked day without every daily goal done, or a weekly goal missed when its week locks.
  // Days off, days before a player joined, and days still open never count.
  function strikesFor(player, ch, nowMs) {
    var out = [];
    if (!ch || !isDate(ch.start) || !isDate(ch.end)) return out;
    for (var d = ch.start; d <= ch.end && isFinal(d, nowMs, ch); d = addDays(d, 1)) {
      if (!onRecord(player, ch, d) || isSkip(ch, d)) continue;
      // Fewer goals than the minimum that day is a strike: otherwise setting none (or one) would make a player
      // strike-proof. The minimum only bites when each player sets their own; group-only challenges count as met.
      if (activeGoals(ch, d).length < minGoalsOn(ch)) { out.push({ kind: "day", date: d, nogoal: true }); continue; }
      if (!dailyGoals(ch, d).length) continue; // weekly-only that day: judged by the week
      if (!dayScore(player, ch, d).perfect) out.push({ kind: "day", date: d });
    }
    // Weekly goals are judged on the player's own record: only days they were in, and the target can't
    // exceed the days the goal was active for them. Each day off in the week takes one off the target.
    for (var ws = ch.start; ws <= ch.end; ws = addDays(ws, 7)) {
      var last = addDays(ws, 6) < ch.end ? addDays(ws, 6) : ch.end;
      if (!isFinal(last, nowMs, ch)) continue;
      var off = 0, tally = Object.create(null); // keyed by goal id: no inherited names ("constructor")
      for (var x = ws > ch.start ? ws : ch.start; x <= last; x = addDays(x, 1)) {
        if (isSkip(ch, x)) { off++; continue; }
        if (!onRecord(player, ch, x)) continue;
        activeGoals(ch, x).filter(isWeekly).forEach(function (g) {
          var t = tally[g.id] || (tally[g.id] = { g: g, days: 0, done: 0 });
          t.days++;
          if (isDone(player, x, g.id)) t.done++;
        });
      }
      Object.keys(tally).forEach(function (id) {
        var t = tally[id];
        var need = weekNeed(t.g.perWeek, off, t.days);
        if (need > 0 && t.done < need) out.push({ kind: "week", date: last, goalId: id });
      });
    }
    return out;
  }

  function cleanMoney(v) {
    var n = Math.round(Number(v));
    return n >= 0 && n <= 10000 ? n : null;
  }

  // A pardon: the struck player asks, the others vote. More than half of the other entrants voting yes wipes the strike.
  // Asks and votes live on each player's own doc (players write only their own), keyed by the strike.
  //   players/<uid>.appeals: {<strikeKey>: true}      only counts when the key names <uid> itself
  //   players/<uid>.votes:   {<strikeKey>: true|false} never counts on the voter's own strikes
  function strikeKey(chId, uid, s) {
    return [chId, uid, s.kind, s.date, s.goalId || "-"].join("|");
  }

  function pardonFor(players, entrants, uid, key) {
    var others = entrants.filter(function (u) { return u !== uid; });
    var asked = !!(players[uid] && players[uid].appeals && players[uid].appeals[key] === true);
    var yes = 0, no = 0;
    others.forEach(function (u) {
      var v = players[u] && players[u].votes && players[u].votes[key];
      if (v === true) yes++; else if (v === false) no++;
    });
    var need = Math.floor(others.length / 2) + 1;
    return { key: key, asked: asked, yes: yes, no: no, need: need, voters: others.length, pardoned: asked && others.length > 0 && yes >= need };
  }

  // Everyone on the board is in for the buy-in. Out at `strikes` strikes, after pardons.
  // Comeback: once out, finish without another strike and get `comeback` dollars back, paid from the pot first.
  // Survivors split what's left evenly; if nobody survives, everyone gets their buy-in back.
  function potStatus(players, ch, nowMs) {
    var pot = ch && ch.pot;
    if (!pot || !(pot.buyIn > 0) || !isDate(ch.start) || !isDate(ch.end)) return null;
    if (pot.settled && Array.isArray(pot.settled.rows)) return settledStatus(pot);
    players = players || {};
    var limit = pot.strikes >= 1 ? pot.strikes : 3;
    var back = pot.comeback > 0 ? Math.min(pot.comeback, pot.buyIn) : 0;
    // Entrants: everyone on the board who joined by the last day. Joining after it's over doesn't buy a share.
    var entrants = Object.keys(players).filter(function (uid) { return joinedBy(players[uid], ch.end); });
    var rows = entrants.map(function (uid) {
      var list = strikesFor(players[uid], chFor(ch, uid), nowMs).map(function (s) {
        return Object.assign({}, s, { pardon: pardonFor(players, entrants, uid, strikeKey(ch.id, uid, s)) });
      }).sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
      var n = list.filter(function (s) { return !s.pardon.pardoned; }).length;
      return {
        uid: uid, name: (players[uid] && players[uid].name) || "Player", strikes: n, list: list,
        out: n >= limit, comeback: back > 0 && n === limit, paid: paidOf(pot, uid), paidByOwner: paidByOwnerOf(pot, uid),
      };
    }).sort(function (a, b) { return a.strikes - b.strikes || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
    var alive = rows.filter(function (r) { return !r.out; }).length;
    var total = pot.buyIn * rows.length;
    var comebacks = alive ? rows.filter(function (r) { return r.comeback; }).length : 0;
    var share = alive ? Math.floor(((total - back * comebacks) / alive) * 100) / 100 : pot.buyIn;
    rows.forEach(function (r) { r.payout = !alive ? pot.buyIn : !r.out ? share : r.comeback ? back : 0; });
    return {
      buyIn: pot.buyIn, limit: limit, comeback: back, pot: total, rows: rows, alive: alive, comebacks: comebacks,
      share: share, refund: alive === 0, settled: false,
      paid: rows.filter(function (r) { return r.paid; }).length, final: isFinal(ch.end, nowMs, ch),
    };
  }

  // Settling freezes the pot: who's out, who made a comeback, and every payout. After that, votes and tick fixes
  // change nothing. Pardon votes stay open until the owner settles, so last-day strikes can still be appealed.
  var ROW_KEYS = ["uid", "name", "strikes", "out", "comeback", "payout"];
  function settlePatch(st, nowMs) {
    if (!st) return { error: "There's no pot to settle." };
    if (st.settled) return { error: "Already settled." };
    if (!st.final) return { error: "Settle once the last day locks (noon the day after it ends)." };
    var rows = st.rows.map(function (r) { var o = {}; ROW_KEYS.forEach(function (k) { o[k] = r[k]; }); return o; });
    return { patch: { pot: { settled: { at: nowMs, rows: rows } } } };
  }

  function unsettlePatch() {
    return { patch: { pot: { settled: null } } };
  }

  function settledStatus(pot) {
    var limit = pot.strikes >= 1 ? pot.strikes : 3;
    var back = pot.comeback > 0 ? Math.min(pot.comeback, pot.buyIn) : 0;
    var rows = pot.settled.rows.map(function (r) {
      return { uid: r.uid, name: r.name, strikes: r.strikes, out: !!r.out, comeback: !!r.comeback, payout: r.payout, list: [], paid: paidOf(pot, r.uid), paidByOwner: paidByOwnerOf(pot, r.uid) };
    });
    var alive = rows.filter(function (r) { return !r.out; }).length;
    var survivor = rows.find(function (r) { return !r.out; });
    return {
      buyIn: pot.buyIn, limit: limit, comeback: back, pot: pot.buyIn * rows.length, rows: rows, alive: alive,
      comebacks: alive ? rows.filter(function (r) { return r.comeback; }).length : 0,
      share: survivor ? survivor.payout : pot.buyIn, refund: alive === 0, settled: true, settledAt: pot.settled.at,
      paid: rows.filter(function (r) { return r.paid; }).length, final: true,
    };
  }

  // Owner only: set the buy-in, the strike limit and the comeback. buyIn 0 turns the pot off; comeback 0 turns it off.
  function potPatch(buyIn, strikes, comeback) {
    var b = cleanMoney(buyIn);
    if (b === null) return { error: "Buy-in is a whole-dollar amount, 0 to 10,000." };
    var k = Math.round(Number(strikes));
    if (!(k >= 1 && k <= 20)) return { error: "Strikes: 1 to 20." };
    var c = cleanMoney(comeback == null || comeback === "" ? 0 : comeback);
    if (c === null || c > b) return { error: "The comeback can't be more than the buy-in." };
    return { patch: { pot: { buyIn: b, strikes: k, comeback: c } } };
  }

  // Owner only: who holds the money, and how to pay them (free text, e.g. "Venmo @name"). The app never moves money.
  var MAX_PAYHOW = 80;
  function treasurerPatch(players, uid, payHow) {
    if (uid && !(players && Object.prototype.hasOwnProperty.call(players, uid))) return { error: "Pick someone on the board." };
    var how = String(payHow == null ? "" : payHow).replace(/\s+/g, " ").trim();
    if (how.length > MAX_PAYHOW) return { error: "How to pay: " + MAX_PAYHOW + " characters at most." };
    return { patch: { pot: { treasurer: uid || "", payHow: how } } };
  }
  function treasurerOf(ch) { return (ch && ch.pot && typeof ch.pot.treasurer === "string" && ch.pot.treasurer) || null; }

  // Owner only: house rules, free text everyone reads on the Rules page. The app never scores them.
  // Keeps line breaks; trims each line; at most MAX_RULES characters. Empty clears them.
  var MAX_RULES = 1000;
  function houseRulesPatch(text) {
    var t = String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n").map(function (l) { return l.replace(/[ \t]+/g, " ").trim(); })
      .join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (t.length > MAX_RULES) return { error: "House rules: " + MAX_RULES + " characters at most." };
    return { patch: { houseRules: t } };
  }

  // A player asks for a pardon on one of their own strikes, or takes the ask back.
  function appealPatch(key, on) {
    var m = {};
    m[key] = !!on;
    return { patch: { appeals: m } };
  }

  // A player votes yes or no on someone else's strike.
  function votePatch(key, yes) {
    var m = {};
    m[key] = !!yes;
    return { patch: { votes: m } };
  }

  // Paid is pot.paid alone: the treasurer's tick, or the creator's (who has no limits). pot.ownerPaid is only a marker
  // that the creator ticked it on someone else's watch, shown to the creator; it never makes anyone paid by itself, so
  // the treasurer can always untick.
  function paidOf(pot, uid) { return !!(pot && pot.paid && pot.paid[uid] === true); }
  function paidByOwnerOf(pot, uid) { return !!(paidOf(pot, uid) && pot.ownerPaid && pot.ownerPaid[uid] === true); }
  function ownerPaidPatch(uid, on) { var m = {}; m[uid] = !!on; return { patch: { pot: { ownerPaid: m } } }; }

  function paidPatch(uid, paid) {
    var m = {};
    m[uid] = !!paid;
    return { patch: { pot: { paid: m } } };
  }

  // Owner only: rename the challenge.
  function renamePatch(name) {
    var t = cleanText(name).slice(0, 60);
    if (!t) return { error: "Give it a name." };
    return { patch: { name: t } };
  }

  // Owner only: end early. A running challenge ends tonight (today still counts); one that hasn't started is removed.
  function endPlan(ch, today) {
    if (today < ch.start) return { remove: true };
    if (ch.end <= today) return { error: ch.end < today ? "It's already over." : "It already ends tonight." };
    return { patch: { end: today } };
  }

  // A new challenge starting on `start` takes over: anything still running then ends the day before,
  // and anything that would start on or after it is removed. Days never overlap, so ticks never get shared.
  function handoffPlan(list, start) {
    return (list || []).filter(function (c) { return c.end >= start; }).map(function (c) {
      return c.start < start ? { id: c.id, name: c.name, patch: { end: addDays(start, -1) } } : { id: c.id, name: c.name, remove: true };
    });
  }

  // Firestore merge writes an empty map as-is, wiping what was there. Drop empty maps before any merge write.
  function pruneEmpty(obj) {
    var out = {};
    Object.keys(obj || {}).forEach(function (k) {
      var v = obj[k];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        var inner = pruneEmpty(v);
        if (Object.keys(inner).length) out[k] = inner;
      } else out[k] = v;
    });
    return out;
  }

  // Goal ids that players have ticks for but the challenge no longer lists (e.g. after a bad write). Newest tick last.
  function orphanGoals(players, ch, all) {
    var known = Object.assign({}, (ch && ch.goals) || {}); // ids of every challenge: another challenge's goals aren't missing
    (all || []).forEach(function (c) { Object.assign(known, c.goals || {}); });
    [ch].concat(all || []).forEach(function (c) { var pg = (c && c.playerGoals) || {}; Object.keys(pg).forEach(function (u) { Object.assign(known, pg[u] || {}); }); });
    var found = Object.create(null);
    Object.keys(players || {}).forEach(function (uid) {
      var days = (players[uid] && players[uid].days) || {};
      Object.keys(days).forEach(function (d) {
        if (d < ch.start || d > ch.end) return;
        Object.keys(days[d] || {}).forEach(function (id) {
          if (known[id]) return;
          var f = found[id] || (found[id] = { id: id, days: [], ticks: 0 });
          if (f.days.indexOf(d) < 0) f.days.push(d);
          if (days[d][id] === true) f.ticks++;
        });
      });
    });
    return Object.keys(found).sort(function (a, b) { return a.localeCompare(b, "en", { numeric: true }); }).map(function (id) { found[id].days.sort(); return found[id]; });
  }

  // Patch restoring orphaned goals under their original ids, so existing ticks attach again.
  function recoverGoalsPatch(ch, items) {
    var goals = {}, order = goalList(ch).reduce(function (m, g) { return Math.max(m, g.order || 0); }, 0);
    for (var i = 0; i < items.length; i++) {
      var t = cleanText(items[i].text);
      if (!t) return { error: "Name every goal before recovering." };
      goals[items[i].id] = { text: t, addedOn: ch.start, closedOn: null, order: ++order, perWeek: cleanPerWeek(items[i].perWeek) };
    }
    return { patch: { goals: goals } };
  }

  // Owner correction of anyone's tick: any day inside the challenge, no edit window.
  function ownerTickPatch(ch, date, id, done) {
    if (!inChallenge(ch, date)) return { error: "That day isn't in the challenge." };
    if (!activeGoals(ch, date).some(function (g) { return g.id === id; })) return { error: "That goal doesn't count that day." };
    var day = {}; day[id] = !!done;
    var days = {}; days[date] = day;
    return { patch: { days: days } };
  }

  // Patch for one tick. Refuses outside the edit window or for goals not active that day.
  function tickPatch(ch, date, id, done, nowMs) {
    if (!isEditable(date, nowMs, ch)) return { error: "That day is final." };
    if (!activeGoals(ch, date).some(function (g) { return g.id === id; })) return { error: "That goal doesn't count that day." };
    var day = {};
    day[id] = !!done;
    var days = {};
    days[date] = day;
    return { patch: { days: days } };
  }

  // Last `n` dates up to today, clipped to the challenge. Oldest first.
  function gridDates(ch, today, n) {
    var out = [];
    for (var i = n - 1; i >= 0; i--) {
      var d = addDays(today, -i);
      if (inChallenge(ch, d)) out.push(d);
    }
    return out;
  }

  function dayNumber(ch, date) {
    return daysBetween(ch.start, date) + 1;
  }

  function challengeLength(ch) {
    return daysBetween(ch.start, ch.end) + 1;
  }

  return {
    TZ: TZ, FINAL_HOUR: FINAL_HOUR, MAX_GOALS: MAX_GOALS, MAX_POST: MAX_POST, cleanPost: cleanPost,
    pacificDate: pacificDate, pacificHour: pacificHour, addDays: addDays, daysBetween: daysBetween, isDate: isDate,
    inChallenge: inChallenge, goalList: goalList, activeGoals: activeGoals, isLocked: isLocked, isDone: isDone,
    dayScore: dayScore, goalStreak: goalStreak, perfectStreak: perfectStreak, isEditable: isEditable, isFinal: isFinal,
    strikesFor: strikesFor, potStatus: potStatus, potPatch: potPatch, paidPatch: paidPatch,
    groupScore: groupScore, snapshotOf: snapshotOf, backupPlan: backupPlan, BACKUP_KEEP: BACKUP_KEEP, endForWeeks: endForWeeks, weeksOf: weeksOf, chFor: chFor, ownView: ownView, ownPatch: ownPatch, ownGoals: ownGoals, MAX_PERSONAL: MAX_PERSONAL, ownGoalsWithout: ownGoalsWithout, canAddOwn: canAddOwn,
    minGoalsOn: minGoalsOn, goalSetKey: goalSetKey, signoffFor: signoffFor, signoffVotePatch: signoffVotePatch, ownerSignoffPatch: ownerSignoffPatch, minGoalsPatch: minGoalsPatch,
    strikeKey: strikeKey, appealPatch: appealPatch, votePatch: votePatch, houseRulesPatch: houseRulesPatch, MAX_RULES: MAX_RULES, treasurerPatch: treasurerPatch, treasurerOf: treasurerOf, MAX_PAYHOW: MAX_PAYHOW, paidOf: paidOf, ownerPaidPatch: ownerPaidPatch, settlePatch: settlePatch, unsettlePatch: unsettlePatch,
    isSkip: isSkip, skipDates: skipDates, skipPatch: skipPatch, renamePatch: renamePatch, endPlan: endPlan, handoffPlan: handoffPlan,
    catchUpOpen: catchUpOpen, pruneEmpty: pruneEmpty, orphanGoals: orphanGoals, recoverGoalsPatch: recoverGoalsPatch, ownerTickPatch: ownerTickPatch, datesPatch: datesPatch, canMoveStart: canMoveStart, moveStartPatch: moveStartPatch, catchUpClosesMs: catchUpClosesMs, editableDates: editableDates, MAX_BACKDATE: MAX_BACKDATE,
    resultsDue: resultsDue, resultId: resultId, buildResult: buildResult, joinedBy: joinedBy,
    currentChallenge: currentChallenge, cleanText: cleanText, validateChallenge: validateChallenge,
    addGoalPatch: addGoalPatch, cadencePatch: cadencePatch, cadenceLabel: cadenceLabel, isWeekly: isWeekly,
    dailyGoals: dailyGoals, weeklyGoals: weeklyGoals, weekStart: weekStart, weekNeed: weekNeed, weekProgress: weekProgress,
    weekScore: weekScore, weekStreak: weekStreak, closeGoalPatch: closeGoalPatch, editGoalPatch: editGoalPatch, tickPatch: tickPatch,
    gridDates: gridDates, dayNumber: dayNumber, challengeLength: challengeLength
  };
});
