"use strict";

// ---------- 常量 ----------
const TENS_40_180 = range(40, 180, 10);
const DURATIONS = [5, 10, 15];
const PALETTE = ["#1d6fa8", "#1b9e77", "#d95f02", "#7570b3"];

const DEFAULTS = [
  { name: "材料A", holdLow: 60, holdHigh: 100, duration: 10, tolerance: 150 },
  { name: "材料B", holdLow: 80, holdHigh: 120, duration: 5, tolerance: 160 },
  { name: "材料C", holdLow: 50, holdHigh: 90, duration: 15, tolerance: 140 },
];

const EMPTY_RESULT = {
  name: "",
  holdLow: 60,
  holdHigh: 100,
  duration: 10,
  tolerance: 150,
};

// ---------- 工具 ----------
function range(a, b, step) {
  const out = [];
  for (let v = a; v <= b; v += step) out.push(v);
  return out;
}

function el(tag, opts = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(opts)) {
    if (k === "class") node.className = v;
    else if (k === "attrs") Object.entries(v).forEach(([ak, av]) => node.setAttribute(ak, av));
    else node[k] = v;
  }
  children.filter(Boolean).forEach((c) =>
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c)
  );
  return node;
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
  return node;
}

async function api(path, options = {}) {
  const resp = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  let data = null;
  try {
    data = await resp.json();
  } catch (e) {
    data = {};
  }
  return { ok: resp.ok, status: resp.status, data };
}

function detailOf(data) {
  if (!data) return "请求失败。";
  if (typeof data.detail === "string") return data.detail;
  if (data.detail && typeof data.detail === "object" && data.detail.detail) return data.detail.detail;
  return "请求失败。";
}

function field(label, control) {
  return el("label", { class: "field" },
    el("span", { class: "field-label", textContent: label }), control);
}

function tensSelect(value, values, key, idx) {
  const sel = el("select", { attrs: { "data-key": key, "data-idx": String(idx) } });
  values.forEach((v) => sel.appendChild(el("option", { value: String(v), textContent: String(v) })));
  sel.value = String(value);
  return sel;
}

function rebuildToleranceOptions(sel, holdHigh, current) {
  sel.innerHTML = "";
  for (let v = holdHigh; v <= 200; v += 10) {
    sel.appendChild(el("option", { value: String(v), textContent: String(v) }));
  }
  sel.value = String(current >= holdHigh ? current : holdHigh);
}

// 单个「材料字段」行（无标题色条，供配方表单与即时表单共用）
function materialFields(values, idx) {
  const box = el("div", { class: "fields", attrs: { "data-midx": String(idx) } });
  const nameInput = el("input", {
    type: "text", value: values.name || "", maxlength: 20,
    placeholder: `材料${idx + 1}（可留空）`,
    attrs: { "data-key": "name", "data-idx": String(idx) },
  });
  const lowSel = tensSelect(values.holdLow, TENS_40_180, "holdLow", idx);
  const highSel = tensSelect(values.holdHigh, TENS_40_180, "holdHigh", idx);
  const durSel = el("select", { attrs: { "data-key": "duration", "data-idx": String(idx) } });
  DURATIONS.forEach((v) =>
    durSel.appendChild(el("option", { value: String(v), textContent: `${v} 分钟` }))
  );
  durSel.value = String(values.duration);
  const tolSel = el("select", { attrs: { "data-key": "tolerance", "data-idx": String(idx) } });
  rebuildToleranceOptions(tolSel, values.holdHigh, values.tolerance);

  box.appendChild(field("名称（可留空）", nameInput));
  box.appendChild(field("保温下限 °C", lowSel));
  box.appendChild(field("保温上限 °C", highSel));
  box.appendChild(field("连续保温时长", durSel));
  box.appendChild(field("耐受上限 °C", tolSel));
  return box;
}

function readMaterialFields(container, idx) {
  const q = (key) => container.querySelector(`[data-idx="${idx}"][data-key="${key}"]`);
  return {
    name: q("name").value.trim(),
    holdLow: Number(q("holdLow").value),
    holdHigh: Number(q("holdHigh").value),
    duration: Number(q("duration").value),
    tolerance: Number(q("tolerance").value),
  };
}

function bindToleranceRebuild(container) {
  container.addEventListener("change", (ev) => {
    const t = ev.target;
    if (t && t.dataset.key === "holdHigh") {
      const idx = Number(t.dataset.idx);
      const tolSel = container.querySelector(`[data-idx="${idx}"][data-key="tolerance"]`);
      rebuildToleranceOptions(tolSel, Number(t.value), Number(tolSel.value));
    }
  });
}

