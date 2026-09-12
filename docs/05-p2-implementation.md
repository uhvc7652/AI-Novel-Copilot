# P2 状态：设定与大纲编辑

> 日期：2026-09-11 · 状态：**代码完成，检查全绿；真实 GUI 链路待作者验证**（见 §5）
> 关联：`docs/00-requirements.md` §4（M1/M2）、§5（任务模型）、`docs/03-project-structure.md`（格式真源）、`docs/04-p1-status.md`（P1 执行器）

---

## 1. 这一期做了什么

需求 §7 对 P2 的判据是「设定卡和大纲都能在面板里维护，AI 按章纲生成整章」。三件事对应三个新表面，共用一个工程树：

| 表面 | 内容 | 落在哪 |
|---|---|---|
| 正文 | 章节编辑器 + 四个正文任务（新增**按章纲写整章**） | `src/client/Panel.tsx` |
| 设定 | M1 完整 CRUD：卡列表（按类型分组）、卡编辑、新建、**存档/恢复**、反向链接 | `src/client/SettingsView.tsx` |
| 大纲 | M2：全书主线、卷纲、章纲（`beats` 逐条增删改序）、卷章树 | `src/client/OutlineView.tsx` |

三个任务输出**共用一条任务条**（`src/client/TaskBar.tsx`）：装配 → 流式 → 预览 → 采纳/放弃，「这次喂了什么」始终可展开。

### 1.1 新增文件与职责

```
src/novel/paths.ts        卡类型/卡路径/文档白名单/slug 校验/大纲路径（零依赖，浏览器也用）
src/novel/project.ts      ChapterSummary 补 beats/summary/pov/characters/locations；
                          卡摘要 summarizeCard、分组 groupCards、反向索引 referenceIndex
src/novel/io.ts           通用文档读写、目录列举、设定库扫描（含 appearsIn）、建章扩展
src/novel/http.ts         /api/novel/doc、/api/novel/dir、/api/novel/cards；/chapter 的 create 扩展
src/client/api.ts         上述路由的浏览器侧封装
src/client/tasks.ts       三种输出类型的任务定义（prose / doc / plan）
src/client/plan.ts        拆章 JSON 的宽容解析（围栏、闲聊、单条 beat 都能吃）
src/client/TaskBar.tsx    任务条：跑任务、流式、预览、采纳、拆章确认、建章
src/client/SettingsView.tsx  设定库
src/client/OutlineView.tsx   大纲与章纲
src/client/ui.ts          共享内联样式、状态标签、PanelEnv（视图与面板之间的唯一接口）
```

### 1.2 新增路由

| 路由 | 方法 | 用途 |
|---|---|---|
| `/api/novel/doc` | GET | 读任意可编辑文档（frontmatter + 正文），白名单见 §2.2 |
| `/api/novel/doc` | POST | 写同一批文档；`createCard` 分支新建设定卡（校验 slug 与重名） |
| `/api/novel/dir` | GET | 列目录；目录不存在返回 `exists:false` 而不是报错 |
| `/api/novel/cards` | GET | 设定库：按类型分组的卡 + 反向链接 `appearsIn` + 两个单文件页 |
| `/api/novel/chapter` | POST | `create` 扩展：接受 `beats/characters/locations/summary/pov/number/targetWords` |

**为什么文档只用一条通道**：章节、设定卡、大纲在格式上是同一个形状（frontmatter + 正文），三种类型各开一条路由只会把同一段解析与围栏代码抄三遍。白名单留在 host 半，面板不必自己再守一道。

### 1.3 作者验证时抓到的真 bug：写作子会话出现在侧栏且打不开（同日修复）

作者点「按章纲写整章」后，侧栏多出一条会话，点它报：

```
历史加载失败：session "novel-a53fbf90-…" not found（session/not-found）
```

**根因是 P1 的一个错误假设**（`04-p1-status.md` §1.2 写着「不设 `cwd` → 不进作者侧栏」）：

1. host 对**每一次** `session/created` 都广播 `api-session/added`（`api/session-controller/src/index.ts`），浏览器据此把会话并入列表；
2. 浏览器侧栏隐藏会话的机制**只有一个**——`ui-workspace/src/client/tree.ts` 的 `sessionVisible` 判 `session.origin !== 'subagent'`。`cwd` 有无根本不是过滤条件；
3. 于是这个无 `cwd`、无分类的子会话既进了列表，又打不开：Session API 用 `header.cwd === undefined` 判定「不存在」（`api/session-controller/src/agent.ts`），报 `session/not-found`。

