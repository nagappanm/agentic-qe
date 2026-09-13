'use strict';
/**
 * Engine selection for qe-browser.
 *
 * ADR-091 chose Vibium as the fleet's browser engine and declined a runtime
 * fallback, on the premise that a second engine meant re-implementing the QE
 * primitives. In practice the primitives sit on a single argv seam, so a second
 * backend only has to speak that vocabulary — which is what lib/engines/*.js do.
 *
 * Selection is explicit and defaults to Vibium, so every existing caller and all
 * migrated skills behave exactly as before unless someone opts in:
 *
 *   QE_BROWSER_ENGINE=vibium      (default)
 *   QE_BROWSER_ENGINE=playwright
 *
 * There is deliberately no automatic fallback between engines. Visual-diff
 * baselines are renderer-specific, so silently switching engines mid-suite
 * would produce false visual regressions; an engine change should be a
 * decision someone made, not one that happened to them.
 */

const VIBIUM = 'vibium';
const PLAYWRIGHT = 'playwright';
const SUPPORTED = [VIBIUM, PLAYWRIGHT];

function selectedEngine() {
  const raw = (process.env.QE_BROWSER_ENGINE || VIBIUM).trim().toLowerCase();
  return SUPPORTED.includes(raw) ? raw : VIBIUM;
}

function engineConfigError() {
  const raw = (process.env.QE_BROWSER_ENGINE || '').trim().toLowerCase();
  if (raw && !SUPPORTED.includes(raw)) {
    return `QE_BROWSER_ENGINE="${raw}" is not a supported engine. Use one of: ${SUPPORTED.join(', ')}. Falling back to ${VIBIUM}.`;
  }
  return null;
}

function backend() {
  return selectedEngine() === PLAYWRIGHT
    ? require('./engines/playwright')
    : require('./engines/vibium');
}

/**
 * Run one argv command on the selected engine.
 * Returns { status, stdout, stderr } or { unavailable: true, message }.
 */
function run(args, opts) {
  return backend().run(args, opts);
}

module.exports = { run, selectedEngine, engineConfigError, SUPPORTED, VIBIUM, PLAYWRIGHT };