// ---------- 标签页 ----------
const tabs = document.getElementById("tabs");
const panels = {
  schedule: document.getElementById("panel-schedule"),
  recipes: document.getElementById("panel-recipes"),
  drafts: document.getElementById("panel-drafts"),
};
tabs.addEventListener("click", (ev) => {
  const btn = ev.target.closest(".tab");
  if (!btn) return;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
  Object.entries(panels).forEach(([key, p]) => {
    p.hidden = key !== btn.dataset.tab;
    p.classList.toggle("active", key === btn.dataset.tab);
  });
  if (btn.dataset.tab === "recipes") loadRecipes();
  if (btn.dataset.tab === "drafts") {
    loadRecipesIntoRefs();
    loadDrafts();
  }
});

// ============================================================
// 结果视图：在指定 slot 内构建与原页面相同的结果结构并渲染
// ============================================================
function createResultView(slot) {
  slot.innerHTML = "";
  const root = el("div");
  root.innerHTML = `
    <div data-role="ok" hidden>
      <section class="card">
        <h2 data-role="title">编排结果 <span class="badge badge-ok">有解</span></h2>
        <div class="summary" data-role="summary"></div>
        <div class="chart-wrap">
          <svg data-role="chart" viewBox="0 0 900 380" role="img" aria-label="炉温设定曲线"></svg>
          <ul class="legend" data-role="legend"></ul>
        </div>
        <div data-role="windows" class="windows"></div>
        <p class="shared-note" data-role="shared" hidden></p>
      </div>
      <section class="card">
        <h2>档位明细</h2>
        <div class="table-wrap">
          <table data-role="steps">
            <thead>
              <tr>
                <th>档位</th>
                <th data-role="th-phase" hidden>阶段</th>
                <th>设定温度 (°C)</th>
                <th>时长 (分钟)</th>
                <th>与上档温差 (°C)</th>
                <th>该档用于</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
      </section>
    </div>
    <div data-role="fail" hidden>
      <section class="card card-fail">
        <h2><span class="badge badge-fail">无解</span></h2>
        <p data-role="reason"></p>
      </section>
    </div>`;
  slot.appendChild(root);
  const $ = (role) => root.querySelector(`[data-role="${role}"]`);
  return {
    clear() {
      $("ok").hidden = true;
      $("fail").hidden = true;
    },
    render(data, title) {
      this.clear();
      if (!data.solvable) {
        $("fail").hidden = false;
        $("reason").textContent = data.reason || "在给定约束下无解。";
        return;
      }
      $("ok").hidden = false;
      if (title) $("title").firstChild.textContent = title + " ";
      renderSummary(data, $("summary"));
      renderChart(data, $("chart"));
      renderLegend(data, $("legend"));
      renderWindows(data, $("windows"), $("shared"));
      renderSteps(data, $("steps"), $("th-phase"));
    },
  };
}

function kv(k, v) {
  return el("div", { class: "kv" }, document.createTextNode(`${k}：`), el("b", { textContent: v }));
}

function renderSummary(data, box) {
  box.innerHTML = "";
  box.appendChild(kv("总档数", `${data.stepCount} 档（≤ 20）`));
  box.appendChild(kv("总时长", `${data.totalMinutes} 分钟`));
  box.appendChild(kv("耐受上限（取所有材料最小值）", `${data.toleranceCap}°C`));
  if (data.hasExecuted) {
    box.appendChild(kv("已执行档位", `${data.executedCount} 档（${data.executedCount * 5} 分钟）`));
    if (data.alreadyComplete) {
      box.appendChild(kv("后续编排", "0 档（已全部达标且回到 20°C，无需续排）"));
    } else {
      box.appendChild(kv("后续档位", `${data.continuationCount} 档（${data.continuationMinutes} 分钟）`));
    }
  }
  const seq = el("div", { class: "kv" });
  seq.appendChild(el("span", { textContent: "完整温度序列：" }));
  seq.appendChild(el("code", { textContent: data.temperatures.join(" → ") + " °C" }));
  box.appendChild(seq);
  if (data.hasExecuted && !data.alreadyComplete) {
    const seqE = el("div", { class: "kv" });
    seqE.appendChild(el("span", { textContent: "已执行：" }));
    seqE.appendChild(el("code", { class: "seq-exec", textContent: data.executedTemperatures.join(" → ") + " °C" }));
    box.appendChild(seqE);
    const seqC = el("div", { class: "kv" });
    seqC.appendChild(el("span", { textContent: "后续编排：" }));
    seqC.appendChild(el("code", { class: "seq-cont", textContent: data.continuationTemperatures.join(" → ") + " °C" }));
    box.appendChild(seqC);
  }
  box.appendChild(el("div", { class: "kv", textContent: "已满足：总档数最少；同档数下后续温度序列字典序最小。" }));
}

