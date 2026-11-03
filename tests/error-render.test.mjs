/**
 * 读数显形：`kg_query` / `kg_schema` 在「读不到」时不得渲染成「是空的」。
 *
 * 病症（2026-11-03 实测）：`loadGraph` 早已把四种情况分得开（不存在 / 格式错 / 读失败 / 正常），
 * 但两个工具的 `render` 没看 `v.error` ——
 *   · kg_query  : `if (nodes.length === 0) return '（无匹配节点）'` ⇒ error 被吞
 *   · kg_schema : 完全不判 error ⇒ 渲染成「库 X（0 节点 / 0 边）」
 * ⇒ 用户读到的是「这个库是空的」，与「这个库根本不存在」同形。
 *
 * 判据三条：
 *   ① 四种 error 各自显形（不合并成一个形状）
 *   ② error 时返回值不得携带假零值（totalNodes: 0 之类）
 *   ③ **对照组**：真的空库必须仍然显示空、不得报错（防修法过头把正常空库也报错）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../lib/index.js'

function harness() {
  const kbsDir = mkdtempSync(join(tmpdir(), 'kg-err-'))
  const tools = new Map()
  // cordis 的 ctx.logger 既可被调用也可直接 .info ⇒ mock 同时满足两种形状
  const logger = Object.assign(() => logger, { info() {}, warn() {}, error() {}, debug() {} })
  apply({ tools: { register: (t) => tools.set(t.name, t) }, logger }, { kbsDir })
  return {
    kbsDir,
    tools,
    /** 造一个指定内容的库 */
    makeLib(name, content) {
      mkdirSync(join(kbsDir, name), { recursive: true })
      writeFileSync(join(kbsDir, name, 'graph.json'), content, 'utf-8')
    },
    cleanup: () => rmSync(kbsDir, { recursive: true, force: true }),
  }
}

/** render 返回 [{type:'text',text}]，拼成纯文本便于断言 */
const textOf = (tool, value) =>
  (tool.output.render({}, value) ?? []).map((p) => p.text ?? '').join('\n')

// ---------- kg_query ----------

test('kg_query：库不存在时 render 必须显形，不得说「无匹配节点」', async () => {
  const h = harness()
  const t = h.tools.get('kg_query')
  const v = await t.execute({ lib: 'no-such-lib' })
  assert.ok(v.error, 'execute 必须带 error（基线：这一层现在就是对的）')
  const text = textOf(t, v)
  assert.notEqual(text, '（无匹配节点）', '「库不存在」≠「库里没有匹配」')
  assert.match(text, /知识库不存在/, 'render 必须把 error 原话说出来')
  h.cleanup()
})

test('kg_query：格式错误也显形（与「不存在」不合并成同一句话）', async () => {
  const h = harness()
  h.makeLib('bad-shape', JSON.stringify({ foo: 1 }))
  const t = h.tools.get('kg_query')
  const v = await t.execute({ lib: 'bad-shape' })
  assert.ok(v.error, 'execute 必须带 error')
  const text = textOf(t, v)
  assert.match(text, /知识库格式错误/, 'render 必须显示格式错误，不能显示「无匹配节点」')
  assert.doesNotMatch(text, /知识库不存在/, '三种 error 不得合并成一个形状')
  h.cleanup()
})

// ---------- kg_schema ----------

test('kg_schema：库不存在时 render 必须显形，且不得渲染成「0 节点 / 0 边」', async () => {
  const h = harness()
  const t = h.tools.get('kg_schema')
  const v = await t.execute({ lib: 'no-such-lib' })
  assert.ok(v.error, 'execute 必须带 error')
  const text = textOf(t, v)
  assert.match(text, /知识库不存在/, 'render 必须把 error 原话说出来')
  assert.doesNotMatch(text, /0 节点 \/ 0 边/, '「读不到」不得渲染成「是空的」')
  h.cleanup()
})

test('kg_schema：error 时返回值不携带假零值（调用方不会把 0 当读数）', async () => {
  const h = harness()
  const t = h.tools.get('kg_schema')
  const v = await t.execute({ lib: 'no-such-lib' })
  assert.equal(v.totalNodes, undefined, 'error 时不得给 totalNodes: 0——那是个假读数')
  assert.equal(v.totalEdges, undefined, 'error 时不得给 totalEdges: 0')
  assert.deepEqual(v.nodeTypes, undefined, 'error 时不得给空的 nodeTypes')
  h.cleanup()
})

// ---------- 对照组（防修法过头） ----------

test('对照组：真的空库必须仍然显示「空」，不得被当成错误', async () => {
  const h = harness()
  h.makeLib('empty-lib', JSON.stringify({ nodes: [], edges: [] }))

  const q = h.tools.get('kg_query')
  const qv = await q.execute({ lib: 'empty-lib' })
  assert.equal(qv.error, undefined, '空库不是错误')
  assert.equal(textOf(q, qv), '（无匹配节点）', '空库照旧显示无匹配')

  const s = h.tools.get('kg_schema')
  const sv = await s.execute({ lib: 'empty-lib' })
  assert.equal(sv.error, undefined, '空库不是错误')
  assert.match(textOf(s, sv), /0 节点 \/ 0 边/, '空库照旧显示 0 节点 0 边')
  h.cleanup()
})

test('对照组：有数据的库正常渲染（不因新增 error 分支而串扰正常路径）', async () => {
  const h = harness()
  h.makeLib('ok-lib', JSON.stringify({
    nodes: [{ id: 'a', type: 'lora', props: { name: 'A' } }],
    edges: [],
  }))
  const s = h.tools.get('kg_schema')
  const sv = await s.execute({ lib: 'ok-lib' })
  assert.equal(sv.error, undefined)
  assert.equal(sv.totalNodes, 1)
  const text = textOf(s, sv)
  assert.match(text, /1 节点/, '正常路径的总数必须真的来自数据')
  assert.match(text, /lora: 1/, '节点类型分布必须出现')
  h.cleanup()
})
