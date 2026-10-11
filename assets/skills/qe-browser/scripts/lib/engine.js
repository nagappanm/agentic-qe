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
 * Decide headed vs headless, for every engine.
 *
 * Headed is the default wherever a display exists, so someone running the
 * helpers on their own machine can watch the browser do what the test says it
 * does. Headless is chosen automatically only where a visible window cannot
 * open — CI, containers, Linux without a display server — because forcing
 * headed there fails outright with "Missing X server or $DISPLAY".
 *
 * Precedence, first match wins:
 *   QE_BROWSER_HEADLESS=1   force headless
 *   QE_BROWSER_HEADED=1     force headed (the pre-existing opt-in, still honoured)
 *   CI detected             headless
 *   Linux, no display       headless
 *   otherwise               headed
 *
 * Returns { headless, reason } so a caller can say why it chose what it chose.
 */
const CI_VARS = ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'JENKINS_URL', 'TF_BUILD'];

function resolveHeadless(env = process.env, platform = process.platform) {
  const on = (v) => v !== undefined && v !== '' && v !== '0' && String(v).toLowerCase() !== 'false';

  if (on(env.QE_BROWSER_HEADLESS)) return { headless: true, reason: 'QE_BROWSER_HEADLESS is set' };
  if (on(env.QE_BROWSER_HEADED)) return { headless: false, reason: 'QE_BROWSER_HEADED is set' };

  const ci = CI_VARS.find((v) => on(env[v]));
  if (ci) return { headless: true, reason: `CI detected (${ci})` };

  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return { headless: true, reason: 'no display server (DISPLAY/WAYLAND_DISPLAY unset)' };
  }
  return { headless: false, reason: 'a display is available' };
}

/**
 * Run one argv command on the selected engine.
 * Returns { status, stdout, stderr } or { unavailable: true, message }.
 */
function run(args, opts) {
  return backend().run(args, opts);
}

module.exports = { run, selectedEngine, engineConfigError, resolveHeadless, SUPPORTED, VIBIUM, PLAYWRIGHT };
