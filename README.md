<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 通用图知识库引擎：多知识库挂载（<kbsDir>/<lib>/graph.json 单文件 JSON）+ 图查询（库清单/类型分布/节点详情/结构化过滤/BFS 遍历/最短路径/写节点/写边），库名与节点/边类型全部自由定义；写路径原子落盘（.graph.tmp.json → rename）
  inject: 'tools'
  tools: kg_libs,kg_schema,kg_lookup,kg_query,kg_walk,kg_path,kg_add_node,kg_add_edge
  runtime: host-only
  envDeps: 无（纯 Node fs；零常驻服务、零索引、零网络）
  boundary: 单文件 JSON 全量读写——无索引/无事务/无并发控制（多实例同写 = 最后写赢）；精确 id + 属性等值/包含匹配，无 fuzzy 与向量相似；不是时间性记忆（「什么时候发生过什么」属 dsh-agent-memory）；无侧车轨迹层（已知缺口，见「落盘与自证」）
  compat: cordis ^4.0.1 / schemastery ^3.18.1-rc.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-knowledge-graph

<p align="center">
  <a href="https://github.com/jonah791/dsh-knowledge-graph"><img src="https://img.shields.io/badge/version-0.1.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-15%20passed-brightgreen" alt="tests">
</p>

**一句话**：给 agent 一个**领域无关的图数据库**——任意知识按「节点 + 边」组织（`nodes[{id,type,props}]` + `edges[{from,to,type,props}]`），8 个工具做「列库 / 看类型分布 / 查节点 / 过滤查询 / BFS 遍历 / 最短路径 / 写节点 / 写边」；库名、节点类型、边类型**全部自由定义**。

**为什么值得用**：记忆库管「什么时候发生过什么」，「谁跟谁有什么关系」它答不了——用长文本硬塞关系，模型只能靠翻页碰运气。本插件把关系**显式建图**：一次 `kg_walk` 就能答「A 能到达什么」（带深度与边类型过滤），一次 `kg_path` 就能答「A 和 B 怎么连上」（无权图最短路径）。零索引、零服务：一个库就是磁盘上一个人可以 `cat` 的 JSON 文件——坏了能看懂，拷走即迁移。

## 能力

| 工具 | 用途 |
|------|------|
| `kg_libs` | 列出全部知识库及规模（节点/边计数）——「我有哪些库」 |
| `kg_schema` | 某库的**节点类型分布 + 边类型分布**（图 schema 概览） |
| `kg_lookup` | 按 id 精确查一个节点及其**直接关联边**（出边/入边，`includeEdges` 缺省 `true`） |
| `kg_query` | 结构化查询：节点类型过滤 + 属性过滤（`propFilter`，支持数组「匹配任一」）+ 可选沿边展开（`withEdges`，出边上限 20），`limit` 缺省 50 |
| `kg_walk` | 图遍历：从起点沿指定边类型 BFS（`maxDepth` 缺省 3、`direction` = `out`/`in`/`both`），返回可达节点与深度 |
| `kg_path` | 两节点间**最短路径**（无权图 BFS），返回路径与途经边类型 |
| `kg_add_node` | 录入/更新一个节点（按 id **upsert**） |
| `kg_add_edge` | 录入一条边；**from/to 必须已存在**，否则显式报错（不制造悬空边） |

**失败与「没有」分离**：库不存在 → `知识库不存在: <lib>（<path>）`（带路径，可直接核盘）；库文件损坏 → JSON 解析错误原文；节点/边不存在 → 明确报错；查询无命中 → 空数组，**不报错**。

## 快速开始

**1) 装依赖**：

```jsonc
"dsh-knowledge-graph": "link:<工作区>/self-plugins/dsh-knowledge-graph"
```

**2) 挂组合**（建议显式配 `kbsDir`——默认值指向插件仓库内部的绝对路径）：

```yaml
- id: knowledge-graph
  name: dsh-knowledge-graph
  config:
    kbsDir: <数据目录>/kbs   # 每个库一个子目录：<kbsDir>/<lib>/graph.json
```

**3) 30 秒验证**：调 `kg_libs` → 期望返回库清单（本机为 `anima`）；调 `kg_schema {lib:'anima'}` → 期望节点/边类型分布非空；调 `kg_lookup {lib:'anima', id:'<任一节点 id>'}` → 期望返回节点 + 关联边。三者都返回而非报错 = 引擎在工作。

## 配置

| 项 | 默认 | 说明 |
|----|------|------|
| `kbsDir` | `E:/alice/self-plugins/dsh-knowledge-graph/kbs` | 知识库根目录；库 = 其下一个子目录，数据文件固定名 `graph.json`。**默认值是插件仓库内的绝对路径**——换机器/换工作区必须显式配置，否则库会跟着插件目录走 |
| `enabled` | `true` | 组合级开关：停用请走 preset 行的 `disabled: true` |

## 落盘与自证（出问题时先看这里）

**唯一持久产物就是库文件本身**：`<kbsDir>/<lib>/graph.json`。写路径**原子落盘**（先写同目录 `.graph.tmp.json`，再 rename 覆盖）——不会留下半截 JSON。

> **已知缺口（如实声明）**：本插件**没有侧车轨迹层**（不落 `<DSH_HOME>/*-trace.jsonl`）、也没有 build 自报——这是可维护性体检（S4 证据层）残留的缺口。下表五问按「能与不能」如实标注，不粉饰：

