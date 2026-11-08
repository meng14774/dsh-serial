# AGENTS.md — dsh-serial 开发与交接手册

> 读者：接手这个插件的 agent / 人。
> 先读 [`README.md`](README.md) 了解功能，本文件讲**怎么安全地改、怎么验证、踩过的坑**。

## 0. 一句话

`dsh-serial` 是一个 host-only 的 DSH 插件：把串口变成「常驻内存流 + 游标读」，给
agent 提供 16 个 `serial_*` 工具，并附带一个 `/dsh-serial` 网页实时控制台。**不写日志文件。**
缓冲按端口驻留，会话死亡只重开自己的端口，绝不静默换口（0.1.6）。
0.1.7 起可在 macOS 上跑（`python3` 默认、`/dev/cu.*`、丢字节能力诚实上报），移植细节见
[`PORTING-macOS.md`](PORTING-macOS.md)。

## 1. 当前状态（交接基线）

| 项 | 值 |
|---|---|
| 源码 | `D:\work\dsh-serial`（本目录） |
| 安装包 | `D:\work\dist\dsh-serial-<ver>.tgz` |
| 安装位置 | `~/.dsh/profiles/desktop`（`dependencies` + `dsh.profile.bundles`） |
| 运行方式 | host 进程内加载；串口由 Python/pyserial sidecar 独占 |
| 目标端口 | 上次成功打开的端口（`~/.dsh/serial-state.json`），其次设置里的 `defaultPort` |
| 网页控制台 | <http://127.0.0.1:19387/dsh-serial> |
| 真机验证 | 2026-11-01：open/prompt 64ms、transact 118ms、push/pull SHA256 一致、自动应答命中；0.1.3 回显排除/exitCode/script/idleMs 13 项通过；0.1.5 `verify=true`、丢字节告警、分片 pull；**0.1.6** 杀 reader 后不换端口/告警/缓冲续读/`serial_ping`/超时结论 16 项通过（COM7）；**0.1.7** 只做了离线校验（`schema.mjs`、`platform.mjs`、`recovery.mjs` 的 A1–A4），**未在 macOS 实机验证** |

**升级后必须重启 DSH。** 运行中的 host 在启动时快照了可解析的包清单；新装/换版本的
包当场 import 会失败（`failed to import`），重启后才会加载。这是实测结论，不是猜测。

## 2. 硬约束（违反会出事）

1. **串口是独占资源**。插件开着时，PuTTY / SerialKit / 另一个插件实例都会打不开或互相抢数据。
   CH340 驱动在 Windows 上有时允许"二次打开"，两个读者**会静默瓜分字节流**（不是报错，是每人拿到
   一部分），所以每个测试/调试脚本跑之前，先 `Get-CimInstance Win32_Process` 确认没有第二个
   `sidecar.py`：`Stop-Process` 掉再开。实测过一次污染：有人在旁边读，同一条命令的输出丢了 30%，
   差点被误判成插件 bug。具体：
   - 用插件前先确认没有别的程序占着串口（`serial_list` 看会话，`Get-CimInstance Win32_Process` 找 `sidecar.py`）；
   - 本插件内部同一端口只允许一个会话（`SerialManager.open` 会复用）；
   - 会话状态变成 `failed/closed` 时，`ensureSession` 重开**同一个端口**（0.1.6：绝不 fallback 到
     `defaultPort`）。重开失败的错误里带端口名、结束时间、原因；死前的缓冲保留在
     `manager.buffers` 里，重开时接上。
2. **高波特率下链路会丢字节，UART 不会告诉你（0.1.5 的立身之本）**。1.5 Mbps、无硬件流控时，
   `ClearCommError` 会报 `CE_OVERRUN`：驱动/芯片接收缓冲溢出，成片丢字节，读循环再紧也一样。
   实测 `seq 1 30000`（240 KB）全速突发丢 ~0.4%，慢速（4 KB/s）不丢；`serial_read(hex=true)`
   看到的缺失字节在进入环形缓冲之前就没了。因此：
   - **不要**指望「读得快」能修好它；需要逐字可信的输出就用 `serial_transact { verify: true }`；
   - **大块输出必须限速**：pull 的 `pieceChars/delayMs`（默认 64 / 8 ms ≈ 8 KB/s）就是为此；
     想更快就自己测试该链路的稳定速率，别直接调大；
   - sidecar 的 `linkErrorCount` 是**驱动层丢字节**计数，`ring.droppedBytes` 是**环形缓冲覆盖**，
     两者完全不同，`serial_status` 的 `link:` 与 `ring-overflow` 分列。
