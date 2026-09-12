# P0 实施记录

> 日期：2026-09-11 · 状态：**代码完成；覆盖写在真实环境待重验**（见 §3.1——之前那次确认测的是 spike 版）
> 关联：`docs/00-requirements.md`（v0.6）、`docs/01-spike-findings.md`（P0-0 结论）、`docs/03-project-structure.md`（格式真源）

---

## 1. 这一期交付了什么

P0 的目标是「能在面板里建工程、写章节、手动编辑、内容正确落盘为 md」。已实现的代码：

```
src/
├── index.ts              host 插件入口：把 IO 半接到 3 条 /api/novel/* 路由
├── novel/
│   ├── document.ts       frontmatter 解析/序列化（js-yaml）
│   ├── words.ts          字数统计（中文字 + 英文词），host/client 共用，无依赖
│   ├── project.ts        工程布局、章节身份推导、卷章树、脚手架内容
│   ├── io.ts             ctx.fs + 沙箱策略的读写、路径围栏、工程扫描
│   └── http.ts           路由与错误码→HTTP 状态映射
└── client/
    ├── api.ts            浏览器侧 API 封装
    ├── Panel.tsx         写作面板：工程树 + 章节编辑器 + 保存
    └── index.tsx         三处注册：tab 类型、面板、左侧页脚前门
```

### API 形状（受 DSH 约束决定）

Fetch 路由是**精确路径**、只支持 `GET`/`HEAD`/`POST`，所以：

| 路由 | 方法 | 用途 |
|---|---|---|
| `/api/novel/ping` | GET/HEAD | 连通性 + 该会话的默认工程根目录 |
| `/api/novel/project` | GET | 读工程树（标题/卷/章/字数） |
| `/api/novel/project` | POST | 初始化工程骨架（不覆盖已存在文件） |
| `/api/novel/chapter` | GET | 读一章（frontmatter + 正文 + 版本号） |
| `/api/novel/chapter` | POST | 写一章，或 `create` 追加新章 |

### 围栏设计

- 每次读写都经 `ctx.fs`，写入额外传 `ctx.sandboxPolicy.resolve({ session })` —— 作者的沙箱模式（`read-only` / `workspace-write` / `danger-full-access`）对面板与对 agent 工具同样生效。
- 每个解析出的目标都用 `ctx.fs.contains(工程根, 目标)` 校验，`../` 逃逸在沙箱之外再拦一道。
- 错误码带语义（`novel/outside-project`→403、`novel/not-found`→404、`FS_STALE_VERSION`→409…），前端按码分支而不解析文案。

---

## 2. 已验证的部分

### 2.1 客户端半（Node 内跑真实产物）

`spike/client-load-check.mjs`：桩掉 `__ModuleLoader__` 与 ctx，执行 `lib/client.js`，再用 `react-dom/server` 渲染两个注册组件。

```
boot graph module requests: react, react/jsx-runtime     ← 未引入任何额外运行时
apply() completed without throwing
  sidebarRightTabs.register(kind=novel priority=extension) title()=小说
  slots.register(sidebar.right.pane.tab, key=dsh-ai-novel-copilot)
  slots.register(sidebar.footer.action, id=dsh-ai-novel-copilot)
RESULT: PASS
```

### 2.2 host 半（真实 DSH 实例 + 真实 HTTP）

`spike/host-api-check.mjs`：用启动 token 换取浏览器会持有的 cookie，跑完整流程。

| 操作 | 结果 |
|---|---|
| ping | ✅ 返回默认工程根 |
| 打开空工程 | ✅ 0 章 |
| 初始化工程 | ✅ 建出 `novel.yaml`、`settings/world.md`、`outline/*`、`style/style-guide.md`、`chapters/v01/c0001.md` |
| 读章节 | ✅ frontmatter + 正文 + 版本号 |
| 新建章节 | ✅ 自动编号为 c0002 并出现在树里 |
| 再读工程树 | ✅ 2 章 |
| 路径逃逸 `../../etc/passwd` | ✅ 400 `novel/not-a-chapter` |
| 读取不存在的章 | ✅ 404 `novel/not-found` |
| **覆盖写已有章节** | ⚠️ 见 §3 —— 已确认为本机沙箱问题，真实环境通过 |

---

## 3. 覆盖写：已确认是本机沙箱限制（P0 无遗留问题）

**现象**（当时）：新建文件成功，替换已有文件失败，错误来自 `fs-local` 原子写路径的 Windows DACL 拷贝步骤：

```
EACCES SetFileSecurityW (Win32 5):
  ...\.spike-novel\chapters\v01\.c0002.md.<pid>.<uuid>.tmpdir\c0002.md.tmp
```

