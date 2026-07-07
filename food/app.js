// UI layer for the voice food log. All computation lives in parser.js/foods.js
// (node-tested); this file owns DOM, localStorage ("food-log" key) and speech.

import { parseLog, totalsOf } from "./parser.js?v=1";

const KEY = "food-log";
const $ = (id) => document.getElementById(id);

// --- storage (read-modify-write over current storage, house rule) -----------

function readSaved() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function normalize(s) {
  return {
    goal: Number.isFinite(s.goal) ? s.goal : 2000,
    entries: Array.isArray(s.entries) ? s.entries : [],
  };
}

let state = normalize(readSaved());
let viewDay = null; // null = today; else "YYYY-MM-DD"
let confirmingDelete = null;

function save(mutate) {
  const s = normalize(readSaved());
  mutate(s);
  localStorage.setItem(KEY, JSON.stringify(s));
  state = s;
  render();
}

// --- day helpers -------------------------------------------------------------

function dayKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const todayKey = () => dayKey(new Date());

function entriesFor(key) {
  return state.entries.filter((e) => dayKey(new Date(e.when)) === key);
}

function lastNDays(n) {
  const days = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    days.push(d);
  }
  return days;
}

function streakDays() {
  const logged = new Set(state.entries.map((e) => dayKey(new Date(e.when))));
  let streak = 0;
  const now = new Date();
  // today counts if logged; otherwise the streak may still be alive from yesterday
  let i = logged.has(todayKey()) ? 0 : 1;
  for (; ; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    if (!logged.has(dayKey(d))) break;
    streak++;
  }
  return streak;
}

// --- logging -----------------------------------------------------------------

function logText(text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  const { items, totals } = parseLog(trimmed);
  if (!items.length) {
    toast("Couldn't find any food in that — try naming the foods");
    return;
  }
  const entry = {
    id: Date.now() + Math.random().toString(36).slice(2, 6),
    when: new Date().toISOString(),
    text: trimmed,
    items,
    ...totals,
  };
  save((s) => s.entries.push(entry));
  $("logInput").value = "";
  viewDay = null;
  const unknown = items.filter((i) => !i.matched).length;
  toast(unknown
    ? `Logged ${totals.kcal} kcal — ${unknown} item${unknown > 1 ? "s" : ""} need a tap below`
    : `Logged ${totals.kcal} kcal`);
}

function recomputeEntry(entry) {
  Object.assign(entry, totalsOf(entry.items));
}

function fixItem(entryId, itemIdx, replacementName, manualKcal) {
  save((s) => {
    const entry = s.entries.find((e) => e.id === entryId);
    if (!entry) return;
    const item = entry.items[itemIdx];
    if (!item) return;
    if (replacementName) {
      const qty = item.qty ?? 1;
      const reparsed = parseLog(`${qty} ${replacementName}`).items[0];
      if (reparsed?.matched) entry.items[itemIdx] = { ...reparsed, text: item.text };
    } else if (Number.isFinite(manualKcal)) {
      Object.assign(item, { matched: true, manual: true, kcal: Math.round(manualKcal), p: 0, c: 0, f: 0 });
    }
    recomputeEntry(entry);
  });
}

function deleteEntry(id) {
  save((s) => {
    s.entries = s.entries.filter((e) => e.id !== id);
  });
}

// --- rendering ---------------------------------------------------------------

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmt(n) { return n.toLocaleString("en-US"); }

function renderTiles() {
  const tiles = $("tiles");
  tiles.textContent = "";
  const key = viewDay ?? todayKey();
  const t = totalsOf(entriesFor(key).flatMap((e) => e.items));

  const hero = el("div", "tile hero");
  const v = el("div", "v", `${fmt(t.kcal)} `);
  const goalSpan = el("span", "goal", `/ ${fmt(state.goal)} kcal`);
  v.appendChild(goalSpan);
  hero.appendChild(v);
  const meter = el("div", "meter");
  const fill = el("div");
  const frac = state.goal > 0 ? t.kcal / state.goal : 0;
  fill.style.width = `${Math.min(100, frac * 100)}%`;
  if (frac > 1) fill.classList.add("over");
  meter.appendChild(fill);
  hero.appendChild(meter);
  const status = el("div", "status");
  if (frac > 1) {
    const overBy = t.kcal - state.goal;
    const strong = el("span", "overtext", `${fmt(overBy)} kcal over`);
    status.append(strong, ` your ${fmt(state.goal)} goal`);
  } else {
    status.textContent = `${fmt(state.goal - t.kcal)} kcal left`;
  }
  hero.appendChild(status);
  tiles.appendChild(hero);

  for (const [label, val, unit] of [["Protein", t.p, "g"], ["Carbs", t.c, "g"], ["Fat", t.f, "g"]]) {
    const tile = el("div", "tile");
    tile.appendChild(el("div", "v", `${Math.round(val)}${unit}`));
    tile.appendChild(el("div", "l", label));
    tiles.appendChild(tile);
  }
}

