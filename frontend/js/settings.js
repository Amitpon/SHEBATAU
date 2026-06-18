/**
 * settings.js - Scoring weight settings modal (TASK 1).
 *
 * Opens via the gear icon in the CDSS bar. Loads GET /api/scoring_config once,
 * renders two collapsible blocks (value accuracy + decision calibration),
 * lets the user drag sliders and preview the effect on 3 example labs,
 * and on Apply writes window._scoringOverride so every table/badge recalculates
 * client-side without a page reload.
 *
 * The POST /api/scoring_weights endpoint is not yet implemented on the backend,
 * so changes are session-only (stored in window._scoringOverride).
 */

// ── Defaults (mirrors SCORING_CONFIG in backend/models/base.py) ──────────────
const SCORING_DEFAULTS = {
  value: { smape_w: 0.4, nrmse_w: 0.6 },
  decision: { ece_w: 0.5, mce_w: 0.5, bss_mode: 'gate', bss_full_at: 0.20, bss_floor: 0.5 },
};

// Example labs for the live preview - pulled from /api/performance once
const VALUE_PREVIEW_LABS    = ['Sodium', 'AST', 'CPK'];
const DECISION_PREVIEW_LABS = ['Lympho_abs', 'Troponin_I_HS', 'MCV'];

// Cached data
let _scoringConfig   = null;     // from GET /api/scoring_config
let _allPerfData     = null;     // from GET /api/performance (for preview)
let _stabThresholds  = null;     // from GET /api/stability_thresholds (registry defaults)
let _settingsLoaded  = false;

// Working copy of config that the sliders modify
let _draft = null;

// ── Public helpers used by performance.js ─────────────────────────────────────

/**
 * Re-compute value_score and calibration_score from window._scoringOverride (if set).
 * Called by performance.js for every table row and badge.
 * Returns the perf row with overridden scores, or the original row if no override.
 */
function _applyScoring(perf) {
  const override = window._scoringOverride;
  if (!override) return perf;

  // Clone to avoid mutating cached data
  const p = Object.assign({}, perf);

  const smape  = p.smape_mean;
  const nrmse  = p.nrmse;
  const ece    = p.ece;
  const mce    = p.mce;
  const bss    = p.bss_pct;     // already a percent, e.g. 15.3

  // Value score
  if (smape != null || nrmse != null) {
    const cfg = override.value;
    const smape_s = Math.max(0, Math.min(1, 1.0 - (smape != null ? smape : 0) / 200.0));
    const nrmse_s = Math.max(0, Math.min(1, 1.0 - (nrmse != null ? nrmse : 0) / 100.0));
    p.value_score = Math.round(100 * (cfg.smape_w * smape_s + cfg.nrmse_w * nrmse_s));
  }

  // Calibration score
  if (ece != null || mce != null || bss != null) {
    const cfg   = override.decision;
    const ece_s = Math.max(0, Math.min(1, 1.0 - (ece != null ? ece : 0)));
    const mce_s = Math.max(0, Math.min(1, 1.0 - (mce != null ? mce : 0)));
    const calib = cfg.ece_w * ece_s + cfg.mce_w * mce_s;

    const bss_frac = (bss != null ? bss : 0) / 100.0;
    let factor;
    if (cfg.bss_mode === 'multiply') {
      factor = Math.max(0, bss_frac);
    } else {
      // gate
      const floor = cfg.bss_floor;
      const full  = cfg.bss_full_at;
      factor = Math.max(0, Math.min(1, floor + (bss_frac / full) * (1.0 - floor)));
    }
    p.calibration_score = Math.round(100 * calib * factor);
  }

  return p;
}

// Make globally available so performance.js can call it immediately
window._applyScoring = _applyScoring;

// ── Client-side score calculators (mirror Python logic exactly) ────────────────

function _calcValueScore(smape, nrmse, cfg) {
  if (smape == null && nrmse == null) return null;
  const smape_s = Math.max(0, Math.min(1, 1.0 - (smape != null ? smape : 0) / 200.0));
  const nrmse_s = Math.max(0, Math.min(1, 1.0 - (nrmse != null ? nrmse : 0) / 100.0));
  return Math.round(100 * (cfg.smape_w * smape_s + cfg.nrmse_w * nrmse_s));
}

