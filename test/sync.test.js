import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { apply } from '../index.js'

const PACKAGE = '@deepseek-ai/dsh-llm-pi-ai'
const wire = { id: 'm', supports_images: true, supports_reasoning: true, reasoning_supported_efforts: ['low', 'high'], can_disable_thinking: true }
const clone = value => structuredClone(value)
const provider = (extra = {}) => ({ api: 'openai-completions', baseURL: 'https://gateway.invalid/v1', models: [{ id: 'm' }], ...extra })
const configuration = p => ({ providers: { gateway: provider(p) } })
const response = (rows = [wire]) => new Response(JSON.stringify({ data: rows }), { headers: { 'content-type': 'application/json' } })
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function host(t, { current = configuration(), inherited = {}, entries, config = {}, fetch = async () => response(), beforeEdit, credentials, llm, emitOnEdit = false, hmr } = {}) {
  let command
  let edits = 0
  let editCalls = 0
  let scans = 0
  let fetches = 0
  let disposed = false
  const events = new Map()
  const cleanup = []
  const trace = []
  const layers = entries || [{ entry: { options: { id: 'llm-pi-ai', name: PACKAGE, config: clone(current) } }, inherited: clone(inherited), override: {} }]
  const temp = mkdtempSync(join(tmpdir(), 'gcs-test-'))
  const debugFile = join(temp, 'reports', 'sync.json')
  t.mock.method(globalThis, 'fetch', async (...args) => { fetches++; return fetch(...args) })
  const ctx = {
    credentials: credentials || { resolve: async () => ({ value: 'dummy-test-key' }) },
    timer: {
      timeout(fn, ms) { const handle = setTimeout(fn, ms); return () => clearTimeout(handle) },
    },
    configEditor: {
      configuration: () => layers,
      async edit(entry, change) {
        editCalls++
        if (beforeEdit) await beforeEdit(entry)
        const next = change(clone(entry.options.config), clone(inherited))
        trace.push('edit')
        if (JSON.stringify(next) !== JSON.stringify(entry.options.config)) {
          edits++
          entry.options.config = next
          if (emitOnEdit) events.get('app-boot/config-reload')?.()
        }
        trace.push('reconciled')
      },
    },
    get(name) {
      if (name === 'commands') return { register(value) { command = value; return () => {} } }
      if (name === 'hmr') return hmr
      if (name === 'llm') {
        if (llm !== undefined) return llm
        return {
          listProviders() { scans++; trace.push('scan'); return [{ id: 'gateway' }] },
          listModels() { return layers[0].entry.options.config.providers?.gateway?.models || [] },
          resolveModelInfo(_provider, id) {
            const model = layers[0].entry.options.config.providers.gateway.models.find(model => model.id === id)
            return { inputModalities: model.input || ['text'], reasoning: { efforts: Object.keys(model.reasoningEfforts || {}).map(id => ({ id })) } }
          },
        }
      }
    },
    on(name, fn) { events.set(name, fn); return () => events.delete(name) },
    effect(fn) { const disposer = fn(); if (typeof disposer === 'function') cleanup.push(disposer) },
  }
  apply(ctx, { syncOnStart: false, syncOnConfigReload: false, debug: false, debugFile, ...config })
  function dispose() { if (!disposed) { disposed = true; cleanup.reverse().forEach(fn => fn()) } }
  t.after(() => { dispose(); rmSync(temp, { recursive: true, force: true }) })
  return {
    run: () => command.handler(),
    reload: () => events.get('app-boot/config-reload')?.(),
    dispose,
    layers,
    trace,
    debugFile,
    capabilityFile: join(temp, 'reports', 'sync-capabilities.json'),
    get current() { return layers[0].entry.options.config },
    get model() { return this.current.providers.gateway.models[0] },
    get edits() { return edits },
    get editCalls() { return editCalls },
    get scans() { return scans },
    get fetches() { return fetches },
  }
}

test('enriches capabilities and both overwrite modes remain idempotent', async t => {
  for (const overwrite of ['missing', 'always']) {
    const h = host(t, { config: { overwrite } })
    assert.equal((await h.run()).kind, 'success')
    assert.deepEqual(h.model.input, ['text', 'image'])
    assert.deepEqual(h.model.reasoningEfforts, { low: 'low', high: 'high', off: null })
    assert.deepEqual(h.model.compat, { thinkingFormat: 'deepseek', supportsReasoningEffort: true })
    await h.run()
    assert.equal(h.edits, 1)
    h.dispose()
  }
})

