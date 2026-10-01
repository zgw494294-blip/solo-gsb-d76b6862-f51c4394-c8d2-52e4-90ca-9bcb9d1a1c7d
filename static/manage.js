"use strict";

// 材料配方库 + 炉次草稿/归档 管理。
// 复用 app.js 中已有的工具（range/el）与结果渲染（renderResult/clearResult）。

let recipes = [];
let drafts = [];
let editingRecipeId = null;
let viewingDraftId = null;

// ---------- 通用 ----------
async function api(path, options = {}) {
  const opts = { headers: { "Content-Type": "application/json" }, ...options };
  const resp = await fetch(path, opts);
  let data = null;
  try {
    data = await resp.json();
  } catch (_) {
    data = null;
  }
  if (!resp.ok) {
    const err = new Error((data && data.detail) || `请求失败（HTTP ${resp.status}）。`);
    err.status = resp.status;
    err.data = data;
    throw err;
  }
  return data;
}

let toastTimer = null;
function toast(msg, kind = "ok") {
  const box = document.getElementById("toast");
  box.textContent = msg;
  box.className = `toast toast-${kind}`;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 3600);
}

function showError(p, msg) {
  p.textContent = msg;
  p.hidden = false;
}
function hideError(p) { p.hidden = true; }

function fmtTime(iso) {
  return iso ? iso.replace("T", " ").replace("Z", " UTC") : "—";
}

function recipeName(r) {
  return (r.name || r.name === "") && r.name.trim() ? r.name.trim() : `配方 ${r.id}（未命名）`;
}

// ---------- 标签页 ----------
document.getElementById("tabs").addEventListener("click", (ev) => {
  const btn = ev.target.closest(".tab");
  if (!btn) return;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
  ["schedule", "recipes", "drafts"].forEach((name) => {
    document.getElementById(`panel-${name}`).hidden = btn.dataset.tab !== name;
  });
  // 进入一键编排试算页：退出炉次查看上下文
  if (btn.dataset.tab === "schedule") {
    viewingDraftId = null;
    document.getElementById("result-context").hidden = true;
  }
});

// 在一键编排页操作时，离开炉次查看上下文
function bindScheduleHandoff() {
  const ctx = document.getElementById("result-context");
  const leaveDraft = () => { viewingDraftId = null; ctx.hidden = true; };
  document.getElementById("schedule-form").addEventListener("submit", leaveDraft);
  ["materials", "executed-input"].forEach((id) => {
    const node = document.getElementById(id);
    node.addEventListener("input", leaveDraft);
    node.addEventListener("change", leaveDraft);
  });
  document.getElementById("material-count").addEventListener("change", leaveDraft);
}

// ---------- 配方表单 ----------
const recipeForm = document.getElementById("recipe-form");
const rName = document.getElementById("r-name");
const rLow = document.getElementById("r-low");
const rHigh = document.getElementById("r-high");
const rDuration = document.getElementById("r-duration");
const rTolerance = document.getElementById("r-tolerance");
const recipeError = document.getElementById("recipe-error");
const recipeTitle = document.getElementById("recipe-form-title");
const recipeCancel = document.getElementById("recipe-cancel");
const recipeSaveHint = document.getElementById("recipe-save-hint");

function fillTens(sel, values, withBlank = false) {
  sel.innerHTML = "";
  if (withBlank) sel.appendChild(el("option", { value: "", textContent: "（不使用）" }));
  values.forEach((v) => sel.appendChild(el("option", { value: String(v), textContent: String(v) })));
}

function initRecipeForm() {
  fillTens(rLow, TENS_40_180);
  fillTens(rHigh, TENS_40_180);
  DURATIONS.forEach((v) =>
    rDuration.appendChild(el("option", { value: String(v), textContent: `${v} 分钟` }))
  );
  rebuildToleranceOptions(rTolerance, Number(rHigh.value), Number(rTolerance.value) || 150);
  rHigh.addEventListener("change", () =>
    rebuildToleranceOptions(rTolerance, Number(rHigh.value), Number(rTolerance.value))
  );
}

function resetRecipeForm() {
  editingRecipeId = null;
  recipeTitle.textContent = "新建材料配方";
  recipeCancel.hidden = true;
  recipeSaveHint.textContent = "保存后即可在炉次草稿中引用。";
  rName.value = "";
  rLow.value = "60";
  rHigh.value = "100";
  rDuration.value = "10";
  rebuildToleranceOptions(rTolerance, 100, 150);
  hideError(recipeError);
}

