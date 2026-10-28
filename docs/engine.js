// Prediction engine based on "Οι μαγικοί αριθμοί του ποδοσφαίρου" (K. Bezas).
// Each team's history: array of {r:'W'|'D'|'L', home:boolean}, oldest -> newest,
// all competitions, only matches played before the fixture.
// Output scores for outcomes H (home win), D (draw), A (away win) plus fired rules.

const Engine = (() => {
  const MIN_GAMES = 7;

  function counts(rs) {
    const c = { W: 0, D: 0, L: 0 };
    for (const r of rs) c[r]++;
    return c;
  }
  const pos = c => c.W + c.D;
  const fmt = c => `${c.W}-${c.D}-${c.L}`;
  const lastN = (h, n) => h.slice(-n).map(m => m.r);
  const resFor = (outcome, side) => // result for side ('h'|'a') under outcome
    outcome === 'D' ? 'D' : (outcome === 'H') === (side === 'h') ? 'W' : 'L';
  const l1 = (a, b) => Math.abs(a.W - b.W) + Math.abs(a.D - b.D) + Math.abs(a.L - b.L);
  const isGolden = c => [c.W, c.D, c.L].sort().join('') === '124';

  function predict(homeHist, awayHist) {
    if (homeHist.length < MIN_GAMES || awayHist.length < MIN_GAMES) return null;
    const S = { H: 0, D: 0, A: 0 };
    const rules = [];
    const add = (id, text, w) => { for (const k in w) S[k] += w[k]; rules.push({ id, text, w }); };

    const T = {
      h: { hist: homeHist, name: 'Home' },
      a: { hist: awayHist, name: 'Away' },
    };
    for (const s of ['h', 'a']) {
      const t = T[s];
      t.f5 = counts(lastN(t.hist, 5));
      t.f6 = counts(lastN(t.hist, 6));
      t.f7 = counts(lastN(t.hist, 7));
      t.f8 = counts(lastN(t.hist, 8));
      t.last3 = lastN(t.hist, 3);
      t.lastHome = t.hist[t.hist.length - 1].home;
    }
    const H = T.h, A = T.a;
    const OUT = ['H', 'D', 'A'];
    const winFor = s => (s === 'h' ? 'H' : 'A');
    const other = s => (s === 'h' ? 'a' : 'h');

    // R1 Balance (pp. 46-48): 6-match form + this result -> forms as equal as possible.
    const dist = {};
    for (const o of OUT) {
      const nh = { ...H.f6 }; nh[resFor(o, 'h')]++;
      const na = { ...A.f6 }; na[resFor(o, 'a')]++;
      dist[o] = l1(nh, na);
    }
    const minD = Math.min(...Object.values(dist));
    const best = OUT.filter(o => dist[o] === minD);
    const w1 = {}; best.forEach(o => (w1[o] = 2 / best.length));
    add('balance', `Balance: ${fmt(H.f6)} vs ${fmt(A.f6)} → ${best.map(lbl).join('/')} brings the forms closest`, w1);

    // R2 Common zero in draws (p. 47): both 6-forms without a draw -> draw fills it.
    if (H.f6.D === 0 && A.f6.D === 0)
      add('commonZero', 'Common zero: neither team has drawn in 6 → a draw fills the gap', { D: 2 });

    // R3 Trailing team (pp. 79-81): the side behind in positive results over 7
    // closes the gap; confirmed by the 5-match form; boosted at home.
    const p7h = pos(H.f7), p7a = pos(A.f7);
    if (p7h !== p7a) {
      const tr = p7h < p7a ? 'h' : 'a', ld = other(tr);
      const gap7 = Math.abs(p7h - p7a);
      const gap5 = pos(T[ld].f5) - pos(T[tr].f5);
      const w = { [winFor(tr)]: 1, D: 1 };
      let text = `Trailing team: ${tr === 'h' ? 'home' : 'away'} side has ${Math.min(p7h, p7a)} vs ${Math.max(p7h, p7a)} positive results in 7 → should not lose`;
      if (gap5 <= gap7) { w[winFor(tr)] += 0.5; w.D += 0.5; text += ' (confirmed by 5-match form)'; }
      if (tr === 'h') { w.H += 0.5; text += ' + home advantage'; }
      add('trailing', text, w);
    }

    // R4 Unbeaten 7 vs exactly one loss in 7 (p. 81): unbeaten side loses.
    for (const s of ['h', 'a']) {
      if (T[s].f7.L === 0 && T[other(s)].f7.L === 1)
        add('unbeaten7', `Unbeaten in 7 against a side with one loss in 7 → unbeaten run ends`, { [winFor(other(s))]: 2 });
    }

    // R5 Six straight wins (p. 68): struggles to win; if it does, narrowly.
    for (const s of ['h', 'a']) {
      if (T[s].f6.W === 6)
        add('sixWins', `${side(s)} has won 6 in a row → will struggle to win again`, { D: 1, [winFor(other(s))]: 0.5 });
    }

    // R6 Six straight negative results (p. 69): hard to lose vs moderate opponent (≤3 positives).
    for (const s of ['h', 'a']) {
      if (pos(T[s].f6) === 0) {
        const op = pos(T[other(s)].f6);
        if (op <= 3) add('sixLosses', `${side(s)} lost 6 in a row, opponent only moderate (${op} positives) → hard to lose`, { [winFor(s)]: 1, D: 1 });
        else add('sixLosses', `${side(s)} lost 6 in a row vs strong opponent → loses narrowly`, { [winFor(other(s))]: 1 });
      }
    }

    // R7 Home side at 1-1-4 (p. 67): won't lose unless opponent has 4+ positives in 6.
    if (H.f6.L === 4 && H.f6.W === 1 && H.f6.D === 1) {
      if (pos(A.f6) < 4) add('home114', 'Home side at 1-1-4 vs opponent with <4 positives → home side does not lose', { H: 1, D: 1 });
    }

    // R8 4-1-1 sides (p. 68): give up a positive result only to equal or better form.
    for (const s of ['h', 'a']) {
      const f = T[s].f6;
      if (f.W === 4 && f.D === 1 && f.L === 1) {
        if (pos(T[other(s)].f6) >= 5) add('form411', `${side(s)} at 4-1-1 vs equal/better form → concedes a positive result`, { [winFor(other(s))]: 1, D: 1 });
        else add('form411', `${side(s)} at 4-1-1 vs weaker form → should win`, { [winFor(s)]: 1 });
      }
    }

    // R9 1-2-3 ready for a 4th loss; 2-1-3 very hard to beat (p. 70).
    for (const s of ['h', 'a']) {
      const f = T[s].f6;
      if (f.W === 1 && f.D === 2 && f.L === 3) add('form123', `${side(s)} at 1-2-3 → ready for a 4th loss`, { [winFor(other(s))]: 1 });
      if (f.W === 2 && f.D === 1 && f.L === 3) add('form213', `${side(s)} at 2-1-3 → very hard to beat`, { [winFor(s)]: 1, D: 0.5 });
    }

    // R10 Three straight losses, now back home (p. 70) → returns to success.
    if (H.last3.join('') === 'LLL' && !H.lastHome)
      add('backHome', 'Home side lost 3 in a row and returns home → bounces back', { H: 1, D: 0.5 });

    // R11 Golden sequence (pp. 59-60): results that make a 7-form 4-2-1 (any order).
    for (const o of OUT) {
      let n = 0;
      for (const s of ['h', 'a']) {
        const c = counts([...lastN(T[s].hist, 6), resFor(o, s)]);
        if (isGolden(c)) n++;
      }
      if (n) add('golden', `${lbl(o)} completes a 4-2-1 golden form for ${n === 2 ? 'both teams' : 'one team'}`, { [o]: 0.5 * n });
    }

    const ranked = OUT.slice().sort((x, y) => S[y] - S[x]);
    const pick = ranked[0];
    const total = S.H + S.D + S.A || 1;
    const margin = (S[ranked[0]] - S[ranked[1]]) / total;
    const confidence = margin >= 0.35 ? 'high' : margin >= 0.15 ? 'medium' : 'low';
    const dc = [ranked[0], ranked[1]].sort((x, y) => OUT.indexOf(x) - OUT.indexOf(y));
    const doubleChance = dc.join('') === 'HD' ? '1X' : dc.join('') === 'DA' ? 'X2' : '12';
    const tr = rules.find(r => r.id === 'trailing');
    const underdog = tr ? (p7h < p7a ? '1X' : 'X2') : null;

    return {
      scores: S, pick, pickLabel: lbl(pick), confidence, doubleChance, underdog, rules,
      forms: {
        h: { f5: fmt(H.f5), f6: fmt(H.f6), f7: fmt(H.f7), f8: fmt(H.f8), seq: lastN(H.hist, 8).join('') },
        a: { f5: fmt(A.f5), f6: fmt(A.f6), f7: fmt(A.f7), f8: fmt(A.f8), seq: lastN(A.hist, 8).join('') },
      },
    };
  }

  function lbl(o) { return o === 'H' ? '1' : o === 'D' ? 'X' : '2'; }
  function side(s) { return s === 'h' ? 'Home side' : 'Away side'; }

  // Did a market win? outcome: 'H'|'D'|'A'
  function hit(market, outcome) {
    if (market === '1') return outcome === 'H';
    if (market === 'X') return outcome === 'D';
    if (market === '2') return outcome === 'A';
    if (market === '1X') return outcome !== 'A';
    if (market === 'X2') return outcome !== 'H';
    if (market === '12') return outcome !== 'D';
    return false;
  }

  return { predict, hit, MIN_GAMES };
})();

if (typeof module !== 'undefined') module.exports = Engine;
