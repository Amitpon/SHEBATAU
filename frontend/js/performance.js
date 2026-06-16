/**
 * performance.js - Performance section.
 *
 * Tabs: Leaderboard | Per-lab detail | Panel browser | No model
 *
 * A) Leaderboard: two clearly SEPARATED column groups.
 *    "Value prediction" (teal) leads with value_score badge, then SMAPE/NRMSE/MAE.
 *    "Skip/repeat decision" (navy) leads with calibration_score badge, then ECE/MCE/BSS%.
 *    Sortable by either score or raw metric. Default: value_score desc.
 *    Color-band rows by combined trust (green/amber/red left edge).
 *
 * B) Threshold sensitivity chart: X=saved%, Y=FNR%, BOTH fixed 0-100.
 *    Line only through anomaly===false points, hollow marker for anomaly===true.
 *    Footnote listing excluded anomaly thresholds with asterisk.
 *
 * C) Panel browser correlations: 2 decimal places, null -> "-", avg_abs_r + homogeneity
 *    sentence. "Build custom profile" control posts to /api/profile/correlations.
 *
 * D) No model section: labs excluded by the >=100 test-records gate.
 */

const _perfCache   = {};
let   _leaderboard = [];
let   _coverageMap = {};  // {lab: {ngboost: bool, mae: bool}}
// Default sort: value_score descending
let   _leaderSort  = { key: 'value_score', asc: false };
let   _activeTab   = 'leaderboard';
// Performance results are scoped per model. Only ngboost has artifacts today; the
// rest appear as disabled options so the section is ready for a second model.
let   _activeModel = 'ngboost';
const MODEL_LABELS = { ngboost: 'NGBoost', mae: 'Masked Autoencoders' };

// Tooltip glossary - plain one-sentence descriptions
const GLOSSARY = {
  value_score:        'Overall 0-100 score for how accurately the model predicts the numeric result - higher is better.',
  calibration_score:  'Overall 0-100 score for how trustworthy the stated stable/repeat probability is - higher is better.',
  smape:  'Typical percent error of the predicted value - under 10% is tight, over 30% is noisy.',
  nrmse:  'RMSE as a percent of the typical value - comparable across different tests.',
  mae:    'Average prediction miss in the lab\'s own units - lower is better.',
  ece:    'Average gap between the probability we state and what actually happens - lower is better.',
  mce:    'Worst calibration gap in any confidence range - lower is better.',
  bss:    'How much better our probability is than a naive baseline - higher is better.',
  roc:    'How well the model separates stable from unstable cases. (Threshold-dependent)',
  saved:  'Share of repeat tests the model would skip. (Threshold-dependent)',
};

const SUMMARY_CHARTS = [
  { key: 'ece',         label: 'ECE Distribution',       file: 'summary_ece.png' },
  { key: 'threshold',   label: 'Threshold Sweep',         file: 'summary_threshold_sweep.png' },
  { key: 'efficiency',  label: 'Efficiency vs Safety',   file: 'summary_efficiency_safety.png' },
  { key: 'roc',         label: 'ROC AUC',                file: 'summary_roc_auc.png' },
  { key: 'instability', label: 'Instability vs Metrics', file: 'summary_instability_vs_metrics.png' },
];

function _summaryChartUrl(chart) {
  const base = _activeModel === 'mae' ? '/mae_summary_charts' : '/summary_charts';
  return `${base}/${chart.file}`;
}

// ── Confidence band helpers (canonical modelQuality in app.js: >=90 excellent,
// >=75 very good, >=60 reasonable, <=59 poor) ──
function _perfScoreColor(score) {
  if (score == null) return '#9ca3af';
  return modelQuality(score).color;
}
function _perfScoreBandLabel(score) {
  if (score == null) return 'Unknown';
  const lbl = modelQuality(score).label;
  return lbl.charAt(0).toUpperCase() + lbl.slice(1);
}

// ── Scoring override helpers ──────────────────────────────────────────────────
// _applyScoring is defined in settings.js and exposed on window._applyScoring.
// We call it through the window reference so performance.js works even if
// settings.js hasn't loaded yet (graceful fallback = identity function).
function _applyScoringLocal(perf) {
  if (typeof window._applyScoring === 'function') return window._applyScoring(perf);
  return perf;
}

// Re-render leaderboard + sort row after the user applies new scoring weights.
// Exposed on window so settings.js can call it without circular dependency.
function _refreshLeaderboardScores() {
  const sortRowEl = document.getElementById('perfSortRow');
  const leaderEl  = document.getElementById('perfLeaderBody');
  if (sortRowEl) _renderSortRow(sortRowEl);
  if (leaderEl)  _renderLeaderboard(leaderEl);
}
window._refreshLeaderboardScores = _refreshLeaderboardScores;

// ── Entry point ───────────────────────────────────────────────────────────────
async function initPerformanceSection() {
  const container = document.getElementById('performance-content');
  if (!container) return;
  container.innerHTML = '<div class="loading-text">Loading...</div>';
  _topCustomProfileInit = false;  // Reset on section reload

  try {
    const [allPerf, labs, panels, models, coverage] = await Promise.all([
      getJSON(`/api/performance?model=${_activeModel}`),
      getJSON('/api/labs'),
      getJSON('/api/panels'),
      getJSON('/api/models').catch(() => [{ name: 'ngboost', available: true }]),
      getJSON('/api/lab_model_coverage').catch(() => ({})),
    ]);
    _leaderboard = allPerf;
    _coverageMap = coverage;
    _renderPerfShell(container, labs, panels, models);
  } catch (e) {
    container.innerHTML = `<div class="error-text">Failed to initialize: ${e.message}</div>`;
  }
}

// ── Shell layout ──────────────────────────────────────────────────────────────
// Per-model coverage for a lab (from the catalog row, via global state.labMap).
function _perfCov(lab) {
  return (typeof state !== 'undefined' && state.labMap && state.labMap[lab] && state.labMap[lab].coverage) || null;
}
// Colored asterisk marker for single-model labs (green = MAE only, navy = NGBoost only).
function _perfCovStar(lab) {
  const c = _perfCov(lab);
  if (!c) return '';
  if (c.mae && !c.ngboost) return '<span class="mae-only-star" title="MAE only - no NGBoost model">&lowast;</span>';
  if (c.ngboost && !c.mae) return '<span class="ngb-only-star" title="NGBoost only - no MAE model (or too few records)">&lowast;</span>';
  return '';
}
// Plain-text coverage tag for <option> elements (cannot be colored).
function _perfCovOptText(l) {
  const c = l.coverage;
  if (c && c.mae && !c.ngboost) return ' (MAE only)';
  if (c && c.ngboost && !c.mae) return ' (NGBoost only)';
  return '';
}

function _renderPerfShell(container, labs, panels, models) {
  const labOptions = labs.map((l) =>
    `<option value="${l.lab}">${l.lab}${l.sex_specific ? ' *' : ''}${_perfCovOptText(l)}</option>`).join('');

  const modelList = (models && models.length) ? models : [{ name: 'ngboost', available: true }];
  const modelTabs = modelList.map((m) => {
    const label = MODEL_LABELS[m.name] || m.name;
    const on = m.name === _activeModel;
    return `<button class="perf-model-tab${on ? ' active' : ''}" data-model="${m.name}">
      ${label}
    </button>`;
  }).join('');

  container.innerHTML = `
    <!-- Model scope: all results below are for the selected model -->
    <div class="perf-model-bar">
      <span class="perf-model-bar-label">Model</span>
      <div class="perf-model-tabs">${modelTabs}</div>
      <span class="perf-model-scope">Showing results for <strong>${MODEL_LABELS[_activeModel] || _activeModel}</strong></span>
    </div>


    <!-- Summary charts gallery at top (collapsible, model-specific when available) -->
    ${['ngboost', 'mae'].includes(_activeModel) ? `
    <div class="perf-summary-gallery" id="perfSummaryGallery">
      <div class="perf-summary-title">
        <span>Overview charts</span>
        <button class="perf-summary-toggle" id="perfSumToggle" aria-expanded="false">Show</button>
      </div>
      <div class="perf-summary-collapse collapsed" id="perfSumCollapse">
      <div class="perf-summary-tabs" id="perfSumTabs">
        ${SUMMARY_CHARTS.map((c, i) =>
          `<button class="perf-sum-tab${i === 0 ? ' active' : ''}" data-key="${c.key}">${c.label}</button>`
        ).join('')}
      </div>
      <div class="perf-summary-img-wrap">
        <img id="perfSumImg" src="${_summaryChartUrl(SUMMARY_CHARTS[0])}" alt="${SUMMARY_CHARTS[0].label}" loading="lazy" />
      </div>
      </div>
    </div>` : ''}

    <!-- Sub-navigation -->
    <div class="perf-nav-tabs">
      <button class="perf-nav-tab active" data-tab="leaderboard">Leaderboard</button>
      <button class="perf-nav-tab" data-tab="detail">Per-lab detail</button>
      <button class="perf-nav-tab" data-tab="compare">Model comparison</button>
      <button class="perf-nav-tab" data-tab="panel">Panel browser</button>
      <button class="perf-nav-tab" data-tab="insufficient">No model</button>
      <button class="perf-nav-tab" data-tab="about">About metrics</button>
    </div>

    <!-- Tab panels -->
    <div class="perf-tab-panel active" id="perf-tab-leaderboard">

      <!-- Value vs Calibration scatter: companion to the leaderboard -->
      <details class="scatter-widget-details" id="scatterWidgetDetails">
        <summary class="scatter-widget-summary">
          Value vs Calibration scatter
          <span class="scatter-widget-hint">Click a dot to star it - starred labs stay highlighted</span>
        </summary>
        <div class="scatter-widget-body" id="scatterWidgetBody"></div>
      </details>

      <div class="perf-card" id="perfLeaderCard">
        <div class="perf-card-header">
          <span class="perf-card-title">All-lab comparison</span>
          <span class="perf-card-sub">
            Labs with a high calibration score (BSS) often also have a high value score.
            Green rows are the ones we trust most - they are both accurate and well-calibrated.
            Click any row to view the full detail for that lab.
          </span>
        </div>
        <div class="perf-sort-row" id="perfSortRow"></div>
        <div id="perfLeaderBody" class="perf-leader-body"></div>
      </div>
      <div id="insufficientTeaser"></div>
    </div>

    <div class="perf-tab-panel" id="perf-tab-detail">
      <div class="perf-card" id="perfDetailCard">
        <div class="perf-card-header">
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
            <span class="perf-card-title">Per-lab detail</span>
            <select id="perfLabSelect" class="perf-lab-select">
              <option value="">-- select a lab --</option>
              ${labOptions}
            </select>
            <span class="sex-note">* sex-specific model</span>
          </div>
        </div>
        <div id="perfLabContent" style="padding:var(--sp-4)">
          <div class="perf-empty">Select a lab above to view detailed metrics, calibration, and correlations.</div>
        </div>
      </div>
    </div>

    <div class="perf-tab-panel" id="perf-tab-compare">

      <!-- Global cross-model comparison: every lab, both models, at a glance -->
      <div class="perf-card" id="perfCrossModelCard" style="margin-bottom:var(--sp-4)">
        <div class="perf-card-header">
          <span class="perf-card-title">All labs: NGBoost vs Masked AE</span>
          <span class="perf-card-sub">
            Each dot is one lab. Up-and-right = we predict it well with <strong>both</strong> models.
            Dots near the diagonal behave the same in both; dots far from it are a model's strength or weakness.
          </span>
        </div>
        <div class="xmodel-controls" id="xmodelControls"></div>
        <div class="xmodel-body" id="xmodelBody"><div class="loading-text">Loading cross-model comparison...</div></div>
      </div>

      <div class="perf-card">
        <div class="perf-card-header">
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
            <span class="perf-card-title">NGBoost vs MAE - per-lab comparison</span>
            <select id="perfCompareLabSelect" class="perf-lab-select">
              <option value="">-- select a lab --</option>
              ${labOptions}
            </select>
          </div>
        </div>
        <div id="perfCompareContent" style="padding:var(--sp-4)">
          <div class="perf-empty">Select a lab above to compare both models side by side.</div>
        </div>
      </div>
    </div>

    <div class="perf-tab-panel" id="perf-tab-panel">
      <!-- Custom profile builder always visible at the top -->
      <div class="perf-card" style="margin-bottom:var(--sp-4)">
        <div class="perf-card-header">
          <span class="perf-card-title">Build a custom profile</span>
          <span class="perf-card-sub">Pick any combination of labs to explore their correlations and see how homogeneous that group is.</span>
        </div>
        <div style="padding:var(--sp-4)">
          <div class="custom-profile-block" id="customProfileBlockTop">
            <div class="custom-profile-select-wrap" id="customProfileSelectWrapTop">
              <div id="customProfileChipsTop" class="custom-profile-chips"></div>
              <div class="custom-profile-add-row">
                <select id="customProfileLabSelectTop" class="perf-lab-select" style="min-width:140px">
                  <option value="">Add lab...</option>
                </select>
                <button class="btn-run-custom" id="btnRunCustomProfileTop">Compute correlations</button>
                <button class="btn-clear-custom" id="btnClearCustomProfileTop">Clear</button>
              </div>
            </div>
            <div id="customProfileResultTop" style="margin-top:var(--sp-3)"></div>
          </div>
        </div>
      </div>

      <div class="perf-layout">
        <div id="perfPanelMain">
          <div class="perf-empty">Select a panel from the right to browse its labs.</div>
        </div>
        <div class="perf-sidebar">
          <div class="perf-sidebar-header"><div class="perf-sidebar-title">Panel browser</div></div>
          <div class="perf-sidebar-body">
            <div class="perf-panel-btns" id="perfPanelBtns">
              ${Object.keys(panels).map((p) => `<button class="perf-panel-btn" data-panel="${p}">${p}</button>`).join('')}
            </div>
            <div id="perfPanelContent"><div class="perf-empty">Select a panel to browse its labs.</div></div>
          </div>
        </div>
      </div>
    </div>

    <div class="perf-tab-panel" id="perf-tab-insufficient">
      <div id="perfInsufficientContent"></div>
    </div>

    <div class="perf-tab-panel" id="perf-tab-about">
      <div id="perfAboutContent">
        <div class="loading-text">Loading metric examples...</div>
      </div>
    </div>
  `;

  // Collapsible overview gallery
  const sumToggle = document.getElementById('perfSumToggle');
  const sumCollapse = document.getElementById('perfSumCollapse');
  if (sumToggle && sumCollapse) {
    sumToggle.addEventListener('click', () => {
      const hidden = sumCollapse.classList.toggle('collapsed');
      sumToggle.textContent = hidden ? 'Show' : 'Hide';
      sumToggle.setAttribute('aria-expanded', String(!hidden));
    });
  }

  // Model scope tabs (only available models are clickable; ngboost today)
  container.querySelectorAll('.perf-model-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      if (tab.dataset.model === _activeModel) return;
      _activeModel = tab.dataset.model;
      initPerformanceSection();  // reload all results for the chosen model
    });
  });

  // Summary chart tabs
  container.querySelectorAll('.perf-sum-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      container.querySelectorAll('.perf-sum-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const chart = SUMMARY_CHARTS.find((c) => c.key === tab.dataset.key);
      if (chart) {
        const imgWrap = document.querySelector('.perf-summary-img-wrap');
        if (imgWrap) imgWrap.innerHTML = `<img id="perfSumImg" src="${_summaryChartUrl(chart)}" alt="${chart.label}" loading="lazy" />`;
      }
    });
  });

  // Section nav tabs
  container.querySelectorAll('.perf-nav-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      container.querySelectorAll('.perf-nav-tab').forEach((t) => t.classList.remove('active'));
      container.querySelectorAll('.perf-tab-panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`perf-tab-${tab.dataset.tab}`).classList.add('active');
      _activeTab = tab.dataset.tab;
      if (tab.dataset.tab === 'insufficient') _renderInsufficient();
      if (tab.dataset.tab === 'about') _renderAboutMetrics();
      if (tab.dataset.tab === 'compare') _initCompareTab();
      if (tab.dataset.tab === 'panel') _initTopCustomProfile();
    });
  });

  _renderSortRow(document.getElementById('perfSortRow'));
  _renderLeaderboard(document.getElementById('perfLeaderBody'));
  _renderInsufficientTeaser();

  // Build scatter widget next to leaderboard
  const scatterBody = document.getElementById('scatterWidgetBody');
  if (scatterBody) _buildScatterWidget(scatterBody, 'ldr');

  document.getElementById('perfLabSelect').onchange = async (e) => {
    if (!e.target.value) return;
    await _loadLabDetail(e.target.value);
  };

  // Compare tab lab selector (wired after render)
  const cmpSel = document.getElementById('perfCompareLabSelect');
  if (cmpSel) {
    cmpSel.onchange = async (e) => {
      if (!e.target.value) return;
      await _loadCompare(e.target.value);
    };
  }

  container.querySelectorAll('.perf-panel-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      container.querySelectorAll('.perf-panel-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      await _loadPanelBrowser(btn.dataset.panel, panels[btn.dataset.panel]);
    });
  });

  document.getElementById('perfLeaderBody').addEventListener('click', (e) => {
    const row = e.target.closest('[data-lab]');
    if (!row) return;
    const lab = row.dataset.lab;
    container.querySelectorAll('.perf-nav-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === 'detail'));
    container.querySelectorAll('.perf-tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'perf-tab-detail'));
    document.getElementById('perfLabSelect').value = lab;
    _loadLabDetail(lab);
  });
}

// ── Sort controls ─────────────────────────────────────────────────────────────
// Each option has: key, label, hint, group, isScore
const SORT_OPTIONS = [
  { key: 'value_score',       label: 'Value score',  hint: GLOSSARY.value_score,       group: 'value',    isScore: true  },
  { key: 'smape_mean',        label: 'SMAPE%',       hint: GLOSSARY.smape,             group: 'value',    isScore: false },
  { key: 'nrmse',             label: 'NRMSE%',       hint: GLOSSARY.nrmse,             group: 'value',    isScore: false },
  { key: 'mae',               label: 'MAE',          hint: GLOSSARY.mae,               group: 'value',    isScore: false },
  { key: 'calibration_score', label: 'Calib. score', hint: GLOSSARY.calibration_score, group: 'decision', isScore: true  },
  { key: 'ece',               label: 'ECE',          hint: GLOSSARY.ece,               group: 'decision', isScore: false },
  { key: 'mce',               label: 'MCE',          hint: GLOSSARY.mce,               group: 'decision', isScore: false },
  { key: 'bss_pct',           label: 'BSS%',         hint: GLOSSARY.bss,               group: 'decision', isScore: false },
];

function _renderSortRow(el) {
  if (!el) return;
  // Split into two groups for visual clarity
  const valueOpts    = SORT_OPTIONS.filter((o) => o.group === 'value');
  const decisionOpts = SORT_OPTIONS.filter((o) => o.group === 'decision');

  const makeBtns = (opts) => opts.map((o) => {
    const isActive = _leaderSort.key === o.key;
    const arrow    = isActive ? (_leaderSort.asc ? ' &#9650;' : ' &#9660;') : '';
    return `<button class="sort-btn${isActive ? ' active ' + o.group + '-sort' : ''}"
                    data-key="${o.key}" data-group="${o.group}"
                    title="${o.hint}">
              ${o.label}${arrow}
            </button>`;
  }).join('');

  el.innerHTML = `
    <span class="sort-label">Sort by:</span>
    <span class="sort-group-label teal-text">Value -</span>
    ${makeBtns(valueOpts)}
    <span class="sort-group-sep">|</span>
    <span class="sort-group-label navy-text">Decision -</span>
    ${makeBtns(decisionOpts)}`;

  el.querySelectorAll('.sort-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const opt = SORT_OPTIONS.find((o) => o.key === btn.dataset.key);
      if (_leaderSort.key === btn.dataset.key) {
        _leaderSort.asc = !_leaderSort.asc;
      } else {
        _leaderSort.key  = btn.dataset.key;
        // Scores: higher is better -> default desc. Raw errors: lower is better -> default asc.
        // BSS: higher is better -> desc.
        _leaderSort.asc  = opt && (opt.isScore || opt.key === 'bss_pct') ? false : true;
      }
      _renderSortRow(el);
      _renderLeaderboard(document.getElementById('perfLeaderBody'));
    });
  });
}