**排除过程**：
1. 同一个子进程里，`node:fs` 的创建 + 覆盖写**完全正常** → 文件系统不是只读，失败点只在安全描述符 API。
2. 新建走的是同一套 `ctx.fs.writeText`，成功 → 调用路径本身没问题，差异只在 `fs-local` 的「替换」分支（要拷贝原文件 DACL）。
3. 本机测试实例是 agent 沙箱的子进程，而该沙箱此前已拦掉：目录选择器 `spawn EPERM`、Chrome 调试端口、esbuild 子进程。

**结论**：本机测试沙箱内的失败原因已排除清楚（见上），但**作者那次"保存成功"的确认已作废**——见 §3.1。

### 3.1 那次确认测错了对象（2026-09-11 发现）

作者在 GUI 里看到的其实是 **P0-0 spike 版面板**（标题写着 "AI-Novel-Copilot spike"），因为 web profile 里装的是**一份 12:54 的拷贝**，之后每次 rebuild 都没到达 GUI。spike 的 host 用 `node:fs` 直写（没有 DACL 拷贝那一步），所以"保存成功"证明的是旧路径，**P0 的 `ctx.fs.writeText` 写路径在真实环境里仍未验证**。

根因是 pnpm 安装方式跨卷退化：

| profile 位置 | 与源码同卷 | pnpm 行为 | 重建后是否生效 |
|---|---|---|---|
| `E:\...\.dsh-home\profiles\novel` | ✅ E 盘 | 硬链接 | ✅ 就地覆写会传过去 |
| `C:\Users\13735\.dsh\profiles\web` | ❌ 跨卷 | **复制** | ❌ 冻结在安装那一刻 |

**修法**：改用 `link:` 协议让 profile 指向源码（已验证生效，profile 里现在是 junction）：

```sh
node apps/cli/lib/bin.js plugin --profile web add link:E:/GameProject/AI-Novel-Copilot
```

**状态**：✅ 已重验通过（2026-09-11）。作者在装成 `link:` 之后的真实 GUI 里**改名成功**（书名从「未命名小说」变成《无命》）。该操作走 `POST /api/novel/meta` → `ctx.fs.writeText` **替换已有 `novel.yaml`**，正是之前有疑问的那条路径。故 DACL 一条确认为本机 agent 沙箱的限制，写入在真实环境正常。

---

## 4. 本期新踩到的 DSH 约束（值得记住）

1. **同时服务 GET 和 POST 的 Fetch 路由必须 `requestBody: 'buffered'`。**
   路由的 body 模式是「每个路由一个值」，不区分方法；`streaming` 模式下桥接层会无条件给请求挂 body，而无 body 的 GET 挂 body 违反 Fetch 规范，构造 `Request` 时抛错，最终表现为**没有任何解释的 400**。
   顺带修正一个错误假设：缓冲模式上限是 **300 MiB**，不是小 JSON 上限，章节正文完全够用。
2. **`/api` 通道带认证与信任栅栏**：未带 cookie 一律 401。这正是把写通道从裸 `webServer` 路由迁过来的收益——旧路径没有任何认证。
3. **Fetch 路由是精确路径匹配**，没有 prefix 形式；一处注册一个路径。

---

## 5. 进入 P1

P0 已闭合，两个前置问题也已定：M7 的两处修正已写入需求文档；**P1 的执行器路径**见下。

**P1 执行器决定（2026-09-11）**：AI 任务在**当前会话**里跑，实现全部落在客户端，host 半一行不加：

```ts
ctx.sessions.binding(sessionId).session.prompt(content, 'queue', signal, requestId)
// 流式：订阅 binding.eventSource，累积 text-delta；turn/end.reason 判定结束
```

原因：这条路复用当前会话的模型（D4 字面成立），且**已有验证过的 API**，不需要 host 半去 import 任何 DSH 内部包——我们的包是 `file:` 链接的，Node 按真实路径解析，根本看不到 profile 的 `node_modules/@deepseek-ai/*`，所以 host 侧驱动模型要么依赖 Typert 代码生成，要么依赖版本敏感的重复安装，都不划算。

代价：生成会出现在当前会话记录里。**因此执行器做成可替换接缝**（任务定义与执行分离，见需求 §5），等上下文膨胀真成为问题，再换成 host 侧独立 agent + 自建流式通道，任务定义不用改。

P1 的另一个现成基础：`fs-local` 的写入结果已带 `before`/`after` 全文（`FsWriteOutcome`），D9 的 diff 预览与 M7 的版本记录可直接建在它上面。
