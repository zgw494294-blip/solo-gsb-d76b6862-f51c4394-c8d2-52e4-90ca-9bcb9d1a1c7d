"""端到端冒烟：配方 CRUD、草稿、联动重算、归档并发与持久化。

直接运行（需要 fastapi + httpx）：
    python3 tests/smoke_e2e.py
"""
import os, sys, tempfile, json
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

tmp = tempfile.mkdtemp()
os.environ["DB_PATH"] = os.path.join(tmp, "test.db")

from fastapi.testclient import TestClient
from app.main import app
c = TestClient(app)

def show(label, r):
    print(f"== {label}: HTTP {r.status_code}")
    try:
        print(json.dumps(r.json(), ensure_ascii=False)[:600])
    except Exception:
        print(r.text[:200])
    return r

# 1) 旧 /api/schedule 保持可用（含续炉）
r = show("schedule 从零", c.post("/api/schedule", json={"materials": [
    {"name": "A", "holdLow": 60, "holdHigh": 100, "duration": 10, "tolerance": 150},
    {"name": "B", "holdLow": 80, "holdHigh": 120, "duration": 5, "tolerance": 160}]}))
assert r.status_code == 200 and r.json()["solvable"]
r = c.post("/api/schedule", json={"materials": [
    {"name": "A", "holdLow": 60, "holdHigh": 100, "duration": 10, "tolerance": 150},
    {"name": "B", "holdLow": 80, "holdHigh": 120, "duration": 5, "tolerance": 160}],
    "executedTemperatures": [40, 60, 80]})
assert r.status_code == 200 and r.json()["continuationTemperatures"] == [60, 40, 20]

# 2) 创建 3 个配方
r1 = show("创建配方1", c.post("/api/recipes", json={
    "name": "钢板A", "holdLow": 60, "holdHigh": 100, "duration": 10, "tolerance": 150}))
id1 = r1.json()["id"]
r2 = show("创建配方2", c.post("/api/recipes", json={
    "name": "钢管B", "holdLow": 80, "holdHigh": 120, "duration": 5, "tolerance": 160}))
id2 = r2.json()["id"]
r3 = show("创建配方3(可能无解组合)", c.post("/api/recipes", json={
    "name": "高温C", "holdLow": 170, "holdHigh": 180, "duration": 15, "tolerance": 180}))
id3 = r3.json()["id"]

# 非法配方：温度非整十 -> 422，且数据不变
r = show("非法配方(非整十)", c.post("/api/recipes", json={
    "name": "X", "holdLow": 65, "holdHigh": 100, "duration": 10, "tolerance": 150}))
assert r.status_code == 422
r = show("非法配方(下限>上限)", c.put(f"/api/recipes/{id1}", json={
    "name": "钢板A", "holdLow": 120, "holdHigh": 100, "duration": 10, "tolerance": 150}))
assert r.status_code == 422

# 3) 创建草稿：2 个不同配方；重复/不存在/数量不对都 422
r = show("草稿(重复ID)", c.post("/api/drafts", json={"recipeIds": [id1, id1]}))
assert r.status_code == 422
r = show("草稿(不存在)", c.post("/api/drafts", json={"recipeIds": [id1, 9999]}))
assert r.status_code == 422
r = show("草稿(1个)", c.post("/api/drafts", json={"recipeIds": [id1]}))
assert r.status_code == 422
d1 = show("创建草稿1(1,2)", c.post("/api/drafts", json={"recipeIds": [id1, id2]}))
draft1 = d1.json()
assert draft1["version"] == 1 and draft1["status"] == "draft" and draft1["solvable"]
seq_v1 = draft1["result"]["temperatures"]
d2 = show("创建草稿2(3,1 高温组合)", c.post("/api/drafts", json={"recipeIds": [id3, id1]}))
draft2 = d2.json()
# 170 保温需要 climb 8 档*2 + 3 = 19 <= 20，检查实际
print("draft2 solvable:", draft2["solvable"], draft2.get("reason"))

# 4) 整份修改配方1 -> 引用它的两个未归档草稿一起重算、版本+1
r = show("修改配方1", c.put(f"/api/recipes/{id1}", json={
    "name": "钢板A2", "holdLow": 60, "holdHigh": 90, "duration": 10, "tolerance": 140}))
