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

npm test、工作台浏览器夹具、站点浏览器测试与音乐夹具只使用 tests/fixtures/content（内容仓库 747915f 的冻结副本，另加一篇覆盖小标题、代码块和表格、挂在两个地图入口下的排版测试文章 publishing-pipeline），不读取相邻或 CI 检出的真实内容；组装时整个 tests/ 都不进入 site。真实内容由 check、validate:content、assemble 与 build 校验。发布文章不应改变单元测试结果；用例需要新的内容形态时，显式修改夹具并同步调整断言。

首次初始化且尚无提交时，commit=null 只允许本地打包，CI 明确失败。
正常升级：先在地图仓库提交并批准推送，再将 topology-source.json 指向该 SHA；运行：

~~~sh
npm run topology:prepare -- --source ../xan9x-blog-topology --update-lock
npm ci
~~~

--update-lock 只用于显式升级；CI 禁用此选项。普通打包发现 integrity 不匹配就失败。
浏览器回归：先停掉真实内容预览（同一项目同时只能有一个开发服务器），用 `BLOG_CONTENT_DIR=tests/fixtures/content npm run dev -- --background` 在 4321 端口启动冻结内容，再运行 npm run test:browser；每个用例开头会核对文章列表，不是冻结内容就直接失败。
Windows 默认使用隔离无头 Edge，可用 `BLOG_TEST_BROWSER=chrome` 改用 Chrome；Linux 需准备 Playwright Chromium 和系统依赖。
博客使用 TypeScript 6，以符合 @astrojs/check 当前 peer 范围；地图继续独立使用 TypeScript 7。

## 内容契约

每篇 articles/**/*.md 必须有稳定 id，不依赖文件名；改标题或移动文件不改变 URL。
必须包含 id/title/description/pubDate 字段；description 允许空字符串。draft 默认 false；topics 默认 []。
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
组装产物也不复制草稿 Markdown。内容数据中的结构分类节点保留；公开首页仅显示通向已发布文章的目录分支。该显示投影不修改源目录树。
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

## 地图作为内容目录与编辑要求

地图是博客的内容导航入口，不是仅展示技术分类的装饰图。实现与验收必须覆盖“目录 → 真实文章 → 返回目录”，以及工作台中的目录维护。

### 已有实现

- `topic/index` 是目录节点；`article` 是文章末端，不允许包含子节点。没有子节点的空目录不等于文章节点。
- 每个文章节点通过 `articleRefs` 绑定稳定文章 ID，构建时统一派生标题、摘要、日期与 `/notes/<id>/`，不手填 URL。
- 缺失绑定、引用不存在的文章、重复 ID、无效关系会阻止构建；草稿及其文章节点不进入公开产物。
- 同一文章可通过不同节点出现在多个分支；移除一个目录入口不等于删除文章文件。
- 当前浏览器行为是选择文章节点显示详情面板，再通过“打开内容”进入文章。已有端到端测试覆盖真实文章打开和浏览器返回。
- 独立工作台现已提供目录树、文章编辑、私有保存和地图预览；公开站点不含编辑接口。工作台已部署到阿里云；从工作台到内容仓库的显式发布已于 2026-09-30 开启，2026-10-01 首次真实发布已验收（记录见“独立执行器当前落地范围”）。

### 编辑规则与当前边界

- 编辑器可维护目录层级、名称和顺序，并创建、修改、移除末端的文章绑定；从文章列表选择真实文章，不输入任意链接。
- 文章节点的标题等信息跟随文章元数据；文章改名或文件移动而 ID 不变时，目录链接保持有效。
- 从目录中的文章节点或地图预览的“打开内容”进入对应文章表单。正文保存在私有工作区的 Markdown 文件快照中，不复制进地图 JSON；未来发布时再同步到内容仓库。
- 移动或删除目录时检查文章入口和关系边；删除文章时先显示引用位置并要求显式处理，不能静默留下失效入口。
- 编辑预览复用同一地图模块与数据校验，但编辑模式的选择/绑定操作不能意外跳离工作台；公开阅读与私有编辑的行为需要区分。
- 保存文章及其目录绑定时应校验一致性，不能发布半完成状态；普通保存、私有预览和显式发布保持分离。
- 目录数据继续由内容仓库维护，地图运行时继续独立维护，编辑器不向公开页面暴露写入权限或仓库凭据。

### 展示决定与验收重点

- 已确认：公开页保留摘要面板，点击“打开内容”后跳转文章，不改为节点单击直接导航。
- 已确认：公开地图递归隐藏没有已发布文章的目录，完整目录留在内容数据中供后续编辑器维护。只含草稿的分支也隐藏；隐藏节点关联的边不进入页面数据。
- 组装内容仍保留目录分类以校验已发布文章的 topics；隐藏发生在传给公开首页的地图数据中，不是删除源数据，也不是将目录名称当成私人资料保护。
- 所有分支都为空时，公开地图保留合法根节点并显示“暂无公开文章”。
- 验收顺序优先打通真实目录跳转与文章阅读，再完成“选择文章绑定 → 保存 → 私有预览 → 显式发布 → 公开地图打开文章”的闭环。
- 验收包括稳定 ID 下的文章改名、跨目录移动、一文多入口、草稿不可公开访问、文章删除后的引用检查，以及鼠标/键盘/窄屏导航。

## 工作台边界

工作台是 `workbench/` 下独立 Node 服务，不是 Astro 公开路由。普通保存不修改内容仓库、不提交 Git、不推送 main，也不会触发站点组装。它只写入权限隔离的私有快照。

已实现：单用户密码登录或显式 SSH 隧道免密、文章新增/编辑/删除、目录新增/重命名/移动/排序/移除、文章绑定与重新绑定、私有 Markdown 预览、完整/公开两种地图预览、私有快照下载，以及离线发布差异核对 CLI 与网页“发布核对”。显式确认、作业查询、发布后基线推进及按发布作业只读查询构建与 Cloudflare 部署状态的代码已部署阿里云；2026-09-30 经用户同意开启生产确认推送，2026-10-01 首次真实发布（正式文章）已端到端验收；含草稿的真实发布和真实提交后的异常恢复尚未在生产中发生，仍只在隔离夹具中验证。
未实现：内容源变更自动合并、快照图形化导入、媒体上传、关系边的独立编辑界面。稿件分为“草稿 / 定稿”（存储仍使用 draft 布尔值）；定稿只影响模拟公开预览，不代表已发布。保存状态独立显示，发布通道未接通时不伪造线上状态。
RSS/sitemap/canonical 所需站点域名、移动端地图可读性和项目内容模型仍是后续工作。


## 首页音乐与本地验证

