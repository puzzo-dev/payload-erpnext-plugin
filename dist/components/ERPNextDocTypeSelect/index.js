"use strict";
"use client";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/components/ERPNextDocTypeSelect/index.tsx
var ERPNextDocTypeSelect_exports = {};
__export(ERPNextDocTypeSelect_exports, {
  ERPNextDocTypeSelect: () => ERPNextDocTypeSelect,
  default: () => ERPNextDocTypeSelect_default
});
module.exports = __toCommonJS(ERPNextDocTypeSelect_exports);
var import_react = require("react");
var import_ui = require("@payloadcms/ui");
var import_jsx_runtime = require("react/jsx-runtime");
var ERPNextDocTypeSelect = () => {
  const { value, setValue } = (0, import_ui.useField)({ path: "doctype" });
  const { getData } = (0, import_ui.useForm)();
  const [options, setOptions] = (0, import_react.useState)([]);
  const [loading, setLoading] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)(null);
  (0, import_react.useEffect)(() => {
    const data = getData();
    const siteId = typeof data.site === "object" && data.site !== null ? data.site.id : data.site;
    if (!siteId) {
      setOptions([]);
      setError("Select a site to load DocTypes from ERPNext.");
      return;
    }
    setLoading(true);
    setError(null);
    fetch(`/api/erpnext-doctypes?siteId=${siteId}`).then(async (res) => {
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      return res.json();
    }).then((json) => {
      setOptions(json.doctypes ?? []);
    }).catch((err) => {
      setError(err instanceof Error ? err.message : "Failed to load DocTypes");
      setOptions([]);
    }).finally(() => setLoading(false));
  }, [getData]);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginBottom: "1rem" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { style: { display: "block", marginBottom: "0.25rem", fontWeight: 600 }, children: "ERPNext DocType" }),
    error && !options.length && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { color: "var(--theme-warning-500, #f59e0b)", fontSize: "0.85rem", marginBottom: "0.5rem" }, children: error }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "select",
      {
        value: value || "",
        onChange: (e) => setValue(e.target.value),
        disabled: loading || options.length === 0,
        style: {
          width: "100%",
          padding: "0.5rem",
          borderRadius: "0.25rem",
          border: "1px solid var(--theme-elevation-150, #d1d5db)",
          background: "var(--theme-input-bg, #fff)",
          color: "var(--theme-text, #111)"
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "", children: loading ? "Loading DocTypes\u2026" : "Select a DocType" }),
          options.map((opt) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("option", { value: opt.value, children: [
            opt.label,
            " ",
            opt.module ? `\u2014 ${opt.module}` : ""
          ] }, opt.value))
        ]
      }
    )
  ] });
};
var ERPNextDocTypeSelect_default = ERPNextDocTypeSelect;
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ERPNextDocTypeSelect
});
