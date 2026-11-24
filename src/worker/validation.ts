import { z } from 'zod';
export const username = z.string().regex(/^[a-z0-9_]{3,20}$/);
export const id = z.string().uuid();
export const postInput = z.object({ body: z.string().trim().max(280), parentId: id.optional(), mediaId: id.optional() }).refine(v => !!v.body || !!v.mediaId, 'Post cannot be empty');
export const profileInput = z.object({ name: z.string().trim().min(1).max(60).optional(), bio: z.string().max(160).optional(), image: id.nullable().optional() });
export function cursorParams(raw: string | undefined) {
  if (!raw) return null;
  const match = /^(\d{1,16}):([0-9a-f-]{36})$/.exec(raw);
  return match ? [Number(match[1]), match[2]] as const : false;
}