// ── Leaderboard ───────────────────────────────────────────────────────────────
function _renderLeaderboard(el) {
  if (!el) return;
  const data = [..._leaderboard];
  const key  = _leaderSort.key;

  data.sort((a, b) => {
    const av = a[key], bv = b[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return _leaderSort.asc ? av - bv : bv - av;
  });

  const rows = data.map((row, idx) => {
    // Apply any active scoring override from the settings modal (session-only)
    const r     = _applyScoringLocal(row);
    const vScore = r.value_score       != null ? r.value_score       : null;
    const cScore = r.calibration_score != null ? r.calibration_score : null;
    const vl     = row.value_level    || 'unknown';
    const dl     = row.decision_level || 'unknown';

    // Supporting raw metrics - small/muted
    const smp  = row.smape_mean != null ? row.smape_mean.toFixed(1) + '%'  : '-';
    const nrm  = row.nrmse      != null ? row.nrmse.toFixed(1) + '%'       : '-';
    const mae  = row.mae        != null ? row.mae.toFixed(2)               : '-';
    const ece  = row.ece        != null ? row.ece.toFixed(4)               : '-';
    const mce  = row.mce        != null ? row.mce.toFixed(4)               : '-';
    const bss  = row.bss_pct    != null ? row.bss_pct.toFixed(1) + '%'     : '-';
    const fam  = row.family     ? `<span class="ldr-fam">${row.family}</span>` : '';
    const calib = row.has_calibration ? '<span class="ldr-calib" title="Calibration plot available">&#128200;</span>' : '';
    const meanLine = row.data_mean != null
      ? `<span class="ldr-data-mean" title="Population mean (5th-95th pct range) of real measured values">avg ${row.data_mean}${row.data_p5 != null ? ` <span class="ldr-data-range">(${row.data_p5}-${row.data_p95})</span>` : ''}</span>`
      : '';

    // Row trust = combined both scores
    const vR = vScore != null ? vScore : 0;
    const cR = cScore != null ? cScore : 0;
    const combined = (vR + cR) / 2;
    const rowTrustClass = combined >= 70 ? 'row-high' : combined >= 45 ? 'row-moderate' : 'row-low';

    // Score badges
    const vBadge = vScore != null
      ? `<span class="score-badge score-teal" title="${GLOSSARY.value_score}">${vScore}</span>`
      : `<span class="score-badge score-muted" title="${GLOSSARY.value_score}">-</span>`;
    const cBadge = cScore != null
      ? `<span class="score-badge score-navy" title="${GLOSSARY.calibration_score}">${cScore}</span>`
      : `<span class="score-badge score-muted" title="${GLOSSARY.calibration_score}">-</span>`;

    // Active column highlight
    const ac = (k) => key === k ? 'ldr-active-col' : '';

    return `<tr class="ldr-row ${rowTrustClass}" data-lab="${row.lab}" title="Click for full detail on ${row.lab}">
      <td class="ldr-rank">${idx + 1}</td>
      <td class="ldr-lab">${row.lab}${_perfCovStar(row.lab)}${fam}${calib}${meanLine}</td>
      <td class="ldr-num col-value ldr-score-cell ${ac('value_score')}" title="${GLOSSARY.value_score}">
        ${vBadge}
        <span class="ldr-raw-metrics">SMAPE <span class="${ac('smape_mean')}">${smp}</span> | NRMSE <span class="${ac('nrmse')}">${nrm}</span> | MAE <span class="${ac('mae')}">${mae}</span></span>
      </td>
      <td class="ldr-num col-decision ldr-score-cell ${ac('calibration_score')}" title="${GLOSSARY.calibration_score}">
        ${cBadge}
        <span class="ldr-raw-metrics">ECE <span class="${ac('ece')}">${ece}</span> | MCE <span class="${ac('mce')}">${mce}</span> | BSS <span class="${ac('bss_pct')}">${bss}</span></span>
      </td>
    </tr>`;
  }).join('');

  // Model count summary: NGBoost N | MAE N | Both N
  const ngbCount = Object.values(_coverageMap).filter((c) => c.ngboost).length;
  const maeCount = Object.values(_coverageMap).filter((c) => c.mae).length;
  const bothCount = Object.values(_coverageMap).filter((c) => c.ngboost && c.mae).length;
  const countSummary = (ngbCount || maeCount) ? `
    <div class="ldr-model-counts">
      <span class="ldr-count-chip ngb-count" title="Labs with a usable NGBoost model (>=100 test records)">NGBoost: <strong>${ngbCount}</strong> labs</span>
      <span class="ldr-count-sep">|</span>
      <span class="ldr-count-chip mae-count" title="Labs with a usable MAE model (>=100 test records)">MAE: <strong>${maeCount}</strong> labs</span>
      <span class="ldr-count-sep">|</span>
      <span class="ldr-count-chip both-count" title="Labs covered by both models">Both: <strong>${bothCount}</strong></span>
    </div>` : '';

  // MAE-only section (labs not in current leaderboard but covered by MAE)
  const leaderboardLabs = new Set(data.map((r) => r.lab));
  const maeOnlyLabs = Object.entries(_coverageMap)
    .filter(([lab, c]) => c.mae && !c.ngboost && !leaderboardLabs.has(lab))
    .map(([lab]) => lab).sort();

  let maeOnlySection = '';
  if (maeOnlyLabs.length && _activeModel === 'ngboost') {
    maeOnlySection = `
      <div class="ldr-mae-only-block">
        <div class="ldr-mae-only-title">Covered by Masked AE only - not in NGBoost (${maeOnlyLabs.length} labs)</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">
          ${maeOnlyLabs.map((l) => `<span class="lab-nomodel mae-only-chip" title="Switch to MAE scope to see metrics">${l}</span>`).join('')}
        </div>
        <div style="font-size:12px;color:var(--muted);margin-top:6px">Switch to the <strong>Masked Autoencoders</strong> model scope above to see their performance metrics.</div>
      </div>`;
  }

  el.innerHTML = countSummary + `
    <!-- Two clearly separated column group headers -->
    <div class="ldr-group-headers">
      <div class="ldr-group-header ldr-group-value">
        <span class="ldr-group-title">Value prediction <span class="ldr-group-sub">(the number)</span></span>
        <span class="ldr-group-hint">Score 0-100 then SMAPE / NRMSE / MAE</span>
      </div>
      <div class="ldr-group-header ldr-group-decision">
        <span class="ldr-group-title">Skip / repeat decision <span class="ldr-group-sub">(the probability)</span></span>
        <span class="ldr-group-hint">Score 0-100 then ECE / MCE / BSS%</span>
      </div>
    </div>
    <div class="ldr-scroll">
      <table class="ldr-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Lab</th>
            <th class="th-value" title="${GLOSSARY.value_score}">
              Value prediction
              <span class="tooltip-icon" title="${GLOSSARY.value_score}">i</span>
            </th>
            <th class="th-decision th-divider" title="${GLOSSARY.calibration_score}">
              Skip / repeat decision
              <span class="tooltip-icon" title="${GLOSSARY.calibration_score}">i</span>
            </th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="ldr-legend">
      <span style="display:inline-flex;align-items:center;gap:4px"><span class="row-trust-dot row-trust-green"></span> both scores high - trust the prediction</span>
      <span style="display:inline-flex;align-items:center;gap:4px"><span class="row-trust-dot row-trust-amber"></span> one score low - apply clinical judgment</span>
      <span style="display:inline-flex;align-items:center;gap:4px"><span class="row-trust-dot row-trust-red"></span> both scores low - rough estimate only</span>
    </div>
    ${maeOnlySection}`;
}

// ── No-model teaser (in leaderboard tab) ──────────────────────────────────────
function _renderInsufficientTeaser() {
  const el = document.getElementById('insufficientTeaser');
  if (!el) return;
  getJSON('/api/lab_universe').then((u) => {
    const noModel = u.no_model_data || [];
    if (!noModel.length) return;
    el.innerHTML = `
      <div class="insufficient-data-block">
        <div class="insufficient-title">${noModel.length} lab${noModel.length > 1 ? 's' : ''} with no model (fewer than 100 test records)</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">
          ${noModel.map((l) => `<span class="lab-nomodel">${l}</span>`).join('')}
        </div>
        <div style="font-size:12px;color:var(--muted);margin-top:8px">These labs cannot be predicted. See the <strong>No model</strong> tab for details.</div>
      </div>`;
  }).catch(() => {});
}

// ── No model tab ──────────────────────────────────────────────────────────────
function _renderInsufficient() {
  const el = document.getElementById('perfInsufficientContent');
  if (!el) return;
  el.innerHTML = '<div class="loading-text">Loading...</div>';

  getJSON('/api/lab_universe').then((u) => {
    const noModelData = u.no_model_data || [];
    const ngbOnly     = u.ngboost_only || [];
    const maeOnly     = u.mae_only || [];
    const groups      = u.excluded_groups || {};

    const chips = (arr) => arr.map((l) => `<span class="lab-nomodel">${l}</span>`).join('');

    const sections = [];

    if (noModelData.length) {
      sections.push(`
        <div class="perf-card" style="margin-bottom:var(--sp-4)">
          <div class="perf-card-header">
            <span class="perf-card-title">No model - insufficient data (${noModelData.length})</span>
            <span class="perf-card-sub">Neither NGBoost nor Masked AE has at least 100 test records for these labs. They cannot be evaluated and should always be ordered.</span>
          </div>
          <div style="padding:var(--sp-4)">
            <div style="display:flex;flex-wrap:wrap;gap:6px">${chips(noModelData)}</div>
          </div>
        </div>`);
    }

    if (ngbOnly.length || maeOnly.length) {
      const oneRow = (label, arr) => arr.length ? `
        <div style="margin-bottom:12px">
          <div style="font-size:13px;font-weight:700;color:var(--ink);margin-bottom:6px">${label} (${arr.length})</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px">${chips(arr)}</div>
        </div>` : '';
      sections.push(`
        <div class="perf-card" style="margin-bottom:var(--sp-4)">
          <div class="perf-card-header">
            <span class="perf-card-title">Covered by one method only (${ngbOnly.length + maeOnly.length})</span>
            <span class="perf-card-sub">These labs are still selectable - predicted by whichever model covers them.</span>
          </div>
          <div style="padding:var(--sp-4)">
            ${oneRow('No NGBoost model - Masked AE covers it', maeOnly)}
            ${oneRow('No Masked AE model - NGBoost covers it', ngbOnly)}
          </div>
        </div>`);
    }

    if (Object.keys(groups).length) {
      const groupHtml = Object.entries(groups).map(([cat, items]) => `
        <details style="margin-bottom:8px">
          <summary style="font-size:13px;font-weight:700;color:var(--ink);cursor:pointer">${cat} (${items.length})</summary>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">
            ${items.map((i) => `<span class="lab-nomodel" title="${i.reason}">${i.lab}</span>`).join('')}
          </div>
        </details>`).join('');
      sections.push(`
        <div class="perf-card">
          <div class="perf-card-header">
            <span class="perf-card-title">Not modelled by design</span>
            <span class="perf-card-sub">Derived, duplicate, or qualitative values that are never predicted.</span>
          </div>
          <div style="padding:var(--sp-4)">${groupHtml}</div>
        </div>`);
    }

    if (!sections.length) {
      el.innerHTML = '<div class="perf-empty">All labs have a model in at least one method.</div>';
      return;
    }
    el.innerHTML = sections.join('');
  }).catch(() => {
    el.innerHTML = '<div class="perf-empty">Failed to load lab universe data.</div>';
  });
}

// ── Per-lab detail ─────────────────────────────────────────────────────────────
async function _getLabPerf(lab) {
  if (_perfCache[lab]) return _perfCache[lab];
  const data = await getJSON(`/api/lab/${encodeURIComponent(lab)}/performance?model=${_activeModel}`);
  _perfCache[lab] = data;
  return data;
}

async function _loadLabDetail(lab) {
  const content = document.getElementById('perfLabContent');
  content.innerHTML = '<div class="loading-text">Loading...</div>';
  // The detail view is scoped to the active model; if that model has no model for
  // this lab, say so clearly (and point to the other model) instead of erroring.
  const cov = _perfCov(lab);
  if (cov && _activeModel === 'ngboost' && !cov.ngboost) {
    content.innerHTML = `<div class="perf-empty">NGBoost has no model for <strong>${lab}</strong>. Switch the model scope to <strong>Masked Autoencoders</strong> above, or open <strong>Model comparison</strong>.</div>`;
    return;
  }
  if (cov && _activeModel === 'mae' && !cov.mae) {
    content.innerHTML = `<div class="perf-empty">Masked AE has no model for <strong>${lab}</strong> (or too few test records). Switch the model scope to <strong>NGBoost</strong>.</div>`;
    return;
  }
  try {
    const perf = await _getLabPerf(lab);
    let importances = null;
    try { importances = await _getImportances(lab); } catch (_) {}
    _renderLabDetail(content, perf, importances, lab);
  } catch (e) {
    content.innerHTML = `<div class="error-text">Failed to load: ${e.message}</div>`;
  }
}

async function _getImportances(lab) {
  const patients = await getJSON('/api/patients');
  const patient  = patients.find((p) => p.labs && p.labs[lab]);
  if (!patient) return null;
  const r = await getJSON('/api/predict', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lab, patient_id: patient.id, decision_threshold: 0.85, model: _activeModel }),
  });
  return r.importances || null;
}

// Build a typical-value feature dict from norms over the lab's union inputs, so a
// predict call succeeds for BOTH models (NGBoost importances are static anyway).
function _normFilledFeatures(lab) {
  const schema = (typeof state !== 'undefined' && state.inputSchemas && state.inputSchemas[lab]) || null;
  const norms  = (typeof state !== 'undefined' && state.norms) || {};
  const cols = schema && schema.union ? schema.union
             : [`prev1_${lab}`, `first_in_adm_${lab}`, `days_since_last_${lab}`];
  const feats = {};
  cols.forEach((c) => {
    const m = c.match(/^(?:first_in_adm_|prev1_|prev2_|prev3_)(.+)$/);
    if (m) { const n = norms[m[1]]; feats[c] = (n && n.typical != null) ? n.typical : 5; }
    else if (c.startsWith('days_since_last_')) feats[c] = 1;
    else if (c === 'age') feats[c] = 65;
    else if (c === 'days_in_admission') feats[c] = 3;
    else if (c.startsWith('test_number')) feats[c] = 3;
    else if (c.startsWith('num_')) feats[c] = 1;
    else if (c === 'pulse') feats[c] = 75;
    else if (c === 'sbp') feats[c] = 120;
    else if (c === 'dbp') feats[c] = 75;
    else { const n = norms[c]; feats[c] = (n && n.typical != null) ? n.typical : 1; }
  });
  return feats;
}

// Importances for BOTH models for a lab. We pass BOTH a real patient (for sex + its
// stored values) AND a norm-filled union of inputs that overrides/fills any gaps -
// this guarantees NGBoost has every feature_col it needs, so its importances always
// render when NGBoost has a model (importances are static, independent of the values).
async function _getImportancesBoth(lab) {
  let sex = null, patientId = null;
  try {
    const patients = await getJSON('/api/patients');
    const p = patients.find((x) => x.labs && x.labs[lab]);
    if (p) { sex = p.sex; patientId = p.id; }
  } catch (_) {}
  const features = _normFilledFeatures(lab);
  try {
    const r = await getJSON('/api/predict', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lab, patient_id: patientId, features, prev1: features[`prev1_${lab}`],
        decision_threshold: 0.85, models: ['ngboost', 'mae'], sex }),
    });
    return {
      ngboost: (r.ngboost || {}).importances || null,
      mae:     (r.mae || {}).importances || null,
      ngAvail:  r.ngboost ? r.ngboost.available !== false : false,
      maeAvail: r.mae ? r.mae.available !== false : false,
    };
  } catch (_) {
    return { ngboost: null, mae: null, ngAvail: false, maeAvail: false };
  }
}

// Render both models' importance bars side by side into the compare tab.
async function _renderCompareImportances(lab) {
  const imps = await _getImportancesBoth(lab);
  const IMPC = ['#00a39a', '#232a86', '#c2185b', '#d97706', '#16a34a', '#6b7280', '#0369a1', '#b45309'];
  const draw = (svgId, noteId, importances, avail) => {
    const svg = document.getElementById(svgId);
    const note = document.getElementById(noteId);
    if (!svg) return;
    if (importances && importances.length) {
      renderHBar(svg, importances.slice(0, 8).map((f, i) => ({
        label: f.feature,
        value: typeof f.pct === 'number' ? f.pct : parseFloat(f.pct) || 0,
        color: IMPC[i % IMPC.length],
      })), { maxAbs: 100, showSign: false, labelW: 150, pctW: 46 });
      if (note) note.textContent = '';
    } else {
      svg.innerHTML = '';
      if (note) note.textContent = avail === false ? 'This model has no model for this lab.' : 'No importance available.';
    }
  };
  draw('cmpImpNg', 'cmpImpNgNote', imps.ngboost, imps.ngAvail);
  draw('cmpImpMae', 'cmpImpMaeNote', imps.mae, imps.maeAvail);
}