3. **回显与 expect**。`serial_transact` 会先跳过控制台回显行（`#afterEcho`），只在回显之后
   搜索，所以匹配串**可以**出现在命令里（`login:`/`php`/`grep`）。改动这段逻辑时保持这个性质：
   回显关掉时退化为事后裁剪。`serial_expect` 是纯缓冲正则，若命令回显还在缓冲里仍可能命中，
   那种场景用 `serial_transact` 或显式 `cursor`。插件内部的 push/pull/script/verify 用运行时拼的
   非字面标记（`DSH""_MARK_...`、`DSH""_S_x`、`%d` 占位），不要改成字面量——长命令的回显会被
   readline 用转义序列重绘，回显里出现的字面标记会让 expect 提前命中。
4. **Linux/U-Boot 控制台行尾是 CR**。`serial_transact` 默认 `newline: "cr"`；写 `\n` 会看起来"没反应"。
5. **打开端口默认不动 DTR/RTS**（`dtr=false, rts=false`）。有些板子 DTR 接复位，改成 `true`
   或脉冲前先确认原理图；3pin 调试口通常只有 GND/TX/RX。
6. **不要往磁盘写串口日志**。这是设计目标：数据只在内存环形缓冲里（默认 4 MiB / 端口），
   溢出丢最旧并报告 `gap`。需要留档时，由 agent 显式 `serial_read(cursor="start")` 再落文件。
   0.1.6 起缓冲按端口**保留**（会话死了也不丢，重开接上），但仍是内存，进程退出即消失；
   `serial_close { dropBuffer: true }` 可显式释放。唯一写盘的是运行期偏好
   `~/.dsh/serial-state.json`（端口名/波特率，不是串口数据）。
7. **Web 写接口只允许 loopback + 同站 JSON**。改 `lib/web.js` 时不要放宽，否则局域网页面能写串口。
8. **串口 sidecar 只依赖 pyserial**（Windows：`python -m pip install pyserial`；macOS/Linux：
   `python3 -m pip install pyserial`，建议 venv 并把 `pythonPath` 指到绝对路径）。不要引入需要
   编译的 Node 原生模块（Electron ABI 问题）。平台默认值集中在 `lib/index.js` 的 `DEFAULTS`、
   `lib/engine.js` 的 `DEFAULT_PYTHON` / `portExample()`、`lib/tools.js` 的 `PORT_EXAMPLE`。
9. **端口名是安全边界（0.1.6）**。会话死亡后工具只允许重开**它自己的端口**。`ensureSession`
   的解析顺序是：显式 `session`/`port` → `defaultId`（活着，或死但有保留缓冲）→ 其它活会话 →
   本进程记住的 `lastPort` → 设置里的 `defaultPort`。后两者只在"什么都没打开过"时使用，并且会以
   `! …` 通知写明用了哪个端口。改这段时**不要**把 `defaultPort` 放回 fallback 中间：一次误开
   另一个设备就可能把 `rmmod` / 烧录命令发给错误目标（真实事故）。实现要点：
   - `manager.buffers: Map<portKey, {ring, tailCursor, lastUsedAt, retired}>` 是"按端口驻留"的唯一真相；
   - `#retire(session, reason)` 把死会话变成 tombstone（保留 ring/游标/原因）并排一条 notice；
   - `#trimBuffers()` 只保留最近 `maxRetainedPorts=8` 个**非活动**端口；
   - `serial_open` 重开同口时从 entry 恢复 `tailCursor`，所以游标继续、未读字节仍可读。

## 3. 工具速查（16 个）