function renderWindows(data, box, note) {
  box.innerHTML = "";
  const boundary = data.executedCount || 0;
  data.windows.forEach((w, i) => {
    const color = PALETTE[i % PALETTE.length];
    const card = el("div", {
      class: "window-card",
      attrs: { style: `border-left-color:${color}` },
    });
    card.appendChild(el("h4", { textContent: w.material }));
    card.appendChild(
      el("p", { textContent: `首次达标连续区间：第 ${w.startStep}～${w.endStep} 档（共 ${w.minutes} 分钟）` })
    );
    card.appendChild(
      el("p", {}, document.createTextNode("区间温度："),
        el("span", { class: "temps", textContent: w.temperatures.join(" → ") + " °C" }))
    );
    if (boundary > 0) {
      let phaseText;
      if (w.endStep <= boundary) phaseText = "该区间全部位于已执行档位中。";
      else if (w.startStep > boundary) phaseText = "该区间全部位于后续档位中。";
      else phaseText = `该区间横跨已执行（第 1～${boundary} 档）与后续档位。`;
      card.appendChild(el("p", { class: "window-phase", textContent: phaseText }));
    }
    box.appendChild(card);
  });

  if (data.sharedSteps.length > 0) {
    note.hidden = false;
    const namesAt = (s) => data.steps.find((st) => st.index === s).inWindow.join("、");
    const parts = data.sharedSteps.map((s) => `第 ${s} 档（${namesAt(s)}）`);
    note.textContent = `共用档位：${parts.join("；")}。`;
  } else {
    note.hidden = true;
  }
}

function renderSteps(data, table, thPhase) {
  const tbody = table.querySelector("tbody");
  tbody.innerHTML = "";
  thPhase.hidden = !data.hasExecuted;

  data.windows.forEach((w, i) => {
    w.__color = PALETTE[i % PALETTE.length];
  });
  const colorOf = new Map(data.windows.map((w) => [w.material, w.__color]));

  data.steps.forEach((st) => {
    const tr = el("tr", { class: st.executed ? "row-exec" : "row-cont" });
    tr.appendChild(el("td", { textContent: String(st.index) }));
    if (data.hasExecuted) {
      tr.appendChild(
        el("td", {},
          el("span", {
            class: st.executed ? "phase-tag phase-exec" : "phase-tag phase-cont",
            textContent: st.executed ? "已执行" : "后续",
          }))
      );
    }
    tr.appendChild(el("td", { textContent: String(st.temperature) }));
    tr.appendChild(el("td", { textContent: String(st.minutes) }));
    const deltaText = st.deltaFromPrev === 0 ? "0" : (st.deltaFromPrev > 0 ? `+${st.deltaFromPrev}` : `${st.deltaFromPrev}`);
    tr.appendChild(el("td", { textContent: deltaText }));

    const useCell = el("td", { class: "use-cell" });
    if (st.inWindow.length === 0) {
      useCell.appendChild(el("span", { class: "dash", textContent: "—（升降温 / 末档）" }));
    } else {
      st.inWindow.forEach((name) => {
        useCell.appendChild(
          el("span", {
            class: "tag" + (st.shared ? " shared" : ""),
            textContent: name,
            attrs: { style: `background:${colorOf.get(name)}` },
          })
        );
      });
      if (st.shared) useCell.appendChild(document.createTextNode(" 共用"));
    }
    tr.appendChild(useCell);
    tbody.appendChild(tr);
  });
}

function renderLegend(data, ul) {
  ul.innerHTML = "";
  data.materials.forEach((m, i) => {
    ul.appendChild(
      el("li", {},
        el("span", { class: "key", attrs: { style: `background:${PALETTE[i % PALETTE.length]}` } }),
        document.createTextNode(`${m.name} 保温区间 ${m.holdLow}–${m.holdHigh}°C`))
    );
  });
  ul.appendChild(el("li", {}, el("span", { class: "key line" }),
    document.createTextNode(`耐受上限 ${data.toleranceCap}°C（所有档位不得超过）`)));
  if (data.hasExecuted) {
    ul.appendChild(el("li", {}, el("span", { class: "key series-exec" }),
      document.createTextNode("已执行档位曲线")));
    if (!data.alreadyComplete) {
      ul.appendChild(el("li", {}, el("span", { class: "key series" }),
        document.createTextNode("后续编排曲线（接续已执行末档，末档回到 20°C）")));
    } else {
      ul.appendChild(el("li", {}, document.createTextNode("已全部达标且回到 20°C，后续为空。")));
    }
  } else {
    ul.appendChild(el("li", {}, el("span", { class: "key series" }),
      document.createTextNode("设定温度曲线（第 0 点为初态 20°C，末档回到 20°C）")));
  }
}

