import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import http from 'node:http';

test('supra default run first element CSV rows match fortran reference values closely', async ({ page }) => {
  test.setTimeout(120000);
  const root = path.resolve('.');
  const server = http.createServer(async (req, res) => {
    const reqPath = (req.url || '/').split('?')[0];
    const clean = decodeURIComponent(reqPath === '/' ? '/index.html' : reqPath);
    const filePath = path.join(root, clean);
    try {
      const data = await fs.readFile(filePath);
      if (filePath.endsWith('.html')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
      else if (filePath.endsWith('.js')) res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      else if (filePath.endsWith('.css')) res.setHeader('Content-Type', 'text/css; charset=utf-8');
      else if (filePath.endsWith('.json')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
      else if (filePath.endsWith('.run') || filePath.endsWith('.mass') || filePath.endsWith('.avl') || filePath.endsWith('.dat')) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      }
      res.statusCode = 200;
      res.end(data);
    } catch {
      res.statusCode = 404;
      res.end('Not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  try {
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const select = document.getElementById('loadExampleSelect');
      return Boolean(select && select.options.length > 1 && !select.disabled);
    }, null, { timeout: 30000 });
    await page.selectOption('#loadExampleSelect', 'supra.avl');
    await expect(page.locator('#fileMeta')).toContainText('supra.avl', { timeout: 30000 });
    await expect(page.locator('#runCasesMeta')).toContainText('supra.run', { timeout: 30000 });
    await expect(page.locator('.constraint-row[data-var=\"alpha\"] .constraint-select')).toHaveValue('alpha');
    await expect(page.locator('.constraint-row[data-var=\"alpha\"] .constraint-value')).toHaveValue(/^\s*5(\.0+)?\s*$/);
    await expect.poll(async () => {
      const r = await page.evaluate(() => window.__trefftzTestHook?.getLastExecResult?.() || null);
      return Number(r?.CLSTRP?.length || 0);
    }, { timeout: 60000 }).toBeGreaterThan(1);

    const [elementDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#downloadForcesElement'),
    ]);
    const elementPath = await elementDownload.path();
    const elementCsvText = await fs.readFile(elementPath, 'utf8');
    const elementLines = elementCsvText.trim().split(/\r?\n/);
    expect(elementLines.length).toBeGreaterThan(2);
    const e1 = elementLines[1].split(',');
    const e2 = elementLines[2].split(',');
    const eNum = (row, idx) => Number(row[idx]);

    // Supra / default run reference from AVL element forces output.
    expect(eNum(e1, 0)).toBe(1);
    expect(eNum(e1, 3)).toBeCloseTo(0.12231, 4); // X
    expect(eNum(e1, 4)).toBeCloseTo(2.07914, 4); // Y
    expect(eNum(e1, 5)).toBeCloseTo(0.09086, 4); // Z
    expect(eNum(e1, 6)).toBeCloseTo(0.64870, 4); // DX
    expect(eNum(e1, 7)).toBeCloseTo(0.11564, 4); // Slope
    expect(eNum(e1, 8)).toBeCloseTo(2.16167, 2); // dCp

    expect(eNum(e2, 0)).toBe(2);
    expect(eNum(e2, 3)).toBeCloseTo(0.94124, 4); // X
    expect(eNum(e2, 4)).toBeCloseTo(2.07914, 4); // Y
    expect(eNum(e2, 5)).toBeCloseTo(0.09086, 4); // Z
    expect(eNum(e2, 6)).toBeCloseTo(1.34723, 4); // DX
    expect(eNum(e2, 7)).toBeCloseTo(0.05780, 4); // Slope
    expect(eNum(e2, 8)).toBeCloseTo(1.20330, 2); // dCp
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
