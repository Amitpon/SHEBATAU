/**
 * app.js - Bootstrap for the Sheba CDSS multi-section app.
 *
 * Fetches: patients, labs, models, panels, lab_norms.
 * Hands off to section modules after init.
 */

// ── Shared fetch helper ───────────────────────────────────────────────────────
async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch (_) {}
    throw new Error(msg);
  }
  return r.json();
}

// ── Model quality bands (SINGLE source of truth, used everywhere) ───────────────
// >=90 excellent ; >=75 very good ; >=60 reasonable ; <=59 poor. A score gap <=
// closeDelta is treated as "about the same" (a pragmatic stand-in for statistical
// significance; we have no per-lab score confidence intervals to run a true test).
const QUALITY = { excellentMin: 90, veryGoodMin: 75, okMin: 60, closeDelta: 5 };

function modelQuality(score) {
  if (score == null) return { key: 'unknown', label: 'unknown', color: '#9ca3af' };
  if (score >= QUALITY.excellentMin) return { key: 'excellent',  label: 'excellent',  color: '#15803d' };
  if (score >= QUALITY.veryGoodMin)  return { key: 'verygood',   label: 'very good',  color: '#65a30d' };
  if (score >= QUALITY.okMin)        return { key: 'reasonable', label: 'reasonable', color: '#d97706' };
  return { key: 'poor', label: 'poor', color: '#dc2626' };
}

// ── Dual-model verdict ─────────────────────────────────────────────────────────
// Compares the two models for one test (or one tube). Two rules from the clinician:
//   1) If the two CALIBRATION scores are within QUALITY.closeDelta points, the models
//      are "about the same" - we don't crown a winner.
//   2) If the two models DISAGREE on skip/repeat, recommend the CONSERVATIVE call:
//      whichever model says REPEAT (i.e. perform the test). Safety beats calibration.
function modelVerdict(ngR, maeR) {
  const ok = (r) => r && r.available !== false && !r.error && r.decision;
  const a = ok(ngR), b = ok(maeR);
  if (!a && !b) return { state: 'none' };
  if (a && !b)  return { state: 'single', only: 'ngboost', score: (ngR.reliability || {}).calibration_score };
  if (!a && b)  return { state: 'single', only: 'mae',     score: (maeR.reliability || {}).calibration_score };
  return _verdictFrom(ngR.decision, maeR.decision,
                      (ngR.reliability || {}).calibration_score,
                      (maeR.reliability || {}).calibration_score);
}

// Core verdict from two decisions + two calibration scores (reused by tubes).
function _verdictFrom(ngDecision, maeDecision, ngC, maeC) {
  const agree = ngDecision === maeDecision;
  const bothScores = ngC != null && maeC != null;
  const diff = bothScores ? Math.abs(ngC - maeC) : null;
  const close = bothScores && diff <= QUALITY.closeDelta;
  const betterCalib = bothScores ? (ngC > maeC ? 'ngboost' : maeC > ngC ? 'mae' : null)
                                 : (ngC != null ? 'ngboost' : maeC != null ? 'mae' : null);
  if (!agree) {
    // Conservative = the model that says REPEAT (draw the test).
    const conservative = ngDecision === 'repeat' ? 'ngboost' : 'mae';
    // If the calibration gap IS significant (>closeDelta) follow the better-calibrated
    // model even if it says SKIP. Otherwise (gap not significant, or a score missing)
    // fall back to the conservative call - safety wins when calibration can't decide.
    const sigGap = bothScores && diff > QUALITY.closeDelta;
    const recommended = sigGap ? betterCalib : conservative;
    const basis = sigGap ? 'calibration' : 'conservative';
    return { state: 'disagree', ngDecision, maeDecision, ngC, maeC, diff, close, betterCalib, conservative, recommended, basis };
  }
  // Agree: recommend the clearly-better-calibrated one, unless they're about the same.
  const recommended = close ? null : betterCalib;
  return { state: 'agree', decision: ngDecision, ngDecision, maeDecision, ngC, maeC, diff, close, recommended };
}