function renderChart(data, svg) {
  svg.innerHTML = "";
  const W = 900, H = 380;
  const M = { t: 26, r: 22, b: 48, l: 54 };
  const pw = W - M.l - M.r, ph = H - M.t - M.b;
  const seq = data.temperatures;
  const n = seq.length;
  const full = [20].concat(seq);

  const maxT = Math.max(...seq);
  const yMax = Math.max(60, Math.min(200, Math.ceil((maxT + 20) / 20) * 20));
  const x = (k) => M.l + (pw * k) / n;
  const y = (t) => M.t + ph * (1 - (t - 20) / (yMax - 20));

  data.materials.forEach((m, i) => {
    const color = PALETTE[i % PALETTE.length];
    svg.appendChild(svgEl("rect", {
      x: M.l, y: y(m.holdHigh), width: pw,
      height: y(m.holdLow) - y(m.holdHigh),
      fill: color, "fill-opacity": 0.10,
    }));
  });

  for (let t = 20; t <= yMax; t += 20) {
    svg.appendChild(svgEl("line", {
      x1: M.l, x2: M.l + pw, y1: y(t), y2: y(t),
      stroke: t === 20 ? "#9fb3c8" : "#e6ecf2", "stroke-width": 1,
    }));
    const txt = svgEl("text", {
      x: M.l - 8, y: y(t) + 3.5, "text-anchor": "end",
      "font-size": 10, fill: "#7b8794",
    });
    txt.textContent = t;
    svg.appendChild(txt);
  }

  if (data.toleranceCap <= yMax) {
    svg.appendChild(svgEl("line", {
      x1: M.l, x2: M.l + pw,
      y1: y(data.toleranceCap), y2: y(data.toleranceCap),
      stroke: "#6b7280", "stroke-width": 1.4, "stroke-dasharray": "6 4",
    }));
  }

  svg.appendChild(svgEl("line", {
    x1: M.l, x2: M.l + pw, y1: y(20), y2: y(20),
    stroke: "#9fb3c8", "stroke-width": 1,
  }));
  const initLab = svgEl("text", { x: x(0), y: H - M.b + 18, "text-anchor": "middle", "font-size": 10, fill: "#7b8794" });
  initLab.textContent = "初态";
  svg.appendChild(initLab);
  for (let k = 1; k <= n; k++) {
    const txt = svgEl("text", { x: x(k), y: H - M.b + 18, "text-anchor": "middle", "font-size": 10, fill: "#52606d" });
    txt.textContent = k;
    svg.appendChild(txt);
  }

  const boundary = data.executedCount || 0;
  const pts = full.map((t, k) => `${x(k)},${y(t)}`);
  if (data.hasExecuted && boundary < n) {
    svg.appendChild(svgEl("polyline", {
      points: pts.slice(0, boundary + 1).join(" "),
      fill: "none", stroke: "#475569", "stroke-width": 2.4,
      "stroke-linejoin": "round", "stroke-linecap": "round",
    }));
    svg.appendChild(svgEl("polyline", {
      points: pts.slice(boundary).join(" "),
      fill: "none", stroke: "#c2410c", "stroke-width": 2,
      "stroke-linejoin": "round", "stroke-linecap": "round",
    }));
    svg.appendChild(svgEl("line", {
      x1: x(boundary), x2: x(boundary), y1: M.t, y2: M.t + ph,
      stroke: "#94a3b8", "stroke-width": 1, "stroke-dasharray": "4 4",
    }));
    const divLab = svgEl("text", {
      x: x(boundary), y: M.t - 8, "text-anchor": "middle",
      "font-size": 10, fill: "#64748b",
    });
    divLab.textContent = "已执行 ｜ 后续";
    svg.appendChild(divLab);
  } else {
    svg.appendChild(svgEl("polyline", {
      points: pts.join(" "),
      fill: "none", stroke: data.hasExecuted ? "#475569" : "#c2410c",
      "stroke-width": data.hasExecuted ? 2.4 : 2,
      "stroke-linejoin": "round", "stroke-linecap": "round",
    }));
  }

  data.windows.forEach((w, i) => {
    const color = PALETTE[i % PALETTE.length];
    const ks = [];
    for (let k = w.startStep; k <= w.endStep; k++) ks.push(k);
    svg.appendChild(svgEl("polyline", {
      points: ks.map((k) => `${x(k)},${y(full[k])}`).join(" "),
      fill: "none", stroke: color, "stroke-width": 5,
      "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-opacity": 0.85,
    }));
    ks.forEach((k) => svg.appendChild(svgEl("circle", {
      cx: x(k), cy: y(full[k]), r: 5, fill: color, stroke: "#fff", "stroke-width": 1.2,
    })));
  });

  for (let k = 1; k <= n; k++) {
    const isExec = data.hasExecuted && k <= boundary;
    svg.appendChild(svgEl("circle", {
      cx: x(k), cy: y(full[k]), r: 3,
      fill: isExec ? "#475569" : "#b91c1c",
    }));
    const lab = svgEl("text", {
      x: x(k), y: y(full[k]) - 7, "text-anchor": "middle",
      "font-size": 9.5, fill: "#334e68",
    });
    lab.textContent = full[k];
    svg.appendChild(lab);
  }
  [0, n].forEach((k) =>
    svg.appendChild(svgEl("circle", {
      cx: x(k), cy: y(full[k]), r: 3.5,
      fill: "#fff", stroke: "#627d98", "stroke-width": 1.6,
    }))
  );
}