test('selects the explicit entry ID ahead of an earlier package match', async t => {
  const make = id => ({ entry: { options: { id, name: PACKAGE, config: configuration() } } })
  const first = make('first'), target = make('target')
  const h = host(t, { entries: [first, target], config: { entryId: 'target' } })
  await h.run()
  assert.equal(first.entry.options.config.providers.gateway.models[0].input, undefined)
  assert.deepEqual(target.entry.options.config.providers.gateway.models[0].input, ['text', 'image'])
})

test('uses a unique default-ID fallback, but rejects ambiguity and missing custom IDs', async t => {
  const make = id => ({ entry: { options: { id, name: PACKAGE, config: configuration() } } })
  const unique = host(t, { entries: [make('custom')] })
  assert.equal((await unique.run()).kind, 'success')
  const ambiguous = host(t, { entries: [make('first'), make('second')] })
  assert.match((await ambiguous.run()).text, /multiple pi-ai Loader entries/)
  assert.equal(ambiguous.fetches, 0)
  const missing = host(t, { entries: [make('custom')], config: { entryId: 'missing' } })
  assert.match((await missing.run()).text, /was not found/)
  assert.equal(missing.fetches, 0)
})

test('rejects an exact ID that belongs to another plugin', async t => {
  const h = host(t, { entries: [{ entry: { options: { id: 'llm-pi-ai', name: 'other', config: configuration() } } }] })
  assert.equal((await h.run()).kind, 'error')
  assert.equal(h.edits, 0)
  assert.equal(h.fetches, 0)
})

test('missing respects provider compat and input defaults, including explicit false', async t => {
  const h = host(t, { current: configuration({ defaultInput: ['text'], compat: { thinkingFormat: 'openai', supportsReasoningEffort: false } }) })
  await h.run()
  assert.equal(h.model.input, undefined)
  assert.equal(h.model.compat, undefined)
  assert.deepEqual(h.current.providers.gateway.compat, { thinkingFormat: 'openai', supportsReasoningEffort: false })
})

test('missing fills compat independently of existing effort levels', async t => {
  const h = host(t, { current: configuration({ models: [{ id: 'm', reasoningEfforts: { high: 'custom-high' }, compat: { supportsStore: false } }] }) })
  await h.run()
  assert.deepEqual(h.model.reasoningEfforts, { high: 'custom-high' })
  assert.deepEqual(h.model.compat, { supportsStore: false, thinkingFormat: 'deepseek', supportsReasoningEffort: true })
})

test('missing preserves model overrides and explicit non-reasoning models', async t => {
  const original = { id: 'm', input: ['text'], reasoningEfforts: false, compat: { thinkingFormat: 'qwen', supportsReasoningEffort: false } }
  const h = host(t, { current: configuration({ models: [original] }) })
  await h.run()
  assert.deepEqual(h.model, original)
  assert.equal(h.edits, 0)
})

test('always refreshes applicable compat but preserves unrelated fields', async t => {
  const h = host(t, { config: { overwrite: 'always', thinkingFormat: 'zai' }, current: configuration({ models: [{ id: 'm', compat: { thinkingFormat: 'openai', supportsReasoningEffort: false, supportsStore: false } }] }) })
  await h.run()
  assert.deepEqual(h.model.compat, { thinkingFormat: 'zai', supportsReasoningEffort: true, supportsStore: false })
  await h.run()
  assert.equal(h.edits, 1)
})

for (const api of ['openai-responses', 'anthropic-messages', undefined]) {
  test(`does not inject completions-only compat for ${api || 'unknown'} protocol`, async t => {
    const h = host(t, { current: configuration({ api }) })
    await h.run()
    assert.deepEqual(h.model.reasoningEfforts, { low: 'low', high: 'high', off: null })
    assert.equal(h.model.compat, undefined)
  })
}

test('unknown capabilities never overwrite existing values, even in always mode', async t => {
  const model = { id: 'm', input: ['text', 'image'], reasoningEfforts: { high: 'high' }, compat: { thinkingFormat: 'qwen' } }
  const h = host(t, { current: configuration({ models: [model] }), config: { overwrite: 'always' }, fetch: async () => response([{ id: 'm' }]) })
  await h.run()
  assert.deepEqual(h.model, model)
  assert.equal(h.edits, 0)
})

test('explicit negative capabilities disable reasoning and image input', async t => {
  const h = host(t, { current: configuration({ models: [{ id: 'm', input: ['text', 'image'], reasoningEfforts: { high: 'high' } }] }), config: { overwrite: 'always' }, fetch: async () => response([{ id: 'm', supports_images: false, supports_reasoning: false, reasoning_supported_efforts: ['high'] }]) })
  await h.run()
  assert.deepEqual(h.model.input, ['text'])
  assert.equal(h.model.reasoningEfforts, false)
})

