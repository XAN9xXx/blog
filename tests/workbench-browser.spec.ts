import { test, expect, type Page } from '@playwright/test';
const sshMode = process.env.WORKBENCH_TEST_AUTH_MODE === 'ssh';
async function login(page: Page) {
  await page.goto('/');
  if (!sshMode) { await page.getByLabel('密码', { exact: true }).fill('test-only-workbench-password');
  await page.getByRole('button', { name: '登录', exact: true }).click(); }
  await expect(page.getByRole('heading', { name: '内容工作区' })).toBeVisible();
  await expect(page.locator('#article-form').getByLabel('标题', { exact: true })).not.toHaveValue('');
}
const saved = (page: Page) => expect(page.locator('#message')).toHaveText('已保存到私有工作区，未发布。');
const view = (page: Page, name: 'articles' | 'directory' | 'preview') => page.locator('#view-' + name).click();
const settings = (page: Page) => page.locator('#article-settings > summary').click();
async function mapNode(page: Page, id: string) {
  await expect(page.locator('#map-preview svg')).not.toHaveClass(/animating/);
  await page.locator(`#map-preview [data-id="${id}"]`).click();
  await expect(page.locator('#map-preview svg')).not.toHaveClass(/animating/);
}
async function createDraft(page: Page, title: string) {
  await page.getByRole('button', { name: '新建草稿', exact: true }).click();
  await page.locator('#article-form').getByLabel('标题', { exact: true }).fill(title);
  await page.locator('#article-form').getByLabel('Markdown 正文').fill('# 私有正文\n\n**可读预览**\n\n<script>window.attack = true</script>');
  const id = await page.locator('#article-form').getByLabel('稳定 ID').inputValue();
  await page.getByRole('button', { name: '保存文章', exact: true }).click(); await saved(page);
  return id;
}
test('writing, binding and map preview form a safe round trip without manually entering IDs', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await login(page);
  await expect(page.locator('#directory-view')).toBeHidden();
  const id = await createDraft(page, '浏览器测试草稿');
  expect(id).toMatch(/^note-[a-f0-9-]+$/);
  const article = page.locator('#article-form');
  await expect(article.getByLabel('稳定 ID')).toHaveAttribute('readonly', '');
  await expect(article.getByLabel('保留为草稿')).toBeChecked();
  await page.getByRole('button', { name: '预览当前正文', exact: true }).click();
  await expect(page.locator('#rendered-body h1')).toHaveText('私有正文');
  await expect(article.getByLabel('Markdown 正文')).toBeHidden();
  expect(await page.evaluate(() => 'attack' in window)).toBe(false);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await expect(article.getByLabel('Markdown 正文')).toBeVisible();
  await view(page, 'directory');
  await expect(page.locator('#tree [data-node-id="compilers"]')).toBeVisible();
  await page.locator('#tree [data-node-id="software"]').click();
  await page.locator('#bind-panel > summary').click();
  const binding = page.locator('#bind-form'); await binding.getByRole('combobox', { name: '文章', exact: true }).selectOption(id);
  const nodeId = await binding.getByLabel('入口节点 ID').inputValue();
  await binding.getByRole('button', { name: '绑定到所选目录' }).click(); await saved(page);
  const publicResponse = page.waitForResponse(response => response.url().endsWith('/api/preview') && response.request().method() === 'POST');
  await view(page, 'preview');
  await expect(page.locator('#preview-caption')).toContainText('模拟公开地图');
  expect(JSON.stringify(await (await publicResponse).json())).not.toContain(nodeId);
  await page.getByRole('button', { name: '完整目录（含草稿）' }).click();
  await mapNode(page, 'software'); await mapNode(page, nodeId);
  await expect(page.locator('#map-preview .context-panel')).toContainText('浏览器测试草稿');
  await page.locator('#map-preview').getByRole('link', { name: '打开内容 →' }).click();
  await expect(page).toHaveURL(new URL('/', String(info.project.use.baseURL)).href);
  await expect(article.getByLabel('稳定 ID')).toHaveValue(id);
  await expect(page.locator('#view-articles')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#article-danger > summary').click();
  await page.getByRole('button', { name: '删除文章', exact: true }).click(); await expect(page.locator('#message')).toContainText('请先移除或重新绑定');
  await article.getByLabel('标题', { exact: true }).fill('改名后的文章'); await settings(page);
  await article.getByLabel('保留为草稿').uncheck();
  await page.locator('#topic-picker > summary').click();
  await article.getByLabel('Software', { exact: true }).check();
  await page.getByRole('button', { name: '保存文章', exact: true }).click(); await saved(page);
  await view(page, 'preview'); await page.getByRole('button', { name: '模拟公开地图' }).click();
  await mapNode(page, 'software'); await mapNode(page, nodeId);
  await expect(page.locator('#map-preview .context-panel')).toContainText('改名后的文章');
  await expect(page.locator('#map-preview .node.current .title')).toHaveCSS('fill', 'rgb(227, 228, 229)');
  await expect(page.locator('#map-preview').getByRole('link', { name: '打开内容 →' })).toHaveAttribute('href', '/notes/' + id + '/');
  await page.screenshot({ path: info.outputPath('workbench-map-preview.png'), fullPage: true });
  await page.reload(); await page.locator(`#articles [data-article-id="${id}"]`).click();
  await expect(article.getByLabel('标题', { exact: true })).toHaveValue('改名后的文章');
  await settings(page); await expect(article.getByLabel('Software', { exact: true })).toBeChecked(); await settings(page);
  await page.screenshot({ path: info.outputPath('workbench-editor.png'), fullPage: true });
  expect(errors).toEqual([]);
});
test('directory actions, collapsed branches and stale-version protection work across task views', async ({ page, context }) => {
  await login(page); await view(page, 'directory');
  await expect(page.locator('#tree [data-node-id="gcc"]')).toBeHidden();
  await page.getByRole('button', { name: '展开 Compilers', exact: true }).click();
  await expect(page.locator('#tree [data-node-id="gcc"]')).toBeVisible();
  await page.locator('#add-directory-panel > summary').click();
  const directory = page.locator('#add-directory-form');
  await directory.getByLabel('名称', { exact: true }).fill('新目录');
  const id = await directory.getByLabel('节点 ID', { exact: true }).inputValue();
  await directory.getByRole('button', { name: '添加到所选目录' }).click(); await saved(page);
  await expect(page.locator('#node-heading')).toHaveText('新目录');
  await page.locator('#directory-form').getByLabel('目录名称').fill('改名目录');
  await page.getByRole('button', { name: '保存目录', exact: true }).click(); await saved(page);
  await page.locator('#move-panel > summary').click();
  await page.locator('#move-form').getByLabel('目标父目录').selectOption('software');
  await page.locator('#move-form').getByRole('button', { name: '移动所选节点' }).click(); await saved(page);
  await expect(page.locator(`#tree [data-node-id="${id}"]`)).toBeVisible();
  await expect(page.locator('#node-breadcrumb')).toContainText('Software');
  const second = await context.newPage(); await second.goto('/');
  await expect(second.locator('#articles [data-article-id="hello"]')).toBeVisible();
  await view(page, 'articles'); await page.locator('#articles [data-article-id="hello"]').click();
  await page.locator('#article-form').getByLabel('标题', { exact: true }).fill('另一个页面保存的标题 ' + id);
  await page.getByRole('button', { name: '保存文章', exact: true }).click(); await saved(page);
  await second.locator('#articles [data-article-id="hello"]').click();
  await second.locator('#article-form').getByLabel('标题', { exact: true }).fill('不应该覆盖的旧版本');
  await second.getByRole('button', { name: '保存文章', exact: true }).click();
  await expect(second.locator('#message')).toContainText('另一个页面中保存');
  await expect(second.locator('#article-form').getByLabel('标题', { exact: true })).toHaveValue('不应该覆盖的旧版本');
  second.once('dialog', dialog => dialog.dismiss()); await view(second, 'directory');
  await expect(second.locator('#view-articles')).toHaveAttribute('aria-pressed', 'true');
  await expect(second.locator('#article-form').getByLabel('标题', { exact: true })).toHaveValue('不应该覆盖的旧版本'); await second.close();
  await view(page, 'directory'); await page.locator('#move-panel > summary').click();
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: '移除所选节点及子树' }).click(); await saved(page);
  await expect(page.locator(`#tree [data-node-id="${id}"]`)).toHaveCount(0);
});
test('search, filters, keyboard save and advanced defaults preserve user edits', async ({ page }) => {
  await login(page); await page.getByRole('button', { name: '新建草稿', exact: true }).click();
  const article = page.locator('#article-form');
  await article.getByLabel('标题', { exact: true }).fill('Keyboard Note');
  const id = await article.getByLabel('稳定 ID').inputValue();
  expect(id).toMatch(/^keyboard-note(?:-\d+)?$/);
  await expect(article.getByLabel('文件路径')).toHaveValue('articles/' + id + '.md');
  await article.getByLabel('Markdown 正文').fill('不应丢失的正文');
  await expect(page.locator('#save-status')).toContainText('未保存');
  await expect(page.locator('#word-count')).toContainText('字符（不含空白）');
  await page.getByLabel('搜索文章', { exact: true }).fill('不存在的关键词');
  await expect(page.locator('#article-list-empty')).toBeVisible();
  await expect(article.getByLabel('Markdown 正文')).toHaveValue('不应丢失的正文');
  await page.getByLabel('搜索文章', { exact: true }).fill('');
  await article.getByLabel('Markdown 正文').press('Control+s'); await saved(page);
  await expect(page.locator('#save-status')).toHaveText('已保存到私有工作区');
  await page.getByLabel('筛选', { exact: true }).selectOption('draft');
  await expect(page.locator(`#articles [data-article-id="${id}"]`)).toBeVisible();
  await expect(page.locator('#articles [data-article-id="hello"]')).toHaveCount(0);
  await page.getByLabel('筛选', { exact: true }).selectOption('all');
  const savedBody = await article.getByLabel('Markdown 正文').inputValue();
  await settings(page); await page.locator('#article-settings .advanced > summary').click();
  await article.getByLabel('文件路径').fill('../unsafe.md');
  await page.getByRole('button', { name: '保存文章', exact: true }).click();
  await expect(page.locator('#message')).toHaveClass(/error/);
  await expect(article.getByLabel('文件路径')).toHaveValue('../unsafe.md');
  await expect(article.getByLabel('Markdown 正文')).toHaveValue(savedBody);
  await article.getByLabel('文件路径').fill('articles/' + id + '.md');
  await page.getByRole('button', { name: '保存文章', exact: true }).click(); await saved(page);
  await page.locator('#article-danger > summary').click();
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: '删除文章', exact: true }).click(); await saved(page);
  await expect(page.locator(`#articles [data-article-id="${id}"]`)).toHaveCount(0);
});
test('responsive task views, map return and logout keep private data protected', async ({ page }, info) => {
  await login(page);
  for (const width of [1486, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`workbench-${width}.png`), fullPage: true });
  }
  await expect(page.locator('#article-library')).toBeHidden();
  await page.getByRole('button', { name: /文章列表/ }).click();
  await expect(page.getByLabel('搜索文章', { exact: true })).toBeVisible();
  await page.locator('#articles [data-article-id="hello"]').click();
  await expect(page.locator('#article-library')).toBeHidden();
  await view(page, 'directory');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('workbench-directory-mobile.png'), fullPage: true });
  await view(page, 'preview');
  await mapNode(page, 'infrastructure');
  await mapNode(page, 'cicd');
  await mapNode(page, 'hello');
  const bounds = await page.locator('#map-preview .context-panel').boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#map-preview').getByRole('link', { name: '打开内容 →' }).click();
  await expect(page.locator('#article-form').getByLabel('稳定 ID')).toHaveValue('hello');
  await page.locator('.account-menu > summary').click();
  await page.getByRole('button', { name: sshMode ? '结束当前会话' : '退出', exact: true }).click();
  await expect(page.getByRole('heading', { name: sshMode ? '当前会话已结束' : '登录工作台' })).toBeVisible();
  expect((await page.request.get('/api/workspace')).status()).toBe(401);
  expect((await page.request.get('/api/export')).status()).toBe(401);
  if (sshMode) { await page.getByRole('button', { name: '重新进入工作台', exact: true }).click(); await expect(page.getByRole('heading', { name: '内容工作区' })).toBeVisible(); }
});

