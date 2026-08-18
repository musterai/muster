// File: src/api/middleware/validate.ts
import { Request, Response, NextFunction, RequestHandler } from 'express';
import { ZodError, ZodTypeAny } from 'zod';
import { ValidationError } from '../../shared/errors.js';
import { noBodySchema, noParamsSchema, noQuerySchema } from '../schemas.js';

export type ValidationTarget = 'body' | 'query' | 'params';

export const validate = (schema: ZodTypeAny, target: ValidationTarget = 'body') => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      req[target] = await schema.parseAsync(req[target]);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        next(new ValidationError('Request validation failed', {
          // Zod's invalid_enum_value message includes the received value;
          // never reflect arbitrary request values (which may be credentials)
          // into a response body.
          issues: error.issues.map(({ path, code, message }) => ({
            path,
            code,
            message: code === 'invalid_enum_value' ? 'Invalid enum value' : message,
          })),
        }));
      } else {
        next(error);
      }
    }
  };
};

export interface RequestValidationSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

/** Validate all request inputs at a route boundary, including intentionally empty inputs. */
export const validateRequest = ({ body, query, params }: RequestValidationSchemas = {}): RequestHandler[] => [
  validate(body ?? noBodySchema, 'body'),
  validate(query ?? noQuerySchema, 'query'),
  validate(params ?? noParamsSchema, 'params'),
];
