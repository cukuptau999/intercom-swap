import { randomUUID } from 'node:crypto';

import { buildIntercomswapSystemPrompt } from './system.js';
import { INTERCOMSWAP_TOOLS } from './tools.js';
import { OpenAICompatibleClient } from './openaiClient.js';
import { AuditLog } from './audit.js';
import { SecretStore, isSecretHandle } from './secrets.js';

function nowMs() {
  return Date.now();
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (_e) {
    return JSON.stringify({ error: 'unserializable' });
  }
}

function normalizeToolResponseMessage({ toolFormat, toolCall, result }) {
  const content = typeof result === 'string' ? result : safeJsonStringify(result);
  if (toolFormat === 'functions') {
    return { role: 'function', name: toolCall.name, content };
  }
  // tools format
  return {
    role: 'tool',
    tool_call_id: toolCall.id || undefined,
    content,
  };
}

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function safeJsonParse(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, value: null, error: 'empty' };
  try {
    return { ok: true, value: JSON.parse(raw), error: null };
  } catch (err) {
    return { ok: false, value: null, error: err?.message ?? String(err) };
  }
}

function isValidStructuredFinal(value) {
  if (!isObject(value)) return { ok: false, error: 'final must be a JSON object' };
  const type = value.type;
  const text = value.text;
  if (typeof type !== 'string' || !type.trim()) return { ok: false, error: 'final.type must be a non-empty string' };
  if (typeof text !== 'string') return { ok: false, error: 'final.text must be a string' };
  return { ok: true, error: null };
}

function extractJsonObjects(text, { maxObjects = 25, maxChars = 200_000 } = {}) {
  const s = String(text ?? '').slice(0, maxChars);
  const out = [];

  let i = 0;
  while (i < s.length && out.length < maxObjects) {
    // Find next '{'
    while (i < s.length && s[i] !== '{') i += 1;
    if (i >= s.length) break;

    const start = i;
    let depth = 0;
    let inString = false;
    let esc = false;
    let j = i;
    for (; j < s.length; j += 1) {
      const ch = s[j];
      if (inString) {
        if (esc) {
          esc = false;
          continue;
        }
        if (ch === '\\\\') {
          esc = true;
          continue;
        }
        if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') depth += 1;
      if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          j += 1;
          break;
        }
      }
    }

    if (depth !== 0) break; // Unbalanced
    const chunk = s.slice(start, j).trim();
    out.push(chunk);
    i = j;
  }

  return out;
}

function tryParseArgsObject(value) {
  if (value === null || value === undefined) return { ok: true, args: {} };
  if (isObject(value)) return { ok: true, args: value };
  if (typeof value === 'string') {
    const parsed = safeJsonParse(value);
    if (parsed.ok && isObject(parsed.value)) return { ok: true, args: parsed.value };
  }
  return { ok: false, args: null };
}

