# dsh-wechat-clawbot

在**微信**里直接用 DeepSeek Harness：通过微信自带的 **ClawBot** 插件扫码接入，双向收发消息。

> 由 **易佳科技**（Eagiaon IT）开发并维护。

- 扫码登录，不需要企业微信、不需要抓包、不需要公网 IP
- 每条微信消息交给一个真实的 DSH 会话（同一个微信用户 = 同一个会话，带上下文）
- 回答回到微信；`/new` `/stop` `/help` `/id` 四个指令
- 「正在输入」用 typing 接口表示，不浪费消息条数

> 协议来自腾讯官方 OpenClaw 微信通道（[Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)，MIT）以及
> [wechat-clawbot-push](https://pypi.org/project/wechat-clawbot-push/) 的实现核对。

---

## 1. 它怎么工作

微信里的 ClawBot 本质是腾讯 iLink 的 bot 通道：

```
微信 App ──扫码──▶ ilink/bot/get_bot_qrcode ─▶ 拿到二维码内容
          ◀─确认── ilink/bot/get_qrcode_status ─▶ bot_token + baseurl
你的消息 ──▶ ilink/bot/getupdates（长轮询，35s）
                    │
                    ▼
            DSH agent（真会话，真工具）
                    │
你收到回复 ◀── ilink/bot/sendmessage（带 context_token）
```

本插件就是这段链路的 DSH 实现：`ctx.agents` 建/续会话，`followup` 投递用户消息，
`whenIdle` 等回合结束，再把最后一条 assistant 文本发回去。

---

## 2. 安装

### 方式 A：从 GitHub 装（推荐）

```powershell
dsh plugin --profile desktop add github:Pythonxiaoyang/dsh-wechat-clawbot
```

然后把 `dsh-wechat-clawbot` 加进 profile 的 `dsh.profile.bundles`（`~/.dsh/profiles/desktop/package.json`），
重启 DeepSeek Harness。

### 方式 B：从本地目录挂载（不依赖 pnpm / 带外网构建）

1. 建一个目录联接（junction），让 profile 能 `import` 到这个包：

   ```powershell
   $src  = "D:\文档\deepseek-harness\default-workspace\dsh-wechat-clawbot"   # 换成你克隆下来的路径
   $link = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-wechat-clawbot"
   New-Item -ItemType Directory -Force (Split-Path $link) | Out-Null
   New-Item -ItemType Junction -Path $link -Target $src
   ```

2. 在 `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾加一行：

   ```yaml
   - insert:
       - id: wechat-clawbot
         name: dsh-wechat-clawbot
   ```

3. 重启 DeepSeek Harness（桌面端直接退出再打开）。

---

## 3. 首次登录

插件启动后会在 stderr 打印两样东西：

```
[wechat-clawbot] 扫码页面：http://127.0.0.1:5xxxx/<随机串>/
[wechat-clawbot] 二维码链接：https://…
```

浏览器打开那个 `127.0.0.1` 地址即可看到二维码（页面只监听本机，登录成功后会提示「登录成功」）。
手机微信扫码 → 在手机上确认；如果手机让你输入**配对数字**，直接在页面的输入框里填。

登录成功后凭证落在：

```
%USERPROFILE%\.dsh\storages\wechat-clawbot\state.json
```

这个文件里有 `bot_token`（等于这只 bot 的收发权限），**不要发给别人**，权限已按 0600 写。

> 注意：微信侧一只 ClawBot 同时只能绑一个客户端。绑了本插件，原来绑定的那个客户端/设备会被顶掉。

---

## 4. 配置

全部可选项，写进 `cordis.patch.yml` 那一行的 `config:` 下：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉插件 |
| `autoLogin` | `true` | 没有凭证时自动出二维码 |
| `botToken` | — | 已有凭证可直接填，跳过扫码 |
| `baseUrl` | `https://ilinkai.weixin.qq.com` | 接入点（联调时可指向假服务端） |
| `stateDir` | `~/.dsh/storages/wechat-clawbot` | 凭证/游标/会话映射落盘目录 |
| `cwd` | 进程工作目录 | 微信会话的工作目录；**建议显式设置**，否则换启动目录会让历史会话找不到 |
| `provider` / `model` | 取 `agentDefaultModel` 当前选择 | 强制指定模型路由（例如 `deepseek-account` + `deepseek-flash`） |
| `agentPreset` | 部署默认 preset | 会话挂哪个 agent preset（决定有哪些工具） |
| `approvalPolicy` | `never` | `autoApprove: false` 时生效：微信里没人点「允许」，默认 fail-closed |
| `autoApprove` | `true` | 自动放行需要审批的工具（否则会一直卡在等审批） |
| `permissionPreset` | `danger-full-access` | 会话权限档位。`danger-full-access` 才能写工作区外的文件（比如桌面）；想收窄就改成 `workspace-write` |
| `turnTimeoutMs` | `180000` | 单轮超时；超了就打断并回一条「超时」，不会永远「正在输入」 |
| `maxReplyChars` | `1800` | 单条回复上限，超了截断（微信限流很紧） |
| `allowUsers` | `[]`（不限制） | 只服务这些 `from_user_id` |
| `typing` | `true` | 处理时显示「正在输入」 |
| `uiPort` | `0`（随机） | 扫码页面端口 |
| `logLevel` | `info` | `silent` / `error` / `warn` / `info` / `debug` |

例子：

```yaml
- insert:
    - id: wechat-clawbot
      name: dsh-wechat-clawbot
      config:
        cwd: D:/work
        provider: deepseek-account
        model: deepseek-flash
        maxReplyChars: 1200
```

---

## 5. 微信里能用的指令

| 指令 | 作用 |
|---|---|
| `/help` | 帮助 |
| `/new` | 清空上下文，开新会话 |
| `/stop` | 打断正在跑的这一轮 |
| `/id` | 看自己的微信用户 id 和当前会话 id |

其他任何文本都会作为一轮对话交给 agent。

---

## 6. 已知限制

- **消息额度**：微信侧一只 bot 大约每 5 分钟只能发 7 条。插件默认一轮只回一条，超长回复直接截断，不拆迁就。
- **二维码会过期**：过期后页面会自动换一张（最多连换 3 张）；如果整轮 8 分钟都没扫上，插件会隔一会儿重新出码重试，页面跟着刷新，不用重启。
- **审批**：默认 `autoApprove: true` + `permissionPreset: danger-full-access`，等于**微信里发一句话就能在你电脑上读写任意文件**。这适合自己一个人用的机器；如果这台机器还有别人用，把 `permissionPreset` 改成 `workspace-write` 或 `autoApprove: false`。
- **会话恢复**：重启后会尝试 `resume` 上次的会话；如果存档读不出来（版本/校验问题），插件会自动换一个新会话 id 继续，不会让这个用户彻底卡死，但历史会丢。
- **只处理文本**：图片/语音/文件目前只回一句「暂时只看得懂文字」；语音若带转写文本则按文本处理。
- **协议是逆向对齐的**：腾讯随时可能改字段；出问题先看 `logLevel: debug` 的日志。

---

## 7. 开发与联调

```powershell
cd D:\文档\deepseek-harness\default-workspace\dsh-wechat-clawbot
npm test          # 22 个用例：协议、二维码、桥接、通道
```

不需要真微信也能跑通整条链路：

```powershell
# 1) 起一个假的 iLink 服务端（额外提供 /__push、/__sent 两个调试接口）
node tools/mock-server.mjs --port 8787

# 2) 用任意一个 profile 挂上插件，config 指向假服务端
#    name: dsh-wechat-clawbot
#    config: { baseUrl: http://127.0.0.1:8787, provider: deepseek-account, model: deepseek-flash }

# 3) 塞一条“用户消息”，看插件回了什么（都是 UTF-8 安全的）
node tools/push.mjs "用一句话介绍你自己"
node tools/sent.mjs
```

目录：

```
src/ilink.js     iLink 协议客户端（扫码/收/发/typing）
src/clawbot.js   通道主体：登录、长轮询、限流、指令、typing
src/bridge.js    微信 peer ↔ DSH agent（preset、审批策略、回合与回复提取）
src/state.js     凭证/游标/会话映射的原子落盘
src/qr.js        二维码（SVG + 终端字符），vendor 里是 qrcode-generator（MIT）
src/ui.js        扫码小页面（只监听 127.0.0.1）
tools/           联调用的假服务端与两个小脚本
test/            node:test 用例
```

## 关于

**易佳科技**（Eagiaon IT）开发并维护。这套插件最初是为了让团队在微信里直接指挥本机的 DeepSeek Harness 而写的：不用开电脑、不用远程桌面，手机上发一句话就能让 agent 读文件、改代码、跑命令。

问题、建议、二次开发都欢迎提 issue / PR。

## License

MIT。`vendor/qrcode.mjs` 来自 [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)（MIT, Kazuhiko Arase）。
