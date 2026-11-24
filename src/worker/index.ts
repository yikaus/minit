import { Hono } from 'hono';
import { z } from 'zod';
import { authFor } from './auth';
import type { Env } from './types';
import { username, id, postInput, profileInput, cursorParams } from './validation';

const app = new Hono<{ Bindings: Env; Variables: { viewer: string | null } }>();
const now = () => Date.now();
const error = (message: string, status: 400 | 401 | 403 | 404 | 409 | 413 | 429 = 400) => new Response(JSON.stringify({ error: message }), { status, headers: { 'content-type': 'application/json' } });
const ip = (c: { req: { header: (key: string) => string | undefined } }) => c.req.header('cf-connecting-ip') || 'unknown';
async function limit(binding: RateLimit, key: string) { return (await binding.limit({ key })).success; }
async function json(c: { req: { json: () => Promise<unknown> } }) { try { return await c.req.json(); } catch { return null; } }

app.onError((err) => { console.error(err); return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500, headers: { 'content-type': 'application/json' } }); });
app.get('/api/auth/status', c => c.json({ google: Boolean(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET) }));
app.use('/api/*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const origin = c.req.header('origin');
    if (c.req.path.startsWith('/api/auth/') && c.req.path.includes('/callback/')) { /* OAuth provider callbacks are cross-site navigations; Better Auth validates state and PKCE. */ }
    else if (!origin || origin !== new URL(c.env.AUTH_URL).origin) return error('Invalid origin', 403);
  }
  const session = await authFor(c.env).api.getSession({ headers: c.req.raw.headers });
  c.set('viewer', session?.user.id || null);
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && !c.req.path.startsWith('/api/auth/') && !c.req.path.startsWith('/api/media') && !c.req.path.startsWith('/api/posts')) {
    if (!await limit(c.env.WRITE_LIMIT, `action:${session?.user.id || ip(c)}`)) return error('Too many actions', 429);
  }
  await next();
});
app.all('/api/auth/*', async c => {
  if (c.req.path.includes('/sign-in') || c.req.path.includes('/sign-up')) {
    if (!await limit(c.env.AUTH_LIMIT, `auth:${ip(c)}`)) return error('Too many attempts', 429);
  }
  if (c.req.path.includes('/sign-up') && c.req.method === 'POST') {
    const input = await c.req.raw.clone().json().catch(() => null); const parsed = z.object({ username, name: z.string().min(1).max(60), email: z.email(), password: z.string().min(10) }).safeParse(input);
    if (!parsed.success) return error('Invalid registration details');
    const existing = await c.env.DB.prepare('SELECT 1 FROM user WHERE username = ?').bind(parsed.data.username).first();
    if (existing) return error('Username unavailable', 409);
  }
  return authFor(c.env).handler(c.req.raw);
});
app.get('/api/me', async c => { const viewer = c.get('viewer'); const user = viewer ? await c.env.DB.prepare('SELECT username FROM user WHERE id=?').bind(viewer).first<{ username: string }>() : null; return c.json({ id: viewer, username: user?.username || null }); });

const postFields = (viewer: string | null) => `SELECT p.id, p.body, p.parent_id AS parentId, p.media_id AS mediaId, p.created_at AS createdAt, u.username, u.name, u.image,
 (SELECT COUNT(*) FROM likes l WHERE l.post_id=p.id) AS likeCount,
 (SELECT COUNT(*) FROM posts r WHERE r.parent_id=p.id) AS replyCount,
 ${viewer ? '(SELECT COUNT(*) FROM likes l WHERE l.post_id=p.id AND l.user_id=?)' : '0'} AS liked
 FROM posts p JOIN user u ON u.id=p.author_id`;
