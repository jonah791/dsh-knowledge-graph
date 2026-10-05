/**
 * 壳层验收：**真调 apply 注册的工具**（mock ctx + 临时 kbsDir，零真实资产）。
 * 覆盖 I7（无悬空边 / fail-closed）与 I8（默认干跑 + 必留痕）在**真实 IO 链路**上的行为。
 * ⚠ 未覆盖（诚实标注）：profile 挂载、工具面可见性 —— 那两项待挂载后线上验收。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../lib/index.js'

function harness() {
  const kbsDir = mkdtempSync(join(tmpdir(), 'kg-del-'))
  const tools = new Map()
  // cordis 的 ctx.logger 既可被调用（取子 logger）也可直接 .info ⇒ mock 同时满足两种形状
  const logger = Object.assign(() => logger, { info() {}, warn() {}, error() {}, debug() {} })
  apply({ tools: { register: (t) => tools.set(t.name, t) }, logger }, { kbsDir })
  const libDir = join(kbsDir, 't1')
  mkdirSync(libDir, { recursive: true })
  writeFileSync(join(libDir, 'graph.json'), JSON.stringify({
    nodes: [{ id: 'a', type: 'x', props: {} }, { id: 'b', type: 'x', props: {} }, { id: 'c', type: 'x', props: {} }],
    edges: [{ from: 'a', to: 'b', type: 'r' }, { from: 'b', to: 'c', type: 'r' }],
  }, null, 2), 'utf-8')
  return {
    kbsDir, tools, libDir,
    graph: () => JSON.parse(readFileSync(join(libDir, 'graph.json'), 'utf-8')),
    traceLines: () => {
      const p = join(kbsDir, 'kg-mutations-trace.jsonl')
      return existsSync(p) ? readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean) : []
    },
    cleanup: () => rmSync(kbsDir, { recursive: true, force: true }),
  }
}

test('apply 注册 10 个 kg_* 工具（含两个删除原语）', () => {
  const h = harness()
  assert.equal(h.tools.size, 10)
  assert.ok(h.tools.has('kg_del_node') && h.tools.has('kg_del_edge'))
  h.cleanup()
})

test('I8 默认干跑：不传 dryRun 时只报影响面，文件与留痕都不动', async () => {
  const h = harness()
  const before = readFileSync(join(h.libDir, 'graph.json'), 'utf-8')
  const r = await h.tools.get('kg_del_node').execute({ lib: 't1', id: 'a' })
  assert.equal(r.ok, true)
  assert.equal(r.dryRun, true, '缺省必须干跑')
  assert.equal(r.related.length, 1, 'a 有 1 条关联边')
  assert.equal(readFileSync(join(h.libDir, 'graph.json'), 'utf-8'), before, '干跑不得改文件')
  assert.equal(h.traceLines().length, 0, '干跑不得留痕')
  h.cleanup()
})

test('I7 尸体样本：仍有关联边且 cascade=false ⇒ 拒绝，且文件不变', async () => {
  const h = harness()
  const before = readFileSync(join(h.libDir, 'graph.json'), 'utf-8')
  const r = await h.tools.get('kg_del_node').execute({ lib: 't1', id: 'a', dryRun: false })
  assert.equal(r.ok, false, 'fail-closed：必须拒绝')
  assert.match(r.error, /关联边/)
  assert.equal(readFileSync(join(h.libDir, 'graph.json'), 'utf-8'), before, '拒绝时不得改文件')
  assert.equal(h.traceLines().length, 0, '拒绝不得留痕')
  h.cleanup()
})

test('cascade=true 正路径：删节点+关联边，落盘且无悬空边，并留痕一行', async () => {
  const h = harness()
  const r = await h.tools.get('kg_del_node').execute({ lib: 't1', id: 'a', cascade: true, dryRun: false, reason: '测试' })
  assert.equal(r.ok, true)
  assert.equal(r.removedEdges, 1)
  const g = h.graph()
  assert.deepEqual(g.nodes.map((n) => n.id), ['b', 'c'])
  assert.equal(g.edges.length, 1, 'a→b 已删，剩 b→c')
  const ids = new Set(g.nodes.map((n) => n.id))
  for (const e of g.edges) assert.ok(ids.has(e.from) && ids.has(e.to), 'I7：盘上结果不得含悬空边')
  const tr = h.traceLines()
  assert.equal(tr.length, 1, 'I8：真实变更必须留痕')
  const rec = JSON.parse(tr[0])
  assert.equal(rec.op, 'del_node')
  assert.equal(rec.target, 'a')
  assert.ok(rec.atMs > 0)
  h.cleanup()
})

test('kg_del_edge：无匹配 ⇒ ok:false（不静默成功）；干跑与真实删分别正确', async () => {
  const h = harness()
  const miss = await h.tools.get('kg_del_edge').execute({ lib: 't1', from: 'a', to: 'c', type: 'r', dryRun: false })
  assert.equal(miss.ok, false)
  assert.match(miss.error, /无匹配边/)
  const dry = await h.tools.get('kg_del_edge').execute({ lib: 't1', from: 'a', to: 'b', type: 'r' })
  assert.equal(dry.ok, true)
  assert.equal(dry.dryRun, true)
  assert.equal(h.graph().edges.length, 2, '干跑不改')
  const real = await h.tools.get('kg_del_edge').execute({ lib: 't1', from: 'a', to: 'b', type: 'r', dryRun: false })
  assert.equal(real.ok, true)
  assert.equal(real.matched, 1)
  assert.equal(h.graph().edges.length, 1)
  h.cleanup()
})

test('删除不存在的节点 ⇒ ok:false + 明确错误（不静默成功）', async () => {
  const h = harness()
  const r = await h.tools.get('kg_del_node').execute({ lib: 't1', id: 'nope', dryRun: false })
  assert.equal(r.ok, false)
  assert.equal(r.found, false)
  assert.match(r.error, /节点不存在/)
  h.cleanup()
})

test('库不存在 ⇒ 读失败必带 error（I3）', async () => {
  const h = harness()
  const r = await h.tools.get('kg_del_node').execute({ lib: 'nosuch', id: 'a', dryRun: false })
  assert.equal(r.ok, false)
  assert.match(r.error, /知识库不存在/)
  h.cleanup()
})

/**
 * 判据：返回值必须 **JSON-lossless** —— 递归找不到 `undefined` 值。
 *
 * 起因（2026-10-05 接线级验收）：`cascade` 真删通过**工具面**调用时返回
 * `Error: tool "kg_del_node" returned invalid output: value is not lossless JSON`，
 * 而删除**已经落盘**（盘上节点与边都没了、留痕也写了一行）——
 * 用户看到「失败」但数据已变，是最危险的组合（重试只会得到「节点不存在」）。
 *
 * 壳测试此前**直接调 execute()**，绕过了 DSH 工具管线的 lossless 校验 ⇒ 全绿却线上不可用。
 * 这里补的正是那层：断言返回值本身没有 undefined（与线上症状同源的根因）。
 */
function firstUndefined(v, path = '') {
  if (v === undefined) return path || '(root)'
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const p = firstUndefined(v[i], `${path}[${i}]`)
      if (p) return p
    }
    return null
  }
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) {
      const p = firstUndefined(v[k], `${path}.${k}`)
      if (p) return p
    }
    return null
  }
  return null
}

test('R1 删节点成功路径的返回值不得含 undefined 字段（lossless-JSON 判据）', async () => {
  const h = harness()
  const del = await h.tools.get('kg_del_node').execute({ lib: 't1', id: 'c', cascade: true, dryRun: false })
  assert.equal(del.ok, true)
  const bad = firstUndefined(del)
  assert.equal(bad, null, `返回值含 undefined 字段: ${bad}`)
  h.cleanup()
})

test('R2 删边成功路径的返回值不得含 undefined 字段（同一根因的第二处）', async () => {
  const h = harness()
  const r = await h.tools.get('kg_del_edge').execute({ lib: 't1', from: 'a', to: 'b', type: 'r', dryRun: false })
  assert.equal(r.ok, true)
  const bad = firstUndefined(r)
  assert.equal(bad, null, `返回值含 undefined 字段: ${bad}`)
  h.cleanup()
})
