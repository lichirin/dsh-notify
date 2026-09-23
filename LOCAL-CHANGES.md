# 本地改造记录（非上游文件）

这份文档记录**本机副本**相对上游 `aokamoaki/dsh-notify` 的全部改动。上游文件
（`README.md` / `README.en.md` / `CHANGELOG.md` 等）刻意保持原样，便于日后对照。

- 上游基线：`https://github.com/aokamoaki/dsh-notify` 的 `main` 分支，以 tarball 方式取得
  （`codeload.github.com`；本机 `git` 协议到 GitHub 不通）。取得时 commits 页显示最新提交为
  `8727238`（*fix: toast click targets desktop app when installed, browser otherwise*），
  版本 `1.0.0`。副本内**没有 `.git`**，与上游比对请用备份目录。
- 上游原样备份：`dsh-plugins/dsh-notify.upstream-backup`
- 目标环境：DSH `0.1.5-rc.1`（Windows 11, Node v24.19.0）
- 改动文件：`lib/index.js`、`lib/client.js`、`test/notify.test.mjs`（其余逐字节等于上游）

---

## 第 1 轮：适配 DSH 0.1.5-rc.1

上游是针对更早版本（注释自述 `0.1.0-rc.6`）写的，四处与本机版本不符：

1. **`titleOf()` 从未生效** —— 读的是 `session.events`，但 0.1.5-rc.1 的 `Session` 类没有这个
   属性，只有 `snapshotEvents()` / `ownEvents()`。结果每条 toast 的标题都退化成「对话」。
   现优先调用 `snapshotEvents()`，保留数组形式作为兜底。

2. **子代理过滤是空操作** —— 上游判断 `event.origin === 'subagent'`，但 `origin` 属于
   `SessionHeader`（`session.header.origin`），不在事件信封上。子代理子会话的通知本来全都
   会弹。新增 `isSubagentSession()`：查 `header.origin === 'subagent'`，并用
   `delegationDepth > 0` 兜底。

3. **完成检测建立在错误前提上** —— 上游注释称「本版本没有 `turn/end`」且「`agent/status`
   对全局监听不可见」，于是每秒轮询 TypeScript **私有字段** `agent.phase`。两者在
   0.1.5-rc.1 上都不成立：`dsh-agent-loop` 明确 append `turn/end`，内置的
   `dsh-compaction-basic`、`dsh-goal-round-driver` 都在根平面监听 `agent/status`。
   改为监听 `turn/start` / `turn/end` 事件，同时移除了 `inject = ['agents','timer']`。

4. **出错通知取不到耗时**（顺带修掉）—— 轮询用 `agent.id` 存 key，`agent/error` 用
   `sessionId` 查，两者不一致。现统一以 session id 存 `{ ts, turn }`。

## 第 2 轮：goal 自动续行不再刷屏

移植自 `Sutera-Diffusus/dsh-windows-notify` 的 `isAutoContinuing`。处于
`phase === 'active'` 且 `activation === 'armed'` 且额度未耗尽的 goal，round driver 会立刻
开始下一轮，因此每轮的完成提醒都是噪音。其余状态（`paused` / `blocked` / `complete`、
`disarmed`、额度耗尽）都是真实停点，照常提醒。

与 Sutera 版本的两点差异：

- agent 取法不同：上游在 `agent/status` 事件里直接有 `agent`，用 `agents.roots()`
  过滤；我们只有 `session`，改用 `ctx.get('agents').get(session.id)`（`AgentRegistry.get`
  在 0.1.5-rc.1 存在，且 `Agent.id` 就是 `SessionId`）。
- 静默范围收窄到**非出错**回合：goal 续行中若某轮以 `error` 结束，driver 会停下，那正是
  应该叫醒用户的时刻。

服务一律经 `ctx.get()` 防御式读取并包在 try/catch 里；取不到就返回「非自动续行」，
保证失败方向永远是**照常提醒**，绝不静默吞掉通知。

## 第 3 轮：目标完成不再「双弹」

模型在回合内把 goal 标记为 `complete` 时，`goal/changed` 先到（去重键是 goal id），
该回合随后 `turn/end`，此时 goal 已是 `complete` 故 `isAutoContinuing` 为假，于是又弹一条
（去重键是 session id）。两个键不同，5 秒去重拦不住。

`goal/changed` 的载荷里其实带 `agent`，据此把「目标完成」与**当前打开的那一轮**精确配对
（`goalNoticeTurn`: sessionId → turn），该轮 `turn/end` 时静默；标记无论如何都被消费，
不会泄漏到后续回合。goal 在回合外完成时不打标记，因此不会误伤无关回合；以 `error`
结束的回合仍然通知。

