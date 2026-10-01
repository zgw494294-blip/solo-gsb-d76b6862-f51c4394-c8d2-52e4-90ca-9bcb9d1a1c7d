# 共炉保温编排台

本地单页应用：为 2～3 种需要在同一台炉子里分别完成连续保温的材料，
编排一条满足全部约束的**最短炉温设定曲线**；长度相同取温度序列
**字典序最小**的方案。

支持**执行记录续炉判定**：可输入 1～20 个已经执行的 5 分钟炉温档位，
逐档核验合法后，以最后已执行温度接续，在 20 档总上限内编排最短且回到
20°C 的后续曲线；首个违规档即拒绝续排。

此外支持把单种材料参数沉淀为**材料配方**（沿用相同字段与校验），让多个
**炉次草稿**按顺序引用 2～3 个不同的现有配方 ID 共用；配方整份修改时，所有
引用它的**未归档**炉次在同一事务内一起重算、版本 +1（无解炉次仍保存并记录
原因、清除旧曲线）。核准后的炉次可**归档冻结**当时的材料参数、草稿版本与
完整求解结果；数据保存在服务器 SQLite，经 Docker Compose 命名卷持久化，
重启/重建容器后仍可读取。

- 后端：Python + FastAPI（求解核心见 `app/solver.py`，纯标准库 BFS）
- 前端：原生 HTML / CSS / JavaScript（`static/`，无任何前端构建与框架）
- 存储：SQLite（WAL，单连接 + 全局写锁串行化），默认文件 `/data/furnace.db`
  （可用环境变量 `DB_PATH` 覆盖）

## 一条命令启动

需要 Docker（含 Compose 插件）。

```bash
docker compose up --build -d
```

启动后浏览器访问：

- 页面：<http://localhost:8000/>
- 健康检查：<http://localhost:8000/healthz>
- 接口文档（FastAPI 自带）：<http://localhost:8000/docs>

停止：

```bash
docker compose down
```

端口在 `docker-compose.yml` 的 `ports` 中修改（宿主端口在冒号左侧）。

### 不用 Docker（可选）

裸跑时若 `/data` 不可写，数据库会落到仓库下 `data/furnace.db`；
也可用 `DB_PATH` 显式指定：

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
DB_PATH=./data/furnace.db uvicorn app.main:app --host 0.0.0.0 --port 8000
```

## 业务规则

### 材料（2～3 种）

- 保温下限 / 上限：40～180°C 的整十数，下限不高于上限；
- 连续保温时长：5、10 或 15 分钟（对应 1、2、3 个连续档位）；
- 耐受上限：不低于保温上限、至多 200°C 的整十数。

### 炉温曲线

- 炉温初态 20°C；
- 每档持续 5 分钟，设定温度为 20～200°C 的整十数；
- 首档与初态温差、相邻档温差均不超过 20°C；
- 末档必须回到 20°C；
- 所有档位温度都不得超过**任何**材料的耐受上限；
- 只有连续达到所需时长（5 分钟一档）的档位全部落在该材料的保温区间
  `[下限, 上限]` 内，该材料才算达标；
- 不同材料可以共用同一档位；材料一旦达标，后续档位对它不再有要求。

### 目标

- 总档数 ≤ 20 的前提下，求档数最少的完整曲线；
- 最短解有多条时，取温度序列字典序最小（例如先升 40°C 排在先升 60°C
  之前）；
- 有解：展示曲线图、各材料**首次达标**的连续档位区间、逐档明细表，
  以及被多种材料共用的档位；
- 无解：页面给出明确的中文原因，**不展示任何部分方案**；
- 修改任意输入后，旧结果立即清除。

### 执行记录续炉判定（可选）

- 在「已执行档位」中输入 **1～20 个**已经执行的 5 分钟炉温档位
  （20～200°C 的整十数，逗号/空格分隔）；HTTP 请求中对应
  `executedTemperatures` 字段（数组，可省略）。
- 从初态 20°C 起，按下列规则**逐档**核验已执行记录：
  - 温度必须是 20～200°C 的整十数；
  - 首档与初态、相邻档温差均不超过 20°C；
  - 每档都不得超过任何材料的耐受上限；
  - **一旦违规，立即指出首个违规档位（1-based）及原因，不给出任何续排**
    （HTTP 422，`detail` 为中文说明）。
- 合法记录逐档累计各材料的**连续**保温进度：
  - 档位落在保温区间内则进度 +1，达到所需档数即达标；
  - 档位离开区间时，**未达标者进度归零**，**已达标者保持达标**；
  - 记录中途回到 20°C 不影响合法性，后续仍可继续编排。
- 续排规则：
  - 以**最后一个已执行温度**为起点，已用档数**计入 20 档总上限**；
  - 求总档数最短、末档回到 20°C 的后续曲线；等长时取后续温度序列
    字典序最小；
  - 各材料**首次达标**区间按完整曲线（已执行 + 后续）统一编号，允许
    横跨已执行与后续档位；
  - 若已全部达标且末档已在 20°C，后续曲线为**空**；
  - 若总档数 20 以内无可行后续，返回 `solvable:false` 并明确提示，
    不展示部分曲线。

## 求解算法

在档位最多 20、温度只有 19 个整十值的规模下，直接做广度优先搜索：

- 状态 = `(当前温度, 各材料连续保温进度)`；进度为“当前已连续处于其区间
  内的档数”，达标后记为完成态；
- 从零编排：从初态 `(20, 全 0)` 出发；带执行记录时：先逐档核验并重放
  记录得到 `(最后已执行温度, 当前进度)`，再以该状态为起点；
- 按温度**升序**扩展下一档（温差 ≤ 20、不超过耐受上限）。BFS 保证
  档数最少，同层按温度升序入队保证温度序列字典序最小；
- 目标状态：当前温度回到 20°C 且所有材料均已完成；
- 扩展深度（已执行档数 + 后续档数）超过 20 即停止；搜不到目标即为无解。
- 另含一个保守的无解预检（如保温下限高于所有耐受上限的最小值），
  仅在无执行记录时使用，用于给出更具体的原因；预检通过不代表必然有解，
  最终以 BFS 为准。

## API

`POST /api/schedule`

请求体字段：

- `materials`（必填，2～3 项）：每种材料的名称与温度参数；
- `executedTemperatures`（可选）：1～20 个已执行档位温度的整数数组；
  省略或传 `[]` 表示从零编排。

### 从零编排（可直接复制执行）

```bash
curl -sS -X POST http://localhost:8000/api/schedule \
  -H 'Content-Type: application/json' \
  -d '{
    "materials": [
      {"name": "材料A", "holdLow": 60, "holdHigh": 100, "duration": 10, "tolerance": 150},
      {"name": "材料B", "holdLow": 80, "holdHigh": 120, "duration": 5,  "tolerance": 160}
    ]
  }'
