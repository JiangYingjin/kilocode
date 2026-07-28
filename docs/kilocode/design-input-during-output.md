# KiloCode 模型输出期间交互式输入：三种 Enter 行为设计方案

## 概述

本文档分析在 KiloCode TUI 中实现以下功能的可行性和设计方案：**当模型正在输出时，用户可以在输入框中打字，按 Enter 时有三种不同的行为**。

---

## 一、当前架构关键发现

### 1.1 输入框当前在输出期间是禁用的

`Prompt` 组件（`component/prompt/index.tsx`）的 `disabled` prop 在 session 路由（`routes/session/index.tsx`）中设置：

```tsx
const disabled = createMemo(
  () => permissions().length > 0 || blockingQuestions().length > 0 ||
       blockingSuggestions().length > 0 || network().length > 0 || terminals().length > 0
)
```

当 `disabled=true` 时，`submit()` 直接返回 `false`，无法输入和提交。

### 1.2 Prompt Queue 已天然支持排队

`KiloSessionPromptQueue.enqueue()` 基于 Promise 链实现串行执行。新 prompt 入队后自动等待前一个 slot 完成，然后通过 `hasFollowup()` → `runLoop` 检测后跳出当前轮次，新 prompt 接管。

**这意味着：排队功能的基础设施已经存在。**

### 1.3 打断机制已存在

- 单次 Esc：递增 `interrupt` 计数
- 5 秒内两次 Esc：调用 `sdk.client.session.abort()` → `SessionPrompt.cancel()` → `SessionRunState.cancel()` → fiber 中断 → `Effect.onInterrupt` → `halt(DOMException("Aborted"))` → `aborted: true`

### 1.4 Fork 机制

已有完整的 fork API（`session.fork()`），在事务中复制消息 + `detachPart()`。当前 fork 在三种场景触发：CLI `--fork`、时间线右键菜单、消息右键菜单。

---

## 二、三种 Enter 行为的可行性评估

### 2.1 行为 A：打断 + 立即发送（Esc Esc + Enter）

**级别：高可行性**

#### 核心改动

| 位置 | 改动 |
|------|------|
| `component/prompt/index.tsx` | 新增 `interrupt_and_submit` 命令，绑定到 Enter（当 status != idle 时） |
| `routes/session/index.tsx` | 允许输入框在输出期间保持可用 |
| `component/prompt/index.tsx` | 在 `submit()` 中判断：若 status != idle，先 abort，重新触发 submit |

#### 数据流

```
用户打字 → 按 Enter（status=busy）
  → Prompt.submit() 检测到 status !== "idle"
    → sdk.client.session.abort({ sessionID })  // 立即打断
    → 等待 abort 完成（或并行）
    → sdk.client.session.prompt({ sessionID, parts })  // 发送新消息
      → KiloSessionPromptQueue.enqueue() → 新 slot 开始 → runLoop
```

#### 改动量估算

| 文件 | 行数 | 复杂度 |
|------|------|---------|
| `component/prompt/index.tsx` | ~50 行 | 低 — 新增 submit 分支 |
| `routes/session/index.tsx` | ~10 行 | 低 — 放宽 disabled 条件 |
| `keybind.ts` | ~5 行 | 低 — 可选：新增绑定 |

---

### 2.2 行为 B：排队等待（等待模型完成后自动发）

**级别：非常高可行性**

#### 核心发现

**这个功能现有基础设施已基本完整。** 当前的 `prompt()` 调用 → `KiloSessionPromptQueue.enqueue()` → 等待前一个 slot 完成 → `hasFollowup()` → `runLoop` 在当前步骤结束后跳出 → 新 prompt 执行。全程自动，无需额外开发。

只需要做以下改动：

1. **放宽 disabled 条件**：输出期间允许打字（同 A）
2. **Enter 的不同行为区分**：用修饰键（Shift+Enter / Alt+Enter / Ctrl+Enter）区分"打断"和"排队"
3. 状态显示：在输入框旁边显示排队状态

