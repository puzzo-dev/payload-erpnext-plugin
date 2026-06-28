"use client";
import "../../chunk-Y6FXYEAI.mjs";

// src/components/ERPNextDocTypeSelect/index.tsx
import { useEffect, useState } from "react";
import { useField, useForm } from "@payloadcms/ui";
import { jsx, jsxs } from "react/jsx-runtime";
var ERPNextDocTypeSelect = () => {
  const { value, setValue } = useField({ path: "doctype" });
  const { getData } = useForm();
  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
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
  return /* @__PURE__ */ jsxs("div", { style: { marginBottom: "1rem" }, children: [
    /* @__PURE__ */ jsx("label", { style: { display: "block", marginBottom: "0.25rem", fontWeight: 600 }, children: "ERPNext DocType" }),
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
          /* @__PURE__ */ jsx("option", { value: "", children: loading ? "Loading DocTypes\u2026" : "Select a DocType" }),
          options.map((opt) => /* @__PURE__ */ jsxs("option", { value: opt.value, children: [
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
export {
  ERPNextDocTypeSelect,
  ERPNextDocTypeSelect_default as default
};