## 第 4 轮：三项功能优化

1. **前台行为可配置** —— 新增 `foregroundMode`，三档：

   | 取值 | 前台时 |
   |---|---|
   | `suppress`（默认） | 静默，仅在后台时提醒（上游行为） |
   | `always` | 前台也弹 |
   | `long` | 只有耗时 ≥ `foregroundMinMs`（默认 30s）的回合前台才弹，短问答保持安静 |

   提问/审批永远不受此开关约束。新增纯函数 `foregroundAllowed()` 便于单测。

2. **结束原因文案** —— `turn/end` 的 `TurnEndReason.kind` 现在逐档显示，而不是一律「完成」：

   | kind | 中文 | English |
   |---|---|---|
   | `completed` | 完成 | completed |
   | `aborted` | 已中止 | aborted |
   | `blocked` | 被拦截 | blocked |
   | `error` | 出错 | error |
   | `max-tokens` | 达到 Token 上限 | max tokens reached |
   | `interrupted` | 被中断 | interrupted |

   未知 kind 原样透传（宁可显示英文，也不谎报「完成」）。新增 `trReason()`。

3. **铃铛改为软静音** —— 点铃铛只静音完成类通知，提问/审批仍会提醒（因为那意味着 agent
   被卡住等你）。为此新增文件级的硬静音 `muteAll`，可彻底静音（含提问/审批）。
   `lib/client.js` 的提示文案已同步改成「完成提醒已开启/已关闭」。

4. **顺带修掉一个会坑人的问题** —— `loadConfig()` 现在剥离 UTF-8 BOM。此前用会写 BOM 的
   编辑器改配置会让 `JSON.parse` 抛错，然后静默回落到默认值（表现为「改了没生效」）。

## 第 5 轮：去重键按「通知种类」区分（修掉会卡死 agent 的缺陷）

上游的去重键只有 `sessionId`，而提问（`ask_user_question`）与审批（`approval/asked`）
**共用 `ask` 这个 soundType**，于是 5 秒内第二条会被静默吞掉。后果不只是少一条提醒：
**被吞掉的审批会让 agent 一直卡在等待里，而屏幕上没有任何东西告诉你这件事**。

改法：新增 `notifyKey(sessionId, soundType, kind)`，键变成 `<id>:<kind>`。种类划分：

| 事件 | soundType | kind |
|---|---|---|
| `turn/end` | `done` / `error` | `turn` |
| `agent/error` | `error` | `turn`（**刻意与上者共享**） |
| `goal/changed(complete)` | `done` | `goal` |
| `ask_user_question` | `ask` | `ask` |
| `approval/asked` | `ask` | `approval` |

- 提问与审批现在**互不抑制**：问完 2 秒后来的审批一定会弹出来。
- 同种类仍然去重：连续两个提问（或连续两个审批）在 5 秒内合并成一次。
- `turn/end` 与 `agent/error` **故意共享 `turn`**：一次失败的回合不能被报告两遍
  （这个行为是上游有意为之，予以保留）。
- 完成与目标完成也是不同种类，互不抑制。

## 第 6 轮：出错/被拦截的回合改为「attention 类」，前台也提醒

**起因**：用户遇到一次 LLM 提供商故障（`Insufficient Balance` / `code: QUOTA` / `status: 402`），
报错显示在 GUI 里，但**没有弹出任何提醒**。

**取证**：直接解压该会话的日志（`session.v3.jsonl.zstd`，是多帧拼接的 zstd，需按帧解码）核实到：

- `turn 17` 的 `turn/end` 为
  `{"kind":"error","error":{"message":"Insufficient Balance","code":"QUOTA","status":402}}`
  —— 也就是说**插件的触发点命中了**，事件确实发出并被接收；
- 会话里不存在更合适的「LLM 失败」专属事件（`llm/retry` 只是重试过程），`turn/end` 的
  `error` 就是权威终态信号。

**根因**：不是漏触发，而是**被前台静默吞掉了**。错误此前与「完成」同类（completion 类），
默认 `foregroundMode: 'suppress'` 下，用户正盯着 GUI 看错误横幅 → `foreground = true` → 不弹。

**修法**：引入**两类通知**的概念，并与 soundType（决定音效）解耦：

