"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  authHeaders: () => authHeaders,
  enqueueForwardToERPNext: () => enqueueForwardToERPNext,
  erpnextPlugin: () => erpnextPlugin,
  executeERPNextWorkflows: () => executeERPNextWorkflows,
  forwardToERPNext: () => forwardToERPNext2,
  forwardToERPNextJob: () => forwardToERPNext,
  getCredentials: () => getCredentials,
  verifyERPNextWebhookSignature: () => verifyERPNextWebhookSignature
});
module.exports = __toCommonJS(index_exports);

// src/types.ts
var import_node_crypto = require("crypto");
var INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;
function isInternalAuth(req) {
  if (!INTERNAL_API_SECRET) return false;
  const authSecret = req.headers?.get("x-internal-auth");
  if (!authSecret) return false;
  const a = Buffer.from(authSecret);
  const b = Buffer.from(INTERNAL_API_SECRET);
  if (a.byteLength !== b.byteLength) return false;
  return (0, import_node_crypto.timingSafeEqual)(a, b);
}
var getUserSiteId = (user) => {
  if (!user.site) return null;
  if (typeof user.site === "object") return user.site.id;
  return user.site;
};

// src/access/roles.ts
var superAdminOnly = ({ req: { user } }) => {
  if (!user) return false;
  return user.role === "super-admin";
};
var siteScopedRead = (siteField = "site") => {
  return ({ req }) => {
    if (isInternalAuth(req)) return true;
    if (!req.user) return false;
    const u = req.user;
    if (u.role === "super-admin") return true;
    const siteId = getUserSiteId(u);
    if (!siteId) return false;
    return { [siteField]: { equals: siteId } };
  };
};
var siteScopedCreate = ({ req }) => {
  if (isInternalAuth(req)) return true;
  if (!req.user) return false;
  const role = req.user.role;
  return ["super-admin", "admin", "editor"].includes(role);
};
var siteScopedUpdate = (siteField = "site") => {
  return ({ req }) => {
    if (isInternalAuth(req)) return true;
    if (!req.user) return false;
    const u = req.user;
    if (u.role === "super-admin") return true;
    const siteId = getUserSiteId(u);
    if (!siteId) return false;
    return { [siteField]: { equals: siteId } };
  };
};
var siteScopedDelete = (siteField = "site") => {
  return ({ req }) => {
    if (isInternalAuth(req)) return true;
    if (!req.user) return false;
    const u = req.user;
    if (u.role === "super-admin") return true;
    if (u.role === "admin") {
      const siteId = getUserSiteId(u);
      if (!siteId) return false;
      return { [siteField]: { equals: siteId } };
    }
    return false;
  };
};

// src/fields/organizationField.ts
var organizationField = (overrides) => ({
  name: "organization",
  type: "relationship",
  relationTo: "organizations",
  required: true,
  admin: {
    description: "The organization this belongs to"
  },
  ...overrides
});