function _calcCalibScore(ece, mce, bss, cfg) {
  if (ece == null && mce == null && bss == null) return null;
  const ece_s = Math.max(0, Math.min(1, 1.0 - (ece != null ? ece : 0)));
  const mce_s = Math.max(0, Math.min(1, 1.0 - (mce != null ? mce : 0)));
  const calib = cfg.ece_w * ece_s + cfg.mce_w * mce_s;
  const bss_frac = (bss != null ? bss : 0) / 100.0;
  let factor;
  if (cfg.bss_mode === 'multiply') {
    factor = Math.max(0, bss_frac);
  } else {
    const floor = cfg.bss_floor;
    const full  = cfg.bss_full_at;
    factor = Math.max(0, Math.min(1, floor + (bss_frac / full) * (1.0 - floor)));
  }
  return Math.round(100 * calib * factor);
}

// ── Init: wire gear button ─────────────────────────────────────────────────────

function initSettings() {
  if (window._settingsInitDone) return;
  window._settingsInitDone = true;

  const gearBtn    = document.getElementById('settingsGearBtn');
  const overlay    = document.getElementById('settingsModalOverlay');
  const closeBtn   = document.getElementById('settingsModalClose');
  const applyBtn   = document.getElementById('settingsApplyBtn');
  const resetBtn   = document.getElementById('settingsResetBtn');
  const applyNote  = document.getElementById('settingsApplyNote');

  if (!gearBtn || !overlay) return;

  gearBtn.addEventListener('click', async () => {
    overlay.style.display = 'flex';
    applyNote.classList.remove('visible');
    if (!_settingsLoaded) {
      await _loadAndRenderSettings();
    }
  });

  // Close on overlay click or X
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.style.display = 'none';
  });
  closeBtn.addEventListener('click', () => { overlay.style.display = 'none'; });

  // Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.style.display !== 'none') {
      overlay.style.display = 'none';
    }
  });

  applyBtn.addEventListener('click', () => _applyDraft());
  resetBtn.addEventListener('click', () => _resetToDefaults());
}

// ── Load config + perf data, then render ──────────────────────────────────────

async function _loadAndRenderSettings() {
  const body = document.getElementById('settingsModalBody');
  body.innerHTML = '<div class="loading-text">Loading scoring configuration...</div>';
  try {
    [_scoringConfig, _allPerfData, _stabThresholds] = await Promise.all([
      getJSON('/api/scoring_config'),
      getJSON('/api/performance').catch(() => []),
      getJSON('/api/stability_thresholds').catch(() => ({})),
    ]);
    // Start draft from current API config (or existing override if already set)
    _draft = window._scoringOverride
      ? JSON.parse(JSON.stringify(window._scoringOverride))
      : _buildDraftFromConfig(_scoringConfig);
    _settingsLoaded = true;
    _renderSettingsBody(body);
  } catch (e) {
    body.innerHTML = `<div class="error-text">Failed to load settings: ${e.message}</div>`;
  }
}

function _buildDraftFromConfig(cfg) {
  return {
    value: {
      smape_w: cfg.value.smape_w,
      nrmse_w: cfg.value.nrmse_w,
    },
    decision: {
      ece_w:      cfg.decision.ece_w,
      mce_w:      cfg.decision.mce_w,
      bss_mode:   cfg.decision.bss_mode,
      bss_full_at: cfg.decision.bss_full_at,
      bss_floor:  cfg.decision.bss_floor,
    },
  };
}

// ── Render modal body ─────────────────────────────────────────────────────────

