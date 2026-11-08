/**
 * dsh-serial — host half.
 *
 * A serial console that behaves like a remote shell for agents: the port is
 * opened once and read continuously, every received byte lands in an in-memory
 * ring buffer, and tools address that buffer with absolute byte cursors. No
 * log files are written, so there is no "capture to a file, then read the file"
 * round trip: an agent can call serial_read at any time and get what happened,
 * or wait for new bytes / a regex.
 *
 * Everything runs in the host process. The actual COM port lives in a small
 * Python/pyserial sidecar (lib/sidecar.py) so there is no native Node module to
 * rebuild for Electron.
 */

import z from '@deepseek-ai/schemastery'
import { SerialManager } from './engine.js'
import { serialTools } from './tools.js'
import { makeRoutes } from './web.js'

/** Stable cordis plugin name. */
export const name = 'serial'

/** Services required before the tools can mount. */
export const inject = ['tools', 'systemPrompt', 'webServer']

/**
 * Host-platform facts. The plugin is deliberately platform-neutral: everything
 * OS-specific is a default value or a diagnostic (see PORTING-macOS.md).
 *
 * - Windows calls the interpreter `python` (the installer adds it to PATH) and
 *   names ports COM15.
 * - macOS has no `python` binary in a stock install, only `python3`, and names
 *   callout devices /dev/cu.usbserial-* (pyserial's list_ports reports exactly
 *   those). A stale COM15 default would be a *wrong port* on macOS, which is
 *   the one thing the port-safety rule forbids, so the default is empty there
 *   and the first call must name the device.
 */
const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'
const DEFAULT_PYTHON = IS_WIN ? 'python' : 'python3'
const PORT_EXAMPLE = IS_WIN ? 'COM15' : IS_MAC ? '/dev/cu.usbserial-1420' : '/dev/ttyUSB0'

/** Schema defaults, re-read for hand-built contexts. */
const DEFAULTS = {
  enabled: true,
  announceToAgent: true,
  defaultPort: IS_WIN ? 'COM15' : '',
  defaultBaud: 1500000,
  dataBits: 8,
  parity: 'none',
  stopBits: 1,
  flowControl: 'none',
  dtr: false,
  rts: false,
  bufferBytes: 4 * 1024 * 1024,
  pythonPath: DEFAULT_PYTHON,
  encoding: 'utf8',
}

/**
 * Plugin config. Every field is `volatile()`, so edits reach the running
 * instance through the settings page without a remount (the loader commits the
 * value and announces `loader/volatile-update` on this fiber).
 */
export const Config = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled).volatile(),
  announceToAgent: z.boolean().default(DEFAULTS.announceToAgent).volatile(),
  defaultPort: z.string().default(DEFAULTS.defaultPort).volatile(),
  defaultBaud: z.number().default(DEFAULTS.defaultBaud).volatile(),
  dataBits: z.number().default(DEFAULTS.dataBits).volatile(),
  parity: z.string().default(DEFAULTS.parity).volatile(),
  stopBits: z.number().default(DEFAULTS.stopBits).volatile(),
  flowControl: z.string().default(DEFAULTS.flowControl).volatile(),
  dtr: z.boolean().default(DEFAULTS.dtr).volatile(),
  rts: z.boolean().default(DEFAULTS.rts).volatile(),
  bufferBytes: z.number().default(DEFAULTS.bufferBytes).volatile(),
  pythonPath: z.string().default(DEFAULTS.pythonPath).volatile(),
  encoding: z.string().default(DEFAULTS.encoding).volatile(),
})

/** The live reference a `volatile()` field resolves to. */
function readField(field, fallback) {
  if (field === undefined) return fallback
  if (typeof field === 'object' && field !== null && typeof field.get === 'function') {
    const value = field.get()
    return value === undefined ? fallback : value
  }
  return field
}

/** Prompt section order (the SSH plugin uses 150). */
const SECTION_ORDER = 155