function _fmtMetric(val) {
  if (val === undefined || val === null || val === '' || val === '--') return '-';
  const n = parseFloat(val);
  if (isNaN(n)) return String(val);
  if (Math.abs(n) < 1) return n.toFixed(4);
  if (Math.abs(n) < 10) return n.toFixed(2);
  return n.toFixed(1);
}

function _renderSexBreakdown(breakdown) {
  if (!breakdown || !breakdown.length) return '';
  const fmtV = (v) => (v == null ? '-' : (typeof v === 'number' ? v.toFixed(v < 1 ? 4 : 1) : v));
  const rows = breakdown.map((b) => {
    const m = b.metrics || {};
    const smape = m['SMAPE_mean%'] != null ? fmtV(m['SMAPE_mean%']) + '%' : '-';
    const nrmse = m['NRMSE%'] != null ? fmtV(m['NRMSE%']) + '%' : '-';
    const ece   = m['ECE'] != null ? fmtV(m['ECE']) : '-';
    const bss   = m['BSS_%'] != null ? fmtV(m['BSS_%']) + '%' : '-';
    const n     = m['Total'] != null ? Number(m['Total']).toLocaleString() : '-';
    return `<tr>
      <td class="sxb-sex">${b.sex === 'M' ? 'Male' : 'Female'}</td>
      <td>${n}</td><td>${smape}</td><td>${nrmse}</td><td>${ece}</td><td>${bss}</td>
    </tr>`;
  }).join('');
  return `
    <div class="perf-section-head">Male vs. Female model comparison</div>
    <div class="perf-block">
      <p style="font-size:12px;color:var(--muted);margin:0 0 10px">
        This lab uses separate models per sex. The metrics above are the weighted average (by n). Per-sex breakdown:
      </p>
      <table class="sxb-table">
        <thead><tr>
          <th>Sex</th><th>n test</th><th>SMAPE</th><th>NRMSE%</th><th>ECE</th><th>BSS%</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function _renderLabDetail(container, perf, importances, lab) {
  const m     = perf.metrics       || {};
  const rel   = perf.reliability   || {};
  const corrs = perf.correlations  || [];
  const calibUrl = perf.calibration_url || null;
  const calibUrlsSex = perf.calibration_urls_sex || null;
  const thresholdCurve = perf.threshold_curve || [];
  const dist = perf.distribution || {};
  const vLevel = rel.value_level    || 'unknown';
  const dLevel = rel.decision_level || 'unknown';

  // Scores from reliability block (these come from the API, not invented)
  const vScore = rel.value_score       != null ? rel.value_score       : null;
  const cScore = rel.calibration_score != null ? rel.calibration_score : null;

  const ece  = _fmtMetric(m['ECE']);
  const mce  = _fmtMetric(m['MCE']);
  const bss  = _fmtMetric(m['BSS_%']);  // CSV header is BSS_% (was read as BSS_pct -> blank)
  const mae  = _fmtMetric(m['MAE']);
  const rmse = _fmtMetric(m['RMSE']);
  const smap = _fmtMetric(m['SMAPE_mean%']);
  const nrm  = _fmtMetric(m['NRMSE%']);
  const roc  = _fmtMetric(m['ROC_AUC']);
  const saved= _fmtMetric(m['Saved%']);
  const fnr  = _fmtMetric(m['FNR%']);
  const ntot = _fmtMetric(m['Total']);

  const vScoreBadge = vScore != null
    ? `<span class="score-badge score-teal score-lg">${vScore}/100</span>`
    : '';
  const cScoreBadge = cScore != null
    ? `<span class="score-badge score-navy score-lg">${cScore}/100</span>`
    : '';

  container.innerHTML = `
    <!-- Reliability verdict -->
    <div class="perf-rel-verdict perf-rel-${dLevel}">
      <div class="prv-head">
        <span class="prv-icon">${dLevel === 'high' ? '&#10003;' : dLevel === 'low' ? '&#9888;' : '&#8505;'}</span>
        <span class="prv-lab">${lab}</span>
        <span class="rel-badge ${vLevel}">value: ${vLevel}</span>
        <span class="rel-badge ${dLevel}">decision: ${dLevel}</span>
      </div>
      <p class="prv-text">${rel.value_text || ''} ${rel.decision_text || ''}</p>
    </div>

    <!-- Dual quality blocks (Value vs Decision) -->
    <div class="perf-dual-quality">

      <!-- Value prediction quality - teal -->
      <div class="quality-block value-quality">
        <div class="quality-block-header">Value prediction quality</div>
        <div class="quality-block-body">
          ${vScoreBadge ? `<div style="margin-bottom:var(--sp-3)">${vScoreBadge}<span class="score-band-label" style="font-size:12px;font-weight:600;margin-left:8px;color:${_perfScoreColor(vScore)}">${_perfScoreBandLabel(vScore)}</span><span style="font-size:12px;color:var(--muted);margin-left:8px">Value accuracy score</span></div>` : ''}
          <div class="val-acc-grid">
            <div class="va-metric">
              <div class="va-val">${mae}</div>
              <div class="va-label">MAE <span class="tooltip-icon" title="${GLOSSARY.mae}">i</span></div>
              <div class="va-def">${GLOSSARY.mae}</div>
            </div>
            <div class="va-metric">
              <div class="va-val">${rmse}</div>
              <div class="va-label">RMSE</div>
              <div class="va-def">Like MAE but penalizes big misses.</div>
            </div>
            <div class="va-metric">
              <div class="va-val">${smap}</div>
              <div class="va-label">SMAPE <span class="tooltip-icon" title="${GLOSSARY.smape}">i</span></div>
              <div class="va-def">${GLOSSARY.smape}</div>
            </div>
            <div class="va-metric">
              <div class="va-val">${nrm}</div>
              <div class="va-label">NRMSE% <span class="tooltip-icon" title="${GLOSSARY.nrmse}">i</span></div>
              <div class="va-def">${GLOSSARY.nrmse}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Decision calibration quality - navy -->
      <div class="quality-block decision-quality">
        <div class="quality-block-header">Decision calibration quality</div>
        <div class="quality-block-body">
          ${cScoreBadge ? `<div style="margin-bottom:var(--sp-3)">${cScoreBadge}<span class="score-band-label" style="font-size:12px;font-weight:600;margin-left:8px;color:${_perfScoreColor(cScore)}">${_perfScoreBandLabel(cScore)}</span><span style="font-size:12px;color:var(--muted);margin-left:8px">Calibration score</span></div>` : ''}
          <div class="calib-metrics-row">
            <div class="calib-metric">
              <div class="cm-val">${ece}</div>
              <div class="cm-label">ECE <span class="tooltip-icon" title="${GLOSSARY.ece}">i</span></div>
              <div class="cm-def">${GLOSSARY.ece}</div>
            </div>
            <div class="calib-metric">
              <div class="cm-val">${mce}</div>
              <div class="cm-label">MCE <span class="tooltip-icon" title="${GLOSSARY.mce}">i</span></div>
              <div class="cm-def">${GLOSSARY.mce}</div>
            </div>
            <div class="calib-metric">
              <div class="cm-val">${bss}${bss !== '-' ? '%' : ''}</div>
              <div class="cm-label">BSS% <span class="tooltip-icon" title="${GLOSSARY.bss}">i</span></div>
              <div class="cm-def">${GLOSSARY.bss}</div>
            </div>
          </div>
          ${(ece === '-' || mce === '-')
            ? `<div class="calib-missing-note">&#9888; ECE / MCE could not be computed for this lab - there are too few held-out samples (n = ${ntot}) to build a reliable calibration curve. Treat the decision score as a rough estimate.</div>`
            : ''}
        </div>
      </div>
    </div>

    ${_renderSexBreakdown(perf.sex_breakdown)}

    <!-- Data distribution (real values) -->
    ${dist && dist.counts ? `
    <div class="perf-section-head">How this lab's values are distributed</div>
    <div class="perf-block">
      <div class="dist-stats-row" id="distStatsRow">
        <div class="dist-stat"><div class="ds-val">${dist.mean}</div><div class="ds-lab">Mean</div></div>
        <div class="dist-stat"><div class="ds-val">${dist.p5}</div><div class="ds-lab">5th pct</div></div>
        <div class="dist-stat"><div class="ds-val">${dist.p50}</div><div class="ds-lab">Median</div></div>
        <div class="dist-stat"><div class="ds-val">${dist.p95}</div><div class="ds-lab">95th pct</div></div>
        <div class="dist-stat"><div class="ds-val">${dist.n != null ? dist.n.toLocaleString() : '-'}</div><div class="ds-lab">Measurements</div></div>
      </div>
      <div class="dist-controls" style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:8px 12px;background:#f9fafb;border-radius:6px;margin-bottom:8px;font-size:12px">
        <label style="display:flex;align-items:center;gap:4px">
          Clip min: <input type="number" id="distClipMin" step="any" style="width:70px;padding:2px 4px;font-size:12px" placeholder="auto">
        </label>
        <label style="display:flex;align-items:center;gap:4px">
          Clip max: <input type="number" id="distClipMax" step="any" style="width:70px;padding:2px 4px;font-size:12px" placeholder="auto">
        </label>
        <label style="display:flex;align-items:center;gap:4px">
          X step: <input type="number" id="distXStep" step="any" min="0" style="width:60px;padding:2px 4px;font-size:12px" placeholder="auto">
        </label>
        <label style="display:flex;align-items:center;gap:4px">
          Y step: <input type="number" id="distYStep" step="any" min="1" style="width:60px;padding:2px 4px;font-size:12px" placeholder="auto">
        </label>
        <label style="display:flex;align-items:center;gap:4px">
          Bin size: <input type="number" id="distBinSize" step="1" min="1" style="width:70px;padding:2px 4px;font-size:12px" placeholder="auto">
        </label>
        <button id="distApplyBtn" style="padding:3px 10px;font-size:12px;background:var(--navy);color:#fff;border:none;border-radius:4px;cursor:pointer">Apply</button>
        <button id="distResetBtn" style="padding:3px 10px;font-size:12px;background:#e5e7eb;color:#374151;border:none;border-radius:4px;cursor:pointer">Reset</button>
        <span id="distClipInfo" style="color:var(--muted);font-size:11px"></span>
      </div>
      <div class="chart-wrap" style="padding:var(--sp-3)">
        <svg id="histSvg" viewBox="0 0 420 184" width="100%"></svg>
      </div>
      <div class="chart-note">Real measured values, clipped to the 1st-99th percentile for readability. Shaded band = 5th to 95th percentile.</div>
    </div>` : ''}

    <!-- Calibration plot -->
    <div class="perf-section-head">Calibration plot</div>
    <div class="perf-block">
      ${calibUrlsSex
        ? `<div class="calib-sex-row">
             ${['M','F'].map((sex) => calibUrlsSex[sex]
               ? `<div class="calib-sex-col">
                    <div class="calib-sex-label">${sex === 'M' ? 'Male' : 'Female'}</div>
                    <img src="${calibUrlsSex[sex]}" alt="Calibration plot for ${lab} (${sex})" class="calib-plot-img" loading="lazy" />
                  </div>`
               : '').join('')}
           </div>`
        : `<div class="calib-plot-block">
             ${calibUrl
               ? `<img src="${calibUrl}" alt="Calibration plot for ${lab}" class="calib-plot-img" loading="lazy" />`
               : `<div class="calib-plot-placeholder">
                    <span class="cpp-icon">&#128200;</span>
                    <span>Calibration plot not available.</span>
                    <span class="cpp-hint">Drop ${lab}.png into calibration/ to display it here.</span>
                  </div>`}
           </div>`}
    </div>

    <!-- Threshold sensitivity chart (B) -->
    ${thresholdCurve.length ? `
    <div class="perf-section-head">Threshold sensitivity - at what cost do we skip?</div>
    <div class="perf-block">
      <div class="threshold-chart-block">
        <div class="threshold-chart-title">
          Higher threshold = fewer tests skipped but fewer unstable results missed.
          Each point is a decision threshold (0.5 to 0.99); lower-right = save more, miss more.
        </div>
        <div class="chart-wrap" style="padding:var(--sp-3)">
          <svg id="thrCurveSvg" viewBox="0 0 420 200" width="100%"></svg>
        </div>
        <div id="thrAnomalyNote" class="chart-note" style="margin-top:4px"></div>
      </div>
    </div>` : ''}

    <!-- Feature importance -->
    <div class="perf-section-head">Key inputs driving predictions</div>
    <div class="perf-block">
      ${perf.importances_sex
        ? `<div class="imp-sex-row">
             ${['M','F'].map((sex) => perf.importances_sex[sex]
               ? `<div class="imp-sex-col">
                    <div class="calib-sex-label">${sex === 'M' ? 'Male model' : 'Female model'}</div>
                    <svg id="impSvg${sex}" viewBox="0 0 360 10" width="100%"></svg>
                  </div>`
               : '').join('')}
           </div>`
        : `<svg id="impSvg" viewBox="0 0 360 10" width="100%"></svg>
           ${!importances ? `<div class="feat-cols-list">${(perf.feature_cols || []).map((f) => `<span class="feat-tag">${f}</span>`).join('')}</div>` : ''}`}
    </div>

    <!-- Correlations -->
    ${(perf.has_correlations && corrs.length) ? `
    <div class="perf-section-head">Most similar tests by result</div>
    <div class="perf-block">
      <p class="corr-explainer">
        Pearson correlations between measured lab values - how similarly the numbers move in patients.
        Not a causal link, but useful to understand result similarity.
        ${perf.profile_family ? `<em>${lab} belongs to the ${perf.profile_family} panel.</em>` : ''}
      </p>
      <svg id="corrSvg" viewBox="0 0 360 10" width="100%"></svg>
      <div class="corr-legend">
        <span class="corr-pos">Values move together</span>
        <span class="corr-neg">Values move opposite</span>
      </div>
    </div>` : !perf.has_correlations ? `
    <div class="perf-section-head">Result similarity</div>
    <div class="perf-block warning" style="background:var(--yellow-bg);border-color:var(--yellow-line)">
      <div style="display:flex;align-items:start;gap:8px">
        <span>&#9888;</span>
        <div>
          <strong>Limited data for correlations</strong>
          <p style="margin:6px 0 0;font-size:12px;color:var(--ink)">
            Not enough overlapping measurements to compute reliable correlations yet.
          </p>
        </div>
      </div>
    </div>` : ''}

    <!-- Advanced metrics (collapsible) -->
    <details class="adv-metrics-details">
      <summary class="adv-metrics-summary">Advanced metrics (ROC_AUC, Saved%, FNR%) - at the 0.5 decision threshold</summary>
      <div class="adv-metrics-body">
        <p class="adv-note">These depend on the decision threshold and are reported here at <strong>threshold = 0.5</strong>. To see how Saved% and FNR% move across thresholds, use the sensitivity chart above.</p>
        <div class="adv-row"><span class="adv-label">ROC AUC</span><span class="adv-val">${roc}</span><span class="adv-def">${GLOSSARY.roc}</span></div>
        <div class="adv-row"><span class="adv-label">Saved%</span><span class="adv-val">${saved}</span><span class="adv-def">${GLOSSARY.saved}</span></div>
        <div class="adv-row"><span class="adv-label">FNR%</span><span class="adv-val">${fnr}</span><span class="adv-def">Rate the model says "skip" when the result is actually unstable.</span></div>
        <div class="adv-row"><span class="adv-label">Test-set size</span><span class="adv-val">${ntot}</span><span class="adv-def">Records in the held-out test set.</span></div>
      </div>
    </details>
  `;

  // Threshold sensitivity chart (B) - X=saved%, Y=FNR%, both fixed 0-100
  if (thresholdCurve.length) {
    const svg = document.getElementById('thrCurveSvg');
    if (svg) _renderThresholdCurve(svg, thresholdCurve);
  }

  // Value distribution histogram with interactive controls
  if (dist && dist.counts) {
    const hsvg = document.getElementById('histSvg');
    if (hsvg) _renderHistogram(hsvg, dist);
    // Bind controls
    const applyBtn = document.getElementById('distApplyBtn');
    const resetBtn = document.getElementById('distResetBtn');
    if (applyBtn && hsvg) {
      const redrawHist = () => {
        const clipMin = document.getElementById('distClipMin').value !== '' ? parseFloat(document.getElementById('distClipMin').value) : null;
        const clipMax = document.getElementById('distClipMax').value !== '' ? parseFloat(document.getElementById('distClipMax').value) : null;
        const xStep   = document.getElementById('distXStep').value !== '' ? parseFloat(document.getElementById('distXStep').value) : null;
        const yStep   = document.getElementById('distYStep').value !== '' ? parseFloat(document.getElementById('distYStep').value) : null;
        const binSize = document.getElementById('distBinSize').value !== '' ? parseFloat(document.getElementById('distBinSize').value) : null;
        _renderHistogram(hsvg, dist, { clipMin, clipMax, xStep, yStep, binSize });
      };
      applyBtn.addEventListener('click', redrawHist);
      if (resetBtn) resetBtn.addEventListener('click', () => {
        document.getElementById('distClipMin').value = '';
        document.getElementById('distClipMax').value = '';
        document.getElementById('distXStep').value = '';
        document.getElementById('distYStep').value = '';
        document.getElementById('distBinSize').value = '';
        document.getElementById('distClipInfo').textContent = '';
        _renderHistogram(hsvg, dist);
        // Restore original stats
        const statsRow = document.getElementById('distStatsRow');
        if (statsRow) {
          statsRow.innerHTML = `
            <div class="dist-stat"><div class="ds-val">${dist.mean}</div><div class="ds-lab">Mean</div></div>
            <div class="dist-stat"><div class="ds-val">${dist.p5}</div><div class="ds-lab">5th pct</div></div>
            <div class="dist-stat"><div class="ds-val">${dist.p50}</div><div class="ds-lab">Median</div></div>
            <div class="dist-stat"><div class="ds-val">${dist.p95}</div><div class="ds-lab">95th pct</div></div>
            <div class="dist-stat"><div class="ds-val">${dist.n != null ? dist.n.toLocaleString() : '-'}</div><div class="ds-lab">Measurements</div></div>`;
        }
      });
    }
  }

  // Feature importance
  const impColors = ['#00a39a','#232a86','#c2185b','#d97706','#16a34a','#6b7280'];
  if (perf.importances_sex) {
    ['M', 'F'].forEach((sex) => {
      const svg = document.getElementById(`impSvg${sex}`);
      const imps = perf.importances_sex[sex];
      if (svg && imps && imps.length) {
        renderHBar(svg, imps.map((f, i) => ({
          label: f.feature, value: f.pct, color: impColors[i % impColors.length],
        })), { maxAbs: 100, showSign: false, labelW: 150, pctW: 46 });
      }
    });
  } else {
    const impSvg = document.getElementById('impSvg');
    if (impSvg && importances && importances.length) {
      renderHBar(impSvg, importances.map((f, i) => ({
        label: f.feature, value: f.pct, color: impColors[i % impColors.length],
      })), { maxAbs: 100, showSign: false, labelW: 150, pctW: 46 });
    }
  }

  // Correlations
  const corrSvg = document.getElementById('corrSvg');
  if (corrSvg && perf.has_correlations && corrs.length) {
    const sorted = [...corrs].sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
    renderHBar(corrSvg, sorted.map((c) => ({ label: c.lab, value: c.r })),
      { maxAbs: 1, showSign: true, labelW: 90, pctW: 50 });
  }
}

// Value-distribution histogram from aggregate counts + bin edges.
// opts: { clipMin, clipMax, xStep, yStep, binSize } for interactive controls.
// binSize: merge original bins so each new bin spans `binSize` units.
function _mergeHistBins(counts, edges, binSize) {
  if (!binSize || binSize <= 0 || !counts.length) return { counts, edges };
  const xMin = edges[0];
  const xMax = edges[edges.length - 1];
  const numBins = Math.max(1, Math.ceil((xMax - xMin) / binSize));
  const newCounts = new Array(numBins).fill(0);
  const newEdges = [];
  for (let i = 0; i <= numBins; i++) newEdges.push(xMin + i * binSize);
  for (let i = 0; i < counts.length; i++) {
    const lo = edges[i], hi = edges[i + 1];
    const mid = (lo + hi) / 2;
    const binIdx = Math.min(Math.floor((mid - xMin) / binSize), numBins - 1);
    if (binIdx >= 0 && binIdx < numBins) newCounts[binIdx] += counts[i];
  }
  // Trim trailing empty bins
  let last = newCounts.length - 1;
  while (last > 0 && newCounts[last] === 0) last--;
  return { counts: newCounts.slice(0, last + 1), edges: newEdges.slice(0, last + 2) };
}

function _renderHistogram(svg, dist, opts) {
  const counts = dist.counts || [];
  const edges  = dist.edges || [];
  if (!counts.length || edges.length !== counts.length + 1) { svg.innerHTML = ''; return; }

  const clipMin = (opts && opts.clipMin != null) ? opts.clipMin : null;
  const clipMax = (opts && opts.clipMax != null) ? opts.clipMax : null;
  const xStep   = (opts && opts.xStep != null && opts.xStep > 0) ? opts.xStep : null;
  const yStep   = (opts && opts.yStep != null && opts.yStep > 0) ? opts.yStep : null;
  const binSize = (opts && opts.binSize != null && opts.binSize > 0) ? opts.binSize : null;

  // Apply custom bin size by merging original bins (before clip filtering)
  let workCounts = counts, workEdges = edges;
  if (binSize) {
    const merged = _mergeHistBins(counts, edges, binSize);
    workCounts = merged.counts;
    workEdges  = merged.edges;
  }

  // Build filtered bins based on clip bounds
  let filtCounts = [], filtEdges = [];
  let totalAll = 0, totalVisible = 0;
  let lastVisibleIdx = -1;
  for (let i = 0; i < workCounts.length; i++) {
    totalAll += workCounts[i];
    const lo = workEdges[i], hi = workEdges[i + 1];
    const binMid = (lo + hi) / 2;
    if (clipMin != null && binMid < clipMin) continue;
    if (clipMax != null && binMid > clipMax) continue;
    filtCounts.push(workCounts[i]);
    filtEdges.push(lo);
    totalVisible += workCounts[i];
    lastVisibleIdx = i;
  }
  if (filtCounts.length && lastVisibleIdx >= 0) filtEdges.push(workEdges[lastVisibleIdx + 1]);

  if (!filtCounts.length) { svg.innerHTML = '<text x="210" y="85" text-anchor="middle" font-size="12" fill="#6b7280">No data in the selected range.</text>'; return; }

  // Compute trimmed mean/median from visible bins (approximation from histogram)
  let trimMean = null, trimMedian = null;
  if (totalVisible > 0) {
    let wSum = 0;
    for (let i = 0; i < filtCounts.length; i++) {
      const mid = (filtEdges[i] + filtEdges[i + 1]) / 2;
      wSum += mid * filtCounts[i];
    }
    trimMean = wSum / totalVisible;
    // Median: find the bin where cumulative reaches 50%
    let cum = 0;
    const half = totalVisible / 2;
    for (let i = 0; i < filtCounts.length; i++) {
      cum += filtCounts[i];
      if (cum >= half) {
        trimMedian = (filtEdges[i] + filtEdges[i + 1]) / 2;
        break;
      }
    }
  }

  const isClipped = clipMin != null || clipMax != null;
  const displayMean = isClipped ? trimMean : dist.mean;
  const displayMedian = isClipped ? trimMedian : dist.p50;

  // Update clip info and stats row
  const clipInfo = document.getElementById('distClipInfo');
  const statsRow = document.getElementById('distStatsRow');
  if (isClipped) {
    const removedPct = totalAll > 0 ? ((totalAll - totalVisible) / totalAll * 100).toFixed(1) : '0.0';
    if (clipInfo) clipInfo.textContent = `Showing ${totalVisible.toLocaleString()} of ${totalAll.toLocaleString()} (${removedPct}% removed)`;
    if (statsRow) {
      statsRow.innerHTML = `
        <div class="dist-stat"><div class="ds-val">${trimMean != null ? trimMean.toFixed(1) : '-'}</div><div class="ds-lab">Mean (trimmed)</div></div>
        <div class="dist-stat"><div class="ds-val">${trimMedian != null ? trimMedian.toFixed(1) : '-'}</div><div class="ds-lab">Median (trimmed)</div></div>
        <div class="dist-stat"><div class="ds-val">${totalVisible.toLocaleString()}</div><div class="ds-lab">Visible</div></div>
        <div class="dist-stat"><div class="ds-val">${((totalAll - totalVisible) / totalAll * 100).toFixed(1)}%</div><div class="ds-lab">Removed</div></div>`;
    }
  } else {
    if (clipInfo) clipInfo.textContent = '';
  }

  const W = 420, H = 170, padL = 40, padR = 16, padT = 12, padB = 32;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxC = Math.max(...filtCounts) || 1;
  const xMin = filtEdges[0], xMax = filtEdges[filtEdges.length - 1], span = (xMax - xMin) || 1;
  const toX = (v) => padL + ((v - xMin) / span) * plotW;
  const toH = (c) => (c / maxC) * plotH;
  const parts = [];
  // baseline
  parts.push(`<line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="#c9ccd6"/>`);
  // 5-95 percentile shaded band (only if not clipped)
  if (!isClipped && dist.p5 != null && dist.p95 != null) {
    const a = Math.max(toX(dist.p5), padL), b = Math.min(toX(dist.p95), W - padR);
    if (b > a) parts.push(`<rect x="${a.toFixed(1)}" y="${padT}" width="${(b - a).toFixed(1)}" height="${plotH}" fill="#00a39a" opacity="0.08"/>`);
  }
  // bars
  filtCounts.forEach((c, i) => {
    const x0 = toX(filtEdges[i]), x1 = toX(filtEdges[i + 1]);
    const w = Math.max(x1 - x0 - 1, 1), h = toH(c);
    parts.push(`<rect x="${x0.toFixed(1)}" y="${(padT + plotH - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="#232a86" opacity="0.78"/>`);
  });
  // mean + median lines
  [['mean', displayMean, '#c2185b'], ['p50', displayMedian, '#d97706']].forEach(([k, val, col]) => {
    if (val == null) return;
    const x = toX(val);
    if (x < padL || x > W - padR) return;
    parts.push(`<line x1="${x.toFixed(1)}" y1="${padT}" x2="${x.toFixed(1)}" y2="${padT + plotH}" stroke="${col}" stroke-width="1.5" stroke-dasharray="4 3"/>`);
  });

  // x-axis ticks
  if (xStep && span > 0) {
    const start = Math.ceil(xMin / xStep) * xStep;
    for (let v = start; v <= xMax; v += xStep) {
      parts.push(`<text x="${toX(v).toFixed(1)}" y="${H - 10}" text-anchor="middle" font-size="10" fill="#6b7280">${(+v).toFixed(v >= 100 ? 0 : 1)}</text>`);
    }
  } else {
    [xMin, (xMin + xMax) / 2, xMax].forEach((v) => {
      parts.push(`<text x="${toX(v).toFixed(1)}" y="${H - 10}" text-anchor="middle" font-size="10" fill="#6b7280">${(+v).toFixed(v >= 100 ? 0 : 1)}</text>`);
    });
  }

  // y-axis ticks
  if (yStep && maxC > 0) {
    for (let c = 0; c <= maxC; c += yStep) {
      const y = padT + plotH - toH(c);
      parts.push(`<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="#e5e7eb" stroke-width="0.5"/>`);
      parts.push(`<text x="${padL - 4}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="8" fill="#9ca3af">${c}</text>`);
    }
  }

  parts.push(`<text x="${padL - 6}" y="${padT + 8}" text-anchor="end" font-size="9" fill="#6b7280">count</text>`);

  // Legend below the chart for mean/median lines
  const legendY = H - 2;
  const legendItems = [];
  if (displayMean != null) legendItems.push({ label: `Mean: ${(+displayMean).toFixed(1)}`, color: '#c2185b' });
  if (displayMedian != null) legendItems.push({ label: `Median: ${(+displayMedian).toFixed(1)}`, color: '#d97706' });
  if (legendItems.length) {
    let lx = padL + 4;
    legendItems.forEach((item) => {
      parts.push(`<line x1="${lx}" y1="${legendY - 4}" x2="${lx + 16}" y2="${legendY - 4}" stroke="${item.color}" stroke-width="1.5" stroke-dasharray="4 3"/>`);
      parts.push(`<text x="${lx + 20}" y="${legendY}" font-size="10" fill="${item.color}" font-weight="600">${item.label}</text>`);
      lx += 20 + item.label.length * 6.2 + 16;
    });
  }

  svg.setAttribute('viewBox', `0 0 ${W} ${H + 14}`);
  svg.innerHTML = parts.join('');
}

