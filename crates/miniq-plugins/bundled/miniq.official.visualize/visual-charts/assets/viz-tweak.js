/* miniQ Tweak：给 UI 原型加“设计微调”面板的轻量助手（无依赖，独立渲染）。
   用法：
     const state = { radius: 12, accent: "#2563eb", compact: false, layout: "列表" };
     function render() { ... 根据 state 更新 DOM ... }
     render();
     const t = new Tweak({ container: mockEl, title: "卡片样式", onChange: render });
     t.addSlider(state, "radius", { label: "圆角", min: 0, max: 32, unit: "px" });
     t.addColorPicker(state, "accent", { label: "强调色" });
     t.addToggle(state, "compact", { label: "紧凑模式" });
     t.addSelect(state, "layout", { label: "布局", options: ["列表", "网格"] });
   面板默认浮在页面右下角，可折叠；“重置”恢复初始值；“复制参数”把当前 state 以 JSON 复制到剪贴板，方便用户把满意的取值告诉 miniQ。
   onChange 应当是确定性的本地渲染函数，不要在里面发请求。 */
(function (global) {
  "use strict";
  var dock = null;
  function ensureDock() {
    if (dock) return dock;
    dock = document.createElement("aside");
    dock.setAttribute("aria-label", "设计微调");
    dock.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:9999;width:260px;max-height:70vh;overflow:auto;" +
      "background:var(--card,#fff);color:var(--card-foreground,#1f2328);border:1px solid var(--border,#ddd);" +
      "border-radius:12px;box-shadow:0 8px 28px rgb(0 0 0/.18);font:13px/1.4 var(--font-sans,system-ui);padding:10px 12px;";
    document.body.appendChild(dock);
    return dock;
  }
  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    for (var k in (attrs || {})) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }
  var uid = 0;
  function Tweak(opts) {
    opts = opts || {};
    this.onChange = typeof opts.onChange === "function" ? opts.onChange : function () {};
    this.supported = typeof document !== "undefined";
    this.bindings = [];
    var box = el("details", { open: "" });
    var sum = el("summary", null, opts.title || (opts.container && opts.container.getAttribute("aria-label")) || "微调");
    sum.style.cssText = "cursor:pointer;font-weight:500;margin-bottom:6px;";
    box.appendChild(sum);
    this.body = el("div");
    box.appendChild(this.body);
    var bar = el("div");
    bar.style.cssText = "display:flex;gap:6px;margin-top:8px;";
    var reset = el("button", { type: "button" }, "重置");
    var copy = el("button", { type: "button" }, "复制参数");
    [reset, copy].forEach(function (b) { b.style.cssText = "flex:1;min-height:28px;border-radius:6px;border:1px solid var(--border,#ccc);background:transparent;color:inherit;cursor:pointer;"; bar.appendChild(b); });
    box.appendChild(bar);
    var self = this;
    reset.addEventListener("click", function () { self.reset(); });
    copy.addEventListener("click", function () {
      var text = JSON.stringify(self.values(), null, 1);
      var done = function () { copy.textContent = "已复制"; setTimeout(function () { copy.textContent = "复制参数"; }, 1200); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { window.prompt("复制以下参数：", text); });
      else window.prompt("复制以下参数：", text);
    });
    ensureDock().appendChild(box);
    this.root = box;
  }
  Tweak.prototype._row = function (label) {
    var id = "tweak-" + (++uid);
    var row = el("div");
    row.style.cssText = "margin:6px 0;";
    var lab = el("label", { "for": id }, label);
    lab.style.cssText = "display:flex;justify-content:space-between;gap:8px;font-size:12px;opacity:.8;margin-bottom:2px;";
    row.appendChild(lab);
    this.body.appendChild(row);
    return { row: row, id: id, label: lab };
  };
  Tweak.prototype._bind = function (obj, prop, input, read, write) {
    var initial = obj[prop], self = this;
    var b = { obj: obj, prop: prop, initial: initial, write: write };
    this.bindings.push(b);
    input.addEventListener("input", function () { obj[prop] = read(); self.onChange(obj, prop); });
    input.addEventListener("change", function () { obj[prop] = read(); self.onChange(obj, prop); });
    return b;
  };
  Tweak.prototype.addSlider = function (obj, prop, o) {
    o = o || {};
    var r = this._row(o.label || prop);
    var out = el("span", null, obj[prop] + (o.unit || ""));
    r.label.appendChild(out);
    var input = el("input", { type: "range", id: r.id, min: o.min != null ? o.min : 0, max: o.max != null ? o.max : 100, step: o.step || 1, value: obj[prop] });
    input.style.width = "100%";
    r.row.appendChild(input);
    this._bind(obj, prop, input, function () { var v = Number(input.value); out.textContent = v + (o.unit || ""); return v; },
      function (v) { input.value = v; out.textContent = v + (o.unit || ""); });
    return this;
  };
  Tweak.prototype.addColorPicker = function (obj, prop, o) {
    o = o || {};
    var r = this._row(o.label || prop);
    var input = el("input", { type: "color", id: r.id, value: obj[prop] });
    input.style.cssText = "width:100%;height:28px;border:0;background:none;";
    r.row.appendChild(input);
    this._bind(obj, prop, input, function () { return input.value; }, function (v) { input.value = v; });
    return this;
  };
  Tweak.prototype.addToggle = function (obj, prop, o) {
    o = o || {};
    var r = this._row(o.label || prop);
    var input = el("input", { type: "checkbox", id: r.id });
    input.checked = !!obj[prop];
    r.label.insertBefore(input, r.label.firstChild);
    r.label.style.justifyContent = "flex-start";
    this._bind(obj, prop, input, function () { return input.checked; }, function (v) { input.checked = !!v; });
    return this;
  };
  Tweak.prototype.addSelect = function (obj, prop, o) {
    o = o || {};
    var r = this._row(o.label || prop);
    var input = el("select", { id: r.id });
    input.style.cssText = "width:100%;min-height:28px;";
    (o.options || []).forEach(function (opt) {
      var v = typeof opt === "object" ? opt.value : opt;
      var t = typeof opt === "object" ? opt.label : opt;
      var op = el("option", { value: v }, t);
      if (String(v) === String(obj[prop])) op.selected = true;
      input.appendChild(op);
    });
    r.row.appendChild(input);
    this._bind(obj, prop, input, function () { return input.value; }, function (v) { input.value = v; });
    return this;
  };
  Tweak.prototype.values = function () {
    var out = {};
    this.bindings.forEach(function (b) { out[b.prop] = b.obj[b.prop]; });
    return out;
  };
  Tweak.prototype.reset = function () {
    var self = this;
    this.bindings.forEach(function (b) { b.obj[b.prop] = b.initial; b.write(b.initial); });
    this.onChange();
    return self;
  };
  Tweak.prototype.destroy = function () { if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root); };
  global.Tweak = Tweak;
})(typeof window !== "undefined" ? window : this);
