// Sweep tab (2026-09-25): the research pipeline's nightly grid (research/reinterp, grid nightly-v1),
// replacing the old classifier/sweep.py text grids. Pure functions over bundle.sweeps
// (research/reinterp/portal_sweeps.py, schema portal-sweeps-v1) -> numbers and HTML strings; app.js
// binds the events. No DOM access here, so jsc/node can load it against a bundle
// (tests/js/sweeps_check.mjs, tests/js/app_sweep_smoke.mjs).
// Forward window (user decision 2026-09-25, "A"; research/reinterp/oos.py HOLDOUT_POLICY "open"): every day from
// windows.sealed_from_pt on is in the day arrays and a fwd column for all configs; the ★ locked row's forward
// number is the one clean out-of-sample test (lock.clean), everything else over those days is exploratory.
// Day arrays are PT days of each pick's actionable time (the clock the train/Sept/fwd windows cut on).

export const SCHEMA = "portal-sweeps-v1";
export const AXES = ["ceiling", "tp", "stop", "cfm", "follow"];

const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const f2 = v => v == null ? "—" : (+v).toFixed(2);
const cls = v => v == null ? "" : v > 0 ? "good" : v < 0 ? "bad" : "";
const td = v => `<td class="${cls(v)}">${f2(v)}</td>`;

export const TIPS = {
  ceiling: "Entry ceiling (¢) — live risk.max_entry_price_cents: buy only if the ask is at or below it",
  tp: "Take-profit (¢) — live risk.take_profit_cents; off = ride to settlement",
  stop: "Disaster stop (¢) — live risk.disaster_stop_cents; none = no stop at all",
  cfm: "Stop confirmation (minutes) — the bid must stay at/below the stop this long before selling",
  follow: "Follow his sells — live follow_admin_sell / follow_admin_sell_min_cents: never, or follow any sell he posts while our bid is at/above the floor (floor 0 = every sell; 40 = live; 70 = profit-taking only)",
  view: "Total pnl_u over the picks from the header's start date to the last day with settled picks, forward days included (u = $ per $10 staked: a full loss is about -10 u)",
  ci: "95% PT-day block bootstrap of the total (days resampled with replacement; B=1000, fixed seed)",
  train: "Split-A TRAIN window, Jul 24 – Aug 31 PT. IN-SAMPLE for the ★ choice: it became the live rule on 2026-09-05 after ranking #1 in the nightly sweeps over this window, so its train rank (and its rank in any view starting before Sep 5) is how it was picked, not evidence",
  base_live: "The configs actually in force at the time (the live-config history: it switches config on each change date) — not the ★ choice, which is one fixed config over the whole window",
  sept: "Sept 1 – 25 PT. EXPLORATORY: this window was already scored by the 2026-09-22 exit study, so it is not a validation",
  fwd: "FORWARD: picks from the forward start (Sep 26 PT) on, updated after every match. For the ★ locked choice this is the one CLEAN out-of-sample test (its config was fixed and locked before these days happened). For every other config it is EXPLORATORY: ranking configs on it picks after the fact",
  wf: "Rank (1 = best of all configs) of this config's P&L inside each walk-forward fold (folds after the forward start are exploratory)",
  ent: "Picks entered in the view",
  wr: "Share of entered picks that made money",
};

// the forward window is present (oos.HOLDOUT_POLICY "open", user decision 2026-09-25)
export const hasForward = sw => !!(sw && sw.windows && sw.windows.forward);

export function isValid(sw) {
  return !!(sw && sw.schema === SCHEMA && Array.isArray(sw.configs) && Array.isArray(sw.days));
}

// index of the first day >= since ("" = all days)
export function dayFrom(sw, since) {
  if (!since) return 0;
  const i = sw.days.findIndex(d => d >= since);
  return i < 0 ? sw.days.length : i;
}

// seeded PRNG (mulberry32) — deterministic CIs
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// resample-count matrix shared by every config (so CIs are comparable), B x nDays
export function bootCounts(nDays, B = 1000, seed = 3) {
  const r = rng(seed), out = [];
  for (let b = 0; b < B; b++) {
    const c = new Uint16Array(nDays);
    for (let k = 0; k < nDays; k++) c[Math.floor(r() * nDays)]++;
    out.push(c);
  }
  return out;
}