// src/utils/erpnextCrypto.ts
var import_crypto = require("crypto");
var ALGORITHM = "aes-256-gcm";
var IV_LENGTH = 12;
var PREFIX = "enc:";
var cachedKey = null;
var initialized = false;
function getEncryptionKey() {
  if (initialized) return cachedKey;
  const hex = process.env.ERPNEXT_ENCRYPTION_KEY;
  if (!hex) {
    if (process.env.NODE_ENV === "production") {
      console.warn("[erpnext-crypto] ERPNEXT_ENCRYPTION_KEY not set \u2014 ERPNext credentials will be stored in plain text.");
    }
    initialized = true;
    return null;
  }
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== 32) {
    throw new Error("[erpnext-crypto] FATAL: ERPNEXT_ENCRYPTION_KEY must be exactly 32 bytes (64 hex chars).");
  }
  cachedKey = buf;
  initialized = true;
  return cachedKey;
}
getEncryptionKey();
function encryptCredential(plaintext) {
  const key = getEncryptionKey();
  if (!key) return plaintext;
  if (plaintext.startsWith(PREFIX)) return plaintext;
  const iv = (0, import_crypto.randomBytes)(IV_LENGTH);
  const cipher = (0, import_crypto.createCipheriv)(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}
function decryptCredential(stored) {
  const key = getEncryptionKey();
  if (!key) return stored;
  if (!stored.startsWith(PREFIX)) return stored;
  try {
    const payload = stored.slice(PREFIX.length);
    const [ivHex, tagHex, ciphertextHex] = payload.split(":");
    if (!ivHex || !tagHex || !ciphertextHex) return stored;
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const ciphertext = Buffer.from(ciphertextHex, "hex");
    const decipher = (0, import_crypto.createDecipheriv)(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString("utf8");
  } catch (err) {
    console.error("[erpnext-crypto] Failed to decrypt credential:", err);
    return stored;
  }
}

// src/collections/ERPNextConfig.ts
async function encryptBeforeChange({ value, previousDoc, field, req }) {
  if (typeof value === "string" && value && !value.startsWith("\u2022\u2022\u2022\u2022")) {
    return encryptCredential(value);
  }
  if (typeof value === "string" && value.startsWith("\u2022\u2022\u2022\u2022")) {
    if (!previousDoc?.id) {
      throw new Error(`Cannot save masked credential for ${field.name}. Please re-enter the API Key/Secret.`);
    }
    const rawConfig = await req.payload.findByID({
      collection: "erpnext-config",
      id: previousDoc.id,
      depth: 0,
      overrideAccess: true,
      context: { preventMasking: true, skipAutoFetch: true }
    });
    const decrypted = rawConfig[field.name];
    return decrypted && typeof decrypted === "string" ? encryptCredential(decrypted) : value;
  }
  return value;
}
function decryptAfterRead({ value, req, context }) {
  if (typeof value !== "string") return value;
  const decrypted = decryptCredential(value);
  const ctx = req?.context || context || {};
  if (ctx.preventMasking) return decrypted;
  if (req?.user && decrypted.length > 4) {
    return "\u2022\u2022\u2022\u2022" + decrypted.slice(-4);
  }
  return decrypted;
}
var autoFetchFromERPNext = async ({ doc, previousDoc, operation, req }) => {
  const erpnextUrl = doc.erpnextUrl;
  if (!erpnextUrl) return doc;
  if (operation === "update" && previousDoc) {
    const alreadyConnected = doc.connectionStatus === "connected";
    const hasCompanies = Array.isArray(doc.availableCompanies) ? doc.availableCompanies.length > 0 : false;
    if (alreadyConnected && hasCompanies) {
      return doc;
    }
  }
  const rawConfig = await req.payload.findByID({
    collection: "erpnext-config",
    id: doc.id,
    depth: 0,
    overrideAccess: true,
    context: { preventMasking: true, skipAutoFetch: true }
  });
  const apiKey = rawConfig.apiKey;
  const apiSecret = rawConfig.apiSecret;
  if (!apiKey || !apiSecret) return doc;
  const decryptedKey = decryptCredential(apiKey);
  const decryptedSecret = decryptCredential(apiSecret);
  if (!decryptedKey || !decryptedSecret) return doc;
  const normalizedUrl = erpnextUrl.replace(/\/+$/, "");
  if (!normalizedUrl.startsWith("https://")) return doc;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `token ${decryptedKey}:${decryptedSecret}`
  };
  let companies = [];
  let leadSources = [];
  let connected = false;
  try {
    const companiesRes = await fetch(
      `${normalizedUrl}/api/resource/Company?fields=["name","company_name","country","default_currency"]&limit_page_length=100`,
      { method: "GET", headers, signal: AbortSignal.timeout(15e3) }
    );
    if (companiesRes.ok) {
      const result = await companiesRes.json();
      companies = (result.data ?? []).map((c) => ({
        name: c.name,
        company_name: c.company_name,
        country: c.country || void 0,
        default_currency: c.default_currency || void 0
      }));
      connected = true;
    }
    const leadSourcesRes = await fetch(
      `${normalizedUrl}/api/resource/Lead%20Source?fields=["name","source_name"]&limit_page_length=100`,
      { method: "GET", headers, signal: AbortSignal.timeout(15e3) }
    );
    if (leadSourcesRes.ok) {
      const result = await leadSourcesRes.json();
      leadSources = (result.data ?? []).map((ls) => ({
        name: ls.name,
        source_name: ls.source_name
      }));
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    await req.payload.update({
      collection: "erpnext-config",
      id: doc.id,
      data: {
        availableCompanies: companies,
        lastCompanyFetchAt: now,
        availableLeadSources: leadSources,
        lastLeadSourceFetchAt: now,
        connectionStatus: connected ? "connected" : "disconnected"
      },
      overrideAccess: true,
      // CRITICAL: prevent infinite loop — this update must NOT trigger afterChange again
      context: { skipAutoFetch: true }
    });
    req.payload.logger.info(
      `[ERPNextConfig] Auto-fetched ${companies.length} companies and ${leadSources.length} lead sources from ${normalizedUrl}`
    );
  } catch (err) {
    req.payload.logger.warn(`[ERPNextConfig] Auto-fetch failed: ${err}`);
    try {
      await req.payload.update({
        collection: "erpnext-config",
        id: doc.id,
        data: { connectionStatus: "disconnected" },
        overrideAccess: true,
        context: { skipAutoFetch: true }
      });
    } catch {
    }
  }
  return doc;
};
var ERPNextConfig = {
  slug: "erpnext-config",
  admin: {
    useAsTitle: "label",
    defaultColumns: ["label", "erpnextUrl", "connectionStatus", "erpnextCompany", "isActive", "createdAt"],
    group: "Integrations"
  },
  access: {
    read: siteScopedRead(),
    create: siteScopedCreate,
    update: siteScopedUpdate(),
    delete: siteScopedDelete()
  },
  hooks: {
    afterChange: [
      (args) => {
        if (args.context?.skipAutoFetch) return args.doc;
        const payload = args.req.payload;
        const docRef = args.doc;
        setTimeout(() => {
          autoFetchFromERPNext({ ...args, doc: docRef }).catch((err) => {
            payload.logger.error(`[ERPNextConfig] Background auto-fetch failed: ${err}`);
          });
        }, 2e3);
        return args.doc;
      }
    ]
  },
  fields: [
    // ── Label + Site + Active (always visible, above tabs) ──────
    {
      name: "label",
      type: "text",
      required: true,
      admin: { description: 'Friendly name, e.g. "iVarse ERPNext"' }
    },
    {
      type: "row",
      fields: [
        {
          name: "site",
          type: "relationship",
          relationTo: "sites",
          required: true,
          admin: {
            description: "The site this ERPNext config belongs to (one per site)",
            width: "70%"
          }
        },
        {
          name: "isActive",
          type: "checkbox",
          defaultValue: true,
          admin: { width: "30%" }
        }
      ]
    },
    organizationField(),
    // ═══════════════════════════════════════════════════════════
    //  TABS
    // ═══════════════════════════════════════════════════════════
    {
      type: "tabs",
      tabs: [
        // ── Tab 1: Connection ────────────────────────────────
        {
          label: "\u{1F511} Connection",
          description: "Enter your ERPNext API credentials and save. Companies and Lead Sources will be fetched automatically.",
          fields: [
            {
              name: "erpnextUrl",
              type: "text",
              required: true,
              admin: {
                description: "ERPNext instance URL (e.g. https://erp.ivarse.com)"
              }
            },
            {
              type: "row",
              fields: [
                {
                  name: "apiKey",
                  type: "text",
                  required: true,
                  admin: {
                    description: "ERPNext API Key (from User \u2192 API Access)",
                    width: "50%"
                  },
                  hooks: {
                    beforeChange: [
                      async ({ value, previousDoc, req }) => await encryptBeforeChange({ value, previousDoc, field: { name: "apiKey" }, req })
                    ],
                    afterRead: [
                      ({ value, req, context }) => decryptAfterRead({ value, req, context })
                    ]
                  }
                },
                {
                  name: "apiSecret",
                  type: "text",
                  required: true,
                  admin: {
                    description: "ERPNext API Secret",
                    width: "50%"
                  },
                  hooks: {
                    beforeChange: [
                      async ({ value, previousDoc, req }) => await encryptBeforeChange({ value, previousDoc, field: { name: "apiSecret" }, req })
                    ],
                    afterRead: [
                      ({ value, req, context }) => decryptAfterRead({ value, req, context })
                    ]
                  }
                }
              ]
            },
            // Connection status (read-only feedback)
            {
              name: "connectionStatus",
              type: "select",
              defaultValue: "untested",
              options: [
                { label: "\u2705 Connected", value: "connected" },
                { label: "\u274C Disconnected", value: "disconnected" },
                { label: "\u23F3 Untested", value: "untested" }
              ],
              admin: {
                description: "Connection health \u2014 updated automatically when you save.",
                readOnly: true
              }
            }
          ]
        },
        // ── Tab 2: ERPNext Settings ──────────────────────────
        {
          label: "\u{1F3E2} ERPNext Settings",
          description: "Select the company and lead source for this site. These lists are auto-populated from ERPNext after saving credentials.",
          fields: [
            // Company dropdown — custom component fetches data from API
            {
              name: "erpnextCompany",
              type: "text",
              admin: {
                description: "Auto-injected into submissions for company-aware doctypes.",
                components: {
                  Field: {
                    path: "./components/CompanySelect/index",
                    exportName: "CompanySelectField"
                  }
                }
              }
            },
            // Lead source dropdown — custom component fetches data from API
            {
              name: "leadSource",
              type: "text",
              admin: {
                description: 'Auto-injected into Lead submissions as the "source" field.',
                components: {
                  Field: {
                    path: "./components/LeadSourceSelect/index",
                    exportName: "LeadSourceSelectField"
                  }
                }
              }
            },
            // Hidden data stores — not shown in UI, used by API only
            { name: "availableCompanies", type: "json", admin: { hidden: true } },
            { name: "lastCompanyFetchAt", type: "date", admin: { hidden: true } },
            { name: "availableLeadSources", type: "json", admin: { hidden: true } },
            { name: "lastLeadSourceFetchAt", type: "date", admin: { hidden: true } }
          ]
        },
        // ── Tab 3: DocType Mapping ───────────────────────────
        {
          label: "\u{1F5C2} Mapping",
          description: "Configure how Payload form submissions map to ERPNext document types.",
          fields: [
            {
              name: "defaultDocType",
              type: "text",
              defaultValue: "Lead",
              admin: {
                description: "Default ERPNext DocType to create from form submissions. Fetched live from the connected ERPNext site.",
                components: {
                  Field: {
                    path: "./components/ERPNextDocTypeSelect/index",
                    exportName: "ERPNextDocTypeSelectField"
                  }
                }
              }
            },
            {
              name: "customDocType",
              type: "text",
              admin: {
                description: "Custom DocType name (use when the desired DocType is not in the fetched list)",
                condition: (_data, siblingData) => !siblingData?.defaultDocType
              }
            },
            {
              name: "fieldMappings",
              type: "array",
              admin: {
                description: "Map Payload form field names \u2192 ERPNext field names. Leave empty to send raw submission data."
              },
              fields: [
                {
                  name: "formFieldName",
                  type: "text",
                  required: true,
                  admin: { description: 'Payload form field name (e.g. "email", "name", "message")' }
                },
                {
                  name: "erpnextFieldName",
                  type: "text",
                  required: true,
                  admin: { description: 'ERPNext field name (e.g. "email_id", "lead_name", "notes")' }
                }
              ]
            }
          ]
        },
        // ── Tab 4: Inbound Webhooks ──────────────────────────
        {
          label: "\u{1F514} Webhooks",
          description: "Configure inbound webhooks from ERPNext to Payload.",
          fields: [
            {
              name: "webhookSecret",
              type: "text",
              admin: {
                description: "HMAC-SHA256 secret for verifying inbound ERPNext webhooks. Set in ERPNext \u2192 Webhook \u2192 Secret."
              },
              hooks: {
                beforeChange: [
                  async ({ value, previousDoc, req }) => await encryptBeforeChange({ value, previousDoc, field: { name: "webhookSecret" }, req })
                ],
                afterRead: [
                  ({ value, req, context }) => decryptAfterRead({ value, req, context })
                ]
              }
            },
            {
              name: "syncCollections",
              type: "select",
              hasMany: true,
              defaultValue: ["insights"],
              options: [
                { label: "Insights (Blog Posts)", value: "insights" }
              ],
              admin: { description: "Which Payload collections should accept data from ERPNext webhooks (Jobs are fetched directly via proxy)" }
            }
          ]
        }
      ]
    }
  ],
  timestamps: true
};

// src/collections/ERPNextDeadLetter.ts
var ERPNextDeadLetter = {
  slug: "erpnext-dead-letters",
  admin: {
    useAsTitle: "submissionId",
    defaultColumns: ["submissionId", "docType", "errorCategory", "retryCount", "status", "createdAt"],
    group: "Integrations",
    description: "Failed ERPNext forwards awaiting retry or manual resolution"
  },
  access: {
    read: superAdminOnly,
    create: superAdminOnly,
    update: superAdminOnly,
    delete: superAdminOnly
  },
  fields: [
    {
      name: "submissionId",
      type: "text",
      required: true,
      admin: { description: "Original form-submission document ID" }
    },
    {
      name: "site",
      type: "relationship",
      relationTo: "sites",
      required: true
    },
    {
      name: "erpnextUrl",
      type: "text",
      required: true
    },
    {
      name: "docType",
      type: "text",
      required: true
    },
    {
      name: "payload",
      type: "json",
      required: true,
      admin: { description: "The JSON payload that was sent (or attempted)" }
    },
    {
      name: "errorCategory",
      type: "select",
      required: true,
      options: [
        { label: "Network Timeout", value: "timeout" },
        { label: "HTTP 4xx (Client Error)", value: "client-error" },
        { label: "HTTP 5xx (Server Error)", value: "server-error" },
        { label: "TLS / Connection Refused", value: "tls-error" },
        { label: "Unexpected Exception", value: "exception" }
      ]
    },
    {
      name: "errorDetail",
      type: "textarea",
      admin: { description: "Full error message or response body" }
    },
    {
      name: "httpStatus",
      type: "number",
      admin: { description: "HTTP status code returned by ERPNext (if any)" }
    },
    {
      name: "retryCount",
      type: "number",
      defaultValue: 0,
      admin: { description: "How many automatic retries have been attempted" }
    },
    {
      name: "lastRetryAt",
      type: "date",
      admin: { description: "Timestamp of the last retry attempt" }
    },
    {
      name: "status",
      type: "select",
      defaultValue: "pending",
      options: [
        { label: "Pending Retry", value: "pending" },
        { label: "Replayed (Success)", value: "success" },
        { label: "Replayed (Failed)", value: "failed" },
        { label: "Archived (Manual)", value: "archived" }
      ]
    },
    {
      name: "correlationId",
      type: "text",
      admin: { description: "Trace ID for cross-reference with application logs" }
    },
    {
      name: "workflow",
      type: "text",
      admin: { description: "Workflow label that produced this failure" }
    },
    {
      name: "requestLabel",
      type: "text",
      admin: { description: "Request label within the workflow" }
    }
  ],
  timestamps: true
};

// src/collections/ERPNextFormWorkflows.ts
var ERPNextFormWorkflows = {
  slug: "erpnext-form-workflows",
  admin: {
    useAsTitle: "label",
    defaultColumns: ["label", "form", "site", "enabled", "updatedAt"],
    group: "Integrations"
  },
  access: {
    read: siteScopedRead(),
    create: siteScopedCreate,
    update: siteScopedUpdate(),
    delete: siteScopedDelete()
  },
  fields: [
    {
      name: "label",
      type: "text",
      required: true,
      admin: { description: 'e.g. "Avril Booking \u2192 Lead + Event Booking"' }
    },
    {
      name: "form",
      type: "relationship",
      relationTo: "forms",
      required: true,
      admin: { description: "The Payload form that triggers this workflow" }
    },
    {
      type: "row",
      fields: [
        {
          name: "site",
          type: "relationship",
          relationTo: "sites",
          required: true,
          admin: { width: "70%" }
        },
        {
          name: "enabled",
          type: "checkbox",
          defaultValue: true,
          admin: { width: "30%" }
        }
      ]
    },
    organizationField(),
    {
      name: "requests",
      type: "array",
      required: true,
      admin: {
        description: "Requests run in ascending position order. A later request can use values produced by an earlier request by referencing its Reference Key."
      },
      fields: [
        {
          type: "row",
          fields: [
            {
              name: "position",
              type: "number",
              required: true,
              defaultValue: 1,
              admin: { width: "15%", description: "Execution order" }
            },
            {
              name: "label",
              type: "text",
              required: true,
              admin: { width: "35%", description: 'e.g. "Create Lead"' }
            },
            {
              name: "doctype",
              type: "text",
              required: true,
              admin: {
                width: "25%",
                description: "ERPNext DocType fetched from the site connection.",
                components: {
                  Field: {
                    path: "./components/ERPNextDocTypeSelect/index",
                    exportName: "ERPNextDocTypeSelectField"
                  }
                }
              }
            },
            {
              name: "action",
              type: "select",
              required: true,
              defaultValue: "create",
              options: [
                { label: "Create", value: "create" },
                { label: "Get", value: "get" },
                { label: "Update", value: "update" }
              ],
              admin: { width: "25%" }
            }
          ]
        },
        {
          name: "enabled",
          type: "checkbox",
          defaultValue: true,
          admin: { description: "Uncheck to skip this request without removing it" }
        },
        {
          name: "referenceKey",
          type: "text",
          admin: {
            description: `Key used to store this request's result so later requests can reference it (e.g. "lead"). Leave blank to ignore the result.`
          }
        },
        {
          name: "referencePath",
          type: "text",
          defaultValue: "data.name",
          admin: {
            description: "Path to the value extracted from the ERPNext response and stored under Reference Key (e.g. data.name, message.name)."
          }
        },
        {
          name: "condition",
          type: "text",
          admin: {
            description: "Optional JS expression evaluated against the submission and prior results. Skip request if falsy. Example: values.event_date && values.guest_count"
          }
        },
        {
          name: "optional",
          type: "checkbox",
          defaultValue: false,
          admin: {
            description: 'For get/update: a "not found" response is treated as success and does not create a dead letter. Later requests can test references.{referenceKey} to decide whether to create the record.'
          }
        },
        {
          name: "fieldMappings",
          type: "array",
          admin: { description: "Map form submission values to ERPNext fields" },
          fields: [
            {
              name: "formFieldName",
              type: "text",
              required: true,
              admin: { description: "Payload form field name (e.g. email, name)" }
            },
            {
              name: "erpFieldName",
              type: "text",
              required: true,
              admin: { description: "ERPNext field name (e.g. email_id, lead_name)" }
            }
          ]
        },
        {
          name: "staticValues",
          type: "array",
          admin: { description: "Hard-coded ERPNext fields added to every request" },
          fields: [
            {
              name: "field",
              type: "text",
              required: true,
              admin: { description: "ERPNext field name" }
            },
            {
              name: "value",
              type: "text",
              required: true,
              admin: { description: "Static value" }
            }
          ]
        },
        {
          name: "referenceMappings",
          type: "array",
          admin: { description: "Map values from earlier requests (by Reference Key) into ERPNext fields" },
          fields: [
            {
              name: "referenceKey",
              type: "text",
              required: true,
              admin: { description: "Reference key of an earlier request" }
            },
            {
              name: "referencePath",
              type: "text",
              defaultValue: "name",
              admin: { description: "Path within the stored result (e.g. name, data.name)" }
            },
            {
              name: "erpFieldName",
              type: "text",
              required: true,
              admin: { description: "ERPNext field name to receive the value" }
            }
          ]
        },
        {
          name: "filters",
          type: "array",
          admin: { description: "For get/update: filters used to find the ERPNext document. Mapped like field mappings." },
          fields: [
            {
              name: "formFieldName",
              type: "text",
              admin: { description: "Payload form field name (leave blank to use static value)" }
            },
            {
              name: "staticValue",
              type: "text",
              admin: { description: "Static filter value" }
            },
            {
              name: "erpFieldName",
              type: "text",
              required: true,
              admin: { description: "ERPNext filter field" }
            },
            {
              name: "operator",
              type: "select",
              defaultValue: "=",
              options: [
                { label: "Equals", value: "=" },
                { label: "Like", value: "like" }
              ]
            }
          ]
        }
      ]
    }
  ],
  timestamps: true
};

// src/utils/rateLimit.ts
var import_ioredis = __toESM(require("ioredis"));
var MAX_STORE_SIZE = 5e4;
var CLEANUP_INTERVAL_MS = 5 * 60 * 1e3;
var redisClient = null;
var redisChecked = false;
function ensureRedisInProduction() {
  if (redisChecked) return;
  redisChecked = true;
  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction && !process.env.REDIS_URL) {
    console.warn(
      "[rateLimit] REDIS_URL not set in production. Falling back to in-memory rate limiting. This is safe for single-container deployments but will not share state across multiple instances."
    );
  }
  if (process.env.REDIS_URL && !redisClient) {
    redisClient = new import_ioredis.default(process.env.REDIS_URL);
  }
}
var InMemoryRateLimiter = class {
  store = /* @__PURE__ */ new Map();
  constructor() {
    setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }
  check(key, maxRequests, windowMs) {
    const now = Date.now();
    const entry = this.store.get(key);
    if (!entry || entry.resetAt < now) {
      this.store.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true };
    }
    if (entry.count >= maxRequests) {
      return { allowed: false, retryAfterMs: entry.resetAt - now };
    }
    entry.count++;
    return { allowed: true };
  }
  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.resetAt < now) this.store.delete(key);
    }
    if (this.store.size > MAX_STORE_SIZE) {
      const sorted = Array.from(this.store.entries()).sort((a, b) => a[1].resetAt - b[1].resetAt);
      const toDelete = sorted.slice(0, this.store.size - MAX_STORE_SIZE);
      for (const [key] of toDelete) this.store.delete(key);
    }
  }
};
var limiter = new InMemoryRateLimiter();
async function checkRateLimit(key, maxRequests, windowMs) {
  ensureRedisInProduction();
  if (redisClient) {
    try {
      const now = Date.now();
      const pipeline = redisClient.pipeline();
      pipeline.zremrangebyscore(key, 0, now - windowMs);
      pipeline.zcard(key);
      pipeline.zadd(key, now, `${now}-${Math.random()}`);
      pipeline.pexpire(key, windowMs);
      const results = await pipeline.exec();
      const count = results?.[1]?.[1] || 0;
      if (count >= maxRequests) {
        return { allowed: false, retryAfterMs: windowMs };
      }
      return { allowed: true };
    } catch (error) {
      console.error("[rateLimit] Redis error, falling back to memory", error);
    }
  }
  return limiter.check(key, maxRequests, windowMs);
}
function getClientIp(req) {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp;
  const socketIp = req.socket?.remoteAddress ?? req.connection?.remoteAddress;
  if (socketIp) return socketIp;
  return `anon-${Math.random().toString(36).slice(2, 10)}`;
}

