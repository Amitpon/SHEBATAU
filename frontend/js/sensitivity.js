/**
 * sensitivity.js - Sensitivity Analysis section.
 *
 * Lets the doctor drag sliders to see how each feature shifts the prediction
 * in real time. Fully self-contained. Uses getJSON from app.js.
 *
 * Layout:
 *   1. Selector bar  - lab / patient / model
 *   2. Two panels    - sliders left, live result right
 *   3. Impact chart  - which features moved P(stable) the most
 *   4. What-if table - saved snapshots
 */

// ── Module state ──────────────────────────────────────────────────────────────
const _sens = {
  lab:            null,
  patientId:      null,
  model:          'ngboost',
  labs:           [],     // full lab catalog from /api/labs
  patients:       [],     // demo patients from /api/patients
  norms:          {},     // /api/lab_norms
  baseline:       {},     // baseline features (from patient data)
  current:        {},     // current slider values
  threshold:      0.85,   // decision threshold: min P(stable) to recommend SKIP
  lastResult:     null,   // last POST /api/predict result (active model)
  lastResults:    null,   // both-model result {ngboost, mae} from last run
  snapshots:      [],     // saved what-if scenarios (each holds BOTH models)
  compareSel:     [],     // selected entries to compare: "<snapIdx>:<model>"
  _debounce:      null,
  _impComputing:  false,
  _firstEqLast:   false,  // Change 4: "first in adm = last result" toggle state
  customPatient:  null,   // Change 6: synthetic patient object when __custom__ selected
};