#### 建议的键绑定方案

| 按键 | 行为 |
|------|------|
| **Enter** | 打断 + 立即发送（行为 A） |
| **Shift+Enter** | 插入换行（当前 `input_newline`） |
| **Alt+Enter** | 排队等待（行为 B） |
| **Ctrl+Enter** | 排队等待（行为 B 的备选键） |

#### 排队指示器

在 Prompt 组件中增加状态提示：

```
[模型正在输出... 按 Enter 打断 | 按 Alt+Enter 排队 ⏳]
```

入队后切换为：

```
[⏳ 1 条消息在排队中...]
```

#### 改动量估算

| 文件 | 行数 | 复杂度 |
|------|------|---------|
| `component/prompt/index.tsx` | ~60 行 | 低 — 新增 queue 行为 + UI 指示器 |
| `routes/session/index.tsx` | ~10 行 | 低 — 放宽 disabled + 传递 status |
| `keybind.ts` | ~10 行 | 低 — 新增绑定 |

---

### 2.3 行为 C：Fork 并行会话（最复杂）

**级别：中等可行性（MVP 可行，完整版困难）**

#### 核心挑战

| 挑战 | 难度 | 说明 |
|------|------|------|
| 输出中的 fork | 中 | 当前 fork 只复制已提交的消息。输出中的消息是未完成的 partial，需要在 fork 前等待当前步骤完成，或将其冻结为 checkpoint |
| 双会话并行 | 中 | KiloCode 是一个 Worker 一个会话。并行需要两个 Worker（每个会话一个），或单 Worker 切换模型 context |
| 快速切换 | 低 | TUI 已有 `session.quick_switch` 命令和 session list 导航 |
| 会话合并 | 高 | 合并两个发散对话分支需要 diff/merge UI，类似 git merge 但更复杂 |

#### 推荐 MVP 方案

**不追求真正并行**，而是：fork + 自动切换 + 保留历史。

##### 数据流

```
用户按 Super+Enter（fork 模式）
  → 获取当前会话状态
  → fork 新会话（session.fork() → 返回新 sessionID）
  → 在新会话中立即 prompt（发送用户输入）
  → TUI 自动切换到新会话（用户看到新会话在输出）
  → 原会话保留在历史中（用户可以通过 session list 或 quick_switch 回去）
```

##### 后续的"查看"与"合并"能力

| 步骤 | 实现 |
|------|------|
| **查看 fork 树** | 在 session sidebar 中显示父子关系（已有 `session.children()` API） |
| **快速切换** | 已有 `session.quick_switch` + session list |
| **对比视图** | 新增"对比会话"视图：左右分栏显示两个会话的最新消息（新增页面） |
| **合并** | 最困难的部分。建议走"手工复制"路径：用户在对比视图中选择要保留的消息，系统将其复制到目标会话 |

##### 改动量估算

| 组件 | 行数 | 说明 |
|------|------|------|
| **第 1 步：fork + prompt**（可行） | ~80 行 | session route + prompt 组件 |
| **第 2 步：自动切换**（已有） | ~0 行 | 已有 navigate(`/session/{id}`) 路径 |
| **第 3 步：fork 树可视化**（可选）| ~200 行 | 新 UI 组件 |
| **第 4 步：对比视图**（可选）| ~300 行 | 新 route + 分栏组件 |
| **第 5 步：合并**（最困难）| ~400 行 | 需要设计消息级别的 diff/merge 逻辑 |
| **总计** | ~1000 行 | MVP (~80 行) 已可交付有价值的功能 |

---

## 三、推荐的实现路线图

### Phase 1：基础改动（1-2 天）

