/**
 * patient.js - Patient section. Five-step wizard:
 *   1. Select or create a patient
 *   2. Choose tests
 *   3. Review / build tube groups (E)
 *      - 2+ selected tests from the same known panel -> AUTO-grouped into a tube card
 *      - Doctor can merge any selected tests, add/remove tests from tubes
 *   4. Fill clinical values with friendly English labels (F)
 *      - first_in_adm_X -> "First X this admission"
 *      - prev1_X -> "Previous X result"
 *      - Shared vitals asked ONCE at the top
 *      - Hints visible while filling, hidden after confirming
 *   5. Results - urgency-sorted interleaved singles AND tubes (G)
 *      - TRUST block: numeric scores not dots
 *      - Feature importance bars: colored + percentage labels visible
 *      - Verification: "prev -> prediction (CI) -> actual"
 *   H) "Clear / New analysis" button resets the whole flow
 *
 * All clinical numbers come from the API - nothing invented here.
 */

// ── Constants ─────────────────────────────────────────────────────────────────
const IMP_COLORS = ['#00a39a','#232a86','#c2185b','#d97706','#16a34a','#6b7280'];

const PANEL_COLORS = {
  CBC:     { color: '#7c3aed', bg: '#f5f3ff' },
  BG_chem: { color: '#0369a1', bg: '#e0f2fe' },
  BG_gas:  { color: '#c2185b', bg: '#fce4ec' },
};

function _finiteNumber(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function _windowBounds(windowRange) {
  if (!windowRange) return null;
  const lo = Array.isArray(windowRange) ? windowRange[0] : windowRange.low;
  const hi = Array.isArray(windowRange) ? windowRange[1] : windowRange.high;
  const loNum = _finiteNumber(lo);
  const hiNum = _finiteNumber(hi);
  return loNum != null && hiNum != null ? [loNum, hiNum] : null;
}

// Shared vitals / admin features NOT per-test
const SHARED_FEATURE_PATTERNS = [
  /^pulse$/, /^sbp$/, /^dbp$/, /^temperature$/, /^spo2$/, /^rr$/, /^gcs$/,
  /^test_number_overall$/, /^test_number_in_admission$/, /^days_in_admission$/, /^age$/,
  /^num_high_risk_drugs$/,
];

function isSharedFeature(col) {
  return SHARED_FEATURE_PATTERNS.some((re) => re.test(col));
}

// Inputs that are DERIVED, not entered: derived from the patient record (sex) or
// computed inside the model. Never rendered as a field; supplied automatically.
const DERIVED_FEATURE_COLS = new Set(['sex_numeric', 'sex_code']);

// F) Friendly label mapping
function _friendlyLabel(col, contextLab) {
  // first_in_adm_X
  const admMatch = col.match(/^first_in_adm_(.+)$/);
  if (admMatch) return `First ${admMatch[1]} this admission`;

  // prev1_X
  const prevMatch = col.match(/^prev1_(.+)$/);
  if (prevMatch) return `Previous ${prevMatch[1]} result`;

  // prev2_X / prev3_X (older history - MAE context)
  const prev2Match = col.match(/^prev2_(.+)$/);
  if (prev2Match) return `${prev2Match[1]} - two results ago`;
  const prev3Match = col.match(/^prev3_(.+)$/);
  if (prev3Match) return `${prev3Match[1]} - three results ago`;

  // days_since_last_X
  const daysMatch = col.match(/^days_since_last_(.+)$/);
  if (daysMatch) return `Days since last ${daysMatch[1]}`;

  // Named vitals / shared
  const namedMap = {
    pulse:                       'Pulse (optional)',
    sbp:                         'Systolic BP (optional)',
    dbp:                         'Diastolic BP (optional)',
    temperature:                 'Temperature (optional)',
    spo2:                        'SpO2 (optional)',
    rr:                          'Respiratory rate (optional)',
    gcs:                         'GCS (optional)',
    age:                         'Age',
    num_high_risk_drugs:         'High-risk drugs (count)',
    test_number_in_admission:    'Test number (this admission)',
    test_number_overall:         'Test number (overall)',
    days_in_admission:           'Days in admission',
  };
  if (namedMap[col]) return namedMap[col];

  // Fallback: humanize the key
  return col.replace(/_/g, ' ');
}

// Short one-line hint for each feature type
function _fieldHint(col) {
  if (col.match(/^first_in_adm_/))   return 'First measured value for this test during the current admission.';
  if (col.match(/^prev1_/))          return 'The most recent prior result for this test.';
  if (col.match(/^prev2_/))          return 'The result before the previous one (older history - used by Masked AE).';
  if (col.match(/^prev3_/))          return 'Three results back (older history - used by Masked AE).';
  if (col.match(/^days_since_last_/)) return 'How many days ago the test was last ordered.';
  if (col === 'pulse')               return 'Resting heart rate in bpm. Leave blank if unavailable.';
  if (col === 'sbp')                 return 'Systolic blood pressure in mmHg. Leave blank if unavailable.';
  if (col === 'dbp')                 return 'Diastolic blood pressure in mmHg. Leave blank if unavailable.';
  if (col === 'age')                 return 'Patient age in years.';
  if (col === 'num_high_risk_drugs') return 'Count of high-risk medications the patient is currently taking.';
  if (col === 'test_number_in_admission') return 'How many times this test has been ordered so far in this admission.';
  if (col === 'test_number_overall') return 'Total number of times this test has ever been ordered for this patient.';
  return null;
}

const VITAL_DEFAULTS = {
  pulse: 75, sbp: 120, dbp: 75,
  temperature: 37.0, spo2: 97, rr: 16, gcs: 15,
  test_number_in_admission: 3, days_in_admission: 3,
};

// ── Session state ─────────────────────────────────────────────────────────────
let _sessionPatients = [];
let _sessionEdits    = {};

// E) Tube state: array of { id, name, labs[], isPanel, panelFamily }
// A test can only be in ONE tube. tubeLabSet tracks which labs are in a tube.
let _wizState = {
  step: 1,
  patientId: null,
  selectedLabs: [],
  tubes: [],           // array of {id, name, labs[], isPanel, panelFamily}
  _nextTubeId: 1,
  predictResults: {},  // { lab: resultObj }
  profileResults: {},  // { tubeId: profileResultObj }
  threshold: 0.85,
  model: 'ngboost',    // active prediction model: 'ngboost' | 'mae'
  expandedCard: null,  // id of expanded card in step 5
  imputedFields: [],   // fields auto-filled when user chose "leave missing"
};

function _allTubedLabs() {
  const s = new Set();
  _wizState.tubes.forEach((t) => t.labs.forEach((l) => s.add(l)));
  return s;
}

// Returns the prediction result for the currently active model.
// Handles both old flat structure and new nested {ngboost, mae} structure.
// The headline result: NGBoost when it has a usable model, otherwise MAE (so a lab
// only one model covers still surfaces correctly in sorts, counts and detail).
function _getResult(lab) {
  const allResults = _wizState.predictResults[lab];
  if (!allResults) return null;
  // flat/backward-compat: result has 'decision', 'error', or 'available' at top level
  if ('decision' in allResults || 'error' in allResults || 'available' in allResults) return allResults;
  // nested: {ngboost: {...}, mae: {...}} - prefer an AVAILABLE result
  const ng = allResults.ngboost, mae = allResults.mae;
  const ok = (r) => r && !r.error && r.available !== false;
  if (ok(ng)) return ng;
  if (ok(mae)) return mae;
  return ng || mae || null;
}
function _resultModelsFor(lab) {
  const allResults = _wizState.predictResults[lab];
  if (!allResults || ('decision' in allResults || 'error' in allResults || 'available' in allResults)) {
    return { ng: allResults && !allResults.error ? allResults : null, mae: null };
  }
  return { ng: allResults.ngboost || null, mae: allResults.mae || null };
}

// Joint-profile result for the currently active model (handles {ngboost, mae}).
function _getProfileResult(tubeId) {
  const all = _wizState.profileResults[tubeId];
  if (!all) return null;
  if (all.ngboost || all.mae) {
    const ok = (r) => r && !r.error && r.available !== false;
    if (ok(all.ngboost)) return all.ngboost;   // NGBoost is the headline when usable
    if (ok(all.mae)) return all.mae;            // else promote MAE
    return all.ngboost || all.mae || null;
  }
  return all; // flat / backward-compat
}
// Joint-profile result for a specific model (null if not run / not nested).
function _getProfileResultFor(tubeId, model) {
  const all = _wizState.profileResults[tubeId];
  if (!all) return null;
  if (all.ngboost || all.mae) return all[model] || null;
  return model === 'ngboost' ? all : null;
}
function _modelLabel(model) { return model === 'mae' ? 'Masked AE' : 'NGBoost'; }

// Per-model coverage for a lab (synchronous from the catalog; async map fallback).
function _labCoverage(lab, state) {
  return (state.labMap[lab] && state.labMap[lab].coverage)
      || (state.labCoverage && state.labCoverage[lab])
      || null;
}
// Marker for labs only ONE model covers. MAE-only gets a green asterisk (the user's
// request); NGBoost-only a navy one. Both carry a tooltip.
function _labCoverageBadge(lab, state) {
  const cov = _labCoverage(lab, state);
  if (!cov) return '';
  if (cov.mae && !cov.ngboost) return '<span class="mae-only-star" title="MAE only - no NGBoost model for this test">&lowast;</span>';
  if (cov.ngboost && !cov.mae) return '<span class="ngb-only-star" title="NGBoost only - no MAE model for this test (or too few records)">&lowast;</span>';
  return '';
}

// ── Entry point ───────────────────────────────────────────────────────────────
function initPatientSection(state) {
  _buildStep1(state);
  _bindWizardEvents(state);

  const thr = document.getElementById('thrSliderWide');
  if (thr) {
    thr.oninput = (e) => {
      _wizState.threshold = parseFloat(e.target.value);
      const disp = document.getElementById('thrValWide');
      if (disp) disp.textContent = _wizState.threshold.toFixed(2);
    };
  }

  // No model toggle: both models always run and are shown together (NGBoost first,
  // Masked AE second), so there is nothing to switch.
}

// ── Patient helpers ───────────────────────────────────────────────────────────
function _allPatients(state) { return [...state.patients, ..._sessionPatients]; }
function _findPatient(state, id) { return _allPatients(state).find((p) => p.id === id) || null; }

// ── STEP 1: Patient grid ──────────────────────────────────────────────────────
function _buildStep1(state) {
  const grid = document.getElementById('patientGrid');
  if (grid) _renderPatientGrid(grid, state);
}

function _renderPatientGrid(grid, state) {
  const all = _allPatients(state);
  const cards = all.map((p) => {
    const labCount = Object.keys(p.labs || {}).length;
    return `
    <div class="patient-card${_wizState.patientId === p.id ? ' selected' : ''}"
         data-id="${p.id}" role="button" tabindex="0" aria-label="Select ${p.name}">
      <div class="patient-card-name">${p.name}
        ${_sessionPatients.some((s) => s.id === p.id) ? '<span class="patient-card-tag">new</span>' : ''}
      </div>
      <div class="patient-card-meta">${p.mrn ? 'MRN: ' + p.mrn + ' | ' : ''}Age: ${p.age || '-'} | ${p.sex || '-'}</div>
      <div class="patient-card-scenario">${p.scenario || ''}</div>
      ${labCount > 0 ? `<div class="patient-card-labs">${labCount} lab${labCount === 1 ? '' : 's'} with data</div>` : ''}
      <button class="btn-edit-patient" data-id="${p.id}" title="Edit patient">Edit</button>
    </div>`;
  }).join('');

  grid.innerHTML = cards + `
    <div class="patient-card patient-card-add" id="btnAddPatient" role="button" tabindex="0" aria-label="Add new patient">
      <div class="patient-card-add-icon">+</div>
      <div class="patient-card-name">New patient</div>
      <div class="patient-card-scenario">Enter name, sex, age</div>
    </div>`;

  grid.querySelectorAll('.patient-card[data-id]').forEach((card) => {
    const select = () => _selectPatient(card.dataset.id, state);
    card.addEventListener('click', (e) => { if (!e.target.classList.contains('btn-edit-patient')) select(); });
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') select(); });
  });
  grid.querySelectorAll('.btn-edit-patient').forEach((btn) => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); _openEditPatientModal(btn.dataset.id, state); });
  });
  const addBtn = document.getElementById('btnAddPatient');
  if (addBtn) {
    addBtn.addEventListener('click', () => _openAddPatientModal(state));
    addBtn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') _openAddPatientModal(state); });
  }
}

function _selectPatient(id, state) {
  _wizState.patientId = id;
  const p = _findPatient(state, id);
  document.querySelectorAll('.patient-card').forEach((c) =>
    c.classList.toggle('selected', c.dataset.id === id));
  document.getElementById('step1Summary').textContent = p ? p.name : '';
  _collapseStep(1, p ? p.name : '');
  _buildStep2(state);
  _activateStep(2);
  _updateWizardDots();
}

// ── Add / Edit modals ─────────────────────────────────────────────────────────
function _openAddPatientModal(state) {
  _showPatientModal({
    title: 'Add new patient', name: '', sex: 'M', age: '',
    onSave: (data) => {
      const id = 'session_' + Date.now();
      _sessionPatients.push({ id, name: data.name, mrn: '', age: data.age ? parseInt(data.age) : null, sex: data.sex, scenario: 'Session patient', labs: {} });
      _renderPatientGrid(document.getElementById('patientGrid'), state);
      _selectPatient(id, state);
    },
  });
}

function _openEditPatientModal(id, state) {
  const p = _findPatient(state, id);
  if (!p) return;
  _showPatientModal({
    title: `Edit: ${p.name}`, name: p.name, sex: p.sex || 'M', age: p.age || '',
    onSave: (data) => {
      const sess = _sessionPatients.find((s) => s.id === id);
      if (sess) { sess.name = data.name; sess.sex = data.sex; sess.age = data.age ? parseInt(data.age) : null; }
      else { if (!_sessionEdits[id]) _sessionEdits[id] = {}; _sessionEdits[id]._patientOverride = { name: data.name, sex: data.sex, age: data.age }; }
      _renderPatientGrid(document.getElementById('patientGrid'), state);
      if (_wizState.patientId === id) document.getElementById('step1Summary').textContent = data.name;
    },
  });
}