// ── B) Threshold sensitivity chart - X=saved%, Y=FNR%, both fixed 0-100 ──────
function _renderThresholdCurve(svg, points) {
  const W = 420, H = 200;
  const padL = 52, padR = 24, padT = 20, padB = 42;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  // Both axes fixed 0-100 always
  const xMin = 0, xMax = 100;
  const yMin = 0, yMax = 100;

  const toX = (v) => padL + ((v - xMin) / (xMax - xMin)) * plotW;
  const toY = (v) => padT + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  // Sort by threshold ascending
  const sorted = [...points].sort((a, b) => (a.threshold || 0) - (b.threshold || 0));
  const normal  = sorted.filter((p) => !p.anomaly);
  const anomaly = sorted.filter((p) => p.anomaly);

  const parts = [];

  // Grid lines at 0, 25, 50, 75, 100
  [0, 25, 50, 75, 100].forEach((v) => {
    const gx = toX(v);
    const gy = toY(v);
    parts.push(`<line x1="${gx.toFixed(1)}" y1="${padT}" x2="${gx.toFixed(1)}" y2="${padT + plotH}" stroke="#e5e7eb" stroke-width="1"/>`);
    parts.push(`<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${padL + plotW}" y2="${gy.toFixed(1)}" stroke="#e5e7eb" stroke-width="1"/>`);
    parts.push(`<text x="${gx.toFixed(1)}" y="${padT + plotH + 14}" text-anchor="middle" font-size="9" fill="#9ca3af">${v}%</text>`);
    parts.push(`<text x="${padL - 5}" y="${gy.toFixed(1)}" text-anchor="end" dominant-baseline="middle" font-size="9" fill="#9ca3af">${v}%</text>`);
  });

  // Axis labels
  parts.push(`<text x="${(padL + plotW / 2).toFixed(0)}" y="${H - 4}" text-anchor="middle" font-size="10" fill="#6b7280">Saved % (tests skipped)</text>`);
  parts.push(`<text x="11" y="${(padT + plotH / 2).toFixed(0)}" text-anchor="middle" font-size="10" fill="#6b7280" transform="rotate(-90, 11, ${(padT + plotH / 2).toFixed(0)})">FNR %</text>`);

  // Axes
  parts.push(`<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="#d1d5db" stroke-width="1.5"/>`);
  parts.push(`<line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="#d1d5db" stroke-width="1.5"/>`);

  // Line only through non-anomaly points
  if (normal.length >= 2) {
    const linePoints = normal
      .map((p) => `${toX(p.saved_pct || 0).toFixed(1)},${toY(p.fnr_pct || 0).toFixed(1)}`)
      .join(' ');
    parts.push(`<polyline points="${linePoints}" fill="none" stroke="#00a39a" stroke-width="2" opacity="0.7"/>`);
  }

  // Normal points - solid filled circles
  normal.forEach((p) => {
    const cx = toX(p.saved_pct || 0);
    const cy = toY(p.fnr_pct   || 0);
    const color = (p.fnr_pct || 0) < 5 ? '#16a34a' : (p.fnr_pct || 0) < 15 ? '#d97706' : '#dc2626';
    parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="6" fill="${color}" stroke="#fff" stroke-width="1.5"/>`);
    parts.push(`<text x="${cx.toFixed(1)}" y="${(cy - 10).toFixed(1)}" text-anchor="middle" font-size="9" fill="#374151" font-weight="700">${p.threshold}</text>`);
  });

  // Anomaly points - hollow/dashed marker (NOT on the line)
  anomaly.forEach((p) => {
    const cx = toX(p.saved_pct || 0);
    const cy = toY(p.fnr_pct   || 0);
    parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="6" fill="none" stroke="#9ca3af" stroke-width="2" stroke-dasharray="3,2"/>`);
    parts.push(`<text x="${cx.toFixed(1)}" y="${(cy - 10).toFixed(1)}" text-anchor="middle" font-size="9" fill="#9ca3af" font-weight="700">${p.threshold}*</text>`);
  });

  svg.innerHTML = parts.join('');

  // Footnote for anomaly points
  if (anomaly.length) {
    const noteEl = document.getElementById('thrAnomalyNote');
    if (noteEl) {
      const list = anomaly.map((p) => p.threshold).join(', ');
      noteEl.textContent = `* ${list} excluded: a higher threshold would not save more than a lower one (data inversion).`;
    }
  }
}

// ── Scatter chart: value_score vs calibration_score ──────────────────────────
// State for scatter filters (module-level so re-renders preserve them)
const SCATTER_STAR_COLORS = ['#e11d48','#ea580c','#7c3aed','#0891b2','#be185d','#047857'];
let _scatterFilters = {
  panels:   { CBC: true, BG_chem: true, BG_gas: true, Standalone: true },
  hideLabs: '',
  dotSize:  5,   // radius: 4=small, 5=medium, 7=large
};
let _scatterStarred = {};  // lab -> color string

function _scatterCalcStats(data) {
  if (!data.length) return null;
  const vs = data.map((r) => r.value_score).filter((v) => v != null);
  const cs = data.map((r) => r.calibration_score).filter((v) => v != null);
  const mean   = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const median = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const std = (arr, mu) => {
    if (arr.length < 2) return null;
    const variance = arr.reduce((a, v) => a + (v - mu) ** 2, 0) / (arr.length - 1);
    return Math.sqrt(variance);
  };
  const vm = mean(vs), cm = mean(cs);
  return {
    value: { mean: vm, median: median(vs), std: std(vs, vm), n: vs.length },
    calib: { mean: cm, median: median(cs), std: std(cs, cm), n: cs.length },
  };
}

function _scatterFilterData() {
  const { panels, hideLabs } = _scatterFilters;
  const hidden = hideLabs.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return _leaderboard.filter((r) => {
    if (r.value_score == null || r.calibration_score == null) return false;
    if (hidden.includes(r.lab.toLowerCase())) return false;
    const fam = r.family || null;
    if (fam === 'CBC' && !panels.CBC) return false;
    if (fam === 'BG_chem' && !panels.BG_chem) return false;
    if (fam === 'BG_gas' && !panels.BG_gas) return false;
    if (!fam && !panels.Standalone) return false;
    return true;
  });
}

