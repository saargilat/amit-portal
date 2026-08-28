// Amit analysis portal — four views over the encrypted bundle. No backend: decrypt, compute,
// render, all client-side. Simulator lives in sim.js (parity-pinned to Python).
import * as sim from "./sim.js?v=7cb194fbfa";

let DATA = null;
const PT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const PTs = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Los_Angeles",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const fmtPT = x => { const d = typeof x === "number" ? new Date(x * 1000) : new Date(x);
  return isNaN(d) ? "" : PT.format(d).replace(",", ""); };
const fmtPTt = x => { const d = typeof x === "number" ? new Date(x * 1000) : new Date(x);
  return isNaN(d) ? "" : PTs.format(d); };

// one description per field, shared by every tab (user 2026-08-03)
const TIPS = {
  rank: "Position when sorted by total P&L (1 = best combo this sweep)",
  ceiling: "Max entry price in cents — the buy fires only if the ask is at or below this",
  tp: "Take-profit in cents — resting sell that fills when the bid touches this level. Slide to 100 = OFF: ride to settlement (no exit fee, keeps the last cent, bears settlement risk)",
  stop: "Disaster-stop trigger in cents — bid at/below this starts the stop clock (0/None = no stop)",
  cfm: "Stop confirmation — minutes the bid must stay at/below the stop before selling (filters wicks)",
  adm: "Follow admin sell advice only in these price regions (low/mid/high are independent on/off; boundaries default 40¢ and 70¢)",
  admLowMax: "Boundary between the LOW and MID regions (¢) — his sells below this count as panic bails",
  admHighMin: "Boundary between the MID and HIGH regions (¢) — his sells at/above this count as profit-taking",
  ent: "Picks actually entered (ask was at/below ceiling)",
  po: "Return per OPPORTUNITY: total P&L ÷ ALL available picks ÷ $10 stake — unlike %/bet, a selective combo pays for the picks it sits out (%/opp = %/bet × share entered)",
  wr: "Profitable: % of entered picks that made money (a bet can profit via TP even when the pick loses the match — and vice versa)",
  p5: "Stability: block-bootstrap 5th-percentile total (blocks of 7 date-consecutive picks, B=300, fixed seed). The total you would still have in the unlucky 5% of alternate histories — positive means robustly profitable, not streak-dependent.",
  tstat: "t-statistic of the per-pick P&L mean (mean ÷ standard error) — larger magnitude = harder to explain as luck",
  total: "Total simulated P&L across all picks, fees included",
  pb: "Per-bet return: total P&L ÷ entered bets ÷ $10 stake, as % — how hard each bet worked",
  gate: "Score-gate applied to every stop: shown as overRunway/desperateRunway/desperateDeficit — 1/2/2 = the DEPLOYED gate (2-2-1), 3/2/2 = the watched gate_223, off = stop fires ungated. Only computed for the full-data cohort (since Jul 30): earlier picks have no score tape",
  overRunway: "Gate: SELL when the opponent needs at most this many games to win the match (truly over)",
  desperateRunway: "Gate: paired with desperateDeficit — SELL when the opponent needs at most this many games (both must hold)",
  desperateDeficit: "Gate: SELL when down at least this many breaks in the current set AND runway is within desperateRunway",
};
const attr = t => String(t || "").replace(/"/g, "&quot;");

// global start filter (user 2026-08-03) — applies to Games/Books/Lab; sweep grids are
// Python-computed over all picks and cannot be re-cut client-side.
const SINCE_OPTS = [
  ["2026-08-06", "since Aug 6 — v2 era (switched over Aug 5 22:43 PT)"],
  ["2026-07-30", "since Jul 30 — FULL data (scores + price series through settlement)"],
  ["2026-07-25", "since Jul 25 — strategy frozen"],
  ["", "all picks"],
];
// Jul 29 was retired as a boundary (2026-08-03): scores began then, but pre-Jul-30 picks have
// truncated tails (flushed 4-59 min before settlement) — only Jul 30+ supports faithful replay.
let SINCE = sessionStorage.getItem("amit_since") ?? "2026-07-30";   // fresh loads default to FULL data (user 2026-08-04)
if (SINCE === "2026-07-29") SINCE = "2026-07-30";
const sinceOK = ts => !SINCE || fmtPT(ts).slice(0, 10) >= SINCE;

// ---------------- crypto gate (PBKDF2 -> AES-GCM; bundle.enc holds salt|iv|ciphertext) ----------------
async function decrypt(buf, password) {
  const b = new Uint8Array(buf);
  const salt = b.slice(0, 16), iv = b.slice(16, 28), ct = b.slice(28);
  const km = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 200000, hash: "SHA-256" },
    km, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(pt));
}

async function dataFetch(name) {
  for (const base of ["data/", "../data/"]) {           // Pages layout, then local-dev layout
    const r = await fetch(base + name).catch(() => null);
    if (r && r.ok) return r;
  }
  throw new Error("data not found: " + name);
}

async function unlock() {
  const pw = document.getElementById("pw").value;
  const msg = document.getElementById("lockmsg");
  msg.textContent = "decrypting…";
  try {
    const buf = await (await dataFetch("bundle.enc?v=8c60dba700")).arrayBuffer();
    DATA = await decrypt(buf, pw);
    sessionStorage.setItem("amit_pw", pw);
    document.getElementById("lock").hidden = true;
    document.getElementById("app").hidden = false;
    document.getElementById("meta").textContent =
      `${DATA.lifecycles.length} lifecycles · generated ${fmtPT(DATA.generated)} PT`;
  } catch (e) {
    msg.textContent = "wrong password (or corrupt bundle)";
    return;
  }
  parity(); route();
}

async function parity() {
  try {
    const fails = await sim.checkParity(DATA.vectors || {}, DATA.config.gate);
    const el = document.getElementById("parity");
    el.textContent = fails.length ? `parity: ${fails.length} FAIL` : "parity: ✓";
    el.className = fails.length ? "bad" : "good";
    if (fails.length) console.warn("parity failures", fails);
  } catch (e) { document.getElementById("parity").textContent = "parity: n/a"; }
}

// ---------------- routing ----------------
const view = () => document.getElementById("view");
window.addEventListener("hashchange", route);
function route() {
  if (!DATA) return;
  GNAV = {};
  const h = location.hash.replace("#", "") || "games";
  document.querySelectorAll(".tab").forEach(a => a.classList.toggle("active", a.hash === "#" + h.split("/")[0]));
  if (h.startsWith("games/")) return gameView(decodeURIComponent(h.slice(6)));
  if (h === "books") return booksView();
  if (h === "sweep") return sweepView();
  if (h === "lab") return labView();
  return gamesList();
}

// ---------------- Games ----------------
function pickWon(r) {
  if (r.match_won === true || r.match_won === false) return r.match_won;   // export-resolved
  const sn = (r.player || "").split(" ").pop().toLowerCase();
  if (r.settle_result_player) return r.settle_result_player.toLowerCase().includes(sn);
  const s = DATA.settles[r.mkt];
  return s == null ? null : s === "yes";
}