assert r.status_code == 200
rec = {d["id"]: d for d in r.json()["recalculatedDrafts"]}
assert rec[draft1["id"]]["version"] == 2
assert rec[draft2["id"]]["version"] == 2
g1 = c.get(f"/api/drafts/{draft1['id']}").json()
assert g1["version"] == 2 and g1["materials"][0]["name"] == "钢板A2"
assert g1["result"]["temperatures"] is not None  # 参数与结果同版本
# 旧曲线已被新结果替换
print("v2 seq:", g1["result"]["temperatures"])

# 5) 把配方改成无解参数（下限 170 > 两配方耐受上限最小值 160）
#    -> 无解草稿仍保存，清旧曲线，记原因，版本+1
r = show("配方1改为无解", c.put(f"/api/recipes/{id1}", json={
    "name": "钢板A3", "holdLow": 170, "holdHigh": 180, "duration": 5, "tolerance": 180}))
assert r.status_code == 200
rec = {d["id"]: d for d in r.json()["recalculatedDrafts"]}
assert rec[draft1["id"]]["solvable"] is False
g1 = c.get(f"/api/drafts/{draft1['id']}").json()
assert g1["version"] == 3 and not g1["solvable"] and g1["result"] is None and g1["reason"]

# 6) 归档：过期 409 / 无解 422 / 成功 200
r = show("归档过期版本", c.post(f"/api/drafts/{draft1['id']}/archive", json={"version": 2}))
assert r.status_code == 409
r = show("归档当前但无解", c.post(f"/api/drafts/{draft1['id']}/archive", json={"version": 3}))
assert r.status_code == 422, "无解归档应 422"
g1b = c.get(f"/api/drafts/{draft1['id']}").json()
assert g1b["status"] == "draft", "失败不改状态"

# 恢复配方1使草稿1有解
c.put(f"/api/recipes/{id1}", json={
    "name": "钢板A", "holdLow": 60, "holdHigh": 100, "duration": 10, "tolerance": 150})
g1 = c.get(f"/api/drafts/{draft1['id']}").json()
assert g1["solvable"], "应恢复有解"
v = g1["version"]
r = show("归档成功", c.post(f"/api/drafts/{draft1['id']}/archive", json={"version": v}))
assert r.status_code == 200 and r.json()["status"] == "archived"
assert r.json()["archivedVersion"] == v
frozen_seq = r.json()["result"]["temperatures"]
frozen_mat = r.json()["materials"]

# 重复归档 -> 409
r = show("重复归档", c.post(f"/api/drafts/{draft1['id']}/archive", json={"version": v}))
assert r.status_code == 409

# 7) 归档后再改配方1：已归档炉次冻结，未归档炉次继续重算
r = c.put(f"/api/recipes/{id1}", json={
    "name": "钢板A改", "holdLow": 70, "holdHigh": 110, "duration": 10, "tolerance": 150})
assert r.status_code == 200
assert r.json()["skippedArchived"] >= 1
a1 = c.get(f"/api/drafts/{draft1['id']}").json()
assert a1["status"] == "archived" and a1["version"] == v
assert a1["materials"] == frozen_mat and a1["result"]["temperatures"] == frozen_seq
g2 = c.get(f"/api/drafts/{draft2['id']}").json()
assert g2["version"] == v + 1, "未归档炉次应继续重算"

# 8) 404
assert c.get("/api/recipes/9999").status_code == 404
assert c.put("/api/recipes/9999", json={
    "name": "X", "holdLow": 60, "holdHigh": 100, "duration": 10, "tolerance": 150}).status_code == 404
assert c.get("/api/drafts/9999").status_code == 404

# 9) 重启可读：重新连同一 DB 文件
from app.store import Store
s2 = Store(os.environ["DB_PATH"])
import app.main as m
m.store = s2  # 仅测试用
recs = s2.list_recipes(); drafts = s2.list_drafts()
assert len(recs) == 3 and len(drafts) == 2
a2 = s2.get_draft(draft1["id"])
assert a2["status"] == "archived" and a2["result"]["temperatures"] == frozen_seq
print("\n全部断言通过 ✔  重启后配方数:", len(recs), " 炉次数:", len(drafts))
