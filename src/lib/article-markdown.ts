import type { Element, ElementContent, Nodes, Properties } from 'hast';
import type { HastPluginDefinition } from 'satteri';
import type {} from '@astrojs/markdown-satteri'; // Types ctx.data.astro (the frontmatter Astro passes in).
import { articleText, DEFAULT_LANG } from './i18n';

/**
 * Sätteri hast plugin for article bodies. Astro runs it after Shiki and before it assigns heading IDs,
 * so the table of contents sees the final heading levels.
 * - The page title is the only h1, so a body that uses h1 is shifted down one level.
 * - Code blocks get a bar naming their language; the page script adds the copy button to it.
 * - Tables scroll inside their own region instead of widening the page.
 */
const SHIFT = 'xan9xShiftHeadings';
const element = (tagName: string, properties: Properties, children: ElementContent[]): Element => ({ type: 'element', tagName, properties, children });
const containsH1 = (node: Readonly<Nodes>): boolean =>
  node.type === 'element' && node.tagName === 'h1' || ('children' in node && node.children.some(containsH1));

function codeLanguage(pre: Readonly<Element>): string | undefined {
  if (typeof pre.properties.dataLanguage === 'string') return pre.properties.dataLanguage;
  const code = pre.children.find((child): child is Element => child.type === 'element' && child.tagName === 'code');
  const classes = Array.isArray(code?.properties.className) ? code.properties.className : [];
  const marked = classes.find(name => typeof name === 'string' && name.startsWith('language-'));
  return typeof marked === 'string' ? marked.slice('language-'.length) : undefined;
}

export const articleMarkdown: HastPluginDefinition = {
  name: 'xan9x-article',
  before(root, ctx) { ctx.data[SHIFT] = containsH1(root); },
  element: {
    filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'table'],
    visit(node, ctx) {
      if (node.tagName === 'pre') {
        const language = codeLanguage(node);
        const label: ElementContent[] = language && language !== 'plaintext' && language !== 'text' ? [{ type: 'text', value: language }] : [];
        ctx.replaceNode(node, element('figure', { className: ['code-block'] }, [
          element('div', { className: ['code-bar'] }, [element('span', { className: ['code-lang'] }, label)]),
          node as Element,
        ]));
      } else if (node.tagName === 'table') {
        const label = articleText[ctx.data.astro?.frontmatter?.lang === 'en' ? 'en' : DEFAULT_LANG].table;
        ctx.wrapNode(node, element('div', { className: ['table-scroll'], tabIndex: 0, role: 'region', ariaLabel: label }, []));
      } else if (ctx.data[SHIFT]) {
        ctx.replaceNode(node, element('h' + Math.min(6, Number(node.tagName[1]) + 1), { ...node.properties }, [...node.children]));
      }
    },
  },
};
