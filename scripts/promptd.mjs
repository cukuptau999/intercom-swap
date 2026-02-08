#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { PromptRouter } from '../src/prompt/router.js';
import { ToolExecutor } from '../src/prompt/executor.js';
import { DEFAULT_PROMPT_SETUP_PATH, loadPromptSetupFromFile } from '../src/prompt/config.js';
import { INTERCOMSWAP_TOOLS } from '../src/prompt/tools.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function usage() {
  return `
promptd (local prompting router + tool executor)

Starts a local HTTP server that:
- calls an OpenAI-compatible LLM API
- executes tool calls via deterministic tooling / SC-Bridge safe RPCs
- writes an audit trail (jsonl) under onchain/

Setup JSON (gitignored):
  --config <path>   (default: ${DEFAULT_PROMPT_SETUP_PATH})

  promptd reads all model + tool wiring from a local JSON file (recommended under onchain/ so it never gets committed).

  Print a template:
    promptd --print-template

HTTP API:
  GET  /healthz
  GET  /v1/tools
  POST /v1/run   { prompt, session_id?, auto_approve?, dry_run?, max_steps? }

`.trim();
}

function parseArgs(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) flags.set(k, true);
    else {
      flags.set(k, next);
      i += 1;
    }
  }
  return flags;
}

function json(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (_e) {
    throw new Error('Invalid JSON body');
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = parseArgs(argv);
  if (argv.includes('--help') || argv.includes('help') || flags.get('help')) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (flags.get('print-template')) {
    process.stdout.write(
      `${JSON.stringify(
        {
          agent: {
            // "maker" or "taker" (used only for system prompt guidance; does not grant permissions).
            role: 'maker',
          },
          llm: {
            base_url: 'http://127.0.0.1:8000/v1',
            api_key: '',
            model: 'your-model-id',
            max_tokens: 8000,
            temperature: 0.4,
            top_p: 0.95,
            top_k: 40,
            min_p: 0.05,
            repetition_penalty: 1.1,
            tool_format: 'tools',
            timeout_ms: 120000,
            // Optional: OpenAI-style structured output enforcement:
            // { "type": "json_object" } or { "type": "json_schema", "json_schema": { ... } }
            response_format: { type: 'json_object' },
            // Optional: extra, provider-specific body fields (pass-through).
            extra_body: {},
          },
          server: {
            host: '127.0.0.1',
            port: 9333,
            audit_dir: 'onchain/prompt/audit',
            auto_approve_default: false,
            max_steps: 12,
            // If the model returns invalid structured output (eg, plans instead of tool calls),
            // promptd will ask it to re-emit valid JSON up to this many times.
            max_repairs: 2,
          },
          sc_bridge: {
            url: 'ws://127.0.0.1:49222',
            token: '',
            token_file: 'onchain/sc-bridge/<store>.token',
          },
          receipts: {
            db: 'onchain/receipts/<store>.sqlite',
          },
          ln: {
            impl: 'cln',
            backend: 'cli',
            network: 'regtest',
            compose_file: 'dev/ln-regtest/docker-compose.yml',
            service: '',
            cli_bin: '',
            lnd: { rpcserver: '', tlscert: '', macaroon: '', dir: '' },
          },
          solana: {
            rpc_url: 'http://127.0.0.1:8899',
            commitment: 'confirmed',
            program_id: '',
            keypair: '',
            cu_limit: null,
            cu_price: null,
          },
        },
        null,
        2
      )}\n`
    );
    return;
  }

  const configPath = flags.get('config') ? String(flags.get('config')).trim() : DEFAULT_PROMPT_SETUP_PATH;
  const setup = loadPromptSetupFromFile({ configPath, cwd: repoRoot });

  const executor = new ToolExecutor({
    scBridge: setup.scBridge,
    ln: setup.ln,
    solana: setup.solana,
    receipts: setup.receipts,
  });

  const router = new PromptRouter({
    llmConfig: setup.llm,
    toolExecutor: executor,
    auditDir: setup.server.auditDir,
    maxSteps: setup.server.maxSteps,
    maxRepairs: setup.server.maxRepairs,
    agentRole: setup.agent?.role || '',
  });

  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method || 'GET';
      const url = String(req.url || '/');

      if (method === 'GET' && url === '/healthz') {
        json(res, 200, { ok: true });
        return;
      }

      if (method === 'GET' && url === '/v1/tools') {
        json(res, 200, { tools: INTERCOMSWAP_TOOLS });
        return;
      }

      if (method === 'POST' && url === '/v1/run') {
        const body = await readJsonBody(req);
        const prompt = String(body.prompt ?? '').trim();
        const sessionId = body.session_id ? String(body.session_id).trim() : null;
        const autoApprove =
          body.auto_approve === undefined || body.auto_approve === null
            ? setup.server.autoApproveDefault
            : Boolean(body.auto_approve);
        const dryRun = Boolean(body.dry_run);
        const maxSteps = body.max_steps !== undefined && body.max_steps !== null ? Number(body.max_steps) : null;

        const out = await router.run({ prompt, sessionId, autoApprove, dryRun, maxSteps });
        json(res, 200, out);
        return;
      }

      json(res, 404, { error: 'not_found' });
    } catch (err) {
      json(res, 400, { error: err?.message ?? String(err) });
    }
  });

  server.listen(setup.server.port, setup.server.host, () => {
    process.stdout.write(
      JSON.stringify(
        {
          type: 'promptd_listening',
          config: setup.configPath,
          host: setup.server.host,
          port: setup.server.port,
          audit_dir: setup.server.auditDir,
          llm: { base_url: setup.llm.baseUrl, model: setup.llm.model, tool_format: setup.llm.toolFormat },
        },
        null,
        2
      ) + '\n'
    );
  });
}

main().catch((err) => die(err?.message ?? String(err)));