// Fallback for models/servers that "describe" a tool call instead of returning tool_calls.
function extractToolCallFromText(content, { allowedNames }) {
  const chunks = extractJsonObjects(content);
  const candidates = [];
  for (const chunk of chunks) {
    const parsed = safeJsonParse(chunk);
    if (!parsed.ok) continue;
    const obj = parsed.value;
    if (!isObject(obj)) continue;
    const objType = typeof obj.type === 'string' ? obj.type.trim() : '';
    const toolish =
      !objType ||
      objType === 'tool' ||
      objType === 'tool_call' ||
      objType === 'function' ||
      objType === 'function_call';

    // 1) {"name":"tool","arguments":{...}} (preferred)
    {
      const name = typeof obj.name === 'string' ? obj.name.trim() : '';
      if (name && allowedNames && allowedNames.has(name)) {
        // If the model uses a {type:"..."} envelope, only accept tool calls from type=="tool".
        if (objType && !toolish) {
          // Not a tool call.
        } else if (!('arguments' in obj) && !toolish) {
          // Avoid misinterpreting arbitrary JSON as a tool call.
        } else {
          const r = tryParseArgsObject(obj.arguments);
          if (r.ok) candidates.push({ name, arguments: r.args, argumentsRaw: safeJsonStringify(r.args) });
        }
      }
    }

    // 2) {"tool":"tool","args":{...}}
    {
      const name = typeof obj.tool === 'string' ? obj.tool.trim() : '';
      if (name && allowedNames && allowedNames.has(name)) {
        if (objType && !toolish) {
          // Not a tool call (eg, a tool_result envelope).
        } else if (!('args' in obj) && !toolish) {
          // Avoid treating {"tool":"..."} as a tool call unless it's explicitly type:"tool".
        } else {
          const argValue = 'args' in obj ? obj.args : 'arguments' in obj ? obj.arguments : undefined;
          const r = tryParseArgsObject(argValue);
          if (r.ok) candidates.push({ name, arguments: r.args, argumentsRaw: safeJsonStringify(r.args) });
        }
      }
    }

    // 2b) {"type":"tool_call","tool":{"name":"...","arguments":{...}}} (nested form)
    if (allowedNames && toolish) {
      const inner = isObject(obj.tool) ? obj.tool : isObject(obj.tool_call) ? obj.tool_call : null;
      if (inner) {
        const name = typeof inner.name === 'string' ? inner.name.trim() : '';
        if (name && allowedNames.has(name)) {
          const r = tryParseArgsObject(inner.arguments);
          if (r.ok) candidates.push({ name, arguments: r.args, argumentsRaw: safeJsonStringify(r.args) });
        }
      }
    }

    // 3) {"tool_calls":[{"name":"...","arguments":{...}}, ...]}
    if (Array.isArray(obj.tool_calls) && allowedNames) {
      for (const tc of obj.tool_calls) {
        if (!isObject(tc)) continue;
        const name = typeof tc.name === 'string' ? tc.name.trim() : '';
        if (!name || !allowedNames.has(name)) continue;
        const r = tryParseArgsObject(tc.arguments);
        if (!r.ok) continue;
        candidates.push({ name, arguments: r.args, argumentsRaw: safeJsonStringify(r.args) });
      }
    }

    // 4) {"type":"function","function":{"name":"...","arguments":"{...}"}} (OpenAI-ish)
    if (allowedNames && isObject(obj.function)) {
      const name = typeof obj.function.name === 'string' ? obj.function.name.trim() : '';
      if (name && allowedNames.has(name)) {
        const r = tryParseArgsObject(obj.function.arguments);
        if (r.ok) candidates.push({ name, arguments: r.args, argumentsRaw: safeJsonStringify(r.args) });
      }
    }

    // 5) {"tool_name": {...}} single-key mapping style (common in weaker tool-call models)
    if (allowedNames) {
      const keys = Object.keys(obj);
      if (keys.length === 1) {
        const k = String(keys[0] || '').trim();
        if (k && allowedNames.has(k)) {
          const r = tryParseArgsObject(obj[k]);
          if (r.ok) candidates.push({ name: k, arguments: r.args, argumentsRaw: safeJsonStringify(r.args) });
        }
      }
    }
  }
  if (candidates.length === 0) return null;
  const last = candidates[candidates.length - 1];
  return {
    id: '',
    name: last.name,
    arguments: last.arguments,
    argumentsRaw: last.argumentsRaw || safeJsonStringify(last.arguments),
    parseError: null,
    fromText: true,
  };
}

function shouldSealKey(key) {
  const k = String(key || '').toLowerCase();
  if (k.includes('preimage')) return true;
  if (k.includes('invite')) return true;
  if (k.includes('welcome')) return true;

  // Credentials/secrets.
  if (k.includes('api_key') || k.includes('apikey')) return true;
  if (k.includes('authorization') || k === 'auth') return true;
  if (k.includes('macaroon')) return true;
  if (k.includes('seed')) return true;
  if (k.includes('password')) return true;

  return false;
}

// Ensures tool results sent back to the model do not include secrets.
// Instead, secrets are replaced with opaque handles stored in the session SecretStore.
function sealToolResultForModel(value, secrets, { path = '' } = {}) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();

  if (Array.isArray(value)) {
    return value.map((v, i) => sealToolResultForModel(v, secrets, { path: `${path}[${i}]` }));
  }

  if (isObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const nextPath = path ? `${path}.${k}` : k;
      if (shouldSealKey(k) && v !== null && v !== undefined) {
        // Avoid double-wrapping if tool already returns a handle.
        if (typeof v === 'string' && isSecretHandle(v)) out[k] = v;
        else out[k] = secrets.put(v, { key: k, path: nextPath });
      } else {
        out[k] = sealToolResultForModel(v, secrets, { path: nextPath });
      }
    }
    return out;
  }

  // Fallback: attempt to serialize.
  return safeJsonStringify(value);
}

