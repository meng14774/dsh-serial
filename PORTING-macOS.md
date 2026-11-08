# dsh-serial 移植到 macOS — 交接文档

> 读者：要在 Mac 上跑这个插件的人 / agent。
> 功能与设计先看 [`README.md`](README.md)，开发约束看 [`AGENTS.md`](AGENTS.md)；
> 本文只讲**源码在哪、哪些地方是平台相关的、到 Mac 上要做什么、怎么验证**。

---

## 0. 快速结论

- 插件是 **纯 JS + 一个 Python/pyserial sidecar**，没有 Node 原生模块，**不需要在 Mac 上重新编译**。
  `dist/dsh-serial-<ver>.tgz` 是平台无关的，拷到 Mac 直接装即可。
- 0.1.7 起代码里只保留**行为默认值**级别的平台差异：Mac 上 `pythonPath` 默认 `python3`、
  `defaultPort` 默认为空（不再拿 `COM15` 去开一个不存在的口）、示例端口是 `/dev/cu.*`。
- 唯一真正的**能力差异**：Windows 能用 `ClearCommError()` 报告驱动层丢字节，macOS/Linux 不能。
  所以 Mac 上 `serial_status` 的 `link:` 会显示 `NOT OBSERVABLE`，**不要把它读成"链路干净"**；
  要逐字可信就用 `serial_transact { verify: true }` 或限速 `serial_pull`。
- 本文的 Mac 步骤**没有在真实 Mac + 串口上跑过**（我只有 Windows + CH340）。凡是标了
  ⚠️ 的地方都是"按 macOS/pyserial 行为推断，需要你实测确认"的。

---

## 1. 源码和产物在哪里

开发机（Windows）上的位置：

| 内容 | 路径 |
|---|---|
| **活跃源码**（唯一真源） | `D:\work\dsh-serial` |
| 可安装包 | `D:\work\dist\dsh-serial-0.1.7.tgz` |
| 源码快照（可拷走） | `D:\work\archive\dsh-serial\dsh-serial-0.1.7-src.zip` |
| 归档说明 / 校验 | 同目录 `VERSION.txt`、`SHA256SUMS.txt` |
| 已安装位置（本机） | `C:\Users\<you>\.dsh\profiles\desktop\node_modules\dsh-serial` |
| 运行期偏好（不是串口日志） | `~/.dsh/serial-state.json` |

源码目录结构（`package.json` 的 `files` 决定装进 tgz 的内容）：

```text
dsh-serial/
  package.json            npm 包定义；dsh.bundle.patch 指向 cordis.patch.yml
  cordis.patch.yml        DSH bundle 声明
  build.ps1               Windows 打包脚本（可继续用）
  build.sh                0.1.7：macOS/Linux 打包脚本（POSIX）
  lib/
    index.js              cordis 插件入口：Config、inject、sync、工具/路由/systemPrompt
    engine.js             SerialSession + SerialManager + RingBuffer 接线（平台相关代码集中在这）
    ring.js               纯函数环形缓冲（绝对偏移、gap 统计）
    tools.js              16 个 agent 工具 + 渲染（平台相关只影响文案）
    web.js                /dsh-serial 网页 + /api/dsh-serial/*（loopback 守卫）
    sidecar.py            pyserial 子进程，NDJSON over stdio（平台相关：link watcher）
  test/
    schema.mjs            16 个工具用真实 defineTool 编译 schema（无需串口）
    platform.mjs          0.1.7：平台文案 / linkWatch 诚实性（无需串口）
    live.mjs              真串口：缓冲/游标/expect/规则
    transfer.mjs          真串口：probe + push/pull 往返 sha256
    tools-live.mjs        真串口：工具 execute/render 全链路
    features.mjs          回显排除 / exitCode / serial_script / idleMs
    integrity.mjs         verify=true / 丢字节告警 / 分片 pull
    recovery.mjs          杀 reader → 不换端口 / 告警 / 缓冲续读 / ping（支持 DSH_SERIAL_OFFLINE=1）
    pull-verify.mjs       连续 pull sha256
    lossdiag.py           链路丢字节复现实验（Windows 用）
    prepare-deps.ps1      Windows：从 DSH app.asar 抽 dsh-tools + 写 stubs
    prepare-deps.sh       0.1.7：macOS/Linux 同上的 POSIX 版
    extract-dsh-tools.cjs 在 app.asar 内复制 dsh-tools 的小脚本（跨平台）
  README.md               功能/用法/排障
  AGENTS.md               开发与交接手册
  PORTING-macOS.md        本文
```

