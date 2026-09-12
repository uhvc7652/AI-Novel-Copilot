# P0-0 技术验证 spike 结论

> 日期：2026-09-11 · 状态：**GO**（架构按本文修正后进入 P0）
> 关联：`docs/00-requirements.md`（§6 技术架构已按本文回写为 v0.3）
> 验证方式：在 `E:\GameProject\AI-Novel-Copilot` 写出可运行插件骨架 → 构建 → 装入隔离 profile → 启动真实 DSH 实例 → HTTP 层验证

---

## 0. 一句话结论

**方案成立，且比预期顺利。** 仓库外的包可以同时做 host 插件与浏览器面板；DSH 的客户端扫描器按 Loader entry 扫描，我们手写的 bundle 被正确编入启动图并分发。唯一未闭环的是「面板在真实浏览器里渲染并点击」——受本机沙箱限制无法自动验证，已留给你一次点击确认。

三个原始风险的裁决：

| 风险 | 裁决 | 依据 |
|---|---|---|
| 客户端面板 ↔ host 通信通道 | ✅ **已解决** | 读走现成 Remote；写走自定义 HTTP 路由（两种做法都已找到确切 API） |
| 客户端 bundle 构建链 | ✅ **已解决** | 手写 tsdown 配置复刻闭包工厂协议即可，实测产物被正确加载 |
| 长文本流式性能 | ⚠️ **未验证** | 不属于本次 spike 范围，见 §6 待办 |

---

## 1. 已实测通过的部分（有证据）

### 1.1 外部包可以被安装为 bundle 并加载 host 半 ✅

```
node apps/cli/lib/bin.js plugin --profile novel add file:E:/GameProject/AI-Novel-Copilot
→ + dsh-ai-novel-copilot file:E:/GameProject/AI-Novel-Copilot
→ bundles: [@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-ai-novel-copilot]
```
`--dump-config` 中可见我们这一层：
```yaml
# == dsh-ai-novel-copilot
- id: ai-novel-copilot
  name: dsh-ai-novel-copilot
```

### 1.2 host 半的自定义 HTTP 路由可用 ✅

`src/index.ts` 里用 `ctx.webServer.register({ kind: 'prefix', path: '/novel-api', handler })` 注册，实测：

| 请求 | 结果 |
|---|---|
| `GET /novel-api/ping` | `{"ok":true,"name":"ai-novel-copilot","root":"E:\\...\\novel","method":"webserver-prefix-route"}` |
| `PUT /novel-api/file?path=chapters/v01/c0001.md` | `{"ok":true,"path":"chapters/v01/c0001.md","bytes":59}` |
| `GET /novel-api/file?path=chapters/v01/c0001.md` | 读回写入的中文正文，逐字节一致 |
| `GET /novel-api/tree?path=chapters/v01` | `{"entries":[{"name":"c0001.md","type":"file"}]}` |
| `GET /novel-api/file?path=../../etc/passwd` | 400 拒绝（路径逃逸守卫生效） |

### 1.3 客户端 bundle 被正确编入启动图并分发 ✅

认证后取回首页 HTML，`window.__DSH_BOOT__` 中我们的行：

```json
{"id":"dsh-ai-novel-copilot","url":"/plugins/??dsh-ai-novel-copilot/client.js&rev=3847ff637f922fa8-44","rev":"3847ff637f922fa8-44"}
```

同时出现在 application 批量脚本里（与内置插件同一条 combo）。取该 bundle：

- `200`，`content-type: text/javascript`
- 首行是我们写的闭包工厂头：`window.__ModuleLoader__.load({ id: "dsh-ai-novel-copilot", factory: (require) => {`
- 含 `sourceMappingURL`，内容寻址 rev 生效
- 伪造的 rev 请求返回 `404`（不会串号发旧字节）

**这证明**：包根解析（`resolveSync` + 最近 package.json）、`dsh.client` 声明、`exports["./client"]` 三环在仓库外全部成立。

### 1.4 构建链可以在仓库外复刻 ✅

DSH 自带的 `clientBundle()` 预设**不能**用于仓库外的包——它按 `globSync('packages/*/*/package.json')` 在 DSH 检出目录里反查包名，找不到就抛 `tsdown: no packages/*/*/package.json declares the name X`。