// ── Which model's full detail to SHOW ──────────────────────────────────────────
// The clinician's rule for the expanded detail (single tests AND tube joints):
// show a comparison table for both, but the full numbers of ONLY the model with the
// higher CALIBRATION score - unless the gap is not significant (<= closeDelta) or a
// score is missing, in which case show BOTH elegantly. One model available -> show it.
//   returns { show: 'none'|'ngboost'|'mae'|'both', primary, ngC, maeC, diff, close }
function pickModelsByCalibration(ngOk, maeOk, ngC, maeC) {
  if (!ngOk && !maeOk) return { show: 'none' };
  if (ngOk && !maeOk)  return { show: 'ngboost', primary: 'ngboost', only: true, ngC, maeC: null };
  if (!ngOk && maeOk)  return { show: 'mae',     primary: 'mae',     only: true, ngC: null, maeC };
  const bothScores = ngC != null && maeC != null;
  const diff = bothScores ? Math.abs(ngC - maeC) : null;
  const close = bothScores && diff <= QUALITY.closeDelta;
  // Can't compare (a score missing) OR about the same -> show both.
  if (!bothScores || close) {
    const primary = ngC != null && maeC != null ? (ngC >= maeC ? 'ngboost' : 'mae')
                  : ngC != null ? 'ngboost' : maeC != null ? 'mae' : 'ngboost';
    return { show: 'both', primary, ngC, maeC, diff, close };
  }
  const primary = ngC > maeC ? 'ngboost' : 'mae';
  return { show: primary, primary, secondary: primary === 'ngboost' ? 'mae' : 'ngboost', ngC, maeC, diff, close: false };
}

// Same rule applied to two single-lab prediction results (calibration from reliability).
function pickModelsToShow(ngR, maeR) {
  const ok = (r) => r && r.available !== false && !r.error && r.decision != null;
  const cOf = (r) => (r && r.reliability && r.reliability.calibration_score != null) ? r.reliability.calibration_score : null;
  const ngOk = ok(ngR), maeOk = ok(maeR);
  return pickModelsByCalibration(ngOk, maeOk, ngOk ? cOf(ngR) : null, maeOk ? cOf(maeR) : null);
}

