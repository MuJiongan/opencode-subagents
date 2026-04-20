import { promises as fs } from "fs"
import * as os from "os"
import * as path from "path"
import { exec } from "child_process"
import { Session } from "./index"
import { MessageV2 } from "./message-v2"
import { SessionID } from "./schema"
import { AppRuntime } from "@/effect/app-runtime"

type SessionBundle = {
  info: Session.Info
  messages: MessageV2.WithParts[]
}

type TreeNode = {
  id: string
  role: string
  description: string
  status: "completed" | "error" | "running" | "pending" | "unknown"
  agent: string
  model: string
  parentID?: string
  allowed_tools: string[] | null
  inherited_tools: boolean
  injected_system: string
  system_prompt_override: string
  prompt_received: string
  result_returned: string
  tool_calls: ToolCallSummary[]
  children: TreeNode[]
  turns: number
}

type ToolCallSummary = {
  tool: string
  title: string
  status: string
  input_json: string
  output: string
  error: string
  child_session_id?: string
}

async function collectTree(rootID: SessionID): Promise<Map<string, SessionBundle>> {
  const bundles = new Map<string, SessionBundle>()
  async function walk(id: SessionID) {
    if (bundles.has(id)) return
    const info = await AppRuntime.runPromise(Session.Service.use((s) => s.get(id)))
    const messages = await AppRuntime.runPromise(Session.Service.use((s) => s.messages({ sessionID: id })))
    bundles.set(id, { info, messages })
    const kids = await AppRuntime.runPromise(Session.Service.use((s) => s.children(id)))
    for (const kid of kids) await walk(kid.id)
  }
  await walk(rootID)
  return bundles
}

function extractAllowedTools(
  ruleset: { permission: string; pattern: string; action: string }[] | undefined,
): { tools: string[]; denyAll: boolean } {
  if (!ruleset) return { tools: [], denyAll: false }
  const denyAll = ruleset.some((r) => r.permission === "*" && r.pattern === "*" && r.action === "deny")
  const tools = new Set<string>()
  for (const rule of ruleset) {
    if (rule.action === "allow" && rule.pattern === "*" && rule.permission !== "*") tools.add(rule.permission)
  }
  return { tools: [...tools].sort(), denyAll }
}

function summarizeToolCalls(msgs: MessageV2.WithParts[]): ToolCallSummary[] {
  const out: ToolCallSummary[] = []
  for (const m of msgs) {
    if (m.info.role !== "assistant") continue
    for (const p of m.parts) {
      if (p.type !== "tool") continue
      const state = p.state as any
      const meta = state?.metadata ?? {}
      out.push({
        tool: p.tool,
        title: state?.title ?? p.tool,
        status: state?.status ?? "unknown",
        input_json: state?.input ? JSON.stringify(state.input, null, 2) : "",
        output: state?.status === "completed" ? String(state?.output ?? "") : "",
        error: state?.status === "error" ? String(state?.error ?? "") : "",
        child_session_id: typeof meta?.sessionId === "string" ? meta.sessionId : undefined,
      })
    }
  }
  return out
}

function finalResultText(msgs: MessageV2.WithParts[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.info.role !== "assistant") continue
    const text = m.parts.findLast((p): p is MessageV2.TextPart => p.type === "text" && !("synthetic" in p && p.synthetic))
    if (text) return text.text
  }
  return ""
}

function findSpawningCall(
  parentBundle: SessionBundle | undefined,
  childID: string,
): {
  role: string
  description: string
  allowed_tools: string[] | null
  prompt_received: string
  system_prompt_override: string
} {
  const fallback = {
    role: "root",
    description: "",
    allowed_tools: null as string[] | null,
    prompt_received: "",
    system_prompt_override: "",
  }
  if (!parentBundle) return fallback
  for (const m of parentBundle.messages) {
    if (m.info.role !== "assistant") continue
    for (const p of m.parts) {
      if (p.type !== "tool" || p.tool !== "task") continue
      const state = p.state as any
      const meta = state?.metadata ?? {}
      if (meta?.sessionId !== childID) continue
      const input = state?.input ?? {}
      return {
        role: typeof input.role === "string" ? input.role : "subagent",
        description: typeof input.description === "string" ? input.description : "",
        allowed_tools: Array.isArray(input.allowed_tools) ? input.allowed_tools : null,
        prompt_received: typeof input.prompt === "string" ? input.prompt : "",
        system_prompt_override: typeof input.system_prompt === "string" ? input.system_prompt : "",
      }
    }
  }
  return fallback
}

