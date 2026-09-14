/**
 * dsh-knowledge-graph — 图算法与纯查询层（零 IO，可离线单测）
 *
 * 2026-09-14 可维护性补课：BFS/最短路径/属性过滤/schema 统计原先都在 index.ts 里
 * （与 ctx.tools.register 混写、未导出），无法离线验证「图有脏数据会怎样」。
 * 本次**仅搬家**（行为逐字不变）——IO（loadGraph/saveGraph/listLibs）留在 index.ts。
 *
 * 不变量（tests/graph.test.mjs 锁住）：
 *   1. 遍历不因悬空边（to 指向不存在的节点）抛错——该边被静默跳过（BFS 用 nodeMap 判定）
 *   2. BFS 结果**不含起点**（depth>0 才入 results），且按深度层次推进、每节点只访问一次（环安全）
 *   3. `propFilter` 全等匹配；值为数组时按「包含任一」匹配；空对象 = 不过滤
 *   4. `shortestPath` 起点==终点返回 null（不是空路径），无路径返回 null
 */

// ---------- 图数据模型 ----------

export interface GraphNode {
  id: string
  type: string
  props: Record<string, unknown>
}
export interface GraphEdge {
  from: string
  to: string
  type: string
  props?: Record<string, unknown>
}
export interface Graph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export const EMPTY: Graph = { nodes: [], edges: [] }

// ---------- JSON-safe 序列化（DSH 工具返回值必须 JsonValue 兼容） ----------

export function jsonNode(n: GraphNode): any {
  return { id: n.id, type: n.type, props: { ...(n.props ?? {}) } }
}
export function jsonEdge(e: GraphEdge): any {
  return { from: e.from, to: e.to, type: e.type, props: { ...(e.props ?? {}) } }
}

// ---------- 查询 ----------

export function findNode(graph: Graph, id: string): GraphNode | undefined {
  return graph.nodes.find((n) => n.id === id)
}

/** 按类型 + 属性条件过滤节点（kg_query 的判定核心） */
export function queryNodes(graph: Graph, type?: string, propFilter?: Record<string, unknown>): GraphNode[] {
  let nodes = graph.nodes
  if (type) nodes = nodes.filter((n) => n.type === type)
  if (propFilter) {
    for (const [k, val] of Object.entries(propFilter)) {
      nodes = nodes.filter((n) => {
        // `?? {}`：脏数据（节点缺 props 字段/被手改为 null）下不得抛 TypeError，
        // 语义 = 该属性不存在 → 不匹配（保守返回）。
        const actual = (n.props ?? {})[k]
        if (Array.isArray(val)) return val.includes(actual)
        return actual === val
      })
    }
  }
  return nodes
}

/** 某节点的出边（上限 cap 条，默认 20） */
export function outEdgesOf(graph: Graph, id: string, cap = 20): GraphEdge[] {
  return graph.edges.filter((e) => e.from === id).slice(0, cap)
}

/** 节点类型 / 边类型分布统计（kg_schema 的判定核心） */
export function schemaOf(graph: Graph): {
  nodeTypes: Record<string, number>
  edgeTypes: Record<string, number>
  totalNodes: number
  totalEdges: number
} {
  const nodeTypes: Record<string, number> = {}
  for (const n of graph.nodes) nodeTypes[n.type] = (nodeTypes[n.type] ?? 0) + 1
  const edgeTypes: Record<string, number> = {}
  for (const e of graph.edges) edgeTypes[e.type] = (edgeTypes[e.type] ?? 0) + 1
  return { nodeTypes, edgeTypes, totalNodes: graph.nodes.length, totalEdges: graph.edges.length }
}

// ---------- 图遍历 ----------

/** 邻接表（可按边类型过滤；edgeTypes 为空 = 全部边）
 *
 * 2026-09-14 修复：**跳过两端节点不存在的悬空边**（`kg_add_edge` 的契约是「from/to 必须已存在」，
 * 悬空边 = 数据腐坏，如手改 JSON / 删节点未删边）。原实现在 BFS 里会给悬空目标产出
 * `{node: undefined}` → 工具层 `node.type` 抛错；在 shortestPath 里会返回通往「幽灵节点」的路径。
 * 实测线上 kbs/anima 图（51 节点/62 边）**零悬空边**，故本修复对真实数据零行为变化。 */
export function adjacency(graph: Graph, edgeTypes: string[] = []): Map<string, { to: string; type: string }[]> {
  const known = new Set(graph.nodes.map((n) => n.id))
  const adj = new Map<string, { to: string; type: string }[]>()
  for (const e of graph.edges) {
    if (edgeTypes.length > 0 && !edgeTypes.includes(e.type)) continue
    if (!known.has(e.from) || !known.has(e.to)) continue
    if (!adj.has(e.from)) adj.set(e.from, [])
    adj.get(e.from)!.push({ to: e.to, type: e.type })
  }
  return adj
}

/** BFS：从起点沿指定边类型集合遍历，返回可达节点 + 路径 */
export function bfs(graph: Graph, start: string, edgeTypes: string[], maxDepth: number): {
  results: { node: GraphNode; depth: number; path: string[]; via: string[] }[]
} {
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]))
  const adj = adjacency(graph, edgeTypes)
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
export function shortestPath(graph: Graph, from: string, to: string): { path: string[]; via: string[] } | null {
  const adj = adjacency(graph)
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