磁盘上的证据也能看到：两条旧会话躺在 `~/.dsh/sessions/_no-cwd/novel-*/`。

**修法**：让写作子会话成为它本来就是的东西——作者会话下的**一次性子代理（one-shot subagent）**，按 DSH 自己的 in-process 驱动（`subagent/subagent-in-process-driver/src/index.ts`）的同一套做法：

| 做法 | 为什么 |
|---|---|
| `meta.origin = 'subagent'` + `meta.parentSession = <作者会话>` | 这是侧栏唯一的隐藏开关；记录改由父会话的目录树寻址 |
| `meta.cwd = 作者会话的 cwd` | 记录不再是无 cwd 的孤儿；与官方驱动一致 |
| 初始轮次里追加 `subagent/descriptor` 事件（`{version:3, mode:'one-shot', provider:'novel-copilot', label}`） | 有身份的子会话记录才会被列成「子代理」，否则冷读会判成「会话记录损坏」 |
| 提示词改走**子会话自己的 `followup`** | Session API 会拒绝按普通 id 驱动子代理会话（`session/agent-busy`）——这条拒绝正是我们要的分类 |

两个实现细节：

- **`createUserMessage` 不能 import**（`@deepseek-ai/dsh-llm` 解析不到），所以消息在本地构造：`{id, role:'user', content:[{type:'text',text}], source:{kind:'user'}}` 并深冻结。这是本期唯一一处「抄了 DSH 的值形状」，`format-check.mjs` 用 8 条断言盯住它（字段集、冻结、id 唯一、描述符版本与字段集）。
- **描述符落成是尽力而为**：pre-step 钩子与首个流式分片两条路径各试一次（都在初始轮次内），钩子注册还包了 try/catch——钩子契约变了只该损失目录行，不该让任务失败。`host` 半边因此不再 inject `sessionController`。

**旧会话怎么办**：`novel-*` 那两条已经写进磁盘，插件不能删（`ctx.fs` 没有删除原语，见 §2.1）。在侧栏里归档它们，或删掉 `~/.dsh/sessions/_no-cwd/novel-*/` 两个目录即可。

### 1.5 顺手修的视觉 bug：采纳按钮一直是灰的

作者反馈：预览区的「采纳」看着像禁用（灰的），但点得动。

原因不在逻辑而在样式：那一行按钮被放进了一个复用 `metaLine`（`opacity: 0.7` 的**文字**样式）的容器里，而 CSS 的 `opacity` 会被所有子元素继承——于是按钮、复选框跟着一起变淡。同样的写法还在设定页的「出现在：」章节按钮和两个「已存档」复选框上。

修法：`ui.ts` 拆出 `controlRow` / `checkLine` / `caption`——**布局与文字变暗分开**，`metaLine` 只留给纯文字，并在它的文档注释里写明这条约束。

**这类 bug 任何渲染检查都看不见**：markup 是对的、处理器也触发了，只有像素错了。所以 `client-load-check.mjs` 加了一条**源码规则**：以 `metaLine` 样式打开、且没有在同一样式行内闭合的元素，若在它自己闭合之前出现 `button/input/select/textarea`，就 FAIL。规则自带三条自测（旧形状必须被抓到、修好后的形状不能误报、自己闭合的文字行不能替兄弟控件背锅）——检查脚本里的规则同样会写错，§3.3 第 4 条已经吃过一次这个亏。

### 1.6 三个使用上的细节（作者提的）

**① 采纳按钮挪到最后。** 原来「采纳/放弃」在预览框的**顶部**，作者读完下面那一段正文还得往回滚。现在决策行在正文之后、「这次喂了什么」之后——读完就是按钮。拆章的「建章（N）」同样是列表之后才出现。

**② 记住打开过的工程。** 面板以前只记住输入框里的**字符串**，重开标签页等于回到一个路径，还得自己找书。现在新增 `src/client/projects.ts`：打开成功的工程写进 `localStorage`（按 root 去重、最多 8 个、最新的排前），面板上多一行「打开过：」按钮，每次打开标签页还会**自动读回上次那本**。

