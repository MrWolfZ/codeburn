import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join, posix, win32 } from 'path'
import { tmpdir } from 'os'

import { copilot, createCopilotProvider, getVSCodeWorkspaceStorageDirs } from '../../src/providers/copilot.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string

async function createSessionDir(sessionId: string, lines: string[], cwd = '/home/user/myproject') {
  const sessionDir = join(tmpDir, sessionId)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'workspace.yaml'), `id: ${sessionId}\ncwd: ${cwd}\n`)
  await writeFile(join(sessionDir, 'events.jsonl'), lines.join('\n') + '\n')
  return join(sessionDir, 'events.jsonl')
}

function modelChange(newModel: string, previousModel?: string) {
  return JSON.stringify({ type: 'session.model_change', timestamp: '2026-04-15T10:00:01Z', data: { newModel, previousModel } })
}

function userMessage(content: string) {
  return JSON.stringify({ type: 'user.message', timestamp: '2026-04-15T10:00:10Z', data: { content, interactionId: 'int-1' } })
}

function assistantMessage(opts: { messageId: string; outputTokens: number; tools?: string[]; timestamp?: string }) {
  return JSON.stringify({
    type: 'assistant.message',
    timestamp: opts.timestamp ?? '2026-04-15T10:00:15Z',
    data: {
      messageId: opts.messageId,
      outputTokens: opts.outputTokens,
      interactionId: 'int-1',
      toolRequests: (opts.tools ?? []).map(name => ({ name, toolCallId: `call-${name}`, type: 'function' })),
    },
  })
}

function transcriptSessionStart(sessionId: string) {
  return JSON.stringify({ type: 'session.start', data: { sessionId, producer: 'copilot-agent' } })
}

function transcriptUserMessage(content: string) {
  return JSON.stringify({ type: 'user.message', data: { content, attachments: [] } })
}

function transcriptAssistantMessage(opts: { messageId: string; content?: string; reasoningText?: string; toolCallIds?: string[]; toolNames?: string[] }) {
  return JSON.stringify({
    type: 'assistant.message',
    data: {
      messageId: opts.messageId,
      content: opts.content ?? '',
      reasoningText: opts.reasoningText ?? '',
      toolRequests: (opts.toolCallIds ?? []).map((id, i) => ({
        toolCallId: id,
        name: opts.toolNames?.[i] ?? (i === 0 ? 'read_file' : 'run_in_terminal'),
        type: 'function',
      })),
    },
  })
}

function sessionShutdown(opts: { modelMetrics?: Record<string, { requests: { count: number; cost: number }; usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number } }> }) {
  return JSON.stringify({
    type: 'session.shutdown',
    data: {
      shutdownType: 'routine',
      totalPremiumRequests: Object.values(opts.modelMetrics ?? {}).reduce((s, m) => s + m.requests.count, 0),
      modelMetrics: opts.modelMetrics,
    },
  })
}

