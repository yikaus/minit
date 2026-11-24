import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
const prefix = `ms${Date.now()}`;
async function signUp(page: import('@playwright/test').Page, name: string, username: string) {
  await page.getByRole('button', { name: 'For everyone' }).click();
  await page.getByRole('button', { name: 'Following' }).click();
  await page.getByRole('dialog').getByLabel('Display name').fill(name);
  await page.getByRole('dialog').getByLabel('Username').fill(username);
  await page.getByRole('dialog').getByLabel('Email').fill(`${username}@example.test`);
  await page.getByRole('dialog').getByLabel('Password').fill('a-strong-password-123');
  await page.getByRole('dialog').getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
test('mobile: register, post, like, profile, follow and reply with authorization', async ({ browser }) => {
  const alice = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const bob = await browser.newContext({ viewport: { width: 320, height: 700 }, isMobile: true, hasTouch: true });
  const a = await alice.newPage(); const b = await bob.newPage();
  await a.goto('/');
  await signUp(a, 'Alice Example', `${prefix}a`);
  await a.getByRole('button', { name: 'Compose' }).click();
  await a.getByPlaceholder('What’s happening in your world?').fill('Hello from Alice');
  await a.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(a.getByText('Hello from Alice').first()).toBeVisible();
  await b.goto('/'); await signUp(b, 'Bob Example', `${prefix}b`);
  await expect(b.getByText('Hello from Alice').first()).toBeVisible();
  await b.getByRole('button', { name: 'Like' }).first().click();
  await b.getByRole('button', { name: `Alice Example @${prefix}a` }).first().click();
  await b.getByRole('button', { name: 'Follow +' }).click();
  await expect(b.getByRole('button', { name: 'Following ✓' })).toBeVisible();
  await b.getByRole('button', { name: 'Home' }).click();
  await b.getByRole('button', { name: 'Reply' }).first().click();
  await b.getByPlaceholder('What’s happening in your world?').fill('Hello Alice!');
  await b.getByRole('button', { name: 'Post', exact: true }).click();
  const postId = (await b.request.get('/api/posts').then(r => r.json())).items.find((p: { body: string }) => p.body === 'Hello from Alice').id;
  const unauthorized = await b.request.delete(`/api/posts/${postId}`, { headers: { origin: 'http://localhost:5173' } });
  expect(unauthorized.status()).toBe(403);
  const replies = await b.request.get(`/api/posts?parent=${postId}`).then(r => r.json());
  expect(replies.items.some((p: { body: string }) => p.body === 'Hello Alice!')).toBeTruthy();
  expect(await b.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await alice.close(); await bob.close();
});