/** Model-facing announcement: what the plugin is, how to use it, and its traps. */
export const SERIAL_GUIDANCE = [
  '本机装有 dsh-serial 串口插件（DSH 串口控制台）：串口一旦打开就在后台持续接收，收到的字节全部存在内存环形缓冲区里，**不写任何日志文件**；agent 任何时候调用 serial_read 都能取到「打开以来」的数据，或者用 waitMs 等新数据、用 serial_expect 等某个正则出现。缓冲**按端口驻留**：会话断开或被关闭后字节仍在内存里，serial_open 同一端口会接上原来的缓冲（absolute cursor 不变），只有 serial_close { dropBuffer: true } 才真的丢。',
  '常用姿势：serial_list 看端口/会话/保留缓冲 → serial_open（不带 port 时用「上次成功打开的端口」，其次才是设置里的 defaultPort；serial_set_default 可改这个偏好）→ serial_transact 一条命令一次调用（发送+等提示符，**自动跳过回显**，匹配串可以出现在命令里）→ serial_read(cursor="start") 回看历史。需要退出码就加 captureExitCode=true；输出可能没有换行时用 idleMs=300 空闲成帧；要逐字可信就 verify=true。serial_ping 发一个 CR 回答「这条链路上还有活物吗」（0 字节 = 端口/波特率/供电问题，不是匹配问题）。serial_status 看游标/未读数/最近操作/保留缓冲。人也可以打开 http://127.0.0.1:19387/dsh-serial 看实时控制台。',
  '串口专属能力：serial_script 跑整段脚本（多行/管道/引号/heredoc 都不经 argv，走板端临时文件，返回 exitCode）——**要在板端插多行或写 heredoc 时先想它**，别用 sed 硬凑；serial_configure 改波特率 / 拉 DTR-RTS / 脉冲复位 / 发 BREAK；serial_rule 是内存里的自动应答规则（登录提示、U-Boot "Press any key"、确认框），命中新到达的字节就立刻回发；serial_probe 扫描波特率找能读通的那一档；serial_push / serial_pull 用 base64 走控制台在「无网络」时传文件（要求板端有 Linux shell）：pull 分片限速、整体 sha256 校验，push 校验长度+sha256 并自动重试。',
  '输出可信度（重要）：串口链路没有硬件流控，高波特率下会偶发丢字节，而 UART 无法从「收到的字节」判断少了什么——看起来完全正常的输出可能就是缺字。所以：(1) 要逐字相信某段输出时用 serial_transact { verify: true }：板端 tee 出同样内容并报 sha256，本机对照；不干净时自动改用「分片限速」通道把文件取回，命令只跑一次，结果显示 integrity: verified / MISMATCH；(2) serial_read / serial_transact 若提示 "driver reported lost bytes"，表示这段窗口里 OS 承认丢了字节，文本可能缺字符，别据此下结论；(3) serial_status 的 link 行是累计证据，"ring-overflow 0" 只说明环形缓冲没被覆盖，不代表链路干净。',
  '会话安全（重要）：reader 线程挂掉时**端口名会保留**，下一次调用会自动重开**同一个端口**，并在结果最上方给出 `! session COM7 ended at 02:07:31 (…)` 一类告警；重开失败会直接报「COM7 ended at … 重开失败」，**任何情况下都不会静默改用 defaultPort 或另一个设备**。要回到已知端口就 serial_open { port: "COMx" }。死掉那一刻还没读的字节默认留在内存里，重开后可继续读；只有 serial_close { dropBuffer: true } 才丢弃。这个告警只在接下来的那次工具返回里出现一次，之后用 serial_status / serial_list 查。',
  '超时结论：serial_transact 超时时会直接给判断，不用自己推游标——0 字节（连命令回显都没有）→ 优先查端口/波特率/供电/被别的程序占用（serial_ping、serial_probe）；只有回显没有输出 → 板子可能挂在启动或 panic 里；有输出但没看到提示符 → 可能还在继续打印，或提示符形状不同。',
  '硬约束（踩过的坑）：(1) Linux/U-Boot 控制台行尾是 CR（\\r），用 serial_transact 默认即可；(2) serial_transact 已自动跳过回显，匹配串不必刻意避开命令文本；但 serial_expect 是纯缓冲正则，若命令回显还在缓冲里仍可能命中，那种场景用 transact 或显式 cursor；(3) 输出里 \\r\\n 和 ANSI 转义很常见，工具默认已处理；(4) 串口是独占的，别的程序（PuTTY/SerialKit）占着就打不开，serial_list 会显示端口状态；(5) 打开端口默认不动 DTR/RTS，避免误复位板子。',
  '路径区分：本机（dsh host）上的文件用本地文件工具（read/write/edit），serial_push/pull 才用于板子上的路径。用户说「串口 / COM / 控制台 / 烧录 / 板子没网」时就指本插件。',
  `端口名与平台：Windows 是 COM15 这类名字；macOS 是 /dev/cu.usbserial-1420 这类名字（serial_list 返回的 cu.* 就是它，优先 cu.*，不要用 /dev/tty.*，那个会等载波）。本机示例端口：${PORT_EXAMPLE}。默认值里没有端口时，先 serial_list，再 serial_open port=…；serial_set_default 可以记住它。`,
].join('\n')