function gamesList() {
  const rows = DATA.lifecycles.filter(r => sinceOK(r.start_ts))
    .sort((a, b) => (b.start_ts || "").localeCompare(a.start_ts || ""));
  const closed = rows.filter(r => r.pnl != null && r.outcome && r.outcome !== "skip" && r.outcome !== "unresolved" && !r.counterfactual);
  const decided = rows.filter(r => pickWon(r) !== null);
  const pw = decided.filter(r => pickWon(r) === true).length;
  const prof = closed.filter(r => r.pnl > 0).length;
  const tot = closed.reduce((a, r) => a + r.pnl, 0);
  const pct = (n, d) => d.length ? `${Math.round(100 * n / d.length)}%` : "–";
  // freshness stamp (user 2026-08-05): the newest game in this view, so a glance answers
  // "is the portal caught up through tonight's matches?"
  const last = rows[0];
  const lastTxt = last ? ` · through ${last.txn ? last.txn + " " : ""}${(last.player || "?").split(" ").slice(-1)[0]} (${fmtPT(last.start_ts).slice(0, 16)})` : "";
  // REAL account line (queue #42): exchange-reported realized P&L, explicitly separate from
  // the paper book. Absent gracefully when the live feed is down — with a loud banner.
  const LV = DATA.live || {};
  const pnlRows = Object.entries(LV.pnl || {});
  const realNet = pnlRows.reduce((a, [, v]) => a + (v.realized || 0) - (v.fees || 0), 0);
  const liveLine = pnlRows.length
    ? ` · <b class="${realNet >= 0 ? "good" : "bad"}" title="REAL account: exchange-reported realized P&L minus fees, across ${pnlRows.length} traded market(s). Not a simulation.">REAL ${realNet >= 0 ? "+" : ""}${realNet.toFixed(2)}</b>`
    : "";
  const liveWarn = (LV.ok === false)
    ? `<p class="note bad"><b>LIVE DATA UNAVAILABLE</b> — the last export could not reach the exchange account${LV.error ? ` (${LV.error})` : ""}; $LIVE chips and REAL P&L may be stale or missing.</p>`
    : "";
  const unmatched = Object.keys(LV.fills || {}).filter(m => !rows.some(r => r.mkt === m));
  const unmatchedNote = unmatched.length
    ? `<p class="note">⚠️ live activity on market(s) with no recorded game: ${unmatched.join(", ")} — manual trades or resolver gaps; not shown in any game view.</p>`
    : "";
  view().innerHTML = liveWarn + `<h3>Games (${rows.length}) <small>· pick won ${pct(pw, decided)} ·
    profitable ${pct(prof, closed)} · <span title="PAPER book total — the simulation's ledger, not the account">paper P&L <span class="${tot >= 0 ? "good" : "bad"}">${tot.toFixed(2)}</span></span>${liveLine}${lastTxt}</small></h3>` + unmatchedNote + `<div class="scrollbox"><table class="list" id="gameslist"><thead><tr>
    <th>date</th><th>txn</th><th>player</th><th>entry</th><th>exit</th><th>outcome</th><th>P&L</th>
    <th>gate</th><th>ghost</th></tr></thead><tbody>` +
    rows.map(r => { const live = (r.toff || []).length || (DATA.scores[r.mkt] || []).length;
      return `<tr class="${live ? "rowlink" : "rowdead"}" data-k="${key(r)}"
        ${live ? "" : 'title="no recorded series for this pick — nothing to open"'}>
      <td>${fmtPT(r.start_ts)}</td><td>${r.counterfactual ? `<span class="note" title="resolver-missed pick — never traded live; candle-backed counterfactual">missed</span>` : (r.txn || "")}${((DATA.live || {}).fills || {})[r.mkt] ? ` <b class="good" title="REAL-MONEY trade — actual exchange fills on this market (see game details for the play-by-play)">$</b>` : ""}${(DATA.retractions || []).some(x => x.txn && x.txn === r.txn) ? ` <b class="bad" title="the admin DELETED the pick message behind this position after it acted — retraction recorded">RETRACTED</b>` : ""}</td>
      <td class="${pickWon(r) === true ? "good" : pickWon(r) === false ? "bad" : ""}" title="${pickWon(r) === true ? "admin pick WON the match" : pickWon(r) === false ? "admin pick LOST the match" : "unsettled/unknown"}">${r.player || ""}</td>
      <td>${r.entry_price ?? ""}</td><td>${r.exit_price ?? ""}</td><td>${r.outcome || ""}</td>
      <td class="${(r.pnl || 0) >= 0 ? "good" : "bad"}">${r.pnl ?? ""}</td>
      <td>${r.gate_verdict ? r.gate_verdict.verdict : ""}</td>
      <td>${ghostCell(r)}</td></tr>`; }).join("") +
    `</tbody></table></div>`;
  view().querySelectorAll(".rowlink").forEach(tr =>
    tr.addEventListener("click", () => location.hash = "games/" + encodeURIComponent(tr.dataset.k)));
}
const key = r => `${r.txn || "x"}|${r.mkt || r.player}`;
// stale-spec ghosts are shown RE-SCORED under the frozen v2.1 spec (defect-fix policy: history is
// post-processed under corrected rules) — the as-lived pre-v2.1 number moves to the tooltip.
function ghostCell(r) {
  const g = r.ghost_close;
  if (!g) return "";
  if (g.spec === "v2.1") return `${g.outcome} ${g.ghost_pnl}`;
  try {
    const res = sim.replayLifecycle(r, DATA.scores[r.mkt] || [], { ...deployedBase(), gate: "primary" });
    const pnl = res.pnl;
    const label = (res.events || []).some(e => e.kind === "gate-sell") ? "gate-sell" : res.outcome;
    return `<span class="${pnl >= (r.pnl || 0) ? "good" : "bad"}" title="re-scored under gate spec v2.1. As lived (pre-v2.1 ghost): ${g.outcome} ${g.ghost_pnl}">${label} ${pnl.toFixed(2)}</span>`;
  } catch (e) { return `${g.outcome} ${g.ghost_pnl}*`; }
}
let GNAV = {};                                     // {prev, next} hashes for arrow-key navigation
window.addEventListener("keydown", e => {
  if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.key === "ArrowLeft" && GNAV.prev) location.hash = GNAV.prev;
  if (e.key === "ArrowRight" && GNAV.next) location.hash = GNAV.next;
});

// score arrays arrive as competitor1/competitor2; present EVERYTHING from our player's side
const oursPair = (s, ours) => {
  const a = (ours === 2 ? s.s2 : s.s1) || [], b = (ours === 2 ? s.s1 : s.s2) || [];
  return [a, b];
};
const oursGs = (s, ours) => ours === 2 ? [s.gs2, s.gs1] : [s.gs1, s.gs2];