export function bootCI(vals, counts) {
  if (!vals.length) return null;
  const nz = [];
  vals.forEach((v, i) => { if (v) nz.push(i); });
  const tot = counts.map(c => { let s = 0; for (const i of nz) s += c[i] * vals[i]; return s; }).sort((a, b) => a - b);
  const B = tot.length;
  return { lo: tot[Math.floor(0.025 * B)], hi: tot[Math.floor(0.975 * B) - 1] };
}

// per-config totals over [since, last non-sealed day]; rank 1 = best total (ties by S)
export function viewRows(sw, since, withCI = true) {
  const i0 = dayFrom(sw, since), nd = sw.days.length - i0;
  const counts = withCI && nd > 0 ? bootCounts(nd, (sw.boot || {}).B || 1000, (sw.boot || {}).seed || 3) : null;
  const rows = sw.configs.map(c => {
    let total = 0, ent = 0, wins = 0;
    for (let i = i0; i < sw.days.length; i++) { total += c.d[i]; ent += c.n[i]; wins += c.w[i]; }
    return { c, S: c.S, ceiling: c.ceiling, tp: c.tp, stop: c.stop, cfm: c.cfm, follow: c.follow,
             total: +total.toFixed(4), ent, wr: ent ? wins / ent : null,
             ci: counts ? bootCI(c.d.slice(i0), counts) : null,
             train: (c.train || {}).pnl_u_total ?? null, sept: (c.sept || {}).pnl_u_total ?? null,
             fwd: (c.forward || {}).pnl_u_total ?? null,
             locked: c.S === sw.choice_S };
  });
  const order = [...rows].sort((a, b) => (b.total - a.total) || (a.S < b.S ? -1 : 1));
  order.forEach((r, k) => { r.rank = k + 1; });
  return rows;
}

// walk-forward folds: every config's P&L and rank inside each fold (by PT day), from the day arrays.
// Competition ranking (ties share the best rank: 1 + configs strictly better), so every rank column
// of the walk-forward table -- the argmax-on-past pick's and the fixed choice's -- comes from here.
export function foldRanks(sw) {
  const folds = ((sw.walk_forward || {}).folds || []);
  const ranks = {};
  sw.configs.forEach(c => { ranks[c.S] = []; });
  const perFold = folds.map(f => {
    const idx = sw.days.map((d, i) => (d >= f.from && d < f.to) ? i : -1).filter(i => i >= 0);
    const tot = sw.configs.map(c => ({ S: c.S, v: idx.reduce((s, i) => s + c.d[i], 0) }));
    tot.sort((a, b) => (b.v - a.v) || (a.S < b.S ? -1 : 1));
    let r = 1;
    tot.forEach((t, k) => { if (k > 0 && tot[k - 1].v - t.v > 1e-9) r = k + 1; ranks[t.S].push({ rank: r, v: t.v }); });
    return { from: f.from, to: f.to, days: idx.length };
  });
  return { perFold, ranks };
}

const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// per-axis marginals over the rows given (the filtered view)
export function marginals(sw, rows) {
  return (sw.axes || []).map(ax => ({
    key: ax.key, label: ax.label,
    values: ax.values.map(v => {
      const rs = rows.filter(r => String(r[ax.key]) === String(v));
      const t = rs.map(r => r.total);
      return { v, n: rs.length, mean: t.length ? t.reduce((a, b) => a + b, 0) / t.length : null,
               median: median(t), best: t.length ? Math.max(...t) : null, worst: t.length ? Math.min(...t) : null,
               losing: rs.filter(r => r.total < 0).length };
    }),
  }));
}

export function viewLabel(sw, since) {
  const o = (sw.start_views || []).find(v => v[0] === (since || ""));
  return o ? o[1] : since ? `since ${since}` : "all picks";
}

export function summary(sw, rows, since) {
  const n = rows.length, losing = rows.filter(r => r.total < 0).length;
  const best = rows.reduce((b, r) => (!b || r.rank < b.rank ? r : b), null);
  return { n, losing, best, locked: rows.find(r => r.locked) || null,
           allLose: n > 0 && losing === n, view: viewLabel(sw, since) };
}

const cfgLabel = r => `in≤${r.ceiling}¢ · tp ${r.tp === "off" ? "off" : r.tp + "¢"} · stop ${r.stop === "none" ? "none" : r.stop + "¢"}` +
  `${r.stop === "none" ? "" : " " + r.cfm + "m"} · sells ${r.follow}`;