// Build the scatter chart widget into a given container element.
// Adds controls, SVG, stats row, and a star legend.
// idSuffix: unique suffix so multiple instances don't clash.
function _buildScatterWidget(container, idSuffix) {
  if (!container || !_leaderboard.length) return;
  if (container.dataset.scatterBuilt) {
    // Already built - just redraw
    _drawScatterSvg(container.querySelector('svg'), idSuffix);
    _updateScatterStats(idSuffix);
    return;
  }
  container.dataset.scatterBuilt = '1';

  container.innerHTML = `
    <div class="scatter-controls" id="scatterCtrl${idSuffix}">
      <div class="scatter-ctrl-row">
        <span class="scatter-ctrl-label">Show:</span>
        ${['CBC', 'BG_chem', 'BG_gas', 'Standalone'].map((p) => `
          <label class="scatter-cb-label">
            <input type="checkbox" class="scatter-panel-cb" data-panel="${p}" ${_scatterFilters.panels[p] ? 'checked' : ''}>
            ${p}
          </label>`).join('')}
        <span class="scatter-ctrl-sep">|</span>
        <label class="scatter-ctrl-label" style="display:inline-flex;align-items:center;gap:4px">
          Hide:
          <input type="text" class="scatter-hide-input" placeholder="e.g. HGB, PLT" value="${_scatterFilters.hideLabs}" style="width:120px;padding:2px 6px;font-size:11px;border:1px solid #d1d5db;border-radius:4px">
        </label>
        <span class="scatter-ctrl-sep">|</span>
        <label class="scatter-ctrl-label" style="display:inline-flex;align-items:center;gap:4px">
          Dot size:
          <select class="scatter-size-sel" style="padding:2px 4px;font-size:11px;border:1px solid #d1d5db;border-radius:4px">
            <option value="4" ${_scatterFilters.dotSize === 4 ? 'selected' : ''}>Small</option>
            <option value="5" ${_scatterFilters.dotSize === 5 ? 'selected' : ''}>Medium</option>
            <option value="7" ${_scatterFilters.dotSize === 7 ? 'selected' : ''}>Large</option>
          </select>
        </label>
        <span class="scatter-ctrl-hint">Click any dot to star it</span>
      </div>
    </div>
    <svg id="scatterSvg${idSuffix}" width="100%" viewBox="0 0 500 400" style="display:block;cursor:crosshair"></svg>
    <div class="scatter-stats-row" id="scatterStats${idSuffix}"></div>
    <div class="scatter-star-legend" id="scatterStarLegend${idSuffix}"></div>
    <details class="scatter-panel-cmp-details">
      <summary class="scatter-panel-cmp-summary">Panel comparison</summary>
      <div class="scatter-panel-cmp-body" id="scatterPanelCmp${idSuffix}"></div>
    </details>`;

  // Floating tooltip div
  let tooltip = document.getElementById('scatterTooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'scatterTooltip';
    tooltip.className = 'scatter-tooltip';
    document.body.appendChild(tooltip);
  }

  const svg = container.querySelector('svg');

  // Bind filter events
  container.querySelectorAll('.scatter-panel-cb').forEach((cb) => {
    cb.addEventListener('change', () => {
      _scatterFilters.panels[cb.dataset.panel] = cb.checked;
      _drawScatterSvg(svg, idSuffix);
      _updateScatterStats(idSuffix);
      _updateScatterPanelCmp(idSuffix);
    });
  });
  container.querySelector('.scatter-hide-input').addEventListener('input', (e) => {
    _scatterFilters.hideLabs = e.target.value;
    _drawScatterSvg(svg, idSuffix);
    _updateScatterStats(idSuffix);
    _updateScatterPanelCmp(idSuffix);
  });
  container.querySelector('.scatter-size-sel').addEventListener('change', (e) => {
    _scatterFilters.dotSize = parseInt(e.target.value, 10);
    _drawScatterSvg(svg, idSuffix);
  });

  // Tooltip on mouse over dots + highlight panel row + click to star
  svg.addEventListener('mousemove', (e) => {
    const g = e.target.closest('[data-lab]');
    if (g) {
      const lab = g.dataset.lab;
      tooltip.textContent = lab + (g.dataset.scores ? ' ' + g.dataset.scores : '');
      tooltip.style.display = 'block';
      tooltip.style.left = e.pageX + 'px';
      tooltip.style.top  = (e.pageY + 1) + 'px';
      tooltip.style.transform = 'translateX(-50%)';
      // Highlight corresponding panel row
      const row = _leaderboard.find((r) => r.lab === lab);
      const fam = (row && row.family) || 'Standalone';
      const cmpEl = container.querySelector('.scatter-panel-cmp-body');
      if (cmpEl) {
        cmpEl.querySelectorAll('tr[data-panel]').forEach((tr) => {
          tr.classList.toggle('scatter-panel-cmp-hover', tr.dataset.panel === fam);
        });
      }
    } else {
      tooltip.style.display = 'none';
      const cmpEl = container.querySelector('.scatter-panel-cmp-body');
      if (cmpEl) cmpEl.querySelectorAll('tr[data-panel]').forEach((tr) => tr.classList.remove('scatter-panel-cmp-hover'));
    }
  });
  svg.addEventListener('mouseleave', () => {
    tooltip.style.display = 'none';
    const cmpEl = container.querySelector('.scatter-panel-cmp-body');
    if (cmpEl) cmpEl.querySelectorAll('tr[data-panel]').forEach((tr) => tr.classList.remove('scatter-panel-cmp-hover'));
  });

  svg.addEventListener('click', (e) => {
    const g = e.target.closest('[data-lab]');
    if (!g) return;
    const lab = g.dataset.lab;
    if (_scatterStarred[lab]) {
      delete _scatterStarred[lab];
    } else {
      const usedColors = Object.values(_scatterStarred);
      const nextColor = SCATTER_STAR_COLORS.find((c) => !usedColors.includes(c))
        || SCATTER_STAR_COLORS[Object.keys(_scatterStarred).length % SCATTER_STAR_COLORS.length];
      _scatterStarred[lab] = nextColor;
    }
    _drawScatterSvg(svg, idSuffix);
    _updateScatterStarLegend(idSuffix);
  });

  _drawScatterSvg(svg, idSuffix);
  _updateScatterStats(idSuffix);
  _updateScatterStarLegend(idSuffix);
  _updateScatterPanelCmp(idSuffix);
}

// Legacy entry point - kept for the overview chart tab
function _renderScatterChart(svg) {
  if (!svg || !_leaderboard.length) return;
  const container = svg.parentElement;
  if (container) {
    // Replace the SVG with the full widget
    const wrapper = document.createElement('div');
    wrapper.className = 'scatter-widget-wrap';
    container.replaceChild(wrapper, svg);
    container.style.overflow = 'visible';
    _buildScatterWidget(wrapper, 'tab');
  }
}

function _updateScatterStats(idSuffix) {
  const statsEl = document.getElementById('scatterStats' + idSuffix);
  if (!statsEl) return;
  const data = _scatterFilterData();
  const s = _scatterCalcStats(data);
  if (!s || !data.length) {
    statsEl.textContent = 'No data matches the current filters.';
    return;
  }
  const fmt = (v) => v != null ? v.toFixed(1) : '-';
  statsEl.innerHTML = `
    <span class="scatter-stat-item scatter-stat-value">Value score - Mean: ${fmt(s.value.mean)} | Median: ${fmt(s.value.median)} | Std dev: ${fmt(s.value.std)}</span>
    <span class="scatter-ctrl-sep" style="margin:0 6px">|</span>
    <span class="scatter-stat-item scatter-stat-calib">Calibration score - Mean: ${fmt(s.calib.mean)} | Median: ${fmt(s.calib.median)} | Std dev: ${fmt(s.calib.std)}</span>
    <span class="scatter-stat-n">(${data.length} labs shown)</span>`;
}

function _updateScatterStarLegend(idSuffix) {
  const legendEl = document.getElementById('scatterStarLegend' + idSuffix);
  if (!legendEl) return;
  const entries = Object.entries(_scatterStarred);
  if (!entries.length) { legendEl.innerHTML = ''; return; }
  legendEl.innerHTML = '<span class="scatter-star-legend-label">Starred:</span>' +
    entries.map(([lab, color]) =>
      `<span class="scatter-star-legend-item" style="color:${color}">&#9733; ${lab}</span>`
    ).join('');
}

function _updateScatterPanelCmp(idSuffix) {
  const el = document.getElementById('scatterPanelCmp' + idSuffix);
  if (!el) return;
  const visibleData = _scatterFilterData();

  // Group visible labs by panel family
  const PANEL_KEYS = ['CBC', 'BG_chem', 'BG_gas', 'Standalone'];
  const groups = {};
  PANEL_KEYS.forEach((p) => groups[p] = []);
  visibleData.forEach((r) => {
    const fam = r.family || 'Standalone';
    if (!groups[fam]) groups[fam] = [];
    groups[fam].push(r);
  });

  const fmt = (v) => v != null ? v.toFixed(1) : '-';

  const rowForGroup = (name, labs, isAll) => {
    if (!labs.length) return '';
    const vs = labs.map((r) => r.value_score).filter((v) => v != null);
    const cs = labs.map((r) => r.calibration_score).filter((v) => v != null);
    const mean   = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    const median = (arr) => {
      if (!arr.length) return null;
      const s = [...arr].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    const std = (arr, mu) => {
      if (arr.length < 2) return null;
      const variance = arr.reduce((a, v) => a + (v - mu) ** 2, 0) / (arr.length - 1);
      return Math.sqrt(variance);
    };
    const vm = mean(vs), cm = mean(cs);
    const cls = isAll ? ' scatter-panel-cmp-all' : '';
    return `<tr data-panel="${name}" class="${cls}">
      <td class="spc-panel">${name}</td>
      <td class="spc-n">${labs.length}</td>
      <td class="spc-teal">${fmt(vm)}</td>
      <td class="spc-teal">${fmt(median(vs))}</td>
      <td class="spc-teal">${fmt(std(vs, vm))}</td>
      <td class="spc-navy">${fmt(cm)}</td>
      <td class="spc-navy">${fmt(median(cs))}</td>
      <td class="spc-navy">${fmt(std(cs, cm))}</td>
    </tr>`;
  };

  const panelRows = PANEL_KEYS
    .filter((p) => groups[p] && groups[p].length > 0)
    .map((p) => rowForGroup(p, groups[p], false))
    .join('');

  const allRow = rowForGroup('All visible', visibleData, true);

  el.innerHTML = `
    <div class="spc-table-wrap">
      <table class="spc-table">
        <thead>
          <tr>
            <th rowspan="2" class="spc-panel-th">Panel</th>
            <th rowspan="2" class="spc-n-th">n</th>
            <th colspan="3" class="spc-value-header">Value score</th>
            <th colspan="3" class="spc-calib-header">Calibration score</th>
          </tr>
          <tr>
            <th class="spc-teal">Mean</th>
            <th class="spc-teal">Median</th>
            <th class="spc-teal">Std</th>
            <th class="spc-navy">Mean</th>
            <th class="spc-navy">Median</th>
            <th class="spc-navy">Std</th>
          </tr>
        </thead>
        <tbody>
          ${panelRows || '<tr><td colspan="8" class="spc-empty">No labs visible</td></tr>'}
          ${allRow}
        </tbody>
      </table>
    </div>`;
}

function _drawScatterSvg(svg, idSuffix) {
  if (!svg) return;
  const W = 500, H = 380;
  const padL = 52, padR = 30, padT = 28, padB = 42;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const toX = (v) => padL + (v / 100) * plotW;
  const toY = (v) => padT + plotH - (v / 100) * plotH;

  const parts = [];

  // Background quadrants (60/60 threshold)
  const midX = toX(60), midY = toY(60);
  parts.push(`<rect x="${midX.toFixed(1)}" y="${padT}" width="${(padL + plotW - midX).toFixed(1)}" height="${(midY - padT).toFixed(1)}" fill="#dcfce7" opacity="0.4"/>`);
  parts.push(`<rect x="${padL}" y="${padT}" width="${(midX - padL).toFixed(1)}" height="${(midY - padT).toFixed(1)}" fill="#fef9c3" opacity="0.3"/>`);
  parts.push(`<rect x="${midX.toFixed(1)}" y="${midY.toFixed(1)}" width="${(padL + plotW - midX).toFixed(1)}" height="${(padT + plotH - midY).toFixed(1)}" fill="#fef9c3" opacity="0.3"/>`);
  parts.push(`<rect x="${padL}" y="${midY.toFixed(1)}" width="${(midX - padL).toFixed(1)}" height="${(padT + plotH - midY).toFixed(1)}" fill="#fee2e2" opacity="0.3"/>`);

  // Grid lines at 0, 25, 50, 75, 100
  [0, 25, 50, 75, 100].forEach((v) => {
    const gx = toX(v), gy = toY(v);
    parts.push(`<line x1="${gx.toFixed(1)}" y1="${padT}" x2="${gx.toFixed(1)}" y2="${padT + plotH}" stroke="#e5e7eb" stroke-width="0.5"/>`);
    parts.push(`<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${padL + plotW}" y2="${gy.toFixed(1)}" stroke="#e5e7eb" stroke-width="0.5"/>`);
    parts.push(`<text x="${gx.toFixed(1)}" y="${padT + plotH + 14}" text-anchor="middle" font-size="9" fill="#9ca3af">${v}</text>`);
    parts.push(`<text x="${padL - 5}" y="${gy.toFixed(1)}" text-anchor="end" dominant-baseline="middle" font-size="9" fill="#9ca3af">${v}</text>`);
  });

  // Axes
  parts.push(`<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="#d1d5db" stroke-width="1.5"/>`);
  parts.push(`<line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="#d1d5db" stroke-width="1.5"/>`);

  // Axis labels
  parts.push(`<text x="${(padL + plotW / 2).toFixed(0)}" y="${H - 4}" text-anchor="middle" font-size="11" fill="#374151" font-weight="600">Value score (0-100)</text>`);
  parts.push(`<text x="12" y="${(padT + plotH / 2).toFixed(0)}" text-anchor="middle" font-size="11" fill="#374151" font-weight="600" transform="rotate(-90, 12, ${(padT + plotH / 2).toFixed(0)})">Calibration score (0-100)</text>`);

  // Title
  parts.push(`<text x="${(W / 2).toFixed(0)}" y="16" text-anchor="middle" font-size="12" fill="#232a86" font-weight="700">Value accuracy vs Calibration quality</text>`);

  // Quadrant labels
  parts.push(`<text x="${(midX + (padL + plotW - midX) / 2).toFixed(0)}" y="${(padT + (midY - padT) / 2).toFixed(0)}" text-anchor="middle" font-size="9" fill="#16a34a" opacity="0.6">Both reliable</text>`);
  parts.push(`<text x="${(padL + (midX - padL) / 2).toFixed(0)}" y="${(midY + (padT + plotH - midY) / 2).toFixed(0)}" text-anchor="middle" font-size="9" fill="#dc2626" opacity="0.6">Both low</text>`);

  // Filtered data points - render regular dots first, stars on top
  const data = _scatterFilterData();
  const r = _scatterFilters.dotSize;

  // Regular (non-starred) dots
  data.filter((d) => !_scatterStarred[d.lab]).forEach((d) => {
    const cx = toX(d.value_score);
    const cy = toY(d.calibration_score);
    let color;
    if (d.value_score >= 60 && d.calibration_score >= 60) color = '#16a34a';
    else if (d.value_score < 60 && d.calibration_score < 60) color = '#dc2626';
    else color = '#d97706';
    const scores = `(V:${d.value_score} C:${d.calibration_score})`;
    parts.push(`<g data-lab="${d.lab}" data-scores="${scores}" style="cursor:pointer">` +
      `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r + 4}" fill="transparent"/>` +
      `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}" fill="${color}" stroke="#fff" stroke-width="1" opacity="0.85"/>` +
      `</g>`);
  });

  // Starred dots - rendered as star symbol on top
  data.filter((d) => _scatterStarred[d.lab]).forEach((d) => {
    const cx = toX(d.value_score);
    const cy = toY(d.calibration_score);
    const starColor = _scatterStarred[d.lab];
    const rs = r + 3;  // star is slightly larger
    // 5-point star path centered at (cx, cy)
    const starPath = _starPath(cx, cy, rs, rs * 0.42);
    const scores = `(V:${d.value_score} C:${d.calibration_score})`;
    parts.push(`<g data-lab="${d.lab}" data-scores="${scores}" style="cursor:pointer">` +
      `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${rs + 5}" fill="transparent"/>` +
      `<path d="${starPath}" fill="${starColor}" stroke="#fff" stroke-width="1"/>` +
      `</g>`);
  });

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = parts.join('');
}

// Generate SVG path string for a 5-point star centered at (cx, cy)
function _starPath(cx, cy, outerR, innerR) {
  const points = [];
  for (let i = 0; i < 10; i++) {
    const angle = (i * Math.PI / 5) - Math.PI / 2;
    const r = i % 2 === 0 ? outerR : innerR;
    points.push(`${(cx + r * Math.cos(angle)).toFixed(2)},${(cy + r * Math.sin(angle)).toFixed(2)}`);
  }
  return 'M' + points.join('L') + 'Z';
}

// ── C) Panel browser ──────────────────────────────────────────────────────────
async function _loadPanelBrowser(panelName, labList) {
  const mainEl    = document.getElementById('perfPanelMain');
  const contentEl = document.getElementById('perfPanelContent');
  if (!mainEl || !contentEl) return;

  // Fetch correlation data
  let corrData = null;
  try {
    corrData = await getJSON(`/api/panel/${encodeURIComponent(panelName)}/correlations`);
  } catch (_) {}

  const panelCalibUrl = `/calibration/ngboost/panel_${panelName}.png`;

  // Build homogeneity sentence
  const homoSentence = corrData && corrData.avg_abs_r != null
    ? _homogeneitySentence(panelName, corrData.avg_abs_r, corrData.homogeneity)
    : '';

  mainEl.innerHTML = `
    <div class="perf-card">
      <div class="perf-card-header">
        <span class="perf-card-title">${panelName} panel - ${labList.length} labs</span>
      </div>
      <div style="padding:var(--sp-4)">

        <!-- Panel calibration -->
        <div class="perf-section-head">Panel calibration plot</div>
        <div class="perf-block">
          <img src="${panelCalibUrl}" alt="${panelName} calibration" class="panel-calibration-img"
               loading="lazy"
               onerror="this.style.display='none';this.nextElementSibling.style.display='block'" />
          <div class="calib-plot-placeholder" style="display:none">
            <span class="cpp-icon">&#128200;</span>
            <span>Panel calibration plot not available.</span>
          </div>
        </div>

        <!-- Correlation summary (C) -->
        ${corrData ? `
        <div class="perf-section-head">Panel correlations</div>
        <div class="perf-block">
          <div class="panel-corr-summary">
            <div class="panel-corr-summary-row">
              <span class="pcs-label">Average |r|:</span>
              <span class="pcs-val">${corrData.avg_abs_r != null ? corrData.avg_abs_r.toFixed(2) : '-'}</span>
              <span class="homogeneity-badge homogeneity-${corrData.homogeneity || 'low'}">${corrData.homogeneity || 'unknown'}</span>
            </div>
            ${homoSentence ? `<div class="panel-corr-homo-text">${homoSentence}</div>` : ''}
            ${corrData.missing && corrData.missing.length ? `<div style="font-size:11px;color:var(--muted);margin-top:4px">Not in correlation matrix: ${corrData.missing.join(', ')}</div>` : ''}
          </div>
          ${corrData.matrix && corrData.labs && corrData.labs.length ? `
          <div class="chart-wrap" style="padding:var(--sp-3);overflow-x:auto">
            <svg id="panelCorrMatSvg" width="100%"></svg>
          </div>` : ''}
        </div>` : ''}

        <!-- Build custom profile (C) -->
        <div class="perf-section-head">Build a custom profile</div>
        <div class="perf-block">
          <div class="custom-profile-block" id="customProfileBlock">
            <div class="custom-profile-desc">
              Pick any combination of labs to explore their correlations and see how homogeneous that group is.
            </div>
            <div class="custom-profile-select-wrap" id="customProfileSelectWrap">
              <div id="customProfileChips" class="custom-profile-chips"></div>
              <div class="custom-profile-add-row">
                <select id="customProfileLabSelect" class="perf-lab-select" style="min-width:140px">
                  <option value="">Add lab...</option>
                  ${(window._allLabsForCustom || []).map((l) => `<option value="${l}">${l}</option>`).join('')}
                </select>
                <button class="btn-run-custom" id="btnRunCustomProfile">Compute correlations</button>
                <button class="btn-clear-custom" id="btnClearCustomProfile">Clear</button>
              </div>
            </div>
            <div id="customProfileResult" style="margin-top:var(--sp-3)"></div>
          </div>
        </div>

      </div>
    </div>`;

  // Render matrix if available
  if (corrData && corrData.matrix && corrData.labs && corrData.labs.length) {
    const matSvg = document.getElementById('panelCorrMatSvg');
    if (matSvg) {
      try { _renderCorrMatrix(matSvg, corrData.labs, corrData.matrix); }
      catch (e) { console.error('Correlation matrix render failed:', e); }
    }
  }

  // Populate custom profile lab select
  _populateCustomProfileSelect();
  _bindCustomProfile();

  // Sidebar per-lab list
  contentEl.innerHTML = `
    <div class="panel-browser-title">${panelName} - ${labList.length} labs</div>
    ${labList.map((lab) => `
      <div class="panel-member-row" id="pmrow-${lab.replace(/[^a-z0-9]/gi,'_')}">
        <div class="panel-member-header">
          <span class="panel-member-name">${lab}</span>
          <button class="panel-member-expand" data-lab="${lab}">View</button>
        </div>
        <div class="panel-member-detail" id="pmdetail-${lab.replace(/[^a-z0-9]/gi,'_')}" hidden></div>
      </div>`).join('')}`;

  contentEl.querySelectorAll('.panel-member-expand').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const lab    = btn.dataset.lab;
      const safeId = lab.replace(/[^a-z0-9]/gi, '_');
      const detail = document.getElementById(`pmdetail-${safeId}`);
      if (detail.hidden) {
        detail.hidden = false;
        btn.textContent = 'Hide';
        if (!detail.dataset.loaded) {
          detail.dataset.loaded = '1';
          detail.innerHTML = '<span class="loading-text" style="padding:6px 0">Loading...</span>';
          try {
            const perf = await _getLabPerf(lab);
            detail.innerHTML = _panelMemberSummary(perf, lab);
          } catch (e) {
            detail.innerHTML = `<span class="error-text" style="font-size:11px">Failed: ${e.message}</span>`;
          }
        }
      } else {
        detail.hidden = true;
        btn.textContent = 'View';
      }
    });
  });
}

