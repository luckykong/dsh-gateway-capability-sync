/**
 * Gateway capability sync (Host half).
 *
 * Harness' pi-ai model import keeps only id/name/contextWindow/maxTokens, so
 * the OpenAI-compatible gateways that advertise `supports_images`,
 * `reasoning_supported_efforts`, `reasoning_default_effort` and
 * `can_disable_thinking` lose that information on import. This plugin reads
 * those fields from the configured provider's `/v1/models` listing and writes
 * the equivalent pi-ai model fields back into the provider row:
 *
 *   supports_images               -> input: ["text", "image"]
 *   reasoning_supported_efforts   -> reasoningEfforts: { low: "low", … }
 *   reasoning_default_effort      -> used as the single level when the gateway
 *                                    lists no effort array
 *   can_disable_thinking          -> reasoningEfforts.off: null (offered as the
 *                                    "off" thinking level)
 *   (reasoning models)            -> compat.thinkingFormat = "deepseek", which
 *                                    makes pi-ai send `thinking: {type:
 *                                    "enabled"|"disabled"}` and a top-level
 *                                    `reasoning_effort` on the OpenAI
 *                                    completions protocol.
 *
 * Existing fields are never overwritten in the default `overwrite: "missing"`
 * mode, so hand-set values win. `overwrite: "always"` refreshes them from the
 * gateway instead. The provider config is written through `configEditor`, which
 * persists it into the profile patch and reconciles it through the Loader.
 *
 * Triggers:
 *   - startup (delayed), so the first run happens after the profile settles;
 *   - `app-boot/config-reload`, so a model list saved from Settings → Models is
 *     enriched right after Harness applies it;
 *   - the `/gateway-sync` chat command, for a manual run with a report.
 *
 * A JSON report of the last run is written to `sync-debug.json` next to this
 * file when `debug` is enabled.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '1.0.3'
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * Directory the debug reports go to when `debugFile` is left empty.
 *
 * An installed bundle lives inside the profile's `node_modules`, which is
 * replaced on every install or update, so writing next to this file would both
 * litter the package and lose the report. Prefer a stable, writable directory
 * under the Harness home (`$DSH_HOME`, default `~/.dsh`) and fall back to the
 * package directory only for a linked checkout where that directory cannot be
 * created.
 */
function resolveReportDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  const preferred = join(home, 'storages', 'gateway-capability-sync')
  try {
    mkdirSync(preferred, { recursive: true })
    return preferred
  } catch {
    return PACKAGE_DIR
  }
}

const REPORT_DIR = resolveReportDir()
const LOADER_ENTRY_NAME = '@deepseek-ai/dsh-llm-pi-ai'
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const THINKING_LEVEL_SET = new Set(THINKING_LEVELS)
const STARTUP_DELAY_MS = 4000
const RELOAD_DEBOUNCE_MS = 1500
const RETRY_DELAY_MS = 8000
const SCAN_DELAY_MS = 9000
const MAX_RETRIES = 6

/** Cordis services the plugin cannot work without. */
export const inject = ['configEditor', 'credentials', 'timer']

