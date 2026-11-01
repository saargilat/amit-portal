// Amit simulator core — JS port of the Python scorers (sweep candle-walk, gate v2.1 evaluate +
// chain replay, maker ghost fills, fee model). Parity with Python is enforced by generated test
// vectors (portal/data/vectors.json) checked at load; the header shows the parity badge.
// Every function is pure; the what-if lab calls these with slider params.

export const fees = {
  taker: (c, p) => Math.ceil(0.07 * c * (p / 100) * (1 - p / 100) * 100) / 100,
  maker: (c, p) => Math.ceil(0.0175 * c * (p / 100) * (1 - p / 100) * 100) / 100,
};

// ---------------- gate v2.1 (score_gate.py) ----------------

export function breakDeficit(ourG, oppG, oppServingNow) {
  const n = ourG + oppG;
  const prevWasOpp = !oppServingNow;
  const oppServed = prevWasOpp ? Math.floor((n + 1) / 2) : Math.floor(n / 2);
  return oppG - oppServed;
}

export function runway(ourG, oppG, ourS, oppS) {
  if (oppS >= 2) return 0;
  let need;
  if (ourG === 6 && oppG === 6) need = 1;
  else {
    const direct = Math.max(6, ourG + 2) - oppG;
    const viaTb = ourG >= 5 ? (6 - oppG) + 1 : direct;
    need = Math.max(1, Math.min(direct, viaTb));
  }
  return need + 6 * Math.max(0, 1 - oppS);
}

const HALTED = new Set(["interrupted", "suspended", "delayed", "paused", "postponed"]);
const FINISHED = new Set(["finished", "ended", "closed", "fnl"]);

export function evaluate(row, ours, nowTs, P = {}) {
  // P: {freshS:120, desperateDeficit:2, desperateRunway:2, overRunway:1}
  const p = { freshS: 120, ...P };                            // gate thresholds arrive via P
  const out = { verdict: "no-data", verdict_strict: "no-data", reason: "", deficit: null, runway: null };
  if (!row) { out.reason = "no score row"; return out; }
  if (ours !== 1 && ours !== 2) { out.reason = "side unmapped"; return out; }
  const age = nowTs - Date.parse(row.t) / 1000;
  if (age > p.freshS) { out.reason = `stale (${Math.round(age)}s)`; return out; }
  if (row.verdict !== "ok") { out.reason = `score not ok (${row.verdict})`; return out; }
  const status = String(row.status || "").toLowerCase();
  const widget = String(row.widget || "").toLowerCase();
  if (HALTED.has(status) || HALTED.has(widget)) { out.verdict = "hold"; out.reason = "match halted"; return out; }
  if (row.stale) { out.reason = "feed frozen"; return out; }
  const s1 = row.s1 || [], s2 = row.s2 || [];
  // ongoing set = last index where a set exists and neither side has closed it as winner/loser
  // (export gives scores only; infer: set i ongoing if it is the LAST set and match not decided)
  const setsWon = (a, b) => {
    let w1 = 0, w2 = 0;
    for (let i = 0; i < Math.min(a.length, b.length) - 1; i++) {   // completed sets = all but last
      if (a[i] > b[i]) w1++; else if (b[i] > a[i]) w2++;
    }
    return [w1, w2];
  };
  // decide if the LAST set is ongoing or the match is over: exporter keeps raw arrays; a decided
  // match in export has winner via settles — the chain passes matchDecided explicitly.
  const nSets = Math.min(s1.length, s2.length);
  if (nSets === 0) { out.reason = "no sets"; return out; }
  const [w1c, w2c] = setsWon(s1, s2);
  const g1 = s1[nSets - 1], g2 = s2[nSets - 1];
  const lastDecided = row.lastSetComplete === true;   // set by the chain when it detects boundary
  if (lastDecided) {
    const w1 = w1c + (g1 > g2 ? 1 : 0), w2 = w2c + (g2 > g1 ? 1 : 0);
    if (w1 >= 2 || w2 >= 2 || row.matchDecided) { out.reason = "no ongoing set (match decided)"; return out; }
    out.verdict = "hold"; out.reason = `set break (sets ${w1}-${w2})`; return out;
  }
  if (!row.server || (row.server !== row.c1 && row.server !== row.c2)) {
    out.reason = "server unknown"; return out;
  }
  const ourG = ours === 1 ? g1 : g2, oppG = ours === 1 ? g2 : g1;
  const ourS = ours === 1 ? w1c : w2c, oppS = ours === 1 ? w2c : w1c;
  const oppId = ours === 1 ? row.c2 : row.c1;
  const dfc = breakDeficit(ourG, oppG, row.server === oppId);
  const rw = runway(ourG, oppG, ourS, oppS);
  out.deficit = dfc; out.runway = rw;
  out.verdict = verdictPrimary(dfc, rw, p);
  out.verdict_strict = verdictStrict(dfc, rw);
  out.reason = out.verdict === "veto" ? `deficit ${dfc}, runway ${rw}` :
    (rw <= p.overRunway ? `runway ${rw} ≤${p.overRunway}` : `deficit ${dfc} ≥${p.desperateDeficit} ∧ runway ${rw} ≤${p.desperateRunway}`);
  return out;
}