function _sensWindowBounds(windowRange) {
  if (!windowRange) return null;
  const lo = Array.isArray(windowRange) ? windowRange[0] : windowRange.low;
  const hi = Array.isArray(windowRange) ? windowRange[1] : windowRange.high;
  const loNum = Number(lo);
  const hiNum = Number(hi);
  return Number.isFinite(loNum) && Number.isFinite(hiNum) ? [loNum, hiNum] : null;
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function initSensitivitySection() {
  const container = document.getElementById('sensitivity-content');
  if (!container) return;

  try {
    // Load catalog data (may already be loaded by app.js via state, but we
    // fetch independently to keep this module self-contained)
    const [labs, patients, norms] = await Promise.all([
      getJSON('/api/labs'),
      getJSON('/api/patients'),
      getJSON('/api/lab_norms'),
    ]);
    _sens.labs     = labs;
    _sens.patients = patients;
    _sens.norms    = norms;
    _renderSensShell(container);
  } catch (e) {
    container.innerHTML = `<div class="error-text">Failed to load: ${e.message}</div>`;
  }
}

// ── Shell ─────────────────────────────────────────────────────────────────────
function _renderSensShell(container) {
  const labOptions = _sens.labs
    .map((l) => `<option value="${l.lab}">${l.lab}${l.sex_specific ? ' *' : ''}</option>`)
    .join('');
  const patOptions = _sens.patients
    .map((p) => `<option value="${p.id}">${p.name} (${p.sex || '-'}, ${p.age || '-'})</option>`)
    .join('') + '<option value="__custom__">Custom patient (enter manually)</option>';

  container.innerHTML = `
    <!-- Selector bar -->
    <div class="sens-selector-bar">
      <span class="sens-sel-label">Lab</span>
      <select id="sensLabSelect" class="sens-select" aria-label="Select lab">
        <option value="">-- select a lab --</option>
        ${labOptions}
      </select>

      <span class="sens-sel-label">Patient</span>
      <select id="sensPatientSelect" class="sens-select" aria-label="Select patient">
        <option value="">-- select a patient --</option>
        ${patOptions}
      </select>

      <span class="dual-run-badge" title="Both models are always predicted from the same sliders and shown together.">
        <span class="drb-dot ngb"></span>NGBoost <span class="drb-plus">+</span> <span class="drb-dot mae"></span>Masked AE
      </span>
    </div>
    <div class="sens-dual-note" id="sensDualNote">
      Both models predict from the same inputs below - NGBoost first, then Masked AE,
      with an agreement note and which model is better calibrated here.
    </div>

    <!-- Decision threshold: the P(stable) cutoff above which we recommend SKIP -->
    <div class="sens-thr-bar">
      <span class="sens-thr-label" title="A test is recommended to SKIP only when its predicted P(stable) is at least this. Raise it to be more cautious (repeat more); lower it to skip more.">Skip threshold</span>
      <input type="range" id="sensThr" min="0.5" max="0.99" step="0.01" value="0.85" aria-label="Decision threshold - minimum P(stable) to recommend skipping" />
      <input type="number" id="sensThrVal" class="sens-thr-num" min="0.5" max="0.99" step="0.01" value="0.85"
             title="Type an exact skip threshold (0.50–0.99)" aria-label="Skip threshold - type exact value" />
      <span class="sens-thr-hint">recommend SKIP only when P(stable) &ge; this (applies to both models)</span>
    </div>

    <!-- Two-panel layout -->
    <div class="sens-two-panel" id="sensTwoPanelWrap">
      <!-- Sliders -->
      <div class="sens-sliders-panel" id="sensSlidersPanel">
        <div class="sens-sliders-header">
          <span>Feature inputs - drag or type to explore</span>
          <button class="btn-sens-reset" id="btnSensReset" disabled
                  title="Restore every input to this patient's original values">&#8634; Reset to baseline</button>
        </div>
        <div class="sens-sliders-body" id="sensSlidersBody">
          <div class="sens-chart-placeholder">Select a lab and patient above.</div>
        </div>
        <!-- Recommendation based on BOTH models -->
        <div class="sens-rec-box" id="sensRecBox"></div>
      </div>

      <!-- Live result -->
      <div class="sens-result-panel" id="sensResultPanel">
        <div class="sens-result-header">Live prediction</div>
        <div class="sens-result-body" id="sensResultBody">
          <div class="sens-chart-placeholder">Waiting for inputs...</div>
        </div>
      </div>
    </div>

    <!-- Impact charts - BOTH models side by side, to compare what each relies on -->
    <div class="sens-chart-card">
      <div class="sens-chart-header">
        <div>
          <span class="sens-chart-title">Feature importance - both models side by side</span>
          <span class="sens-chart-hint"> - compare what drives each model: similar drivers = they "see" the test the same way; different drivers = they reason differently.</span>
        </div>
      </div>
      <div class="sens-imp-dual" id="sensImpDual">
        <div class="sens-imp-col">
          <div class="sens-imp-col-head"><span class="ngb-model-tag">NGBoost</span> feature importance</div>
          <div class="sens-chart-body" id="sensImpBodyNg">
            <div class="sens-chart-placeholder">Run a prediction to see feature importance.</div>
          </div>
        </div>
        <div class="sens-imp-col">
          <div class="sens-imp-col-head"><span class="mae-model-tag">Masked AE</span> attention (token importance)</div>
          <div class="sens-chart-body" id="sensImpBodyMae">
            <div class="sens-chart-placeholder">Run a prediction to see attention weights.</div>
          </div>
        </div>
      </div>
    </div>

    <!-- What-if snapshots -->
    <div class="sens-snapshots-card">
      <div class="sens-snapshots-header">
        <span class="sens-snapshots-title">What-if scenarios</span>
        <button class="btn-save-snapshot" id="btnSaveSnapshot" disabled>Save snapshot</button>
      </div>
      <div class="sens-snapshots-body" id="sensSnapshotsBody">
        <div class="sens-snapshots-empty">No snapshots saved yet. Adjust sliders and click "Save snapshot".</div>
      </div>
    </div>

    <!-- Back to Patient -->
    <button class="sens-back-btn" id="sensBackBtn">
      &#8592; Back to Patient with this lab pre-selected
    </button>
  `;

  // No importance toggle: both models' feature importance are shown side by side.

  // Bind selectors
  document.getElementById('sensLabSelect').onchange = _onSensSelChange;
  document.getElementById('sensPatientSelect').onchange = _onSensSelChange;
  document.getElementById('btnSaveSnapshot').onclick = _saveSnapshot;
  const btnReset = document.getElementById('btnSensReset');
  if (btnReset) btnReset.onclick = _resetSensToBaseline;

  // Decision-threshold: drag the slider OR type an exact value into the field;
  // the two stay in sync and re-predict (both models) live.
  const thr     = document.getElementById('sensThr');
  const thrNum  = document.getElementById('sensThrVal');
  const repredict = () => {
    if (_sens.lab && (_sens.patientId || _sens.customPatient)) {
      clearTimeout(_sens._debounce);
      _sens._debounce = setTimeout(_runSensPrediction, 250);
    }
  };
  if (thr) {
    thr.addEventListener('input', () => {
      _sens.threshold = parseFloat(thr.value);
      if (thrNum) thrNum.value = _sens.threshold.toFixed(2);
      repredict();
    });
  }
  if (thrNum) {
    const applyThr = (commit) => {
      let v = parseFloat(thrNum.value);
      if (!Number.isFinite(v)) { if (commit) thrNum.value = _sens.threshold.toFixed(2); return; }
      v = Math.min(Math.max(v, 0.5), 0.99);
      if (commit) thrNum.value = v.toFixed(2);
      _sens.threshold = v;
      if (thr) thr.value = v;
      repredict();
    };
    thrNum.addEventListener('input', () => applyThr(false));
    thrNum.addEventListener('change', () => applyThr(true));
    thrNum.addEventListener('blur', () => applyThr(true));
    thrNum.addEventListener('keydown', (e) => { if (e.key === 'Enter') { applyThr(true); thrNum.blur(); } });
  }
  document.getElementById('sensBackBtn').onclick = () => {
    if (_sens.lab && typeof switchToPatientWithLab === 'function') {
      switchToPatientWithLab(_sens.lab);
    } else if (typeof switchSection === 'function') {
      switchSection('patient');
    }
  };
}

// ── Selector change ───────────────────────────────────────────────────────────
async function _onSensSelChange() {
  const labSel    = document.getElementById('sensLabSelect');
  const patSel    = document.getElementById('sensPatientSelect');
  const lab       = labSel ? labSel.value : '';
  const patientId = patSel ? patSel.value : '';

  // Always hide/remove previous custom form when selection changes
  const existingForm = document.getElementById('sensCustomPatientForm');
  if (existingForm) existingForm.remove();

  if (!lab || !patientId) return;

  // Change 6: custom patient flow
  if (patientId === '__custom__') {
    _sens.lab       = lab;
    _sens.patientId = '__custom__';
    _sens.snapshots = [];
    _sens.compareSel = [];
    _sens.lastResult = null;
    _sens.customPatient = null;

    // Show inline form below the selector bar
    const selectorBar = document.querySelector('.sens-selector-bar');
    if (selectorBar) {
      const form = document.createElement('div');
      form.id = 'sensCustomPatientForm';
      form.className = 'sens-custom-form';
      form.innerHTML = `
        <label for="sensCustomAge">Age</label>
        <input type="number" id="sensCustomAge" min="1" max="120" placeholder="e.g. 65" style="width:70px" />
        <label for="sensCustomSex">Sex</label>
        <select id="sensCustomSex">
          <option value="">Unknown</option>
          <option value="M">M</option>
          <option value="F">F</option>
        </select>
        <button class="btn-sens-confirm" id="btnSensCustomConfirm">Confirm</button>`;
      selectorBar.insertAdjacentElement('afterend', form);

      document.getElementById('btnSensCustomConfirm').addEventListener('click', async () => {
        const age = parseInt(document.getElementById('sensCustomAge').value, 10) || null;
        const sex = document.getElementById('sensCustomSex').value || null;
        _sens.customPatient = {
          id: '__custom__',
          name: 'Custom patient',
          age,
          sex,
          labs: {},
        };
        form.remove();
        await _loadSensForPatient(lab, '__custom__', _sens.customPatient);
      });
    }
    return;  // wait for Confirm before loading sliders
  }

  // Normal patient flow
  const patient = _sens.patients.find((p) => p.id === patientId) || null;
  await _loadSensForPatient(lab, patientId, patient);
}

// Shared logic: called after patient is confirmed (normal or custom)
async function _loadSensForPatient(lab, patientId, patient) {
  _sens.lab       = lab;
  _sens.patientId = patientId;
  _sens.snapshots = [];
  _sens.compareSel = [];
  _sens.lastResult = null;

  const featureCols = _sensFeatureCols(lab, patient);

  // Build baseline from patient's stored features if available
  const storedFeats = (patient && patient.labs && patient.labs[lab] && patient.labs[lab].features) || {};

  const baseline = {};
  featureCols.forEach((col) => {
    if (storedFeats[col] !== undefined) {
      baseline[col] = storedFeats[col];
    } else {
      baseline[col] = _sensDefaultValue(col, lab, patient);
    }
  });

  _sens.baseline = { ...baseline };
  _sens.current  = { ...baseline };

  _renderSensSliders(featureCols, lab, patient);
  const btnReset = document.getElementById('btnSensReset');
  if (btnReset) btnReset.disabled = false;
  await _runSensPrediction();
  _renderSnapshotsTable();
}

// Reset every input back to this patient's original (baseline) values, then re-predict.
function _resetSensToBaseline() {
  if (!_sens.lab || !Object.keys(_sens.baseline).length) return;
  _sens.current = { ..._sens.baseline };
  const patient = _sens.patientId === '__custom__'
    ? _sens.customPatient
    : _sens.patients.find((p) => p.id === _sens.patientId);
  const featureCols = _sensFeatureCols(_sens.lab, patient);
  _renderSensSliders(featureCols, _sens.lab, patient);  // re-renders rows from baseline
  _runSensPrediction();
}

// Union of the inputs BOTH models use, so a single slider set drives both at once.
// Sourced from the backend /api/input_schemas (loaded into the global `state`),
// which is the genuine per-model input contract (NGBoost cols + MAE prev2/prev3,
// age, days_in_admission, panel siblings). Derived inputs are excluded.
function _sensFeatureCols(lab, patient) {
  const cols = new Set();
  const schema = (typeof state !== 'undefined' && state.inputSchemas && state.inputSchemas[lab]) || null;
  if (schema && schema.union) {
    schema.union.forEach((c) => cols.add(c));
  } else {
    const labMeta = _sens.labs.find((l) => l.lab === lab) || null;
    (labMeta && labMeta.feature_cols || []).forEach((c) => cols.add(c));   // NGBoost
    cols.add(`prev1_${lab}`); cols.add(`first_in_adm_${lab}`); cols.add(`days_since_last_${lab}`);
  }
  const block = patient && patient.labs && patient.labs[lab];
  Object.keys((block && block.features) || {}).forEach((c) => cols.add(c)); // stored values
  return [...cols].filter((c) =>
    !c.startsWith('mae__') && !c.startsWith('mae_time__') &&
    c !== 'sex_numeric' && c !== 'sex_code' && !/_delta$/.test(c));
}

// Which model(s) use a slider, for the per-slider tag.
function _sensFeatureModels(lab, col) {
  const schema = (typeof state !== 'undefined' && state.inputSchemas && state.inputSchemas[lab]) || null;
  if (schema && schema.models_by_feature && schema.models_by_feature[col]) return schema.models_by_feature[col];
  return [];
}
function _sensModelTag(lab, col) {
  const ms = _sensFeatureModels(lab, col);
  if (!ms.length) return '';
  if (ms.length === 2) return '<span class="feat-model-tag both" title="Used by both models">both</span>';
  if (ms[0] === 'ngboost') return '<span class="feat-model-tag ngb" title="Used by NGBoost only">NGB</span>';
  return '<span class="feat-model-tag mae" title="Used by Masked AE only">MAE</span>';
}

// Compute a sensible default for a feature when the patient has no stored value
function _sensDefaultValue(col, lab, patient) {
  const norms = _sens.norms;

  if (col === 'age' && patient && patient.age) return patient.age;

  const vitalDefaults = {
    pulse: 75, sbp: 120, dbp: 75,
    temperature: 37.0, spo2: 97, rr: 16, gcs: 15,
    test_number_in_admission: 3, test_number_overall: 5,
    days_in_admission: 3, num_high_risk_drugs: 1,
    sex_numeric: patient && patient.sex === 'M' ? 1 : 0,
  };
  if (vitalDefaults[col] !== undefined) return vitalDefaults[col];

  const m = col.match(/^(?:first_in_adm_|prev1_|prev2_|prev3_)(.+)$/);
  if (m) {
    const n = norms[m[1]];
    if (n && n.typical != null) return n.typical;
  }
  if (col.match(/^days_since_last_/)) return 1;
  const n = norms[col];
  if (n && n.typical != null) return n.typical;
  return 0;
}

// Compute slider range for a feature.
// Bounds = clip_floor/clip_ceiling from lab_norms (trained artifact, never invented).
// Step   = quant_step from registry (lab's actual reporting resolution).
function _sensSliderRange(col, lab) {
  const norms = _sens.norms;

  const vitalRanges = {
    pulse: [40, 160, 1], sbp: [60, 220, 1], dbp: [40, 140, 1],
    temperature: [35.0, 41.0, 0.1], spo2: [70, 100, 1],
    rr: [8, 40, 1], gcs: [3, 15, 1], age: [1, 100, 1],
    test_number_in_admission: [1, 20, 1], test_number_overall: [1, 50, 1],
    days_in_admission: [1, 60, 1], num_high_risk_drugs: [0, 10, 1],
    sex_numeric: [0, 1, 1],
  };
  if (vitalRanges[col]) return vitalRanges[col];

  if (col.match(/^days_since_last_/)) return [0, 30, 1];

  const m = col.match(/^(?:first_in_adm_|prev1_|prev2_|prev3_)(.+)$/);
  if (m) {
    const n = norms[m[1]];
    if (n) {
      const lo   = n.low  != null ? n.low  : (n.typical != null ? n.typical * 0.3 : 0);
      const hi   = n.high != null ? n.high : (n.typical != null ? n.typical * 3   : 100);
      const step = (n.quant_step && n.quant_step > 0) ? n.quant_step
                 : ((hi - lo) <= 10 ? 0.1 : (hi - lo) <= 100 ? 1 : 5);
      return [lo, hi, step];
    }
  }
  const n = norms[col];
  if (n && n.typical != null) {
    const lo   = n.low  != null ? n.low  : n.typical * 0.3;
    const hi   = n.high != null ? n.high : n.typical * 3;
    const step = (n.quant_step && n.quant_step > 0) ? n.quant_step
               : ((hi - lo) <= 10 ? 0.1 : 1);
    return [lo, hi, step];
  }
  return [0, 100, 1];
}

// ── Render sliders ────────────────────────────────────────────────────────────
function _renderSensSliders(featureCols, lab, patient) {
  const body = document.getElementById('sensSlidersBody');
  if (!body) return;

  if (!featureCols.length) {
    body.innerHTML = '<div class="sens-chart-placeholder">No features for this lab.</div>';
    return;
  }

  // Change 4: detect if both first_in_adm_X and prev1_X exist
  const firstKey = `first_in_adm_${lab}`;
  const prev1Key  = `prev1_${lab}`;
  const hasBoth   = featureCols.includes(firstKey) && featureCols.includes(prev1Key);

  // Build checkbox HTML (shown only when both keys exist)
  const checkboxHtml = hasBoth ? `
    <div class="sens-first-eq-last" id="sensFirstEqLastRow">
      <input type="checkbox" id="sensFirstEqLastChk"
             ${_sens._firstEqLast ? 'checked' : ''}
             aria-label="First test in admission equals last result" />
      <label for="sensFirstEqLastChk">
        First test in admission = last result
        <span style="color:var(--muted);font-weight:400"> (check when patient had only one test this admission)</span>
      </label>
      ${_sens._firstEqLast ? '<span style="font-size:11px;color:var(--teal-dark);margin-left:4px">first_in_adm locked to prev1</span>' : ''}
    </div>` : '';

  const sliderRows = featureCols.map((col) => {
    const [lo, hi, step] = _sensSliderRange(col, lab);
    const val     = _sens.current[col] != null ? _sens.current[col] : (lo + hi) / 2;
    const safeCol = col.replace(/[^a-zA-Z0-9]/g, '_');
    const label   = _sensLabel(col);
    const decimals = step < 1 ? String(step).split('.')[1].length : 0;

    // Change 4: hide first_in_adm slider when toggle is on
    const hidden = hasBoth && col === firstKey && _sens._firstEqLast ? 'style="display:none"' : '';

    // G: range + typical hint displayed below the slider
    const normKey = (() => {
      const mm = col.match(/^(?:first_in_adm_|prev1_)(.+)$/);
      return mm ? mm[1] : col;
    })();
    const nHint = _sens.norms[normKey];
    const typical = (nHint && nHint.typical != null) ? +nHint.typical : null;
    const spread  = (nHint && nHint.spread  != null) ? +nHint.spread  : null;
    const typicalStr = typical != null ? ` typical ${typical.toFixed(decimals)}` : '';
    const rangeHint  = `[${(+lo).toFixed(decimals)}–${(+hi).toFixed(decimals)}${typicalStr}]`;
    // out-of-typical: value sits more than 2 RMSE (spread) from the lab's mean.
    // typical+spread are trained values from lab_norms (never invented). Warn only.
    const unusual = (typical != null && spread != null && spread > 0)
      ? Math.abs(val - typical) > 2 * spread : false;
    const typAttrs = (typical != null && spread != null)
      ? `data-typical="${typical}" data-spread="${spread}"` : '';

    return `<div class="sens-slider-row" id="sensRow_${safeCol}" ${hidden}>
      <span class="sens-slider-label" title="${col}">${label} ${_sensModelTag(lab, col)}</span>
      <input type="range" class="sens-slider-input" id="sensSlider_${safeCol}"
             min="${lo}" max="${hi}" step="${step}"
             value="${Math.min(Math.max(val, lo), hi)}"
             data-col="${col}" data-decimals="${decimals}"
             aria-label="${label}" />
      <input type="number" class="sens-slider-num" id="sensNum_${safeCol}"
             min="${lo}" max="${hi}" step="${step}"
             value="${(+val).toFixed(decimals)}"
             data-col="${col}" data-decimals="${decimals}" data-lo="${lo}" data-hi="${hi}" ${typAttrs}
             title="Type an exact value (allowed range ${(+lo).toFixed(decimals)}–${(+hi).toFixed(decimals)})"
             aria-label="${label} - type exact value" />
      <span class="sens-range-hint">${rangeHint}
        <span class="sens-typical-flag" id="sensFlag_${safeCol}" ${unusual ? '' : 'hidden'}
              title="More than 2× the lab's typical spread (RMSE) from its mean - unusual but allowed.">&#9888; unusual for this lab</span>
      </span>
    </div>`;
  }).join('');

  body.innerHTML = checkboxHtml + sliderRows;

  // Bind checkbox for Change 4
  if (hasBoth) {
    const chk = document.getElementById('sensFirstEqLastChk');
    if (chk) {
      chk.addEventListener('change', () => {
        _sens._firstEqLast = chk.checked;
        const firstSafe  = firstKey.replace(/[^a-zA-Z0-9]/g, '_');
        const prev1Safe  = prev1Key.replace(/[^a-zA-Z0-9]/g, '_');
        const firstRow   = document.getElementById(`sensRow_${firstSafe}`);
        const noteEl     = document.querySelector('.sens-first-eq-last span[style*="teal"]');

        if (chk.checked) {
          // Sync first_in_adm to current prev1 value and hide the slider
          if (firstRow) firstRow.style.display = 'none';
          const prev1Val = _sens.current[prev1Key];
          if (prev1Val != null) {
            _sens.current[firstKey] = prev1Val;
          }
          // Show lock note
          const row = document.getElementById('sensFirstEqLastRow');
          if (row && !row.querySelector('.feleq-note')) {
            const note = document.createElement('span');
            note.className = 'feleq-note';
            note.style.cssText = 'font-size:11px;color:var(--teal-dark);margin-left:4px';
            note.textContent = 'first_in_adm locked to prev1';
            row.appendChild(note);
          }
        } else {
          // Restore slider to its own value (reset to baseline)
          if (firstRow) firstRow.style.display = '';
          _sens.current[firstKey] = _sens.baseline[firstKey] != null
            ? _sens.baseline[firstKey]
            : _sens.current[firstKey];
          // Update displayed value
          const numEl   = document.getElementById(`sensNum_${firstSafe}`);
          const sliderEl = document.getElementById(`sensSlider_${firstSafe}`);
          if (numEl && sliderEl) {
            const dec = parseInt(sliderEl.dataset.decimals, 10) || 0;
            sliderEl.value = _sens.current[firstKey];
            numEl.value = (+_sens.current[firstKey]).toFixed(dec);
          }
          // Remove lock note
          const note = document.querySelector('.feleq-note');
          if (note) note.remove();
        }
        clearTimeout(_sens._debounce);
        _sens._debounce = setTimeout(_runSensPrediction, 300);
      });
    }
  }

  // Bind slider events
  body.querySelectorAll('.sens-slider-input').forEach((slider) => {
    slider.addEventListener('input', () => {
      const col      = slider.dataset.col;
      const decimals = parseInt(slider.dataset.decimals, 10) || 0;
      const val      = parseFloat(slider.value);
      const safeCol  = col.replace(/[^a-zA-Z0-9]/g, '_');

      _sens.current[col] = val;

      // Change 4: if this is prev1_X and toggle is on, sync first_in_adm_X silently
      if (hasBoth && col === prev1Key && _sens._firstEqLast) {
        _sens.current[firstKey] = val;
      }

      // Update the editable number field to match
      const numEl = document.getElementById(`sensNum_${safeCol}`);
      if (numEl) numEl.value = val.toFixed(decimals);

      // Mark as changed vs baseline
      const baseline = _sens.baseline[col];
      const changed  = baseline != null && Math.abs(val - baseline) > 0.001;
      slider.classList.toggle('sens-slider-changed', changed);
      if (numEl) numEl.classList.toggle('sens-num-changed', changed);
      _sensUpdateTypicalFlag(safeCol, val);

      // Debounced predict
      clearTimeout(_sens._debounce);
      _sens._debounce = setTimeout(_runSensPrediction, 300);
    });
  });

  // Bind the editable number fields: typing an exact value drives the slider too.
  // Value is clamped to the lab's trained clip bounds (slider min/max) so we never
  // form a prediction outside the range the model was calibrated on.
  body.querySelectorAll('.sens-slider-num').forEach((numInput) => {
    const apply = (commit) => {
      const col      = numInput.dataset.col;
      const decimals = parseInt(numInput.dataset.decimals, 10) || 0;
      const lo       = parseFloat(numInput.dataset.lo);
      const hi       = parseFloat(numInput.dataset.hi);
      const safeCol  = col.replace(/[^a-zA-Z0-9]/g, '_');

      let val = parseFloat(numInput.value);
      if (!Number.isFinite(val)) {
        if (commit) numInput.value = (+_sens.current[col]).toFixed(decimals);
        return;
      }
      // Clamp to the trained range
      const clamped = Math.min(Math.max(val, lo), hi);
      if (commit && clamped !== val) numInput.value = clamped.toFixed(decimals);
      val = clamped;

      _sens.current[col] = val;

      // Keep the slider thumb in sync
      const sliderEl = document.getElementById(`sensSlider_${safeCol}`);
      if (sliderEl) sliderEl.value = val;

      // Change 4: if this is prev1_X and toggle is on, sync first_in_adm_X silently
      if (hasBoth && col === prev1Key && _sens._firstEqLast) {
        _sens.current[firstKey] = val;
      }

      // Mark as changed vs baseline
      const baseline = _sens.baseline[col];
      const changed  = baseline != null && Math.abs(val - baseline) > 0.001;
      if (sliderEl) sliderEl.classList.toggle('sens-slider-changed', changed);
      numInput.classList.toggle('sens-num-changed', changed);
      _sensUpdateTypicalFlag(safeCol, val);

      clearTimeout(_sens._debounce);
      _sens._debounce = setTimeout(_runSensPrediction, 300);
    };
    // Live as they type, and a final clamp/normalize when they leave or press Enter
    numInput.addEventListener('input', () => apply(false));
    numInput.addEventListener('change', () => apply(true));
    numInput.addEventListener('blur', () => apply(true));
    numInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { apply(true); numInput.blur(); } });
  });
}

