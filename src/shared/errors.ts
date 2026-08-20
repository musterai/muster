// File: src/shared/errors.ts

export class AppError extends Error {
  public statusCode: number;
  public code: string;
  public details?: Record<string, unknown>;

  constructor(message: string, statusCode: number, code: string, details?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, 404, 'NOT_FOUND');
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 409, 'CONFLICT', details);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

export class KBEntityAmbiguityError extends AppError {
  constructor(details: Record<string, unknown>) {
    super(
      'Entity reference matches multiple knowledge-base entities',
      409,
      'KB_ENTITY_AMBIGUOUS',
      details,
    );
  }
}

/** A structured domain-rule refusal that is safe for both REST and MCP callers to act on. */
export class CardRuleError extends AppError {
  constructor(code: string, message: string, details: Record<string, unknown>) {
    super(message, 409, code, details);
  }
}

/** A document workflow refusal that callers can distinguish from write conflicts. */
export class DocumentStateError extends AppError {
  constructor(code: string, message: string, details: Record<string, unknown>) {
    super(message, 409, code, details);
  }
}