只自动打开**真正打开过**的工程，输入了但没读过的路径仍只是文本——否则一个错字会在挂载时变成一条报错。磁盘格式一个字没动：这是纯客户端记忆，落在浏览器的 `localStorage` 里。

**③ 可以直接选文件夹。** 工具栏加了「选择文件夹」，走的是 shell 自己的选择器（工作区侧栏用的同一个）：`uiWorkspace.pickDirectory()`。

这里有个刻意的取舍：**没有把它写进 `inject`**，而是用 `ctx.get('uiWorkspace')` 读。cordis 的 `inject` 是硬依赖——声明了它，一个没装目录选择器的部署会**整个插件不加载**；而作者要丢的只是一个按钮。`ctx.get` 的语义正是「Read a service from the store **without** the inject requirement」，查不到就退化成一句提示（「这个部署没有装目录选择器，请直接填路径」）。查表发生在点击时，所以两个插件的激活顺序也无所谓。

### 1.7 章节也能「删」了：存档（作者反馈）

作者问：好像没有删除章节的功能。

**能给的答案是「没有删除原语」**。重查过一遍（不是凭印象）：`ctx.fs` 的能力面只有 resolve / stat / lstat / list / read / write / edit 与 `contains`（`packages/fs/fs/src/index.ts`），API 侧的 `workspace-files`、host 侧各包都没有任何删除文件的动词——DSH 刻意不给文件删除能力，给 agent 的文件工具也一样。而 P0 定的规矩是「`ctx.fs` + 沙箱策略是唯一的门」，绕过去拿 `node:fs` 删文件，等于把作者对自己文件说的话作废。所以给的是和设定卡同一套办法：**存档**。

具体行为：

| 位置 | 存档一章之后 |
|---|---|
| `chapters/v01/c0002.md` | 多一行 `archived: true`，正文与其他字段一字不动 |
| 章节树 | 该章退出默认列表；标题行右侧出现「已存档」+「显示已存档」开关，勾上就回来（半透明显示） |
| 章数与字数 | 从 `chapterCount` / `wordCount` 里去掉，改记在 `archivedCount` / `archivedWords`（面板在统计行里显示「已存档 N 章 / M 字」） |
| 章号 | **不释放**：下一章照旧是 `c0004`。这样恢复它不会撞上任何人的引用，也不需要重编号 |
| 任务 | 「上一章」锚定会跳过它（接着**还能读到的**那一章写）；卷纲/拆章的「已写章节」名单里也不再有它 |
| 大纲页 | 章节列表不列（那是排章用的地方），要找回或恢复去正文页 |
| 面板操作 | 正文编辑区右下角「存档本章」（带一次确认，说明可恢复），打开已存档的章时按钮变成「恢复本章」，正文上方有一行说明 |

host 侧因此多了一个契约：`ProjectSnapshot` 的 `volumes` **包含**存档章（各自带 `archived` 标记，怎么处理由面板决定），而 `chapterCount`/`wordCount` 只算活着的章，另加 `archivedCount`/`archivedWords` 两个计数。**列表与计数分离**是刻意的：面板需要看到存档章才能提供「显示已存档」，而书稿的篇幅统计不该被撤掉的章节撑大。

`format-check.mjs` 加了 8 项盯这条线：`archived` 只认布尔真值、存档章退出计数但留在树里、存档不释放章号、续写跳过已存档的上一章、拆章不把存档章算作已排的章。

---

## 2. 三个需要记录的决定

### 2.1 「删」= 存档，因为 `ctx.fs` 没有删除

`ctx.fs` 的能力面是 `resolve / stat / lstat / readText / streamText / listDir / contains / writeText / editText`（`packages/fs/fs/src/index.ts`），**没有任何 unlink/rm/move**；DSH 给 agent 的文件工具同样只有 read/write/edit。而 P0 定下的规矩是「`ctx.fs` + 沙箱策略是唯一的门」，绕过它去 `node:fs.unlinkSync` 等于把作者的文件策略作废。

所以 M1 的「删」实现为**存档**：卡上加 `archived: true`，面板默认不列，勾「显示已存档」可恢复。

两个细节值得记住：

- **用独立字段而不是 `status: archived`**：伏笔卡的 `status` 是生命周期（`planted`/`reinforced`/`paid`/`abandoned`），一个字段扛两种含义，格式就开始撒谎。
- **这是本期的唯一功能降级**：真删除得由作者在文件管理器里做，或等 DSH 提供删除原语。`docs/03-project-structure.md` §4.3 已记下这个字段。