function _showPatientModal({ title, name, sex, age, onSave }) {
  document.getElementById('patientModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'patientModal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box" role="dialog" aria-modal="true" aria-label="${title}">
      <div class="modal-header">
        <span class="modal-title">${title}</span>
        <button class="modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="modal-body">
        <label class="field">
          <span>Full name</span>
          <input id="mPatientName" type="text" value="${name}" placeholder="Patient name" />
        </label>
        <div class="modal-row">
          <label class="field" style="flex:1">
            <span>Sex</span>
            <select id="mPatientSex">
              <option value="M"${sex === 'M' ? ' selected' : ''}>Male</option>
              <option value="F"${sex === 'F' ? ' selected' : ''}>Female</option>
            </select>
          </label>
          <label class="field" style="flex:1">
            <span>Age</span>
            <input id="mPatientAge" type="number" min="0" max="120" value="${age}" placeholder="Age" />
          </label>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-modal-cancel">Cancel</button>
        <button class="btn-modal-save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('.modal-close').onclick = close;
  modal.querySelector('.btn-modal-cancel').onclick = close;
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.querySelector('.btn-modal-save').onclick = () => {
    const n = document.getElementById('mPatientName').value.trim();
    if (!n) { alert('Please enter a patient name.'); return; }
    onSave({ name: n, sex: document.getElementById('mPatientSex').value, age: document.getElementById('mPatientAge').value });
    close();
  };
  document.getElementById('mPatientName').focus();
}

// ── STEP 2: Test picker ───────────────────────────────────────────────────────
function _buildStep2(state) {
  const body = document.getElementById('flowStep2Body');
  if (!body) return;

  const patient = _findPatient(state, _wizState.patientId);
  const patientLabs = patient && patient.labs ? Object.keys(patient.labs) : [];
  const panels = state.panels || {};

  const panelGroupsEl = document.getElementById('testPanelGroups');
  const ungroupedEl   = document.getElementById('testUngrouped');
  if (!panelGroupsEl || !ungroupedEl) return;

  const inPanel = new Set();
  Object.values(panels).forEach((labs) => labs.forEach((l) => inPanel.add(l)));

  let panelGroupsHtml = '';
  Object.entries(panels).forEach(([panelName, labs]) => {
    const pc = PANEL_COLORS[panelName] || { color: '#374151', bg: '#f3f4f6' };
    const checks = labs.map((lab) => {
      const hasData = patientLabs.includes(lab);
      return `<label class="lab-check-label${hasData ? ' has-data' : ''}">
        <input type="checkbox" class="test-lab-check" value="${lab}"
               data-panel="${panelName}"
               ${_wizState.selectedLabs.includes(lab) ? 'checked' : ''}>
        ${lab}${_labCoverageBadge(lab, state)}
      </label>`;
    }).join('');
    panelGroupsHtml += `
      <div class="test-panel-group" data-panel="${panelName}">
        <div class="test-panel-group-header">
          <span class="panel-color-dot" style="background:${pc.color}"></span>
          <span class="panel-badge" style="background:${pc.color}">${panelName}</span>
          <span style="font-weight:400;color:#6b7280;margin-left:4px">${labs.length} tests</span>
        </div>
        <div class="test-panel-check-grid">${checks}</div>
      </div>`;
  });
  panelGroupsEl.innerHTML = panelGroupsHtml;

  // Legend: a teal dot marks labs we already have REAL data for on this patient.
  const legend = `<div class="test-legend">
    <span class="tl-item"><span class="tl-dot model"></span>Has a trained model (selectable)</span>
    <span class="tl-item"><span class="tl-dot data"></span>Real data loaded for this patient</span>
    <span class="tl-item"><span class="mae-only-star">&lowast;</span> MAE only (no NGBoost model)</span>
    <span class="tl-item"><span class="ngb-only-star">&lowast;</span> NGBoost only (no MAE model)</span>
  </div>`;
  let legendEl = document.getElementById('testLegend');
  if (!legendEl) {
    legendEl = document.createElement('div');
    legendEl.id = 'testLegend';
    panelGroupsEl.parentElement.insertBefore(legendEl, panelGroupsEl);
  }
  legendEl.innerHTML = legend;

  const ungrouped = state.labs.filter((l) => !inPanel.has(l.lab));
  if (ungrouped.length) {
    const ugChecks = ungrouped.map((l) => {
      const hasData = patientLabs.includes(l.lab);
      return `<label class="lab-check-label${hasData ? ' has-data' : ''}"${hasData ? ' title="Real data loaded for this patient"' : ''}>
        <input type="checkbox" class="test-lab-check" value="${l.lab}"
               ${_wizState.selectedLabs.includes(l.lab) ? 'checked' : ''}>
        ${l.lab}${_labCoverageBadge(l.lab, state)}
      </label>`;
    }).join('');
    ungroupedEl.innerHTML = `
      <div class="test-ungrouped-header">Other tests</div>
      <div class="test-ungrouped-grid">${ugChecks}</div>`;
  } else {
    ungroupedEl.innerHTML = '';
  }

  _updateTestSelectSummary(state, patientLabs);
  _renderNoModelSection(state);

  document.querySelectorAll('.test-lab-check').forEach((cb) => {
    cb.addEventListener('change', () => {
      _wizState.selectedLabs = [...document.querySelectorAll('.test-lab-check:checked')].map((c) => c.value);
      _updateTestSelectSummary(state, patientLabs);
    });
  });

  const btnAll = document.getElementById('btnSelectAll');
  const btnClear = document.getElementById('btnClearSel');
  if (btnAll) btnAll.onclick = () => {
    document.querySelectorAll('.test-lab-check').forEach((cb) => (cb.checked = true));
    _wizState.selectedLabs = state.labs.map((l) => l.lab);
    _updateTestSelectSummary(state, patientLabs);
  };
  if (btnClear) btnClear.onclick = () => {
    document.querySelectorAll('.test-lab-check').forEach((cb) => (cb.checked = false));
    _wizState.selectedLabs = [];
    _updateTestSelectSummary(state, patientLabs);
  };
}

function _updateTestSelectSummary(state, patientLabs) {
  const n = _wizState.selectedLabs.length;
  const panels = state.panels || {};
  let panelCounts = [];
  Object.entries(panels).forEach(([name, labs]) => {
    const cnt = labs.filter((l) => _wizState.selectedLabs.includes(l)).length;
    if (cnt > 0) panelCounts.push(`${cnt} in ${name}`);
  });
  const el = document.getElementById('testSelectSummary');
  if (el) el.textContent = n === 0 ? '0 tests selected'
    : `${n} test${n > 1 ? 's' : ''} selected${panelCounts.length ? ', ' + panelCounts.join(', ') : ''}`;
}

// Blocked / partial coverage, organised BY MODEL (no reasons): what has no model at
// all (neither method, >=100-records bar), what is covered by only one method (still
// selectable), and the derived/duplicate columns we never model.
function _renderNoModelSection(state) {
  const host = document.getElementById('testUngrouped');
  if (!host) return;
  const render = (u) => {
    const dataNoModel = u.no_model_data || u.insufficient || [];
    const derived     = u.no_model_derived || [];
    const ngbOnly     = u.ngboost_only || [];
    const maeOnly     = u.mae_only || [];
    if (!dataNoModel.length && !derived.length && !ngbOnly.length && !maeOnly.length) return;

    const chips = (arr) => [...arr].sort().map((l) => `<span class="lab-nomodel">${l}</span>`).join('');

    const sections = [];
    if (dataNoModel.length) sections.push(`
      <details class="nomodel-details">
        <summary class="nomodel-summary">No model in either method (${dataNoModel.length}) - always order these</summary>
        <div class="nomodel-sub">Neither NGBoost nor Masked AE has enough data (at least 100 test records) to predict these, so they cannot be evaluated here.</div>
        <div class="nomodel-grid">${chips(dataNoModel)}</div>
      </details>`);

    if (ngbOnly.length || maeOnly.length) {
      const oneRow = (label, arr) => arr.length ? `
        <div class="nomodel-subgroup">
          <div class="nomodel-subhead">${label} <span class="nomodel-count">(${arr.length})</span></div>
          <div class="nomodel-grid">${chips(arr)}</div>
        </div>` : '';
      sections.push(`
        <details class="nomodel-details">
          <summary class="nomodel-summary">Covered by one method only (${ngbOnly.length + maeOnly.length})</summary>
          <div class="nomodel-sub">Still selectable - predicted by the one method that covers them (marked with a coloured asterisk in the list above).</div>
          ${oneRow('No NGBoost model - Masked AE covers it', maeOnly)}
          ${oneRow('No Masked AE model - NGBoost covers it', ngbOnly)}
        </details>`);
    }

    if (derived.length) sections.push(`
      <details class="nomodel-details">
        <summary class="nomodel-summary">Not predicted - derived / duplicate values (${derived.length})</summary>
        <div class="nomodel-sub">Computed from other tests or not numeric, so we do not model them.</div>
        <div class="nomodel-grid">${chips(derived)}</div>
      </details>`);

    const html = sections.join('');
    const existing = document.getElementById('noModelSection');
    if (existing) existing.outerHTML = `<div id="noModelSection">${html}</div>`;
    else host.insertAdjacentHTML('afterend', `<div id="noModelSection">${html}</div>`);
  };
  if (_wizState.universe) { render(_wizState.universe); return; }
  getJSON('/api/lab_universe').then((u) => { _wizState.universe = u; render(u); }).catch(() => {});
}

// ── STEP 3: Tube groups (E) ───────────────────────────────────────────────────
function _buildStep3(state) {
  const labs = _wizState.selectedLabs;
  if (labs.length <= 1) {
    // Single test - skip step 3
    _wizState.tubes = labs.length === 1
      ? [{ id: 'tube_1', name: labs[0], labs: labs.slice(), isPanel: false, panelFamily: null }]
      : [];
    _wizState._nextTubeId = 2;
    _collapseStep(3, 'skipped');
    document.getElementById('flowStep3').classList.add('completed');
    _buildStep4(state);
    _activateStep(4);
    _updateWizardDots();
    return;
  }

  // AUTO-group by profile_family (2+ from same panel -> one tube)
  const byFamily = {};
  const noFamily = [];
  labs.forEach((labName) => {
    const meta = state.labMap[labName];
    const fam  = meta && meta.profile_family;
    if (fam) {
      if (!byFamily[fam]) byFamily[fam] = [];
      byFamily[fam].push(labName);
    } else {
      noFamily.push(labName);
    }
  });

  _wizState.tubes = [];
  _wizState._nextTubeId = 1;

  Object.entries(byFamily).forEach(([fam, groupLabs]) => {
    if (groupLabs.length >= 2) {
      _wizState.tubes.push({
        id: 'tube_' + (_wizState._nextTubeId++),
        name: fam + ' panel',
        labs: groupLabs,
        isPanel: true,
        panelFamily: fam,
      });
    } else {
      noFamily.push(...groupLabs);
    }
  });

  // Individual labs each get their own single-lab tube (for uniform data model)
  noFamily.forEach((labName) => {
    _wizState.tubes.push({
      id: 'tube_' + (_wizState._nextTubeId++),
      name: labName,
      labs: [labName],
      isPanel: false,
      panelFamily: null,
    });
  });

  _renderStep3(state);
}

function _renderStep3(state) {
  const content = document.getElementById('profileGroupsContent');
  if (!content) return;

  const panelTubes = _wizState.tubes.filter((t) => t.isPanel && !t.isCustom);
  const customTubes = _wizState.tubes.filter((t) => t.isPanel && t.isCustom);
  const singleTubes = _wizState.tubes.filter((t) => !t.isPanel);

  // All labs that are NOT in a panel tube are "loose" and can be merged
  const tubedLabs = _allTubedLabs();
  const allLabs   = _wizState.selectedLabs;

  // Available loose labs = single-lab tubes
  const looseLabs = singleTubes.map((t) => t.labs[0]);

  content.innerHTML = `
    <div class="tubes-intro">
      Tests from the same panel are automatically grouped into a tube for joint prediction.
      You can also merge any loose tests into a custom tube, or move tests between tubes.
    </div>

    <!-- Panel tubes (auto-detected) -->
    ${panelTubes.length ? `
    <div class="tubes-section-label">Panel tubes (auto-detected)</div>
    ${panelTubes.map((tube) => _renderTubeCard(tube, state, looseLabs)).join('')}
    ` : ''}

    <!-- Custom tubes -->
    ${customTubes.length ? `
    <div class="tubes-section-label">Custom tubes</div>
    ${customTubes.map((tube) => _renderTubeCard(tube, state, looseLabs)).join('')}
    ` : ''}

    <!-- Standalone / individual tests -->
    ${looseLabs.length ? `
    <div class="tubes-section-label">Standalone tests${looseLabs.length > 1 ? ' - you can merge any of these into a custom tube' : ''}</div>
    <div class="loose-labs-row" id="looseLabsRow">
      ${looseLabs.map((lab) => `
        <span class="loose-lab-chip" data-lab="${lab}">
          ${lab}
          ${looseLabs.length > 1 ? `<button class="loose-lab-merge-btn" data-lab="${lab}" title="Merge into a new tube">+tube</button>` : ''}
        </span>`).join('')}
    </div>
    ` : ''}

    <!-- Custom tube builder -->
    ${looseLabs.length >= 2 ? `
    <div id="customTubeBuilder" class="custom-tube-builder" style="display:none">
      <div class="ctb-title">New custom tube</div>
      <div id="ctbSelectedChips" class="ctb-chips"></div>
      <div class="ctb-actions">
        <button class="btn-primary" id="btnCreateTube" style="padding:7px 16px;font-size:13px">Create tube</button>
        <button class="btn-modal-cancel" id="btnCancelTube">Cancel</button>
      </div>
    </div>
    ` : ''}
  `;

  // Bind loose lab merge buttons
  content.querySelectorAll('.loose-lab-merge-btn').forEach((btn) => {
    btn.addEventListener('click', () => _startMergeTube(btn.dataset.lab, state));
  });

  // Bind tube card actions
  _bindTubeCardActions(content, state);

  const totalTubes = panelTubes.length + customTubes.length;
  const sumText = `${totalTubes} tube${totalTubes !== 1 ? 's' : ''}, ${looseLabs.length} standalone`;
  document.getElementById('step3Summary').textContent = sumText;
}

function _renderTubeCard(tube, state, looseLabs) {
  const pc = PANEL_COLORS[tube.panelFamily] || { color: '#374151', bg: '#f3f4f6' };
  const borderColor = (tube.isPanel && !tube.isCustom) ? pc.color : tube.isCustom ? 'var(--navy)' : 'var(--navy)';

  return `
    <div class="profile-group-card tube-card" id="tubeCard_${tube.id}" style="border-left:3px solid ${borderColor}">
      <div class="profile-group-header" style="${(tube.isPanel && !tube.isCustom) ? 'background:' + pc.bg : ''}">
        <span class="tube-name-text">${tube.name}</span>
        <button class="tube-rename-btn" data-tube="${tube.id}" title="Rename this tube" aria-label="Rename tube">&#9998;</button>
        <span class="rel-badge ${tube.isPanel ? 'high' : 'unknown'}" style="font-size:10px;margin-left:auto">
          ${tube.isPanel ? 'joint prediction' : 'individual'}
        </span>
      </div>
      <div class="profile-group-body tube-body">
        ${tube.labs.map((lab) => `
          <span class="tube-lab-chip" data-tube="${tube.id}" data-lab="${lab}">
            ${lab}
            <button class="tube-remove-lab-btn" data-tube="${tube.id}" data-lab="${lab}" title="Remove from tube" aria-label="Remove ${lab} from tube">&times;</button>
          </span>`).join('')}
        ${(looseLabs.length > 0 && tube.isPanel) ? `
          <div class="tube-add-row">
            <select class="tube-add-select" data-tube="${tube.id}" style="font-size:11px;padding:2px 4px">
              <option value="">Add lab to this tube...</option>
              ${looseLabs.map((l) => `<option value="${l}">${l}</option>`).join('')}
            </select>
          </div>` : ''}
      </div>
    </div>`;
}

// State for custom tube building
let _ctbLabs = [];

function _startMergeTube(lab, state) {
  const builder = document.getElementById('customTubeBuilder');
  if (!builder) return;
  if (!_ctbLabs.includes(lab)) _ctbLabs.push(lab);
  builder.style.display = 'block';
  _renderCtbChips();

  const btnCreate = document.getElementById('btnCreateTube');
  const btnCancel = document.getElementById('btnCancelTube');
  if (btnCreate) btnCreate.onclick = () => _createCustomTube(state);
  if (btnCancel) btnCancel.onclick = () => { _ctbLabs = []; builder.style.display = 'none'; _renderCtbChips(); };
}

function _renderCtbChips() {
  const chips = document.getElementById('ctbSelectedChips');
  if (!chips) return;
  chips.innerHTML = _ctbLabs.map((l) =>
    `<span class="tube-lab-chip">
       ${l}
       <button class="tube-remove-lab-btn" data-lab="${l}" aria-label="Remove ${l}">&times;</button>
     </span>`
  ).join('') + (_ctbLabs.length < _wizState.selectedLabs.filter((x) => !_allTubedLabs().has(x) || _ctbLabs.includes(x)).length
    ? '' : '');
  chips.querySelectorAll('.tube-remove-lab-btn').forEach((btn) => {
    btn.onclick = () => {
      _ctbLabs = _ctbLabs.filter((x) => x !== btn.dataset.lab);
      _renderCtbChips();
    };
  });
}

function _createCustomTube(state) {
  if (_ctbLabs.length < 2) { alert('Select at least 2 tests to form a tube.'); return; }
  // Remove each lab from its existing single-lab tube
  const tubedSet = new Set(_ctbLabs);
  _wizState.tubes = _wizState.tubes.filter((t) => {
    // Remove single-lab tubes whose lab is being merged
    if (!t.isPanel && t.labs.length === 1 && tubedSet.has(t.labs[0])) return false;
    return true;
  });
  const customCount = _wizState.tubes.filter((t) => t.isCustom).length + 1;
  _wizState.tubes.push({
    id: 'tube_' + (_wizState._nextTubeId++),
    name: 'Custom panel ' + customCount,
    labs: [..._ctbLabs],
    isPanel: true,
    isCustom: true,
    panelFamily: null,
  });
  _ctbLabs = [];
  const builder = document.getElementById('customTubeBuilder');
  if (builder) builder.style.display = 'none';
  _renderStep3(state);
}

function _bindTubeCardActions(container, state) {
  // Rename a tube (optional - inline edit, defaults already sensible)
  container.querySelectorAll('.tube-rename-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tube = _wizState.tubes.find((t) => t.id === btn.dataset.tube);
      if (!tube) return;
      const next = window.prompt('Name this tube:', tube.name);
      if (next && next.trim()) { tube.name = next.trim(); _renderStep3(state); }
    });
  });

  // Remove lab from tube
  container.querySelectorAll('.tube-remove-lab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tubeId = btn.dataset.tube;
      const lab    = btn.dataset.lab;
      const tube   = _wizState.tubes.find((t) => t.id === tubeId);
      if (!tube) return;
      // Remove lab from tube
      tube.labs = tube.labs.filter((l) => l !== lab);
      if (tube.labs.length === 0) {
        // Remove empty tube
        _wizState.tubes = _wizState.tubes.filter((t) => t.id !== tubeId);
      }
      // Create standalone single-lab tube for the removed lab
      _wizState.tubes.push({
        id: 'tube_' + (_wizState._nextTubeId++),
        name: lab,
        labs: [lab],
        isPanel: false,
        panelFamily: null,
      });
      _renderStep3(state);
    });
  });

  // Add loose lab to a panel tube via select
  container.querySelectorAll('.tube-add-select').forEach((sel) => {
    sel.addEventListener('change', () => {
      const v      = sel.value;
      const tubeId = sel.dataset.tube;
      if (!v) return;
      const tube      = _wizState.tubes.find((t) => t.id === tubeId);
      const singleTub = _wizState.tubes.find((t) => !t.isPanel && t.labs.length === 1 && t.labs[0] === v);
      if (!tube || !singleTub) { sel.value = ''; return; }
      // Move lab from its single tube into this tube
      tube.labs.push(v);
      _wizState.tubes = _wizState.tubes.filter((t) => t.id !== singleTub.id);
      _renderStep3(state);
    });
  });
}

// ── STEP 4: Fill values (F) ───────────────────────────────────────────────────
// Cross-lab features: any feature whose name matches a different lab, e.g.
// "first_in_adm_LDH" when the current lab is "AST". We detect this by checking
// if the stem of the feature name is a known lab key and it differs from the
// current lab.
function _isCrossLabFeature(col, currentLab, state) {
  const m = col.match(/^(?:first_in_adm_|prev1_|days_since_last_)(.+)$/);
  if (!m) return false;
  const stem = m[1];
  if (stem.toLowerCase() === currentLab.toLowerCase()) return false;
  return !!(state.labMap && state.labMap[stem]);
}

