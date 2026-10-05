# 语义文档：dsh-knowledge-graph（通用图知识库引擎）

| 项 | 值 |
|----|----|
| 能力名 | dsh-knowledge-graph（插件内 `name = 'agent-knowledge-graph'`；组合行 id `agent-knowledge-graph`） |
| 主副本路径 | `self-plugins/dsh-knowledge-graph/docs/semantic.md` |
| 实现落点 | `self-plugins/dsh-knowledge-graph/src/index.ts`（单文件：存储层 + BFS + 8 工具） |
| 版本 | v0.1.0（package.json） |
| 状态 | **draft**（补课文档，验收条目待线上复核） |
| 依赖服务 | `inject = ['tools']`；外部依赖：**无**（本地 JSON 文件即数据库） |
| 数据落点 | `<kbsDir>/<lib>/graph.json`；`kbsDir` 默认 `E:/alice/self-plugins/dsh-knowledge-graph/kbs` |

---

## 1 · 定位与反定位

**定位**：给智能体一个**领域无关的图数据库**——任意知识按「节点 + 边」组织（`nodes[{id,type,props}]` + `edges[{from,to,type,props}]`），
支持结构化过滤查询、BFS 遍历、最短路径、单点关联查询；**库名/节点类型/边类型全部自由定义**。

**反定位（本文不管什么）**：
- 不管**时间性记忆**（那属于 `dsh-agent-memory`：fact/knowledge/episodic + 时间桶压缩）——kg 管**结构化关系**，memory 管「什么时候发生过什么」
- 不管语义检索/向量相似（本引擎是精确 id + 属性等值/包含匹配，无 fuzzy）
- 不管领域知识本身（anima 库里的 LoRA 结论属 `comfyui-guidance` 域）
- **不是** 图数据库服务（无索引、无事务、无并发控制——单文件 JSON 全量读写）

## 2 · 术语表

| 术语 | 含义 |
|------|------|
| lib（知识库） | `kbsDir` 下的一个子目录，内含 `graph.json`——一个独立图 |
| node | `{id, type, props}`；`id` 唯一（约定形如 `<type>/<name>`，如 `lora/fcomic`） |
| edge | `{from, to, type, props?}`；`from`/`to` 必须已存在（`kg_add_edge` 校验） |
| 边类型语义 | 自由定义；惯例：`compatible` / `conflicts` / `produces` / `used_in` / `requires_param` / `trained_for` |
| 原子写 | `写 .graph.tmp.json` → `renameSync` 覆盖（防半写损坏） |
| direction | `kg_walk` 的方向：`out`（默认）/ `in`（反转全部边）/ `both`（并集） |
| upsert | `kg_add_node` 按 `id` 覆盖式写入（存在则整体替换 `type+props`） |

## 3 · 概念模型

```
kbsDir（默认 = 插件仓库内 kbs/）
  └─ <lib>/graph.json   { nodes: [...], edges: [...] }
        │
        ├─ 读路径（全部工具入口）
        │    loadGraph(kbsDir, lib) → {graph, error?}
        │      ├─ 文件不存在 → EMPTY + error `知识库不存在: <lib>（<路径>）`
        │      ├─ JSON 坏/缺 nodes|edges 数组 → EMPTY + error `知识库格式错误/读取知识库失败`
        │      └─ 成功 → 原图
        │
        ├─ 查询面：kg_libs · kg_lookup · kg_query · kg_schema
        ├─ 行走面：kg_walk(bfs) · kg_path(shortestPath, BFS 无权)
        └─ 写入面：kg_add_node(upsert) · kg_add_edge(存在性校验 + 去重)
              └─ saveGraph → mkdirSync(dir) → write .graph.tmp.json → renameSync(graph.json)

bfs(graph, start, edgeTypes, maxDepth):  visited 集合去重（节点级，非路径级）+ 逐层 push
shortestPath(graph, from, to):            BFS 首次到达即返回（无权图最短）
jsonNode/jsonEdge:                        浅拷贝 props（工具返回值必须 JSON-safe）
```

