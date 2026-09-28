import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { loadContentCatalog } from '../src/lib/content-files';
import { applyCommand, validateWorkspace, WorkbenchError, type Workspace } from './model';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function assertRealPath(target: string): void {
  const parent = path.dirname(target);
  if (parent !== target) assertRealPath(parent);
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error('工作台路径不接受符号链接：' + target);
}
function contains(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
export class WorkspaceStore {
  readonly directory: string;
  private file: string;
  constructor(readonly content: string, directory: string) {
    this.content = path.resolve(content); this.directory = path.resolve(directory);
    assertRealPath(this.content); assertRealPath(this.directory);
    const blog = path.resolve(import.meta.dirname, '..');
    for (const forbidden of [this.content, path.join(blog, 'public'), path.join(blog, 'src'), path.join(blog, 'dist'), path.resolve(blog, '../xan9x-site')]) {
      if (contains(forbidden, this.directory) || contains(this.directory, forbidden)) throw new Error('私有工作区不能与内容源或公开输出重叠。');
    }
    // Within the engine checkout, only the explicitly excluded private state directory is safe.
    if (contains(blog, this.directory) && !contains(path.join(blog, '.workbench'), this.directory)) throw new Error('仓库内私有状态必须位于 .workbench/。');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.directory = realpathSync(this.directory);
    this.file = path.join(this.directory, 'workspace.json');
    if (!existsSync(this.file)) this.lock(() => {
      if (!existsSync(this.file)) { const workspace = this.source(); this.write({ version: 1, baseRevision: hash(workspace), workspace }); }
    });
    this.get();
  }
  private source(): Workspace {
    assertRealPath(path.join(this.content, 'articles'));
    assertRealPath(path.join(this.content, 'topology.json'));
    const catalog = loadContentCatalog(this.content);
    return validateWorkspace({ version: 1, topology: JSON.parse(readFileSync(path.join(this.content, 'topology.json'), 'utf8')),
      articles: catalog.articles.map(a => ({ path: a.relativePath.split(path.sep).join('/'), raw: a.raw })) });
  }
  private read() {
    assertRealPath(this.file);
    const value = JSON.parse(readFileSync(this.file, 'utf8'));
    if (value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.baseRevision)) throw new Error('私有工作区损坏；不会自动覆盖。');
    return { version: 1 as const, baseRevision: value.baseRevision as string, workspace: validateWorkspace(value.workspace) };
  }
  private lock<T>(action: () => T): T {
    const file = path.join(this.directory, 'write.lock');
    let descriptor: number;
    try { descriptor = openSync(file, 'wx', 0o600); }
    catch { throw new WorkbenchError('工作区正在保存或保留了中断锁，请稍后重试；不要强行覆盖。', 409); }
    try { return action(); } finally { closeSync(descriptor); rmSync(file); }
  }
  private write(value: ReturnType<WorkspaceStore['read']>) {
    const temporary = path.join(this.directory, randomUUID() + '.tmp');
    const descriptor = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(descriptor, JSON.stringify(value) + '\n'); fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
    try {
      renameSync(temporary, this.file);
      if (process.platform !== 'win32') {
        const directory = openSync(this.directory, 'r');
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
    }
    finally { if (existsSync(temporary)) rmSync(temporary); }
  }
  get() {
    const value = this.read();
    let sourceChanged = true;
    try { sourceChanged = hash(this.source()) !== value.baseRevision; } catch { /* Keep private edits readable if the source becomes invalid. */ }
    return { ...value, revision: hash(value), sourceChanged };
  }
  /** Change only the accepted Git baseline; newer saved edits remain byte-for-byte intact. */
  advancePublicationBase(expected: string, next: string) {
    if (![expected, next].every(value => /^[a-f0-9]{64}$/.test(value))) throw new WorkbenchError('无效的发布基线。');
    return this.lock(() => {
      const current = this.read();
      if (current.baseRevision === next) return this.get(); // Recovery after write succeeded but receipt was lost.
      if (current.baseRevision !== expected) throw new WorkbenchError('工作区基线已变化，不能覆盖；Git 结果保留，需人工核对。', 409);
      this.write({ ...current, baseRevision: next });
      return this.get();
    });
  }
  save(revision: string, command: unknown) {
    return this.lock(() => {
      const current = this.read();
      if (revision !== hash(current)) throw new WorkbenchError('内容已在另一个页面中保存。请先保留本页文字，再重新加载；不会覆盖较新内容。', 409);
      const workspace = applyCommand(current.workspace, command);
      this.write({ ...current, workspace });
      return this.get();
    });
  }
}
