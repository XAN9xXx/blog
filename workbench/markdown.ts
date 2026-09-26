import MarkdownIt from 'markdown-it';
// No raw HTML, plugins, automatic external resources, or executable code blocks.
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
markdown.renderer.rules.image = () => '<span class="muted">[私有预览暂不加载图片]</span>';
const link = markdown.renderer.rules.link_open ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index]!.attrSet('rel', 'noreferrer noopener'); tokens[index]!.attrSet('target', '_blank');
  return link(tokens, index, options, env, self);
};
export function renderMarkdown(body: string): string { return markdown.render(body); }