function _renderSettingsBody(container) {
  container.innerHTML = `
    <!-- BLOCK 0: Display mode -->
    <div class="settings-block" id="settingsBlockMode" style="border-left:3px solid var(--navy)">
      <div class="settings-block-header" id="settingsBlockModeHdr">
        <span>Display mode</span>
        <span class="settings-block-toggle">&#9660;</span>
      </div>
      <div class="settings-block-body" id="settingsBlockModeBody">
        <div class="settings-note" style="margin-bottom:var(--sp-2)">
          Choose how prediction results are displayed.
        </div>
        <div class="settings-radio-group">
          <label class="settings-radio-label">
            <input type="radio" name="displayMode" value="clinical" ${isClinicalMode() ? 'checked' : ''} />
            <span class="settings-radio-meta">
              <span class="settings-radio-title">Clinical <span class="settings-radio-recommended">recommended</span></span>
              <span class="settings-radio-desc">Compact cards, no numeric scores. Low-confidence labs flagged automatically.</span>
            </span>
          </label>
          <label class="settings-radio-label">
            <input type="radio" name="displayMode" value="detailed" ${!isClinicalMode() ? 'checked' : ''} />
            <span class="settings-radio-meta">
              <span class="settings-radio-title">Detailed</span>
              <span class="settings-radio-desc">Full model output: bell curves, trust analysis, verification, all scores.</span>
            </span>
          </label>
        </div>
        ${_renderClinicalBandsGroup('value', 'Value accuracy bands', 'Controls whether the predicted value is shown.')}
        ${_renderClinicalBandsGroup('calibration', 'Calibration / probability trust bands', 'Controls whether the skip/repeat probability is trusted, or the test is always flagged for repeat.')}
      </div>
    </div>

    <!-- BLOCK 1: Value accuracy -->
    <div class="settings-block teal-block" id="settingsBlockValue">
      <div class="settings-block-header" id="settingsBlockValueHdr">
        <span>Value accuracy score weights</span>
        <span class="settings-block-toggle">&#9660;</span>
      </div>
      <div class="settings-block-body" id="settingsBlockValueBody">
        ${_renderValueBlock()}
      </div>
    </div>

    <!-- BLOCK 2: Decision calibration -->
    <div class="settings-block navy-block" id="settingsBlockDecision">
      <div class="settings-block-header" id="settingsBlockDecisionHdr">
        <span>Decision calibration score</span>
        <span class="settings-block-toggle">&#9660;</span>
      </div>
      <div class="settings-block-body" id="settingsBlockDecisionBody">
        ${_renderDecisionBlock()}
      </div>
    </div>

    <!-- BLOCK 3: Stability thresholds -->
    <div class="settings-block orange-block collapsed" id="settingsBlockStab">
      <div class="settings-block-header" id="settingsBlockStabHdr">
        <span>Stability thresholds per lab</span>
        <span class="settings-block-toggle">&#9654;</span>
      </div>
      <div class="settings-block-body" id="settingsBlockStabBody">
        ${_renderStabBlock()}
      </div>
    </div>
  `;

  // Wire collapsible headers
  ['Mode', 'Value', 'Decision', 'Stab'].forEach((name) => {
    const hdr = document.getElementById(`settingsBlock${name}Hdr`);
    const blk = document.getElementById(`settingsBlock${name}`);
    if (hdr && blk) {
      hdr.addEventListener('click', () => blk.classList.toggle('collapsed'));
    }
  });

  // Wire all sliders + radios + stab inputs
  _bindDisplayModeControls();
  _bindValueSliders();
  _bindDecisionControls();
  _bindStabControls();
}

// ── Block 1 HTML ──────────────────────────────────────────────────────────────

