// File: src/api/middleware/error-handler.ts
import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../shared/errors.js';
import { PermissionDeniedError } from '../../shared/permission-enforcer.js';

type BodyParserError = Error & {
  type?: string;
  status?: number;
  statusCode?: number;
  body?: unknown;
};

function isBodyTooLargeError(error: BodyParserError): boolean {
  return error.type === 'entity.too.large'
    || error.type === 'parameters.too.many'
    || error.status === 413
    || error.statusCode === 413;
}

function isMalformedBodyError(error: BodyParserError): boolean {
  return error.type === 'entity.parse.failed'
    || (error instanceof SyntaxError && (error.status === 400 || error.statusCode === 400) && 'body' in error);
}

/**
 * Keep parser failures out of the generic logger. body-parser attaches the
 * raw request body to several error variants, so logging the error object
 * would turn malformed input into a credential/content disclosure vector.
 */
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  const parserError = err as BodyParserError;
  if (isBodyTooLargeError(parserError)) {
    res.status(413).json({
      error: 'Request body too large',
      code: 'REQUEST_BODY_TOO_LARGE',
    });
    return;
  }

  if (isMalformedBodyError(parserError)) {
    res.status(400).json({
      error: 'Invalid request body',
      code: 'INVALID_REQUEST_BODY',
    });
    return;
  }

  // Thrown by business-rule grant checks made inside a route handler, not
  // just the permissionGuard middleware — same refusal shape either way.
  if (err instanceof PermissionDeniedError) {
    res.status(403).json(err.refusal);
    return;
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }

  // Keep the useful diagnostic while avoiding raw error-object serialization.
  // Parser errors returned above are intentionally never logged here.
  console.error('Unhandled request error:', err.name, err.message);
  res.status(500).json({ error: 'Internal Server Error' });
}