app.get('/api/posts', async c => {
  const viewer = c.get('viewer'); const cursor = cursorParams(c.req.query('cursor'));
  if (cursor === false) return error('Invalid cursor');
  const mode = c.req.query('mode');
  if (mode === 'following' && !viewer) return error('Sign in to see following', 401);
  const author = c.req.query('author'); const parent = c.req.query('parent'); const search = c.req.query('q')?.trim().slice(0, 80);
  const conditions: string[] = []; const args: unknown[] = viewer ? [viewer] : [];
  if (mode === 'following') { conditions.push('p.author_id IN (SELECT followed_id FROM follows WHERE follower_id=?)'); args.push(viewer); }
  if (author) { conditions.push('u.username=?'); args.push(author); }
  if (parent) { if (!id.safeParse(parent).success) return error('Invalid parent'); conditions.push('p.parent_id=?'); args.push(parent); }
  else conditions.push('p.parent_id IS NULL');
  if (search) { conditions.push('p.body LIKE ? ESCAPE \'\\\''); args.push(`%${search.replace(/[\\%_]/g, '\\$&')}%`); }
  if (cursor) { conditions.push('(p.created_at < ? OR (p.created_at = ? AND p.id < ?))'); args.push(cursor[0], cursor[0], cursor[1]); }
  const rows = await c.env.DB.prepare(`${postFields(viewer)} WHERE ${conditions.join(' AND ')} ORDER BY p.created_at DESC,p.id DESC LIMIT 21`).bind(...args).all();
  const items = rows.results.slice(0, 20);
  const last = items.at(-1) as { createdAt: number; id: string } | undefined;
  return c.json({ items, nextCursor: rows.results.length > 20 && last ? `${last.createdAt}:${last.id}` : null });
});
app.get('/api/posts/:id', async c => {
  if (!id.safeParse(c.req.param('id')).success) return error('Invalid post');
  const viewer = c.get('viewer'); const row = await c.env.DB.prepare(`${postFields(viewer)} WHERE p.id=?`).bind(...(viewer ? [viewer] : []), c.req.param('id')).first();
  return row ? c.json(row) : error('Post not found', 404);
});
app.post('/api/posts', async c => {
  const viewer = c.get('viewer'); if (!viewer) return error('Sign in required', 401);
  if (!await limit(c.env.WRITE_LIMIT, `post:${viewer}`)) return error('Posting too quickly', 429);
  const parsed = postInput.safeParse(await json(c)); if (!parsed.success) return error('Invalid post');
  const { body, parentId, mediaId } = parsed.data;
  if (parentId && !await c.env.DB.prepare('SELECT 1 FROM posts WHERE id=?').bind(parentId).first()) return error('Parent not found', 404);
  if (mediaId && !await c.env.DB.prepare('SELECT 1 FROM media WHERE id=? AND owner_id=? AND attached_at IS NULL').bind(mediaId, viewer).first()) return error('Image unavailable', 404);
  if (mediaId) {
    const claimed = await c.env.DB.prepare('UPDATE media SET attached_at=? WHERE id=? AND owner_id=? AND attached_at IS NULL').bind(now(), mediaId, viewer).run();
    if (!claimed.meta.changes) return error('Image already in use', 409);
  }
  const postId = crypto.randomUUID(); const timestamp = now();
  try { await c.env.DB.prepare('INSERT INTO posts (id,author_id,body,parent_id,media_id,created_at) VALUES (?,?,?,?,?,?)').bind(postId, viewer, body, parentId || null, mediaId || null, timestamp).run(); }
  catch (e) { if (mediaId) await c.env.DB.prepare('UPDATE media SET attached_at=NULL WHERE id=? AND owner_id=?').bind(mediaId, viewer).run(); throw e; }
  if (parentId) {
    const parent = await c.env.DB.prepare('SELECT author_id FROM posts WHERE id=?').bind(parentId).first<{ author_id: string }>();
    if (parent && parent.author_id !== viewer) await c.env.EVENTS.send({ kind: 'reply', recipientId: parent.author_id, actorId: viewer, targetId: postId });
  }
  return c.json({ id: postId }, 201);
});
app.delete('/api/posts/:id', async c => {
  const viewer = c.get('viewer'); if (!viewer) return error('Sign in required', 401);
  if (!await limit(c.env.WRITE_LIMIT, `delete:${viewer}`)) return error('Too many actions', 429);
  if (!id.safeParse(c.req.param('id')).success) return error('Invalid post');
  const post = await c.env.DB.prepare('SELECT author_id,media_id FROM posts WHERE id=?').bind(c.req.param('id')).first<{ author_id: string; media_id: string | null }>();
  if (!post) return error('Post not found', 404); if (post.author_id !== viewer) return error('Forbidden', 403);
  await c.env.DB.prepare('DELETE FROM posts WHERE id=?').bind(c.req.param('id')).run();
  if (post.media_id) await c.env.DB.prepare('UPDATE media SET attached_at=NULL WHERE id=?').bind(post.media_id).run();
  return c.json({ ok: true });
});
app.put('/api/posts/:id/like', async c => {
  const viewer = c.get('viewer'); if (!viewer) return error('Sign in required', 401);
  if (!await limit(c.env.WRITE_LIMIT, `like:${viewer}`)) return error('Too many actions', 429);
  if (!id.safeParse(c.req.param('id')).success) return error('Invalid post');
  const post = await c.env.DB.prepare('SELECT author_id FROM posts WHERE id=?').bind(c.req.param('id')).first<{ author_id: string }>();
  if (!post) return error('Post not found', 404);
  const result = await c.env.DB.prepare('INSERT OR IGNORE INTO likes (user_id,post_id,created_at) VALUES (?,?,?)').bind(viewer, c.req.param('id'), now()).run();
  if (result.meta.changes && post.author_id !== viewer) await c.env.EVENTS.send({ kind: 'like', recipientId: post.author_id, actorId: viewer, targetId: c.req.param('id') });
  return c.json({ ok: true });
});
app.delete('/api/posts/:id/like', async c => { const viewer = c.get('viewer'); if (!viewer) return error('Sign in required', 401); if (!id.safeParse(c.req.param('id')).success) return error('Invalid post'); if (!await limit(c.env.WRITE_LIMIT, `like:${viewer}`)) return error('Too many actions', 429); await c.env.DB.prepare('DELETE FROM likes WHERE user_id=? AND post_id=?').bind(viewer, c.req.param('id')).run(); return c.json({ ok: true }); });

