'use strict';
/**
 * Vibium backend — the AQE default engine (ADR-091).
 *
 * This is a verbatim extraction of the spawnSync call that lived in
 * lib/vibium.js before the engine abstraction landed. It is deliberately
 * unchanged: the Vibium path is what every existing caller and all 11
 * migrated skills run today, so the refactor must not alter its behaviour.
 */

const { spawnSync } = require('node:child_process');

const ENGINE_ID = 'vibium';

/**
 * Inject `--headless` by default. The qe-browser helpers target QE/CI use
 * where there is no display server, and Vibium is visible-by-default, which
 * fails in containers with "Missing X server or $DISPLAY".
 * Opt out with QE_BROWSER_HEADED=1.
 */
function injectHeadless(args) {
  if (process.env.QE_BROWSER_HEADED === '1') return args;
  if (args.includes('--headless') || args.includes('--headed')) return args;
  return ['--headless', ...args];
}

function isUnavailable(result) {
  return Boolean(result.error && result.error.code === 'ENOENT');
}

function run(args, { input, timeoutMs = 30000 } = {}) {
  const finalArgs = injectHeadless(args);
  const result = spawnSync('vibium', finalArgs, {
    encoding: 'utf8',
    input,
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });

  if (isUnavailable(result)) {
    return {
      unavailable: true,
      message:
        'vibium binary not found on PATH. Install via `npm install -g vibium` or run `aqe init`.',
    };
  }

  return {
    status: result.status,
    stdout: (result.stdout || '').toString(),
    stderr: (result.stderr || '').toString(),
  };
}

module.exports = { ENGINE_ID, run };