**给 Mac 的最短路径**：拿 `dsh-serial-0.1.7-src.zip`（源码）和 `dsh-serial-0.1.7.tgz`（可安装包）
两个文件即可，不需要整棵工作区。

---

## 2. 架构一页

```text
DSH host 进程
 ├─ lib/index.js        cordis 插件：注册 16 个 serial_* 工具 + /dsh-serial 路由 + 提示词
 ├─ lib/engine.js       SerialManager ── 每个端口一个 SerialSession
 │                       ├─ 内存环形缓冲（默认 4 MiB/端口，不写日志）
 │                       ├─ 绝对字节游标（tail/start/end/数字）
 │                       ├─ 按端口驻留的 buffers（会话死了缓冲还在）
 │                       └─ notices（下一次工具结果最上方的 "! …"）
 └─ lib/sidecar.py      Python + pyserial 子进程，stdin/stdout 上说 NDJSON
                         收到串口字节 → {"t":"d","b64":…} → engine 追加进 ring
```

关键数据流：**串口字节只存在于内存**。写盘的只有 `~/.dsh/serial-state.json`
（上次成功打开的端口 + 波特率），可以用 `DSH_SERIAL_STATE=off` 关掉。

工具调用时 `SerialManager.ensureSession()` 的解析顺序（0.1.6 的端口安全规则，Mac 上同样生效）：

```text
显式 session/port
→ 默认会话（活着，或死了但缓冲还在）
→ 其它活会话
→ 本次进程记住的 lastPort
→ 配置里的 defaultPort        ← 只有"什么都不知道"才用，并且会明说
```

死亡后只重开**它自己的端口**；失败会报 `serial session <port> ended at <time> (...) and reopening
<port> failed: … No other port was opened.`，不会静默换口。

---

## 3. 平台相关代码清单（移植时只看这些）

| 位置 | Windows 行为 | macOS 行为 / 0.1.7 处理 |
|---|---|---|
| `lib/index.js` `DEFAULTS` | `defaultPort: 'COM15'`、`pythonPath: 'python'` | 非 Windows：`defaultPort: ''`、`pythonPath: 'python3'`；仍可由设置页/`DSH_SERIAL_PYTHON` 覆盖 |
| `lib/engine.js` `DEFAULT_PYTHON` | `python` | `python3` |
| `lib/engine.js` `portExample()` | `COM15` | `/dev/cu.usbserial-1420`（Linux `/dev/ttyUSB0`），用于错误文案 |
| `lib/engine.js` `open()` | — | 打开 `/dev/tty.*` 时排一条 notice，提示改用 `/dev/cu.*` |
| `lib/engine.js` `cfg()` / `SerialSession` | 同上 python 默认 | 同上 |
| `lib/sidecar.py` `make_link_watcher()` | `serial.win32.ClearCommError` 上报 `CE_*` | import 失败 → 返回 `None`；ready 里带 `linkWatch:false`，engine/tools 据此显示 `NOT OBSERVABLE` |
| `lib/sidecar.py` `--rxbuf` | `ser.set_buffer_size()`（SetupComm） | POSIX 上该方法不存在，异常被吞；**无害但无效** ⚠️ |
| `lib/sidecar.py` ready | — | 0.1.7 起额外上报 `platform`、`linkWatch`（engine 只读后者） |
| `lib/tools.js` 文案/示例 | `COM15`、`pwsh` | 0.1.7 起示例端口按平台；macOS 端口为空时 `serial_list` 多一行驱动/`/dev/cu.*` 提示 |
| `spawn(..., { windowsHide: true })` | 隐藏控制台窗口 | POSIX 忽略，无副作用 |
| `lib/web.js` | 无平台代码 | 一致 |
| 测试默认值 | `COM15` + `python` | 0.1.7 起按平台取默认；端口一律可 `argv` 传入 |

