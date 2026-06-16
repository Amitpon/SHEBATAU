// Semicircular P(stable) gauge with a red needle and a threshold tick.
function renderGauge(svg, pStable, threshold) {
  const cx = 70, cy = 78, r = 56;
  const ang = (t) => Math.PI - t * Math.PI; // t in [0,1] -> 180°..0°
  const pt = (t, rad) => [cx + rad * Math.cos(ang(t)), cy - rad * Math.sin(ang(t))];

  const arc = (t0, t1, color, width) => {
    const [x0, y0] = pt(t0, r), [x1, y1] = pt(t1, r);
    const large = (t1 - t0) > 0.5 ? 1 : 0;
    return `<path d="M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>`;
  };

  const p = Math.max(0, Math.min(1, pStable));
  // Color: green when above threshold (stable = safe to skip), red when below
  const fillColor = (threshold != null && p >= threshold) ? '#16a34a' : '#dc2626';
  const parts = [];
  parts.push(arc(0, 1, '#e5e7eb', 10));                       // track
  if (p > 0.001) parts.push(arc(0, p, fillColor, 10));        // filled arc

  // threshold tick
  if (threshold != null) {
    const [tx0, ty0] = pt(threshold, r - 8), [tx1, ty1] = pt(threshold, r + 6);
    parts.push(`<line x1="${tx0.toFixed(1)}" y1="${ty0.toFixed(1)}" x2="${tx1.toFixed(1)}" y2="${ty1.toFixed(1)}" stroke="#232a86" stroke-width="2.5"/>`);
  }

  // needle
  const [nx, ny] = pt(p, r - 12);
  parts.push(`<line x1="${cx}" y1="${cy}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" stroke="${fillColor}" stroke-width="4" stroke-linecap="round"/>`);
  parts.push(`<circle cx="${cx}" cy="${cy}" r="5" fill="#374151"/>`);

  svg.innerHTML = parts.join('');
}