| 工具 | 一句话 | 关键参数 |
|---|---|---|
| `serial_list` | 端口 + 会话 + 保留缓冲 + 默认值/上次使用 | `force` |
| `serial_open` | 打开并常驻；同口重开会接上保留缓冲 | `port/baud/dataBits/parity/stopBits/flowControl/dtr/rts/bufferBytes` |
| `serial_close` | 关闭（缓冲默认保留） | `session/all/dropBuffer` |
| `serial_status` | 状态/游标/规则/最近操作/链路丢字节/保留缓冲 | `session` |
| `serial_write` | 发文本或 hex | `data/hex/newline/repeat/intervalMs` |
| `serial_read` | 游标读 + 等新数据（含 loss 警告、0 字节提示） | `cursor/maxBytes/waitMs/tailLines/hex/stripAnsi` |
| `serial_expect` | 等正则（不发） | `pattern/patterns/cursor/idleMs/timeoutMs/contextBytes` |
| `serial_transact` | 发一行 + 等正则 + 跳过回显；端到端校验；超时给结论 | `data/expect/patterns/timeoutMs/newline/captureExitCode/idleMs/verify/verifyAttempts` |
| `serial_ping` | 发一个 CR 判断链路是否活着（0 字节=端口/波特率/供电） | `timeoutMs/data/poke` |
| `serial_set_default` | 记住下次自动打开的端口/波特率（持久化） | `port/baud` |
| `serial_script` | 整段脚本（走临时文件，不经 argv） | `script/interpreter/sudo/timeoutMs` |
| `serial_configure` | 波特率/DTR/RTS/脉冲/BREAK/清缓冲 | `baud/dtr/rts/pulse/pulseMs/breakMs/flush` |
| `serial_rule` | 内存自动应答 | `action/name/pattern/send/once/cooldownMs` |
| `serial_probe` | 扫波特率 | `port/bauds/perBaudMs/poke` |
| `serial_push` | 本地 → 板子（base64，长度+sha256 校验，自动重试） | `localPath/remotePath/chmod/sudo/attempts` |
| `serial_pull` | 板子 → 本地（分片限速 + 整体 sha256，落盘前校验） | `remotePath/localPath/maxBytes/pieceChars/delayMs/attempts` |

游标：`"tail"`=只给新数据；`"start"`=缓冲里的全部历史；`"end"`=跳到末尾；数字=上次返回的 `cursor`。
`serial_read` 不传 cursor 时会推进会话的 tail 游标；显式传 cursor 时只读不动 tail。
0.1.6 起游标在同一端口的会话之间**连续**（缓冲被保留，重开后 `tail` 从上次读到的位置继续）。

## 4. 常见任务剧本

```text
# 跑命令（首选）
serial_transact { data: "uptime", expect: "[$#] $" }

# 板子没反应/怀疑挂死：先确认链路是否活着（0 字节 = 端口/波特率/供电，不是正则）
serial_ping { timeoutMs: 2000 }
serial_ping { poke: false, timeoutMs: 5000 }   # 纯监听，不打扰 autoboot

# 记住当前端口，免得每次写 port（持久化到 ~/.dsh/serial-state.json）
serial_set_default { port: "COM7", baud: 1500000 }

# 会话死了之后的正确姿势：直接继续调工具（会自动重开同一端口并报告保留了多少字节）
serial_read { }                     # 结果第一行会是 "! session COM7 ended at …"
serial_open { port: "COM7" }        # 或显式重开，会说明接上了多少旧字节

# 抓启动日志（复位前先开始读，或复位后从 start 捞）
serial_configure { pulse: "dtr", pulseMs: 200 }
serial_expect { pattern: "login:|Starting kernel", timeoutMs: 30000 }

# 无网络传脚本并执行
serial_push { localPath: "D:/.../x.sh", remotePath: "/tmp/x.sh", chmod: "755" }
serial_transact { data: "bash /tmp/x.sh", expect: "[$#] $" }

# 自动登录（内存规则，命中新字节即回发）
serial_rule { action: "add", name: "login", pattern: "login:\\s*$", send: "orangepi\r" }
serial_rule { action: "add", name: "passwd", pattern: "Password:\\s*$", send: "orangepi\r" }

# 波特率未知
serial_probe { port: "COM7", bauds: [115200, 1500000, 921600] }
```