const ciTxt = ci => ci ? `[${f2(ci.lo)}, ${f2(ci.hi)}]` : "—";

// reader / engine / pricing changes since the lock (portal_sweeps _lock_info, oos.identity_changes): the lock's
// eval rule flags a reader or engine change (never a reason to re-pick); a pricing change voids the clean read
export function idChanges(lk) {
  const ch = ["reader", "engine", "pricing"].filter(k => lk && lk[k + "_changed"] === true);
  if (!ch.length) return "";
  const a = lk.at_lock || {}, n = lk.now || {};
  return ` <span class="idchg warn" title="The lock's eval rule: a reader or engine change since the lock is flagged next to the number, never a reason to re-pick; a pricing change voids the clean read">⚑ changed since the lock: ${
    ch.map(k => `${k} ${esc(a[k])} → ${esc(n[k])}`).join(", ")}</span>`;
}

// staleness (classifier/portal_export.export_sweeps adds sw.freshness at publish time): the summary is only
// rewritten by a successful pipeline run, so say so when a match finished after it or the last run failed
export function staleHTML(sw) {
  const f = sw && sw.freshness;
  if (!f || !f.stale) return "";
  return `<div class="warnbox stale"><b>Not up to date:</b> ${esc(f.why || "")}. Showing the last good summary
    (built ${esc(String(f.summary_at || "?").slice(0, 16).replace("T", " "))} UTC).</div>`;
}

