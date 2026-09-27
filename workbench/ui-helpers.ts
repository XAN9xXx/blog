/** Generate editable defaults only; server-side validation remains authoritative. */
export function uniqueId(label: string, used: Iterable<string>, fallback: string): string {
  const ascii = label.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 110).replace(/-+$/g, '');
  const base = ascii || fallback;
  const ids = new Set(used);
  let candidate = base; let suffix = 2;
  while (ids.has(candidate)) candidate = `${base}-${suffix++}`;
  return candidate;
}
export function matchesArticle(article: { id: string; data: { title: string; description: string; draft: boolean } }, query: string, filter: string): boolean {
  if (filter === 'draft' && !article.data.draft || filter === 'ready' && article.data.draft) return false;
  const haystack = `${article.data.title} ${article.data.description} ${article.id}`.toLocaleLowerCase();
  return query.trim().toLocaleLowerCase().split(/\s+/).every(word => haystack.includes(word));
}

/** Match the module's minimum viewport while fitting ordinary desktop windows. */
export function previewSize(width: number, viewportHeight: number, top: number) {
  return { width: Math.max(640, Math.floor(width)), height: Math.max(400, Math.min(680, Math.floor(viewportHeight - Math.max(0, top) - 104))) };
}

export function articleListSummary(total: number, shown: number, query: string, filter: string) {
  const searching = Boolean(query.trim());
  const noun = filter === 'draft' ? '草稿' : filter === 'ready' ? '定稿文章' : '文章';
  const empty = !total ? '还没有文章，可以新建草稿开始写作。'
    : searching ? `没有匹配的${noun}。试试其他关键词${filter === 'all' ? '' : '，或切换筛选'}。`
    : filter !== 'all' ? `当前没有${noun}。可以切换为“全部文章”。` : '没有文章可显示。';
  return { count: searching || filter !== 'all' ? `${shown} / ${total}` : String(total), empty };
}

/** Reveal the inspector with the smallest vertical page scroll, never moving the map sideways. */
export function panelScrollOffset(top: number, bottom: number, viewportHeight: number): number {
  const margin = 16;
  // An oversized inspector cannot fit: start at its heading instead of hiding it above the viewport.
  if (bottom - top > viewportHeight - margin * 2) return top - margin;
  if (top < margin) return top - margin;
  if (bottom > viewportHeight - margin) return bottom - viewportHeight + margin;
  return 0;
}
