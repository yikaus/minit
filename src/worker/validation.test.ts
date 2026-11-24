import { describe, expect, it } from 'vitest';
import { cursorParams, postInput, profileInput, username } from './validation';
describe('request validation', () => {
  it('rejects invalid usernames and post bodies', () => {
    expect(username.safeParse('User!').success).toBe(false);
    expect(username.safeParse('valid_123').success).toBe(true);
    expect(postInput.safeParse({ body: ' ' }).success).toBe(false);
    expect(postInput.safeParse({ body: 'x'.repeat(281) }).success).toBe(false);
    expect(postInput.safeParse({ body: 'hello' }).success).toBe(true);
  });
  it('limits profile data and validates cursor syntax', () => {
    expect(profileInput.safeParse({ bio: 'a'.repeat(161) }).success).toBe(false);
    expect(cursorParams('bad')).toBe(false);
    expect(cursorParams(undefined)).toBe(null);
    expect(cursorParams('123:550e8400-e29b-41d4-a716-446655440000')).toEqual([123, '550e8400-e29b-41d4-a716-446655440000']);
  });
});
