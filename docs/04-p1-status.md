# P1 状态：生成闭环

> 日期：2026-09-11 · 状态：**P1 完成**（作者在真实 GUI 确认续写链路可用）
> 关联：`docs/00-requirements.md` §5（任务模型）、`docs/02-p0-implementation.md`（P0）、`docs/03-project-structure.md`（格式真源）

---

## 1. 执行器决定（2026-09-11）

AI 任务在**当前会话**里跑，实现全部落在客户端，host 半一行不加：

```ts
ctx.sessions.binding(sessionId).session.prompt(content, 'queue', signal, requestId)
// 流式：订阅 binding.eventSource，累积 text-delta；turn/end.reason 判定结束
```

**为什么不用 host 侧独立 agent**：我们的包是 `file:` 链接安装的，Node 按真实路径解析，**看不到 profile 的 `node_modules/@deepseek-ai/*`**。所以 host 侧要驱动模型，要么走 Typert 代码生成（要求复刻 monorepo 骨架），要么依赖版本敏感的重复安装并 import `createUserMessage` 之类的内部值——都不划算。客户端这条路复用当前会话的模型（D4 字面成立），且 API 已验证。

**代价**：生成会出现在当前会话的对话记录里。
**因此**：`src/client/runner.ts` 是**执行器接缝**——任务定义（`tasks.ts`）与执行分离，将来换成 host 侧独立 agent + 自建流式通道时，只改 runner，任务定义不动。

### 1.1 这个决定是错的（2026-09-11，有硬证据）

作者点「续写」两次，两条任务留痕的 `output` **都不是小说正文，而是本 agent（编码助手）写的聊天消息**：

| 记录 | output 内容 |
|---|---|
| `…06-08-19…-continue.json` | 我那条「这个 prompt 很难看——你说得对…」 |
| `…06-17-35…-continue.json` | 我上一条「这次 prompt 是干净的…」 |

**根因**：作者点任务时，提示词被送进的「当前会话」**正是他与我（编码 agent）对话的这个会话**。于是

1. **回答者不是小说写手，是编码 agent**——系统提示词是编码 agent 的，历史里全是 DSH 内部机制的讨论，输出自然是"关于插件的评论"。
2. **流式关联也抓错了轮次**：`runner.ts` 按 turn 号基线关联，当我正在流式输出时点按钮，基线算低了，于是把我正在流出的消息当成了任务输出。
3. **反向污染**：每次点击都往作者与编码 agent 的对话里插一条小说提示词。

我当初把「在当前会话里跑」说成"代价只是生成会出现在对话记录里"——**低估了**。真正的代价是它根本不是写手在回答。

**处置**：任务按钮先停用（`TASKS_ENABLED = false`），随后按下节换成独立写作 agent 并重新开放。

### 1.2 新执行器：host 侧独立写作 agent（已实现并验证）

需求 §5 本来就写着"上下文只来自**显式装配的工程文件**"，而旧执行器用的是会话历史——**是执行器违背了自己定的规矩**。新执行器每次任务建一个独立 agent：

```ts
ctx.agents.create({
  sessionId, meta: {},                       // 不设 cwd → 不进作者侧栏
  agentOptions: <读自当前会话的 provider/model>,   // D4
  setup: agentCtx => {
    agentCtx.systemPrompt.section({ name: 'novel-copilot/writer', order: 0,
                                    complete: true, text: WRITER_SYSTEM_PROMPT })
    agentCtx.tools.restrict({ allow: [] })
  },
})
ctx.sessionController.prompt({ requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] })
// 流式：ctx.on('agent/assistant-stream') 按子会话 id 过滤
// 结束：ctx.on('session/event') 的 turn/end；随后 handle.dispose()
```

三个关键点：

- **`complete: true`**：把这条段落当作**完整**的系统提示词，部署的编码指令不再被装配进来。这是"它真的是小说写手"的机制保证。
- **零 import**：创建、发提示词、注册段落、限制工具全是服务调用，不需要 `createUserMessage` 之类的内部值——这正是当初排除这条路的原因，而它其实不成立。
- **不设 `cwd`**：会话列表只列有 cwd 的会话，所以写作 agent 不会出现在作者侧栏里。

进度回传用**轮询**（250ms）而不是 SSE：刚在流式关联上栽过一次，一个"迟到的读者也能读到全文"的累积缓冲，比少 200ms 延迟更值钱。

**烟雾测试（真实模型，已通过）**：

```
POST /api/novel/task  → {"ok":true,"runId":"fb5af4c5-…"}
+2 chars: "接通"
done. reason: completed | error: (none)
```

提示词是「只输出两个字：接通」，它就只输出了"接通"——**没有像编码 agent 那样评论**，说明 `complete` 段落生效。

**踩到的一条**：cordis 里用 `ctx.agents` 之前必须把它声明进插件的 `inject`，否则报 `cannot get property "agents" without inject`。host 半的 inject 因此补成了
`['connection','fs','sandboxPolicy','sessions','agents','sessionController']`。

