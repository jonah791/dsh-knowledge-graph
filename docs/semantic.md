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
6. **I6 工具数固定 8**：`kg_libs` / `kg_lookup` / `kg_walk` / `kg_path` / `kg_query` / `kg_add_node` / `kg_add_edge` / `kg_schema`。

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
| `kg_walk` | `lib`,`start` | `edgeTypes[]`、`maxDepth`(默认3,≤6)、`direction`(`out`/`in`/`both`) | `{start, found, results[], error?}` | 起点不存在 → BFS 返回空（`found:0`）**且无 error**（与 lib 缺失不同） |
| `kg_path` | `lib`,`from`,`to` | — | `{found, path[], via[], error?}` | 起点/终点缺一 → 先报 `无起点/无终点`；无路 → `两节点间无路径` |
| `kg_query` | `lib` | `type`、`propFilter{}`、`limit`(默认50)、`withEdges`(默认true) | `{count, nodes[], error?}` | `count` = **过滤后总数**（未截断）；`nodes` 截断到 limit；每节点 `outEdges` 再截断到 20 |
| `kg_add_node` | `lib`,`id`,`type` | `props{}` | `{ok, error?}` | lib 不存在 → **自动建库**（以 `知识库不存在` 字符串判定分支）；已存在 id → 整体替换 |
| `kg_add_edge` | `lib`,`from`,`to`,`type` | `props{}` | `{ok, error?}` | from/to 不存在 → `ok:false` + 明确错误；同 `(from,to,type)` 已存在 → **跳过写入**（仍返回 `ok:true`） |
| `kg_schema` | `lib` | — | `{lib, nodeTypes{}, edgeTypes{}, totalNodes, totalEdges, error?}` | 类型分布计数（`Record<string, number>`） |

`propFilter` 匹配语义：值为数组 → `val.includes(actual)`（任一命中）；否则严格 `actual === val`（**无模糊匹配**）。
`kg_walk` 方向实现：`in` = 全部边 from/to 互换；`both` = 原边 ∪ 反向边（**同一节点对可能被访问两次但 `visited` 去重**）。

