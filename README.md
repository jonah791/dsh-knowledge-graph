# dsh-knowledge-graph


<p align="center">
  <a href="https://github.com/jonah791/dsh-knowledge-graph"><img src="https://img.shields.io/badge/version-0.1.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
</p>
> 通用图知识库引擎：多知识库挂载 + 图遍历查询（节点/边/路径）。
> DeepSeek Harness 自研插件 · v0.1.0

## 定位

给智能体一个**领域无关的图数据库**——任意知识（LoRA 经验、插件档案、领域模型）按「节点 + 边」组织，支持结构化查询、图遍历、最短路径，让知识不仅可检索，还可「关联行走」。

## 功能特性

- **多知识库挂载**：`kg_libs` 列出全部知识库及其规模；每个库是一个独立图（如 anima / wq / plugins）
- **节点/边原语**：`kg_add_node`（按 id upsert）、`kg_add_edge`（节点间关系，from/to 必须已存在）
- **结构化查询**：`kg_query` 按节点类型 + 属性过滤，沿边展开；`kg_schema` 查看节点/边类型分布
- **图遍历与路径**：`kg_walk`（从起点沿边类型 BFS）、`kg_path`（两点间最短路径）、`kg_lookup`（单节点详情+关联边）
- **任意领域可用**：库名/节点类型/边类型全部自由定义

## 安装

```bash
git clone https://github.com/jonah791/dsh-knowledge-graph.git self-plugins/dsh-knowledge-graph
cd self-plugins/dsh-knowledge-graph && pnpm install && pnpm build
```

挂载到 web profile。组合行 id：`agent-knowledge-graph`。

## 使用（工具面）

| 工具 | 用途 |
|------|------|
| `kg_libs` | 列出全部知识库及规模 |
| `kg_schema` | 知识库节点/边类型分布 |
| `kg_add_node` | 录入/更新节点（按 id upsert） |
| `kg_add_edge` | 录入边（关系），from/to 必须存在 |
| `kg_lookup` | 精确查节点 + 关联边 |
| `kg_query` | 结构化过滤查询（类型+属性，沿边展开） |
| `kg_walk` | 图遍历（BFS，指定边类型/深度/方向） |
| `kg_path` | 两点间最短路径 |

**典型应用**（已在用）：anima 知识库（LoRA/基模/工作流的 relation 图谱）、插件档案库。

## 配置

无（开箱即用，库动态创建）。

## 技术要点

- 图引擎通用——不绑定任何领域，库/类型/边自由定义
- 边类型语义化（compatible/conflicts/produces/used_in/requires_param/trained_for 等）
- 与 dsh-agent-memory（记忆联想）互补：memory 管「时间性记忆」，kg 管「结构化关系」

## License

MIT