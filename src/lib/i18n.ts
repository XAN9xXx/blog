/**
 * Per-article language (plan A): each article is written in one language, and its page declares that
 * language and uses matching fixed text. Site chrome, the home page and the list stay in zh-CN.
 */
export const LANGS = ['zh-CN', 'en'] as const;
export type Lang = typeof LANGS[number];
export const DEFAULT_LANG: Lang = 'zh-CN';
export const articleLang = (data: { lang?: Lang }): Lang => data.lang ?? DEFAULT_LANG;

export const articleText = {
  'zh-CN': {
    placements: '在地图中的位置', contents: '本文目录', sections: (count: number) => `本文目录 · ${count} 节`,
    pager: '上一篇和下一篇', previous: '上一篇', next: '下一篇', copy: '复制', copied: '已复制', table: '可横向滚动的表格',
  },
  en: {
    placements: 'On the map', contents: 'Contents', sections: (count: number) => `Contents · ${count} sections`,
    pager: 'Previous and next', previous: 'Previous', next: 'Next', copy: 'Copy', copied: 'Copied', table: 'Scrollable table',
  },
} satisfies Record<Lang, Record<string, string | ((count: number) => string)>>;