替代方案已跑通：自己写 tsdown 配置复刻**产物契约**（而不是复用预设）：

```ts
format: ['cjs'], platform: 'browser',
deps: { neverBundle: PLATFORM_MODULES },
outputOptions: {
  entryFileNames: 'client.js',
  banner: `window.__ModuleLoader__.load({ id: <pkg>, factory: (require) => {`,
  footer: 'return module.exports; } });',
  intro: 'var module = { exports: {} }; var exports = module.exports;',
}
```

产物实测：仅 `require("react")` 与 `require("react/jsx-runtime")`，两者都在平台模块表内（`packages/client/web/src/platform.ts` 的 9 项）。**没有内联任何 `@deepseek-ai/*` 值。**

> 注：`external` 顶层选项在 tsdown 0.22 已废弃，需用 `deps.neverBundle`；host 半还需 `fixedExtension: false`，否则 `type: module` 下会输出 `.mjs`，Loader 找不到 `lib/index.js`。

---

## 2. 客户端半：已在 Node 里跑通（浏览器渲染仍待你确认）

本机沙箱内 Chrome/Edge 无法以调试端口启动（`--remote-debugging-port` 被忽略、无 DevToolsActivePort 文件、无监听），因此**不能**自动做真实浏览器验证。改用等价手段补上：`spike/client-load-check.mjs` 在 Node 里桩掉 `window.__ModuleLoader__` 与 cordis ctx，执行构建产物并用 `react-dom/server` 渲染面板。

结果（**PASS**）：

```
loader registrations: 1                 id: dsh-ai-novel-copilot
factory is a function: true             exports: apply, inject
boot graph module requests: react, react/jsx-runtime
react instance shared with the renderer: true
apply() completed without throwing
  effect(novel tab type)      -> sidebarRightTabs.register(id=dsh-ai-novel-copilot kind=novel priority=extension)
                                 title() = 小说 · guide entries = 1
  effect(novel tab body)      -> slots.inject(sidebar.right.pane.tab) -> slots.register(key=dsh-ai-novel-copilot)
  effect(sidebar footer entry)-> slots.inject(sidebar.footer.action)  -> slots.register(id=dsh-ai-novel-copilot)
panel renders: <div …><button>探测 host</button>…<textarea …></textarea></div>
```

这证明：bundle 工厂可执行、只请求平台模块表内的两个模块、`apply()` 的三处注册形态与官方文档一致（`packages/client/AGENTS.md:141` 的 `ctx.slots.inject(name, () => ctx.slots.register(...))`）、面板 JSX 与 hooks 合法。

**仍未被证明的**：真实 Shell 里右侧边栏是否把我们的 tab 渲染出来、按钮点击的完整往返。这需要你的眼睛（见下）。

### 顺带发现的产品问题：入口可达性

我们的写作面板是「页面类型」的 tab，**按设计不出现在任何地方**，必须：展开右侧边栏（按钮在会话头部角落 = `conversation.session.header.corner`）→ 打开引导页 → 点「小说写作台」。两跳，且首次使用者根本不知道该往哪看。

因此已在 spike 里补了一个**常驻可见的入口**：左侧边栏页脚的「小说」按钮（`sidebar.footer.action`）。点一下就去 ping host 路由，成功显示「小说 ✓」。

> **P0 结论**：正式版本需要一个正经的前门（页脚入口 / 命令面板项 / 引导页之外的直达方式），不能只留引导页胶囊。这条已并入 P0 待办。

### 真实浏览器验证结果

- ✅ **左侧边栏页脚的「小说」按钮出现，点击后变成「小说 ✓」** —— 面板 → host 路由 → 响应的**完整往返在真实浏览器里跑通**，spike 的出口判据达成。
- ⚠️ 右侧边栏的写作台面板**当时无法验证**，原因是**没有会话**：`sidebar.right.pane.tab` 是 session 作用域槽位，没有会话就完全不渲染，连会话头部右上角的侧栏展开按钮都不存在。

### 为什么隔离实例开不了会话（重要，避免误判为 bug）

在隔离的 3099 实例上创建会话时报：

```
directory picker failed: spawn EPERM
```

根因不是 DSH 也不是插件：**该实例是本 agent 沙箱的子进程**，它的原生目录选择器（`ui-directory-picker-native`）再 `spawn` 子进程时被沙箱拦截。同一原因也让本次的 Chrome 无头验证无法进行。**用户自己启动的实例不会有这个限制。**

由此得出两条 P0 结论：
1. 验证必须在**用户自己的 profile** 里做，不能依赖 agent 沙箱内起的实例；
2. 隔离实例这条路只适合验证 host 半与静态产物（它已经完成了这个任务）。

### ⚠️ 安装方式决定"重建是否生效"（2026-09-11 踩到）

`dsh plugin add file:<本地目录>` 的实际行为取决于**profile 与源码是否同卷**：

| profile 位置 | 与源码同卷 | pnpm 行为 | 重建后 |
|---|---|---|---|
| 工作区内 `.dsh-home\profiles\*` | ✅ 同卷 | 硬链接 | ✅ 就地覆写会传过去 |
| `C:\Users\13735\.dsh\profiles\web` | ❌ 跨卷 | **复制** | ❌ 冻结在安装那一刻 |

后果很隐蔽：**同一个改动在隔离实例上立刻生效，在真实 GUI 上永远不生效**，而界面上没有任何提示。作者因此对着一个旧版面板做了验证，得出过错误结论。

**开发时一律用 `link:`**（跨卷也能建 junction，源码即真相）：

```sh
node apps/cli/lib/bin.js plugin --profile <name> add link:E:/GameProject/AI-Novel-Copilot
```

判断当前装的是哪种：`Get-ChildItem <profile>\node_modules -Force | Where Name -eq 'dsh-ai-novel-copilot'` 看 `LinkType`（`Junction` = 链接；空 = 拷贝）。或者往源码 `lib/` 放个探针文件，看它有没有出现在 profile 里。

### 已装进真实 profile

```
node apps/cli/lib/bin.js plugin --profile web add file:E:/GameProject/AI-Novel-Copilot
→ web profile bundles 追加 dsh-ai-novel-copilot（其余 11 个 bundle 与依赖完好）
```
正在运行的 3080 进程是安装前启动的，因此 `/novel-api/ping` 返回 404 —— **需要重启 DSH** 才会加载。移除方式：`dsh plugin --profile web remove dsh-ai-novel-copilot`。



---

## 3. 架构修正（基于本次验证与两路源码调研）

### 3.1 数据通道：读用现成 Remote，写走自定义路由

**读：免费。** `workspaceFiles` 这个 Remote 命名空间已经存在，客户端可直接用：

```
ctx.remote.workspaceFiles.list(sessionId, path, signal)
ctx.remote.workspaceFiles.read(sessionId, path, range, signal)   // 行窗口
ctx.remote.workspaceFiles.stat / readBytes / readAll / readRelated
ctx.remote.workspaceFiles.changes(sessionId, signal)             // 变更流
```
注意：`read/stat/readAll` **不受工作区边界约束**（只有 `list`/`changes` 受限），行窗口上限 5000 行、单页 2 MiB、整文件 32 MiB。

**写：没有任何现成通道。** 源码原话 `this service exposes no mutations`。全仓 client 可达的写入口为零。

因此写路径必须自建。**推荐改用 DSH 的 `/api` Fetch 路由**（比我现在 spike 里用的裸 `webServer` 路由更好）：

```ts
ctx.effect(() => ctx.connection.fetch.register({
  path: '/api/novel/writeChapter',
  methods: ['POST'],
  requestBody: 'buffered',
  fetch: request => handle(request),
}), 'novel: write route')
```
理由：`/api` 前缀的请求**已经过 Host/Origin 信任栅栏与认证**（`api-request-trust.ts`），而裸 `webServer` 路由需要自己调 `ctx.connection.requestRejection`。现成先例是 `file-upload` 的 `/api/session/uploadFileBinary`。

**P0 必须修的两点**（当前 spike 是简化实现）：
1. 路由前缀从 `/novel-api` 改为 `/api/novel/*`，走信任栅栏；
2. 写文件不要用裸 `node:fs`，改走 `ctx.fs.writeText(target, content, intent, signal, sandboxPolicy)`，其中 policy 由 `ctx.sandboxPolicy.resolve({ session })` 得到——这样**作者的沙箱策略真正生效**（`read-only` 下拒绝写、`workspace-write` 下限定工作区）。现在的实现绕过了沙箱，只是 spike 权宜。

**不要走的路**：自定义 Remote 命名空间虽然类型化、可流式，但 client 侧强制要求生成的严格 codec，而 typert 生成器硬编码只扫 `<root>/packages/` 并要求根上有 `tsconfig.host.json`。仓库外的包要复刻整个 monorepo 骨架，成本远高于收益。**将来需要流式时再把同一个 host 服务挂 `@Remote` 暴露，业务逻辑不用改。**

### 3.2 面板落点：右侧边栏 tab（已验证可注册）

```ts
export const inject = ['slots', 'sidebarRightTabs']
ctx.sidebarRightTabs.register({ id: PKG, kind: 'novel', priority: 'extension', title, guide })
ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: PKG }, Body))
```
- `priority: 'extension'` 是**产品外**类型的档位，按设计压过内置 `builtin`；同 kind 只能有一个 extension。
- body 是 session 作用域，props 直接带 `sessionId`，可直接拿去调 `workspaceFiles`。
- 两个 `inject` 别混：`package.json` 里的 `dsh.client.inject` 只是**模块工厂到达顺序**的信息性声明；真正的服务依赖是插件模块导出的 `inject` 数组。

### 3.3 AI 任务（P1 的地基，本次只做源码级确认）

| 问题 | 结论 |
|---|---|
| 面板按钮怎么触发生成 | 客户端 `ctx.sessions.binding(current).session.prompt(content, 'queue', signal, requestId)` → host 落到 `agent.followup()`。**天然复用当前会话模型**，符合 D4 |
| 怎么拿流式输出 | 订阅 `binding.eventSource`（`ObservableSnapshot`），**不必**耦合 Conversation 渲染器 |
| 怎么知道结束 | `turn/end` 事件的 `reason.kind`（`completed`/`error`/`aborted`/`max-tokens`…）；`prompt()` 返回只代表入队成功 |
| 两个硬约束 | ① 瞬态 chunk 在结算时被删除，**必须自己累积文本**；② 事件窗口只为**当前 staged 会话**打开，面板任务必须作用于用户正在看的会话 |
| 限定工具子集 | `ctx.tools.restrict()` 只能在 **host 侧 scoped ctx** 调用，客户端无通道 |
| 不污染主对话 | 只能换 session/独立 agent；代价是新会话进列表、模型要显式选、流式链路要自建 |

**对需求的影响**：D3 选了「面板按钮触发」，那么每次任务都会在**主会话**里留下一条 user 消息和一次完整生成记录。这可能是你想要的（可追溯），也可能不是。**这需要在 P1 开始前拍板**，三条路：
- (a) 就在当前会话跑，接受它出现在对话记录里（最省事，模型/上下文天然正确）；
- (b) host 半建独立 agent + 自建 `/api` 流式回推（干净，但要自己维护流和模型选择）；
- (c) 折中：当前会话跑，但任务记录写进 `.novel/runs/`，并在面板里展示（对话记录当审计日志）。

---

## 4. 开发与调试循环（已跑通）

```powershell
# 构建（host + client 两份产物，一个 lib/）
pnpm run build            # 或 pnpm run watch

# 装进一个 profile（**link:**，不要用 file:）
node <dsh>/apps/cli/lib/bin.js plugin --profile <name> add link:E:/GameProject/AI-Novel-Copilot

# 启动
$env:DSH_NOVEL_ROOT='E:\GameProject\AI-Novel-Copilot\novel'
node <dsh>/apps/cli/lib/bin.js --profile <name> --no-open --port 3099
```

**本机注意**：`pnpm dsh`（= `node --import tsx/esm`）在受限沙箱下会因 esbuild 子进程 `spawn EPERM` 失败；改用**已构建的** `apps/cli/lib/bin.js` 可直接绕开。

**测试隔离**：写 `C:\Users\13735\.dsh` 在工作区之外、被文件策略拒绝。本次验证用工作区内的 `DSH_HOME=E:\GameProject\AI-Novel-Copilot\.dsh-home` 起了完全隔离的实例，**没有碰你正在用的 web profile**。

### 重建什么时候生效（2026-09-11 实测补全）

> 这是「安装方式决定重建是否生效」那一条的另一半：用了 `link:` 之后，**host 半仍然需要换一个进程**。

| 半 | `pnpm run build` 之后 |
|---|---|
| 浏览器半 `lib/client.js` | 页面刷新即拿到新产物（bundle 是页面加载时向 host 取的） |
| **host 半 `lib/index.js`** | **必须换进程**：新路由/新行为不会出现在已运行的实例里 |

原因在 DSH 侧，两处源码：

- `apps/cli/src/profile-boot.ts`：`patchReload: live`（随产品交付的 `web` profile 用的就是它）在 CLI 里挂的是一个 **watch-only HMR 实例，`config: { root: [] }`** —— 注释原文「mount a watch-only instance with no module roots … cordis.patch.yml edits stay live without replacing source modules」；
- `packages/bundle/base/cordis.patch.yml`：`hmr` 行本身 `disabled: true`，注释「Module reload is opt-in per profile」。

所以「配置热重载」只管 `cordis.patch.yml`（用户 patch 层），**不替换插件的 JS 模块**。

**症状与判定**：host 半还是旧构建时，面板里新加的路由会 404，客户端报「host 返回了非 JSON 响应（HTTP 404）」（这个 API 的失败也一律是 JSON，所以非 JSON 只可能来自插件之外）。要确认**运行中的 host 半到底是哪个构建**，问 `/api/novel/ping`：它返回的 `routes` 就是该进程当前注册的路由表。

2026-09-11 的实例（M5 落地当天）：监听 3080 的进程起于 19:36:53，最后一次构建是 19:28:11 —— 同一个 `/api/novel/search` 在更早那个进程上 404、在新进程上 200。差值不在代码，在进程。客户端半那次确实也更新了（新页签出现），但**是刷新拿到的还是 `dsh-client-hmr` 自动重载的，我没有分辨**，§6 第 3 条待办不变。

---

## 5. 对需求文档的回写

`docs/00-requirements.md` §6 技术架构已更新（v0.3）：数据通道、面板落点、沙箱策略、构建方式四处按本文修正。

---

## 6. P0 开工前的待办

1. **你确认面板渲染**（§2）——唯一未闭环项，阻塞 P0 的 UI 部分。
2. 路由迁移到 `/api/novel/*` + 接入 `ctx.fs` 与 `ctx.sandboxPolicy`（§3.1 的两个必修点）。
3. 实测 HMR：`tsdown --watch` 改一行 panel 文案，看浏览器是否自动更新。
4. **M7「修改记录」的两个待确认点**（你新加的模块）：
   - 依赖写的是 `M6、M3、M5`，但我认为应为 `M0`——版本历史是编辑器的地基能力，不该等一致性检查；
   - 落盘写 `chapters/**/*.md`（diff 格式）会把 diff 文件混进正文目录，建议改到 `.novel/history/`；
   - 另外 D10 的 git 自动提交已经提供了文件级版本历史，M7 与它的边界需要说清（M7 是面板内的行级 diff/回滚，git 是文件级）。
5. **P1 的 D3 取舍**（§3.3 的三条路）需要在做生成功能前定下。

---

## 附：本次产出的骨架文件

```
E:\GameProject\AI-Novel-Copilot\
├── package.json          # dsh.bundle.patch + dsh.client + exports ./client
├── cordis.patch.yml      # 组合包层：插入 host 插件行
├── tsdown.config.ts      # 手写的双产物构建（host ESM + client 闭包工厂 CJS）
├── tsconfig.json
├── src/index.ts          # host 半：/novel-api 路由（读/写/列目录 + 路径守卫）
├── src/client/index.tsx  # client 半：注册「小说」侧栏 tab + 面板
└── spike/browser-check.mjs  # 无头浏览器验证脚本（本机沙箱内未能用上）
```