| 五问 | 现状 | 怎么答 |
|------|------|--------|
| ① 线上跑的是哪个构建 | ❌ 不能（无 build 自报） | 退而对照 `lib/index.js` 的 mtime 与 web 进程启动时间 |
| ② 谁发起 / 调了什么 | ❌ 不能（无轨迹） | 只有库文件的**最终状态**（谁写的、何时写的都不留痕） |
| ③ 断在哪一段 | ⚠ 部分能 | 报错文案三类可判：`知识库不存在: <lib>（<path>）` / `graph.json 解析失败` / `要求两端已存在`；工具返回带 `error` 即为失败，空结果不是失败 |
| ④ 结果质量 | ✅ 能 | `kg_libs`（库清单 + 节点/边计数）+ `kg_schema`（类型分布）——**一次调用即实测**，不依赖任何日志 |
| ⑤ 耗时与预算 | ❌ 不能（未埋点） | 单文件 JSON 全量读写，库在本机这个量级（`anima` 23,643 字节）可忽略 |

本机实测（2026-09-14）：`kbs/` 下 1 个库 `anima`，`graph.json` 23,643 字节。

## 生效判据与回退

**生效判据**（三选一，按可靠性排序）：
1. 行为级：`kg_libs` 返回**含你的库**（一次真实调用即判真假——工具在 = 插件在）；
2. 生态级：`plugin_boot_status`（`dsh-plugin-bootreport`）的 `liveNow` 含本插件；
3. 进程级：`lib/index.js` 的 mtime **早于** 3080 监听进程的启动时间 ⇒ 进程在跑当前构建。

> 注意：**重新构建 ≠ 生效**——产物 mtime 新只证明「构建过」，进程启动时间晚于产物 mtime 才算「在跑它」。

**回退**（三档）：
- 组合级：preset 给该行加 `disabled: true`（或删行）→ 8 个工具从工具面消失，**数据文件原封不动**（最轻的一档，推荐）；
- 源码级：`git -C self-plugins/dsh-knowledge-graph revert <commit>` → 重新构建 → 预检 → 哨兵重启；
- 数据级：库是纯 JSON，删 `<kbsDir>/<lib>/` 即删库——**不可逆**，删前先拷一份（本引擎没有软删除与归档）。

## 测试

```bash
npm test        # = node --test "tests/*.test.mjs"
```

**15 例离线测试**（`tests/graph.test.mjs`，全部打在 `src/graph.ts` 纯层上：零 IO、零夹具、一次跑完 <100ms），覆盖：
- 查询层 — `findNode` 命中/未命中、`queryNodes` 类型过滤 + `propFilter`（等值/数组匹配任一）、`outEdgesOf` 的 cap 边界、`jsonNode`/`jsonEdge` 形状投影；
- 遍历层 — `adjacency`（含边类型过滤）、`bfs` 深度与方向语义、`shortestPath` 的**四个边界**（起终点相同 / 无路径 / 未知节点 / 环图 → 返回 `null` 或正常终止，不挂死）、**幂等**（同输入重复调用结果一致，无隐藏状态）；
- 脏数据层 — **悬空边（`to` 指向不存在的节点）必须跳过**，不得产出 `undefined` 节点；`schemaOf` 在缺字段/空图下不崩。

**无网络、无宿主依赖**：算法全在纯层，测试不需要挂载插件。

## 设计要点

- **算法与存储分层**（`src/graph.ts` 143 行纯算法 / `src/index.ts` 存储 IO + 工具接线）：这是「可测」与「可维护」的前提——纯层零 IO 才能 15 例离线覆盖；IO 层只干三件事 `loadGraph`/`saveGraph`/`listLibs`。**新增算法请放纯层，不要写进工具闭包。**
- **脏数据必须被跳过，不许崩**：图上任何一环都可能被手写错（悬空边、自环、缺 `type`）。`bfs`/`shortestPath` 对悬空边**跳过**、对环图靠 `visited` 收敛——这条来自实测修复（`e2c7a2f` 修了两处脏数据崩溃）。
- **原子写**：`.graph.tmp.json` → rename。半截 JSON 比没有 JSON 更糟（下次 load 直接解析失败，而原数据已毁）。
- **单文件 JSON 是取舍，不是妥协**：换来「人来可读、`git diff` 可看、拷走即迁移」；代价是无索引/无事务/无并发控制——**多实例同时写 = 最后写赢**，需要强一致请换真图数据库。
- **写入按 id upsert**：`kg_add_node` 同 id 覆盖即更新（不产生重复节点）；`kg_add_edge` 严格要求两端已存在——**先把点建出来，再连边**。
- **缺自证轨迹层**（见上）：本插件是「数据即状态」型，状态文件自证**结果**，但不自证**过程**（谁改的、断在哪一步）。补轨迹层已列入待办。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位（与 memory 的分工）、术语表、概念模型、配置 schema、**工具签名与裁决表（逐字）**、调用点清单、边界与信任、可证伪验收 A1–A15、实践修订记录、未决问题 U1–U7 |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `plugin-maintainability` | 插件可维护性工程（自证轨迹 / 五问判据 / 观测不反噬）——**本插件残留的 S4 缺口就是这份判据照出来的** |
| 技能 `dsh-plugin-testability` | 把决策逻辑抽成纯层并配离线单测的方法（与本插件 `graph.ts` 同源） |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态。
