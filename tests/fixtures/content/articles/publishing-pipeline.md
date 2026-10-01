---
id: publishing-pipeline
title: 博客发布链路：从工作台到 Cloudflare Pages
description: 普通保存和发布分开：一次显式确认，如何变成内容提交、组装构建和生产部署。
pubDate: 2026-09-30
draft: false
topics: [infrastructure, cicd]
---

写文章和发布文章是两件事。工作台里的“保存”只写入私有工作区，不会碰内容仓库；只有在发布页核对冻结版本、勾选确认之后，独立执行器才会推送一次提交。

## 链路总览

1. 工作台冻结当前保存的版本，与内容仓库 main 对比，列出文章和地图的改动。
2. 确认后，执行器以快进方式把一次提交推送到自托管 Git，再镜像到 GitHub。
3. 内容仓库的工作流把这次提交的完整 SHA 交给博客仓库的组装构建。
4. 组装构建校验内容，生成 site 仓库的一次提交，并记录三个仓库的来源。
5. Cloudflare Pages 构建 site 并部署。

## 执行器只能快进推送

执行器以独立的系统用户运行，和网页进程只通过 Unix socket 通信。systemd 单元同样收紧了权限：

```ini
[Service]
User=xan9x-publisher
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/xan9x-publisher /run/xan9x-publisher
```

部署后先确认两个服务都在运行：

```bash
systemctl is-active xan9x-workbench xan9x-publisher
journalctl -u xan9x-publisher -n 20 --no-pager
```

### 只读查询

部署状态查询只发 GET 请求，结果写在 `.site-build.json` 对应的提交上。

## 怎样才算“已上线”

| 状态 | 判定依据 |
| --- | --- |
| 已推送 | 执行器确认远端 main 已快进到候选提交 |
| 构建成功 | Actions 运行与 site 记录同一个 content 提交 |
| 已上线 | 该 site 提交的 Cloudflare 部署是项目当前的生产部署 |

> 构建成功只说明产物生成了。只有当前生产部署对应这次提交，页面上看到的才是这次发布的内容。

完整记录见 [docs/workflow.md](https://github.com/XAN9xXx/blog/blob/main/docs/workflow.md)。