function _renderValueBlock() {
  const smapePct = Math.round(_draft.value.smape_w * 100);
  const nrmsePct = 100 - smapePct;
  return `
    <!-- SMAPE slider -->
    <div class="settings-slider-row" id="smapeSliderRow">
      <div class="settings-slider-label">
        <span>SMAPE weight</span>
        <span class="settings-slider-val teal-val" id="smapeValDisplay">${smapePct}%</span>
      </div>
      <input type="range" id="smapeSlider" min="0" max="100" value="${smapePct}"
             aria-label="SMAPE weight percent" />
      <div class="settings-slider-hint">Scale-independent percent error - range 0-200%</div>
    </div>

    <!-- NRMSE - auto complement -->
    <div class="settings-slider-row">
      <div class="settings-slider-label">
        <span>NRMSE weight (auto - complement)</span>
        <span class="settings-slider-val teal-val" id="nrmseValDisplay">${nrmsePct}%</span>
      </div>
      <input type="range" id="nrmseSlider" min="0" max="100" value="${nrmsePct}"
             aria-label="NRMSE weight percent" />
      <div class="settings-slider-hint">RMSE as % of typical value - penalizes large misses harder. Recommended: 60%+</div>
    </div>

    <!-- Live formula -->
    <div class="settings-formula" id="valueFormulaDisplay">
      Score = ${smapePct}% x SMAPE-score + ${nrmsePct}% x NRMSE-score
    </div>

    <!-- Preview -->
    <div>
      <div class="settings-preview">
        <div class="settings-preview-head">Live preview - effect on 3 example labs</div>
        <div class="settings-preview-row header">
          <span>Lab</span>
          <span class="settings-preview-num">Current</span>
          <span class="settings-preview-num">New</span>
          <span class="settings-preview-delta">Delta</span>
        </div>
        <div id="valuePreviewRows">${_renderValuePreviewRows()}</div>
      </div>
    </div>
  `;
}

function _renderValuePreviewRows() {
  if (!_allPerfData || !_allPerfData.length) {
    return '<div class="settings-preview-row"><span class="metrics-example-loading">Loading examples...</span></div>';
  }
  return VALUE_PREVIEW_LABS.map((labName) => {
    const row = _allPerfData.find((r) => r.lab === labName || r.lab.startsWith(labName));
    if (!row) return '';
    const originalScore = row.value_score != null ? row.value_score : '-';
    const newScore = _calcValueScore(row.smape_mean, row.nrmse, _draft.value);
    const delta = (newScore != null && originalScore !== '-')
      ? newScore - originalScore : null;
    const deltaClass = delta == null ? 'delta-same'
      : delta > 0 ? 'delta-up' : delta < 0 ? 'delta-down' : 'delta-same';
    const deltaStr = delta == null ? '-' : delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : '0';
    return `<div class="settings-preview-row">
      <span>${labName}</span>
      <span class="settings-preview-num teal-num">${originalScore}</span>
      <span class="settings-preview-num teal-num">${newScore != null ? newScore : '-'}</span>
      <span class="settings-preview-delta ${deltaClass}">${deltaStr}</span>
    </div>`;
  }).join('');
}

// ── Block 2 HTML ──────────────────────────────────────────────────────────────