function gameView(k) {
  const r = DATA.lifecycles.find(x => key(x) === k);
  if (!r) return gamesList();
  const scores = DATA.scores[r.mkt] || [];
  const ours = (scores.find(s => s.ours) || {}).ours || 1;
  // prev/next through the same filtered, newest-first list the Games tab shows (also ←/→ keys)
  const list = DATA.lifecycles
    .filter(x => sinceOK(x.start_ts) && ((x.toff || []).length || (DATA.scores[x.mkt] || []).length))
    .sort((a, b) => (b.start_ts || "").localeCompare(a.start_ts || ""));
  const idx = list.findIndex(x => key(x) === k);
  const nb = list[idx - 1], na = list[idx + 1];
  const gh = x => "games/" + encodeURIComponent(key(x));
  GNAV = { prev: nb ? gh(nb) : null, next: na ? gh(na) : null };
  const nav = `<div class="gnav"><a href="#games">≡ all games</a>
    ${nb ? `<a href="#${gh(nb)}">← ${nb.txn || ""} ${nb.player || ""}</a>` : ""}
    <span class="note">${idx + 1} / ${list.length}</span>
    ${na ? `<a href="#${gh(na)}">${na.txn || ""} ${na.player || ""} →</a>` : ""}
    <span class="note">(arrow keys work too)</span></div>`;
// RULES IN FORCE for a given game (user 2026-08-07): every lifecycle records the config it
// actually traded under (ceiling/tp/stop/confirm_s; adm/unit/live too since 2026-08-07), so this
// shows the rules EFFECTIVE THEN — never today's. Older rows lack adm/unit; those are backfilled
// from the known deployment eras and flagged, rather than silently showing current values.
function rulesInForce(r) {
  const t = r.start_ts || "";
  const era = t >= "2026-08-06T05:43" ? { adm: true, admMin: 40, label: "v2" }
            : { adm: true, admMin: 70, label: "v1" };
  const tp = r.tp;
  return {
    label: era.label,
    ceiling: r.ceiling, unit: r.unit != null ? r.unit : 10,
    tp: tp == null ? "?" : (tp >= 100 ? "OFF (ride to settlement)" : tp + "\u00a2"),
    stop: r.stop == null ? "off" : r.stop + "\u00a2",
    cfm: r.confirm_s == null ? "" : (r.confirm_s === 0 ? "instant" : (r.confirm_s / 60) + "min sustained"),
    adm: (r.adm_follow != null ? r.adm_follow : era.adm)
         ? "follow \u2265" + (r.adm_min != null ? r.adm_min : era.admMin) + "\u00a2" : "never",
    mirrored: r.live_mirrored === true,
    backfilled: r.adm_follow == null,
  };
}

  view().innerHTML = `${nav}<h3>${r.player} — ${r.mkt || "?"} <small>(${r.outcome || "active"}, P&L ${r.pnl ?? "?"})</small></h3>
    <p class="note">bid/ask are ${r.player}'s own market; score is shown ${r.player}-first · hover the graph,
    the score strip, or an event to cross-highlight · * = serving that game</p>
    ${(() => { const R = rulesInForce(r); return `<p class="note" title="The auto-trader rules EFFECTIVE FOR THIS GAME, recorded at trade time — not the current settings.${R.backfilled ? " (admin-follow/unit backfilled from the deployment era: this lifecycle predates per-pick recording of those two fields.)" : ""}"><b>rules in force</b> (${R.label}) · ceiling ${R.ceiling}\u00a2 · take-profit ${R.tp} · stop ${R.stop} ${R.cfm} · admin sells ${R.adm} · unit $${R.unit}${R.mirrored ? ` · <b class="good">REAL money</b>` : ""}${R.backfilled ? " \u1d47" : ""}</p>`; })()}
    <div id="chart"></div><div id="scorestrip"></div><h4>Events</h4><div id="events"></div>`;
  const t0 = Date.parse(r.start_ts) / 1000;
  const xs = (r.toff || []).map(o => t0 + o);
  const bid = r.bid || [], ask = r.ask || [];
  const marks = collectMarks(r, scores, t0, ours);

  // strip + events FIRST, so every element the cursor hooks touch exists before the chart does
  // (2026-08-03: clicking a row put the pointer on the chart, the first cursor event fired into
  // not-yet-initialized state and killed hovering for the whole view)
  document.getElementById("scorestrip").innerHTML =
    scoreStrip(scores, ours, !!(r.settle_result_player || r.settle_close_ts || DATA.settles[r.mkt]), pickWon(r));
  document.getElementById("events").innerHTML = marks.map((m, i) =>
    `<div class="ev" data-i="${i}" data-t="${m.t}" title="${attr(m.title || m.label)}"><span class="dot" style="background:${m.color}"></span>
     <b>${fmtPTt(m.t)}</b> ${m.label}</div>`).join("") || "—";
  const cells = [...view().querySelectorAll("#scorestrip .sc")].map(el => ({ el, t: +el.dataset.t }));
  const evEls = [...view().querySelectorAll("#events .ev")];
  let hotCell = null, hotEv = null, hoverT = null;
  function highlightCell(t) {
    let next = null;
    if (t != null) for (const c of cells) { if (c.t <= t) next = c; else break; }
    if (next === hotCell) return;
    if (hotCell) hotCell.el.classList.remove("hot");
    if (next) next.el.classList.add("hot");
    hotCell = next;
  }

  // size a padding band above the plot for the mark dots/labels (user 2026-08-03: they must
  // not sit on the price series). Depth = worst label stack at projected pixel positions.
  const W = Math.min(1100, view().clientWidth - 10);
  const tmin = xs[0] ?? t0, tmax = xs[xs.length - 1] ?? t0 + 1;
  const pxPerS = (W - 60) / Math.max(1, tmax - tmin);
  let maxSlot = 0; const proj = [];
  for (const m of marks) {
    const x = (m.t - tmin) * pxPerS;
    const slot = proj.filter(p => Math.abs(p.x - x) < 58).length;
    proj.push({ x, slot }); maxSlot = Math.max(maxSlot, slot);
  }
  const padTop = 18 + (maxSlot + 1) * 14;

  // hovering the chart near an event highlights that event row (and bolds its mark)
  function chartHover(t, uu) {
    let next = null, best = 12;                          // within 12 CSS px of a mark line
    if (t != null) {
      const lx = uu.valToPos(t, "x");
      marks.forEach((m, i) => {
        const d = Math.abs(uu.valToPos(m.t, "x") - lx);
        if (d < best) { best = d; next = i; }
      });
    }
    if (next === hotEv) return;
    if (hotEv != null) evEls[hotEv].classList.remove("hot");
    if (next != null) evEls[next].classList.add("hot");
    hotEv = next;
    hoverT = next != null ? marks[next].t : null;
    uu.redraw();
  }

  // mobile (2026-08-07): a 400px plot plus the mark band leaves no room for the score
  // strip on a phone; shrink the plot only, keeping the mark band intact.
  const CH = window.matchMedia("(max-width: 700px)").matches ? 240 : 400;
  const u = new uPlot({
    width: W, height: CH + padTop, padding: [padTop, 8, 0, 0],
    scales: { y: { range: [0, 100] } },
    series: [{}, { label: "bid", stroke: "#4aa3ff", width: 1 },
      { label: "ask", stroke: "#ffb14a", width: 1 }],
    hooks: {
      draw: [uu => drawMarks(uu, marks, hoverT, padTop)],
      setCursor: [uu => {
        const l = uu.cursor.left;
        if (l == null || l < 0) { highlightCell(null); chartHover(null, uu); return; }
        const t = uu.posToVal(l, "x");
        highlightCell(t); chartHover(t, uu);
      }],
    },
    axes: [{ values: (u, ts) => ts.map(t => fmtPTt(t).slice(0, 5)) }, {}],
  }, [xs, bid, ask], document.getElementById("chart"));

  // hover an event or a score cell -> locate it on the graph AND fill the time/bid/ask
  // readout (user 2026-08-06): driving the uPlot cursor to the event's timestamp populates
  // the legend and fires the same cross-highlight chain as hovering the chart itself.
  const setHover = t => {
    hoverT = t;
    if (t != null) u.setCursor({ left: u.valToPos(t, "x"), top: 10 });
    else u.setCursor({ left: -10, top: -10 });
    u.redraw();
  };
  view().querySelectorAll("#events .ev, #scorestrip .sc").forEach(el => {
    el.addEventListener("mouseenter", () => setHover(+el.dataset.t));
    el.addEventListener("mouseleave", () => setHover(null));
  });
}

function collectMarks(r, scores, t0, ours) {
  const M = [];
  const add = (t, label, color, short, title) => t && M.push({ t, label, color, short, title });
  add(t0, `signal · window ${r.window_kind || "?"}`, "#888", "signal");
  if (r.entry_idx != null) add(t0 + (r.toff?.[r.entry_idx] ?? r.entry_idx * (r.freq_s || 5)), `ENTRY @ ${r.entry_price}¢`, "#2ecc71", "entry");
  const ms = r.maker_shadow;
  if (ms) for (const [name, f] of Object.entries(ms.filled || {}))
    add(Date.parse(f.t) / 1000, `maker ${name} fill @ ${f.px}¢`, "#9b59b6", "maker");
  if (r.gate_verdict) add(Date.parse(r.gate_verdict.t) / 1000,
    `GATE ${r.gate_verdict.verdict.toUpperCase()} (${r.gate_verdict.reason}) · stop fill ${r.gate_verdict.stop_fill}¢`, "#e67e22",
    `gate:${r.gate_verdict.verdict}`);
  if (r.ghost_close) {
    const stale = r.ghost_close.spec !== "v2.1";
    add(Date.parse(r.ghost_close.t) / 1000,
      `GHOST ${r.ghost_close.outcome} @ ${r.ghost_close.exit_price}¢ (Δ ${r.ghost_close.delta})${stale ? " — as lived, PRE-v2.1 spec" : ""}`,
      "#e74c3c", "ghost");
    if (stale) {
      try {
        const res = sim.replayLifecycle(r, scores, { ...deployedBase(), gate: "primary" });
        for (const e of res.events || []) {
          const t = t0 + (r.toff?.[e.i] ?? 0);
          if (e.kind === "gate" && e.verdict && e.verdict !== "veto")
            add(t, `v2.1 replay: gate ${e.verdict.toUpperCase()} (${e.detail || ""})`, "#16a085", `v2.1 ${e.verdict}`);
          if (e.kind === "gate-sell") add(t, `v2.1 replay: GATE-SELL @ ${e.px}¢`, "#16a085", "v2.1 sell");
          if (e.kind === "tp") add(t, `v2.1 replay (corrected spec): held through set break → take-profit @ ${e.px}¢ — gate book records ${(Math.round(res.pnl * 100) / 100)}`, "#16a085", "v2.1 TP");
          if (e.kind === "settlement") add(t, `v2.1 replay (corrected spec): held → settlement @ ${e.px}¢ — gate book records ${(Math.round(res.pnl * 100) / 100)}`, "#16a085", "v2.1 settle");
        }
      } catch (err) {}
    }
  }
  // REAL-MONEY overlay (2026-08-05, live era): actual exchange fills + the mirror's under-filled
  // attempts, so the play-by-play shows exactly what the account did next to what paper did.
  const lv = DATA.live || {};
  for (const f of (lv.fills || {})[r.mkt] || [])
    add(Date.parse(f.t) / 1000,
        `💵 LIVE ${f.action === "buy" ? "BUY" : "SELL"} ${f.count} ct @ ${f.px}¢ — REAL fill`,
        f.action === "buy" ? "#f39c12" : "#c0392b", `$${f.action}`);
  for (const o of (lv.orders || {})[r.mkt] || [])
    if (o.t && (o.filled || 0) < (o.count || 0) && ["placed", "error"].includes(o.status))
      add(Date.parse(o.t) / 1000,
          o.attempts ? `⚠️ LIVE exit retry burst: ${o.attempts} attempts ${o.t ? fmtPTt(Date.parse(o.t) / 1000) : ""}–${o.t_last ? fmtPTt(Date.parse(o.t_last) / 1000) : ""} (${o.filled || 0}/${o.count} filled)`
                     : `⚠️ LIVE ${o.action} ${o.filled || 0}/${o.count} filled (${o.status}${o.reason ? " · " + o.reason : ""})`,
          "#e67e22", o.attempts ? "retries" : "live-miss");
  if (r.exit_idx != null) add(t0 + (r.toff?.[r.exit_idx] ?? 0), `EXIT ${r.outcome} @ ${r.exit_price}¢`, "#e74c3c",
    r.outcome === "take-profit" ? "TP" : r.outcome === "stop-loss" ? "stop" : "exit");
  if (r.settle_close_ts) add(Date.parse(r.settle_close_ts) / 1000, `settled: ${r.settle_result_player || "?"}`, "#555", "settle");
  // set boundaries + halts from score rows. A set BEGINS at 0-0 — never show the first sampled
  // game of the new set as if it were the opening score (user 2026-08-03); show completed sets.
  let maxSets = 0, seenFirst = false, inHalt = false;
  const haltMark = (s) => {
    const h = ["interrupted", "suspended", "delayed"].includes(String(s.status).toLowerCase());
    if (h && !inHalt) { inHalt = true; add(Date.parse(s.t) / 1000, `HALT (${s.status})`, "#f1c40f", "halt"); }
    else if (!h && inHalt) { inHalt = false; add(Date.parse(s.t) / 1000, "play resumed", "#f1c40f", "resume"); }
  };
  for (const s of scores) {
    const n = (s.s1 || []).length;
    if (n <= maxSets || !seenFirst) {              // regressions are widget resets, not new sets
      if (!seenFirst && n) { seenFirst = true; maxSets = n; }
      haltMark(s);
      continue;
    }
    maxSets = n;
    {
      const [a, b] = oursPair(s, ours);
      const prior = a.slice(0, n - 1).map((v, i) => `${v}-${b[i]}`).join(" ");
      add(Date.parse(s.t) / 1000, `set ${n} begins${prior ? ` (after ${prior})` : ""}`, "#3498db", `set${n}`);
    }
    haltMark(s);
  }
  // clamp messages to THIS match's life: signal-5min .. settlement+5min (2026-08-05: without an
  // upper bound, the next match's hype leaked into every finished game's event list)
  const tEnd = (r.settle_close_ts ? Date.parse(r.settle_close_ts) / 1000
               : t0 + ((r.toff && r.toff.length) ? r.toff[r.toff.length - 1] : 4 * 3600)) + 300;
  // full text on hover (user 2026-08-06); a DELETE shows the original message it removed
  const byId = {};
  for (const m of DATA.messages) if (m.msg_id && (m.text || "").length > 2) byId[m.msg_id] = m.text;
  DATA.messages.filter(m => Math.abs(Date.parse(m.t) / 1000 - t0) < 4 * 3600)
    .forEach(m => { const mt = Date.parse(m.t) / 1000;
      const orig = m.kind === "delete" ? byId[m.msg_id] : null;
      const txt = (m.text || "").length > 2 ? m.text : orig;
      if (txt && mt >= t0 - 300 && mt <= tEnd)
        add(mt, `msg[${m.kind}]: ${txt.slice(0, 60)}`, "#7f8c8d", "msg",
            m.kind === "delete" ? `DELETED — original message:\n${orig || "(unknown)"}` : txt); });
  return M.sort((a, b) => a.t - b.t);
}

