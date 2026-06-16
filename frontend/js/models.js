/**
 * models.js - Models section.
 *
 * References: structured refs come from models/<family>/REFERENCES.md via /api/references.
 * PDFs in Professional Articles/<family>/ are listed per model card (except stanford.pdf
 * which is shown in the General References section below all model cards).
 */

// Per-filename custom descriptions for known PDFs
const PDF_DESCRIPTIONS = {
  'labstabilityprediction.pdf': 'Foundation paper that inspired the NGBoost - Probabilistic Gradient Boosting implementation.',
  'stanford.pdf': null, // rendered in General References section instead
};

let _cachedRefs = null;

async function loadModelsSection() {
  const container = document.getElementById('models-content');
  if (!container) return;
  container.innerHTML = '<div class="loading-text">Loading model information...</div>';

  try {
    const [meth, models, refs] = await Promise.all([
      getJSON('/api/methodology'),
      getJSON('/api/models'),
      _cachedRefs || getJSON('/api/references').then((r) => { _cachedRefs = r; return r; }),
    ]);

    const availMap = {};
    models.forEach((m) => (availMap[m.name] = m.available));

    const families = meth.families || {};
    const html = Object.entries(families).map(([key, fam]) =>
      renderModelCard(key, fam, availMap[key] !== false, refs[key] || [])
    ).join('');

    const clinicalMotivation = `
      <div class="clinical-motivation-banner">
        <span class="clinical-motivation-icon">&#128203;</span>
        <div>
          <div class="clinical-motivation-title">Clinical motivation</div>
          <div class="clinical-motivation-text">
            Grounded in Liang et al. (2023), who demonstrated a <strong>15.4% reduction in unnecessary CBC orders</strong>
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

function renderModelCard(key, fam, available, structuredRefs) {
  // I) Title comes from API - for MAE this is "Masked Autoencoders (coming soon)"
  const availBadge = available
    ? '<span class="avail-badge avail-on">Available</span>'
    : '<span class="avail-badge avail-off">Coming soon</span>';

  const stepsHtml = fam.steps && fam.steps.length ? `
    <div class="model-steps-label">How it works - step by step</div>
    <ol class="model-steps">${fam.steps.map((s) => `<li>${s}</li>`).join('')}</ol>` : '';

  const hasStructured = Array.isArray(structuredRefs) && structuredRefs.length > 0;
  const pdfFiles = Array.isArray(fam.reference_files) ? fam.reference_files.filter(Boolean) : [];

  // Build a combined references list: structured refs + PDFs together
  let refsHtml = '';
  const combinedRefs = [];

  // Add structured references
  if (hasStructured) {
    structuredRefs.forEach((r) => {
      const link = r.links && r.links[0];
      const titleHtml = link
        ? `<a href="${link.url}" target="_blank" rel="noopener" class="ref-link">${r.title}</a>`
        : `<span class="ref-link">${r.title}</span>`;
      const meta = [r.authors, r.journal].filter(Boolean).join(' - ');
      const metaHtml = meta ? `<span class="ref-meta">${meta}</span>` : '';
      combinedRefs.push(`<li>${titleHtml}${metaHtml}</li>`);
    });
  }

  // Add PDF files as references - skip files handled globally (e.g. stanford.pdf)
  if (pdfFiles.length) {
    pdfFiles.forEach((f) => {
      if (f in PDF_DESCRIPTIONS && PDF_DESCRIPTIONS[f] === null) return; // shown in general section
      const humanName = f.replace(/\.pdf$/i, '').replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      const pdfUrl = '/Professional Articles/' + encodeURIComponent(key) + '/' + encodeURIComponent(f);
      const desc = PDF_DESCRIPTIONS[f] || `Foundation paper that inspired the ${fam.title || key} implementation.`;
      combinedRefs.push(`<li>
        <a href="${pdfUrl}" target="_blank" rel="noopener" class="ref-link">${humanName}</a>
        <span class="ref-pdf-badge">PDF</span>
        <span class="ref-meta">${desc}</span>
      </li>`);
    });
  }

  // References hidden for now (re-enable by restoring the refsHtml assignment below)
  // if (combinedRefs.length) { refsHtml = `...`; }

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
        ${refsHtml}
      </div>
    </div>`;
}

function _renderGeneralRefs(families) {
  // Collect PDFs marked for the general section (PDF_DESCRIPTIONS[f] === null)
  const generalItems = [];

  // stanford.pdf - motivation paper showing clinical feasibility
  const ngboostFam = families['ngboost'];
  const pdfFiles = Array.isArray(ngboostFam && ngboostFam.reference_files)
    ? ngboostFam.reference_files
    : [];
  if (pdfFiles.includes('stanford.pdf')) {
    const url = '/Professional Articles/ngboost/stanford.pdf';
    generalItems.push(`<li>
      <a href="${url}" target="_blank" rel="noopener" class="ref-link">Stanford - SmartAlert RCT (Liang et al. 2023)</a>
      <span class="ref-pdf-badge">PDF</span>
      <span class="ref-meta">Foundation paper that motivated the research - showed that ML-based lab prediction can be clinically implemented with a 15.4% reduction in unnecessary tests (JAMA Internal Medicine, 2023).</span>
    </li>`);
  }

  if (!generalItems.length) return '';

  return `
    <div class="model-card general-refs-card" style="margin-top:16px">
      <div class="model-card-header">
        <h3 class="model-title">General References</h3>
        <span class="avail-badge avail-on">Background</span>
      </div>
      <div class="model-card-body">
        <p class="model-summary">Papers that inspired the overall research direction - not tied to a specific model implementation.</p>
        <div class="model-refs-label">References and source papers</div>
        <ul class="model-refs structured-refs">${generalItems.join('')}</ul>
      </div>
    </div>`;
}
