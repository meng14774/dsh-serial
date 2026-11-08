# dsh-serial — 给 agent 用的串口交互插件

> 版本：0.1.7 ｜ 许可：MIT ｜ 仓库：<https://github.com/meng14774/dsh-serial>
> 安装形态：DSH profile bundle（host-only）
> 目标端口：**上次成功打开的端口**（Windows 如 `COM7`，macOS 如 `/dev/cu.usbserial-1420`）@ 1500000 8N1，
> 其次才是设置里的 `defaultPort`
> 交接/开发细节见 [`AGENTS.md`](AGENTS.md)；macOS 移植见 [`PORTING-macOS.md`](PORTING-macOS.md)；
> 变更记录见 [`CHANGELOG.md`](CHANGELOG.md)

**它能做什么**：把串口变成 agent 可以直接读写的常驻内存流——16 个 `serial_*` 工具、
绝对字节游标、expect/transact、自动应答规则、端到端校验、无网络传文件，外加一个网页实时控制台。

```bash
# 方式一：从 npm（已发布时）
dsh plugin --profile <profile> add @meng14774/dsh-serial

# 方式二：从源码
git clone git@github.com:meng14774/dsh-serial.git
cd dsh-serial && ./build.sh                        # Windows: .\build.ps1
dsh plugin --profile <profile> add "$(ls -t dist/*.tgz | head -1)"
# 然后重启 DSH（见第 8 节）
```

## 1. 它解决什么问题

老办法是「把串口输出写成 log 文件，agent 再去读文件」——每次都要开一次串口、落一次盘、
再 read 一次，时序还容易错。

这个插件把串口变成**常驻的、可随机访问的内存流**：

- 串口一旦打开就**持续接收**，字节全部进入内存环形缓冲区（默认 4 MiB，可配），**不写任何日志文件**；
- agent 用**绝对字节游标**读取：`serial_read(cursor=12345)` 只要新数据，`cursor="start"` 回看全部历史；
- 等数据不用轮询：`serial_read(waitMs=5000)` 阻塞到有新字节或超时，`serial_expect("login:")` 等正则出现；
- `serial_transact` 一次调用完成「发一行 + 等提示符 + 去掉回显 + 返回干净输出」；
- 板子没有网络、SSH 不通时，`serial_push` / `serial_pull` 用 base64 走控制台传文件，并校验字节数。

一句话：**agent 随时 `serial_read` 就能拿到「从打开串口那一刻起」发生过的所有事情，不需要日志文本这个中间层。**

## 2. 架构

```
DSH host 进程
 ├─ lib/index.js      cordis 插件：注册 16 个 agent 工具 + system prompt 说明 + Web 控制台路由
 ├─ lib/engine.js     SerialManager / SerialSession：环形缓冲、游标、expect/transact、规则、传文件
 ├─ lib/ring.js       内存环形缓冲（绝对偏移，溢出丢最旧并报告 gap）
 ├─ lib/tools.js      工具定义（defineTool）
 ├─ lib/web.js        /dsh-serial 实时控制台 + /api/dsh-serial/*
 └─ lib/sidecar.py    Python + pyserial 子进程，独占 COM 口，NDJSON over stdio
                        ↑ 每收到一块数据就 base64 推给 Node，Node 只做缓冲和索引
```

为什么用 Python sidecar 而不是 Node 原生 `serialport`：
Electron 的 ABI 与 Node 不同，原生模块要按 Electron 重编译；pyserial 在本机已验证可用
（SerialKit 用的就是它），而且把「端口独占」隔离在独立进程里，插件热重载不会卡住串口。

## 3. 工具一览（agent 直接调用）