// ============================================================
// 标签页 1：即时编排（原表单逻辑，结果改用 createResultView）
// ============================================================
const materialsBox = document.getElementById("materials");
const countSelect = document.getElementById("material-count");
const form = document.getElementById("schedule-form");
const formError = document.getElementById("form-error");
const submitBtn = document.getElementById("submit-btn");
const executedInput = document.getElementById("executed-input");
const scheduleView = createResultView(document.getElementById("schedule-result-slot"));
scheduleView.clear();

function buildRows() {
  materialsBox.innerHTML = "";
  DEFAULTS.forEach((d, i) => {
    const color = PALETTE[i];
    const fields = materialFields(d, i);
    const row = el(
      "div",
      { class: "material-row", attrs: { "data-row": String(i) } },
      el(
        "div",
        { class: "row-title" },
        el("span", { class: "swatch", attrs: { style: `background:${color}` } }),
        document.createTextNode(`材料 ${i + 1}`)
      ),
      fields
    );
    materialsBox.appendChild(row);
  });
  applyCount();
}

function applyCount() {
  const n = Number(countSelect.value);
  document.querySelectorAll("#materials [data-row]").forEach((row) => {
    row.hidden = Number(row.dataset.row) >= n;
  });
}

function readForm() {
  const n = Number(countSelect.value);
  const out = [];
  for (let i = 0; i < n; i++) out.push(readMaterialFields(materialsBox, i));
  return out;
}

materialsBox.addEventListener("change", (ev) => {
  scheduleView.clear();
  formError.hidden = true;
  const t = ev.target;
  if (t && t.dataset.key === "holdHigh") {
    const idx = Number(t.dataset.idx);
    const tolSel = materialsBox.querySelector(`[data-idx="${idx}"][data-key="tolerance"]`);
    rebuildToleranceOptions(tolSel, Number(t.value), Number(tolSel.value));
  }
});
materialsBox.addEventListener("input", () => {
  scheduleView.clear();
  formError.hidden = true;
});
countSelect.addEventListener("change", () => {
  applyCount();
  scheduleView.clear();
  formError.hidden = true;
});

function clientValidate(items) {
  for (let i = 0; i < items.length; i++) {
    const m = items[i];
    const tag = m.name || `第 ${i + 1} 种材料`;
    if (m.holdLow > m.holdHigh) return `「${tag}」的保温下限不得高于保温上限。`;
    if (m.tolerance < m.holdHigh)
      return `「${tag}」的耐受上限不得低于保温上限（${m.holdHigh}°C）。`;
  }
  return null;
}

function parseExecuted() {
  const raw = executedInput.value.trim();
  if (!raw) return { values: null, error: null };
  const parts = raw.split(/[,，\s]+/).filter(Boolean);
  if (parts.length < 1 || parts.length > 20)
    return { values: null, error: "已执行档位数量必须为 1～20 个。" };
  const values = [];
  for (let i = 0; i < parts.length; i++) {
    const tok = parts[i];
    if (!/^[+-]?\d+$/.test(tok))
      return { values: null, error: `已执行记录第 ${i + 1} 档「${tok}」不是整数温度。` };
    const t = Number(tok);
    if (t < 20 || t > 200)
      return { values: null, error: `已执行记录第 ${i + 1} 档温度 ${t}°C 超出允许范围 20～200°C。` };
    if (t % 10 !== 0)
      return { values: null, error: `已执行记录第 ${i + 1} 档温度 ${t}°C 不是整十数。` };
    values.push(t);
  }
  let prev = 20;
  for (let i = 0; i < values.length; i++) {
    if (Math.abs(values[i] - prev) > 20)
      return {
        values: null,
        error: `已执行记录第 ${i + 1} 档温度 ${values[i]}°C 与上一档 ${prev}°C 温差 ${Math.abs(values[i] - prev)}°C，超过 20°C 上限。`,
      };
    prev = values[i];
  }
  return { values, error: null };
}

executedInput.addEventListener("input", () => {
  scheduleView.clear();
  formError.hidden = true;
});

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  formError.hidden = true;
  const items = readForm();
  const err = clientValidate(items);
  if (err) {
    scheduleView.clear();
    showFormError(err);
    return;
  }
  const { values: executed, error: execErr } = parseExecuted();
  if (execErr) {
    scheduleView.clear();
    showFormError(execErr);
    return;
  }

  const body = { materials: items };
  if (executed) body.executedTemperatures = executed;

  submitBtn.disabled = true;
  submitBtn.textContent = "求解中…";
  try {
    const { ok, data } = await api("/api/schedule", { method: "POST", body: JSON.stringify(body) });
    if (!ok) {
      scheduleView.clear();
      showFormError(detailOf(data));
      return;
    }
    scheduleView.render(data, "编排结果");
  } catch (e) {
    scheduleView.clear();
    showFormError("无法连接后端服务，请确认服务已启动。");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "一键启动编排";
  }
});

function showFormError(msg) {
  formError.textContent = msg;
  formError.hidden = false;
}