// src/endpoints/anonymousUpload.ts
var MAX_FILE_SIZE = 5 * 1024 * 1024;
var ALLOWED_MIME_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
];
var anonymousUploadEndpoint = {
  path: "/anonymous-upload",
  method: "post",
  handler: async (req) => {
    const payload = req.payload;
    const logger = payload.logger;
    const ip = getClientIp(req);
    const rateLimit = await checkRateLimit(`anonymous-upload:${ip}`, 5, 60 * 1e3);
    if (!rateLimit.allowed) {
      return Response.json({ error: "Rate limit exceeded. Please try again later." }, { status: 429 });
    }
    try {
      const formData = await req.formData?.();
      if (!formData) {
        return Response.json({ error: "Expected multipart/form-data" }, { status: 400 });
      }
      const file = formData.get("file");
      const site = formData.get("site");
      if (!file || !(file instanceof File) || file.size === 0) {
        return Response.json({ error: "No file provided" }, { status: 400 });
      }
      if (file.size > MAX_FILE_SIZE) {
        return Response.json({ error: `File exceeds ${MAX_FILE_SIZE / 1024 / 1024} MB limit` }, { status: 413 });
      }
      if (!ALLOWED_MIME_TYPES.includes(file.type)) {
        return Response.json({ error: "Unsupported file type" }, { status: 415 });
      }
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const mediaDoc = await payload.create({
        collection: "media",
        data: {
          alt: file.name,
          ...site ? { site } : {}
        },
        file: {
          data: buffer,
          name: file.name,
          mimetype: file.type,
          size: file.size
        },
        overrideAccess: true
      });
      const url = mediaDoc.url || mediaDoc.filename;
      logger.info(`[AnonymousUpload] Created media ${mediaDoc.id} for site ${site || "none"}`);
      return Response.json({ ok: true, mediaId: mediaDoc.id, url });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[AnonymousUpload] Failed: ${message}`);
      return Response.json({ error: "Upload failed" }, { status: 500 });
    }
  }
};

// src/endpoints/erpnextProxy.ts
var ALLOWED_SUBMIT_DOCTYPES = [
  "Lead",
  "Job Applicant",
  "Ticket",
  "HD Ticket",
  "Issue",
  "Blog Comment",
  "Contact",
  "Event",
  "Email Group Member"
];
var ALLOWED_READ_DOCTYPES = [
  ...ALLOWED_SUBMIT_DOCTYPES,
  "Blog Category",
  "Job Opening",
  "Ticket Type",
  "HD Ticket Type",
  "User",
  "Newsletter",
  "Company",
  "Lead Source"
];
var PUBLIC_READ_DOCTYPES = [
  "Job Opening",
  "Blog Category",
  "Ticket Type",
  "HD Ticket Type"
];
var COMPANY_AWARE_DOCTYPES = /* @__PURE__ */ new Set([
  "Lead",
  "Contact",
  "Customer",
  "Job Applicant",
  "Job Opening",
  "Ticket",
  "HD Ticket",
  "Issue"
]);
async function getCredentials(payload, siteSlug, req) {
  const findConfig = async (where) => {
    return payload.find({
      collection: "erpnext-config",
      where,
      limit: 1,
      depth: 0,
      overrideAccess: true,
      context: { preventMasking: true }
    });
  };
  const isMasked = (v) => v.includes("\u2022");
  const buildCreds = (cfg) => {
    const url = cfg.erpnextUrl?.replace(/\/+$/, "");
    const rawKey = cfg.apiKey;
    const rawSecret = cfg.apiSecret;
    const company = cfg.erpnextCompany || void 0;
    const leadSource = cfg.leadSource || void 0;
    if (!url || !rawKey || !rawSecret) return null;
    if (isMasked(rawKey) || isMasked(rawSecret)) {
      payload.logger.error(
        `[ERPNext-Proxy] Credential masking leaked through for config ${cfg.id}. This indicates a Payload framework bug. Failing closed \u2014 do NOT fall back to raw SQL.`
      );
      return null;
    }
    const apiKey = rawKey.startsWith("enc:") ? decryptCredential(rawKey) : rawKey;
    const apiSecret = rawSecret.startsWith("enc:") ? decryptCredential(rawSecret) : rawSecret;
    if (!apiKey || !apiSecret || isMasked(apiKey) || isMasked(apiSecret)) return null;
    return { url, apiKey, apiSecret, company, leadSource };
  };
  if (siteSlug) {
    const sites = await payload.find({
      collection: "sites",
      where: { slug: { equals: siteSlug } },
      limit: 1,
      depth: 0,
      overrideAccess: true
    });
    if (sites.totalDocs > 0) {
      const siteId = sites.docs[0].id;
      const configs = await findConfig({
        site: { equals: siteId },
        isActive: { equals: true }
      });
      if (configs.totalDocs > 0) {
        const cfg = configs.docs[0];
        const creds = buildCreds(cfg);
        if (creds) return creds;
      }
    }
  }
  return null;
}
function authHeaders(creds) {
  return {
    "Content-Type": "application/json",
    Authorization: `token ${creds.apiKey}:${creds.apiSecret}`
  };
}
async function parseERPNextError(response) {
  let msg = `ERPNext API error: ${response.status}`;
  try {
    const data = await response.json();
    if (data.exception) msg = String(data.exception);
    else if (data._server_messages) {
      const messages = JSON.parse(String(data._server_messages));
      if (messages.length > 0) {
        const parsed = JSON.parse(messages[0]);
        msg = parsed.message || msg;
      }
    } else if (data.message) msg = String(data.message);
  } catch {
  }
  return msg;
}
var ERPNEXT_RATE_LIMIT_MAX = 30;
var ERPNEXT_RATE_LIMIT_WINDOW_MS = 6e4;
async function validateProxyAccess(req) {
  const internalKey = process.env.ERPNEXT_PROXY_KEY;
  if (internalKey) {
    const provided = req.headers.get("x-internal-key");
    if (provided === internalKey) return { accessLevel: "internal" };
  }
  const origin = req.headers.get("origin") || req.headers.get("referer") || req.headers.get("x-trusted-origin") || "";
  if (!origin && req.user) return { accessLevel: "admin" };
  if (origin) {
    const trustedHosts = /* @__PURE__ */ new Set(["localhost", "127.0.0.1"]);
    const cmsHost = process.env.PAYLOAD_PUBLIC_SERVER_URL || process.env.NEXT_PUBLIC_PAYLOAD_URL || "";
    if (cmsHost) {
      try {
        trustedHosts.add(new URL(cmsHost).hostname);
      } catch {
      }
    }
    const extra = process.env.TRUSTED_ORIGINS || process.env.CORS_ORIGINS || "";
    if (extra) {
      for (const o of extra.split(",")) {
        const trimmed = o.trim();
        if (!trimmed) continue;
        try {
          trustedHosts.add(new URL(trimmed).hostname);
        } catch {
        }
      }
    }
    try {
      const sites = await req.payload.find({
        collection: "sites",
        limit: 100,
        depth: 0,
        overrideAccess: true
      });
      for (const site of sites.docs) {
        const s = site;
        if (s.internalDomain) {
          trustedHosts.add(s.internalDomain);
        }
        if (Array.isArray(s.allowedDomains)) {
          for (const d of s.allowedDomains) {
            if (d.domain) {
              try {
                trustedHosts.add(new URL(d.domain.startsWith("http") ? d.domain : `https://${d.domain}`).hostname);
              } catch {
                trustedHosts.add(d.domain);
              }
            }
          }
        }
      }
    } catch (err) {
      req.payload.logger.error(`[ERPNext-Proxy] Failed to fetch allowed domains: ${err}`);
    }
    try {
      const originHostname = new URL(origin).hostname;
      if (trustedHosts.has(originHostname)) return { accessLevel: "public" };
    } catch {
    }
  }
  return {
    error: Response.json(
      { error: "Unauthorized: invalid origin or missing internal key" },
      { status: 403 }
    ),
    accessLevel: "public"
  };
}
async function applyProxyRateLimit(req) {
  const ip = getClientIp(req);
  const result = await checkRateLimit(`erpnext-proxy:${ip}`, ERPNEXT_RATE_LIMIT_MAX, ERPNEXT_RATE_LIMIT_WINDOW_MS);
  if (!result.allowed) {
    return Response.json(
      { error: "Too many requests, please try again later" },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(result.retryAfterMs / 1e3)) }
      }
    );
  }
  return null;
}
var erpnextProxySubmit = {
  path: "/erpnext-proxy/submit",
  method: "post",
  handler: async (req) => {
    try {
      const { error: accessDenied } = await validateProxyAccess(req);
      if (accessDenied) return accessDenied;
      const rateLimited = await applyProxyRateLimit(req);
      if (rateLimited) return rateLimited;
      const body = typeof req.body === "string" ? JSON.parse(req.body) : await new Response(req.body).text().then((t) => JSON.parse(t));
      if (!body || typeof body !== "object") {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }
      const { doctype, data, site } = body;
      if (typeof doctype !== "string" || doctype.length === 0 || doctype.length > 120) {
        return Response.json({ error: "Missing or invalid required field: doctype (string, 1-120 chars)" }, { status: 400 });
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return Response.json({ error: "Missing or invalid required field: data (object)" }, { status: 400 });
      }
      if (site !== void 0 && (typeof site !== "string" || site.length > 120)) {
        return Response.json({ error: "Invalid field: site (string, max 120 chars)" }, { status: 400 });
      }
      if (!ALLOWED_SUBMIT_DOCTYPES.includes(doctype)) {
        return Response.json({ error: `Doctype "${doctype}" is not allowed` }, { status: 400 });
      }
      const creds = await getCredentials(req.payload, site, req);
      if (!creds) {
        req.payload.logger.error("[ERPNext-Proxy] No active ERPNext config found");
        return Response.json({ error: "ERPNext integration not configured" }, { status: 500 });
      }
      const submitData = { ...data };
      if (creds.company && COMPANY_AWARE_DOCTYPES.has(doctype)) {
        submitData.company = creds.company;
      }
      if (creds.leadSource && doctype === "Lead" && !submitData.source) {
        submitData.source = creds.leadSource;
      }
      const encodedDoctype = encodeURIComponent(doctype);
      const response = await fetch(`${creds.url}/api/resource/${encodedDoctype}`, {
        method: "POST",
        headers: authHeaders(creds),
        body: JSON.stringify(submitData),
        signal: AbortSignal.timeout(15e3)
      });
      if (!response.ok) {
        const msg = await parseERPNextError(response);
        req.payload.logger.warn(`[ERPNext-Proxy] Submit(${doctype}) failed: ${msg}`);
        return Response.json({ error: msg }, { status: response.status });
      }
      const result = await response.json();
      return Response.json(result);
    } catch (err) {
      req.payload.logger.error(`[ERPNext-Proxy] Submit error: ${err}`);
      return Response.json({ error: "Failed to submit to ERPNext" }, { status: 500 });
    }
  }
};
var erpnextProxyResource = {
  path: "/erpnext-proxy/resource",
  method: "get",
  handler: async (req) => {
    try {
      const { error: accessDenied, accessLevel } = await validateProxyAccess(req);
      if (accessDenied) return accessDenied;
      const rateLimited = await applyProxyRateLimit(req);
      if (rateLimited) return rateLimited;
      const url = new URL(req.url || "", "http://localhost");
      const doctype = url.searchParams.get("doctype");
      const name = url.searchParams.get("name");
      const fields = url.searchParams.get("fields");
      const filters = url.searchParams.get("filters");
      const limitPageLength = url.searchParams.get("limit_page_length");
      const site = url.searchParams.get("site");
      if (!doctype) {
        return Response.json({ error: "Missing doctype query param" }, { status: 400 });
      }
      if (!ALLOWED_READ_DOCTYPES.includes(doctype)) {
        return Response.json({ error: `Doctype "${doctype}" is not allowed` }, { status: 400 });
      }
      if (accessLevel === "public" && !PUBLIC_READ_DOCTYPES.includes(doctype)) {
        return Response.json({ error: `Unauthorized: Public origin cannot read sensitive doctype "${doctype}"` }, { status: 403 });
      }
      const creds = await getCredentials(req.payload, site, req);
      if (!creds) {
        return Response.json({ error: "ERPNext integration not configured" }, { status: 500 });
      }
      const params = new URLSearchParams();
      if (fields) params.append("fields", fields);
      if (limitPageLength) params.append("limit_page_length", limitPageLength);
      if (creds.company && COMPANY_AWARE_DOCTYPES.has(doctype) && !name) {
        let parsedFilters = [];
        if (filters) {
          try {
            parsedFilters = JSON.parse(filters);
          } catch {
          }
        }
        parsedFilters = parsedFilters.filter(
          (f) => !(Array.isArray(f) && f[0] === "company")
        );
        parsedFilters.push(["company", "=", creds.company]);
        params.set("filters", JSON.stringify(parsedFilters));
      } else if (filters) {
        params.append("filters", filters);
      }
      const encodedDoctype = encodeURIComponent(doctype);
      const endpoint = name ? `${creds.url}/api/resource/${encodedDoctype}/${encodeURIComponent(name)}` : `${creds.url}/api/resource/${encodedDoctype}`;
      const qs = params.toString() ? `?${params}` : "";
      const response = await fetch(`${endpoint}${qs}`, {
        method: "GET",
        headers: authHeaders(creds),
        signal: AbortSignal.timeout(15e3)
      });
      if (!response.ok) {
        return Response.json(
          { error: `ERPNext API error: ${response.status}` },
          { status: response.status }
        );
      }
      const result = await response.json();
      if (name && creds.company && COMPANY_AWARE_DOCTYPES.has(doctype)) {
        const docCompany = result.data?.company;
        if (docCompany && docCompany !== creds.company) {
          req.payload.logger.warn(`[ERPNext-Proxy] Cross-tenant access blocked. User requested ${doctype} ${name} belonging to ${docCompany}, but config is mapped to ${creds.company}`);
          return Response.json({ error: "Unauthorized: Document belongs to a different company" }, { status: 403 });
        }
      }
      return Response.json(result);
    } catch (err) {
      req.payload.logger.error(`[ERPNext-Proxy] Resource error: ${err}`);
      return Response.json({ error: "Failed to fetch from ERPNext" }, { status: 500 });
    }
  }
};
var erpnextProxyHealth = {
  path: "/erpnext-proxy/health",
  method: "get",
  handler: async (req) => {
    try {
      const url = new URL(req.url || "", "http://localhost");
      const site = url.searchParams.get("site");
      const creds = await getCredentials(req.payload, site, req);
      if (!creds) {
        return Response.json({ healthy: false, reason: "No active ERPNext config found" });
      }
      const response = await fetch(`${creds.url}/api/resource/User?limit_page_length=1`, {
        method: "GET",
        headers: authHeaders(creds),
        signal: AbortSignal.timeout(1e4)
      });
      return Response.json({ healthy: response.ok });
    } catch {
      return Response.json({ healthy: false, reason: "connection failed" });
    }
  }
};
var erpnextProxyUpload = {
  path: "/erpnext-proxy/upload",
  method: "post",
  handler: async (req) => {
    try {
      const { error: accessDenied } = await validateProxyAccess(req);
      if (accessDenied) return accessDenied;
      const rateLimited = await applyProxyRateLimit(req);
      if (rateLimited) return rateLimited;
      if (typeof req.formData !== "function") {
        return Response.json({ error: "Multipart form data not supported" }, { status: 400 });
      }
      const formData = await req.formData();
      const doctype = formData.get("doctype");
      const docname = formData.get("docname");
      const site = formData.get("site");
      const file = formData.get("file");
      if (!doctype || !docname || !file) {
        return Response.json({ error: "Missing required fields" }, { status: 400 });
      }
      if (!ALLOWED_SUBMIT_DOCTYPES.includes(doctype)) {
        return Response.json({ error: `Doctype "${doctype}" is not allowed` }, { status: 400 });
      }
      const creds = await getCredentials(req.payload, site, req);
      if (!creds) {
        return Response.json({ error: "ERPNext integration not configured" }, { status: 500 });
      }
      const erpFormData = new FormData();
      erpFormData.append("file", file);
      erpFormData.append("doctype", doctype);
      erpFormData.append("docname", docname);
      erpFormData.append("is_private", "1");
      const response = await fetch(`${creds.url}/api/method/upload_file`, {
        method: "POST",
        headers: {
          Authorization: `token ${creds.apiKey}:${creds.apiSecret}`
        },
        body: erpFormData
      });
      if (!response.ok) {
        const msg = await parseERPNextError(response);
        req.payload.logger.warn(`[ERPNext-Proxy] Upload failed: ${msg}`);
        return Response.json({ error: msg }, { status: response.status });
      }
      const result = await response.json();
      return Response.json(result);
    } catch (err) {
      req.payload.logger.error(`[ERPNext-Proxy] Upload error: ${err}`);
      return Response.json({ error: "Failed to upload to ERPNext" }, { status: 500 });
    }
  }
};

