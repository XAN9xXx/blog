import { mountTopology, type TopologyInstance, type TopologyNode } from '@xan9x/topology';
import '@xan9x/topology/style.css';
import './style.css';
import type { Workspace, Command } from './model';
interface Article { id: string; path: string; body: string; data: { id: string; title: string; description: string; pubDate: string; draft: boolean; topics: string[] } }
interface State { revision: string; sourceChanged: boolean; workspace: Workspace; articles: Article[] }
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const form = (id: string) => $<HTMLFormElement>(id);
const field = (id: string, name: string) => form(id).elements.namedItem(name) as HTMLInputElement;
const select = (id: string, name: string) => form(id).elements.namedItem(name) as HTMLSelectElement;
let csrf = ''; let state: State; let selectedNode = ''; let selectedArticle: string | undefined;
const dirtyForms = new Set<string>();
function clearDirty() { dirty = false; dirtyForms.clear(); }
let creating = false; let dirty = false; let pending = false; let map: TopologyInstance | undefined;
function message(text: string, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
async function api<T>(url: string, value?: unknown): Promise<T> {
  const response = await fetch(url, { method: value === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: value === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: value === undefined ? undefined : JSON.stringify(value) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '请求失败。'); return result;
}
async function action(run: () => Promise<void>) {
  if (pending) return;
  pending = true; document.body.setAttribute('aria-busy', 'true');
  // Lock editable controls too: a response must not overwrite typing made during an in-flight save.
  const controls = [...document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('button,input,select,textarea')];
  const disabled = controls.map(control => control.disabled); controls.forEach(control => control.disabled = true);
  try { await run(); } catch (error) { message(error instanceof Error ? error.message : '操作失败。', true); }
  finally { controls.forEach((control, i) => control.disabled = disabled[i]!); pending = false; document.body.removeAttribute('aria-busy'); }
}
function flat(node = state.workspace.topology.document.root, parent?: TopologyNode): { node: TopologyNode; parent?: TopologyNode }[] {
  return [{ node, parent }, ...(node.children ?? []).flatMap(child => flat(child, node))];
}
function discard() { return !dirty || window.confirm('有尚未保存的表单修改，确定放弃并切换吗？'); }
function selectOptions(target: HTMLSelectElement, options: { value: string; text: string }[], value?: string) {
  target.replaceChildren(...options.map(item => new Option(item.text, item.value))); if (value !== undefined) target.value = value;
}
function articleLabel(id: string) { const a = state.articles.find(a => a.id === id); return a ? `${a.data.title}${a.data.draft ? ' · 草稿' : ''}` : id; }
function showArticle(id?: string, fresh = false) {
  const a = state.articles.find(a => a.id === id);
  creating = fresh; selectedArticle = id;
  $<HTMLFieldSetElement>('article-fields').disabled = !a && !fresh;
  if (!a && !fresh) { form('article-form').reset(); $('article-refs').textContent = '选择文章或创建新草稿。'; return; }
  const data = a?.data ?? { id: '', title: '', description: '', pubDate: new Date().toISOString(), draft: true, topics: [] };
  for (const name of ['id', 'title', 'description'] as const) field('article-form', name).value = data[name];
  field('article-form', 'id').readOnly = !fresh;
  field('article-form', 'path').value = a?.path ?? 'articles/';
  field('article-form', 'pubDate').value = data.pubDate.slice(0, 10);
  field('article-form', 'draft').checked = data.draft;
  field('article-form', 'topics').value = data.topics.join(', ');
  field('article-form', 'body').value = a?.body ?? '';
  $('delete-article').hidden = fresh;
  const refs = Object.entries(state.workspace.topology.articleRefs).filter(([, article]) => article === id).map(([node]) => node);
  $('article-refs').textContent = fresh ? '新文章默认草稿。ID 保存后固定；改名或移动文件不改变链接。' : '目录入口：' + (refs.join('、') || '尚未绑定到地图');
  $('body-preview').hidden = true;
}
function showNode() {
  const found = flat().find(e => e.node.id === selectedNode) ?? flat()[0]!;
  selectedNode = found.node.id; const node = found.node; const article = node.type === 'article';
  $('selected-node').textContent = `${node.id} · ${node.type}`;
  $('directory-form').hidden = article; $('rebind-form').hidden = !article;
  field('directory-form', 'label').value = node.label; field('directory-form', 'description').value = node.description ?? '';
  const articles = state.articles.map(a => ({ value: a.id, text: articleLabel(a.id) }));
  selectOptions(select('bind-form', 'articleId'), articles);
  selectOptions(select('rebind-form', 'articleId'), articles, state.workspace.topology.articleRefs[node.id]);
  const descendants = new Set(flat(node).map(e => e.node.id));
  selectOptions(select('move-form', 'parentId'), flat().filter(e => !descendants.has(e.node.id) && ['root', 'topic', 'index'].includes(e.node.type)).map(e => ({ value: e.node.id, text: `${e.node.label} (${e.node.id})` })), found.parent?.id);
  const siblingIndex = found.parent?.children?.findIndex(n => n.id === node.id) ?? 0;
  field('move-form', 'position').value = String(siblingIndex + 1);
  $('move-form').hidden = !found.parent; $('remove-node').hidden = !found.parent;
  $('add-directory-form').hidden = article; $('bind-form').hidden = article;
}
function render() {
  $('login').hidden = true; $('main').hidden = false; $('account').hidden = false;
  $('revision').textContent = '已保存版本 ' + state.revision.slice(0, 10) + ' · 仅私有工作区';
  $('source-warning').hidden = !state.sourceChanged;
  const tree = (node: TopologyNode): HTMLLIElement => {
    const li = document.createElement('li'); const button = document.createElement('button');
    button.type = 'button'; button.textContent = node.type === 'article' ? articleLabel(state.workspace.topology.articleRefs[node.id]!) : node.label;
    button.dataset.nodeId = node.id; button.setAttribute('aria-current', node.id === selectedNode ? 'true' : 'false');
    button.addEventListener('click', () => { if (!discard()) return; clearDirty(); selectedNode = node.id;
      if (node.type === 'article') { selectedArticle = state.workspace.topology.articleRefs[node.id]; creating = false; }
      render();
    }); li.append(button);
    if (node.children?.length) { const ul = document.createElement('ul'); ul.append(...node.children.map(tree)); li.append(ul); } return li;
  };
  const ul = document.createElement('ul'); ul.append(tree(state.workspace.topology.document.root)); $('tree').replaceChildren(ul);
  $('articles').replaceChildren(...state.articles.map(a => { const li = document.createElement('li'); const button = document.createElement('button');
    button.type = 'button'; button.textContent = articleLabel(a.id); button.dataset.articleId = a.id;
    button.addEventListener('click', () => { if (!discard()) return; clearDirty(); showArticle(a.id); }); li.append(button); return li;
  }));
  showNode(); showArticle(selectedArticle, creating);
}
async function save(command: Command) {
  const owner: Record<Command['type'], string> = { saveArticle: 'article-form', deleteArticle: 'article-form', addDirectory: 'add-directory-form', editDirectory: 'directory-form', moveNode: 'move-form', removeNode: '', bindArticle: 'bind-form', rebindArticle: 'rebind-form' };
  if ([...dirtyForms].some(id => id !== owner[command.type]) && !confirm('其他表单还有未保存修改。继续此操作会放弃那些修改，是否继续？')) throw new Error('已取消，未保存的修改仍在表单中。');
  state = await api<State>('/api/command', { revision: state.revision, command }); clearDirty();
  map?.destroy(); map = undefined; $('preview-caption').textContent = '内容已保存，请重新生成地图预览。'; render(); message('已保存到私有工作区，未发布。');
}
for (const id of ['article-form', 'directory-form', 'rebind-form', 'add-directory-form', 'bind-form', 'move-form']) form(id).addEventListener('input', () => { dirty = true; dirtyForms.add(id); });
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); } });
form('login-form').addEventListener('submit', event => { event.preventDefault(); const password = field('login-form', 'password').value;
  void action(async () => { const session = await api<{ csrf: string }>('/api/login', { password }); csrf = session.csrf;
    field('login-form', 'password').value = ''; state = await api<State>('/api/workspace'); selectedNode = state.workspace.topology.document.root.id; render(); message('已登录。'); });
});
$('logout').addEventListener('click', () => { if (!discard()) return; void action(async () => { await api('/api/logout', {}); clearDirty(); location.reload(); }); });
$('reload').addEventListener('click', () => { if (!discard()) return; void action(async () => { state = await api<State>('/api/workspace'); clearDirty(); creating = false; render(); message('已重新加载。'); }); });
$('new-article').addEventListener('click', () => { if (!discard()) return; clearDirty(); showArticle(undefined, true); field('article-form', 'id').focus(); });
field('article-form', 'id').addEventListener('input', () => { if (creating) field('article-form', 'path').value = 'articles/' + field('article-form', 'id').value + '.md'; });
form('article-form').addEventListener('submit', event => { event.preventDefault(); const value = (name: string) => field('article-form', name).value;
  const command: Command = { type: 'saveArticle', create: creating, path: value('path'), body: value('body'), data: { id: value('id'), title: value('title'), description: value('description'),
    pubDate: value('pubDate'), draft: field('article-form', 'draft').checked, topics: value('topics').split(',').map(s => s.trim()).filter(Boolean) } };
  void action(async () => { await save(command); selectedArticle = command.data.id as string; creating = false; showArticle(selectedArticle); });
});
$('preview-body').addEventListener('click', () => { const body = field('article-form', 'body').value; void action(async () => {
  const result = await api<{ html: string }>('/api/markdown', { body }); $('rendered-body').innerHTML = result.html; $('body-preview').hidden = false; message('正文预览不会保存或发布。'); }); });