/**
 * Mount the serial engine and tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, any>} [config]
 */
export function apply(ctx, config) {
  const readConfig = () => ({
    enabled: readField(config?.enabled, DEFAULTS.enabled),
    announceToAgent: readField(config?.announceToAgent, DEFAULTS.announceToAgent),
    defaultPort: readField(config?.defaultPort, DEFAULTS.defaultPort),
    defaultBaud: readField(config?.defaultBaud, DEFAULTS.defaultBaud),
    dataBits: readField(config?.dataBits, DEFAULTS.dataBits),
    parity: readField(config?.parity, DEFAULTS.parity),
    stopBits: readField(config?.stopBits, DEFAULTS.stopBits),
    flowControl: readField(config?.flowControl, DEFAULTS.flowControl),
    dtr: readField(config?.dtr, DEFAULTS.dtr),
    rts: readField(config?.rts, DEFAULTS.rts),
    bufferBytes: readField(config?.bufferBytes, DEFAULTS.bufferBytes),
    pythonPath: readField(config?.pythonPath, DEFAULTS.pythonPath),
    encoding: readField(config?.encoding, DEFAULTS.encoding),
  })

  const manager = new SerialManager({ getConfig: readConfig })
  ctx.effect(() => () => { void manager.dispose() }, 'dsh-serial: engine')

  let disposeTools
  let disposeSection
  let disposeRoutes

  const teardown = () => {
    if (disposeTools !== undefined) { disposeTools(); disposeTools = undefined }
    if (disposeSection !== undefined) { disposeSection(); disposeSection = undefined }
    if (disposeRoutes !== undefined) { disposeRoutes(); disposeRoutes = undefined }
  }

  const sync = () => {
    const value = readConfig()
    teardown()
    if (!value.enabled) return
    if (value.announceToAgent) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-serial',
        order: SECTION_ORDER,
        text: SERIAL_GUIDANCE,
      })
    }
    disposeRoutes = ctx.effect(
      () => {
        try {
          const disposers = makeRoutes(manager).map((route) => ctx.webServer.register(route))
          return () => { for (const dispose of disposers) dispose() }
        } catch (error) {
          console.error('[dsh-serial] web routes failed to register:', error)
          return () => {}
        }
      },
      'dsh-serial: web routes',
    )
    disposeTools = ctx.effect(
      () => {
        const disposers = serialTools(manager).map((tool) => ctx.tools.register(tool))
        return () => { for (const dispose of disposers) dispose() }
      },
      'dsh-serial: tools',
    )
  }

  // A settings edit is committed into this instance's config references; the
  // surfaces are re-derived without remounting the plugin.
  ctx.on('loader/volatile-update', () => { sync() })
  sync()
}