test('connection failures, discarded switches and cross-form cancellation do not silently lose input', async ({ page }) => {
  await login(page);
  const article = page.locator('#article-form');
  await article.getByLabel('Markdown 正文').fill('断线时也要保留这段文字');
  await page.route('**/api/command', route => route.abort('failed'));
  await page.getByRole('button', { name: '保存文章', exact: true }).click();
  await expect(page.locator('#message')).toContainText('无法连接工作台');
  await expect(article.getByLabel('Markdown 正文')).toHaveValue('断线时也要保留这段文字');
  await expect(page.locator('#save-status')).toContainText('未保存');
  page.once('dialog', dialog => dialog.dismiss()); await view(page, 'preview');
  await expect(page.locator('#articles-view')).toBeVisible();
  await page.unroute('**/api/command');
  await article.getByLabel('Markdown 正文').press('Control+s'); await saved(page);
  await expect(article.getByLabel('Markdown 正文')).toBeFocused();
  await view(page, 'directory');
  await page.locator('#directory-form').getByLabel('目录名称').fill('尚未保存的目录名称');
  await page.locator('#add-directory-panel > summary').click();
  await page.locator('#add-directory-form').getByLabel('名称', { exact: true }).fill('不应新增的子目录');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: '添加到所选目录' }).click();
  await expect(page.locator('#directory-form').getByLabel('目录名称')).toHaveValue('尚未保存的目录名称');
  await expect(page.locator('#add-directory-form').getByLabel('名称', { exact: true })).toHaveValue('不应新增的子目录');
  await expect(page.locator('#tree')).not.toContainText('不应新增的子目录');
  await expect(page.locator('#save-status')).toContainText('未保存');
});

