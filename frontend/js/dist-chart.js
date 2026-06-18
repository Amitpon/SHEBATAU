// Draws the predicted distribution as a bell curve, mean marked and stability window
// shaded. When a 95% CI is supplied the curve is a two-piece (split) normal: a
// different spread on each side so a log-skewed prediction shows its real longer tail
// instead of a misleading symmetric bell.
function renderBell(svg, mu, sigma, windowRange, ci, prevValue) {
  const W = 220, H = 120, padX = 10, base = 100, top = 16;
  if (!sigma || sigma <= 0) sigma = Math.max(Math.abs(mu) * 0.05, 1e-6);

  // Per-side spread: from the CI when available (ci = [lo, hi] at 95% ~= 1.96 sigma),
  // otherwise fall back to a symmetric sigma.
  let sL = sigma, sR = sigma;
  if (ci && ci.length === 2) {
    sL = Math.max((mu - ci[0]) / 1.96, 1e-6);
    sR = Math.max((ci[1] - mu) / 1.96, 1e-6);
  }
  const lo = mu - 3.5 * sL, hi = mu + 3.5 * sR;
  const span = hi - lo || 1;
  const xOf = (v) => padX + ((v - lo) / span) * (W - 2 * padX);
  // Unnormalised split-normal density: 1 at the mean, continuous, asymmetric tails.
  const dens = (v) => {
    const s = v < mu ? sL : sR;
    return Math.exp(-0.5 * ((v - mu) / s) ** 2);
  };
  const yOf = (v) => base - dens(v) * (base - top);

  const pts = [];
  for (let i = 0; i <= 80; i++) {
    const v = lo + (span * i) / 80;
    pts.push(`${xOf(v).toFixed(1)},${yOf(v).toFixed(1)}`);
  }

  const parts = [];
  // shaded stability window
  if (windowRange) {
    const rawLo = Array.isArray(windowRange) ? windowRange[0] : windowRange.low;
    const rawHi = Array.isArray(windowRange) ? windowRange[1] : windowRange.high;
    const winLo = Number(rawLo);
    const winHi = Number(rawHi);
    const a = Number.isFinite(winLo) ? Math.max(xOf(winLo), padX) : null;
    const b = Number.isFinite(winHi) ? Math.min(xOf(winHi), W - padX) : null;
    if (a != null && b != null && b > a) parts.push(`<rect x="${a.toFixed(1)}" y="${top}" width="${(b - a).toFixed(1)}" height="${base - top}" fill="#00a39a" opacity="0.12"/>`);
  }
  parts.push(`<line x1="${padX}" y1="${base}" x2="${W - padX}" y2="${base}" stroke="#c9ccd6"/>`);
  parts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="#232a86" stroke-width="2"/>`);
  // mean line
  const xm = xOf(mu);
  parts.push(`<line x1="${xm.toFixed(1)}" y1="${top}" x2="${xm.toFixed(1)}" y2="${base}" stroke="#444" stroke-dasharray="3 3"/>`);
  parts.push(`<text x="${xm.toFixed(1)}" y="${base + 14}" text-anchor="middle" font-size="11" fill="#444">&#956;</text>`);
  // 95% CI ticks (show the asymmetry honestly)
  if (ci && ci.length === 2) {
    [ci[0], ci[1]].forEach((cv) => {
      const x = xOf(cv);
      parts.push(`<line x1="${x.toFixed(1)}" y1="${base - 6}" x2="${x.toFixed(1)}" y2="${base + 4}" stroke="#888"/>`);
    });
    parts.push(`<text x="${((xm + xOf(ci[1])) / 2).toFixed(1)}" y="${(top + base) / 2 - 4}" text-anchor="middle" font-size="10" fill="#888">95% CI</text>`);
  }
  // Previous test result marker - where the patient's last value sat, for visual
  // comparison against where we now predict the next value to land.
  if (Number.isFinite(prevValue)) {
    const xp = Math.min(Math.max(xOf(prevValue), padX), W - padX);
    parts.push(`<line x1="${xp.toFixed(1)}" y1="${top}" x2="${xp.toFixed(1)}" y2="${base}" stroke="#d97706" stroke-width="1.5" stroke-dasharray="2 2"/>`);
    parts.push(`<circle cx="${xp.toFixed(1)}" cy="${base}" r="3" fill="#d97706"/>`);
    parts.push(`<text x="${xp.toFixed(1)}" y="${top - 4}" text-anchor="middle" font-size="9" fill="#d97706">prev</text>`);
  }

  svg.innerHTML = parts.join('');
}