function readRecipeForm() {
  return {
    name: rName.value.trim(),
    holdLow: Number(rLow.value),
    holdHigh: Number(rHigh.value),
    duration: Number(rDuration.value),
    tolerance: Number(rTolerance.value),
  };
}

function fillRecipeForm(r) {
  rName.value = r.name || "";
  rLow.value = String(r.holdLow);
  rHigh.value = String(r.holdHigh);
  rDuration.value = String(r.duration);
  rebuildToleranceOptions(rTolerance, r.holdHigh, r.tolerance);
}

function clientValidateRecipe(p) {
  if (p.holdLow > p.holdHigh) return "保温下限不得高于保温上限。";
  if (p.tolerance < p.holdHigh) return `耐受上限不得低于保温上限（${p.holdHigh}°C）。`;
  return null;
}

recipeCancel.addEventListener("click", resetRecipeForm);

recipeForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  hideError(recipeError);
  const p = readRecipeForm();
  const verr = clientValidateRecipe(p);
  if (verr) { showError(recipeError, verr); return; }

  const btn = document.getElementById("recipe-submit");
  btn.disabled = true;
  try {
    if (editingRecipeId === null) {
      const r = await api(`/api/recipes`, { method: "POST", body: JSON.stringify(p) });
      toast(`配方 #${r.id} 已创建。`);
    } else {
      const data = await api(`/api/recipes/${editingRecipeId}`, {
        method: "PUT",
        body: JSON.stringify(p),
      });
      const n = data.recalculatedDrafts.length;
      const skipped = data.skippedArchived;
      if (n === 0) {
        toast(`配方 #${editingRecipeId} 已整份修改；没有需要重算的未归档炉次。`);
      } else {
        const vers = data.recalculatedDrafts.map((d) => `#${d.id}→v${d.version}`).join("，");
        toast(`已修改并联动重算 ${n} 个炉次（${vers}）；已归档炉次不受影响。`, "ok");
      }
      if (skipped > 0) toast(`已修改；另有 ${skipped} 个已归档炉次保持冻结。`, "ok");
    }
    resetRecipeForm();
    await Promise.all([loadRecipes(), loadDrafts()]);
    if (viewingDraftId !== null) await viewDraft(viewingDraftId);
  } catch (e) {
    showError(recipeError, e.message || "保存失败。");
  } finally {
    btn.disabled = false;
  }
});

// ---------- 配方列表 ----------
const recipeTbody = document.querySelector("#recipe-table tbody");
const recipeEmpty = document.getElementById("recipe-empty");

async function loadRecipes() {
  recipes = await api("/api/recipes");
  renderRecipeTable();
  renderDraftSelects();
}

function renderRecipeTable() {
  recipeTbody.innerHTML = "";
  recipeEmpty.hidden = recipes.length > 0;
  recipes.forEach((r) => {
    const refs = (r.draftIds || []).map((id) => `#${id}`).join("、") || "—";
    const tr = el("tr", {
      class: editingRecipeId === r.id ? "row-editing" : "",
    });
    tr.appendChild(el("td", { textContent: String(r.id) }));
    tr.appendChild(el("td", { textContent: r.name ? r.name : "（未命名）" }));
    tr.appendChild(el("td", { textContent: `${r.holdLow}～${r.holdHigh}` }));
    tr.appendChild(el("td", { textContent: String(r.duration) }));
    tr.appendChild(el("td", { textContent: String(r.tolerance) }));
    tr.appendChild(el("td", { textContent: refs }));
    const ops = el("td");
    ops.appendChild(
      el("button", {
        class: "btn-small",
        textContent: "整份修改",
        onclick: () => beginEditRecipe(r.id),
      })
    );
    tr.appendChild(ops);
    recipeTbody.appendChild(tr);
  });
}

function beginEditRecipe(id) {
  const r = recipes.find((x) => x.id === id);
  if (!r) return;
  editingRecipeId = id;
  fillRecipeForm(r);
  recipeTitle.textContent = `整份修改配方 #${id}（修改将联动重算所有未归档炉次）`;
  recipeCancel.hidden = false;
  recipeSaveHint.textContent = "提交即整份替换；非法参数不会改动任何数据。";
  hideError(recipeError);
  renderRecipeTable();
  recipeForm.scrollIntoView({ behavior: "smooth", block: "center" });
}