test('SSH mode renews an absent session once without discarding an unsaved article', async ({ page, context }) => {
  test.skip(!sshMode, 'Automatic renewal is only enabled in explicitly configured SSH mode.');
  await login(page); await expect(page.locator('#access-mode')).toHaveText('SSH 免密');
  await expect(page.locator('#login')).toBeHidden();
  const body = page.locator('#article-form').getByLabel('Markdown 正文');
  await body.fill('会话失效后，仍然保留并保存当前输入');
  await context.clearCookies();
  let commands = 0; page.on('request', request => { if (request.url().endsWith('/api/command')) commands++; });
  await body.press('Control+s'); await saved(page);
  expect(commands).toBe(2); // A rejected 401, then exactly one authenticated retry.
  await expect(body).toHaveValue(/会话失效后，仍然保留并保存当前输入/);
  await expect(body).toBeFocused();
});


test('preview motion, viewport sizing, inspector and page gutters remain usable', async ({ page }, info) => {
  await login(page); await page.emulateMedia({ reducedMotion: 'no-preference' }); await page.setViewportSize({ width: 1440, height: 840 });
  const mainLeft = () => page.locator('main').evaluate(el => el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft));
  for (const width of [1920, 1536, 1440, 1366, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 840 });
    const footerLeft = await page.locator('footer').evaluate(el => el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft));
    expect(Math.abs(footerLeft - await mainLeft())).toBeLessThan(1);
  }
  await page.setViewportSize({ width: 1440, height: 840 });
  const before = await mainLeft();
  await view(page, 'preview'); await expect(page.locator('#map-preview svg')).not.toHaveClass(/animating/);
  expect(Math.abs(await mainLeft() - before)).toBeLessThan(1);
  expect(Math.abs(await page.locator('footer').evaluate(el => el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft)) - before)).toBeLessThan(1);
  const svg = await page.locator('#map-preview svg').boundingBox();
  expect(svg!.y + svg!.height).toBeLessThanOrEqual(840);
  // Sample intermediate positions, rather than mistaking an immediate jump for animation.
  await page.evaluate(() => {
    const sample = { running: true, positions: [] as string[] };
    (window as unknown as { motionSample: typeof sample }).motionSample = sample;
    const frame = () => { sample.positions.push(document.querySelector('#map-preview [data-id="infrastructure"]')?.getAttribute('transform') ?? ''); if (sample.running) requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
  });
  await mapNode(page, 'infrastructure');
  const positions = await page.evaluate(() => { const sample = (window as unknown as { motionSample: { running: boolean; positions: string[] } }).motionSample; sample.running = false; return sample.positions; });
  expect(new Set(positions.filter(Boolean)).size).toBeGreaterThan(3);
  await page.setViewportSize({ width: 1280, height: 900 });
  const resizedWidth = await page.locator('.preview-viewport').evaluate(el => Math.max(640, Math.floor(el.clientWidth)));
  await expect(page.locator('#map-preview svg')).toHaveAttribute('viewBox', new RegExp(`^0 0 ${resizedWidth} `));
  await expect(page.locator('#map-preview svg')).not.toHaveClass(/animating/);
  await expect(page.locator('#map-preview .node.current')).toHaveAttribute('data-id', 'infrastructure');
  await mapNode(page, 'cicd'); await mapNode(page, 'hello');
  const graph = await page.locator('#map-preview svg').boundingBox();
  const panel = await page.locator('#map-preview .context-panel').boundingBox();
  expect(panel!.y).toBeGreaterThanOrEqual(graph!.y + graph!.height - 1);
  await page.screenshot({ path: info.outputPath('preview-inspector-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#map-preview svg')).toHaveAttribute('viewBox', /^0 0 640 /);
  await expect(page.locator('#map-preview svg')).not.toHaveClass(/animating/);
  await expect(page.locator('#map-preview .context-panel')).toBeVisible();
  const narrowPanel = await page.locator('#map-preview .context-panel').boundingBox();
  expect(narrowPanel!.x).toBeGreaterThanOrEqual(0); expect(narrowPanel!.x + narrowPanel!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('preview-inspector-mobile.png'), fullPage: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 840 });
  await view(page, 'articles'); await view(page, 'preview');
  await page.evaluate(() => {
    const sample = (window as unknown as { motionSample: { running: boolean; positions: string[] } }).motionSample;
    sample.positions = []; sample.running = true;
    const frame = () => { sample.positions.push(document.querySelector('#map-preview [data-id="infrastructure"]')?.getAttribute('transform') ?? ''); if (sample.running) requestAnimationFrame(frame); }; requestAnimationFrame(frame);
  });
  await mapNode(page, 'infrastructure');
  const reducedPositions = await page.evaluate(() => { const sample = (window as unknown as { motionSample: { running: boolean; positions: string[] } }).motionSample; sample.running = false; return sample.positions; });
  expect(new Set(reducedPositions.filter(Boolean)).size).toBeLessThanOrEqual(2);
  await expect(page.locator('#map-preview svg')).not.toHaveClass(/animating/);
  await expect(page.locator('#map-preview .node.current')).toHaveAttribute('data-id', 'infrastructure');
});