### 1.3 修正：上面那条「不设 `cwd`」是错的（2026-09-11，P2 期间）

本节原来写着「**不设 `cwd`**：会话列表只列有 cwd 的会话，所以写作 agent 不会出现在作者侧栏里」——**这个假设没有验证过，而且是错的**。作者在 P2 验证时点「按章纲写整章」，侧栏就多出一条会话，点它报：

```
历史加载失败：session "novel-a53fbf90-…" not found（session/not-found）
```

实际机制是：host 对每次 `session/created` 都广播 `api-session/added`，而侧栏隐藏会话**只看** header 的 `origin: 'subagent'`；没有 `cwd` 只让它「打不开」，不会让它「不出现」。修法与证据见 `docs/05-p2-implementation.md` §1.3：写作子会话现在按 DSH 自己的一次性子代理来创建（`origin` + `parentSession` + 描述符），提示词改走子会话自己的 `followup`，`sessionController` 也从 inject 里去掉了。

**教训**：把「大概是这样的」写成「所以」只是一句话的事，代价是作者点一下按钮就撞上一个内部错误。凡是要写进文档的机制结论，要么有实测，要么标明是待验证假设。

---

## 2. 这一期做了什么

### 2.1 任务定义（`src/client/tasks.ts`）

三个任务，每个都做**显式输入装配**（需求 §5）：返回 prompt 与"读了哪些文件、为什么读"的清单，面板可展开给作者看。

| 任务 | 应用方式 | 读什么 |
|---|---|---|
| 续写 | 追加到正文末尾 | `novel.yaml`、`style/style-guide.md`、`outline/volumes/vNN.md`、本章（章纲 + 正文末尾 1500 字） |
| 改写 | 替换正文 | 同上（正文取全文），要求情节与信息量不变 |
| 扩写 | 替换正文 | 同上，目标篇幅为原字数的 1.5 倍，不新增情节转折 |

所有任务共用输出约束：直接输出正文、不复述、不加标题或总结句、保持人称与视角一致。

### 2.2 执行器（`src/client/runner.ts`）

- **关联方式按 turn 号**而非 requestId：取窗口里已有的最高 turn 作为基线，只接受高于基线的 `text-delta` 与 `turn/end`。即使后面排着别的轮次也不会串。
- **自己累积文本**：瞬态 `assistant/live-chunk` 行会在结算时被会话删除，所以边流边累积，事后不回读。
- `cancel()` 停止监听并 abort 请求。

### 2.3 面板（`src/client/Panel.tsx`）

生成 → 流式显示 → 结算后进预览区 → **采纳/放弃**。采纳只把文本写进**编辑器缓冲区**（变成未保存修改），文件仍由 P0 的保存路径写。**AI 永远不直接落盘**（D9）。

预览区下方的「这次喂了什么」可展开查看输入清单。

### 2.3.1 类型检查（新增，2026-09-11）

此前这个仓库**从没跑过 `tsc`**——只靠构建（不做类型检查）和两个运行期检查脚本。代价立刻显现：

**现象**：续写按钮一直是灰的。
**原因**：换成独立 agent 后我从 `PanelProps` 删掉了 `sessions`，但**解构与按钮的 `disabled` 条件里还留着它**：

```tsx
export function Panel({ sessionId, sessions }: PanelProps)   // ← 已不在 props 里
disabled={busy || running || sessions === undefined}         // ← 恒为真 → 永远禁用
```

`client-load-check.mjs` 没抓到，因为**任务行只在打开章节后才渲染**（`open !== undefined`），而检查脚本渲染时没有章节——那段 JSX 一次都没被执行过。**渲染通过 ≠ 分支被执行。**

**处置**：补上 `pnpm run typecheck`（`tsc --noEmit`）、新增 `@types/node`、并开 `allowImportingTsExtensions`（全文用显式扩展名）。当前 **exit 0，零错误**。今后改完先跑它。

### 2.4 host 侧的新路由

| 路由 | 方法 | 用途 |
|---|---|---|
| `/api/novel/text` | GET | 读工程内任意文本文件（任务装配用）；文件不存在返回 `exists:false` 而非报错 |
| `/api/novel/meta` | POST | 合并式修改 `novel.yaml`（改名等）；只动传入字段，其余原样保留 |
| `/api/novel/run` | POST | 把任务留痕写进 `.novel/runs/<时间戳>-<任务>.json`（输入清单、提示词、原始输出、结束原因） |

### 2.5 由一份 prompt 转储查出的真 bug

作者把「续写」实际喂进去的 prompt 贴了回来，暴露两件事：

**① `novel.yaml` 的字段一直被忽略（真 bug）。** 脚手架写的是**裸 YAML**（没有 `---` 围栏），而 `projectMeta` 用 frontmatter 解析器读它——找不到围栏就返回空对象，于是 `title`/`genre`/`targetWords` **全部落到兜底值**，书名永远显示「未命名小说」，就算作者手改了文件也读不到。

