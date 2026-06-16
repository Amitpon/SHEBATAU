/**
 * charts.js - Reusable hand-rolled SVG chart helpers.
 * Same idiom as gauge.js and dist-chart.js - no libraries, no CDN.
 *
 * Color conventions (match CSS vars):
 *   teal  (#00a39a) - positive / good
 *   red   (#dc2626) - negative / warn
 *   navy  (#232a86) - primary data series
 *   grey  (#9ca3af) - baseline / secondary
 */

/**
 * Horizontal bar chart.
 * items: [{label, value, color?}]
 *   value range: [0..maxAbs] (importances) or [-1..1] (correlations with showSign)
 */
function renderHBar(svg, items, opts = {}) {
  if (!items || !items.length) return;
  const {
    maxAbs   = 100,
    showSign = false,
    barH     = 20,
    gap      = 5,
    labelW   = 130,
    pctW     = 50,
    padX     = 12,
    padTop   = 6,
  } = opts;

  const svgW = (svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.width > 0)
    ? svg.viewBox.baseVal.width : 360;
  const trackW = svgW - labelW - pctW - padX * 2;
  const rowH = barH + gap;
  const totalH = items.length * rowH + padTop * 2 + 4;

  svg.setAttribute('viewBox', `0 0 ${svgW} ${totalH}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', totalH);

  const parts = [];

  // Optional center line for signed bars
  if (showSign) {
    const cx = padX + labelW + trackW / 2;
    parts.push(`<line x1="${cx.toFixed(1)}" y1="${padTop}" x2="${cx.toFixed(1)}" y2="${totalH - padTop}" stroke="#e5e7eb" stroke-width="1"/>`);
  }

  items.forEach((item, i) => {
    const y = padTop + i * rowH;
    const absVal = Math.min(Math.abs(item.value), maxAbs);
    const frac = absVal / maxAbs;

    let color, barX, barW;
    if (showSign) {
      // Diverging: center at midpoint of track
      color = item.value >= 0 ? '#00a39a' : '#dc2626';
      const half = trackW / 2;
      const fill = frac * half;
      if (item.value >= 0) {
        barX = padX + labelW + half;
        barW = fill;
      } else {
        barX = padX + labelW + half - fill;
        barW = fill;
      }
    } else {
      color = item.color || '#232a86';
      barX = padX + labelW;
      barW = frac * trackW;
    }

    // Label (truncate if needed)
    const lbl = item.label.length > 18 ? item.label.slice(0, 17) + '…' : item.label;
    parts.push(`<text x="${padX}" y="${y + barH - 5}" font-size="11" fill="#374151" font-family="ui-monospace,Menlo,Consolas,monospace">${lbl}</text>`);

    // Track background
    parts.push(`<rect x="${padX + labelW}" y="${y}" width="${trackW}" height="${barH}" rx="3" fill="#f3f4f6"/>`);

    // Filled bar
    if (barW > 0.5) {
      parts.push(`<rect x="${barX.toFixed(1)}" y="${y}" width="${barW.toFixed(1)}" height="${barH}" rx="3" fill="${color}" opacity="0.88"/>`);
    }

    // Value label - use item.color for percentage labels when not signed
    const valText = showSign
      ? (item.value >= 0 ? '+' : '') + item.value.toFixed(3)
      : item.value.toFixed(1) + '%';
    const valColor = showSign ? (item.value >= 0 ? '#007a73' : '#b91c1c') : (item.color || '#232a86');
    parts.push(`<text x="${padX + labelW + trackW + 4}" y="${y + barH - 5}" font-size="11" fill="${valColor}" font-weight="700">${valText}</text>`);
  });

  svg.innerHTML = parts.join('');
}

/**
 * Dual bar comparison (e.g. Brier baseline vs model).
 * bars: [{label, value, color}]
 */
function renderDualBar(svg, bars, opts = {}) {
  if (!bars || !bars.length) return;
  const {
    maxVal  = 0.5,
    barH    = 26,
    gap     = 10,
    labelW  = 140,
    valW    = 56,
    padX    = 12,
    padTop  = 8,
  } = opts;

  const svgW = (svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.width > 0)
    ? svg.viewBox.baseVal.width : 360;
  const trackW = svgW - labelW - valW - padX * 2;
  const rowH = barH + gap;
  const totalH = bars.length * rowH + padTop * 2 + 20;

  svg.setAttribute('viewBox', `0 0 ${svgW} ${totalH}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', totalH);

  // Light gridlines
  const nGrid = 4;
  const parts = [];
  for (let g = 0; g <= nGrid; g++) {
    const gx = padX + labelW + (g / nGrid) * trackW;
    const gval = ((g / nGrid) * maxVal).toFixed(2);
    parts.push(`<line x1="${gx.toFixed(1)}" y1="${padTop}" x2="${gx.toFixed(1)}" y2="${totalH - 20}" stroke="#e5e7eb" stroke-width="1"/>`);
    parts.push(`<text x="${gx.toFixed(1)}" y="${totalH - 6}" text-anchor="middle" font-size="9" fill="#9ca3af">${gval}</text>`);
  }

  bars.forEach((bar, i) => {
    const y = padTop + i * rowH;
    const frac = Math.min(bar.value / maxVal, 1);
    const fillW = frac * trackW;

    parts.push(`<text x="${padX}" y="${y + barH - 7}" font-size="12" fill="#374151" font-weight="600">${bar.label}</text>`);
    parts.push(`<rect x="${padX + labelW}" y="${y}" width="${trackW}" height="${barH}" rx="4" fill="#f3f4f6"/>`);
    if (fillW > 0.5) {
      parts.push(`<rect x="${padX + labelW}" y="${y}" width="${fillW.toFixed(1)}" height="${barH}" rx="4" fill="${bar.color}" opacity="0.9"/>`);
    }
    parts.push(`<text x="${padX + labelW + trackW + 5}" y="${y + barH - 7}" font-size="12" fill="${bar.color}" font-weight="700">${bar.value.toFixed(4)}</text>`);
  });

  svg.innerHTML = parts.join('');
}

/**
 * Joint-probability arc gauge (smaller version of gauge.js, for profile results).
 */
function renderJointGauge(svg, pJoint, threshold) {
  const cx = 80, cy = 72, r = 56;
  const ang = (t) => Math.PI - t * Math.PI;
  const pt  = (t, rad) => [cx + rad * Math.cos(ang(t)), cy - rad * Math.sin(ang(t))];

  const arc = (t0, t1, color, w) => {
    const [x0, y0] = pt(t0, r), [x1, y1] = pt(t1, r);
    const large = (t1 - t0) > 0.5 ? 1 : 0;
    return `<path d="M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>`;
  };

  const p = Math.max(0, Math.min(1, pJoint));
  const fillColor = p >= threshold ? '#16a34a' : '#dc2626';
  const parts = [];

  parts.push(arc(0, 1, '#e5e7eb', 10));
  if (p > 0.001) parts.push(arc(0, p, fillColor, 10));

  // Threshold tick
  const [tx0, ty0] = pt(threshold, r - 9);
  const [tx1, ty1] = pt(threshold, r + 7);
  parts.push(`<line x1="${tx0.toFixed(1)}" y1="${ty0.toFixed(1)}" x2="${tx1.toFixed(1)}" y2="${ty1.toFixed(1)}" stroke="#232a86" stroke-width="2.5"/>`);

  // Needle
  const [nx, ny] = pt(p, r - 16);
  parts.push(`<line x1="${cx}" y1="${cy}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" stroke="${fillColor}" stroke-width="4" stroke-linecap="round"/>`);
  parts.push(`<circle cx="${cx}" cy="${cy}" r="5" fill="#374151"/>`);

  // Labels
  parts.push(`<text x="${cx}" y="${cy + 17}" text-anchor="middle" font-size="14" font-weight="900" fill="${fillColor}">${(p * 100).toFixed(1)}%</text>`);
  parts.push(`<text x="5" y="${cy + 4}" font-size="9" fill="#9ca3af">0%</text>`);
  parts.push(`<text x="${cx * 2 - 22}" y="${cy + 4}" font-size="9" fill="#9ca3af">100%</text>`);

  svg.innerHTML = parts.join('');
}

/**
 * Inline mini reliability bar (returns SVG string for innerHTML injection).
 */
function miniReliabilityBar(level) {
  const colors  = { high: '#16a34a', moderate: '#d97706', low: '#dc2626' };
  const widths  = { high: 100, moderate: 62, low: 32 };
  const c = colors[level] || '#9ca3af';
  const w = (widths[level] || 45) * 0.72;
  return `<svg width="80" height="10" viewBox="0 0 80 10" aria-hidden="true">
    <rect x="0" y="1" width="80" height="8" rx="3" fill="#e5e7eb"/>
    <rect x="0" y="1" width="${w}" height="8" rx="3" fill="${c}"/>
  </svg>`;
}
