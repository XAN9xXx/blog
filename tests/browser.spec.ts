import { test, expect } from '@playwright/test';

test('published map opens real article; theme and deep links survive host integration', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const map = page.locator('#map');
  await expect(map.locator('.xan9x-topology')).toHaveCount(1);
  await expect(map.locator('g.node')).toHaveCount(6);
  await expect(map.locator('path.relation')).not.toHaveCount(0);
  await page.screenshot({ path: info.outputPath('blog-root.png'), animations: 'disabled' });
  await map.locator('[data-id="infrastructure"]').click();
  await map.locator('[data-id="cicd"]').click();
  await map.locator('[data-id="hello"]').click();
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
  await expect(map.locator('.node.current .title')).toHaveCSS('fill', 'rgb(238, 234, 224)');
});
