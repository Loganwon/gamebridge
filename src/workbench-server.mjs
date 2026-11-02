import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolveProviderConfig } from './ai/provider.mjs';
import { validateConversionRequest, validateConversionPlan } from './converter/spec.mjs';
import { generateConversionPlan } from './converter/provider.mjs';
import { assessConversion, readAdapterCatalog } from './converter/workflow.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json' };
function failure(status, code, message) { const error = new Error(message); Object.assign(error, { status, code }); return error; }

/** Local conversion-planning service. No code generation, compilation or game execution routes. */
export function createWorkbenchServer({ root = path.join(ROOT, 'dist'), apiKey = process.env.DEEPSEEK_API_KEY || '', baseUrl = process.env.GAMEBRIDGE_API_BASE || 'https://api.deepseek.com', model = process.env.GAMEBRIDGE_MODEL || 'deepseek-flash', analyzer = generateConversionPlan } = {}) {
  const records = new Map(), active = new Set();
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  function noCredential(value, secrets, code = 'CREDENTIAL_IN_RESPONSE') {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string') return;
    if (secrets.some(secret => secret && serialized.includes(JSON.stringify(secret).slice(1, -1)))) throw failure(502, code, '内容包含凭据，已丢弃且未保存。');
  }
  async function body(req) {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw failure(415, 'JSON_REQUIRED', '请使用 JSON 请求。');
    const chunks = []; let total = 0;
    for await (const bytes of req) { total += bytes.length; if (total > 32768) throw failure(413, 'REQUEST_TOO_LARGE', '请求不能超过 32 KiB。'); chunks.push(bytes); }
    try {
      const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['request', 'provider'].includes(key))) throw new Error();
      return input;
    } catch { throw failure(400, 'INVALID_JSON', '请求不是允许的 JSON 对象。'); }
  }
  function get(id) {
    const record = records.get(id);
    if (!record || Date.now() - record.created > 3600000) { records.delete(id); throw failure(404, 'NOT_FOUND', '方案不存在或已过期。'); }
    return record;
  }
  const server = http.createServer(async (req, res) => {
    const secrets = [apiKey].filter(Boolean);
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const port = server.address()?.port, host = req.headers.host || '';
      const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) throw failure(403, 'INVALID_HOST', '仅接受本机工作台请求。');
      if (req.headers.origin && !origins.includes(req.headers.origin)) throw failure(403, 'INVALID_ORIGIN', '请从本机工作台发起操作。');
      const url = new URL(req.url, origins[0]);
      if (url.pathname === '/api/config' && req.method === 'GET') return json(res, 200, { local: true, providerConfigured: Boolean(apiKey), defaultProvider: { baseUrl, model }, capabilities: { conversionPlanning: true, projectGeneration: false, compilation: false, gameExecution: false }, adapters: readAdapterCatalog() });
      if (url.pathname === '/api/adapters' && req.method === 'GET') return json(res, 200, readAdapterCatalog());
      if (url.pathname === '/api/conversions' && req.method === 'POST') {
        const input = await body(req), request = validateConversionRequest(input.request);
        if (active.size >= 2) throw failure(429, 'BUSY', '已有分析任务在运行。');
        const provider = resolveProviderConfig(input.provider, { apiKey, baseUrl, model }); secrets.push(provider.apiKey);
        noCredential(request, secrets, 'CREDENTIAL_IN_REQUEST');
        const controller = new AbortController(), deadline = AbortSignal.timeout(120000);
        const signal = AbortSignal.any([controller.signal, deadline]);
        const closed = () => { if (!res.writableEnded) controller.abort(); };
        const interrupted = () => { throw failure(409, 'ANALYSIS_CANCELLED', '分析已取消，晚到结果已丢弃。'); };
        let onAbort;
        const abort = new Promise((_, reject) => { onAbort = () => reject(failure(409, 'ANALYSIS_CANCELLED', '分析已取消或超时，晚到结果已丢弃。')); signal.addEventListener('abort', onAbort, { once: true }); });
        active.add(controller); res.once('close', closed);
        let proposal;
        try {
          if (signal.aborted) interrupted();
          proposal = await Promise.race([analyzer(request, { ...provider, signal }), abort]);
          if (signal.aborted) interrupted();
        } finally { active.delete(controller); signal.removeEventListener('abort', onAbort); res.removeListener('close', closed); }
        noCredential(proposal, secrets);
        const plan = validateConversionPlan(proposal, request), assessment = assessConversion(plan);
        const id = randomUUID();
        const record = { id, created: Date.now(), request, plan, assessment, report: { scope: 'conversion-plan', provenance: 'model', model: provider.model, modelCalls: 1, analysis: 'schema_validated', completeRequirementCoverage: false, readyToGenerate: false, realModBuild: 'not_run', game: 'not_run', readyToInstall: false }, downloadUrl: `/api/conversions/${id}/download` };
        noCredential(record, secrets);
        if (signal.aborted || res.destroyed) interrupted();
        if (records.size >= 16) records.delete(records.keys().next().value);
        records.set(id, record); return json(res, 200, record);
      }
      const download = url.pathname.match(/^\/api\/conversions\/([a-f0-9-]{36})\/download$/);
      if (download && req.method === 'GET') {
        const record = get(download[1]);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="gamebridge-conversion-plan.json"', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(record, null, 2) + '\n');
      }
      if (url.pathname.startsWith('/api/')) throw failure(404, 'UNKNOWN_API', '接口不存在。');
      if (!['GET', 'HEAD'].includes(req.method)) throw failure(405, 'METHOD_NOT_ALLOWED', '此资源只支持读取。');
      const publicRoot = await realpath(root), target = await realpath(path.join(publicRoot, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
      if (!target.startsWith(publicRoot + path.sep)) throw failure(403, 'INVALID_PATH', '文件不在网站目录内。');
      const bytes = await readFile(target);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (res.writableEnded || res.destroyed) return;
      const statuses = { PROVIDER_AUTH: 401, PROVIDER_RATE_LIMIT: 429, PROVIDER_TIMEOUT: 504, PROVIDER_NETWORK: 502, PROVIDER_HTTP: 502, INVALID_RESPONSE: 502, INVALID_PLAN: 502, INVALID_CONVERSION_PLAN: 422, INVALID_CONVERSION_REQUEST: 400, ENOENT: 404 };
      let message = error.safeMessage || error.message || '操作失败。';
      for (const secret of secrets) if (secret) message = message.replaceAll(secret, '[redacted]');
      json(res, error.status || statuses[error.code] || 400, { error: { code: error.code || 'REQUEST_FAILED', message } });
    }
  });
  const close = server.close.bind(server);
  server.close = (...args) => { for (const controller of active) controller.abort(); return close(...args); };
  return server;
}
