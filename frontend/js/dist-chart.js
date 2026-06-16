// Draws the predicted distribution as a bell curve, mean marked and stability window
// shaded. When a 95% CI is supplied the curve is a two-piece (split) normal: a
// different spread on each side so a log-skewed prediction shows its real longer tail
// instead of a misleading symmetric bell.
function renderBell(svg, mu, sigma, windowRange, ci) {
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

  svg.innerHTML = parts.join('');
}