## 5. 代码结构

```
lib/index.js    cordis 插件入口：Config schema、inject、sync()、注册工具/路由/systemPrompt 段
lib/engine.js   SerialSession（sidecar 生命周期、环形缓冲、读/expect/transact/ping、规则、状态）
                SerialManager（会话表、按端口保留的 buffers、notices、往返偏好、ports/probe/push/pull）
                #retire / #reopen / #trimBuffers：会话死亡后保留 ring 并按同端口重开
lib/ring.js     RingBuffer：绝对偏移、容量裁剪、gap 统计（纯函数，好测）
lib/tools.js    defineTool 定义 + 渲染（16 个 agent 工具；每次返回前带上 pending notices）
lib/web.js      /dsh-serial 页面 + /api/dsh-serial/*（loopback 守卫）
lib/sidecar.py  pyserial 子进程：NDJSON over stdio；reader 线程死掉时 os._exit 释放端口
                ready 消息带 platform / linkWatch（Win32 才有驱动丢字节计数）
build.ps1       打包（Windows；build.sh 是 POSIX 等价物）
PORTING-macOS.md 换平台交接：源码位置、平台相关点、macOS 验证清单、已知限制
```

**平台相关代码只有几处**（0.1.7）：`index.js` 的 `DEFAULTS`（`defaultPort`/`pythonPath`）、
`engine.js` 的 `DEFAULT_PYTHON`/`portExample()`/`open()` 里的 `/dev/tty.*` 提醒、
`sidecar.py` 的 `make_link_watcher()`（Windows-only）以及 ready 里的 `linkWatch`、
`tools.js` 的 `PORT_EXAMPLE`/`renderSession()` 文案。其余逻辑与平台无关。

数据流：`sidecar.py --stdout--> engine 环形缓冲 <-- 工具/网页按游标读`。
缓冲字典 `manager.buffers` 以**小写端口名**为键，跨会话持有 `{ring, tailCursor, retired}`；
`serialTools()` 把 manager 记在模块级 `noticesManager`，`serialTool.execute` 在返回前
`drainNotices()`，这就是「会话死了下一次调用会看到 `! …`」的实现。
sidecar 端口协议见 `sidecar.py` 顶部注释；改协议要同时改 `engine.js` 的 `#onLine`。

## 6. 开发与验证

```powershell
cd D:\work\dsh-serial

# 0) 一次性：准备测试用的真实 defineTool（从 app.asar 抽 dsh-tools + 写 stubs）
powershell -NoProfile -ExecutionPolicy Bypass -File .\test\prepare-deps.ps1

# 1) 纯逻辑（不需要串口）
node test/schema.mjs          # 16 个工具用真实 defineTool 编译 schema
node test/platform.mjs        # 0.1.7：平台示例端口 / linkWatch 文案（离线）

# 2) 真串口（会短暂占用端口，先确认没别人用；下面按本机 CH340=COM7 举例）
node test/live.mjs COM7 1500000         # 缓冲/游标/expect/自动应答
node test/transfer.mjs COM7 1500000      # probe + push/pull 往返 SHA256
node test/tools-live.mjs COM7 1500000    # 工具 execute/render 全链路
node test/features.mjs COM7 1500000      # 回显排除 / exitCode / serial_script / idleMs
node test/integrity.mjs COM7 1500000     # verify=true 端到端校验 / loss 告警 / 分片 pull
node test/recovery.mjs COM7 1500000      # 0.1.6：杀 reader → 不换端口 / 告警 / 缓冲续读 / ping
node test/pull-verify.mjs COM7 1500000 4 # 40 KB 连续 pull，sha256 必须全部一致
python test/lossdiag.py COM7 1500000 r4096 30000 burst  # 链路丢字节复现（hint: 先关会话、杀 sidecar）

# 3) 打包（改动后必须先提升版本号，pnpm 否则认为没变化）
.\build.ps1 -Version 0.1.7

# 4) 安装（plugin_manager 工具）：
#    install_bundle target=D:\work\dist\dsh-serial-0.1.7.tgz
#    然后重启 DSH
```

