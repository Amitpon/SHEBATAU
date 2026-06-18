/**
 * models.js - Models section.
 *
 * Source-paper links are inline in the explainer text itself (Jiang et al. in the NGBoost
 * summary, Liang et al. in the clinical motivation banner) - no separate references list.
 */

async function loadModelsSection() {
  const container = document.getElementById('models-content');
  if (!container) return;
  container.innerHTML = '<div class="loading-text">Loading model information...</div>';

  try {
    const [meth, models] = await Promise.all([
      getJSON('/api/methodology'),
      getJSON('/api/models'),
    ]);

    const availMap = {};
    models.forEach((m) => (availMap[m.name] = m.available));

    const families = meth.families || {};
    const html = Object.entries(families).map(([key, fam]) =>
      renderModelCard(key, fam, availMap[key] !== false)
    ).join('');

    const clinicalMotivation = `
      <div class="clinical-motivation-banner">
        <span class="clinical-motivation-icon">&#128203;</span>
        <div>
          <div class="clinical-motivation-title">Clinical motivation</div>
          <div class="clinical-motivation-text">
            Grounded in <a href="/Professional Articles/ngboost/stanford.pdf" target="_blank" rel="noopener" class="ref-link">Liang et al. (2023)</a>, who demonstrated a <strong>15.4% reduction in unnecessary CBC orders</strong>
            without compromising patient safety - showing that model-driven lab cancellation is both safe and effective
            in a real clinical environment.
          </div>
        </div>
      </div>`;

    container.innerHTML = clinicalMotivation + (html || '<p style="color:var(--muted);padding:20px">No model information available.</p>');
  } catch (e) {
    container.innerHTML = `<div class="error-text">Failed to load model information: ${e.message}</div>`;
  }
}

function renderModelCard(key, fam, available) {
  // I) Title comes from API - for MAE this is "Masked Autoencoders (coming soon)"
  const availBadge = available
    ? '<span class="avail-badge avail-on">Available</span>'
    : '<span class="avail-badge avail-off">Coming soon</span>';

  const stepsHtml = fam.steps && fam.steps.length ? `
    <div class="model-steps-label">How it works - step by step</div>
    <ol class="model-steps">${fam.steps.map((s) => `<li>${s}</li>`).join('')}</ol>` : '';

  // Use advantages/limitations from API if present; otherwise use NGBoost defaults
  const advList = Array.isArray(fam.advantages) && fam.advantages.length
    ? fam.advantages
    : key === 'ngboost' ? [
        'Predicts a full probability distribution, not just a point estimate',
        'Calibrated probabilities - P(stable) reflects observed frequencies',
        'Feature importance explains each prediction to the clinician',
        'Handles skewed distributions via log-transform and Monte Carlo inversion',
        'Supports joint panel analysis via Gaussian copula on correlation matrix',
      ] : [];
  const limList = Array.isArray(fam.limitations) && fam.limitations.length
    ? fam.limitations
    : key === 'ngboost' ? [
        'Predictions are based on historical patterns - rare events may be underestimated',
        'Only as good as the features provided; missing vitals reduce accuracy',
        'Some labs have higher uncertainty (see Performance tab for per-lab metrics)',
        'Sex-specific models require the patient sex field to be present',
      ] : [];

  const framingHtml = available && fam.steps && fam.steps.length && (advList.length || limList.length) ? `
    <div class="model-framing-row">
      ${advList.length ? `<div class="model-framing-box advantage">
        <div class="framing-label">Strengths</div>
        <ul>${advList.map((a) => `<li>${a}</li>`).join('')}</ul>
      </div>` : ''}
      ${limList.length ? `<div class="model-framing-box limitation">
        <div class="framing-label">Limitations</div>
        <ul>${limList.map((l) => `<li>${l}</li>`).join('')}</ul>
      </div>` : ''}
    </div>` : '';

  return `
    <div class="model-card ${available ? '' : 'model-unavailable'}">
      <div class="model-card-header">
        <h3 class="model-title">${fam.title}</h3>
        ${availBadge}
      </div>
      <div class="model-card-body">
        <p class="model-summary">${fam.summary}</p>
        ${framingHtml}
        ${stepsHtml}
      </div>
    </div>`;
}