首页保持独立地图组件，文章仍从 `/notes/` 访问；下方音乐模块使用内容仓库 `music/playlist.json`。
歌单规范见内容仓库 README。音频通过 Astro 静态文件 endpoint 生成到 `dist/music/`，不需要额外服务器、第三方播放器或 Cloudflare 仓库凭据。
组装预检同样校验歌单和文件；本地无歌单的旧快照按空歌单处理，损坏歌单、无效引用或超过 25 MiB 的文件会阻止构建。
Cloudflare Pages 单资源限制依据：https://developers.cloudflare.com/pages/platform/limits/#file-size 。

验证步骤：

1. `npm run check && npm test && npm run build`。
2. 人工预览真实内容：`npm run dev -- --background`，打开本地 4321 端口；检查空状态、主题切换、地图钻取和文章入口。
3. 自动化测试改用冻结内容：在博客目录 `npm run dev -- stop`，再 `BLOG_CONTENT_DIR=tests/fixtures/content npm run dev -- --background`。
4. 使用 `node tests/create-music-fixture.mjs` 从同一份冻结内容创建临时组装站点和两段测试 WAV（不会修改正式内容或 `xan9x-site`）。按输出进入临时站点运行离线安装、构建和后台服务。
5. 指定 `BLOG_MUSIC_TEST_URL=http://127.0.0.1:4324` 后运行 `npm run test:browser`。Windows 默认使用独立无头 Edge，`BLOG_TEST_BROWSER=chrome` 改用 Chrome；WSL 需自行安装对应 Playwright 浏览器。未指定 fixture URL 时两项音频测试会明确跳过。
6. 浏览器测试覆盖播放/暂停、进度、音量/静音、切歌、结束后顺序播放、错误恢复、空状态、窄屏、404 页面及原地图回归。测试 WAV 只在临时目录，不进入生产歌单。
7. 验证完在临时站点和博客目录分别运行 `npm run dev -- stop`；需要时按第 2 步重新启动真实内容预览。

音乐不自动播放、无跨页持久播放，不含上传界面；这些不属于本次首页改版。大文件若超过 Pages 限额，需要另行确认站内对象存储方案，当前不自动接入外部服务。


## 私有工作台：运行与上线闸门

### 本地验证

需要 Node 24 和完整依赖（包含 devDependencies）。先准备地图包并 `npm ci`，再运行：

~~~sh
npm run workbench:build
# Bash：静默读取密码，标准输入传给哈希工具；不把明文写进历史或命令参数。
read -rs -p 'Workbench password (12+ characters): ' password; printf '\n'
export WORKBENCH_PASSWORD_HASH="$(printf '%s' "$password" | npm run workbench:password --silent)"
unset password
export WORKBENCH_ORIGIN=http://127.0.0.1:4325
npm run workbench:start
~~~

通过 `http://127.0.0.1:4325` 访问。必须使用与 WORKBENCH_ORIGIN 完全一致的地址，不能混用 localhost 和 127.0.0.1。默认 password 模式缺少有效密码哈希会拒绝启动。进程固定监听回环地址，不会直接暴露到公网。

变量：

| 变量 | 默认值 / 约束 |
| --- | --- |
| WORKBENCH_ORIGIN | 浏览器实际使用的来源地址；SSH 转发用 http://127.0.0.1:4325，直接使用远程域名则必须 HTTPS；不能包含路径 |
| WORKBENCH_PORT | 4325，1024–65535；服务仅监听 127.0.0.1 |
| WORKBENCH_AUTH_MODE | 默认 password；显式设为 ssh 时允许个人 SSH 隧道免密访问 |
| WORKBENCH_PASSWORD_HASH | password 模式必填；ssh 模式忽略此值，可保留已有哈希用于恢复 |
| WORKBENCH_CONTENT_DIR | 相邻内容仓库；只读导入文章和 topology.json，不读取 Git 凭据 |
| WORKBENCH_STATE_DIR | 引擎内 .workbench；VPS 建议 /var/lib/xan9x-workbench |

仓库内状态只能位于 `.workbench/`；不能放到内容源、public、src、dist 或生成 site 中。工作台代码、构建产物、私有状态及全部测试（含内容夹具）均由组装脚本排除。不要把真实环境文件放入公开资源目录。

### 工作台操作流程

- **写文章**：登录后直接打开已有文章。侧栏按标题、摘要或 ID 搜索，并按草稿/定稿筛选；搜索或筛选时计数显示“当前结果 / 总数”，空状态区分无内容、搜索无匹配和无对应状态文章。手机上通过“文章列表”展开选择。新建草稿只需标题和正文，ID 与文件路径自动生成，可在高级设置中覆盖，首次保存后 ID 固定。
- **文章设置**：可选摘要、日期、草稿状态和主题选择收在正文下方。同一文章在保存、切换工作区视图后保留展开状态和主题搜索；切换文章或刷新页面重新初始化。主题用已选标签汇总，可搜索名称/路径并移除选择，搜索本身不算内容修改；列表不再嵌套滚动。取消“保留为草稿”表示定稿，不代表已发布；主题仍不会自动创建地图入口。
- **保存与预览**：编辑区顶部保留保存按钮，支持 Ctrl/Cmd+S。正文编辑与安全预览在同一区域切换；预览不会自动保存。公开文章标题已是一级标题，编辑器建议正文从二级标题开始，但不自动改写或禁止正文的一级标题。未保存状态始终可见，切换任务或文章前会确认放弃；断线和版本冲突保留当前输入，不做自动覆盖或浏览器本地持久化。跨任务视图保留未保存表单、“保存并切换”仍未实现；目前地图预览只读取已保存快照，后续需一起明确多表单和版本提示规则，不能仅删除确认框。
- **管理目录**：左侧可折叠目录树，右侧显示当前节点与父级路径。添加子目录、添加文章入口、移动/移除操作按需展开；新节点 ID 默认生成。主题目录用于领域分组，索引目录用于条目汇集；两者都可嵌套，并不按层级自动转换，不确定时使用默认主题目录。文章编辑区的“管理地图入口”可以定位已有绑定或帮助添加首个入口。
- **地图预览**：独立页面视图，进入时自动加载已保存版本；可切换完整目录和模拟公开地图。默认启用地图动画，系统减少动态效果设置仍生效。显示高度参考窗口空间，但保留地图逻辑坐标范围，短窗口允许页面滚动；窄屏画布保持模块最小宽度、可横向滚动。详情在画布下方，不覆盖节点。完整目录模式下，空目录使用虚线圆圈与“空目录”说明，面板可直达该节点的管理表单，不再指向空索引；公开地图仍隐藏空目录。调整窗口时保留当前焦点及选中的文章/空目录面板；文章末端仍先显示摘要，点击“打开内容”回到编辑器。工作台的嵌入排版不是公开站点的逐像素复刻，动画本体修改仍需独立地图与公开站点验收。
- **工作区选项**：右上角包含“重新读取已保存内容”、导出私有快照和结束会话。重新读取不执行 Git fetch/pull，不同步内容源；导出包含正文与草稿，不可直接公开。