不变量（invariants）：
1. **I1 单文件即库**：每个 lib 的全部数据在 `<kbsDir>/<lib>/graph.json`（无索引文件、无旁挂状态）。
2. **I2 原子写**：写入必经 tmp + rename（`grep -c "renameSync" src/index.ts` = 2：1 处 import + 1 处调用，调用点在 `saveGraph`）。
3. **I3 读失败必带 error**：`loadGraph` 三条失败路径都返回 `error` 字符串，**从不静默返回空图**。
4. **I4 边两端必须存在**：`kg_add_edge` 校验 `from`/`to`（`kg_add_node` 无此约束——它是节点的唯一入口）。
5. **I5 遍历深度封顶 6**：`kg_walk` 的 `maxDepth` 被 `Math.min(maxDepth ?? 3, 6)` 截断。
6. **I6 工具数固定 10**：`kg_libs` / `kg_lookup` / `kg_walk` / `kg_path` / `kg_query` / `kg_add_node` / `kg_add_edge` / `kg_schema` / `kg_del_node` / `kg_del_edge`。
7. **I7 无悬空边**：库中每条边的 `from`/`to` 都能在 `nodes` 里找到。添加侧由 I4 保证；**删除侧**由 `kg_del_node` 的 fail-closed 默认保证（`cascade=false` 时拒绝删除仍带边的节点）。
8. **I8 删除默认干跑 + 必留痕**：`kg_del_node` / `kg_del_edge` 的 `dryRun` 缺省 `true`；任何**真实**变更在 `<kbsDir>/kg-mutations-trace.jsonl` 追加一行摘要（`atMs` / `op` / `lib` / `target` / `cascade` / `removedEdges` / `reason`）。⚠ 留痕写失败**不改变**主操作结果（观测不反噬主流程），但在出参 `traceError?` 里如实回报。
9. **I9 出参必须是 lossless JSON**：任何工具的返回值**不得含 `undefined` 值**（可选字段只能在**有值**时出现）。DSH 管线对出参做 lossless-JSON 校验，违规会**拒绝整个返回值**——而副作用**已经发生**，用户看到的是「报错 + 数据已变」（2026-10-05 由 `kg_del_node` 的 `traceError: undefined` 触发，见 §9）。

## 4 · 契约

### 4.1 配置（`Config` schema）
| 字段 | 默认 | 说明 |
|------|------|------|
| `kbsDir` | `E:/alice/self-plugins/dsh-knowledge-graph/kbs` | 知识库根目录；web profile 的 `agent-knowledge-graph` 行**未覆盖**，故运行时即此默认值 |

### 4.2 工具签名与裁决表（逐字）
| 工具 | 必需参数 | 可选参数 | 出参 | 裁决要点 |
|------|---------|---------|------|---------|
| `kg_libs` | — | — | `{libs[], total}` | `kbsDir` 不存在 → `{libs:[], total:0}`（不报错）；只认含 `graph.json` 的子目录 |
| `kg_lookup` | `lib`,`id` | `includeEdges`(默认 true) | `{found, node, outEdges[], inEdges[], error?}` | 未找到 → `found:false` + error |
| `kg_walk` | `lib`,`start` | `edgeTypes[]`、`maxDepth`(默认3,≤6)、`direction`(`out`/`in`/`both`) | `{start, found, results[{depth,path,via,dirs,node}], error?}` | 起点不存在 → BFS 返回空（`found:0`）**且无 error**（与 lib 缺失不同）；`dirs[i]` ∈ `fwd`/`rev` = 第 i 跳在**原图**里的真实方向，渲染据此还原箭头（I9 同族：展示必须忠于数据） |
| `kg_path` | `lib`,`from`,`to` | — | `{found, path[], via[], error?}` | 起点/终点缺一 → 先报 `无起点/无终点`；无路 → `两节点间无路径` |
| `kg_query` | `lib` | `type`、`propFilter{}`、`limit`(默认50)、`withEdges`(默认true) | `{count, nodes[], error?}` | `count` = **过滤后总数**（未截断）；`nodes` 截断到 limit；每节点 `outEdges` 再截断到 20 |
| `kg_add_node` | `lib`,`id`,`type` | `props{}` | `{ok, error?}` | lib 不存在 → **自动建库**（以 `知识库不存在` 字符串判定分支）；已存在 id → 整体替换 |
| `kg_add_edge` | `lib`,`from`,`to`,`type` | `props{}` | `{ok, error?}` | from/to 不存在 → `ok:false` + 明确错误；同 `(from,to,type)` 已存在 → **跳过写入**（仍返回 `ok:true`） |
| `kg_schema` | `lib` | — | `{lib, nodeTypes{}, edgeTypes{}, totalNodes, totalEdges, error?}` | 类型分布计数（`Record<string, number>`） |
| `kg_del_node` | `lib`,`id` | `cascade`(默认 false)、`dryRun`(默认 **true**) | `{ok, dryRun, found, related[], removedEdges, traceError?, error?}` | 节点不存在 → `ok:false` + `节点不存在`；**有关联边且 `cascade=false` → `ok:false` 拒绝**（报 `related` 影响面，要求先 `kg_del_edge` 或显式 `cascade:true`）；`cascade=true` → 一并删边并报 `removedEdges`；干跑不落盘、不写 trace |
| `kg_del_edge` | `lib`,`from`,`to`,`type` | `dryRun`(默认 **true**) | `{ok, dryRun, matched, traceError?, error?}` | 精确匹配 `(from,to,type)`，**匹配多条则全删**并报 `matched`；无匹配 → `ok:false` + `无匹配边`（**不静默成功**） |