const DEFAULTS = {
  entryId: 'llm-pi-ai',
  providers: [],
  syncOnStart: true,
  syncOnConfigReload: true,
  syncImages: true,
  syncReasoning: true,
  thinkingFormat: 'deepseek',
  overwrite: 'missing',
  debug: true,
  debugFile: '',
  requestTimeoutMs: 15000,
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function numberOrUndefined(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function deepEqual(left, right) {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    for (let index = 0; index < left.length; index += 1) {
      if (!deepEqual(left[index], right[index])) return false
    }
    return true
  }
  if (isObject(left) && isObject(right)) {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    if (leftKeys.length !== rightKeys.length) return false
    for (const key of leftKeys) {
      if (!Object.prototype.hasOwnProperty.call(right, key)) return false
      if (!deepEqual(left[key], right[key])) return false
    }
    return true
  }
  return false
}

function normalizeConfig(raw) {
  const input = isObject(raw) ? raw : {}
  const providers = Array.isArray(input.providers)
    ? input.providers.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
    : []
  return {
    entryId: text(input.entryId) || DEFAULTS.entryId,
    providers,
    syncOnStart: input.syncOnStart !== false,
    syncOnConfigReload: input.syncOnConfigReload !== false,
    syncImages: input.syncImages !== false,
    syncReasoning: input.syncReasoning !== false,
    thinkingFormat: text(input.thinkingFormat) || DEFAULTS.thinkingFormat,
    overwrite: input.overwrite === 'always' ? 'always' : DEFAULTS.overwrite,
    debug: input.debug !== false,
    debugFile: text(input.debugFile) || DEFAULTS.debugFile,
    requestTimeoutMs: Number.isFinite(input.requestTimeoutMs)
      ? Math.max(1000, Math.round(input.requestTimeoutMs))
      : DEFAULTS.requestTimeoutMs,
  }
}

/** Normalize one `/v1/models` reply into capability rows. */
function readListing(payload) {
  const rows = []
  let listed = []
  if (isObject(payload) && Array.isArray(payload.data)) {
    listed = payload.data.map((item) => ({ fallbackId: '', raw: item }))
  } else if (isObject(payload) && isObject(payload.models)) {
    listed = Object.entries(payload.models)
      .filter(([, value]) => isObject(value))
      .map(([key, value]) => ({ fallbackId: key, raw: value }))
  }
  for (const { fallbackId, raw } of listed) {
    if (!isObject(raw)) continue
    const id = text(raw.id) || text(fallbackId)
    if (id === '') continue
    const efforts = Array.isArray(raw.reasoning_supported_efforts)
      ? raw.reasoning_supported_efforts
        .map((level) => text(level))
        .filter((level) => level !== '' && level !== 'off' && THINKING_LEVEL_SET.has(level))
      : []
    rows.push({
      id,
      name: text(raw.name) || text(raw.display_name) || id,
      supportsImages: raw.supports_images === true,
      supportsReasoning: raw.supports_reasoning === true,
      efforts,
      defaultEffort: text(raw.reasoning_default_effort) || text(raw.reasoning_effort),
      canDisableThinking: raw.can_disable_thinking === true,
      contextWindow: numberOrUndefined(raw.context_length) ?? numberOrUndefined(raw.contextWindow) ?? numberOrUndefined(raw.max_allowed_size),
      maxTokens: numberOrUndefined(raw.max_output_tokens) ?? numberOrUndefined(raw.maxTokens),
    })
  }
  return rows
}

/** The pi-ai `reasoningEfforts` dict a gateway row supports, or null. */
function deriveReasoningEfforts(row) {
  if (!row.supportsReasoning) return null
  const levels = []
  for (const level of row.efforts) if (!levels.includes(level)) levels.push(level)
  if (levels.length === 0 && row.defaultEffort !== '' && row.defaultEffort !== 'off' && THINKING_LEVEL_SET.has(row.defaultEffort)) {
    levels.push(row.defaultEffort)
  }
  if (levels.length === 0) return null
  levels.sort((left, right) => THINKING_LEVELS.indexOf(left) - THINKING_LEVELS.indexOf(right))
  const efforts = {}
  for (const level of levels) efforts[level] = level
  if (row.canDisableThinking) efforts.off = null
  return efforts
}

/**
 * Enrich one configured model from its gateway row.
 * @returns {{ model: object, changed: boolean, applied: string[] }}
 */
function enrichModel(model, row, config) {
  if (!isObject(model) || row === undefined || row === null) return { model, changed: false, applied: [] }
  const next = cloneJson(model)
  const applied = []
  const always = config.overwrite === 'always'

  if (config.syncImages) {
    const hasInput = Array.isArray(next.input) && next.input.length > 0
    if (always || !hasInput) {
      const desired = row.supportsImages ? ['text', 'image'] : ['text']
      if (!deepEqual(next.input, desired)) {
        next.input = desired
        applied.push('input')
      }
    }
  }

  if (config.syncReasoning) {
    const efforts = deriveReasoningEfforts(row)
    const hasEfforts = next.reasoningEfforts !== undefined
    if (always || !hasEfforts) {
      if (efforts !== null) {
        next.reasoningEfforts = efforts
        applied.push('reasoningEfforts')
        const compat = isObject(next.compat) ? { ...next.compat } : {}
        if (compat.thinkingFormat === undefined) {
          compat.thinkingFormat = config.thinkingFormat
          applied.push('compat.thinkingFormat')
        }
        if (compat.supportsReasoningEffort === undefined) {
          compat.supportsReasoningEffort = true
          applied.push('compat.supportsReasoningEffort')
        }
        next.compat = compat
      } else if (always && hasEfforts) {
        next.reasoningEfforts = false
        applied.push('reasoningEfforts=false')
      }
    }
  }

  return { model: next, changed: applied.length > 0, applied }
}

/** Apply one gateway's capability table to a whole provider config. */
function enrichProviderConfig(providerConfig, gateway, config) {
  const stats = { models: 0, enriched: 0, images: 0, reasoning: 0, canDisableThinking: 0, fields: {} }
  if (!isObject(providerConfig) || !Array.isArray(providerConfig.models)) return stats
  const nextModels = providerConfig.models.map((model) => {
    stats.models += 1
    const id = isObject(model) ? text(model.id) : ''
    const row = id === '' ? undefined : gateway.byId.get(id)
    const { model: enriched, changed, applied } = enrichModel(model, row, config)
    if (changed) {
      stats.enriched += 1
      for (const field of applied) stats.fields[field] = (stats.fields[field] || 0) + 1
      if (applied.includes('input') && row !== undefined && row !== null && row.supportsImages) stats.images += 1
      if (applied.includes('reasoningEfforts')) {
        stats.reasoning += 1
        if (row !== undefined && row !== null && row.canDisableThinking) stats.canDisableThinking += 1
      }
    }
    return enriched
  })
  providerConfig.models = nextModels
  return stats
}

/** Resolve the provider entry to edit from the live configuration. */
function findEntry(configuration, config) {
  const wanted = config.entryId
  for (const layer of configuration) {
    const entry = layer.entry
    if (!isObject(entry)) continue
    const id = text(entry.id)
    const name = isObject(entry.options) ? text(entry.options.name) : ''
    if (id === wanted || (name === LOADER_ENTRY_NAME && id !== '')) return layer
  }
  // Fall back to the package name when the row id was customized.
  for (const layer of configuration) {
    const entry = layer.entry
    if (isObject(entry) && isObject(entry.options) && text(entry.options.name) === LOADER_ENTRY_NAME) return layer
  }
  return undefined
}

function providerConfigOf(override, inherited, providerKey) {
  const fromOverride = isObject(override) && isObject(override.providers) && isObject(override.providers[providerKey])
    ? override.providers[providerKey]
    : undefined
  const fromInherited = isObject(inherited) && isObject(inherited.providers) && isObject(inherited.providers[providerKey])
    ? inherited.providers[providerKey]
    : undefined
  if (fromOverride === undefined && fromInherited === undefined) return undefined
  return { ...(fromInherited || {}), ...(fromOverride || {}) }
}

function selectProviderKeys(override, inherited, config) {
  if (config.providers.length > 0) return config.providers
  const keys = new Set()
  for (const source of [inherited, override]) {
    if (!isObject(source) || !isObject(source.providers)) continue
    for (const key of Object.keys(source.providers)) {
      const provider = providerConfigOf(override, inherited, key)
      if (provider !== undefined && text(provider.baseURL) !== '') keys.add(key)
    }
  }
  return [...keys]
}

/**
 * The Host plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const debugFile = config.debugFile !== '' ? config.debugFile : join(REPORT_DIR, 'sync-debug.json')
  const hmr = ctx.get('hmr')
  // The plugin is activated inside an HMR transaction, and Node timers inherit
  // that AsyncLocalStorage scope. Running our work through hmr.executing.exit
  // drops the inherited scope so configEditor.edit (which needs its own HMR
  // transaction) does not fail with "HMR transactions cannot be nested".
  function outsideHmr(operation) {
    try {
      if (hmr !== undefined && hmr.executing !== undefined && typeof hmr.executing.exit === 'function') {
        return hmr.executing.exit(operation)
      }
    } catch (error) {
      console.warn('[gateway-capability-sync] could not leave the HMR transaction context:', error)
    }
    return operation()
  }

  let inFlight = undefined
  let debounceTimer = undefined
  let retryTimer = undefined
  let retriesLeft = MAX_RETRIES
  let scanTimer = undefined
  let disposed = false

  function writeDebug(report) {
    if (!config.debug) return
    const target = report.kind === 'capability-scan' && config.debugFile === ''
      ? join(REPORT_DIR, 'sync-capabilities.json')
      : debugFile
    try {
      writeFileSync(target, JSON.stringify(report, null, 2) + '\n', 'utf8')
    } catch (error) {
      console.warn('[gateway-capability-sync] could not write debug report:', error)
    }
  }

  async function readGateway(providerKey, provider) {
    const baseURL = text(provider.baseURL)
    if (baseURL === '') return { error: 'provider has no baseURL' }
    const url = baseURL.replace(/\/+$/, '') + '/models'
    const headers = { accept: 'application/json' }
    if (isObject(provider.headers)) {
      for (const [name, value] of Object.entries(provider.headers)) {
        if (typeof value === 'string') headers[name] = value
      }
    }
    const apiKeyEnv = text(provider.apiKeyEnv)
    if (apiKeyEnv !== '') {
      const resolved = await ctx.credentials.resolve(apiKeyEnv)
      if (resolved === undefined) return { error: 'credential ' + apiKeyEnv + ' is not configured' }
      headers.authorization = 'Bearer ' + resolved.value
    }
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    })
    if (!response.ok) {
      return { error: 'HTTP ' + response.status + ' from ' + url }
    }
    const payload = await response.json()
    const rows = readListing(payload)
    if (rows.length === 0) return { error: 'listing at ' + url + ' carried no model records' }
    return { rows }
  }

  function transform(override, inherited, gateways) {
    const next = cloneJson(isObject(override) ? override : {})
    const providers = isObject(next.providers) ? next.providers : undefined
    const statsByProvider = {}
    if (providers === undefined) return { next, statsByProvider }
    for (const [providerKey, gateway] of Object.entries(gateways)) {
      const provider = providers[providerKey]
      if (!isObject(provider) || !Array.isArray(provider.models)) continue
      statsByProvider[providerKey] = enrichProviderConfig(provider, gateway, config)
    }
    return { next, statsByProvider }
  }

  function scheduleRetry(reason, error) {
    if (disposed || retriesLeft <= 0) return
    const message = error instanceof Error ? error.message : String(error)
    if (!/HMR transactions cannot be nested/i.test(message)) return
    retriesLeft -= 1
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      console.warn('[gateway-capability-sync] retrying ' + reason + ' sync after an HMR transaction ends')
      runSync(reason + '-retry').catch((failure) => console.warn('[gateway-capability-sync] retry failed:', failure))
    }, RETRY_DELAY_MS)
  }

  async function runSync(reason) {
    if (disposed) return undefined
    if (inFlight !== undefined) return inFlight
    inFlight = (async () => {
      const startedAt = Date.now()
      const report = {
        version: VERSION,
        reason,
        at: new Date().toISOString(),
        entryId: config.entryId,
        overwrite: config.overwrite,
        options: {
          providers: config.providers,
          syncImages: config.syncImages,
          syncReasoning: config.syncReasoning,
          thinkingFormat: config.thinkingFormat,
        },
        providers: [],
        stats: {},
        wrote: false,
        errors: [],
        durationMs: 0,
      }
      try {
        const configuration = ctx.configEditor.configuration()
        const layer = findEntry(configuration, config)
        if (layer === undefined) {
          report.errors.push('loader entry "' + config.entryId + '" (' + LOADER_ENTRY_NAME + ') was not found')
          report.availableEntryIds = configuration.map((item) => {
            const entry = item.entry
            return isObject(entry) ? text(entry.id) + ' → ' + (isObject(entry.options) ? text(entry.options.name) : '') : ''
          })
          return report
        }
        report.entry = {
          id: isObject(layer.entry) ? text(layer.entry.id) : '',
          name: isObject(layer.entry) && isObject(layer.entry.options) ? text(layer.entry.options.name) : '',
        }
        const override = isObject(layer.override) ? layer.override : {}
        const inherited = isObject(layer.inherited) ? layer.inherited : {}
        const providerKeys = selectProviderKeys(override, inherited, config)
        if (providerKeys.length === 0) {
          report.errors.push('no provider with a baseURL is configured on ' + report.entry.name)
          return report
        }

        const gateways = {}
        for (const providerKey of providerKeys) {
          const provider = providerConfigOf(override, inherited, providerKey)
          if (provider === undefined) {
            report.providers.push({ key: providerKey, error: 'provider is not configured' })
            continue
          }
          const accepted = await readGateway(providerKey, provider)
          if (accepted.error !== undefined) {
            report.providers.push({ key: providerKey, baseURL: text(provider.baseURL), error: accepted.error })
            continue
          }
          const byId = new Map()
          for (const row of accepted.rows) byId.set(row.id, row)
          gateways[providerKey] = { byId }
          report.providers.push({
            key: providerKey,
            baseURL: text(provider.baseURL),
            models: accepted.rows.length,
            withImages: accepted.rows.filter((row) => row.supportsImages).length,
            withReasoning: accepted.rows.filter((row) => row.supportsReasoning).length,
            withOff: accepted.rows.filter((row) => row.canDisableThinking).length,
          })
        }

        if (Object.keys(gateways).length === 0) {
          report.errors.push('no provider could be interrogated; config left untouched')
          return report
        }

        const preview = transform(override, inherited, gateways)
        report.stats = preview.statsByProvider
        if (deepEqual(preview.next, override)) {
          report.wrote = false
          return report
        }

        const entry = layer.entry
        try {
          await ctx.configEditor.edit(entry, (current) => {
            const edited = transform(isObject(current) ? current : {}, inherited, gateways)
            return edited.next
          })
          report.wrote = true
        } catch (error) {
          report.errors.push(error instanceof Error ? error.message : String(error))
          scheduleRetry(reason, error)
        }
      } catch (error) {
        report.errors.push(error instanceof Error ? error.message : String(error))
      } finally {
        report.durationMs = Date.now() - startedAt
        writeDebug(report)
      }
      return report
    })().finally(() => {
      inFlight = undefined
    })
    return inFlight
  }

  async function scanCapabilities() {
    const report = {
      version: VERSION,
      at: new Date().toISOString(),
      providers: [],
      models: [],
      errors: [],
    }
    const llm = ctx.get('llm')
    if (llm === undefined || typeof llm.listModels !== 'function') {
      report.errors.push('llm service is not available')
      return report
    }
    let providerIds = []
    try {
      const info = llm.listProviders()
      providerIds = Array.isArray(info) ? info.map((item) => text(item && item.id)).filter((id) => id !== '') : []
    } catch (error) {
      report.errors.push('listProviders failed: ' + (error instanceof Error ? error.message : String(error)))
      return report
    }
    for (const provider of providerIds) {
      try {
        const models = await llm.listModels(provider)
        for (const model of models) {
          const resolved = await llm.resolveModelInfo(provider, model.id)
          const efforts = resolved.reasoning && Array.isArray(resolved.reasoning.efforts)
            ? resolved.reasoning.efforts.map((effort) => text(effort && effort.id)).filter((id) => id !== '')
            : []
          report.models.push({
            provider,
            model: model.id,
            inputModalities: Array.isArray(resolved.inputModalities) ? [...resolved.inputModalities] : [],
            efforts,
            defaultEffort: resolved.reasoning && resolved.reasoning.defaultEffort !== undefined ? String(resolved.reasoning.defaultEffort) : undefined,
            contextWindow: resolved.context ? resolved.context.contextWindow : undefined,
            defaultMaxTokens: resolved.defaultMaxTokens,
          })
        }
        report.providers.push({ provider, models: models.length })
      } catch (error) {
        report.errors.push(provider + ': ' + (error instanceof Error ? error.message : String(error)))
      }
    }
    report.summary = {
      models: report.models.length,
      withImage: report.models.filter((model) => model.inputModalities.includes('image')).length,
      withReasoning: report.models.filter((model) => model.efforts.length > 0).length,
      withOff: report.models.filter((model) => model.efforts.includes('off')).length,
    }
    writeDebug({ ...report, kind: 'capability-scan' })
    return report
  }

  function formatReport(report) {
    if (report === undefined) return 'gateway sync is already running; try again in a moment'
    const lines = []
    const providerText = report.providers
      .map((provider) => provider.error !== undefined
        ? provider.key + ': ' + provider.error
        : provider.key + ': ' + provider.models + ' models (' + provider.withImages + ' image, ' + provider.withReasoning + ' reasoning, ' + provider.withOff + ' off)')
      .join('; ')
    if (providerText !== '') lines.push(providerText)
    const stats = report.stats || {}
    for (const [key, value] of Object.entries(stats)) {
      const fields = Object.entries(value.fields || {}).map(([field, count]) => field + '×' + count).join(', ')
      lines.push(key + ': ' + value.enriched + '/' + value.models + ' models enriched' + (fields === '' ? '' : ' (' + fields + ')'))
    }
    lines.push(report.wrote ? 'config updated and reloaded' : 'config already up to date')
    if (report.errors.length > 0) lines.push('errors: ' + report.errors.join(' | '))
    lines.push('report: ' + debugFile)
    return lines.join('\n')
  }

  // Startup run, after the profile has settled.
  if (config.syncOnStart) {
    ctx.effect(() => {
      const timer = setTimeout(() => {
        outsideHmr(() => {
          runSync('startup').catch((error) => console.warn('[gateway-capability-sync] startup sync failed:', error))
        })
      }, STARTUP_DELAY_MS)
      return () => clearTimeout(timer)
    }, 'gateway-capability-sync: startup sync')
  }

  // Re-sync whenever a profile patch is reconciled (for example after saving the
  // model list in Settings → Models). Debounced, and the sync itself is a no-op
  // when the config already carries the capabilities.
  if (config.syncOnConfigReload) {
    ctx.effect(() => {
      const off = ctx.on('app-boot/config-reload', () => {
        if (debounceTimer !== undefined) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => {
          debounceTimer = undefined
          outsideHmr(() => {
            runSync('config-reload').catch((error) => console.warn('[gateway-capability-sync] reload sync failed:', error))
          })
        }, RELOAD_DEBOUNCE_MS)
      })
      return () => {
        off()
        if (debounceTimer !== undefined) {
          clearTimeout(debounceTimer)
          debounceTimer = undefined
        }
      }
    }, 'gateway-capability-sync: config reload sync')
  }

  // Manual trigger: /gateway-sync in the composer.
  const commands = ctx.get('commands')
  if (commands !== undefined && typeof commands.register === 'function') {
    ctx.effect(() => commands.register({
      name: 'gateway-sync',
      description: 'Sync model capabilities (vision / reasoning levels) from the configured OpenAI-compatible gateway.',
      handler: async () => {
        const report = await outsideHmr(() => runSync('command'))
        const failed = report === undefined || report.errors.length > 0 || (report.providers || []).some((provider) => provider.error !== undefined)
        return { kind: failed ? 'error' : 'success', text: formatReport(report) }
      },
    }), 'gateway-capability-sync: command')
  }

  // Post-sync scan: read the capabilities the running adapter actually serves.
  // Written to sync-capabilities.json so the effect of a sync can be checked
  // without opening the UI.
  const timerService = ctx.timer
  if (timerService !== undefined && typeof timerService.timeout === 'function') {
    scanTimer = timerService.timeout(() => {
      outsideHmr(() => {
        scanCapabilities().catch((error) => console.warn('[gateway-capability-sync] capability scan failed:', error))
      })
    }, SCAN_DELAY_MS)
  }

  ctx.effect(() => () => {
    disposed = true
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    if (scanTimer !== undefined && typeof scanTimer === 'function') scanTimer()
  }, 'gateway-capability-sync: disposed flag')
}