test('infers reasoning from declared levels or a valid default, without inventing levels', async t => {
  const h = host(t, { current: configuration({ models: [{ id: 'm' }, { id: 'default' }, { id: 'no-levels', reasoningEfforts: { low: 'low' } }] }), fetch: async () => response([
    { id: 'm', reasoning_supported_efforts: ['high', 'unknown', 'high', 'low'], can_disable_thinking: true },
    { id: 'default', reasoning_default_effort: 'max' },
    { id: 'no-levels', supports_reasoning: true },
  ]), config: { overwrite: 'always' } })
  await h.run()
  const models = h.current.providers.gateway.models
  assert.deepEqual(models[0].reasoningEfforts, { low: 'low', high: 'high', off: null })
  assert.deepEqual(models[1].reasoningEfforts, { max: 'max' })
  assert.deepEqual(models[2].reasoningEfforts, { low: 'low' })
})

test('unknown off capability preserves existing off; explicit false removes it', async t => {
  let canDisable
  const h = host(t, { current: configuration({ models: [{ id: 'm', reasoningEfforts: { low: 'low', off: null } }] }), config: { overwrite: 'always' }, fetch: async () => response([{ id: 'm', reasoning_supported_efforts: ['high'], ...(canDisable === undefined ? {} : { can_disable_thinking: canDisable }) }]) })
  await h.run()
  assert.deepEqual(h.model.reasoningEfforts, { high: 'high', off: null })
  canDisable = false
  await h.run()
  assert.deepEqual(h.model.reasoningEfforts, { high: 'high' })
})

test('syncs inherited current models while preserving every other provider and raw field', async t => {
  const current = configuration()
  current.providers.untouched = { api: 'anthropic-messages', models: [{ id: 'other' }] }
  current.custom = { keep: true }
  const h = host(t, { current, inherited: current })
  await h.run()
  assert.deepEqual(h.model.input, ['text', 'image'])
  assert.deepEqual(h.current.providers.untouched, current.providers.untouched)
  assert.deepEqual(h.current.custom, current.custom)
})

test('does not restore inherited providers excluded from the current complete config', async t => {
  const inherited = configuration()
  inherited.providers.removed = provider()
  const h = host(t, { inherited })
  await h.run()
  assert.equal(h.current.providers.removed, undefined)
  assert.equal(h.fetches, 1)
})

test('an explicit empty current config is not replaced with inherited providers', async t => {
  const h = host(t, { current: {}, inherited: configuration() })
  assert.equal((await h.run()).kind, 'error')
  assert.equal(h.fetches, 0)
  assert.deepEqual(h.current, {})
})

for (const failure of ['network', 'json', 'credential', 'http']) {
  test(`isolates ${failure} failure and still syncs healthy providers`, async t => {
    const current = { providers: { good: provider(), bad: provider({ baseURL: 'https://bad.invalid/v1', apiKeyEnv: failure === 'credential' ? 'BAD_KEY' : undefined }) } }
    const h = host(t, { current, credentials: { resolve: async () => { throw new Error('credential unavailable') } }, fetch: async url => {
      if (!url.includes('bad.invalid')) return response()
      if (failure === 'network') throw new Error('simulated timeout')
      if (failure === 'json') return new Response('invalid json')
      return new Response('', { status: 503 })
    } })
    const result = await h.run()
    assert.equal(result.kind, 'error')
    assert.match(result.text, /config updated and reloaded \(some providers failed\)/)
    assert.deepEqual(h.current.providers.good.models[0].input, ['text', 'image'])
    assert.equal(h.current.providers.bad.models[0].input, undefined)
  })
}

test('cancels an in-flight request on disposal without submitting config', async t => {
  let signal
  const blocked = deferred()
  const h = host(t, { fetch: async (_url, options) => { signal = options.signal; return blocked.promise } })
  const pending = h.run()
  assert.equal(signal.aborted, false)
  h.dispose()
  assert.equal(signal.aborted, true)
  blocked.resolve(response())
  assert.equal((await pending).kind, 'error')
  assert.equal(h.editCalls, 0)
})

test('checks disposal again inside the edit callback', async t => {
  const ready = deferred(), proceed = deferred()
  const h = host(t, { beforeEdit: async () => { ready.resolve(); await proceed.promise } })
  const pending = h.run()
  await ready.promise
  h.dispose(); proceed.resolve()
  assert.equal((await pending).kind, 'error')
  assert.equal(h.edits, 0)
})

