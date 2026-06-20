// Local web console: a developer-facing control panel for the unified agent.
// Beyond a chat box it surfaces what the agent already exposes — model, mode
// (standard/deep/team), execution policy, the user's sessions (from the central
// libSQL store), the tool-quality ranking (from telemetry), and the workspace
// files. The real multi-tenant online surface is the gateway; this is for
// hands-on local testing.
//
//   DEEPSEEK_API_KEY=... node_modules/.bin/tsx src/unified-agent/web-console.ts
//
import { mkdirSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExecutionPolicy } from "../../packages/capability-contract/src/index.js";
import type { RuntimeEvent } from "../../packages/loop-runtime/src/index.js";
import { LocalSandbox } from "../../packages/sandbox-core/src/index.js";
import { LibsqlSessionStore } from "../../packages/session-store/src/index.js";
import { SqliteTelemetryStore } from "../../packages/telemetry-store/src/index.js";
import { DEEPSEEK_MODEL, startAgent, type UnifiedAgent } from "./index.js";

const PORT = Number(process.env.PORT ?? 8787);
const WORKSPACE = path.resolve(process.env.AGENT_WORKSPACE ?? "./web-workspace");
const DB_URL = `file:${path.join(WORKSPACE, "central.db")}`;
const OWNER = "web-user";
const SYSTEM_PROMPT =
  "You are a helpful coding assistant in a sandboxed workspace. Use the fs.read, " +
  "fs.write, fs.list, and exec.run tools to inspect and change files and run " +
  "commands rather than only describing them. Be concise.";

