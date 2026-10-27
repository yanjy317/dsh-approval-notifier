# dsh-approval-notifier

DeepSeek Harness 插件：每当 DSH 需要你**审批**（权限请求）或**回答问题**（`ask_user_question`）时，弹一条原生 Windows 通知 —— 即使 DSH 窗口被别的窗口挡住也不会错过。

- 正在看的会话**不打扰**；其它会话改用**应用内提醒**（点一下就跳过去）。
- 审批通知自带 **「允许一次 / 拒绝」** 两颗按钮，可以直接在通知里答掉。
- 点击通知会激活 `dsh-approval-notifier://focus?session=<id>` 协议，把 DSH 窗口切到对应会话。
- 配置改完保存即刻生效，**无需重启 DSH**。

## 安装

```bash
dsh plugin add github:yanjy317/dsh-approval-notifier
```

或在本地把插件目录放到 `profiles/<profile>/.local-plugins/dsh-approval-notifier`，
该目录下的 `cordis.patch.yml` 会被自动叠加。

## 工作原理

宿主侧（`lib/index.js`）只做**只读观察**，不会拦截、延迟或否决任何提问：

- `session/event` 的 `approval/asked`：`dsh-user-approval` 为每次权限请求追加的持久审计事件，
  在 answerer waterfall 之前触发，因此与谁回答、监听器顺序、批准结果都无关。
  对应的 `approval/decided` 会撤掉应用内的那条提醒。
- `user-questions/request`：`ask_user_question` 的 waterfall，以 `prepend` 注册为纯观察者
  （`next()` 原样透传）。

弹什么取决于浏览器侧（`lib/client.js`，见 `presence.js`）报告的窗口状态：

| 情况 | 处理 |
| --- | --- |
| 该会话正在屏幕上 | 不弹 |
| 窗口在前台，但停在**别的**会话 | 应用内提醒卡片 |
| 窗口不在前台（或没有窗口） | Windows 桌面 toast |

审批 toast 上的两颗按钮**不会**在宿主侧直接作答 —— 宿主把决定转发给页面，由页面去 resolve
**同一个**待决审批，避免与 `approval/request` waterfall 竞争、导致应用内卡片残留。

## 配置

日常开关放在 `<DSH_HOME>/dsh-approval-notifier.json`，每次通知时重新读取（mtime + size 缓存），
改动即时生效。优先级由低到高：内置默认值 → 插件 `cordis` 的 `config` → 上述文件 → 环境变量。
任何一层坏掉都只是被丢弃、回退到上一层，因为「读不到偏好」绝不能让通知丢失。

主要字段（完整列表见 `lib/config.js` 的 `DEFAULTS`）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `notifyApprovals` | `true` | 审批通知 |
| `notifyQuestions` | `true` | 提问通知 |
| `notifyInApp` | `true` | 允许应用内提醒 |
| `suppressVisible` | `true` | 正在看的会话不打扰 |
| `decideFromToast` | `true` | toast 上显示「允许一次 / 拒绝」 |
| `sound` | `true` | 提示音 |
| `includeToolCall` | `true` | 通知里带上工具调用信息 |
| `clickAction` | `auto` | `auto` / `focus-app` / `open-url` / `none` |
| `openUrl` | `''` | `clickAction: open-url` 时打开的地址 |
| `focusScheme` | `dsh-approval-notifier` | 点击通知用的 URL scheme |
| `desktopExePath` | `''` | 空 = 自动探测 DSH 安装位置 |
| `appId` | `DSH.ApprovalNotifier` | Windows AppUserModelID（影响图标/分组） |
| `dedupeMs` | `1500` | 同一条通知的去重窗口 |
| `maxPerMinute` | `30` | 限流 |
| `timeoutMs` | `15000` | toast 超时 |
| `powershellPath` | `''` | 空 = 自动探测 |
| `log` / `logFile` | `true` / `''` | 日志开关与路径 |

也可以按 profile 覆写，写在该 profile 自己的 `cordis.patch.yml`：

```yaml
- id: dsh-approval-notifier
  config:
    sound: false
```

## 开发

```bash
npm test        # node --test "test/**/*.test.js"
```

无构建步骤 —— `lib/*.js` 即产物，直接发布。

## 目录结构

```
lib/index.js       宿主侧：事件观察、通知调度、协议注册、activate 路由
lib/client.js      浏览器侧：上报窗口/会话状态、渲染应用内提醒卡片
lib/config.js      配置分层与热重载
lib/notify.js      调用 toast.ps1 弹通知
lib/presence.js    「该不该弹、弹哪种」的判定
lib/message.js     通知文案
lib/protocol.js    URL scheme 注册与处理
lib/focus.vbs      点击通知后置前窗口（GUI 子系统，不闪黑框）
lib/toast.ps1      Windows toast 渲染
lib/inbox.js       待决通知队列
lib/session-read.js 读取会话上下文 / 审批策略
lib/desktop.js     探测桌面版安装路径
test/              node:test 测试
```

## License

MIT