// src/endpoints/fetchCompanies.ts
var FETCH_COMPANIES_RATE_LIMIT_MAX = 10;
var FETCH_COMPANIES_RATE_LIMIT_WINDOW_MS = 6e4;
var fetchCompaniesEndpoint = {
  path: "/erpnext-config/fetch-companies",
  method: "post",
  handler: async (req) => {
    try {
      const user = req.user;
      if (!user || !["super-admin", "admin"].includes(user.role || "")) {
        return Response.json(
          { error: "Authentication required \u2014 admin or super-admin only" },
          { status: 401 }
        );
      }
      const ip = getClientIp(req);
      const rateCheck = await checkRateLimit(
        `fetch-companies:${ip}`,
        FETCH_COMPANIES_RATE_LIMIT_MAX,
        FETCH_COMPANIES_RATE_LIMIT_WINDOW_MS
      );
      if (!rateCheck.allowed) {
        return Response.json(
          { error: "Too many requests. Try again later." },
          { status: 429, headers: { "Retry-After": String(Math.ceil(rateCheck.retryAfterMs / 1e3)) } }
        );
      }
      let body;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "Invalid request body" }, { status: 400 });
      }
      const { configId, erpnextUrl: rawUrl, apiKey: rawKey, apiSecret: rawSecret } = body;
      let erpnextUrl;
      let apiKey;
      let apiSecret;
      if (configId) {
        const config = await req.payload.findByID({
          collection: "erpnext-config",
          id: configId,
          depth: 0,
          overrideAccess: true,
          context: { preventMasking: true }
        });
        const cfg = config;
        erpnextUrl = cfg.erpnextUrl || "";
        apiKey = cfg.apiKey || "";
        apiSecret = cfg.apiSecret || "";
        apiKey = decryptCredential(apiKey);
        apiSecret = decryptCredential(apiSecret);
      } else if (rawUrl && rawKey && rawSecret) {
        erpnextUrl = rawUrl;
        apiKey = rawKey;
        apiSecret = rawSecret;
      } else {
        return Response.json(
          { error: "Provide either configId or (erpnextUrl + apiKey + apiSecret)" },
          { status: 400 }
        );
      }
      const normalizedUrl = erpnextUrl.replace(/\/+$/, "");
      if (!normalizedUrl.startsWith("https://")) {
        return Response.json(
          { error: "Only HTTPS ERPNext URLs are allowed" },
          { status: 400 }
        );
      }
      const companiesUrl = `${normalizedUrl}/api/resource/Company?fields=["name","company_name","country","default_currency"]&limit_page_length=100`;
      const response = await fetch(companiesUrl, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `token ${apiKey}:${apiSecret}`
        },
        signal: AbortSignal.timeout(15e3)
      });
      if (!response.ok) {
        const status = response.status;
        let errorMsg = `ERPNext returned HTTP ${status}`;
        if (status === 401 || status === 403) {
          errorMsg = "Authentication failed \u2014 check your API Key and Secret";
        }
        if (configId) {
          await updateConfigStatus(req.payload, configId, "disconnected");
        }
        req.payload.logger.warn(`[fetch-companies] ERPNext auth failed: ${status}`);
        return Response.json({ error: errorMsg, connected: false }, { status: 502 });
      }
      const result = await response.json();
      const companies = (result.data ?? []).map((c) => ({
        name: c.name,
        company_name: c.company_name,
        country: c.country || void 0,
        default_currency: c.default_currency || void 0
      }));
      if (configId) {
        await req.payload.update({
          collection: "erpnext-config",
          id: configId,
          data: {
            availableCompanies: companies,
            lastCompanyFetchAt: (/* @__PURE__ */ new Date()).toISOString(),
            connectionStatus: "connected"
          },
          overrideAccess: true
        });
      }
      req.payload.logger.info(
        `[fetch-companies] Fetched ${companies.length} companies from ${normalizedUrl}`
      );
      return Response.json({
        connected: true,
        companies,
        fetchedAt: (/* @__PURE__ */ new Date()).toISOString()
      });
    } catch (err) {
      req.payload.logger.error(`[fetch-companies] Error: ${err}`);
      return Response.json(
        { error: err instanceof Error ? err.message : "Failed to fetch companies" },
        { status: 500 }
      );
    }
  }
};
async function updateConfigStatus(payload, configId, status) {
  try {
    await payload.update({
      collection: "erpnext-config",
      id: configId,
      data: { connectionStatus: status },
      overrideAccess: true
    });
  } catch {
  }
}