// Toggle the "unusual for this lab" flag on a row, using the trained typical (mean)
// and spread (RMSE) stashed on the number input. >2 spreads from the mean = unusual.
// This only WARNS - the value is still allowed (and already clamped to clip bounds).
function _sensUpdateTypicalFlag(safeCol, val) {
  const flag = document.getElementById(`sensFlag_${safeCol}`);
  const numEl = document.getElementById(`sensNum_${safeCol}`);
  if (!flag || !numEl) return;
  const typical = parseFloat(numEl.dataset.typical);
  const spread  = parseFloat(numEl.dataset.spread);
  if (!Number.isFinite(typical) || !Number.isFinite(spread) || spread <= 0) { flag.hidden = true; return; }
  const unusual = Math.abs(val - typical) > 2 * spread;
  flag.hidden = !unusual;
  numEl.classList.toggle('sens-num-unusual', unusual);
}

// Human-readable label for a feature column
function _sensLabel(col) {
  const m1 = col.match(/^first_in_adm_(.+)$/);
  if (m1) return `First ${m1[1]} (adm.)`;
  const m2 = col.match(/^prev1_(.+)$/);
  if (m2) return `Prev ${m2[1]}`;
  const mp2 = col.match(/^prev2_(.+)$/);
  if (mp2) return `Prev-2 ${mp2[1]}`;
  const mp3 = col.match(/^prev3_(.+)$/);
  if (mp3) return `Prev-3 ${mp3[1]}`;
  const m3 = col.match(/^days_since_last_(.+)$/);
  if (m3) return `Days since ${m3[1]}`;
  const named = {
    pulse: 'Pulse', sbp: 'Sys. BP', dbp: 'Dias. BP',
    temperature: 'Temp', spo2: 'SpO2', rr: 'Resp. rate',
    gcs: 'GCS', age: 'Age', num_high_risk_drugs: 'High-risk drugs',
    test_number_in_admission: 'Test # (adm.)', test_number_overall: 'Test # (total)',
    days_in_admission: 'Days admitted',
    sex_numeric: 'Sex (0=F, 1=M)',
  };
  return named[col] || col.replace(/_/g, ' ');
}