macOS/Linux：`./test/prepare-deps.sh`（`DSH_ELECTRON`/`DSH_PROFILE` 可覆盖默认路径）、
`./build.sh 0.1.7`；没有硬件时 `DSH_SERIAL_OFFLINE=1 node test/recovery.mjs` 只跑 Part A。
macOS 专用步骤见 [`PORTING-macOS.md`](PORTING-macOS.md)。

注意：`recovery.mjs` 会**直接 kill 掉自己的 sidecar** 来模拟 reader 死亡，不要对着正在用的
会话跑；它用临时 state 文件，不会改本机真实偏好。

验证是否真的激活：

1. `cordis_inspect` 的 Config provider 里 `dsh-serial` 状态应为 `active`；
2. 新会话里能调用 `serial_list`；
3. `http://127.0.0.1:19387/dsh-serial` 返回页面；
4. `serial_open` 后 `serial_status` 的 `pid` 变化，`bufferedBytes` 增长。

## 7. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 装完 entry 一直 `inactive`、日志 `failed to import` | 运行中的 host 不认新包：**重启 DSH**。确认 profile 的 `bundles` 含 `dsh-serial` 且 `node_modules/dsh-serial/package.json` 版本正确 |
| `PermissionError(13)` 打开失败 | 端口被别的进程占着：找 `sidecar.py`/`putty.exe`/`SerialKit`；`Stop-Process` 掉僵尸 sidecar 再试 |
| 会话显示 `open` 但 `lastError: read failed...` | 旧版本 reader 线程死后没退出（0.1.1 之前）。0.1.2 起 sidecar 会 `os._exit` 释放端口；0.1.6 起下一次工具调用重开**同一端口**并保留缓冲 |
| 工具结果最上方出现 `! session COM7 ended at …` | 0.1.6 的正常告警：reader 死了/会话被关。插件已重开同一端口（或已把缓冲留作 tombstone）。看告警里的原因，不要当成"端口换了" |
| `serial session COM7 ended … and reopening COM7 failed` | 端口真的没了（拔线、换 USB 口变 COM8、被别的程序独占）。`serial_list` 找新端口后 `serial_open port=…`；旧缓冲仍在内存里，重开同口还能读 |
| `NO MATCH … 0 bytes came back` | 不是 pattern 问题：先 `serial_ping`，再 `serial_probe` 扫波特率，检查供电/接线/端口号 |
| `NO MATCH … echoed, then the console went quiet` | 板子收下了行但不输出：长命令还在跑、卡在 boot/panic，或这个 UART 没有 shell |
| 自动打开的不是我想要的口 | 0.1.6 的优先级是「上次成功打开的端口 > 设置里的 defaultPort」；用 `serial_set_default { port }` 改掉偏好，或显式 `serial_open port=…` |
| `captureExitCode` 返回 `null` | 只对 POSIX shell 有效（U-Boot/AT 没有 `$?`）；也可能是命令把 shell 退了 |
| 输出没有换行、等不到提示符 | 用 `idleMs`（transact/expect），静默 200–500 ms 即返回部分输出 |
| push 报 "console stopped echoing" | 链路在丢字节或回显被关：先 `serial_transact` 确认提示符与回显，再重试 |
| 大文件 push 校验不一致 | 工具会自动重试（默认 3 次）；仍失败就改用 `serial_script` 分块处理或降低 chunkChars |
| 输出看着正常但内容缺字 / `ls` 少了几列 | 链路丢字节：`serial_status` 看 `link:`；要可信输出用 `serial_transact { verify: true }`，批量取文件用 `serial_pull`（分片限速） |
| `serial_pull` 报 "sha256 mismatch" / 一直重试 | 片速仍高于该链路极限：调小 `pieceChars`、调大 `delayMs`（如 32 / 15 ms）；工具本身会自动降速重试 |
| `serial_read` 显示 "driver reported lost bytes" | 驱动承认这窗口丢了字节，文本不可逐字相信；重跑该命令并开 `verify`，或从板端文件重取 |
| 同一条命令输出时好时坏、丢一大截 | 很可能有第二个读者（另一个 sidecar/PuTTY/SerialKit）：`Get-CimInstance Win32_Process` 里找 `sidecar.py` 全部杀掉再试 |
| 输出全是乱码 | 波特率不对 → `serial_probe` |
| 命令没反应 | 行尾 CR；或 shell 在等续行 → `serial_write { hex: "03" }`（Ctrl+C） |
| `serial_push` 超时 | 板端不是 Linux shell / 没有 `base64`；先 transact 确认提示符 |
| 网页 403 | 非 loopback 访问；只允许 127.0.0.1/::1 |
| `serial_list` 里端口在但打不开 | 端口被独占（正常现象），或驱动未就绪 |