// ============================================================
// 标签页 2：材料配方（创建 / 读取 / 整份修改）
// ============================================================
const recipeForm = document.getElementById("recipe-form");
const recipeFieldsBox = document.getElementById("recipe-fields");
const recipeError = document.getElementById("recipe-error");
const recipeMsg = document.getElementById("recipe-message");
const recipeEditId = document.getElementById("recipe-edit-id");
const recipeSaveBtn = document.getElementById("recipe-save-btn");
const recipeCancelBtn = document.getElementById("recipe-cancel-btn");
const recipeFormTitle = document.getElementById("recipe-form-title");

recipeFieldsBox.appendChild(materialFields(EMPTY_RESULT, 0));
bindToleranceRebuild(recipeFieldsBox);

function resetRecipeForm() {
  recipeFieldsBox.innerHTML = "";
  recipeFieldsBox.appendChild(materialFields(EMPTY_RESULT, 0));
  recipeEditId.value = "";
  recipeSaveBtn.textContent = "创建配方";
  recipeCancelBtn.hidden = true;
  recipeFormTitle.textContent = "新建材料配方";
  recipeError.hidden = true;
  recipeMsg.hidden = true;
}

recipeCancelBtn.addEventListener("click", resetRecipeForm);

recipeForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  recipeError.hidden = true;
  recipeMsg.hidden = true;
  const payload = readMaterialFields(recipeFieldsBox, 0);
  const editId = recipeEditId.value;
  recipeSaveBtn.disabled = true;
  try {
    const path = editId ? `/api/recipes/${editId}` : "/api/recipes";
    const method = editId ? "PUT" : "POST";
    const { ok, status, data } = await api(path, { method, body: JSON.stringify(payload) });
    if (!ok) {
      recipeError.textContent = detailOf(data);
      recipeError.hidden = false;
      return;
    }
    if (editId) {
      const n = data.recomputedDrafts.length;
      const unsolvable = data.recomputedDrafts.filter((d) => !d.solvable).length;
      recipeMsg.textContent =
        `配方 ${data.recipe.id} 已整份修改（版本 ${data.recipe.version}）；` +
        `引用它的 ${n} 个炉次草稿已按新参数重算、版本各 +1` +
        (unsolvable ? `，其中 ${unsolvable} 个当前无解（旧曲线已清除并记录原因）。` : "。");
    } else {
      recipeMsg.textContent = `配方 ${data.id} 已创建（版本 1）。`;
    }
    recipeMsg.hidden = false;
    resetRecipeFormKeepMsg();
    await loadRecipes();
  } catch (e) {
    recipeError.textContent = "无法连接后端服务，请确认服务已启动。";
    recipeError.hidden = false;
  } finally {
    recipeSaveBtn.disabled = false;
  }
});

function resetRecipeFormKeepMsg() {
  recipeFieldsBox.innerHTML = "";
  recipeFieldsBox.appendChild(materialFields(EMPTY_RESULT, 0));
  recipeEditId.value = "";
  recipeSaveBtn.textContent = "创建配方";
  recipeCancelBtn.hidden = true;
  recipeFormTitle.textContent = "新建材料配方";
  recipeError.hidden = true;
}

async function loadRecipes() {
  const tbody = document.querySelector("#recipes-table tbody");
  tbody.innerHTML = "";
  const { ok, data } = await api("/api/recipes");
  const recipes = ok ? data : [];
  document.getElementById("recipe-count").textContent = `（共 ${recipes.length} 个）`;
  document.getElementById("recipe-empty").hidden = recipes.length !== 0;
  recipes.forEach((r) => {
    const tr = el("tr", { class: "rrecipe-" + r.id });
    tr.appendChild(el("td", { textContent: String(r.id) }));
    tr.appendChild(el("td", { textContent: r.name || "—" }));
    tr.appendChild(el("td", { textContent: String(r.holdLow) }));
    tr.appendChild(el("td", { textContent: String(r.holdHigh) }));
    tr.appendChild(el("td", { textContent: String(r.duration) }));
    tr.appendChild(el("td", { textContent: String(r.tolerance) }));
    tr.appendChild(el("td", {}, el("span", { class: "ver-badge", textContent: `v${r.version}` })));
    tr.appendChild(el("td", { class: "ts", textContent: fmtTime(r.updatedAt) }));
    const editBtn = el("button", {
      class: "btn-secondary btn-small", type: "button", textContent: "整份修改",
    });
    editBtn.addEventListener("click", () => fillRecipeForm(r));
    tr.appendChild(el("td", {}, editBtn));
    tbody.appendChild(tr);
  });
  // 同步炉次草稿页的引用下拉
  populateDraftRefs(recipes);
}

