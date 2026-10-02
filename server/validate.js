import { HttpError } from './errors.js';

export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 256;
export const MAX_USERNAME = 64;
export const MAX_NAME = 100;
export const ASSIGNABLE_ROLES = ['EVENT_ADMIN', 'SCANNER'];

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** A trimmed username of 1-64 characters without control characters. */
export function requireUsername(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'USERNAME_INVALID');
  const name = value.trim();
  if (!name || name.length > MAX_USERNAME || CONTROL_CHARS.test(name)) {
    throw new HttpError(400, 'USERNAME_INVALID');
  }
  return name;
}

/** A password of 8-256 characters (returned untouched: whitespace is part of a password). */
export function requirePassword(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'CREDENTIALS_REQUIRED');
  if (value.length < MIN_PASSWORD) throw new HttpError(400, 'PASSWORD_TOO_SHORT');
  if (value.length > MAX_PASSWORD) throw new HttpError(400, 'PASSWORD_TOO_LONG');
  return value;
}

/** A trimmed display name (event, section, subsection) of 1-`max` characters. */
export function requireName(value, max = MAX_NAME) {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, 'NAME_REQUIRED');
  const name = value.trim();
  if (name.length > max) throw new HttpError(400, 'NAME_TOO_LONG');
  return name;
}

/** Validates the body of an account-creation request. */
export function requireNewAccount(body) {
  const { username, password, role } = body || {};
  const cleanUsername = requireUsername(username);
  const cleanPassword = requirePassword(password);
  if (!ASSIGNABLE_ROLES.includes(role)) throw new HttpError(400, 'ROLE_INVALID');
  return { username: cleanUsername, password: cleanPassword, role };
}