| 类别 | 包含 | 前台 | 软静音（铃铛） | 硬静音 `muteAll` |
|---|---|---|---|---|
| **attention**（agent 卡住等你） | `ask_user_question`、`approval/asked`、`turn/end` 的 `error` / `blocked` | **照常提醒** | **照常提醒** | 静音 |
| completion | `completed` / `aborted` / `max-tokens` / `interrupted`、goal 完成 | 受 `foregroundMode` 约束 | 静音 | 静音 |

- 新增 `isAttentionReason(reason)`（`error`、`blocked`）。
- `decideNotify()` 增加第 6 个参数 `attention`；为向后兼容，`soundType === 'ask'`
  **隐含** attention，因此原有调用方式行为不变。
- `blocked` 也改用 error 音效（`attention ? 'error' : 'done'`）。
- 核心理由：出错的回合意味着 **agent 停在那里、不处理就什么都不会再发生**，这与
  「提问/审批」是同一种"需要你介入"的语义；晚提醒等于没提醒。
- `aborted`（用户自己按的取消）**不算** attention，前台仍然静默。
- `muteAll` 仍是优先级最高的"闭嘴"逃生门——连 attention 类也一起静音。

---

## 配置参考

文件：`~/.dsh/dsh-notify.json`（`DSH_HOME` 感知）。
**每次通知都会重新读取**，改完立即生效，无需重启。文件可以为**局部**——只写你想改的键，
其余保持默认（与默认值做浅合并）。

| 键 | 默认 | 说明 | 入口 |
|---|---|---|---|
| `sound` | `true` | 提示音开关 | 文件 |
| `toast` | `true` | 系统弹窗开关 | 文件 |
| `volume` | `1.0` | 0–1 | 铃铛滑块 |
| `serviceNotify` | `true` | 服务类通知开关（桌面壳读取） | 文件 |
| `notifications` | `true` | **软静音**：只静音完成类 | 铃铛点击 |
| `foregroundMode` | `'suppress'` | `suppress` / `always` / `long` | 文件 |
| `foregroundMinMs` | `30000` | `long` 模式的耗时门槛 | 文件 |
| `muteAll` | `false` | **硬静音**：全部静音（含提问/审批） | 文件 |

环境变量：`DSH_NOTIFY_LANG`（`zh`/`en` 强制语言）、`DSH_HOME`（配置与状态目录）。

自有 HTTP 路由（同源校验）：`GET/POST /dsh-notify/config`、`GET/POST /dsh-notify/foreground`。

## 怎么试

```powershell
# 前台也弹
'{"foregroundMode":"always"}' | Set-Content "$env:USERPROFILE\.dsh\dsh-notify.json" -Encoding utf8

# 仅长回合在前台弹（默认 30 秒门槛）
'{"foregroundMode":"long","foregroundMinMs":30000}' | Set-Content "$env:USERPROFILE\.dsh\dsh-notify.json" -Encoding utf8

# 恢复「仅后台提醒」
'{"foregroundMode":"suppress"}' | Set-Content "$env:USERPROFILE\.dsh\dsh-notify.json" -Encoding utf8

# 彻底静音（含提问/审批）
'{"muteAll":true}' | Set-Content "$env:USERPROFILE\.dsh\dsh-notify.json" -Encoding utf8
```

改完直接触发一次回合即可，**不用重启**。`Get-Content` 可回读当前生效值。

## 已知的上游行为（未改，供决策）

- **完成类的 5 秒同会话去重**：连续两个回合间隔小于 5 秒时只提醒一次（`turn` 种类内去重）。
- **前台判定较宽**：页面可见且窗口聚焦即算前台，把窗口挪到旁边看着也会静默。
  （`foregroundMode` 可改变这一点。）
- **提示音不可选**：只有开关（`sound`）和音量（`volume`），没有多套音效。
- **没有免打扰时段**：`Sutera-Diffusus/dsh-windows-notify` 有（另含托盘角标）。

## 测试

`node --test test/notify.test.mjs` —— 64 例，全绿。覆盖配置解析（含 BOM、局部配置、
损坏回落）、决策函数（三档模式、软/硬静音、attention 类、去重）、去重键种类划分、
`titleOf` 的两种会话形态、`isSubagentSession`、`isAutoContinuing` 全状态、
goal 与回合的配对、HTTP 路由。

## 安装与卸载

```powershell
# 安装（已装）
dsh plugin --profile web add "link:<克隆下来的目录>"
# 卸载
dsh plugin --profile web remove dsh-notify
```

改完源码需**重启 `dsh web` 后端进程**（bundle 层与宿主半边在启动时加载），
客户端半边的文案改动刷新页面即可。