// ---------- 新建炉次 ----------
const draftForm = document.getElementById("draft-form");
const draftError = document.getElementById("draft-error");
const dSelects = [
  document.getElementById("draft-r1"),
  document.getElementById("draft-r2"),
  document.getElementById("draft-r3"),
];

function renderDraftSelects() {
  const prev = dSelects.map((s) => s.value);
  dSelects.forEach((sel, i) => {
    fillTens(sel, recipes.map((r) => r.id), i === 2);
    for (const r of recipes) {
      const opt = sel.querySelector(`option[value="${r.id}"]`);
      if (opt) opt.textContent = `#${r.id} ${recipeName(r)}`;
    }
    if (i === 2 && prev[2] === "" ) sel.value = "";
    else if ([...sel.options].some((o) => o.value === prev[i])) sel.value = prev[i];
  });
}

draftForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  hideError(draftError);
  const ids = dSelects.map((s) => s.value).filter((v) => v !== "").map(Number);
  if (ids.length < 2) return showError(draftError, "请选择 2～3 个配方。");
  if (new Set(ids).size !== ids.length)
    return showError(draftError, "同一炉次引用的配方必须互不相同。");

  try {
    const d = await api("/api/drafts", {
      method: "POST",
      body: JSON.stringify({ recipeIds: ids }),
    });
    toast(`炉次 #${d.id} 已创建（v1，${d.solvable ? "有解" : "无解，已记录原因"}）。`);
    await loadDrafts();
    await viewDraft(d.id);
    document.getElementById("result").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    showError(draftError, e.message || "创建失败。");
  }
});

// ---------- 炉次列表 ----------
const draftList = document.getElementById("draft-list");
const draftEmpty = document.getElementById("draft-empty");

async function loadDrafts() {
  drafts = await api("/api/drafts");
  renderDraftList();
}

function renderDraftList() {
  draftList.innerHTML = "";
  draftEmpty.hidden = drafts.length > 0;
  drafts.forEach((d) => {
    const names = d.recipeIds
      .map((rid) => {
        const r = recipes.find((x) => x.id === rid);
        return r ? `#${rid} ${recipeName(r)}` : `#${rid}`;
      })
      .join(" → ");

    const card = el("div", { class: "draft-card" + (viewingDraftId === d.id ? " active" : "") });
    const head = el("div", { class: "draft-head" });
    head.appendChild(el("span", { class: "draft-title", textContent: `炉次 #${d.id}` }));
    if (d.status === "archived") {
      head.appendChild(el("span", { class: "badge badge-archive", textContent: "已归档" }));
    } else {
      head.appendChild(el("span", { class: "badge badge-draft", textContent: "草稿" }));
    }
    head.appendChild(el("span", {
      class: "badge " + (d.solvable ? "badge-ok" : "badge-fail"),
      textContent: d.solvable ? "有解" : "无解",
    }));
    head.appendChild(el("span", { class: "draft-version", textContent: `v${d.version}` }));
    card.appendChild(head);

    card.appendChild(el("p", { class: "draft-refs", textContent: `引用配方：${names}` }));
    if (!d.solvable && d.reason)
      card.appendChild(el("p", { class: "draft-reason", textContent: `无解原因：${d.reason}` }));
    if (d.status === "archived") {
      card.appendChild(el("p", {
        class: "draft-frozen",
        textContent: `已冻结归档版本 v${d.archivedVersion}（${fmtTime(d.archivedAt)}），后续配方修改不再影响本炉次。`,
      }));
    }

    const ops = el("div", { class: "draft-ops" });
    ops.appendChild(el("button", {
      class: "btn-small",
      textContent: "查看",
      onclick: () => viewDraft(d.id),
    }));
    if (d.status === "draft" && d.solvable) {
      ops.appendChild(el("button", {
        class: "btn-small btn-primary",
        textContent: `核准归档 v${d.version}`,
        onclick: () => archiveDraft(d.id, d.version),
      }));
    }
    card.appendChild(ops);
    draftList.appendChild(card);
  });
}

// ---------- 炉次查看 / 归档 ----------
const resultContext = document.getElementById("result-context");
const ctxBody = document.getElementById("result-context-body");