修法：`document.ts` 新增 `parseYamlData`/`serializeYamlData` 两个数据文件专用的读写函数，`projectMeta` 与 `writeMeta` 改用它。已实测：修复后 `/project` 正确返回 `title: "测试之书"`、`genre`、`targetWords`。

序列化时 `sortKeys` 关掉——作者手写的文件不该因为改一个字段就被重排。

**② prompt 里全是空模板与机器字段。** 见下。

### 2.6 任务装配的两处修正

- **空模板不再进 prompt**：剥掉 frontmatter、标题行、以及「`- 人称与叙述距离：`」这类只有标签没有值的条目后，若什么都不剩就判定为"还没填"，跳过它——既不进 prompt 也不进「这次喂了什么」。
- **不再倾倒 `novel.yaml`**：改用 host 已解析的工程元数据，渲染成一句人话（`【作品】《书名》 · 体裁 · 全书目标约 N 万字`）。原来的做法把 `currentVolume: 1`、`targetWords: 1000000` 这类机器字段直接丢给模型，对"怎么写这一章"毫无信息量。

### 2.7 顺手补的两个缺口

- **书名可改**：面板工程树标题位置变成可编辑输入框 + 「改名」按钮，走 `POST /api/novel/meta`。
- **空工程目录守卫**：以前根目录为空时保存会把空值发出去、换回一句 `缺少参数 root`。现在面板在本地拦截并明确提示「保存前请先点『打开』或『初始化』」，不发请求。

---

## 3. 已验证

| 项 | 结果 |
|---|---|
| 客户端 bundle 依赖边界 | ✅ 只 `require("react")` 与 `react/jsx-runtime`；js-yaml 未泄漏进浏览器 |
| host 半依赖 | ✅ js-yaml 保持外部依赖（真实安装在包目录） |
| 客户端注册 | ✅ 4 处注入（slots/sidebarRightTabs/sidebarRight/sessions），三处注册形态正确，两个组件渲染通过 |
| `GET /api/novel/text` | ✅ 读到 `novel.yaml`、`style-guide.md`；缺失文件 `exists:false` 且不报错 |
| `novel.yaml` 字段解析 | ✅ 修复后 `/project` 返回 `title: "测试之书"` + `genre` + `targetWords`（修复前全是兜底值） |
| 改名合并保真 | ✅ `spike/yaml-merge-check.cjs`：只改标题，`genre`/`targetWords`/`currentVolume` 的值与类型全部保留 |
| 空模板过滤 | ✅ `spike/substance-check.mjs`：三种空模板判定为无内容，两份填过的判定为有内容 |
| `POST /api/novel/meta`（替换已有 `novel.yaml`） | ⚠️ 本机沙箱内被 DACL 权限拦截（与保存同一原因），待作者环境确认 |
| 路径逃逸 | ✅ `../../../etc/hosts` → 403 `novel/outside-project` |
| `POST /api/novel/run` | ✅ 落盘 `.novel/runs/2026-09-11T05-52-51-314Z-continue.json` |

### 3.1 踩到的坑：`slots.register` 的 `inject` 必须是工厂函数

**现象**：标签页面板完全空白，页脚按钮也失效。控制台报

```
TypeError: inject is not a function
    at runInject (scoped-slots.tsx:112:29)
slot entry crashed in 'sidebar.footer.action'
slot entry crashed in 'sidebar.right.pane.tab'
```

**原因**：`ctx.slots.register(options, Component)` 的 `options.inject` 必须是**函数** `(...args) => face`，框架每次渲染调用它、把返回值展开成组件 props。传对象就会在渲染时抛错。我照抄 `ui-sidebar-files` 时看错了——那里的 `filesFace(...)` 返回的正是函数。

**两条教训**：
1. DSH 的槽位框架会**按条目捕获崩溃**（`slot entry crashed in '<slot>'`），所以坏掉的注册只让那一块变空白，不会拖垮整个界面——排查时要看控制台而不是猜测。
2. 已把这条契约写进 `spike/client-load-check.mjs`：`inject` 不是函数就直接 FAIL，不让同类错误再溜过去。

**未验证（需真实浏览器 + 真实模型）**：点击「续写」→ 流式预览 → 采纳 → 保存 的完整链路。这必须在你的 GUI 里跑，因为我的沙箱起不了可用会话。

---

## 4. 请你验证

1. 重启 DSH（当前进程还是上一版代码）
2. 打开或初始化一个工程 → 打开一章
3. 点**续写** → 预览区应开始流式出字 → 结束后出现**采纳/放弃**
4. **采纳** → 正文进入编辑器且标记未保存 → **保存** → 落盘
5. 展开「这次喂了什么」应列出本次读到的文件

注意：这次生成会作为一轮对话出现在**当前会话记录**里——这是本版执行器的已知取舍，不是 bug。

---

## 5. 之后

- 若上下文膨胀成为实际问题 → 换执行器（见 §1），任务定义不动。
- P2（设定库 + 大纲编辑 + 按 beats 生成整章）尚未开始；`/api/novel/text` 已经是它的读取基础，还缺一条目录列举路由。