```

返回（HTTP 200，节选）：

```json
{
  "solvable": true,
  "hasExecuted": false,
  "temperatures": [40, 60, 80, 60, 40, 20],
  "executedTemperatures": [],
  "continuationTemperatures": [40, 60, 80, 60, 40, 20],
  "executedCount": 0,
  "continuationCount": 6,
  "stepCount": 6,
  "totalMinutes": 30,
  "alreadyComplete": false,
  "toleranceCap": 150,
  "windows": [
    {"material": "材料A", "startStep": 2, "endStep": 3, "minutes": 10},
    {"material": "材料B", "startStep": 3, "endStep": 3, "minutes": 5}
  ]
}
```

### 带执行记录续炉（可直接复制执行）

已执行 `[40, 60, 80]` 三档：材料 A 已连续保温 2 档（区间 60～100），
材料 B 已保温 1 档（区间 80～120）。续排只需降温回 20°C：

```bash
curl -sS -X POST http://localhost:8000/api/schedule \
  -H 'Content-Type: application/json' \
  -d '{
    "materials": [
      {"name": "材料A", "holdLow": 60, "holdHigh": 100, "duration": 10, "tolerance": 150},
      {"name": "材料B", "holdLow": 80, "holdHigh": 120, "duration": 5,  "tolerance": 160}
    ],
    "executedTemperatures": [40, 60, 80]
  }'
```

返回（HTTP 200，节选）：

```json
{
  "solvable": true,
  "hasExecuted": true,
  "temperatures": [40, 60, 80, 60, 40, 20],
  "executedTemperatures": [40, 60, 80],
  "continuationTemperatures": [60, 40, 20],
  "executedCount": 3,
  "continuationCount": 3,
  "stepCount": 6,
  "totalMinutes": 30,
  "alreadyComplete": false,
  "steps": [
    {"index": 1, "temperature": 40, "deltaFromPrev": 20, "executed": true,  "phase": "executed"},
    {"index": 4, "temperature": 60, "deltaFromPrev": -20, "executed": false, "phase": "continuation"}
  ]
}
```

字段说明（续炉相关）：

| 字段 | 含义 |
| --- | --- |
| `hasExecuted` | 是否带已执行记录 |
| `executedTemperatures` / `executedCount` | 已执行档位温度与档数 |
| `continuationTemperatures` / `continuationCount` | 后续曲线温度与档数（可为空数组） |
| `alreadyComplete` | 已执行记录结束时是否已全部达标且回到 20°C（此时后续为空） |
| `steps[].executed` / `steps[].phase` | 每档属于 `executed`（已执行）还是 `continuation`（后续） |
| `windows` | 各材料首次达标区间，按**完整曲线**统一编号（允许横跨两段） |

### 已全部达标且回到 20°C —— 后续为空

```bash
curl -sS -X POST http://localhost:8000/api/schedule \
  -H 'Content-Type: application/json' \
  -d '{
    "materials": [
      {"name": "材料A", "holdLow": 60, "holdHigh": 100, "duration": 10, "tolerance": 150},
      {"name": "材料B", "holdLow": 80, "holdHigh": 120, "duration": 5,  "tolerance": 160}
    ],
    "executedTemperatures": [40, 60, 80, 100, 100, 120, 100, 80, 60, 40, 20]
  }'