## 8. 与其它项目的关系

- **SerialKit**（`D:\work\SerialKit`）：用户自己的通用串口工具，按"落盘日志"工作。
  本插件是它的替代品，不要改 SerialKit 仓库；两者不要同时开同一个口。
- **软路由项目**（本工作区 `HANDOVER.md`）：串口是 SSH 失联时的兜底通道，本插件可替代
  `tools/sk_push2.py` 等脚本。`serialkit.yaml` 仍保留，作为 SerialKit 的配置。
- **DSH 本体**：插件只依赖公开 npm 包（`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools`），
  不改 DSH 源码。`defineTool` 从真实实现里取（测试时 `prepare-deps.ps1` 抽取）。

## 9. 变更记录

- **0.1.7**（macOS 移植交接）
  - 非 Windows 默认 `pythonPath=python3`、`defaultPort` 为空（不再拿 `COM15` 去开 Mac 上的口），
    端口示例按平台生成（`COM15` / `/dev/cu.usbserial-1420` / `/dev/ttyUSB0`）；
  - macOS 上打开 `/dev/tty.*` 排一条 notice，提示改用 `/dev/cu.*`（tty 会等载波）；
  - sidecar ready 上报 `linkWatch`；`serial_status` 在 macOS/Linux 显示
    `NOT OBSERVABLE`，不再把"没有计数"说成"没有丢字节"；
  - 新增 `build.sh`、`test/prepare-deps.sh`（POSIX）、`test/platform.mjs`（离线平台检查）；
    `recovery.mjs` 支持 `DSH_SERIAL_OFFLINE=1` 跳过真机部分；测试默认 python/端口按平台；
  - 新增 `PORTING-macOS.md`；tgz 的 `files` 带上该文档；
  - **未在 macOS 实机验证**（仅 Windows 离线校验），风险点与验证清单见 PORTING 文档第 9 节。
- **0.1.6**（2026-11-02，回应"会话死了却去开默认端口 / 缓冲跟着丢 / 超时没有结论"的反馈）
  - **端口安全**：会话死亡后 `ensureSession` 只重开**它自己的端口**；重开失败直接报端口名 +
    结束时间 + 原因，明确"没有打开别的端口"。`defaultPort` 只在"从未用过任何端口"时兜底，
    且会以通知说明。新增 `~/.dsh/serial-state.json` 记住上次成功的端口/波特率
    （`serial_set_default` 可改，`DSH_SERIAL_STATE=off` 可禁用）。
  - **缓冲按端口驻留**：`manager.buffers` 跨会话保存 ring + `tailCursor`，重开同口接上，
    死前未读的字节仍可读；`serial_close { dropBuffer: true }` 才释放；最多保留 8 个非活动端口。
  - **死亡可见**：`session ended at …` 作为 notice 出现在**下一次工具返回的最上方**；
    `serial_list`（含 retained 区块）与 `serial_status` 也能看到。
  - **超时结论**：`serial_transact` 对「0 字节」「只有回显后安静」「有输出无提示符」分别给结论；
    `serial_read`/`serial_expect` 在 0 字节时也提示先查端口/波特率/供电。
  - **新增 `serial_ping`**：一个 CR（或 `poke:false` 纯监听）判断链路是否活着，给首字节延迟与
    提示符判断；**新增 `serial_set_default`**。
  - `serial_open` 报告重开时接上了多少旧字节；`serial_close` 报告保留/丢弃了多少；
    `serial_status` 可查询已关闭端口的保留缓冲；Web 状态接口返回 `retained`/`lastPort`。
  - 新增 `test/recovery.mjs`（离线 5 项 + 真机 16 项：杀 sidecar → 不换端口/告警/续读/ping/结论）。
  - 已知未做：书签固定历史、把 push/pull 的 base64 流量排除出环形缓冲（大传输仍会挤掉旧历史）。