app.get('/api/users', async c => { const q = c.req.query('q')?.trim().slice(0, 80) || ''; if (!q) return c.json({ items: [] }); const term = `%${q.replace(/[\\%_]/g, '\\$&')}%`; const result = await c.env.DB.prepare("SELECT username,name,bio,image FROM user WHERE username LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' ORDER BY username LIMIT 20").bind(term, term).all(); return c.json({ items: result.results }); });
app.get('/api/users/:username', async c => {
  const name = c.req.param('username'); if (!username.safeParse(name).success) return error('User not found', 404);
  const viewer = c.get('viewer'); const cacheKey = `profile:${name}`;
  let profile = await c.env.CACHE.get(cacheKey, 'json') as Record<string, unknown> | null;
  if (!profile) {
    profile = await c.env.DB.prepare('SELECT id,username,name,bio,image,created_at AS createdAt,(SELECT COUNT(*) FROM follows WHERE followed_id=user.id) AS followers,(SELECT COUNT(*) FROM follows WHERE follower_id=user.id) AS following FROM user WHERE username=?').bind(name).first();
    if (!profile) return error('User not found', 404);
    await c.env.CACHE.put(cacheKey, JSON.stringify(profile), { expirationTtl: 60 });
  }
  const isFollowing = viewer ? !!await c.env.DB.prepare('SELECT 1 FROM follows WHERE follower_id=? AND followed_id=?').bind(viewer, profile.id).first() : false;
  return c.json({ ...profile, isFollowing, isSelf: viewer === profile.id });
});
app.patch('/api/profile', async c => {
  const viewer = c.get('viewer'); if (!viewer) return error('Sign in required', 401);
  const parsed = profileInput.safeParse(await json(c)); if (!parsed.success) return error('Invalid profile');
  const fields: string[] = []; const args: unknown[] = [];
  for (const [key, value] of Object.entries(parsed.data)) {
    if (key === 'image' && value && !await c.env.DB.prepare('SELECT 1 FROM media WHERE id=? AND owner_id=?').bind(value, viewer).first()) return error('Avatar unavailable', 404);
    fields.push(`${key}=?`); args.push(key === 'image' && value ? `/api/media/${value}` : value);
  }
  if (fields.length) { await c.env.DB.prepare(`UPDATE user SET ${fields.join(',')},updated_at=? WHERE id=?`).bind(...args, now(), viewer).run(); const u = await c.env.DB.prepare('SELECT username FROM user WHERE id=?').bind(viewer).first<{ username: string }>(); if (u) await c.env.CACHE.delete(`profile:${u.username}`); }
  return c.json({ ok: true });
});
app.put('/api/users/:username/follow', async c => {
  const viewer = c.get('viewer'); if (!viewer) return error('Sign in required', 401);
  if (!username.safeParse(c.req.param('username')).success) return error('User not found', 404);
  const target = await c.env.DB.prepare('SELECT id FROM user WHERE username=?').bind(c.req.param('username')).first<{ id: string }>(); if (!target) return error('User not found', 404); if (target.id === viewer) return error('Cannot follow yourself');
  const result = await c.env.DB.prepare('INSERT OR IGNORE INTO follows (follower_id,followed_id,created_at) VALUES (?,?,?)').bind(viewer, target.id, now()).run();
  await c.env.CACHE.delete(`profile:${c.req.param('username')}`);
  const actor = await c.env.DB.prepare('SELECT username FROM user WHERE id=?').bind(viewer).first<{ username: string }>();
  if (actor) await c.env.CACHE.delete(`profile:${actor.username}`);
  if (result.meta.changes) await c.env.EVENTS.send({ kind: 'follow', recipientId: target.id, actorId: viewer, targetId: viewer });
  return c.json({ ok: true });
});
app.delete('/api/users/:username/follow', async c => { const viewer = c.get('viewer'); if (!viewer) return error('Sign in required', 401); await c.env.DB.prepare('DELETE FROM follows WHERE follower_id=? AND followed_id=(SELECT id FROM user WHERE username=?)').bind(viewer, c.req.param('username')).run(); await c.env.CACHE.delete(`profile:${c.req.param('username')}`); const actor = await c.env.DB.prepare('SELECT username FROM user WHERE id=?').bind(viewer).first<{ username: string }>(); if (actor) await c.env.CACHE.delete(`profile:${actor.username}`); return c.json({ ok: true }); });