function _homogeneitySentence(panelName, avgR, level) {
  const levelDesc = level === 'high'
    ? 'highly homogeneous'
    : level === 'moderate'
    ? 'moderately homogeneous'
    : 'weakly homogeneous';
  return `This panel is ${levelDesc} (avg |r| = ${avgR.toFixed(2)}) - these tests tend to ${level === 'high' ? 'move together strongly' : level === 'moderate' ? 'move together somewhat' : 'move somewhat independently'}.`;
}

// Custom profile: populate lab selector from _leaderboard
function _populateCustomProfileSelect() {
  const sel = document.getElementById('customProfileLabSelect');
  if (!sel) return;
  const labs = _leaderboard.map((r) => r.lab).sort();
  sel.innerHTML = '<option value="">Add lab...</option>' +
    labs.map((l) => `<option value="${l}">${l}</option>`).join('');
}

// Custom profile state
let _customProfileLabs = [];

function _bindCustomProfile() {
  const sel     = document.getElementById('customProfileLabSelect');
  const runBtn  = document.getElementById('btnRunCustomProfile');
  const clrBtn  = document.getElementById('btnClearCustomProfile');
  const chips   = document.getElementById('customProfileChips');
  const result  = document.getElementById('customProfileResult');
  if (!sel || !runBtn || !clrBtn || !chips || !result) return;

  _customProfileLabs = [];
  _renderCustomChips(chips);

  sel.onchange = () => {
    const v = sel.value;
    if (!v || _customProfileLabs.includes(v)) { sel.value = ''; return; }
    _customProfileLabs.push(v);
    sel.value = '';
    _renderCustomChips(chips);
  };

  runBtn.onclick = async () => {
    if (_customProfileLabs.length < 2) {
      result.innerHTML = '<div class="chart-note" style="color:var(--yellow)">Add at least 2 labs to compute correlations.</div>';
      return;
    }
    result.innerHTML = '<div class="loading-text">Computing...</div>';
    try {
      const data = await getJSON('/api/profile/correlations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labs: _customProfileLabs }),
      });
      result.innerHTML = _renderCustomProfileResult(data);
      // Draw matrix
      if (data.matrix && data.labs && data.labs.length) {
        const matSvg = document.getElementById('customCorrMatSvg');
        if (matSvg) _renderCorrMatrix(matSvg, data.labs, data.matrix);
      }
    } catch (e) {
      result.innerHTML = `<div class="error-text">Failed: ${e.message}</div>`;
    }
  };

  clrBtn.onclick = () => {
    _customProfileLabs = [];
    _renderCustomChips(chips);
    result.innerHTML = '';
  };
}

// Top-level custom profile (always visible in panel tab)
let _topCustomProfileLabs = [];
let _topCustomProfileInit = false;

function _initTopCustomProfile() {
  if (_topCustomProfileInit) return;
  _topCustomProfileInit = true;
  const sel     = document.getElementById('customProfileLabSelectTop');
  const runBtn  = document.getElementById('btnRunCustomProfileTop');
  const clrBtn  = document.getElementById('btnClearCustomProfileTop');
  const chips   = document.getElementById('customProfileChipsTop');
  const result  = document.getElementById('customProfileResultTop');
  if (!sel || !runBtn || !clrBtn || !chips || !result) return;

  // Populate lab select from leaderboard
  const labs = _leaderboard.map((r) => r.lab).sort();
  sel.innerHTML = '<option value="">Add lab...</option>' +
    labs.map((l) => `<option value="${l}">${l}</option>`).join('');

  _topCustomProfileLabs = [];
  _renderCustomChips(chips, _topCustomProfileLabs);

  sel.onchange = () => {
    const v = sel.value;
    if (!v || _topCustomProfileLabs.includes(v)) { sel.value = ''; return; }
    _topCustomProfileLabs.push(v);
    sel.value = '';
    _renderCustomChips(chips, _topCustomProfileLabs);
  };

  runBtn.onclick = async () => {
    if (_topCustomProfileLabs.length < 2) {
      result.innerHTML = '<div class="chart-note" style="color:var(--yellow)">Add at least 2 labs to compute correlations.</div>';
      return;
    }
    result.innerHTML = '<div class="loading-text">Computing...</div>';
    try {
      const data = await getJSON('/api/profile/correlations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labs: _topCustomProfileLabs }),
      });
      result.innerHTML = _renderCustomProfileResult(data).replace('customCorrMatSvg', 'topCustomCorrMatSvg');
      if (data.matrix && data.labs && data.labs.length) {
        const matSvg = document.getElementById('topCustomCorrMatSvg');
        if (matSvg) _renderCorrMatrix(matSvg, data.labs, data.matrix);
      }
    } catch (e) {
      result.innerHTML = `<div class="error-text">Failed: ${e.message}</div>`;
    }
  };

  clrBtn.onclick = () => {
    _topCustomProfileLabs = [];
    _renderCustomChips(chips, _topCustomProfileLabs);
    result.innerHTML = '';
  };
}

function _renderCustomChips(chips, labsArr) {
  if (!chips) return;
  // Use provided labsArr, or fall back to _customProfileLabs
  const useLabs = labsArr || _customProfileLabs;
  chips.innerHTML = useLabs.map((l) =>
    `<span class="custom-chip">
       ${l}
       <button class="custom-chip-remove" data-lab="${l}" aria-label="Remove ${l}">&times;</button>
     </span>`
  ).join('');
  chips.querySelectorAll('.custom-chip-remove').forEach((btn) => {
    btn.onclick = () => {
      const idx = useLabs.indexOf(btn.dataset.lab);
      if (idx >= 0) useLabs.splice(idx, 1);
      _renderCustomChips(chips, useLabs);
    };
  });
}

function _renderCustomProfileResult(data) {
  const homoSentence = data.avg_abs_r != null
    ? _homogeneitySentence('custom profile', data.avg_abs_r, data.homogeneity)
    : '';
  const missingNote = data.missing && data.missing.length
    ? `<div style="font-size:11px;color:var(--muted);margin-top:4px">Not in correlation matrix: ${data.missing.join(', ')}</div>`
    : '';

  return `
    <div class="panel-corr-summary" style="margin-bottom:var(--sp-3)">
      <div class="panel-corr-summary-row">
        <span class="pcs-label">Average |r|:</span>
        <span class="pcs-val">${data.avg_abs_r != null ? data.avg_abs_r.toFixed(2) : '-'}</span>
        <span class="homogeneity-badge homogeneity-${data.homogeneity || 'low'}">${data.homogeneity || 'unknown'}</span>
      </div>
      ${homoSentence ? `<div class="panel-corr-homo-text">${homoSentence}</div>` : ''}
      ${missingNote}
    </div>
    ${data.matrix && data.labs && data.labs.length ? `
    <div class="chart-wrap" style="padding:var(--sp-3);overflow-x:auto">
      <svg id="customCorrMatSvg" width="100%"></svg>
    </div>` : '<div class="chart-note">No correlation data available for the selected labs.</div>'}`;
}

// ── Panel member summary (sidebar) ────────────────────────────────────────────
function _panelMemberSummary(perf, lab) {
  const m    = perf.metrics    || {};
  const rel  = perf.reliability || {};
  const corrs = (perf.correlations || []).slice(0, 5);
  const vLevel = rel.value_level    || '-';
  const dLevel = rel.decision_level || '-';

  const metrics = [
    { k: 'ECE',        l: 'ECE' },
    { k: 'NRMSE%',     l: 'NRMSE%' },
    { k: 'SMAPE_mean%',l: 'SMAPE' },
    { k: 'MAE',        l: 'MAE' },
  ].map(({ k, l }) => {
    const v = m[k];
    if (v === undefined || v === '' || v === '--') return '';
    return `<span class="panel-metric">${l}: <strong>${_fmtMetric(v)}</strong></span>`;
  }).filter(Boolean).join('');

  const corrList = corrs.length
    ? corrs.map((c) => `${c.lab} (${c.r >= 0 ? '+' : ''}${c.r.toFixed(2)})`).join(', ')
    : '-';

  return `
    <div class="panel-member-metrics">
      <div class="panel-member-rel">
        <span class="rel-badge ${vLevel}" style="font-size:10px;padding:1px 7px">${vLevel}</span>
        <span class="rel-badge ${dLevel}" style="font-size:10px;padding:1px 7px">${dLevel}</span>
        <span class="mini-bar-wrap">${miniReliabilityBar(dLevel)}</span>
      </div>
      <div class="panel-metric-row">${metrics}</div>
      <div class="panel-corr-row">Similar tests: <span class="panel-corr-list">${corrList}</span></div>
    </div>`;
}

// ── C) Correlation matrix - 2 decimal places, null -> "-" ────────────────────
function _renderCorrMatrix(svg, labs, matrix) {
  const n = labs.length;
  if (!n || !matrix || !matrix.length) return;
  const cellSize = Math.max(22, Math.min(36, Math.floor(260 / n)));
  const labelW   = Math.min(80, 8 * Math.max(...labs.map((l) => l.length)));
  const W = labelW + cellSize * n + 10;
  const H = labelW + cellSize * n + 10;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('height', H);
  const parts = [];

  labs.forEach((lab, i) => {
    // Y-axis label
    const y = labelW + i * cellSize + cellSize / 2;
    parts.push(`<text x="${labelW - 4}" y="${y}" text-anchor="end" dominant-baseline="middle" font-size="9" fill="#374151">${lab.slice(0, 9)}</text>`);
    // X-axis label (rotated)
    const x = labelW + i * cellSize + cellSize / 2;
    parts.push(`<text x="${x}" y="${labelW - 4}" text-anchor="start" font-size="9" fill="#374151" transform="rotate(-45, ${x}, ${labelW - 4})">${lab.slice(0, 7)}</text>`);

    labs.forEach((_, j) => {
      const raw = matrix[i] && matrix[i][j];
      const cx = labelW + j * cellSize;
      const cy = labelW + i * cellSize;

      if (i === j) {
        // Diagonal = 1.00 (always)
        parts.push(`<rect x="${cx}" y="${cy}" width="${cellSize - 1}" height="${cellSize - 1}" fill="rgba(35,42,134,0.15)" rx="1"/>`);
        parts.push(`<text x="${cx + cellSize / 2}" y="${cy + cellSize / 2}" text-anchor="middle" dominant-baseline="middle" font-size="8" fill="#232a86" font-weight="700">1.00</text>`);
      } else if (raw === null || raw === undefined) {
        // Null cell -> "-" muted
        parts.push(`<rect x="${cx}" y="${cy}" width="${cellSize - 1}" height="${cellSize - 1}" fill="#f3f4f6" rx="1"/>`);
        parts.push(`<text x="${cx + cellSize / 2}" y="${cy + cellSize / 2}" text-anchor="middle" dominant-baseline="middle" font-size="9" fill="#9ca3af">-</text>`);
      } else {
        const r = parseFloat(raw);
        const absR = Math.abs(r);
        const alpha = Math.min(absR, 0.9);
        const color = r > 0
          ? `rgba(0,163,154,${alpha.toFixed(2)})`
          : `rgba(220,38,38,${alpha.toFixed(2)})`;
        parts.push(`<rect x="${cx}" y="${cy}" width="${cellSize - 1}" height="${cellSize - 1}" fill="${color}" rx="1"/>`);
        // Always render 2 decimal places
        parts.push(`<text x="${cx + cellSize / 2}" y="${cy + cellSize / 2}" text-anchor="middle" dominant-baseline="middle" font-size="${cellSize >= 28 ? 8 : 7}" fill="${absR > 0.4 ? '#fff' : '#374151'}">${r.toFixed(2)}</text>`);
      }
    });
  });

  svg.innerHTML = parts.join('');
}

// ── About metrics tab (TASK 2) ────────────────────────────────────────────────
// Renders metric explainer cards in two columns (teal = value, navy = decision).
// Populates real-data examples from _leaderboard (already loaded).

