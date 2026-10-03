import MarkdownIt from 'markdown-it';
import { parseImageUrl } from '../src/lib/images';
type Token = ReturnType<MarkdownIt['parse']>[number];
// No raw HTML, plugins, automatic external resources, or executable code blocks.
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
// Uploaded images are served by the workbench itself (or redirected to their published copy); any other
// image source stays a placeholder, so a preview never contacts a third party.
markdown.renderer.rules.image = (tokens, index, options, env, self) => {
  const token = tokens[index]!; const image = parseImageUrl(token.attrGet('src') ?? '');
  if (!image) return '<span class="muted">[私有预览只显示工作台上传的图片]</span>';
  const alt = markdown.utils.escapeHtml(self.renderInlineAsText(token.children ?? [], options, env));
  return `<img src="/api/images/${image.key}" alt="${alt}" width="${image.width}" height="${image.height}" loading="lazy">`;
};
const link = markdown.renderer.rules.link_open ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index]!.attrSet('rel', 'noreferrer noopener'); tokens[index]!.attrSet('target', '_blank');
  return link(tokens, index, options, env, self);
};
export function renderMarkdown(body: string): string { return markdown.render(body); }

/** Every image source in a body, as Markdown parses it (inline and reference style), in order of appearance. */
export function imageSources(body: string): string[] {
  const sources: string[] = [];
  const visit = (tokens: Token[]) => tokens.forEach(token => {
    if (token.type === 'image') sources.push(token.attrGet('src') ?? '');
    if (token.children) visit(token.children);
  });
  visit(markdown.parse(body, {}));
  return sources;
}
