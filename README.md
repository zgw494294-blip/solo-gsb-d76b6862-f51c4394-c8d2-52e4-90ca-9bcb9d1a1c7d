# 共炉保温编排台

本地单页应用：为 2～3 种需要在同一台炉子里分别完成连续保温的材料，
编排一条满足全部约束的**最短炉温设定曲线**；长度相同取温度序列
**字典序最小**的方案。

支持**执行记录续炉判定**：可输入 1～20 个已经执行的 5 分钟炉温档位，
逐档核验合法后，以最后已执行温度接续，在 20 档总上限内编排最短且回到
20°C 的后续曲线；首个违规档即拒绝续排。

- 后端：Python + FastAPI（求解核心见 `app/solver.py`，纯标准库 BFS；
  配方 / 炉次 / 归档用 SQLite 持久化，见 `app/db.py`、`app/store.py`）
- 前端：原生 HTML / CSS / JavaScript（`static/`，无任何前端构建与框架，
  页面分为「编排求解 / 材料配方 / 炉次草稿」三个标签页）

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

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
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

## 共享材料配方与炉次草稿（SQLite 持久化）

除了上面的即时编排，服务还支持把**材料参数保存为配方**，让多个**炉次草稿**
按顺序共用 2～3 个现有配方；核准的炉次方案可以**归档冻结**。数据保存在
SQLite（默认 `/data/planner.db`），Compose 以命名卷 `planner-data` 挂载，
容器重启后仍可读取。

### 材料配方 `/api/recipes`

- 字段与即时编排的材料**完全一致并复用同一套校验**：
  `name`（可留空，≤20 字）、`holdLow` / `holdHigh`（40～180°C 整十数，
  下限不高于上限）、`duration`（5/10/15 分钟）、`tolerance`（不低于保温
  上限、至多 200°C 的整十数）。
- 支持**创建、读取、整份修改**（PUT 为全量替换）。配方创建时版本为 1，
  每次成功修改版本 +1；**非法修改返回 422，不写入任何数据**（配方版本、
  引用草稿均保持原样）。

### 炉次草稿 `/api/drafts`

- 创建时按**顺序**给出 `recipeIds`：必须是 **2～3 个互不相同的现有配方
  ID**；引用一经创建**不可更改**（没有修改引用的接口）。
- 创建即**从 20°C 空记录求解**（复用原 BFS 规则），草稿**版本从 1 开始**；
  结果（有解时的完整曲线，或无解时的中文原因）与当时的材料参数快照一同
  保存。**无解草稿同样保存**，只是不保留任何曲线。
- **修改某配方时，所有引用它的“活动”草稿在同一事务里一起重算，版本各
  +1**：有解则写入新结果，无解则**清除旧曲线并记录原因**。已归档炉次不
  再受配方修改影响。
- 炉次读取（列表 / 详情）包含：`status`（`active` / `archived`）、
  引用配方与引用时版本 `recipeVersions`、草稿 `version`、求解所用
  `materials` 参数快照、`solvable`、`result`（完整求解结果）或 `reason`
  （无解原因）。活动草稿的参数与结果一定是同一次求解写入的，**不会读到
  “新参数 + 旧结果”的混合态**。

### 归档核准方案 `POST /api/drafts/{id}/archive`

请求体 `{"version": N}` 携带**你所查看的草稿版本**：

- 版本与当前不一致（期间配方被改过）→ **409**，响应体附 `currentVersion`，
  请重新读取最新参数与结果后再归档；
- 草稿当前**无解** → **422**（中文原因），**不改变任何状态**；
- 已归档 → 409；归档与配方修改并发时，由服务端按**某一先后顺序串行生效**，
  后到的归档会收到 409，先到的归档冻结旧版本；
- 成功 → 状态变为 `archived`，**冻结当时的材料参数、草稿版本与完整求解
  结果**；此后配方再怎么改，只影响其余未归档炉次。

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

其余接口（配方与炉次管理，均返回 JSON）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/recipes` | 列出全部配方 |
| POST | `/api/recipes` | 创建配方（201，版本从 1 开始） |
| GET | `/api/recipes/{id}` | 读取单个配方 |
| PUT | `/api/recipes/{id}` | 整份修改配方；原子重算引用它的活动草稿（版本 +1） |
| GET | `/api/drafts` | 列出全部炉次（含状态/参数/版本/结果或无解原因） |
| POST | `/api/drafts` | 按 2～3 个不同现有配方 ID 创建炉次并从空记录求解（201） |
| GET | `/api/drafts/{id}` | 读取炉次详情（归档后返回冻结快照） |
| POST | `/api/drafts/{id}/archive` | 携带查看版本归档（过期 409 / 无解 422） |

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

### 配方与炉次草稿（可直接复制执行）

```bash
# 1) 创建两个材料配方（版本均从 1 开始）
curl -sS -X POST http://localhost:8000/api/recipes \
  -H 'Content-Type: application/json' \
  -d '{"name":"钢甲","holdLow":60,"holdHigh":100,"duration":10,"tolerance":150}'