function _renderDecisionBlock() {
  const ecePct  = Math.round(_draft.decision.ece_w * 100);
  const mcePct  = 100 - ecePct;
  const isGate  = _draft.decision.bss_mode === 'gate';
  const floorPct  = Math.round(_draft.decision.bss_floor * 100);
  const fullPct   = Math.round(_draft.decision.bss_full_at * 100);

  return `
    <!-- BSS mode radio -->
    <div>
      <div class="settings-slider-label" style="margin-bottom:var(--sp-2)">
        <span>BSS handling mode</span>
      </div>
      <div class="settings-radio-group">
        <label class="settings-radio-label">
          <input type="radio" name="bssMode" value="gate" ${isGate ? 'checked' : ''} />
          Gate <span class="settings-radio-recommended">recommended</span>
        </label>
        <label class="settings-radio-label">
          <input type="radio" name="bssMode" value="multiply" ${!isGate ? 'checked' : ''} />
          Multiply
        </label>
      </div>
    </div>

    <!-- Gate-specific sliders (hidden in multiply mode) -->
    <div id="gateSliders" style="${isGate ? '' : 'display:none'}">
      <div class="settings-slider-row">
        <div class="settings-slider-label">
          <span>BSS floor - minimum credit when BSS = 0</span>
          <span class="settings-slider-val navy-val" id="bssFloorDisplay">${floorPct}%</span>
        </div>
        <input type="range" id="bssFloorSlider" min="0" max="100" value="${floorPct}"
               aria-label="BSS floor percent" />
        <div class="settings-slider-hint">When BSS = 0 (no skill), the calibration score is multiplied by this floor value instead of being zeroed.</div>
      </div>
      <div class="settings-slider-row">
        <div class="settings-slider-label">
          <span>BSS full credit at - skill saturation point</span>
          <span class="settings-slider-val navy-val" id="bssFullDisplay">${fullPct}%</span>
        </div>
        <input type="range" id="bssFullSlider" min="1" max="50" value="${fullPct}"
               aria-label="BSS full credit point percent" />
        <div class="settings-slider-hint">BSS% value at which full skill credit is reached (score is not penalized further above this).</div>
      </div>
    </div>

    <!-- Plain English explanation -->
    <div class="settings-note" id="bssModeExplainer">
      ${_bssModeText(isGate, floorPct)}
    </div>

    <!-- ECE weight -->
    <div class="settings-slider-row" id="eceSliderRow">
      <div class="settings-slider-label">
        <span>ECE weight</span>
        <span class="settings-slider-val navy-val" id="eceValDisplay">${ecePct}%</span>
      </div>
      <input type="range" id="eceSlider" min="0" max="100" value="${ecePct}"
             aria-label="ECE weight percent" />
      <div class="settings-slider-hint">Expected Calibration Error - average probability gap across all cases</div>
    </div>

    <!-- MCE weight - auto complement -->
    <div class="settings-slider-row">
      <div class="settings-slider-label">
        <span>MCE weight (auto - complement)</span>
        <span class="settings-slider-val navy-val" id="mceValDisplay">${mcePct}%</span>
      </div>
      <input type="range" id="mceSlider" min="0" max="100" value="${mcePct}"
             aria-label="MCE weight percent" />
      <div class="settings-slider-hint">Maximum Calibration Error - worst-case probability gap in any confidence bin</div>
    </div>

    <!-- Live formula -->
    <div class="settings-formula" id="decisionFormulaDisplay">
      ${_decisionFormulaText(ecePct, mcePct, isGate, floorPct, fullPct)}
    </div>

    <!-- Preview -->
    <div>
      <div class="settings-preview">
        <div class="settings-preview-head">Live preview - effect on 3 example labs</div>
        <div class="settings-preview-row header">
          <span>Lab</span>
          <span class="settings-preview-num">Current</span>
          <span class="settings-preview-num">New</span>
          <span class="settings-preview-delta">Delta</span>
        </div>
        <div id="decisionPreviewRows">${_renderDecisionPreviewRows()}</div>
      </div>
    </div>
  `;
}

function _renderDecisionPreviewRows() {
  if (!_allPerfData || !_allPerfData.length) {
    return '<div class="settings-preview-row"><span class="metrics-example-loading">Loading examples...</span></div>';
  }
  return DECISION_PREVIEW_LABS.map((labName) => {
    const row = _allPerfData.find((r) => r.lab === labName || r.lab.startsWith(labName));
    if (!row) return '';
    const originalScore = row.calibration_score != null ? row.calibration_score : '-';
    const newScore = _calcCalibScore(row.ece, row.mce, row.bss_pct, _draft.decision);
    const delta = (newScore != null && originalScore !== '-')
      ? newScore - originalScore : null;
    const deltaClass = delta == null ? 'delta-same'
      : delta > 0 ? 'delta-up' : delta < 0 ? 'delta-down' : 'delta-same';
    const deltaStr = delta == null ? '-' : delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : '0';
    return `<div class="settings-preview-row">
      <span>${labName}</span>
      <span class="settings-preview-num navy-num">${originalScore}</span>
      <span class="settings-preview-num navy-num">${newScore != null ? newScore : '-'}</span>
      <span class="settings-preview-delta ${deltaClass}">${deltaStr}</span>
    </div>`;
  }).join('');
}

function _bssModeText(isGate, floorPct) {
  if (isGate) {
    return `Gate mode: a well-calibrated model always gets at least <strong>${floorPct}%</strong> of its calibration score, even if BSS is zero. The full score is reached when BSS reaches the saturation point above. This avoids crushing models that are well-calibrated but have low base-rate variability.`;
  }
  return `Multiply mode: calibration score is multiplied by max(0, BSS). If BSS = 0 (no skill above a naive baseline), the score is zero even if the model is perfectly calibrated. Use this only when skill is a strict requirement.`;
}