test('topic search preserves selected values and disclosure state without pretending to publish', async ({ page }, info) => {
  await login(page);
  const article = page.locator('#article-form');
  const id = await article.getByLabel('稳定 ID').inputValue();
  await settings(page); await page.locator('#topic-picker > summary').click();
  await article.getByLabel('搜索主题', { exact: true }).fill('Software');
  await expect(page.locator('#save-status')).toHaveText('已保存到私有工作区');
  await article.getByLabel('Software', { exact: true }).check();
  await expect(page.locator('#selected-topics')).toContainText('Software');
  await article.getByLabel('搜索主题', { exact: true }).fill('no-such-topic');
  await expect(page.locator('#topic-no-match')).toBeVisible();
  await expect(page.locator('#selected-topics')).toContainText('Software');
  await page.getByRole('button', { name: '保存文章', exact: true }).click(); await saved(page);
  await expect(page.locator('#article-settings')).toHaveAttribute('open', '');
  await expect(page.locator('#topic-picker')).toHaveAttribute('open', '');
  await expect(article.getByLabel('搜索主题', { exact: true })).toHaveValue('no-such-topic');
  await view(page, 'directory'); await view(page, 'articles');
  await expect(page.locator('#article-settings')).toHaveAttribute('open', '');
  await expect(page.locator('#topic-picker')).toHaveAttribute('open', '');
  await expect(page.locator('#selected-topics')).toContainText('Software');
  await page.getByRole('button', { name: '移除主题 Software', exact: true }).click();
  await expect(page.locator('#selected-topics')).not.toContainText('Software');
  await article.getByLabel('Markdown 正文').fill('A 中 😊\n');
  await expect(page.locator('#word-count')).toHaveText('3 字符（不含空白）');
  await expect(page.locator('#save-status')).toContainText('未保存');
  await article.getByLabel('搜索主题', { exact: true }).fill('');
  await expect(article.getByLabel('Software', { exact: true })).not.toBeChecked();
  expect(await page.locator('#topic-options').evaluate(el => getComputedStyle(el).overflowY)).toBe('visible');
  await page.locator('#article-settings .advanced > summary').click();
  await expect(article.getByLabel('稳定 ID')).toHaveCSS('border-top-style', 'dashed');
  await article.getByLabel('文件路径').fill('articles/moved/' + id + '.md');
  await expect(page.locator('#path-change-note')).toBeVisible();
  await expect(article.getByLabel('稳定 ID')).toHaveValue(id);
  await article.getByLabel('文件路径').fill('articles/' + id + '.md');
  await article.getByLabel('保留为草稿').uncheck();
  await expect(page.locator('#article-state')).toHaveText('稿件：定稿');
  await expect(page.locator('#publish-status')).toHaveText('发布通道未接通');
  await page.getByRole('button', { name: '保存文章', exact: true }).click(); await saved(page);
  await page.screenshot({ path: info.outputPath('editor-topics-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const saveStatus = await page.locator('#save-status').boundingBox();
  const navigation = await page.locator('.workspace-nav nav').boundingBox();
  expect(saveStatus!.y).toBeGreaterThanOrEqual(navigation!.y + navigation!.height);
  await page.screenshot({ path: info.outputPath('editor-topics-mobile.png'), fullPage: true });
  await page.locator('.account-menu > summary').click();
  await page.getByRole('button', { name: '重新读取已保存内容', exact: true }).click();
  await expect(page.locator('#message')).toHaveText('已重新读取私有快照。');
});


test('article filters explain empty results and the editor explains heading hierarchy', async ({ page }) => {
  await login(page); await page.getByLabel('搜索文章', { exact: true }).fill('no-matching-article');
  await expect(page.locator('#article-count')).toHaveText(/^0 \/ \d+$/);
  await expect(page.locator('#article-list-empty')).toContainText('其他关键词');
  await page.getByLabel('搜索文章', { exact: true }).fill('');
  await page.getByLabel('筛选', { exact: true }).selectOption('draft');
  await expect(page.locator('#article-list-empty')).toHaveText('当前没有草稿。可以切换为“全部文章”。');
  await expect(page.locator('#article-count')).toHaveText(/^0 \/ \d+$/);
  await page.getByLabel('筛选', { exact: true }).selectOption('all');
  await expect(page.locator('#body-heading-help')).toContainText('正文建议从 ## 二级标题开始');
  await expect(page.getByLabel('Markdown 正文')).toHaveAttribute('aria-describedby', 'body-heading-help');
});

test('empty directories lead to management instead of a nonexistent index', async ({ page }, info) => {
  await login(page);
  let writes = 0; page.on('request', request => { if (request.url().endsWith('/api/command')) writes++; });
  await view(page, 'preview'); await page.getByRole('button', { name: '完整目录（含草稿）' }).click();
  await mapNode(page, 'software');
  await expect(page.locator('#map-preview [data-id="dotnet"]')).toHaveClass(/empty-directory/);
  await expect(page.locator('#map-preview [data-id="dotnet"]')).toHaveAttribute('aria-label', /空目录/);
  await mapNode(page, 'dotnet');
  await expect(page.locator('#map-preview .context-panel')).toContainText('空目录');
  await expect(page.locator('#map-preview .context-panel')).not.toContainText('打开完整索引');
  await page.setViewportSize({ width: 1280, height: 840 });
  const width = await page.locator('.preview-viewport').evaluate(el => Math.max(640, Math.floor(el.clientWidth)));
  await expect(page.locator('#map-preview svg')).toHaveAttribute('viewBox', new RegExp(`^0 0 ${width} `));
  await expect(page.locator('#map-preview .node.current')).toHaveAttribute('data-id', 'software');
  await expect(page.getByRole('button', { name: '去管理目录添加内容', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('empty-directory.png'), fullPage: true });
  await page.getByRole('button', { name: '去管理目录添加内容', exact: true }).click();
  await expect(page.locator('#directory-view')).toBeVisible();
  await expect(page.locator('#tree [aria-current="true"]')).toHaveAttribute('data-node-id', 'dotnet');
  await expect(page.locator('#directory-form').getByLabel('目录名称')).toBeFocused();
  await page.locator('#add-directory-panel > summary').click();
  await expect(page.locator('#directory-kind-help')).toBeVisible();
  await expect(page.locator('#add-directory-form select[name="kind"]')).toHaveAttribute('aria-describedby', 'directory-kind-help');
  expect(writes).toBe(0);
});

// Do not click the panel action before checking its geometry: Playwright would
// auto-scroll it into view and hide the regression this test is intended to catch.
for (const viewport of [{ width: 1651, height: 962 }, { width: 1366, height: 720 }, { width: 390, height: 844 }]) {
  for (const reducedMotion of ['no-preference', 'reduce'] as const) {
    test(`opening an article reveals its title and action at ${viewport.width}x${viewport.height}, motion=${reducedMotion}`, async ({ page }, info) => {
      await page.setViewportSize(viewport); await page.emulateMedia({ reducedMotion }); await login(page);
      await view(page, 'preview'); await mapNode(page, 'infrastructure'); await mapNode(page, 'cicd');
      const node = page.locator('#map-preview .node[data-id="hello"]');
      await node.scrollIntoViewIfNeeded();
      const horizontal = await page.locator('.preview-viewport').evaluate(el => el.scrollLeft);
      await page.evaluate(() => {
        const original = window.scrollBy.bind(window);
        const calls: ScrollToOptions[] = [];
        (window as unknown as { revealScrolls: ScrollToOptions[] }).revealScrolls = calls;
        window.scrollBy = ((options: ScrollToOptions) => { calls.push(options); original(options); }) as typeof window.scrollBy;
      });
      await node.click();
      const panel = page.locator('#map-preview .context-panel');
      await expect(panel.locator('h3')).toBeInViewport({ ratio: 1 });
      await expect(panel.locator('.panel-open')).toBeInViewport({ ratio: 1 });
      await expect.poll(() => page.evaluate(() => (window as unknown as { revealScrolls: ScrollToOptions[] }).revealScrolls.length)).toBe(1);
      const calls = await page.evaluate(() => (window as unknown as { revealScrolls: ScrollToOptions[] }).revealScrolls);
      expect(calls[0].behavior).toBe(reducedMotion === 'reduce' ? 'instant' : 'smooth');
      expect(calls[0].top).toBeGreaterThan(0); expect(calls[0].left).toBe(0);
      expect(await page.locator('.preview-viewport').evaluate(el => el.scrollLeft)).toBe(horizontal);
      expect(await panel.evaluate(el => el.contains(document.activeElement))).toBe(false);
      // Read both rectangles in the same frame while smooth scrolling may still be running.
      expect(await panel.evaluate(el => el.getBoundingClientRect().top - document.querySelector('#map-preview svg')!.getBoundingClientRect().bottom)).toBeGreaterThanOrEqual(-1);
      await expect.poll(() => panel.evaluate(el => el.getBoundingClientRect().bottom)).toBeLessThanOrEqual(viewport.height - 15);
      if (viewport.width === 1651 && reducedMotion === 'no-preference') await page.screenshot({ path: info.outputPath('revealed-inspector.png') });
      // Restore/repaint is not a new user selection, even though the renderer opens a panel.
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await page.setViewportSize({ width: viewport.width - 10, height: viewport.height });
      const width = await page.locator('.preview-viewport').evaluate(el => Math.max(640, Math.floor(el.clientWidth)));
      await expect(page.locator('#map-preview svg')).toHaveAttribute('viewBox', new RegExp(`^0 0 ${width} `));
      await expect(page.locator('#map-preview svg')).not.toHaveClass(/animating/);
      await expect(panel).toBeVisible();
      expect(await page.evaluate(() => (window as unknown as { revealScrolls: ScrollToOptions[] }).revealScrolls.length)).toBe(1);
    });
  }
}

test('empty-directory reveal is not repeated by selection restoration or already-visible clicks', async ({ page }) => {
  await page.setViewportSize({ width: 1651, height: 962 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  await login(page); await view(page, 'preview'); await page.getByRole('button', { name: '完整目录（含草稿）' }).click();
  await mapNode(page, 'software'); await mapNode(page, 'dotnet');
  const panel = page.locator('#map-preview .context-panel');
  await expect(panel.locator('h3')).toBeInViewport({ ratio: 1 });
  await expect(panel.getByRole('button', { name: '去管理目录添加内容', exact: true })).toBeInViewport({ ratio: 1 });
  await page.evaluate(() => {
    const original = window.scrollBy.bind(window); const calls: ScrollToOptions[] = [];
    (window as unknown as { revealScrolls: ScrollToOptions[] }).revealScrolls = calls;
    window.scrollBy = ((options: ScrollToOptions) => { calls.push(options); original(options); }) as typeof window.scrollBy;
  });
  await mapNode(page, 'dotnet'); // Same visible inspector: no unnecessary scroll.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => (window as unknown as { revealScrolls: ScrollToOptions[] }).revealScrolls)).toEqual([]);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.setViewportSize({ width: 1600, height: 962 });
  await expect(panel).toContainText('空目录');
  await expect(page.locator('#map-preview svg')).not.toHaveClass(/animating/);
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { revealScrolls: ScrollToOptions[] }).revealScrolls)).toEqual([]);
});

test('publication review explains missing configuration without offering a fake publish action', async ({ page }) => {
  await login(page);
  await page.route('**/api/publication', route => route.fulfill({ json: { configured: false, canPublish: false, remoteChecked: false } }));
  await page.locator('#view-publication').click();
  await expect(page.locator('#publication-configuration')).toContainText('尚未配置');
  await expect(page.locator('#review-publication')).toBeDisabled();
  await expect(page.locator('#publication-result')).toBeHidden();
  await expect(page.locator('#publish-status')).toHaveText('发布通道未接通');
});
test('configured publication review shows saved differences and draft scope without posting content', async ({ page }) => {
  test.skip(process.env.WORKBENCH_TEST_REVIEW !== '1', 'Requires the temporary read-only Git fixture.');
  await login(page); await createDraft(page, '核对草稿 <img src=x>');
  let commands=0; page.on('request', request => { if (request.url().endsWith('/api/command') || request.url().endsWith('/api/publish')) commands++; });
  await page.locator('#view-publication').click(); await expect(page.locator('#review-publication')).toBeEnabled();
  const response=page.waitForResponse(response=>response.url().endsWith('/api/publication/plan'));
  await page.locator('#review-publication').click();
  expect((await (await response).json()).snapshot).toBeUndefined();
  await expect(page.locator('#publication-result')).toBeVisible();
  await expect(page.locator('#publication-summary')).toContainText('仅核对，未发布');
  await expect(page.locator('#publication-disclosure')).toContainText('仅私有 Git · 草稿 核对草稿 <img src=x>');
  await expect(page.locator('#publication-result img')).toHaveCount(0);
  expect(commands).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.locator('#view-articles').click(); await page.locator('#view-publication').click();
  await expect(page.locator('#publication-result')).toBeHidden();
});

test('isolated reviewer explains disabled publishing and reports baseline migration blockers', async ({ page }) => {
  await login(page);
  await page.route('**/api/publication', route => route.fulfill({ json: { configured: true, canPublish: false, transport: 'isolated-worker', remoteChecked: false } }));
  await page.route('**/api/publication/plan', route => route.fulfill({ status: 409, json: { error: '远端内容基线缺少 topology.json，尚未完成内容格式迁移；未提交或推送。' } }));
  let writes = 0; page.on('request', request => { if (/\/api\/(command|publish)$/.test(request.url())) writes++; });
  await page.locator('#view-publication').click();
  await expect(page.locator('#publication-configuration')).toContainText('已配置独立执行器');
  await expect(page.locator('#publication-view')).toContainText('当前未开放真实推送');
  await page.locator('#review-publication').click();
  await expect(page.getByText('远端内容基线缺少 topology.json，尚未完成内容格式迁移；未提交或推送。', { exact: true })).toBeVisible();
  await expect(page.locator('#publication-result')).toBeHidden();
  expect(writes).toBe(0);
});

const publishFixture = process.env.WORKBENCH_TEST_PUBLISH === '1';
async function reviewForConfirmation(page: Page) {
  await page.locator('#view-publication').click();
  await expect(page.locator('#review-publication')).toBeEnabled();
  await page.locator('#review-publication').click();
  await expect(page.locator('#publication-confirmation')).toBeVisible();
  await expect(page.locator('#confirm-publication')).toBeDisabled();
}
test('explicit confirmation includes drafts, can be cancelled, survives reload, and handles no-op without claiming deployment', async ({ page }) => {
  test.skip(!publishFixture, 'Requires a disposable local bare remote, never production.');
  await login(page); await createDraft(page, '确认流程草稿');
  let confirms = 0; page.on('request', request => { if (request.url().endsWith('/api/publication/confirm')) confirms++; });
  await reviewForConfirmation(page); await expect(page.locator('#publication-disclosure')).toContainText('仅私有 Git · 草稿 确认流程草稿');
  await page.locator('#cancel-publication').click(); await expect(page.locator('#publication-result')).toBeHidden(); expect(confirms).toBe(0);
  await page.locator('#review-publication').click(); await expect(page.locator('#publication-confirmation')).toBeVisible();
  await page.locator('#publication-acknowledge').check(); await expect(page.locator('#confirm-publication')).toBeEnabled();
  await page.locator('#confirm-publication').click();
  await expect(page.locator('#publication-job-status')).toContainText('已推送 Git，网站部署尚未核验');
  await expect(page.locator('#publication-job-status')).toContainText('基线已更新');
  await expect(page.locator('#refresh-publication')).toBeEnabled(); expect(confirms).toBe(1);
  await page.reload(); await page.locator('#view-publication').click(); await expect(page.locator('#publication-job-status')).toContainText('已推送 Git');
  await page.locator('#refresh-publication').click(); expect(confirms).toBe(1);
  await page.locator('#review-publication').click(); await expect(page.locator('#publication-summary')).toContainText('没有差异');
  await page.locator('#publication-acknowledge').check(); await page.locator('#confirm-publication').click();
  await expect(page.locator('#publication-job-status')).toContainText('没有差异，未创建新提交');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('a save in another page after review invalidates confirmation without silently publishing it', async ({ page, context }) => {
  test.skip(!publishFixture, 'Requires disposable publisher.');
  await login(page); await reviewForConfirmation(page);
  const other = await context.newPage(); await login(other);
  await other.locator('#article-form').getByLabel('标题', { exact: true }).fill('另一个页面的新标题');
  await other.getByRole('button', { name: '保存文章', exact: true }).click(); await saved(other);
  const response = page.waitForResponse(response => response.url().endsWith('/api/publication/confirm'));
  await page.locator('#publication-acknowledge').check(); await page.locator('#confirm-publication').click();
  expect((await response).status()).toBe(409); await expect(page.locator('#message')).toContainText('已变化');
  await expect(page.locator('#publication-confirmation')).toBeHidden(); await other.close();
});
test('typing while confirmation response is in flight survives baseline advancement and can still be saved', async ({ page }) => {
  test.skip(!publishFixture, 'Requires disposable publisher.');
  await login(page); await reviewForConfirmation(page);
  let release!: () => void; const held = new Promise<void>(resolve => release = resolve);
  let accepted!: () => void; const completed = new Promise<void>(resolve => accepted = resolve);
  await page.route('**/api/publication/confirm', async route => { const response = await route.fetch(); accepted(); await held; await route.fulfill({ response }); });
  await page.locator('#publication-acknowledge').check(); await page.locator('#confirm-publication').click(); await completed;
  await page.locator('#view-articles').click();
  const body = page.locator('#article-form').getByLabel('Markdown 正文'); const next = (await body.inputValue()) + '\n\n发布期间继续写的新内容\n';
  await body.fill(next); release();
  await expect(page.locator('#refresh-publication')).toBeEnabled(); await expect(body).toHaveValue(next);
  await expect(page.locator('#save-status')).toContainText('未保存');
  await page.getByRole('button', { name: '保存文章', exact: true }).click(); await saved(page); await expect(body).toHaveValue(next);
});
test('lost browser response recovers using status queries rather than repeating confirmation', async ({ page }) => {
  test.skip(!publishFixture, 'Requires disposable publisher.');
  await login(page); await reviewForConfirmation(page); let confirms = 0;
  await page.route('**/api/publication/confirm', async route => { confirms++; await route.fetch(); await route.abort('failed'); });
  await page.locator('#publication-acknowledge').check(); await page.locator('#confirm-publication').click();
  await expect(page.locator('#message')).toContainText('执行结果待查询'); await expect(page.locator('#publication-confirmation')).toBeHidden();
  await page.locator('#refresh-publication').click(); await expect(page.locator('#publication-job-status')).toContainText('已推送 Git'); expect(confirms).toBe(1);
  await page.locator('#review-publication').click(); await expect(page.locator('#publication-summary')).toContainText('没有差异');
});

test('deployment query separates live production from older evidence without triggering writes', async ({ page }) => {
  await login(page);
  const commit='a'.repeat(40), job={id:'12345678-1234-4123-8123-123456789012',planId:'b'.repeat(64),expiresAt:'2030-01-01T00:00:00.000Z',phase:'pushed',commit,revision:'c'.repeat(64),baseRevision:'d'.repeat(64),candidateDigest:'e'.repeat(64),baseCommit:'f'.repeat(40),publishEnabled:false,deployed:false};
  await page.route('**/api/publication',route=>route.fulfill({json:{configured:true,canPublish:false,transport:'isolated-worker'}}));
  await page.route('**/api/publication/job',route=>route.fulfill({json:{progress:{version:1,job,baseline:'advanced'}}}));
  let queries=0,writes=0;
  page.on('request',request=>{if(['/api/command','/api/publication/confirm','/api/publication/reconcile'].some(path=>request.url().endsWith(path)))writes++;});
  const deployment={id:'a2e67767-f1cc-454c-a9a9-8c419b20e2ad',url:'https://dash.cloudflare.com/?to=%2F'+'f'.repeat(32)+'%2Fpages%2Fview%2Fsite%2Fa2e67767-f1cc-454c-a9a9-8c419b20e2ad'};
  const reports=[
    {state:'deployment-succeeded',productionVerified:false,run:{id:123,attempt:2,blogCommit:'b'.repeat(40)},site:{commit:'d'.repeat(40),current:false,topologyCommit:'e'.repeat(40)},deployment},
    {state:'unavailable',productionVerified:false,run:null,site:null,deployment:null},
    {state:'live',productionVerified:true,run:{id:124,attempt:1,blogCommit:'b'.repeat(40)},site:{commit:'d'.repeat(40),current:true,topologyCommit:'e'.repeat(40)},deployment},
  ];
  await page.route('**/api/publication/deployment',route=>{expect(route.request().postDataJSON()).toEqual({});return route.fulfill({json:{report:{contentCommit:commit,checkedAt:'2026-09-29T09:00:00.000Z',...reports[queries++]}}});});
  await page.locator('#view-publication').click();await expect(page.locator('#refresh-deployment')).toBeVisible();
  await page.locator('#refresh-deployment').click();await expect(page.locator('#deployment-status')).toContainText('已不是它');await expect(page.locator('#deployment-status')).toContainText('历史 site');
  await expect(page.locator('#deployment-detail')).toContainText('不代表当前编辑内容');await expect(page.locator('#deployment-links a')).toHaveCount(3);
  await expect(page.locator('#deployment-links a').last()).toHaveAttribute('href',deployment.url);
  await expect(page.locator('#publish-status')).not.toContainText('已上线');await expect(page.locator('#refresh-deployment')).toBeEnabled();
  await page.locator('#refresh-deployment').click();await expect(page.locator('#deployment-status')).toContainText('查询暂不可用');await expect(page.locator('#deployment-links a')).toHaveCount(0);
  await page.locator('#refresh-deployment').click();await expect(page.locator('#deployment-status')).toContainText('已上线');await expect(page.locator('#deployment-status')).not.toContainText('历史 site');
  await expect(page.locator('#publish-status')).not.toContainText('已上线');
  expect(queries).toBe(3);expect(writes).toBe(0);
});

test('article language is chosen in settings, round-trips through save and reload, and shows in the list', async ({ page }) => {
  await login(page);
  await view(page, 'articles');
  const language = page.locator('#article-form').getByLabel('文章语言');
  const open = async (id: string) => {
    await page.locator(`#articles [data-article-id="${id}"]`).click();
    if (await page.locator('#article-settings').getAttribute('open') === null) await settings(page);
  };
  await open('hello');
  await expect(language).toHaveValue('en');
  await expect(page.locator('#articles [data-article-id="hello"] .article-meta')).toContainText('English');
  await open('publishing-pipeline');
  await expect(language).toHaveValue('zh-CN');
  await language.selectOption('en');
  await page.getByRole('button', { name: '保存文章', exact: true }).click(); await saved(page);
  await expect(page.locator('#articles [data-article-id="publishing-pipeline"] .article-meta')).toContainText('English');
  await page.reload(); await expect(page.getByRole('heading', { name: '内容工作区' })).toBeVisible();
  await view(page, 'articles'); await open('publishing-pipeline');
  await expect(language).toHaveValue('en');
  await language.selectOption('zh-CN');
  await page.getByRole('button', { name: '保存文章', exact: true }).click(); await saved(page);
  await expect(page.locator('#articles [data-article-id="publishing-pipeline"] .article-meta')).not.toContainText('English');
});