**不需要改的**：`ring.js`、工具逻辑、push/pull/script/verify 的板端命令（板子仍是 Linux）、
`serial_rule`、`serial_probe`、Web 控制台、状态文件格式。

---

## 4. 0.1.7 为 macOS 做的改动（相对 0.1.6）

1. **解释器默认值**：非 Windows 用 `python3`（`lib/index.js`、`lib/engine.js`）。
   仍支持 `DSH_SERIAL_PYTHON=/abs/path/python3` 和设置页 `pythonPath`。
2. **默认端口不再跨平台**：macOS/Linux 的 `defaultPort` 默认空字符串。第一次调用会明确要求
   `serial_open port=/dev/cu.…`，而不是去开 `COM15`（端口安全规则的一部分）。
3. **端口示例与文案**：错误信息、工具参数描述、`serial_list` 空列表提示都按平台生成。
4. **`/dev/tty.*` 提醒**：macOS 上打开 dial-in 设备时在下一次结果顶部提示改用 `/dev/cu.*`。
5. **丢字节诚实性**：sidecar ready 上报 `linkWatch`；`serial_status` 在不可观测的平台上显示
   `NOT OBSERVABLE`，而不是 `no driver-reported loss`。
6. **可移植脚本**：`build.sh`、`test/prepare-deps.sh`（POSIX），`prepare-deps.sh` 默认找
   `/Applications/DeepSeek Harness.app/…`，可用 `DSH_ELECTRON` / `DSH_PROFILE` 覆盖。
7. **测试**：默认 python/端口按平台；新增 `test/platform.mjs`（离线）；
   `recovery.mjs` 支持 `DSH_SERIAL_OFFLINE=1` 只跑离线部分。

以上改动对 Windows 行为**没有变化**（`process.platform === 'win32'` 分支保持原值）。

---

## 5. macOS 环境准备

### 5.1 必需

- macOS 11+（Intel 或 Apple Silicon 都可以）。
- DSH 桌面版（能打开 `http://127.0.0.1:19387`）。
- **Python 3.9+** 和 **pyserial**。检查：

  ```bash
  python3 --version
  python3 -c "import serial; print(serial.VERSION)"
  ```

  没有 pyserial 时，**推荐用 venv**（Homebrew Python 有 PEP 668 限制，`pip install --user` 可能被拒）：

  ```bash
  python3 -m venv ~/.dsh-serial-venv
  ~/.dsh-serial-venv/bin/python -m pip install --upgrade pip pyserial
  ~/.dsh-serial-venv/bin/python -c "import serial; print(serial.VERSION)"
  ```

  然后在 DSH 设置页把 `pythonPath` 设成 **绝对路径**
  `/Users/<你>/.dsh-serial-venv/bin/python`（或 `DSH_SERIAL_PYTHON`）。
  ⚠️ **一定要用绝对路径**：从 Finder/Dock 启动的 app，PATH 通常只有
  `/usr/bin:/bin:/usr/sbin:/sbin`，找不到 `/opt/homebrew/bin/python3` 或 pyenv 的 python。

- 串口驱动（见 5.3）。macOS **不自带** CH340/CH9102 的 VCP 驱动。

### 5.2 可选（只有要在 Mac 上重新打包/跑测试才需要）

- Node.js + npm（`node --version`；没有就 `brew install node`）。
  只安装现成 tgz 的话**不需要** Node。
- 如果要跑 `test/schema.mjs` / `test/tools-live.mjs`：需要从 DSH app.asar 抽测试依赖，
  用 `test/prepare-deps.sh`（默认路径不匹配时用 `DSH_ELECTRON=...` 指定 app 可执行文件）。
- 推荐 `chmod +x build.sh test/prepare-deps.sh`（zip 解压后执行位可能丢失）。

### 5.3 USB 串口驱动

