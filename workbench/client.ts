import { deploymentMessage, type DeploymentReport } from './deployment-state';
import { mountTopology, type TopologyInstance, type TopologyNode } from '@xan9x/topology';
import type { TopologyDocument } from '@xan9x/topology/schema';
import '@xan9x/topology/style.css';
import './style.css';
import type { Workspace, Command } from './model';
import type { PublicationProgress } from './publication-state';
import type { PublicationReviewSummary } from './publication-review';
import { uniqueId, matchesArticle, previewSize, articleListSummary, panelScrollOffset, localDate } from './ui-helpers';

interface Article { id: string; path: string; body: string; data: { id: string; title: string; description: string; pubDate: string; draft: boolean; topics: string[]; lang?: 'zh-CN' | 'en' } }
interface State { revision: string; sourceChanged: boolean; workspace: Workspace; articles: Article[] }
type View = 'articles' | 'directory' | 'preview' | 'publication';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const form = (id: string) => $<HTMLFormElement>(id);
const field = (id: string, name: string) => form(id).elements.namedItem(name) as HTMLInputElement;
const select = (id: string, name: string) => form(id).elements.namedItem(name) as HTMLSelectElement;
let publicationConfigured = false;
let publicationCanPublish = false;
let publicationInFlight = false;
let deploymentInFlight = false;
let displayedPublication: PublicationProgress | null = null;
let reviewedPlan: PublicationReviewSummary | undefined;
let authMode: 'password' | 'ssh' = 'password';
let csrf = ''; let state: State; let selectedNode = ''; let selectedArticle: string | undefined;
let creating = false; let pending = false; let view: View = 'articles';
let map: TopologyInstance | undefined;
let mapDocument: TopologyDocument | undefined;
let mapWidth = 0; let mapHeight = 0; let mapMode: 'editing' | 'public' = 'public';
let articleSeed = ''; let autoArticleId = ''; let autoArticlePath = ''; let autoDirectoryId = ''; let directorySeed = '';
const dirtyForms = new Set<string>();
const expandedNodes = new Set<string>();
let messageTimer: ReturnType<typeof setTimeout> | undefined;
function updateStatus() {
  $('save-status').textContent = pending ? '处理中…' : dirtyForms.size ? '有未保存修改' : '已保存到私有工作区';
  $('save-status').classList.toggle('unsaved', dirtyForms.size > 0);
  if (state) updateArticleSummary();
}
function clearDirty() { dirtyForms.clear(); updateStatus(); }
function message(text: string, error = false) {
  clearTimeout(messageTimer);
  $('message').textContent = text; $('message').hidden = !text;
  $('message').classList.toggle('error', error); $('message').setAttribute('role', error ? 'alert' : 'status');
  if (!error && text) messageTimer = setTimeout(() => { $('message').hidden = true; }, 6000);
}
class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function api<T>(url: string, value?: unknown, renewSession = true): Promise<T> {
  const response = await fetch(url, { method: value === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: value === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: value === undefined ? undefined : JSON.stringify(value) }).catch(() => { throw new Error('无法连接工作台。请检查 SSH 隧道或网络，然后重试；当前输入仍然保留。'); });
  // Only a definite 401 is safe to retry: no command was accepted. Never retry an uncertain network failure.
  if (response.status === 401 && authMode === 'ssh' && renewSession && url !== '/api/session') {
    const session = await api<{ csrf: string }>('/api/session', undefined, false); csrf = session.csrf;
    return api<T>(url, value, false);
  }
  const result = await response.json();
  if (!response.ok) throw new ApiError(result.error ?? '请求失败。', response.status); return result;
}
async function action(run: () => Promise<void>) {
  if (pending) return;
  pending = true; document.body.setAttribute('aria-busy', 'true'); updateStatus();
  // Keep the existing in-flight editing lock: a save response must never overwrite new typing.
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const controls = [...document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('button,input,select,textarea')];
  const disabled = controls.map(control => control.disabled); controls.forEach(control => control.disabled = true);
  try { await run(); }
  catch (error) { message(error instanceof ApiError && error.status === 401 && state ? '登录已过期。请先复制未保存的内容，再刷新页面重新登录；当前输入仍然保留。' : error instanceof Error ? error.message : '操作失败，当前输入仍然保留。', true); }
  finally {
    controls.forEach((control, i) => control.disabled = disabled[i]!); pending = false; document.body.removeAttribute('aria-busy');
    if (state) ($('bind-form').querySelector('button[type=submit]') as HTMLButtonElement).disabled = !state.articles.length;
    $<HTMLButtonElement>('review-publication').disabled = !publicationConfigured || publicationInFlight;
    updatePublicationConfirmation();
    updateStatus();
    if (focused?.isConnected && focused.getClientRects().length) focused.focus({ preventScroll: true });
  }
}
function flat(node = state.workspace.topology.document.root, parent?: TopologyNode): { node: TopologyNode; parent?: TopologyNode }[] {
  return [{ node, parent }, ...(node.children ?? []).flatMap(child => flat(child, node))];
}
function trail(id: string): string[] {
  const entries = flat(); const names: string[] = []; let entry = entries.find(e => e.node.id === id);
  while (entry) { names.unshift(entry.node.label); entry = entry.parent ? entries.find(e => e.node.id === entry!.parent!.id) : undefined; }
  return names;
}
function expandAncestors(id: string) {
  const entries = flat(); let entry = entries.find(e => e.node.id === id);
  while (entry?.parent) { expandedNodes.add(entry.parent.id); entry = entries.find(e => e.node.id === entry!.parent!.id); }
}
function discard() { return !dirtyForms.size || window.confirm('有尚未保存的修改。确定放弃这些修改并切换吗？'); }
function selectOptions(target: HTMLSelectElement, options: { value: string; text: string }[], value?: string) {
  target.replaceChildren(...options.map(item => new Option(item.text, item.value))); if (value !== undefined) target.value = value;
}
function articleLabel(id: string) { const a = state.articles.find(a => a.id === id); return a ? `${a.data.title}${a.data.draft ? ' · 草稿' : ''}` : id; }
function setView(next: View) {
  view = next;
  for (const name of ['articles', 'directory', 'preview', 'publication'] as const) { $(name + '-view').hidden = name !== next; $('view-' + name).setAttribute('aria-pressed', String(name === next)); }
}
function updateArticleList() {
  const query = $<HTMLInputElement>('article-search').value;
  const filter = $<HTMLSelectElement>('article-filter').value;
  const articles = state.articles.filter(a => matchesArticle(a, query, filter));
  const summary = articleListSummary(state.articles.length, articles.length, query, filter);
  $('article-count').textContent = summary.count;
  $('mobile-article-count').textContent = summary.count;
  $('article-list-empty').textContent = summary.empty;
  $('article-list-empty').hidden = articles.length > 0;
  $('articles').replaceChildren(...articles.map(a => {
    const li = document.createElement('li'); const button = document.createElement('button');
    button.type = 'button'; button.dataset.articleId = a.id; button.setAttribute('aria-current', String(a.id === selectedArticle && !creating));
    const title = document.createElement('span'); title.className = 'article-name'; title.textContent = a.data.title;
    const meta = document.createElement('span'); meta.className = 'article-meta'; meta.textContent = `${a.data.draft ? '草稿' : '定稿'} · ${a.data.pubDate.slice(0, 10)}${a.data.lang === 'en' ? ' · English' : ''}`;
    button.append(title, meta); button.addEventListener('click', () => { if (!discard()) return; clearDirty(); showArticle(a.id); toggleLibrary(false); });
    li.append(button); return li;
  }));
}
function bodyMode(preview: boolean) {
  $('body-editor').hidden = preview; $('body-preview').hidden = !preview;
  $('write-body').setAttribute('aria-pressed', String(!preview)); $('preview-body').setAttribute('aria-pressed', String(preview));
}
function updateArticleSummary() {
  const body = field('article-form', 'body').value;
  $('word-count').textContent = `${Array.from(body.replace(/\s/g, '')).length.toLocaleString()} 字符（不含空白）`;
  $('article-state').textContent = '稿件：' + (field('article-form', 'draft').checked ? '草稿' : '定稿');
  $('path-change-note').hidden = creating || field('article-form', 'path').value === state.articles.find(a => a.id === selectedArticle)?.path;
  $('settings-summary').textContent = `${field('article-form', 'draft').checked ? '草稿' : '定稿'} · ${field('article-form', 'topics').value.split(',').filter(s => s.trim()).length} 个主题`;
}
function showArticle(id?: string, fresh = false) {
  const a = state.articles.find(a => a.id === id);
  const sameArticle = selectedArticle === a?.id && creating === fresh;
  creating = fresh; selectedArticle = a?.id;
  const empty = !a && !fresh;
  $('article-empty').hidden = !empty; $('article-editor').hidden = empty;
  $<HTMLFieldSetElement>('article-fields').disabled = empty;
  if (empty) { form('article-form').reset(); updateArticleList(); return; }
  articleSeed = 'note-' + crypto.randomUUID().slice(0, 8);
  const data = a?.data ?? { id: uniqueId('', state.articles.map(a => a.id), articleSeed), title: '', description: '', pubDate: localDate(), draft: true, topics: [] };
  for (const name of ['id', 'title', 'description'] as const) field('article-form', name).value = data[name];
  field('article-form', 'id').readOnly = !fresh;
  field('article-form', 'path').value = a?.path ?? 'articles/' + data.id + '.md';
  autoArticleId = data.id; autoArticlePath = field('article-form', 'path').value;
  field('article-form', 'pubDate').value = data.pubDate.slice(0, 10);
  field('article-form', 'draft').checked = data.draft;
  field('article-form', 'lang').value = data.lang ?? 'zh-CN';
  field('article-form', 'topics').value = data.topics.join(', ');
  field('article-form', 'body').value = a?.body ?? '';
  $('topic-options').replaceChildren(...flat().filter(e => ['topic', 'index'].includes(e.node.type)).map(e => {
    const label = document.createElement('label'); label.className = 'checkbox';
    const input = document.createElement('input'); input.type = 'checkbox'; input.value = e.node.id; input.checked = data.topics.includes(e.node.id); input.dataset.topicId = e.node.id;
    const name = trail(e.node.id).slice(1).join(' / '); label.dataset.topicName = name;
    label.append(input, document.createTextNode(name));
    input.addEventListener('input', updateTopics);
    return label;
  }));
  $('article-danger').hidden = fresh; $('manage-entry').hidden = fresh;
  const refs = Object.entries(state.workspace.topology.articleRefs).filter(([, article]) => article === id).map(([node]) => trail(node).slice(0, -1).join(' / '));
  $('article-refs').textContent = fresh ? '先保存草稿，再为它安排地图入口。' : refs.length ? '地图入口：' + refs.join('；') : '还没有地图入口，读者暂时无法从地图找到这篇文章。';
  if (!sameArticle) {
    $<HTMLDetailsElement>('article-settings').open = false;
    for (const details of $('article-settings').querySelectorAll('details')) details.open = false;
    $<HTMLDetailsElement>('article-danger').open = false;
    $<HTMLInputElement>('topic-search').value = '';
  }
  renderSelectedTopics(); filterTopics();
  bodyMode(false); updateArticleSummary(); updateArticleList();
}
function renderSelectedTopics() {
  const checked = [...$('topic-options').querySelectorAll<HTMLInputElement>('input:checked')];
  $('topic-selected-empty').hidden = checked.length > 0;
  $('selected-topics').replaceChildren(...checked.map(input => {
    const name = input.parentElement!.dataset.topicName!;
    const li = document.createElement('li'); const button = document.createElement('button');
    button.type = 'button'; button.className = 'topic-chip'; button.textContent = name + ' ×';
    button.setAttribute('aria-label', '移除主题 ' + name);
    button.addEventListener('click', () => {
      input.checked = false; updateTopics();
      field('article-form', 'topics').dispatchEvent(new Event('input', { bubbles: true }));
      ($('selected-topics').querySelector<HTMLButtonElement>('button') ?? $('topic-picker').querySelector<HTMLElement>('summary'))?.focus({ preventScroll: true });
    });
    li.append(button); return li;
  }));
}
function updateTopics() {
  field('article-form', 'topics').value = [...$('topic-options').querySelectorAll<HTMLInputElement>('input:checked')].map(input => input.value).join(', ');
  renderSelectedTopics();
}
function filterTopics() {
  const words = $<HTMLInputElement>('topic-search').value.trim().toLocaleLowerCase().split(/\s+/);
  const labels = [...$('topic-options').querySelectorAll<HTMLLabelElement>('label')];
  for (const label of labels) label.hidden = !words.every(word => label.dataset.topicName!.toLocaleLowerCase().includes(word));
  $('topic-no-match').hidden = labels.some(label => !label.hidden);
}
$('topic-search').addEventListener('input', filterTopics);
function showNode() {
  const found = flat().find(e => e.node.id === selectedNode) ?? flat()[0]!;
  selectedNode = found.node.id; const node = found.node; const article = node.type === 'article';
  $('node-heading').textContent = article ? articleLabel(state.workspace.topology.articleRefs[node.id]!) : node.label;
  $('node-breadcrumb').textContent = trail(node.id).slice(0, -1).join(' / ') || '地图根目录';
  $('selected-node').textContent = `${article ? '文章入口' : node.type === 'root' ? '根目录' : '目录'} · ${node.id}`;
  $('directory-form').hidden = article; $('rebind-form').hidden = !article;
  field('directory-form', 'label').value = node.label; field('directory-form', 'description').value = node.description ?? '';
  const articles = state.articles.map(a => ({ value: a.id, text: articleLabel(a.id) }));
  selectOptions(select('bind-form', 'articleId'), articles, selectedArticle ?? articles[0]?.value);
  selectOptions(select('rebind-form', 'articleId'), articles, state.workspace.topology.articleRefs[node.id]);
  const descendants = new Set(flat(node).map(e => e.node.id));
  selectOptions(select('move-form', 'parentId'), flat().filter(e => !descendants.has(e.node.id) && ['root', 'topic', 'index'].includes(e.node.type)).map(e => ({ value: e.node.id, text: trail(e.node.id).join(' / ') })), found.parent?.id);
  field('move-form', 'position').value = String((found.parent?.children?.findIndex(n => n.id === node.id) ?? 0) + 1);
  $('move-panel').hidden = !found.parent;
  $('add-directory-panel').hidden = article; $('bind-panel').hidden = article;
  for (const id of ['add-directory-panel', 'bind-panel', 'move-panel']) $<HTMLDetailsElement>(id).open = false;
  form('add-directory-form').reset(); directorySeed = 'directory-' + crypto.randomUUID().slice(0, 8);
  autoDirectoryId = uniqueId('', flat().map(e => e.node.id), directorySeed); field('add-directory-form', 'id').value = autoDirectoryId;
  updateBindingId(); $('bind-empty').hidden = state.articles.length > 0;
  (form('bind-form').querySelector('button[type=submit]') as HTMLButtonElement).disabled = !state.articles.length;
}
function updateBindingId() { field('bind-form', 'nodeId').value = uniqueId(select('bind-form', 'articleId').value + '-link', flat().map(e => e.node.id), 'article-link'); }
function renderTree() {
  const tree = (node: TopologyNode): HTMLLIElement => {
    const li = document.createElement('li'); const row = document.createElement('div'); row.className = 'tree-row';
    const button = document.createElement('button'); button.className = 'node-button'; button.type = 'button';
    button.textContent = node.type === 'article' ? articleLabel(state.workspace.topology.articleRefs[node.id]!) : node.label;
    button.dataset.nodeId = node.id; button.setAttribute('aria-current', String(node.id === selectedNode));
    button.addEventListener('click', () => {
      if (!discard()) return; clearDirty(); selectedNode = node.id;
      // Reset abandoned article inputs too, even though that view is currently hidden.
      showArticle(selectedArticle, creating); showNode(); renderTree();
      $('tree').querySelector<HTMLButtonElement>(`[data-node-id="${CSS.escape(node.id)}"]`)?.focus({ preventScroll: true });
    });
    if (node.children?.length) {
      const children = document.createElement('ul'); children.append(...node.children.map(tree)); children.hidden = !expandedNodes.has(node.id);
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.dataset.toggleId = node.id; toggle.className = 'tree-toggle';
      toggle.setAttribute('aria-expanded', String(!children.hidden)); toggle.setAttribute('aria-label', `${children.hidden ? '展开' : '收起'} ${node.label}`); toggle.textContent = children.hidden ? '展开' : '收起';
      toggle.addEventListener('click', () => { if (expandedNodes.has(node.id)) expandedNodes.delete(node.id); else expandedNodes.add(node.id); renderTree(); $('tree').querySelector<HTMLButtonElement>(`[data-toggle-id="${CSS.escape(node.id)}"]`)?.focus({ preventScroll: true }); });
      row.append(toggle, button); li.append(row, children);
    } else { row.append(button); li.append(row); }
    return li;
  };
  const list = document.createElement('ul'); list.append(tree(state.workspace.topology.document.root)); $('tree').replaceChildren(list);
}
function render() {
  clearPublicationReview();
  $('connecting').hidden = true; $('session-closed').hidden = true; $('login').hidden = true; $('main').hidden = false; $('account').hidden = false;
  $('access-mode').textContent = authMode === 'ssh' ? 'SSH 免密' : '私有';
  $('logout').textContent = authMode === 'ssh' ? '结束当前会话' : '退出';
  $('revision').textContent = '私有版本 ' + state.revision.slice(0, 10);
  $('source-warning').hidden = !state.sourceChanged;
  if (!selectedArticle && !creating) selectedArticle = state.articles[0]?.id;
  showNode(); expandAncestors(selectedNode); renderTree(); showArticle(selectedArticle, creating); setView(view); updateStatus();
}
async function save(command: Command) {
  const owner: Record<Command['type'], string> = { saveArticle: 'article-form', deleteArticle: 'article-form', addDirectory: 'add-directory-form', editDirectory: 'directory-form', moveNode: 'move-form', removeNode: '', bindArticle: 'bind-form', rebindArticle: 'rebind-form' };
  if ([...dirtyForms].some(id => id !== owner[command.type]) && !confirm('其他表单还有未保存修改。继续此操作会放弃那些修改，是否继续？')) return;
  const parent = flat().find(e => e.node.id === selectedNode)?.parent?.id;
  state = await api<State>('/api/command', { revision: state.revision, command }); clearDirty();
  if (command.type === 'saveArticle') { selectedArticle = command.data.id as string; creating = false; }
  if (command.type === 'deleteArticle') selectedArticle = undefined;
  if (command.type === 'addDirectory') selectedNode = command.id;
  if (command.type === 'bindArticle') selectedNode = command.nodeId;
  if (command.type === 'removeNode') selectedNode = parent ?? state.workspace.topology.document.root.id;
  map?.destroy(); map = undefined; mapDocument = undefined;
  $('preview-caption').textContent = '内容已保存，下次打开预览时将使用新版本。'; render(); message('已保存到私有工作区，未发布。');
}
function toggleLibrary(open: boolean) { $('article-library').classList.toggle('is-open', open); $('toggle-library').setAttribute('aria-expanded', String(open)); }
function newArticle() {
  if (!discard()) return; clearDirty(); setView('articles'); showArticle(undefined, true); toggleLibrary(false);
  // Even a blank newly-created draft needs a navigation guard.
  dirtyForms.add('article-form'); updateStatus(); field('article-form', 'title').focus();
}
for (const id of ['article-form', 'directory-form', 'rebind-form', 'add-directory-form', 'bind-form', 'move-form']) {
  form(id).addEventListener('input', event => { if ((event.target as HTMLElement).id === 'topic-search') return; dirtyForms.add(id); updateStatus(); if (id === 'article-form') updateArticleSummary(); });
  form(id).addEventListener('invalid', event => { let parent = (event.target as HTMLElement).parentElement; while (parent) { if (parent instanceof HTMLDetailsElement) parent.open = true; parent = parent.parentElement; } }, true);
}
window.addEventListener('beforeunload', event => { if (dirtyForms.size) event.preventDefault(); });
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && state && view === 'articles' && (selectedArticle || creating)) { event.preventDefault(); if (!pending) form('article-form').requestSubmit(); } });
form('login-form').addEventListener('submit', event => { event.preventDefault(); const password = field('login-form', 'password').value;
  void action(async () => { const session = await api<{ csrf: string }>('/api/login', { password }); csrf = session.csrf;
    field('login-form', 'password').value = ''; state = await api<State>('/api/workspace'); selectedNode = state.workspace.topology.document.root.id; expandedNodes.add(selectedNode); render(); message(''); });
});
$('logout').addEventListener('click', () => { if (!discard()) return; void action(async () => { await api('/api/logout', {}); clearDirty(); if (authMode === 'ssh') location.assign('/?session=closed'); else location.reload(); }); });
$('reload').addEventListener('click', () => { if (!discard()) return; void action(async () => { state = await api<State>('/api/workspace'); clearDirty(); creating = false; map?.destroy(); map = undefined; mapDocument = undefined; render(); $<HTMLDetailsElement>('account').querySelector('details')!.open = false; if (view === 'preview') await showMap(mapMode); message('已重新读取私有快照。'); }); });
for (const next of ['articles', 'directory', 'preview', 'publication'] as const) $('view-' + next).addEventListener('click', () => {
  if (next === view || pending || !discard()) return;
  clearDirty(); creating = false; render(); setView(next);
  if (next === 'preview') void action(() => showMap(mapMode));
  if (next === 'publication') void action(loadPublicationConfiguration);
});
let reviewExpiry: ReturnType<typeof setTimeout> | undefined;
function clearPublicationReview() {
  clearTimeout(reviewExpiry); reviewedPlan = undefined; $('publication-result').hidden = true;
  $('publication-confirmation').hidden = true; $<HTMLInputElement>('publication-acknowledge').checked = false; updatePublicationConfirmation();
  for (const id of ['publication-version', 'publication-summary', 'publication-issues', 'publication-files', 'publication-articles', 'publication-disclosure', 'publication-directories']) $(id).replaceChildren();
}
async function loadPublicationConfiguration() {
  clearPublicationReview();
  const button = $<HTMLButtonElement>('review-publication'); button.disabled = true; publicationConfigured = false;
  const status = await api<{ configured: boolean; canPublish: boolean; transport?: string; baseCommit?: string; visibilityDeclaration?: string }>('/api/publication');
  $('publication-configuration').textContent = status.transport === 'isolated-worker'
    ? `已配置独立执行器 · 核对时读取远端 content/main · ${status.canPublish ? '仅显式确认后推送私有 Git' : '首次真实发布尚未开放'}；网页服务不持有推送凭据。`
    : status.configured
    ? `本地基线 ${status.baseCommit!.slice(0, 12)} · 可见性声明：${({ private: '私有', public: '公开', unknown: '未确认' })[status.visibilityDeclaration as 'private' | 'public' | 'unknown']}（未查询远端）`
    : '尚未配置本地 Git 基线。需要在服务器配置只读内容仓库和导入提交，不需要在网页中填写凭据。';
  publicationConfigured = status.configured; publicationCanPublish = status.canPublish; button.disabled = !status.configured;
  $('publication-gate').textContent = status.canPublish ? '仅在下方核对并显式确认后才会推送。' : '当前未开放真实推送。';
  $('refresh-publication').hidden = status.transport !== 'isolated-worker';
  if (status.transport === 'isolated-worker') displayPublicationProgress((await api<{ progress: PublicationProgress | null }>('/api/publication/job')).progress);
}
function reviewList(id: string, lines: string[], empty: string) {
  $(id).replaceChildren(...(lines.length ? lines : [empty]).map(text => { const item = document.createElement('li'); item.textContent = text; return item; }));
}
$('review-publication').addEventListener('click', () => void action(async () => {
  clearPublicationReview();
  const plan = await api<PublicationReviewSummary>('/api/publication/plan', { revision: state.revision });
  if (state.revision !== plan.revision) throw new Error('本页版本已变化，请重新核对。');
  const remaining = Date.parse(plan.expiresAt) - Date.now();
  if (remaining <= 0) throw new Error('核对结果已过期，请重新生成。');
  const kind = { added: '新增', modified: '修改', deleted: '删除', moved: '移动' };
  $('publication-version').textContent = `工作区 ${plan.revision.slice(0, 12)} · 基线 ${plan.baseCommit.slice(0, 12)} · 有效至 ${new Date(plan.expiresAt).toLocaleTimeString()}`;
  $('publication-summary').textContent = plan.noChanges ? '与核对基线没有差异；未发布任何内容。' : `${plan.files.length} 个文件变化，${plan.articles.length} 篇文章变化。仅核对，未发布。`;
  reviewList('publication-issues', plan.issues.map(issue => issue.message), '未发现计划器校验问题；这不代表具备发布条件。');
  reviewList('publication-files', plan.files.map(file => `${kind[file.kind]} · ${file.path}`), '没有文件变化。');
  reviewList('publication-articles', plan.articles.map(article => `${kind[article.kind]} · ${article.after?.title ?? article.before?.title} · ${article.before?.path ?? '无'} → ${article.after?.path ?? '无'} · ${article.before ? article.before.draft ? '草稿' : '定稿' : '无'} → ${article.after ? article.after.draft ? '草稿' : '定稿' : '无'}`), '没有文章变化。');
  reviewList('publication-disclosure', [
    ...plan.disclosure.publicArticles.map(article => `公开候选 · ${article.title}（${article.id}）`),
    ...plan.disclosure.drafts.map(article => `仅私有 Git · 草稿 ${article.title}（${article.id}）`),
    `公开地图文章入口 ${plan.disclosure.publicMapEntries} 个；保留 ${plan.disclosure.preservedFileCount} 个不由工作台管理的文件。`,
  ], '没有文章。');
  $('publication-directories').textContent = JSON.stringify(plan.directories, null, 2);
  reviewedPlan = plan;
  $('publication-result').hidden = false;
  $('publication-confirmation').hidden = !publicationCanPublish || !plan.execution?.publishEnabled;
  $('publication-target').textContent = `目标：私有 content/main · 基线 ${plan.baseCommit.slice(0, 12)} · 工作区 ${plan.revision.slice(0, 12)}。${plan.noChanges ? '无差异时不创建提交。' : ''}`;
  updatePublicationConfirmation();
  reviewExpiry = setTimeout(() => { clearPublicationReview(); $('publication-configuration').textContent = '核对结果已过期，请重新生成；没有内容被发布。'; }, remaining);
}));
function updatePublicationConfirmation() {
  $<HTMLButtonElement>('review-publication').disabled = pending || publicationInFlight || !publicationConfigured;
  $<HTMLButtonElement>('refresh-publication').disabled = pending || publicationInFlight;
  $<HTMLButtonElement>('refresh-deployment').disabled = pending || publicationInFlight || deploymentInFlight;
  $<HTMLButtonElement>('confirm-publication').disabled = pending || publicationInFlight || !publicationCanPublish || !reviewedPlan?.execution?.publishEnabled ||
    Date.now() >= Date.parse(reviewedPlan?.expiresAt ?? '') || !$<HTMLInputElement>('publication-acknowledge').checked;
}
function displayPublicationProgress(progress: PublicationProgress | null) {
  if (progress?.job.id !== displayedPublication?.job.id || progress?.job.commit !== displayedPublication?.job.commit) $('deployment-result').hidden = true;
  displayedPublication = progress;
  $('refresh-deployment').hidden = !progress?.job.commit || !['pushed', 'no-changes'].includes(progress.job.phase);
  $('publication-job').hidden = !progress;
  if (!progress) return;
  const labels: Record<PublicationProgress['job']['phase'], string> = {
    prepared: '确认已记录，执行结果待查询', committing: '正在生成提交', committed: '已生成候选提交，推送结果待核对', pushing: '推送结果待查询',
    pushed: '已推送 Git，网站部署尚未核验', 'no-changes': '没有差异，未创建新提交', conflict: '远端已变化，本次未推送', unknown: '执行结果不确定，需要人工核对；不会自动重推', expired: '核对已过期，本次未推送',
  };
  const baseline = progress.baseline === 'advanced' ? '工作区基线已更新，后续编辑已保留。' : progress.baseline === 'conflict' ? 'Git 结果已保留，但工作区基线未能更新，需要人工核对。' : '工作区基线尚未更新。';
  $('publication-job-status').textContent = `${labels[progress.job.phase]}。${baseline}`;
  $('publication-job-detail').textContent = `作业 ${progress.job.id} · 冻结版本 ${progress.job.revision.slice(0, 12)}${progress.job.commit ? ' · Git ' + progress.job.commit.slice(0, 12) : ''}`;
  $('publish-status').textContent = '最近作业：' + labels[progress.job.phase];
}
async function applyPublicationProgress(progress: PublicationProgress | null, ownsEditingLock = false) {
  displayPublicationProgress(progress);
  if (progress?.baseline !== 'advanced' || (pending && !ownsEditingLock)) return;
  const fresh = await api<State>('/api/workspace');
  // If only the baseline changed, refresh the CAS token without touching any input.
  // Never adopt another editor's changed content as the base of this page's unsaved form.
  if ((!pending || ownsEditingLock) && JSON.stringify(fresh.workspace) === JSON.stringify(state.workspace)) {
    state.revision = fresh.revision; state.sourceChanged = fresh.sourceChanged;
    $('revision').textContent = '私有版本 ' + state.revision.slice(0, 10);
    $('source-warning').hidden = !state.sourceChanged;
  } else if ((!pending || ownsEditingLock) && !dirtyForms.size && view === 'publication') {
    state = fresh; render(); displayPublicationProgress(progress);
  }
}
$('publication-acknowledge').addEventListener('change', updatePublicationConfirmation);
$('cancel-publication').addEventListener('click', () => { clearPublicationReview(); message('已取消本次核对，未发起推送。'); });
$('confirm-publication').addEventListener('click', () => {
  const plan = reviewedPlan;
  if (!plan?.execution || !publicationCanPublish || !$<HTMLInputElement>('publication-acknowledge').checked) return;
  if (publicationInFlight || pending) return;
  void (async () => {
    publicationInFlight = true; clearPublicationReview();
    try {
      const result = await api<{ progress: PublicationProgress }>('/api/publication/confirm', {
        id: plan.execution!.id, planId: plan.planId, revision: plan.revision, baseCommit: plan.baseCommit, acknowledgePrivateSnapshot: true,
      });
      await applyPublicationProgress(result.progress);
    } catch (error) {
      $('publication-job').hidden = false;
      $('publication-job-status').textContent = '确认未完成或结果待查询；请查询作业状态，不要重复发布。';
      $('publication-job-detail').textContent = `核对作业 ${plan.execution!.id}`;
      message(error instanceof ApiError ? error.message : '确认响应未能取得，执行结果待查询；不要重复推送，当前输入仍然保留。', true);
    } finally { publicationInFlight = false; updatePublicationConfirmation(); }
  })();
});
$('refresh-publication').addEventListener('click', () => void action(async () => {
  clearPublicationReview();
  const result = await api<{ progress: PublicationProgress | null }>('/api/publication/reconcile', {});
  await applyPublicationProgress(result.progress, true);
  if (!result.progress) message('没有已确认的发布作业；不会自动推送。');
}));
$('refresh-deployment').addEventListener('click', () => {
  if (deploymentInFlight || publicationInFlight || pending) return;
  const expected = displayedPublication?.job;
  void (async () => {
    deploymentInFlight = true; updatePublicationConfirmation();
    $('deployment-result').hidden = false; $('deployment-status').textContent = '正在查询该提交的构建与部署证据…';
    $('deployment-detail').textContent = ''; $('deployment-links').replaceChildren();
    try {
      const { report } = await api<{ report: DeploymentReport | null }>('/api/publication/deployment', {});
      if (displayedPublication?.job.id !== expected?.id || displayedPublication?.job.commit !== expected?.commit) return;
      if (!report) { $('deployment-status').textContent = '没有已证实推送的发布作业；未查询或重推任何内容。'; return; }
      if (report.contentCommit !== expected?.commit) throw new Error('版本不匹配');
      $('deployment-status').textContent = deploymentMessage(report);
      $('deployment-detail').textContent = `Content ${report.contentCommit.slice(0, 12)}${report.site ? ' · Site ' + report.site.commit.slice(0, 12) : ''} · 查询于 ${new Date(report.checkedAt).toLocaleString()}（30 秒内复用结果）。只针对该冻结发布版本，不代表当前编辑内容。`;
      const link = (label: string, href: string) => { const a = document.createElement('a'); a.textContent = label; a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; $('deployment-links').append(a); };
      if (report.run) link('查看构建', `https://github.com/XAN9xXx/blog/actions/runs/${report.run.id}/attempts/${report.run.attempt}`);
      if (report.site) link('查看 site 提交', `https://github.com/XAN9xXx/site/commit/${report.site.commit}`);
      if (report.deployment) link('查看 Cloudflare 部署', report.deployment.url);
    } catch { $('deployment-status').textContent = '部署状态查询失败；不会改变文章、发布记录或重推内容。'; }
    finally { deploymentInFlight = false; updatePublicationConfirmation(); }
  })();
});
$('toggle-library').addEventListener('click', () => toggleLibrary(!$('article-library').classList.contains('is-open')));
$('mobile-new-article').addEventListener('click', newArticle);
$('new-article').addEventListener('click', newArticle); $('empty-new-article').addEventListener('click', newArticle);
$('article-search').addEventListener('input', updateArticleList); $('article-filter').addEventListener('change', updateArticleList);
field('article-form', 'title').addEventListener('input', () => {
  if (!creating || field('article-form', 'id').value !== autoArticleId) return;
  autoArticleId = uniqueId(field('article-form', 'title').value, state.articles.map(a => a.id), articleSeed); field('article-form', 'id').value = autoArticleId;
  if (field('article-form', 'path').value === autoArticlePath) { autoArticlePath = 'articles/' + autoArticleId + '.md'; field('article-form', 'path').value = autoArticlePath; }
});
field('article-form', 'id').addEventListener('input', () => { if (creating && field('article-form', 'path').value === autoArticlePath) { autoArticlePath = 'articles/' + field('article-form', 'id').value + '.md'; field('article-form', 'path').value = autoArticlePath; } });
form('article-form').addEventListener('submit', event => { event.preventDefault(); const value = (name: string) => field('article-form', name).value;
  const command: Command = { type: 'saveArticle', create: creating, path: value('path'), body: value('body'), data: { id: value('id'), title: value('title'), description: value('description'), pubDate: value('pubDate'), draft: field('article-form', 'draft').checked, topics: value('topics').split(',').map(s => s.trim()).filter(Boolean), lang: value('lang') === 'en' ? 'en' : 'zh-CN' } };
  void action(() => save(command));
});
$('write-body').addEventListener('click', () => bodyMode(false));
$('preview-body').addEventListener('click', () => { const body = field('article-form', 'body').value; void action(async () => { const result = await api<{ html: string }>('/api/markdown', { body }); $('rendered-body').innerHTML = result.html; bodyMode(true); }); });
$('delete-article').addEventListener('click', () => {
  if (!selectedArticle) return; const id = selectedArticle;
  const refs = Object.entries(state.workspace.topology.articleRefs).filter(([, article]) => article === id).map(([node]) => trail(node).join(' / '));
  if (refs.length) { message('请先移除或重新绑定这些入口：' + refs.join('、'), true); return; }
  if (!confirm('从私有工作区删除文章「' + articleLabel(id) + '」？未保存的修改也会丢弃；不会直接修改线上内容。')) return;
  void action(() => save({ type: 'deleteArticle', id, confirm: true }));
});
$('manage-entry').addEventListener('click', () => {
  if (!discard()) return; clearDirty();
  const ref = Object.entries(state.workspace.topology.articleRefs).find(([, id]) => id === selectedArticle)?.[0];
  selectedNode = ref ?? state.workspace.topology.document.root.id; render(); setView('directory');
  if (!ref) $<HTMLDetailsElement>('bind-panel').open = true;
});
form('directory-form').addEventListener('submit', event => { event.preventDefault(); const command: Command = { type: 'editDirectory', id: selectedNode, label: field('directory-form', 'label').value, description: field('directory-form', 'description').value }; void action(() => save(command)); });
field('add-directory-form', 'label').addEventListener('input', () => { if (field('add-directory-form', 'id').value === autoDirectoryId) { autoDirectoryId = uniqueId(field('add-directory-form', 'label').value, flat().map(e => e.node.id), directorySeed); field('add-directory-form', 'id').value = autoDirectoryId; } });
form('add-directory-form').addEventListener('submit', event => { event.preventDefault(); const command: Command = { type: 'addDirectory', parentId: selectedNode, id: field('add-directory-form', 'id').value, label: field('add-directory-form', 'label').value, kind: select('add-directory-form', 'kind').value as 'topic' | 'index' }; void action(() => save(command)); });
select('bind-form', 'articleId').addEventListener('change', updateBindingId);
form('bind-form').addEventListener('submit', event => { event.preventDefault(); const command: Command = { type: 'bindArticle', parentId: selectedNode, nodeId: field('bind-form', 'nodeId').value, articleId: select('bind-form', 'articleId').value }; void action(() => save(command)); });
form('rebind-form').addEventListener('submit', event => { event.preventDefault(); const command: Command = { type: 'rebindArticle', nodeId: selectedNode, articleId: select('rebind-form', 'articleId').value }; void action(() => save(command)); });
$('edit-bound').addEventListener('click', () => { if (!discard()) return; clearDirty(); showArticle(state.workspace.topology.articleRefs[selectedNode]); setView('articles'); field('article-form', 'title').focus(); });
form('move-form').addEventListener('submit', event => { event.preventDefault(); const command: Command = { type: 'moveNode', id: selectedNode, parentId: select('move-form', 'parentId').value, index: Number(field('move-form', 'position').value) - 1 }; void action(() => save(command)); });
$('remove-node').addEventListener('click', () => {
  const node = flat().find(e => e.node.id === selectedNode)!.node; const removed = flat(node);
  if (!confirm(`移除 ${node.label} 及其子树（${removed.length} 个节点、${removed.filter(e => e.node.type === 'article').length} 个文章入口）？文章正文不会删除。`)) return;
  void action(() => save({ type: 'removeNode', id: selectedNode, confirm: true }));
});
$('collapse-tree').addEventListener('click', () => { expandedNodes.clear(); expandedNodes.add(state.workspace.topology.document.root.id); renderTree(); });
function annotateMapDirectories() {
  if (!mapDocument || !map || map.getState().destroyed) return;
  const directories = flat(mapDocument.root).filter(({ node }) => ['topic', 'index'].includes(node.type));
  const emptyIds = new Set(directories.filter(({ node }) => !node.children?.length).map(({ node }) => node.id));
  for (const element of $('map-preview').querySelectorAll<SVGGElement>('.node[data-id]')) {
    const empty = emptyIds.has(element.dataset.id!); element.classList.toggle('empty-directory', empty);
    if (empty) {
      const node = directories.find(({ node }) => node.id === element.dataset.id)!.node;
      element.setAttribute('aria-label', `${node.label}，空目录，可在管理目录中添加内容`);
      const meta = element.querySelector('.meta'); if (meta) meta.textContent = '空目录';
    }
  }
  const selected = directories.find(({ node }) => node.id === map!.getState().selectedId)?.node;
  const panel = $('map-preview').querySelector<HTMLElement>('.context-panel');
  if (!selected || !panel || panel.hidden) return;
  const empty = emptyIds.has(selected.id);
  if (empty) {
    const type = panel.querySelector('.panel-type'); if (type) type.textContent = '空目录';
    const description = panel.querySelector(':scope > p'); if (description) description.textContent = '这里还没有子目录或文章入口。可以前往管理目录添加内容。';
  }
  if (panel.querySelector('[data-workbench-directory]')?.getAttribute('data-workbench-directory') === selected.id) return;
  const button = document.createElement('button'); button.type = 'button'; button.className = 'panel-open';
  button.dataset.workbenchDirectory = selected.id; button.textContent = empty ? '去管理目录添加内容' : '管理此目录';
  button.addEventListener('click', () => {
    if (pending || !discard()) return;
    clearDirty(); selectedNode = selected.id; render(); setView('directory'); field('directory-form', 'label').focus();
  });
  const previous = panel.querySelector('.panel-open'); if (previous) previous.replaceWith(button); else panel.append(button);
}
function mapSize() {
  const viewport = $('map-preview').parentElement!;
  $('map-scroll-hint').hidden = viewport.clientWidth >= 640;
  return previewSize(viewport.clientWidth, window.innerHeight, viewport.getBoundingClientRect().top + window.scrollY);
}
let mapRevealFrame = 0;
function revealMapSelection(event: Event) {
  if (!event.isTrusted || !(event.target instanceof Element)) return;
  if (event instanceof KeyboardEvent && !['Enter', ' '].includes(event.key)) return;
  // Capture before the renderer stops node-click propagation. Synthetic clicks used
  // to restore selection after a resize must not pull the page back to the inspector.
  const target = event.target.closest<HTMLElement | SVGGElement>('.node[data-id], .panel-rel[data-id]');
  if (!target) return;
  cancelAnimationFrame(mapRevealFrame);
  const instance = map; const id = target.dataset.id;
  const reveal = () => {
    if (!instance || map !== instance || view !== 'preview') return;
    const current = instance.getState();
    if (current.destroyed || current.selectedId !== id) return;
    if (current.animating) { mapRevealFrame = requestAnimationFrame(reveal); return; }
    const panel = $('map-preview').querySelector<HTMLElement>('.context-panel');
    if (!panel || panel.hidden) return;
    const { top, bottom } = panel.getBoundingClientRect();
    const offset = panelScrollOffset(top, bottom, window.innerHeight);
    if (Math.abs(offset) > 1) window.scrollBy({ top: offset, left: 0,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  };
  mapRevealFrame = requestAnimationFrame(reveal);
}
$('map-preview').addEventListener('click', revealMapSelection, true);
$('map-preview').addEventListener('keydown', revealMapSelection, true);
function drawMap(preserveFocus = false) {
  cancelAnimationFrame(mapRevealFrame);
  if (!mapDocument || view !== 'preview') return;
  const previous = preserveFocus ? map?.getState() : undefined;
  const selectedDirectory = previous?.selectedId && flat(mapDocument.root).find(({ node }) => node.id === previous.selectedId && ['topic', 'index'].includes(node.type))?.node;
  ({ width: mapWidth, height: mapHeight } = mapSize());
  $('map-preview').style.minWidth = mapWidth + 'px';
  $('map-preview').style.setProperty('--preview-canvas-height', mapHeight + 'px');
  // Keep the renderer's proven logical geometry; fit the SVG instead of squeezing nodes against its edges.
  const logicalHeight = Math.max(mapHeight, Math.min(640, Math.max(460, mapWidth * .52)));
  $('map-preview').style.setProperty('--preview-visible-width', $('map-preview').parentElement!.clientWidth + 'px');
  map?.destroy(); map = mountTopology($('map-preview'), mapDocument, { width: mapWidth, height: logicalHeight,
    initialFocusId: selectedDirectory ? previous?.focusId : previous?.selectedId ?? previous?.focusId,
    onNavigate(_href, node, event) { event.preventDefault(); if (!discard()) return; clearDirty(); selectedNode = node.id; creating = false; selectedArticle = state.workspace.topology.articleRefs[node.id]; render(); setView('articles'); field('article-form', 'title').focus(); }
  });
  map.subscribe(annotateMapDirectories); annotateMapDirectories();
  if (selectedDirectory && previous) {
    // The pinned module's focus(id) enters directories, even empty ones. Restore
    // their selection through the rendered node after the parent layout settles.
    const instance = map; let unsubscribe = () => {};
    const restoreSelection = () => {
      const current = instance.getState();
      if (current.destroyed) { unsubscribe(); return; }
      if (current.animating) return;
      unsubscribe();
      if (current.focusId !== previous.focusId || current.selectedId) return;
      const node = Array.from($('map-preview').querySelectorAll<SVGGElement>('.node[data-id]')).find(element => element.dataset.id === selectedDirectory.id);
      node?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    };
    unsubscribe = instance.subscribe(restoreSelection); restoreSelection();
  }
  const viewport = $('map-preview').parentElement!;
  viewport.scrollLeft = Math.max(0, (mapWidth - viewport.clientWidth) / 2);
}
async function showMap(mode: 'editing' | 'public') {
  const result = await api<{ document: TopologyDocument }>('/api/preview', { revision: state.revision, mode });
  mapMode = mode; mapDocument = result.document; drawMap();
  $('preview-editing').setAttribute('aria-pressed', String(mode === 'editing')); $('preview-public').setAttribute('aria-pressed', String(mode === 'public'));
  $('preview-caption').textContent = `${mode === 'editing' ? '完整目录 · 含草稿和空分类' : '模拟公开地图 · 隐藏草稿和空分类'} · 使用已保存版本 ${state.revision.slice(0, 10)}`;
}
$('preview-editing').addEventListener('click', () => void action(() => showMap('editing')));
$('preview-public').addEventListener('click', () => void action(() => showMap('public')));
let mapResizeFrame = 0;
function resizeMap() {
  cancelAnimationFrame(mapResizeFrame);
  mapResizeFrame = requestAnimationFrame(() => {
    if (view !== 'preview' || !mapDocument) return;
    const size = mapSize();
    $('map-preview').style.setProperty('--preview-visible-width', $('map-preview').parentElement!.clientWidth + 'px');
    if (size.width !== mapWidth || size.height !== mapHeight) drawMap(true);
  });
}
new ResizeObserver(resizeMap).observe($('map-preview').parentElement!);
window.addEventListener('resize', resizeMap);
$('reconnect-session').addEventListener('click', () => location.replace('/'));
async function connect() {
  try {
    const session = await api<{ csrf: string; authMode: 'password' | 'ssh' }>('/api/session'); csrf = session.csrf; authMode = session.authMode;
    state = await api<State>('/api/workspace'); selectedNode = state.workspace.topology.document.root.id; expandedNodes.add(selectedNode); render();
  } catch (error) {
    $('connecting').hidden = true; $('login').hidden = false;
    if (!(error instanceof ApiError && error.status === 401)) throw error;
  }
}
if (new URLSearchParams(location.search).get('session') === 'closed') {
  $('connecting').hidden = true; $('session-closed').hidden = false;
} else void action(connect);