function _decisionFormulaText(ecePct, mcePct, isGate, floorPct, fullPct) {
  const calibPart = `Calibration = ${ecePct}% x (1-ECE) + ${mcePct}% x (1-MCE)`;
  if (isGate) {
    return `${calibPart}  |  BSS-gate: floor=${floorPct}%, saturates at BSS=${fullPct}%`;
  }
  return `${calibPart}  |  Score = Calibration x max(0, BSS)`;
}

// ── Block 3: Stability thresholds ────────────────────────────────────────────

function _renderStabBlock() {
  const labs = Object.keys(_stabThresholds || {}).sort();
  if (!labs.length) {
    return '<div class="settings-note">No lab threshold data available.</div>';
  }

  const overrides = window._stabilityOverrides || {};

  const rows = labs.map((lab) => {
    const defaultVal = _stabThresholds[lab];
    const currentVal = overrides[lab] != null ? overrides[lab] : defaultVal;
    const isEdited = overrides[lab] != null && overrides[lab] !== defaultVal;
    return `
      <div class="stab-row${isEdited ? ' stab-edited' : ''}" data-lab="${lab}">
        <span class="stab-lab-name">${lab}</span>
        <span class="stab-default" title="Registry default">${defaultVal}</span>
        <input
          type="number"
          class="stab-input"
          data-lab="${lab}"
          data-default="${defaultVal}"
          value="${currentVal}"
          min="0"
          step="any"
          aria-label="Stability threshold for ${lab}"
        />
        <button class="stab-reset-btn" data-lab="${lab}" title="Reset to registry default">&#8635;</button>
      </div>`;
  }).join('');

  return `
    <div class="settings-note" style="margin-bottom:var(--sp-3)">
      The stability window is <strong>prev_value &plusmn; threshold</strong>.
      If the model predicts the next value will fall inside this window, the test is classified as <em>stable</em> (skip).
      Widening the threshold makes the model more likely to skip; narrowing it makes repeat more likely.
      Changes apply per-request - the registry files are never modified.
    </div>
    <div class="stab-search-row">
      <input type="text" id="stabSearchInput" class="stab-search" placeholder="Filter labs..." aria-label="Filter labs" />
      <button id="stabResetAllBtn" class="stab-reset-all-btn">Reset all to defaults</button>
    </div>
    <div class="stab-table-head">
      <span>Lab</span>
      <span>Default</span>
      <span>Current</span>
      <span></span>
    </div>
    <div id="stabRowsContainer" class="stab-rows">
      ${rows}
    </div>
  `;
}

function _bindStabControls() {
  const container = document.getElementById('stabRowsContainer');
  if (!container) return;

  // Live edit - update window._stabilityOverrides immediately
  container.addEventListener('input', (e) => {
    const inp = e.target;
    if (!inp.classList.contains('stab-input')) return;
    const lab = inp.dataset.lab;
    const def = parseFloat(inp.dataset.default);
    const val = parseFloat(inp.value);
    if (!isFinite(val) || val < 0) return;
    if (!window._stabilityOverrides) window._stabilityOverrides = {};
    if (val === def) {
      delete window._stabilityOverrides[lab];
    } else {
      window._stabilityOverrides[lab] = val;
    }
    const row = inp.closest('.stab-row');
    if (row) row.classList.toggle('stab-edited', val !== def);
  });

  // Per-row reset button
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.stab-reset-btn');
    if (!btn) return;
    const lab = btn.dataset.lab;
    const def = parseFloat(btn.closest('.stab-row').querySelector('.stab-input').dataset.default);
    const inp = btn.closest('.stab-row').querySelector('.stab-input');
    inp.value = def;
    if (window._stabilityOverrides) delete window._stabilityOverrides[lab];
    btn.closest('.stab-row').classList.remove('stab-edited');
  });

  // Filter
  const searchInput = document.getElementById('stabSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.toLowerCase();
      container.querySelectorAll('.stab-row').forEach((row) => {
        row.style.display = row.dataset.lab.toLowerCase().includes(q) ? '' : 'none';
      });
    });
  }

  // Reset all
  const resetAll = document.getElementById('stabResetAllBtn');
  if (resetAll) {
    resetAll.addEventListener('click', () => {
      window._stabilityOverrides = {};
      container.querySelectorAll('.stab-input').forEach((inp) => {
        inp.value = inp.dataset.default;
        inp.closest('.stab-row').classList.remove('stab-edited');
      });
    });
  }
}