function drawMarks(u, marks, hoverT, padTop) {
  const ctx = u.ctx, pr = devicePixelRatio || 1;
  const bandTop = u.bbox.top - padTop * pr;            // labels live ABOVE the plot area
  const placed = [];                                   // stack labels that share an x-neighborhood
  ctx.save();
  ctx.font = `${11 * pr}px system-ui, sans-serif`;
  ctx.textAlign = "left";
  for (const m of marks) {
    const x = u.valToPos(m.t, "x", true);
    if (x < u.bbox.left || x > u.bbox.left + u.bbox.width) continue;
    const hot = hoverT != null && Math.abs(m.t - hoverT) < 0.5;
    const slot = placed.filter(p => Math.abs(p.x - x) < 58 * pr).length;
    placed.push({ x, slot });
    const y = bandTop + (12 + slot * 14) * pr;
    ctx.strokeStyle = m.color; ctx.globalAlpha = hot ? 1 : 0.55;
    ctx.lineWidth = hot ? 2 * pr : 1;
    ctx.setLineDash(hot ? [] : [4, 3]);
    ctx.beginPath(); ctx.moveTo(x, y + 5 * pr); ctx.lineTo(x, u.bbox.top + u.bbox.height); ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = hot ? 1 : 0.9;
    ctx.fillStyle = m.color;
    ctx.beginPath(); ctx.arc(x, y, 4 * pr, 0, 2 * Math.PI); ctx.fill();
    ctx.fillText(m.short || "", x + 6 * pr, y + 4 * pr);
  }
  if (hoverT != null && !marks.some(m => Math.abs(m.t - hoverT) < 0.5)) {
    const x = u.valToPos(hoverT, "x", true);            // score-cell hover: plain locator line
    if (x >= u.bbox.left && x <= u.bbox.left + u.bbox.width) {
      ctx.strokeStyle = "#888"; ctx.globalAlpha = 0.9; ctx.lineWidth = 2 * pr; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(x, u.bbox.top); ctx.lineTo(x, u.bbox.top + u.bbox.height); ctx.stroke();
    }
  }
  ctx.restore();
}

// score strip: one row per set, each cell = that set's games (ours-first) + point score
function scoreStrip(scores, ours, settled, won) {
  if (!scores.length) return "<i>no score data for this match</i>";
  // final per set = max-games pair (games only increase within a set; guards vs widget resets).
  // Completed sets are ALWAYS in the arrays — so a late join still knows earlier sets' finals.
  const fin = [], maxVal = [];
  let finMax = 0, totalSets = 0;
  for (const s of scores) {
    const [a, b] = oursPair(s, ours);
    if (a.length < finMax) continue;
    finMax = a.length;
    totalSets = Math.max(totalSets, a.length);
    a.forEach((v, i) => {
      const av = +v || 0, bv = +b[i] || 0, sum = av + bv;
      maxVal[i] = Math.max(maxVal[i] || 0, av, bv);
      if (!fin[i] || sum > fin[i].sum)
        fin[i] = { v: `${v}-${b[i]}`, sum, t: Date.parse(s.t) / 1000, av, bv };
    });
  }
  const sets = [], setMaxSum = [];
  let last = "", maxN = 0;
  for (const s of scores) {
    const n = (s.s1 || []).length || 1;
    if (n < maxN) continue;                              // widget reset (fewer sets) — glitch
    maxN = n;
    const [a, b] = oursPair(s, ours);
    const pa = +(a[n - 1] ?? 0) || 0, pb = +(b[n - 1] ?? 0) || 0;
    if (pa + pb < (setMaxSum[n - 1] || 0)) continue;     // games only increase within a set
    setMaxSum[n - 1] = pa + pb;
    // * marks who is serving the game in progress at that score (server UUID vs competitor ids)
    const ourId = ours === 2 ? s.c2 : s.c1, oppId = ours === 2 ? s.c1 : s.c2;
    const sv = s.server ? (s.server === ourId ? 1 : s.server === oppId ? 2 : 0) : 0;
    // the score feed appends a set's array only after its FIRST game — during that lag the previous set
    // reads complete while the new set's game 1 is being played. Synthesize the 0-0 cell for the
    // new set from the first lag row, so every observed set starts at 0-0 with game-1's server.
    const cmpl = (Math.max(pa, pb) === 6 && Math.abs(pa - pb) >= 2) ||
                 (Math.max(pa, pb) === 7 && Math.abs(pa - pb) <= 2);
    if (cmpl && n < totalSets && !(sets[n] && sets[n].length)) {
      (sets[n] = sets[n] || []).push(
        `<span class="sc" data-t="${Date.parse(s.t) / 1000}">${fmtPTt(Date.parse(s.t) / 1000).slice(0, 5)} 0${sv === 1 ? "*" : ""}-0${sv === 2 ? "*" : ""}</span>`);
    }
    const f = `${a[n - 1] ?? 0}${sv === 1 ? "*" : ""}-${b[n - 1] ?? 0}${sv === 2 ? "*" : ""}`;
    const kf = `${n}|${f}`;
    if (kf !== last) {
      (sets[n - 1] = sets[n - 1] || []).push(
        `<span class="sc" data-t="${Date.parse(s.t) / 1000}">${fmtPTt(Date.parse(s.t) / 1000).slice(0, 5)} ${f}</span>`);
      last = kf;
    }
  }
  const nSets = Math.max(sets.length, fin.length);
  const out = [];
  for (let i = 0; i < nSets; i++) {
    const cells = sets[i] || [];
    const done = i < nSets - 1 || settled;
    // a "set" whose counter exceeds 7 is a MATCH TIEBREAK — those are points, not games
    // (the widget counts TB points live, then records the official 1-0 set at close)
    const isTb = (maxVal[i] || 0) > 7;
    const cls = fin[i] ? (fin[i].av > fin[i].bv ? "good" : fin[i].av < fin[i].bv ? "bad" : "") : "";
    // the LAST set ends naturally only at a complete score (6-x by 2 / 7-5 / 7-6 / TB to 10 by 2);
    // anything short of that with the match settled = retirement/walkover — show the reason,
    // never a fake "final" (user 2026-08-03)
    const mx = fin[i] ? Math.max(fin[i].av, fin[i].bv) : 0, df = fin[i] ? Math.abs(fin[i].av - fin[i].bv) : 0;
    const natural = fin[i] && (isTb ? (mx >= 10 && df >= 2)
      : ((mx === 6 && df >= 2) || (mx === 7 && df <= 2)));
    // last sample one unit short of completion + the LEADER won the match => the closing
    // point/game fell between 30s samples: completed, marked with ⁺. "ended early" is claimed
    // only when the data supports it (trailer won, or a real gap to completion) — the old
    // heuristic mislabeled Goncalves' 10-point TB won from 9-2 as a retirement (2026-08-03).
    const leaderIsUs = fin[i] && fin[i].av > fin[i].bv;
    const winnerIsLeader = won == null ? false : (won === leaderIsUs);
    const oneAway = fin[i] && df >= 1 && (isTb ? mx === 9 : (mx === 5 || (mx === 6 && df === 1)));
    const presumedDone = oneAway && winnerIsLeader;
    const finCell = done && fin[i]
      ? (i === nSets - 1 && !natural
        ? (presumedDone
          ? `<span class="sc fin ${cls}" data-t="${fin[i].t}" title="closing ${isTb ? "point" : "game"} fell between 30s samples — set completed from here">final ${isTb ? "TB " : ""}${fin[i].v}⁺</span>`
          : `<span class="sc fin" data-t="${fin[i].t}">ended early — retired/walkover</span>`)
        : `<span class="sc fin ${cls}" data-t="${fin[i].t}">final ${isTb ? "TB " : ""}${fin[i].v}</span>`) : "";
    if (!cells.length && !finCell) continue;
    const body = cells.length
      ? cells.join(" → ") + (finCell ? " → " + finCell : "")
      : `<span class="note">(ended before we joined)</span> ${finCell}`;
    out.push(`<div class="setrow"><b>set ${i + 1}${isTb ? " · match tiebreak" : ""}</b> ${body}</div>`);
  }
  return out.join("");
}