function countTurns(msgs: MessageV2.WithParts[]): number {
  return msgs.filter((m) => m.info.role === "user").length
}

function buildTreeNode(
  bundles: Map<string, SessionBundle>,
  id: string,
  parentBundle?: SessionBundle,
): TreeNode {
  const bundle = bundles.get(id)!
  const { info, messages } = bundle
  const spawn = findSpawningCall(parentBundle, id)
  const { tools, denyAll } = extractAllowedTools(info.permission as any)
  const firstUser = messages.find((m) => m.info.role === "user")
  const injectedSystem =
    firstUser && firstUser.info.role === "user" ? (firstUser.info.system ?? "") : ""
  const lastAssistant = messages.findLast((m) => m.info.role === "assistant")
  const status: TreeNode["status"] =
    !parentBundle
      ? "completed"
      : (() => {
          if (!parentBundle) return "completed"
          for (const m of parentBundle.messages) {
            if (m.info.role !== "assistant") continue
            for (const p of m.parts) {
              if (p.type !== "tool" || p.tool !== "task") continue
              const meta = (p.state as any)?.metadata ?? {}
              if (meta?.sessionId !== id) continue
              const s = (p.state as any)?.status
              if (s === "completed" || s === "error" || s === "running" || s === "pending") return s
            }
          }
          return "unknown"
        })()

  const tool_calls = summarizeToolCalls(messages)
  const children = tool_calls
    .map((t) => t.child_session_id)
    .filter((x): x is string => !!x)
    .filter((cid) => bundles.has(cid))
    .map((cid) => buildTreeNode(bundles, cid, bundle))

  const agent = (lastAssistant?.info as any)?.agent ?? "—"
  const model =
    lastAssistant && lastAssistant.info.role === "assistant"
      ? `${(lastAssistant.info as any).providerID ?? ""}/${(lastAssistant.info as any).modelID ?? ""}`
      : "—"

  return {
    id,
    role: parentBundle ? spawn.role : "main",
    description: spawn.description || info.title || "",
    status,
    agent,
    model,
    parentID: info.parentID,
    allowed_tools: denyAll ? tools : spawn.allowed_tools,
    inherited_tools: !denyAll && !spawn.allowed_tools,
    injected_system: injectedSystem,
    system_prompt_override: spawn.system_prompt_override,
    prompt_received: spawn.prompt_received,
    result_returned: finalResultText(messages),
    tool_calls,
    children,
    turns: countTurns(messages),
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "completed":
      return "completed"
    case "error":
      return "error"
    case "running":
      return "running"
    case "pending":
      return "pending"
    default:
      return "unknown"
  }
}