### 2.2 文档白名单是四棵树

`isDocumentPath` 只放行 `chapters/ settings/ outline/ style/` 下的 `.md`。`novel.yaml` 走它自己的 `/meta` 路由（它是纯 YAML 数据文件，不是 frontmatter 文档——这正是 P1 §2.5 那个真 bug 的教训），`.novel/` 是机器数据，一律进不来。路径仍然先过 `ctx.fs.contains` 再落到 `ctx.fs`，`../` 逃逸在沙箱之外还有一道。

### 2.3 任务输出分三类，因为「落盘策略」不同（需求 §5）

| kind | 例 | 采纳后去哪 | 谁落盘 |
|---|---|---|---|
| `prose` | 按章纲写整章、续写、改写、扩写 | 编辑器正文缓冲（替换或追加） | 作者点保存 |
| `doc` | 续写卷纲、续写主线 | 大纲编辑区缓冲 | 作者点保存 |
| `plan` | 按卷纲拆章 | 不落盘：渲染成待确认章节清单 → 建章 | 建章走 `/chapter` 的 `create` |

`plan` 是唯一一条「模型输出结构化数据」的路。解析刻意宽容（剥围栏、剥前后闲聊、`beats` 给字符串也当一条），失败一律返回一句人话而不是抛栈——因为最坏情况是模型没按格式回，作者该看到的是「输出里没有可解析的 JSON 数组」，并保留原始输出可查。

**装配仍然是显式的**：每个任务返回 `inputs`，面板照旧展示。「按章纲写整章」就是需求 §5 那个例子的完整版：全书主线 + 卷纲 + 本章 `beats` + 出场角色卡（最多 6 张，按 `characters`/`pov` 顺序找卡）+ 上一章 `summary` 与末尾 800 字 + 文风规则。

### 2.4 顺手补上：`wordCount` 终于真的由工具维护

格式 §4.2 写着 `wordCount` 是「由工具维护，不手写」，但从 P0 起没有任何代码写它。P2 在**两条写入路径**上盖章（`writeChapter` 与 `writeDocument`）：如果只在正文保存时盖，从大纲页改一次 `beats` 就会留下过期字数，这个字段就开始撒谎。章纲编辑与正文编辑写的是同一个文件，所以两处都盖。

---

## 3. 已验证

`pnpm run check` = `typecheck` + `build` + `check:format` + `check:client`，**exit 0**。

| 项 | 结果 |
|---|---|
| `pnpm run typecheck`（`tsc --noEmit`） | ✅ 0 错误 |
| `pnpm run build`（tsdown 双产物） | ✅ `lib/index.js` 60.8 kB / `lib/client.js` 42.7 kB |
| `spike/format-check.mjs`（新增，84 项） | ✅ 全过 |
| `spike/client-load-check.mjs`（扩展） | ✅ 注册契约 + 每个表面渲染且关键文案都在 + 源码规则「变暗的文字样式不得包住控件」 |
| 客户端依赖边界 | ✅ 只 `require("react")` 与 `react/jsx-runtime`；js-yaml 未进浏览器 |
| 写作子会话的分类与投递（P2 修复） | ✅ 14 项：`meta.origin=subagent`/`parentSession`/`cwd`/`delegationDepth`、消息四字段与深冻结、描述符形状与「只落一次」、提示词走 `followup`、流式累积与 `turn/end` 结算 |

### 3.1 新增的 `spike/format-check.mjs` 直接跑真模块（53 项）

P1 的 `substance-check.mjs` 把正则抄了一份进脚本，并注明「保持同步」——对一个「正则行为本身就是被测对象」的检查可以接受，对「哪些文件允许写」「卡的 id 是什么」这种规则不可以。新脚本用 `node --experimental-transform-types` **直接 import 同一批 `.ts` 文件**（本机 Node v22.23.2 实测；不能用 strip-only，因为它拒绝 `NovelError`/`NovelIo` 用的参数属性），断言的是真实现：