```yaml
目标: 让输入框在输出期间可用，实现行为 A（打断）和行为 B（排队）

改动:
  1. routes/session/index.tsx:
     - 放宽 disabled 条件：不在 status=busy 时禁用
     - 传递 sessionStatus 给 Prompt 组件
  
  2. component/prompt/index.tsx:
     - submit() 中增加 status 判断：
       - idle → 正常提交
       - busy → abort + prompt（打断/发送）
       - busy + 修饰键 → prompt（排队）
     - 新增排队状态 UI 指示器
  
  3. keybind.ts:
     - Alt+Enter → input.queue (排队)
     - Enter → input.submit (打断+发送)
```

### Phase 2：Fork 行为（3-5 天）

```yaml
目标: 实现行为 C 的 MVP：fork + prompt + 自动切换

改动:
  1. SDK / server:
     - 确认 session.fork() API 在输出中也能安全调用
     - 或新增 session.forkAndPrompt() 复合 API
  
  2. component/prompt/index.tsx:
     - Super+Enter → input.fork_and_prompt
  
  3. routes/session/sidebar.tsx:
     - 显示 session 的父子关系（fork 树）
```

### Phase 3：对比与合并（可选，5-10 天）

```yaml
目标: 分叉会话的查看、比较与合并

改动:
  1. 新增路由 /session/{id}/compare/{forkId}
  2. 左右分栏显示两个会话的最新消息
  3. 消息级别的选择 + 复制到目标会话
```

---

## 四、关键风险与边界情况

### 4.1 打断中的竞态条件

当前 `abort` 是异步的（`sdk.client.session.abort()` → HTTP 请求 → Effect fiber interrupt）。如果用户在打断后立即发送 prompt，可能会出现：
- **A) abort 还未完成，prompt 已经在排队了** → 队里有一个即将被取消的 slot + 一个新 slot
- **B) abort 完成了，但旧消息标记为错误（aborted）** → 这是期望行为

**解决方案**：打断 + prompt 应在一次 RPC 中完成（新增 `session.interruptAndPrompt()` API），或者在客户端等待 abort 确认后再 prompt。

### 4.2 排队期间的输入

用户在排队状态下是否可以继续打字/修改？建议：
- 入队后锁定输入内容（不允许修改已排队的消息）
- 但可以让用户继续输入第二条排队消息

### 4.3 Fork 时的输出状态

当模型正在输出时 fork，当前 assistant 消息未完成。有三种策略：

| 策略 | 优点 | 缺点 |
|------|------|------|
| **等待当前步骤完成再 fork** | fork 到的状态是完整的 | 用户需要等待（可能几秒） |
| **fork 到最后提交的 checkpoint** | 立即响应 | 丢失当前步骤的上下文 |
| **fork 并冻结部分输出** | 最精确 | 需要修改 processor 的状态序列化 |

推荐：采用**策略 1**，用户感知上合理（"正在等待模型完成当前步骤再分支"）。

---

## 五、设计原则

1. **渐进实现**：从行为 A+B 开始（低风险、高价值的改动），行为 C 的 MVP 作为第二步
2. **复用现有设施**：排队直接复用 `KiloSessionPromptQueue`，fork 复用 `session.fork()`，打断复用 `session.abort()`
3. **键绑定明确区分**：用户少记忆负担，三个行为用清晰的修饰键区分
4. **UI 反馈到位**：状态提示清楚告知用户当前在输出、排队、还是 fork 模式

---

## 六、Fork 并行会话深度设计

### 6.1 现有基础设施盘点

| 功能 | 现状 | 路径 |
|------|------|------|
| **Fork 会话** | ✅ 完整实现 | `POST /session/{id}/fork` → `session.fork()` 事务复制 |
| **并行执行** | ✅ 天然可行 | 每个 session 独立 Worker，各自处理自己的 prompt queue |
| **切换会话** | ✅ 已有 `session.child.next/previous`、`session.parent`、`session.quick_switch.1-9` | 左右箭头循环子会话，上箭头回父会话，Leader+数字切固定会话 |
| **fork 时间点** | ✅ `messageID` 参数指定 fork 点 | `DialogForkFromTimeline` 已支持选择任意用户消息作为 fork 点 |
| **fork 树的 UI 可视化** | ❌ 无 | 侧边栏只显示当前 session，不显示 fork 关系 |
| **会话合并** | ❌ 无 | 需要从零构建 |

