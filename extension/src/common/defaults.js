import { CODE_KEYWORDS } from './patterns.js';
import { OCR_PROVIDER } from './constants.js';

/**
 * The single source of truth for configuration. `settings.js` deep-merges the
 * stored object on top of this, so adding a key here is enough to ship it.
 */
export const DEFAULT_SETTINGS = {
  schema: 1,

  /** Master kill switch. */
  enabled: true,

  otp: {
    enabled: true,
    /** Fill the field the moment a fresh code arrives. */
    autoFill: true,
    /** Click the form's submit button after filling. Off: this is irreversible. */
    autoSubmit: false,
    minLength: 4,
    maxLength: 8,
    /** digits | alnum */
    charset: 'digits',
    keywords: [...CODE_KEYWORDS],
    /** A code older than this is never auto-filled. */
    ttlSeconds: 300,
    /** Only fill when the code arrived *after* the field appeared. */
    requireFreshCode: true,
    /** Never fill a field the user already typed into. */
    skipNonEmpty: true,
    highlight: true,
  },

  captcha: {
    enabled: true,
    /** local (bundled Tesseract) | http (self-hosted OCR) | off */
    provider: OCR_PROVIDER.LOCAL,
    autoFill: true,
    autoSubmit: false,
    /** digits | alpha | alnum | upperAlnum | custom */
    charset: 'alnum',
    customCharset: '',
    /** 0 = accept any length. */
    expectedLength: 4,
    /** Below this Tesseract confidence the result is offered, not auto-filled. */
    minConfidence: 60,
    /** Re-roll the CAPTCHA image at most this many times when unreadable. */
    maxRetries: 2,
    /** Solve as soon as the image is detected, instead of waiting for a click. */
    solveOnDetect: true,
    /** Re-solve when the site swaps the image (user clicked "refresh"). */
    solveOnImageChange: true,
    preprocess: {
      enabled: true,
      scale: 3,
      grayscale: true,
      /** Auto-invert light-on-dark CAPTCHAs. */
      autoInvert: true,
      binarize: true,
      /** 0 = Otsu (automatic). */
      threshold: 0,
      despeckle: true,
      trimBorder: 1,
    },
    local: {
      lang: 'eng',
      /** Tesseract page-seg mode: 7 = single text line, 8 = single word, 13 = raw line. */
      psm: 7,
    },
    http: {
      url: '',
      method: 'POST',
      /** json-base64 | form-data | raw-body */
      format: 'json-base64',
      fieldName: 'image',
      /** Dotted path into the JSON response, e.g. "result" or "data.text". Empty = whole body. */
      responsePath: '',
      headerName: '',
      headerValue: '',
      timeoutMs: 8000,
    },
  },

  sources: {
    ws: {
      enabled: false,
      url: 'ws://127.0.0.1:8787/ws',
      token: '',
      reconnectSeconds: 5,
    },
    http: {
      enabled: false,
      url: 'http://127.0.0.1:8787/latest',
      intervalSeconds: 5,
      /** Dotted path to the SMS text inside the JSON response. Empty = auto-detect. */
      responsePath: '',
      headerName: '',
      headerValue: '',
      timeoutMs: 6000,
    },
    clipboard: {
      enabled: false,
      /** Only read while an OTP field is on screen, and only in the focused tab. */
      onlyWithOtpField: true,
      intervalSeconds: 2,
    },
    manual: {
      enabled: true,
    },
  },

  sites: {
    /** all | allowlist */
    mode: 'all',
    allowlist: [],
    blocklist: [],
    /**
     * Manually picked fields, keyed by hostname: { "example.com": { otp: "#code" } }.
     * The escape hatch for sites whose markup gives the detector nothing to go on.
     */
    fieldOverrides: {},
  },

  ui: {
    showBadge: true,
    notifyOnCode: false,
  },

  advanced: {
    debug: false,
    /** Hold the offscreen document open so the WS bridge stays connected. */
    keepAlive: true,
    /** Remember the last N codes in memory only (never written to disk). */
    historySize: 10,
  },
};