function _featureColsForLab(lab, state, patient, mode = 'both') {
  const cols = new Set();
  const schema = (state.inputSchemas && state.inputSchemas[lab]) || null;
  if (schema) {
    // The backend already returns the genuine, model-specific input lists.
    const list = mode === 'ngboost' ? schema.ngboost
               : mode === 'mae'     ? schema.mae
               : schema.union;
    (list || []).forEach((c) => cols.add(c));
  } else {
    // Fallback (schema not loaded): registry feature_cols + base MAE inputs.
    const meta = state.labMap[lab];
    if (mode === 'both' || mode === 'ngboost') (meta && meta.feature_cols || []).forEach((c) => cols.add(c));
    if (mode === 'both' || mode === 'mae') {
      cols.add(`prev1_${lab}`); cols.add(`first_in_adm_${lab}`); cols.add(`days_since_last_${lab}`);
      cols.add('age'); cols.add('days_in_admission');
    }
  }
  // Always include any stored patient values so a loaded value never lacks a field.
  const block = patient && patient.labs && patient.labs[lab];
  Object.keys((block && block.features) || {}).forEach((c) => cols.add(c));
  // Drop MAE token columns and DERIVED inputs the doctor must never type:
  //   - sex_numeric/sex_code  -> derived from the patient's sex
  //   - *_delta               -> derived inside the model (prev1 - first_in_adm)
  return [...cols].filter((c) =>
    !c.startsWith('mae__') && !c.startsWith('mae_time__') &&
    !DERIVED_FEATURE_COLS.has(c) && !/_delta$/.test(c));
}

// Which models use a given input column (for the per-field "NGB / MAE / both" tag).
function _featureModels(lab, col, state) {
  const schema = state.inputSchemas && state.inputSchemas[lab];
  if (schema && schema.models_by_feature && schema.models_by_feature[col]) {
    return schema.models_by_feature[col];
  }
  return [];
}

// Small chip showing which model(s) consume a field.
function _tagFromModels(ms) {
  if (!ms || !ms.length) return '';
  if (ms.length === 2 || (ms.includes('ngboost') && ms.includes('mae')))
    return '<span class="feat-model-tag both" title="Used by both models">both</span>';
  if (ms.includes('ngboost')) return '<span class="feat-model-tag ngb" title="Used by NGBoost only">NGB</span>';
  return '<span class="feat-model-tag mae" title="Used by Masked AE only">MAE</span>';
}
function _featureModelTag(lab, col, state) {
  return _tagFromModels(_featureModels(lab, col, state));
}
// Shared/cross-test fields: a field is asked once for all selected tests, so
// aggregate which models use it across every selected lab.
function _featureModelTagShared(col, state) {
  const ms = new Set();
  (_wizState.selectedLabs || []).forEach((lab) => {
    _featureModels(lab, col, state).forEach((m) => ms.add(m));
  });
  return _tagFromModels([...ms]);
}

function _buildStep4(state) {
  const labs = _wizState.selectedLabs;
  if (!labs.length) return;
  const patient = _findPatient(state, _wizState.patientId);

  const allCols = new Set();
  labs.forEach((lab) => {
    _featureColsForLab(lab, state, patient, 'both').forEach((c) => allCols.add(c));
  });

  const sharedCols = [...allCols].filter(isSharedFeature);

  // Cross-test shared: non-vital columns appearing in 2+ selected labs → show once
  const colToLabs = {};
  labs.forEach((lab) => {
    _featureColsForLab(lab, state, patient, 'both').forEach((col) => {
      if (isSharedFeature(col)) return;
      if (!colToLabs[col]) colToLabs[col] = [];
      colToLabs[col].push(lab);
    });
  });
  const crossTestSharedCols = Object.entries(colToLabs)
    .filter(([, ls]) => ls.length >= 2)
    .map(([col]) => col);
  _wizState.crossTestSharedCols = new Set(crossTestSharedCols);

  const perTestCols = {};
  labs.forEach((lab) => {
    perTestCols[lab] = _featureColsForLab(lab, state, patient, 'both').filter(
      (c) => !isSharedFeature(c) && !_wizState.crossTestSharedCols.has(c)
    );
  });
  _wizState.featureColsByLab = perTestCols;
  _wizState.sharedFeatureCols = sharedCols;

  // Shared features block - responsive 3/2/1 column grid
  const sharedBlock = document.getElementById('sharedFeaturesBlock');
  if (sharedBlock) {
    if (sharedCols.length) {
      sharedBlock.innerHTML = `
        <div class="shared-features-title">Patient baseline (asked once for all tests)</div>
        <div class="shared-features-grid sf-grid-responsive">
          ${sharedCols.map((col) => _renderFeatField(col, col, state, patient, 'shared_', true)).join('')}
        </div>`;
    } else {
      sharedBlock.innerHTML = '';
    }
  }

  // Cross-test shared block: columns needed by 2+ selected tests
  const crossTestBlock = document.getElementById('crossTestSharedBlock');
  if (crossTestBlock) {
    if (crossTestSharedCols.length) {
      crossTestBlock.style.display = '';
      crossTestBlock.innerHTML = `
        <div class="cross-test-shared-meta">
          <div class="cross-test-shared-title">Shared lab values (needed by multiple selected tests)</div>
          <div style="display:flex;gap:var(--sp-2)">
            <button class="btn-fill-cross-shared" id="btnFillCrossNormal">Fill typical</button>
            <button class="btn-fill-cross-shared" id="btnFillCrossRandom">Randomize</button>
          </div>
        </div>
        <div class="cross-test-shared-hint">Fill these once — they auto-apply to every test that needs them.</div>
        <div class="shared-features-grid sf-grid-responsive">
          ${crossTestSharedCols.map((col) => _renderCrossTestSharedField(col, colToLabs[col], state, patient)).join('')}
        </div>`;
      document.getElementById('btnFillCrossNormal')?.addEventListener('click', () =>
        _fillCrossTestShared(crossTestSharedCols, state, patient, 'normal'));
      document.getElementById('btnFillCrossRandom')?.addEventListener('click', () =>
        _fillCrossTestShared(crossTestSharedCols, state, patient, 'random'));
    } else {
      crossTestBlock.style.display = 'none';
      crossTestBlock.innerHTML = '';
    }
  }

  // Per-test sections - each lab is its own card with navy left border
  const perTestEl = document.getElementById('perTestInputs');
  if (perTestEl) {
    perTestEl.innerHTML = labs.map((lab) => {
      const cols = perTestCols[lab] || [];
      const storedBlock = (patient && patient.labs && patient.labs[lab]) || {};
      const sessionEdit = (_sessionEdits[_wizState.patientId] || {})[lab] || {};
      const actualNext  = sessionEdit.actual_next !== undefined
        ? sessionEdit.actual_next
        : storedBlock.actual_next;

      // Split regular vs cross-lab features for separate rendering
      const regularCols   = cols.filter((c) => !_isCrossLabFeature(c, lab, state));
      const crossLabCols  = cols.filter((c) => _isCrossLabFeature(c, lab, state));

      const crossLabHtml = crossLabCols.length ? `
        <div class="cross-lab-section">
          <div class="cross-lab-section-head">
            Cross-lab inputs
            <span class="tooltip-icon" title="These values from other tests are needed because the model learned they correlate with ${lab}. Enter them even if they are not the primary test.">?</span>
          </div>
          <div class="per-test-inputs-grid">
            ${crossLabCols.map((col) => {
              const m = col.match(/^(?:first_in_adm_|prev1_|days_since_last_)(.+)$/);
              const stem = m ? m[1] : col;
              return _renderFeatFieldWithTooltip(col, lab, state, patient, `pt_${_labId(lab)}_`, `This cross-lab value (${stem}) is needed because the model learned it correlates with ${lab}`);
            }).join('')}
          </div>
        </div>` : '';

      // "Actual next result" - collapsible, clearly optional
      const actualId      = `actual_${_labId(lab)}`;
      const actualToggle  = `actualToggle_${_labId(lab)}`;
      const actualBody    = `actualBody_${_labId(lab)}`;

      return `
        <div class="per-test-section" id="section_${_labId(lab)}">
          <div class="per-test-section-header">
            <span class="per-test-lab-name">${lab}</span>
            <div class="per-test-fill-btns">
              <button class="btn-fill-normal" data-lab="${lab}">Fill normal</button>
              <button class="btn-fill-random" data-lab="${lab}">Randomize</button>
            </div>
          </div>
          <div class="per-test-section-body">
            ${regularCols.length
              ? `<div class="per-test-inputs-grid">
                   ${regularCols.map((col) => _renderFeatField(col, lab, state, patient, `pt_${_labId(lab)}_`, true)).join('')}
                 </div>`
              : `<div class="no-extra-inputs-msg">No additional inputs required for this test.</div>`}
            ${crossLabHtml}
            <!-- "Actual next result" - optional, collapsible verification field -->
            <div class="actual-result-section">
              <button class="actual-result-toggle" id="${actualToggle}" aria-expanded="false"
                      aria-controls="${actualBody}"
                      onclick="
                        var b=document.getElementById('${actualBody}');
                        var open=this.getAttribute('aria-expanded')==='true';
                        b.style.display=open?'none':'block';
                        this.setAttribute('aria-expanded',String(!open));
                        this.querySelector('.atr-arrow').textContent=open?'&#9656;':'&#9662;';">
                <span class="atr-arrow">&#9656;</span>
                Actual next result
                <span class="actual-optional-badge">optional - for model verification only</span>
                <span class="tooltip-icon" title="Fill this only if you know the real next result. The model predicts WITHOUT it - this field just lets you verify accuracy.">?</span>
              </button>
              <div class="actual-result-body" id="${actualBody}" style="display:none">
                <div class="actual-result-hint">Enter the actual next result to see how accurate the prediction was. The prediction runs perfectly without this.</div>
                <input type="number" step="any" id="${actualId}"
                       class="feat-input actual-result-input"
                       value="${actualNext ?? ''}" placeholder="Leave blank to skip" />
              </div>
            </div>
          </div>
        </div>`;
    }).join('');

    perTestEl.querySelectorAll('.btn-fill-normal').forEach((btn) => {
      btn.addEventListener('click', () => _fillLabInputs(btn.dataset.lab, state, patient, 'normal'));
    });
    perTestEl.querySelectorAll('.btn-fill-random').forEach((btn) => {
      btn.addEventListener('click', () => _fillLabInputs(btn.dataset.lab, state, patient, 'random'));
    });
  }

  document.getElementById('step4Summary').textContent = `${labs.length} test${labs.length > 1 ? 's' : ''}`;
}

// Render a single cross-test shared field (col needed by labsArr - 2+ tests)
function _renderCrossTestSharedField(col, labsArr, state, patient) {
  const friendly = _friendlyLabel(col, labsArr[0]);
  const normHint = _normHint(col, labsArr[0], state, patient);
  const hintText = _fieldHint(col);

  // Get stored value from the first lab that has it
  let stored;
  for (const lab of labsArr) {
    const storedBlock = (patient && patient.labs && patient.labs[lab]) || {};
    const sessionEdit = (_sessionEdits[_wizState.patientId] || {})[lab] || {};
    const vals = { ...(storedBlock.features || {}), ...(sessionEdit.features || {}) };
    if (vals[col] !== undefined && vals[col] !== null) { stored = vals[col]; break; }
  }

  const labTags = labsArr.map((l) => `<span class="cross-test-shared-labs">${l}</span>`).join('');

  return `<div class="feat-field">
    <span class="feat-label feat-label-friendly">${friendly} ${_featureModelTagShared(col, state)} ${labTags}</span>
    ${(hintText || normHint) ? `<span class="feat-hint-text">
      ${hintText ? hintText + ' ' : ''}
      ${normHint ? `Typical: <strong>${normHint.typical}</strong>${normHint.range ? '  (range ' + normHint.range + ')' : ''}` : ''}
    </span>` : ''}
    <input type="number" step="any" id="cross_shared_${_safeId(col)}"
           class="feat-input"
           value="${stored !== undefined && stored !== null ? stored : ''}"
           placeholder="${normHint ? normHint.typical : ''}"
           aria-label="${friendly}" />
  </div>`;
}

function _fillCrossTestShared(cols, state, patient, mode) {
  cols.forEach((col) => {
    const el = document.getElementById('cross_shared_' + _safeId(col));
    if (!el) return;
    const val = _computeFillValue(col, state, patient, mode);
    if (val !== null && val !== undefined) el.value = val;
  });
}

// Render a feature field with an explicit tooltip override (used for cross-lab features)
function _renderFeatFieldWithTooltip(col, lab, state, patient, prefix, tooltipText) {
  const friendly  = _friendlyLabel(col, lab);
  const normHint  = _normHint(col, lab, state, patient);
  const storedBlock = (patient && patient.labs && patient.labs[lab]) || {};
  const sessionEdit = (_sessionEdits[_wizState.patientId] || {})[lab] || {};
  const vals    = { ...(storedBlock.features || {}), ...(sessionEdit.features || {}) };
  const stored  = vals[col];

  return `<div class="feat-field">
    <span class="feat-label feat-label-friendly">
      ${friendly} ${_featureModelTag(lab, col, state)}
      <span class="tooltip-icon cross-lab-tooltip" title="${tooltipText}">?</span>
    </span>
    ${normHint ? `<span class="feat-hint-text">Typical: <strong>${normHint.typical}</strong>${normHint.range ? '  (range ' + normHint.range + ')' : ''}</span>` : ''}
    <input type="number" step="any" id="${prefix}${_safeId(col)}"
           class="feat-input cross-lab-input"
           value="${stored !== undefined && stored !== null ? stored : ''}"
           placeholder="${normHint ? normHint.typical : ''}"
           aria-label="${friendly}" />
  </div>`;
}

// F) Render one feature field with friendly label + collapsible hint
function _renderFeatField(col, lab, state, patient, prefix, showHints) {
  const friendly  = _friendlyLabel(col, lab);
  const hintText  = _fieldHint(col);
  const normHint  = _normHint(col, lab, state, patient);

  const storedBlock = (patient && patient.labs && patient.labs[lab]) || {};
  const sessionEdit = (_sessionEdits[_wizState.patientId] || {})[lab] || {};
  const vals    = { ...(storedBlock.features || {}), ...(sessionEdit.features || {}) };
  const stored  = vals[col];

  // Is this field optional?
  const isOptional = col.match(/^pulse$|^sbp$|^dbp$|^temperature$|^spo2$|^rr$|^gcs$/);
  const optionalBadge = isOptional ? '<span class="feat-optional">(optional)</span>' : '';

  const hintId = prefix + _safeId(col) + '_hint';
  const modelTag = isSharedFeature(col) ? _featureModelTagShared(col, state) : _featureModelTag(lab, col, state);

  return `<div class="feat-field">
    <span class="feat-label feat-label-friendly">${friendly} ${modelTag} ${optionalBadge}</span>
    ${showHints && (hintText || normHint)
      ? `<span class="feat-hint-text" id="${hintId}">
           ${hintText ? hintText + ' ' : ''}
           ${normHint ? `Typical: <strong>${normHint.typical}</strong>${normHint.range ? '  (range ' + normHint.range + ')' : ''}` : ''}
         </span>`
      : ''}
    <input type="number" step="any" id="${prefix}${_safeId(col)}"
           class="feat-input"
           value="${stored !== undefined && stored !== null ? stored : ''}"
           placeholder="${normHint ? normHint.typical : ''}"
           aria-label="${friendly}" />
  </div>`;
}

// ── Fill helpers ──────────────────────────────────────────────────────────────
function _fillLabInputs(lab, state, patient, mode) {
  const prefix = `pt_${_labId(lab)}_`;
  const cols = _featureColsForLab(lab, state, patient, 'both');
  cols.forEach((col) => {
    if (isSharedFeature(col)) return;
    if (_wizState.crossTestSharedCols && _wizState.crossTestSharedCols.has(col)) return;
    const el = document.getElementById(prefix + _safeId(col));
    if (!el) return;
    const val = _computeFillValue(col, state, patient, mode);
    if (val !== null && val !== undefined) el.value = val;
  });
}

function _normHint(col, currentLab, state, patient) {
  const norms = state.norms || {};
  const m = col.match(/^(?:first_in_adm_|prev1_|prev2_|prev3_)(.+)$/);
  if (m) {
    const n = norms[m[1]];
    if (n && n.typical != null) {
      const rp = [];
      if (n.low  != null) rp.push(n.low);
      if (n.high != null) rp.push(n.high);
      return { typical: n.typical, range: rp.length === 2 ? `${rp[0]} - ${rp[1]}` : null };
    }
    return null;
  }
  if (col.match(/^days_since_last_/)) return { typical: 1, range: '1 - 5' };
  if (col === 'age' && patient && patient.age) return { typical: patient.age };
  const vd = VITAL_DEFAULTS[col];
  if (vd !== null && vd !== undefined) return { typical: vd };
  if (col === 'days_in_admission') return { typical: 3 };
  if (col.match(/^test_number/)) return { typical: 3 };
  const n = norms[col];
  if (n && n.typical != null) return { typical: n.typical };
  return null;
}

function _computeFillValue(col, state, patient, mode) {
  const norms = state.norms || {};
  if (col.match(/^days_since_last_/))
    return mode === 'normal' ? 1 : Math.floor(Math.random() * 5) + 1;
  const m = col.match(/^(?:first_in_adm_|prev1_|prev2_|prev3_)(.+)$/);
  if (m) {
    const n = norms[m[1]];
    if (!n || n.typical == null) return null;
    return mode === 'normal' ? n.typical : _gaussianFill(n);
  }
  if (col === 'age' && patient && patient.age) return patient.age;
  const vd = VITAL_DEFAULTS[col];
  if (vd !== null && vd !== undefined)
    return mode === 'normal' ? vd : Math.round(vd * (0.9 + Math.random() * 0.2));
  if (col === 'days_in_admission') return mode === 'normal' ? 3 : Math.floor(Math.random() * 7) + 1;
  if (col.match(/^test_number/)) return mode === 'normal' ? 3 : Math.floor(Math.random() * 5) + 1;
  if (col.match(/^num_/)) return mode === 'normal' ? 1 : Math.floor(Math.random() * 5) + 1;
  const n = norms[col];
  if (n && n.typical != null) return mode === 'normal' ? n.typical : _gaussianFill(n);
  return null;
}