| 芯片 | 驱动 | 设备名示例 |
|---|---|---|
| CH340/CH341/CH9102 | WCH **CH34xVCPDriver**（macOS 11+，DriverKit）或旧版 CH34x kext 安装包 | `/dev/cu.wchusbserial1420` |
| FTDI FT232/FT2232 | FTDI VCP 驱动（部分型号 macOS 自带） | `/dev/cu.usbserial-1420`、`/dev/cu.usbserial-A50285BI` |
| CP2102/CP2104 | Silicon Labs CP210x VCP | `/dev/cu.SLAB_USBtoUART` |
| ESP32-S3 / CDC ACM | 系统自带 | `/dev/cu.usbmodem*` |

安装后：

```bash
ls -l /dev/cu.*            # 适配器插拔前后各看一次，确认多出来的是哪个
systemextensionsctl list   # DriverKit 版驱动是否 enabled/activated
```

Apple Silicon 上首次加载系统扩展会要求到 **系统设置 → 隐私与安全性** 里点"允许"，然后重启。
如果 `/dev/cu.*` 里只有蓝牙/内置设备，先怀疑驱动没加载，而不是插件。

### 5.4 权限/占用

macOS 的 `/dev/cu.*` 一般 `crw-rw-rw-`，普通用户可直接打开；不需要 sudo。
但**同一端口同时被 `screen` / `minicom` / 另一个 sidecar 打开时，POSIX 默认允许二次打开，
两个读者会静默瓜分字节流**（和 Windows CH340 的坑一样）。排查：

```bash
lsof /dev/cu.usbserial-1420
pgrep -fl "sidecar.py"
```

插件同一端口只保留一个会话；跑测试/换口前先关掉 `screen`/`minicom`。

---

## 6. 在 Mac 上安装（两种方式）

### 方式 A（推荐）：直接用现成 tgz

tgz 是纯 JS + Python，和平台无关，不需要在 Mac 上重新打包。

1. 把 `dsh-serial-0.1.7.tgz` 拷到 Mac（任意绝对路径，例如 `~/Downloads/`）。
2. 在 DSH 里让 agent 执行：

   ```text
   plugin_manager install_bundle target=/Users/<你>/Downloads/dsh-serial-0.1.7.tgz
   ```

   或者用 CLI（DSH 的 `dsh` 命令在 PATH 里时）：

   ```bash
   dsh plugin --profile desktop add /Users/<你>/Downloads/dsh-serial-0.1.7.tgz
   ```

3. **完全退出并重启 DSH**。运行中的 host 在启动时快照可解析的包清单；热装后当前会话
   仍绑定旧工具定义（Windows 上已实测）。装完不重启 → 工具不出现 / `failed to import`。
4. 新开会话，确认有 16 个 `serial_*` 工具。

### 方式 B：在 Mac 上从源码打包

1. 解压 `dsh-serial-0.1.7-src.zip`，进入目录：

   ```bash
   cd ~/dsh-serial            # 解压后的目录
   chmod +x build.sh test/prepare-deps.sh
   ./build.sh                 # 打包当前版本到上一级 dist/
   # 或改版本号：./build.sh 0.1.8
   ```

   `build.sh` 只做三件事：用 node 改 `package.json` 的 version、`npm pack`、打印 sha256。
   `npm` 可用 `npm install -g npm` 或 `brew install node` 安装。
2. 安装 `../dist/dsh-serial-0.1.7.tgz`（同上 `plugin_manager install_bundle`），然后重启 DSH。

> 不要用"目录软链"安装：profile 的解析器需要用 tgz 里自带的依赖边界
> （Windows 上 `file:` 指向源码目录时，嵌套 import 拿不到 `@deepseek-ai/*`）。
> 也不要直接改 `~/.dsh/profiles/desktop/node_modules/dsh-serial`——升级会被覆盖。

### 6.1 设置页配置（第一次）