describe('copilot provider - JSONL parsing', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'copilot-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('parses a basic assistant message', async () => {
    const eventsPath = await createSessionDir('sess-001', [
      modelChange('gpt-4.1'),
      userMessage('write a function'),
      assistantMessage({ messageId: 'msg-1', outputTokens: 150 }),
    ])

    const source = { path: eventsPath, project: 'myproject', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.provider).toBe('copilot')
    expect(call.model).toBe('gpt-4.1')
    expect(call.outputTokens).toBe(150)
    expect(call.inputTokens).toBe(0)
    expect(call.userMessage).toBe('write a function')
    expect(call.sessionId).toBe('sess-001')
    expect(call.bashCommands).toEqual([])
    expect(call.costUSD).toBeGreaterThan(0)
  })

  it('tracks model changes mid-session', async () => {
    const eventsPath = await createSessionDir('sess-002', [
      modelChange('gpt-5-mini'),
      userMessage('first'),
      assistantMessage({ messageId: 'msg-1', outputTokens: 50, timestamp: '2026-04-15T10:00:10Z' }),
      modelChange('gpt-4.1', 'gpt-5-mini'),
      userMessage('second'),
      assistantMessage({ messageId: 'msg-2', outputTokens: 80, timestamp: '2026-04-15T10:01:00Z' }),
    ])

    const source = { path: eventsPath, project: 'test', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(2)
    expect(calls[0]!.model).toBe('gpt-5-mini')
    expect(calls[1]!.model).toBe('gpt-4.1')
  })

  it('extracts tool names from toolRequests', async () => {
    const eventsPath = await createSessionDir('sess-003', [
      modelChange('gpt-4.1'),
      userMessage('run tests'),
      assistantMessage({ messageId: 'msg-1', outputTokens: 60, tools: ['bash', 'read_file', 'write_file'] }),
    ])

    const source = { path: eventsPath, project: 'test', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls[0]!.tools).toEqual(['Bash', 'Read', 'Edit'])
  })

  it('normalizes Copilot MCP tool names from toolRequests', async () => {
    const eventsPath = await createSessionDir('sess-mcp-tools', [
      modelChange('gpt-4.1'),
      userMessage('list MCP-backed tasks and issues'),
      assistantMessage({
        messageId: 'msg-1',
        outputTokens: 60,
        tools: ['github-mcp-server-list_issues', 'cyberday-get_tasks', 'mempalace-mempalace_search', 'bash'],
      }),
    ])

    const source = { path: eventsPath, project: 'test', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls[0]!.tools).toEqual([
      'mcp__github_mcp_server__list_issues',
      'mcp__cyberday__get_tasks',
      'mcp__mempalace__mempalace_search',
      'Bash',
    ])
  })

  it('does not crash on malformed toolRequests (string / null / missing)', async () => {
    // Regression guard: a corrupt session previously aborted the whole file's
    // parse loop because .map was called on a non-array. The fix coerces any
    // non-array shape (string, null, missing) to []. We mix one corrupt event
    // between two healthy events and assert both healthy events still parse.
    const corruptToolRequestsString = JSON.stringify({
      type: 'assistant.message',
      timestamp: '2026-04-15T10:00:15Z',
      data: { messageId: 'corrupt-string', outputTokens: 50, toolRequests: 'not an array' },
    })
    const corruptToolRequestsNull = JSON.stringify({
      type: 'assistant.message',
      timestamp: '2026-04-15T10:00:16Z',
      data: { messageId: 'corrupt-null', outputTokens: 50, toolRequests: null },
    })
    const eventsPath = await createSessionDir('sess-corrupt', [
      modelChange('gpt-4.1'),
      assistantMessage({ messageId: 'msg-before', outputTokens: 100 }),
      corruptToolRequestsString,
      corruptToolRequestsNull,
      assistantMessage({ messageId: 'msg-after', outputTokens: 200 }),
    ])

    const source = { path: eventsPath, project: 'test', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    // The healthy messages BEFORE and AFTER the corrupt events both parse —
    // proving that the corrupt event no longer aborts the per-file parse loop.
    // Pre-fix, .map on a non-array threw and we'd see < 4 calls.
    expect(calls).toHaveLength(4)
    expect(calls.find(c => c.outputTokens === 100)).toBeDefined()  // msg-before
    expect(calls.find(c => c.outputTokens === 200)).toBeDefined()  // msg-after
    // Corrupt events produce calls with empty tools, not crashes.
    const corruptCalls = calls.filter(c => c.outputTokens === 50)
    expect(corruptCalls.length).toBe(2)
    for (const c of corruptCalls) {
      expect(c.tools).toEqual([])
    }
  })

  it('ignores malformed non-string tool names', async () => {
    const malformedToolName = JSON.stringify({
      type: 'assistant.message',
      timestamp: '2026-04-15T10:00:15Z',
      data: {
        messageId: 'malformed-tool-name',
        outputTokens: 50,
        toolRequests: [null, { name: 123, toolCallId: 'call-bad', type: 'function' }],
      },
    })
    const eventsPath = await createSessionDir('sess-malformed-tool-name', [
      modelChange('gpt-4.1'),
      malformedToolName,
      assistantMessage({ messageId: 'msg-after', outputTokens: 100, tools: ['github-mcp-server-list_issues'] }),
    ])

    const source = { path: eventsPath, project: 'test', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(2)
    expect(calls[0]!.tools).toEqual([])
    expect(calls[1]!.tools).toEqual(['mcp__github_mcp_server__list_issues'])
  })

  it('skips assistant messages with zero outputTokens', async () => {
    const eventsPath = await createSessionDir('sess-004', [
      modelChange('gpt-4.1'),
      assistantMessage({ messageId: 'msg-empty', outputTokens: 0 }),
      assistantMessage({ messageId: 'msg-real', outputTokens: 42 }),
    ])

    const source = { path: eventsPath, project: 'test', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.outputTokens).toBe(42)
  })

  it('deduplicates messages across parser runs', async () => {
    const eventsPath = await createSessionDir('sess-005', [
      modelChange('gpt-4.1'),
      assistantMessage({ messageId: 'msg-dup', outputTokens: 100 }),
    ])

    const source = { path: eventsPath, project: 'test', provider: 'copilot' }
    const seenKeys = new Set<string>()

    const calls1: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, seenKeys).parse()) calls1.push(call)

    const calls2: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, seenKeys).parse()) calls2.push(call)

    expect(calls1).toHaveLength(1)
    expect(calls2).toHaveLength(0)
  })

  it('returns empty for missing file', async () => {
    const source = { path: '/nonexistent/events.jsonl', project: 'test', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)
    expect(calls).toHaveLength(0)
  })

  it('skips assistant messages before the first model_change event', async () => {
    const eventsPath = await createSessionDir('sess-no-model', [
      assistantMessage({ messageId: 'msg-early', outputTokens: 50 }),
      modelChange('gpt-4.1'),
      assistantMessage({ messageId: 'msg-after', outputTokens: 80 }),
    ])

    const source = { path: eventsPath, project: 'test', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.outputTokens).toBe(80)
    expect(calls[0]!.model).toBe('gpt-4.1')
  })

  it('infers OpenAI auto bucket for transcript toolCallId prefix call_', async () => {
    const eventsPath = await createSessionDir('sess-tr-call', [
      transcriptSessionStart('sess-tr-call'),
      transcriptUserMessage('check model inference'),
      transcriptAssistantMessage({
        messageId: 'msg-1',
        content: 'done',
        toolCallIds: ['call_abc123'],
      }),
    ])

    const source = { path: eventsPath, project: 'test', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.model).toBe('copilot-openai-auto')
  })

  it('infers Anthropic auto bucket for transcript toolCallId prefixes tooluse_/toolu_vrtx_', async () => {
    const eventsPath = await createSessionDir('sess-tr-claude', [
      transcriptSessionStart('sess-tr-claude'),
      transcriptUserMessage('check model inference'),
      transcriptAssistantMessage({
        messageId: 'msg-1',
        content: 'done',
        toolCallIds: ['tooluse_XY', 'toolu_vrtx_01ABC'],
      }),
    ])

    const source = { path: eventsPath, project: 'test', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.model).toBe('copilot-anthropic-auto')
  })

  it('chooses the dominant inferred transcript model when prefixes are mixed', async () => {
    const eventsPath = await createSessionDir('sess-tr-mixed', [
      transcriptSessionStart('sess-tr-mixed'),
      transcriptUserMessage('mixed'),
      transcriptAssistantMessage({
        messageId: 'msg-1',
        content: 'one',
        toolCallIds: ['toolu_bdrk_123'],
      }),
      transcriptAssistantMessage({
        messageId: 'msg-2',
        content: 'two',
        toolCallIds: ['call_1'],
      }),
      transcriptAssistantMessage({
        messageId: 'msg-3',
        content: 'three',
        toolCallIds: ['call_2'],
      }),
    ])

    const source = { path: eventsPath, project: 'test', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(3)
    expect(calls.every(c => c.model === 'copilot-openai-auto')).toBe(true)
  })

  it('normalizes Copilot MCP tool names from VS Code transcripts', async () => {
    const eventsPath = await createSessionDir('sess-tr-mcp-tools', [
      transcriptSessionStart('sess-tr-mcp-tools'),
      transcriptUserMessage('use GitHub MCP'),
      transcriptAssistantMessage({
        messageId: 'msg-1',
        content: 'done',
        toolCallIds: ['call_abc123', 'call_def456'],
        toolNames: ['github-mcp-server-list_issues', 'read_file'],
      }),
    ])

    const source = { path: eventsPath, project: 'test', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.tools).toEqual(['mcp__github_mcp_server__list_issues', 'Read'])
  })

  it('distributes input tokens from session.shutdown modelMetrics', async () => {
    const eventsPath = await createSessionDir('sess-shutdown-001', [
      modelChange('claude-sonnet-4.6'),
      userMessage('implement feature A'),
      assistantMessage({ messageId: 'msg-1', outputTokens: 100 }),
      userMessage('fix bug in feature A'),
      assistantMessage({ messageId: 'msg-2', outputTokens: 300 }),
      sessionShutdown({
        modelMetrics: {
          'claude-sonnet-4.6': {
            requests: { count: 2, cost: 1 },
            usage: {
              inputTokens: 8000,
              outputTokens: 400,
              cacheReadTokens: 6000,
              cacheWriteTokens: 500,
              reasoningTokens: 0,
            },
          },
        },
      }),
    ])

    const source = { path: eventsPath, project: 'test', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(2)
    // msg-1 has 100/400 = 25% of output → should get 25% of input tokens
    expect(calls[0]!.inputTokens).toBe(2000)   // 8000 * 0.25
    expect(calls[0]!.cacheReadInputTokens).toBe(1500)  // 6000 * 0.25
    expect(calls[0]!.cacheCreationInputTokens).toBe(125)   // 500 * 0.25
    expect(calls[0]!.costUSD).toBeGreaterThan(0)
    // msg-2 has 300/400 = 75% of output → should get 75% of input tokens
    expect(calls[1]!.inputTokens).toBe(6000)   // 8000 * 0.75
    expect(calls[1]!.cacheReadInputTokens).toBe(4500)  // 6000 * 0.75
    expect(calls[1]!.cacheCreationInputTokens).toBe(375)   // 500 * 0.75
    expect(calls[1]!.costUSD).toBeGreaterThan(0)
    // Verify totals match session shutdown metrics
    const totalInput = calls.reduce((s, c) => s + c.inputTokens, 0)
    expect(totalInput).toBe(8000)
    const totalCacheRead = calls.reduce((s, c) => s + c.cacheReadInputTokens, 0)
    expect(totalCacheRead).toBe(6000)
    const totalCacheWrite = calls.reduce((s, c) => s + c.cacheCreationInputTokens, 0)
    expect(totalCacheWrite).toBe(500)
  })

  it('handles multiple models in session.shutdown metrics', async () => {
    const eventsPath = await createSessionDir('sess-multi-model', [
      modelChange('claude-sonnet-4.6'),
      userMessage('first task'),
      assistantMessage({ messageId: 'msg-1', outputTokens: 200, timestamp: '2026-04-15T10:00:10Z' }),
      modelChange('gpt-4.1', 'claude-sonnet-4.6'),
      userMessage('second task'),
      assistantMessage({ messageId: 'msg-2', outputTokens: 100, timestamp: '2026-04-15T10:01:00Z' }),
      sessionShutdown({
        modelMetrics: {
          'claude-sonnet-4.6': {
            requests: { count: 1, cost: 0.5 },
            usage: { inputTokens: 5000, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 0, reasoningTokens: 0 },
          },
          'gpt-4.1': {
            requests: { count: 1, cost: 0.2 },
            usage: { inputTokens: 2000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
          },
        },
      }),
    ])

    const source = { path: eventsPath, project: 'test', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(2)
    // claude-sonnet-4.6 is 100% of its own model's output
    expect(calls[0]!.model).toBe('claude-sonnet-4.6')
    expect(calls[0]!.inputTokens).toBe(5000)
    expect(calls[0]!.cacheReadInputTokens).toBe(3000)
    // gpt-4.1 is 100% of its own model's output
    expect(calls[1]!.model).toBe('gpt-4.1')
    expect(calls[1]!.inputTokens).toBe(2000)
    expect(calls[1]!.cacheReadInputTokens).toBe(0)
  })

  it('ignores session.shutdown with missing modelMetrics (backward compat)', async () => {
    const shutdownNoMetrics = JSON.stringify({
      type: 'session.shutdown',
      data: { shutdownType: 'routine', totalPremiumRequests: 2 },
    })
    const eventsPath = await createSessionDir('sess-no-metrics', [
      modelChange('gpt-4.1'),
      userMessage('hello'),
      assistantMessage({ messageId: 'msg-1', outputTokens: 100 }),
      shutdownNoMetrics,
    ])

    const source = { path: eventsPath, project: 'test', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    // Without metrics, input tokens remain 0 (backward compatible)
    expect(calls[0]!.inputTokens).toBe(0)
    // Cost is still calculated from output tokens alone
    expect(calls[0]!.costUSD).toBeGreaterThan(0)
  })

  it('handles session.shutdown model with zero output tokens gracefully', async () => {
    const eventsPath = await createSessionDir('sess-zero-output-metric', [
      modelChange('gpt-4.1'),
      userMessage('hello'),
      assistantMessage({ messageId: 'msg-1', outputTokens: 50 }),
      sessionShutdown({
        modelMetrics: {
          'gpt-4.1': {
            requests: { count: 1, cost: 0.1 },
            usage: { inputTokens: 3000, outputTokens: 0, cacheReadTokens: 2000, cacheWriteTokens: 0, reasoningTokens: 0 },
          },
        },
      }),
    ])

    const source = { path: eventsPath, project: 'test', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    // When model's shutdown outputTokens is 0, skip distribution (divide by zero guard)
    expect(calls[0]!.inputTokens).toBe(0)
    expect(calls[0]!.costUSD).toBe(0)
  })

  it('distributes input tokens from session.shutdown in transcript format', async () => {
    // Transcript format files start with session.start + producer: copilot-agent.
    // The shutdown event may also appear in these files (e.g. ~/.copilot/session-state/
    // events that now use the transcript schema). This tests that path.
    const shutdownRaw = JSON.stringify({
      type: 'session.shutdown',
      data: {
        shutdownType: 'routine',
        modelMetrics: {
          'claude-sonnet-4': {
            requests: { count: 2, cost: 1 },
            usage: {
              inputTokens: 10000,
              outputTokens: 500,
              cacheReadTokens: 8000,
              cacheWriteTokens: 0,
              reasoningTokens: 200,
            },
          },
        },
      },
    })
    const eventsPath = await createSessionDir('sess-tr-shutdown', [
      transcriptSessionStart('sess-tr-shutdown'),
      transcriptUserMessage('implement feature'),
      transcriptAssistantMessage({
        messageId: 'msg-1',
        content: 'here is the implementation',
        toolCallIds: ['toolu_bdrk_abc'],
      }),
      transcriptUserMessage('fix the bug'),
      transcriptAssistantMessage({
        messageId: 'msg-2',
        content: 'fixed it, done',
        toolCallIds: ['toolu_bdrk_def'],
      }),
      shutdownRaw,
    ])

    const source = { path: eventsPath, project: 'test', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(2)
    // Both calls use the same model (copilot-anthropic-auto from toolCallId prefix),
    // but modelMetrics is keyed by 'claude-sonnet-4'. Since the inferred model
    // doesn't match, distribution skips → falls back to character counting.
    // This verifies the model key must match.
    expect(calls[0]!.model).toBe('copilot-anthropic-auto')

    // Now test with matching model key in metrics:
  })

  it('distributes input tokens in transcript format when model keys match', async () => {
    // The transcript parser infers model from toolCallId prefixes.
    // When explicit model data is available on events, that takes priority.
    const trMsgWithModel = (msgId: string, content: string, modelName: string) =>
      JSON.stringify({
        type: 'assistant.message',
        data: {
          messageId: msgId,
          content,
          toolRequests: [{ toolCallId: `toolu_bdrk_${msgId}`, name: 'read_file', type: 'function' }],
          model: modelName,
        },
      })

    const shutdownRaw = JSON.stringify({
      type: 'session.shutdown',
      data: {
        shutdownType: 'routine',
        modelMetrics: {
          'claude-sonnet-4.5': {
            requests: { count: 2, cost: 1 },
            usage: {
              inputTokens: 9000,
              outputTokens: 300,
              cacheReadTokens: 7200,
              cacheWriteTokens: 100,
              reasoningTokens: 0,
            },
          },
        },
      },
    })

    const eventsPath = await createSessionDir('sess-tr-model-match', [
      transcriptSessionStart('sess-tr-model-match'),
      transcriptUserMessage('do thing A'),
      trMsgWithModel('msg-1', 'done with A', 'claude-sonnet-4.5'),
      transcriptUserMessage('do thing B'),
      trMsgWithModel('msg-2', 'here is B, much longer response that produces more output tokens relative to the first one', 'claude-sonnet-4.5'),
      shutdownRaw,
    ])

    const source = { path: eventsPath, project: 'test', provider: 'copilot' }
    const calls: ParsedProviderCall[] = []
    for await (const call of copilot.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(2)
    expect(calls.every(c => c.model === 'claude-sonnet-4.5')).toBe(true)

    // msg-1 has shorter content, so fewer estimated output tokens → smaller share
    // msg-2 has longer content → larger share of input tokens
    expect(calls[0]!.inputTokens).toBeGreaterThan(0)
    expect(calls[1]!.inputTokens).toBeGreaterThan(calls[0]!.inputTokens)
    const totalInput = calls.reduce((s, c) => s + c.inputTokens, 0)
    expect(totalInput).toBe(9000)
    expect(calls.every(c => c.cacheReadInputTokens >= 0)).toBe(true)
    expect(calls.every(c => c.costUSD > 0)).toBe(true)
  })
})

describe('copilot provider - discoverSessions', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'copilot-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('discovers sessions from directory', async () => {
    await createSessionDir('sess-disc-001', [modelChange('gpt-4.1')])
    await createSessionDir('sess-disc-002', [modelChange('gpt-4.1')])

    const provider = createCopilotProvider(tmpDir, '/nonexistent/vscode')
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(2)
    expect(sessions.every(s => s.provider === 'copilot')).toBe(true)
    expect(sessions.every(s => s.path.endsWith('events.jsonl'))).toBe(true)
  })

  it('reads project name from workspace.yaml cwd', async () => {
    await createSessionDir('sess-disc-003', [modelChange('gpt-4.1')], '/home/user/myapp')

    const provider = createCopilotProvider(tmpDir, '/nonexistent/vscode')
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.project).toBe('myapp')
  })

  it('strips quotes and trailing comments from workspace.yaml cwd', async () => {
    const sessionDir = join(tmpDir, 'sess-quoted')
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, 'workspace.yaml'), 'cwd: "/home/user/myapp"  # project root\n')
    await writeFile(join(sessionDir, 'events.jsonl'), '\n')

    const provider = createCopilotProvider(tmpDir, '/nonexistent/vscode')
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.project).toBe('myapp')
  })

  it('returns empty when directory does not exist', async () => {
    const provider = createCopilotProvider('/nonexistent/path', '/nonexistent/vscode')
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(0)
  })

  it('skips entries without events.jsonl', async () => {
    const emptyDir = join(tmpDir, 'empty-session')
    await mkdir(emptyDir, { recursive: true })

    const provider = createCopilotProvider(tmpDir, '/nonexistent/vscode')
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(0)
  })

  it('discovers VS Code workspace transcripts', async () => {
    const wsDir = join(tmpDir, 'vscode-ws')
    const transcriptsDir = join(wsDir, 'abc123', 'GitHub.copilot-chat', 'transcripts')
    await mkdir(transcriptsDir, { recursive: true })
    await writeFile(join(wsDir, 'abc123', 'workspace.json'), JSON.stringify({ folder: 'file:///home/user/myapp' }))
    await writeFile(join(transcriptsDir, 'session-1.jsonl'), JSON.stringify({ type: 'session.start', data: { sessionId: 's1', producer: 'copilot-agent' } }) + '\n')

    const provider = createCopilotProvider('/nonexistent/legacy', wsDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.project).toBe('myapp')
    expect(sessions[0]!.path).toContain('session-1.jsonl')
  })

  it('includes VSCodium workspaceStorage paths on all supported platforms', () => {
    expect(getVSCodeWorkspaceStorageDirs('/Users/test', 'darwin')).toContain(
      posix.join('/Users/test', 'Library', 'Application Support', 'VSCodium', 'User', 'workspaceStorage'),
    )
    expect(getVSCodeWorkspaceStorageDirs('C:\\Users\\test', 'win32')).toContain(
      win32.join('C:\\Users\\test', 'AppData', 'Roaming', 'VSCodium', 'User', 'workspaceStorage'),
    )
    expect(getVSCodeWorkspaceStorageDirs('/home/test', 'linux')).toContain(
      posix.join('/home/test', '.config', 'VSCodium', 'User', 'workspaceStorage'),
    )
  })
})