function _gaussianFill(n) {
  if (n.typical == null) return null;
  const spread = n.spread || Math.abs(n.typical) * 0.1 || 1;
  const u1 = Math.random(), u2 = Math.random();
  const z  = Math.sqrt(-2 * Math.log(u1 + 1e-12)) * Math.cos(2 * Math.PI * u2);
  let val = n.typical + z * spread;
  if (n.low  != null) val = Math.max(val, n.low);
  if (n.high != null) val = Math.min(val, n.high);
  return Math.round(val * 1000) / 1000;
}

// True only when the submitted inputs equal the patient's stored real values AND a
// real next result is on record - i.e. a genuine case we can score the model against.
function _isRealCase(stored, features, actual) {
  if (!stored || stored.actual_next == null) return false;
  if (actual == null || Math.abs(actual - stored.actual_next) > 1e-6) return false;
  const sf = stored.features || {};
  const keys = new Set([...Object.keys(sf), ...Object.keys(features || {})]);
  for (const k of keys) {
    const a = sf[k], b = (features || {})[k];
    if (a == null && b == null) continue;
    if (a == null || b == null) return false;
    if (Math.abs(a - b) > 1e-6) return false;
  }
  return true;
}

// Gather feature inputs for one lab
function _gatherFeaturesForLab(lab, state) {
  const out  = {};
  const cols = _wizState.featureColsByLab && _wizState.featureColsByLab[lab]
    ? _wizState.featureColsByLab[lab]
    : _featureColsForLab(lab, state, _findPatient(state, _wizState.patientId), 'both');
  const allCols = [...new Set([
    ...cols,
    ...(_wizState.sharedFeatureCols || []),
    ...(_wizState.crossTestSharedCols || []),
  ])];
  allCols.forEach((col) => {
    let el;
    if (isSharedFeature(col)) {
      el = document.getElementById('shared_' + _safeId(col));
    } else if (_wizState.crossTestSharedCols && _wizState.crossTestSharedCols.has(col)) {
      el = document.getElementById('cross_shared_' + _safeId(col));
    } else {
      el = document.getElementById(`pt_${_labId(lab)}_${_safeId(col)}`);
    }
    if (el && el.value !== '') out[col] = parseFloat(el.value);
  });
  return out;
}

// ── MISSING INPUTS CHECK & DIALOG ─────────────────────────────────────────────

// Returns { lab, col, label, el } for every required feature that is empty in
// the UI and not present in the patient's stored block for that lab.
// Only NGBoost inputs are *required* (NGBoost hard-fails on a missing feature);
// MAE's extra inputs (prev2/prev3, panel siblings) are optional context, so an
// empty sibling field must never block a run or demand 13 values for a CBC lab.
function _checkMissingInputs(state, patient) {
  const missing = [];
  const seenEls = new Set(); // deduplicate cross-test shared elements
  _wizState.selectedLabs.forEach((lab) => {
    const stored = ((patient && patient.labs && patient.labs[lab]) || {}).features || {};
    _featureColsForLab(lab, state, patient, 'ngboost').forEach((col) => {
      if (stored[col] !== undefined) return;
      let el;
      if (isSharedFeature(col)) {
        el = document.getElementById('shared_' + _safeId(col));
      } else if (_wizState.crossTestSharedCols && _wizState.crossTestSharedCols.has(col)) {
        el = document.getElementById('cross_shared_' + _safeId(col));
      } else {
        el = document.getElementById(`pt_${_labId(lab)}_${_safeId(col)}`);
      }
      if (el && el.value === '' && !seenEls.has(el.id)) {
        seenEls.add(el.id);
        missing.push({ lab, col, label: _friendlyLabel(col, lab), el });
      }
    });
  });
  return missing;
}

// Fill all missing items using _computeFillValue (reuses existing fill logic)
function _fillMissingItems(missingItems, strategy, state, patient) {
  const fillMode = strategy === 'random' ? 'random' : 'normal';
  const filled = [];
  missingItems.forEach(({ lab, col, el }) => {
    const val = _computeFillValue(col, state, patient, fillMode);
    if (val !== null && val !== undefined) {
      el.value = val;
      filled.push({ lab, col, value: val });
    }
  });
  return filled;
}

// Show a sticky notice in step 4 when "fill manually" is chosen
function _showMissingCountNotice(missingItems) {
  const existing = document.getElementById('missingCountNotice');
  if (existing) existing.remove();
  if (!missingItems.length) return;
  const notice = document.createElement('div');
  notice.id = 'missingCountNotice';
  notice.className = 'missing-count-notice';
  notice.innerHTML = `
    <span class="mcn-text">${missingItems.length} field${missingItems.length > 1 ? 's' : ''} still need values - highlighted in red above</span>
    <button class="mcn-close" onclick="document.getElementById('missingCountNotice').remove()" aria-label="Dismiss">&times;</button>`;
  const sticky = document.getElementById('step4StickyBar');
  if (sticky && sticky.parentElement) sticky.parentElement.insertBefore(notice, sticky);
}

// Dialog shown when required inputs are empty before running predictions
function _showMissingDialog(missingItems, state, patient, onResolved) {
  const existing = document.getElementById('missingInputsOverlay');
  if (existing) existing.remove();

  const byLab = {};
  missingItems.forEach((item) => { (byLab[item.lab] = byLab[item.lab] || []).push(item); });

  const overlay = document.createElement('div');
  overlay.id = 'missingInputsOverlay';
  overlay.className = 'modal-overlay';
  overlay.style.cssText = 'display:flex;z-index:900';

  const labsHtml = Object.entries(byLab).map(([lab, items]) => `
    <div class="missing-lab-group">
      <div class="missing-lab-name">${lab}</div>
      <ul class="missing-fields-list">
        ${items.map((it) => `<li>${it.label}</li>`).join('')}
      </ul>
    </div>`).join('');

  overlay.innerHTML = `
    <div class="settings-modal-box" style="max-width:560px">
      <div class="modal-header">
        <span class="modal-title">Some required inputs are missing</span>
        <button class="modal-close" id="missingDlgClose" aria-label="Close">&times;</button>
      </div>
      <div class="modal-body" style="max-height:320px;overflow-y:auto;padding:16px 20px">
        <p class="missing-dlg-intro">
          ${missingItems.length} required field${missingItems.length > 1 ? 's are' : ' is'} empty.
          Choose how to handle before running:
        </p>
        <div class="missing-labs-scroll">${labsHtml}</div>
        <div class="missing-strategy-group">
          <div class="missing-strategy-title">How to fill the missing values?</div>
          ${[
            ['manual', 'Fill manually - highlight the empty fields so I can enter values'],
            ['mean',   'Fill with population mean (typical value from training data)'],
            ['median', 'Fill with population median'],
            ['random', 'Fill randomly within normal clinical range'],
            ['leave',  'Fill with population mean automatically - flag imputed values in results (prediction may be less accurate)'],
          ].map(([val, label], i) => `
            <label class="missing-strategy-option">
              <input type="radio" name="missingStrategy" value="${val}" ${i === 0 ? 'checked' : ''}/>
              <span>${label}</span>
            </label>`).join('')}
        </div>
      </div>
      <div class="modal-footer" style="justify-content:flex-end;gap:8px">
        <button class="btn-settings-reset" id="missingDlgCancel">Cancel</button>
        <button class="btn-settings-apply" id="missingDlgApply">Apply to all and run</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  document.getElementById('missingDlgClose').addEventListener('click', close);
  document.getElementById('missingDlgCancel').addEventListener('click', close);

  document.getElementById('missingDlgApply').addEventListener('click', () => {
    const strategy = overlay.querySelector('input[name="missingStrategy"]:checked')?.value || 'mean';

    if (strategy === 'manual') {
      close();
      const step4Body = document.getElementById('flowStep4Body');
      if (step4Body) step4Body.scrollIntoView({ behavior: 'smooth', block: 'start' });
      missingItems.forEach(({ el }) => {
        el.classList.add('input-missing-highlight');
        el.addEventListener('input', () => el.classList.remove('input-missing-highlight'), { once: true });
      });
      _showMissingCountNotice(missingItems);
      return;
    }

    const filled = _fillMissingItems(missingItems, strategy, state, patient);
    close();
    // 'leave' strategy - flag imputed so results can show a notice
    onResolved(strategy === 'leave' ? filled : []);
  });
}

// ── RUN PREDICTIONS ───────────────────────────────────────────────────────────

// Entry point: check missing inputs first, show dialog if any, then run.
async function _runAllPredictions(state) {
  const labs    = _wizState.selectedLabs;
  const patient = _findPatient(state, _wizState.patientId);
  if (!patient) { alert('Please select a patient first.'); return; }
  if (!labs.length) { alert('Please select at least one test.'); return; }

  const missing = _checkMissingInputs(state, patient);
  if (missing.length > 0) {
    _showMissingDialog(missing, state, patient, (imputed) => {
      _wizState.imputedFields = imputed;
      _execPredictions(state, patient);
    });
    return;
  }

  _wizState.imputedFields = [];
  _execPredictions(state, patient);
}

async function _execPredictions(state, patient) {
  const labs = _wizState.selectedLabs;
  const btn = document.getElementById('runAllBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Running...'; }

  _activateStep(5);
  _updateWizardDots();
  const wrap = document.getElementById('resultsListWrap');
  wrap.innerHTML = '<div class="loading-text">Running predictions...</div>';

  try {
    // Per-lab predictions
    const predPromises = labs.map((lab) => {
      const features = _gatherFeaturesForLab(lab, state);
      const actualEl = document.getElementById(`actual_${_labId(lab)}`);
      const actual   = actualEl && actualEl.value !== '' ? parseFloat(actualEl.value) : null;
      const stored   = (patient.labs || {})[lab];
      const realCase = _isRealCase(stored, features, actual);
      const body = {
        lab, patient_id: patient.id, features, actual_next: actual,
        decision_threshold: _wizState.threshold, models: ['ngboost', 'mae'], sex: patient.sex,
        stability_overrides: (window._stabilityOverrides && Object.keys(window._stabilityOverrides).length)
          ? window._stabilityOverrides : undefined,
      };
      const _tagRealCase = (r) => {
        // r is {ngboost: {...}, mae: {...}} - tag each sub-result
        if (r && r.ngboost) r.ngboost._realCase = realCase;
        if (r && r.mae)     r.mae._realCase     = realCase;
        if (r && !r.ngboost && !r.mae) r._realCase = realCase;
        return r;
      };
      return getJSON('/api/predict', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => { return { lab, result: _tagRealCase(r) }; })
        .catch(async (e) => {
          if (e instanceof TypeError) {
            await new Promise((res) => setTimeout(res, 800));
            return getJSON('/api/predict', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }).then((r) => { return { lab, result: _tagRealCase(r) }; })
              .catch((e2) => ({ lab, error: 'Server unreachable - is it running? (' + e2.message + ')' }));
          }
          return { lab, error: e.message };
        });
    });

    // Profile predictions - run BOTH models so the joint result is shown for each.
    // Per-lab UI features are forwarded (fixes missing cross-lab inputs).
    const multiTubes = _wizState.tubes.filter((t) => t.labs.length >= 2);
    const profilePromises = multiTubes.map((tube) => {
      const featuresPerLab = {};
      tube.labs.forEach((lab) => {
        const f = _gatherFeaturesForLab(lab, state);
        if (Object.keys(f).length > 0) featuresPerLab[lab] = f;
      });
      const baseBody = {
        labs: tube.labs, patient_id: patient.id,
        features: Object.keys(featuresPerLab).length ? featuresPerLab : undefined,
        decision_threshold: _wizState.threshold,
        stability_overrides: (window._stabilityOverrides && Object.keys(window._stabilityOverrides).length)
          ? window._stabilityOverrides : undefined,
      };
      const call = (model) => getJSON('/api/predict_profile', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...baseBody, model }),
      }).then((r) => r).catch((e) => ({ available: false, error: e.message, model }));
      return Promise.all([call('ngboost'), call('mae')])
        .then(([ngboost, mae]) => ({ tubeId: tube.id, result: { ngboost, mae } }));
    });

    const [predResults, profileResults] = await Promise.all([
      Promise.all(predPromises),
      Promise.all(profilePromises),
    ]);

    _wizState.predictResults = {};
    predResults.forEach(({ lab, result, error }) => {
      _wizState.predictResults[lab] = error ? { error } : result;
    });
    _wizState.profileResults = {};
    profileResults.forEach(({ tubeId, result, error }) => {
      _wizState.profileResults[tubeId] = error ? { error } : result;
    });

    _renderResults(state);
    _collapseStep(4, 'complete');
    document.getElementById('flowStep4').classList.add('completed');
    _updateWizardDots();

  } catch (e) {
    wrap.innerHTML = `<div class="error-text">Failed: ${e.message}</div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Run all predictions'; }
  }
}

// ── G) STEP 5: Results - urgency-sorted interleaved singles AND tubes ─────────
function _renderResults(state) {
  const sortBar = document.getElementById('resultsSortBar');
  if (sortBar) sortBar.style.display = 'flex';
  _wizState.expandedCard = null;
  _doRenderResults('urgency', state);
  _renderImputedNotice();

  document.querySelectorAll('.sort-bar-btn').forEach((btn) => {
    btn.onclick = null; // clear old
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sort-bar-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      _doRenderResults(btn.dataset.sort, state);
    });
  });

  // Show H) Clear button
  _renderClearNewBtn();
}

// Banner shown when some inputs were auto-filled with population means
function _renderImputedNotice() {
  const existing = document.getElementById('imputedNotice');
  if (existing) existing.remove();
  const imputed = _wizState.imputedFields || [];
  if (!imputed.length) return;

  const wrap = document.getElementById('resultsListWrap');
  if (!wrap) return;

  const byLab = {};
  imputed.forEach(({ lab, col }) => {
    (byLab[lab] = byLab[lab] || []).push(_friendlyLabel(col, lab));
  });

  const notice = document.createElement('div');
  notice.id = 'imputedNotice';
  notice.className = 'imputed-notice';
  notice.innerHTML = `
    <span class="imputed-notice-icon">&#9432;</span>
    <div class="imputed-notice-body">
      <strong>Some inputs were filled with population means</strong>
      <div class="imputed-notice-detail">
        ${Object.entries(byLab).map(([lab, cols]) =>
          `<span class="imputed-lab-tag">${lab}: ${cols.join(', ')}</span>`
        ).join('')}
      </div>
      <div class="imputed-notice-caveat">Predictions for these inputs may be less accurate than if actual patient values were used.</div>
    </div>`;
  wrap.parentElement.insertBefore(notice, wrap);
}

// H) Clear / New analysis button
function _renderClearNewBtn() {
  let existing = document.getElementById('clearNewAnalysisBtn');
  if (existing) return;
  const wrap = document.getElementById('resultsListWrap');
  if (!wrap) return;
  const btnWrap = document.createElement('div');
  btnWrap.id = 'clearNewBtnWrap';
  btnWrap.style.cssText = 'display:flex;justify-content:flex-end;margin-bottom:var(--sp-3)';
  btnWrap.innerHTML = `<button id="clearNewAnalysisBtn" class="btn-clear-new" aria-label="Clear and start new analysis">Clear / New analysis</button>`;
  wrap.parentElement.insertBefore(btnWrap, wrap);
  document.getElementById('clearNewAnalysisBtn').addEventListener('click', _resetWizard);
}

function _resetWizard() {
  // Reset wizard state
  _wizState = {
    step: 1,
    patientId: null,
    selectedLabs: [],
    tubes: [],
    _nextTubeId: 1,
    predictResults: {},
    profileResults: {},
    threshold: 0.85,
    expandedCard: null,
    imputedFields: [],
    crossTestSharedCols: new Set(),
  };
  // Reset UI to step 1
  for (let i = 1; i <= 5; i++) {
    const step = document.getElementById(`flowStep${i}`);
    const body = document.getElementById(`flowStep${i}Body`);
    const editBtn = document.getElementById(`step${i}EditBtn`);
    const sumEl = document.getElementById(`step${i}Summary`);
    if (step) step.classList.remove('active', 'completed', 'locked');
    if (body) body.style.display = '';
    if (editBtn) editBtn.style.display = 'none';
    if (sumEl) sumEl.textContent = '';
  }
  // Unselect patient
  document.querySelectorAll('.patient-card').forEach((c) => c.classList.remove('selected'));
  // Clear results
  const wrap = document.getElementById('resultsListWrap');
  if (wrap) wrap.innerHTML = '<div class="results-empty" id="resultsEmpty">Fill values and click "Run all predictions" to see results.</div>';
  const sortBar = document.getElementById('resultsSortBar');
  if (sortBar) sortBar.style.display = 'none';
  // Remove clear button
  const btnWrap = document.getElementById('clearNewBtnWrap');
  if (btnWrap) btnWrap.remove();
  // Reset threshold slider
  const thr = document.getElementById('thrSliderWide');
  if (thr) { thr.value = '0.85'; }
  const thrVal = document.getElementById('thrValWide');
  if (thrVal) thrVal.textContent = '0.85';
  // Hide sticky bar
  const stickyBar = document.getElementById('step4StickyBar');
  if (stickyBar) stickyBar.style.display = 'none';
  // Activate step 1
  _activateStep(1);
  _updateWizardDots();
}