```

返回（节选）：`"solvable": true, "alreadyComplete": true,
"continuationTemperatures": [], "continuationCount": 0`。

### 执行记录违规 —— HTTP 422，指出首个违规档

第 2 档由 40°C 跳到 80°C（温差 40°C > 20°C）：

```bash
curl -sS -X POST http://localhost:8000/api/schedule \
  -H 'Content-Type: application/json' \
  -d '{
    "materials": [
      {"name": "材料A", "holdLow": 60, "holdHigh": 100, "duration": 10, "tolerance": 150},
      {"name": "材料B", "holdLow": 80, "holdHigh": 120, "duration": 5,  "tolerance": 160}
    ],
    "executedTemperatures": [40, 80]
  }'
```

```json
{"detail": "已执行记录第 2 档温度 80°C 与上一档 40°C 温差 40°C，超过 20°C 上限。"}
```

超过耐受上限（所有材料耐受上限最小值为 150°C，第 7 档 160°C 违规）：

```bash
curl -sS -X POST http://localhost:8000/api/schedule \
  -H 'Content-Type: application/json' \
  -d '{
    "materials": [
      {"name": "材料A", "holdLow": 60, "holdHigh": 100, "duration": 10, "tolerance": 150},
      {"name": "材料B", "holdLow": 80, "holdHigh": 120, "duration": 5,  "tolerance": 160}
    ],
    "executedTemperatures": [40, 60, 80, 100, 120, 140, 160]
  }'
# {"detail":"已执行记录第 7 档温度 160°C 超过所有材料耐受上限的最小值 150°C。"}
```

### 无可行后续 —— HTTP 200，solvable=false

已执行档数 + 最短必要后续超过 20 档时（HTTP 200，便于页面区分“无解”与
“参数错误”）：

```json
{"solvable": false, "reason": "已执行 20 档后，在 20 档总上限内找不到满足剩余材料并回到 20°C 的后续曲线，无法续排。"}
```

参数非法（材料参数错误、已执行记录为空/超过 20 个/非整十数/越界等）
时返回 HTTP 422，`detail` 为中文错误说明。响应中**不会**附带任何部分
曲线。

## 材料配方与炉次草稿（多炉次共用、联动重算、归档）

「一键编排」（`/api/schedule`）是不落库的即时试算；需要多个炉次共用材料
参数时，使用下面的配方 / 炉次接口，数据全部保存在服务器 SQLite 中。

### 模型与规则

- **配方 Recipe** = 单种材料参数，字段与校验和 `/api/schedule` 的材料完全
  一致：`name`（可空，≤20 字符）、`holdLow`/`holdHigh`（40～180 整十，
  下限不高于上限）、`duration`（5/10/15）、`tolerance`（≥上限、≤200 的
  整十数）。
- **炉次草稿 Draft**：按**顺序**引用 **2～3 个互不相同**的**现有**配方 ID
  （`recipeIds`）。引用关系创建后**不可修改**；炉次从 **20°C 空记录**
  （无已执行档）求解，版本**从 v1 开始**。
- **整份修改配方（PUT）**：先校验新参数（非法直接 422，**不改变任何数据**），
  合法后在一个数据库事务内更新配方，并把**所有引用它的未归档炉次一起重算、
  版本各 +1**。有解则保存完整结果；**无解草稿仍保存**，但**清除旧曲线**
  （`result` 置空、`solvable=false`）并记录中文 `reason`。
- **核准归档**：请求必须携带所查看的草稿版本 `version`（乐观并发）：
  - 版本与当前不一致（期间配方被改过）→ **HTTP 409**，不改状态；
  - 版本一致但当前**无解** → **HTTP 422**，不改状态；
  - 成功 → 状态变 `archived`，**冻结**归档当时的材料参数、草稿版本
    （`archivedVersion`）和完整求解结果。此后配方再被修改只重算未归档炉次，
    已归档炉次（含曲线）完全不变。
- **并发顺序**：所有写操作由服务端同一把锁串行化，配方修改与归档按取得锁
  的先后顺序整体生效；每个炉次行把「材料参数快照 + 结果/无解原因 + 版本」
  一起原子更新，读取**绝不会**混用新参数与旧结果。

### 炉次读取结构（`GET /api/drafts/{id}`）

含状态、当前材料参数、版本、完整结果或无解原因：

```json
{
  "id": 1,
  "status": "draft",
  "version": 2,
  "recipeIds": [1, 2],
  "solvable": true,
  "reason": null,
  "materials": [
    {"name": "钢板", "holdLow": 60, "holdHigh": 100, "duration": 10, "tolerance": 150},
    {"name": "钢管", "holdLow": 80, "holdHigh": 120, "duration": 5, "tolerance": 160}
  ],
  "result": { "solvable": true, "temperatures": [40, 60, 80, 60, 40, 20], "...": "与 /api/schedule 成功响应结构一致" },
  "archivedVersion": null,
  "createdAt": "…", "updatedAt": "…", "archivedAt": null
}
```

### 配方 API 示例

```bash
# 创建配方（HTTP 201）
curl -sS -X POST http://localhost:8000/api/recipes \
  -H 'Content-Type: application/json' \
  -d '{"name":"钢板","holdLow":60,"holdHigh":100,"duration":10,"tolerance":150}'