// src/endpoints/fetchDocTypes.ts
var FETCH_DOCTYPES_RATE_LIMIT_MAX = 20;
var FETCH_DOCTYPES_RATE_LIMIT_WINDOW_MS = 6e4;
var fetchDocTypesEndpoint = {
  path: "/erpnext-doctypes",
  method: "get",
  handler: async (req) => {
    try {
      const user = req.user;
      if (!user || !["super-admin", "admin"].includes(user.role || "")) {
        return Response.json(
          { error: "Authentication required \u2014 admin or super-admin only" },
          { status: 401 }
        );
      }
      const ip = getClientIp(req);
      const rateCheck = await checkRateLimit(
        `fetch-doctypes:${ip}`,
        FETCH_DOCTYPES_RATE_LIMIT_MAX,
        FETCH_DOCTYPES_RATE_LIMIT_WINDOW_MS
      );
      if (!rateCheck.allowed) {
        return Response.json(
          { error: "Too many requests. Try again later." },
          { status: 429, headers: { "Retry-After": String(Math.ceil(rateCheck.retryAfterMs / 1e3)) } }
        );
      }
      const siteId = req.query?.siteId;
      const siteSlug = req.query?.siteSlug;
      if (!siteId && !siteSlug) {
        return Response.json({ error: "Provide siteId or siteSlug" }, { status: 400 });
      }
      const sites = await req.payload.find({
        collection: "sites",
        where: siteId ? { id: { equals: siteId } } : { slug: { equals: siteSlug } },
        limit: 1,
        depth: 0,
        overrideAccess: true
      });
      const site = sites.docs[0];
      if (!site) {
        return Response.json({ error: "Site not found" }, { status: 404 });
      }
      const configs = await req.payload.find({
        collection: "erpnext-config",
        where: { site: { equals: site.id }, isActive: { equals: true } },
        limit: 1,
        depth: 0,
        overrideAccess: true,
        context: { preventMasking: true }
      });
      const cfg = configs.docs[0];
      if (!cfg) {
        return Response.json({ error: "No active ERPNext config for this site" }, { status: 400 });
      }
      const erpnextUrl = (cfg.erpnextUrl || "").replace(/\/+$/, "");
      if (!erpnextUrl.startsWith("https://")) {
        return Response.json({ error: "Only HTTPS ERPNext URLs are allowed" }, { status: 400 });
      }
      const apiKey = decryptCredential(cfg.apiKey || "");
      const apiSecret = decryptCredential(cfg.apiSecret || "");
      if (!apiKey || !apiSecret) {
        return Response.json({ error: "ERPNext credentials are missing" }, { status: 400 });
      }
      const doctypesUrl = `${erpnextUrl}/api/resource/DocType?fields=["name","module","istable","issingle"]&limit_page_length=500`;
      const response = await fetch(doctypesUrl, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `token ${apiKey}:${apiSecret}`
        },
        signal: AbortSignal.timeout(15e3)
      });
      if (!response.ok) {
        const status = response.status;
        let errorMsg = `ERPNext returned HTTP ${status}`;
        if (status === 401 || status === 403) errorMsg = "Authentication failed \u2014 check your API Key and Secret";
        return Response.json({ error: errorMsg }, { status: 502 });
      }
      const result = await response.json();
      const doctypes = (result.data ?? []).filter((d) => d.issingle !== 1 && d.istable !== 1).map((d) => ({
        value: d.name,
        label: d.name,
        module: d.module
      })).sort((a, b) => a.label.localeCompare(b.label));
      return Response.json({
        connected: true,
        doctypes,
        fetchedAt: (/* @__PURE__ */ new Date()).toISOString()
      });
    } catch (err) {
      req.payload.logger.error(`[fetch-doctypes] Error: ${err}`);
      return Response.json(
        { error: err instanceof Error ? err.message : "Failed to fetch DocTypes" },
        { status: 500 }
      );
    }
  }
};

