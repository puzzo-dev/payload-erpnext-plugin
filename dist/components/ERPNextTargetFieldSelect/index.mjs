"use client";
import "../../chunk-Y6FXYEAI.mjs";

// src/components/ERPNextTargetFieldSelect/index.tsx
import { useEffect, useState } from "react";
import { useField, useForm } from "@payloadcms/ui";
import { jsx, jsxs } from "react/jsx-runtime";
var ERPNextTargetFieldSelect = ({ path }) => {
  const { value, setValue } = useField({ path });
  const { getData } = useForm();
  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    const parts = path.split(".");
    const blockIndex = parts.findIndex((p) => p === "steps") + 1;
    const blockNum = parts[blockIndex];
    const data = getData();
    const siteObj = data?.site;
    const siteId = typeof siteObj === "object" && siteObj !== null ? siteObj.id : siteObj;
    const doctype = data?.steps?.[blockNum]?.doctype;
    if (!siteId) {
      setOptions([]);
      setError("Select a site first.");
      return;
    }
    if (!doctype) {
      setOptions([]);
      setError("Select an ERPNext DocType first.");
      return;
    }
    setLoading(true);
    setError(null);
    fetch(`/api/erpnext-doctype-fields?siteId=${siteId}&doctype=${doctype}`).then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }).then((json) => {
      setOptions(json.fields ?? []);
    }).catch((err) => {
      setError(err.message);
    }).finally(() => setLoading(false));
  }, [getData, path]);
  return /* @__PURE__ */ jsxs("div", { style: { marginBottom: "1rem" }, children: [
    /* @__PURE__ */ jsx("label", { className: "field-label", style: { display: "block", marginBottom: "0.25rem", fontWeight: 600 }, children: "ERPNext Target Field" }),
    error && !options.length && /* @__PURE__ */ jsx("div", { style: { color: "var(--theme-warning-500, #f59e0b)", fontSize: "0.85rem", marginBottom: "0.5rem" }, children: error }),
    /* @__PURE__ */ jsxs(
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
          /* @__PURE__ */ jsx("option", { value: "", children: loading ? "Loading fields\u2026" : "Select a Field" }),
          options.map((opt) => /* @__PURE__ */ jsxs("option", { value: opt.value, children: [
            opt.label,
            " (",
            opt.value,
            ")"
          ] }, opt.value))
        ]
      }
    )
  ] });
};
var ERPNextTargetFieldSelect_default = ERPNextTargetFieldSelect;
export {
  ERPNextTargetFieldSelect,
  ERPNextTargetFieldSelect_default as default
};
