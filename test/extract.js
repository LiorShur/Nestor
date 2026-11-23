/**
 * Test helper — re-exports testable pure functions from src/ modules.
 *
 * Now that the app is modularised, we import directly from the source
 * modules rather than regex-extracting from the monolithic HTML file.
 * This is cleaner, faster, and doesn't break when function bodies change.
 *
 * Falls back to the legacy HTML extraction if a src/ module import
 * fails (e.g. during the transition period).
 */

export { genCode, escHtml, _haversine, _toIsoDate, loadScript, loadCSS } from '../src/utils.js';
export { _nextOccurrence, _upcomingDosesFor } from '../src/medications.js';
export { _authPasswordStrength } from '../src/auth.js';
