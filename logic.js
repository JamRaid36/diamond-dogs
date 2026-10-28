/* Diamond Dogs — pure game logic. No DOM, no network, no clock reads except where `now` is passed in.
 * Loaded as a classic script in the page (window.DDLogic) and required by the node test suite.
 * Data shapes (Firestore):
 *   challenges/<id>  {name, start, end, createdBy, createdAt, goals: {<goalId>: {text, addedOn, closedOn|null, order}}}
 *   players/<uid>    {name, joinedAt, targets: {<goalId>: text}, days: {<YYYY-MM-DD>: {<goalId>: bool}}}
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

  var dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  var hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" });

  function pacificDate(ms) {
    return dateFmt.format(new Date(ms));
  }

  function pacificHour(ms) {
    return Number(hourFmt.format(new Date(ms))) % 24;
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

  function goalList(ch) {
    var g = (ch && ch.goals) || {};
    return Object.keys(g)
      .map(function (id) { return Object.assign({ id: id }, g[id]); })
      .sort(function (a, b) { return (a.order || 0) - (b.order || 0) || (a.addedOn < b.addedOn ? -1 : 1); });
  }

  // Goals that count on `date`: added on or before it, not closed on or before it, and the date inside the challenge.
  function activeGoals(ch, date) {
    if (!inChallenge(ch, date)) return [];
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

  function dayScore(player, ch, date) {
    var goals = activeGoals(ch, date);
    var hit = goals.filter(function (g) { return isDone(player, date, g.id); }).length;
    var of = goals.length;
    return { hit: hit, of: of, pct: of ? Math.round((hit / of) * 100) : 0, perfect: of > 0 && hit === of };
  }

  // Current streak for one goal. Today counts if done; if today isn't done yet the streak through yesterday is
  // still alive. A day the goal wasn't active (before addedOn) ends the walk.
  function goalStreak(player, ch, goalId, today) {
    var day = isDone(player, today, goalId) ? today : addDays(today, -1);
    var n = 0;
    while (inChallenge(ch, day) && activeGoals(ch, day).some(function (g) { return g.id === goalId; })) {
      if (!isDone(player, day, goalId)) break;
      n++;
      day = addDays(day, -1);
    }
    return n;
  }

  // Perfect-day streak: consecutive days with every active goal done, same today/yesterday rule.
  function perfectStreak(player, ch, today) {
    var day = dayScore(player, ch, today).perfect ? today : addDays(today, -1);
    var n = 0;
    while (inChallenge(ch, day) && dayScore(player, ch, day).perfect) {
      n++;
      day = addDays(day, -1);
    }
    return n;
  }

  // The day a player may still tick: today always; yesterday until noon Pacific.
  function isEditable(date, nowMs) {
    var today = pacificDate(nowMs);
    if (date === today) return true;
    return date === addDays(today, -1) && pacificHour(nowMs) < FINAL_HOUR;
  }

  // A date is final (scoreboard can post) from noon Pacific the next day.
  function isFinal(date, nowMs) {
    var today = pacificDate(nowMs);
    if (date < addDays(today, -1)) return true;
    return date === addDays(today, -1) && pacificHour(nowMs) >= FINAL_HOUR;
  }

  // Dates in this challenge that are final and have no results doc yet. Oldest first, at most `limit`.
  function resultsDue(ch, existingDates, nowMs, limit) {
    if (!ch) return [];
    var have = {};
    (existingDates || []).forEach(function (d) { have[d] = true; });
    var out = [];
    for (var d = ch.start; d <= ch.end && isFinal(d, nowMs); d = addDays(d, 1)) {
      if (!have[d]) out.push(d);
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
      var s = dayScore(p, ch, date);
      return { uid: uid, name: (p && p.name) || "Player", hit: s.hit, of: s.of, pct: s.pct, perfect: s.perfect };
    }).filter(function (r) { return joinedBy(players[r.uid], date); });
    rows.sort(function (a, b) { return b.pct - a.pct || b.hit - a.hit || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
    return { date: date, challengeId: ch.id, rows: rows, createdAt: nowMs };
  }

  // A player counts on dates on or after the day they joined.
  function joinedBy(player, date) {
    if (!player || !player.joinedAt) return true;
    return pacificDate(player.joinedAt) <= date;
  }

  // The challenge to show: the one running today (latest start wins), else the next upcoming, else the last ended.
  function currentChallenge(list, today) {
    var all = (list || []).slice().sort(function (a, b) { return a.start < b.start ? 1 : -1; });
    var running = all.filter(function (c) { return inChallenge(c, today); });
    if (running.length) return running[0];
    var upcoming = all.filter(function (c) { return c.start > today; }).sort(function (a, b) { return a.start < b.start ? -1 : 1; });
    if (upcoming.length) return upcoming[0];
    return all[0] || null;
  }

  function cleanText(s) {
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  }

  function goalId(seed) {
    return "g" + seed.toString(36);
  }

  // Validate a new challenge form. Returns {ok, errors: {field: message}, value}.
  function validateChallenge(input, today) {
    var errors = {};
    var name = cleanText(input.name);
    var goals = (input.goals || []).map(cleanText).filter(Boolean);
    if (!name) errors.name = "Give the challenge a name.";
    if (!isDate(input.start)) errors.start = "Pick a start date.";
    else if (input.start < today) errors.start = "Start today or later.";
    if (!isDate(input.end)) errors.end = "Pick an end date.";
    else if (isDate(input.start) && input.end < input.start) errors.end = "End on or after the start date.";
    else if (isDate(input.start) && daysBetween(input.start, input.end) > 365) errors.end = "Keep it to a year or less.";
    if (!goals.length) errors.goals = "Add at least one goal.";
    if (goals.length > MAX_GOALS) errors.goals = "Twelve goals at most.";
    var ok = Object.keys(errors).length === 0;
    var value = null;
    if (ok) {
      var g = {};
      goals.forEach(function (text, i) { g["g" + (i + 1)] = { text: text, addedOn: input.start, closedOn: null, order: i + 1 }; });
      value = { name: name, start: input.start, end: input.end, goals: g };
    }
    return { ok: ok, errors: errors, value: value };
  }

  // Patch that adds a goal mid-challenge. It counts from `today` (or the start, if not started yet).
  function addGoalPatch(ch, text, today, seed) {
    var t = cleanText(text);
    if (!t) return { error: "Type the goal first." };
    if (goalList(ch).filter(function (g) { return !g.closedOn; }).length >= MAX_GOALS) return { error: "Twelve goals at most." };
    var order = goalList(ch).reduce(function (m, g) { return Math.max(m, g.order || 0); }, 0) + 1;
    var goals = {};
    goals[goalId(seed)] = { text: t, addedOn: today > ch.start ? today : ch.start, closedOn: null, order: order };
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
  function editGoalPatch(ch, id, text, today) {
    if (isLocked(ch, today)) return { error: "Goals are locked once the challenge starts. Close it and add a new one." };
    var t = cleanText(text);
    if (!t) return { error: "Type the goal first." };
    var goals = {};
    goals[id] = { text: t };
    return { patch: { goals: goals } };
  }

  // Patch for one tick. Refuses outside the edit window or for goals not active that day.
  function tickPatch(ch, date, id, done, nowMs) {
    if (!isEditable(date, nowMs)) return { error: "That day is final." };
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
    TZ: TZ, FINAL_HOUR: FINAL_HOUR, MAX_GOALS: MAX_GOALS,
    pacificDate: pacificDate, pacificHour: pacificHour, addDays: addDays, daysBetween: daysBetween, isDate: isDate,
    inChallenge: inChallenge, goalList: goalList, activeGoals: activeGoals, isLocked: isLocked, isDone: isDone,
    dayScore: dayScore, goalStreak: goalStreak, perfectStreak: perfectStreak, isEditable: isEditable, isFinal: isFinal,
    resultsDue: resultsDue, resultId: resultId, buildResult: buildResult, joinedBy: joinedBy,
    currentChallenge: currentChallenge, cleanText: cleanText, validateChallenge: validateChallenge,
    addGoalPatch: addGoalPatch, closeGoalPatch: closeGoalPatch, editGoalPatch: editGoalPatch, tickPatch: tickPatch,
    gridDates: gridDates, dayNumber: dayNumber, challengeLength: challengeLength
  };
});