### 6.2 快速切换 UI 改进（低难度）

#### 当前已有的切换能力

用户已可以通过以下方式在 fork 树间切换：

- `←` / `→`（`session.child.previous` / `session.child.next`）：在同级子会话间循环
- `↑`（`session.parent`）：回到父会话
- `<leader>1` - `<leader>9`（`session.quick_switch.1-9`）：跳到固定的会话
- 命令面板 `/sessions`：打开会话列表选择

#### 需要新增的改进

**改进 1：侧边栏 fork 树可视化**

在侧边栏中显示当前会话的 fork 关系树：

```
┌─ 当前会话标题 ───────────┐
│                           │
│  ← (parent) 原始会话      │
│                           │
│  ── Fork 分支 ──          │
│  ● 当前会话 (fork #1)     │  ← 高亮
│  ○ fork #2 (另一路)       │
│  ○ fork #3 (另一路)       │
│                           │
│  ↑↓ 箭头切换  Enter 进入   │
└───────────────────────────┘
```

实现在 `routes/session/sidebar.tsx` 中：
- 读取当前 session 的 `parentID` 和同组 children
- 如果 `parentID` 存在或 children 非空，渲染 fork 树区域
- 高亮当前会话
- 支持方向键导航（复用现有的 `session.child.*` 命令）

**改进 2：底部栏 fork 指示器**

在 session 底部栏（`routes/session/footer.tsx`）添加 fork 位置提示：

```
[Branch: parent ▶ fork #1 ◀ fork #2]   [3/3 messages]
```

**改进 3：增加 `[` / `]` 快捷键**

| 快捷键 | 命令 | 行为 |
|--------|------|------|
| `[` | `session.sibling.previous` | 上一个同级 fork |
| `]` | `session.sibling.next` | 下一个同级 fork |

### 6.3 会话合并（核心攻坚）

#### 合并概念

把两个分叉的对话分支合并到一起。给定：

```
Session A (parent):
  用户: "如何优化这个算法？"
    助手: [给出方案 A]
  用户: "试试看"
    助手: [实现方案 A]           ← fork 点
        \
Session B (fork):               Session C (fork 2):
  用户: "换思路"                   用户: "用 Python 重写"
    助手: [方案 B 的推理]              助手: [Python 实现]
  用户: "再优化"                   用户: "加测试"
    助手: [方案 B 优化]               助手: [添加测试]
```

合并就是把 Session B 或 C 的结果带回 Session A。

#### 三种合并策略

**策略 1：追加结果（Append）— MVP，最容易**

```
原理: 把 fork 分支中 fork 点之后的消息按顺序追加到父会话
场景: fork 分支完成后，想把分支产出带回主线
操作: 用户在 fork 会话中调用 /merge → 自动追加到父会话
结果: 父会话末尾出现新消息
```

实现：

```
POST /session/{parentID}/merge
body: { sourceID: "session-B-id", strategy: "append" }

服务端逻辑：
  1. 读取 session B 中 fork 点之后的所有消息
  2. 重新分配 MessageID/PartID
  3. 用 KiloSession.writer 追加到 session A
  4. 返回合并后的 session ID
```

**策略 2：总结导入（Summary）— 最实用**

```
原理: LLM 总结 fork 分支的对话，以一条用户消息导入父会话
场景: fork 分支很长时，不想逐条复制，只要结论
操作: 用户在 fork 会话中调用 /merge-summary
结果: 父会话中出现 "来自 fork 分支的总结：[...]" 用户消息
```

实现：