export function headerHTML(sw, rows, since) {
  const s = summary(sw, rows, since);
  const pbo = sw.pbo, highPBO = pbo != null && pbo > 0.5;
  const L = s.locked, lk = sw.lock || {};
  const loses = sw.loses || {};
  const wf = foldRanks(sw);
  const fwd = lk.forward, F = hasForward(sw), W = sw.windows || {};
  const base = sw.baselines || {};
  const BL = { live_in_force: ["configs in force at the time (history)", TIPS.base_live], hold_to_settlement: ["hold to settlement", ""] };
  const bl = k => base[k] ? `<tr><td title="${esc((BL[k] || [])[1] || "")}">${esc((BL[k] || [k.replace(/_/g, " ")])[0])}</td>${td(base[k].train && base[k].train.pnl_u_total)}${td(base[k].sept && base[k].sept.pnl_u_total)}${F ? td(base[k].forward && base[k].forward.pnl_u_total) : ""}</tr>` : "";
  const nFwdCfg = F ? sw.configs.filter(c => c.forward && c.forward.n_entries).length : 0;
  const openTxt = m => m && m.open ? `, ${m.open} still open` : "";
  // the locked choice's forward result: the one clean out-of-sample test when locked before the forward start
  let fwdLine;
  if (F) {
    const clean = lk.clean === true;
    const tag = clean ? `<span class="cleantest">clean out-of-sample test</span>` : lk.lock_id ? `<span class="bad">not a clean test</span>` : "";
    fwdLine = `<br>Forward from ${esc(W.sealed_from_pt)} ${tag}: ` + (
      !lk.lock_id ? "not locked — forward numbers for this choice are exploratory like every other config's"
      : fwd && (fwd.n_entries || fwd.open) ? `<b class="${cls(fwd.pnl_u_total)} ${clean ? "cleantest" : ""}">${f2(fwd.pnl_u_total)} u</b> on ${fwd.n_entries} settled picks${openTxt(fwd)}${lk.forward_through ? ` through ${esc(lk.forward_through)} PT` : ""}`
      : `no forward picks yet — this line fills after the first settled pick from ${esc(W.sealed_from_pt)} on`) +
      (lk.lock_id ? idChanges(lk) + ` <span class="note">(lock ${esc(lk.lock_id)}, locked ${esc(String(lk.locked_at || "").slice(0, 16).replace("T", " "))} UTC; ${esc(lk.clean_why || "")}; recomputed every run — the choice is fixed, only the data grows${
        lk.recorded && lk.recorded.forward ? `; recorded read ${f2(lk.recorded.forward.pnl_u_total)} u up to ${esc(String(lk.recorded.until || "").slice(0, 10))}` : ""})</span>` : "");
  } else {
    fwdLine = `<br>Forward from ${esc(W.sealed_from_pt)}: ${fwd ? `<b class="${cls(fwd.pnl_u_total)}">${f2(fwd.pnl_u_total)} u</b> on ${fwd.n_entries} picks${lk.forward_until ? ` up to ${esc(String(lk.forward_until).slice(0, 10))}` : ""} (lock ${esc(lk.lock_id)}, read ${esc(lk.forward_at)})`
        : lk.lock_id ? `locked (${esc(lk.lock_id)}), not evaluated yet` : "SEALED — not locked yet; forward numbers appear only after the choice is locked and evaluated once"}`;
  }
  const wfRows = ((sw.walk_forward || {}).folds || []).map((f, i) => {
    const lr = L ? wf.ranks[L.S][i] : null;
    const ar = f.selected && wf.ranks[f.selected] ? wf.ranks[f.selected][i] : null;
    return `<tr><td>${esc(f.from)} → ${esc(f.to)}</td>
      <td>${ar ? `${ar.rank} / ${sw.n_configs}` : "—"}</td>${td(f.selected_test && f.selected_test.pnl_u_total)}
      <td>${lr ? `${lr.rank} / ${sw.n_configs}` : "—"}</td>${td(lr ? lr.v : null)}
      ${td(f.baselines ? f.baselines.live_in_force : null)}${td(f.baselines ? f.baselines.hold_to_settlement : null)}</tr>`;
  }).join("");
  const sp = ((sw.walk_forward || {}).fold_rank_spearman || []).map(v => v == null ? "—" : v.toFixed(2)).join(", ");
  return `<h3>Strategy sweep — ${esc(sw.grid)} · ${sw.n_configs} configs · ${esc(s.view)} <small>· picks through ${esc(sw.through_day)} PT</small></h3>
  ${staleHTML(sw)}<div class="warnbox">
    <b>${s.allLose ? `Every one of the ${s.n} configs loses money` : `${s.losing} of ${s.n} configs lose money`}</b> in the current view (${esc(s.view)})
    (train: ${loses.train ?? "?"} of ${sw.n_configs} lose; Sept: ${loses.sept ?? "?"} lose${F ? `; forward (exploratory): ${nFwdCfg ? `${loses.forward ?? "?"} of ${sw.n_configs} lose` : "no settled picks yet"}` : ""}).
    Rank 1 is the least-bad config, not an edge (the ★ row is pinned first whatever its rank).
    ${pbo != null ? `<br><b>Rankings are ${highPBO ? "unreliable" : "only weakly informative"}:</b> probability of backtest overfitting PBO = ${pbo.toFixed(2)}
      ${highPBO ? "(above 0.5: the train-window winner usually lands in the bottom half of the other half of the data)" : ""}.
      Walk-forward: re-ranking on the past picked a config whose next-fold rank was ${((sw.walk_forward || {}).folds || []).map((f, i) => f.selected && wf.ranks[f.selected] ? wf.ranks[f.selected][i].rank : "—").join(", ")} of ${sw.n_configs}
      ${sp ? `; fold-to-fold rank correlation ${sp}` : ""}.` : ""}
  </div>
  <div class="lockedbox">
    <b>Pre-registered choice (fixed, not re-ranked):</b> ${L ? esc(cfgLabel(L)) : "<span class=bad>not in this grid</span>"}
    — ${esc((sw.prereg || {}).choice_rule ? "the config in force when the grid was registered" : "")}
    ${L ? `<br>${esc(s.view)}: <b class="${cls(L.total)}">${f2(L.total)} u</b> (rank ${L.rank} of ${s.n}, CI ${ciTxt(L.ci)}) ·
      train (in-sample) <b class="${cls(L.train)}">${f2(L.train)}</b> ${ciTxt(L.c.ci_train)} · Sept (exploratory) <b class="${cls(L.sept)}">${f2(L.sept)}</b> ${ciTxt(L.c.ci_sept)}
      ${fwdLine}
      <br><span class="note">In-sample caveat: this choice became the live rule on 2026-09-05 because it ranked #1 in the nightly sweeps over the train window, so its train number and its rank in every view starting before Sep 5 are how it was picked, not a test. Only picks after Sep 5 — and ${F ? "its forward result above" : "the sealed forward read"} — are out-of-sample for it.</span>` : ""}
  </div>
  <details class="sw-sec"><summary><b>What these numbers are</b></summary>
    <p class="note">${esc((sw.labels || {}).exploratory || "")}</p>
    <p class="note">${esc((sw.labels || {}).pnl_u || "")}</p>
    <p class="note">${esc((sw.labels || {}).lag || "")}</p>
    <p class="note"><b>Grid.</b> ceiling {60, 65} × take-profit {85, 92, 99, off} × (stop, confirm) {(none), (15, 0/3m), (20, 0/3m), (25, 0/1/3m), (30, 0–5m), (35, 0–5m)} × follow his sells {never, floor 0, 40, 70} = ${sw.n_configs}.
      ${esc(sw.dropped || "")}</p>
    ${F ? `<p class="note"><b>Forward.</b> ${esc((sw.labels || {}).forward || "")} Every day from ${esc(W.sealed_from_pt)} on is in the per-day results, the view totals and the fwd column for all ${sw.n_configs} configs, updated after every match; the ★ row's fwd number is the clean test, every other fwd number (and any rank over those days) is exploratory.</p>` : ""}
    <p class="note"><b>Start date.</b> The header's start selector re-cuts every total in this tab from per-day results (the view column); the train, Sept${F ? " and fwd" : ""} columns are fixed windows. ${F ? "" : `Sealed forward picks (from ${esc(W.sealed_from_pt)}) are never shown except the locked choice's single forward read.`}</p>
    <p class="note"><b>Engine.</b> Every config is a full replay of the live code (research/reinterp, reader + pricing + engine versions ${esc((sw.build || {}).i)}/${esc((sw.build || {}).p)}/${esc((sw.build || {}).e)}) on today's interpretation of every admin message; results dir ${esc(sw.results_dir)}.</p>
  </details>
  <details class="sw-sec"><summary><b>Baselines</b> (train / Sept${F ? " / forward" : ""})</summary>
    <table class="list"><thead><tr><th>policy</th><th title="${esc(TIPS.train)}">train</th><th title="${esc(TIPS.sept)}">Sept</th>${F ? `<th title="${esc(TIPS.fwd)}">fwd</th>` : ""}</tr></thead><tbody>
    ${bl("live_in_force")}${bl("hold_to_settlement")}<tr><td>no trade</td><td>0.00</td><td>0.00</td>${F ? "<td>0.00</td>" : ""}</tr></tbody></table></details>
  <details class="sw-sec"><summary><b>Walk-forward</b> — does re-ranking on the past pick a winner?</summary>
    <table class="list"><thead><tr><th>fold (PT)</th><th>argmax-on-past: rank in fold</th><th>its fold total</th><th>fixed choice: rank</th><th>its fold total</th><th title="${esc(TIPS.base_live)}">in force at the time</th><th>hold</th></tr></thead>
    <tbody>${wfRows}</tbody></table>
    <p class="note">Anchored: each fold picks the best config on every pick before it, then scores it on the fold. Ranks: 1 = best in the fold; tied configs share a rank. ${F ? `The forward start (${esc(W.sealed_from_pt)}) is a fixed fold boundary: the folds before it never change, the folds from it on (the last one ends where the data ends) are exploratory like every forward ranking.` : "The last fold ends where the sealed holdout starts."}</p></details>`;
}