const allowed = { 'image/jpeg': [0xff, 0xd8, 0xff], 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/webp': [0x52, 0x49, 0x46, 0x46] } as const;
app.post('/api/media', async c => {
  const viewer = c.get('viewer'); if (!viewer) return error('Sign in required', 401);
  if (!await limit(c.env.UPLOAD_LIMIT, `upload:${viewer}`)) return error('Too many uploads', 429);
  const length = Number(c.req.header('content-length')); if (!length || length > 5_300_000) return error('Image must be under 5 MB', 413);
  const type = c.req.header('content-type')?.split(';')[0] as keyof typeof allowed;
  if (!(type in allowed)) return error('Unsupported image type');
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.length > 5_000_000 || bytes.length < 16 || !allowed[type].every((v, i) => bytes[i] === v) || (type === 'image/webp' && String.fromCharCode(...bytes.slice(8, 12)) !== 'WEBP')) return error('Invalid image');
  const mediaId = crypto.randomUUID(); await c.env.MEDIA.put(mediaId, bytes, { httpMetadata: { contentType: type } });
  try { await c.env.DB.prepare('INSERT INTO media (id,owner_id,content_type,created_at) VALUES (?,?,?,?)').bind(mediaId, viewer, type, now()).run(); }
  catch (e) { await c.env.MEDIA.delete(mediaId); throw e; }
  return c.json({ id: mediaId, url: `/api/media/${mediaId}` }, 201);
});
app.get('/api/media/:id', async c => {
  if (!id.safeParse(c.req.param('id')).success) return error('Not found', 404);
  const record = await c.env.DB.prepare('SELECT content_type FROM media WHERE id=? AND (attached_at IS NOT NULL OR id IN (SELECT substr(image,12) FROM user WHERE image IS NOT NULL))').bind(c.req.param('id')).first<{ content_type: string }>();
  if (!record) return error('Not found', 404);
  const object = await c.env.MEDIA.get(c.req.param('id')); if (!object) return error('Not found', 404);
  return new Response(object.body, { headers: { 'content-type': record.content_type, 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" } });
});
app.get('/api/notifications', async c => { const viewer = c.get('viewer'); if (!viewer) return error('Sign in required', 401); const rows = await c.env.DB.prepare('SELECT n.id,n.kind,n.target_id AS targetId,n.created_at AS createdAt,n.read_at AS readAt,u.username,u.name FROM notifications n JOIN user u ON u.id=n.actor_id WHERE n.recipient_id=? ORDER BY n.created_at DESC LIMIT 50').bind(viewer).all(); return c.json({ items: rows.results }); });
app.post('/api/notifications/read', async c => { const viewer = c.get('viewer'); if (!viewer) return error('Sign in required', 401); await c.env.DB.prepare('UPDATE notifications SET read_at=? WHERE recipient_id=? AND read_at IS NULL').bind(now(), viewer).run(); return c.json({ ok: true }); });

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<{ kind: string; recipientId: string; actorId: string; targetId: string }>, env: Env) {
    for (const message of batch.messages) {
      try {
        const { kind, recipientId, actorId, targetId } = message.body;
        if (!['like', 'follow', 'reply'].includes(kind)) { message.ack(); continue; }
        await env.DB.prepare('INSERT OR IGNORE INTO notifications (id,recipient_id,actor_id,kind,target_id,created_at) VALUES (?,?,?,?,?,?)').bind(crypto.randomUUID(), recipientId, actorId, kind, targetId, now()).run();
        message.ack();
      } catch { message.retry(); }
    }
  },
  async scheduled(_event: ScheduledEvent, env: Env) {
    const old = await env.DB.prepare('SELECT id FROM media WHERE attached_at IS NULL AND created_at < ? AND id NOT IN (SELECT substr(image,12) FROM user WHERE image IS NOT NULL) LIMIT 100').bind(now() - 86_400_000).all<{ id: string }>();
    for (const item of old.results) { await env.MEDIA.delete(item.id); await env.DB.prepare('DELETE FROM media WHERE id=? AND attached_at IS NULL').bind(item.id).run(); }
  },
};
