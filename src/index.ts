/**
 * dsh-knowledge-graph：通用图知识库引擎
 *
 * 设计：
 * - 一个插件 = 图引擎（节点/边/遍历/路径），可挂载无限个知识库
 * - 每个知识库 = kbs/<name>/graph.json（图数据）
 * - 图模型：nodes[{id,type,props}] + edges[{from,to,type,props}]
 * - 工具面全部跨库：kg_libs / kg_lookup / kg_walk / kg_path / kg_query / kg_add_node / kg_add_edge / kg_schema
 *
 * 用途：把「模型/LoRA/工作流/风格」等关系型经验组织成图，
 *       任意领域（Anima 生图 / WQ 因子 / 插件生态…）各建一库，查询沿关系走。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

export const name = 'agent-knowledge-graph'
export const inject = ['tools'] as const

export interface Config {
  /** 知识库根目录：其下每个子目录 = 一个知识库 */
  kbsDir: string
}
export const Config = z.object({
  kbsDir: z.string().default('E:/alice/self-plugins/dsh-knowledge-graph/kbs'),
})

// ---------- 图数据模型 ----------

interface GraphNode {
  id: string
  type: string
  props: Record<string, unknown>
}
interface GraphEdge {
  from: string
  to: string
  type: string
  props?: Record<string, unknown>
}
interface Graph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

const EMPTY: Graph = { nodes: [], edges: [] }

// ---------- JSON-safe 序列化（DSH 工具返回值必须 JsonValue 兼容） ----------

function jsonNode(n: GraphNode): any {
  return { id: n.id, type: n.type, props: { ...(n.props ?? {}) } }
}
function jsonEdge(e: GraphEdge): any {
  return { from: e.from, to: e.to, type: e.type, props: { ...(e.props ?? {}) } }
}

// ---------- 存储层 ----------

function libPath(kbsDir: string, lib: string): string {
  return join(kbsDir, lib, 'graph.json')
}

function loadGraph(kbsDir: string, lib: string): { graph: Graph; error?: string } {
  const p = libPath(kbsDir, lib)
  if (!existsSync(p)) return { graph: EMPTY, error: `知识库不存在: ${lib}（${p}）` }
  try {
    const raw = readFileSync(p, 'utf-8')
    const g = JSON.parse(raw) as Graph
    if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) {
      return { graph: EMPTY, error: `知识库格式错误: ${lib}（缺 nodes/edges 数组）` }
    }
    return { graph: g }
  } catch (e) {
    return { graph: EMPTY, error: `读取知识库失败: ${lib} — ${(e as Error).message}` }
  }
}

function listLibs(kbsDir: string): { name: string; nodes: number; edges: number }[] {
  if (!existsSync(kbsDir)) return []
  return readdirSafe(kbsDir)
    .filter((n) => {
      try { return existsSync(join(kbsDir, n, 'graph.json')) } catch { return false }
    })
    .map((n) => {
      const { graph } = loadGraph(kbsDir, n)
      return { name: n, nodes: graph.nodes.length, edges: graph.edges.length }
    })
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** 原子写：临时文件 + rename（防半写损坏） */
function saveGraph(kbsDir: string, lib: string, graph: Graph): { ok: boolean; error?: string } {
  try {
    const dir = dirname(libPath(kbsDir, lib))
    mkdirSync(dir, { recursive: true })
    const tmp = join(dir, '.graph.tmp.json')
    writeFileSync(tmp, JSON.stringify(graph, null, 2), 'utf-8')
    renameSync(tmp, libPath(kbsDir, lib))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

function findNode(graph: Graph, id: string): GraphNode | undefined {
  return graph.nodes.find((n) => n.id === id)
}

// ---------- 图遍历 ----------

/** BFS：从起点沿指定边类型集合遍历，返回可达节点 + 路径 */
function bfs(graph: Graph, start: string, edgeTypes: string[], maxDepth: number): {
  results: { node: GraphNode; depth: number; path: string[]; via: string[] }[]
} {
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]))
  const adj = new Map<string, { to: string; type: string }[]>()
  for (const e of graph.edges) {
    if (edgeTypes.length > 0 && !edgeTypes.includes(e.type)) continue
    if (!adj.has(e.from)) adj.set(e.from, [])
    adj.get(e.from)!.push({ to: e.to, type: e.type })
  }
  const startNode = nodeMap.get(start)
  if (!startNode) return { results: [] }

  const visited = new Set([start])
  const queue: { id: string; depth: number; path: string[]; via: string[] }[] = [
    { id: start, depth: 0, path: [start], via: [] },
  ]
  const results: { node: GraphNode; depth: number; path: string[]; via: string[] }[] = []
  while (queue.length > 0) {
    const cur = queue.shift()!
    if (cur.depth > 0) {
      results.push({ node: nodeMap.get(cur.id)!, depth: cur.depth, path: cur.path, via: cur.via })
    }
    if (cur.depth >= maxDepth) continue
    for (const next of adj.get(cur.id) ?? []) {
      if (visited.has(next.to)) continue
      visited.add(next.to)
      queue.push({
        id: next.to,
        depth: cur.depth + 1,
        path: [...cur.path, next.to],
        via: [...cur.via, next.type],
      })
    }
  }
  return { results }
}