function itemLine(entry, idx) {
  const item = entry.items[idx];
  const row = el("div", item.matched ? "item" : "item unknown");
  if (item.matched) {
    const qtyStr = item.unit
      ? `${item.qty} ${item.unit}`
      : item.qty !== 1 ? `${item.qty}×` : "";
    row.appendChild(el("span", "", `${qtyStr} ${item.name}`.trim()));
    row.appendChild(el("span", "m",
      item.manual
        ? `${item.kcal} kcal (your estimate)`
        : `${item.kcal} kcal · ${item.p}p ${item.c}c ${item.f}f`));
  } else {
    row.appendChild(el("span", "", `“${item.text}” — not sure what this is`));
    const fixes = el("div", "fixrow");
    for (const name of item.suggestions ?? []) {
      const b = el("button", "", name);
      b.addEventListener("click", () => fixItem(entry.id, idx, name));
      fixes.appendChild(b);
    }
    const kcalIn = el("input");
    kcalIn.type = "number";
    kcalIn.placeholder = "kcal?";
    kcalIn.inputMode = "numeric";
    const apply = el("button", "", "set");
    apply.addEventListener("click", () => {
      const v = parseFloat(kcalIn.value);
      if (Number.isFinite(v) && v >= 0) fixItem(entry.id, idx, null, v);
    });
    fixes.append(kcalIn, apply);
    row.appendChild(fixes);
  }
  return row;
}

