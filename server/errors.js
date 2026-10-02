/**
 * API error codes with their default English message. Responses look like { error, code }; the
 * client translates `err.<CODE>` from its own dictionary and falls back to `error`.
 * Every code added here needs `err.<CODE>` in both languages of public/js/i18n.js (a test checks).
 */
export const CODES = {
  INVALID_JSON: 'Invalid JSON',
  PAYLOAD_TOO_LARGE: 'Request too large',
  INVALID_REQUEST: 'Invalid request',
  UNSUPPORTED_MEDIA_TYPE: 'Unsupported media type',
  INTERNAL: 'Internal server error',
};

/** Throw (or pass to next) to answer with a specific status and code. */
export class HttpError extends Error {
  constructor(status, code, message = CODES[code]) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

/** Express error middleware: known errors keep their status, anything else is logged as a 500. */
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  // body-parser and friends tag their errors with a 4xx status
  const status = err.status ?? err.statusCode;
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    const code = err.type === 'entity.parse.failed' ? 'INVALID_JSON'
      : status === 413 ? 'PAYLOAD_TOO_LARGE'
      : status === 415 ? 'UNSUPPORTED_MEDIA_TYPE'
      : 'INVALID_REQUEST';
    return res.status(status).json({ error: CODES[code], code });
  }
  console.error(err);
  res.status(500).json({ error: CODES.INTERNAL, code: 'INTERNAL' });
}