// src/endpoints/fetchLeadSources.ts
var RATE_LIMIT_MAX = 10;
var RATE_LIMIT_WINDOW_MS = 6e4;
var fetchLeadSourcesEndpoint = {
  path: "/erpnext-config/fetch-lead-sources",
  method: "post",
  handler: async (req) => {
    try {
      const user = req.user;
      if (!user || !["super-admin", "admin"].includes(user.role || "")) {
        return Response.json(
          { error: "Authentication required \u2014 admin or super-admin only" },
          { status: 401 }
        );
      }
      const ip = getClientIp(req);
      const rateCheck = await checkRateLimit(
        `fetch-lead-sources:${ip}`,
        RATE_LIMIT_MAX,
        RATE_LIMIT_WINDOW_MS
      );
      if (!rateCheck.allowed) {
        return Response.json(
          { error: "Too many requests. Try again later." },
          { status: 429, headers: { "Retry-After": String(Math.ceil(rateCheck.retryAfterMs / 1e3)) } }
        );
      }
      let body;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "Invalid request body" }, { status: 400 });
      }
      const { configId, erpnextUrl: rawUrl, apiKey: rawKey, apiSecret: rawSecret } = body;
      let erpnextUrl;
      let apiKey;
      let apiSecret;
      if (configId) {
        const config = await req.payload.findByID({
          collection: "erpnext-config",
          id: configId,
          depth: 0,
          overrideAccess: true,
          context: { preventMasking: true }
        });
        const cfg = config;
        erpnextUrl = cfg.erpnextUrl || "";
        apiKey = cfg.apiKey || "";
        apiSecret = cfg.apiSecret || "";
        apiKey = decryptCredential(apiKey);
        apiSecret = decryptCredential(apiSecret);
      } else if (rawUrl && rawKey && rawSecret) {
        erpnextUrl = rawUrl;
        apiKey = rawKey;
        apiSecret = rawSecret;
      } else {
        return Response.json(
          { error: "Provide either configId or (erpnextUrl + apiKey + apiSecret)" },
          { status: 400 }
        );
      }
      const normalizedUrl = erpnextUrl.replace(/\/+$/, "");
      if (!normalizedUrl.startsWith("https://")) {
        return Response.json(
          { error: "Only HTTPS ERPNext URLs are allowed" },
          { status: 400 }
        );
      }
      const leadSourcesUrl = `${normalizedUrl}/api/resource/Lead%20Source?fields=["name","source_name"]&limit_page_length=100`;
      const response = await fetch(leadSourcesUrl, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `token ${apiKey}:${apiSecret}`
        },
        signal: AbortSignal.timeout(15e3)
      });
      if (!response.ok) {
        const status = response.status;
        let errorMsg = `ERPNext returned HTTP ${status}`;
        if (status === 401 || status === 403) {
          errorMsg = "Authentication failed \u2014 check your API Key and Secret";
        }
        req.payload.logger.warn(`[fetch-lead-sources] ERPNext request failed: ${status}`);
        return Response.json({ error: errorMsg }, { status: 502 });
      }
      const result = await response.json();
      const leadSources = (result.data ?? []).map((ls) => ({
        name: ls.name,
        source_name: ls.source_name
      }));
      if (configId) {
        await req.payload.update({
          collection: "erpnext-config",
          id: configId,
          data: {
            availableLeadSources: leadSources,
            lastLeadSourceFetchAt: (/* @__PURE__ */ new Date()).toISOString()
          },
          overrideAccess: true
        });
      }
      req.payload.logger.info(
        `[fetch-lead-sources] Fetched ${leadSources.length} lead sources from ${normalizedUrl}`
      );
      return Response.json({
        leadSources,
        fetchedAt: (/* @__PURE__ */ new Date()).toISOString()
      });
    } catch (err) {
      req.payload.logger.error(`[fetch-lead-sources] Error: ${err}`);
      return Response.json(
        { error: err instanceof Error ? err.message : "Failed to fetch lead sources" },
        { status: 500 }
      );
    }
  }
};

// src/endpoints/retryDeadLetters.ts
var retryDeadLettersEndpoint = {
  path: "/retry-dead-letters",
  method: "post",
  handler: async (req) => {
    const user = req.user;
    if (!user || !["super-admin", "admin"].includes(user.role || "")) {
      return Response.json({ error: "Unauthorized" }, { status: 403 });
    }
    const url = new URL(req.url || "", "http://localhost");
    const limit = Math.min(Number.parseInt(url.searchParams.get("limit") ?? "20", 10), 100);
    const siteSlug = url.searchParams.get("site") ?? void 0;
    try {
      const where = { status: { equals: "pending" } };
      if (siteSlug) {
      }
      const pending = await req.payload.find({
        collection: "erpnext-dead-letters",
        where,
        limit,
        depth: 0,
        req
      });
      const results = [];
      for (const letter of pending.docs) {
        const dl = letter;
        const id = dl.id;
        const erpnextUrl = dl.erpnextUrl;
        const docType = dl.docType;
        const payload = dl.payload;
        const retryCount = dl.retryCount ?? 0;
        try {
          if (!erpnextUrl.startsWith("https://")) {
            throw new Error("Non-HTTPS URL blocked by policy");
          }
          const siteId = dl.site;
          const configs = await req.payload.find({
            collection: "erpnext-config",
            where: {
              site: { equals: siteId },
              isActive: { equals: true }
            },
            limit: 1,
            depth: 0,
            req,
            overrideAccess: true,
            context: { preventMasking: true }
          });
          if (configs.totalDocs === 0) {
            results.push({ id, status: "skipped", detail: "No active ERPNext config found for site" });
            continue;
          }
          const cfg = configs.docs[0];
          const url2 = `${erpnextUrl.replace(/\/+$/, "")}/api/resource/${encodeURIComponent(docType)}`;
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15e3);
          const response = await fetch(url2, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `token ${cfg.apiKey}:${cfg.apiSecret}`
            },
            body: JSON.stringify(payload),
            signal: controller.signal
          });
          clearTimeout(timeout);
          if (response.ok) {
            await req.payload.update({
              collection: "erpnext-dead-letters",
              id,
              req,
              data: {
                status: "success",
                retryCount: retryCount + 1,
                lastRetryAt: (/* @__PURE__ */ new Date()).toISOString()
              }
            });
            results.push({ id, status: "success", detail: "Replayed successfully" });
          } else {
            const body = await response.text().catch(() => "(no body)");
            await req.payload.update({
              collection: "erpnext-dead-letters",
              id,
              req,
              data: {
                status: "failed",
                retryCount: retryCount + 1,
                lastRetryAt: (/* @__PURE__ */ new Date()).toISOString(),
                errorDetail: `Replay failed: HTTP ${response.status} ${body.slice(0, 500)}`
              }
            });
            results.push({ id, status: "failed", detail: `HTTP ${response.status}` });
          }
        } catch (err) {
          await req.payload.update({
            collection: "erpnext-dead-letters",
            id,
            req,
            data: {
              status: "failed",
              retryCount: retryCount + 1,
              lastRetryAt: (/* @__PURE__ */ new Date()).toISOString(),
              errorDetail: `Replay exception: ${String(err)}`
            }
          });
          results.push({ id, status: "error", detail: String(err) });
        }
      }
      return Response.json({ processed: results.length, results });
    } catch (err) {
      req.payload.logger.error(`[retryDeadLetters] Unexpected error: ${err}`);
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  }
};