function renderEntries() {
  const key = viewDay ?? todayKey();
  const banner = $("dayBanner");
  if (viewDay && viewDay !== todayKey()) {
    banner.className = "daybanner show";
    banner.textContent = "";
    const d = new Date(viewDay + "T12:00:00");
    banner.appendChild(el("span", "", `Viewing ${d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}`));
    const back = el("button", "", "Back to today");
    back.addEventListener("click", () => { viewDay = null; render(); });
    banner.appendChild(back);
    $("entriesTitle").textContent = "That day";
  } else {
    banner.className = "daybanner";
    $("entriesTitle").textContent = "Today";
  }

  const box = $("entries");
  box.textContent = "";
  const list = entriesFor(key);
  if (!list.length) {
    box.appendChild(el("div", "empty",
      key === todayKey() ? "Nothing logged yet — say what you had." : "Nothing logged that day."));
    return;
  }
  for (const entry of list) {
    const div = el("div", "entry");
    const head = el("div", "head");
    head.appendChild(el("span", "when",
      new Date(entry.when).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })));
    head.appendChild(el("span", "said", entry.text));
    head.appendChild(el("span", "kcal", `${fmt(entry.kcal)} kcal`));
    const del = el("button", "del", confirmingDelete === entry.id ? "sure?" : "✕");
    if (confirmingDelete === entry.id) del.classList.add("confirm");
    del.title = "Delete entry";
    del.addEventListener("click", () => {
      if (confirmingDelete === entry.id) {
        confirmingDelete = null;
        deleteEntry(entry.id);
      } else {
        confirmingDelete = entry.id;
        render();
      }
    });
    head.appendChild(del);
    div.appendChild(head);

    const items = el("div", "items");
    entry.items.forEach((_, idx) => items.appendChild(itemLine(entry, idx)));
    div.appendChild(items);
    box.appendChild(div);
  }
}

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function renderChart() {
  const svg = $("chart");
  svg.textContent = "";
  const NS = "http://www.w3.org/2000/svg";
  const W = 520, H = 150, padB = 20, padT = 18, padR = 44;
  const days = lastNDays(14);
  const perDay = days.map((d) => {
    const key = dayKey(d);
    return { key, d, kcal: totalsOf(entriesFor(key).flatMap((e) => e.items)).kcal };
  });
  const maxV = Math.max(state.goal * 1.15, ...perDay.map((p) => p.kcal), 1);
  const plotW = W - padR;
  const slot = plotW / 14;
  const barW = Math.min(22, slot * 0.6);
  const y = (v) => H - padB - (v / maxV) * (H - padB - padT);

  // baseline + goal line (recessive)
  const base = document.createElementNS(NS, "line");
  base.setAttribute("x1", 0); base.setAttribute("x2", plotW);
  base.setAttribute("y1", y(0)); base.setAttribute("y2", y(0));
  base.setAttribute("stroke", css("--baseline"));
  svg.appendChild(base);

  const goalY = y(state.goal);
  const goal = document.createElementNS(NS, "line");
  goal.setAttribute("x1", 0); goal.setAttribute("x2", plotW);
  goal.setAttribute("y1", goalY); goal.setAttribute("y2", goalY);
  goal.setAttribute("stroke", css("--text-muted"));
  goal.setAttribute("stroke-dasharray", "4 4");
  goal.setAttribute("stroke-width", "1");
  svg.appendChild(goal);
  const goalLabel = document.createElementNS(NS, "text");
  goalLabel.setAttribute("x", plotW + 6);
  goalLabel.setAttribute("y", goalY + 4);
  goalLabel.setAttribute("fill", css("--text-muted"));
  goalLabel.setAttribute("font-size", "11");
  goalLabel.textContent = "goal";
  svg.appendChild(goalLabel);

  const today = todayKey();
  perDay.forEach((p, i) => {
    const cx = i * slot + slot / 2;
    const g = document.createElementNS(NS, "g");
    g.setAttribute("class", "bar");
    const title = document.createElementNS(NS, "title");
    title.textContent = `${p.d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} — ${fmt(p.kcal)} kcal`;
    g.appendChild(title);

    if (p.kcal > 0) {
      const h = Math.max(2, y(0) - y(p.kcal));
      const r = Math.min(3, barW / 2, h);
      const x0 = cx - barW / 2, yTop = y(0) - h;
      const path = document.createElementNS(NS, "path");
      path.setAttribute("d",
        `M ${x0} ${y(0)} V ${yTop + r} Q ${x0} ${yTop} ${x0 + r} ${yTop} ` +
        `H ${x0 + barW - r} Q ${x0 + barW} ${yTop} ${x0 + barW} ${yTop + r} V ${y(0)} Z`);
      path.setAttribute("fill", css("--bar"));
      g.appendChild(path);
    }
    // invisible hit target wider than the mark
    const hit = document.createElementNS(NS, "rect");
    hit.setAttribute("x", i * slot); hit.setAttribute("y", padT - 10);
    hit.setAttribute("width", slot); hit.setAttribute("height", H - padT + 10);
    hit.setAttribute("fill", "transparent");
    g.appendChild(hit);

    const isToday = p.key === today;
    if (isToday && p.kcal > 0) {
      const lbl = document.createElementNS(NS, "text");
      lbl.setAttribute("x", cx); lbl.setAttribute("y", y(p.kcal) - 5);
      lbl.setAttribute("text-anchor", "middle");
      lbl.setAttribute("fill", css("--text-secondary"));
      lbl.setAttribute("font-size", "11");
      lbl.setAttribute("font-weight", "600");
      lbl.textContent = fmt(p.kcal);
      svg.appendChild(lbl);
    }
    const axis = document.createElementNS(NS, "text");
    axis.setAttribute("x", cx); axis.setAttribute("y", H - 6);
    axis.setAttribute("text-anchor", "middle");
    axis.setAttribute("fill", css(isToday ? "--text-secondary" : "--text-muted"));
    axis.setAttribute("font-size", "10");
    if (isToday) axis.setAttribute("font-weight", "700");
    axis.textContent = isToday ? "today" : p.d.toLocaleDateString(undefined, { weekday: "narrow" });
    svg.appendChild(axis);

    g.addEventListener("click", () => {
      viewDay = p.key === today ? null : p.key;
      render();
    });
    svg.insertBefore(g, svg.firstChild); // bars under labels
  });

  // table view (accessible fallback)
  const table = $("historyTable");
  table.textContent = "";
  const hr = el("tr");
  for (const h of ["Day", "kcal", "Protein", "Carbs", "Fat"]) hr.appendChild(el("th", "", h));
  table.appendChild(hr);
  for (const p of perDay) {
    const t = totalsOf(entriesFor(p.key).flatMap((e) => e.items));
    const tr = el("tr");
    tr.appendChild(el("td", "", p.d.toLocaleDateString(undefined, { month: "short", day: "numeric" })));
    for (const v of [t.kcal, `${Math.round(t.p)}g`, `${Math.round(t.c)}g`, `${Math.round(t.f)}g`]) {
      tr.appendChild(el("td", "", String(v)));
    }
    table.appendChild(tr);
  }

  const s = streakDays();
  $("streak").textContent = s >= 2 ? `🔥 ${s}-day streak` : s === 1 ? "🔥 day 1" : "";
}