| 工具 | 作用 |
|---|---|
| `serial_list` | 系统端口（含 VID:PID/描述）、当前会话、**按端口保留的缓冲**、默认/上次使用的端口与波特率 |
| `serial_open` | 打开端口并常驻（默认不动 DTR/RTS，避免误复位；可指定波特率/校验/流控/缓冲大小）；**重开同一端口会接上原来保留的缓冲并报告丢没丢东西** |
| `serial_close` | 关闭一个或全部会话；**缓冲默认保留**（`dropBuffer: true` 才丢） |
| `serial_status` | 会话状态、缓冲/未读数、游标、最后收字节时间、**链路丢字节计数（link）**、最近操作、自动应答规则、**已关闭端口保留的缓冲** |
| `serial_write` | 发文本或 hex，行尾可选 `cr`/`lf`/`crlf`/`none`，支持 `repeat` 连发（抢 U-Boot 按键） |
| `serial_read` | 按游标读缓冲；`waitMs` 等新数据；`tailLines` 只取最后 N 行；`hex` 十六进制视图；**窗口内有丢字节会警告**；0 字节时直接提示「先查端口/波特率/供电」 |
| `serial_expect` | 等一个或多个正则出现，返回匹配、分组、命中后的游标（不发数据）；`idleMs` 空闲成帧 |
| `serial_transact` | 发一行并等正则，**自动跳过回显**，返回干净输出；`captureExitCode` 附带 `$?`；`idleMs` 空闲成帧；**`verify: true` 端到端校验输出**（跑命令首选）；**超时未匹配时直接给结论**（0 字节 / 只有回显 / 有输出无提示符） |
| `serial_ping` | 发一个 CR（或纯监听），回答「这条链路上还有活物吗」：返回首字节延迟、是否像提示符；**0 字节 = 端口/波特率/供电问题，不是正则问题** |
| `serial_set_default` | 记住「下次自动打开哪个端口/波特率」，持久化到 `~/.dsh/serial-state.json`，重启后仍有效 |
| `serial_script` | **整段脚本**（多行/管道/引号/heredoc 都不走 argv）：base64 落成板端临时文件，用 bash/python3 执行，返回输出 + exitCode |
| `serial_configure` | 改波特率、设 DTR/RTS、脉冲复位、发 BREAK、清输入缓冲 |
| `serial_rule` | 内存里的自动应答规则：命中新到达的字节就自动回发（登录、U-Boot、确认框） |
| `serial_probe` | 扫描波特率，报告哪一档能读出可打印文本（默认会发一个 CR 来诱发提示符） |
| `serial_push` | 本地文件 → 板子（base64 + heredoc，`wc -c` **+ sha256** 校验，失败自动重试，默认 3 次；回显确认率过低提前中止） |
| `serial_pull` | 板子文件 → 本地（base64 **分片 + 片间间隔**发送，整体 sha256 校验，失败自动降速重试；落盘前必须校验通过） |

游标语义：

- `"tail"`（默认）：只给上次读之后的新数据；
- `"start"`：给缓冲区里保留的全部历史；
- `"end"`：跳过现有的，只看之后到达的；
- 数字：上一轮结果里的 `cursor`，用于精确续读（可跨会话、可多读者各自持有）。

## 3.1 输出可信度与链路丢字节（0.1.5 新增）

**结论先说：高波特率（本机 1.5 Mbps）下这条链路会丢字节，而且 UART 不会告诉你。**

诊断方法：板端 `seq -f '%06g' 1 30000`（约 240 KB），统计收到的序号。实测：

| 方式 | 丢失 |
|---|---|
| 全速突发（`read(4096)`，即 sidecar 默认） | 240 KB 里丢 ~1100 字节（0.4%，几十处，每处丢几个到上百字符） |
| 每行间隔 2 ms 的慢速输出（~4 KB/s） | 0 |
| 分片 128 字符 + 每片 5 ms 间隔（~25 KB/s） | 偶尔仍丢（10 次拉取里 1–2 次） |
| 分片 64 字符 + 每片 8 ms 间隔（~8 KB/s） | 稳定 |

`ClearCommError` 报的是 `CE_OVERRUN`（硬件/驱动接收缓冲溢出），不是线缆噪声、也不是本插件读得慢——读循环再紧也一样丢。`serial_read(hex=true)` 看到的缺失字节在环形缓冲里就已经没了，所以问题在「串口 → 驱动 → sidecar」这一段之前。

由此插件提供三层保护，按「要不要逐字相信」选用：

