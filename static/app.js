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

// ---------- 输入表单 ----------
const materialsBox = document.getElementById("materials");
const countSelect = document.getElementById("material-count");
const form = document.getElementById("schedule-form");
const formError = document.getElementById("form-error");
const submitBtn = document.getElementById("submit-btn");
const resultBox = document.getElementById("result");
const executedInput = document.getElementById("executed-input");

function buildRows() {
  materialsBox.innerHTML = "";
  DEFAULTS.forEach((d, i) => {
    const color = PALETTE[i];
    const fields = el("div", { class: "fields" });

    const nameInput = el("input", {
      type: "text",
      value: d.name,
      maxlength: 20,
      placeholder: `材料${i + 1}`,
      attrs: { "data-key": "name", "data-idx": String(i) },
    });

    const lowSel = tensSelect(d.holdLow, TENS_40_180, "holdLow", i);
    const highSel = tensSelect(d.holdHigh, TENS_40_180, "holdHigh", i);
    const durSel = el("select", {
      attrs: { "data-key": "duration", "data-idx": String(i) },
    });
    DURATIONS.forEach((v) =>
      durSel.appendChild(el("option", { value: String(v), textContent: `${v} 分钟` }))
    );
    durSel.value = String(d.duration);

    const tolSel = el("select", {
      attrs: { "data-key": "tolerance", "data-idx": String(i) },
    });
    rebuildToleranceOptions(tolSel, d.holdHigh, d.tolerance);

    fields.appendChild(field("名称（可留空）", nameInput));
    fields.appendChild(field("保温下限 °C", lowSel));
    fields.appendChild(field("保温上限 °C", highSel));
    fields.appendChild(field("连续保温时长", durSel));
    fields.appendChild(field("耐受上限 °C", tolSel));

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

function applyCount() {
  const n = Number(countSelect.value);
  document.querySelectorAll("[data-row]").forEach((row) => {
    row.hidden = Number(row.dataset.row) >= n;
  });
}

function readForm() {
  const n = Number(countSelect.value);
  const out = [];
  for (let i = 0; i < n; i++) {
    const q = (key) =>
      materialsBox.querySelector(`[data-idx="${i}"][data-key="${key}"]`);
    out.push({
      name: q("name").value.trim(),
      holdLow: Number(q("holdLow").value),
      holdHigh: Number(q("holdHigh").value),
      duration: Number(q("duration").value),
      tolerance: Number(q("tolerance").value),
    });
  }
  return out;
}

// 任一输入变化 => 清除旧结果
materialsBox.addEventListener("change", (ev) => {
  clearResult();
  formError.hidden = true;
  const t = ev.target;
  if (t && t.dataset.key === "holdHigh") {
    const idx = Number(t.dataset.idx);
    const tolSel = materialsBox.querySelector(`[data-idx="${idx}"][data-key="tolerance"]`);
    rebuildToleranceOptions(tolSel, Number(t.value), Number(tolSel.value));
  }
});
materialsBox.addEventListener("input", (ev) => {
  clearResult();
  formError.hidden = true;
});
countSelect.addEventListener("change", () => {
  applyCount();
  clearResult();
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

// 解析已执行档位文本：逗号（中英文）/空白分隔；返回 { values: number[] | null, error: string | null }
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
  // 相邻（含初态 20°C）温差 ≤ 20，逐档给出首个违规档
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
  clearResult();
  formError.hidden = true;
});

// ---------- 提交求解 ----------
form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  formError.hidden = true;
  const items = readForm();
  const err = clientValidate(items);
  if (err) {
    clearResult();
    showFormError(err);
    return;
  }
  const { values: executed, error: execErr } = parseExecuted();
  if (execErr) {
    clearResult();
    showFormError(execErr);
    return;
  }

  const body = { materials: items };
  if (executed) body.executedTemperatures = executed;

  submitBtn.disabled = true;
  submitBtn.textContent = "求解中…";
  try {
    const resp = await fetch("/api/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) {
      clearResult();
      showFormError(data.detail || `请求失败（HTTP ${resp.status}）。`);
      return;
    }
    renderResult(data, items);
  } catch (e) {
    clearResult();
    showFormError("无法连接后端服务，请确认服务已启动。");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "编排求解";
  }
});

function showFormError(msg) {
  formError.textContent = msg;
  formError.hidden = false;
}

// ---------- 结果渲染 ----------
const resultOk = document.getElementById("result-ok");
const resultFail = document.getElementById("result-fail");
const failReason = document.getElementById("fail-reason");

function clearResult() {
  resultBox.hidden = true;
  resultOk.hidden = true;
  resultFail.hidden = true;
}

function renderResult(data, submitted) {
  clearResult();
  resultBox.hidden = false;
  if (!data.solvable) {
    resultFail.hidden = false;
    failReason.textContent = data.reason || "在给定约束下无解。";
    return;
  }
  resultOk.hidden = false;
  renderSummary(data);
  renderChart(data);
  renderLegend(data);
  renderWindows(data);
  renderSteps(data);
}

function renderSummary(data) {
  const box = document.getElementById("summary");
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
  box.appendChild(
    el("div", { class: "kv", textContent: "已满足：总档数最少；同档数下后续温度序列字典序最小。" })
  );
}

function kv(k, v) {
  return el("div", { class: "kv" }, document.createTextNode(`${k}：`), el("b", { textContent: v }));
}

function renderWindows(data) {
  const box = document.getElementById("windows");
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
      el("p", {}, document.createTextNode("区间温度："), el("span", { class: "temps", textContent: w.temperatures.join(" → ") + " °C" }))
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

  const note = document.getElementById("shared-note");
  if (data.sharedSteps.length > 0) {
    note.hidden = false;
    const namesAt = (s) =>
      data.steps.find((st) => st.index === s).inWindow.join("、");
    const parts = data.sharedSteps.map((s) => `第 ${s} 档（${namesAt(s)}）`);
    note.textContent = `共用档位：${parts.join("；")}。`;
  } else {
    note.hidden = true;
  }
}

function renderSteps(data) {
  const tbody = document.querySelector("#steps-table tbody");
  const thPhase = document.getElementById("th-phase");
  tbody.innerHTML = "";
  thPhase.hidden = !data.hasExecuted;

  data.windows.forEach((w, i) => {
    // 仅为建立 材料名->颜色 的对应（颜色顺序与 windows 一致）
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
          })
        )
      );
    }
    tr.appendChild(el("td", { textContent: String(st.temperature) }));
    tr.appendChild(el("td", { textContent: String(st.minutes) }));
    const delta = el("td", { textContent: st.deltaFromPrev === 0 ? "0" : (st.deltaFromPrev > 0 ? `+${st.deltaFromPrev}` : `${st.deltaFromPrev}`) });
    tr.appendChild(delta);

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

