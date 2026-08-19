import { z } from 'zod';

/**
 * Transport-neutral card creation contract.
 *
 * REST supplies `column_id` as a path parameter while MCP carries it in the
 * tool input, so the common payload and the MCP envelope are separate schemas.
 * Keeping the constraints here prevents one transport quietly accepting data
 * that the other rejects before a CardService mutation.
 */
export const CARD_ID_MAX_LENGTH = 128;
export const CARD_TITLE_MAX_LENGTH = 200;
export const CARD_TEXT_MAX_LENGTH = 200_000;
export const CARD_ARRAY_MAX_ITEMS = 100;

export const cardIdentifierSchema = z.string()
  .trim()
  .min(1)
  .max(CARD_ID_MAX_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, 'must be a valid identifier');

const cardTextSchema = (max: number, min = 1) => z.string().trim().min(min).max(max);

const isoDatePattern = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export const cardDueDateSchema = z.string()
  .trim()
  .refine((value) => {
    const match = value.match(isoDatePattern);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const calendarDate = new Date(Date.UTC(year, month - 1, day));
    if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1 || calendarDate.getUTCDate() !== day) return false;
    return !value.includes('T') || !Number.isNaN(Date.parse(value));
  }, 'must be a valid ISO date or datetime');

const booleanLike = z.union([z.boolean(), z.number().int().min(0).max(1)])
  .transform((value) => value === true || value === 1);

export const cardCreateInputSchema = z.object({
  title: cardTextSchema(CARD_TITLE_MAX_LENGTH),
  description: cardTextSchema(CARD_TEXT_MAX_LENGTH, 0).optional(),
  priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  position: cardTextSchema(CARD_ID_MAX_LENGTH).optional(),
  due_date: cardDueDateSchema.optional(),
  labels: z.array(cardIdentifierSchema).max(CARD_ARRAY_MAX_ITEMS).optional(),
  assignees: z.array(cardIdentifierSchema).max(CARD_ARRAY_MAX_ITEMS).optional(),
  is_epic: booleanLike.optional(),
  operator_override: z.boolean().optional(),
}).strict();

export const mcpCardCreateInputSchema = cardCreateInputSchema.extend({
  column_id: cardIdentifierSchema,
}).strict();