// ---------------- 5s lifecycle replay (gate chain + maker + exits) ----------------

export function replayLifecycle(life, scoreRows, P = {}) {
  // P: {ceiling, tp, stop, confirmS, gate:'off'|'primary'|'strict', gateP:{...}, maker:'off'|'ask0'|'ask1'}
  const p = { gate: "off", gateP: {}, maker: "off", ...P };   // strategy numbers come from the
  // encrypted bundle's config — the public code carries none (2026-08-04)
  const asks = life.ask || [], bids = life.bid || [], toff = life.toff || [];
  const t0 = Date.parse(life.start_ts) / 1000;
  const freq = life.freq_s || 5;
  const wlen = Math.floor((life.window_kind === "ongoing" ? 300 : 900) / freq);
  const sr = (scoreRows || []).map(r => ({ ...r, ts: Date.parse(r.t) / 1000 }));
  const latestScore = ts => { let b = null; for (const r of sr) { if (r.ts <= ts) b = r; else break; } return b; };
  const events = [];
  // entry
  let entry = null, ei = null, makerLevel = null, makerFillIdx = null;
  for (let i = 0; i < Math.min(wlen, asks.length); i++) {
    const a = asks[i];
    if (a == null) continue;
    if (makerLevel == null && a > 0 && a <= 99) {
      makerLevel = Math.min(p.maker === "ask1" ? a - 1 : a, p.ceiling);
    }
    if (p.maker !== "off") {
      if (makerFillIdx == null && makerLevel != null && i > 0 && a <= makerLevel) makerFillIdx = i;
    }
    if (entry == null && a > 0 && a <= p.ceiling) { entry = a; ei = i; events.push({ i, kind: "entry", px: a }); }
    if (entry != null && p.maker === "off") break;
  }
  if (p.maker !== "off") {
    if (makerFillIdx == null) return { outcome: "maker-miss", pnl: 0, events };
    entry = makerLevel; ei = makerFillIdx;
    events.push({ i: makerFillIdx, kind: "maker-fill", px: makerLevel });
  }
  if (entry == null) return { outcome: "skip", pnl: 0, events };
  const C = p.unit / (entry / 100);   // FRACTIONAL (sweep convention) — the lab is exploratory
  // (user 2026-08-03); the daemon books whole contracts, so tiny deltas vs actual are expected
  const entryFee = p.maker !== "off" ? fees.maker(C, entry) : fees.taker(C, entry);
  // admin-follow (user 2026-08-04): REGION SUBSETS — fill at the last bid AT OR BEFORE the sell
  // (D3 rule) when it lands in any enabled band. P.admBands = [[lo,hi|null],...] or null.
  const bands = (p.admBands && p.admBands.length) ? p.admBands : null;
  const ev = (life.mkt || "").split("-").slice(0, -1).join("-");
  let pending = bands ? (p.sells || [])
    .map(x => ({ ts: Date.parse(x.t) / 1000, ev: x.ev }))
    .filter(x => x.ts > t0 + (toff[ei] ?? 0) && (!x.ev || x.ev === ev))
    .map(x => x.ts).sort((a, b) => a - b) : [];
  let lb = null;
  // exit walk with gate chain. Stop sustain mirrors the daemon EXACTLY (paper_sim first_below_ts):
  // the timer starts AT the first below-stop sample (elapsed 0 there) — accumulating the gap from
  // the previous (above-stop) row fired one row early on perfect 5s cadence (T037, 2026-08-03).
  let firstBelowTs = null, prevTs = null, vetoMode = false, lastRowT = null;
  for (let i = ei + 1; i < bids.length; i++) {
    const b = bids[i], a = asks[i];
    const ts = t0 + (toff[i] != null ? toff[i] : i * freq);
    if (b == null) continue;
    if (b === 0 && a != null && a >= 99) { prevTs = ts; continue; }
    const gap = prevTs != null && ts - prevTs > 3 * freq;
    prevTs = ts;
    if (b >= p.tp) {
      events.push({ i, kind: "tp", px: p.tp });
      return { outcome: "take-profit", pnl: round2(C * p.tp / 100 - C * entry / 100 - entryFee - fees.maker(C, p.tp)), events };
    }
    while (pending.length && ts >= pending[0]) {          // admin fill at last bid BEFORE the sell
      const px = lb;
      pending.shift();
      if (px != null && bands.some(bd => px >= bd[0] && (bd[1] == null || px < bd[1]))) {
        events.push({ i, kind: "adm-sell", px });
        return { outcome: "adm-sell", pnl: round2(C * px / 100 - C * entry / 100 - entryFee - fees.taker(C, px)), events };
      }
    }
    lb = b;
    if (!p.stop) continue;
    const row = latestScore(ts);
    const halted = row && (HALTED.has(String(row.status || "").toLowerCase()) || HALTED.has(String(row.widget || "").toLowerCase()));
    if (halted) continue;
    if (gap) firstBelowTs = null;
    if (b > p.stop) { firstBelowTs = null; if (vetoMode) { vetoMode = false; events.push({ i, kind: "recovery", px: b }); } continue; }
    if (!vetoMode) {
      if (firstBelowTs == null) { firstBelowTs = ts; continue; }
      if (ts - firstBelowTs >= p.confirmS) {
        if (p.gate === "off") { events.push({ i, kind: "stop", px: b }); return sell(b, i); }
        const v = evaluate(row, row && row.ours, ts, p.gateP);
        const verdict = p.gate === "strict" ? (v.verdict === "no-data" || v.verdict === "hold" ? v.verdict : v.verdict_strict) : v.verdict;
        events.push({ i, kind: "gate", verdict, px: b, detail: v.reason });
        if (verdict === "veto") { vetoMode = true; lastRowT = row && row.t; }
        else if (verdict === "hold") { /* wait */ }
        else return sell(b, i);
      }
    } else {
      const row2 = latestScore(ts);
      if (row2 && row2.t !== lastRowT) {
        lastRowT = row2.t;
        const v = evaluate(row2, row2.ours, ts, p.gateP);
        const verdict = p.gate === "strict" ? (v.verdict === "no-data" || v.verdict === "hold" ? v.verdict : v.verdict_strict) : v.verdict;
        if (verdict !== "veto" && verdict !== "hold") { events.push({ i, kind: "gate-sell", px: b, detail: v.reason }); return sell(b, i); }
      }
    }
  }
  // settle_yes is only injected by the books path — fall back to the export-authoritative
  // match_won so lab/standalone replays settle correctly (2026-08-03: winners booked as 0)
  const won = life.settle_yes != null ? life.settle_yes === true : life.match_won === true;
  const px = won ? 100 : 0;
  events.push({ i: bids.length - 1, kind: "settlement", px });
  return { outcome: "settlement", pnl: round2(C * px / 100 - C * entry / 100 - entryFee), events };

  function sell(b, i) {
    const px = Math.max(1, b);
    return { outcome: "stop-loss", pnl: round2(C * px / 100 - C * entry / 100 - entryFee - fees.taker(C, px)), events };
  }
}