1. **`serial_transact { verify: true }`** — 板端 `tee` 出同样内容并报 `sha256` + 字节数；本机把捕获到的字节（去掉 tty 的 CRLF 变换、控制台转义和提示符）算一次 hash 对照。
   - 一致 → `integrity: verified`，这段输出可以逐字相信；
   - 不一致 → 自动改用**分片+间隔**的通道把 tee 出来的文件取回来（命令只执行一次），结果同样标 `verified`，并注明 `captureOk: false` 表示实时捕获当时是花的。
2. **`serial_pull`** — 分片推送 + 整体 sha256，校验不过就降速重试（片宽减半、间隔加倍），校验通过才落盘。
3. **可见警告** — sidecar 每次读到 `CE_*` 就上报，`serial_read` / `serial_transact` 会在窗口内出现丢字节时输出 `WARNING: the serial driver reported lost bytes`，`serial_status` 的 `link:` 行是累计证据。注意它统计的是**驱动层丢字节**，和 `ring-overflow`（环形缓冲被覆盖）是两回事。

> 反过来：如果 `serial_transact` 没有开 `verify`，输出里也没有 loss 警告，那说明**这一次**驱动没报丢字节，但并不保证字节一定完整（漏报是可能的）。要确定性，用 `verify`。

## 3.2 会话死亡、端口安全与缓冲保留（0.1.6 新增）

真实事故：会话在 COM7 上，reader 报 `GetOverlappedResult failed (PermissionError(13, '拒绝访问。'))`，
旧版本的下一次工具调用却去打开 `defaults.port=COM15`——如果 COM15 恰好是另一个设备，
`rmmod` / `insmod -f` 这类命令就会发给它。对调试串口是事故，对烧录是灾难。现在不会了。

端口选择规则（按优先级）：

1. **端口已知**（会话活着，或死了但有保留缓冲）→ 只重开**同一个端口**。重开失败就报
   `serial session COM7 ended at 02:07:31 (…) and reopening COM7 failed: …`，并明说"没有打开别的端口"。
2. **什么都没打开过** → 打开**上次成功打开的端口**（持久化在 `~/.dsh/serial-state.json`），
   并明确写出"`config.defaultPort` 是 COM15，未被使用"。
3. 只有**从来没用过任何端口**时，才用设置里的 `defaultPort`，同样会明确说明。
4. 显式传 `session` / `port` 时只认它；找不到就报错并提示 `serial_open port=…`，绝不猜。

会话死掉之后：

- **下一次工具返回的最上方**出现 `! session COM7 ended at 02:07:31 (serial reader stopped: …)`；
- 端口名、结束时间、原因会记在 `serial_list` / `serial_status` 里；
- **环形缓冲按端口保留**（默认最多 8 个端口 × 各自 `bufferBytes`）。重开同一端口后游标连续，
  死前没读的 9626 字节还在，`serial_read`（默认 tail）会先把它们吐出来；
- `serial_close { dropBuffer: true }` 才会真正释放这份历史。

超时也不再靠人解读游标：`serial_transact` 对「0 字节（连回显都没有）」「只有回显、之后安静」
「有输出但没有提示符」三种情况各给一句结论和下一步建议；`serial_ping` 用一个 CR 回答
「这条链路上有没有活物」。

已知边界：0.1.6 仍不做「书签/固定某段历史」，也没有把 push/pull 的 base64 流量排除出环形缓冲——
大传输仍会挤掉旧历史（会报告 `ring-overflow` / `gap`）。

## 4. 典型工作流

