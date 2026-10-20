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
 * Reports are written under the Harness home when `debug` is enabled.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const { version: VERSION } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
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

const LOADER_ENTRY_NAME = '@deepseek-ai/dsh-llm-pi-ai'
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const THINKING_LEVEL_SET = new Set(THINKING_LEVELS)
const THINKING_FORMATS = new Set(['openai', 'deepseek', 'openrouter', 'together', 'baseten', 'zai', 'qwen', 'chat-template', 'qwen-chat-template', 'string-thinking', 'ant-ling'])
const STARTUP_DELAY_MS = 4000
const RELOAD_DEBOUNCE_MS = 1500
const RETRY_DELAY_MS = 8000
const SCAN_DELAY_MS = 9000
const MAX_RETRIES = 6

/** True for the Host's rejection of an edit issued inside a transaction. */
function isNestedTransactionError(error) {
  return /HMR transactions cannot be nested/i.test(error instanceof Error ? error.message : String(error))
}

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
  const thinkingFormat = text(input.thinkingFormat) || DEFAULTS.thinkingFormat
  if (!THINKING_FORMATS.has(thinkingFormat)) throw new Error('unsupported thinkingFormat: ' + thinkingFormat)
  return {
    entryId: text(input.entryId) || DEFAULTS.entryId,
    providers: [...new Set(providers)],
    syncOnStart: input.syncOnStart !== false,
    syncOnConfigReload: input.syncOnConfigReload !== false,
    syncImages: input.syncImages !== false,
    syncReasoning: input.syncReasoning !== false,
    thinkingFormat,
    overwrite: input.overwrite === 'always' ? 'always' : DEFAULTS.overwrite,
    debug: input.debug !== false,
    debugFile: text(input.debugFile) || DEFAULTS.debugFile,
    requestTimeoutMs: Number.isFinite(input.requestTimeoutMs)
      ? Math.min(2147483647, Math.max(1000, Math.round(input.requestTimeoutMs)))
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
    const defaultEffort = text(raw.reasoning_default_effort) || text(raw.reasoning_effort)
    const inferredReasoning = efforts.length > 0 || (defaultEffort !== 'off' && THINKING_LEVEL_SET.has(defaultEffort))
    rows.push({
      id,
      name: text(raw.name) || text(raw.display_name) || id,
      supportsImages: typeof raw.supports_images === 'boolean' ? raw.supports_images : undefined,
      supportsReasoning: typeof raw.supports_reasoning === 'boolean'
        ? raw.supports_reasoning
        : inferredReasoning ? true : undefined,
      efforts,
      defaultEffort,
      canDisableThinking: typeof raw.can_disable_thinking === 'boolean' ? raw.can_disable_thinking : undefined,
      contextWindow: numberOrUndefined(raw.context_length) ?? numberOrUndefined(raw.contextWindow) ?? numberOrUndefined(raw.max_allowed_size),
      maxTokens: numberOrUndefined(raw.max_output_tokens) ?? numberOrUndefined(raw.maxTokens),
    })
  }
  return rows
}

