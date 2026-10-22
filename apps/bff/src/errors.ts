import type { ErrorCode } from '@ihg-guest-search/shared';

/**
 * Raised when the BFF must refuse to start: missing or invalid configuration (Req 8.5),
 * dev auth in production (Req 20.4) or an unimplemented auth mode (Req 20.5).
 * The server entry point prints the message to stderr and exits with code 1.
 *
 * Messages MUST name configuration keys only, never their values.
 */
export class StartupError extends Error {
  override readonly name = 'StartupError';
  /** Keys that were required but absent or empty. */
  readonly missingKeys: readonly string[];
  /** Keys that were present but failed validation. */
  readonly invalidKeys: readonly string[];

  constructor(
    message: string,
    keys: { missing?: readonly string[]; invalid?: readonly string[] } = {},
  ) {
    super(message);
    this.missingKeys = keys.missing ?? [];
    this.invalidKeys = keys.invalid ?? [];
  }
}

/**
 * A typed request-time failure carrying a catalog `ErrorCode` (Req 19.1). The HTTP layer
 * maps `code` to the catalog status and user message; `message` is for logs only and MUST
 * NOT contain user-supplied values, PII or SOAP payloads.
 */
export class AppError extends Error {
  override readonly name = 'AppError';
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}
