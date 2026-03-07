import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import http from 'node:http';

test('hinge downloads are below panel and export strip/element force CSV', async ({ page }) => {
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
    await page.waitForFunction(() => Boolean(window.__trefftzTestHook?.setFlowSolverData));

    await expect(page.locator('#downloadForcesStrip')).toBeVisible();
    await expect(page.locator('#downloadForcesElement')).toBeVisible();
    const placement = await page.evaluate(() => {
      const stripBtn = document.getElementById('downloadForcesStrip');
      const hingePanel = Array.from(document.querySelectorAll('.panel.output'))
        .find((p) => p.querySelector('.panel-title')?.textContent?.includes('Hinge Moments')) || null;
      const insideHinge = Boolean(stripBtn && hingePanel && hingePanel.contains(stripBtn));
      const panelRect = hingePanel?.getBoundingClientRect();
      const btnRect = stripBtn?.getBoundingClientRect();
      return {
        insideHinge,
        panelBottom: Number(panelRect?.bottom || 0),
        buttonTop: Number(btnRect?.top || 0),
      };
    });
    expect(placement.insideHinge).toBe(false);
    expect(placement.buttonTop).toBeGreaterThanOrEqual(placement.panelBottom - 1);

    await page.evaluate(() => {
      const idx2 = (i, j, dim1) => i + dim1 * j;
      const rle = new Array(12).fill(0);
      const rv = new Array(4 * 3).fill(0);
      rle[idx2(2, 1, 4)] = 1.25;
      rle[idx2(3, 1, 4)] = -0.5;
      rv[idx2(1, 1, 4)] = 1.0;
      rv[idx2(2, 1, 4)] = 2.0;
      rv[idx2(3, 1, 4)] = 3.0;
      rv[idx2(1, 2, 4)] = 1.5;
      rv[idx2(2, 2, 4)] = 2.1;
      rv[idx2(3, 2, 4)] = 3.2;
      window.__trefftzTestHook?.setFlowSolverData?.({
        CLSTRP: [0, 0.4],
        CDSTRP: [0, 0.03],
        CYSTRP: [0, -0.01],
        CHORD: [0, 1.5],
        WSTRIP: [0, 2.5],
        RLE: rle,
        CNC: [0, 0.12345],
        CLT_LSTRP: [0, 0.34567],
        CL_LSTRP: [0, 0.45678],
        CD_LSTRP: [0, 0.05678],
        CDV_LSTRP: [0, 0.00678],
        CMC4_LSTRP: [0, -0.02000],
        CMLE_LSTRP: [0, 0.09420],
        DWWAKE: [0, 0.01234],
        JFRST: [0, 1],
        NJ: [0, 1],
        IJFRST: [0, 1],
        NVSTRP: [0, 2],
        RV: rv,
        DXV: [0, 0.5, 0.5],
        SLOPEC: [0, 0.4, 0.4],
        DCP: [0, 0.111111, -0.222222],
      });
    });

    const [stripDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#downloadForcesStrip'),
    ]);
    expect(stripDownload.suggestedFilename()).toContain('_strip_forces.csv');
    const stripPath = await stripDownload.path();
    const stripCsv = await fs.readFile(stripPath, 'utf8');
    expect(stripCsv).toContain('strip_idx,surface_idx,Xle,Yle,Zle,Chord,Area,c_cl,ai,cl_norm,cl,cd,cdv,cm_c/4,cm_LE,C.P.x/c');
    expect(stripCsv).toContain('1,1,0.00000,1.25000,-0.50000,1.50000,3.75000,0.12345,0.01234,0.34567,0.45678,0.05678,0.00678,-0.02000,0.09420,-0.20623');

    const [elementDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#downloadForcesElement'),
    ]);
    expect(elementDownload.suggestedFilename()).toContain('_element_forces.csv');
    const elementPath = await elementDownload.path();
    const elementCsv = await fs.readFile(elementPath, 'utf8');
    expect(elementCsv).toContain('element_idx,strip_idx,surface_idx,X,Y,Z,DX,Slope,dCp.');
    expect(elementCsv).toContain('1,1,1,1.00000,2.00000,3.00000,0.50000,0.40000,0.111111');
    expect(elementCsv).toContain('2,1,1,1.50000,2.10000,3.20000,0.50000,0.40000,-0.222222');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
