# Gateway Capability Sync

Harness 导入 OpenAI 兼容网关的模型时只保留 `id / name / contextWindow / maxTokens`，会丢掉网关 `/v1/models` 已返回的
能力字段。这个插件把能力读回来，按 Harness（pi-ai 适配器）的模型配置格式写进 profile：

## 安装

要求在 DeepSeek Harness 里用 `plugin_manager` 的 `install_bundle`，`target` 传 git 地址：

```
github:luckykong/dsh-gateway-capability-sync
```

也可以固定到某个提交（推荐，版本可复现）：

```
github:luckykong/dsh-gateway-capability-sync#<commit-sha>
```

安装前请确认**当前没有 agent 在运行** —— 插件管理器在 agent 运行期间会拒绝安装。
装完后重启 Harness（或在插件管理页启用 `gateway-capability-sync` 这一行），
然后到「设置 → 模型」导入一次网关模型；插件会在启动 4 秒后、以及每次配置重载后自动补全能力，
也可以发送 `/gateway-sync` 手动触发。

卸载：`plugin_manager` 的 `remove_bundle`，`target` 传 `dsh-gateway-capability-sync`。

| 网关 `/v1/models` 字段 | 写回的模型配置 |
| --- | --- |
| `supports_images: true` / `false` | `input: ["text", "image"]` / `["text"]` |
| `reasoning_supported_efforts` | `reasoningEfforts: { low: low, high: high, max: max }` |
| `reasoning_default_effort` / `reasoning_effort` | 网关没有档位数组时作为唯一档位 |
| `can_disable_thinking` | `reasoningEfforts.off: null` → 界面可选“关闭思考” |
| 思考模型，且 provider 明确设置 `api: openai-completions` | `compat.thinkingFormat: deepseek` + `compat.supportsReasoningEffort: true` |

网关省略能力字段时视为未知，保留已有配置。有效的档位数组或默认档位可推断模型支持思考；
显式 `supports_reasoning: false` 优先。`supports_reasoning: true` 但没有有效档位时，不自动构造档位。
Responses、Anthropic 等其他协议不写入上述 completions 专用 compat；协议省略时也不猜测，报告会提示。

`thinkingFormat: deepseek` 让 pi-ai 在 OpenAI completions 协议上发
`thinking: {type: "enabled"|"disabled"}` 与顶层 `reasoning_effort`；实测该网关两种形态都接收，
且 `thinking.type=disabled` 会真正关掉思考（省略参数则网关重新补成开启）。

## 触发方式

- **启动后自动同步**（延迟 4 秒），同步和配置重载完成后进行能力扫描。关闭启动同步时，第 9 秒保留一次初始扫描。
- **配置重载后自动同步**：在 `设置 → 模型` 保存/刷新模型后，Harness 重载配置，插件随即补全能力。
- **手动触发**：输入框发送 `/gateway-sync`，返回同步报告。
- 同步幂等：配置已具备能力时不写文件、不触发额外重载。
- 同步期间的配置重载会合并为后续一轮同步；并发手动命令共用当前任务。停用插件会取消请求并阻止后续配置提交。
- 单个网关失败不会阻止其他网关同步；部分失败会在命令结果中明确报告。

## 覆盖策略

- 默认 `overwrite: missing`：逐字段补缺失值；保留模型已有设置、provider 的 `compat` 和显式 `defaultInput`，包括手工设置的 `false`。
- `overwrite: always`：按网关明确声明的能力刷新 `input` / `reasoningEfforts`，并在适用协议下刷新 `compat.thinkingFormat` 和 `compat.supportsReasoningEffort`。其他 compat 字段保留。
- 未知元数据不会撤销已有能力；`can_disable_thinking` 未知时保留已有的 `off` 声明。

## 配置（profile `cordis.patch.yml` 中本插件行）

```yaml
- id: gateway-capability-sync
  name: 'dsh-gateway-capability-sync'
  config:
    entryId: llm-pi-ai          # 要修改的 Loader 行 id
    providers: []               # 空 = 该行下所有带 baseURL 的 provider
    syncOnStart: true
    syncOnConfigReload: true
    syncImages: true
    syncReasoning: true
    thinkingFormat: deepseek    # 也可用 zai / qwen / openai 等 pi-ai thinkingFormat
    overwrite: missing          # missing | always
    debug: true
    debugFile: ''               # 空 = $DSH_HOME/storages/gateway-capability-sync/sync-debug.json
    requestTimeoutMs: 15000     # 每次 /models 请求超时，最少 1000ms
```

`entryId` 精确匹配并检查插件包名。默认 ID 找不到时，只有唯一的 pi-ai Loader 才允许按包名兜底；
自定义 ID 找不到或候选不唯一时报告错误，避免修改错误条目。

## 输出与排查

| 文件 | 内容 |
| --- | --- |
| `sync-debug.json` | 每次同步：entry、provider 列表、网关模型数（图片/思考/可关闭思考）、补全统计、跳过原因、是否写入、状态与错误；合并的前序轮次存于 previousRuns |
| `sync-capabilities.json` | 同步后扫描：Harness 实际解析到的每个模型的能力（inputModalities / efforts / defaultEffort），或扫描错误 |

