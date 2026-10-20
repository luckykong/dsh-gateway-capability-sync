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
| `supports_images` | `input: ["text", "image"]` |
| `reasoning_supported_efforts` | `reasoningEfforts: { low: low, high: high, max: max }` |
| `reasoning_default_effort` / `reasoning_effort` | 网关没有档位数组时作为唯一档位 |
| `can_disable_thinking` | `reasoningEfforts.off: null` → 界面可选“关闭思考” |
| 思考模型 | `compat.thinkingFormat: deepseek` + `compat.supportsReasoningEffort: true` |

`thinkingFormat: deepseek` 让 pi-ai 在 OpenAI completions 协议上发
`thinking: {type: "enabled"|"disabled"}` 与顶层 `reasoning_effort`；实测该网关两种形态都接收，
且 `thinking.type=disabled` 会真正关掉思考（省略参数则网关重新补成开启）。

## 触发方式

- **启动后自动同步**（延迟 4 秒），随后 9 秒做一次能力扫描。
- **配置重载后自动同步**：在 `设置 → 模型` 保存/刷新模型后，Harness 重载配置，插件随即补全能力。
- **手动触发**：输入框发送 `/gateway-sync`，返回同步报告。
- 同步幂等：配置已具备能力时不写文件、不触发额外重载。

## 覆盖策略

- 默认 `overwrite: missing`：只补缺失字段，已有的视为手工设置，永不覆盖。
- `overwrite: always`：按网关刷新 `input` / `reasoningEfforts` / `compat.*`。

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
```

## 输出与排查

| 文件 | 内容 |
| --- | --- |
| `sync-debug.json` | 每次同步：entry、provider 列表、网关模型数（图片/思考/可关闭思考）、补全统计、是否写入、错误 |
| `sync-capabilities.json` | 每次扫描：Harness 实际解析到的每个模型的能力（inputModalities / efforts / defaultEffort） |

默认写入 `$DSH_HOME/storages/gateway-capability-sync/`（通常是
`~/.dsh/storages/gateway-capability-sync/`），而不是插件包目录 —— 已安装的插件位于
profile 的 `node_modules` 中，安装或更新时会被整体替换。想让报告写到别处，就把
`debugFile` 设成一个绝对路径。

## 已知边界

- 只补全**已配置的模型**，不会自动新增网关里新出现的模型（仍用「设置 → 模型 → 刷新」导入；这类模型缺少手工 `input` 时按文本处理）。
- Harness 模型 schema 没有“默认思考档位”字段：`reasoning_default_effort` 只在网关没给档位数组时用于推断唯一档位。
- `can_disable_thinking` 缺失的思考模型不提供 “off” 档位。
- 视觉能力按目录字段写入；实际带图请求仍建议验收（同名模型的不同区域通道能力可能不同）。
- 依赖 Host 服务 `configEditor`、`credentials`、`timer`；`configEditor` 的写入需要 HMR 事务，插件在定时器回调里先退出
  激活时继承的 HMR 事务上下文，否则会报 `HMR transactions cannot be nested`。