`propFilter` 匹配语义：值为数组 → `val.includes(actual)`（任一命中）；否则严格 `actual === val`（**无模糊匹配**）。
`kg_walk` 方向实现：`in` = 全部边 from/to 互换；`both` = 原边 ∪ 反向边（**同一节点对可能被访问两次但 `visited` 去重**）。⚠ **遍历用反向图、展示用原图**：`execute` 逐跳以原图边集判定 `dirs`，render 对 `rev` 跳改写为 `${下游} --[t]--> ${上游}`——**反向遍历的结果必须翻译回原始方向**，否则用户读到与盘上相反的事实（2026-10-05 缺陷 1）。

### 4.3 调用点清单 `[MUST]`
| 调用方 | 调用点（文件:符号） | 时机 |
|-------|------------------|------|
| web profile 组合 | `.dsh/profiles/web/cordis.patch.yml` 行 `id: agent-knowledge-graph` / `name: dsh-knowledge-graph`（无 config） | web 启动挂载 |
| 插件本体 | `src/index.ts:apply(ctx, config)` → `ctx.tools.register(defineTool({name:'kg_libs'…}))` | 挂载时注册 |
| 插件本体 | `src/index.ts:apply` 注册其余 9 个工具：`kg_lookup` / `kg_walk` / `kg_path` / `kg_query` / `kg_add_node` / `kg_add_edge` / `kg_schema` / `kg_del_node` / `kg_del_edge` | 挂载时注册 |
| 插件本体 | `src/index.ts:apply` 末尾 → `logger.info('dsh-knowledge-graph ready · kbsDir=…')` | 挂载时（**logger 不落盘，非证据**） |
| 全部工具 | `src/index.ts:loadGraph(config.kbsDir, lib)` → `readFileSync(<kbsDir>/<lib>/graph.json)` | 每次调用 |
| 写工具 | `src/index.ts:saveGraph` → `writeFileSync('.graph.tmp.json')` → `renameSync(graph.json)` | `kg_add_node` / `kg_add_edge` / `kg_del_node` / `kg_del_edge` |
| 留痕（删除侧） | `src/index.ts:appendTrace` → `appendFileSync(<kbsDir>/kg-mutations-trace.jsonl)` | `kg_del_node` / `kg_del_edge` 的**真实**变更各一行（干跑不写；写失败只回报 `traceError`，不改主结果） |
| `kg_walk` | `src/index.ts:bfs(g2, start, edgeTypes, depth)` | 每次调用 |
| `kg_path` | `src/index.ts:shortestPath(graph, from, to)` | 每次调用 |
| 模型（爱丽丝） | 领域建库：`kg_add_node` / `kg_add_edge` → `kg_query` / `kg_walk` / `kg_lookup` / `kg_path` / `kg_schema` | 知识组织与查询 |
| 运行时数据（实测 2026-10-05） | 共 4 库：`alice-core`(11/5)、`anima`(**71/82**)、`earn`(11/13)、`x402`(4/3)——`anima` 是主库，较 2026-09-14 基线（51/62）已增长 | 现状快照 |

## 5 · 边界与信任

- 能力边界 ≠ 沙箱：`kg_add_node` 的 `lib` 参数直接拼成目录名（`join(kbsDir, lib, 'graph.json')`）——**未做路径穿越校验**，`lib='../x'` 会写到 `kbsDir` 之外（见 §10 U2）。写入面「能创建目录、能覆盖文件」，但只能在 `kbsDir` 的**语义**内使用。
- 不越界清单：不做模糊/语义检索；不做跨库 join（一次只操作一个 lib）；不做权限/多用户（单机单用户）；不自动建边（`kg_add_edge` 不隐式建节点）。
- 失败面：
  - 读失败（不存在/坏 JSON）→ `loadGraph` **拒绝并报错**（`error` 字段），调用方各自降级（`kg_query` 返回 `count:0` + error）。
  - 写失败 → `saveGraph` 返回 `{ok:false, error}`，工具透传 `ok:false`（**放行 + 报错**）。
  - **并发写无保护**：读-改-写全量覆盖，两个并发 `kg_add_node` 会丢更新（单进程 DSH 内工具是顺序的，但多会话/分身并行时存在窗口）。
  - **`kg_query` 的 error 字段不在 output schema 里**（schema 只声明 `count`/`nodes` + `additionalProperties:false`），返回 error 可能触发严格返回值校验（见 §10 U3）。