$('delete-article').addEventListener('click', () => {
  if (!selectedArticle) return; const id = selectedArticle;
  const refs = Object.entries(state.workspace.topology.articleRefs).filter(([, article]) => article === id).map(([node]) => node);
  if (refs.length) { message('请先移除或重新绑定这些入口：' + refs.join('、'), true); return; }
  if (!confirm('从私有工作区删除文章 ' + id + '？未保存的修改也会丢弃；不会直接修改线上内容。')) return;
  void action(async () => { await save({ type: 'deleteArticle', id, confirm: true }); selectedArticle = undefined; showArticle(); });
});
form('directory-form').addEventListener('submit', event => { event.preventDefault(); const command: Command = { type: 'editDirectory', id: selectedNode, label: field('directory-form','label').value, description: field('directory-form','description').value }; void action(() => save(command)); });
form('add-directory-form').addEventListener('submit', event => { event.preventDefault(); const command: Command = { type: 'addDirectory', parentId: selectedNode, id: field('add-directory-form','id').value, label: field('add-directory-form','label').value, kind: select('add-directory-form','kind').value as 'topic' | 'index' }; void action(async () => { await save(command); form('add-directory-form').reset(); }); });
form('bind-form').addEventListener('submit', event => { event.preventDefault(); const command: Command = { type: 'bindArticle', parentId: selectedNode, nodeId: field('bind-form','nodeId').value, articleId: select('bind-form','articleId').value }; void action(async () => { await save(command); field('bind-form','nodeId').value = ''; }); });
form('rebind-form').addEventListener('submit', event => { event.preventDefault(); const command: Command = { type: 'rebindArticle', nodeId: selectedNode, articleId: select('rebind-form','articleId').value }; void action(() => save(command)); });
$('edit-bound').addEventListener('click', () => { if (!discard()) return; clearDirty(); showArticle(state.workspace.topology.articleRefs[selectedNode]); });
form('move-form').addEventListener('submit', event => { event.preventDefault(); const command: Command = { type: 'moveNode', id: selectedNode, parentId: select('move-form','parentId').value, index: Number(field('move-form','position').value) - 1 }; void action(() => save(command)); });
$('remove-node').addEventListener('click', () => {
  const node = flat().find(e => e.node.id === selectedNode)!.node; const removed = flat(node);
  if (!confirm(`移除 ${node.label} 及其子树（${removed.length} 个节点、${removed.filter(e => e.node.type === 'article').length} 个文章入口）和相关关系边？文章正文不会删除。`)) return;
  void action(() => save({ type: 'removeNode', id: selectedNode, confirm: true }));
});
async function showMap(mode: 'editing' | 'public') {
  const result = await api<{ document: Parameters<typeof mountTopology>[1] }>('/api/preview', { revision: state.revision, mode });
  map?.destroy(); map = mountTopology($('map-preview'), result.document, { width: 1100, height: 480, animate: false,
    onNavigate(_href, node, event) { event.preventDefault(); if (!discard()) return; clearDirty(); selectedNode = node.id; creating = false;
      selectedArticle = state.workspace.topology.articleRefs[node.id]; render(); $('article-form').scrollIntoView({ block: 'start' }); }
  });
  $('preview-caption').textContent = `${mode === 'editing' ? '完整目录 · 含草稿和空分类' : '模拟公开地图 · 不含草稿和空分类'} · 版本 ${state.revision.slice(0, 10)}`;
}
$('preview-editing').addEventListener('click', () => void action(() => showMap('editing')));
$('preview-public').addEventListener('click', () => void action(() => showMap('public')));
void action(async () => {
  try { const session = await api<{ csrf: string }>('/api/session'); csrf = session.csrf; }
  catch { return; }
  state = await api<State>('/api/workspace'); selectedNode = state.workspace.topology.document.root.id; render();
});