```text
# 首次
serial_list                               # 确认端口在、没被 PuTTY 占用；看 sessions / retained
serial_open                               # 上次成功的端口（或设置里的 defaultPort）
serial_read(cursor="start", tailLines=40) # 串口打开前就在缓冲里的启动日志（如果有）

# 记住这次用的口，下次没有会话时就用它（不用每次写 port）
serial_set_default(port="COM7", baud=1500000)

# 判断"板子是不是挂了 / 口对不对"（0 字节 = 端口/波特率/供电问题）
serial_ping(timeoutMs=2000)
serial_ping(poke=false, timeoutMs=5000)   # 纯监听，不打扰 U-Boot 自动启动

# 跑一条命令（首选）
serial_transact(data="uptime", expect="[$#] $")
# -> matched "orangepi@orangepi:~$ " in 95 ms，输出已去掉命令回显

# 抓启动日志（复位后）
serial_configure(pulse="dtr", pulseMs=200)   # 若 DTR 接了复位；3pin 调试口通常没接
serial_read(waitMs=30000)                    # 等 30s 内的启动输出
serial_expect(pattern="login:|Starting kernel")

# 自动登录（内存规则，命中即回发）
serial_rule(action="add", name="login", pattern="login:\\\\s*$", send="orangepi\\r")
serial_rule(action="add", name="passwd", pattern="Password:\\\\s*$", send="orangepi\\r")

# 无网络传文件
serial_push(localPath="D:/CodeStation/WorkBUddy_WS/tools/agh_verify.sh", remotePath="/tmp/agh_verify.sh", chmod="755")
serial_transact(data="bash /tmp/agh_verify.sh", expect="[$#] $")
serial_pull(remotePath="/tmp/result.log", localPath="D:/CodeStation/WorkBUddy_WS/tmp/result.log")

# 整段脚本（管道/引号/多行/heredoc 都不经过 argv，推荐）
serial_script(script="set -e\nx='a b c'\nprintf '%s\\n' \"$x\" | tr ' ' '-'\nfor i in 1 2 3; do echo n$i; done")

# 要退出码：命令失败不会被当成成功
serial_transact(data="test -f /etc/hosts", captureExitCode=true)   # exitCode: 0
serial_transact(data="grep -q zzz /etc/hosts", captureExitCode=true) # exitCode: 1

# 输出没有换行（curl | head -c 400、进度条）：用空闲成帧取回
serial_transact(data="curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/", idleMs=300)
```

## 5. Web 实时控制台（给人看）

插件启动后打开：<http://127.0.0.1:19387/dsh-serial>

- 左上是会话/打开/关闭；中间是实时输出（每 350 ms 拉一次增量，和 agent 共用同一缓冲）；
- 底部输入框回车发送（可选 CR/LF/CRLF）；
- 守卫：仅 loopback，POST 要求 JSON + 同站，避免局域网或跨站表单写串口。

## 6. 配置（DSH 设置页）

`enabled` / `announceToAgent` / `defaultPort` / `defaultBaud` / `dataBits` / `parity` /
`stopBits` / `flowControl` / `dtr` / `rts` / `bufferBytes` / `pythonPath` / `encoding`。

全部是 volatile 字段：设置页改完即时生效，不用重启。
默认 `dtr=false, rts=false`（打开端口时把两线拉低，避免 CH340 的 DTR 复位电路误动作；
如果你的板子 DTR 接了复位又希望保持高电平，把它改成 `true`）。

**平台默认值（0.1.7）**：Windows 默认 `defaultPort=COM15`、`pythonPath=python`；
macOS/Linux 默认 `defaultPort` 为空（不猜端口）、`pythonPath=python3`，端口示例为
`/dev/cu.usbserial-1420`。macOS 上建议把 `pythonPath` 指到**绝对路径**（venv 或 Homebrew python），
原因和完整步骤见 [`PORTING-macOS.md`](PORTING-macOS.md)。

另有一个**运行期偏好**，不属于设置页：`~/.dsh/serial-state.json` 记住「上次成功打开的端口 +
波特率」，由 `serial_set_default` 或任意一次成功 `serial_open` 更新（`DSH_SERIAL_STATE=off`
可禁用）。它只在「没有任何会话、也没有保留缓冲」时用于自动打开，优先级高于 `defaultPort`，
避免 USB 适配器换口后设置页的旧值又把命令发到不存在的 COM15。

## 7. 坑与约束（实测）

1. **回显**：`serial_transact` 会先定位控制台回显行的结尾，**只从回显之后开始找 expect**，
   所以匹配串可以出现在命令里（`login:`、`php`、`grep` 都不会自匹配）；回显关掉时退化为
   事后裁剪。`serial_expect` 是纯缓冲正则，不发命令——如果某条命令是你刚手打且回显还在缓冲里，
   仍然可能命中回显，那种场景用 `serial_transact` 或显式 `cursor`。