## 6 · 与既有机制的关系

- 与 **`dsh-agent-memory`**：互补——kg 管「实体与关系的现状」（无时间维度），memory 管「事件与结论的时间线」；同一知识可两处各留一份（形态不同，不算平行维护）。
- 与 **AGENTS.md §5.20（语义文档）**：二者都是「外部持久层」，但职责不同——语义文档写「能力是什么」，kg 写「领域实体关系」。
- 与 **§5.11（组合变更必验证）**：改 `src/index.ts` → `pnpm build` → 预检看 `lib/index.js` mtime 前进。
- 与 **`dsh-comfyui` / `dsh-anima-tags`**：anima 库是生图领域的**关系索引**（LoRA↔基模↔工作流的 compatible/trained_for 关系），查图后仍需 comfyui 工具实际生成。
- 与 **`dsh-code-search`**：kg 查「我记下的关系」，code-search 查「代码里的字面量」——不互替。

**生效判据（改代码后怎么证明真的生效）**：
1. 构建产物新：`self-plugins/dsh-knowledge-graph/lib/index.js` 的 mtime **晚于**当前 web 进程启动时间（§5.11 进程级口径）。
2. 工具面在场：本会话可列出 8 个 `kg_*` 工具。
3. 行为可答：`kg_libs` 返回 `total>=1` 且含 `anima`（当前实测 51 节点/62 边）——**这个数字就是运行时指纹**，与 `kbs/anima/graph.json` 的实际节点数不符即说明读的不是这份文件。
4. 落盘产物：执行一次 `kg_add_node`（可用同一 id 覆盖写自身，零语义副作用）→ `kbs/anima/graph.json` 的 **mtime 前进**且内容可被 `JSON.parse` 解析（原子写的直接证据）。

