/** Shared identifiers. Keep in sync across background / offscreen / content / UI. */

export const MSG = {
  // content -> background
  CONTENT_READY: 'content:ready',
  OTP_FIELD_FOUND: 'content:otp-field-found',
  OTP_FIELD_LOST: 'content:otp-field-lost',
  REQUEST_LATEST_CODE: 'content:request-latest-code',
  REQUEST_OCR: 'content:request-ocr',
  REPORT_FILL: 'content:report-fill',

  // background -> content
  DELIVER_CODE: 'bg:deliver-code',
  TRIGGER_SCAN: 'bg:trigger-scan',
  TRIGGER_CAPTCHA: 'bg:trigger-captcha',
  FILL_TEXT: 'bg:fill-text',
  PICK_FIELD: 'bg:pick-field',
  PING: 'bg:ping',

  // offscreen <-> background
  OFFSCREEN_READY: 'off:ready',
  OCR_RUN: 'off:ocr-run',
  BRIDGE_CONFIGURE: 'off:bridge-configure',
  BRIDGE_STATUS: 'off:bridge-status',
  BRIDGE_MESSAGE: 'off:bridge-message',
  BRIDGE_TEST: 'off:bridge-test',

  // popup/options -> background
  GET_STATE: 'ui:get-state',
  SUBMIT_MANUAL_CODE: 'ui:submit-manual-code',
  RESCAN_ACTIVE_TAB: 'ui:rescan-active-tab',
  SOLVE_ACTIVE_TAB: 'ui:solve-active-tab',
  FILL_ACTIVE_TAB: 'ui:fill-active-tab',
  CLIPBOARD_ACTIVE_TAB: 'ui:clipboard-active-tab',
  PICK_ACTIVE_TAB: 'ui:pick-active-tab',
  CLEAR_FIELD_OVERRIDE: 'ui:clear-field-override',
  TEST_BRIDGE: 'ui:test-bridge',
  TEST_OCR: 'ui:test-ocr',
  CLEAR_HISTORY: 'ui:clear-history',
  GET_LOGS: 'ui:get-logs',
  READ_CLIPBOARD: 'ui:read-clipboard',
};

export const STORAGE = {
  SETTINGS: 'settings',
  /** session-only: verification codes never touch disk */
  CODES: 'codes',
  LOGS: 'logs',
  STATUS: 'status',
};

export const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

/** Codes older than this are never auto-filled. */
export const CODE_TTL_MS = 5 * 60 * 1000;

/** Hard ceilings; the options UI cannot exceed these. */
export const LIMITS = {
  MAX_OCR_PER_MINUTE: 12,
  MAX_OCR_RETRIES: 3,
  MAX_CODE_HISTORY: 20,
  MAX_LOGS: 300,
  MIN_POLL_SECONDS: 2,
};

export const SOURCE = {
  BRIDGE_WS: 'bridge-ws',
  BRIDGE_HTTP: 'bridge-http',
  CLIPBOARD: 'clipboard',
  MANUAL: 'manual',
};

export const OCR_PROVIDER = {
  LOCAL: 'local',
  HTTP: 'http',
  OFF: 'off',
};