// ── Run prediction ────────────────────────────────────────────────────────────
async function _runSensPrediction() {
  if (!_sens.lab || !_sens.patientId) return;
  const resultBody = document.getElementById('sensResultBody');
  if (resultBody) resultBody.classList.add('sens-result-updating');

  // Change 6: resolve patient (custom or from list)
  const patient = _sens.patientId === '__custom__'
    ? _sens.customPatient
    : _sens.patients.find((p) => p.id === _sens.patientId);
  const sex = patient ? patient.sex : null;

  // Change 6: for custom patient send patient_id: null and include age/sex in features
  const isCustom   = _sens.patientId === '__custom__';
  const patientId  = isCustom ? null : _sens.patientId;
  const featPayload = { ..._sens.current };
  if (isCustom && patient) {
    if (patient.age != null)  featPayload.age = patient.age;
    if (patient.sex != null)  featPayload.sex_code = patient.sex === 'M' ? 1 : patient.sex === 'F' ? 0 : null;
  }

  try {
    // Always run BOTH models from the same inputs so the per-model difference is
    // visible live; the toggle only chooses which is the headline.
    const results = await getJSON('/api/predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lab:                _sens.lab,
        patient_id:         patientId,
        features:           featPayload,
        decision_threshold: _sens.threshold,
        models:             ['ngboost', 'mae'],
        sex,
      }),
    });
    _sens.lastResults = results;
    const okk = (r) => r && r.available !== false && !r.error;
    // Snapshot subject = headline (NGBoost-preferred); importance chart follows the toggle.
    _sens.lastResult = okk(results.ngboost) ? results.ngboost
                     : okk(results.mae) ? results.mae
                     : (results.ngboost || results.mae || null);
    _renderSensResultDual(results);
    _renderSensRecommendation(results);
    _renderDualImportances(results);

    // Enable snapshot once a usable headline result exists
    const btnSnap = document.getElementById('btnSaveSnapshot');
    if (btnSnap) btnSnap.disabled = !_sens.lastResult || _sens.lastResult.available === false;

  } catch (e) {
    if (resultBody) {
      resultBody.innerHTML = `<div class="error-text" style="font-size:12px">Prediction failed: ${e.message}</div>`;
    }
    const recBox = document.getElementById('sensRecBox');
    if (recBox) recBox.innerHTML = '';
  } finally {
    if (resultBody) resultBody.classList.remove('sens-result-updating');
  }
}