// ---------------- Books ----------------
const r2 = x => Math.round(x * 100) / 100;
// effective acquisition cost in ¢/contract (price + fee), the #37 frame
const effTaker = px => px + 0.07 * px * (100 - px) / 100;
const effMaker = px => px + 0.0175 * px * (100 - px) / 100;

function computeBooks(P = {}) {
  // per policy: pnl (absolute), buy (entry edge vs actual, $), sell (exit edge vs actual, $ —
  // includes missed trades), skips. buy + sell = total Δ vs actual by construction.
  const names = ["actual", "gate_primary", "gate_223", "gate_strict", "maker_ask0", "maker_ask1", "hold"];
  const books = {};
  names.forEach(n => books[n] = { pnl: [], buy: [], sell: [], skips: 0 });
  const done = DATA.lifecycles.filter(r => r.outcome && r.outcome !== "skip" && r.outcome !== "unresolved" && r.pnl != null && sinceOK(r.start_ts));
  const base = deployedBase();
  const pols = { gate_primary: { ...base, gate: "primary" },
                 gate_223: { ...base, gate: "primary", gateP: { ...DATA.config.gate_watch } },
                 gate_strict: { ...base, gate: "strict" },
                 maker_ask0: { ...base, maker: "ask0" }, maker_ask1: { ...base, maker: "ask1" } };
  for (const r of done) {
    const scores = (DATA.scores[r.mkt] || []);
    r.settle_yes = r.settle_result_player ? (r.player || "").split(" ").pop().toLowerCase() &&
      r.settle_result_player.toLowerCase().includes((r.player || "").split(" ").pop().toLowerCase()) : (DATA.settles[r.mkt] === "yes");
    const aEff = effTaker(r.entry_price);
    books.actual.pnl.push(r.pnl); books.actual.buy.push(0); books.actual.sell.push(0);
    for (const [k, opt] of Object.entries(pols)) {
      const res = sim.replayLifecycle(r, scores, { ...opt, ...P });
      const dTot = r2(res.pnl - r.pnl);
      let buy = 0;
      const ev = (res.events || []).find(e => e.kind === "maker-fill") ||
                 (res.events || []).find(e => e.kind === "entry");
      if (res.outcome === "skip" || res.outcome === "maker-miss" || !ev) { books[k].skips++; }
      else {
        const pC = Math.round(10 / (ev.px / 100));
        const pEff = ev.kind === "maker-fill" ? effMaker(ev.px) : effTaker(ev.px);
        buy = r2(pC * (aEff - pEff) / 100);
      }
      books[k].pnl.push(res.pnl); books[k].buy.push(buy); books[k].sell.push(r2(dTot - buy));
    }
    const e = r.entry_price, C = e ? 10 / (e / 100) : 0;
    const hold = e ? r2(C * (r.settle_yes ? 100 : 0) / 100 - C * e / 100 - sim.fees.taker(C, e)) : 0;
    books.hold.pnl.push(hold); books.hold.buy.push(0); books.hold.sell.push(r2(hold - r.pnl));
  }
  return { books, picks: done };
}

function booksView(P = {}) {
  const { books, picks } = computeBooks(P);
  const cum = a => a.reduce((acc, v, i) => (acc.push(r2((acc[i - 1] || 0) + v)), acc), []);
  const xs = picks.map((_, i) => i + 1);
  view().innerHTML = `<h3>Books — six ways the same picks could have been traded (n=${picks.length})</h3>
    <p class="note">Every closed pick is replayed under six policies; X = pick number in date order.
    <b>actual</b> is the recorded paper book; each other line changes exactly one thing. The P&L chart is
    absolute; the buy/sell charts split each policy's difference vs actual into the <b>entry side</b>
    (better/worse acquisition price+fee, at that policy's position size) and the <b>exit side</b>
    (everything after entry — different exits AND trades never entered). Buy + sell = total edge vs actual.</p>
    <h4>cumulative P&L ($)</h4><div id="chartP"></div>
    <h4>entry (buy) edge vs actual ($)</h4><div id="chartB"></div>
    <h4>exit (sell) edge vs actual ($) — includes missed trades</h4><div id="chartS"></div>
    <table class="list"><thead><tr><th>book</th><th>what it is</th><th>skipped</th>
      <th title="cumulative entry-side edge vs actual">buy edge</th>
      <th title="cumulative exit-side edge vs actual (incl. missed trades)">sell edge</th>
      <th>total</th><th>vs actual</th></tr></thead><tbody id="totals"></tbody></table>
    <p class="note">gate graduation: ≥25 events, primary ≥ +$20 ex-retirement · maker: ≥40 entries, ≥1¢/ct + misses not winner-heavy</p>`;
  const dark = document.documentElement.dataset.theme === "dark";
  const colors = { actual: dark ? "#fff" : "#222", gate_primary: "#e67e22", gate_223: "#27ae60", gate_strict: "#e6c822", maker_ask0: "#9b59b6", maker_ask1: "#b98ff0", hold: "#4aa3ff" };
  const series = [{}].concat(Object.keys(books).map(k => ({ label: k, stroke: colors[k], width: k === "actual" ? 2 : 1 })));
  const W = Math.min(1100, view().clientWidth - 10);
  const mk = (id, field, h) => new uPlot(
    { width: W, height: h, series, scales: { x: { time: false } },
      axes: [{ label: "closed pick # (date order)" }, {}] },
    [xs, ...Object.values(books).map(b => cum(b[field]))], document.getElementById(id));
  mk("chartP", "pnl", 320); mk("chartB", "buy", 220); mk("chartS", "sell", 220);
  const DESC = {
    actual: "the live paper book as the daemon really traded it (entries, TP/stop exits; it does NOT follow admin sells)",
    gate_primary: "same trades, but every stop-sell first passes the score gate at its deployed thresholds — the FROZEN spec on the graduation ledger",
    gate_223: "lab-found gate variant with a looser truly-over threshold: vetoes almost nothing, keeps set-break holds. WATCHED only — adopting it would reset the gate counter",
    gate_strict: "same, with the strict comparator (veto only when deficit≤1 AND runway≥3)",
    maker_ask0: "entry as a resting maker bid AT the signal ask (lower fee, may miss the fill)",
    maker_ask1: "entry as a resting maker bid 1¢ BELOW the signal ask (lower cost, misses more)",
    hold: "never exit early — every entry held to settlement (win 100 / lose 0)",
  };
  const at = books.actual.pnl.reduce((x, y) => x + y, 0);
  document.getElementById("totals").innerHTML = Object.entries(books).map(([k, b]) => {
    const tot = b.pnl.reduce((x, y) => x + y, 0);
    const bt = b.buy.reduce((x, y) => x + y, 0), st = b.sell.reduce((x, y) => x + y, 0);
    const cell = v => `<td class="${v > 0.005 ? "good" : v < -0.005 ? "bad" : ""}">${v.toFixed(2)}</td>`;
    return `<tr><td style="color:${colors[k]}">■ ${k}</td><td class="note">${DESC[k]}</td>
      <td>${b.skips || ""}</td>${cell(bt)}${cell(st)}
      <td class="${tot >= 0 ? "good" : "bad"}">${tot.toFixed(2)}</td>${cell(tot - at)}</tr>`;
  }).join("");
}