自动化浏览器验证应使用 `tests/workbench-fixture.ts` 的临时副本，不要对生产隧道运行写入测试。可设置 `WORKBENCH_TEST_PORT=4335` 启动夹具，并以 `WORKBENCH_TEST_URL=http://127.0.0.1:4335` 运行测试。每轮完整测试使用新夹具，避免多轮登录触发真实保留的限流逻辑。

### 保存语义与恢复边界

- 首次启动从内容源读取完整目录及 Markdown，生成单一私有快照。原始内容仓库完全不变。
- 表单提交先对整份文章/目录快照执行相同 schema 和引用校验，再以写锁、临时文件、fsync 和 rename 保存。文章与绑定不会处于半写入状态。
- API 要求当前 revision；旧页面保存返回 409，保留表单输入，不覆盖另一页面的新版本。
- 若内容源的文章或目录发生外部变化，界面提示需要核对合并；不会静默重新导入或覆盖私有编辑。此版本没有自动合并按钮。
- 已有文章 ID 在界面不可修改；可改标题和文件路径。首版工作台文件路径限 ASCII `articles/目录/文件.md`，所有路径均校验且不允许越界。
- 保留未编辑文章的原始 Markdown；编辑过的文章重新序列化 YAML，保留额外 frontmatter 字段，但不保证注释/排版逐字节保留。
- 删除文章前必须解除所有目录入口；移除目录会连带移除其入口与关系边，但不会删除正文。被文章 topics 引用的分类需先解除引用。
- 导出包含草稿和正文，属于私有备份，不是可公开发布的 site。常规备份对象是 WORKBENCH_STATE_DIR，不要将其加入公开仓库。
- 异常终止可能留下 write.lock，服务会拒绝后续保存而不是强行覆盖。只有在确认进程已停止并检查快照后，管理员才能清理遗留锁；不提供自动破锁。
- 会话保存在内存，空闲 1 小时或建立满 8 小时失效，结束会话立即撤销；密码模式在重启/过期后需重新登录，SSH 模式按下文规则重新建立会话。密码登录有全局速率限制，同一时间只执行一次密码推导。

### 当前部署选择：阿里云 VPS + SSH 本地端口转发

工作台先部署在阿里云 VPS，通过 SSH 本地转发访问，不配置公开域名、HTTPS 反向代理或 Cloudflare Tunnel。之前的域名/反向代理前置条件在此阶段不再需要。雨云的裸 Git 仓库、GitHub 镜像与 Cloudflare 的公开博客流水线保持原样，不因工作台换部署主机而迁移。

~~~text
本机浏览器 http://127.0.0.1:4325
    → 本机 SSH 监听 127.0.0.1:4325
    → 加密 SSH 通道
    → 阿里云 VPS 127.0.0.1:4325（工作台）
        ├─ 只读内容工作副本
        └─ 私有状态目录（保存文章与目录快照）
~~~

示例配置在 `workbench/workbench.env.example`，systemd 模板在 `workbench/xan9x-workbench.service`。阿里云部署已完成；程序使用低权限 systemd 服务、回环监听及独立私有状态目录。后续代码改动先在临时副本验证，再另行确认更新 VPS；本地提交并不代表线上已更新。

服务端环境配置：

~~~ini
WORKBENCH_ORIGIN=http://127.0.0.1:4325
WORKBENCH_PORT=4325
WORKBENCH_CONTENT_DIR=/srv/worktrees/xan9x-blog-content
WORKBENCH_STATE_DIR=/var/lib/xan9x-workbench
# WORKBENCH_PASSWORD_HASH 由用户在服务器本地生成，不在文档或聊天提供真实值。
~~~

用户已确认目标为 Debian 13，SSH 别名为 `aliyun`。在 Windows PowerShell 中使用现有别名建立隧道：

~~~powershell
ssh -N -T -a -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 127.0.0.1:4325:127.0.0.1:4325 aliyun
~~~

- `-L` 左边是本机监听地址/端口，右边是从 VPS 连接的目标地址/端口；两端都显式使用 127.0.0.1。
- `-N -T` 只转发，不启动远端命令或终端；`-a` 不转发 SSH agent。自定义 SSH 端口使用已有别名配置，或另加 `-p 端口`。
- 保持此 PowerShell 会话运行，再访问 `http://127.0.0.1:4325`；Ctrl+C 关闭隧道，但不会停止 VPS 上的 systemd 工作台服务。
- 不使用 `-g`，不绑定本机 0.0.0.0，也不关闭 SSH 主机密钥校验。初次连接应核对服务器指纹。
- 无需为工作台在阿里云安全组或系统防火墙开放 4325/80/443；只需已有 SSH 入口可达。不要为此改动已有网站端口规则。
- 浏览器到本机、SSH 服务到 VPS 本机的最后一段是回环 HTTP；跨网络的一段由 SSH 加密。两台机器都应可信，默认密码模式保留独立密码；显式 SSH 免密模式依赖这两台机器与 SSH 访问边界，仍保留 CSRF 校验和私有文件权限。
- `ExitOnForwardFailure` 能发现转发监听建立失败，但不能保证 VPS 上目标服务可用；还需实际打开网页或检查 HTTP。

如果本机 4325 已占用，可以把本机端口改为 14325：

~~~powershell
ssh -N -T -a -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 127.0.0.1:14325:127.0.0.1:4325 aliyun
~~~

这时浏览器使用 `http://127.0.0.1:14325`，**VPS 上的 WORKBENCH_ORIGIN 也必须改成这个地址并重启工作台**，但 WORKBENCH_PORT 仍为 4325。SSH 转发不会替你改写 HTTP Host/Origin；若仍配置旧来源，登录或保存会被 403 拒绝。不要把 WORKBENCH_ORIGIN 填成 VPS 公网 IP，也不要混用 localhost 和 127.0.0.1。变更来源后需重新登录。

### 个人 SSH 隧道免密模式

在 `/etc/xan9x-workbench.env` 中显式设置 `WORKBENCH_AUTH_MODE=ssh` 并重启服务后，浏览器通过隧道直接进入，不再输入工作台密码。默认仍为 `password`，未知配置值拒绝启动；免密模式只允许 `http://127.0.0.1:端口` 来源，服务固定监听 `127.0.0.1` 并拒绝其他地址上的连接。不要为它配置公网反向代理或开放监听。

