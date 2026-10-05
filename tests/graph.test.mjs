/**
 * graph.ts 纯函数套件（离线、零 IO）。
 * 覆盖：正常路径 + 失败/退化路径（悬空边、缺 props、环、空图、无路径、边界深度）。
 * 失败路径是 S6 判据——图数据脏（悬空边/缺字段）时遍历必须保守跳过，不得抛错。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY, jsonNode, jsonEdge, findNode, queryNodes, outEdgesOf, schemaOf, adjacency, bfs, shortestPath,
  edgesTouching, matchEdges, removeNode, removeEdges,
} from '../lib/graph.js'

const n = (id, type = 't', props = {}) => ({ id, type, props })
const e = (from, to, type = 'rel') => ({ from, to, type })

/** a → b → c，另有 a → d */
const CHAIN = {
  nodes: [n('a'), n('b'), n('c'), n('d')],
  edges: [e('a', 'b'), e('b', 'c'), e('a', 'd', 'other')],
}

// ---------- json 序列化 ----------

test('jsonNode/jsonEdge: props 缺失回落空对象，返回值不共享引用（不可被改脏源数据）', () => {
  const node = { id: 'x', type: 't' }
  const jn = jsonNode(node)
  assert.deepEqual(jn, { id: 'x', type: 't', props: {} })
  jn.props.injected = 1
  assert.equal(node.props, undefined, '序列化不得回写源节点')
  assert.deepEqual(jsonEdge({ from: 'a', to: 'b', type: 'r' }).props, {})
})

// ---------- 基础查询 ----------

test('findNode: 命中 / 未命中 / 空图', () => {
  assert.equal(findNode(CHAIN, 'b').type, 't')
  assert.equal(findNode(CHAIN, 'zzz'), undefined)
  assert.equal(findNode(EMPTY, 'a'), undefined)
})

test('adjacency: 无边类型过滤时含全部边；给过滤集合时只留匹配类型', () => {
  assert.equal(adjacency(CHAIN).get('a').length, 2)
  assert.deepEqual(adjacency(CHAIN, ['other']).get('a'), [{ to: 'd', type: 'other' }])
  assert.deepEqual(adjacency(CHAIN, ['nonexistent']).size, 0)
})

test('queryNodes: 类型过滤（空/未给 = 全部）', () => {
  const g = { nodes: [n('a', 'lora'), n('b', 'base')], edges: [] }
  assert.deepEqual(queryNodes(g, 'lora').map((x) => x.id), ['a'])
  assert.equal(queryNodes(g).length, 2)
  assert.equal(queryNodes(g, '').length, 2, '空字符串等同未给')
  assert.deepEqual(queryNodes(g, 'nope'), [])
})

test('queryNodes: propFilter 全等 / 数组「任一命中」/ 多键 AND', () => {
  const g = { nodes: [n('a', 'lora', { category: 'style', strength: 1 }), n('b', 'lora', { category: 'char' }), n('c', 'lora', { category: 'style', strength: 2 })], edges: [] }
  assert.deepEqual(queryNodes(g, undefined, { category: 'style' }).map((x) => x.id), ['a', 'c'])
  assert.deepEqual(queryNodes(g, undefined, { category: ['char', 'style'] }).length, 3)
  assert.deepEqual(queryNodes(g, undefined, { category: 'style', strength: 2 }).map((x) => x.id), ['c'])
  assert.equal(queryNodes(g, undefined, {}).length, 3, '空 propFilter = 不过滤')
})

test('queryNodes: 失败/脏数据路径——节点缺 props 不得抛错（视为不匹配）', () => {
  const g = { nodes: [{ id: 'dirty', type: 'lora' }, n('ok', 'lora', { category: 'style' })], edges: [] }
  assert.deepEqual(queryNodes(g, undefined, { category: 'style' }).map((x) => x.id), ['ok'])
  assert.deepEqual(queryNodes(g, undefined, { category: 'style' }).length, 1)
})