2. **Linux/U-Boot 控制台行尾是 CR**（`\r`）。`serial_transact` 默认 `newline: "cr"`；改成 `lf` 会看起来"命令没反应"。
3. **串口是独占资源**：PuTTY / SerialKit / 别的程序开着时，打开通常会失败（`cannot open COM7: ...`）。
   Windows + CH340 有时允许"二次打开"，但两个读者会**静默瓜分字节流**（不是报错，是各拿一部分，
   实测丢 30%），所以跑测试前先确认没有第二个 `sidecar.py`。插件内部同一端口只允许一个会话。
   会话因占用/拔线而死时，端口名和原因会保留，下一次调用重开**同一个端口**（见 3.2），
   不会悄悄换口；保留的缓冲还能把死前没读的字节取回来。
4. **打开端口默认不动 DTR/RTS**，避免复位；要复位用 `serial_configure(pulse="dtr")`。
5. **输出里常有 `\r\n` 和 ANSI 转义**，工具默认已 strip；要原样看就 `stripAnsi=false` / `hex=true`。
6. **全屏 TUI（如 `top`、菜单式配置界面）** 不能靠 expect 判断状态，只能读屏面文本自己解析；
   `serial_transact` 对这种场景只能等超时。
7. 波特率 1.5 Mbaud 下别在一个 `serial_write` 里塞几百 KB——tty 输入缓冲有限。
   `serial_push` 已经按「逐行等回显」做流控（回显关闭时自动退化为 4 ms/行节奏）。

### 0.1.3 / 0.1.4 / 0.1.5 / 0.1.6 的交互改进（为什么上面这些坑现在小多了）

| 改进 | 行为 |
|---|---|
| **回显排除** | `serial_transact` 用 `#afterEcho` 定位回显行结尾，expect 只搜之后的字节；`searchFrom` 在结果里可见，便于确认真的跳过了 |
| **exitCode** | `captureExitCode=true` 时追加运行时 nonce 标记 `printf '\n__DSH_RC_<nonce>=%d__\n' $?`，结构化返回 `exitCode`；回显里只有 `%d`，不会自匹配 |
| **serial_script** | 脚本 base64 落成板端临时文件后交给 bash/python3，彻底避开 argv 引号/管道问题；>1200 字符自动复用 push 的分块流式 |
| **空闲成帧** | `idleMs` 在指定静默时长后返回部分输出（`idle: true`），无换行输出不再被吞 |
| **传输校验** | push 比对 `wc -c` + `sha256sum`，不一致自动重试（默认 3 次）；回显确认率低于 30% 时提前中止并说明原因 |
| **输出校验** | `serial_transact { verify: true }`：tee + 远端 sha256 对照，实时捕获是花的就改用分片通道取回（命令只跑一次） |
| **拉取校验** | pull 分片 + 片间间隔发送（默认 64 字符 / 8 ms），整体 sha256 校验，失败自动降速重试；落盘前必须校验通过 |
| **丢字节可见** | sidecar 上报 `CE_*` 驱动丢字节事件；`serial_read`/`serial_transact` 在窗口内警告，`serial_status` 有累计 `link:` 行 |
| **超时判活** | 等不到 pattern 但提示符已经回来了 → `status: timeout-but-prompt-seen`，不再当成超时失败 |
| **端口安全（0.1.6）** | 会话死亡只重开自己的端口；重开失败给出端口/时间/原因，**永不静默改用 `defaultPort`** |
| **缓冲保留（0.1.6）** | 环形缓冲按端口驻留；重开同口接上原缓冲（游标连续），`serial_close dropBuffer=true` 才丢 |
| **死亡告警（0.1.6）** | reader 死亡/重开/接入旧缓冲都会在下一次工具结果最上方以 `! …` 出现一次 |
| **超时结论（0.1.6）** | 0 字节 / 只有回显 / 有输出无提示符，三种超时直接给结论和下一步 |
| **serial_ping（0.1.6）** | 一个 CR 判断链路是否活着；`poke=false` 纯监听，不打扰 autoboot |
| **偏好持久化（0.1.6）** | `serial_set_default` 或成功 open 记住端口/波特率，重启后仍生效 |

## 8. 安装 / 更新 / 卸载