function render() {
  renderTiles();
  renderEntries();
  renderChart();
  $("goal").value = state.goal;
}

// --- copy-for-Claude ---------------------------------------------------------

function claudePrompt() {
  const key = viewDay ?? todayKey();
  const list = entriesFor(key);
  const t = totalsOf(list.flatMap((e) => e.items));
  const lines = list.map((e) => {
    const when = new Date(e.when).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const items = e.items.map((i) =>
      i.matched ? `${i.name} ~${i.kcal} kcal` : `"${i.text}" (unestimated)`).join(", ");
    return `- ${when}: "${e.text}" → ${items}`;
  });
  return [
    `Here's my food log for ${key} from my simple voice tracker, with its rough built-in estimates:`,
    ...(lines.length ? lines : ["(nothing logged)"]),
    ``,
    `App's running total: ${t.kcal} kcal, ${t.p} g protein, ${t.c} g carbs, ${t.f} g fat. My daily goal is ${state.goal} kcal.`,
    ``,
    `Please sanity-check these estimates (correct anything that looks off — trust your judgment over the app's), estimate anything marked unestimated, give me a corrected day total, and one honest sentence of accountability feedback.`,
  ].join("\n");
}

async function copyForClaude() {
  const text = claudePrompt();
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied — paste it to Claude");
  } catch {
    // clipboard API can be unavailable (permissions); fall back to a textarea
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    toast("Copied — paste it to Claude");
  }
}

// --- toast -------------------------------------------------------------------

let toastTimer = null;
function toast(msg) {
  const node = $("toast");
  node.textContent = msg;
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 2600);
}

// --- speech ------------------------------------------------------------------

function setupSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = $("mic");
  if (!SR) {
    mic.style.display = "none"; // keyboard dictation into the text field still works
    return;
  }
  let rec = null;
  mic.addEventListener("click", () => {
    if (rec) {
      rec.stop();
      return;
    }
    rec = new SR();
    rec.lang = navigator.language || "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    mic.classList.add("listening");
    rec.onresult = (ev) => {
      const text = Array.from(ev.results).map((r) => r[0].transcript).join(" ");
      $("logInput").value = text;
    };
    rec.onerror = () => toast("Mic didn't work — type it instead");
    rec.onend = () => {
      mic.classList.remove("listening");
      rec = null;
      if ($("logInput").value.trim()) logText($("logInput").value);
    };
    rec.start();
  });
}

// --- wire-up -----------------------------------------------------------------

$("logBtn").addEventListener("click", () => logText($("logInput").value));
$("logInput").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") logText($("logInput").value);
});
$("goal").addEventListener("change", () => {
  const v = parseInt($("goal").value, 10);
  if (Number.isFinite(v) && v >= 500 && v <= 10000) save((s) => { s.goal = v; });
});
$("claudeBtn").addEventListener("click", copyForClaude);

// re-render on bfcache restore so another tab's writes show up (house rule)
window.addEventListener("pageshow", (ev) => {
  if (ev.persisted) {
    state = normalize(readSaved());
    render();
  }
});

setupSpeech();
render();

// test hook
window.__foodDebug = { readSaved, parseLog };
