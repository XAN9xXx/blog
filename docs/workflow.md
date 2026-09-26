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
- 独立工作台现已提供目录树、文章编辑、私有保存和地图预览；公开站点不含编辑接口。显式发布和远端部署尚未接通。

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

已实现：单用户密码登录、文章新增/编辑/删除、目录新增/重命名/移动/排序/移除、文章绑定与重新绑定、私有 Markdown 预览、完整/公开两种地图预览、私有快照下载。
未实现：远端部署、内容源变更自动合并、快照图形化导入、媒体上传、关系边的独立编辑界面、显式 Git 发布及发布状态查询。标为“非草稿”只影响模拟公开预览，不代表已发布。
RSS/sitemap/canonical 所需站点域名、移动端地图可读性和项目内容模型仍是后续工作。


## 首页音乐与本地验证

首页保持独立地图组件，文章仍从 `/notes/` 访问；下方音乐模块使用内容仓库 `music/playlist.json`。
歌单规范见内容仓库 README。音频通过 Astro 静态文件 endpoint 生成到 `dist/music/`，不需要额外服务器、第三方播放器或 Cloudflare 仓库凭据。
组装预检同样校验歌单和文件；本地无歌单的旧快照按空歌单处理，损坏歌单、无效引用或超过 25 MiB 的文件会阻止构建。
Cloudflare Pages 单资源限制依据：https://developers.cloudflare.com/pages/platform/limits/#file-size 。

验证步骤：

1. `npm run check && npm test && npm run build`。
2. `npm run dev -- --background`，打开本地 4321 端口；检查空状态、主题切换、地图钻取和文章入口。
3. 使用 `node tests/create-music-fixture.mjs` 创建临时组装站点和两段测试 WAV（不会修改正式内容或 `xan9x-site`）。按输出进入临时站点运行离线安装、构建和后台服务。
4. 指定 `BLOG_MUSIC_TEST_URL=http://127.0.0.1:4324` 后运行 `npm run test:browser`。Windows 验证使用独立无头 Edge，WSL 需自行安装对应 Playwright 浏览器。未指定 fixture URL 时两项音频测试会明确跳过。
5. 浏览器测试覆盖播放/暂停、进度、音量/静音、切歌、结束后顺序播放、错误恢复、空状态、窄屏及原地图回归。测试 WAV 只在临时目录，不进入生产歌单。
6. 临时站点验证完在其目录运行 `npm run dev -- stop`，正式本地预览可继续保留。

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

通过 `http://127.0.0.1:4325` 访问。必须使用与 WORKBENCH_ORIGIN 完全一致的地址，不能混用 localhost 和 127.0.0.1。缺少有效密码哈希会拒绝启动。进程固定监听回环地址，不会直接暴露到公网。

变量：

| 变量 | 默认值 / 约束 |
| --- | --- |
| WORKBENCH_ORIGIN | 浏览器实际使用的来源地址；SSH 转发用 http://127.0.0.1:4325，直接使用远程域名则必须 HTTPS；不能包含路径 |
| WORKBENCH_PORT | 4325，1024–65535；服务仅监听 127.0.0.1 |
| WORKBENCH_PASSWORD_HASH | 必填，使用上述命令生成；不接受明文或默认密码 |
| WORKBENCH_CONTENT_DIR | 相邻内容仓库；只读导入文章和 topology.json，不读取 Git 凭据 |
| WORKBENCH_STATE_DIR | 引擎内 .workbench；VPS 建议 /var/lib/xan9x-workbench |

仓库内状态只能位于 `.workbench/`；不能放到内容源、public、src、dist 或生成 site 中。工作台代码、构建产物、私有状态及工作台测试均由组装脚本排除。不要把真实环境文件放入公开资源目录。

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
- 会话保存在内存；重启后需要重新登录。空闲 1 小时或登录满 8 小时失效；退出立即撤销。单用户登录有全局速率限制，同一时间只执行一次密码推导。

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

示例配置在 `workbench/workbench.env.example`，systemd 模板在 `workbench/xan9x-workbench.service`。当前只有本地验证，没有安装或启动到 VPS。

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
- 浏览器到本机、SSH 服务到 VPS 本机的最后一段是回环 HTTP；跨网络的一段由 SSH 加密。两台机器都应可信，SSH 并不代替工作台密码、CSRF 校验或私有文件权限。
- `ExitOnForwardFailure` 能发现转发监听建立失败，但不能保证 VPS 上目标服务可用；还需实际打开网页或检查 HTTP。

如果本机 4325 已占用，可以把本机端口改为 14325：

~~~powershell
ssh -N -T -a -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 127.0.0.1:14325:127.0.0.1:4325 aliyun
~~~

这时浏览器使用 `http://127.0.0.1:14325`，**VPS 上的 WORKBENCH_ORIGIN 也必须改成这个地址并重启工作台**，但 WORKBENCH_PORT 仍为 4325。SSH 转发不会替你改写 HTTP Host/Origin；若仍配置旧来源，登录或保存会被 403 拒绝。不要把 WORKBENCH_ORIGIN 填成 VPS 公网 IP，也不要混用 localhost 和 127.0.0.1。变更来源后需重新登录。

### 部署后的首次密码设置与启动

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
- 专用服务用户只读代码和内容源，只写私有状态目录。生产密码由用户在 VPS 本地设置，不发送到聊天；环境文件留在仓库外并限制权限。
- HTTP 回环来源的会话保留 HttpOnly / SameSite=Strict；不设置仅用于 HTTPS 的 Secure 标记。来源与 CSRF 校验继续生效，不能为适配隧道而禁用。
- 如果 SSH 报 `administratively prohibited`，应由管理员检查有效的 AllowTcpForwarding、DisableForwarding、PermitOpen 和 authorized_keys 限制；不直接改全局 SSH 策略。若要为专用账号收窄目的地，可评估只允许 127.0.0.1:4325，但须先确认不影响已有连接用途。

上线验收顺序：

1. VPS 上确认服务只监听 127.0.0.1:4325，而不是 0.0.0.0 或公网地址；本机也只监听 127.0.0.1 的转发端口。
2. 通过隧道登录，保存一篇测试草稿、绑定目录，检查完整/公开两种预览。
3. 验证未登录不能读取工作区/导出、旧页面保存冲突不会覆盖新版本、退出后会话失效。
4. 重启工作台后重新登录，确认私有保存仍在；关闭 SSH 后本机访问中断，重新建隧道后恢复。
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
