import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@mt/types';

export const idSchema = z.string().min(1, 'id is required').max(128);

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().nullish(),
});

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(64),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type PaginationInput = z.input<typeof paginationSchema>;
export type SearchQueryInput = z.input<typeof searchQuerySchema>;

/** Collects Zod issues into the `details` map of a VALIDATION_ERROR response. */
export function zodIssuesToDetails(error: z.ZodError): Record<string, string> {
  const details: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || '_';
    if (!details[path]) details[path] = issue.message;
  }
  return details;
}