// ---------------- Sweep ----------------
let SWEEP_F = { ceiling: "", tp: "", stop: "", cfm: "", adm: "", gate: "", sort: "total" };
function sweepView() {
  const days = Object.keys(DATA.sweeps).sort();
  const day = days[days.length - 1];
  // grids are computed nightly per start date, matching the global selector (user 2026-08-03)
  const variant = SINCE || "all";
  const gridOf = d => { const g = DATA.sweeps[d] || {}; return Array.isArray(g) ? g : (g[variant] || null); };
  const allOf = d => { const g = DATA.sweeps[d] || {}; return Array.isArray(g) ? g : (g.all || []); };
  let rows = gridOf(day), fallback = "";
  (rows || []).forEach(r => { r.pb = r.ent ? r.total / r.ent * 10 : 0; r.po = r.n ? r.total / r.n * 10 : null; });
  if (!rows) { rows = allOf(day); fallback = variant === "all" ? "" :
    ` — no grid for this start date yet (computed nightly; showing all picks)`; }
  rows.forEach(r => { r.pb = r.ent ? r.total / r.ent * 10 : 0; r.po = r.n ? r.total / r.n * 10 : null; });
  const vlabel = variant === "all" ? "all picks" : "since " + variant;
  // one dropdown per parameter (user 2026-08-03: token filter was unintuitive)
  const opts = k => [...new Set(rows.map(r => r[k]))].sort((a, b) =>
    (parseFloat(a) || 0) - (parseFloat(b) || 0));
  const ADM_ORDER = ["any", "never", "high", "mid", "low", "high+low", "high+mid", "mid+low"];
  const GATE_ORDER = ["off", "1/2/2", "2/2/2", "3/2/2"];
  const sel = k => {
    let vs = opts(k);
    if (k === "tp") vs = [...vs].sort((a, b) =>
      ((a === "off") - (b === "off")) || (parseFloat(a) - parseFloat(b)));
    if (k === "adm") vs = [...vs].sort((a, b) =>
      (ADM_ORDER.indexOf(a) + 99 * (ADM_ORDER.indexOf(a) < 0)) - (ADM_ORDER.indexOf(b) + 99 * (ADM_ORDER.indexOf(b) < 0)));
    if (k === "gate") vs = [...vs].sort((a, b) =>
      (GATE_ORDER.indexOf(a) + 99 * (GATE_ORDER.indexOf(a) < 0)) - (GATE_ORDER.indexOf(b) + 99 * (GATE_ORDER.indexOf(b) < 0)));
    return `<label class="fsel" title="${attr(TIPS[k])}">${k} <select data-f="${k}"><option value="">*</option>${
      vs.map(v => `<option${String(v) === SWEEP_F[k] ? " selected" : ""}>${v}</option>`).join("")}</select></label>`;
  };
  const gmeta = ((DATA.sweeps[day] || {}).meta || {})[variant] || {};
  // gate combos exist only in the full-data grid (>=7/30 cohort); older cohorts hide the column
  const hasGate = rows.some(r => r.gate && r.gate !== "off");
  view().innerHTML = `<h3>Sweep explorer — ${day} · ${vlabel}${fallback} (${rows.length} combos)${gmeta.through ? ` <small>· ${gmeta.through}</small>` : ""}</h3>
    ${gmeta.pbo ? `<p class="note" title="CSCV: across all half-splits of the picks, how often the in-sample best combo underperforms the out-of-sample median — the standard backtest-overfitting probability">${gmeta.pbo}</p>` : ""}
    ${gmeta.mnull ? `<p class="note" title="Each entered pick re-flipped at its market-implied win probability (its entry price); observed hold-to-settle total vs 2000 fair-price seasons — the skill-vs-luck test. Near 50% = indistinguishable from the market; near 100% = the admin beats the prices">${gmeta.mnull}</p>` : ""}
    <div class="fbar">${(hasGate ? ["ceiling", "tp", "stop", "cfm", "adm", "gate"] : ["ceiling", "tp", "stop", "cfm", "adm"]).map(sel).join(" ")}
      <label class="fsel">sort <select id="s" data-keep="1"><option value="total">total</option><option value="wr">profit %</option>
      <option value="pb">%/bet</option><option value="po">%/opp</option><option value="p5">stability p5</option><option value="tstat">t-stat</option></select></label>
      <button id="freset">reset filters</button>
      <span id="fcount" class="note"></span></div>
    <div class="scrollbox"><table class="list" id="grid"></table></div>` +
    (DATA.frozen50 ? `<details style="margin-top:1em"><summary><b>Frozen top-50 watch</b> — locked ${DATA.frozen50.frozen_at} · fresh picks since freeze: ${DATA.frozen50.fresh_n}</summary>
      <p class="note">The 50 best combos as ranked on freeze day, tracked forever on picks they have never seen — grid restructures cannot touch this list. "fresh total" is each combo's P&L on post-freeze picks only: the honest out-of-sample test of whether the top of the sweep was skill or sample luck.</p>
      <div class="scrollbox"><table class="list"><thead><tr><th>#</th><th>combo (ceil/tp/stop/cfm/adm/gate)</th><th>locked total</th><th>fresh ent</th><th>fresh total</th></tr></thead><tbody>${
        DATA.frozen50.rows.map((r, i) => `<tr><td>${i + 1}</td><td>${r.key}</td><td>${r.baseline.total.toFixed(2)}</td><td>${r.fresh ? r.fresh.fresh_ent : ""}</td><td class="${r.fresh && r.fresh.fresh_total > 0 ? "good" : r.fresh && r.fresh.fresh_total < 0 ? "bad" : ""}">${r.fresh ? r.fresh.fresh_total.toFixed(2) : "—"}</td></tr>`).join("")
      }</tbody></table></div></details>` : "");
  const render = () => {
    const fs = [...view().querySelectorAll("[data-f]")].filter(e => e.value !== "");
    const s = document.getElementById("s").value;
    let rs = rows.filter(r => fs.every(e => String(r[e.dataset.f]) === e.value));
    rs = rs.sort((a, b) => (b[s] ?? 0) - (a[s] ?? 0));
    document.getElementById("fcount").textContent = `${rs.length} shown`;
    document.getElementById("grid").innerHTML = `<thead><tr>${
      [["#", "rank"], ["ceil", "ceiling"], ["tp", "tp"], ["stop", "stop"], ["cfm", "cfm"], ["adm", "adm"],
       ...(hasGate ? [["gate", "gate"]] : []),
       ["ent", "ent"], ["prof%", "wr"], ["%/bet", "pb"], ["%/opp", "po"], ["p5", "p5"], ["t", "tstat"], ["total", "total"]]
      .map(([h, k]) => `<th title="${attr(TIPS[k])}">${h}</th>`).join("")}</tr></thead><tbody>` +
      rs.slice(0, 500).map(r => {
        const $ = v => `<td class="${v > 0 ? "good" : v < 0 ? "bad" : ""}">${v.toFixed(2)}</td>`;
        return `<tr data-c="${r.ceiling}" data-tp="${r.tp}" data-stop="${r.stop}" data-cfm="${r.cfm}" data-adm="${r.adm}" data-gate="${r.gate || "off"}">
        <td>${r.rank}</td><td>${r.ceiling}</td><td>${r.tp}</td><td>${r.stop}</td><td>${r.cfm}</td>
        <td>${r.adm}</td>${hasGate ? `<td>${r.gate || "off"}</td>` : ""}<td>${r.ent}</td><td>${r.wr}</td>
        <td class="${r.pb >= 0 ? "good" : "bad"}">${r.pb.toFixed(1)}%</td>
        <td class="${r.po >= 0 ? "good" : "bad"}">${r.po != null ? r.po.toFixed(1) + "%" : ""}</td>${r.p5 != null ? $(r.p5) : "<td></td>"}${r.tstat != null ? `<td class="${r.tstat > 0 ? "good" : "bad"}">${r.tstat.toFixed(2)}</td>` : "<td></td>"}${$(r.total)}</tr>`; }).join("") + "</tbody>";
  };
  // right-click a row -> take its settings to the What-if lab (user 2026-08-04)
  document.getElementById("grid").addEventListener("contextmenu", e => {
    const tr = e.target.closest("tbody tr");
    if (!tr) return;
    e.preventDefault();
    let m = document.getElementById("ctxmenu");
    if (!m) {
      m = document.createElement("div"); m.id = "ctxmenu";
      m.innerHTML = `<div class="ci" data-act="lab">take settings to What-if lab</div>
                     <div class="ci" data-act="filter">set to filters</div>`;
      document.body.appendChild(m);
      document.addEventListener("click", () => { m.style.display = "none"; });
    }
    m.style.left = e.pageX + "px"; m.style.top = e.pageY + "px"; m.style.display = "block";
    m.querySelector('[data-act="lab"]').onclick = () => {
      window.__LABPRESET = { ...tr.dataset };
      m.style.display = "none";
      location.hash = "#lab";
    };
    m.querySelector('[data-act="filter"]').onclick = () => {
      SWEEP_F = { ceiling: tr.dataset.c, tp: tr.dataset.tp, stop: tr.dataset.stop,
                  cfm: tr.dataset.cfm, adm: tr.dataset.adm, gate: tr.dataset.gate || "", sort: SWEEP_F.sort };
      m.style.display = "none";
      view().querySelectorAll("[data-f]").forEach(x => { x.value = SWEEP_F[x.dataset.f] ?? ""; });
      render();
    };
  });
  document.getElementById("s").value = SWEEP_F.sort || "total";
  view().querySelectorAll("select").forEach(e => e.addEventListener("change", () => {
    view().querySelectorAll("[data-f]").forEach(x => { SWEEP_F[x.dataset.f] = x.value; });
    SWEEP_F.sort = document.getElementById("s").value;
    render();
  }));
  document.getElementById("freset").addEventListener("click", () => {
    view().querySelectorAll("[data-f]").forEach(e => e.value = "");
    document.getElementById("s").value = "total";
    SWEEP_F = { ceiling: "", tp: "", stop: "", cfm: "", adm: "", gate: "", sort: "total" };
    render();
  });
  render();
}

