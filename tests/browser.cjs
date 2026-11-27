/* Offline release acceptance checks. Run after building production and fixtures. */
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const qa = path.join(root, '.local', 'qa');
const servers = [];
const errors = [];
const external = [];
const requests = new Set();
const shortName = s => s.replace(/^.*\/birds\/atlas\//, '');

function serve(demo) {
  const launcher = process.platform === 'win32' ? 'py' : 'python3';
  const python = process.env.ATLAS_PYTHON || execFileSync(launcher, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
  const server = spawn(python, ['atlas.py', 'preview', '--port', '0', ...(demo ? ['--demo'] : [])],
    { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(server);
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Local preview timed out: ' + output)), 12000);
    server.stdout.on('data', chunk => {
      output += chunk.toString();
      const url = output.match(/http:\/\/127\.0\.0\.1:\d+\/birds\/atlas\//);
      if (url) { clearTimeout(timer); resolve(url[0]); }
    });
    server.stderr.on('data', chunk => { output += chunk.toString(); });
    server.once('error', e => { clearTimeout(timer); reject(e); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error('Preview exited ' + code + ': ' + output)); });
  });
}

async function browserPage(browser, url, mobile) {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1366, height: 820 },
    isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1, reducedMotion: 'reduce', serviceWorkers: 'block',
  });
  const origin = new URL(url).origin;
  await context.route('**/*', route => {
    const target = new URL(route.request().url());
    if (['http:', 'https:'].includes(target.protocol) && target.origin !== origin) {
      external.push(target.href);
      return route.abort();
    }
    return route.continue();
  });
  context.on('request', request => {
    const target = new URL(request.url());
    if (!['http:', 'https:'].includes(target.protocol)) return;
    if (target.origin !== origin) external.push(target.href);
    else requests.add(shortName(target.pathname));
  });
  context.on('response', response => {
    if (response.status() >= 400) errors.push(response.status() + ' ' + response.url());
  });
  const page = await context.newPage();
  page.on('pageerror', err => errors.push(err.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', e => console.error('CSP blocked ' + e.blockedURI));
  });
  assert.equal((await page.goto(url)).status(), 200);
  await settle(page);
  assert.equal(page.url(), url);
  assert.equal((await page.reload()).status(), 200);
  await settle(page);
  return page;
}

async function settle(page) {
  await page.evaluate(async () => {
    const map = await (await import('./app.js')).ready;
    const nextIdle = map.once('idle');
    map.triggerRepaint();
    await nextIdle;
  });
}

async function clickPoint(page, point, mobile = false) {
  const pixel = await page.evaluate(async point => {
    const map = await (await import('./app.js')).ready;
    map.jumpTo({ center: point, zoom: 14 });
    const idle = map.once('idle');
    map.triggerRepaint();
    await idle;
    const p = map.project(point);
    const box = map.getCanvas().getBoundingClientRect();
    return { x: box.x + p.x, y: box.y + p.y };
  }, point);
  if (mobile) await page.touchscreen.tap(pixel.x, pixel.y);
  else await page.mouse.click(pixel.x, pixel.y);
}

const layer = (page, name) => page.getByRole('checkbox', { name, exact: true });
const link = (page, name) => page.locator('#details').getByRole('link', { name, exact: true });
const title = page => page.locator('#detail-title').innerText();

