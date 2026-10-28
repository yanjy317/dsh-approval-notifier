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

### 应用内提醒卡片

卡片本身也是可操作的，不必先跳转：

- **就地作答**：审批卡片自带「允许一次 / 拒绝」，走的是和 toast 按钮同一条 `decide`
  通路 —— 仍然是页面 resolve 自己正在展示的那个待决审批，不是第二套权威。
  若该审批已被回答、或已被同一会话里更晚的审批取代，`callId` 对不上，卡片不会假装成功。
- **信息层级**：类型徽标（审批 / 提问）+ 存在时长、标题、单行预览（`ui-monospace`，
  超 96 字符截断为 `…`）、可展开的完整正文。长命令不再把会话信息挤出视野。
- **折叠**：最多同时显示 3 张，其余折进「另有 N 条提醒」，可展开也可收起。
- **动效**：进入时淡入上滑，悬停时轻微抬起并让边框染上该类型的强调色；
  `prefers-reduced-motion` 下全部关闭。

类型区分：审批用橙色 `⚠`，提问用蓝色 `?`，色带同时作用于左边框与徽标。

### 为什么必须注册 AppUserModelID

插件启动后会为 `appId`（默认 `DSH.ApprovalNotifier`）在
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\<appId>.lnk` 建一个开始菜单快捷方式，
并把 `System.AppUserModel.ID` 属性（经 `IPropertyStore`）写成同一个 id。

这一步不能省：Win32 进程可以用**任意**字符串调 `CreateToastNotifier(id).Show()`，
WinRT 会照收不误 —— `Show()` 不抛异常、`Setting` 一直报 `Enabled`、内容甚至被写进
`wpndatabase`。但 shell **不会显示**它，因为它只能把 id 映射回一个已安装的应用；
对未打包应用，这个映射就是上面那条快捷方式。缺了它，通知被静默丢弃：没有横幅、
没有声音、通知中心里也没有。

这也是本插件早期版本「看起来在发通知，实际什么也看不到」的原因。判断依据是
`/status` 的 `toastIdentity` 字段（`ok`/`created`/`path`/`error`），**不要**相信
`/test` 返回的 `ok: true` —— 它只说明 `Show()` 没抛异常。

注册是幂等的：快捷方式已带正确 id 就原样保留，带了别的 id 才改写。改 `appId`
会重建；`appId` 或可执行文件变更后才重新注册，不会每条通知都起一次 PowerShell。
注册失败会退避 60 秒再试一次 —— 一个注定失败的机器（没有开始菜单、被策略锁住、
缺 PowerShell）不该在每次调用上都白起一个 1.5 秒的子进程，但暂时的失败也必须能自愈。

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
lib/shortcut.js    AppUserModelID 注册（toast 身份）
lib/focus.vbs      点击通知后置前窗口（GUI 子系统，不闪黑框）
lib/toast.ps1      Windows toast 渲染
lib/register-shortcut.ps1  建开始菜单快捷方式并写入 AppUserModelID
lib/inbox.js       待决通知队列
lib/session-read.js 读取会话上下文 / 审批策略
lib/desktop.js     探测桌面版安装路径
test/              node:test 测试
```

## License

MIT