function escapeHtml(value: unknown): string {
  if (value === undefined || value === null) return ""
  const s = typeof value === "string" ? value : String(value)
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function renderRow(node: TreeNode, depth: number, lastSiblingMask: boolean[]): string {
  const toolCount = node.tool_calls.filter((t) => t.tool !== "task").length
  const sub = node.children.length
  const badge = `<span class="badge badge-${statusColor(node.status)}">${escapeHtml(node.status)}</span>`

  // build the ascii-style guide prefix using box-drawing characters
  // for each ancestor level: "│  " if that ancestor has more siblings after it, "   " if it's the last
  // for the current level: "├─ " normally, "└─ " if this row is the last child of its parent
  let guide = ""
  for (let i = 0; i < depth - 1; i++) {
    guide += `<span class="guide-col ${lastSiblingMask[i] ? "guide-col-empty" : "guide-col-bar"}"></span>`
  }
  if (depth > 0) {
    guide += `<span class="guide-col ${lastSiblingMask[depth - 1] ? "guide-col-last" : "guide-col-mid"}"></span>`
  }
  const hasChildren = sub > 0
  const caret = hasChildren
    ? `<button class="caret" data-id="${escapeHtml(node.id)}" aria-label="toggle" type="button">▾</button>`
    : `<span class="caret-spacer"></span>`

  const row = `
    <div class="row" data-depth="${depth}" data-id="${escapeHtml(node.id)}">
      <span class="guide">${guide}</span>
      ${caret}
      <span class="status-dot status-${statusColor(node.status)}" title="${escapeHtml(node.status)}"></span>
      <button class="card-btn" data-id="${escapeHtml(node.id)}" type="button">
        <span class="role">@${escapeHtml(node.role)}</span>
        <span class="desc">${escapeHtml(node.description || node.id.slice(-8))}</span>
        <span class="stats">
          <span title="tool calls">🔧 ${toolCount}</span>
          <span title="subagents">🧵 ${sub}</span>
          <span title="turns">💬 ${node.turns}</span>
          ${badge}
        </span>
      </button>
    </div>
  `

  const childRows = node.children
    .map((c, i) => {
      const isLast = i === node.children.length - 1
      return renderRow(c, depth + 1, [...lastSiblingMask, isLast])
    })
    .join("")

  return `${row}<div class="subtree" data-parent="${escapeHtml(node.id)}">${childRows}</div>`
}

const STYLES = `
  :root {
    color-scheme: light dark;
    --bg: #0b0d12;
    --panel: #141820;
    --fg: #e6e6e6;
    --muted: #9ca3af;
    --border: #2a2d33;
    --accent: #818cf8;
    --accent-soft: rgba(129, 140, 248, 0.15);
    --ok: #4ade80;
    --err: #f87171;
    --pending: #fbbf24;
    --unknown: #6b7280;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #fafafa;
      --panel: #ffffff;
      --fg: #1a1a1a;
      --muted: #6b7280;
      --border: #d4d4d8;
      --accent: #4f46e5;
      --accent-soft: rgba(79, 70, 229, 0.08);
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; min-height: 100vh; }
  h1 { margin: 0; font-size: 18px; font-weight: 600; }
  .toolbar { padding: 12px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 12px; background: var(--panel); position: sticky; top: 0; z-index: 10; }
  .toolbar .meta { color: var(--muted); font-size: 12px; margin-left: auto; }
  code, pre { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; }
  pre { background: var(--accent-soft); padding: 10px; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; margin: 6px 0; color: var(--fg); }

  /* tree (indented list) */
  .tree-wrap { padding: 20px; max-width: 1100px; margin: 0 auto; }
  .tree { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  .row {
    display: flex; align-items: center; gap: 6px;
    padding: 3px 6px; border-radius: 5px;
    min-height: 28px;
  }
  .row:hover { background: var(--accent-soft); }
  .guide { display: inline-flex; flex-shrink: 0; }
  .guide-col {
    display: inline-block; width: 20px; height: 28px; position: relative;
  }
  /* a vertical line continuing from a parent with more siblings below */
  .guide-col-bar::before {
    content: ""; position: absolute; left: 9px; top: 0; bottom: 0;
    border-left: 1px solid var(--border);
  }
  /* a T connector (current row is a middle child) */
  .guide-col-mid::before {
    content: ""; position: absolute; left: 9px; top: 0; bottom: 0;
    border-left: 1px solid var(--border);
  }
  .guide-col-mid::after {
    content: ""; position: absolute; left: 9px; top: 50%; width: 11px;
    border-top: 1px solid var(--border);
  }
  /* an L connector (current row is the last child) */
  .guide-col-last::before {
    content: ""; position: absolute; left: 9px; top: 0; height: 50%;
    border-left: 1px solid var(--border);
  }
  .guide-col-last::after {
    content: ""; position: absolute; left: 9px; top: 50%; width: 11px;
    border-top: 1px solid var(--border);
  }
  .guide-col-empty { /* spacing only */ }

  .caret, .caret-spacer {
    width: 16px; height: 16px; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center;
    background: transparent; border: 0; color: var(--muted); cursor: pointer; font-size: 10px; padding: 0;
  }
  .caret:hover { color: var(--fg); }
  .caret-spacer { cursor: default; }
  .row.collapsed .caret { transform: rotate(-90deg); }

  .status-dot {
    display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
  }
  .status-dot.status-completed { background: var(--ok); }
  .status-dot.status-error { background: var(--err); }
  .status-dot.status-running { background: var(--pending); animation: pulse 1.2s ease-in-out infinite; }
  .status-dot.status-pending { background: var(--muted); }
  .status-dot.status-unknown { background: var(--unknown); }
  @keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.4 } }

  .card-btn {
    flex: 1; display: flex; align-items: center; gap: 10px; min-width: 0;
    background: transparent; border: 0; padding: 4px 8px; border-radius: 5px;
    cursor: pointer; text-align: left; font: inherit; color: var(--fg);
  }
  .card-btn:hover { background: var(--accent-soft); }
  .card-btn .role { color: var(--accent); font-weight: 600; font-size: 13px; flex-shrink: 0; }
  .card-btn .desc { color: var(--fg); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; opacity: 0.85; }
  .card-btn .stats { display: flex; gap: 8px; font-size: 11px; color: var(--muted); flex-shrink: 0; align-items: center; }

  .subtree.hidden { display: none; }

  .badge {
    display: inline-block; padding: 1px 6px; border-radius: 999px; font-size: 9px; text-transform: uppercase;
    font-weight: 700; letter-spacing: 0.04em;
  }
  .badge-completed { background: color-mix(in srgb, var(--ok) 25%, transparent); color: var(--ok); }
  .badge-error { background: color-mix(in srgb, var(--err) 25%, transparent); color: var(--err); }
  .badge-running { background: color-mix(in srgb, var(--pending) 25%, transparent); color: var(--pending); }
  .badge-pending { background: color-mix(in srgb, var(--muted) 25%, transparent); color: var(--muted); }
  .badge-unknown { background: color-mix(in srgb, var(--unknown) 25%, transparent); color: var(--unknown); }

  /* modal */
  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.6);
    display: none; align-items: center; justify-content: center; z-index: 100;
    backdrop-filter: blur(2px);
  }
  .modal-backdrop.open { display: flex; }
  .modal {
    background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
    width: min(860px, 95vw); max-height: 90vh; overflow-y: auto;
    box-shadow: 0 20px 60px rgba(0,0,0,0.5);
  }
  .modal-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 16px 20px; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--panel); z-index: 1;
  }
  .modal-header h2 { margin: 0; font-size: 16px; font-weight: 600; }
  .modal-header .subtitle { color: var(--muted); font-weight: 400; font-size: 13px; margin-left: 6px; }
  .close-btn {
    background: transparent; border: 0; color: var(--muted); font-size: 24px; cursor: pointer;
    width: 30px; height: 30px; line-height: 0;
  }
  .close-btn:hover { color: var(--fg); }
  .modal-body { padding: 16px 20px 24px; }
  .section { margin: 14px 0; }
  .section h3 { font-size: 11px; text-transform: uppercase; color: var(--muted); letter-spacing: 0.06em; margin: 0 0 6px; font-weight: 600; }
  .kv-grid { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; font-size: 13px; }
  .kv-grid dt { color: var(--muted); }
  .kv-grid dd { margin: 0; color: var(--fg); }
  .kv-grid code { color: var(--fg); }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip { background: var(--accent-soft); padding: 2px 8px; border-radius: 4px; font-size: 11px; font-family: ui-monospace, monospace; color: var(--accent); }
  .empty { color: var(--muted); font-style: italic; font-size: 12px; }
  .tool-list { display: flex; flex-direction: column; gap: 6px; }
  .tool-item { border: 1px solid var(--border); border-radius: 6px; background: var(--bg); }
  .tool-item summary {
    cursor: pointer; padding: 6px 10px; list-style: none; display: flex; gap: 8px; align-items: center; font-size: 12px;
  }
  .tool-item summary::-webkit-details-marker { display: none; }
  .tool-item summary::before { content: "▸"; color: var(--muted); font-size: 10px; }
  .tool-item[open] summary::before { content: "▾"; }
  .tool-item .tool-body { padding: 0 10px 10px; font-size: 12px; }
  .tool-item code.tool-name { color: var(--accent); font-weight: 600; }
  .tool-item .tool-title { color: var(--muted); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .btn-open-child {
    margin-left: auto; padding: 2px 8px; font-size: 11px; border: 1px solid var(--accent);
    background: transparent; color: var(--accent); border-radius: 4px; cursor: pointer;
  }
  .btn-open-child:hover { background: var(--accent-soft); }
  details pre { max-height: 300px; overflow: auto; margin: 4px 0; }
`

const CLIENT_SCRIPT = `
(function () {
  const NODES = window.__TRACE_NODES__;

  function escapeHtml(value) {
    if (value === undefined || value === null) return "";
    const s = typeof value === "string" ? value : String(value);
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function renderDetail(node) {
    const allowedChips = node.inherited_tools
      ? '<span class="empty">inherited from agent permissions (no explicit allowlist)</span>'
      : (node.allowed_tools && node.allowed_tools.length
          ? node.allowed_tools.map(t => '<span class="chip">' + escapeHtml(t) + '</span>').join("")
          : '<span class="empty">none (deny-all)</span>');

    const toolItems = node.tool_calls.filter(t => t.tool !== 'task').map(t => {
      const statusBadge = '<span class="badge badge-' + t.status + '">' + escapeHtml(t.status) + '</span>';
      return (
        '<details class="tool-item">' +
          '<summary><code class="tool-name">' + escapeHtml(t.tool) + '</code>' +
          '<span class="tool-title">' + escapeHtml(t.title) + '</span>' +
          statusBadge + '</summary>' +
          '<div class="tool-body">' +
            (t.input_json ? '<details><summary>input</summary><pre>' + escapeHtml(t.input_json) + '</pre></details>' : '') +
            (t.output ? '<details open><summary>output</summary><pre>' + escapeHtml(t.output) + '</pre></details>' : '') +
            (t.error ? '<div style="color:var(--err)">error: <pre>' + escapeHtml(t.error) + '</pre></div>' : '') +
          '</div>' +
        '</details>'
      );
    }).join("");

    const spawnItems = node.tool_calls.filter(t => t.tool === 'task').map(t => {
      const cid = t.child_session_id;
      const childExists = cid && NODES[cid];
      const btn = childExists
        ? '<button class="btn-open-child" data-child="' + escapeHtml(cid) + '">open subagent →</button>'
        : '';
      const statusBadge = '<span class="badge badge-' + t.status + '">' + escapeHtml(t.status) + '</span>';
      return (
        '<details class="tool-item">' +
          '<summary><code class="tool-name">task</code>' +
          '<span class="tool-title">' + escapeHtml(t.title) + '</span>' +
          statusBadge + btn + '</summary>' +
          '<div class="tool-body">' +
            (t.input_json ? '<details><summary>input</summary><pre>' + escapeHtml(t.input_json) + '</pre></details>' : '') +
            (t.output ? '<details><summary>returned to parent</summary><pre>' + escapeHtml(t.output) + '</pre></details>' : '') +
          '</div>' +
        '</details>'
      );
    }).join("");

    return (
      '<div class="section">' +
        '<h3>identity</h3>' +
        '<dl class="kv-grid">' +
          '<dt>role</dt><dd><strong>' + escapeHtml(node.role) + '</strong></dd>' +
          (node.description ? '<dt>description</dt><dd>' + escapeHtml(node.description) + '</dd>' : '') +
          '<dt>status</dt><dd><span class="badge badge-' + node.status + '">' + escapeHtml(node.status) + '</span></dd>' +
          '<dt>agent</dt><dd><code>' + escapeHtml(node.agent) + '</code></dd>' +
          '<dt>model</dt><dd><code>' + escapeHtml(node.model) + '</code></dd>' +
          '<dt>session id</dt><dd><code>' + escapeHtml(node.id) + '</code></dd>' +
          (node.parentID ? '<dt>parent id</dt><dd><code>' + escapeHtml(node.parentID) + '</code> <button class="btn-open-child" data-child="' + escapeHtml(node.parentID) + '">open parent →</button></dd>' : '') +
        '</dl>' +
      '</div>' +
      '<div class="section">' +
        '<h3>allowed tools</h3>' +
        '<div class="chips">' + allowedChips + '</div>' +
      '</div>' +
      (node.injected_system ? (
        '<div class="section">' +
          '<h3>system prompt injected by parent</h3>' +
          '<pre>' + escapeHtml(node.injected_system) + '</pre>' +
        '</div>'
      ) : '') +
      (node.system_prompt_override ? (
        '<div class="section">' +
          '<h3>system_prompt override</h3>' +
          '<pre>' + escapeHtml(node.system_prompt_override) + '</pre>' +
        '</div>'
      ) : '') +
      (node.prompt_received ? (
        '<div class="section">' +
          '<h3>prompt received from parent</h3>' +
          '<pre>' + escapeHtml(node.prompt_received) + '</pre>' +
        '</div>'
      ) : '') +
      (node.result_returned ? (
        '<div class="section">' +
          '<h3>final result (returned to parent / user)</h3>' +
          '<pre>' + escapeHtml(node.result_returned) + '</pre>' +
        '</div>'
      ) : '') +
      (spawnItems ? (
        '<div class="section">' +
          '<h3>subagents spawned (' + node.children.length + ')</h3>' +
          '<div class="tool-list">' + spawnItems + '</div>' +
        '</div>'
      ) : '') +
      (toolItems ? (
        '<div class="section">' +
          '<h3>tool calls in this session (' + node.tool_calls.filter(function(t){return t.tool !== 'task'}).length + ')</h3>' +
          '<div class="tool-list">' + toolItems + '</div>' +
        '</div>'
      ) : '<div class="section"><h3>tool calls in this session</h3><div class="empty">none</div></div>')
    );
  }

  const backdrop = document.getElementById("modal-backdrop");
  const body = document.getElementById("modal-body");
  const title = document.getElementById("modal-title");
  const subtitle = document.getElementById("modal-subtitle");

  function openModal(id) {
    const node = NODES[id];
    if (!node) return;
    title.textContent = "@" + node.role;
    subtitle.textContent = node.description || "";
    body.innerHTML = renderDetail(node);
    backdrop.classList.add("open");
  }
  function closeModal() { backdrop.classList.remove("open"); }

  document.querySelectorAll(".card-btn").forEach(function (el) {
    el.addEventListener("click", function (e) {
      e.stopPropagation();
      openModal(el.getAttribute("data-id"));
    });
  });
  document.querySelectorAll(".caret").forEach(function (el) {
    el.addEventListener("click", function (e) {
      e.stopPropagation();
      const id = el.getAttribute("data-id");
      const subtree = document.querySelector('.subtree[data-parent="' + id + '"]');
      const row = el.closest(".row");
      if (!subtree || !row) return;
      subtree.classList.toggle("hidden");
      row.classList.toggle("collapsed");
    });
  });
  backdrop.addEventListener("click", function (e) {
    if (e.target === backdrop) closeModal();
  });
  document.getElementById("close-btn").addEventListener("click", closeModal);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeModal(); });

  // delegate for "open subagent/parent" buttons rendered inside the modal body
  body.addEventListener("click", function (e) {
    const btn = e.target.closest(".btn-open-child");
    if (!btn) return;
    e.stopPropagation();
    openModal(btn.getAttribute("data-child"));
  });
})();
`

function flattenNodes(root: TreeNode, acc: Record<string, TreeNode> = {}): Record<string, TreeNode> {
  acc[root.id] = root
  for (const c of root.children) flattenNodes(c, acc)
  return acc
}

export async function renderTraceHtml(rootID: SessionID): Promise<{ html: string; title: string }> {
  const bundles = await collectTree(rootID)
  if (!bundles.has(rootID)) throw new Error(`Session not found: ${rootID}`)
  const tree = buildTreeNode(bundles, rootID)
  const flat = flattenNodes(tree)
  const title = bundles.get(rootID)!.info.title ?? rootID

  const renderedTree = renderRow(tree, 0, [])

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Trace · ${escapeHtml(title)}</title>
  <style>${STYLES}</style>
</head>
<body>
  <header class="toolbar">
    <h1>🧵 Subagent trace</h1>
    <span class="meta">${escapeHtml(title)} · ${Object.keys(flat).length} session(s) · generated ${new Date().toLocaleString()}</span>
  </header>

  <main class="tree-wrap">
    <div class="tree">${renderedTree}</div>
  </main>

  <div class="modal-backdrop" id="modal-backdrop" role="dialog" aria-modal="true">
    <div class="modal">
      <div class="modal-header">
        <div>
          <h2 id="modal-title">—</h2>
          <span class="subtitle" id="modal-subtitle"></span>
        </div>
        <button class="close-btn" id="close-btn" aria-label="close">×</button>
      </div>
      <div class="modal-body" id="modal-body"></div>
    </div>
  </div>

  <script>window.__TRACE_NODES__ = ${JSON.stringify(flat).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")};</script>
  <script>${CLIENT_SCRIPT}</script>
</body>
</html>
`

  return { html, title }
}

/**
 * Writes a session trace to a temp HTML file and opens it in the default browser.
 * Returns the file path. Silently swallows browser-open errors (returns path regardless).
 */
export async function writeAndOpenTrace(rootID: SessionID): Promise<string> {
  const { html } = await renderTraceHtml(rootID)
  const dir = path.join(os.tmpdir(), "opencode-trace")
  await fs.mkdir(dir, { recursive: true })
  const filepath = path.join(dir, `${rootID}-${Date.now()}.html`)
  await fs.writeFile(filepath, html, "utf8")
  openInBrowser(filepath)
  return filepath
}

function openInBrowser(filepath: string) {
  const quoted = `"${filepath.replace(/"/g, '\\"')}"`
  const command =
    process.platform === "darwin"
      ? `open ${quoted}`
      : process.platform === "win32"
        ? `start "" ${quoted}`
        : `xdg-open ${quoted}`
  exec(command, () => {
    /* best effort */
  })
}