// Render BOTH models every time in the SAME full format - NGBoost first, then Masked
// AE beneath the same way - plus an agreement/recommendation banner. If a model has no
// model for this lab, its block shows "not available" (never blank).
function _renderSensResultDual(results) {
  const body = document.getElementById('sensResultBody');
  if (!body) return;
  const ng  = results ? results.ngboost : null;
  const mae = results ? results.mae : null;
  // The agreement/recommendation banner lives under the sliders (left), not here -
  // this panel stays a clean, readable side-by-side of the two predictions.
  body.innerHTML =
    _sensResultPrimaryHtml(ng, 'ngboost')
    + '<div class="sens-model-divider"></div>'
    + _sensResultPrimaryHtml(mae, 'mae');
}

// Recommendation block shown BELOW the sliders (left column): the action we advise
// based on BOTH models + the agreement/calibration explanation.
function _renderSensRecommendation(results) {
  const box = document.getElementById('sensRecBox');
  if (!box) return;
  const ng  = results ? results.ngboost : null;
  const mae = results ? results.mae : null;
  const ok = (r) => r && r.available !== false && !r.error && r.decision;
  if (!ok(ng) && !ok(mae)) { box.innerHTML = ''; return; }

  const v = modelVerdict(ng, mae);
  let action;
  if (v.state === 'single')      action = (v.only === 'mae' ? mae : ng).decision;
  else if (v.state === 'agree')  action = v.decision;
  else                           action = (v.recommended === 'ngboost' ? v.ngDecision : v.maeDecision);
  const isRepeat = action === 'repeat';
  const banner = (typeof modelVerdictBanner === 'function') ? modelVerdictBanner(v) : '';

  box.innerHTML = `
    <div class="sens-rec-head">Recommendation - based on both models</div>
    <div class="sens-rec-action ${isRepeat ? 'repeat' : 'skip'}">
      ${isRepeat ? '&#8635; REPEAT - draw the test' : '&#10003; SKIP - the test can be deferred'}
    </div>
    ${banner}`;
}

function _sensModelLabel(model) { return model === 'mae' ? 'Masked AE' : 'NGBoost'; }

// ── Render live result panel ──────────────────────────────────────────────────
// Returns the HTML for the headline model's full result block (model tag + value,
// CI, sigma, window, P(stable), decision, trust). Caller sets innerHTML.
function _sensResultPrimaryHtml(r, model, subtitle) {
  const tag = _sensModelLabel(model);
  const sub = subtitle != null ? subtitle : '';
  const tagHtml = `<div class="sens-primary-tagrow"><span class="sens-model-tag ${model === 'mae' ? 'mae-tag' : 'ngb-tag'} sens-primary-tag">${tag}</span>${sub ? `<span class="sens-primary-tag-hint">${sub}</span>` : ''}</div>`;

  // Handle unavailable / error result (e.g. MAE not covering this lab or NaN prediction)
  if (!r || r.available === false) {
    const reason = r ? (r.error || r.message || 'Model not available for this lab') : 'No result';
    return `${tagHtml}<div class="sens-unavail-block">
      <span class="sens-model-tag ${model === 'mae' ? 'mae-tag' : 'ngb-tag'}">${tag}</span>
      <span class="sens-unavail-reason">${reason}</span>
    </div>`;
  }

  const dec    = r.decision === 'skip';
  const pStab  = r.p_stable != null ? (r.p_stable * 100).toFixed(1) + '%' : '-';
  const pColor = dec ? 'var(--green)' : 'var(--red)';

  const q      = r.quant_step;
  const val    = _sensQfmt(r.value != null ? r.value : r.mu, q);
  const ci     = r.ci95 ? `[${_sensQfmt(Math.max(r.ci95[0], 0), q)} - ${_sensQfmt(r.ci95[1], q)}]` : '';

  const rel    = r.reliability || {};
  const vScore = rel.value_score       != null ? rel.value_score       : '-';
  const cScore = rel.calibration_score != null ? rel.calibration_score : '-';
  const vColor = _sensScoreColor(rel.value_score);
  const cColor = _sensScoreColor(rel.calibration_score);

  // FIX 1: compute sigma from ci95 for display
  const sigmaDisplay = r.ci95
    ? _sensQfmt((r.ci95[1] - r.ci95[0]) / (2 * 1.96), q)
    : 'n/a';

  // Stability window and CI asymmetry note
  const win = _sensWindowBounds(r.stability_window);
  const winHtml = win ? (() => {
    const wlo = _sensQfmt(Math.max(win[0], 0), q);
    const whi = _sensQfmt(win[1], q);
    return `<div class="sens-stable-window">
      <span class="ssw-label">Skip if next result in:</span>
      <span class="ssw-val">[${wlo} - ${whi}]</span>
    </div>`;
  })() : '';

  // Asymmetry note: when the model uses log transform, CI is right-skewed (correct behavior)
  const loDev = r.ci95 ? (r.mu != null ? r.mu - r.ci95[0] : null) : null;
  const hiDev = r.ci95 ? (r.mu != null ? r.ci95[1] - r.mu : null) : null;
  const asymNote = (loDev != null && hiDev != null && hiDev > loDev * 1.15)
    ? `<div class="sens-asym-note">CI is wider on the upper side - this is correct for log-scale labs (right-skewed distribution).</div>`
    : '';

  return tagHtml + `
    <div class="sens-result-value-row">
      <span class="sens-result-val">${val}</span>
      <span class="sens-result-ci">${ci}</span>
    </div>
    ${asymNote}
    <div class="sens-sigma-row">
      <span class="sens-sigma-label">Spread (effective sigma):</span>
      <span class="sens-sigma-val" id="sensSigmaVal">${sigmaDisplay}</span>
    </div>
    ${winHtml}
    <div class="sens-pstable-row">
      <span class="sens-pstable-num" style="color:${pColor}">${pStab}</span>
      <span>P(stable)</span>
    </div>
    <div style="margin-bottom:var(--sp-3)">
      <span class="sens-decision-badge ${dec ? 'skip' : 'repeat'}">
        ${dec ? '&#10003; SKIP' : '&#8635; REPEAT'}
      </span>
    </div>
    <div class="sens-trust-row">
      <div class="sens-trust-chip">
        <span class="sens-trust-num" style="color:${vColor}">${vScore}</span>
        <span class="sens-trust-lbl">Value</span>
      </div>
      <div class="sens-trust-chip">
        <span class="sens-trust-num" style="color:${cColor}">${cScore}</span>
        <span class="sens-trust-lbl">Calibration</span>
      </div>
    </div>
  `;
}