默认写入 `$DSH_HOME/storages/gateway-capability-sync/`（通常是
`~/.dsh/storages/gateway-capability-sync/`），而不是插件包目录 —— 已安装的插件位于
profile 的 `node_modules` 中，安装或更新时会被整体替换。想让报告写到别处，就把
`debugFile` 设成一个绝对路径。
例如 `debugFile: /tmp/gateway/sync.json` 会把扫描另存为 `/tmp/gateway/sync-capabilities.json`，不会相互覆盖。
父目录会自动创建。`debug: false` 时关闭报告写入和能力扫描，命令也不会显示不存在的报告路径。

## 已知边界

- 只补全**已配置的 models 列表**，不会自动新增网关里新出现的模型（仍用「设置 → 模型 → 刷新」导入）。没有 models 列表的目录路由、没有匹配网关记录的模型列表会明确报告跳过。
- 继承来源的 models 列表可以补全。Host 的 configEditor 要求保存完整配置，因此补全后该列表固定在 profile；后续上游列表变化需要重新导入。不会恢复当前完整配置中已移除的 provider。
- 写入前若发现 provider 地址、协议、凭证引用或请求头发生变化，会丢弃旧查询结果并重新查询；已删除的 provider 不会被恢复。
- Harness 模型 schema 没有“默认思考档位”字段：`reasoning_default_effort` 只在网关没给档位数组时用于推断唯一档位。
- `can_disable_thinking` 缺失时不新增 “off” 档位，已有声明会保留。
- 不会自动删除以前保存的、不适用于当前协议的 compat，因为无法判定它是否来自手工设置；存量无效字段需要单独移除。
- 视觉能力按目录字段写入；实际带图请求仍建议验收（同名模型的不同区域通道能力可能不同）。
- 依赖 Host 服务 `configEditor`、`credentials`、`timer`；`configEditor` 的写入需要 HMR 事务，插件在定时器回调里先退出
  激活时继承的 HMR 事务上下文，否则会报 `HMR transactions cannot be nested`。

## 开发与验证

运行环境：Node.js >= 20.11。无需安装额外的运行时依赖。在源码工作区运行：

```sh
npm run check
```

检查包括 JavaScript 语法和模拟 Host 的回归测试，使用虚构凭证及隔离报告目录，不连接真实网关。
测试通过不等于真实 Host、真实网关的端到端验收。

问题清单、修复记录与验证范围见 [代码审查与修复记录](docs/代码审查与修复记录.md)。

## 版本记录

### 1.1.1

修复同步状态判定错误，并明确 HMR 事务失败的恢复行为：

- **误报失败**：配置无需改动（能力已齐全）、但另有 provider 连不上时，整轮被标为 `failed`。
  现在只有真正尝试写入却失败才算 `failed`；写入了部分 provider 记 `partial`；无需写入时保持
  `up-to-date`。这会影响 `/gateway-sync` 的返回：能力已齐全且某个网关离线时不再报错。
- **HMR 事务冲突**：`configEditor.edit` 遇到 `HMR transactions cannot be nested` 时，现在明确交给
  节流重试处理（8 秒后重跑），而不是当作永久失败；写入成功后重试预算重新恢复，
  避免早先偶发失败耗尽预算连累后续同步。
- 报告不再输出内部的 `attemptedWrite` 字段。

排查提示：`sync-debug.json` 中 `status` 与 `wrote` 需结合看——
`up-to-date` + `wrote:false` 表示无需改动，`partial` + `wrote:true` 表示部分网关更新成功。

### 1.1.0

修复 14 项已确认缺陷（GCS-01 至 GCS-14），主要包括：

- Loader 目标按精确 ID 匹配并核对包名，候选不唯一时报错，避免改错条目。
- 覆盖策略收窄：`missing` 逐字段补缺并保留手工 `false` 与 `defaultInput`；网关未声明的能力视为未知，不再被归一为 `false`。
- completions 专用 compat 仅在 provider 明确为 `openai-completions` 时写入，其他协议或协议未知时不动并给出提示。
- 同步健壮性：单网关异常隔离、停用即取消、重载合并、并发命令共用、写入前核对配置来源变化，过期结果丢弃。
- 报告状态区分更新／无变化／跳过／部分失败／失败／取消；扫描错误同样写报告；`debug: false` 不写文件也不提示路径。
- 版本号统一从 `package.json` 读取；新增 `requestTimeoutMs`（默认 15000ms）。
- 新增 `npm test` / `npm run check` 回归入口（44 项）。

### 1.0.0

首个发布版本。

## 升级说明

1.0.x 升级到 1.1.0 不需要修改现有 `cordis.patch.yml` 配置；新增的 `requestTimeoutMs` 有默认值，不写即可。
以前由插件写过、但与当前协议不适配的 compat 字段不会被自动清理（无法判定是否来自手工设置），需要手工检查。