// Compact inline marker for the COLLAPSED clinical card: previous value (dot) and
// predicted value (diamond) on one line, with the 95% range as a thin bar between them.
// Lets a doctor see "where we expect this to land vs where it was" without opening the
// card - the full bell curve stays in the expanded detail.
function renderMiniRangeSvg(prevValue, predValue, ciLo, ciHi) {
  const W = 64, H = 16, padX = 4, midY = H / 2;
  const vals = [prevValue, predValue, ciLo, ciHi].filter(Number.isFinite);
  if (!vals.length) return '';
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.15;
  lo -= pad; hi += pad;
  const xOf = (v) => padX + ((v - lo) / (hi - lo)) * (W - 2 * padX);

  const parts = [`<line x1="${padX}" y1="${midY}" x2="${W - padX}" y2="${midY}" stroke="#c9ccd6" stroke-width="1"/>`];
  if (Number.isFinite(ciLo) && Number.isFinite(ciHi)) {
    const a = xOf(ciLo), b = xOf(ciHi);
    parts.push(`<rect x="${a.toFixed(1)}" y="${(midY - 2).toFixed(1)}" width="${(b - a).toFixed(1)}" height="4" rx="2" fill="#232a86" opacity="0.25"/>`);
  }
  if (Number.isFinite(prevValue)) {
    parts.push(`<circle cx="${xOf(prevValue).toFixed(1)}" cy="${midY}" r="2.5" fill="#d97706"/>`);
  }
  if (Number.isFinite(predValue)) {
    const x = xOf(predValue);
    parts.push(`<polygon points="${x.toFixed(1)},${(midY - 4).toFixed(1)} ${(x + 3).toFixed(1)},${midY.toFixed(1)} ${x.toFixed(1)},${(midY + 4).toFixed(1)} ${(x - 3).toFixed(1)},${midY.toFixed(1)}" fill="#232a86"/>`);
  }
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${parts.join('')}</svg>`;
}

// Mini trend sparkline for the collapsed card (item 3): first-in-admission value ->
// most recent result -> predicted value. Only 3 points because that is all the data we
// actually have per lab per admission (no intermediate history is stored) - the
// predicted point is drawn dashed/lighter to mark it as a projection, not a measurement.
function renderSparklineSvg(firstVal, prevVal, predVal) {
  const W = 44, H = 16, padX = 3, padY = 3;
  const pts = [firstVal, prevVal, predVal];
  const known = pts.filter(Number.isFinite);
  if (known.length < 2) return '';
  let lo = Math.min(...known), hi = Math.max(...known);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const xs = pts.map((_, i) => padX + (i / (pts.length - 1)) * (W - 2 * padX));
  const yOf = (v) => Number.isFinite(v) ? (H - padY) - ((v - lo) / (hi - lo)) * (H - 2 * padY) : null;
  const ys = pts.map(yOf);

  const parts = [];
  for (let i = 0; i < pts.length - 1; i++) {
    if (ys[i] == null || ys[i + 1] == null) continue;
    const dashed = (i === pts.length - 2) ? ' stroke-dasharray="2 2"' : '';
    parts.push(`<line x1="${xs[i].toFixed(1)}" y1="${ys[i].toFixed(1)}" x2="${xs[i + 1].toFixed(1)}" y2="${ys[i + 1].toFixed(1)}" stroke="#6b7280" stroke-width="1.3"${dashed}/>`);
  }
  pts.forEach((v, i) => {
    if (ys[i] == null) return;
    const isPred = i === pts.length - 1;
    parts.push(`<circle cx="${xs[i].toFixed(1)}" cy="${ys[i].toFixed(1)}" r="${isPred ? 2 : 1.6}" fill="${isPred ? '#232a86' : '#6b7280'}"/>`);
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" title="Trend: admission start -> most recent -> predicted">${parts.join('')}</svg>`;
}