// ---------------- What-if lab ----------------
const labDefaults = () => ({ ...(DATA.config.lab) });
let LAB_F = null;                                   // sticky lab state across tab switches
const LAB_IDS = ["ceiling", "tp", "stop", "cfm", "overRunway", "desperateRunway", "desperateDeficit", "admLowMax", "admHighMin"];
const LAB_CBS = ["gateOn", "makerOn", "admLow", "admMid", "admHigh"];
// deployed base parameters for every replay — read from the ENCRYPTED bundle, never hardcoded
const deployedBase = () => {
  const L = DATA.config.lab;
  return { ceiling: L.ceiling, tp: L.tp, stop: L.stop, confirmS: L.cfm * 60,
           unit: DATA.config.unit, gateP: { ...DATA.config.gate },
           // v2 (2026-08-06): deployed FOLLOWS admin sells at/above the encrypted floor —
           // deployed-replays without this misattributed 58% of exits as divergences
           admBands: DATA.config.adm_floor != null ? [[DATA.config.adm_floor, null]] : null,
           sells: DATA.sells || [] };
};
function labView() {
  const LD = labDefaults();
  function slider(id, min, max, step = 1) {
    const v = LD[id];
    return `<label class="sl"><b title="${attr(TIPS[id])}">${id}</b>
            <input type="range" id="${id}" min="${min}" max="${max}" value="${v}" step="${step}" title="${attr(TIPS[id])}">
            <output for="${id}">${v}</output></label>`;
  }
  function val(id) { const e = document.getElementById(id);
    e.nextElementSibling.textContent = (id === "tp" && +e.value >= 100) ? "off" : e.value; return +e.value; }
  view().innerHTML = `<h3>What-if lab — live re-simulation of every recorded lifecycle</h3>
  <div class="sliders">
    ${slider("ceiling", 45, 75)} ${slider("tp", 70, 100)} ${slider("stop", 0, 40)}
    ${slider("cfm", 0, 6, 0.5)} ${slider("overRunway", 0, 3)}
    ${slider("desperateRunway", 1, 4)} ${slider("desperateDeficit", 1, 3)}
  </div>
  <div><label title="Replace every immediate stop-sell with the score-gate decision (veto/hold/sell + event-driven re-checks)"><input type="checkbox" id="gateOn"> apply gate (primary) to stops</label>
       <label title="Enter with a resting bid 1¢ below the signal ask instead of paying the taker fee — misses picks that run away"><input type="checkbox" id="makerOn"> maker entry (ask-1)</label>
       <span title="${attr(TIPS.adm)}">adm:
         <label><input type="checkbox" id="admLow"> low</label>
         <label><input type="checkbox" id="admMid"> mid</label>
         <label><input type="checkbox" id="admHigh"> high</label></span>
       <button id="labreset">reset to defaults</button></div>
  <div class="sliders">${slider("admLowMax", 20, 55)} ${slider("admHighMin", 55, 90)}</div>
  <div id="gatebox">
    <p class="note"><b>deficit</b> = how many breaks down your player is in the CURRENT set ·
    <b>runway</b> = the minimum number of games the opponent still needs to win the whole match.
    The gate is consulted only when a stop wants to fire (bid ≤ stop, sustained cfm minutes).
    Halted match or set break → HOLD · dead score feed → SELL.</p>
    <div id="gaterule" class="note"></div>
  </div>
  <div id="labout"></div>
  <p class="note">Re-runs the 5s replay for every closed lifecycle with your parameters — same engine,
  parity-checked against Python. ${DATA.config.deploy_note} — i.e. what produced "actual". <b>actual</b> is not a simulation: it is the recorded live paper book, exactly as the daemon
  traded it at the time (real fill timing is the only thing the replay cannot reproduce). Since v2 (Aug 6) the deployed bot FOLLOWS admin sells at/above the deployed floor; the adm checkboxes let you explore other regions.</p>`;
  const upd = () => {
    const g = document.getElementById("gateOn").checked;
    ["overRunway", "desperateRunway", "desperateDeficit"].forEach(id => {
      const e = document.getElementById(id); e.disabled = !g;
      e.closest(".sl").classList.toggle("off", !g);
    });
    // live SELL/VETO rule, rendered from the sliders (user 2026-08-03)
    const oR = +document.getElementById("overRunway").value,
          dR = +document.getElementById("desperateRunway").value,
          dD = +document.getElementById("desperateDeficit").value;
    let sellTxt, vetoTxt;
    if (oR >= dR) { sellTxt = `runway ≤ ${oR}`; vetoTxt = `runway ≥ ${oR + 1}`; }
    else {
      sellTxt = `runway ≤ ${oR} OR (deficit ≥ ${dD} AND runway ≤ ${dR})`;
      const mid = oR + 1 === dR ? `runway = ${dR}` : `runway ${oR + 1}–${dR}`;
      vetoTxt = `runway ≥ ${dR + 1}, OR (${mid} AND deficit ≤ ${dD - 1})`;
    }
    document.getElementById("gaterule").innerHTML =
      `<b class="bad">SELL</b> iff ${sellTxt}<br><b class="good">VETO</b> iff ${vetoTxt}`;
    document.getElementById("gatebox").classList.toggle("off", !g);
    const P = {
      ceiling: val("ceiling"), tp: val("tp") >= 100 ? 999 : val("tp"), stop: val("stop") || null, confirmS: val("cfm") * 60,
      unit: DATA.config.unit,
      gate: document.getElementById("gateOn").checked ? "primary" : "off",
      maker: document.getElementById("makerOn").checked ? "ask1" : "off",
      admBands: (() => {
        const lm = val("admLowMax"), hm = val("admHighMin"), b = [];
        if (document.getElementById("admLow").checked) b.push([0, lm]);
        if (document.getElementById("admMid").checked) b.push([lm, hm]);
        if (document.getElementById("admHigh").checked) b.push([hm, null]);
        return b;
      })(), sells: DATA.sells || [],
      gateP: { overRunway: val("overRunway"), desperateRunway: val("desperateRunway"), desperateDeficit: val("desperateDeficit") },
    };
    const done = DATA.lifecycles.filter(r => r.outcome && r.outcome !== "skip" && r.outcome !== "unresolved" && r.pnl != null && sinceOK(r.start_ts))
      .sort((a, b) => (b.start_ts || "").localeCompare(a.start_ts || ""));   // newest first, counterfactuals slotted chronologically
    let tot = 0, actual = 0, outs = {}, subThresh = 0, nSub = 0;
    const div = [], pnls = [];
    for (const r of done) {
      const res = sim.replayLifecycle(r, DATA.scores[r.mkt] || [], P);
      tot += res.pnl; actual += r.pnl;
      pnls.push(res.pnl);
      outs[res.outcome] = (outs[res.outcome] || 0) + 1;
      if (Math.abs(res.pnl - r.pnl) > 0.25) div.push({ r, res });   // fractional-contract pennies stay quiet
      else if (Math.abs(res.pnl - r.pnl) > 0.001) { subThresh += res.pnl - r.pnl; nSub++; }
    }
    // stability, sweep-identical methodology (blocks of date-consecutive picks, B=300, seeded PRNG)
    let p5 = null, tstat = null;
    if (pnls.length >= 8) {
      const asc = [...pnls].reverse();                              // date-ascending for blocks
      const n = asc.length, L = n >= 12 ? Math.max(2, Math.min(7, Math.floor(n / 6))) : 2;
      const nb = Math.ceil(n / L);
      let seed = 1000 + n;
      const rng = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let z = Math.imul(seed ^ seed >>> 15, 1 | seed);
        z = z + Math.imul(z ^ z >>> 7, 61 | z) ^ z; return ((z ^ z >>> 14) >>> 0) / 4294967296; };
      const tots = [];
      for (let b = 0; b < 300; b++) {
        let t = 0, c = 0;
        while (c < n) { const blk = Math.floor(rng() * nb);
          for (let j = 0; j < L && c < n; j++, c++) t += asc[(blk * L + j) % n]; }
        tots.push(t);
      }
      tots.sort((a, b) => a - b);
      p5 = tots[Math.floor(0.05 * tots.length)];
      const mu = asc.reduce((a, x) => a + x, 0) / n;
      const sd = Math.sqrt(asc.reduce((a, x) => a + (x - mu) ** 2, 0) / (n - 1));
      tstat = sd > 0 ? mu / (sd / Math.sqrt(n)) : 0;
    }
    LAB_F = {};
    LAB_IDS.forEach(id => { const e = document.getElementById(id); if (e) LAB_F[id] = e.value; });
    LAB_CBS.forEach(id => { const e = document.getElementById(id); if (e) LAB_F[id] = e.checked; });
    document.getElementById("labout").innerHTML =
      `<h4>result: <span class="${tot >= 0 ? "good" : "bad"}">${tot.toFixed(2)}</span>
       vs actual ${actual.toFixed(2)}
       (Δ <span class="${tot - actual > 0.005 ? "good" : tot - actual < -0.005 ? "bad" : ""}">${(tot - actual).toFixed(2)}</span>)
       over ${done.length} lifecycles
       ${p5 != null ? ` · <span title="${attr(TIPS.p5)} Same blocks/B as the sweep (different RNG, so values may differ by a few cents).">p5 <b class="${p5 > 0 ? "good" : "bad"}">${p5.toFixed(2)}</b></span> · <span title="${attr(TIPS.tstat)}">t <b class="${tstat > 0 ? "good" : "bad"}">${tstat.toFixed(2)}</b></span>` : ""}</h4>
       <div>${Object.entries(outs).map(([k, v]) => `${k}: ${v}`).join(" · ")}</div>` +
      (nSub ? `<div class="note">…plus ${nSub} sub-25¢ differences (contract rounding) totaling ${subThresh >= 0 ? "+" : ""}${subThresh.toFixed(2)} — the list below + this residual = Δ exactly</div>` : "") +
      (div.length ? `<div class="note">picks where the replay differs from the live book:</div>` +
        div.map(({ r, res }) => `<div class="ev">${r.txn || ""} ${r.player || ""}:
          actual ${r.outcome} ${r.pnl.toFixed(2)} → replay ${res.outcome} ${res.pnl.toFixed(2)}
          (Δ <span class="${res.pnl > r.pnl ? "good" : "bad"}">${(res.pnl - r.pnl).toFixed(2)}</span>)</div>`).join("") : "");
  };
  if (LAB_F) {                                               // restore sticky state (tab switches)
    LAB_IDS.forEach(id => { const e = document.getElementById(id);
      if (e && LAB_F[id] != null) { e.value = LAB_F[id]; e.nextElementSibling.textContent = e.value; } });
    LAB_CBS.forEach(id => { const e = document.getElementById(id); if (e) e.checked = !!LAB_F[id]; });
  }
  if (window.__LABPRESET) {                                  // handed over from the sweep explorer
    const pz = window.__LABPRESET; window.__LABPRESET = null;
    const setv = (id, v) => { const e = document.getElementById(id); e.value = v; e.nextElementSibling.textContent = e.value; };
    setv("ceiling", pz.c); setv("tp", pz.tp === "off" ? 100 : pz.tp);
    setv("stop", pz.stop === "off" || pz.stop === "None" ? 0 : +pz.stop);
    setv("cfm", pz.cfm);
    const REG = { never: [], any: ["admLow", "admMid", "admHigh"], high: ["admHigh"], mid: ["admMid"],
                  low: ["admLow"], "high+low": ["admHigh", "admLow"], "high+mid": ["admHigh", "admMid"],
                  "mid+low": ["admMid", "admLow"] };
    const on = REG[pz.adm] || [];
    ["admLow", "admMid", "admHigh"].forEach(id => { document.getElementById(id).checked = on.includes(id); });
    // gate column rides along (2026-08-05): label is overRunway/desperateRunway/desperateDeficit
    if (pz.gate && pz.gate !== "off") {
      const [oR, dR, dD] = pz.gate.split("/");
      document.getElementById("gateOn").checked = true;
      setv("overRunway", oR); setv("desperateRunway", dR); setv("desperateDeficit", dD);
    } else if (pz.gate === "off") document.getElementById("gateOn").checked = false;
  }
  view().querySelectorAll("input").forEach(i => i.addEventListener("input", upd));
  document.getElementById("labreset").addEventListener("click", () => { LAB_F = null; labView(); });
  try { upd(); } catch (e) {
    LAB_F = {};
    LAB_IDS.forEach(id => { const e = document.getElementById(id); if (e) LAB_F[id] = e.value; });
    LAB_CBS.forEach(id => { const e = document.getElementById(id); if (e) LAB_F[id] = e.checked; });
    document.getElementById("labout").innerHTML = `<span class="bad">lab error: ${e.message}</span>`;
  }
}