# 列表 / 单个读取（列表中 draftIds 为当前引用该配方的炉次）
curl -sS http://localhost:8000/api/recipes
curl -sS http://localhost:8000/api/recipes/1

# 整份修改：原子联动重算所有未归档引用炉次（非法参数 422 且零改动）
curl -sS -X PUT http://localhost:8000/api/recipes/1 \
  -H 'Content-Type: application/json' \
  -d '{"name":"钢板改","holdLow":70,"holdHigh":100,"duration":10,"tolerance":150}'
# {"recipe": {...}, "recalculatedDrafts": [{"id":1,"version":2,"solvable":true,"reason":null}], "skippedArchived": 0}
```

### 炉次草稿 / 归档 API 示例

```bash
# 创建草稿：2～3 个不同的现有配方 ID，按顺序引用（HTTP 201；无解也会保存）
curl -sS -X POST http://localhost:8000/api/drafts \
  -H 'Content-Type: application/json' -d '{"recipeIds":[1,2]}'

curl -sS http://localhost:8000/api/drafts          # 列表（不含 result 大字段）
curl -sS http://localhost:8000/api/drafts/1        # 单个：状态/参数/版本/结果或原因

# 核准归档：携带所查看版本
curl -sS -X POST http://localhost:8000/api/drafts/1/archive \
  -H 'Content-Type: application/json' -d '{"version":2}'

# 期间配方被改过、版本已过期 → 409
# {"detail":"所查看的版本 v1 已过期，炉次 1 当前为 v2，请刷新查看最新结果后再归档。"}
# 当前版本无解 → 422（状态保持 draft，result 保持为空）
# 成功 → 200，status=archived，archivedVersion=2，返回冻结的完整结果
```

状态码汇总：配方/炉次不存在 → **404**；请求体字段非法 → **422**
（材料校验中文信息，不写库）；引用 ID 重复/数量不对/引用不存在 → **422**；
归档版本过期或重复归档 → **409**；归档目标无解 → **422**。

### 页面

顶部三个标签页：

1. **一键编排（含续炉）**：原有即时试算页，行为完全不变（不落库）；
2. **材料配方库**：创建配方、查看引用炉次、整份修改（保存后提示联动重算
   了哪些炉次及新版本）；
3. **炉次草稿 / 归档**：选 2～3 个配方建草稿、查看（复用曲线图与档位明细，
   上下文条显示状态/版本/冻结参数）、一键核准归档；409/422 以浮层提示并
   自动刷新到最新版本。

### 数据持久化

SQLite 文件位于容器内 `/data/furnace.db`（`docker-compose.yml` 已配置命名
卷 `furnace-data`）。执行 `docker compose down` **不会**删除卷；仅
`docker compose down -v` 才会清空数据。

```bash
docker compose up --build -d     # 首次
docker compose restart           # 重启后配方/炉次/归档仍在
docker compose down && docker compose up --build -d   # 重建容器也保留
```

## 目录结构

```
.
├── app/
│   ├── __init__.py
│   ├── main.py        # FastAPI 路由与参数校验（schedule / recipes / drafts）
│   ├── solver.py      # 规则常量、校验与 BFS 求解
│   └── store.py       # SQLite 持久化：配方/草稿/归档、联动重算与并发事务
├── static/
│   ├── index.html     # 页面（三个标签页）
│   ├── styles.css     # 样式
│   ├── app.js         # 一键编排表单、求解、结果与 SVG 曲线渲染
│   └── manage.js      # 配方库、炉次草稿、归档与版本上下文
├── Dockerfile
├── docker-compose.yml # 命名卷 furnace-data → /data
├── requirements.txt
└── README.md
```