// G) Interleaved sort: tubes positioned by joint P(unstable), singles by P(unstable)
function _pUnstableForCard(card) {
  // card = { type: 'single'|'tube', lab?, tube? }
  if (card.type === 'single') {
    const r = _getResult(card.lab) || {};
    return r.p_stable != null ? 1 - r.p_stable : 0;
  }
  // tube: use joint skip probability if available
  const pr = _getProfileResult(card.tube.id);
  if (pr && !pr.error && pr.available !== false && pr.joint_skip != null) {
    // joint_skip = P(all stable), so P(at least one unstable) = 1 - joint_skip
    return 1 - pr.joint_skip;
  }
  // fallback: max P(unstable) of members
  const members = card.tube.labs;
  let maxUnstable = 0;
  members.forEach((l) => {
    const r = _getResult(l) || {};
    if (r.p_stable != null) maxUnstable = Math.max(maxUnstable, 1 - r.p_stable);
  });
  return maxUnstable;
}

function _doRenderResults(sortKey, state) {
  const wrap = document.getElementById('resultsListWrap');

  // Build a flat list of cards (singles + multi-lab tubes)
  // Each single-lab tube becomes a single card; each multi-lab tube becomes a tube card
  const cards = _wizState.tubes.map((tube) => {
    if (tube.labs.length === 1) {
      return { type: 'single', lab: tube.labs[0], tube };
    }
    return { type: 'tube', tube };
  });

  // Sort
  cards.sort((a, b) => {
    if (sortKey === 'urgency') {
      // Clinical mode: sort by clinical urgency category, not raw probability - REPEAT
      // with high confidence first (needs the draw, and we're sure), then REPEAT with
      // low confidence, then SKIP with low confidence (worth a second look), then SKIP
      // with high confidence last (least attention needed).
      if (isClinicalMode()) {
        const rankOf = (card) => {
          if (card.type === 'single') {
            const { ng, mae } = _resultModelsFor(card.lab);
            const pick = clinicalPickResult(ng, mae);
            if (!pick.r) return 1.5;
            const rel = pick.r.reliability || {};
            const calibTier = clinicalCalibTier(rel.calibration_score);
            const dec = calibTier.forceRepeat ? 'repeat' : pick.r.decision;
            return clinicalUrgencyRank(dec, calibTier.key);
          }
          const ranks = card.tube.labs.map((l) => {
            const { ng, mae } = _resultModelsFor(l);
            const pick = clinicalPickResult(ng, mae);
            if (!pick.r) return 1.5;
            const rel = pick.r.reliability || {};
            const calibTier = clinicalCalibTier(rel.calibration_score);
            const dec = calibTier.forceRepeat ? 'repeat' : pick.r.decision;
            return clinicalUrgencyRank(dec, calibTier.key);
          });
          return Math.min(...ranks);
        };
        return rankOf(a) - rankOf(b);
      }
      return _pUnstableForCard(b) - _pUnstableForCard(a);
    }
    if (sortKey === 'confidence') {
      const rankMap = { high: 3, moderate: 2, low: 1, unknown: 0 };
      const scoreOf = (card) => {
        if (card.type === 'single') {
          const rel = (_getResult(card.lab) || {}).reliability || {};
          return (rankMap[rel.value_level] || 0) + (rankMap[rel.decision_level] || 0);
        }
        // tube: avg of members
        const scores = card.tube.labs.map((l) => {
          const rel = (_getResult(l) || {}).reliability || {};
          return (rankMap[rel.value_level] || 0) + (rankMap[rel.decision_level] || 0);
        });
        return scores.reduce((s, v) => s + v, 0) / scores.length;
      };
      return scoreOf(b) - scoreOf(a);
    }
    if (sortKey === 'accuracy') {
      const smapeOf = (card) => {
        if (card.type === 'single') {
          const mets = ((_getResult(card.lab) || {}).reliability || {}).metrics || {};
          return mets.SMAPE_mean_pct || 999;
        }
        const vals = card.tube.labs.map((l) => {
          const mets = ((_getResult(l) || {}).reliability || {}).metrics || {};
          return mets.SMAPE_mean_pct || 999;
        });
        return Math.max(...vals);
      };
      return smapeOf(a) - smapeOf(b);
    }
    return 0;
  });

  // C) Summary counts
  // For labs inside a multi-lab tube, use the tube's JOINT decision (from profile result)
  // instead of the individual lab decision, so the banner agrees with what the card shows.
  const _labJointDecision = {};
  _wizState.tubes.forEach((tube) => {
    if (tube.labs.length <= 1) return;
    const pr = _getProfileResult(tube.id);
    if (pr && !pr.error && pr.available !== false && pr.decision) {
      tube.labs.forEach((lab) => { _labJointDecision[lab] = pr.decision; });
    }
  });
  const _effectiveDecision = (lab) => {
    if (isClinicalMode()) {
      const { ng, mae } = _resultModelsFor(lab);
      const pick = clinicalPickResult(ng, mae);
      if (pick.r) {
        const rel = pick.r.reliability || {};
        if (clinicalCalibTier(rel.calibration_score).forceRepeat) return 'repeat';
        if (_labJointDecision[lab]) return _labJointDecision[lab];
        return pick.r.decision;
      }
    }
    if (_labJointDecision[lab]) return _labJointDecision[lab];
    const r = _getResult(lab);
    return (r && !r.error) ? r.decision : null;
  };

  const totalCount  = _wizState.selectedLabs.length;
  const repeatCount = _wizState.selectedLabs.filter((l) => _effectiveDecision(l) === 'repeat').length;
  const skipCount   = _wizState.selectedLabs.filter((l) => _effectiveDecision(l) === 'skip').length;
  const errorCount  = _wizState.selectedLabs.filter((l) => !_effectiveDecision(l)).length;
  const savingsPct  = totalCount > 0 ? Math.round((skipCount / totalCount) * 100) : 0;

  const step5Summary = document.getElementById('step5Summary');
  if (step5Summary) step5Summary.textContent = `${repeatCount} REPEAT, ${skipCount} skip`;

  const summaryBanner = totalCount > 0 ? (isClinicalMode() ? `
    <div class="results-summary-banner">
      <div class="rsb-item rsb-repeat">
        <span class="rsb-num">${repeatCount}</span>
        <span class="rsb-lab">need repeating</span>
      </div>
      <div class="rsb-divider"></div>
      <div class="rsb-item rsb-skip">
        <span class="rsb-num">${skipCount}</span>
        <span class="rsb-lab">can skip</span>
      </div>
      ${errorCount > 0 ? `<div class="rsb-divider"></div><div class="rsb-item rsb-error"><span class="rsb-num">${errorCount}</span><span class="rsb-lab">errors</span></div>` : ''}
    </div>` : `
    <div class="results-summary-banner">
      <div class="rsb-item">
        <span class="rsb-num">${totalCount}</span>
        <span class="rsb-lab">tests evaluated</span>
      </div>
      <div class="rsb-divider"></div>
      <div class="rsb-item rsb-skip">
        <span class="rsb-num">${skipCount}</span>
        <span class="rsb-lab">can skip</span>
      </div>
      <div class="rsb-divider"></div>
      <div class="rsb-item rsb-repeat">
        <span class="rsb-num">${repeatCount}</span>
        <span class="rsb-lab">need repeating</span>
      </div>
      <div class="rsb-divider"></div>
      <div class="rsb-item rsb-savings">
        <span class="rsb-num">${savingsPct}%</span>
        <span class="rsb-lab">fewer draws</span>
      </div>
      ${errorCount > 0 ? `<div class="rsb-divider"></div><div class="rsb-item rsb-error"><span class="rsb-num">${errorCount}</span><span class="rsb-lab">errors</span></div>` : ''}
    </div>`) : '';

  // Render all cards into one flat list
  let html = '';
  cards.forEach((card) => {
    if (card.type === 'single') {
      html += _renderResultCard(card.lab, state);
    } else {
      html += _renderTubeResultCard(card.tube, state);
    }
  });

  wrap.innerHTML = summaryBanner + (html || '<div class="results-empty">No results.</div>');

  // Bind accordion
  _bindResultAccordion(wrap, state);
}

// Re-render results when display mode changes
document.addEventListener('displayModeChanged', () => {
  if (_wizState && _wizState.step === 5 && _wizState.predictResults) {
    _doRenderResults('urgency', _wizState);
  }
});

// G) Single result card
// Renders a compact secondary row showing the OTHER model's result under the primary card.
function _renderMaeSecondaryRow(lab, r, q, modelName = 'mae') {
  const tag = _modelLabel(modelName);
  if (!r || r.available === false || r.error) {
    const msg = r ? (r.error || r.message || `Not covered by ${tag} model`) : `Not covered by ${tag} model`;
    return `<div class="mae-secondary-row mae-unavail">
      <span class="mae-model-tag">${tag}</span>
      <span class="mae-unavail-text">${msg}</span>
    </div>`;
  }
  const dec      = r.decision === 'skip';
  const pct      = (r.p_stable * 100).toFixed(1) + '%';
  const pColor   = dec ? 'var(--green)' : 'var(--red)';
  const predicted = _qfmt(r.value != null ? r.value : r.mu, q);
  const ci       = r.ci95 ? `[${_qfmt(Math.max(r.ci95[0], 0), q)} - ${_qfmt(r.ci95[1], q)}]` : '';
  const rel      = r.reliability || {};
  const vScore   = rel.value_score        != null ? rel.value_score        : null;
  const cScore   = rel.calibration_score  != null ? rel.calibration_score  : null;
  return `<div class="mae-secondary-row ${dec ? 'mae-skip' : 'mae-repeat'}">
    <span class="mae-model-tag">${tag}</span>
    <span class="mae-decision ${dec ? 'skip' : 'repeat'}">${dec ? '&#10003; SKIP' : '&#8635; REPEAT'}</span>
    <span class="mae-pstable" style="color:${pColor}">${pct}</span>
    <span class="mae-value">${predicted} <span class="mae-ci">${ci}</span></span>
    <span class="mae-trust">${_trustChips(vScore, cScore)}</span>
  </div>`;
}

function _renderResultCard(lab, state) {
  const { ng: ngR, mae: maeR } = _resultModelsFor(lab);
  const ok = (x) => x && !x.error && x.available !== false;
  const verdict = modelVerdict(ngR, maeR);
  const verdictBanner = modelVerdictBanner(verdict);

  // Headline = NGBoost if it has a model, else MAE (so a lab only one model covers
  // still opens and shows that model's prediction + scores). Secondary = the other.
  let primaryModel, r, secondaryModel, secondaryR;
  if (ok(ngR))      { primaryModel = 'ngboost'; r = ngR;  secondaryModel = 'mae';     secondaryR = maeR; }
  else if (ok(maeR)){ primaryModel = 'mae';     r = maeR; secondaryModel = 'ngboost'; secondaryR = ngR;  }
  else {
    const msg = (ngR && (ngR.error || ngR.message)) || (maeR && (maeR.error || maeR.message))
              || (_wizState.predictResults[lab] && _wizState.predictResults[lab].error) || 'No result';
    return `<div class="result-card" id="rcard_${_labId(lab)}" data-lab="${lab}" data-cardtype="single">
      <div class="result-card-compact" style="cursor:default">
        <span class="rc-lab-name-wrap"><span class="ngb-model-tag">NGBoost</span>${lab}</span>
        <span class="error-text" style="font-size:11px;padding:2px 6px;grid-column:2/-1">${msg}</span>
      </div>
      <div class="result-card-detail" id="rdetail_${_labId(lab)}"></div>
    </div>`;
  }

  const q         = r.quant_step;
  const clinical  = isClinicalMode();

  if (clinical) {
    // Single consistent model pick - same one the expanded detail will use, so
    // the compact card and the opened detail never disagree on which model's
    // numbers are shown.
    const pick      = clinicalPickResult(ngR, maeR);
    const cr         = pick.r || r;
    const crel       = cr.reliability || {};
    const vScore     = crel.value_score       != null ? crel.value_score       : null;
    const cScore     = crel.calibration_score != null ? crel.calibration_score : null;
    const valueTier  = clinicalValueTier(vScore);
    const calibTier  = clinicalCalibTier(cScore);
    const dec        = calibTier.forceRepeat ? false : (cr.decision === 'skip');
    const pct        = (cr.p_stable * 100).toFixed(1) + '%';
    const pColor     = dec ? 'var(--green)' : 'var(--red)';
    const predicted  = _qfmt(cr.value != null ? cr.value : cr.mu, cr.quant_step);
    const realBadge  = cr._realCase
      ? '<span class="rc-real-badge real" title="Real patient inputs with a known next result - this tests the model">REAL</span>'
      : '<span class="rc-real-badge manual" title="Values were entered or edited by hand - not a verified real case">MANUAL</span>';
    const probHtml = calibTier.useProb
      ? `<span class="rc-pstable" style="color:${pColor}">${pct}<br><span class="clinical-tier-note tier-${calibTier.key}">${clinicalTierIconHtml(calibTier.key)}${calibTier.label}</span></span>`
      : `<span class="clinical-tier-note tier-${calibTier.key}" style="display:block">${clinicalTierIconHtml(calibTier.key)}${calibTier.label}</span>`;
    const prevNum  = _finiteNumber(cr.prev1);
    const predNum  = cr.value != null ? cr.value : cr.mu;
    const firstNum = _finiteNumber(cr.inputs && cr.inputs['first_in_adm_' + lab]);
    const miniMarker = valueTier.show && cr.ci95
      ? renderMiniRangeSvg(prevNum, predNum, cr.ci95[0], cr.ci95[1])
      : '';
    const sparkline = valueTier.show
      ? renderSparklineSvg(firstNum, prevNum, predNum)
      : '';
    const valueHtml = valueTier.show
      ? `<span class="rc-predicted">${predicted}<br><span class="clinical-tier-note tier-${valueTier.key}">${clinicalTierIconHtml(valueTier.key)}${valueTier.label}</span>
          <span class="clinical-mini-marker">${miniMarker}${sparkline}</span></span>`
      : `<span class="clinical-tier-note tier-${valueTier.key}">${clinicalTierIconHtml(valueTier.key)}${valueTier.label}</span>`;
    const disagreeNote = pick.disagree
      ? `<div class="clinical-disagree-note"><span class="clinical-disagree-icon">&#9878;</span>The two models disagree - showing the safer recommendation</div>`
      : '';
    return `<div class="result-card" id="rcard_${_labId(lab)}" data-lab="${lab}" data-cardtype="single">
      <div class="result-card-compact clinical-compact ${dec ? 'skip-row' : 'repeat-row'}">
        <span class="rc-lab-name-wrap">${lab} ${realBadge}</span>
        <span class="rc-decision-badge ${dec ? 'skip' : 'repeat'}">${dec ? '&#10003; SKIP' : '&#8635; REPEAT'}</span>
        ${probHtml}
        ${valueHtml}
        <span class="rc-expand-icon">&#9660;</span>
      </div>
      ${disagreeNote}
      <div class="result-card-detail" id="rdetail_${_labId(lab)}">
        <div class="skeleton-card">
          <div class="skeleton-line skeleton-lg"></div>
          <div class="skeleton-line skeleton-md"></div>
          <div class="skeleton-line skeleton-sm"></div>
        </div>
      </div>
    </div>`;
  }

  const rel       = r.reliability || {};
  const vScore    = rel.value_score       != null ? rel.value_score       : null;
  const cScore    = rel.calibration_score != null ? rel.calibration_score : null;
  const dec       = (r.decision === 'skip');
  const pct       = (r.p_stable * 100).toFixed(1) + '%';
  const pColor    = dec ? 'var(--green)' : 'var(--red)';
  const predicted = _qfmt(r.value != null ? r.value : r.mu, q);
  const ci        = r.ci95 ? `[${_qfmt(Math.max(r.ci95[0], 0), q)} - ${_qfmt(r.ci95[1], q)}]` : '';
  const realBadge = r._realCase
    ? '<span class="rc-real-badge real" title="Real patient inputs with a known next result - this tests the model">REAL</span>'
    : '<span class="rc-real-badge manual" title="Values were entered or edited by hand - not a verified real case">MANUAL</span>';

  const trustDotHtml = `<div class="rc-confidence">${_trustChips(vScore, cScore)}</div>`;
  // Secondary row only when the lab has a second model at all (covered or not).
  const maeRowHtml   = (secondaryR != null)
    ? _renderMaeSecondaryRow(lab, secondaryR, (secondaryR && secondaryR.quant_step) || q, secondaryModel)
    : '';

  return `<div class="result-card" id="rcard_${_labId(lab)}" data-lab="${lab}" data-cardtype="single">
    <div class="result-card-compact ${dec ? 'skip-row' : 'repeat-row'}">
      <span class="rc-lab-name-wrap"><span class="ngb-model-tag">${_modelLabel(primaryModel)}</span>${lab} ${realBadge}</span>
      <span class="rc-decision-badge ${dec ? 'skip' : 'repeat'}">${dec ? '&#10003; SKIP' : '&#8635; REPEAT'}</span>
      <span class="rc-pstable" style="color:${pColor}">${pct}</span>
      <span class="rc-predicted">${predicted}<br><span style="font-size:10px;color:var(--muted)">${ci}</span></span>
      ${trustDotHtml}
      <span class="rc-expand-icon">&#9660;</span>
    </div>
    ${maeRowHtml}
    ${verdictBanner}
    <div class="result-card-detail" id="rdetail_${_labId(lab)}">
      <div class="skeleton-card">
        <div class="skeleton-line skeleton-lg"></div>
        <div class="skeleton-line skeleton-md"></div>
        <div class="skeleton-line skeleton-sm"></div>
      </div>
    </div>
  </div>`;
}

// Compact secondary joint row for the OTHER model (mirrors the single-lab MAE row).
function _renderTubeSecondaryRow(otherR, otherModel) {
  const tag = _modelLabel(otherModel);
  if (!otherR || otherR.error || otherR.available === false || otherR.joint_skip == null) {
    const msg = otherR ? (otherR.error || otherR.message || `${tag} could not evaluate this panel jointly`)
                       : `Not evaluated by ${tag}`;
    return `<div class="mae-secondary-row mae-unavail">
      <span class="mae-model-tag">${tag}</span>
      <span class="mae-unavail-text">${msg}</span>
    </div>`;
  }
  const dec = otherR.decision === 'skip';
  const pct = (otherR.joint_skip * 100).toFixed(1) + '%';
  return `<div class="mae-secondary-row ${dec ? 'mae-skip' : 'mae-repeat'}">
    <span class="mae-model-tag">${tag}</span>
    <span class="mae-decision ${dec ? 'skip' : 'repeat'}">${dec ? '&#10003; SKIP' : '&#8635; REPEAT'}</span>
    <span class="mae-pstable" style="color:${dec ? 'var(--green)' : 'var(--red)'}">P(all stable) ${pct}</span>
  </div>`;
}

