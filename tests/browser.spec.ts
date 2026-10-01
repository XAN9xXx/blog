import { test, expect } from '@playwright/test';

// Assertions below describe tests/fixtures/content, never whatever is currently published.
test.beforeEach(async ({ request }) => {
  const notes = await (await request.get('/notes/')).text();
  const links = [...new Set([...notes.matchAll(/href="(\/notes\/[^"]+\/)"/g)].map(match => match[1]))].sort();
  if (links.join() !== '/notes/hello/,/notes/publishing-pipeline/') throw new Error('浏览器测试只针对冻结内容：请用 BLOG_CONTENT_DIR=tests/fixtures/content 启动开发服务器（见 docs/workflow.md）。');
});

test('published map opens real article; theme and deep links survive host integration', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const map = page.locator('#map');
  await expect(map.locator('.xan9x-topology')).toHaveCount(1);
  const directory = JSON.parse((await map.locator('[data-topology-document]').getAttribute('data-topology-document'))!);
  function assertDirectory(node: { type: string; href?: string; children?: typeof node[] }) {
    if (node.type === 'article') expect(node.href).toMatch(/^\/notes\/[^/]+\/$/);
    else if (node.type !== 'root') expect(node.children?.length).toBeGreaterThan(0);
    node.children?.forEach(assertDirectory);
  }
  assertDirectory(directory.root);
  await expect(map.locator('g.node')).toHaveCount(directory.root.children.length + 1);
  await page.screenshot({ path: info.outputPath('blog-root.png'), animations: 'disabled' });
  await map.locator('[data-id="infrastructure"]').click();
  await map.locator('[data-id="cicd"]').click();
  await map.locator('[data-id="hello"]').click();
  await expect(page).not.toHaveURL(/\/notes\/hello\/$/);
  await expect(map.locator('.context-panel')).toContainText('Hello from Blog-Content');
  await expect(map.getByRole('link', { name: '打开内容 →' })).toHaveAttribute('href', '/notes/hello/');
  await page.screenshot({ path: info.outputPath('blog-article-panel.png'), animations: 'disabled' });
  await map.getByRole('link', { name: '打开内容 →' }).click();
  await expect(page).toHaveURL(/\/notes\/hello\/$/);
  await expect(page.getByRole('heading', { name: 'Hello from Blog-Content' })).toBeVisible();
  await expect(page.locator('article')).toContainText('This article lives in the Blog-Content repository.');
  await page.goBack();
  await expect(map.locator('.node.current')).toHaveAttribute('data-id', 'cicd');
  expect(errors).toEqual([]);
});

test('serialized data is safe, there are no placeholder links, keyboard and theme work', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?check=1#topic=infrastructure/cicd');
  const map = page.locator('#map');
  await expect(map.locator('.node.current')).toHaveAttribute('data-id', 'cicd');
  const data = await map.locator('[data-topology-document]').getAttribute('data-topology-document');
  expect(data).not.toMatch(/#article-|#project-|#topic-/);
  await map.locator('[data-id="hello"]').focus(); await page.keyboard.press('Enter');
  await expect(map.locator('.context-panel')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(map.locator('.context-panel')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(map.locator('.node.current')).toHaveAttribute('data-id', 'infrastructure');
  await expect(page).toHaveURL(/\?check=1#topic=infrastructure$/);
  await page.locator('html').evaluate(element => { element.setAttribute('data-theme', 'dark'); });
  await expect(map.locator('.node.current .title')).toHaveCSS('fill', 'rgb(231, 233, 234)');
});


test('homepage empty player, navigation, theme persistence, and responsive layout', async ({ page }, info) => {
  await page.setViewportSize({ width: 1486, height: 1059 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '技术地图' })).toBeVisible();
  await expect(page.getByText('点击主题，逐层展开。')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '音乐', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '音乐播放器', exact: true })).toBeVisible();
  await expect(page.getByText('还没有添加音乐')).toBeVisible();
  const player = page.locator('#music');
  for (const control of await player.locator('button, input').all()) await expect(control).toBeDisabled();
  expect(await player.locator('audio').getAttribute('src')).toBeNull();
  await expect(player.locator('[data-duration]')).toHaveText('0:00');
  await page.getByRole('button', { name: '切换主题' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload(); await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.mouse.move(0, 0);
  await page.screenshot({ path: info.outputPath('homepage-light.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '切换主题' }).click();
  await page.mouse.move(0, 0);
  for (const width of [1486, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1059 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`homepage-${width}.png`), fullPage: true, animations: 'disabled' });
  }
  await page.getByRole('navigation').getByRole('link', { name: '音乐' }).click();
  await expect(page).toHaveURL(/#music$/);
  await page.getByRole('navigation').getByRole('link', { name: '文章' }).click();
  await expect(page).toHaveURL(/\/notes\/$/);
});

test('self-hosted fixture plays, seeks, changes volume, selects tracks and finishes the playlist', async ({ page }) => {
  test.skip(!process.env.BLOG_MUSIC_TEST_URL, 'Requires isolated two-track music fixture server.');
  await page.goto(process.env.BLOG_MUSIC_TEST_URL!);
  const player = page.locator('#music');
  const audio = player.locator('audio');
  expect(await audio.evaluate((a: HTMLAudioElement) => a.paused)).toBe(true);
  await player.getByRole('button', { name: '播放', exact: true }).click();
  await expect(player.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0);
  await player.getByRole('button', { name: '暂停', exact: true }).click();
  await player.getByRole('slider', { name: '播放进度' }).fill('2');
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThanOrEqual(1.9);
  await player.getByRole('slider', { name: '音量', exact: true }).fill('0.35');
  expect(await audio.evaluate((a: HTMLAudioElement) => a.volume)).toBeCloseTo(.35);
  await player.getByRole('button', { name: '静音', exact: true }).click();
  expect(await audio.evaluate((a: HTMLAudioElement) => a.muted)).toBe(true);
  await player.getByRole('button', { name: '取消静音' }).click();
  await player.getByRole('button', { name: '下一首' }).click();
  await expect(player.locator('[data-track-title]')).toHaveText('测试音轨 B');
  expect(await audio.evaluate((a: HTMLAudioElement) => a.paused)).toBe(true);
  await player.getByRole('button', { name: '上一首' }).click();
  await player.locator('[data-play]').focus(); await page.keyboard.press('Space');
  await expect(player.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  await audio.evaluate((a: HTMLAudioElement) => { a.currentTime = a.duration - .2; });
  await expect(player.locator('[data-track-title]')).toHaveText('测试音轨 B');
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0);
  await audio.evaluate((a: HTMLAudioElement) => { a.currentTime = a.duration - .2; });
  await expect(player.getByRole('button', { name: '播放', exact: true })).toBeVisible();
  await player.locator('[data-track-index="0"]').click();
  await expect(player.locator('[data-track-title]')).toHaveText('测试音轨 A');
  await expect(player.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
});

test('missing audio reports an error and switching to a healthy track recovers', async ({ page }) => {
  test.skip(!process.env.BLOG_MUSIC_TEST_URL, 'Requires isolated two-track music fixture server.');
  await page.route('**/music/fixture-a.wav', route => route.fulfill({ status: 404, body: 'Missing' }));
  await page.goto(process.env.BLOG_MUSIC_TEST_URL!);
  const player = page.locator('#music');
  await player.getByRole('button', { name: '播放', exact: true }).click();
  await expect(player.getByRole('status')).toContainText('无法播放');
  await player.locator('[data-track-index="1"]').click();
  await expect(player.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  await expect(player.getByRole('status')).toBeHidden();
});


test('narrow-screen map can be panned, drilled into, opened and returned to root', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const map = page.locator('#map');
  const viewport = map.locator('.map-viewport');
  await expect(map.getByRole('button', { name: '上一层' })).toBeDisabled();
  const before = await viewport.evaluate(element => element.scrollLeft);
  await map.getByRole('button', { name: '向右查看地图' }).click();
  expect(await viewport.evaluate(element => element.scrollLeft)).toBeGreaterThan(before);
  await map.locator('[data-id="infrastructure"]').click();
  await map.locator('[data-id="cicd"]').click();
  await map.locator('[data-id="hello"]').click();
  const panel = map.locator('.context-panel');
  await expect(panel).toBeVisible();
  const bounds = await panel.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await expect(map.getByRole('link', { name: '打开内容 →' })).toBeInViewport();
  await page.keyboard.press('Escape');
  await map.getByRole('button', { name: '上一层' }).click();
  await expect(map.locator('.node.current')).toHaveAttribute('data-id', 'infrastructure');
  await map.getByRole('button', { name: '全部主题' }).click();
  await expect(map.getByRole('button', { name: '上一层' })).toBeDisabled();
});

test('unknown paths get the 404 page with a 404 status, not the homepage', async ({ page }) => {
  const response = await page.goto('/notes/missing-fixture-article/');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: '页面不存在' })).toBeVisible();
  await expect(page.locator('#map')).toHaveCount(0);
  await page.getByRole('link', { name: '回到技术地图' }).click();
  await expect(page.locator('#map .xan9x-topology')).toHaveCount(1);
});

test('article page links back to every map entry, lists its sections, copies code and follows the theme', async ({ page, context }, info) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 1486, height: 1059 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/notes/publishing-pipeline/');
  await expect(page).toHaveTitle('博客发布链路：从工作台到 Cloudflare Pages — XAN9x');
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '文章' })).toHaveAttribute('aria-current', 'page');
  const places = page.getByRole('list', { name: '在地图中的位置' }).getByRole('link');
  expect(await places.evaluateAll(links => links.map(link => link.getAttribute('href')))).toEqual(['/#topic=infrastructure/selfhosting', '/#topic=infrastructure/cicd']);
  await expect(places.nth(1)).toHaveText('Infrastructure / CI / CD');

  const toc = page.getByRole('navigation', { name: '本文目录' });
  await expect(toc.getByRole('link')).toHaveText(['链路总览', '执行器只能快进推送', '怎样才算“已上线”']);
  await expect(page.locator('.toc-inline')).toBeHidden();
  await expect(toc.getByRole('link', { name: '链路总览' })).toHaveAttribute('aria-current', 'location');
  await toc.getByRole('link', { name: '执行器只能快进推送' }).click();
  expect(await page.evaluate(() => decodeURIComponent(location.hash))).toBe('#执行器只能快进推送');
  await expect(page.getByRole('heading', { level: 2, name: '执行器只能快进推送' })).toBeInViewport();
  await expect(toc.getByRole('link', { name: '执行器只能快进推送' })).toHaveAttribute('aria-current', 'location');
  await expect(toc.locator('[aria-current]')).toHaveCount(1);
  expect(await page.locator('.code-block pre code').first().evaluate(element => getComputedStyle(element).fontFamily)).toContain('Consolas');

  const blocks = page.locator('.code-block');
  await expect(blocks.locator('.code-lang')).toHaveText(['ini', 'bash']);
  await expect(page.getByRole('region', { name: '可横向滚动的表格' })).toBeVisible();
  const copy = blocks.nth(1).getByRole('button');
  await expect(copy).toHaveText('复制', { useInnerText: true });
  await copy.click();
  await expect(copy).toHaveText('已复制', { useInnerText: true });
  // The Windows clipboard stores CRLF; the copied text itself uses LF.
  expect((await page.evaluate(() => navigator.clipboard.readText())).replaceAll('\r\n', '\n')).toBe('systemctl is-active xan9x-workbench xan9x-publisher\njournalctl -u xan9x-publisher -n 20 --no-pager');
  await expect(copy).toHaveText('复制', { useInnerText: true, timeout: 4000 });

  const pager = page.getByRole('navigation', { name: '上一篇和下一篇' }).getByRole('link');
  await expect(pager).toHaveCount(1);
  await expect(pager).toHaveAttribute('href', '/notes/hello/');
  await expect(pager).toContainText('上一篇');

  const token = blocks.nth(0).locator('pre .line span').first();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: info.outputPath('article-1486-dark.png'), fullPage: true, animations: 'disabled' });
  expect(await token.evaluate(element => getComputedStyle(element).color)).toBe('rgb(179, 146, 240)');
  await page.getByRole('button', { name: '切换主题' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await token.evaluate(element => getComputedStyle(element).color)).toBe('rgb(111, 66, 193)');
  await page.mouse.move(0, 0);
  await page.screenshot({ path: info.outputPath('article-1486-light.png'), fullPage: true, animations: 'disabled' });

  await places.nth(1).click();
  await expect(page).toHaveURL(/\/#topic=infrastructure\/cicd$/);
  await expect(page.locator('#map .node.current')).toHaveAttribute('data-id', 'cicd');
});