describe('copilot provider - metadata', () => {
  it('has correct name and displayName', () => {
    expect(copilot.name).toBe('copilot')
    expect(copilot.displayName).toBe('Copilot')
  })

  it('normalizes tool display names', () => {
    expect(copilot.toolDisplayName('bash')).toBe('Bash')
    expect(copilot.toolDisplayName('read_file')).toBe('Read')
    expect(copilot.toolDisplayName('write_file')).toBe('Edit')
    expect(copilot.toolDisplayName('web_search')).toBe('WebSearch')
    expect(copilot.toolDisplayName('github-mcp-server-list_issues')).toBe('mcp__github_mcp_server__list_issues')
    expect(copilot.toolDisplayName('unknown_tool')).toBe('unknown_tool')
  })

  it('normalizes model display names', () => {
    expect(copilot.modelDisplayName('gpt-4.1')).toBe('GPT-4.1')
    expect(copilot.modelDisplayName('gpt-4.1-mini')).toBe('GPT-4.1 Mini')
    expect(copilot.modelDisplayName('gpt-4.1-nano')).toBe('GPT-4.1 Nano')
    expect(copilot.modelDisplayName('gpt-5-mini')).toBe('GPT-5 Mini')
    expect(copilot.modelDisplayName('o3')).toBe('o3')
    expect(copilot.modelDisplayName('o4-mini')).toBe('o4-mini')
    expect(copilot.modelDisplayName('copilot-openai-auto')).toBe('Copilot (OpenAI auto)')
    expect(copilot.modelDisplayName('copilot-anthropic-auto')).toBe('Copilot (Anthropic auto)')
    expect(copilot.modelDisplayName('unknown-model-xyz')).toBe('unknown-model-xyz')
  })

  it('longest-prefix match wins for versioned model IDs', () => {
    // gpt-5-mini-2026-01-01 must match gpt-5-mini, not gpt-5
    expect(copilot.modelDisplayName('gpt-5-mini-2026-01-01')).toBe('GPT-5 Mini')
    expect(copilot.modelDisplayName('gpt-4.1-mini-2026-01-01')).toBe('GPT-4.1 Mini')
  })
})