// Joint-profile verdict for a tube. Same logic as single tests (conservative on
// disagreement, "about the same" within 5 pts), but the calibration score is the
// AVERAGE member calibration for each model (a tube has no single calibration).
function _tubeVerdict(tube) {
  const ng  = _getProfileResultFor(tube.id, 'ngboost');
  const mae = _getProfileResultFor(tube.id, 'mae');
  const ok = (r) => r && !r.error && r.available !== false && r.decision;
  const a = ok(ng), b = ok(mae);
  if (!a && !b) return { state: 'none' };
  if (a && !b)  return { state: 'single', only: 'ngboost', score: _tubeAvgCalibration(tube, 'ng') };
  if (!a && b)  return { state: 'single', only: 'mae',     score: _tubeAvgCalibration(tube, 'mae') };
  return _verdictFrom(ng.decision, mae.decision, _tubeAvgCalibration(tube, 'ng'), _tubeAvgCalibration(tube, 'mae'));
}

// G) Tube result card - shows the joint result for BOTH models (NGBoost first).
// Panel/tube rollup (item 8): count how many member labs need a second look (forced
// repeat due to poor calibration, poor value reliability, or a model disagreement) so a
// doctor scanning a CBC panel doesn't have to expand all 18 rows to know if anything
// needs attention.
function _panelFlagCount(tube) {
  let flagged = 0;
  tube.labs.forEach((lab) => {
    const { ng, mae } = _resultModelsFor(lab);
    const pick = clinicalPickResult(ng, mae);
    if (!pick.r) { flagged++; return; }
    const rel = pick.r.reliability || {};
    const calibTier = clinicalCalibTier(rel.calibration_score);
    const valueTier = clinicalValueTier(rel.value_score);
    // calibTier.forceRepeat is exactly calibTier.key === 'poor' - this is the case the
    // doctor specifically asked about: a test forced to REPEAT only because calibration
    // is too low to trust a skip call (the model itself may have said skip).
    if (calibTier.forceRepeat || valueTier.key === 'poor' || pick.disagree) flagged++;
  });
  return { flagged, total: tube.labs.length };
}

function _renderTubeResultCard(tube, state) {
  // Primary = NGBoost joint if usable, else MAE (so a panel only one model can do
  // jointly still shows). Secondary = the other model's joint row.
  const ngR  = _getProfileResultFor(tube.id, 'ngboost');
  const maeR = _getProfileResultFor(tube.id, 'mae');
  const ok = (r) => r && !r.error && r.available !== false;
  let primaryModel, profResult, secondaryModel, otherR;
  if (ok(ngR))      { primaryModel = 'ngboost'; profResult = ngR;  secondaryModel = 'mae';     otherR = maeR; }
  else if (ok(maeR)){ primaryModel = 'mae';     profResult = maeR; secondaryModel = 'ngboost'; otherR = ngR;  }
  else              { primaryModel = 'ngboost'; profResult = ngR || maeR; secondaryModel = 'mae'; otherR = maeR; }
  const hasProfResult = profResult && !profResult.error && profResult.available !== false;

  const jointSkip = hasProfResult && profResult.joint_skip != null
    ? (profResult.joint_skip * 100).toFixed(1) + '%'
    : null;
  const jointDec = hasProfResult ? profResult.decision : null;

  const pc = PANEL_COLORS[tube.panelFamily] || { color: '#374151', bg: '#f3f4f6' };
  const borderColor = tube.isPanel ? pc.color : 'var(--navy)';

  const clinical = isClinicalMode();
  const tubeRowClass = `result-card-compact tube-compact${clinical ? ' clinical-compact' : ''}${jointDec ? (jointDec === 'skip' ? ' skip-row' : ' repeat-row') : ''}`;
  return `<div class="result-card tube-result-card" id="rcard_tube_${tube.id}" data-tubeid="${tube.id}" data-cardtype="tube">
    <div class="${tubeRowClass}" data-tubeid="${tube.id}">
      <span class="rc-lab-name-wrap" style="font-size:12px">${clinical ? '' : `<span class="ngb-model-tag">${_modelLabel(primaryModel)}</span>`}${tube.name}</span>
      <span class="rc-tube-members">${tube.labs.length} tests</span>
      ${clinical ? (() => {
        const { flagged, total } = _panelFlagCount(tube);
        return flagged > 0
          ? `<span class="clinical-panel-chip chip-flag" title="${flagged} of ${total} tests need a second look">&#9650; ${flagged} of ${total} flagged</span>`
          : `<span class="clinical-panel-chip chip-clear" title="All tests in this panel look reliable">&#9679; all clear</span>`;
      })() : ''}
      ${hasProfResult && jointSkip ? `
        <span class="rc-decision-badge ${jointDec === 'skip' ? 'skip' : 'repeat'}">
          ${jointDec === 'skip' ? '&#10003; SKIP' : '&#8635; REPEAT'}
        </span>
        <span class="rc-pstable" style="color:${jointDec === 'skip' ? 'var(--green)' : 'var(--red)'}">P(all stable) ${jointSkip}</span>` : ''}
      <span class="rc-expand-icon">&#9660;</span>
      ${clinical ? '' : `<span class="rc-tube-chips">${tube.labs.map((l) => `<span class="tube-mini-chip">${l}</span>`).join('')}</span>`}
    </div>
    ${clinical ? '' : _renderTubeSecondaryRow(otherR, secondaryModel)}
    ${clinical ? '' : modelVerdictBanner(_tubeVerdict(tube))}
    <div class="result-card-detail" id="rdetail_tube_${tube.id}">
      <div class="loading-text" style="padding:12px 0">Loading detail...</div>
    </div>
  </div>`;
}

function _bindResultAccordion(wrap, state) {
  wrap.querySelectorAll('.result-card-compact').forEach((compact) => {
    compact.addEventListener('click', () => {
      const card = compact.closest('.result-card');
      if (!card) return;
      const cardType = card.dataset.cardtype;
      const isOpen   = card.classList.contains('expanded');

      // Close all
      wrap.querySelectorAll('.result-card').forEach((c) => c.classList.remove('expanded'));
      _wizState.expandedCard = null;

      if (!isOpen) {
        card.classList.add('expanded');
        if (cardType === 'tube') {
          const tubeId = card.dataset.tubeid;
          _wizState.expandedCard = 'tube_' + tubeId;
          _renderTubeDetail(tubeId, state);
        } else {
          const lab = card.dataset.lab;
          _wizState.expandedCard = lab;
          _renderCardDetail(lab, state);
        }
      }
    });
  });
}

// ── Model comparison mini-table (value + calibration per model) ────────────────
// A small, tidy table summarising BOTH models so the doctor can compare value and
// calibration at a glance, even when only the higher-calibration model's full detail
// is shown below it. Reused by single tests and tube members; a joint variant below.
function _miniCellScore(score) {
  if (score == null) return '<span class="mmt-score" style="color:var(--muted)">-</span>';
  const q = modelQuality(score);
  return `<span class="mmt-score" style="color:${q.color}">${score}<span class="mmt-band">${q.label}</span></span>`;
}

function _miniRowSingle(lab, model, r, isPrimary) {
  const tag = _modelLabel(model);
  if (!r || r.error || r.available === false || r.decision == null) {
    const msg = r ? (r.error || r.message || `no ${tag} model for this test`) : `${tag} not run`;
    return `<tr class="mmt-unavail"><td class="mmt-model">${tag}</td><td colspan="4" class="mmt-na">${msg}</td></tr>`;
  }
  const rel = r.reliability || {};
  const q   = r.quant_step;
  const val = _qfmt(r.value != null ? r.value : r.mu, q);
  const ci  = r.ci95 ? `<span class="mmt-ci">[${_qfmt(Math.max(r.ci95[0], 0), q)} - ${_qfmt(r.ci95[1], q)}]</span>` : '';
  const dec = r.decision === 'skip';
  const pct = r.p_stable != null ? (r.p_stable * 100).toFixed(1) + '%' : '-';
  return `<tr class="${isPrimary ? 'mmt-primary' : ''}">
    <td class="mmt-model">${tag}${isPrimary ? '<span class="mmt-shown">shown below</span>' : ''}</td>
    <td>${val} ${ci}</td>
    <td>${_miniCellScore(rel.value_score != null ? rel.value_score : null)}</td>
    <td>${_miniCellScore(rel.calibration_score != null ? rel.calibration_score : null)}</td>
    <td><span class="mmt-dec ${dec ? 'skip' : 'repeat'}">${dec ? 'SKIP' : 'REPEAT'}</span> <span style="color:${dec ? 'var(--green)' : 'var(--red)'}">${pct}</span></td>
  </tr>`;
}

function _compareTableSingle(lab, ngR, maeR, pick) {
  const showBoth = pick.show === 'both' || pick.show === 'none';
  const cap = pick.show === 'none' ? ''
    : showBoth ? 'Calibration is about the same - both models shown below.'
    : `Higher calibration: <strong>${_modelLabel(pick.primary)}</strong> - its full detail is shown below.`;
  return `<div class="model-mini-table-wrap">
    <div class="mmt-title">Model comparison${cap ? ` <span class="mmt-cap">${cap}</span>` : ''}</div>
    <table class="model-mini-table">
      <thead><tr><th>Model</th><th>Predicted value</th><th>Value score</th><th>Calibration</th><th>Decision</th></tr></thead>
      <tbody>
        ${_miniRowSingle(lab, 'ngboost', ngR, !showBoth && pick.primary === 'ngboost')}
        ${_miniRowSingle(lab, 'mae', maeR, !showBoth && pick.primary === 'mae')}
      </tbody>
    </table>
  </div>`;
}

// Average member calibration for a tube under one model ('ng' | 'mae'). A tube has no
// single calibration, so we average the per-member calibration scores that exist.
function _tubeAvgCalibration(tube, which) {
  const vals = tube.labs.map((l) => {
    const rr = _resultModelsFor(l)[which];
    return (rr && !rr.error && rr.available !== false && rr.reliability)
      ? rr.reliability.calibration_score : null;
  }).filter((v) => v != null);
  return vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : null;
}

// Which model's joint detail to lead with (higher avg member calibration, both if tie).
function _tubeJointPick(tube) {
  const ng  = _getProfileResultFor(tube.id, 'ngboost');
  const mae = _getProfileResultFor(tube.id, 'mae');
  const ok = (r) => r && !r.error && r.available !== false && r.joint_skip != null;
  return pickModelsByCalibration(
    ok(ng), ok(mae),
    ok(ng) ? _tubeAvgCalibration(tube, 'ng') : null,
    ok(mae) ? _tubeAvgCalibration(tube, 'mae') : null);
}

function _miniRowJoint(tube, model, jr, avgC, isPrimary) {
  const tag = _modelLabel(model);
  if (!jr || jr.error || jr.available === false || jr.joint_skip == null) {
    const msg = jr ? (jr.message || jr.error || 'no joint result') : 'not evaluated';
    return `<tr class="mmt-unavail"><td class="mmt-model">${tag}</td><td colspan="2" class="mmt-na">${msg}</td></tr>`;
  }
  const dec = jr.decision === 'skip';
  const pct = (jr.joint_skip * 100).toFixed(1) + '%';
  return `<tr class="${isPrimary ? 'mmt-primary' : ''}">
    <td class="mmt-model">${tag}${isPrimary ? '<span class="mmt-shown">leads below</span>' : ''}</td>
    <td><span style="color:${dec ? 'var(--green)' : 'var(--red)'}">${pct}</span> <span class="mmt-dec ${dec ? 'skip' : 'repeat'}">${dec ? 'SKIP' : 'REPEAT'}</span></td>
    <td>${_miniCellScore(avgC)}</td>
  </tr>`;
}

function _compareTableJoint(tube, pick) {
  const ng  = _getProfileResultFor(tube.id, 'ngboost');
  const mae = _getProfileResultFor(tube.id, 'mae');
  const ngC = _tubeAvgCalibration(tube, 'ng'), maeC = _tubeAvgCalibration(tube, 'mae');
  const showBoth = pick.show === 'both' || pick.show === 'none';
  const cap = pick.show === 'none' ? ''
    : showBoth ? 'Average calibration is about the same - both joint results shown.'
    : `Higher avg calibration: <strong>${_modelLabel(pick.primary)}</strong> - its joint detail leads below.`;
  return `<div class="model-mini-table-wrap">
    <div class="mmt-title">Joint model comparison${cap ? ` <span class="mmt-cap">${cap}</span>` : ''}</div>
    <table class="model-mini-table">
      <thead><tr><th>Model</th><th>Joint P(all stable)</th><th>Avg calibration</th></tr></thead>
      <tbody>
        ${_miniRowJoint(tube, 'ngboost', ng, ngC, !showBoth && pick.primary === 'ngboost')}
        ${_miniRowJoint(tube, 'mae', mae, maeC, !showBoth && pick.primary === 'mae')}
      </tbody>
    </table>
  </div>`;
}

// G) Render expanded single card detail - comparison table + the higher-calibration
// model's full detail (BOTH when calibration is about the same or a score is missing).
function _renderCardDetail(lab, state) {
  const detail = document.getElementById(`rdetail_${_labId(lab)}`);
  if (!detail) return;

  if (isClinicalMode()) {
    _renderCardDetailClinical(lab, detail);
    return;
  }

  const { ng, mae } = _resultModelsFor(lab);
  const verdictBanner = modelVerdictBanner(modelVerdict(ng, mae));
  const pick = pickModelsToShow(ng, mae);
  const table = _compareTableSingle(lab, ng, mae, pick);
  const showBoth = pick.show === 'both' || pick.show === 'none';

  let blocks, toDraw;
  if (showBoth) {
    blocks = `${_modelDetailHtml(lab, ng, 'ngboost')}
      <div class="detail-model-divider"></div>
      ${_modelDetailHtml(lab, mae, 'mae')}`;
    toDraw = [['ngboost', ng], ['mae', mae]];
  } else {
    const r = pick.show === 'mae' ? mae : ng;
    blocks = _modelDetailHtml(lab, r, pick.show);
    toDraw = [[pick.show, r]];
  }

  detail.innerHTML = `${verdictBanner}${table}${blocks}`;
  toDraw.forEach(([m, rr]) => {
    if (rr && !rr.error && rr.available !== false && rr.mu != null && rr.sigma != null) {
      const el = document.getElementById(`belldet_${m}_${_labId(lab)}`);
      if (el) renderBell(el, rr.mu, rr.sigma, rr.stability_window, rr.ci95);
    }
  });
}

function _renderCardDetailClinical(lab, detail) {
  const { ng, mae } = _resultModelsFor(lab);
  const pick = clinicalPickResult(ng, mae);
  const r = pick.r;
  if (!r) {
    detail.innerHTML = '<div class="clinical-detail" style="color:var(--muted);font-size:12px">No model data available.</div>';
    return;
  }
  const q = r.quant_step;
  const rel = r.reliability || {};
  const calibTier = clinicalCalibTier(rel.calibration_score);
  const valueTier = clinicalValueTier(rel.value_score);
  const disagreeBlock = pick.disagree
    ? `<div class="clinical-disagree-note"><span class="clinical-disagree-icon">&#9878;</span>NGBoost and Masked AE disagree on this test - the safer recommendation is shown.</div>`
    : '';
  const calibBlock = `<div class="clinical-tier-block tier-${calibTier.key}">${clinicalTierIconHtml(calibTier.key)}${calibTier.label}</div>`;
  const valueBlock = `<div class="clinical-tier-block tier-${valueTier.key}">${clinicalTierIconHtml(valueTier.key)}${valueTier.label}</div>`;

  const bellId = `bellclin_${_labId(lab)}`;
  let graphHtml = '';
  if (valueTier.show && r.mu != null && r.sigma != null) {
    const prevNum = _finiteNumber(r.prev1);
    const predDisp = _qfmt(r.value != null ? r.value : r.mu, q);
    const ciStr = r.ci95 ? `${_qfmt(Math.max(r.ci95[0], 0), q)} - ${_qfmt(r.ci95[1], q)}` : '-';
    const prevDisp = prevNum != null ? _qfmt(prevNum, q) : '-';
    graphHtml = `
      <div class="clinical-graph-block">
        <svg id="${bellId}" viewBox="0 0 220 120" preserveAspectRatio="xMidYMid meet"></svg>
        <div class="clinical-graph-legend">
          <div class="cgl-item"><span class="cgl-dot cgl-prev"></span>Previous result: <strong>${prevDisp}</strong></div>
          <div class="cgl-item"><span class="cgl-dot cgl-pred"></span>Predicted: <strong>${predDisp}</strong></div>
          <div class="cgl-item">95% range: <strong>${ciStr}</strong></div>
        </div>
      </div>`;
  }

  const imps = clinicalImportances(r, pick.other);
  const impHtml = imps.length ? `
    <div class="detail-section-head" style="margin-top:var(--sp-2)">Key influencing factors</div>
    <div class="importances-list">
      ${imps.map((f, i) => {
        const color = IMP_COLORS[i % IMP_COLORS.length];
        const pct = typeof f.pct === 'number' ? f.pct : parseFloat(f.pct) || 0;
        return `<div class="imp-row">
          <span class="imp-name">${_friendlyLabel(f.feature, lab)}</span>
          <span class="imp-track">
            <span class="imp-fill" style="width:${pct}%;background:${color}"></span>
          </span>
          <span class="imp-pct" style="color:${color}">${pct.toFixed(1)}%</span>
        </div>`;
      }).join('')}
    </div>` : '<div style="color:var(--muted);font-size:12px">No feature importance data.</div>';

  detail.innerHTML = `<div class="clinical-detail">${disagreeBlock}${calibBlock}${valueBlock}${graphHtml}${impHtml}</div>`;

  if (valueTier.show && r.mu != null && r.sigma != null) {
    const el = document.getElementById(bellId);
    if (el) renderBell(el, r.mu, r.sigma, r.stability_window, r.ci95, _finiteNumber(r.prev1));
  }
}