免密依赖部署环境的 SSH 访问边界，不代表 HTTP 服务能识别 SSH 用户。VPS 上能访问回环端口的其他本地进程，以及本机转发端口的使用者，同样能够进入；多用户或不可信环境应恢复密码模式。无需删除已有密码哈希，改回 `WORKBENCH_AUTH_MODE=password` 并重启即可恢复原密码。

浏览器仍自动获取 HttpOnly / SameSite=Strict 会话和随机 CSRF token；Host、Origin、Fetch Metadata 与写请求 CSRF 校验继续生效，未建立会话不能读取工作区或导出。只有明确收到 401 时，前端才自动重建 SSH 会话并重试一次；网络失败、403 和版本冲突不自动重试。结束当前会话会撤销 cookie，页面停留在结束状态；由于入口本来免密，重新进入不需要密码。要停止本机访问，需要关闭 SSH 隧道。

SSH 免密模式使用现有安全校验叠加会话，而不是把写接口改成无校验接口。CSRF 防护依据：[OWASP CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)。

### 部署后的首次密码设置与启动（password 模式）

安装代码、内容快照、Node、服务用户及 systemd 单元后，先保持服务停用，不配置默认生产密码。由用户在自己的交互 SSH 终端中执行：

~~~sh
bash /opt/xan9x-blog/workbench/set-password.sh
systemctl enable --now xan9x-workbench
systemctl status xan9x-workbench --no-pager
~~~

密码设置脚本需要 root 和交互终端；隐藏读取两次密码，经 scrypt 处理后以 0600 权限原子更新 /etc/xan9x-workbench.env，不显示密码或哈希，不把明文放在进程参数中。脚本失败时不要执行后续启动命令。此脚本本身不启动服务。

修改密码后需 `systemctl restart xan9x-workbench`，使新配置生效并撤销现有内存会话。不要将密码或环境文件内容发送到聊天。

### 阿里云上线前需要确认

- SSH 别名/连接信息、发行版、Node 24 可用路径，以及是否可以安装低权限 systemd 服务；先只读检查，再确认实际部署变更。
- 模板使用 /opt/xan9x-blog 中的代码，以及独立安装到 /opt/node24 的 Node 24；不修改系统 Node 或全局 alternatives。SSH 登录用户与工作台服务用户可以不同，服务不要以 root 运行。
- 阿里云需要独立的内容工作副本；雨云的 `/srv/git/*.git` 是裸仓库，不能直接作为 WORKBENCH_CONTENT_DIR。代码/内容传输或仓库读取凭据另行确认，不给工作台进程 Git 发布权限。
- 专用服务用户只读代码和内容源，只写私有状态目录。使用密码模式时，生产密码由用户在 VPS 本地设置，不发送到聊天；环境文件留在仓库外并限制权限。
- HTTP 回环来源的会话保留 HttpOnly / SameSite=Strict；不设置仅用于 HTTPS 的 Secure 标记。来源与 CSRF 校验继续生效，不能为适配隧道而禁用。
- 如果 SSH 报 `administratively prohibited`，应由管理员检查有效的 AllowTcpForwarding、DisableForwarding、PermitOpen 和 authorized_keys 限制；不直接改全局 SSH 策略。若要为专用账号收窄目的地，可评估只允许 127.0.0.1:4325，但须先确认不影响已有连接用途。

上线验收顺序：

1. VPS 上确认服务只监听 127.0.0.1:4325，而不是 0.0.0.0 或公网地址；本机也只监听 127.0.0.1 的转发端口。
2. 通过隧道进入工作台（密码模式需登录，SSH 模式自动建立会话），保存一篇测试草稿、绑定目录，检查完整/公开两种预览。
3. 验证未建立会话不能读取工作区/导出、旧页面保存冲突不会覆盖新版本、结束会话后旧 cookie 失效；SSH 模式允许重新建立会话。
4. 重启工作台后重新进入，确认私有保存仍在；关闭 SSH 后本机访问中断，重新建隧道后恢复。
5. 确认真实内容仓库和公开站点没有因保存发生变更，再单独设计发布候选、差异确认与显式推送流程。当前不存在可调用的发布接口。

将来需要从多设备直接通过域名访问时，再配置 HTTPS 反向代理及相应 WORKBENCH_ORIGIN，不在当前隧道方案中暴露公网 HTTP。