### 4.3 调用点清单 `[MUST]`
| 调用方 | 调用点（文件:符号） | 时机 |
|-------|------------------|------|
| web profile 组合 | `.dsh/profiles/web/cordis.patch.yml` 行 `id: agent-knowledge-graph` / `name: dsh-knowledge-graph`（无 config） | web 启动挂载 |
| 插件本体 | `src/index.ts:apply(ctx, config)` → `ctx.tools.register(defineTool({name:'kg_libs'…}))` | 挂载时注册 |
| 插件本体 | `src/index.ts:apply` 注册其余 7 个工具：`kg_lookup` / `kg_walk` / `kg_path` / `kg_query` / `kg_add_node` / `kg_add_edge` / `kg_schema` | 挂载时注册 |
| 插件本体 | `src/index.ts:apply` 末尾 → `logger.info('dsh-knowledge-graph ready · kbsDir=…')` | 挂载时（**logger 不落盘，非证据**） |
| 全部工具 | `src/index.ts:loadGraph(config.kbsDir, lib)` → `readFileSync(<kbsDir>/<lib>/graph.json)` | 每次调用 |
| 写工具 | `src/index.ts:saveGraph` → `writeFileSync('.graph.tmp.json')` → `renameSync(graph.json)` | `kg_add_node` / `kg_add_edge` |
| `kg_walk` | `src/index.ts:bfs(g2, start, edgeTypes, depth)` | 每次调用 |
| `kg_path` | `src/index.ts:shortestPath(graph, from, to)` | 每次调用 |
| 模型（爱丽丝） | 领域建库：`kg_add_node` / `kg_add_edge` → `kg_query` / `kg_walk` / `kg_lookup` / `kg_path` / `kg_schema` | 知识组织与查询 |
| 运行时数据（实测 2026-09-14） | 唯一库 `anima`：`kbs/anima/graph.json`（**51 节点 / 62 边**，mtime 2026-09-02） | 现状快照 |

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
| A1 | 工具面恰好 8 个 `kg_*` | `grep -c "name: 'kg_" src/index.ts` = 8 | 待验收 |
| A2 | lib 缺失必报错（不静默空图） | `kg_lookup lib=nosuch id=x` → `found:false` + error 含 `知识库不存在` | 待验收 |
| A3 | 自动建库 | `kg_add_node lib=tmp-a id=t/1 type=t` → 在 `kbs/tmp-a/graph.json` 生成文件且 `ok:true` | 待验收 |
| A4 | 原子写 | 写入过程中不存在半写的 `graph.json`（只出现 `.graph.tmp.json` 瞬时文件，最终被 rename） | 待验收 |
| A5 | 边两端校验 | `kg_add_edge from=nope to=base/anima-base type=x` → `ok:false` + `起点不存在` | 待验收 |
| A6 | 边去重 | 同一 `(from,to,type)` 连加两次 → 第二次不产生新边（`kg_schema.totalEdges` 不变） | 待验收 |
| A7 | upsert 语义 | 同 id 先写 `props{name:A}` 再写 `props{name:B}` → `kg_lookup` 只见 B（**旧 props 不合并**） | 待验收 |
| A8 | BFS 深度封顶 | `kg_walk maxDepth=99` 与 `maxDepth=6` 结果一致 | 待验收 |
| A9 | direction=in 反转 | 对 `base/anima-base` 用 `direction=in` 应能走到指向它的 LoRA（`out` 走不到） | 待验收 |
| A10 | 现状指纹 | `kg_libs` 返回 `anima` 且 `nodes=51, edges=62`（2026-09-14 实测基线） | 已实测（快照，需人工复核一致性） |
| A11 | 回归能力存在且绿 | `npm test`（= `node --test "tests/*.test.mjs"`，跑 `lib/` 产物）→ **15 pass / 0 fail** | ✅ 2026-09-14 |
| A12 | 图算法对脏数据保守（不抛） | `tests/graph.test.mjs`：缺 props 节点参与 propFilter → 视为不匹配；悬空边 → 跳过不产出 `undefined` 节点 | ✅ 2026-09-14 |
| A13 | BFS 不变量 | 起点不入结果、逐层推进、环图不重复访问、`maxDepth` 截断、未知起点返回空 | ✅ 2026-09-14 |
| A14 | `shortestPath` 边界 | 起终点相同→`null`；有向反向不可达→`null`；空图/未知节点→`null` | ✅ 2026-09-14 |
| A15 | 真实图数据零悬空边（修复不改变线上结果） | `python3 -c` 扫 `kbs/*/graph.json`（校验每边两端存在）→ anima：51 节点/62 边/**悬空边 0** | ✅ 2026-09-14 |

## 8 · 与实现的关系

- 主实现：`self-plugins/dsh-knowledge-graph/src/index.ts`（存储 IO：`loadGraph`/`saveGraph`/`listLibs` + 8 工具接线）、
  `src/graph.ts`（**纯层，零 IO**：`GraphNode/GraphEdge/Graph`、`jsonNode/jsonEdge`、`findNode`、`queryNodes`、
  `outEdgesOf`、`schemaOf`、`adjacency`、`bfs`、`shortestPath`——2026-09-14 从 `index.ts` 抽出，见 §9）。
- 测试：`tests/graph.test.mjs`（15 用例，`npm test` 跑 `lib/` 产物，与运行时同源）。
- 同语义副本：无。
- 运行时数据（**非代码**，随实现演进但独立提交）：`kbs/anima/graph.json`（51 节点 / 62 边，mtime 2026-09-02）。
- 未实现/未验证部分**显式标注**：
  - ~~**无 `tests/`**：A1–A9 待验收（A10 为实测快照）。`bfs` / `shortestPath` 是纯函数，最该先补单测。~~ 已补（A11–A15 已验证）；A1–A9 属**接线/IO** 行为（原子写、自动建库、边去重…），仍需真实调用验收。
  - README 写「典型应用（已在用）：anima 知识库 + **插件档案库**」，但全盘扫描（`Get-ChildItem -Recurse -Filter graph.json`，排除 node_modules）**只有 `kbs/anima` 一个库**——插件档案库尚未落地。
  - 无索引/无缓存：每次调用全量读 + 全量 JSON.parse（51 节点无感，量级上千时是瓶颈）。

## 9 · 实践修订记录

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

## 10 · 未决问题

- **U1 无并发控制**：读-改-写全量覆盖，多会话/分身并行写会丢更新。倾向：写入前按 mtime 做乐观锁（`if (mtime !== seenMtime) 拒绝并提示重读`）。
- **U2 `lib` 无路径校验**：`join(kbsDir, lib, 'graph.json')` 对 `lib='../../x'` 会越出 `kbsDir`。倾向：校验 `lib` 只含 `[a-z0-9_-]`，越界即拒绝。
- **U3 `kg_query` 的 error 不在 schema**：`additionalProperties:false` + 未声明 `error` → 错误路径可能被输出校验拦截。倾向：把 `error` 加进 schema（其余工具都有）。
- **U4 无 fuzzy 检索**：只有精确 id 与属性等值/包含。倾向：保持精确（检索交给 memory/code-search），或后续加 `kg_search`（子串匹配 props）。
- **U5 README 与实现漂移**：「插件档案库」未落地。倾向：要么建库，要么改 README 去掉该声明。
- **U6 无单测**：`bfs` / `shortestPath` / `path traversal` 全无覆盖。倾向：按技能 `dsh-plugin-testability` 先给这两函数补离线单测（`node --test` 跑 `lib/`）。
  → **已闭环（2026-09-14）**：`tests/graph.test.mjs` 15 用例覆盖 `bfs`/`shortestPath`/`queryNodes`/`schemaOf`/`outEdgesOf`/`adjacency`/`jsonNode`/`jsonEdge`，含失败路径；A11–A15 全绿。
- **U7 IO 层仍无测试（本次登记）**：`loadGraph`（坏 JSON/缺字段）、`saveGraph`（写失败/原子性）、`listLibs` 三条 IO 路径无离线断言——需先抽成「以注入的 fs 操作为参数」的纯函数，或改用临时目录产物断言（`os.tmpdir()` 写坏 JSON → 断言返回 `error` 而非抛）。倾向：下一轮补 `tests/io.test.mjs`（用临时目录，不碰 `kbs/`）。
- **U3 复核（2026-09-14）**：`kg_query` 的 error 路径仍不在 output schema 内（本次未动接线，仅在纯层加了脏数据防护）。