// ---------------- candle-walk (sweep run()) ----------------

export function candleWalk(cs, S, settleYes) {
  let entry = null, si = null;
  for (let i = 0; i < Math.min(15, cs.length); i++) {
    if (cs[i].ask <= S.ceiling) { entry = cs[i].ask; si = i; break; }
  }
  if (entry == null) return { outcome: "skip", pnl: 0 };
  const C = (S.unit || 10) / (entry / 100);   // candleWalk mirrors the SWEEP (fractional at unit,
  // rescaled) — NOT the daemon; only replayLifecycle books integer contracts (parity 2026-08-03)
  let below = 0;
  for (let j = si + 1; j < cs.length; j++) {
    const c = cs[j];
    if (c.bid_hi >= S.tp) return { outcome: "take-profit", pnl: round2(C * S.tp / 100 - C * entry / 100 - fees.taker(C, entry) - fees.maker(C, S.tp)) };
    if (S.stop && c.bid_hi <= S.stop) {
      below += 1;
      if (below >= S.confirm) {
        const px = Math.max(1, Math.min(c.bid != null ? c.bid : c.bid_lo, S.stop));
        return { outcome: "stop-loss", pnl: round2(C * px / 100 - C * entry / 100 - fees.taker(C, entry) - fees.taker(C, px)) };
      }
    } else below = 0;
  }
  const px = settleYes ? 100 : 0;
  return { outcome: "settlement", pnl: round2(C * px / 100 - C * entry / 100 - fees.taker(C, entry)) };
}

function round2(x) { return Math.round(x * 100) / 100; }

export const verdictPrimary = (dfc, rw, p) =>
  ((dfc >= p.desperateDeficit && rw <= p.desperateRunway) || rw <= p.overRunway)
    ? "stop" : "veto";
export const verdictStrict = (dfc, rw) => (dfc <= 1 && rw >= 3) ? "veto" : "stop";

export async function checkParity(vectors, gateCfg) {
  const fails = [];
  for (const v of vectors.fees || []) {
    if (fees.taker(v.c, v.p) !== v.taker || fees.maker(v.c, v.p) !== v.maker) fails.push(["fee", v]);
  }
  for (const v of vectors.deficit || []) {
    if (breakDeficit(v.our, v.opp, v.oppServing) !== v.expect) fails.push(["deficit", v]);
  }
  for (const v of vectors.runway || []) {
    if (runway(v.our, v.opp, v.ourS, v.oppS) !== v.expect) fails.push(["runway", v]);
  }
  for (const v of vectors.verdicts || []) {
    if (verdictPrimary(v.d, v.r, gateCfg) !== v.primary || verdictStrict(v.d, v.r) !== v.strict)
      fails.push(["verdict", v]);
  }
  for (const v of vectors.candle || []) {
    const r = candleWalk(v.cs, v.S, v.settleYes);
    if (r.outcome !== v.outcome || Math.abs(r.pnl - v.pnl) > 0.011) fails.push(["candle", v, r]);
  }
  return fails;
}