// ── Display mode: clinical reliability bands editor ───────────────────────────

function _renderClinicalBandsGroup(kind, title, desc) {
  const b = getClinicalBands(kind);
  const row = (tierKey, tierLabel) => `
    <div class="settings-threshold-row">
      <label>${tierLabel}</label>
      <input type="number" class="clin-band-input" data-kind="${kind}" data-tier="${tierKey}" min="50" max="99" value="${b[tierKey]}" />
    </div>`;
  return `
    <div class="settings-clin-bands-group" style="margin-top:var(--sp-3)">
      <div class="settings-radio-title" style="margin-bottom:var(--sp-1)">${title}</div>
      <div class="settings-radio-desc" style="margin-bottom:var(--sp-2)">${desc}</div>
      ${row('high', 'High - min %')}
      ${row('good', 'Good - min %')}
      ${row('ok', 'Usable - min %')}
    </div>`;
}

// ── Bind display mode controls ───────────────────────────────────────────────

function _bindDisplayModeControls() {
  document.querySelectorAll('input[name="displayMode"]').forEach((radio) => {
    radio.addEventListener('change', () => setDisplayMode(radio.value));
  });
  document.querySelectorAll('.clin-band-input').forEach((input) => {
    input.addEventListener('change', () => {
      const kind = input.dataset.kind;
      const tier = input.dataset.tier;
      const bands = getClinicalBands(kind);
      bands[tier] = parseInt(input.value, 10) || bands[tier];
      setClinicalBands(kind, bands);
    });
  });
}

// ── Bind slider interactions ──────────────────────────────────────────────────

function _bindValueSliders() {
  const smapeSlider = document.getElementById('smapeSlider');
  const nrmseSlider = document.getElementById('nrmseSlider');
  if (!smapeSlider || !nrmseSlider) return;

  function _syncValueSliders(changedKey, newVal) {
    const complement = 100 - newVal;
    if (changedKey === 'smape') {
      smapeSlider.value = newVal;
      nrmseSlider.value = complement;
      document.getElementById('smapeValDisplay').textContent = newVal + '%';
      document.getElementById('nrmseValDisplay').textContent = complement + '%';
      _draft.value.smape_w = newVal / 100;
      _draft.value.nrmse_w = complement / 100;
    } else {
      nrmseSlider.value = newVal;
      smapeSlider.value = complement;
      document.getElementById('nrmseValDisplay').textContent = newVal + '%';
      document.getElementById('smapeValDisplay').textContent = complement + '%';
      _draft.value.nrmse_w = newVal / 100;
      _draft.value.smape_w = complement / 100;
    }
    const sp = Math.round(_draft.value.smape_w * 100);
    const np = Math.round(_draft.value.nrmse_w * 100);
    document.getElementById('valueFormulaDisplay').textContent =
      `Score = ${sp}% x SMAPE-score + ${np}% x NRMSE-score`;
    _updateValuePreview();
  }

  smapeSlider.addEventListener('input', () => _syncValueSliders('smape', +smapeSlider.value));
  nrmseSlider.addEventListener('input', () => _syncValueSliders('nrmse', +nrmseSlider.value));
}