// Full rich detail block for ONE model: header, bell, stats, decision, key factors,
// trust analysis, stability context, MCE warning, trust banner, verification.
function _modelDetailHtml(lab, r, model) {
  const _tag = _modelLabel(model);
  const _tagCls = model === 'mae' ? 'mae-model-tag' : 'ngb-model-tag';
  const _head = `<div class="detail-model-head"><span class="${_tagCls}">${_tag}</span> full detail</div>`;
  if (!r || r.error || r.available === false) {
    const _msg = r ? (r.error || r.message || `${_tag} has no model for this lab`) : `${_tag} was not run`;
    return `<div class="detail-model-section">${_head}<div class="sec-model-unavail">${_msg}</div></div>`;
  }

  const rel    = r.reliability || {};
  const vl     = rel.value_level    || 'unknown';
  const dl     = rel.decision_level || 'unknown';
  const mets   = rel.metrics || {};
  const dec    = r.decision === 'skip';
  const q      = r.quant_step;
  const predDisp = _qfmt(r.value != null ? r.value : r.mu, q);  // shown rounded to the lab's step

  // G) TRUST block with NUMERIC scores
  const vScore = rel.value_score       != null ? rel.value_score       : null;
  const cScore = rel.calibration_score != null ? rel.calibration_score : null;
  const smapeMed = mets.SMAPE_med_pct  != null ? mets.SMAPE_med_pct.toFixed(1) + '%'
                 : mets.SMAPE_mean_pct != null ? mets.SMAPE_mean_pct.toFixed(1) + '%' : '-';
  const ece    = mets.ECE              != null ? mets.ECE.toFixed(4) : '-';
  const bss    = mets.BSS_pct          != null ? mets.BSS_pct.toFixed(1) + '%' : '-';
  const ntot   = mets.n_test           != null ? Math.round(mets.n_test) : '-';
  const mce    = mets.MCE              != null ? parseFloat(mets.MCE) : null;
  // Population context so a population-level MAE is never mistaken for THIS prediction's error.
  const meanVal = mets.mean_val != null ? mets.mean_val.toFixed(1) : null;
  const maePop  = mets.MAE != null && meanVal != null
    ? `Across ${ntot} ${lab} tests (population avg ${meanVal}) the average miss is ${mets.MAE.toFixed(1)}.`
    : '';

  const sigmaStr  = r.sigma != null ? r.sigma.toFixed(3) : '-';
  const thrStr    = r.stability_threshold != null ? r.stability_threshold : '-';
  const win = _windowBounds(r.stability_window);
  const windowStr = win ? `[${Math.max(win[0], 0)} - ${win[1]}]` : '-';

  const mceWarning = mce != null && mce > 0.1
    ? `<div class="trust-row">
         <span class="trust-row-icon">&#9888;</span>
         <span class="trust-row-text"><strong>MCE warning:</strong> MCE = ${mce.toFixed(4)} - calibration error is high in at least one confidence range.</span>
       </div>` : '';

  // G) TRUST block: numeric scores + one-line explanations
  const trustLevel = _compositeTrust(vl, dl);
  const trustHtml = `
    <div class="trust-analysis">
      <div class="trust-analysis-title">Trust analysis</div>
      <div class="trust-scores-row">
        <div class="trust-score-block teal-trust">
          <span class="trust-score-num" style="color:${_scoreColor(vScore)}">${vScore != null ? vScore : '-'}<span class="tsn-max">/100</span></span>
          <span class="trust-score-band" style="color:${_scoreColor(vScore)}">${_scoreBandLabel(vScore)}</span>
          <span class="trust-score-label">Trust in the value</span>
          <span class="trust-score-how">How well we hit the number. 0.4 x SMAPE-score + 0.6 x NRMSE-score (NRMSE weighted higher because big misses are riskier).</span>
          <span class="trust-score-sub">${rel.value_text || ''} ${maePop}</span>
        </div>
        <div class="trust-score-block navy-trust">
          <span class="trust-score-num" style="color:${_scoreColor(cScore)}">${cScore != null ? cScore : '-'}<span class="tsn-max">/100</span></span>
          <span class="trust-score-band" style="color:${_scoreColor(cScore)}">${_scoreBandLabel(cScore)}</span>
          <span class="trust-score-label">Trust in the probability</span>
          <span class="trust-score-how">Calibration (ECE, MCE) gated by skill (BSS): a model no better than guessing is pulled down, but good calibration is not zeroed.</span>
          <span class="trust-score-sub">${rel.decision_text || ''} ECE: ${ece} | BSS: ${bss}</span>
        </div>
      </div>
      <div class="trust-row" style="margin-top:var(--sp-2)">
        <span class="trust-row-icon">&#8505;</span>
        <span class="trust-row-text">
          <strong>Stability context:</strong>
          Threshold = ${thrStr}, predicted sigma = ${sigmaStr}, stability window = ${windowStr}.
          ${r.sigma && r.stability_threshold && r.sigma > r.stability_threshold * 2
            ? 'High sigma relative to window - value prediction may be accurate but the stability window is tight.'
            : 'Sigma is within normal range relative to the stability window.'}
        </span>
      </div>
      ${mceWarning}
      <div class="trust-overall ${trustLevel}">
        ${trustLevel === 'high' ? '&#10003; HIGH TRUST' : trustLevel === 'moderate' ? '&#8505; MODERATE TRUST - apply clinical judgment' : '&#9888; LOW TRUST - rough estimate only'}
      </div>
    </div>`;

  // G) Feature importance bars: COLORED + percentage labels visible
  const imps = r.importances || [];
  const impHtml = imps.length ? `
    <div class="detail-section-head" style="margin-top:var(--sp-4)">Key influencing factors</div>
    <div class="importances-list">
      ${imps.map((f, i) => {
        const color = IMP_COLORS[i % IMP_COLORS.length];
        const pct   = typeof f.pct === 'number' ? f.pct : parseFloat(f.pct) || 0;
        return `<div class="imp-row">
          <span class="imp-name">${_friendlyLabel(f.feature, lab)}</span>
          <span class="imp-track">
            <span class="imp-fill" style="width:${pct}%;background:${color}"></span>
          </span>
          <span class="imp-pct" style="color:${color}">${pct.toFixed(1)}%</span>
        </div>`;
      }).join('')}
    </div>` : '';

  // G) Verification story: prev -> prediction (CI) -> actual
  let verifHtml = '';
  if (r.verification) {
    const v = r.verification;
    const vstatus = v.status === 'STABLE' ? 'stable' : 'unstable';
    const prevNum = _finiteNumber(r.prev1);
    const prevVal = prevNum != null ? _qfmt(prevNum, q) : '?';
    const predStr = _qfmt(r.value != null ? r.value : r.mu, q);
    const ciStr   = r.ci95 ? `(CI: ${_qfmt(Math.max(r.ci95[0], 0), q)} - ${_qfmt(r.ci95[1], q)})` : '';
    verifHtml = `
      <div class="verification-block">
        <div class="vb-title">Verification - did we predict correctly?</div>
        <div class="verif-story">
          <div class="verif-step">
            <span class="verif-label">Previous result</span>
            <span class="verif-val">${prevVal}</span>
          </div>
          <div class="verif-arrow">&#8594;</div>
          <div class="verif-step">
            <span class="verif-label">Our prediction ${ciStr}</span>
            <span class="verif-val">${predStr}</span>
          </div>
          <div class="verif-arrow">&#8594;</div>
          <div class="verif-step">
            <span class="verif-label">Actual next result</span>
            <span class="verif-val verif-actual">${_qfmt(v.actual, q)}</span>
          </div>
        </div>
        <div style="margin-top:var(--sp-2);font-size:12px">
          Status: <span class="badge ${vstatus}">${v.status}</span>
          | Overlap: <strong>${v.overlap_pct}%</strong>
          ${v.percentile != null ? ` | Percentile: <strong>${v.percentile.toFixed(1)}</strong>` : ''}
          ${v.decision_correct != null ? ` | Decision: <strong>${v.decision_correct ? 'Correct' : 'Incorrect'}</strong>` : ''}
        </div>
      </div>`;
  }

  // Asymmetric spread: the value is modeled on a log scale, so back-transformed the
  // distribution is right-skewed. Show the real -/+ deviation, never a symmetric sigma.
  let ciDevStr = r.sigma != null ? 'spread ' + r.sigma.toFixed(2) : '-';
  let skewNote = '';
  if (r.mu != null && r.ci95) {
    const effLo = Math.max(r.ci95[0], 0);
    const loDev = r.mu - effLo;
    const hiDev = r.ci95[1] - r.mu;
    ciDevStr = `-${loDev.toFixed(2)} / +${hiDev.toFixed(2)}`;
    if (hiDev > loDev * 1.3) {
      skewNote = `<span class="stat-sub">Right-skewed (log scale): longer upper tail is expected.</span>`;
    }
  }

  const bellId = `belldet_${model}_${_labId(lab)}`;
  return `<div class="detail-model-section">
    ${_head}
    <div class="detail-top-grid">
      <div class="detail-bell-block">
        <svg id="${bellId}" viewBox="0 0 220 120" preserveAspectRatio="xMidYMid meet"></svg>
      </div>
      <div class="detail-stats-block">
        <div class="detail-stats-grid">
          <div class="stat-item">
            <span class="stat-label">Predicted value</span>
            <span class="stat-val">${predDisp}</span>
            <span class="stat-sub">${ciDevStr}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">95% CI</span>
            <span class="stat-val" style="font-size:13px">[${r.ci95 ? _qfmt(Math.max(r.ci95[0], 0), q) + ' - ' + _qfmt(r.ci95[1], q) : '-'}]</span>
            ${skewNote}
          </div>
          <div class="stat-item">
            <span class="stat-label">P(stable)</span>
            <span class="stat-val" style="color:${dec ? 'var(--green)' : 'var(--red)'}">${(r.p_stable * 100).toFixed(1)}%</span>
            <span class="stat-sub">Threshold: ${(r.decision_threshold * 100).toFixed(0)}%</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Previous value</span>
            <span class="stat-val">${_finiteNumber(r.prev1) != null ? _finiteNumber(r.prev1).toFixed(3) : '-'}</span>
          </div>
        </div>
        <div style="margin-top:var(--sp-3)">
          <span class="rc-decision-badge ${dec ? 'skip' : 'repeat'}" style="font-size:14px;padding:8px 16px">
            ${dec ? '&#10003; SKIP - Result likely stable' : '&#8635; REPEAT - Draw test'}
          </span>
        </div>
      </div>
    </div>
    ${impHtml}
    ${trustHtml}
    ${verifHtml}
  </div>`;
}

// G) Render expanded tube detail
function _renderTubeDetail(tubeId, state) {
  const detail = document.getElementById(`rdetail_tube_${tubeId}`);
  if (!detail) return;
  const tube = _wizState.tubes.find((t) => t.id === tubeId);
  if (!tube) return;

  if (isClinicalMode()) {
    _renderTubeDetailClinical(tube, detail, state);
    return;
  }

  // Joint comparison table for BOTH models, then the joint analysis of the model with
  // the higher AVERAGE member calibration (both panels only when about the same).
  const pick = _tubeJointPick(tube);
  const showBothJoint = pick.show === 'both' || pick.show === 'none';

  let html = modelVerdictBanner(_tubeVerdict(tube)) + _compareTableJoint(tube, pick);

  const jointSummaryFor = (model) => {
    const pr = _getProfileResultFor(tubeId, model);
    const tagCls = model === 'mae' ? 'mae-model-tag' : 'ngb-model-tag';
    if (!pr) return '';
    if (pr.error) return `<div class="error-text" style="margin-bottom:var(--sp-3)">${_modelLabel(model)} joint profile failed: ${pr.error}</div>`;
    if (pr.available === false) return `<div class="tube-detail-summary">
        <div class="tube-detail-title">${tube.name} <span class="${tagCls}">${_modelLabel(model)}</span></div>
        <div class="tube-joint-explain muted">${pr.message || 'Joint analysis unavailable for this model.'}</div>
      </div>`;
    if (pr.joint_skip == null) return '';
    const jointSkip = (pr.joint_skip * 100).toFixed(1) + '%';
    const isSkip    = pr.decision === 'skip';
    const indepBase = pr.independent_baseline != null ? (pr.independent_baseline * 100).toFixed(1) + '%' : null;
    const corrEffect = pr.correlation_effect != null
      ? (pr.correlation_effect * 100).toFixed(1)
      : (pr.independent_baseline != null && pr.joint_skip != null
          ? ((pr.joint_skip - pr.independent_baseline) * 100).toFixed(1) : null);
    return `
      <div class="tube-detail-summary">
        <div class="tube-detail-title">${tube.name} - joint analysis <span class="${tagCls}">${_modelLabel(model)}</span></div>
        <div class="tube-joint-badge ${isSkip ? 'skip' : 'repeat'}">
          Joint P(all stable): <strong>${jointSkip}</strong>
          ${isSkip ? '- SKIP all tests' : '- REPEAT (at least one test needed)'}
        </div>
        <div class="tube-joint-explain">
          ${indepBase ? `Assuming independence: ${indepBase}. ` : ''}
          ${corrEffect != null ? `Correlation effect: ${parseFloat(corrEffect) >= 0 ? '+' : ''}${corrEffect}% (tests move ${parseFloat(corrEffect) >= 0 ? 'together, raising joint stability' : 'independently, lowering joint stability'}).` : ''}
        </div>
      </div>`;
  };

  if (showBothJoint) {
    html += jointSummaryFor('ngboost');
    html += jointSummaryFor('mae');
  } else {
    html += jointSummaryFor(pick.show);
  }

  // Intra-tube correlation map (only if >= 2 labs)
  if (tube.labs.length >= 2) {
    html += `
      <div class="detail-section-head">Intra-tube correlations</div>
      <div id="tubeCorr_${tubeId}" style="margin-bottom:var(--sp-3)">
        <div class="loading-text" style="font-size:12px;padding:8px 0">Loading correlations...</div>
      </div>`;
  }

  // Each member test is an accordion - click to open its graph and detail.
  html += `<div class="detail-section-head">Individual test results <span class="dsh-hint">(click a test to open its graph)</span></div>`;
  tube.labs.forEach((lab) => {
    const { ng, mae } = _resultModelsFor(lab);
    const mpick = pickModelsToShow(ng, mae);
    const pm = mpick.primary || (mpick.show === 'mae' ? 'mae' : 'ngboost');
    const r  = pm === 'mae' ? mae : ng;
    const ngDec  = (ng  && !ng.error  && ng.available  !== false) ? ng.decision  : null;
    const maeDec = (mae && !mae.error && mae.available !== false) ? mae.decision : null;
    const differ = ngDec && maeDec && ngDec !== maeDec;
    const ok  = r && !r.error && r.available !== false && r.p_stable != null;
    const dec = ok && r.decision === 'skip';
    const tagCls = pm === 'mae' ? 'mae-model-tag' : 'ngb-model-tag';
    html += `
      <div class="tube-member-result" data-lab="${lab}">
        <div class="tube-member-header" data-tubemember="${lab}">
          <span class="tube-member-lab"><span class="${tagCls}" style="font-size:9px;margin-right:4px">${_modelLabel(pm)}</span>${lab}${_labCoverageBadge(lab, state)}</span>
          ${ok
            ? `<span class="rc-decision-badge ${dec ? 'skip' : 'repeat'}" style="font-size:11px">${dec ? '&#10003; SKIP' : '&#8635; REPEAT'}</span>
               <span class="rc-pstable" style="color:${dec ? 'var(--green)' : 'var(--red)'}">P(stable): ${(r.p_stable * 100).toFixed(1)}%</span>
               ${differ ? '<span class="mmt-differ" title="The two models disagree on this test - see detail below">models differ</span>' : ''}`
            : `<span class="error-text" style="font-size:11px">${r ? (r.error || r.message || 'No model covers this lab') : ''}</span>`}
          <span class="rc-expand-icon" style="margin-left:auto">&#9660;</span>
        </div>
        <div class="tube-member-detail" id="tubeMemberDetail_${tubeId}_${_labId(lab)}"></div>
      </div>`;
  });

  detail.innerHTML = html;

  // Member accordion: render the graph lazily on first open (one open at a time).
  detail.querySelectorAll('.tube-member-header').forEach((hdr) => {
    hdr.addEventListener('click', () => {
      const row = hdr.closest('.tube-member-result');
      if (!row) return;
      const lab = row.dataset.lab;
      const wasOpen = row.classList.contains('expanded');
      detail.querySelectorAll('.tube-member-result').forEach((r2) => r2.classList.remove('expanded'));
      if (!wasOpen) {
        row.classList.add('expanded');
        const el = document.getElementById(`tubeMemberDetail_${tubeId}_${_labId(lab)}`);
        if (el && !el.dataset.rendered) { _renderMemberDetailInline(el, lab, state); el.dataset.rendered = '1'; }
      }
    });
  });

  // Load intra-tube correlations
  if (tube.labs.length >= 2) {
    const corrEl = document.getElementById(`tubeCorr_${tubeId}`);
    if (corrEl) {
      getJSON('/api/profile/correlations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labs: tube.labs }),
      }).then((data) => {
        if (!data.matrix || !data.labs || !data.labs.length) {
          corrEl.innerHTML = '<div style="font-size:12px;color:var(--muted)">Correlation data not available for these tests.</div>';
          return;
        }
        const avgStr = data.avg_abs_r != null ? data.avg_abs_r.toFixed(2) : '-';
        const homoText = data.avg_abs_r != null
          ? (data.homogeneity === 'high' ? 'These tests move together strongly.'
            : data.homogeneity === 'moderate' ? 'These tests move somewhat together.'
            : 'These tests move relatively independently.')
          : '';
        corrEl.innerHTML = `
          <div class="panel-corr-summary" style="margin-bottom:var(--sp-2)">
            Avg |r|: <strong>${avgStr}</strong>
            <span class="homogeneity-badge homogeneity-${data.homogeneity || 'low'}" style="margin-left:6px">${data.homogeneity || 'unknown'}</span>
            ${homoText ? `<span style="font-size:11px;color:var(--muted);margin-left:8px">${homoText}</span>` : ''}
          </div>
          <div class="chart-wrap" style="padding:var(--sp-2);overflow-x:auto">
            <svg id="tubeMatSvg_${tubeId}" width="100%"></svg>
          </div>`;
        const svg = document.getElementById(`tubeMatSvg_${tubeId}`);
        if (svg && typeof _renderCorrMatrix === 'function') _renderCorrMatrix(svg, data.labs, data.matrix);
        else if (svg) _renderTubeMatrix(svg, data.labs, data.matrix);
      }).catch(() => {
        if (corrEl) corrEl.innerHTML = '<div style="font-size:12px;color:var(--muted)">Correlation data unavailable.</div>';
      });
    }
  }

}

