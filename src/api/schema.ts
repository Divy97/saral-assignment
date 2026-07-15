import { z } from "zod";

// Query params come in as strings. limit defaults to 25, must be an int 1..100 — anything
// above 100 (or non-numeric / < 1) is rejected, not clamped. Unknown params are stripped.
export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  next_cursor: z.string().optional(),
  hashtag: z.string().trim().optional(), // defaults to the configured hashtag (matcha)
});

export type ListQuery = z.infer<typeof listQuerySchema>;