隧道参数依据：[OpenSSH ssh(1)](https://man.openbsd.org/ssh.1)、[ssh_config(5)](https://man.openbsd.org/ssh_config.5)、[sshd_config(5)](https://man.openbsd.org/sshd_config.5)。

安全实现参考：[OWASP 身份验证](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)、[OWASP CSRF 防护](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)、[Node 24 scrypt](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)。这不是第三方安全审计结论。

### 工作台验收

~~~sh
npm run check
npm test
npm run workbench:build
# 临时副本 + 临时私有状态，仅测试用密码；不要把此夹具部署到 VPS。
node --import tsx tests/workbench-fixture.ts
# 另一终端（Windows 使用隔离 Edge；Linux 需要 Playwright Chromium）：
npm run workbench:test:browser
~~~

测试覆盖认证/会话/CSRF、无效编辑回滚、版本冲突、目录操作、引用保护、草稿与空目录的双模式预览、Markdown 注入防护、编辑后重新加载、地图回到文章表单，以及桌面/平板/手机布局。浏览器夹具只修改临时内容副本；停止进程后自动清理。


## 发布闭环：离线核对原型与后续设计

目前实现了离线核对网页、独立执行器内核、显式确认与状态查询 IPC，以及安全的工作区基线推进。确认闭环代码已部署阿里云；2026-09-30 经用户同意，生产入口 `server.ts` 与 `publisher-server.ts` 显式开启确认推送，真实提交与基线推进此前只在临时仓库验证。Web 适配器、IPC 路由和执行器三个边界的默认值仍为关闭，只由生产入口的常量开启，不提供环境变量开关；每次推送仍需在网页上显式确认。已获准安装 content 专用受限凭据；未修改 GitHub Actions、雨云仓库 hook 或 Cloudflare 配置。当前推进顺序为：窄屏地图修复 → 工作台发布流程 → CI/CD 对齐；核对结果不表示 CI/CD 已接通。

### 已实现：只读离线计划器与网页核对

`workbench/publication-plan.ts` 复用现有工作区、文章、目录和公开投影校验；`workbench/publication-git.ts` 只读取本地 Git 对象；`workbench/plan-publication.ts` 提供命令行入口。网页通过已认证的 `GET /api/publication` 查看配置、`POST /api/publication/plan` 生成摘要。两者保持私有且不缓存；POST 受 CSRF 保护，只接受已保存 revision，不接受客户端提供的仓库、SHA 或凭据。本地离线模式不联网、不写 Git。独立执行器模式可以 fetch 固定远端到专属对象仓库并持久化核对作业，但不修改工作区或远端 refs。部署验收以实际服务、文件校验及接口测试为准，不把本地提交当成线上更新。

~~~sh
npm run workbench:plan -- \
  --snapshot /private/path/workspace.json \
  --content-repo /path/to/local/blog-content \
  --base-commit <完整的40位小写Git提交SHA> \
  --visibility unknown
~~~

- 输入可用工作台导出的私有快照或已有 workspace.json。只读现有文件，不通过 WorkspaceStore 构造器初始化/重写真实工作区。输出到标准输出，不自动创建计划文件、备份或 Git 提交。
- 必须传仓库根目录及完整提交 SHA，且本地 HEAD 仍等于该 SHA；不接受浮动分支名。从固定提交读取文章与 topology.json，**不采用脏工作树中的文件**，不执行 fetch/pull、checkout 或 push。
- Git 调用禁用替换对象、可选写锁和部分克隆的按需获取，忽略继承的 Git 仓库路径覆盖。需要支持 `--no-lazy-fetch` 的 Git（本地验证为 2.47.3）；缺失对象直接失败，不偷偷联网。内容中的符号链接、子模块、无效 UTF-8、无效文章路径和损坏引用均拒绝。
- 核对快照的 baseRevision 是否匹配该提交的规范化内容摘要。**摘要相同只能证明内容一致，不能证明最初导入来自哪个 Git commit，也不能证明远端未前进。** 原型明确返回 `importCommitProvenanceVerified: false` 和 `remoteChecked: false`，没有迁移或伪造导入来源。
- 计划列出文件增改删、按稳定 ID 识别的文章移动/状态变化、目录/绑定/关系变化、草稿清单、预计公开文章和地图入口数。未管理的音乐、资源及仓库配置仅计数，保持原样；无变化的 topology.json 保留原有格式，不制造格式化差异。
- 内存计划冻结快照 R，并记录摘要、planId 和 15 分钟有效期。重新核对时，R2 编辑、基线提交、可见性声明、计划内容变化或到期都会使旧计划失效；不保存回工作区，不覆盖继续编辑的 R2。CLI 只输出审阅摘要，不输出冻结正文，也不持久化可执行发布任务。
- `--visibility` 默认为 unknown；private 只是操作者对仓库及镜像的声明，**不表示已查询 GitHub**。草稿会进入完整候选快照，公开或未确认可见性的仓库会收到明确风险提示。无论是否有风险提示，计划始终返回 `canPublish: false`，不能据此执行发布。
- 摘要省略 Markdown 正文，但仍含草稿标题、路径及目录信息；不要上传到公开日志或 site。当前限制为快照/受管内容各最多 16 MiB、1000 篇文章、仓库 10000 个文件，超过限制直接拒绝。

网页配置为可选项，必须由服务端指定：

~~~sh
WORKBENCH_REVIEW_REPOSITORY=/absolute/path/to/content-checkout
WORKBENCH_REVIEW_BASE_COMMIT=<完整40位SHA>
WORKBENCH_REVIEW_VISIBILITY=unknown
~~~

全部不配置时，工作台照常运行，核对页解释缺失基线且禁用核对按钮；部分配置或无效值拒绝启动。`private` 仍只是操作者声明，不是远端核验。

核对通过独立 Node 子进程运行既有 CLI（单任务、60 秒超时、限制输出），不阻塞 HTTP 事件循环。不会传递服务端密码哈希等环境变量，也不把原始错误路径或 stderr 返回浏览器。核对前后核验 revision；生成期间其他页面保存时丢弃结果。网页仅显示文件/文章变化、目录/关系摘要及公开/草稿范围，不返回冻结正文；结果 15 分钟过期，切换视图或本页重新加载/保存也会清除旧结果。

**边界**：尚不提供 Markdown 正文逐行 diff。离线 CLI 不持久化作业；独立执行器保存冻结核对作业，Web 在确认前保存不含正文的接受记录。基线推进仅在确认作业有成功 Git 结果且原基线匹配时执行，不等于三方合并、导入来源证明或网站已上线。生产推送只能由入口常量开启，不能靠环境变量；每次推送仍须单独确认。

测试使用临时 Git 仓库，核对执行前后文件及 Git 元数据未改变，并覆盖过期、并发版本、草稿、目录绑定、文件移动、替换对象、缺失对象不联网等情况。独立执行器另有临时远端与 IPC 测试；导入来源迁移、生产启用、CI/CD 状态关联和正文逐行差异界面仍未实现。这是发布流程的前置核对工具，不是已经完成真实端到端发布。

### 职责与状态

- 浏览器编辑 → 工作台 → 私有快照的现有路径保持不变，普通保存永不执行 Git。
- 首版保留文章主题与地图入口的独立语义。地图入口是导航位置，主题是文章元数据；不将两者不同视为校验错误，不偷偷推导或改写 topics。若未来采用地图为唯一分类来源，需另行定义多入口、祖先主题、无入口文章的迁移规则并确认。
- 稿件状态（草稿 / 定稿）、私有保存状态、发布作业状态分别展示。一篇已上线的文章可以同时有未保存的新编辑，不用单一阶段线覆盖这三个维度。
- 用户已确认首版采用“发布工作区版本”：完整已保存工作区（含草稿）可进入私有 content 仓库及私有镜像，公开 site 必须排除草稿和对应地图入口。冻结文章/目录快照，展示它与目标 content 基线的差异后再确认每次发布；不先实现任意勾选单个文件发布，避免文章和绑定只发布了一半。
- 首版只管理 articles/**/*.md 和 topology.json。音乐、共享资源、仓库配置、工作流及其他文件原样保留，不做整仓库清空替换；工作台配置、密钥、私有快照文件本身绝不提交。
- 完整快照可能包含草稿；只有确认 content 仓库及镜像均为私有，且确认页清楚列出会进入 Git 的草稿后才能启用此方案。不能因为 site 排除了草稿就忽略内容仓库本身的泄漏风险。若目标仓库公开，先停下设计公开内容投影及草稿存储规则，不默认上传草稿。

### 准备、确认与原子提交

1. **准备计划**：接受当前私有 revision，冻结文章与目录；检查 schema、文章引用、主题、路径、大小和公开投影。对内容源/目标远端执行只读同步与基线检查，生成带过期时间的 planId、快照摘要和差异清单，不提交或推送。
2. **建立可证明的基线**：现有 workspace.json 只有内容摘要 baseRevision，没有 Git commit 和完整原始基线，不能据此宣称具备三方合并能力。需在迁移时核实导入源对应的 content commit，并保存可复核的基线；无法证明来源或远端已前进时，返回“需要核对”，保留私有编辑。首版不自动合并、不强制覆盖、不伪造当前远端为旧编辑的基线。
3. **显式确认**：显示新增、修改、删除、文件移动、文章入口变化、将进入公开产物的文章，以及仍只进入私有 Git 的草稿。确认绑定 planId、revision 和目标基线；任一变更后旧计划失效，不把未保存表单隐式包含进发布。
4. **执行提交**：发布执行器使用独立 Git 对象仓库和每个作业的私有 index，再次校验后通过 hash-object / write-tree / commit-tree 创建候选；不 checkout、不执行 Git hooks 或内容过滤器。仅提交白名单中的实际变更，把相互依赖的文章/目录放进一个原子提交；无差异则直接返回，不制造空提交。固定仓库和分支白名单，不接受客户端给出的 shell、仓库 URL、任意路径或 ref。
5. **推送**：沿用雨云 content 裸仓库 → GitHub 镜像的既有路径，普通 fast-forward push；远端变化导致拒绝时转为冲突，不能 force-push 或自动 rebase 后悄悄发布。推送结果不确定时先查询远端 commit，不能盲目生成新提交重试。
6. **保护继续编辑**：确认后冻结的版本 R 与后续私有编辑 R2 分开。发布完成仅记录 R 的结果，不用 R 覆盖 R2，不把新输入标为已上线。基线推进使用单独的版本检查步骤，不能无条件覆盖现有快照。

### 发布执行器与权限

工作台 Web 服务继续不持有 Git 推送凭据。独立的低权限执行器通过受权限限制的 Unix socket 接收核对快照，单作业执行，独立保存状态；其凭据只能访问指定 content 仓库。读取构建/部署状态的凭据也留在服务端，不放入浏览器、URL、导出或 site。

作业必须有持久化 ID 和幂等约束：同一个确认请求只能创建一个作业；断线、重启后从已有记录与远端证据恢复，不从头重推。日志只记录必要的 commit、作业阶段和经过筛选的错误，不记录 token 或完整草稿正文。用户已确认配置独立执行器、专用凭据和必要的 systemd 权限；2026-09-30 用户同意开启生产发布。

### 独立执行器当前落地范围

- Web 服务以 `xan9x-workbench` 运行；执行器以 `xan9x-publisher` 运行，socket 的共享组为 `xan9x-workbench`。socket `0660`、运行目录 `0750`；发布者私有目录 `0700`、私钥 `0600`，Web 用户不能读取密钥。
- `workbench/xan9x-publisher.service` 与 `workbench/publisher-server.ts` 固定远端 content/main、密钥和已核验的主机公钥路径。远端写作 SSH 别名 `content-origin`，实际地址和端口只放在服务器上 root 管理的 `/etc/xan9x-publisher/ssh_config`（`Host content-origin` 下写 `HostName`、`Port`，root:root 0644），不进入公开仓库；缺少该文件时执行器拒绝启动。客户端只能发送快照，不能传 URL、SSH 命令、仓库路径或 ref。
- Web 配置 `WORKBENCH_PUBLISHER_SOCKET=/run/xan9x-publisher/review.sock`，与 `WORKBENCH_REVIEW_*` 离线配置互斥。网页入口仍用原来的认证、同源和 CSRF 校验；Unix socket 没有 TCP 监听端口。
- 生产版本开放 `/status`、`/prepare`、`/jobs/<id>`、`/deployment` 和只观察结果的 `/reconcile`。2026-09-30 起生产入口将 `publishEnabled` 设为 true 并显式允许确认，`/confirm` 随之注册；库的默认值仍为关闭，只有显式开启的入口才注册确认接口。核对会 fetch 并验证远端 main 在读取期间不变，再检查私有快照的导入基线。成功后最多保留 100 个作业，达到上限需人工审阅清理，不自动丢弃未核对状态。
- RainYun 的专用 authorized_keys 条目使用 `restrict` 和 root 管理的 `content-publisher` forced command，仅接受指定 content 路径的 upload-pack/receive-pack；其他仓库、shell 和端口转发拒绝。`git-shell-commands/no-interactive-login` 保留 Git 账号禁止交互登录的边界。该 forced command 以 `receive.denyNonFastForwards`、`receive.denyDeletes` 运行 receive-pack：执行器密钥只能快进更新、不能删除引用；仓库配置保持默认，所有者自己的密钥仍可强推。没有改仓库 hooks。
- 执行器内核已在临时裸仓库验证：无差异不提交、单次 fast-forward、重复确认幂等、远端变化拒绝、草稿完整保留、非托管文件保留、过期/篡改拒绝、拒绝推送后不重试、发布冻结 R 不覆盖后续 R2。确认接口、网页确认和基线推进已在本地临时仓库联调，代码已部署；生产推送于 2026-09-30 开启，首次真实发布已于 2026-10-01 验收（见下条）。
- 2026-10-01 首次真实发布：用户在工作台核对并确认作业 `40c27e3f`，执行器以 XAN9x Workbench 身份将 content/main 从 `747915f` 快进到 `73ed131`（新增正式文章 `hello-world` 及其地图入口，另含用户编辑的若干目录简介），雨云与 GitHub 镜像一致；接受记录为已推送、基线已推进，无遗留锁。content 触发器按完整 SHA 发起组装 `36831211775`，但该次因博客单元测试直接读取真实内容而失败（未提交 site）；blog `f09363d` 改用冻结夹具后，push 触发的组装 `36833023068` 解析到同一 content，生成 site `9f05df4`，Cloudflare 生产部署 `dcd86f8f` 为 canonical。网页“查询部署状态”与执行器 socket 均返回“已上线”；文章页、文章列表与地图 Software 下的入口均已上线。本次未包含草稿，草稿隐藏仍只由夹具和组装测试覆盖。
- 异常退出留下 `execution.lock` 时不自动破锁。管理员先停止执行器，读取对应作业阶段、候选 commit 和远端 main 的证据，再决定人工恢复；不能删除锁后盲目重推。`pushing/committed` 的恢复只观察远端，未能证实成功则记为 unknown。
- 2026-09-29 经批准将 content/main 从 `5fd9d62` 快进至 `37f945a`，雨云与私有 GitHub 镜像一致，补齐 topology.json / 稳定文章 ID。工作台对该基线核对成功：无差异、未提交、未推送；私有快照校验值保持不变。迁移触发既有 Actions 运行 `36545503195`，生成 site `3ce6d0e`，Cloudflare 对应部署成功；部署地址首页和文章页 HTTP 200。此为管理员迁移，不是工作台首次真实发布，也未验收自定义域名。

### 已部署并开启：确认、作业恢复与基线推进

- 网页先核对完整已保存版本，再展示冻结版本、目标 content/main、基线提交、文件变化与草稿范围。必须主动勾选“包括草稿进入私有仓库及私有镜像”后才能确认；取消核对不会发起推送。普通保存不触发发布。
- `POST /api/publication/confirm` 仅接受严格结构的作业 ID、planId、revision、baseCommit 和显式确认；仍受登录、同源和 CSRF 保护。确认前重新核验当前工作区、过期时间和冻结作业身份；执行器再次核验远端基线。Web 适配器与 worker 的默认值都是拒绝确认、不注册该接口，生产入口显式开启后才可用。
- 确认前在私有状态目录原子写入 `publication.json`：最近接受的作业摘要与基线处理状态，不含 Markdown 或凭据。先持久化接受记录，再请求执行器；相同请求再次到达只观察该作业，不再次发送确认。记录未决时拒绝准备另一个发布，防止绕过未知结果。
- `GET /api/publication/job` 只读本地接受记录；`POST /api/publication/reconcile` 查询同一作业的执行结果，并在已证实成功时尝试基线推进。它不接受客户端替换作业或仓库。刷新页面后仍能读取最近记录；未知结果只能查询，不自动重推。
- 确认在界面后台等待，不锁住文章编辑。若响应返回时只有基线改变，更新页面的保存版本令牌但不重填表单；其他页面已经改变内容时不擅自采用其版本作为未保存表单的基线，仍交给保存冲突保护。状态查询不把当前草稿或后续输入标成已上线。
- 成功后，在工作区原有写锁下比较原 baseRevision，再仅修改 baseRevision；冻结 R 不覆盖后来保存的 R2。若基线已是候选摘要则幂等返回；其他基线拒绝覆盖。Git 成功但本地推进失败时保留成功 commit，显示“基线需人工核对”，不能伪装成未推送并重试。
- 工作区与接受记录是两次原子文件写入，并非跨文件事务。若基线写入后、接受记录更新前中断，查询重放只做幂等基线确认；后续编辑保持不变。`publication.lock` 或 worker 的 `execution.lock` 遗留时不自动破锁，需先停止对应进程并人工检查记录和远端证据。
- 新作业确认后，旧作业不能再次推进当前基线；仅最近接受记录可用于恢复。计划过期、远端冲突、未知结果与基线冲突分开显示。即使 Git 已推送，`deployed` 仍固定为 false，页面只说“已推送 Git，网站部署尚未核验”。
- 浏览器发布测试必须设置 `WORKBENCH_TEST_PUBLISH=1` 启动 `tests/workbench-fixture.ts`。该开关只存在于测试入口，创建临时本地裸仓库，不使用生产地址或 SSH 密钥；不得把含确认测试的整套浏览器用例指向生产隧道。

### CI 输入与发布结果的对应关系

2026-09-29 固定输入切片已推送并验收：blog `f0796e9`、content `747915f`、topology `4792e12`。未指定 SHA 的运行 `36547989814` 与显式指定 SHA 的运行 `36548263665` 均成功；最终 site `b1f5aee` 的来源记录与第二次运行完全对应，Cloudflare 检查成功，部署地址首页与文章 HTTP 200。新版 content 发送端已上线且纯工作流变更按预期不触发；2026-10-01 首次真实发布验收了自动发送路径：`73ed131` 触发的运行 `36831211775` 标题与 checkout 均为该完整 SHA（该次失败于博客单元测试，原因已修复）。

- content 触发器通过 `inputs.content_commit` 传入完整事件 SHA；仅更改 `.github/` 不自动发布。先上线 blog 的新接收端，再上线 content 触发器，不能反过来发送旧工作流不认识的 input。
- blog 接受可选的完整小写 SHA；未提供时仅查询一次私有 content/main，后续 checkout 使用该固定 SHA，拒绝分支名、短 SHA 和无效输入。凭据只用于固定仓库，不接受客户端仓库地址。
- 组装预检要求实际 content HEAD 与固定 SHA 一致、两个输入仓库均干净；不满足时在清理输出目录前失败。`.site-build.json` 增加 Actions repository / runId / runAttempt / URL，保留 blog、content、topology 来源。步骤摘要记录生成的 site commit，不向清单自引用写入 site commit。
- 本地普通组装仍可标记 dirty，不伪造 Actions 身份；测试继续使用临时 site。

完整闭环仍需要后续接通与验收：

- 上线验证固定输入切片：分别覆盖 content 触发和未提供 SHA 的手动触发，核对产物的 content commit 与冻结输入一致。
- 同时记录实际 blog commit、已固定的 topology commit、content commit、Actions run ID、生成的 site commit，以及 Cloudflare deployment ID，形成一条可核对的链。发布作业根据已推送的 content commit 关联这条链，不靠开始时间或“最近一次成功”猜测。
- Actions 保留现有校验、地图打包、组装与生成 site 构建闸门；成功后才提交 site。site 仍是可独立构建的 Astro 项目，不改成工作台直接上传 dist；Cloudflare 仍只读取 site。
- 保留构建合并/取消策略时，旧作业被较新提交取代应显示“被新版本取代”，不能误报为部署成功，也不应自动重新推送旧版本。
- 没有生成新 site commit 时，先核对既有产物与输入是否一致，再关联既有部署；不能伪造新的部署任务。

GitHub 的 workflow_dispatch 支持 ref 和 inputs；具体接入时仍需核验默认分支上的工作流与权限：[GitHub 官方说明](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)。Cloudflare 的 Git 集成可以按仓库提交构建并提供部署状态；项目实际关联仓库、生产分支、构建命令和状态查询权限需要另行检查：[Cloudflare 官方说明](https://developers.cloudflare.com/pages/configuration/git-integration/)。

### 只读构建与部署查询（已部署）

- 2026-09-30 部署于 blog `d0fb551`，两个只读凭据已安装。以 content `747915f` 对真实 GitHub 与 Cloudflare 直接查询：组装 run `36607294684`（blog `d0fb551`）→ site `f359658` → Pages 生产部署 `d0ecfdf1`，为项目 canonical 部署，结果“已上线”；Pages API 返回完整 40 位 commit、`github:push` 触发与 `deploy/success` 阶段，与代码假设一致。按作业查询已于 2026-10-01 首次真实发布验收：作业 `40c27e3f`（content `73ed131`）→ run `36833023068`（blog `f09363d`）→ site `9f05df4` → Pages 部署 `dcd86f8f`，网页入口与执行器 socket 均返回“已上线”、`productionVerified` 为 true。
- 查询只绑定最近已接受作业中、已证实推送的 content commit。浏览器只提交空对象，不能指定 commit、仓库或 URL；Web 适配器查本地接受记录，worker 以作业 ID 查自己的记录，再查询固定的 GitHub 仓库。
- 两个只读凭据都只在独立 worker 内使用，不由 Web 进程持有，不进浏览器、快照、日志或生成 site。GitHub token 放在 `/etc/xan9x-publisher/github-read-token`；Cloudflare 凭据放在 `/etc/xan9x-publisher/cloudflare-pages-read`，是含账户 ID 与 token 的 JSON，账户 ID 因此不进入公开仓库。两者所有者均为 `xan9x-publisher`、权限 `0400`，不得为符号链接或开放组/其他用户权限。缺少 GitHub 凭据时返回“未配置”；只缺 Cloudflare 凭据时核验到构建产物为止，并显示未配置 Cloudflare。Cloudflare 文件格式无效时执行器拒绝启动，错误信息不回显文件内容。缺少凭据不影响保存和核对。
- 先核验私有 content/site 的读取访问，再确认镜像 commit 是否存在。读取 site/main 的 `.site-build.json`，必要时最多查最近 10 个修改该文件的提交；依据 manifest 精确查询 Actions run ID / attempt，核对 blog SHA、工作流路径、content SHA 和 topology 来源。找不到产物时，最多查 50 个显式 dispatch 作业，运行标题只作候选，不能凭标题或 Actions 成功宣称部署成功。
- 部署证据取自 Cloudflare Pages API，而不是 GitHub 上的 Cloudflare 检查：fine-grained token 没有 Checks 权限，GitHub 官方的 fine-grained 可用端点列表也不含 check runs；Cloudflare 在 site 提交上只写检查，不写 commit status 或 GitHub deployment。查询先读取固定 `site` 项目，核对项目名、生产分支 `main` 和来源 GitHub `XAN9xXx/site`；再读取最近 25 个生产部署，只接受触发类型 `github:push`、分支 `main`、commit 等于该 site SHA 的部署，拒绝手动上传的部署。同一提交有多个部署时以最新的为准，更新的失败/进行中不能被较早的成功覆盖；历史 site 提交明确标注。
- 只有匹配部署的最新阶段为 `deploy` 成功，且正是项目的 `canonical_deployment`（当前生产部署）时，结果才是“已上线”，`productionVerified` 为 true；部署成功但已不是当前生产部署时明确标出。这核验的是 Cloudflare 记录的生产部署，不抓取页面内容，也不单独核验自定义域名解析。原发布作业的 `deployed` 仍为 false。
- GitHub 与 Cloudflare 合计最多 20 个 GET 请求；每次网络请求 8 秒超时、响应最多 2 MiB、禁止重定向；总查询时间有边界。30 秒内复用同一提交结果，同一 worker 只运行一份查询。范围外或证据不足显示“未找到可核验关联”，网络/权限/证据错误显示“查询暂不可用”；不自动重跑 CI、不重推 Git、不改变基线或正文。
- GitHub token 使用 fine-grained 类型，仅选择 `blog`、`blog-content`、`site`，Repository permissions 的 Actions / Contents 为 Read-only，Metadata 保持自动只读；不授予任何写权限。Cloudflare 使用 API token，只授予账户级 `Cloudflare Pages: Read`，账户范围限定为托管 `site` 项目的账户。工具不能自动证明用户创建的 token 恰好具备最小权限，创建时需人工核对。推荐设置有效期并提前轮换；到期只影响查询，不改变发布记录。
- 新代码和脚本获准部署后，用户在阿里云交互 SSH 中分别运行 `sudo bash /opt/xan9x-blog/workbench/set-github-read-token.sh` 与 `sudo bash /opt/xan9x-blog/workbench/set-cloudflare-read-token.sh`：前者隐藏读取 token；后者先读取账户 ID（控制台网址中的 32 位十六进制），再隐藏读取 token。不把 token 写进命令参数、环境文件、聊天或 shell 历史。脚本原子安装凭据但不重启服务；随后经批准重启 publisher 并验收。不要把本机 `gh` 登录凭据复制到 VPS。
- 未配置凭据、无已确认发布作业时，不伪造一份真实发布记录来验收；先用模拟 API、临时裸仓库和本机只读 GitHub 元数据验证。凭据已配置，经网页的生产端到端查询仍需后续真实作业。

### 状态判定与失败处理

| 展示状态 | 必须有的证据 |
| --- | --- |
| 等待确认 | 只读计划通过，尚未提交 |
| 已提交 / 等待镜像 | 雨云远端确认接受对应 content commit |
| 等待构建 / 构建中 | GitHub 镜像出现对应 commit，匹配的 Actions 作业可查 |
| 等待部署 / 部署中 | CI 构建通过，已确认生成的 site commit，部署任务能对应它 |
| 已上线 | 对应 site commit 的生产部署成功，生产版本核验通过；仅 HTTP 200 或 Actions 绿色不够 |
| 失败 / 冲突 / 被取代 | 相应阶段的明确结果；显示阶段、关联链接和可执行的下一步 |
| 状态待确认 | 网络中断、权限不足或缺失回执；不冒充成功或从头盲重试 |

若 content 已推送但 CI/部署失败，保留提交并明确失败阶段。修正或重试时使用相同固定输入与作业关联；回退内容需新的显式确认提交，不通过 reset/force-push 改写历史。部署成功也不能把私有工作区中未进入该作业的变更标为已上线。

### 分阶段落地与验收

1. **离线计划器（核对原型已实现，见上文）**：在临时 Git 仓库验证基线、差异、草稿提示、路径白名单、文件移动、完整目录一致性和过期计划。此阶段没有网络写入。
2. **本地提交执行器**：使用临时 bare remote 验证原子提交、并发冲突、无差异、重复确认、推送中断/结果不确定、进程重启，以及发布 R 时继续编辑 R2 不丢失。
3. **CI 对应关系**：单独修改 content 触发器与组装工作流、测试固定 SHA 和 provenance；实施前先检查 content 工作区，不能覆盖其中已有的未提交工作流修改。凭据、镜像 hook、远端分支及仓库可见性确认后再批准推送。
4. **真实端到端验收**：经用户确认，用指定测试文章发布；验证 GitHub → site → Cloudflare 生产版本、地图末端文章跳转、草稿不可公开访问及失败状态。未完成这一步之前，不将发布功能标为已接通。

发布范围已确认，但仓库实际可见性和生产链路仍需核验。后续需要用户参与的节点集中在：最小权限凭据的本地配置、核验镜像/Cloudflare 项目，以及批准首次真实发布。本方案本身不要求用户现在发送任何 token、密码或私钥。