bundle 名为 `dsh-serial`。安装包由 `build.sh`（macOS/Linux）或 `build.ps1`（Windows）打包到
`dist/`，再用 `dsh plugin` 装进目标 profile。`dist/` 不进仓库（见 `.gitignore`）。

- **首次安装或升级后需要重启 DSH**。运行中的 host 在启动时快照了可解析的包清单，
  之后新加的包当场 import 会失败（`failed to import`），重启即生效。
  （profile 的 `patchReload` 为 `live` 时，实测新 bundle 也能热加载，但不要依赖这一点。）
- 从源码打包并安装（版本号必须递增，否则 pnpm 认为没变）：

```bash
git clone git@github.com:meng14774/dsh-serial.git
cd dsh-serial
./build.sh                          # 或 ./build.sh 0.1.8 升版本；Windows: .\build.ps1 -Version 0.1.7
dsh plugin --profile desktop add dist/meng14774-dsh-serial-0.1.7.tgz
# 或让 agent 调用 plugin_manager：install_bundle target=<abs>/dist/meng14774-dsh-serial-0.1.7.tgz
```

- npm 包名是 `@meng14774/dsh-serial`（scoped；`dsh-serial` 这个裸名字已被别人占用）：

```bash
npm i -g @meng14774/dsh-serial        # 或者直接
dsh plugin --profile desktop add @meng14774/dsh-serial
```

- 每个 GitHub Release 也附了现成的 `dsh-serial-<ver>.tgz`（见 Releases 页），可以直接下载安装：

```bash
dsh plugin --profile desktop add ~/Downloads/meng14774-dsh-serial-0.1.7.tgz
```

tgz 是纯 JS + Python，**跨平台通用**：在 Mac 上可以直接装 Windows 打出来的包，
不要求 Mac 上装 Node/npm。macOS 的驱动、`pythonPath`、`/dev/cu.*`、验证步骤见
[`PORTING-macOS.md`](PORTING-macOS.md)。

- 卸载：`dsh plugin --profile desktop remove dsh-serial`，然后重启。

## 9. 自测（不经过 DSH，直接打真串口）

```powershell
cd D:\work\dsh-serial
# 测试依赖（真实 defineTool + schemastery），只需跑一次；node_modules 可随时删
powershell -NoProfile -ExecutionPolicy Bypass -File .\test\prepare-deps.ps1
# macOS/Linux: ./test/prepare-deps.sh（默认找 /Applications/DeepSeek Harness.app，可用 DSH_ELECTRON 覆盖）

node test/schema.mjs                        # 只用真实 defineTool 校验 16 个工具的 schema
node test/platform.mjs                      # 0.1.7：平台文案 / linkWatch 诚实性（无需串口）
node test/live.mjs COM7 1500000             # 引擎：缓冲、游标、expect、规则
node test/transfer.mjs COM7 1500000         # probe + push/pull 往返校验（含 sha256）
node test/tools-live.mjs COM7 1500000       # 真实 defineTool + 工具 execute/render 全链路
node test/features.mjs COM7 1500000         # 0.1.3 交互回归：回显排除/exitCode/script/idle
node test/integrity.mjs COM7 1500000        # 0.1.5：verify=true 端到端校验 + 丢字节告警 + 分片 pull
node test/recovery.mjs COM7 1500000         # 0.1.6：杀 reader → 不换端口 / 告警 / 缓冲保留 / ping / 结论
node test/pull-verify.mjs COM7 1500000 4    # 40 KB 文件连续 pull，sha256 必须全部一致
python test/lossdiag.py COM7 1500000 r4096 30000 burst   # 链路丢字节复现实验（对照 board 端序号）
```

macOS 上端口换成 `/dev/cu.usbserial-…`；没有硬件时可以只跑离线部分：

```bash
node test/schema.mjs && node test/platform.mjs
DSH_SERIAL_OFFLINE=1 node test/recovery.mjs    # 只跑 Part A（端口安全逻辑），B 跳过
```

> 真串口测试会短暂占用端口，先确认没有别的程序/会话在用它（测试里会直接 kill 掉 sidecar 来模拟
> reader 死亡，所以不要在正在用的会话上跑 `recovery.mjs`）。
> `test/*.mjs` 依赖 `node_modules/@deepseek-ai/dsh-tools`（从 DSH asar 抽出的真实实现，
> 由 `prepare-deps.ps1` 生成，仅测试用；安装包 `files` 不包含 test 与 node_modules）。