function _renderAboutMetrics() {
  const container = document.getElementById('perfAboutContent');
  if (!container) return;
  if (container.dataset.rendered) return;  // Only build once
  container.dataset.rendered = '1';

  // Pick best ECE labs (lowest ECE that isn't null) for decision examples
  const withEce = _leaderboard
    .filter((r) => r.ece != null)
    .sort((a, b) => a.ece - b.ece);

  // Pick best SMAPE labs (lowest smape_mean) for value examples
  const withSmape = _leaderboard
    .filter((r) => r.smape_mean != null)
    .sort((a, b) => a.smape_mean - b.smape_mean);

  // Concrete example labs for callout
  const troponin = _leaderboard.find((r) => r.lab.toLowerCase().includes('troponin'));
  const sodium   = _leaderboard.find((r) => r.lab.toLowerCase() === 'sodium' || r.lab === 'Na');

  const eceEx   = withEce[0];
  const mceEx   = withEce.find((r) => r.mce != null) || withEce[0];
  const bssEx   = _leaderboard.filter((r) => r.bss_pct != null).sort((a, b) => b.bss_pct - a.bss_pct)[0];
  const smapeEx = withSmape[0];
  const nrmseEx = _leaderboard.filter((r) => r.nrmse != null).sort((a, b) => a.nrmse - b.nrmse)[0];
  const maeEx   = _leaderboard.filter((r) => r.mae != null).sort((a, b) => a.mae - b.mae)[0];

  // Current scoring weights (use override if set, else defaults)
  const cfg    = window._scoringOverride || null;
  const sw     = cfg ? Math.round(cfg.value.smape_w * 100) : 40;
  const nw     = cfg ? Math.round(cfg.value.nrmse_w * 100) : 60;
  const ew     = cfg ? Math.round(cfg.decision.ece_w * 100) : 50;
  const mw     = cfg ? Math.round(cfg.decision.mce_w * 100) : 50;
  const mode   = cfg ? cfg.decision.bss_mode : 'gate';
  const floorPct = cfg ? Math.round(cfg.decision.bss_floor * 100) : 50;
  const fullPct  = cfg ? Math.round(cfg.decision.bss_full_at * 100) : 20;

  const fx = (v, d) => (v != null ? (+v).toFixed(d) : '-');

  const valueScoreFormula = `Score = ${sw}% x SMAPE-score + ${nw}% x NRMSE-score`;
  const calibFormula = `Calibration = ${ew}% x (1-ECE) + ${mw}% x (1-MCE)`;
  const gateExplain  = mode === 'gate'
    ? `Gate mode: score is never below ${floorPct}% x calibration. Full credit at BSS = ${fullPct}%.`
    : `Multiply mode: score = calibration x max(0, BSS). BSS=0 zeroes the score.`;

  const bandsHtml = `
    <table class="bands-table">
      <thead><tr><th>Score</th><th>Label</th></tr></thead>
      <tbody>
        <tr><td><span class="band-dot" style="background:#15803d"></span>90-100</td><td>Excellent</td></tr>
        <tr><td><span class="band-dot" style="background:#65a30d"></span>75-89</td><td>Very good</td></tr>
        <tr><td><span class="band-dot" style="background:#d97706"></span>60-74</td><td>Reasonable</td></tr>
        <tr><td><span class="band-dot" style="background:#dc2626"></span>0-59</td><td>Poor</td></tr>
      </tbody>
    </table>`;

  // Training pipeline steps data
  // Color phases: data=blue, train=purple, calib=green, eval=orange
  const PIPELINE_STEPS = [
    {
      num: 1, phase: 'data', title: 'Data Split',
      body: 'Patient-level split: 50% train / 30% validation / 20% test. Split by patient ID so no patient leaks between sets.',
      why: 'Patient-level splitting prevents the model from "memorizing" a specific patient\'s trajectory and ensures the test set is truly unseen.'
    },
    {
      num: 2, phase: 'data', title: 'Outlier Clipping (Winsorization)',
      body: 'Learn P0.1/P99.9 clip bounds from train only. Applied to all sets to remove extreme outliers without data leakage.',
      why: 'Clipping on train-only bounds prevents test-set statistics from influencing feature scaling, preserving a fair evaluation.'
    },
    {
      num: 3, phase: 'data', title: 'Feature Engineering',
      body: 'Per-admission features: prev1 (last value), first_in_adm (admission baseline), days_since_last. Target = current value.',
      why: 'These three features capture the temporal trajectory within an admission without requiring time-series modeling.'
    },
    {
      num: 4, phase: 'data', title: 'Temporal Integrity',
      body: 'Only past information allowed: prev1, first_in_adm, days_since. Forbidden: same-day other labs, any target column. Missing values -> sentinel -999.',
      why: 'Strict temporal ordering prevents look-ahead bias. The -999 sentinel lets the model learn "no prior value" as a distinct state.'
    },
    {
      num: 5, phase: 'train', title: 'Feature Selection',
      body: '30% row dropout (prev1 set to -1) during selection. f_regression drops features with p > 0.05. DecisionTree keeps top features (max 10, 95% variance).',
      why: 'Dropout during selection makes the model robust to missing-value patterns seen in real clinical workflows where not all tests are always available.'
    },
    {
      num: 6, phase: 'train', title: 'NGBoost Training',
      body: '500 trees, LR=0.01, early stopping on validation (50 rounds). If target skew > 2: log1p transform. Output: Normal(mu, sigma).',
      why: 'NGBoost natively outputs a probability distribution, not just a point estimate. This is what makes confidence intervals and P(stable) possible.'
    },
    {
      num: 7, phase: 'calib', title: 'Isotonic Calibration',
      body: 'Calibrate P(stable) using validation data only. NEVER fit on test. Output: calibrated probability that reflects observed frequencies.',
      why: 'Raw model probabilities are often overconfident. Isotonic calibration maps them to actual observed rates, making the ECE close to zero.'
    },
    {
      num: 8, phase: 'calib', title: 'P(stable) Computation',
      body: 'P(stable) = Phi(prev1+delta, mu, sigma) - Phi(prev1-delta, mu, sigma). mu is snapped to quantization grid before CDF.',
      why: 'Stability is defined as the next value landing within a lab-specific window around the previous result - not a threshold on the raw prediction.'
    },
    {
      num: 9, phase: 'calib', title: 'Decision',
      body: 'P(stable) >= threshold -> CANCEL (skip). P(stable) < threshold -> KEEP (repeat). Doctor makes the final call.',
      why: 'The threshold is adjustable per clinical context. A lower threshold = safer but more tests ordered. A higher threshold = more efficient but higher miss rate.'
    },
    {
      num: 10, phase: 'eval', title: 'Walk-Forward Simulation',
      body: 'Chronological per-patient simulation. CANCEL -> prev1 NOT updated (test not done). KEEP -> prev1 updated with real value. Outputs: Saved%, FNR%, ECE, AUC.',
      why: 'Walk-forward simulation mirrors real deployment: when a test is cancelled, the model must predict the next value without a fresh measurement.'
    },
    {
      num: 11, phase: 'eval', title: 'Threshold Sweep',
      body: 'Run walk-forward independently at thresholds 0.50, 0.60, 0.70, 0.80, 0.90, 0.99. Output: Efficiency-Safety tradeoff curve (Saved% vs FNR%).',
      why: 'No single threshold is right for every ward or patient. The sweep shows the full tradeoff so clinicians can choose the operating point that fits their risk tolerance.'
    },
  ];

  const pipelineStepsHtml = PIPELINE_STEPS.map((s) => `
    <div class="pipeline-step phase-${s.phase}">
      <div class="pipeline-step-num">
        <div class="pipeline-step-circle">${s.num}</div>
      </div>
      <div class="pipeline-step-content">
        <div class="pipeline-step-title">${s.title}</div>
        <div class="pipeline-step-body">${s.body}</div>
        <div class="pipeline-step-why">Why this matters: ${s.why}</div>
      </div>
    </div>`).join('');

  const pipelineHtml = `
    <div class="pipeline-section">
      <button class="pipeline-toggle-btn" id="pipelineToggleBtn" aria-expanded="false" aria-controls="pipelineBody">
        <span>Training pipeline - 11 steps from raw data to calibrated prediction</span>
        <span class="pipeline-toggle-icon">&#9660;</span>
      </button>
      <div class="pipeline-body collapsed" id="pipelineBody">
        <div class="pipeline-legend">
          <div class="pipeline-legend-item">
            <span class="pipeline-legend-dot" style="background:#0369a1"></span>
            Steps 1-4: Data preparation
          </div>
          <div class="pipeline-legend-item">
            <span class="pipeline-legend-dot" style="background:#7c3aed"></span>
            Steps 5-6: Model training
          </div>
          <div class="pipeline-legend-item">
            <span class="pipeline-legend-dot" style="background:#059669"></span>
            Steps 7-9: Calibration and decision
          </div>
          <div class="pipeline-legend-item">
            <span class="pipeline-legend-dot" style="background:#d97706"></span>
            Steps 10-11: Evaluation
          </div>
        </div>
        <div class="pipeline-timeline">
          ${pipelineStepsHtml}
        </div>
      </div>
    </div>`;

  container.innerHTML = `
    <div class="perf-card" style="margin-bottom:var(--sp-5)">
      <div class="perf-card-header">
        <span class="perf-card-title">How the scores and metrics work</span>
        <span class="perf-card-sub">Each lab has two independent scores. These explain what they measure, how they are calculated, and what the numbers mean clinically.</span>
      </div>
      <div style="padding:var(--sp-5)">

        <!-- Training pipeline (collapsible, at the top) -->
        ${pipelineHtml}

        <!-- Two-scores callout (full width) -->
        <div class="two-scores-callout" style="margin-bottom:var(--sp-5)">
          <div class="two-scores-callout-title">
            <span>&#9432;</span>
            Why two separate scores?
          </div>
          <div class="two-scores-callout-body">
            A lab gets a <em>Value accuracy score</em> (teal) - how close the predicted number is to reality - and a separate
            <em>Decision calibration score</em> (navy) - how trustworthy the stated stable/repeat probability is.
            These measure different things and can disagree.<br><br>
            ${troponin
              ? `Example: <em>Troponin I HS</em> has value_score = ${troponin.value_score != null ? troponin.value_score : '?'} and calibration_score = ${troponin.calibration_score != null ? troponin.calibration_score : '?'}. The model correctly ranks stable vs unstable cases (good calibration) yet the exact number is hard to predict (SMAPE = ${fx(troponin.smape_mean, 1)}%). This is typical for biomarkers with a wide biological range.`
              : 'Example: Troponin typically has a good decision score (the model ranks stability well) but a lower value score (the raw number is hard to predict precisely). This is typical for biomarkers with wide biological ranges.'}
            <br><br>
            ${sodium
              ? `Contrast with <em>Sodium</em>: value_score = ${sodium.value_score != null ? sodium.value_score : '?'}, calibration_score = ${sodium.calibration_score != null ? sodium.calibration_score : '?'} - both usually reliable because Sodium is tightly regulated.`
              : 'Contrast with Sodium: a tightly regulated electrolyte that typically scores well on both axes.'}
          </div>
        </div>

        <!-- Two-column metric cards -->
        <div class="about-metrics-layout">

          <!-- LEFT: Value accuracy -->
          <div class="metrics-column teal-col">
            <div class="metrics-column-header teal-header">Value accuracy metrics</div>

            <div class="metric-card">
              <div class="metric-card-name">MAE - Mean Absolute Error</div>
              <div class="metric-card-def">Average absolute difference between the predicted value and the actual measured result, in the lab's own units.</div>
              <div class="metric-card-formula">MAE = mean( |predicted - actual| )</div>
              <div class="metric-card-example">
                ${maeEx ? `<strong>${maeEx.lab}</strong> MAE = ${fx(maeEx.mae, 2)} - on average the prediction misses by ${fx(maeEx.mae, 2)} units. Lower is always better.` : 'Lower is always better. Unlike RMSE, MAE weights all misses equally.'}
              </div>
            </div>

            <div class="metric-card">
              <div class="metric-card-name">RMSE - Root Mean Square Error</div>
              <div class="metric-card-def">Like MAE but squares each error before averaging. Large misses count disproportionately more - the metric is sensitive to outliers.</div>
              <div class="metric-card-formula">RMSE = sqrt( mean( (predicted - actual)^2 ) )</div>
              <div class="metric-card-example">
                If the model usually misses by 5 units but occasionally by 50, RMSE will be much higher than MAE. Use RMSE when large misses carry clinical risk.
              </div>
            </div>

            <div class="metric-card">
              <div class="metric-card-name">SMAPE - Symmetric Mean Absolute Percent Error</div>
              <div class="metric-card-def">Percent error normalized by the average of predicted and actual values. Scale-independent - compare across labs with very different units. Range: 0-200%.</div>
              <div class="metric-card-formula">SMAPE = 100 x mean( 2|pred-act| / (|pred|+|act|) )</div>
              <div class="metric-card-example">
                ${smapeEx ? `<strong>${smapeEx.lab}</strong> SMAPE = ${fx(smapeEx.smape_mean, 1)}% - among the lowest in the panel.` : ''}
                Under 10% = tight, 10-30% = moderate, over 30% = noisy.
              </div>
            </div>

            <div class="metric-card">
              <div class="metric-card-name">NRMSE - Normalized RMSE</div>
              <div class="metric-card-def">RMSE expressed as a percentage of the typical lab value. Makes RMSE comparable across labs with different numeric scales.</div>
              <div class="metric-card-formula">NRMSE% = 100 x RMSE / mean_val</div>
              <div class="metric-card-example">
                ${nrmseEx ? `<strong>${nrmseEx.lab}</strong> NRMSE = ${fx(nrmseEx.nrmse, 1)}%.` : ''}
                Under 15% = good, 15-40% = acceptable, over 40% = high noise.
              </div>
            </div>

            <div class="metric-card">
              <div class="metric-card-name">Value score (0-100)</div>
              <div class="metric-card-def">Combined accuracy score shown in the leaderboard. Weighted blend of SMAPE and NRMSE, both rescaled to 0-1. Adjustable in settings.</div>
              <div class="metric-card-score-formula teal-formula">
                SMAPE-score = 1 - SMAPE / 200<br>
                NRMSE-score = max(0, 1 - NRMSE / 100)<br>
                ${valueScoreFormula}
              </div>
              <div class="metric-card-example">
                NRMSE is weighted higher by default (60%) because large misses are more clinically dangerous than typical misses. Adjustable in the gear settings.
              </div>
            </div>
          </div>

          <!-- RIGHT: Decision calibration -->
          <div class="metrics-column navy-col">
            <div class="metrics-column-header navy-header">Decision calibration metrics</div>

            <div class="metric-card">
              <div class="metric-card-name">ECE - Expected Calibration Error</div>
              <div class="metric-card-def">Average gap between the model's stated probability of stability and the actual observed rate. Lower is better. Near 0 means the stated probabilities are trustworthy.</div>
              <div class="metric-card-formula">ECE = mean( |stated P - observed rate| ) across confidence bins</div>
              <div class="metric-card-example">
                ${eceEx ? `<strong>${eceEx.lab}</strong> ECE = ${fx(eceEx.ece, 4)} - the model is off by ${(eceEx.ece * 100).toFixed(2)}% on average. When it says "90% stable", about ${(90 - eceEx.ece * 100).toFixed(0)}-${(90 + eceEx.ece * 100).toFixed(0)}% of those cases actually are.` : 'ECE near 0 means "when the model says 90% stable, about 90% really are."'}
              </div>
            </div>

            <div class="metric-card">
              <div class="metric-card-name">MCE - Maximum Calibration Error</div>
              <div class="metric-card-def">The worst-case ECE in any single confidence bin. While ECE is an average, MCE reveals whether there is any region where the model is badly miscalibrated.</div>
              <div class="metric-card-formula">MCE = max( |stated P - observed rate| ) over all bins</div>
              <div class="metric-card-example">
                ${mceEx ? `<strong>${mceEx.lab}</strong> MCE = ${fx(mceEx.mce, 4)}.` : ''}
                A low ECE but high MCE means the model is usually fine but badly wrong in one confidence region - watch out when the model is very confident.
              </div>
            </div>

            <div class="metric-card">
              <div class="metric-card-name">BSS% - Brier Skill Score</div>
              <div class="metric-card-def">How much better the model's probability is compared to a naive baseline (always predicting the base stability rate). Percent of possible improvement. Above 0 = adds value.</div>
              <div class="metric-card-formula">BSS% = 100 x (1 - Brier / Brier_baseline)</div>
              <div class="metric-card-example">
                ${bssEx ? `<strong>${bssEx.lab}</strong> BSS = ${fx(bssEx.bss_pct, 1)}% - strong predictive skill over the baseline.` : ''}
                BSS &gt; 0 = adds value. BSS = 0 = no better than guessing. BSS &lt; 0 = worse than guessing.
              </div>
            </div>

            <div class="metric-card">
              <div class="metric-card-name">Calibration score (0-100)</div>
              <div class="metric-card-def">Combined decision quality score. Combines ECE/MCE calibration quality with BSS skill. Adjustable via BSS mode in settings.</div>
              <div class="metric-card-score-formula navy-formula">
                ${calibFormula}<br>
                ${gateExplain}
              </div>
              <div class="metric-card-example">
                Gate mode avoids punishing well-calibrated models on stable labs where BSS is structurally low (little variability, so low Brier improvement). A lab can still be clinically useful even with modest BSS if it is well-calibrated.
              </div>
            </div>

            <div class="metric-card">
              <div class="metric-card-name">Confidence bands</div>
              <div class="metric-card-def">Both scores map to a plain-English confidence label shown alongside predictions in the Patient section.</div>
              ${bandsHtml}
            </div>

          </div>
        </div><!-- /about-metrics-layout -->
      </div>
    </div>
  `;

  // Bind pipeline toggle after innerHTML is written
  const pipelineBtn = document.getElementById('pipelineToggleBtn');
  const pipelineBody = document.getElementById('pipelineBody');
  if (pipelineBtn && pipelineBody) {
    pipelineBtn.addEventListener('click', () => {
      const isOpen = pipelineBtn.getAttribute('aria-expanded') === 'true';
      pipelineBtn.setAttribute('aria-expanded', String(!isOpen));
      pipelineBody.classList.toggle('collapsed', isOpen);
    });
  }
}

// ── Model comparison tab ──────────────────────────────────────────────────────
function _initCompareTab() {
  const sel = document.getElementById('perfCompareLabSelect');
  if (sel && sel.value) _loadCompare(sel.value);
  _buildCrossModelComparison();
}

// ── Cross-model comparison (every lab, both models) ──────────────────────────
const _xmodel = { metric: 'value_score', joined: null, built: false };

const XMODEL_METRICS = {
  value_score:       { label: 'Value accuracy',        higherBetter: true },
  calibration_score: { label: 'Decision calibration',  higherBetter: true },
};
const XMODEL_GOOD = 75;   // score >= 75 = "we trust it" (matches the band labels)

// Panel colors for dots (kept local so this works independent of other widgets)
const XMODEL_FAM_COLORS = {
  CBC: '#7c3aed', BG_chem: '#0369a1', BG_gas: '#c2185b', Standalone: '#6b7280',
};
function _xmodelFamColor(fam) { return XMODEL_FAM_COLORS[fam] || XMODEL_FAM_COLORS.Standalone; }

async function _buildCrossModelComparison() {
  const body = document.getElementById('xmodelBody');
  if (!body) return;
  if (_xmodel.built && _xmodel.joined) { _renderXmodelControls(); _renderCrossModel(); return; }

  try {
    const [ng, mae] = await Promise.all([
      getJSON('/api/performance?model=ngboost'),
      getJSON('/api/performance?model=mae'),
    ]);
    const ngMap  = {}; ng.forEach((r) => (ngMap[r.lab] = r));
    const maeMap = {}; mae.forEach((r) => (maeMap[r.lab] = r));
    const labs = [...new Set([...Object.keys(ngMap), ...Object.keys(maeMap)])].sort();
    _xmodel.joined = labs.map((lab) => ({
      lab,
      family: (ngMap[lab] && ngMap[lab].family) || (maeMap[lab] && maeMap[lab].family) || 'Standalone',
      ng: ngMap[lab] || null,
      mae: maeMap[lab] || null,
    }));
    _xmodel.built = true;
    _renderXmodelControls();
    _renderCrossModel();
  } catch (e) {
    body.innerHTML = `<div class="error-text">Failed to load cross-model data: ${e.message}</div>`;
  }
}

function _renderXmodelControls() {
  const ctrl = document.getElementById('xmodelControls');
  if (!ctrl) return;
  ctrl.innerHTML = `
    <span class="xmodel-ctrl-label">Compare on:</span>
    ${Object.entries(XMODEL_METRICS).map(([k, m]) =>
      `<button class="xmodel-metric-btn${k === _xmodel.metric ? ' active' : ''}" data-metric="${k}">${m.label}</button>`).join('')}
    <span class="xmodel-ctrl-hint">Both scores are 0-100 (higher = better). Threshold for "trusted" = ${XMODEL_GOOD}.</span>`;
  ctrl.querySelectorAll('.xmodel-metric-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      _xmodel.metric = btn.dataset.metric;
      ctrl.querySelectorAll('.xmodel-metric-btn').forEach((b) =>
        b.classList.toggle('active', b.dataset.metric === _xmodel.metric));
      _renderCrossModel();
    });
  });
}