| 字段 | macOS 建议值 | 说明 |
|---|---|---|
| `pythonPath` | `/Users/<你>/.dsh-serial-venv/bin/python` 或 `/opt/homebrew/bin/python3` | 必须绝对路径；默认 `python3` 在 Finder 启动的 app 里可能找不到 |
| `defaultPort` | 留空，或写死 `/dev/cu.usbserial-XXXX` | 默认空；留空时第一次必须显式 `serial_open` |
| `defaultBaud` | 1500000（你的板子） | 默认 1500000 |
| `dtr` / `rts` | 默认 false | ⚠️ 见 9.3：pyserial 打开时仍可能按默认电平驱动两线 |

配置是 volatile 的，改完即时生效，不用重启。运行期偏好（上次成功打开的端口/波特率）
在 `~/.dsh/serial-state.json`，由 `serial_set_default` 或成功 `serial_open` 更新。

---

## 7. 第一次连接

```text
serial_list
# ports (1):
#   /dev/cu.usbserial-1420  USB Serial  VID:PID=0403:6001
# ...
# defaults: port=(unset) baud=1500000 8N1 flow=none

serial_open { port: "/dev/cu.usbserial-1420", baud: 1500000 }
# opened.
# session /dev/cu.usbserial-1420: open ... @ 1500000 8N1
# fresh buffer (this port had no retained history).

serial_ping { timeoutMs: 2000 }
# ALIVE — 1 B in 3 ms, prompt-like

serial_transact { data: "uname -a", expect: "[$#] $" }
# matched ...，输出已去回显

serial_set_default { port: "/dev/cu.usbserial-1420", baud: 1500000 }
```

要点：

- **优先 `/dev/cu.*`**，不要 `/dev/tty.*`：后者是 dial-in 设备，打开时可能等载波（DCD），
  表现成 `serial_open` 卡住直到超时。0.1.7 在打开 `/dev/tty.*` 时会排一条 notice 提醒。
- 适配器换 USB 口后设备名可能变（例如 `-1420` 后缀），用 `serial_list` 重新确认，
  再用 `serial_set_default` 更新偏好；旧端口的缓冲仍留在内存里。
- 1.5 Mbaud：pyserial 在 macOS 上对非标准波特率走 `IOSSIOSPEED`，**取决于驱动是否支持**。
  如果打开报 `termios.error` / `could not configure port`，先用 `serial_probe` 试
  `[1500000, 921600, 115200]`；也可以先用 115200 确认链路。
- `serial_ping` 会发一个 CR，可能打断 U-Boot autoboot；只想听就用 `poke: false`。

---

## 8. 验证清单（Mac）

按顺序做，前 4 步不需要 DSH 之外的工具：

```bash
# 1) Python 侧
python3 -c "import serial; print(serial.VERSION)"          # 期望 3.5+
ls -l /dev/cu.*                                            # 期望看到适配器

# 2) 纯逻辑（需要 node + 测试依赖；prepare-deps.sh 见 5.2）
node test/schema.mjs        # PASS: tools built: 16
node test/platform.mjs      # ALL PLATFORM CHECKS PASSED（其中 portExample 期望 /dev/cu.usbserial-1420）

# 3) 真串口 smoke test（把 /dev/cu.… 换成你的）
node test/live.mjs /dev/cu.usbserial-1420 1500000
# 期望最后输出 PASS/ALL ...，并打印缓冲/游标统计

# 4) 工具层 + 交互回归
node test/tools-live.mjs /dev/cu.usbserial-1420 1500000
node test/features.mjs   /dev/cu.usbserial-1420 1500000
node test/integrity.mjs  /dev/cu.usbserial-1420 1500000    # verify: verified
node test/transfer.mjs   /dev/cu.usbserial-1420 1500000    # push/pull sha256 一致

# 5) 会话死亡/缓冲保留（会 kill 自己的 sidecar，别对着正在用的会话跑）
DSH_SERIAL_OFFLINE=1 node test/recovery.mjs                # 先跑离线 A1–A4
node test/recovery.mjs /dev/cu.usbserial-1420 1500000      # 真机 B1–B16
```

DSH 内：

1. 新会话里能看到 16 个 `serial_*` 工具；
2. `serial_list` 不再默认指向 COM15；`defaults: port=(unset)`；
3. `serial_open` → `serial_ping` → `serial_transact` 三步都通；
4. 浏览器打开 `http://127.0.0.1:19387/dsh-serial` 能看到实时控制台；
5. 杀掉 sidecar 后下一次 `serial_read` 顶部出现 `! session …`，并自动重开**同一端口**；
6. `serial_close { dropBuffer: true }` 后 retained 列表里不再有该端口。