```
POST /session/{parentID}/merge
body: { sourceID: "session-B-id", strategy: "summary" }

服务端逻辑：
  1. 读取 session B 的所有消息
  2. 调用 LLM 生成总结
  3. 在 session A 中创建一条 noReply 用户消息
  4. 消息内容: "## 来自分支 <session B 标题>\n\n<LLM 总结>"
```

**策略 3：选择性合并（Selective）— 最强大**

```
原理: 用户选择 fork 分支中的特定消息，只复制选中的内容到父会话
场景: fork 分支中有用和无关内容混杂
操作: 用户调用 /merge-select → 弹出消息列表 → 勾选 → 确认
结果: 选中的消息按序追加到父会话
```

实现：

```
POST /session/{parentID}/merge
body: { sourceID: "session-B-id", strategy: "selective", messageIDs: [...] }

服务端逻辑：
  1. 读取 session B 中指定的消息
  2. 按时间排序
  3. 用 KiloSession.writer 追加到 session A
  4. 只复制消息，不触发 LLM
```

#### 服务端实现

**`session.ts` 新增 `merge()` 方法原型：**

```
merge(input: {
  targetID: SessionID
  sourceID: SessionID
  strategy: "append" | "summary" | "selective"
  messageIDs?: MessageID[]
}): Effect<{ mergedSessionID: SessionID; messageCount: number }>

实现：
  1. 验证 targetID 和 sourceID 存在且有关联
  2. 根据策略获取要复制的消息
     - append: fork 点之后的所有消息
     - selective: 指定的消息，按时间排序
  3. 用 KiloSession.writer(targetID, sync) 创建批量写入器
  4. 遍历消息，重分配 ID，写入
  5. 提交事务
  6. 返回合并结果
```

#### HTTP API / SDK / TUI

```
SDK:  sdk.client.session.merge({ id: targetID, body: { sourceID, strategy, messageIDs? } })
HTTP: POST /session/{id}/merge → { mergedSessionID, messageCount }
TUI:  /merge 命令 → DialogMergeStrategy → DialogMergeMessageSelect → 执行 → 导航
```

#### 改动量估算

| 组件 | 文件 | 行数 | 说明 |
|------|------|------|------|
| **服务端 merge()** | `session/session.ts` | ~80 行 | 核心 merge 逻辑 |
| **HTTP API** | `server/httpapi/groups/kilocode.ts` | ~30 行 | 新增端点 + schema |
| **SDK client** | `sdk/js/src/client.ts` | 自动生成 | OpenAPI spec 驱动 |
| **TUI 命令** | `routes/session/index.tsx` | ~30 行 | /merge slash 命令 |
| **合并对话框** | `component/dialog-merge.tsx` | ~150 行 | 策略选择 + 执行 |
| **侧边栏 fork 树** | `routes/session/sidebar.tsx` | ~60 行 | fork 树可视化 |
| **底部栏指示器** | `routes/session/footer.tsx` | ~30 行 | fork 位置提示 |
| **快捷键** | `config/keybind.ts` | ~5 行 | `[` / `]` 绑定 |
| **总计** | | **~385 行** | 核心合并 + UI 改进 |

#### 路线图

```
Phase 1 (1-2天): 侧边栏 fork 树 + 底部栏指示器 + [ / ] 快捷键
  纯 UI 改进，不需服务端改动

Phase 2 (2-3天): 追加合并 (Append) + 总结导入 (Summary)
  服务端 merge() 方法 + HTTP API + /merge 命令

Phase 3 (3-5天): 选择性合并 (Selective) + 消息选择器 UI
  消息选择组件 + 合并确认对话框
```

### 6.4 与现有功能的集成

```
Fork 流程:
  /fork → DialogForkFromTimeline → sdk.client.session.fork() → 导航到新会话 → 并行执行

切换流程:
  ← / → 同级 fork 切换 | ↑ 回父会话 | [ / ] 上下同级 fork | quick_switch 任意会话

合并流程:
  在 fork 会话中 /merge → DialogMergeStrategy → 选择策略 → 执行 → 导航到合并后会话
```