- slug / 卡路径 / 类型反解 / 文档白名单（含 `novel.yaml`、`.novel/`、`../` 全被挡住）；
- 章纲、摘要、引用列表从 frontmatter 读出；手写无 frontmatter 的章仍进索引；
- 反向索引把卡映射到章节；已存档的卡排在最后；伏笔卡的 `status` 不被当成存档位；
- frontmatter 往返不丢字段；
- 拆章 JSON：围栏、闲聊、单条 beat、没有数组、没有 title 的条目；
- **任务装配**（stub 掉 `fetch` 喂罐头文件）：整章任务确实带上了章纲、上一章摘要与结尾、角色卡正文，输入清单列出每个文件；卷纲任务的落盘目标正确；拆章任务带上可用设定 id 且排除已存档卡；
- **host IO 层**（内存 `ctx.fs` 替身，17 项）：脚手架不覆盖已有文件、`novel.yaml` 作为数据文件解析、`wordCount` 在两条写入路径上都被盖章、文档通道拒绝 `novel.yaml` 与逃逸路径、中文 id 与重名卡被拒、建章自动编号带章纲、显式章号撞车报冲突而不是覆盖、设定库分组与存档计数、反向链接、两个单文件页的存在性、目录列举（不存在的目录只是 `exists:false`）、工程树带章纲与字数。

最后一条是这一期最值钱的补充：IO 层是整个插件的规则所在，此前只有「对着真实例跑一遍 HTTP」能碰它，而那条路我的沙箱走不通。

### 3.2 `client-load-check.mjs` 现在渲染每个表面并找关键文案

P1 那个「按钮恒灰」的教训是**渲染通过 ≠ 分支被执行**。这次脚本在原有注册契约之外，用真实 fixture 逐个渲染 `__views` 里的组件，并断言只有特定分支才会产出的文案：设定库里的「陈默」「新建卡」「已存档 1 张」、大纲页的「续写卷纲」「按卷纲拆章」「要点 2」、任务条的按钮标签。为此客户端入口多导出了一个 `__views`（slot 框架只读 `apply`/`inject`，浏览器里是惰性的）。

脚本还多跑一条源码规则（见 §1.5）：变暗的文字样式不得包住控件。这条规则的事由很直白——渲染、类型、格式三种检查都看不见「按钮是灰的」，因为 markup 与处理器都是对的。

### 3.3 写检查脚本时抓到的东西

代码刚写完时，检查脚本自己先报了四条问题，四条都值得记：

1. **卡的摘要取到了小节标题**——`## 外貌` 是每张卡的第一行，摘要于是每张卡都一样，等于没有信息。改成跳过标题、取第一行真正的内容。
2. **一条断言写错了对象**：我把「角色卡正文进 prompt」写成了「卡路径进 prompt」，而路径只进 `inputs`（设计如此：prompt 里给模型看正文，面板上给人看清单）。断言已分开。
3. **`wordCount` 的旧值**：一条断言拿"写正文时"的字数去比对"改章纲后"的树，暴露的其实是我对这个字段的理解——它必须跟着最后一次写入走，这条正好变成了 §2.4 那个改动的验证。
4. **检查用的内存文件系统本身有 bug**：`stat` 只把"含有子目录的路径"认成目录，于是 `settings/characters/` 里只有文件时被判为不存在，设定库、建章编号、章号冲突三条断言全红。**替身也是代码**——它错了会以产品做错的样子报出来。

写检查脚本时被抓出来的错，比写完之后被人抓出来便宜得多——这也是 §3.1 坚持跑真模块的理由。

### 3.4 §1.3 那个修复是怎么在本地验的

作者报的 bug 出在 host 侧 agent 创建上，我的沙箱起不了可用会话，但 `startWritingRun` 需要的东西很窄：一个能 `create` 的 `ctx.agents`、一个事件总线、一个 logger。于是用**假 host** 把整条路跑通（`format-check.mjs` 的最后一节，14 项）：

- 断言 `create` 收到的 `meta` 就是 `origin/parentSession/cwd/delegationDepth`；
- 手动按工厂的方式调用 `setup`，再手动触发它注册的 `agent/pre-step` 钩子，断言描述符**恰好落成一次**且带任务标签；
- 断言提示词进了子会话自己的 `followup`（而不是被拒绝的 Session API）；
- 手动投递 `agent/assistant-stream` 的 `text-delta` 与 `session/event` 的 `turn/end`，断言文本累积与结算原因。

这不能替代真实模型那一跑，但它把「值形状对不对、顺序对不对、会不会重复落成」这些**我本来只能靠读源码下结论**的部分变成了机器判定。剩下的不确定只有一条：DSH 是否真的按这个契约调 `setup`/`pre-step`——那正好是作者点一次按钮就能回答的。

