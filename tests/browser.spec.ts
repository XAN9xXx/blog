import { test, expect } from '@playwright/test';

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