// ---------------- theme ----------------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem("amit_theme", t);
  const b = document.getElementById("themebtn");
  if (b) b.textContent = t === "dark" ? "☀️" : "🌙";
}
applyTheme(localStorage.getItem("amit_theme") || "light");
document.getElementById("themebtn").addEventListener("click",
  () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));

// ---------------- boot ----------------
const sinceSel = document.getElementById("since");
if (sinceSel) {
  sinceSel.innerHTML = SINCE_OPTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
  sinceSel.value = SINCE_OPTS.some(([v]) => v === SINCE) ? SINCE : "2026-07-30";
  SINCE = sinceSel.value;
  sinceSel.addEventListener("change", () => {
    SINCE = sinceSel.value; sessionStorage.setItem("amit_since", SINCE); route();
  });
}
document.getElementById("unlock").addEventListener("click", unlock);
document.getElementById("pw").addEventListener("keydown", e => { if (e.key === "Enter") unlock(); });
const saved = sessionStorage.getItem("amit_pw");
if (saved) { document.getElementById("pw").value = saved; unlock(); }

// ---------------- mobile affordances (user 2026-08-07) ----------------
// Desktop is untouched: everything here is gated on a coarse pointer. On touch there is no
// hover, so the explanations that live in title= attributes are unreachable — tapping an
// informational element shows its text in a dismissable toast instead.
if (window.matchMedia("(hover: none)").matches) {
  const toast = document.createElement("div");
  toast.id = "tiptoast"; toast.hidden = true;
  document.body.appendChild(toast);
  const hide = () => { toast.hidden = true; };
  toast.addEventListener("click", hide);
  document.addEventListener("click", e => {
    if (e.target.closest("#tiptoast")) return;
    // only INFORMATIONAL elements — never hijack a row, tab, button or control
    const el = e.target.closest("th[title], .note[title], b[title], span[title], label[title]");
    if (!el || e.target.closest("tr.rowlink, a, button, select, input")) return hide();
    const t = el.getAttribute("title");
    if (!t) return hide();
    toast.textContent = t;
    toast.hidden = false;
  }, true);
  // mark tooltip-bearing text so it's discoverable rather than invisible
  const mark = () => document.querySelectorAll("th[title], .note[title], b[title]")
    .forEach(el => el.classList.add("tiphint"));
  new MutationObserver(mark).observe(document.getElementById("view") || document.body,
                                     { childList: true, subtree: true });
  mark();
}