export function marginalsHTML(sw, rows) {
  const m = marginals(sw, rows);
  return `<details class="sw-sec" open><summary><b>Per-axis marginals</b> — each value averaged over every other knob (filtered view)</summary>
  <div class="margins">${m.map(ax => `<table class="list margin"><thead><tr><th title="${esc(TIPS[ax.key])}">${esc(ax.label)}</th><th>configs</th><th>mean</th><th>median</th><th>best</th><th>losing</th></tr></thead><tbody>${
    ax.values.map(v => `<tr><td>${esc(v.v)}</td><td>${v.n}</td>${td(v.mean)}${td(v.median)}${td(v.best)}<td>${v.n ? `${v.losing}/${v.n}` : ""}</td></tr>`).join("")
  }</tbody></table>`).join("")}</div>
  <p class="note">stop and confirm are paired (confirm is only swept at 25/30/35 and at 15/20 as 0 or 3 min), so their marginals mix different companions.</p></details>`;
}

export function tableHTML(sw, rows, wf, limit = 700) {
  const head = [["#", "view", "rank"], ["ceil", "ceiling"], ["tp", "tp"], ["stop", "stop"], ["cfm", "cfm"], ["sells", "follow"],
    ["ent", "ent"], ["win%", "wr"], ["view total", "view"], ["view CI", "ci"], ["train", "train"], ["train CI", "ci"],
    ["Sept*", "sept"], ["Sept CI", "ci"], ...(hasForward(sw) ? [["fwd*", "fwd"], ["fwd CI", "ci"]] : []), ["WF ranks", "wf"]];
  const nf = (wf.perFold || []).length, F = hasForward(sw), clean = F && (sw.lock || {}).clean === true;
  const fcell = r => !F ? "" : (r.locked && clean
    ? `<td class="${cls(r.fwd)} cleantest" title="clean out-of-sample test (locked before the forward start)">${f2(r.fwd)}</td>`
    : td(r.fwd)) + `<td class="note">${ciTxt(r.c.ci_forward)}</td>`;
  return `<thead><tr>${head.map(([h, k]) => `<th title="${esc(TIPS[k] || "")}">${h}</th>`).join("")}</tr></thead><tbody>` +
    rows.slice(0, limit).map(r => `<tr class="${r.locked ? "locked" : ""}" data-s="${esc(r.S)}" data-c="${esc(r.ceiling)}" data-tp="${esc(r.tp)}"
      data-stop="${esc(r.stop)}" data-cfm="${esc(r.cfm)}" data-follow="${esc(r.follow)}">
      <td>${r.rank}${r.locked ? " ★" : ""}</td><td>${esc(r.ceiling)}</td><td>${esc(r.tp)}</td><td>${esc(r.stop)}</td><td>${esc(r.cfm)}</td><td>${esc(r.follow)}</td>
      <td>${r.ent}</td><td>${r.wr == null ? "" : (100 * r.wr).toFixed(0)}</td>${td(r.total)}<td class="note">${ciTxt(r.ci)}</td>
      ${td(r.train)}<td class="note">${ciTxt(r.c.ci_train)}</td>${td(r.sept)}<td class="note">${ciTxt(r.c.ci_sept)}</td>${fcell(r)}
      <td class="note">${nf ? (wf.ranks[r.S] || []).map(x => x.rank).join(" · ") : ""}</td></tr>`).join("") + "</tbody>";
}