function _bindDecisionControls() {
  const eceSlider    = document.getElementById('eceSlider');
  const mceSlider    = document.getElementById('mceSlider');
  const floorSlider  = document.getElementById('bssFloorSlider');
  const fullSlider   = document.getElementById('bssFullSlider');
  const gateSliders  = document.getElementById('gateSliders');
  const explainer    = document.getElementById('bssModeExplainer');
  const formulaEl    = document.getElementById('decisionFormulaDisplay');

  const _refreshDecisionUI = () => {
    const ep = Math.round(_draft.decision.ece_w * 100);
    const mp = 100 - ep;
    const isGate  = _draft.decision.bss_mode === 'gate';
    const fp = Math.round(_draft.decision.bss_floor * 100);
    const fup = Math.round(_draft.decision.bss_full_at * 100);
    if (formulaEl) formulaEl.textContent = _decisionFormulaText(ep, mp, isGate, fp, fup);
    if (explainer) explainer.innerHTML = _bssModeText(isGate, fp);
    _updateDecisionPreview();
  };

  // BSS mode radios
  document.querySelectorAll('input[name="bssMode"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      _draft.decision.bss_mode = radio.value;
      if (gateSliders) {
        gateSliders.style.display = radio.value === 'gate' ? '' : 'none';
      }
      _refreshDecisionUI();
    });
  });

  // ECE / MCE complement
  if (eceSlider && mceSlider) {
    function _syncEceMce(changedKey, val) {
      const comp = 100 - val;
      if (changedKey === 'ece') {
        eceSlider.value = val;
        mceSlider.value = comp;
        document.getElementById('eceValDisplay').textContent = val + '%';
        document.getElementById('mceValDisplay').textContent = comp + '%';
        _draft.decision.ece_w = val / 100;
        _draft.decision.mce_w = comp / 100;
      } else {
        mceSlider.value = val;
        eceSlider.value = comp;
        document.getElementById('mceValDisplay').textContent = val + '%';
        document.getElementById('eceValDisplay').textContent = comp + '%';
        _draft.decision.mce_w = val / 100;
        _draft.decision.ece_w = comp / 100;
      }
      _refreshDecisionUI();
    }
    eceSlider.addEventListener('input', () => _syncEceMce('ece', +eceSlider.value));
    mceSlider.addEventListener('input', () => _syncEceMce('mce', +mceSlider.value));
  }

  // Floor slider
  if (floorSlider) {
    floorSlider.addEventListener('input', () => {
      const v = +floorSlider.value;
      _draft.decision.bss_floor = v / 100;
      document.getElementById('bssFloorDisplay').textContent = v + '%';
      _refreshDecisionUI();
    });
  }

  // Full-at slider
  if (fullSlider) {
    fullSlider.addEventListener('input', () => {
      const v = +fullSlider.value;
      _draft.decision.bss_full_at = v / 100;
      document.getElementById('bssFullDisplay').textContent = v + '%';
      _refreshDecisionUI();
    });
  }
}

// ── Preview update helpers ────────────────────────────────────────────────────

function _updateValuePreview() {
  const el = document.getElementById('valuePreviewRows');
  if (el) el.innerHTML = _renderValuePreviewRows();
}

function _updateDecisionPreview() {
  const el = document.getElementById('decisionPreviewRows');
  if (el) el.innerHTML = _renderDecisionPreviewRows();
}

// ── Apply / reset ─────────────────────────────────────────────────────────────

function _applyDraft() {
  window._scoringOverride = JSON.parse(JSON.stringify(_draft));
  const note = document.getElementById('settingsApplyNote');
  if (note) note.classList.add('visible');

  // Trigger performance section re-render if it's already loaded
  if (window._perfLoaded && typeof window._refreshLeaderboardScores === 'function') {
    window._refreshLeaderboardScores();
  }

  // Re-run predictions if stability overrides changed and predictions are showing
  if (window._stabilityOverrides && Object.keys(window._stabilityOverrides).length > 0) {
    if (typeof window._rerunPredictions === 'function') {
      window._rerunPredictions();
    }
  }
}

function _resetToDefaults() {
  // Reset draft from the API config (not the window override)
  _draft = _buildDraftFromConfig(_scoringConfig || SCORING_DEFAULTS);
  window._scoringOverride = null;
  // Re-render the modal body with fresh defaults
  const body = document.getElementById('settingsModalBody');
  if (body) _renderSettingsBody(body);
  const note = document.getElementById('settingsApplyNote');
  if (note) note.classList.remove('visible');
  // Re-render leaderboard if open
  if (window._perfLoaded && typeof window._refreshLeaderboardScores === 'function') {
    window._refreshLeaderboardScores();
  }
}

// initSettings() is called from app.js after bootstrap completes.
// The function is safe to call multiple times - event listeners are only added once.