function _renderTubeDetailClinical(tube, detail, state) {
  const pr = _getProfileResult(tube.id);
  const hasJoint = pr && !pr.error && pr.available !== false && pr.joint_skip != null;
  let html = '';
  if (hasJoint) {
    const jointPct = (pr.joint_skip * 100).toFixed(1) + '%';
    const isSkip = pr.decision === 'skip';
    html += `<div class="tube-detail-summary" style="margin-bottom:var(--sp-3)">
      <div class="tube-joint-badge ${isSkip ? 'skip' : 'repeat'}">
        Joint P(all stable): <strong>${jointPct}</strong>
        ${isSkip ? '- SKIP all tests' : '- REPEAT (at least one test needed)'}
      </div>
    </div>`;
  }

  html += `<div class="detail-section-head">Individual test results</div>`;
  tube.labs.forEach((lab) => {
    const { ng, mae } = _resultModelsFor(lab);
    const pick = clinicalPickResult(ng, mae);
    const r = pick.r;
    const ok = !!r;
    const rel = ok ? (r.reliability || {}) : {};
    const calibTier = clinicalCalibTier(rel.calibration_score);
    const valueTier = clinicalValueTier(rel.value_score);
    const dec = ok ? (calibTier.forceRepeat ? false : r.decision === 'skip') : false;
    const q = ok ? r.quant_step : 1;
    const disagreeFlag = ok && pick.disagree ? '<span class="clinical-disagree-flag" title="Models disagree - safer recommendation shown">&#9878;</span>' : '';

    html += `<div class="tube-member-result" data-lab="${lab}">
      <div class="tube-member-header" data-tubemember="${lab}">
        <span class="tube-member-lab">${lab}${disagreeFlag}</span>
        ${ok ? `
          <span class="rc-decision-badge ${dec ? 'skip' : 'repeat'}" style="font-size:11px">${dec ? '&#10003; SKIP' : '&#8635; REPEAT'}</span>
          ${calibTier.useProb
            ? `<span class="rc-pstable" style="color:${dec ? 'var(--green)' : 'var(--red)'}">P(stable): ${(r.p_stable * 100).toFixed(1)}%</span>`
            : `<span class="clinical-tier-note tier-${calibTier.key}">${clinicalTierIconHtml(calibTier.key)}${calibTier.label}</span>`}
          ${valueTier.show ? `<span style="font-size:11px;color:var(--ink-2)">${_qfmt(r.value != null ? r.value : r.mu, q)}</span>` : ''}
        ` : `<span class="error-text" style="font-size:11px">No data</span>`}
        <span class="rc-expand-icon" style="margin-left:auto">&#9660;</span>
      </div>
      <div class="tube-member-detail" id="tubeMemberDetail_${tube.id}_${_labId(lab)}"></div>
    </div>`;
  });

  detail.innerHTML = html;

  detail.querySelectorAll('.tube-member-header').forEach((hdr) => {
    hdr.addEventListener('click', () => {
      const row = hdr.closest('.tube-member-result');
      if (!row) return;
      const lab = row.dataset.lab;
      const wasOpen = row.classList.contains('expanded');
      detail.querySelectorAll('.tube-member-result').forEach((r2) => r2.classList.remove('expanded'));
      if (!wasOpen) {
        row.classList.add('expanded');
        const el = document.getElementById(`tubeMemberDetail_${tube.id}_${_labId(lab)}`);
        if (el && !el.dataset.rendered) {
          _renderCardDetailClinical(lab, el);
          el.dataset.rendered = '1';
        }
      }
    });
  });
}

// Render a mini correlation matrix for a tube (in case performance.js version isn't available)
function _renderTubeMatrix(svg, labs, matrix) {
  if (typeof _renderCorrMatrix === 'function') {
    _renderCorrMatrix(svg, labs, matrix);
  }
}

// Inline member detail inside a tube - dual-model, same rule as single tests:
// comparison table + the higher-calibration model's block (both when about the same).
function _renderMemberDetailInline(el, lab, state) {
  const { ng, mae } = _resultModelsFor(lab);
  const pick = pickModelsToShow(ng, mae);
  const banner = modelVerdictBanner(modelVerdict(ng, mae));
  const table  = _compareTableSingle(lab, ng, mae, pick);
  const showBoth = pick.show === 'both' || pick.show === 'none';

  let blocks, toDraw;
  if (showBoth) {
    blocks = `${_memberModelBlockHtml(lab, ng, 'ngboost')}<div class="detail-model-divider"></div>${_memberModelBlockHtml(lab, mae, 'mae')}`;
    toDraw = [['ngboost', ng], ['mae', mae]];
  } else {
    const r = pick.show === 'mae' ? mae : ng;
    blocks = _memberModelBlockHtml(lab, r, pick.show);
    toDraw = [[pick.show, r]];
  }

  el.innerHTML = `${banner}${table}${blocks}`;
  toDraw.forEach(([m, rr]) => {
    if (rr && !rr.error && rr.available !== false && rr.mu != null && rr.sigma != null) {
      const bell = document.getElementById(`mbell_${m}_${_labId(lab)}`);
      if (bell) renderBell(bell, rr.mu, rr.sigma, rr.stability_window, rr.ci95);
    }
  });
}

// Compact per-model body for a tube member (bell graph + stats + trust + importances).
function _memberModelBlockHtml(lab, r, model) {
  const tag = _modelLabel(model);
  const tagCls = model === 'mae' ? 'mae-model-tag' : 'ngb-model-tag';
  const head = `<div class="member-model-head"><span class="${tagCls}">${tag}</span></div>`;
  if (!r || r.error || r.available === false) {
    const msg = r ? (r.error || r.message || `${tag} has no model for this lab`) : `${tag} was not run`;
    return `<div class="member-model-block">${head}<div class="sec-model-unavail" style="font-size:11px">${msg}</div></div>`;
  }

  const rel    = r.reliability || {};
  const vScore = rel.value_score != null ? rel.value_score : null;
  const cScore = rel.calibration_score != null ? rel.calibration_score : null;
  const mets   = rel.metrics || {};
  const ece    = mets.ECE != null ? mets.ECE.toFixed(4) : '-';
  const bss    = mets.BSS_pct != null ? mets.BSS_pct.toFixed(1) + '%' : '-';
  const q      = r.quant_step;
  const predDisp = _qfmt(r.value != null ? r.value : r.mu, q);
  const bellId = `mbell_${model}_${_labId(lab)}`;
  const trustRow = `
    <div class="member-trust-row">
      <span><b style="color:${_scoreColor(vScore)}">${vScore != null ? vScore : '-'}</b> value <span class="mtr-band" style="color:${_scoreColor(vScore)}">${_scoreBandLabel(vScore)}</span></span>
      <span><b style="color:${_scoreColor(cScore)}">${cScore != null ? cScore : '-'}</b> probability <span class="mtr-band" style="color:${_scoreColor(cScore)}">${_scoreBandLabel(cScore)}</span></span>
      <span class="mtr-metrics">ECE ${ece} | BSS ${bss}</span>
    </div>`;

  const imps = r.importances || [];
  const impHtml = imps.length ? `
    <div class="importances-list importances-compact">
      ${imps.slice(0, 5).map((f, i) => {
        const color = IMP_COLORS[i % IMP_COLORS.length];
        const pct   = typeof f.pct === 'number' ? f.pct : parseFloat(f.pct) || 0;
        return `<div class="imp-row">
          <span class="imp-name">${_friendlyLabel(f.feature, lab)}</span>
          <span class="imp-track"><span class="imp-fill" style="width:${pct}%;background:${color}"></span></span>
          <span class="imp-pct" style="color:${color}">${pct.toFixed(1)}%</span>
        </div>`;
      }).join('')}
    </div>` : '';

  // Verification (real next result) when available
  let verif = '';
  if (r.verification) {
    const v = r.verification;
    const prevNum = _finiteNumber(r.prev1);
    const prevTxt = prevNum != null ? _qfmt(prevNum, q) : '?';
    verif = `<div class="tube-member-verif">Prev ${prevTxt} &#8594; predicted ${predDisp} &#8594; actual <strong>${_qfmt(v.actual, q)}</strong> (${v.status}, ${v.decision_correct ? 'decision correct' : 'decision wrong'})</div>`;
  }

  return `
    <div class="member-model-block">
      ${head}
      <div class="tube-member-body">
        <div class="detail-top-grid" style="grid-template-columns:170px 1fr;gap:var(--sp-4)">
          <div class="detail-bell-block">
            <svg id="${bellId}" viewBox="0 0 220 120" preserveAspectRatio="xMidYMid meet"></svg>
          </div>
          <div>
            <div class="detail-stats-grid" style="grid-template-columns:1fr 1fr;margin-bottom:var(--sp-2)">
              <div class="stat-item">
                <span class="stat-label">Predicted</span>
                <span class="stat-val" style="font-size:15px">${predDisp}</span>
                <span class="stat-sub">CI: ${r.ci95 ? _qfmt(Math.max(r.ci95[0], 0), q) + ' - ' + _qfmt(r.ci95[1], q) : '-'}</span>
              </div>
              <div class="stat-item">
                <span class="stat-label">Trust (value / prob)</span>
                <span class="stat-val" style="font-size:13px">${_trustChips(vScore, cScore)}</span>
                <span class="stat-sub">${_scoreBandLabel(vScore)}</span>
              </div>
            </div>
            ${trustRow}
            ${impHtml}
          </div>
        </div>
        ${verif}
      </div>
    </div>`;
}

// ── Wizard flow control ───────────────────────────────────────────────────────
function _compositeTrust(vl, dl) {
  const rankMap = { high: 2, moderate: 1, low: 0, unknown: 0 };
  const total = (rankMap[vl] || 0) + (rankMap[dl] || 0);
  if (total >= 4) return 'high';
  if (total >= 2) return 'moderate';
  return 'low';
}

// Color + label a 0-100 trust score by the canonical confidence bands (modelQuality
// in app.js, single source of truth): >=90 excellent, >=75 very good, >=50 reasonable,
// <=49 poor.
function _scoreColor(score) {
  if (score == null) return 'var(--muted)';
  return modelQuality(score).color;
}
function _scoreBandLabel(score) {
  if (score == null) return 'Unknown';
  const lbl = modelQuality(score).label;
  return lbl.charAt(0).toUpperCase() + lbl.slice(1);
}

// Two labeled, color-by-value trust chips for the compact row.
function _trustChips(vScore, cScore) {
  const GUIDE = 'Score guide: 90+ excellent | 75-89 very good | 50-74 reasonable | <50 poor';
  const chip = (val, lab, desc) => val == null ? '' : `
    <span class="rc-score-chip" title="${desc} | ${GUIDE}">
      <span class="rcs-num" style="color:${_scoreColor(val)}">${val}</span>
      <span class="rcs-lab">${lab}</span>
    </span>`;
  return `<div class="rc-trust-pair">
    ${chip(vScore, 'value', 'Value accuracy: how close the predicted number is to actual (SMAPE/NRMSE).')}
    ${chip(cScore, 'prob', 'Probability calibration: how reliable the P(stable) percentage is (ECE/BSS).')}
  </div>`;
}

function _activateStep(n) {
  _wizState.step = n;
  for (let i = 1; i <= 5; i++) {
    const s = document.getElementById(`flowStep${i}`);
    if (!s) continue;
    const body = document.getElementById(`flowStep${i}Body`);
    if (i < n) {
      s.classList.remove('active', 'locked');
    } else if (i === n) {
      s.classList.remove('completed', 'locked');
      s.classList.add('active');
      if (body) body.style.display = '';
    } else {
      s.classList.remove('active', 'completed');
      s.classList.add('locked');
      if (body) body.style.display = 'none';
    }
  }
  // Show/hide the sticky threshold bar only on step 4
  const stickyBar = document.getElementById('step4StickyBar');
  if (stickyBar) stickyBar.style.display = (n === 4) ? 'block' : 'none';
}

function _collapseStep(n, summaryText) {
  const body    = document.getElementById(`flowStep${n}Body`);
  const step    = document.getElementById(`flowStep${n}`);
  const editBtn = document.getElementById(`step${n}EditBtn`);
  if (body)    body.style.display = 'none';
  if (step)    step.classList.remove('active');
  if (editBtn) editBtn.style.display = 'inline-block';
  const sumEl = document.getElementById(`step${n}Summary`);
  if (sumEl && summaryText) sumEl.textContent = summaryText;
}

function _updateWizardDots() {
  const n = _wizState.step;
  document.querySelectorAll('.wizard-step-dot').forEach((dot) => {
    const s = parseInt(dot.dataset.step);
    dot.classList.remove('active', 'completed');
    if (s < n) dot.classList.add('completed');
    else if (s === n) dot.classList.add('active');
  });
  document.querySelectorAll('.wizard-connector').forEach((conn, idx) => {
    conn.classList.toggle('completed', idx + 1 < n);
  });
}

// ── Bind top-level events ─────────────────────────────────────────────────────
function _bindWizardEvents(state) {
  const btnConfirm2 = document.getElementById('btnConfirmTests');
  if (btnConfirm2) btnConfirm2.addEventListener('click', () => {
    if (!_wizState.selectedLabs.length) { alert('Please select at least one test.'); return; }
    _collapseStep(2, `${_wizState.selectedLabs.length} tests`);
    document.getElementById('flowStep2').classList.add('completed');
    _buildStep3(state);
    if (_wizState.selectedLabs.length > 1) {
      _activateStep(3);
    }
    _updateWizardDots();
  });

  const btnConfirm3 = document.getElementById('btnConfirmGroups');
  if (btnConfirm3) btnConfirm3.addEventListener('click', () => {
    _collapseStep(3, `${_wizState.tubes.filter((t) => t.labs.length >= 2).length} tube(s)`);
    document.getElementById('flowStep3').classList.add('completed');
    _buildStep4(state);
    _activateStep(4);
    _updateWizardDots();
  });

  [1, 2, 3, 4].forEach((n) => {
    const btn = document.getElementById(`step${n}EditBtn`);
    if (!btn) return;
    btn.addEventListener('click', () => {
      const body = document.getElementById(`flowStep${n}Body`);
      if (body) body.style.display = '';
      const step = document.getElementById(`flowStep${n}`);
      if (step) { step.classList.add('active'); step.classList.remove('completed'); }
      btn.style.display = 'none';
      for (let i = n + 1; i <= 5; i++) {
        const s = document.getElementById(`flowStep${i}`);
        if (s) { s.classList.remove('active', 'completed'); s.classList.add('locked'); }
        const b2 = document.getElementById(`flowStep${i}Body`);
        if (b2) b2.style.display = 'none';
        const eb = document.getElementById(`step${i}EditBtn`);
        if (eb) eb.style.display = 'none';
        const sumEl = document.getElementById(`step${i}Summary`);
        if (sumEl) sumEl.textContent = '';
      }
      _wizState.step = n;
      _updateWizardDots();
    });
  });

  const runBtn = document.getElementById('runAllBtn');
  if (runBtn) runBtn.addEventListener('click', () => _runAllPredictions(state));

  // Expose for settings.js so Apply with stability overrides can re-run predictions
  window._rerunPredictions = () => {
    if (_wizState.selectedLabs && _wizState.selectedLabs.length > 0 && _wizState.patientId) {
      _runAllPredictions(state);
    }
  };
}

// ── Utility ───────────────────────────────────────────────────────────────────
// Display rounding: every prediction is shown at the lab's own reporting step
// (quant_step), e.g. AST to the nearest 1, Creatinine to 0.01, pH to 0.5.
function _quantRound(v, q) { return (!q || q <= 0 || v == null) ? v : Math.round(v / q) * q; }
function _quantDecimals(q) {
  if (!q || q <= 0) return 2;
  const s = q.toString(); const i = s.indexOf('.');
  return i < 0 ? 0 : (s.length - i - 1);
}
function _qfmt(v, q) {
  if (v == null || !Number.isFinite(Number(v))) return '-';
  return _quantRound(v, q).toFixed(_quantDecimals(q));
}

function _labId(lab)  { return lab.replace(/[^a-zA-Z0-9]/g, '_'); }
function _safeId(col) { return col.replace(/[^a-zA-Z0-9]/g, '_'); }