---

## 4. 还没验证的（需要在真实浏览器里点）

我的沙箱起不了可用会话，所以下列**交互分支**只有类型检查与静态渲染兜底，必须由你在 GUI 里走一遍：

| # | 操作 | 期望 |
|---|---|---|
| 1 | 重建后重启 DSH，打开工程 | 面板顶部出现「正文 / 设定 / 大纲」三个页签 |
| 2 | 设定页 | 列出已有卡；填 id + 名字 → 「新建卡」→ 文件出现在 `settings/<类型>/` |
| 3 | 设定页打开一张卡 | 改名/别名/身份/标签可编辑，**保存**后落盘；`world.md`、`timeline.md` 两个页面也能开、能存 |
| 4 | 设定页「存档」 | 卡从列表消失（勾「显示已存档」可回来），文件里多出 `archived: true` |
| 5 | 设定页「出现在」 | 卡下方列出引用它的章节，点一下跳到正文页并打开那一章 |
| 6 | 大纲页 | 全书主线、本卷卷纲能读能存（空工程先点保存创建文件） |
| 7 | 大纲页点一章 | 章纲页出现：标题/目标字数/视角/出场角色/地点/摘要 + `beats` 逐条增删改序，保存后章节文件 frontmatter 更新 |
| 8 | 大纲页「续写卷纲」 | 流式出字 → 采纳 → 进入卷纲编辑区 → 保存落盘 |
| 9 | 大纲页「按卷纲拆章」 | 出 JSON → 面板列出待建章节（可勾选）→「建章」→ 章节树多出对应章，且本章要点已写进 frontmatter |
| 10 | 正文页「按章纲写整章」 | 按该章 `beats` 生成整章 → 采纳 → 保存 |
| 11 | 任意任务 | 展开「这次喂了什么」应列出本次真实读到的文件（没有内容的模板不会出现） |
| 12 | **任意任务跑完后看侧栏** | **不应**多出任何会话行（写作子会话是 `origin: 'subagent'`）；旧的两条 `novel-*` 需要你手动归档或删目录，插件删不了（§1.3） |
| 13 | 预览区读完正文 | 「采纳」就在正文下面（§1.6 ①） |
| 14 | 「选择文件夹」 | 弹出系统选择器；选中后直接打开该工程（§1.6 ③） |
| 15 | 关掉标签页再打开 | 自动回到上次打开的那本；「打开过：」列出之前的几个，点一下能换（§1.6 ②） |
| 16 | 正文页「存档本章」 | 确认后章节从树里消失、统计行出现「已存档 1 章 / N 字」；勾「显示已存档」能看到它（半透明），打开后按钮变成「恢复本章」，点一下回到正常（§1.7） |
| 17 | 存档一章后再点「按章纲写整章」 | 那章不再被当成「上一章」；prompt 的输入清单里也不会出现它（§1.7） |

注意第 9、10 项要真跑模型，`plan` 那一步的输出格式不保证一次就对——不对时面板会给出「输出里没有可解析的 JSON 数组」并保留原始输出，这时**换一次任务**比改格式更省事。

第 12 项是这次修复的验收点：如果侧栏还是多出一条 `novel-…`，说明 `meta.origin` 没有生效，把控制台里的会话 summary 发我。

---

## 5. 之后

- **P3 长程能力**：M5 检索问答 + M6 一致性检查。P2 已经把地基铺好：`/api/novel/dir` 与 `/api/novel/text` 是目录列举与读取通道，`referenceIndex` 已经是「某某出现在哪些章」的反查，确定性检查（引用不存在 id、别名冲突、章号缺重、伏笔未回收）现在只差一个报告面板。
- **已知欠账**：
  - 硬删除（见 §2.1）——需要 DSH 给出删除原语，或明确走 shell 工具。
  - 面板还没做「未保存就切页签」的保护：三个表面都常驻挂载（切页签不丢缓冲），但切**章节**时只提示正文的未保存修改，大纲/设定的缓冲不在提示范围内。
  - `beats` 编辑器不支持拖拽排序，只有 ↑/↓（键盘可达性够用，手感一般）。
  - 百万字级性能仍未做（P5）：现在每次 `/cards` 都会重扫全部章节来算反向链接。