test('does not start a fetch after pending credential resolution finishes on a disposed plugin', async t => {
  const blocked = deferred()
  const h = host(t, { current: configuration({ apiKeyEnv: 'TEST_KEY' }), credentials: { resolve: () => blocked.promise } })
  const pending = h.run()
  h.dispose(); blocked.resolve({ value: 'dummy-key' })
  await pending
  assert.equal(h.fetches, 0)
  assert.equal(h.edits, 0)
})

test('reloads during a fetch are coalesced into a fresh pass for the latest models', async t => {
  const blocked = deferred()
  let call = 0
  const h = host(t, { config: { syncOnConfigReload: true }, fetch: async () => ++call === 1 ? blocked.promise : response([wire, { ...wire, id: 'new-model' }]) })
  const pending = h.run()
  h.layers[0].entry.options.config.providers.gateway.models.push({ id: 'new-model' })
  h.reload(); h.reload()
  blocked.resolve(response())
  await pending
  assert.equal(h.fetches, 2)
  assert.deepEqual(h.current.providers.gateway.models[1].input, ['text', 'image'])
})

test('concurrent manual commands share one request instead of adding a rerun', async t => {
  const blocked = deferred()
  const h = host(t, { fetch: () => blocked.promise })
  const first = h.run(), second = h.run()
  blocked.resolve(response())
  assert.deepEqual(await first, await second)
  assert.equal(h.fetches, 1)
})

test('a self-generated config reload settles without an infinite write loop', async t => {
  const h = host(t, { emitOnEdit: true, config: { syncOnConfigReload: true, overwrite: 'always' } })
  const result = await h.run()
  assert.equal(h.edits, 1)
  assert.equal(h.fetches, 2)
  assert.match(result.text, /config updated and reloaded/)
})

test('discards a stale response when provider connection changes before edit', async t => {
  const urls = []
  let changed = false
  const h = host(t, { fetch: async url => { urls.push(url); return response([{ ...wire, supports_images: !url.includes('new.invalid') }]) }, beforeEdit: async entry => {
    if (!changed) { changed = true; entry.options.config.providers.gateway.baseURL = 'https://new.invalid/v1' }
  } })
  await h.run()
  assert.deepEqual(urls, ['https://gateway.invalid/v1/models', 'https://new.invalid/v1/models'])
  assert.deepEqual(h.model.input, ['text'])
  assert.equal(h.edits, 1)
})

test('does not resurrect a provider removed before edit', async t => {
  const h = host(t, { beforeEdit: async entry => { delete entry.options.config.providers.gateway } })
  const result = await h.run()
  assert.match(result.text, /provider was removed/)
  assert.equal(h.current.providers.gateway, undefined)
  assert.equal(h.edits, 0)
})

test('scans after a slow startup sync and after manual sync, never before reconciliation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const blocked = deferred()
  const h = host(t, { config: { debug: true, syncOnStart: true }, fetch: () => blocked.promise })
  t.mock.timers.tick(4000)
  assert.equal(h.fetches, 1)
  t.mock.timers.tick(9000)
  assert.equal(h.scans, 0)
  blocked.resolve(response())
  await setImmediate()
  assert.equal(h.scans, 1)
  assert.deepEqual(h.trace, ['edit', 'reconciled', 'scan'])
  await h.run()
  assert.equal(h.scans, 2)
  const report = JSON.parse(readFileSync(h.capabilityFile, 'utf8'))
  assert.deepEqual(report.models[0].inputModalities, ['text', 'image'])
})

