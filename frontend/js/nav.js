/**
 * nav.js - Top navigation.
 * Switches between Patient / Models / Performance / Sensitivity sections.
 */

const NAV_SECTIONS = ['patient', 'models', 'performance', 'sensitivity'];

function initNav() {
  // The top nav bar is kept hidden - welcome cards and the Home button handle navigation.
  document.querySelectorAll('.nav-tab').forEach((tab) => {
    tab.addEventListener('click', () => switchSection(tab.dataset.section));
  });

  // Welcome landing page cards
  document.querySelectorAll('.welcome-card[data-section]').forEach((card) => {
    card.addEventListener('click', () => switchSection(card.dataset.section));
  });

  // Back to home buttons
  document.querySelectorAll('.back-to-home-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchSection('welcome'));
  });

  // Logo click - go to welcome
  const logo = document.querySelector('.brand-logo');
  if (logo) {
    logo.addEventListener('click', () => switchSection('welcome'));
  }

  switchSection('welcome');
}

function switchSection(name) {
  document.querySelectorAll('.nav-tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.section === name));

  ['welcome', ...NAV_SECTIONS].forEach((s) => {
    const el = document.getElementById(`section-${s}`);
    if (el) el.hidden = s !== name;
  });

  // Lazy-load sections on first visit
  if (name === 'models' && !window._modelsLoaded) {
    window._modelsLoaded = true;
    if (typeof loadModelsSection === 'function') loadModelsSection();
  }
  if (name === 'performance' && !window._perfLoaded) {
    window._perfLoaded = true;
    if (typeof initPerformanceSection === 'function') initPerformanceSection();
  }
  if (name === 'sensitivity' && !window._sensitivityLoaded) {
    window._sensitivityLoaded = true;
    if (typeof initSensitivitySection === 'function') initSensitivitySection();
  }
}

// Allow sensitivity.js to navigate back to Patient with a pre-selected lab
function switchToPatientWithLab(lab) {
  switchSection('patient');
  // Dispatch a custom event that patient.js can listen for
  window.dispatchEvent(new CustomEvent('sensitivity:goto-patient', { detail: { lab } }));
}