async function production(page, mobile) {
  const data = JSON.parse(fs.readFileSync(path.join(root, 'dist/data/records.json'), 'utf8'));
  assert.equal(data.mode, 'production');
  const count = Object.values(data.layers).reduce((n, l) => n + l.records.length, 0);
  assert.equal(await page.locator('#map-count').textContent(), count.toLocaleString('en-US') + (count === 1 ? ' record shown' : ' records shown'));
  assert.equal(await page.locator('#demo-label').isVisible(), false);
  assert.equal(await page.locator('#birds-toggle').evaluate(button => {
    const bounds = button.getBoundingClientRect();
    const chevron = button.querySelector('.chevron').getBoundingClientRect();
    return button.scrollWidth <= button.clientWidth + 1 && chevron.right < bounds.right;
  }), true, 'Birds dropdown affordance must fit inside its button');
  await page.screenshot({ path: path.join(qa, mobile ? 'production-phone.png' : 'production-desktop.png') });
  await page.getByRole('button', { name: 'Map guide', exact: true }).click();
  assert.equal(await page.getByRole('dialog').isVisible(), true);
  await page.getByRole('button', { name: 'Close map guide' }).click();
  const record = data.layers.eggs.records.find(r => r.id === 'E1234');
  if (record) {
    await clickPoint(page, record.point, mobile);
    const chooser = page.getByRole('button', { name: /^Eggs\s*E1234$/ });
    if (await chooser.count()) await chooser.click();
    assert.equal(await title(page), 'E1234');
    assert.equal(await link(page, 'View egg slip').getAttribute('href'), 'https://ericlaslo.com/birds/eggs/E1234');
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
}

async function fixtures(page, mobile) {
  const birds = page.getByRole('button', { name: 'Birds', exact: true });
  async function openLayers() {
    if (await birds.getAttribute('aria-expanded') === 'false') await birds.click();
  }
  assert.equal(await page.locator('#demo-label').isVisible(), true);
  await openLayers();
  assert.deepEqual(await page.getByRole('checkbox').evaluateAll(nodes => nodes.map(n => n.getAttribute('aria-label'))),
    ['Eggs', 'Types', 'Fluids', 'Skins']);
  for (const name of ['Eggs', 'Types', 'Fluids', 'Skins']) assert.equal(await layer(page, name).isChecked(), true);
  if (mobile) await birds.click();
  const shared = [-79.948, 40.445];
  await clickPoint(page, shared, mobile);
  assert.equal(await title(page), '2 records here');
  const panel = page.locator('#details');
  await panel.getByRole('button', { name: /^Eggs\s*E1234$/ }).click();
  assert.equal(await title(page), 'E1234');
  assert.equal(await link(page, 'View egg slip').getAttribute('href'), 'https://ericlaslo.com/birds/eggs/E1234');
  assert.equal(await link(page, 'Collection database').getAttribute('href'), 'https://example.org/collection/E1234');
  assert.equal(new URL(await link(page, 'Search Wikipedia').getAttribute('href')).searchParams.get('search'), 'Turdus migratorius');
  await panel.getByRole('button', { name: 'All 2 records here' }).click();
  await panel.getByRole('button', { name: /^Types\s*E1234$/ }).click();
  assert.equal(await link(page, 'Wikipedia article').getAttribute('href'), 'https://en.wikipedia.org/wiki/Red-tailed_hawk');
  assert.equal(await link(page, 'View egg slip').count(), 0);
  assert.equal(await link(page, 'Search Wikipedia').count(), 0);
  await openLayers();
  await layer(page, 'Types').uncheck();
  assert.equal(await panel.isVisible(), false);
  if (mobile) await birds.click();
  await clickPoint(page, shared, mobile);
  assert.equal(await title(page), 'E1234');
  assert.equal(await link(page, 'View egg slip').count(), 1);
  await openLayers();
  await layer(page, 'Eggs').uncheck();
  if (mobile) await birds.click();
  await clickPoint(page, shared, mobile);
  assert.equal(await panel.isVisible(), false);
  await openLayers();
  await layer(page, 'Eggs').check();
  if (mobile) await birds.click();
  await clickPoint(page, [-79.952, 40.446], mobile);
  assert.equal(await title(page), 'E0007-A');
  assert.match(await panel.innerText(), /Pittsburgh east bank/);
  assert.match(await panel.innerText(), /Approximate position · Locality\/town approximation/);
  assert.deepEqual(await panel.locator('dt').allTextContents(), ['Scientific name', 'Original locality']);
  await page.screenshot({ path: path.join(qa, mobile ? 'detail-phone.png' : 'detail-desktop.png') });
  await panel.getByRole('button', { name: 'Close record panel' }).click();
  await clickPoint(page, [-80.8431, 35.2271], mobile);
  assert.equal(await title(page), 'F0042');
  assert.equal(await panel.locator('img').evaluate(async image => { await image.decode(); return image.naturalWidth; }), 400);
  await panel.getByRole('button', { name: 'Close record panel' }).click();
  await clickPoint(page, [-0.1276, 51.5072], mobile);
  assert.equal(await title(page), 'S0001');
  await panel.getByRole('button', { name: 'Close record panel' }).click();
  if (!mobile) {
    await page.locator('#map canvas').focus();
    await page.keyboard.press('Enter');
    assert.equal(await title(page), 'S0001');
    await page.keyboard.press('Escape');
    assert.equal(await panel.isVisible(), false);
  }
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await page.getByRole('button', { name: 'Reset world view', exact: true }).click();
  await openLayers();
  for (const name of ['Eggs', 'Fluids', 'Skins']) await layer(page, name).uncheck();
  assert.match(await page.locator('#notice').innerText(), /Select a layer/);
  assert.equal(await page.locator('#map-count').innerText(), '0 records shown');
  if (mobile) await birds.click();
  for (const point of [[-80.8431, 35.2271], [-0.1276, 51.5072]]) {
    await clickPoint(page, point, mobile);
    assert.equal(await panel.isVisible(), false);
  }
}

async function main() {
  fs.mkdirSync(qa, { recursive: true });
  const [prod, demo] = await Promise.all([serve(false), serve(true)]);
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const executablePath = process.env.ATLAS_BROWSER || (fs.existsSync(edge) ? edge : undefined);
  const browser = await chromium.launch({ executablePath, headless: true, args: [
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-background-networking',
    '--disable-component-update', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
  ] });
  try {
    for (const mobile of [false, true]) {
      for (const [url, check] of [[prod, production], [demo, fixtures]]) {
        const page = await browserPage(browser, url, mobile);
        await check(page, mobile);
        await page.context().close();
        console.log('PASS', check.name, mobile ? 'phone' : 'desktop', 'direct visit, refresh and interactions');
      }
    }
    assert.deepEqual(external, [], 'Off-origin request attempted');
    assert.deepEqual(errors, [], 'Browser, CSP or HTTP error');
    for (const name of ['vendor/maplibre-gl-worker.js', 'basemap/world.geojson', 'data/records.json']) {
      assert.ok(requests.has(name), 'Missing local resource ' + name);
    }
    console.log('PASS local resources only (' + requests.size + ' paths), no browser errors. Screenshots in .local/qa/');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const server of servers) server.kill();
});