function renderLegend(data) {
  const ul = document.getElementById("legend");
  ul.innerHTML = "";
  data.materials.forEach((m, i) => {
    ul.appendChild(
      el("li", {},
        el("span", { class: "key", attrs: { style: `background:${PALETTE[i % PALETTE.length]}` } }),
        document.createTextNode(`${m.name} 保温区间 ${m.holdLow}–${m.holdHigh}°C`)
      )
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

// ---------- SVG 曲线 ----------
function renderChart(data) {
  const svg = document.getElementById("chart");
  svg.innerHTML = "";
  const W = 900, H = 380;
  const M = { t: 26, r: 22, b: 48, l: 54 };
  const pw = W - M.l - M.r, ph = H - M.t - M.b;
  const seq = data.temperatures;
  const n = seq.length;
  const full = [20].concat(seq); // k=0 为初态

  const maxT = Math.max(...seq);
  const yMax = Math.max(60, Math.min(200, Math.ceil((maxT + 20) / 20) * 20));
  const x = (k) => M.l + (pw * k) / n;
  const y = (t) => M.t + ph * (1 - (t - 20) / (yMax - 20));

  // 保温区间底色
  data.materials.forEach((m, i) => {
    const color = PALETTE[i % PALETTE.length];
    svg.appendChild(svgEl("rect", {
      x: M.l, y: y(m.holdHigh), width: pw,
      height: y(m.holdLow) - y(m.holdHigh),
      fill: color, "fill-opacity": 0.10,
    }));
  });

  // 网格 + y 轴标签
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

  // 耐受上限虚线
  if (data.toleranceCap <= yMax) {
    svg.appendChild(svgEl("line", {
      x1: M.l, x2: M.l + pw,
      y1: y(data.toleranceCap), y2: y(data.toleranceCap),
      stroke: "#6b7280", "stroke-width": 1.4, "stroke-dasharray": "6 4",
    }));
  }

  // x 轴
  svg.appendChild(svgEl("line", {
    x1: M.l, x2: M.l + pw, y1: y(20), y2: y(20),
    stroke: "#9fb3c8", "stroke-width": 1,
  }));
  // x 轴档位标签
  const initLab = svgEl("text", { x: x(0), y: H - M.b + 18, "text-anchor": "middle", "font-size": 10, fill: "#7b8794" });
  initLab.textContent = "初态";
  svg.appendChild(initLab);
  for (let k = 1; k <= n; k++) {
    const txt = svgEl("text", { x: x(k), y: H - M.b + 18, "text-anchor": "middle", "font-size": 10, fill: "#52606d" });
    txt.textContent = k;
    svg.appendChild(txt);
  }

  // 主曲线（含初态点）：已执行段与后续段分色
  const boundary = data.executedCount || 0; // 已执行档数（分界点位于 full 的该下标）
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
    // 已执行 / 后续 分界
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
  } else if (data.hasExecuted) {
    // 全部为已执行档位（已达标且回到 20°C，后续为空）
    svg.appendChild(svgEl("polyline", {
      points: pts.join(" "),
      fill: "none", stroke: "#475569", "stroke-width": 2.4, "stroke-linejoin": "round",
    }));
  } else {
    svg.appendChild(svgEl("polyline", {
      points: pts.join(" "),
      fill: "none", stroke: "#c2410c", "stroke-width": 2, "stroke-linejoin": "round",
    }));
  }

  // 各材料达标区间加粗覆盖
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

  // 所有档位点 + 温度标注
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
  // 初态 / 末档点
  [0, n].forEach((k) =>
    svg.appendChild(svgEl("circle", {
      cx: x(k), cy: y(full[k]), r: 3.5,
      fill: "#fff", stroke: "#627d98", "stroke-width": 1.6,
    }))
  );
}

// ---------- 启动 ----------
buildRows();