// filters: {axisKey: "value" | ""}; sort: view|train|sept|fwd|wr|ent
export function applyFilters(rows, filters, sort) {
  const fs = Object.entries(filters || {}).filter(([, v]) => v !== "" && v != null);
  const out = rows.filter(r => fs.every(([k, v]) => String(r[k]) === String(v)));
  const key = { view: "total", train: "train", sept: "sept", fwd: "fwd", wr: "wr", ent: "ent" }[sort || "view"] || "total";
  out.sort((a, b) => ((b[key] ?? -1e9) - (a[key] ?? -1e9)) || (a.S < b.S ? -1 : 1));
  const L = out.findIndex(r => r.locked);                 // the fixed choice is always pinned on top
  if (L > 0) out.unshift(out.splice(L, 1)[0]);
  return out;
}

export function filterBarHTML(sw, filters, sort) {
  const sel = ax => `<label class="fsel" title="${esc(TIPS[ax.key])}">${esc(ax.key)} <select data-f="${ax.key}"><option value="">*</option>${
    ax.values.map(v => `<option${String(v) === String(filters[ax.key] ?? "") ? " selected" : ""}>${esc(v)}</option>`).join("")}</select></label>`;
  const so = [["view", "view total"], ["train", "train"], ["sept", "Sept"], ...(hasForward(sw) ? [["fwd", "forward"]] : []), ["wr", "win %"], ["ent", "entries"]];
  return `<div class="fbar">${(sw.axes || []).map(sel).join(" ")}
    <label class="fsel">sort <select id="s" data-keep="1">${so.map(([v, l]) => `<option value="${v}"${v === sort ? " selected" : ""}>${l}</option>`).join("")}</select></label>
    <button id="freset">reset filters</button> <span id="fcount" class="note"></span></div>`;
}

// lab hand-over: the lab's adm regions use boundaries 40/70, so a floor maps onto them exactly
export function labPreset(ds) {
  const ADM = { never: "never", "floor 0": "any", "floor 40": "high+mid", "floor 70": "high" };
  return { c: ds.c, tp: ds.tp, stop: ds.stop === "none" ? "off" : ds.stop, cfm: ds.cfm, adm: ADM[ds.follow] || "never", gate: "off" };
}