test('scan failure is saved without replacing the separate sync report', async t => {
  const h = host(t, { config: { debug: true }, llm: {} })
  await h.run()
  assert.match(JSON.parse(readFileSync(h.capabilityFile, 'utf8')).errors[0], /llm service/)
  const report = JSON.parse(readFileSync(h.debugFile, 'utf8'))
  assert.equal(report.wrote, true)
  assert.equal(report.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
})

test('debug false writes no report and advertises no report path', async t => {
  const h = host(t)
  const result = await h.run()
  assert.doesNotMatch(result.text, /report:/)
  assert.equal(existsSync(h.debugFile), false)
  assert.equal(h.scans, 0)
})

test('reports catalog-only and unmatched model lists as skipped', async t => {
  for (const models of [[], [{ id: 'not-listed' }]]) {
    const h = host(t, { current: configuration({ models }) })
    const result = await h.run()
    assert.match(result.text, /sync skipped/)
    assert.doesNotMatch(result.text, /already up to date/)
    assert.equal(h.edits, 0)
  }
})

test('all-provider failure is never reported as up to date', async t => {
  const h = host(t, { fetch: async () => { throw new Error('offline') } })
  const result = await h.run()
  assert.equal(result.kind, 'error')
  assert.match(result.text, /sync failed/)
  assert.doesNotMatch(result.text, /already up to date/)
})

test('request headers use case-insensitive authorization replacement', async t => {
  const h = host(t, { current: configuration({ apiKeyEnv: 'TEST_KEY', headers: { Authorization: 'old-token', 'X-Custom': 'value' } }), fetch: async (_url, { headers }) => {
    assert.equal(headers.get('authorization'), 'Bearer dummy-test-key')
    assert.equal(headers.get('x-custom'), 'value')
    return response()
  } })
  await h.run()
})

test('HMR exit does not rerun an operation that throws', async t => {
  let exits = 0
  const h = host(t, { hmr: { executing: { exit() { exits++; throw new Error('HMR exit failed') } } } })
  await assert.rejects(h.run(), /HMR exit failed/)
  assert.equal(exits, 1)
  assert.equal(h.fetches, 0)
})

test('leaves an actual AsyncLocalStorage HMR transaction before editing', async t => {
  const executing = new AsyncLocalStorage()
  const h = host(t, { hmr: { executing }, beforeEdit: async () => assert.equal(executing.getStore(), undefined) })
  await executing.run('activation-transaction', async () => {
    assert.equal((await h.run()).kind, 'success')
    assert.equal(executing.getStore(), 'activation-transaction')
  })
  assert.equal(h.edits, 1)
})

test('rejects invalid thinking formats before scheduling any work', t => {
  assert.throws(() => host(t, { config: { thinkingFormat: 'invalid-format' } }), /unsupported thinkingFormat/)
})

test('honors provider selection and the individual capability switches', async t => {
  const current = { providers: { selected: provider(), ignored: provider({ baseURL: 'https://ignored.invalid/v1' }) } }
  const h = host(t, { current, config: { providers: ['selected', 'selected'], syncImages: false } })
  await h.run()
  assert.equal(h.fetches, 1)
  assert.equal(h.current.providers.selected.models[0].input, undefined)
  assert.ok(h.current.providers.selected.models[0].reasoningEfforts)
  assert.deepEqual(h.current.providers.ignored, current.providers.ignored)
  const imagesOnly = host(t, { config: { syncReasoning: false } })
  await imagesOnly.run()
  assert.deepEqual(imagesOnly.model.input, ['text', 'image'])
  assert.equal(imagesOnly.model.reasoningEfforts, undefined)
  assert.equal(imagesOnly.model.compat, undefined)
})

test('accepts models keyed by ID and never adds unconfigured models', async t => {
  const h = host(t, { fetch: async () => new Response(JSON.stringify({ models: { m: { supports_images: true }, extra: wire } })) })
  await h.run()
  assert.equal(h.current.providers.gateway.models.length, 1)
  assert.deepEqual(h.model.input, ['text', 'image'])
})

test('uses the configured timeout signal and isolates an aborted provider', async t => {
  const timeouts = []
  t.mock.method(AbortSignal, 'timeout', ms => { timeouts.push(ms); return AbortSignal.abort(new Error('simulated deadline')) })
  const h = host(t, { config: { requestTimeoutMs: 2500 }, fetch: async (_url, options) => { options.signal.throwIfAborted() } })
  const result = await h.run()
  assert.deepEqual(timeouts, [2500])
  assert.match(result.text, /simulated deadline/)
  assert.equal(h.edits, 0)
})

test('retries nested HMR transaction failures and cleans up pending retries on disposal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(console, 'warn', () => {})
  let attempts = 0
  const h = host(t, { beforeEdit: async () => {
    if (++attempts === 1) throw new Error('HMR transactions cannot be nested')
  } })
  assert.equal((await h.run()).kind, 'error')
  t.mock.timers.tick(8000)
  await setImmediate()
  assert.equal(h.edits, 1)
  assert.equal(h.fetches, 2)
  const cancelled = host(t, { beforeEdit: async () => { throw new Error('HMR transactions cannot be nested') } })
  await cancelled.run()
  cancelled.dispose()
  t.mock.timers.tick(8000)
  await setImmediate()
  assert.equal(cancelled.fetches, 1)
})

test('debounces idle config reload events and removes pending callbacks on disposal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = host(t, { config: { syncOnConfigReload: true } })
  h.reload(); h.reload()
  t.mock.timers.tick(1499)
  assert.equal(h.fetches, 0)
  t.mock.timers.tick(1)
  await setImmediate()
  assert.equal(h.edits, 1)
  h.reload(); h.dispose()
  t.mock.timers.tick(1500)
  await setImmediate()
  assert.equal(h.fetches, 1)
})