function _renderCrossModel() {
  const body = document.getElementById('xmodelBody');
  if (!body || !_xmodel.joined) return;
  const key = _xmodel.metric;

  // Build a row per lab carrying BOTH score types for BOTH models, plus the
  // toggled-metric coordinates (x=NGBoost, y=MAE) used by the scatter.
  const rows = _xmodel.joined.map((row) => {
    const g = (m, k) => (row[m] && row[m][k] != null ? row[m][k] : null);
    return {
      lab: row.lab, family: row.family,
      ngV: g('ng', 'value_score'),  maeV: g('mae', 'value_score'),
      ngC: g('ng', 'calibration_score'), maeC: g('mae', 'calibration_score'),
      x: g('ng', key), y: g('mae', key),
    };
  });
  const both = rows.filter((r) => r.x != null && r.y != null);   // scatter needs both axes

  const svg = _xmodelScatterSvg(both);
  const table = _xmodelVerdictTable(rows, key);

  body.innerHTML = `
    <div class="xmodel-scatter-wrap">${svg}</div>
    ${table}`;

  // Tooltip on hover
  const svgEl = body.querySelector('svg');
  let tip = document.getElementById('scatterTooltip');
  if (!tip) { tip = document.createElement('div'); tip.id = 'scatterTooltip'; tip.className = 'scatter-tooltip'; document.body.appendChild(tip); }
  if (svgEl) {
    svgEl.addEventListener('mousemove', (e) => {
      const g = e.target.closest('[data-lab]');
      if (g) {
        tip.textContent = g.dataset.tip || g.dataset.lab;
        tip.style.display = 'block';
        tip.style.left = e.pageX + 'px';
        tip.style.top = (e.pageY + 2) + 'px';
        tip.style.transform = 'translateX(-50%)';
      } else { tip.style.display = 'none'; }
    });
    svgEl.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    // Click a dot -> open the per-lab comparison below
    svgEl.addEventListener('click', (e) => {
      const g = e.target.closest('[data-lab]');
      if (!g) return;
      _openPerLabCompare(g.dataset.lab);
    });
  }

  // Click a verdict-table row -> open the per-lab comparison below
  body.querySelectorAll('.xmodel-row').forEach((tr) => {
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => _openPerLabCompare(tr.dataset.lab));
  });
}

function _openPerLabCompare(lab) {
  const sel = document.getElementById('perfCompareLabSelect');
  if (sel) sel.value = lab;
  _loadCompare(lab);
  document.getElementById('perfCompareContent')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function _xmodelScatterSvg(points) {
  if (!points.length) return '<div class="perf-empty">No labs are scored by both models on this metric yet.</div>';
  const W = 520, H = 460, ML = 54, MR = 18, MT = 18, MB = 52;
  const plotW = W - ML - MR, plotH = H - MT - MB;
  const sx = (v) => ML + (v / 100) * plotW;
  const sy = (v) => MT + plotH - (v / 100) * plotH;
  const G = XMODEL_GOOD;

  // Quadrant background tints
  const quad = [
    // x>=G, y>=G : strong both (green)
    `<rect x="${sx(G)}" y="${sy(100)}" width="${sx(100) - sx(G)}" height="${sy(G) - sy(100)}" fill="#16a34a" opacity="0.07"/>`,
    // x<G, y<G : weak both (red)
    `<rect x="${sx(0)}" y="${sy(G)}" width="${sx(G) - sx(0)}" height="${sy(0) - sy(G)}" fill="#dc2626" opacity="0.06"/>`,
  ].join('');

  // Axes + grid (0,25,50,75,100)
  let grid = '';
  [0, 25, 50, 75, 100].forEach((t) => {
    grid += `<line x1="${sx(t)}" y1="${MT}" x2="${sx(t)}" y2="${MT + plotH}" stroke="#eef0f3" stroke-width="1"/>`;
    grid += `<line x1="${ML}" y1="${sy(t)}" x2="${ML + plotW}" y2="${sy(t)}" stroke="#eef0f3" stroke-width="1"/>`;
    grid += `<text x="${sx(t)}" y="${MT + plotH + 16}" font-size="9" fill="#9ca3af" text-anchor="middle">${t}</text>`;
    grid += `<text x="${ML - 8}" y="${sy(t) + 3}" font-size="9" fill="#9ca3af" text-anchor="end">${t}</text>`;
  });

  // Diagonal y=x (equal performance)
  const diag = `<line x1="${sx(0)}" y1="${sy(0)}" x2="${sx(100)}" y2="${sy(100)}" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="5,3" opacity="0.8"/>`;
  // "Trusted" threshold lines
  const thr = `<line x1="${sx(G)}" y1="${MT}" x2="${sx(G)}" y2="${MT + plotH}" stroke="#16a34a" stroke-width="1" stroke-dasharray="3,3" opacity="0.5"/>
               <line x1="${ML}" y1="${sy(G)}" x2="${ML + plotW}" y2="${sy(G)}" stroke="#16a34a" stroke-width="1" stroke-dasharray="3,3" opacity="0.5"/>`;

  const dots = points.map((p) => {
    const c = _xmodelFamColor(p.family);
    const delta = (p.y - p.x);
    const tip = `${p.lab}: NGBoost ${Math.round(p.x)} vs MAE ${Math.round(p.y)} (Δ ${delta >= 0 ? '+' : ''}${Math.round(delta)})`;
    return `<g data-lab="${p.lab}" data-tip="${tip}" style="cursor:pointer">
      <circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="5" fill="${c}" opacity="0.82" stroke="#fff" stroke-width="0.8"/>
    </g>`;
  }).join('');

  // Corner labels + axis titles
  const labels = `
    <text x="${sx(100) - 4}" y="${sy(100) + 12}" font-size="9.5" fill="#16a34a" text-anchor="end" font-weight="700">strong in both</text>
    <text x="${sx(0) + 4}" y="${sy(0) - 5}" font-size="9.5" fill="#dc2626" text-anchor="start" font-weight="700">weak in both</text>
    <text x="${sx(100) - 4}" y="${sy(0) - 5}" font-size="9" fill="#6b7280" text-anchor="end">NGBoost only</text>
    <text x="${sx(0) + 4}" y="${sy(100) + 12}" font-size="9" fill="#6b7280" text-anchor="start">MAE only</text>
    <text x="${ML + plotW / 2}" y="${H - 6}" font-size="11" fill="#374151" text-anchor="middle" font-weight="600">NGBoost ${XMODEL_METRICS[_xmodel.metric].label} score →</text>
    <text x="14" y="${MT + plotH / 2}" font-size="11" fill="#374151" text-anchor="middle" font-weight="600" transform="rotate(-90 14 ${MT + plotH / 2})">MAE ${XMODEL_METRICS[_xmodel.metric].label} score →</text>`;

  const legend = `<g>${['CBC', 'BG_chem', 'BG_gas', 'Standalone'].map((f, i) =>
    `<g transform="translate(${ML + i * 96}, ${MT - 4})"><circle cx="4" cy="0" r="4" fill="${_xmodelFamColor(f)}"/><text x="12" y="3" font-size="9" fill="#6b7280">${f}</text></g>`).join('')}</g>`;

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;max-width:560px;margin:0 auto">
    ${quad}${grid}${diag}${thr}${dots}${labels}${legend}
  </svg>`;
}

// Quality class for a 0-100 score (4 canonical bands): >=90 excellent, >=75 very good,
// >=60 reasonable, <=59 poor.
function _xmodelQ(v) { return v == null ? '' : v >= 90 ? 'q-exc' : v >= 75 ? 'q-vg' : v >= 60 ? 'q-ok' : 'q-poor'; }

function _xmodelVerdictTable(rows, key) {
  if (!rows || !rows.length) return '';
  const CLOSE = 5;   // score gap within which the two models are "about the same"
  const metricLabel = XMODEL_METRICS[key].label;
  const num = (v, q) => (v == null ? '<span class="xmodel-na">-</span>' : `<span class="${q || ''}">${Math.round(v)}</span>`);

  // Verdict on the toggled metric. Closeness rule: |x-y|<=5 => "about the same".
  // Bands: excellent >=75, not-reliable <60. Single-model labs get an "only" verdict.
  const verdict = (p) => {
    if (p.x != null && p.y != null) {
      if (Math.abs(p.x - p.y) <= CLOSE) {
        if (p.x >= 75 && p.y >= 75) return { t: 'Trusted in both', c: 'v-both', rank: 0 };
        if (p.x < 60 && p.y < 60)   return { t: 'Weak in both', c: 'v-weak', rank: 3 };
        return { t: 'About the same', c: 'v-same', rank: 1 };
      }
      return p.x > p.y
        ? { t: 'NGBoost stronger', c: 'v-ng', rank: 2 }
        : { t: 'MAE stronger', c: 'v-mae', rank: 2 };
    }
    if (p.x != null) return { t: 'NGBoost only', c: 'v-ng', rank: 4 };
    if (p.y != null) return { t: 'MAE only', c: 'v-mae', rank: 4 };
    return { t: 'No model', c: 'v-weak', rank: 5 };
  };

  // Sort: trusted-both first (combined metric desc), then stronger/only, weak, none.
  const sorted = [...rows].sort((a, b) => {
    const va = verdict(a), vb = verdict(b);
    if (va.rank !== vb.rank) return va.rank - vb.rank;
    const ca = (a.x || 0) + (a.y || 0), cb = (b.x || 0) + (b.y || 0);
    return cb - ca;
  });

  const counts = { both: 0, ng: 0, mae: 0, weak: 0, same: 0, only: 0 };
  rows.forEach((p) => {
    const v = verdict(p);
    if (v.c === 'v-both') counts.both++;
    else if (v.c === 'v-same') counts.same++;
    else if (v.t === 'NGBoost stronger') counts.ng++;
    else if (v.t === 'MAE stronger') counts.mae++;
    else if (v.t.endsWith('only')) counts.only++;
    else counts.weak++;
  });

  const body = sorted.map((p) => {
    const v = verdict(p);
    const dStr = (p.x != null && p.y != null)
      ? `<span class="xmodel-delta ${(p.y - p.x) >= 0 ? 'pos' : 'neg'}">${(p.y - p.x) >= 0 ? '+' : ''}${Math.round(p.y - p.x)}</span>`
      : '<span class="xmodel-na">-</span>';
    return `<tr class="xmodel-row ${v.c}" data-lab="${p.lab}">
      <td class="xmodel-lab">${p.lab}<span class="xmodel-fam" style="background:${_xmodelFamColor(p.family)}">${p.family}</span></td>
      <td class="xmodel-num">${num(p.ngV, _xmodelQ(p.ngV))}</td>
      <td class="xmodel-num xmodel-calib">${num(p.ngC, _xmodelQ(p.ngC))}</td>
      <td class="xmodel-num">${num(p.maeV, _xmodelQ(p.maeV))}</td>
      <td class="xmodel-num xmodel-calib">${num(p.maeC, _xmodelQ(p.maeC))}</td>
      <td class="xmodel-num">${dStr}</td>
      <td><span class="xmodel-verdict ${v.c}">${v.t}</span></td>
    </tr>`;
  }).join('');

  return `
    <div class="xmodel-counts">
      <span class="xmodel-count v-both">${counts.both} trusted in both</span>
      <span class="xmodel-count v-same">${counts.same} about the same</span>
      <span class="xmodel-count v-ng">${counts.ng} NGBoost stronger</span>
      <span class="xmodel-count v-mae">${counts.mae} MAE stronger</span>
      <span class="xmodel-count v-weak">${counts.weak} weak in both</span>
      ${counts.only ? `<span class="xmodel-count v-only">${counts.only} only one model</span>` : ''}
    </div>
    <div class="xmodel-table-scroll">
      <table class="xmodel-table">
        <thead>
          <tr>
            <th rowspan="2">Lab</th>
            <th colspan="2" class="xmodel-grp ngb-grp">NGBoost</th>
            <th colspan="2" class="xmodel-grp mae-grp">Masked AE</th>
            <th rowspan="2">Δ ${metricLabel}<br><span class="xmodel-th-sub">(MAE−NG)</span></th>
            <th rowspan="2">Verdict<br><span class="xmodel-th-sub">on ${metricLabel.toLowerCase()}</span></th>
          </tr>
          <tr>
            <th class="xmodel-th-sub">Value</th><th class="xmodel-th-sub">Calib.</th>
            <th class="xmodel-th-sub">Value</th><th class="xmodel-th-sub">Calib.</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <div class="xmodel-table-hint">Both score types are shown for each model. A lab only one model covers still appears, with that model's scores and an "only" verdict. Click any row or dot to open the full side-by-side metrics below.</div>`;
}

async function _loadCompare(lab) {
  const container = document.getElementById('perfCompareContent');
  if (!container) return;
  container.innerHTML = '<div class="loading-text">Loading comparison...</div>';
  try {
    const [ng, mae] = await Promise.all([
      getJSON(`/api/lab/${encodeURIComponent(lab)}/performance?model=ngboost`).catch(() => null),
      getJSON(`/api/lab/${encodeURIComponent(lab)}/performance?model=mae`).catch(() => null),
    ]);
    container.innerHTML = _renderCompareHtml(lab, ng, mae);
    _renderCompareImportances(lab);  // fill the side-by-side importance bars (async)
  } catch (e) {
    container.innerHTML = `<div class="error-text">Failed to load comparison: ${e.message}</div>`;
  }
}

function _renderCompareHtml(lab, ng, mae) {
  const models = [
    { key: 'ngboost', label: 'NGBoost', data: ng },
    { key: 'mae',     label: 'Masked Autoencoders', data: mae },
  ];

  const metricRows = [
    { label: 'Value score',       fn: (d) => d.reliability?.value_score,       fmt: (v) => v != null ? `${v}/100` : '-', group: 'value' },
    { label: 'SMAPE%',            fn: (d) => d.reliability?.metrics?.SMAPE_mean_pct, fmt: (v) => v != null ? v.toFixed(1) + '%' : '-', group: 'value' },
    { label: 'NRMSE%',            fn: (d) => d.reliability?.metrics?.NRMSE_pct,     fmt: (v) => v != null ? v.toFixed(1) + '%' : '-', group: 'value' },
    { label: 'MAE',               fn: (d) => d.reliability?.metrics?.MAE,           fmt: (v) => v != null ? v.toFixed(3) : '-',         group: 'value' },
    { label: 'Calibration score', fn: (d) => d.reliability?.calibration_score,  fmt: (v) => v != null ? `${v}/100` : '-', group: 'decision' },
    { label: 'ECE',               fn: (d) => d.reliability?.metrics?.ECE,           fmt: (v) => v != null ? v.toFixed(3) : '-',         group: 'decision' },
    { label: 'MCE',               fn: (d) => d.reliability?.metrics?.MCE,           fmt: (v) => v != null ? v.toFixed(3) : '-',         group: 'decision' },
    { label: 'BSS%',              fn: (d) => d.reliability?.metrics?.BSS_pct,       fmt: (v) => v != null ? v.toFixed(1) + '%' : '-',   group: 'decision' },
    { label: 'ROC AUC',           fn: (d) => d.reliability?.metrics?.ROC_AUC,       fmt: (v) => v != null ? v.toFixed(3) : '-',         group: 'decision' },
    { label: 'n test',            fn: (d) => d.reliability?.metrics?.n_test,        fmt: (v) => v != null ? v.toLocaleString() : '-',   group: 'info' },
  ];

  const colHeaders = models.map((m) => {
    const d = m.data;
    if (!d) return `<th class="cmp-col-head cmp-unavail">${m.label}<br><span class="cmp-na">Not available</span></th>`;
    const rel = d.reliability || {};
    const vs = rel.value_score;
    const cs = rel.calibration_score;
    return `<th class="cmp-col-head cmp-${m.key}">
      ${m.label}
      <div class="cmp-scores-mini">
        ${vs != null ? `<span class="score-badge score-teal">${vs}/100</span>` : ''}
        ${cs != null ? `<span class="score-badge score-navy">${cs}/100</span>` : ''}
      </div>
    </th>`;
  }).join('');

  let lastGroup = null;
  const rows = metricRows.map((row) => {
    const vals = models.map((m) => {
      if (!m.data) return '-';
      const v = row.fn(m.data);
      return row.fmt(v);
    });

    let groupHeader = '';
    if (row.group !== lastGroup) {
      const gLabel = row.group === 'value' ? 'Value prediction' : row.group === 'decision' ? 'Decision calibration' : 'Info';
      groupHeader = `<tr><td colspan="${models.length + 1}" class="cmp-group-head">${gLabel}</td></tr>`;
      lastGroup = row.group;
    }

    // Highlight better value (lower error = better for SMAPE/NRMSE/MAE/ECE/MCE; higher = better for scores/ROC/BSS)
    const numVals = vals.map((v) => parseFloat(v));
    const higherBetter = ['Value score', 'Calibration score', 'ROC AUC', 'BSS%'].includes(row.label);
    let winnerIdx = -1;
    const validNums = numVals.filter((n) => !isNaN(n));
    if (validNums.length === 2 && numVals[0] !== numVals[1]) {
      winnerIdx = higherBetter
        ? (numVals[0] > numVals[1] ? 0 : 1)
        : (numVals[0] < numVals[1] ? 0 : 1);
    }

    const cells = vals.map((v, i) => {
      const cls = i === winnerIdx ? ' class="cmp-winner"' : '';
      return `<td${cls}>${v}</td>`;
    }).join('');

    return groupHeader + `<tr><td class="cmp-metric-label">${row.label}</td>${cells}</tr>`;
  }).join('');

  return `
    <div class="cmp-header">
      <h4 style="margin:0 0 4px">${lab} - model comparison</h4>
      <p style="margin:0;font-size:12px;color:var(--muted)">
        Green cell = better metric. Scores are 0-100 (higher is better).
        Missing values (-) mean the model has no data for that metric.
      </p>
    </div>
    <div style="overflow-x:auto">
      <table class="cmp-table">
        <thead><tr><th class="cmp-metric-label">Metric</th>${colHeaders}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="cmp-features-section">
      <div class="perf-section-head" style="margin-top:var(--sp-4)">Feature importance - both models side by side</div>
      <p style="margin:0 0 8px;font-size:12px;color:var(--muted)">
        What each model relies on. NGBoost = gain importance; Masked AE = attention (a proxy).
        Similar bars mean the models reason alike; different bars mean they weigh different inputs.
      </p>
      <div class="cmp-imp-row">
        <div class="cmp-imp-col">
          <div class="cmp-imp-head"><span class="score-badge score-teal">NGBoost</span></div>
          <svg id="cmpImpNg" viewBox="0 0 360 10" width="100%"></svg>
          <div class="cmp-imp-note" id="cmpImpNgNote">Loading...</div>
        </div>
        <div class="cmp-imp-col">
          <div class="cmp-imp-head"><span class="score-badge score-navy">Masked AE</span></div>
          <svg id="cmpImpMae" viewBox="0 0 360 10" width="100%"></svg>
          <div class="cmp-imp-note" id="cmpImpMaeNote">Loading...</div>
        </div>
      </div>
    </div>`;
}