function fillRecipeForm(r) {
  recipeFieldsBox.innerHTML = "";
  recipeFieldsBox.appendChild(materialFields(r, 0));
  recipeEditId.value = String(r.id);
  recipeSaveBtn.textContent = `保存修改（版本 ${r.version} → ${r.version + 1}）`;
  recipeCancelBtn.hidden = false;
  recipeFormTitle.textContent = `整份修改配方 #${r.id}`;
  recipeError.hidden = true;
  recipeMsg.hidden = true;
  if (recipeForm.scrollIntoView) recipeForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

function fmtTime(s) {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleString("zh-CN", { hour12: false });
  } catch (e) {
    return s;
  }
}

// ============================================================
// 标签页 3：炉次草稿
// ============================================================
const draftForm = document.getElementById("draft-form");
const draftError = document.getElementById("draft-error");
const draftCountSel = document.getElementById("draft-count");
const draftRefsBox = document.getElementById("draft-refs");
const draftDetailCard = document.getElementById("draft-detail-card");
const draftMeta = document.getElementById("draft-meta");
const draftResultView = createResultView(document.getElementById("draft-result-slot"));
draftResultView.clear();

let cachedRecipes = [];
let viewedDraft = null; // 当前查看的草稿（携带其版本用于归档）

async function loadRecipesIntoRefs() {
  const { ok, data } = await api("/api/recipes");
  cachedRecipes = ok ? data : [];
  populateDraftRefs(cachedRecipes);
}

function populateDraftRefs(recipes) {
  cachedRecipes = recipes;
  buildDraftRefRows();
}

function buildDraftRefRows() {
  const n = Number(draftCountSel.value);
  const prev = Array.from(draftRefsBox.querySelectorAll("select")).map((s) => s.value);
  draftRefsBox.innerHTML = "";
  for (let i = 0; i < n; i++) {
    const sel = el("select", { attrs: { "data-ref": String(i) } });
    sel.appendChild(el("option", { value: "", textContent: "选择配方…" }));
    cachedRecipes.forEach((r) => {
      sel.appendChild(el("option", {
        value: String(r.id),
        textContent: `#${r.id} ${r.name || "（未命名）"} [${r.holdLow}-${r.holdHigh}°C, ${r.duration}min, 耐受${r.tolerance}°C, v${r.version}]`,
      }));
    });
    if (prev[i]) sel.value = prev[i];
    const row = el("div", { class: "ref-row" },
      el("span", { class: "ref-order", textContent: `第 ${i + 1} 个配方` }), sel);
    draftRefsBox.appendChild(row);
  }
}
draftCountSel.addEventListener("change", buildDraftRefRows);

draftForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  draftError.hidden = true;
  const ids = Array.from(draftRefsBox.querySelectorAll("select")).map((s) => s.value);
  if (ids.some((v) => v === "")) {
    draftError.textContent = "请为每个位置选择一个现有配方。";
    draftError.hidden = false;
    return;
  }
  const payload = {
    name: document.getElementById("draft-name").value.trim(),
    recipeIds: ids.map(Number),
  };
  const btn = document.getElementById("draft-create-btn");
  btn.disabled = true;
  try {
    const { ok, status, data } = await api("/api/drafts", { method: "POST", body: JSON.stringify(payload) });
    if (!ok) {
      draftError.textContent = detailOf(data);
      draftError.hidden = false;
      return;
    }
    await loadDrafts();
    openDraft(data.id);
  } catch (e) {
    draftError.textContent = "无法连接后端服务，请确认服务已启动。";
    draftError.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

async function loadDrafts() {
  const tbody = document.querySelector("#drafts-table tbody");
  tbody.innerHTML = "";
  const { ok, data } = await api("/api/drafts");
  const drafts = ok ? data : [];
  document.getElementById("draft-empty").hidden = drafts.length !== 0;
  const recipesById = new Map(cachedRecipes.map((r) => [r.id, r]));
  drafts.forEach((d) => {
    const tr = el("tr", { class: viewedDraft && viewedDraft.id === d.id ? "row-selected" : "" });
    tr.appendChild(el("td", { textContent: String(d.id) }));
    tr.appendChild(el("td", { textContent: d.name || "—" }));
    tr.appendChild(el("td", {
      textContent: d.recipeIds.map((id) => {
        const r = recipesById.get(id);
        return `#${id}${r && r.name ? " " + r.name : ""}`;
      }).join(" → "),
    }));
    tr.appendChild(el("td", {}, el("span", { class: "ver-badge", textContent: `v${d.version}` })));
    tr.appendChild(el("td", {}, el("span", {
      class: "status-badge " + (d.status === "archived" ? "status-archived" : "status-active"),
      textContent: d.status === "archived" ? "已归档" : "活动",
    })));
    tr.appendChild(el("td", {
      textContent: d.solvable ? `有解（${d.result.stepCount} 档）` : "无解",
      class: d.solvable ? "" : "text-fail",
    }));
    tr.appendChild(el("td", { class: "ts", textContent: fmtTime(d.updatedAt) }));
    const viewBtn = el("button", { class: "btn-secondary btn-small", type: "button", textContent: "查看" });
    viewBtn.addEventListener("click", () => openDraft(d.id));
    tr.appendChild(el("td", {}, viewBtn));
    tbody.appendChild(tr);
  });
}

async function openDraft(id) {
  const card = draftDetailCard;
  card.hidden = false;
  const { ok, status, data } = await api(`/api/drafts/${id}`);
  if (!ok) {
    showDraftDetailError(detailOf(data));
    return;
  }
  renderDraftDetail(data);
  if (card.scrollIntoView) card.scrollIntoView({ behavior: "smooth", block: "start" });
}

function showDraftDetailError(msg) {
  const e = document.getElementById("draft-detail-error");
  e.textContent = msg;
  e.hidden = false;
}

function renderDraftDetail(d) {
  viewedDraft = d;
  document.getElementById("draft-detail-error").hidden = true;
  document.getElementById("draft-detail-ok").hidden = true;
  document.getElementById("draft-detail-title").textContent =
    `炉次 #${d.id} ${d.name || "（未命名）"}`;

  const archiveBtn = document.getElementById("draft-archive-btn");
  archiveBtn.disabled = d.status === "archived";
  archiveBtn.textContent = d.status === "archived"
    ? "已归档（方案已冻结）"
    : `核准归档（携带版本 v${d.version}）`;

  draftMeta.innerHTML = "";
  draftMeta.appendChild(kv("状态", d.status === "archived" ? "已归档（冻结）" : "活动"));
  draftMeta.appendChild(kv("草稿版本", `v${d.version}`));
  draftMeta.appendChild(kv("按顺序引用配方", d.recipeIds
    .map((id) => {
      const rv = d.recipeVersions[String(id)];
      return `#${id}${rv ? `（引用时 v${rv}）` : ""}`;
    })
    .join(" → ")));
  draftMeta.appendChild(kv("求解", d.solvable ? `有解，${d.result.stepCount} 档 / ${d.result.totalMinutes} 分钟` : "无解"));
  draftMeta.appendChild(kv("创建 / 更新", `${fmtTime(d.createdAt)} ｜ ${fmtTime(d.updatedAt)}`));
  if (d.archivedAt) draftMeta.appendChild(kv("归档时间", fmtTime(d.archivedAt)));

  const matBox = el("div", { class: "kv" });
  matBox.appendChild(el("span", {
    textContent: d.status === "archived"
      ? "冻结当时的材料参数："
      : "当前求解所用材料参数（与下方结果同版）：",
  }));
  d.materials.forEach((m, i) => {
    matBox.appendChild(el("code", { class: "mat-chip", textContent:
      `${i + 1}. ${m.name}：区间 ${m.holdLow}–${m.holdHigh}°C，${m.duration} 分钟，耐受 ${m.tolerance}°C` }));
  });
  draftMeta.appendChild(matBox);

  if (d.solvable) {
    draftResultView.render(d.result,
      d.status === "archived" ? `归档方案（冻结 v${d.version}）` : `求解结果（v${d.version}）`);
  } else {
    draftResultView.render({ solvable: false, reason: d.reason });
  }
  loadDrafts();
}

document.getElementById("draft-refresh-btn").addEventListener("click", async () => {
  if (!viewedDraft) return;
  await openDraft(viewedDraft.id);
});

document.getElementById("draft-archive-btn").addEventListener("click", async () => {
  if (!viewedDraft || viewedDraft.status === "archived") return;
  const okMsg = document.getElementById("draft-detail-ok");
  const errEl = document.getElementById("draft-detail-error");
  okMsg.hidden = true;
  errEl.hidden = true;
  const btn = document.getElementById("draft-archive-btn");
  btn.disabled = true;
  try {
    const r = await api(`/api/drafts/${viewedDraft.id}/archive`, {
      method: "POST",
      body: JSON.stringify({ version: viewedDraft.version }),
    });
    if (r.status === 409) {
      const cur = r.data.detail && r.data.detail.currentVersion;
      errEl.textContent =
        detailOf(r.data) + (cur ? ` 已为你重新载入当前版本 v${cur}。` : "");
      errEl.hidden = false;
      // 过期：重新读取，呈现最新参数 + 结果，绝不混用
      await openDraft(viewedDraft.id);
      return;
    }
    if (!r.ok) {
      // 422：当前无解等；状态未改变
      errEl.textContent = "归档失败（未改变任何状态）：" + detailOf(r.data);
      errEl.hidden = false;
      await openDraft(viewedDraft.id);
      return;
    }
    okMsg.textContent = `归档成功：已冻结炉次 #${r.data.id} 的版本 v${r.data.version} 材料参数与完整求解结果；此后配方修改不再影响本炉次。`;
    okMsg.hidden = false;
    renderDraftDetail(r.data);
    return; // 已归档：保持按钮禁用
  } catch (e) {
    errEl.textContent = "无法连接后端服务，请确认服务已启动。";
    errEl.hidden = false;
    btn.disabled = false;
  }
});

// ---------- 启动 ----------
buildRows();