type Mode = "standard" | "deep" | "team";
function modeConfig(mode: Mode) {
  return { id: mode, maxParallelToolCalls: 1, planningEnabled: mode === "deep" };
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Unified Agent 控制台</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,sans-serif;background:#0b0b0d;color:#e7e7ea;display:grid;grid-template-columns:280px 1fr;height:100vh}
aside{background:#141417;border-right:1px solid #26262c;padding:16px;overflow-y:auto}
main{display:flex;flex-direction:column;height:100vh}
h1{font-size:15px;font-weight:500;margin:0 0 14px}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.05em;opacity:.5;margin:18px 0 8px}
label{display:block;font-size:12px;opacity:.7;margin:8px 0 3px}
select,input{width:100%;padding:8px;border-radius:8px;border:1px solid #2a2a30;background:#1c1c20;color:inherit;font-size:14px}
.row{font-size:13px;padding:6px 8px;border-radius:7px;cursor:pointer;opacity:.8}
.row:hover{background:#1c1c20}
.row.active{background:#23304a;opacity:1}
.kv{font-size:12px;opacity:.7;display:flex;justify-content:space-between;padding:3px 0;font-family:ui-monospace,monospace}
#log{flex:1;overflow-y:auto;padding:18px;display:flex;flex-direction:column;gap:10px}
.msg{padding:10px 14px;border-radius:12px;max-width:80%;white-space:pre-wrap;line-height:1.5}
.user{align-self:flex-end;background:#2b3a55}
.assistant{align-self:flex-start;background:#1c1c20;border:1px solid #2a2a30}
.tool{align-self:flex-start;font-size:12px;opacity:.6;font-family:ui-monospace,monospace}
.err{color:#f09595}
footer{display:flex;gap:8px;padding:14px;border-top:1px solid #26262c}
footer input{font-size:15px}
button{padding:10px 16px;border-radius:9px;border:0;background:#3b6cc4;color:#fff;font-size:14px;cursor:pointer}
button:disabled{opacity:.5}
.small{font-size:11px;opacity:.5;margin-top:4px}
</style></head><body>
<aside>
<h1>⚙ Unified Agent 控制台</h1>
<h2>模型</h2><div class="kv"><span id="model">—</span></div>
<label>模式 (大脑)</label><select id="mode"><option value="standard">标准</option><option value="deep">深度（规划-执行）</option><option value="team">团队（并行编排）</option></select>
<label>执行策略</label><select id="policy"><option value="auto">auto（全自动）</option><option value="read-only">read-only（只读）</option></select>
<div class="small">ask（逐次审批）需在 CLI/终端用</div>
<h2>会话 <button id="new" style="float:right;padding:2px 8px;font-size:11px">新建</button></h2><div id="sessions"></div>
<h2>工具质量</h2><div id="tools"></div>
<h2>工作区文件</h2><div id="files"></div>
</aside>
<main>
<div id="log"></div>
<footer><input id="m" placeholder="说点什么…（它会真读写文件、跑命令）" autocomplete="off" autofocus><button id="b">发送</button></footer>
</main>
<script>
let sessionId='web';
const $=id=>document.getElementById(id),log=$('log');
function add(cls,text){const d=document.createElement('div');d.className='msg '+cls;d.textContent=text;log.appendChild(d);d.scrollIntoView();return d}
async function refresh(){
  const s=await (await fetch('/api/state?session='+encodeURIComponent(sessionId))).json();
  $('model').textContent=s.model;
  $('sessions').innerHTML='';
  for(const x of s.sessions){const d=document.createElement('div');d.className='row'+(x.sessionId===sessionId?' active':'');d.textContent=x.sessionId;d.onclick=()=>loadSession(x.sessionId);$('sessions').appendChild(d)}
  $('tools').innerHTML=s.tools.length?'':'<div class="small">暂无</div>';
  for(const t of s.tools){const d=document.createElement('div');d.className='kv';d.innerHTML='<span>'+t.capability+'</span><span>'+t.calls+'次 '+Math.round(t.errorRate*100)+'%err</span>';$('tools').appendChild(d)}
  $('files').innerHTML=s.files.length?'':'<div class="small">空</div>';
  for(const f of s.files){const d=document.createElement('div');d.className='kv';d.innerHTML='<span>'+f+'</span>';$('files').appendChild(d)}
}
async function loadSession(id){
  sessionId=id;log.innerHTML='';
  const h=await (await fetch('/api/history?session='+encodeURIComponent(id))).json();
  for(const m of h.messages)add(m.role==='user'?'user':'assistant',m.text);
  refresh();
}
$('new').onclick=()=>{sessionId='web-'+Date.now();log.innerHTML='';refresh()};
$('b').parentElement.onsubmit=null;
document.querySelector('footer').addEventListener('submit',e=>e.preventDefault());
async function send(){
  const msg=$('m').value.trim();if(!msg)return;
  $('m').value='';$('b').disabled=true;add('user',msg);
  const t=add('assistant','…思考中');
  try{
    const r=await fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:msg,sessionId,mode:$('mode').value,policy:$('policy').value})});
    const d=await r.json();t.remove();
    for(const x of d.tools)add('tool','· '+x.capability+(x.isError?' ✗':' ✓'));
    for(const resp of d.responses)add('assistant',resp);
    if(d.status!=='finished')add('assistant err','['+d.status+'] '+(d.detail||''));
  }catch(err){t.textContent='请求失败: '+err;t.className='msg assistant err'}
  $('b').disabled=false;$('m').focus();refresh();
}
$('b').onclick=send;$('m').addEventListener('keydown',e=>{if(e.key==='Enter')send()});
refresh();
</script></body></html>`;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function listFiles(): string[] {
  try {
    return readdirSync(WORKSPACE, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.endsWith(".db"))
      .map((e) => path.relative(WORKSPACE, path.join(e.parentPath, e.name)))
      .slice(0, 50);
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error("set DEEPSEEK_API_KEY");
  }
  mkdirSync(WORKSPACE, { recursive: true });
  const { store, close } = await LibsqlSessionStore.create({ url: DB_URL });
  const telemetry = new SqliteTelemetryStore(new DatabaseSync(":memory:"));
  const sandbox = new LocalSandbox({ workspaceRoot: WORKSPACE });

  let turnEvents: RuntimeEvent[] = [];
  const sink = (event: RuntimeEvent): void => {
    turnEvents.push(event);
    telemetry.record(event);
  };

  // One agent per (mode, policy); rebuilt lazily since the brain is mode-bound.
  const agents = new Map<string, UnifiedAgent>();
  function agentFor(mode: Mode, policy: ExecutionPolicy): UnifiedAgent {
    const key = `${mode}:${policy}`;
    let agent = agents.get(key);
    if (!agent) {
      agent = startAgent(
        { model: DEEPSEEK_MODEL, mode, policy, systemPrompt: SYSTEM_PROMPT },
        { sandboxProviders: [sandbox], store, telemetry: sink },
      );
      agents.set(key, agent);
    }
    return agent;
  }

  async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = JSON.parse(await readBody(req)) as {
      message: string;
      sessionId: string;
      mode: Mode;
      policy: ExecutionPolicy;
    };
    await store.ensureSession(body.sessionId, OWNER);
    turnEvents = [];
    const result = await agentFor(body.mode, body.policy).runtime.runTurn({
      sessionId: body.sessionId,
      userMessage: body.message,
      binding: { kind: "cloud-general" },
      mode: modeConfig(body.mode),
    });
    const tools = turnEvents
      .filter((e) => e.kind === "tool_call_finished")
      .map((e) => ({ capability: e.capability, isError: e.isError }));
    sendJson(res, {
      responses: result.responses,
      status: result.status,
      detail: result.detail ?? null,
      tools,
    });
  }

  async function handleState(res: ServerResponse): Promise<void> {
    sendJson(res, {
      model: `${DEEPSEEK_MODEL.displayName} (${DEEPSEEK_MODEL.provider})`,
      sessions: await store.listSessions(OWNER),
      tools: telemetry.toolQualityRanking(),
      files: listFiles(),
    });
  }

  async function handleHistory(url: URL, res: ServerResponse): Promise<void> {
    const sessionId = url.searchParams.get("session") ?? "web";
    const loaded = await store.load(sessionId);
    const messages = (loaded?.entries ?? [])
      .filter((e) => e.kind === "user" || e.kind === "assistant")
      .map((e) => ({
        role: e.kind,
        text: e.kind === "user" || e.kind === "assistant" ? e.text : "",
      }));
    sendJson(res, { messages });
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/chat") {
      void handleChat(req, res).catch((e: unknown) => sendError(res, e));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      void handleState(res).catch((e: unknown) => sendError(res, e));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/history") {
      void handleHistory(url, res).catch((e: unknown) => sendError(res, e));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  server.listen(PORT, () => {
    process.stdout.write(`unified agent console on http://localhost:${PORT}\n`);
    process.stdout.write(`workspace: ${WORKSPACE}\n`);
  });

  const shutdown = (): void => {
    server.close();
    for (const agent of agents.values()) {
      agent.close();
    }
    close();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function sendJson(res: ServerResponse, value: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}
function sendError(res: ServerResponse, error: unknown): void {
  res.writeHead(500, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