---

## 9. 与 Windows 的差异 / 已知限制（诚实版）

### 9.1 丢字节不可观测

Windows 上 `serial_status` 的 `link:` 来自 `ClearCommError`（`CE_OVERRUN` 等）。macOS 没有等价 API，
0.1.7 起显示：

```text
link: NOT OBSERVABLE on this OS (driver loss counters are Win32-only) — "0" is not proof of a clean link;
      trust serial_transact { verify: true } or a paced serial_pull
```

这不代表 Mac 不丢字节，只代表**工具看不见**。1.5 Mbps 无硬件流控时风险与 Windows 相同。
对策不变：
- 输出要逐字可信 → `serial_transact { verify: true }`（板端 tee + sha256，必要时走分片通道取回）；
- 批量取文件 → `serial_pull`（默认 64 字符/8 ms ≈ 8 KB/s，校验失败自动降速重试）。

### 9.2 没有独占打开（TIOCEXCL）

当前 sidecar 不设置 `exclusive=True`。macOS 上如果 `screen`/`minicom`/第二个 sidecar 也开着，
两个读者会分字节。插件保证自己同一端口只有一个会话，但**管不了别的程序**。
以后要加可以给 sidecar 加一个 POSIX-only 的 `exclusive` 参数（pyserial 的 `Serial(exclusive=True)`
只在 POSIX 实现，Windows 不支持），本次没有做。

### 9.3 DTR/RTS 行为

插件自身不主动设置 DTR/RTS（不脉冲、不复位）；但 **pyserial 打开端口时会把两条线按
`_dtr_state`/`_rts_state`（默认 True）驱动一次**，这是 pyserial 的行为，不是插件额外动作。
DTR 接复位电路的板子（ESP32 等）请用 3 线调试口或先确认原理图；要主动复位用
`serial_configure { pulse: "dtr", pulseMs: 200 }`。

### 9.4 `--rxbuf` 在 POSIX 上无效

Windows 用 `SetupComm` 扩大驱动接收缓冲；macOS 上 `set_buffer_size()` 不存在，异常被吞掉。
`bufferBytes`（内存环形缓冲）仍然有效，和驱动缓冲是两件事。

### 9.5 未在真实 Mac 上验证

本轮改动只做了离线校验（`schema.mjs`、`platform.mjs`；Windows 上 `recovery.mjs` 的离线 A1–A4）。
**没有在 Mac + USB 串口上跑过**。风险点按优先级：
1. `pythonPath` 绝对路径 / venv（5.1）——最容易踩；
2. 驱动是否加载出 `/dev/cu.*`（5.3）；
3. 1500000 非标准波特率是否被驱动接受（7）；
4. `/dev/cu.*` 打开时的 DTR/RTS 电平（9.3）。

如果这四条都过了，其余逻辑与 Windows 相同（同一份 JS + sidecar 协议）。

---

## 10. 如果要继续改（代码级移植点）

1. **新的解释器/OS 默认值**：`lib/index.js` 的 `DEFAULTS`、`lib/engine.js` 的
   `DEFAULT_PYTHON`/`portExample()`。只改默认值，不要改 `ensureSession` 的端口安全顺序。
2. **新的端口命名**：`portExample()` 和 `tools.js` 的 `PORT_EXAMPLE`；`serial_open` 的
   `/dev/tty.*` 提醒在 `engine.js` 的 `open()`（目前只对 macOS 生效）。
3. **平台能力上报**：`lib/sidecar.py` 的 ready 消息加字段（如 `linkWatch`、`platform`），
   `engine.js` 的 `#onLine` case `'ready'` 读入，`status()` / `retiredStatus()` 透传，
   `tools.js` 的 `renderSession()` 决定文案。不要把"不知道"渲染成"没问题"。
