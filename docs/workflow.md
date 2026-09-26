# 发布工作流

## 仓库职责

| 仓库 | 职责 |
|---|---|
| xan9x-blog | Astro 页面、内容适配、校验和组装；GitHub 镜像 XAN9xXx/blog |
| xan9x-blog-content | 文章、共享资源、topology.json 中的个人地图数据；GitHub 镜像 XAN9xXx/blog-content |
| xan9x-blog-topology | 独立地图运行时、schema、布局及测试；私有 GitHub 仓库 XAN9xXx/blog-topology |
| xan9x-site | CI 生成的完整 Astro 项目；GitHub XAN9xXx/site；禁止手工编辑 |

博客与内容原有的 VPS 自托管 Git → GitHub 镜像流程保持不变。
地图的 VPS 目录已由用户建立，GitHub 私有仓库地址已提供；镜像 hook、内部权限和远端提交仍需上线前确认。
xan9x-blog-bootstrap 是早期脚手架，不参与流水线。

## 数据流：Cloudflare 仍然只读取 site

~~~text
blog + blog-content + 固定 SHA 的 blog-topology
                ↓ GitHub Actions：校验、编译地图、npm pack、组装
          site（Astro 源码 + 公开内容 + 地图 tgz + lockfile）
                ↓ CI npm ci、构建验证、提交并推送 site
          Cloudflare Pages 从 site 再构建并部署
~~~

site 不是 dist；dist 仍被忽略。CI 构建是发布前闸门，Cloudflare 构建才负责部署。
地图开发源码不复制到 site，只有编译后的模块包；Cloudflare 无需读取地图私有仓库。
现有主分支推送触发器、content → blog workflow_dispatch、组装并发策略均保留。
仅改 .github 不自动发布，须用 workflow_dispatch 手动验证。
地图仓库更新不会自动升级博客：先明确选择版本、更新固定 SHA 和依赖锁，再走博客流程。

## 地图依赖与本地开发

- topology-source.json 记录仓库和完整 40 位 commit SHA，不使用浮动分支。
- package-lock.json 另外锁定地图 tgz 的 SHA-512 integrity。
- .topology-package/topology.tgz 在引擎仓库忽略，在生成 site 中必须被跟踪。
- 地图仓库与博客分别安装依赖；本地从相邻目录打包，不能用 npm link 代替独立安装验收。

~~~sh
# 地图目录
npm ci
npm run check
npm test
# 博客目录：prepare 使用 Node 内置模块，可以在 npm ci 之前运行
npm run topology:prepare -- --source ../xan9x-blog-topology
npm ci
npm run check
npm test
npm run build
npm run dev -- --background
~~~

首次初始化且尚无提交时，commit=null 只允许本地打包，CI 明确失败。
正常升级：先在地图仓库提交并批准推送，再将 topology-source.json 指向该 SHA；运行：

~~~sh
npm run topology:prepare -- --source ../xan9x-blog-topology --update-lock
npm ci
~~~

--update-lock 只用于显式升级；CI 禁用此选项。普通打包发现 integrity 不匹配就失败。
浏览器回归：启动 4321 端口后运行 npm run test:browser。
Windows 使用隔离无头 Edge；Linux 需准备 Playwright Chromium 和系统依赖。
博客使用 TypeScript 6，以符合 @astrojs/check 当前 peer 范围；地图继续独立使用 TypeScript 7。

## 内容契约

每篇 articles/**/*.md 必须有稳定 id，不依赖文件名；改标题或移动文件不改变 URL。
必填 id/title/description/pubDate；draft 默认 false；topics 默认 []。
id 限 ASCII 字母数字开头，其后为字母数字、点、下划线或连字符，最多 128 字符。
文章 URL 为 /notes/<id>/。未知主题、重复文章 ID、无效日期、缺失目录均使构建失败。

内容根目录中的 topology.json：

~~~json
{
  "document": { "version": 1, "root": { "id": "root", "label": "XAN9x", "type": "root", "children": [] }, "relations": [] },
  "articleRefs": {}
}
~~~

articleRefs 将地图 article 节点 ID 映射到文章稳定 ID，允许一篇文章出现在多个分支。
主题 ID 来自 document 中的 topic/index 节点；topics/ 暂不是独立的主题数据源。
文章节点的标题、简介、日期、URL 在构建时取自文章，不以地图里重复的标题为准。
所有 authored href 都被拒绝，防止绕过引用校验；project 引用尚未实现，明确报错而非生成假链接。
原演示图里的虚构文章和项目不作为正式内容发布；结构分类保留。

草稿仍参与引用校验，但从公开地图中移除，包括节点、绑定和相连关系。
组装产物也不复制草稿 Markdown。结构分类节点保留，不因空分类自动删树。
assets/music/topics/projects 目录当前按共享公开资源复制，**不是私有草稿附件存储**。
不要将密钥、私有附件放入这些公开资源目录。

## 组装输入、输出和安全边界

| 变量 | 默认值 | 用途 |
|---|---|---|
| BLOG_CONTENT_SOURCE | ../xan9x-blog-content | assemble 的内容输入 |
| SITE_DIR | ../xan9x-site | assemble 输出；测试应使用临时目录 |
| TOPOLOGY_SOURCE_DIR | ../xan9x-blog-topology | 额外保护的地图源码路径 |
| BLOG_CONTENT_DIR | 优先 ./content/topology.json 所在目录，否则 ../xan9x-blog-content | Astro 内容读取 |

生成 site 自带 content，Cloudflare 不再必须配置 BLOG_CONTENT_DIR；若显式配置，应为 ./content。
显式错误路径会使构建失败，不再静默生成空站。

preflight 在任何清理之前检查：源 Git 工作树、内容完整性、地图包 integrity、资源符号链接、目标实际路径。
目标不能与任何源目录重合、嵌套或包含源；父级符号链接也要解析。
非空目标必须已有合法 .site-build.json，拒绝覆盖任意未知目录。
之后保留 .git、重建其余文件：引擎、地图 tgz、公开文章、公开地图和共享资源。
.site-build.json 记录 blog/content commit 与 dirty、地图 repository/commit/integrity。
内容只复制明确目录，不复制 .git/.github、根目录 .env 等隐藏文件。
本地源目录有未提交内容会被标记 dirty，但**执行 assemble 仍会覆盖目标**，不可将真实工作区当临时目录。

## CI 与密钥

保留 BLOG_CONTENT_TOKEN、SITE_TOKEN 和内容仓库中的 BLOG_DISPATCH_TOKEN。
新增博客仓库 secret BLOG_TOPOLOGY_TOKEN，仅需读取私有 blog-topology 内容；不要将 token 写进 URL、lockfile 或产物。
CI 用固定 SHA checkout 地图，关闭该 checkout 的凭据持久化，然后执行地图 check/test、打包、博客 check/test/内容校验。
组装后 npm ci 和 build 成功才允许提交、推送 site。Cloudflare 依旧只需现有 site 访问权限。
远端构建、token 权限、镜像 hook 和 Cloudflare 实际部署必须在用户批准推送后另行验收。

## 工作台边界

本阶段未实现编辑、保存、鉴权或发布 API。
工作台的普通保存不能向会触发发布的 main 分支推送；草稿保存、私有预览、显式发布将分别设计。
RSS/sitemap/canonical 所需站点域名、移动端地图可读性和项目内容模型仍是后续工作。