function _sensScoreColor(s) {
  if (s == null) return 'var(--muted)';
  return modelQuality(s).color;
}

function _sensQfmt(v, q) {
  const x = Number(v);
  if (v == null || !Number.isFinite(x)) return '-';
  if (!q || q <= 0) return x.toFixed(2);
  const rounded = Math.round(v / q) * q;
  const s = q.toString();
  const dec = s.indexOf('.') < 0 ? 0 : s.length - s.indexOf('.') - 1;
  return rounded.toFixed(dec);
}

async function _callPredict(features, patient) {
  // Change 6: custom patient sends null patient_id
  const isCustom  = _sens.patientId === '__custom__';
  const patientId = isCustom ? null : _sens.patientId;
  const featPayload = { ...features };
  if (isCustom && patient) {
    if (patient.age != null) featPayload.age = patient.age;
    if (patient.sex != null) featPayload.sex_code = patient.sex === 'M' ? 1 : patient.sex === 'F' ? 0 : null;
  }
  return getJSON('/api/predict', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lab:                _sens.lab,
      patient_id:         patientId,
      features:           featPayload,
      decision_threshold: _sens.threshold,
      model:              _sens.model,
      sex:                patient ? patient.sex : null,
    }),
  });
}

// ── Static importances ────────────────────────────────────────────────────────
// Render BOTH models' importance side by side so they can be compared directly.
function _renderDualImportances(results) {
  const ng  = results && results.ngboost;
  const mae = results && results.mae;
  const note = (r) => (r && r.available === false) ? (r.message || 'No model for this lab')
                    : (r && r.error) ? r.error : null;
  _renderStaticImportances((ng && ng.importances) || [], 'sensImpBodyNg', note(ng));
  _renderStaticImportances((mae && mae.importances) || [], 'sensImpBodyMae', note(mae));
}

function _renderStaticImportances(importances, targetId, unavailMsg) {
  const body = document.getElementById(targetId || 'sensImpBodyNg');
  if (!body) return;
  if (unavailMsg) {
    body.innerHTML = `<div class="sens-chart-placeholder">${unavailMsg}</div>`;
    return;
  }
  if (!importances || !importances.length) {
    body.innerHTML = '<div class="sens-chart-placeholder">No importance data available.</div>';
    return;
  }

  const items = importances.slice(0, 10); // top 10
  const BAR_H   = 22;
  const GAP     = 7;
  const LABEL_W = 140;
  const PCT_W   = 44;
  const BAR_MAX = 240;
  const W = LABEL_W + BAR_MAX + PCT_W + 24;
  const H = items.length * (BAR_H + GAP) + 16;
  const COLORS = ['#00a39a','#232a86','#c2185b','#d97706','#16a34a','#7c3aed','#0369a1','#6b7280','#b45309','#0e7490'];

  const bars = items.map((item, i) => {
    const y     = i * (BAR_H + GAP) + 8;
    const bw    = Math.max((item.pct / 100) * BAR_MAX, 2);
    const color = COLORS[i % COLORS.length];
    const lbl   = _sensLabel(item.feature);
    const trunc = lbl.length > 18 ? lbl.slice(0, 17) + '...' : lbl;
    return [
      '<text x="' + (LABEL_W - 6) + '" y="' + (y + BAR_H / 2) + '" text-anchor="end" dominant-baseline="middle" font-size="11" fill="#374151">' + trunc + '</text>',
      '<rect x="' + LABEL_W + '" y="' + y + '" width="' + bw.toFixed(1) + '" height="' + BAR_H + '" fill="' + color + '" rx="3" opacity="0.85"/>',
      '<text x="' + (LABEL_W + bw + 5) + '" y="' + (y + BAR_H / 2) + '" dominant-baseline="middle" font-size="11" font-weight="700" fill="' + color + '">' + item.pct.toFixed(1) + '%</text>'
    ].join('');
  }).join('');

  body.innerHTML = '<div style="overflow-x:auto">'
    + '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="max-width:' + W + 'px;display:block">' + bars + '</svg>'
    + '</div>'
    + '<div style="font-size:11px;color:var(--muted);margin-top:8px">Percentage of total feature importance assigned by the trained model. Fixed per lab - does not change with slider values.</div>';
}

// ── Snapshots ─────────────────────────────────────────────────────────────────
// Snapshot one model's result into a compact, comparable entry.
function _snapEntry(r) {
  if (!r || r.available === false || r.error) return null;
  const q = r.quant_step;
  return {
    predicted:  _sensQfmt(r.value != null ? r.value : r.mu, q),
    muRaw:      r.value != null ? r.value : r.mu,
    ci95:       r.ci95 ? [...r.ci95] : null,
    pStable:    r.p_stable != null ? (r.p_stable * 100).toFixed(1) + '%' : '-',
    pStableRaw: r.p_stable != null ? r.p_stable : null,
    decision:   r.decision || '-',
  };
}

// Save a scenario: stores BOTH models' predictions for the current slider values.
// The two new entries are pre-selected so you immediately see NGBoost vs MAE; you
// can then tick/untick any entries below to choose exactly what to compare.
function _saveSnapshot() {
  if (!_sens.lastResults || !_sens.lab) return;

  const changed = Object.entries(_sens.current)
    .filter(([col, val]) => {
      const base = _sens.baseline[col];
      return base != null && Math.abs(val - base) > 0.001;
    })
    .map(([col]) => _sensLabel(col));

  const idx = _sens.snapshots.length;
  _sens.snapshots.push({
    name:     `S${idx + 1}`,
    changed:  changed.length ? changed.join(', ') : 'baseline',
    features: { ..._sens.current },
    models: {
      ngboost: _snapEntry(_sens.lastResults.ngboost),
      mae:     _snapEntry(_sens.lastResults.mae),
    },
  });
  // Default selection = just this scenario's two models (NGBoost vs MAE on the same
  // inputs). Not "everything" - the doctor ticks more entries to compare across
  // scenarios. Replacing (not appending) keeps the default focused and predictable.
  _sens.compareSel = [];
  if (_sens.snapshots[idx].models.ngboost) _sens.compareSel.push(`${idx}:ngboost`);
  if (_sens.snapshots[idx].models.mae)     _sens.compareSel.push(`${idx}:mae`);

  _renderSnapshotsTable();
}

// Flatten the selected (scenario, model) entries into rows for the comparison view.
function _selectedCompareEntries() {
  const ML = (m) => (m === 'mae' ? 'Masked AE' : 'NGBoost');
  const out = [];
  _sens.snapshots.forEach((s, i) => {
    ['ngboost', 'mae'].forEach((model) => {
      if (!_sens.compareSel.includes(`${i}:${model}`)) return;
      const e = s.models[model];
      if (!e) return;
      out.push({ ...e, name: `${s.name} · ${ML(model)}`, model, features: s.features });
    });
  });
  return out;
}