4. **POSIX 丢字节检测（未做）**：`TIOCGICOUNT` 在 Linux 有、macOS 没有；没有可移植的等价物。
   若只针对 Linux，可在 sidecar 里读 `/proc/tty/driver/serial` 或 `TIOCGICOUNT`，但要按平台降级。
5. **独占打开（未做）**：sidecar 加 `--exclusive`，仅 POSIX 传给 `serial.Serial(exclusive=True)`；
   Windows 忽略该参数。
6. **打包/安装不变量**：改完必须 `build.sh`/`build.ps1` 提升版本 → 重装 tgz → **重启 DSH**。
   热挂载不会刷新当前会话已绑定的工具定义。

改 `sidecar.py` 的协议时，同时改 `engine.js` 的 `#onLine`；改工具参数时更新
`test/schema.mjs`（它用真实 `defineTool` 编译 16 个 schema）。

---

## 11. macOS 排障

| 现象 | 处理 |
|---|---|
| `serial_list` 显示 `ports (0)` 或只有蓝牙 | 驱动没加载/没批准：`ls /dev/cu.*`、`systemextensionsctl list`、系统设置→隐私与安全性；换线/换口；重启 |
| `cannot open /dev/cu.…: [Errno 16] Resource busy` | 被别的程序占着：`lsof /dev/cu.…`，关掉 `screen`/`minicom`/旧 sidecar（`pgrep -fl sidecar.py`） |
| 打开 `/dev/tty.*` 卡住很久 | 用了 dial-in 设备：改用 `serial_list` 报的 `/dev/cu.*` |
| `failed to launch python3` / `python3: command not found` | Finder 启动的 app PATH 很干净：设置页把 `pythonPath` 指向绝对路径（推荐 venv，见 5.1） |
| `pyserial import failed: No module named 'serial'` | 该解释器没装 pyserial：在同一个绝对路径的 python 里 `-m pip install pyserial` |
| `termios.error ... could not configure port` | 驱动不支持这个波特率（1.5M 常见）：`serial_probe { bauds: [1500000, 921600, 115200] }` |
| 输出全是乱码 | 波特率/校验/停止位不对：`serial_probe` |
| `link: NOT OBSERVABLE ...` | 正常（macOS 没有驱动丢字节计数）；要可信输出用 `verify: true` / 限速 `serial_pull` |
| 同一条命令输出时好时坏、丢一大截 | 可能有第二个读者：`pgrep -fl sidecar.py`、`lsof /dev/cu.…`；关掉后重试 |
| 工具没出现 / `failed to import` | 装完没重启 DSH；或 profile 里 `dsh.profile.bundles` 没写 `dsh-serial` |
| `serial_push` 报 "console stopped echoing" | 板端不是 Linux shell / 回显被关 / 链路丢字节：先 `serial_transact` 确认提示符 |
| 1.5M 下 `verify` 反复 MISMATCH | 片速仍高于链路极限：调小 `pieceChars`、调大 `delayMs`；或降到 921600 |

---

## 12. 版本、校验与回滚

- 版本：`package.json` 的 `version`（当前 0.1.7）。
- 校验：`archive/dsh-serial/SHA256SUMS.txt` 里有 src zip / tgz / README / AGENTS / VERSION 的 sha256。
  在 Mac 上核对：

  ```bash
  shasum -a 256 dsh-serial-0.1.7.tgz
  ```

- 回滚：装回上一个 tgz（例如 0.1.6），然后重启 DSH。源码 zip 里带完整历史和 `VERSION.txt`。
- 卸载：

  ```bash
  dsh plugin --profile desktop remove dsh-serial   # 或 plugin_manager remove_bundle target=dsh-serial
  ```

  偏好文件 `~/.dsh/serial-state.json` 可留着，也可删；它不含串口数据。

---

## 13. 一句话给移植者

> JS 部分不用动；到 Mac 上只要保证 **`python3` + pyserial 能被 DSH 找到、`/dev/cu.*` 出现、
> 波特率被驱动接受**。端口名是安全边界：默认端口在 Mac 上是空的，第一次显式 `serial_open`，
> 以后 `serial_set_default` 记住它；会话死了只会重开它自己。