/** 最短路径（BFS 无权图） */
function shortestPath(graph: Graph, from: string, to: string): { path: string[]; via: string[] } | null {
  const adj = new Map<string, { to: string; type: string }[]>()
  for (const e of graph.edges) {
    if (!adj.has(e.from)) adj.set(e.from, [])
    adj.get(e.from)!.push({ to: e.to, type: e.type })
  }
  const visited = new Set([from])
  const queue: { id: string; path: string[]; via: string[] }[] = [{ id: from, path: [from], via: [] }]
  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const next of adj.get(cur.id) ?? []) {
      if (visited.has(next.to)) continue
      visited.add(next.to)
      const newPath = [...cur.path, next.to]
      const newVia = [...cur.via, next.type]
      if (next.to === to) return { path: newPath, via: newVia }
      queue.push({ id: next.to, path: newPath, via: newVia })
    }
  }
  return null
}

// ---------- 工具 ----------

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('agent-knowledge-graph')

  ctx.tools.register(defineTool({
    name: 'kg_libs',
    description: '列出全部知识库及其规模（节点/边数）。通用图引擎——每个库是一个领域（如 anima/wq/plugins）。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { libs: { type: 'array', required: true }, total: { type: 'number', required: true } } },
      render: (_a: unknown, v: any) => {
        const libs = (v?.libs ?? []) as { name: string; nodes: number; edges: number }[]
        const text = libs.length === 0 ? '（无知识库）' : libs.map((l) => `• ${l.name}: ${l.nodes} 节点 / ${l.edges} 边`).join('\n')
        return [{ type: 'text', text }]
      },
    },
    async execute() {
      const libs = listLibs(config.kbsDir)
      return { libs, total: libs.length }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'kg_lookup',
    description: '按 id 精确查一个节点及其直接关联边（出边/入边）。id 格式通常为 <type>/<name>，如 lora/fcomic 或 base/anima-base。',
    parameters: {
      lib: { type: 'string', description: '知识库名（如 anima）', required: true },
      id: { type: 'string', description: '节点 id', required: true },
      includeEdges: { type: 'boolean', description: '是否返回关联边（默认 true）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { found: { type: 'boolean', required: true }, node: { type: 'json' }, outEdges: { type: 'array' }, inEdges: { type: 'array' }, error: { type: 'string' } } },
      render: (_a: unknown, v: any) => {
        if (!v?.found) return [{ type: 'text', text: `未找到节点: ${v?.error ?? ''}` }]
        const n = v.node
        const out = (v.outEdges ?? []).map((e: any) => `→[${e.type}] ${e.to}`).join('\n')
        const inn = (v.inEdges ?? []).map((e: any) => `←[${e.type}] ${e.from}`).join('\n')
        const text = [
          `${n.type} · ${n.id}`,
          `props: ${JSON.stringify(n.props ?? {}, null, 2)}`,
          out ? `出边:\n${out}` : '',
          inn ? `入边:\n${inn}` : '',
        ].filter(Boolean).join('\n')
        return [{ type: 'text', text }]
      },
    },
    async execute(args: { lib: string; id: string; includeEdges?: boolean }) {
      const { graph, error } = loadGraph(config.kbsDir, args.lib)
      if (error) return { found: false, error }
      const node = findNode(graph, args.id)
      if (!node) return { found: false, error: `${args.lib} 中无节点 ${args.id}` }
      const showEdges = args.includeEdges !== false
      return {
        found: true,
        node: jsonNode(node),
        outEdges: showEdges ? graph.edges.filter((e) => e.from === args.id).map(jsonEdge) : [],
        inEdges: showEdges ? graph.edges.filter((e) => e.to === args.id).map(jsonEdge) : [],
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'kg_walk',
    description: '图遍历：从起点沿指定边类型 BFS，返回可达节点、深度与路径。这是图数据库核心操作——查「A 能到达什么」。edgeTypes 留空 = 全部边。',
    parameters: {
      lib: { type: 'string', description: '知识库名', required: true },
      start: { type: 'string', description: '起点节点 id', required: true },
      edgeTypes: { type: 'array', items: { type: 'string' }, description: '只走这些边类型（空=全部）' },
      maxDepth: { type: 'number', description: '最大深度（默认 3）' },
      direction: { type: 'string', enum: ['out', 'in', 'both'], description: '遍历方向（默认 out）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { start: { type: 'string', required: true }, found: { type: 'number', required: true }, results: { type: 'array' }, error: { type: 'string' } } },
      render: (_a: unknown, v: any) => {
        if (v?.error) return [{ type: 'text', text: `遍历失败: ${v.error}` }]
        const rs = (v?.results ?? []) as any[]
        if (rs.length === 0) return [{ type: 'text', text: `从 ${v?.start} 出发无可达节点` }]
        const text = rs.map((r: any) => {
          const segs: string[] = []
          for (let i = 0; i < r.path.length - 1; i++) segs.push(`${r.path[i]} --[${r.via[i]}]--> ${r.path[i + 1]}`)
          return `[d${r.depth}] ${segs.join('\n        ')}`
        }).join('\n')
        return [{ type: 'text', text }]
      },
    },
    async execute(args: { lib: string; start: string; edgeTypes?: string[]; maxDepth?: number; direction?: string }) {
      const { graph, error } = loadGraph(config.kbsDir, args.lib)
      if (error) return { start: args.start, found: 0, results: [], error }
      const depth = Math.min(args.maxDepth ?? 3, 6)
      const dir = args.direction ?? 'out'
      let edges = graph.edges
      if (dir === 'in') edges = graph.edges.map((e) => ({ from: e.to, to: e.from, type: e.type, props: e.props }))
      else if (dir === 'both') edges = [...graph.edges, ...graph.edges.map((e) => ({ from: e.to, to: e.from, type: e.type, props: e.props }))]
      const g2: Graph = { nodes: graph.nodes, edges }
      const { results } = bfs(g2, args.start, args.edgeTypes ?? [], depth)
      return {
        start: args.start,
        found: results.length,
        results: results.map((r) => ({
          depth: r.depth,
          path: r.path,
          via: r.via,
          node: jsonNode(r.node),
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'kg_path',
    description: '两节点间最短路径（BFS 无权图），返回路径与途经边类型。用于「A 和 B 怎么连上」。',
    parameters: {
      lib: { type: 'string', description: '知识库名', required: true },
      from: { type: 'string', description: '起点', required: true },
      to: { type: 'string', description: '终点', required: true },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { found: { type: 'boolean', required: true }, path: { type: 'array' }, via: { type: 'array' }, error: { type: 'string' } } },
      render: (_a: unknown, v: any) => {
        if (!v?.found) return [{ type: 'text', text: `无路径: ${v?.error ?? ''}` }]
        const via = (v.via ?? []) as string[]
        const path = (v.path ?? []) as string[]
        const segs: string[] = []
        for (let i = 0; i < path.length - 1; i++) segs.push(`${path[i]} --[${via[i]}]--> ${path[i + 1]}`)
        return [{ type: 'text', text: segs.join('\n') }]
      },
    },
    async execute(args: { lib: string; from: string; to: string }) {
      const { graph, error } = loadGraph(config.kbsDir, args.lib)
      if (error) return { found: false, error }
      if (!findNode(graph, args.from)) return { found: false, error: `无起点 ${args.from}` }
      if (!findNode(graph, args.to)) return { found: false, error: `无终点 ${args.to}` }
      const r = shortestPath(graph, args.from, args.to)
      if (!r) return { found: false, error: '两节点间无路径' }
      return { found: true, path: r.path, via: r.via }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'kg_query',
    description: '结构化查询：按节点类型 + 属性条件过滤节点，可选沿边展开（outEdges 前 N）。通用查询入口——「列出某类型里满足某条件的节点及其关系」。',
    parameters: {
      lib: { type: 'string', description: '知识库名', required: true },
      type: { type: 'string', description: '节点类型过滤（如 lora/base/workflow/style；空=全部）' },
      propFilter: { type: 'object', additionalProperties: true, description: '属性过滤 {字段: 值}（如 {category: "style"}；支持数组匹配任一）' },
      limit: { type: 'number', description: '返回条数上限（默认 50）' },
      withEdges: { type: 'boolean', description: '附带每个节点的出边（默认 true）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { count: { type: 'number', required: true }, nodes: { type: 'array' } } },
      render: (_a: unknown, v: any) => {
        const nodes = (v?.nodes ?? []) as any[]
        if (nodes.length === 0) return [{ type: 'text', text: '（无匹配节点）' }]
        const text = nodes.map((n) => {
          const p = n.props ?? {}
          const key = p.name ?? n.id
          const extra = p.category ? ` [${p.category}]` : ''
          const trigger = p.trigger ? ` 触发词:${p.trigger}` : ''
          return `• ${n.type}/${key}${extra}${trigger}`
        }).join('\n')
        return [{ type: 'text', text }]
      },
    },
    async execute(args: { lib: string; type?: string; propFilter?: Record<string, unknown>; limit?: number; withEdges?: boolean }) {
      const { graph, error } = loadGraph(config.kbsDir, args.lib)
      if (error) return { count: 0, nodes: [], error }
      let nodes = graph.nodes
      if (args.type) nodes = nodes.filter((n) => n.type === args.type)
      if (args.propFilter) {
        for (const [k, val] of Object.entries(args.propFilter)) {
          nodes = nodes.filter((n) => {
            const actual = (n.props as Record<string, unknown>)[k]
            if (Array.isArray(val)) return val.includes(actual)
            return actual === val
          })
        }
      }
      const showEdges = args.withEdges !== false
      const capped = nodes.slice(0, args.limit ?? 50)
      return {
        count: nodes.length,
        nodes: capped.map((n) => ({
          id: n.id,
          type: n.type,
          props: { ...(n.props ?? {}) } as any,
          outEdges: showEdges ? graph.edges.filter((e) => e.from === n.id).slice(0, 20).map(jsonEdge) : [],
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'kg_add_node',
    description: '录入/更新一个节点（按 id upsert）。新增模型/知识时入库——知识库的写入原语。',
    parameters: {
      lib: { type: 'string', description: '知识库名', required: true },
      id: { type: 'string', description: '节点 id（唯一，如 lora/fcomic）', required: true },
      type: { type: 'string', description: '节点类型（如 lora/base/workflow/style）', required: true },
      props: { type: 'object', additionalProperties: true, description: '属性（name/category/trigger/strength/desc 等）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, error: { type: 'string' } } },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v?.ok ? '✓ 节点已写入' : `✗ ${v?.error ?? ''}` }],
    },
    async execute(args: { lib: string; id: string; type: string; props?: Record<string, unknown> }) {
      const { graph, error } = loadGraph(config.kbsDir, args.lib)
      if (error && error.includes('知识库不存在')) {
        const fresh: Graph = { nodes: [], edges: [] }
        fresh.nodes.push({ id: args.id, type: args.type, props: args.props ?? {} })
        const r = saveGraph(config.kbsDir, args.lib, fresh)
        return r.ok ? { ok: true } : { ok: false, error: r.error }
      }
      if (error) return { ok: false, error }
      const idx = graph.nodes.findIndex((n) => n.id === args.id)
      if (idx >= 0) graph.nodes[idx] = { id: args.id, type: args.type, props: args.props ?? {} }
      else graph.nodes.push({ id: args.id, type: args.type, props: args.props ?? {} })
      const r = saveGraph(config.kbsDir, args.lib, graph)
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'kg_add_edge',
    description: '录入一条边（关系）。from/to 必须已存在（否则报错）。边类型如 compatible/conflicts/produces/used_in/requires_param/trained_for。',
    parameters: {
      lib: { type: 'string', description: '知识库名', required: true },
      from: { type: 'string', description: '起点节点 id', required: true },
      to: { type: 'string', description: '终点节点 id', required: true },
      type: { type: 'string', description: '边类型（关系名）', required: true },
      props: { type: 'object', additionalProperties: true, description: '边属性（strength/note 等）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, error: { type: 'string' } } },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v?.ok ? '✓ 边已写入' : `✗ ${v?.error ?? ''}` }],
    },
    async execute(args: { lib: string; from: string; to: string; type: string; props?: Record<string, unknown> }) {
      const { graph, error } = loadGraph(config.kbsDir, args.lib)
      if (error) return { ok: false, error }
      if (!findNode(graph, args.from)) return { ok: false, error: `起点不存在: ${args.from}` }
      if (!findNode(graph, args.to)) return { ok: false, error: `终点不存在: ${args.to}` }
      if (!graph.edges.some((e) => e.from === args.from && e.to === args.to && e.type === args.type)) {
        graph.edges.push({ from: args.from, to: args.to, type: args.type, props: args.props ?? {} })
      }
      const r = saveGraph(config.kbsDir, args.lib, graph)
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'kg_schema',
    description: '查看知识库的节点类型分布与边类型分布（图 schema 概览）。',
    parameters: {
      lib: { type: 'string', description: '知识库名', required: true },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { lib: { type: 'string', required: true }, nodeTypes: { type: 'json' }, edgeTypes: { type: 'json' }, totalNodes: { type: 'number' }, totalEdges: { type: 'number' } } },
      render: (_a: unknown, v: any) => {
        const nt = Object.entries(v?.nodeTypes ?? {}).map(([k, n]) => `${k}: ${n}`).join(' · ')
        const et = Object.entries(v?.edgeTypes ?? {}).map(([k, n]) => `${k}: ${n}`).join(' · ')
        const text = `库 ${v?.lib}（${v?.totalNodes} 节点 / ${v?.totalEdges} 边）\n节点类型: ${nt}\n边类型: ${et}`
        return [{ type: 'text', text }]
      },
    },
    async execute(args: { lib: string }) {
      const { graph, error } = loadGraph(config.kbsDir, args.lib)
      if (error) return { lib: args.lib, nodeTypes: {}, edgeTypes: {}, totalNodes: 0, totalEdges: 0, error }
      const nodeTypes: Record<string, number> = {}
      for (const n of graph.nodes) nodeTypes[n.type] = (nodeTypes[n.type] ?? 0) + 1
      const edgeTypes: Record<string, number> = {}
      for (const e of graph.edges) edgeTypes[e.type] = (edgeTypes[e.type] ?? 0) + 1
      return { lib: args.lib, nodeTypes, edgeTypes, totalNodes: graph.nodes.length, totalEdges: graph.edges.length }
    },
  }))

  logger.info(`dsh-knowledge-graph ready · kbsDir=${config.kbsDir}`)
}