function messageHasToolCalls(message) {
  if (!message || typeof message !== 'object') return false;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;
  if (message.function_call && typeof message.function_call === 'object') return true;
  return false;
}

export class PromptRouter {
  constructor({
    llmConfig,
    llmClient = null,
    toolExecutor,
    auditDir = 'onchain/prompt/audit',
    maxSteps = 12,
    maxRepairs = 2,
    agentRole = '',
  }) {
    if (!toolExecutor) throw new Error('PromptRouter requires toolExecutor');
    if (!llmConfig || typeof llmConfig !== 'object') throw new Error('PromptRouter requires llmConfig');
    if (!llmConfig.baseUrl) throw new Error('PromptRouter requires llmConfig.baseUrl');
    if (!llmConfig.model) throw new Error('PromptRouter requires llmConfig.model');

    this.toolExecutor = toolExecutor;
    this.auditDir = auditDir;
    this.maxSteps = maxSteps;
    this.maxRepairs = Number.isFinite(maxRepairs) ? Math.max(0, Math.trunc(maxRepairs)) : 2;
    this.agentRole = String(agentRole || '').trim();

    const cfg = llmConfig;
    this.llmConfig = cfg;

    this.llmClient =
      llmClient ||
      new OpenAICompatibleClient({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        defaultModel: cfg.model,
        timeoutMs: cfg.timeoutMs,
        toolFormat: cfg.toolFormat,
      });

    this._sessions = new Map(); // sessionId -> { messages }
  }

  _getSession(sessionId) {
    const id = sessionId || randomUUID();
    if (!this._sessions.has(id)) {
      this._sessions.set(id, {
        messages: [{ role: 'system', content: buildIntercomswapSystemPrompt({ role: this.agentRole }) }],
        secrets: new SecretStore(),
      });
    }
    return { id, session: this._sessions.get(id) };
  }

