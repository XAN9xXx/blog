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