// src/lib/executeERPNextWorkflows.ts
var MAX_RETRIES = 3;
var BASE_TIMEOUT_MS = 1e4;
var RETRY_BACKOFF_MS = [0, 2e3, 8e3];
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function extractERPNextErrorMessage(body) {
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed.message === "string" && parsed.message) return parsed.message;
    if (typeof parsed.exception === "string" && parsed.exception) return parsed.exception;
    if (Array.isArray(parsed._server_messages) && parsed._server_messages.length > 0) {
      return parsed._server_messages.join("; ");
    }
    if (typeof parsed.exc === "string" && parsed.exc) {
      return parsed.exc.split("\n").slice(-2)[0] || parsed.exc;
    }
  } catch {
  }
  return null;
}
function categorizeError(status, err) {
  if (err instanceof Error && err.name === "AbortError") {
    return { category: "timeout", detail: "Request aborted after timeout" };
  }
  if (err instanceof TypeError) {
    return { category: "tls-error", detail: String(err) };
  }
  if (status === void 0) {
    return { category: "exception", detail: String(err) };
  }
  if (status >= 400 && status < 500) {
    return { category: "client-error", detail: `HTTP ${status}` };
  }
  if (status >= 500) {
    return { category: "server-error", detail: `HTTP ${status}` };
  }
  return { category: "exception", detail: `HTTP ${status}` };
}
function getByPath(obj, path) {
  if (!path || !obj) return void 0;
  return path.split(".").reduce((acc, key) => {
    if (acc && typeof acc === "object" && key in acc) {
      return acc[key];
    }
    return void 0;
  }, obj);
}
function buildSubmissionMap(submissionData) {
  const map = {};
  for (const entry of submissionData ?? []) {
    if (entry.field && entry.value !== void 0 && !entry.field.startsWith("_")) {
      map[entry.field] = entry.value;
    }
  }
  return map;
}
function evaluateCondition(condition, values, references) {
  if (!condition || !condition.trim()) return true;
  try {
    const fn = new Function("values", "references", `return Boolean(${condition})`);
    return fn(values, references) === true;
  } catch (err) {
    return true;
  }
}
async function executeERPNextWorkflows(options) {
  const { payload, formId, siteId, submissionId, submissionData, correlationId, log } = options;
  const results = [];
  try {
    const resolvedSiteId = typeof siteId === "object" ? siteId.id : siteId;
    const erpConfigs = await payload.find({
      collection: "erpnext-config",
      where: {
        site: { equals: resolvedSiteId },
        isActive: { equals: true }
      },
      limit: 1,
      depth: 0,
      overrideAccess: true,
      context: { preventMasking: true }
    });
    if (erpConfigs.totalDocs === 0) {
      log("info", "No active ERPNext config for site \u2014 skipping workflows", { siteId: resolvedSiteId });
      return results;
    }
    const erpConfig = erpConfigs.docs[0];
    const normalizedUrl = (erpConfig.erpnextUrl || "").replace(/\/+$/, "");
    if (!normalizedUrl.startsWith("https://")) {
      log("error", "Refusing to forward to non-HTTPS ERPNext URL", { url: normalizedUrl });
      return results;
    }
    const apiKey = erpConfig.apiKey || "";
    const apiSecret = erpConfig.apiSecret || "";
    if (!apiKey || !apiSecret || apiKey.startsWith("\u2022\u2022\u2022\u2022") || apiSecret.startsWith("\u2022\u2022\u2022\u2022")) {
      log("error", "ERPNext credentials are missing or masked");
      return results;
    }
    const erpnextCompany = erpConfig.erpnextCompany || void 0;
    const leadSource = erpConfig.leadSource || void 0;
    const authHeader = `token ${apiKey}:${apiSecret}`;
    const workflows = await payload.find({
      collection: "erpnext-form-workflows",
      where: {
        form: { equals: formId },
        site: { equals: resolvedSiteId },
        enabled: { equals: true }
      },
      limit: 10,
      depth: 0,
      overrideAccess: true
    });
    if (workflows.totalDocs === 0) {
      log("info", "No ERPNext workflows for form \u2014 using legacy single-DocType fallback", { formId });
      const legacyResult = await executeLegacyForward({
        payload,
        erpConfig,
        siteId: resolvedSiteId,
        submissionId: String(submissionId),
        submissionData,
        correlationId,
        log
      });
      if (legacyResult) results.push(legacyResult);
      return results;
    }
    const values = buildSubmissionMap(submissionData);
    const references = {};
    for (const workflow of workflows.docs) {
      const requests = [...workflow.requests || []].sort((a, b) => (a.position || 0) - (b.position || 0));
      for (const request of requests) {
        if (request.enabled === false) continue;
        if (!evaluateCondition(request.condition, values, references)) {
          log("info", `Skipping request "${request.label}" \u2014 condition falsy`, { requestLabel: request.label });
          continue;
        }
        const result = {
          ok: false,
          requestLabel: request.label,
          doctype: request.doctype,
          action: request.action,
          referenceKey: request.referenceKey || void 0
        };
        try {
          const body = {};
          for (const mapping of request.fieldMappings || []) {
            const value = values[mapping.formFieldName];
            if (value !== void 0) {
              body[mapping.erpFieldName] = value;
            }
          }
          for (const staticValue of request.staticValues || []) {
            body[staticValue.field] = staticValue.value;
          }
          for (const refMapping of request.referenceMappings || []) {
            const refValue = getByPath(references[refMapping.referenceKey], refMapping.referencePath || "name");
            if (refValue !== void 0) {
              body[refMapping.erpFieldName] = refValue;
            }
          }
          if (erpnextCompany && !body.company) {
            body.company = erpnextCompany;
          }
          if (leadSource && request.doctype === "Lead" && !body.source) {
            body.source = leadSource;
          }
          let url;
          let method;
          if (request.action === "create") {
            url = `${normalizedUrl}/api/resource/${encodeURIComponent(request.doctype)}`;
            method = "POST";
          } else if (request.action === "get") {
            const filters = (request.filters || []).filter((f) => f.erpFieldName).map((f) => {
              const value = f.formFieldName ? values[f.formFieldName] : f.staticValue;
              return [request.doctype, f.erpFieldName, f.operator || "=", value];
            });
            const qs = new URLSearchParams();
            qs.set("fields", JSON.stringify(["name"]));
            if (filters.length > 0) qs.set("filters", JSON.stringify(filters));
            qs.set("limit_page_length", "1");
            url = `${normalizedUrl}/api/resource/${encodeURIComponent(request.doctype)}?${qs.toString()}`;
            method = "GET";
          } else {
            const filterName = (request.filters || []).map((f) => {
              const value = f.formFieldName ? values[f.formFieldName] : f.staticValue;
              return { field: f.erpFieldName, value };
            }).find((f) => f.field === "name")?.value;
            const refName = request.referenceKey ? getByPath(references[request.referenceKey], request.referencePath || "name") : void 0;
            const docName = filterName || refName;
            if (!docName) {
              throw new Error("Update action requires a document name via filters or referenceKey");
            }
            url = `${normalizedUrl}/api/resource/${encodeURIComponent(request.doctype)}/${encodeURIComponent(String(docName))}`;
            method = "PUT";
          }
          log("info", `Executing ERPNext request`, {
            workflow: workflow.label,
            requestLabel: request.label,
            doctype: request.doctype,
            action: request.action,
            url: url.replace(apiSecret, "***").replace(apiKey, "***")
          });
          let lastStatus;
          let lastError;
          let lastBody = "";
          let responseData;
          for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), BASE_TIMEOUT_MS);
            try {
              if (attempt > 0) {
                log("info", `Retry attempt ${attempt + 1}/${MAX_RETRIES}`, { backoffMs: RETRY_BACKOFF_MS[attempt] });
                await sleep(RETRY_BACKOFF_MS[attempt]);
              }
              const response = await fetch(url, {
                method,
                headers: {
                  "Content-Type": "application/json",
                  Authorization: authHeader,
                  "X-Correlation-ID": correlationId
                },
                body: method === "GET" ? void 0 : JSON.stringify(body),
                signal: controller.signal
              });
              lastStatus = response.status;
              lastBody = await response.text().catch(() => "(no body)");
              if (response.ok) {
                responseData = lastBody ? JSON.parse(lastBody) : {};
                if (request.action === "get" || request.action === "update") {
                  const list = Array.isArray(responseData?.data) ? responseData.data : void 0;
                  const found = list ? list.length > 0 : responseData !== null && responseData !== void 0;
                  if (!found && request.optional) {
                    log("info", `Optional ${request.action} returned no match \u2014 treating as success`, {
                      requestLabel: request.label
                    });
                    result.ok = true;
                    result.status = response.status;
                    break;
                  }
                  if (!found && !request.optional) {
                    log("warn", `${request.action} returned no match`, { requestLabel: request.label });
                    lastStatus = 404;
                    lastBody = JSON.stringify({ message: "Document not found" });
                    break;
                  }
                }
                result.ok = true;
                result.status = response.status;
                break;
              }
              log("warn", `HTTP ${response.status} from ERPNext`, {
                status: response.status,
                bodyPreview: lastBody.slice(0, 500),
                attempt: attempt + 1
              });
              if (response.status >= 400 && response.status < 500) break;
            } catch (err) {
              lastError = err;
              log("warn", `Network exception on attempt ${attempt + 1}`, { error: String(err) });
            } finally {
              clearTimeout(timeout);
            }
          }
          if (!result.ok) {
            const { category, detail } = categorizeError(lastStatus, lastError);
            const erpMessage = extractERPNextErrorMessage(lastBody);
            result.error = erpMessage || `${category}: ${detail}`;
            await writeDeadLetter(payload, {
              submissionId: String(submissionId),
              site: resolvedSiteId,
              erpnextUrl: normalizedUrl,
              docType: request.doctype,
              payload: body,
              errorCategory: category,
              errorDetail: `${detail}

Last body:
${lastBody.slice(0, 2e3)}`,
              httpStatus: lastStatus ?? null,
              retryCount: MAX_RETRIES,
              status: "pending",
              correlationId,
              workflow: workflow.label,
              requestLabel: request.label
            });
          } else {
            if (request.referenceKey) {
              const listData = Array.isArray(responseData?.data) ? responseData.data : void 0;
              const normalized = request.action === "get" && listData && listData.length > 0 ? listData[0] : responseData;
              const path = request.referencePath || (request.action === "get" ? "name" : "data.name");
              const extracted = getByPath(normalized, path);
              references[request.referenceKey] = normalized;
              result.referenceValue = extracted !== void 0 ? String(extracted) : void 0;
              result.erpName = extracted !== void 0 ? String(extracted) : void 0;
              log("info", `Stored reference`, { referenceKey: request.referenceKey, value: result.referenceValue });
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.error = msg;
          log("error", `Request "${request.label}" failed with exception`, { error: msg });
          await writeDeadLetter(payload, {
            submissionId: String(submissionId),
            site: resolvedSiteId,
            erpnextUrl: normalizedUrl,
            docType: request.doctype,
            payload: {},
            errorCategory: "exception",
            errorDetail: msg,
            httpStatus: null,
            retryCount: 0,
            status: "pending",
            correlationId,
            workflow: workflow.label,
            requestLabel: request.label
          });
        }
        results.push(result);
      }
    }
  } catch (err) {
    log("error", "Unexpected error executing ERPNext workflows", { error: err instanceof Error ? err.message : String(err) });
  }
  return results;
}
async function executeLegacyForward(args) {
  const { payload, erpConfig, siteId, submissionId, submissionData, correlationId, log } = args;
  const normalizedUrl = (erpConfig.erpnextUrl || "").replace(/\/+$/, "");
  if (!normalizedUrl.startsWith("https://")) {
    log("error", "Refusing to forward to non-HTTPS ERPNext URL", { url: normalizedUrl });
    return null;
  }
  const apiKey = erpConfig.apiKey || "";
  const apiSecret = erpConfig.apiSecret || "";
  if (apiKey.startsWith("\u2022\u2022\u2022\u2022") || apiSecret.startsWith("\u2022\u2022\u2022\u2022")) {
    log("error", "ERPNext credentials are masked or invalid in database.");
    return null;
  }
  const docType = erpConfig.defaultDocType === "Custom" ? erpConfig.customDocType : erpConfig.defaultDocType;
  if (!docType) {
    log("warn", "No legacy DocType configured \u2014 skipping forward");
    return null;
  }
  const values = buildSubmissionMap(submissionData);
  let erpPayload = {};
  const fieldMappings = erpConfig.fieldMappings;
  if (fieldMappings && fieldMappings.length > 0) {
    for (const mapping of fieldMappings) {
      const value = values[mapping.formFieldName];
      if (value !== void 0) {
        erpPayload[mapping.erpnextFieldName] = value;
      }
    }
  } else {
    log("warn", "No field mappings configured \u2014 forwarding raw field names", { formFields: Object.keys(values) });
    erpPayload = { ...values };
  }
  if (erpConfig.erpnextCompany && !erpPayload.company) {
    erpPayload.company = erpConfig.erpnextCompany;
  }
  if (erpConfig.leadSource && docType === "Lead" && !erpPayload.source) {
    erpPayload.source = erpConfig.leadSource;
  }
  const url = `${normalizedUrl}/api/resource/${encodeURIComponent(docType)}`;
  const authHeader = `token ${apiKey}:${apiSecret}`;
  log("info", "Forwarding submission (legacy fallback)", { url, docType, submissionId });
  let lastStatus;
  let lastError;
  let lastBody = "";
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BASE_TIMEOUT_MS);
    try {
      if (attempt > 0) {
        log("info", `Retry attempt ${attempt + 1}/${MAX_RETRIES}`, { backoffMs: RETRY_BACKOFF_MS[attempt] });
        await sleep(RETRY_BACKOFF_MS[attempt]);
      }
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
          "X-Correlation-ID": correlationId
        },
        body: JSON.stringify(erpPayload),
        signal: controller.signal
      });
      lastStatus = response.status;
      if (response.ok) {
        const result = await response.json().catch(() => ({}));
        log("info", `Created ${docType} successfully`, {
          name: result?.data?.name || "ok",
          attempt: attempt + 1
        });
        return {
          ok: true,
          requestLabel: "Legacy forward",
          doctype: docType,
          action: "create",
          status: response.status
        };
      }
      lastBody = await response.text().catch(() => "(no body)");
      log("warn", `HTTP ${response.status} from ERPNext`, {
        status: response.status,
        bodyPreview: lastBody.slice(0, 500),
        attempt: attempt + 1
      });
      if (response.status >= 400 && response.status < 500) break;
    } catch (err) {
      lastError = err;
      log("warn", `Network exception on attempt ${attempt + 1}`, { error: String(err) });
    } finally {
      clearTimeout(timeout);
    }
  }
  const { category, detail } = categorizeError(lastStatus, lastError);
  const erpMessage = extractERPNextErrorMessage(lastBody);
  log("error", "All legacy retry attempts exhausted \u2014 writing dead letter", { category, detail });
  await writeDeadLetter(payload, {
    submissionId,
    site: siteId,
    erpnextUrl: normalizedUrl,
    docType,
    payload: erpPayload,
    errorCategory: category,
    errorDetail: `${detail}

Last body:
${lastBody.slice(0, 2e3)}`,
    httpStatus: lastStatus ?? null,
    retryCount: MAX_RETRIES,
    status: "pending",
    correlationId,
    workflow: "Legacy fallback",
    requestLabel: "Legacy forward"
  });
  return {
    ok: false,
    requestLabel: "Legacy forward",
    doctype: docType,
    action: "create",
    status: lastStatus,
    error: erpMessage || `${category}: ${detail}`
  };
}
async function writeDeadLetter(payload, data) {
  try {
    await payload.create({
      collection: "erpnext-dead-letters",
      overrideAccess: true,
      data
    });
  } catch (err) {
    payload.logger.error(`[ERPNext] Failed to create dead-letter record: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// src/jobs/forwardToERPNext.ts
var import_crypto2 = require("crypto");
var forwardToERPNext = {
  slug: "forwardToERPNext",
  inputSchema: [
    { name: "submissionId", type: "text", required: true },
    { name: "formId", type: "text", required: true },
    { name: "siteId", type: "text", required: true }
  ],
  handler: async ({ input, req }) => {
    const correlationId = (0, import_crypto2.randomUUID)();
    const log = (level, msg, meta) => {
      const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
      req.payload.logger[level](`[ERPNext][${correlationId}] ${msg}${metaStr}`);
    };
    const submission = await req.payload.findByID({
      collection: "form-submissions",
      id: input.submissionId,
      depth: 0,
      overrideAccess: true
    }).catch((err) => {
      log("error", "Failed to fetch form submission", { error: String(err) });
      return null;
    });
    if (!submission) {
      throw new Error(`Form submission ${input.submissionId} not found`);
    }
    const results = await executeERPNextWorkflows({
      payload: req.payload,
      formId: input.formId,
      siteId: input.siteId,
      submissionId: input.submissionId,
      submissionData: submission.submissionData,
      correlationId,
      log
    });
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      log("error", "One or more ERPNext workflow requests failed", { failed });
      throw new Error(`ERPNext workflow failed: ${failed.map((f) => f.requestLabel).join(", ")}`);
    }
    return {
      output: {}
    };
  }
};

// src/hooks/forwardToERPNext.ts
var import_payload = require("payload");
var import_crypto3 = require("crypto");
var forwardToERPNext2 = async ({
  doc,
  operation,
  req
}) => {
  if (operation !== "create") return doc;
  const correlationId = (0, import_crypto3.randomUUID)();
  const log = (level, msg, meta) => {
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
    req.payload.logger[level](`[ERPNext][${correlationId}] ${msg}${metaStr}`);
  };
  try {
    const formRef = doc.form;
    if (!formRef) return doc;
    const formId = typeof formRef === "object" ? formRef.id : formRef;
    const form = await req.payload.findByID({
      collection: "forms",
      id: formId,
      depth: 0,
      req
    }).catch(() => null);
    const siteId = form?.site;
    if (!siteId) return doc;
    const resolvedSiteId = typeof siteId === "object" ? siteId.id : siteId;
    const results = await executeERPNextWorkflows({
      payload: req.payload,
      formId,
      siteId: resolvedSiteId,
      submissionId: doc.id,
      submissionData: doc.submissionData,
      correlationId,
      log
    });
    const failed = results.filter((r) => !r.ok);
    if (failed.length === 0) return doc;
    const validationErrors = failed.filter((r) => r.status && r.status >= 400 && r.status < 500);
    const transientErrors = failed.filter((r) => !r.status || r.status >= 500 || r.error?.includes("timeout") || r.error?.includes("tls-error"));
    if (validationErrors.length > 0) {
      const messages = validationErrors.map((r) => `${r.requestLabel} (${r.doctype}): ${r.error}`).join("; ");
      log("warn", "ERPNext validation errors \u2014 rejecting submission", { messages });
      throw new import_payload.APIError(`ERPNext validation failed: ${messages}`, 400);
    }
    if (transientErrors.length > 0) {
      try {
        await req.payload.jobs.queue({
          task: "forwardToERPNext",
          input: {
            submissionId: String(doc.id),
            formId: String(formId),
            siteId: String(resolvedSiteId)
          },
          queue: "default",
          req
        });
        log("info", "Queued ERPNext forward job for retry", { transientErrors });
      } catch (err) {
        log("error", "Failed to enqueue ERPNext retry job", { error: String(err) });
      }
    }
  } catch (err) {
    if (err instanceof import_payload.APIError) throw err;
    req.payload.logger.error(`[ERPNext][${correlationId}] Unexpected outer error: ${err}`);
  }
  return doc;
};

// src/hooks/enqueueForwardToERPNext.ts
var enqueueForwardToERPNext = async ({
  doc,
  operation,
  req
}) => {
  if (operation !== "create") return doc;
  const formRef = doc.form;
  if (!formRef) return doc;
  const formId = typeof formRef === "object" ? formRef.id : formRef;
  const form = await req.payload.findByID({
    collection: "forms",
    id: formId,
    depth: 0,
    req
  }).catch(() => null);
  const siteId = form?.site;
  if (!siteId) return doc;
  const resolvedSiteId = typeof siteId === "object" ? siteId.id : siteId;
  try {
    await req.payload.jobs.queue({
      task: "forwardToERPNext",
      input: {
        submissionId: String(doc.id),
        formId: String(formId),
        siteId: String(resolvedSiteId)
      },
      queue: "default",
      req
    });
  } catch (err) {
    req.payload.logger.error(`[ERPNext] Failed to enqueue forward job: ${err instanceof Error ? err.message : String(err)}`);
  }
  return doc;
};

// src/index.ts
function erpnextPlugin(options = {}) {
  const enableAnonymousUpload = options.enableAnonymousUpload !== false;
  return (config) => {
    const endpoints = [
      ...config.endpoints || [],
      erpnextProxySubmit,
      erpnextProxyResource,
      erpnextProxyHealth,
      erpnextProxyUpload,
      fetchCompaniesEndpoint,
      fetchDocTypesEndpoint,
      fetchLeadSourcesEndpoint,
      retryDeadLettersEndpoint
    ];
    if (enableAnonymousUpload) {
      endpoints.push(anonymousUploadEndpoint);
    }
    return {
      ...config,
      collections: [...config.collections || [], ERPNextConfig, ERPNextFormWorkflows, ERPNextDeadLetter],
      endpoints,
      jobs: {
        ...config.jobs || {},
        tasks: [...config.jobs?.tasks || [], forwardToERPNext]
      }
    };
  };
}
function verifyERPNextWebhookSignature(rawBody, signature, secret, encoding = "hex") {
  const { createHmac, timingSafeEqual: timingSafeEqual2 } = require("crypto");
  const expected = createHmac("sha256", secret).update(rawBody).digest(encoding);
  if (expected.length !== signature.length) return false;
  return timingSafeEqual2(Buffer.from(expected), Buffer.from(signature));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  authHeaders,
  enqueueForwardToERPNext,
  erpnextPlugin,
  executeERPNextWorkflows,
  forwardToERPNext,
  forwardToERPNextJob,
  getCredentials,
  verifyERPNextWebhookSignature
});
