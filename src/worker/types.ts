export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  CACHE: KVNamespace;
  EVENTS: Queue<{ kind: 'like' | 'follow' | 'reply'; recipientId: string; actorId: string; targetId: string }>;
  AUTH_LIMIT: RateLimit;
  WRITE_LIMIT: RateLimit;
  UPLOAD_LIMIT: RateLimit;
  BETTER_AUTH_SECRET: string;
  AUTH_URL: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  ASSETS: Fetcher;
}
