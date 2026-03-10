import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import http from 'node:http';

function createServer(root) {
  return http.createServer(async (req, res) => {
    const reqPath = (req.url || '/').split('?')[0];
    const clean = decodeURIComponent(reqPath === '/' ? '/index.html' : reqPath);
    const filePath = path.join(root, clean);
    try {
      const data = await fs.readFile(filePath);
      if (filePath.endsWith('.html')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
      else if (filePath.endsWith('.js')) res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      else if (filePath.endsWith('.css')) res.setHeader('Content-Type', 'text/css; charset=utf-8');
      else if (filePath.endsWith('.json')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
      else if (filePath.endsWith('.run') || filePath.endsWith('.mass') || filePath.endsWith('.avl')) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      }
      res.statusCode = 200;
      res.end(data);
    } catch {
      res.statusCode = 404;
      res.end('Not found');
    }
  });
}

async function setupPage(page) {
  const root = path.resolve('.');
  const server = createServer(root);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#debugLog')).toContainText('App ready', { timeout: 15000 });
  return server;
}

test('Define Sweep modal opens showing constraint rows and closes on Cancel', async ({ page }) => {
  const server = await setupPage(page);
  try {
    await expect(page.locator('#sweepModal')).toBeHidden();
    await page.click('#sweepDefineBtn');
    await expect(page.locator('#sweepModal')).toBeVisible();

    // Should have at least the 5 base constraint rows (alpha, beta, p, q, r) plus any control surfaces
    const rows = page.locator('#sweepRows .sweep-row');
    const count = await rows.count();
    expect(count).toBeGreaterThanOrEqual(5);

    // Cancel closes the modal
    await page.click('#sweepCancelBtn');
    await expect(page.locator('#sweepModal')).toBeHidden();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Checkbox limit prevents selecting more than 3 sweep variables', async ({ page }) => {
  const server = await setupPage(page);
  try {
    await page.click('#sweepDefineBtn');
    const checks = page.locator('#sweepRows .sweep-enable');
    const count = await checks.count();
    expect(count).toBeGreaterThanOrEqual(4);

    // Enable first 3
    await checks.nth(0).check();
    await checks.nth(1).check();
    await checks.nth(2).check();

    // 4th checkbox should be disabled
    await expect(checks.nth(3)).toBeDisabled();

    // Uncheck one, 4th should re-enable
    await checks.nth(1).uncheck();
    await expect(checks.nth(3)).toBeEnabled();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Single-variable sweep generates correct run cases', async ({ page }) => {
  const server = await setupPage(page);
  try {
    const initialCount = await page.locator('#runCaseList .run-case-item').count();

    await page.click('#sweepDefineBtn');
    const firstRow = page.locator('#sweepRows .sweep-row').first();

    // Enable alpha
    await firstRow.locator('.sweep-enable').check();
    // Set start=0, stop=2, delta=1
    await firstRow.locator('.sweep-start').fill('0');
    await firstRow.locator('.sweep-stop').fill('2');
    await firstRow.locator('.sweep-delta').fill('1');

    // Preview should say 3 cases
    await expect(page.locator('#sweepCaseCount')).toContainText('3 case(s)');

    await page.click('#sweepConfirmBtn');
    await expect(page.locator('#sweepModal')).toBeHidden();

    // Should have 3 new run cases
    await expect(page.locator('#runCaseList .run-case-item')).toHaveCount(initialCount + 3);

    // Check names
    const titles = page.locator('#runCaseList .run-case-item .run-case-title');
    const names = [];
    for (let i = initialCount; i < initialCount + 3; i++) {
      names.push(await titles.nth(i).inputValue());
    }
    expect(names).toEqual(['alpha=0', 'alpha=1', 'alpha=2']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Two-variable sweep generates cartesian product', async ({ page }) => {
  const server = await setupPage(page);
  try {
    const initialCount = await page.locator('#runCaseList .run-case-item').count();

    await page.click('#sweepDefineBtn');
    const rows = page.locator('#sweepRows .sweep-row');

    // Enable alpha: 0 to 1, delta 1
    const alphaRow = rows.nth(0);
    await alphaRow.locator('.sweep-enable').check();
    await alphaRow.locator('.sweep-start').fill('0');
    await alphaRow.locator('.sweep-stop').fill('1');
    await alphaRow.locator('.sweep-delta').fill('1');

    // Enable beta: 5 to 10, delta 5
    const betaRow = rows.nth(1);
    await betaRow.locator('.sweep-enable').check();
    await betaRow.locator('.sweep-start').fill('5');
    await betaRow.locator('.sweep-stop').fill('10');
    await betaRow.locator('.sweep-delta').fill('5');

    // Preview: 2 * 2 = 4 cases
    await expect(page.locator('#sweepCaseCount')).toContainText('4 case(s)');

    await page.click('#sweepConfirmBtn');
    await expect(page.locator('#runCaseList .run-case-item')).toHaveCount(initialCount + 4);

    const titles = page.locator('#runCaseList .run-case-item .run-case-title');
    const names = [];
    for (let i = initialCount; i < initialCount + 4; i++) {
      names.push(await titles.nth(i).inputValue());
    }
    expect(names).toEqual([
      'alpha=0,beta=5',
      'alpha=0,beta=10',
      'alpha=1,beta=5',
      'alpha=1,beta=10',
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Case count preview updates dynamically', async ({ page }) => {
  const server = await setupPage(page);
  try {
    await page.click('#sweepDefineBtn');
    await expect(page.locator('#sweepCaseCount')).toContainText('No variables selected');

    const firstRow = page.locator('#sweepRows .sweep-row').first();
    await firstRow.locator('.sweep-enable').check();
    await firstRow.locator('.sweep-start').fill('0');
    await firstRow.locator('.sweep-stop').fill('5');
    await firstRow.locator('.sweep-delta').fill('1');
    await expect(page.locator('#sweepCaseCount')).toContainText('6 case(s)');

    // Change delta to 2
    await firstRow.locator('.sweep-delta').fill('2');
    await expect(page.locator('#sweepCaseCount')).toContainText('3 case(s)');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