function _renderSnapshotsTable() {
  const body = document.getElementById('sensSnapshotsBody');
  if (!body) return;

  if (!_sens.snapshots.length) {
    body.innerHTML = '<div class="sens-snapshots-empty">No snapshots saved yet. Adjust sliders and click "Save snapshot" - each scenario stores BOTH models so you can compare them.</div>';
    return;
  }

  // One row per (scenario, model). A checkbox selects it for comparison so you can
  // compare across scenarios (same model) OR across models (same scenario), freely.
  const decBadge = (d) => `<span class="sens-snap-decision ${d}">${(d || '-').toUpperCase()}</span>`;
  const rowFor = (s, i, model) => {
    const e = s.models[model];
    const key = `${i}:${model}`;
    const tagCls = model === 'mae' ? 'mae-model-tag' : 'ngb-model-tag';
    const ML = model === 'mae' ? 'Masked AE' : 'NGBoost';
    if (!e) {
      return `<tr class="sens-snap-row sens-snap-unavail">
        <td></td>
        <td>${model === 'ngboost' ? s.name : ''}</td>
        <td><span class="${tagCls}">${ML}</span></td>
        <td colspan="3" style="font-size:11px;color:var(--muted)">no model for this lab</td>
        <td>${model === 'ngboost' ? `<button class="btn-snap-delete" data-idx="${i}" aria-label="Delete ${s.name}">&times;</button>` : ''}</td>
      </tr>`;
    }
    const checked = _sens.compareSel.includes(key) ? 'checked' : '';
    return `<tr class="sens-snap-row">
      <td><input type="checkbox" class="sens-snap-cb" data-key="${key}" ${checked} aria-label="Compare ${s.name} ${ML}"></td>
      <td>${model === 'ngboost' ? `${s.name} <span class="sens-snap-change" title="${s.changed}">${s.changed}</span>` : ''}</td>
      <td><span class="${tagCls}">${ML}</span></td>
      <td style="font-family:ui-monospace,monospace;font-weight:700">${e.predicted}</td>
      <td style="font-family:ui-monospace,monospace;font-weight:700">${e.pStable}</td>
      <td>${decBadge(e.decision)}</td>
      <td>${model === 'ngboost' ? `<button class="btn-snap-delete" data-idx="${i}" aria-label="Delete ${s.name}">&times;</button>` : ''}</td>
    </tr>`;
  };

  const rows = _sens.snapshots.map((s, i) =>
    rowFor(s, i, 'ngboost') + rowFor(s, i, 'mae')).join('');

  const selCount = _sens.compareSel.length;
  const compareBtn = `<button class="btn-sens-compare" id="btnSensCompare" ${selCount < 2 ? 'disabled' : ''}>Compare selected (${selCount})</button>`;

  body.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:var(--sp-3)">
      <span class="sens-snap-hint">Tick any two or more entries to compare - across scenarios or across models.</span>
      ${compareBtn}
    </div>
    <div id="sensCompareView" style="display:none"></div>
    <table class="sens-snap-table">
      <thead>
        <tr>
          <th style="width:28px"></th>
          <th>Scenario</th>
          <th>Model</th>
          <th>Predicted</th>
          <th>P(stable)</th>
          <th>Decision</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

  // Selection checkboxes
  body.querySelectorAll('.sens-snap-cb').forEach((cb) => {
    cb.addEventListener('change', () => {
      const key = cb.dataset.key;
      _sens.compareSel = _sens.compareSel.filter((k) => k !== key);
      if (cb.checked) _sens.compareSel.push(key);
      const btn = document.getElementById('btnSensCompare');
      if (btn) { btn.textContent = `Compare selected (${_sens.compareSel.length})`; btn.disabled = _sens.compareSel.length < 2; }
      // Live-update an open comparison
      const view = document.getElementById('sensCompareView');
      if (view && view.style.display !== 'none' && _sens.compareSel.length >= 2) _renderCompareGrid(view, _selectedCompareEntries());
    });
  });

  // Delete a whole scenario (drops both its entries + any selection of them)
  body.querySelectorAll('.btn-snap-delete').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      _sens.snapshots.splice(idx, 1);
      // Re-index compareSel keys after splice
      _sens.compareSel = _sens.compareSel
        .filter((k) => parseInt(k.split(':')[0], 10) !== idx)
        .map((k) => {
          const [si, m] = k.split(':');
          const n = parseInt(si, 10);
          return n > idx ? `${n - 1}:${m}` : k;
        });
      _renderSnapshotsTable();
    });
  });

  // Compare toggle
  const cmpBtn = document.getElementById('btnSensCompare');
  if (cmpBtn) {
    cmpBtn.addEventListener('click', () => {
      const view = document.getElementById('sensCompareView');
      if (!view || _sens.compareSel.length < 2) return;
      const isOpen = view.style.display !== 'none';
      if (isOpen) {
        view.style.display = 'none';
        cmpBtn.classList.remove('active');
      } else {
        view.style.display = 'block';
        cmpBtn.classList.add('active');
        _renderCompareGrid(view, _selectedCompareEntries());
      }
    });
  }
}