// HTML banner for a dual-model verdict (works for single tests and tubes).
function modelVerdictBanner(v) {
  if (!v || v.state === 'none') return '';
  const ML = (m) => (m === 'mae' ? 'Masked AE' : 'NGBoost');
  const qtxt = (m, s) => (s != null ? `${ML(m)} ${s}/100 (${modelQuality(s).label})` : `${ML(m)} (no score)`);
  const DEC = (d) => (d === 'skip' ? 'SKIP' : 'REPEAT');

  if (v.state === 'single') {
    const other = v.only === 'mae' ? 'NGBoost' : 'Masked AE';
    return `<div class="agree-banner agree-single">
      <span class="agree-icon">&#8505;</span>
      <span>Only <strong>${ML(v.only)}</strong> has a model for this test (${modelQuality(v.score).label}). ${other} does not cover it, so there is nothing to compare.</span>
    </div>`;
  }
  const scorePair = `${qtxt('ngboost', v.ngC)} vs ${qtxt('mae', v.maeC)}`;

  if (v.state === 'disagree') {
    const recDec = v.recommended === 'ngboost' ? v.ngDecision : v.maeDecision;
    if (v.basis === 'calibration') {
      // Calibration gap is significant -> trust the better-calibrated model's call.
      return `<div class="agree-banner agree-no">
        <span class="agree-icon">&#9888;</span>
        <span><strong>Models disagree</strong> - NGBoost says ${DEC(v.ngDecision)}, Masked AE says ${DEC(v.maeDecision)}.
        Calibration differs clearly, so follow the better-calibrated model: <strong>${ML(v.recommended)} - ${DEC(recDec)}</strong>.
        <span class="agree-sub">Calibration: ${scorePair} (gap ${v.diff} pts > ${QUALITY.closeDelta}).</span></span>
      </div>`;
    }
    // Gap not significant (or unknown) -> conservative: draw the test.
    return `<div class="agree-banner agree-no">
      <span class="agree-icon">&#9888;</span>
      <span><strong>Models disagree</strong> - NGBoost says ${DEC(v.ngDecision)}, Masked AE says ${DEC(v.maeDecision)}.
      Calibration is ${v.close ? 'about the same' : 'not comparable'}, so take the safer call: <strong>REPEAT - draw the test</strong> (the ${ML(v.conservative)} recommendation).
      <span class="agree-sub">Calibration: ${scorePair}.</span></span>
    </div>`;
  }
  // agree. Safety caution: agreeing to SKIP while BOTH are poorly calibrated (<60)
  // is the risky case - flag it rather than reassure.
  const lowSkip = v.decision === 'skip' && v.ngC != null && v.maeC != null
                && v.ngC < QUALITY.okMin && v.maeC < QUALITY.okMin;
  const caution = lowSkip
    ? `<span class="agree-sub">&#9888; Both agree to SKIP but neither is well-calibrated here - consider drawing the test on clinical judgment.</span>`
    : '';
  const cls = lowSkip ? 'agree-banner agree-no' : 'agree-banner agree-yes';
  const icon = lowSkip ? '&#9888;' : '&#10003;';
  if (v.close || v.recommended == null) {
    return `<div class="${cls}">
      <span class="agree-icon">${icon}</span>
      <span>Both models <strong>agree</strong>: ${DEC(v.decision)}. They are <strong>about the same reliability</strong> here (${scorePair}).${caution}</span>
    </div>`;
  }
  return `<div class="${cls}">
    <span class="agree-icon">${icon}</span>
    <span>Both models <strong>agree</strong>: ${DEC(v.decision)}. If you weight one, <strong>${ML(v.recommended)}</strong> is more reliable here (${scorePair}).${caution}</span>
  </div>`;
}

// ── Global app state ──────────────────────────────────────────────────────────
const state = {
  patients: [],
  labs: [],
  labMap: {},
  models: [],
  panels: {},
  norms: {},  // lab_norms: { Lab: {typical, low, high, spread} }
  labCoverage: {},  // { Lab: {ngboost: bool, mae: bool} }
  inputSchemas: {},  // { Lab: {ngboost[], mae[], union[], derived[], models_by_feature{}} }
};

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function init() {
  try {
    [state.patients, state.labs, state.models, state.panels, state.norms, state.inputSchemas] = await Promise.all([
      getJSON('/api/patients'),
      getJSON('/api/labs'),
      getJSON('/api/models'),
      getJSON('/api/panels'),
      getJSON('/api/lab_norms'),
      getJSON('/api/input_schemas').catch(() => ({})),  // per-lab inputs for BOTH models
    ]);

    state.labs.forEach((l) => (state.labMap[l.lab] = l));

    // Load model coverage in background (non-blocking)
    getJSON('/api/lab_model_coverage')
      .then((d) => { state.labCoverage = d || {}; })
      .catch(() => { state.labCoverage = {}; });

    initNav();
    initPatientSection(state);
    if (typeof initSettings === 'function') initSettings();

  } catch (e) {
    document.body.innerHTML = `
      <div style="padding:48px 32px;font-family:sans-serif;max-width:520px;margin:auto">
        <h2 style="color:#dc2626;margin:0 0 12px">Startup failed</h2>
        <p style="color:#374151;margin:0 0 8px">${e.message}</p>
        <p style="color:#6b7280;font-size:13px">Make sure the backend is running: <code>run.bat</code></p>
      </div>`;
  }
}

init();
