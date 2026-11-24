import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';
import type { Env } from './types';

export function authFor(env: Env) {
  return betterAuth({
    database: drizzleAdapter(drizzle(env.DB, { schema }), { provider: 'sqlite', schema }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.AUTH_URL,
    trustedOrigins: [env.AUTH_URL],
    emailAndPassword: { enabled: true, minPasswordLength: 10 },
    databaseHooks: { user: { create: { before: async (user) => {
      // OAuth profiles don't submit our required username. Assign a random, non-PII handle.
      if (user.username) return;
      const suffix = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');
      return { data: { ...user, username: `g${suffix}` } };
    } } } },
    socialProviders: {
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      } } : {}),
    },
    advanced: { useSecureCookies: env.AUTH_URL.startsWith('https://') },
    user: { additionalFields: {
      username: { type: 'string', required: false, input: true },
      bio: { type: 'string', required: false, input: false, defaultValue: '' },
    } },
  });
}