- **0.1.5**（2026-11-02，回应"链路会丢字节而工具不告诉我"的反馈）
  - 查清根因：1.5 Mbps 无流控时驱动报 `CE_OVERRUN`，`seq 1 30000` 全速突发丢 ~0.4%；读得更快没用。
    sidecar 现在每轮读取后调 `ClearCommError`，用 `{"t":"link"}` 上报丢失事件与偏移；
  - `serial_read`/`serial_transact` 在窗口内有丢字节时给出明确警告，`serial_status` 增加 `link:` 行，
    并把原来的 `dropped` 改名为 `ring-overflow`（两者含义不同）；
  - 新增 `serial_transact { verify: true }`：板端 tee + sha256 对照；实时捕获是花的则自动用
    分片通道取回 tee 出的文件（命令只执行一次），结果 `integrity: verified`；
  - `serial_pull` 重写：不再一次吐整个 base64，改为分片限速推送（默认 64 字符 / 8 ms），
    整体 sha256 校验，失败自动降速重试，校验通过才落盘；
  - `serial_transact` 超时但已看到提示符 → `status: timeout-but-prompt-seen`，不再误报超时；
  - `serial_push` 重试次数可配（默认 3）；
  - 新增 `test/integrity.mjs`（验证/告警/分片 pull）与 `test/lossdiag.py`（丢字节复现实验）。
- **0.1.4**（2026-11-01）
  - `serial_pull` 增加 sha256 校验（远端 hash 在同一捕获里带回）+ 失败自动重试一次；
    实测 41 KB 连续 4 次拉取中出现 1 次真丢字节，重试后校验通过；
  - `serial_transact` 的 captureExitCode 输出不再展示内部标记，只显示 "exit code: N"；
  - 新增 `test/pull-verify.mjs`。
- **0.1.3**（2026-11-01，基于另一个 agent 的实战反馈）
  - `serial_transact` **跳过回显再搜索**：匹配串可以出现在命令里，算术标记技巧不再需要；
  - `serial_transact` 新增 `captureExitCode`，结构化返回 `exitCode`（运行时 nonce 标记，回显不自匹配）；
  - 新增 `serial_script`：整段脚本 base64 落临时文件后执行，彻底避开 argv 引号/管道问题；
  - `expect/transact` 新增 `idleMs` 空闲成帧，无换行输出不再被吞；
  - `push` 增加 sha256 校验 + 失败自动重试一次 + 回显确认率过低提前中止；
  - 新增 `test/features.mjs` 回归（真机 13 项检查全过）；测试提示符改为通用 `[$#] $`。
- **0.1.2**（2026-11-01）
  - reader 线程异常时 sidecar 立即退出并释放端口（修复"open 但已死"的僵尸会话）；
  - `ensureSession` 对 failed/closed 会话自动重开，失败信息带上一次原因；
  - 新增 `test/prepare-deps.ps1` + `extract-dsh-tools.cjs`，测试依赖可一键重建；
  - 清理：移除重复 dist、node_modules、临时脚本；归档到 `archive/dsh-serial/`。
- **0.1.1**（2026-11-01）
  - 新增 Web 控制台 `/dsh-serial` 与 `/api/dsh-serial/*`；
  - 13 个工具定稿（含 push/pull、rule、probe）；
  - 真机全流程验证通过（push/pull SHA256 一致）。
- **0.1.0**：首个可用版本（engine + 环形缓冲 + 游标 + expect/transact + 自动应答）。