test('outEdgesOf: 只取该节点出边、按 cap 截断、无出边返回空数组', () => {
  const many = { nodes: [n('a')], edges: Array.from({ length: 25 }, (_, i) => e('a', 'n' + i)) }
  assert.equal(outEdgesOf(many, 'a').length, 20)
  assert.equal(outEdgesOf(many, 'a', 3).length, 3)
  assert.deepEqual(outEdgesOf(CHAIN, 'c'), [])
  assert.equal(outEdgesOf(CHAIN, 'a').length, 2)
})

test('schemaOf: 类型分布统计 + 空图零值（幂等）', () => {
  const g = { nodes: [n('a', 'lora'), n('b', 'lora'), n('c', 'base')], edges: [e('a', 'b', 'used_in'), e('b', 'c', 'used_in')] }
  assert.deepEqual(schemaOf(g), { nodeTypes: { lora: 2, base: 1 }, edgeTypes: { used_in: 2 }, totalNodes: 3, totalEdges: 2 })
  assert.deepEqual(schemaOf(g), schemaOf(g))
  assert.deepEqual(schemaOf(EMPTY), { nodeTypes: {}, edgeTypes: {}, totalNodes: 0, totalEdges: 0 })
})

// ---------- BFS ----------

test('bfs: 逐层可达 + 路径/via 记录 + 不含起点', () => {
  const { results } = bfs(CHAIN, 'a', [], 3)
  const ids = results.map((r) => r.node.id)
  assert.deepEqual(ids, ['b', 'd', 'c'])
  const c = results.find((r) => r.node.id === 'c')
  assert.deepEqual(c.path, ['a', 'b', 'c'])
  assert.deepEqual(c.via, ['rel', 'rel'])
  assert.equal(c.depth, 2)
  assert.ok(!ids.includes('a'), '起点不得出现在结果里')
})

test('bfs: maxDepth 截断 / 边类型过滤 / 未知起点 / 空图', () => {
  assert.deepEqual(bfs(CHAIN, 'a', [], 1).results.map((r) => r.node.id), ['b', 'd'])
  assert.deepEqual(bfs(CHAIN, 'a', ['other'], 5).results.map((r) => r.node.id), ['d'])
  assert.deepEqual(bfs(CHAIN, 'missing', [], 5).results, [])
  assert.deepEqual(bfs(EMPTY, 'a', [], 5).results, [])
})

test('bfs: 环图不无限循环、每节点只访问一次', () => {
  const cyc = { nodes: [n('a'), n('b'), n('c')], edges: [e('a', 'b'), e('b', 'c'), e('c', 'a')] }
  assert.deepEqual(bfs(cyc, 'a', [], 99).results.map((r) => r.node.id), ['b', 'c'])
})

test('bfs: 失败/脏数据路径——悬空边（to 指向不存在的节点）必须被跳过，不得产出 undefined 节点', () => {
  const dangling = { nodes: [n('a')], edges: [e('a', 'ghost')] }
  const { results } = bfs(dangling, 'a', [], 3)
  assert.deepEqual(results, [], '悬空边的目标节点不存在 → 不得进入结果（否则渲染层读 node.type 会抛错）')
})

// ---------- shortestPath ----------

test('shortestPath: 取最短路径与途经边类型', () => {
  const g = { nodes: [n('a'), n('b'), n('c'), n('d')], edges: [e('a', 'b', 'x'), e('b', 'c', 'y'), e('a', 'c', 'z')] }
  assert.deepEqual(shortestPath(g, 'a', 'c'), { path: ['a', 'c'], via: ['z'] })
  assert.deepEqual(shortestPath(g, 'a', 'b'), { path: ['a', 'b'], via: ['x'] })
})