function _renderCompareGrid(container, entries) {
  const snaps = entries || _selectedCompareEntries();
  if (!snaps || snaps.length < 2) {
    container.innerHTML = '<div class="sens-snapshots-empty">Select at least two entries (tick the boxes) to compare.</div>';
    return;
  }

  const CURVE_COLORS = ['#00a39a','#232a86','#c2185b','#d97706','#16a34a','#7c3aed'];

  // ── Comparison table ────────────────────────────────────────────────────────
  // Find features that vary across any snapshot
  const allKeys = new Set();
  snaps.forEach(function(s) { if (s.features) Object.keys(s.features).forEach(function(k) { allKeys.add(k); }); });
  const varyingKeys = [];
  allKeys.forEach(function(k) {
    const baseVal = snaps[0].features ? snaps[0].features[k] : null;
    const differs = snaps.slice(1).some(function(s) {
      const v = s.features ? s.features[k] : null;
      return baseVal != null && v != null && Math.abs(v - baseVal) > 0.001;
    });
    if (differs) varyingKeys.push(k);
  });

  function cellStyle(i, highlight) {
    var bg = highlight ? 'background:#fef3c7;font-weight:700;' : (i === 0 ? '' : 'background:#f9fafb;');
    return 'padding:5px 8px;font-size:11px;text-align:center;font-family:ui-monospace,monospace;' + bg;
  }
  function headerStyle(col) {
    return 'padding:6px 8px;font-size:11px;font-weight:700;color:' + col + ';text-align:center;min-width:80px;white-space:nowrap;';
  }

  var headerCells = '<th style="padding:6px 8px;font-size:11px;font-weight:600;color:#374151;text-align:left"></th>'
    + snaps.map(function(s, i) {
        return '<th style="' + headerStyle(CURVE_COLORS[i % CURVE_COLORS.length]) + '">' + s.name + '</th>';
      }).join('');

  function makeRow(label, cells) {
    return '<tr><td style="padding:5px 8px;font-size:11px;color:var(--muted);font-weight:500;white-space:nowrap">' + label + '</td>' + cells + '</tr>';
  }

  var predRow = makeRow('Predicted',
    snaps.map(function(s) { return '<td style="' + cellStyle(0, false) + '">' + s.predicted + '</td>'; }).join(''));

  var sigmaRow = makeRow('Sigma (uncertainty)',
    snaps.map(function(s, i) {
      var sig = s.ci95 ? ((s.ci95[1] - s.ci95[0]) / (2 * 1.96)).toFixed(2) : 'n/a';
      return '<td style="' + cellStyle(i, false) + '">' + sig + '</td>';
    }).join(''));

  var pRow = makeRow('P(stable)',
    snaps.map(function(s, i) { return '<td style="' + cellStyle(i, false) + '">' + s.pStable + '</td>'; }).join(''));

  var decRow = makeRow('Decision',
    snaps.map(function(s, i) {
      var dec = s.decision === 'skip';
      var badge = '<span style="background:' + (dec ? '#dcfce7' : '#fee2e2') + ';color:' + (dec ? '#15803d' : '#dc2626') + ';border-radius:3px;padding:1px 6px;font-size:10px">' + (dec ? 'SKIP' : 'REPEAT') + '</span>';
      return '<td style="' + cellStyle(i, false) + '">' + badge + '</td>';
    }).join(''));

  var featureRows = '';
  if (varyingKeys.length) {
    featureRows += '<tr><td colspan="' + (snaps.length + 1) + '" style="padding:4px 8px;font-size:10px;font-weight:600;color:var(--muted);background:#f9fafb;border-top:1px solid #e5e7eb">Changed inputs</td></tr>';
    featureRows += varyingKeys.slice(0, 8).map(function(k) {
      var baseVal = snaps[0].features ? snaps[0].features[k] : null;
      var cells = snaps.map(function(s, i) {
        var v = s.features ? s.features[k] : null;
        var isDiff = i > 0 && baseVal != null && v != null && Math.abs(v - baseVal) > 0.001;
        var fmt = v != null ? (+v).toFixed(2) : '-';
        return '<td style="' + cellStyle(i, isDiff) + '">' + fmt + '</td>';
      }).join('');
      return '<tr><td style="padding:5px 8px;font-size:11px;color:#374151">' + _sensLabel(k) + '</td>' + cells + '</tr>';
    }).join('');
  }

  var tableHtml = '<div style="overflow-x:auto;margin-bottom:14px">'
    + '<table style="width:100%;border-collapse:collapse;background:white;border:1px solid var(--border,#e5e7eb);border-radius:8px;overflow:hidden">'
    + '<thead style="background:#f9fafb"><tr>' + headerCells + '</tr></thead>'
    + '<tbody>' + predRow + sigmaRow + pRow + decRow + featureRows + '</tbody>'
    + '</table></div>';

  // ── Overlapping bell curves ─────────────────────────────────────────────────
  var curveSvg = _renderOverlappingCurves(snaps, CURVE_COLORS);

  var legendItems = snaps.map(function(s, i) {
    var col = CURVE_COLORS[i % CURVE_COLORS.length];
    return '<div style="display:flex;align-items:center;gap:5px;font-size:11px">'
      + '<span style="width:12px;height:12px;border-radius:2px;background:' + col + ';flex-shrink:0;display:inline-block"></span>'
      + '<span style="font-weight:700">' + s.name + '</span>'
      + '<span style="font-family:ui-monospace,monospace;color:#374151">' + s.predicted + '</span>'
      + '</div>';
  }).join('');

  container.innerHTML = tableHtml
    + '<div style="background:white;border:1px solid var(--border,#e5e7eb);border-radius:8px;padding:12px 8px 8px">'
    + '<div style="font-size:11px;font-weight:700;color:#374151;margin-bottom:6px">Predicted value distributions</div>'
    + curveSvg
    + '<div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:8px;padding:0 4px">' + legendItems + '</div>'
    + '</div>';
}

function _renderOverlappingCurves(snaps, colors) {
  // Compute x range from all ci95 (or fall back to muRaw +/- 3*sigma)
  var allPts = [];
  snaps.forEach(function(s) {
    var mu = s.muRaw != null ? s.muRaw : parseFloat(s.predicted);
    if (!isNaN(mu)) allPts.push(mu);
    if (s.ci95) { allPts.push(s.ci95[0], s.ci95[1]); }
  });
  if (!allPts.length) return '<div class="sens-chart-placeholder">Not enough data for distribution chart.</div>';

  var xMin0 = Math.min.apply(null, allPts);
  var xMax0 = Math.max.apply(null, allPts);
  var span  = xMax0 - xMin0 || Math.abs(allPts[0]) * 0.4 || 1;
  var xMin  = xMin0 - span * 0.25;
  var xMax  = xMax0 + span * 0.25;

  // SVG dimensions
  var W = 400, H = 140;
  var ML = 8, MR = 8, MT = 12, MB = 28;
  var plotW = W - ML - MR;
  var plotH = H - MT - MB;

  function toSx(v) { return ML + (v - xMin) / (xMax - xMin) * plotW; }

  // For each snapshot compute Gaussian density points
  var N = 120;
  var maxDensity = 0;

  var curves = snaps.map(function(s) {
    var mu = s.muRaw != null ? s.muRaw : parseFloat(s.predicted);
    var sigma = s.ci95 ? (s.ci95[1] - s.ci95[0]) / (2 * 1.96) : span * 0.15;
    if (sigma <= 0) sigma = span * 0.1;
    var pts = [];
    for (var j = 0; j <= N; j++) {
      var x = xMin + (j / N) * (xMax - xMin);
      var z = (x - mu) / sigma;
      var density = Math.exp(-0.5 * z * z) / (sigma * Math.sqrt(2 * Math.PI));
      if (density > maxDensity) maxDensity = density;
      pts.push({ x: x, d: density });
    }
    return { mu: mu, sigma: sigma, pts: pts };
  });

  if (maxDensity === 0) maxDensity = 1;

  // Build SVG paths
  var pathElems = curves.map(function(c, i) {
    var color = colors[i % colors.length];
    // Filled area path
    var fillPts = c.pts.map(function(p) {
      return toSx(p.x).toFixed(1) + ',' + (MT + plotH - (p.d / maxDensity) * plotH * 0.85).toFixed(1);
    });
    // Close path along bottom
    var startX = toSx(c.pts[0].x).toFixed(1);
    var endX   = toSx(c.pts[c.pts.length - 1].x).toFixed(1);
    var bottomY = (MT + plotH).toFixed(1);
    var fillD = 'M ' + startX + ',' + bottomY + ' L ' + fillPts.join(' L ') + ' L ' + endX + ',' + bottomY + ' Z';
    // Stroke path (just the top curve)
    var strokeD = 'M ' + fillPts.join(' L ');
    // Vertical line at mu
    var mx = toSx(c.mu).toFixed(1);
    var lineTop = (MT + plotH - 0.85 * plotH + 2).toFixed(1);
    return [
      '<path d="' + fillD + '" fill="' + color + '" opacity="0.15"/>',
      '<path d="' + strokeD + '" fill="none" stroke="' + color + '" stroke-width="2" opacity="0.9"/>',
      '<line x1="' + mx + '" y1="' + lineTop + '" x2="' + mx + '" y2="' + (MT + plotH) + '" stroke="' + color + '" stroke-width="1.2" stroke-dasharray="3,2" opacity="0.7"/>'
    ].join('');
  }).join('');

  // X axis ticks (3-5 evenly spaced)
  var tickCount = 5;
  var ticks = '';
  for (var t = 0; t <= tickCount; t++) {
    var tv = xMin + (t / tickCount) * (xMax - xMin);
    var tx = toSx(tv).toFixed(1);
    var ty = (MT + plotH).toFixed(1);
    ticks += '<line x1="' + tx + '" y1="' + ty + '" x2="' + tx + '" y2="' + (+ty + 4) + '" stroke="#d1d5db" stroke-width="1"/>';
    ticks += '<text x="' + tx + '" y="' + (MT + plotH + 14) + '" font-size="8.5" fill="#9ca3af" text-anchor="middle">' + tv.toFixed(1) + '</text>';
  }
  var axisLine = '<line x1="' + ML + '" y1="' + (MT + plotH) + '" x2="' + (W - MR) + '" y2="' + (MT + plotH) + '" stroke="#e5e7eb" stroke-width="1"/>';

  return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="display:block;overflow:visible" aria-hidden="true">'
    + axisLine + ticks + pathElems
    + '</svg>';
}