**回退**：`git revert` 最近提交 → `pnpm build` → 预检 → 哨兵重启 web。
**数据面回退**：`kbs/<lib>/graph.json` 是普通文本文件，直接 `git checkout -- kbs/<lib>/graph.json` 即可回到上一次提交的图状态（图数据与代码同仓，天然有版本）。

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据（单测名/命令/日志行/HTTP） | 状态 |
|---|-----------|------------------------------|------|
| A1 | 工具面恰好 10 个 `kg_*` | `grep -c "name: 'kg_" src/index.ts` = 10 | ✅ 2026-10-04 |
| A2 | lib 缺失必报错（不静默空图） | `kg_lookup lib=nosuch id=x` → `found:false` + error 含 `知识库不存在` | ✅ 2026-10-05（线上调用：`未找到节点: 知识库不存在: nosuch（…\kbs\nosuch\graph.json）`） |
| A3 | 自动建库 | `kg_add_node lib=tmp-a id=t/1 type=t` → 在 `kbs/tmp-a/graph.json` 生成文件且 `ok:true` | ✅ 2026-10-05（`lib=tmp-verify-1005` → 盘上生成 133 B 合法 JSON） |
| A4 | 原子写 | 写入过程中不存在半写的 `graph.json`（只出现 `.graph.tmp.json` 瞬时文件，最终被 rename） | ⚠ 2026-10-05 **终态口径已实测**（写完扫描 `kbs/` 零 `.tmp` 残留）；**瞬时窗口未直接观测**——判据弱化，见 §10 U8 |
| A5 | 边两端校验 | `kg_add_edge from=nope to=base/anima-base type=x` → `ok:false` + `起点不存在` | ✅ 2026-10-05（线上：`✗ 起点不存在: nope`） |
| A6 | 边去重 | 同一 `(from,to,type)` 连加两次 → 第二次不产生新边（`kg_schema.totalEdges` 不变） | ✅ 2026-10-05（两次写入后 `kg_schema` 仍 `2 节点 / 1 边`） |
| A7 | upsert 语义 | 同 id 先写 `props{name:A}` 再写 `props{name:B}` → `kg_lookup` 只见 B（**旧 props 不合并**） | ✅ 2026-10-05（同 id 覆盖写 `name:A`→`name:B`，读回只见 B） |
| A8 | BFS 深度封顶 | `kg_walk maxDepth=99` 与 `maxDepth=6` 结果一致 | ✅ 2026-10-05（**深链夹具** 8 节点/7 边：`99`→d1..d6 封顶，`3`→d1..d3 ⇒ 读数不同故有区分力） |
| A9 | direction=in 反转 | 对 `base/anima-base` 用 `direction=in` 应能走到指向它的 LoRA（`out` 走不到） | ✅ 2026-10-05（真实库 anima：`out`→`found:0`，`in`→19 条入边源 ⇒ 有区分力） |
| A10 | 现状指纹 | `kg_libs` 返回 `anima` 且 `nodes=51, edges=62`（2026-09-14 实测基线） | ✅ 2026-10-05 **基线更新**：`anima` = **71 节点 / 82 边**（图在长，旧基线 51/62 已过期；库总数 4：alice-core / anima / earn / x402） |
| A11 | 回归能力存在且绿 | `npm test`（= `node --test "tests/*.test.mjs"`，跑 `lib/` 产物）→ **15 pass / 0 fail** | ✅ 2026-09-14 |
| A12 | 图算法对脏数据保守（不抛） | `tests/graph.test.mjs`：缺 props 节点参与 propFilter → 视为不匹配；悬空边 → 跳过不产出 `undefined` 节点 | ✅ 2026-09-14 |
| A13 | BFS 不变量 | 起点不入结果、逐层推进、环图不重复访问、`maxDepth` 截断、未知起点返回空 | ✅ 2026-09-14 |
| A14 | `shortestPath` 边界 | 起终点相同→`null`；有向反向不可达→`null`；空图/未知节点→`null` | ✅ 2026-09-14 |
| A15 | 真实图数据零悬空边（修复不改变线上结果） | `python3 -c` 扫 `kbs/*/graph.json`（校验每边两端存在）→ anima：51 节点/62 边/**悬空边 0** | ✅ 2026-09-14 |
| A16 | 删除原语缺省干跑（I8） | `tests/delete-shell.test.mjs`：不传 `dryRun` ⇒ 只报影响面，**文件与留痕都不动** | ✅ 2026-10-04 |
| A17 | 带边节点默认拒绝删（I7 fail-closed） | 同上：「仍有关联边且 `cascade=false` ⇒ `ok:false` + 文件不变 + 零留痕」（**尸体样本**） | ✅ 2026-10-04 |
| A18 | `cascade` 正路径不留悬空边 | 同上：`cascade=true` ⇒ 节点与关联边一并删，**盘上结果逐边校验两端存在** | ✅ 2026-10-04 |
| A19 | 真实变更必留痕 | 同上：`<kbsDir>/kg-mutations-trace.jsonl` 恰一行，含 `op` / `target` / `atMs` | ✅ 2026-10-04 |
| A20 | 无匹配边不静默成功 | 同上：`kg_del_edge` 匹配 0 条 → `ok:false` + `无匹配边` | ✅ 2026-10-04 |
| A21 | 纯层删除语义 | `tests/graph.test.mjs` 新增 7 例（自环只计一次 / 精确匹配 / 同三元组多条全删 / 不改入参 / 空图），共 **22** 例 | ✅ 2026-10-04 |
| A22 | 壳层验的是真链路而非副本 | 上述壳测试经 `apply()` **真注册**的工具执行，跑在临时 `kbsDir`（`mkdtempSync`） | ✅ 2026-10-04 |
| A23 | 方向展示忠于原始图（`in`/`both`） | `tests/walk-direction.test.mjs` W3/W4：`direction=in` 的渲染必须出现 `x --[t]--> a` 且**不得**出现 `a --[t]--> x` | ✅ 2026-10-05（先红后绿；修前线上渲染成 `base/anima-base --[compatible]--> lora/fcomic`，而盘上是反向） |
| A24 | 出参 JSON-lossless（删除成功路径） | 同上 R1/R2：递归断言返回值无 `undefined` 字段 | ✅ 2026-10-05（修前线上：`tool "kg_del_node" returned invalid output: value is not lossless JSON`，**而删除已落盘**） |
| A25 | 删除原语**线上真路径**（经工具面而非壳） | 干跑 → `dryRun:false` 拒绝 → `cascade:true` 真删 → 留痕 1 行；盘上无悬空边 | ✅ 2026-10-05（临时库实测，四条读数见 §9） |
| A26 | `kg_walk` 方向语义有回归覆盖 | W1 对照（out 只走真出边，防修过头）/ W2（in 可达）/ W3（展示）/ W4（both 混向） | ✅ 2026-10-05（4 例） |

## 8 · 与实现的关系

- 主实现：`self-plugins/dsh-knowledge-graph/src/index.ts`（存储 IO：`loadGraph`/`saveGraph`/`listLibs` + 8 工具接线）、
  `src/graph.ts`（**纯层，零 IO**：`GraphNode/GraphEdge/Graph`、`jsonNode/jsonEdge`、`findNode`、`queryNodes`、
  `outEdgesOf`、`schemaOf`、`adjacency`、`bfs`、`shortestPath`——2026-09-14 从 `index.ts` 抽出，见 §9）。
- 测试：`tests/graph.test.mjs`（**22** 用例，纯层）+ `tests/delete-shell.test.mjs`（**9** 用例，壳层，经 `apply()` 真注册 + 临时 `kbsDir`）+ `tests/walk-direction.test.mjs`（**4** 用例，方向语义）。合计 **35** 例，`node --test "tests/*.test.mjs"` 全绿（2026-10-05 实测）。
- ⚠ 壳测试 mock 了 `ctx.tools.register` 与 `ctx.logger` 两个成员 ⇒ 它验的是「注册 → execute → 文件副作用」链路，**不含** profile 挂载与工具面可见性。**后两项已于 2026-10-05 用工具面真调用补齐**（A2–A9 / A25）——也正是那次补齐抓出了两个壳测试看不见的缺陷（方向渲染 / lossless-JSON）。
- ⚠ 壳测试**直接调 `execute()`**，因此**绕过 DSH 工具管线的出参校验**（`additionalProperties:false` + lossless JSON）——A24 那类缺陷只能靠「断言返回值形状」或真调用抓到；纯壳测试永远绿。新增 R1/R2 就是把这层搬进离线可测。
- 同语义副本：无。
- 运行时数据（**非代码**，随实现演进但独立提交）：`kbs/anima/graph.json`（51 节点 / 62 边，mtime 2026-09-02）。
- 未实现/未验证部分**显式标注**：
  - ~~**无 `tests/`**：A1–A9 待验收（A10 为实测快照）。`bfs` / `shortestPath` 是纯函数，最该先补单测。~~ 已补（A11–A15 已验证）；**A1–A9 已于 2026-10-05 用工具面真调用逐条验收完毕**（读数见 §7 各行）——那次验收当场抓出两个壳测试看不见的缺陷（§9），并新增 A23–A26 锁住。
  - README 写「典型应用（已在用）：anima 知识库 + **插件档案库**」，但全盘扫描（`Get-ChildItem -Recurse -Filter graph.json`，排除 node_modules）**只有 `kbs/anima` 一个库**——插件档案库尚未落地。
  - 无索引/无缓存：每次调用全量读 + 全量 JSON.parse（51 节点无感，量级上千时是瓶颈）。

## 9 · 实践修订记录

- **2026-10-05 接线级验收：抓出两个壳测试看不见的真实缺陷**（t-10a1817f「删除能力线收尾」）
  - **触发**：核实发现三个删除原语（`kg_del_node`/`kg_del_edge`、`context_unmark`、`goal_abandon`）**均已实现**，四项判据（干跑/留痕/文档/尸体样本）代码侧齐备 ⇒ 缺口不在「没做」，而在 **A2–A9 接线级验收全空**（§8 一直写着「仍需真实调用验收」）。**验收不是走形式——第一次真调用就见了血。**
  - **缺陷 1（方向展示）**：对 anima 调 `direction=in`，返回文本渲染成 `base/anima-base --[compatible]--> lora/fcomic`，而盘上数据是 `lora/fcomic --> base/anima-base`（入边 19、出边 0）。根因：`index.ts` 反向构图做遍历（**遍历本身正确**），render 却直接按 `-->` 渲染反向路径 ⇒ **遍历语义与展示语义混为一谈**。
  - **缺陷 2（lossless-JSON，更硬）**：`cascade:true, dryRun:false` 经工具面调用返回 `Error: tool "kg_del_node" returned invalid output: value is not lossless JSON`——**而删除已经落盘**（节点与边都没了、留痕写了一行）。根因：`appendTrace` 成功时返回 `undefined`，被直接塞进出参 `traceError` ⇒ 非 lossless JSON。⇒ **「报错但数据已变」**，最能误导的一类失败（重试只会得到「节点不存在」）。
  - **修法**：① `kg_walk.execute` 增逐跳 `dirs: ('fwd'|'rev')[]`（以原图边集判定），render 据它把反向跳还原成原始方向；② 两处删除工具改为**有值才带字段**（`...(traceError === undefined ? {} : { traceError })`）。
  - **回归**：新增 `tests/walk-direction.test.mjs`（4 例，W1 是对照组防修过头）+ `delete-shell.test.mjs` 增 R1/R2（递归断言无 `undefined`）——全部**先红后绿**；用例总数 29 → **35**。
  - **可迁移教训**：① **壳测试直接调 `execute()` ⇒ 绕过 DSH 管线的出参校验**（lossless / `additionalProperties:false`），这类缺陷纯离线测试**永远绿**；要么断言返回值形状，要么真调一次。② **「遍历语义」与「展示语义」是两层**——反向遍历的结果必须翻译回原始方向，否则用户读到与数据相反的事实。③ **无 bug 的读数也可能无区分力**：A8 首次在 anima 上用 out 方向验（found=0，`99` 与 `6` 都是 0）⇒ 不算证据；改用 8 节点深链夹具有了 d6/d3 之分才算。
  - **线上真路径读数**（临时库 `tmp-verify-1005`，验后整库清除）：干跑 → `✓ [干跑] 节点存在 · 关联边 1 条（未落盘）`；`dryRun:false` → `✗ 节点仍有 1 条关联边…`（fail-closed 拒绝，文件不变）；`cascade:true` 真删 → 盘上只剩 `t/2` 且零边、无悬空边，`kg-mutations-trace.jsonl` 恰 1 行（含 `op`/`lib`/`target`/`cascade`/`removedEdges`/`reason`/`atMs`）。
  - **注**：缺陷 1 的修复**需重启 web 生效**（宿主插件非 HMR）⇒ 线上验收（新渲染文本）记于重启后，见 §10 U9。

- **2026-09-14 补课：本插件此前无语义文档（可维护性工程）**
  - 语义**被确认**：单文件即库、原子写、读失败必带 error、边两端校验、深度封顶 6、8 工具面。
  - 语义**被补充**：`kbsDir` 默认值指向**插件仓库内**目录（web profile 未覆盖 config），因此「知识库数据跟代码同仓」——这解释了为什么图数据也有 git 版本；以及唯一库 `anima` 的实际规模（51/62）。
  - 语义**被修正**：README 的「已在用：anima + 插件档案库」与实测不符（只有 anima）；`kg_add_node` 对 lib 缺失是**自动建库**（README 未提）。
  - 教训：跨插件/跨形态的**数据落点**必须写进语义文档（本次 `kbsDir` 默认在仓库内、`dataDir` 在 `$DSH_HOME`、`jobs.json` 在 `$DSH_HOME`——三个插件三种落点），否则「数据在哪」只能翻源码。

- **2026-09-14 可维护性补课（批次 W3）：图算法抽纯 + 15 测试 + 修两处脏数据崩溃**
  - 语义**被确认**：`bfs` 不含起点、逐层推进、每节点只访问一次（环安全）；`propFilter` 全等/数组任一/多键 AND 三态语义；`jsonNode/jsonEdge` 返回 `props` 副本不回写源。
  - 语义**被补充**：新增 `adjacency`（邻接表构造，`bfs` 与 `shortestPath` 共用）、`queryNodes`（`kg_query` 判定核心）、`outEdgesOf`（出边 cap=20）、`schemaOf`（`kg_schema` 判定核心）四个导出——原先这些判定逻辑藏在工具 `execute` 闭包里，**无法离线验证**。
  - 语义**被修正（真缺陷 1，先证伪后修）**：`queryNodes`（原 `kg_query` 内联）对**缺 `props` 字段的节点**执行 `(n.props)[k]` → `TypeError: Cannot read properties of undefined`。修法：`(n.props ?? {})[k]`，语义 = 属性不存在 → 不匹配（保守返回）。
  - 语义**被修正（真缺陷 2，先证伪后修）**：`adjacency`/`bfs`/`shortestPath` 对**悬空边**（`to` 指向不存在的节点）无防护——`bfs` 会产出 `{node: undefined}`（工具层读 `node.type` 即抛错），`shortestPath` 会返回通往幽灵节点的路径。修法：邻接表构造时跳过两端节点不存在的边（依据 `kg_add_edge` 的既有契约「from/to 必须已存在」⇒ 悬空边即数据腐坏）。**实测线上 anima 图 51/62 零悬空边 ⇒ 对真实数据零行为变化**。
  - 教训：**结构性防御（BFS 的 `visited`/`nodeMap`）容易让人以为「脏数据也被挡住了」**——`visited` 挡的是重复访问，不是不存在的节点；两个崩溃点都只在「图被手工改过」时才现形，且表现为工具直接抛错（不是返回错误对象），最该被单测锁住。

- **2026-10-04 删除能力补课（按理论改造基础设施 · 主人 10-03 点名「删除能力最弱」）**
  - 语义**被补充**：新增两个删除原语 `kg_del_node` / `kg_del_edge`，并立两条不变量于 §3——**I7 无悬空边**（删除侧 fail-closed）、**I8 默认干跑 + 必留痕**。
  - 设计依据：`R-004`（净收益 = Δ收益 − 持有成本 − **变更成本**）。删除能力弱 ≡ 变更成本高 ⇒ 数据只增不减是**成本结构的必然**，不是纪律问题。故删除原语的第一职责不是「能删」，而是**把变更成本压到一次调用**，同时用 fail-closed 保证不制造新腐坏。
  - 语义**被确立**：`cascade` 缺省 `false` ⇒ 带边节点**拒绝删除**并报出影响面（要求先逐条 `kg_del_edge` 或显式 `cascade:true`）。这与 `plugin_purge` 的「先出影响面再执行」同形，并与既有 I4（`kg_add_edge` 两端必须存在）配成一对：**添加侧与删除侧共同维护 I7**。
  - 教训：**「能加不能删」不是功能缺失，是成本失偏**——添加零摩擦、删除要手改 JSON，于是必然长胖。而补删除时若只做「能删」、不做「默认干跑 + 影响面 + 留痕」，只是把静默损坏从「改不动」换成「改错了也不知道」。

## 10 · 未决问题

- **U1 无并发控制**：读-改-写全量覆盖，多会话/分身并行写会丢更新。倾向：写入前按 mtime 做乐观锁（`if (mtime !== seenMtime) 拒绝并提示重读`）。
- **U2 `lib` 无路径校验**：`join(kbsDir, lib, 'graph.json')` 对 `lib='../../x'` 会越出 `kbsDir`。倾向：校验 `lib` 只含 `[a-z0-9_-]`，越界即拒绝。
- **U3 `kg_query` 的 error 不在 schema**：`additionalProperties:false` + 未声明 `error` → 错误路径可能被输出校验拦截。倾向：把 `error` 加进 schema（其余工具都有）。
- **U4 无 fuzzy 检索**：只有精确 id 与属性等值/包含。倾向：保持精确（检索交给 memory/code-search），或后续加 `kg_search`（子串匹配 props）。
- **U5 README 与实现漂移**：「插件档案库」未落地。倾向：要么建库，要么改 README 去掉该声明。
- **U6 无单测**：`bfs` / `shortestPath` / `path traversal` 全无覆盖。倾向：按技能 `dsh-plugin-testability` 先给这两函数补离线单测（`node --test` 跑 `lib/`）。
  → **已闭环（2026-09-14）**：`tests/graph.test.mjs` 22 用例覆盖 `bfs`/`shortestPath`/`queryNodes`/`schemaOf`/`outEdgesOf`/`adjacency`/`jsonNode`/`jsonEdge`，含失败路径；A11–A15 全绿。
- **U7 IO 层仍无测试（本次登记）**：`loadGraph`（坏 JSON/缺字段）、`saveGraph`（写失败/原子性）、`listLibs` 三条 IO 路径无离线断言——需先抽成「以注入的 fs 操作为参数」的纯函数，或改用临时目录产物断言（`os.tmpdir()` 写坏 JSON → 断言返回 `error` 而非抛）。倾向：下一轮补 `tests/io.test.mjs`（用临时目录，不碰 `kbs/`）。
  → **部分闭环（2026-10-04）**：`tests/delete-shell.test.mjs` 已用临时目录（`mkdtempSync`）对**删除路径**的 IO 做产物断言（写后读回、逐边校验两端存在、留痕行数），不碰 `kbs/`。仍缺：`loadGraph` 坏 JSON 与 `saveGraph` 写失败两条**失败路径**的离线断言。
- **U3 复核（2026-09-14）**：`kg_query` 的 error 路径仍不在 output schema 内（本次未动接线，仅在纯层加了脏数据防护）。
- **U8 A4 原子写的「瞬时窗口」未直接观测**（2026-10-05 登记）：判据原文要求观测「半写的 `graph.json` 不存在、只出现 `.graph.tmp.json` 瞬时文件」，实测只证明了**终态**无 `.tmp` 残留（§7 A4 已诚实弱化标注）。倾向：原子写靠 rename 语义已足够，不必加锁；要么把 A4 判据正式改写成终态口径，要么用大图 + 并发读去探瞬时窗口（成本高、收益低，暂不做）。
- **U9 缺陷 1 修复的线上验收待重启**（2026-10-05 登记）：`kg_walk` 渲染修正与删除工具出参修正均需 **web 重启**生效（宿主插件非 HMR）。重启后应复验两件：① 对 anima 调 `direction=in`，渲染须为 `lora/fcomic --[compatible]--> base/anima-base`（而非 `base/anima-base --> lora/fcomic`）；② 经工具面调 `kg_del_node`（成功路径）不再报 `not lossless JSON`。**离线已有 W3 + R1/R2 守住，线上复验是闭环最后一环。**