# {"id":1,"name":"钢甲","holdLow":60,...,"version":1,"createdAt":"...","updatedAt":"..."}

curl -sS -X POST http://localhost:8000/api/recipes \
  -H 'Content-Type: application/json' \
  -d '{"name":"铜乙","holdLow":80,"holdHigh":120,"duration":5,"tolerance":160}'

# 2) 创建炉次草稿：按顺序引用 2 个不同现有配方，从 20°C 空记录求解
curl -sS -X POST http://localhost:8000/api/drafts \
  -H 'Content-Type: application/json' \
  -d '{"name":"十月首炉","recipeIds":[1,2]}'
```

返回（HTTP 201，节选）：

```json
{
  "id": 1,
  "name": "十月首炉",
  "status": "active",
  "recipeIds": [1, 2],
  "recipeVersions": {"1": 1, "2": 1},
  "version": 1,
  "materials": [
    {"name": "钢甲", "holdLow": 60, "holdHigh": 100, "duration": 10, "tolerance": 150},
    {"name": "铜乙", "holdLow": 80, "holdHigh": 120, "duration": 5,  "tolerance": 160}
  ],
  "solvable": true,
  "result": { "solvable": true, "temperatures": [40, 60, 80, 60, 40, 20],
              "stepCount": 6, "totalMinutes": 30, "steps": [ ... ],
              "windows": [ ... ], "sharedSteps": [ ... ], "materials": [ ... ] },
  "reason": null,
  "createdAt": "...", "updatedAt": "...", "archivedAt": null
}
```

### 修改配方 → 引用草稿一起重算（版本 +1）

```bash
curl -sS -X PUT http://localhost:8000/api/recipes/1 \
  -H 'Content-Type: application/json' \
  -d '{"name":"钢甲","holdLow":70,"holdHigh":100,"duration":10,"tolerance":150}'
```

```json
{
  "recipe": { "id": 1, "holdLow": 70, "version": 2, "...": "..." },
  "recomputedDrafts": [
    { "id": 1, "status": "active", "version": 2, "solvable": true,
      "materials": [ { "holdLow": 70, "...": "..." } ],
      "result": { "...": "与 materials 同版的完整结果" } }
  ]
}
```

非法修改（如保温下限高于上限、耐受上限低于保温上限、非整十数等）返回
**422 且不改变任何数据**：配方版本不增加，引用草稿也不会被重算。
新参数导致草稿无解时，草稿仍保存：`version` 增加、`solvable:false`、
`result:null`、`reason` 为中文原因。

### 归档：携带所查看的版本

```bash
# 正常归档（当前查看的就是 v2）
curl -sS -X POST http://localhost:8000/api/drafts/1/archive \
  -H 'Content-Type: application/json' -d '{"version":2}'
# 200，节选：
# {"id":1,"status":"archived","version":2,
#  "materials":[...冻结快照...],"result":{...冻结完整结果...},
#  "archivedAt":"2026-10-01T08:00:00Z", ...}

# 期间配方被改过（草稿已到 v3），仍带 v2 归档 → 409
curl -sS -X POST http://localhost:8000/api/drafts/1/archive \
  -H 'Content-Type: application/json' -d '{"version":2}'
# 409：{"detail":{"detail":"炉次草稿已过期：你查看的是版本 2，当前为版本 3，请重新读取后再归档。",
#                 "currentVersion":3}}

# 当前无解时归档 → 422，状态不变
# 422：{"detail":"材料「钢甲」的保温下限 170°C 已高于所有材料耐受上限的最小值 160°C，..."}
```

归档成功后再次 `PUT /api/recipes/1` 只影响其他**未归档**炉次；
`GET /api/drafts/1` 永远返回归档时冻结的版本、参数与结果。

## 目录结构

```
.
├── app/
│   ├── __init__.py
│   ├── main.py        # FastAPI 路由与参数校验（schedule / recipes / drafts / archive）
│   ├── solver.py      # 规则常量、校验与 BFS 求解（配方与草稿复用）
│   ├── db.py          # SQLite 连接、建表与全局串行锁
│   └── store.py       # 配方 / 炉次草稿 / 归档的事务化读写
├── static/
│   ├── index.html     # 页面（编排求解 / 材料配方 / 炉次草稿 三个标签页）
│   ├── styles.css     # 样式
│   └── app.js         # 表单、请求、结果与 SVG 曲线渲染
├── Dockerfile
├── docker-compose.yml # 含命名卷 planner-data → /data，持久化 planner.db
├── requirements.txt
└── README.md
```

数据库路径：环境变量 `PLANNER_DB`（Compose 中为 `/data/planner.db`）；
裸跑且 `/data` 不可写时自动落到仓库内 `data/planner.db`。
