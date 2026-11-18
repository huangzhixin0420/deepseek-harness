/**
 * Acceptance fixture for the Windows custom-core overwrite install.
 *
 * The isolated runner copies this package into the Desktop profile's plugin
 * directory and enables it through the profile patch layer. On load it
 * registers one Host-global inherited tool and one scope-owned tool behind an
 * `includeOwn` allow-list, then reports what the installed core did: whether
 * the own registration exists in the catalog, whether it is projected as
 * visible, and whether a call to it is admitted. Bare `rc3` admits the call;
 * the unified core rejects it.
 *
 * It also creates or resumes one real Session through the installed core, which
 * is the recognisable data the overwrite install must preserve.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Tool the fixture registers inside its own scope. */
const OWN_TOOL = 'fixture_unified_own_tool'
/** Host-global tool inherited by the scope and named by its allow-list. */
const INHERITED_TOOL = 'fixture_unified_inherited_tool'
const OWN_TOOL_REPLY = 'fixture-own-tool-ran'

export const name = 'fixture-unified-own-tool'
export const inject = ['tools']

/** Resolve how this load should behave from the acceptance runner's environment. */
function runOptions() {
  const report = process.env['DSH_FIXTURE_OWN_TOOL_REPORT']
  if (report === undefined || report === '') return undefined
  return {
    report,
    mode: process.env['DSH_FIXTURE_OWN_TOOL_MODE'] === 'seed' ? 'seed' : 'observe',
    sessionId: process.env['DSH_FIXTURE_OWN_TOOL_SESSION'] ?? '',
  }
}

/** Describe one settled execution without leaking tool bodies. */
function describeExecution(result) {
  const text = result.content
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('')
  return {
    isError: result.isError === true,
    code: result.error?.info?.code ?? null,
    text,
  }
}

/** Call the fixture's own tool through the installed registry and executor. */
async function executeOwnTool(ctx, key) {
  const controller = new AbortController()
  const timeout = setTimeout(() => { controller.abort() }, 60_000)
  try {
    const batch = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: 'fixture-unified-own-tool-call', name: OWN_TOOL, arguments: '{}' }],
      signal: controller.signal,
      agent: key,
    })
    const settled = batch.results[0]
    if (settled === undefined) return { isError: true, code: 'FIXTURE_NO_RESULT', text: '' }
    return describeExecution(settled.result)
  } finally {
    clearTimeout(timeout)
  }
}

/** Create the session the baseline must produce, or resume it on the overwritten installation. */
async function touchSession(ctx, options) {
  // The agents service is the core's own session boundary; absent in compositions that expose none.
  const agents = ctx.get('agents')
  if (agents === undefined) return { mode: options.mode, id: options.sessionId, error: 'the composition exposes no agents service' }
  const sessionId = options.mode === 'seed' && options.sessionId === '' ? randomUUID() : options.sessionId
  const handle = options.mode === 'seed'
    ? await agents.create({ sessionId, meta: { cwd: process.cwd() } })
    : await agents.resume({ resumeSessionId: sessionId })
  await handle.dispose()
  return { mode: options.mode, id: sessionId }
}

/** Write the observation so the acceptance script never reads a half-written file. */
function writeReport(path, report) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.partial`
  writeFileSync(temporary, `${JSON.stringify(report, undefined, 2)}\n`)
  renameSync(temporary, path)
}

/** Observe one installation and report what it did. */
async function observe(ctx, options) {
  const report = {
    fixture: name,
    mode: options.mode,
    ownTool: OWN_TOOL,
    allowedInheritedTool: INHERITED_TOOL,
    host: { loadedFixture: true, bootedProfile: true },
    inheritedToolPresent: false,
    registered: false,
    catalog: [],
    projection: [],
    projectionListsOwnTool: null,
    restrictAccepted: false,
    execution: undefined,
    session: undefined,
    error: null,
  }
  let liftRestriction
  let scope
  let disposeInherited
  try {
    disposeInherited = ctx.tools.register({
      name: INHERITED_TOOL,
      description: 'Acceptance fixture tool inherited by one agent-like scope.',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: () => Promise.resolve('fixture-inherited-tool-ran'),
    })
    report.inheritedToolPresent = ctx.tools.get(INHERITED_TOOL) !== undefined
    if (!report.inheritedToolPresent) throw new Error(`the fixture could not register the inherited tool "${INHERITED_TOOL}"`)
    // Resolved through the installation's profile resolution; a failure is reported, not swallowed by the loader.
    const { createScope } = await import('@deepseek-ai/dsh-scope')
    const key = { id: 'fixture-unified-own-tool' }
    scope = createScope(ctx, key)
    scope.ctx.tools.register({
      name: OWN_TOOL,
      description: 'Acceptance fixture tool registered inside one agent-like scope.',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: () => Promise.resolve(OWN_TOOL_REPLY),
    })
    liftRestriction = scope.ctx.tools.restrict({ allow: [INHERITED_TOOL], includeOwn: true })
    report.restrictAccepted = true
    report.catalog = ctx.tools.catalog(key).map(tool => tool.name).sort()
    report.projection = ctx.tools.schemas(key).map(tool => tool.name).sort()
    report.registered = report.catalog.includes(OWN_TOOL)
    report.projectionListsOwnTool = report.projection.includes(OWN_TOOL)
    report.execution = await executeOwnTool(ctx, key)
    try {
      report.session = await touchSession(ctx, options)
    } catch (error) {
      report.session = { mode: options.mode, error: String(error) }
    }
  } catch (error) {
    report.error = String(error)
  } finally {
    if (liftRestriction !== undefined) liftRestriction()
    if (scope !== undefined) await scope.dispose()
    if (disposeInherited !== undefined) disposeInherited()
  }
  writeReport(options.report, report)
}

/** Cordis entry point: inert unless the acceptance runner asked for a report. */
export function apply(ctx) {
  const options = runOptions()
  if (options === undefined) return
  void observe(ctx, options).catch((error) => {
    writeReport(options.report, {
      fixture: name,
      mode: options.mode,
      ownTool: OWN_TOOL,
      allowedInheritedTool: INHERITED_TOOL,
      error: String(error),
    })
  })
}