test('a short article keeps a single h1, skips the contents list and links to the newer article', async ({ page }) => {
  await page.goto('/notes/hello/');
  await expect(page.locator('h1')).toHaveText(['Hello from Blog-Content']);
  await expect(page.locator('.prose h2')).toHaveText(['Hello']);
  await expect(page.getByRole('navigation', { name: '本文目录' })).toHaveCount(0);
  await expect(page.locator('.toc-inline')).toHaveCount(0);
  const pager = page.getByRole('navigation', { name: '上一篇和下一篇' }).getByRole('link');
  await expect(pager).toHaveCount(1);
  await expect(pager).toHaveAttribute('href', '/notes/publishing-pipeline/');
  await expect(pager).toContainText('下一篇');
});

test('the notes list groups by year, newest first, with each article\'s map location', async ({ page }, info) => {
  await page.setViewportSize({ width: 1486, height: 1059 });
  await page.goto('/notes/');
  await expect(page).toHaveTitle('文章 — XAN9x');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('文章');
  await expect(page.locator('.count')).toHaveText('2 篇');
  const rows = page.getByRole('region', { name: '2026' }).getByRole('listitem');
  expect(await rows.getByRole('link').evaluateAll(links => links.map(link => link.getAttribute('href')))).toEqual(['/notes/publishing-pipeline/', '/notes/hello/']);
  await expect(rows.nth(0)).toContainText('09-30');
  await expect(rows.nth(0)).toContainText('Infrastructure / Self-hosting');
  await expect(rows.nth(1)).toContainText('Infrastructure / CI / CD');
  await page.screenshot({ path: info.outputPath('notes-1486-dark.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '切换主题' }).click();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: info.outputPath('notes-1486-light.png'), fullPage: true, animations: 'disabled' });
  await rows.nth(1).getByRole('link').click();
  await expect(page).toHaveURL(/\/notes\/hello\/$/);
});

test('article and list pages fit every width; narrow screens fold the contents list', async ({ page }, info) => {
  for (const path of ['/notes/publishing-pipeline/', '/notes/']) {
    await page.goto(path);
    for (const width of [1486, 1199, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${path} at ${width}px`).toBe(true);
      if (path === '/notes/') continue;
      await expect(page.locator('.toc-rail')).toBeVisible({ visible: width >= 1200 });
      await expect(page.locator('.toc-inline')).toBeVisible({ visible: width < 1200 });
    }
  }
  await page.goto('/notes/publishing-pipeline/');
  await page.setViewportSize({ width: 390, height: 844 });
  const longLine = page.locator('.code-block pre').first();
  expect(await longLine.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('article-390.png'), fullPage: true, animations: 'disabled' });
  await page.locator('.toc-inline summary').click();
  await expect(page.locator('.toc-inline').getByRole('link')).toHaveText(['链路总览', '执行器只能快进推送', '怎样才算“已上线”']);
  await page.goto('/notes/');
  await page.screenshot({ path: info.outputPath('notes-390.png'), fullPage: true, animations: 'disabled' });
});