  async run({
    prompt,
    sessionId = null,
    autoApprove = false,
    dryRun = false,
    maxSteps = null,
  }) {
    const p = String(prompt ?? '').trim();
    if (!p) throw new Error('prompt is required');

    const { id, session } = this._getSession(sessionId);
    const audit = new AuditLog({ dir: this.auditDir, sessionId: id });
    audit.write('prompt', { sessionId: id, prompt: p, autoApprove, dryRun });

    const tools = INTERCOMSWAP_TOOLS;
    const allowedToolNames = new Set(
      tools
        .map((t) => t?.function?.name)
        .filter((n) => typeof n === 'string' && n.trim())
    );
    const toolFormat = this.llmConfig.toolFormat === 'functions' ? 'functions' : 'tools';

    session.messages.push({ role: 'user', content: p });

    const steps = [];
    const max = maxSteps ?? this.maxSteps;
    let repairsUsed = 0;

    for (let i = 0; i < max; i += 1) {
      const startedAt = nowMs();
      const extraBody = {};
      if (this.llmConfig.extraBody && typeof this.llmConfig.extraBody === 'object') {
        Object.assign(extraBody, this.llmConfig.extraBody);
      }
      if (this.llmConfig.responseFormat && typeof this.llmConfig.responseFormat === 'object') {
        // OpenAI-compatible JSON mode / JSON schema mode.
        extraBody.response_format = this.llmConfig.responseFormat;
      }

      const llmOut = await this.llmClient.chatCompletions({
        messages: session.messages,
        tools,
        toolChoice: 'auto',
        maxTokens: this.llmConfig.maxTokens,
        temperature: this.llmConfig.temperature,
        topP: this.llmConfig.topP,
        topK: this.llmConfig.topK,
        minP: this.llmConfig.minP,
        repetitionPenalty: this.llmConfig.repetitionPenalty,
        extraBody: Object.keys(extraBody).length > 0 ? extraBody : null,
      });

      // Some servers/models don't emit tool_calls reliably. If the assistant content contains a
      // structured tool call JSON object ({name,arguments}), treat it as a tool call.
      if ((!Array.isArray(llmOut.toolCalls) || llmOut.toolCalls.length === 0) && llmOut.content) {
        const fallback = extractToolCallFromText(llmOut.content, { allowedNames: allowedToolNames });
        if (fallback) llmOut.toolCalls = [fallback];
      }

      const llmStep = {
        type: 'llm',
        i,
        started_at: startedAt,
        duration_ms: nowMs() - startedAt,
        finish_reason: llmOut.finishReason,
        content: llmOut.content || '',
        tool_calls: llmOut.toolCalls,
      };
      steps.push(llmStep);
      audit.write('llm_response', llmStep);

      // If there are tool calls, execute them, append tool results, and loop.
      if (Array.isArray(llmOut.toolCalls) && llmOut.toolCalls.length > 0) {
        // IMPORTANT: preserve the assistant message that contains tool_calls in the transcript.
        // Many OpenAI-compatible servers expect the exact assistant tool-call message to appear
        // before any subsequent tool results (tool_call_id correlation, etc).
        if (llmOut.message && typeof llmOut.message === 'object' && messageHasToolCalls(llmOut.message)) {
          session.messages.push(llmOut.message);
        }

        for (const call of llmOut.toolCalls) {
          if (!call || typeof call.name !== 'string') {
            throw new Error('Invalid tool call (missing name)');
          }
          if (call.parseError) {
            throw new Error(`Tool call arguments parse error for ${call.name}: ${call.parseError}`);
          }
          if (!call.arguments || typeof call.arguments !== 'object') {
            throw new Error(`Tool call missing arguments for ${call.name}`);
          }

          const toolStartedAt = nowMs();
          audit.write('tool_call', { name: call.name, arguments: call.arguments, dryRun, autoApprove });
          const toolResult = await this.toolExecutor.execute(call.name, call.arguments, {
            autoApprove,
            dryRun,
            secrets: session.secrets,
          });
          const toolResultForModel = sealToolResultForModel(toolResult, session.secrets);
          const toolStep = {
            type: 'tool',
            name: call.name,
            arguments: call.arguments,
            started_at: toolStartedAt,
            duration_ms: nowMs() - toolStartedAt,
            result: toolResultForModel,
          };
          steps.push(toolStep);
          audit.write('tool_result', toolStep);

          // Append tool result as a message so the model can continue.
          session.messages.push(normalizeToolResponseMessage({ toolFormat, toolCall: call, result: toolResultForModel }));
        }
        continue;
      }

      // Otherwise, we have a final assistant message.
      const rawFinal = llmOut.content || '';
      const parsed = safeJsonParse(rawFinal);
      const shape = parsed.ok ? isValidStructuredFinal(parsed.value) : { ok: false, error: parsed.error };
      const contentJson = parsed.ok && shape.ok ? parsed.value : { type: 'message', text: rawFinal.trim() };

      // If the model returned an invalid structured output (eg, a plan JSON object) and did not
      // emit a tool call, ask it to re-emit valid JSON. This is the main guardrail that makes
      // "forced structured output" usable with weaker models.
      if ((!parsed.ok || !shape.ok) && repairsUsed < this.maxRepairs) {
        repairsUsed += 1;
        audit.write('repair', {
          i,
          repairs_used: repairsUsed,
          parsed_ok: Boolean(parsed.ok),
          structured_ok: Boolean(parsed.ok && shape.ok),
          structured_error: parsed.ok && !shape.ok ? shape.error : parsed.ok ? null : parsed.error,
        });
        session.messages.push({
          role: 'user',
          content:
            'INVALID_OUTPUT. Output ONLY one of:\n' +
            '1) Tool call JSON: {"type":"tool","name":"<tool_name>","arguments":{...}}\n' +
            '2) Final message JSON: {"type":"message","text":"..."}\n' +
            'Do NOT output plans or any other keys. Re-emit now.',
        });
        continue;
      }

      if (llmOut.message && typeof llmOut.message === 'object') session.messages.push(llmOut.message);
      audit.write('final', {
        content: rawFinal,
        structured_ok: Boolean(parsed.ok && shape.ok),
        structured_error: parsed.ok && !shape.ok ? shape.error : parsed.ok ? null : parsed.error,
        content_json: contentJson,
      });
      return { session_id: id, content: rawFinal, content_json: contentJson, steps };
    }

    throw new Error(`Max steps exceeded (${max})`);
  }
}
