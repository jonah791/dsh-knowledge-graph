/**
 * 壳层验收：kg_walk 方向语义（W1–W4）。
 *
 * 起因（2026-10-05 接线级验收）：对真实库 anima 调 `direction=in` 时，返回文本渲染成
 * `base/anima-base --[compatible]--> lora/fcomic`，而盘上数据是 `lora/fcomic --> base/anima-base`。
 * 遍历本身正确（反向构图），**展示方向与数据相反** ⇒ 用户读到的是「我指向它」。
 * 此前 `tests/` 对 kg_walk 零覆盖（grep 'direction|walk' 无命中）。
 *
 * 判据分工：W1 是对照组（防修过头：out 仍须为 0），W2 测遍历，W3 测展示，W4 测 mixed。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../lib/index.js'

/** 图形状刻意复刻 anima 的 base/anima-base：三条边指向 a、a 只有一条出边。 */
function harness() {
  const kbsDir = mkdtempSync(join(tmpdir(), 'kg-walk-'))
  const tools = new Map()
  const logger = Object.assign(() => logger, { info() {}, warn() {}, error() {}, debug() {} })
  apply({ tools: { register: (t) => tools.set(t.name, t) }, logger }, { kbsDir })
  const libDir = join(kbsDir, 't1')
  mkdirSync(libDir, { recursive: true })
  writeFileSync(join(libDir, 'graph.json'), JSON.stringify({
    nodes: [
      { id: 'a', type: 'base', props: {} },
      { id: 'x', type: 'lora', props: {} },
      { id: 'y', type: 'lora', props: {} },
      { id: 'z', type: 'workflow', props: {} },
    ],
    edges: [
      { from: 'x', to: 'a', type: 'compatible' },
      { from: 'y', to: 'a', type: 'compatible' },
      { from: 'a', to: 'z', type: 'uses_base' },
    ],
  }, null, 2), 'utf-8')
  return { kbsDir, tools, cleanup: () => rmSync(kbsDir, { recursive: true, force: true }) }
}

const textOf = (tool, args, v) => tool.output.render(args, v).map((s) => s.text).join('\n')

test('W1 对照组：out 方向下 a 只有 1 条出边 ⇒ 可达 1 个（不是 0，也不是 3）', async () => {
  const h = harness()
  const tool = h.tools.get('kg_walk')
  const args = { lib: 't1', start: 'a', direction: 'out' }
  const r = await tool.execute(args)
  assert.equal(r.found, 1, 'a 的出边只有 a→z')
  assert.equal(r.results[0].path.at(-1), 'z')
  assert.deepEqual(r.results[0].dirs, ['fwd'], 'out 方向每跳都是正向')
  h.cleanup()
})

test('W2 in 方向：反向可达 2 个（x、y 都指向 a），且每跳标注为 rev', async () => {
  const h = harness()
  const tool = h.tools.get('kg_walk')
  const args = { lib: 't1', start: 'a', direction: 'in' }
  const r = await tool.execute(args)
  assert.equal(r.found, 2, 'in 方向应走到 x 与 y，不含 z')
  assert.deepEqual(r.results.map((x) => x.dirs[0]).sort(), ['rev', 'rev'])
  h.cleanup()
})

test('W3 尸体样本：in 方向渲染必须忠于原始图方向（显示 x --> a，不得显示 a --> x）', async () => {
  const h = harness()
  const tool = h.tools.get('kg_walk')
  const args = { lib: 't1', start: 'a', direction: 'in' }
  const text = textOf(tool, args, await tool.execute(args))
  assert.match(text, /(x|y) --\[compatible\]--> a/, '必须出现原始方向 x --> a')
  assert.doesNotMatch(text, /a --\[compatible\]--> (x|y)/, '不得把反向跳渲染成正向（这正是被修的缺陷）')
  h.cleanup()
})

test('W4 both 方向：正向与反向逐跳区分（同一结果集内混有两支）', async () => {
  const h = harness()
  const tool = h.tools.get('kg_walk')
  const args = { lib: 't1', start: 'a', direction: 'both', maxDepth: 1 }
  const r = await tool.execute(args)
  assert.equal(r.found, 3, '正向 z + 反向 x/y')
  const dirs = r.results.map((x) => x.dirs[0])
  assert.ok(dirs.includes('fwd'), 'a→z 应标 fwd')
  assert.ok(dirs.includes('rev'), 'x/y→a 应标 rev')
  h.cleanup()
})