/** False is an explicit denial; undefined means no usable declaration. */
function deriveReasoningEfforts(row) {
  if (row.supportsReasoning === false) return false
  const levels = []
  for (const level of row.efforts) if (!levels.includes(level)) levels.push(level)
  if (levels.length === 0 && row.defaultEffort !== '' && row.defaultEffort !== 'off' && THINKING_LEVEL_SET.has(row.defaultEffort)) {
    levels.push(row.defaultEffort)
  }
  if (levels.length === 0) return undefined
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
function enrichModel(model, row, config, provider) {
  if (!isObject(model) || row === undefined || row === null) return { model, changed: false, applied: [] }
  const next = cloneJson(model)
  const applied = []
  const always = config.overwrite === 'always'

  if (config.syncImages && row.supportsImages !== undefined) {
    const hasInput = (Array.isArray(next.input) && next.input.length > 0)
      || (Array.isArray(provider.defaultInput) && provider.defaultInput.length > 0)
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
    if ((always || !hasEfforts) && efforts !== undefined) {
      // An omitted off capability does not revoke an existing declaration.
      if (isObject(efforts) && row.canDisableThinking === undefined
        && isObject(next.reasoningEfforts) && Object.hasOwn(next.reasoningEfforts, 'off')) {
        efforts.off = next.reasoningEfforts.off
      }
      if (!deepEqual(next.reasoningEfforts, efforts)) {
        next.reasoningEfforts = efforts
        applied.push(efforts === false ? 'reasoningEfforts=false' : 'reasoningEfforts')
      }
    }
    // These two switches are only valid for Chat Completions. Unknown catalog
    // protocols are deliberately left alone rather than guessed from a URL.
    if (row.supportsReasoning === true && provider.api === 'openai-completions' && isObject(next.reasoningEfforts)) {
      const compat = isObject(next.compat) ? { ...next.compat } : {}
      const inheritedCompat = isObject(provider.compat) ? provider.compat : {}
      for (const [field, value] of Object.entries({ thinkingFormat: config.thinkingFormat, supportsReasoningEffort: true })) {
        const effective = compat[field] === undefined ? inheritedCompat[field] : compat[field]
        if ((always || effective === undefined) && !deepEqual(effective, value)) {
          compat[field] = value
          applied.push('compat.' + field)
        }
      }
      if (Object.keys(compat).length > 0) next.compat = compat
    }
  }

  return { model: next, changed: applied.length > 0, applied }
}

/** Apply one gateway's capability table to a whole provider config. */
function enrichProviderConfig(providerConfig, gateway, config) {
  const stats = { models: 0, matched: 0, enriched: 0, images: 0, reasoning: 0, canDisableThinking: 0, fields: {}, warnings: [] }
  if (!isObject(providerConfig) || !Array.isArray(providerConfig.models) || providerConfig.models.length === 0) {
    stats.skipped = 'no configured models list; catalog-only routes are not modified'
    return stats
  }
  const nextModels = providerConfig.models.map((model) => {
    stats.models += 1
    const id = isObject(model) ? text(model.id) : ''
    const row = id === '' ? undefined : gateway.byId.get(id)
    if (row !== undefined) stats.matched += 1
    const { model: enriched, changed, applied } = enrichModel(model, row, config, providerConfig)
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
  if (stats.matched === 0) stats.skipped = 'no configured model matched the gateway listing'
  if (config.syncReasoning && !text(providerConfig.api)
    && nextModels.some((model) => isObject(model) && isObject(model.reasoningEfforts))) {
    stats.warnings.push('api is not explicit; completions-only compat was left untouched')
  }
  return stats
}

/** Resolve the provider entry to edit from the live configuration. */
function findEntry(configuration, config) {
  const matches = configuration.filter((layer) => entryIdOf(layer.entry) === config.entryId)
  if (matches.length > 1) throw new Error('multiple Loader entries have id "' + config.entryId + '"')
  if (matches.length === 1) {
    if (matches[0].entry.options?.name !== LOADER_ENTRY_NAME) throw new Error('entry "' + config.entryId + '" is not ' + LOADER_ENTRY_NAME)
    return matches[0]
  }
  if (config.entryId !== DEFAULTS.entryId) return undefined
  const candidates = configuration.filter((layer) => layer.entry?.options?.name === LOADER_ENTRY_NAME)
  if (candidates.length > 1) throw new Error('multiple pi-ai Loader entries found; set entryId explicitly')
  return candidates[0]
}

function entryIdOf(entry) {
  return text(entry?.options?.id) || text(entry?.id)
}

// ConfigEditor persists complete raw configs, not a deep-merge patch. The live
// entry is authoritative even when its explicit config is empty.
function configurationOf(layer) {
  if (isObject(layer.entry?.options) && Object.hasOwn(layer.entry.options, 'config')) {
    return isObject(layer.entry.options.config) ? layer.entry.options.config : {}
  }
  if (isObject(layer.override) && Object.keys(layer.override).length > 0) return layer.override
  return isObject(layer.inherited) ? layer.inherited : {}
}

function providerConfigOf(current, providerKey) {
  return isObject(current.providers) && Object.hasOwn(current.providers, providerKey)
    && isObject(current.providers[providerKey]) ? current.providers[providerKey] : undefined
}

function selectProviderKeys(current, config) {
  if (config.providers.length > 0) return config.providers
  return Object.keys(isObject(current.providers) ? current.providers : {})
    .filter((key) => text(providerConfigOf(current, key)?.baseURL) !== '')
}

function gatewaySource(provider) {
  return Object.fromEntries(['baseURL', 'apiKeyEnv', 'headers', 'api']
    .filter((field) => provider[field] !== undefined)
    .map((field) => [field, provider[field]]))
}

/**
 * The Host plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const reportDir = config.debug && config.debugFile === '' ? resolveReportDir() : ''
  const debugFile = config.debugFile !== '' ? config.debugFile : join(reportDir, 'sync-debug.json')
  const capabilityFile = config.debugFile === '' ? join(reportDir, 'sync-capabilities.json')
    : debugFile.endsWith('.json') ? debugFile.slice(0, -5) + '-capabilities.json' : debugFile + '.capabilities.json'
  const hmr = ctx.get('hmr')
  // The plugin is activated inside an HMR transaction, and Node timers inherit
  // that AsyncLocalStorage scope. Running our work through hmr.executing.exit
  // drops the inherited scope so configEditor.edit (which needs its own HMR
  // transaction) does not fail with "HMR transactions cannot be nested".
  function outsideHmr(operation) {
    if (hmr !== undefined && hmr.executing !== undefined && typeof hmr.executing.exit === 'function') {
      return hmr.executing.exit(operation)
    }
    return operation()
  }

  // `configEditor.edit` is rejected whenever `hmr.executing` still holds a
  // store ("HMR transactions cannot be nested"). exit() clears the store for the
  // synchronous call and its whole continuation, which covers every trigger this
  // plugin installs (timers, loader events, the command handler). A rejection can
  // still happen when a *neighbouring* transaction is live at that instant, so
  // the write is attempted and, on exactly that error, handed to the throttled
  // retry below rather than being treated as a permanent failure.

  let inFlight = undefined
  let pendingReason = undefined
  let debounceTimer = undefined
  let retryTimer = undefined
  let retriesLeft = MAX_RETRIES
  let scanTimer = undefined
  let disposed = false
  const lifecycle = new AbortController()

  function writeDebug(report) {
    if (!config.debug || disposed) return
    const target = report.kind === 'capability-scan' ? capabilityFile : debugFile
    try {
      mkdirSync(dirname(target), { recursive: true })
      // attemptedWrite is bookkeeping for status classification, not report data.
      const { attemptedWrite, ...published } = report
      writeFileSync(target, JSON.stringify(published, null, 2) + '\n', 'utf8')
    } catch (error) {
      console.warn('[gateway-capability-sync] could not write debug report:', error)
    }
  }

  async function readGateway(provider) {
    const baseURL = text(provider.baseURL)
    if (baseURL === '') return { error: 'provider has no baseURL' }
    const url = baseURL.replace(/\/+$/, '') + '/models'
    const headers = new Headers({ accept: 'application/json' })
    if (isObject(provider.headers)) {
      for (const [name, value] of Object.entries(provider.headers)) {
        if (typeof value === 'string') headers.set(name, value)
      }
    }
    const apiKeyEnv = text(provider.apiKeyEnv)
    if (apiKeyEnv !== '') {
      const resolved = await ctx.credentials.resolve(apiKeyEnv)
      lifecycle.signal.throwIfAborted()
      if (resolved === undefined) return { error: 'credential ' + apiKeyEnv + ' is not configured' }
      headers.set('authorization', 'Bearer ' + resolved.value)
    }
    lifecycle.signal.throwIfAborted()
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(config.requestTimeoutMs)]),
    })
    if (!response.ok) {
      return { error: 'HTTP ' + response.status + ' from ' + url }
    }
    const payload = await response.json()
    const rows = readListing(payload)
    if (rows.length === 0) return { error: 'listing at ' + url + ' carried no model records' }
    return { rows }
  }

  function transform(current, gateways) {
    const next = cloneJson(isObject(current) ? current : {})
    const statsByProvider = Object.create(null)
    let stale = false
    for (const [providerKey, gateway] of Object.entries(gateways)) {
      const provider = providerConfigOf(next, providerKey)
      if (provider === undefined) {
        statsByProvider[providerKey] = { skipped: 'provider was removed before the sync completed' }
        continue
      }
      if (!deepEqual(gatewaySource(provider), gateway.source)) {
        statsByProvider[providerKey] = { skipped: 'provider connection changed; stale listing was discarded' }
        stale = true
        continue
      }
      statsByProvider[providerKey] = enrichProviderConfig(provider, gateway, config)
    }
    return { next, statsByProvider, stale }
  }

  function scheduleRetry(reason, error) {
    if (disposed || retriesLeft <= 0) return
    if (!isNestedTransactionError(error)) return
    retriesLeft -= 1
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      console.warn('[gateway-capability-sync] retrying ' + reason + ' sync after an HMR transaction ends')
      outsideHmr(() => runSync(reason + '-retry')).catch((failure) => console.warn('[gateway-capability-sync] retry failed:', failure))
    }, RETRY_DELAY_MS)
  }

  async function syncOnce(reason) {
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
      attemptedWrite: false,
      status: 'failed',
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
          return isObject(entry) ? entryIdOf(entry) + ' → ' + (isObject(entry.options) ? text(entry.options.name) : '') : ''
        })
        return report
      }
      report.entry = {
        id: entryIdOf(layer.entry),
        name: isObject(layer.entry) && isObject(layer.entry.options) ? text(layer.entry.options.name) : '',
      }
      const current = cloneJson(configurationOf(layer))
      const providerKeys = selectProviderKeys(current, config)
      if (providerKeys.length === 0) {
        report.errors.push('no provider with a baseURL is configured on ' + report.entry.name)
        return report
      }

      const gateways = Object.create(null)
      for (const providerKey of providerKeys) {
        lifecycle.signal.throwIfAborted()
        const provider = providerConfigOf(current, providerKey)
        if (provider === undefined) {
          report.providers.push({ key: providerKey, error: 'provider is not configured' })
          continue
        }
        let accepted
        try {
          accepted = await readGateway(provider)
        } catch (error) {
          lifecycle.signal.throwIfAborted()
          accepted = { error: error instanceof Error ? error.message : String(error) }
        }
        lifecycle.signal.throwIfAborted()
        if (accepted.error !== undefined) {
          report.providers.push({ key: providerKey, baseURL: text(provider.baseURL), error: accepted.error })
          continue
        }
        const byId = new Map()
        for (const row of accepted.rows) byId.set(row.id, row)
        gateways[providerKey] = { byId, source: cloneJson(gatewaySource(provider)) }
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

      lifecycle.signal.throwIfAborted()
      const preview = transform(current, gateways)
      report.stats = preview.statsByProvider
      report.status = 'up-to-date'
      if (deepEqual(preview.next, current)) {
        if (Object.values(report.stats).every((stats) => stats.skipped !== undefined)) report.status = 'skipped'
        return report
      }

      const entry = layer.entry
      try {
        report.attemptedWrite = true
        await ctx.configEditor.edit(entry, (latest) => {
          lifecycle.signal.throwIfAborted()
          const edited = transform(latest, gateways)
          report.stats = edited.statsByProvider
          if (edited.stale) pendingReason = 'config-changed'
          report.wrote = !deepEqual(edited.next, latest)
          return edited.next
        })
        report.status = report.wrote ? 'updated' : 'skipped'
        // A write proves the profile is reachable again; restore the retry budget
        // so a later independent failure is not punished by an earlier one.
        retriesLeft = MAX_RETRIES
        if (retryTimer !== undefined) {
          clearTimeout(retryTimer)
          retryTimer = undefined
        }
      } catch (error) {
        report.wrote = false
        report.status = disposed ? 'cancelled' : 'failed'
        if (disposed) return report
        report.errors.push(error instanceof Error ? error.message : String(error))
        scheduleRetry(reason, error)
      }
    } catch (error) {
      if (disposed) report.status = 'cancelled'
      else {
        report.status = 'failed'
        report.errors.push(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (report.status !== 'cancelled' && (report.errors.length > 0 || report.providers.some((provider) => provider.error !== undefined))) {
        // An unreachable provider is not a failure of this run when the profile
        // was updated for the providers that did answer. It is a failure when
        // nothing could be written at all.
        report.status = report.wrote ? 'partial' : (report.attemptedWrite ? 'failed' : report.status)
      }
      report.durationMs = Date.now() - startedAt
      writeDebug(report)
    }
    return report
  }

  function runSync(reason) {
    if (disposed) return Promise.resolve(undefined)
    if (inFlight !== undefined) {
      if (reason === 'config-reload' || reason.endsWith('-retry')) pendingReason = reason
      return inFlight
    }
    inFlight = (async () => {
      const previousRuns = []
      let nextReason = reason
      let wrote = false
      let report
      do {
        pendingReason = undefined
        report = await syncOnce(nextReason)
        wrote ||= report.wrote
        // A reload queued while fetching needs a fresh pass before verification.
        if (!disposed && pendingReason === undefined && config.debug) await scanCapabilities()
        nextReason = pendingReason
        if (nextReason !== undefined) previousRuns.push({ reason: report.reason, wrote: report.wrote, errors: report.errors, stats: report.stats })
      } while (!disposed && nextReason !== undefined)
      if (wrote && report.status === 'up-to-date') report.status = 'updated'
      report.wrote = wrote
      report.previousRuns = previousRuns
      writeDebug(report)
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
    try {
      lifecycle.signal.throwIfAborted()
      const llm = ctx.get('llm')
      if (llm === undefined || typeof llm.listModels !== 'function' || typeof llm.listProviders !== 'function'
        || typeof llm.resolveModelInfo !== 'function') {
        report.errors.push('llm service is not available')
        return report
      }
      const info = await llm.listProviders()
      const providerIds = Array.isArray(info) ? info.map((item) => text(item && item.id)).filter((id) => id !== '') : []
      for (const provider of providerIds) {
        try {
          lifecycle.signal.throwIfAborted()
          const models = await llm.listModels(provider)
          for (const model of models) {
            lifecycle.signal.throwIfAborted()
            const resolved = await llm.resolveModelInfo(provider, model.id)
            lifecycle.signal.throwIfAborted()
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
          if (disposed) return report
          report.errors.push(provider + ': ' + (error instanceof Error ? error.message : String(error)))
        }
      }
    } catch (error) {
      if (!disposed) report.errors.push(error instanceof Error ? error.message : String(error))
    } finally {
      report.summary = {
        models: report.models.length,
        withImage: report.models.filter((model) => model.inputModalities.includes('image')).length,
        withReasoning: report.models.filter((model) => model.efforts.length > 0).length,
        withOff: report.models.filter((model) => model.efforts.includes('off')).length,
      }
      writeDebug({ ...report, kind: 'capability-scan' })
    }
    return report
  }

  function formatReport(report) {
    if (report === undefined) return 'gateway sync cancelled: plugin is inactive'
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
      lines.push(value.skipped !== undefined ? key + ': skipped: ' + value.skipped
        : key + ': ' + value.enriched + '/' + value.models + ' models enriched' + (fields === '' ? '' : ' (' + fields + ')'))
      for (const warning of value.warnings || []) lines.push(key + ': warning: ' + warning)
    }
    const failed = report.status === 'failed' || report.status === 'partial'
    lines.push(report.status === 'cancelled' ? 'gateway sync cancelled: plugin is inactive'
      : report.wrote ? 'config updated and reloaded' + (failed ? ' (some providers failed)' : '')
        : report.status === 'skipped' ? 'config left unchanged: sync skipped'
          : failed ? 'config left unchanged: sync failed' : 'config already up to date')
    if (report.errors.length > 0) lines.push('errors: ' + report.errors.join(' | '))
    if (config.debug) lines.push('report: ' + debugFile)
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
        if (disposed) return
        if (inFlight !== undefined) {
          pendingReason = 'config-reload'
          return
        }
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
        const failed = report === undefined || ['failed', 'partial', 'cancelled'].includes(report.status)
        return { kind: failed ? 'error' : 'success', text: formatReport(report) }
      },
    }), 'gateway-capability-sync: command')
  }

  // With startup sync disabled, keep one initial diagnostic scan. Every sync
  // otherwise scans only after edits and any queued reloads have completed.
  const timerService = ctx.timer
  if (config.debug && !config.syncOnStart && timerService !== undefined && typeof timerService.timeout === 'function') {
    scanTimer = timerService.timeout(() => {
      if (!disposed && inFlight === undefined) outsideHmr(() => scanCapabilities())
        .catch((error) => console.warn('[gateway-capability-sync] capability scan failed:', error))
    }, SCAN_DELAY_MS)
  }

  ctx.effect(() => () => {
    disposed = true
    pendingReason = undefined
    lifecycle.abort()
    if (debounceTimer !== undefined) clearTimeout(debounceTimer)
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    if (scanTimer !== undefined && typeof scanTimer === 'function') scanTimer()
  }, 'gateway-capability-sync: disposed flag')
}