async function viewDraft(id) {
  let d;
  try {
    d = await api(`/api/drafts/${id}`);
  } catch (e) {
    toast(e.message, "fail");
    return;
  }
  viewingDraftId = id;
  renderDraftList();
  renderDraftContext(d);
  clearResult();
  resultBox.hidden = false;
  if (d.solvable && d.result) {
    renderResult(d.result, d.materials);
  } else {
    resultOk.hidden = true;
    resultFail.hidden = false;
    failReason.textContent = d.reason || "当前版本无解。";
  }
}

function renderDraftContext(d) {
  ctxBody.innerHTML = "";
  const top = el("div", { class: "ctx-top" });
  top.appendChild(el("b", { textContent: `炉次 #${d.id}` }));
  if (d.status === "archived") {
    top.appendChild(el("span", { class: "badge badge-archive", textContent: "已归档（冻结）" }));
    top.appendChild(el("span", { textContent: `归档版本 v${d.archivedVersion}` }));
  } else {
    top.appendChild(el("span", { class: "badge badge-draft", textContent: "草稿" }));
  }
  top.appendChild(el("span", {
    class: "badge " + (d.solvable ? "badge-ok" : "badge-fail"),
    textContent: d.solvable ? `当前 v${d.version} 有解` : `当前 v${d.version} 无解`,
  }));
  ctxBody.appendChild(top);

  const mat = d.materials.map((m, i) => `[${i + 1}] ${m.name} ${m.holdLow}-${m.holdHigh}°C/${m.duration}min/耐受${m.tolerance}°C`).join("　");
  ctxBody.appendChild(el("p", { class: "ctx-mats", textContent: mat }));

  const meta = el("p", { class: "ctx-meta" });
  meta.appendChild(document.createTextNode(
    `引用配方 ID：${d.recipeIds.join(" → ")}（不可改）；最近更新：${fmtTime(d.updatedAt)}。`
  ));
  ctxBody.appendChild(meta);

  if (d.status === "archived") {
    ctxBody.appendChild(el("p", {
      class: "ctx-note",
      textContent: "本炉次已归档：以下曲线与材料参数为归档当时冻结的完整求解结果，之后修改配方只会影响未归档炉次。",
    }));
  } else if (d.solvable) {
    const row = el("div", { class: "ctx-actions" });
    row.appendChild(el("button", {
      class: "btn-small btn-primary",
      textContent: `核准归档（携带 v${d.version}）`,
      onclick: () => archiveDraft(d.id, d.version),
    }));
    row.appendChild(el("span", {
      class: "hint",
      textContent: "若在此期间引用的配方被修改导致版本变化，归档将返回 409 且不改变状态，重新查看最新版本后再归档即可。",
    }));
    ctxBody.appendChild(row);
  } else {
    ctxBody.appendChild(el("p", {
      class: "ctx-note ctx-note-fail",
      textContent: "当前版本无解，不能归档（提交归档会返回 422 且不改状态）。修改任一引用配方后会自动重算；旧曲线已清除，原因如上。",
    }));
  }
  resultContext.hidden = false;
}

async function archiveDraft(id, version) {
  try {
    const d = await api(`/api/drafts/${id}/archive`, {
      method: "POST",
      body: JSON.stringify({ version }),
    });
    toast(`炉次 #${id} 已归档，冻结 v${d.archivedVersion} 的材料参数与完整结果。`);
    await loadDrafts();
    await viewDraft(id);
  } catch (e) {
    if (e.status === 409) toast(`409 冲突：${e.message}`, "fail");
    else if (e.status === 422) toast(`422 无法归档：${e.message}`, "fail");
    else toast(e.message, "fail");
    // 冲突时刷新为最新版本（不改状态），便于用户重新查看后归档
    await loadDrafts();
    if (viewingDraftId !== null) await viewDraft(viewingDraftId);
  }
}

// ---------- 启动 ----------
initRecipeForm();
bindScheduleHandoff();
document.getElementById("refresh-recipes").addEventListener("click", () =>
  loadRecipes().then(() => toast("配方列表已刷新。")).catch((e) => toast(e.message, "fail"))
);
document.getElementById("refresh-drafts").addEventListener("click", () =>
  loadDrafts().then(() => toast("炉次列表已刷新。")).catch((e) => toast(e.message, "fail"))
);
(async function init() {
  try {
    await Promise.all([loadRecipes(), loadDrafts()]);
  } catch (e) {
    toast(e.message, "fail");
  }
})();