test('shortestPath: 边界与失败路径——起终点相同/无路径/未知节点/环图均返回 null 或终止不挂死', () => {
  assert.equal(shortestPath(CHAIN, 'a', 'a'), null, '起终点相同返回 null（不是空路径）')
  assert.equal(shortestPath(CHAIN, 'c', 'a'), null, '图是有向的，反向不可达')
  assert.equal(shortestPath(CHAIN, 'ghost', 'a'), null)
  assert.equal(shortestPath(EMPTY, 'a', 'b'), null)
  const cyc = { nodes: [n('a'), n('b')], edges: [e('a', 'b'), e('b', 'a')] }
  assert.deepEqual(shortestPath(cyc, 'a', 'b'), { path: ['a', 'b'], via: ['rel'] })
  const dangling = { nodes: [n('a')], edges: [e('a', 'ghost')] }
  assert.equal(shortestPath(dangling, 'a', 'ghost'), null, '悬空边不得被判为路径')
})

test('shortestPath: 幂等——同输入重复调用结果一致（无隐藏状态）', () => {
  const g = { nodes: [n('a'), n('b'), n('c')], edges: [e('a', 'b'), e('b', 'c')] }
  assert.deepEqual(shortestPath(g, 'a', 'c'), shortestPath(g, 'a', 'c'))
})

// ---------- 删除（I7 无悬空边：删除侧 fail-closed）----------

test('edgesTouching: 出边/入边分别收集，自环只计一次（不落进入边）', () => {
  const g = { nodes: [n('a'), n('b'), n('c')], edges: [e('a', 'b'), e('c', 'a', 'in'), e('a', 'a', 'self')] }
  const t = edgesTouching(g, 'a')
  assert.deepEqual(t.out.map((x) => x.to), ['b', 'a'])
  assert.deepEqual(t.in.map((x) => x.from), ['c'], '自环已由出边覆盖')
})

test('removeNode 尸体样本：仍有关联边且 cascade=false ⇒ 返回 null（fail-closed）', () => {
  assert.equal(removeNode(CHAIN, 'a', false), null, '有关联边必须拒绝，宁可不删也不留悬空边')
})

test('removeNode cascade=true：节点与全部关联边一并移除，结果无悬空边', () => {
  const r = removeNode(CHAIN, 'a', true)
  assert.deepEqual(r.graph.nodes.map((x) => x.id), ['b', 'c', 'd'],
    'd 节点仍在：删 a 只带走 a→d 这条边，不带走 d 本身（边 ≠ 节点）')
  assert.equal(r.graph.edges.length, 1, 'a 的 2 条出边被删，剩 b→c')
  assert.equal(r.removedEdges.length, 2)
  const ids = new Set(r.graph.nodes.map((x) => x.id))
  for (const ed of r.graph.edges) assert.ok(ids.has(ed.from) && ids.has(ed.to), 'I7：结果不得含悬空边')
})

test('removeNode 金标准：无边节点直接删；纯函数不改入参', () => {
  const g = { nodes: [n('x'), n('y')], edges: [] }
  const r = removeNode(g, 'x', false)
  assert.deepEqual(r.graph.nodes.map((x) => x.id), ['y'])
  assert.equal(g.nodes.length, 2, '入参不得被改动')
})

test('removeEdges: 精确匹配 (from,to,type)；类型不符 ⇒ 空 removed 且图不变', () => {
  const r1 = removeEdges(CHAIN, 'a', 'b', 'rel')
  assert.equal(r1.removed.length, 1)
  assert.equal(r1.graph.edges.length, 2)
  const r2 = removeEdges(CHAIN, 'a', 'b', 'WRONG_TYPE')
  assert.equal(r2.removed.length, 0, '调用方据此报错，不静默成功')
  assert.equal(r2.graph.edges.length, 3)
})

test('removeEdges: 同 (from,to,type) 多条 ⇒ 全删', () => {
  const g = { nodes: [n('a'), n('b')], edges: [e('a', 'b'), e('a', 'b'), e('a', 'b', 'other')] }
  const r = removeEdges(g, 'a', 'b', 'rel')
  assert.equal(r.removed.length, 2)
  assert.equal(r.graph.edges.length, 1)
})

test('matchEdges: 空图 / 不存在 ⇒ 空数组', () => {
  assert.deepEqual(matchEdges(EMPTY, 'a', 'b', 'r'), [])
  assert.deepEqual(matchEdges(CHAIN, 'a', 'zzz', 'rel'), [])
})
