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
  NOT_FOUND: 'Not found',
  INVALID_CREDENTIALS: 'Invalid credentials',
  TOO_MANY_ATTEMPTS: 'Too many attempts, please try again later',
  CREDENTIALS_REQUIRED: 'Username and password are required',
  USERNAME_INVALID: 'Username must be 1-64 characters without control characters',
  PASSWORD_TOO_SHORT: 'Password must be at least 8 characters',
  PASSWORD_TOO_LONG: 'Password must be at most 256 characters',
  NAME_REQUIRED: 'Name is required',
  NAME_TOO_LONG: 'Name must be at most 100 characters',
  ROLE_INVALID: 'Role must be EVENT_ADMIN or SCANNER',
  NOT_SIGNED_IN: 'Not signed in',
  NOT_AUTHORIZED: 'Not authorized',
  NOT_AUTHORIZED_EVENT: 'Not authorized for this event',
  EVENT_NOT_FOUND: 'Event not found',
  SECTION_NOT_FOUND: 'Section not found',
  SUBSECTION_NOT_FOUND: 'Subsection not found',
  USER_NOT_FOUND: 'User not found',
  EVENT_OR_USER_NOT_FOUND: 'Event or user not found',
  USERNAME_TAKEN: 'Username already taken',
  SECTION_EXISTS: 'Section already exists',
  SUBSECTION_EXISTS: 'Subsection already exists',
  COLOR_INVALID: 'color must be in #rrggbb format',
  RESET_TIME_INVALID: 'reset_time must be in HH:MM format',
  TIMEZONE_INVALID: 'timezone must be a valid IANA time zone such as Europe/Berlin',
  SETTINGS_REQUIRED: 'Provide reset_time and/or timezone',
  COUNT_INVALID: 'count must be between 1 and 10000',
  TICKET_NOT_FOUND: 'Code not found',
  CODE_AMBIGUOUS: 'Code is ambiguous, provide more characters',
  HOLDER_INVALID: 'holder must be text',
  HOLDER_TOO_LONG: 'holder must be at most 100 characters',
  NOTHING_TO_UPDATE: 'Nothing to update',
  CODE_REVOKED: 'Code revoked',
  SCAN_NOT_FOUND: 'Scan not found',
  ALREADY_VOIDED: 'Scan already voided',
  UNDO_EXPIRED: 'The undo window has expired',
  SUBSECTION_MISMATCH: 'Subsection does not belong to this section',
  IMAGE_TYPE_INVALID: 'Only PNG, JPEG or WebP allowed',
  IMAGE_MISSING: 'Image data missing',
  NO_BACKDROP: 'No background image',
  CANNOT_DELETE_SELF: 'You cannot delete your own account',
  OWNER_NO_ASSIGNMENT: 'Owner does not need an assignment',
  INVALID_CODE: 'Invalid code',
  UNKNOWN_CODE: 'Unknown code',
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