## 10. 故障排查

| 现象 | 处理 |
|---|---|
| 设置页看不到插件 / agent 没有 `serial_*` 工具 | 装完必须**重启 DSH**；确认 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 含 `dsh-serial` |
| `error: cannot open COM7: PermissionError` | 被别的程序占用：关掉 PuTTY/SerialKit/旧 agent 进程；`serial_list` 看端口 |
| 工具结果最上方出现 `! session COM7 ended at …` | reader 死了（拔线/换口/被抢）；插件已按同一个端口重开或正在重开。先看这条告警里的原因，再 `serial_list` 确认端口还在；**不会**跳到别的口 |
| `serial session COM7 … reopening COM7 failed` | 端口已消失（换 USB 口会变成 COM8 等）：`serial_list` 找到新端口后 `serial_open port="COM8"`，旧缓冲仍保留在内存里 |
| `NO MATCH … 0 bytes came back` | 不是正则问题：先 `serial_ping`，再查波特率/端口/供电，`serial_probe` 扫波特率 |
| `NO MATCH … echoed, then the console went quiet` | 板子收下了命令但不输出：可能长命令还在跑、挂在 boot/panic，或这个 UART 没有 shell |
| 端口总被自动打开错的那个 | `serial_set_default(port="COM7")` 记住正确的；设置页的 `defaultPort` 只在"从没用过任何端口"时生效 |
| `python` / `python3` 找不到，或 `pyserial import failed` | 装上 pyserial（Windows `python -m pip install pyserial`；macOS 用 venv），或把设置里的 `pythonPath` 指到绝对路径（macOS 从 Finder 启动时 PATH 很干净，见 PORTING-macOS.md） |
| 全是乱码 | 波特率不对：`serial_probe` 扫描；或校验/停止位不对 |
| 命令没反应 | 行尾用 CR；或 shell 在等续行（发 `serial_write(hex="03")` = Ctrl+C） |
| `serial_push` 超时 | 板端不是 Linux shell / 没有 `base64`；先 `serial_transact` 确认提示符 |

## 11. 设计取舍

- **内存缓冲 vs 落盘日志**：内存只保留最近 N 字节，关会话/退出进程即丢；这正是"实时"的代价与收益。
  0.1.6 起缓冲**按端口保留**（重开同口可续读，`dropBuffer=true` 才释放），但仍不做长期留档：
  要存档就让 agent 显式 `serial_read(cursor="start")` 再写文件。
- **一个端口一个会话**：同一个口被多个 agent 共享，写入串行化；读各自持有游标，互不影响。
- **端口名是安全边界**：会话死亡只重开自己的端口，宁可报错也不猜；自动打开只发生在"什么都不知道"时，
  而且会说明用的是哪个偏好。
- **host-only**：不打包浏览器 bundle，Web 控制台是 host 直接吐的静态页，升级只动一个包。
- **不自动打开端口**：避免插件加载即拉 DTR 复位板子；第一次工具调用才打开（或显式 `serial_open`）。
- **Python sidecar 而不是 Node 原生模块**：避开 Electron ABI 重编译；pyserial 在本机已验证。

## 12. 归档与交接

归档位置：`D:\work\archive\dsh-serial\`

```
archive/dsh-serial/
├── dsh-serial-0.1.7-src.zip     源码快照（lib/ + test/ + 文档 + build.sh，不含 node_modules/dist）
├── dsh-serial-0.1.7.tgz         可安装包（profile 装的就是它）
├── README.md / AGENTS.md        当时的文档快照
├── PORTING-macOS.md             macOS 移植交接（源码位置、平台差异、验证清单）
├── SHA256SUMS.txt               校验和
└── VERSION.txt                  版本、装法、验证清单
```

交接顺序：README（是什么）→ PORTING-macOS.md（换平台）→ AGENTS.md（怎么改/怎么验/怎么升级）
→ `test/`（可执行的自测）。升级必须「提升版本 → pack → install → 重启 DSH」，原因见 AGENTS.md 第 1 节。
