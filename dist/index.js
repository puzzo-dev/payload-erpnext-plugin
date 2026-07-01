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
  erpnextPlugin: () => erpnextPlugin,
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
                    path: "payload-erpnext-plugin/components/ERPNextDocTypeSelect",
                    exportName: "ERPNextDocTypeSelect"
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
      const siteRaw = formData.get("site");
      if (!file || !(file instanceof File) || file.size === 0) {
        return Response.json({ error: "No file provided" }, { status: 400 });
      }
      let site = null;
      if (siteRaw) {
        const siteCheck = await payload.find({
          collection: "sites",
          where: { slug: { equals: siteRaw } },
          limit: 1,
          overrideAccess: true
        });
        if (siteCheck.totalDocs === 0) {
          return Response.json({ error: "Invalid site" }, { status: 400 });
        }
        site = siteRaw;
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
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    } catch {
      return null;
    }
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
  const origin = req.headers.get("origin") || req.headers.get("referer") || "";
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
      if (!/^https?:\/\//i.test(creds.url)) return Response.json({ error: "ERPNext integration not configured" }, { status: 500 });
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
      if (!/^https?:\/\//i.test(creds.url)) return Response.json({ error: "ERPNext integration not configured" }, { status: 500 });
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
      if (!/^https?:\/\//i.test(creds.url)) return Response.json({ healthy: false, reason: "ERPNext integration not configured" });
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
      if (!/^https?:\/\//i.test(creds.url)) return Response.json({ error: "ERPNext integration not configured" }, { status: 500 });
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

// src/endpoints/fetchDocTypeFields.ts
var FETCH_FIELDS_RATE_LIMIT_MAX = 30;
var FETCH_FIELDS_RATE_LIMIT_WINDOW_MS = 6e4;
var fetchDocTypeFieldsEndpoint = {
  path: "/erpnext-doctype-fields",
  method: "get",
  handler: async (req) => {
    try {
      const user = req.user;
      if (!user || !["super-admin", "admin"].includes(user.role || "")) {
        return Response.json(
          { error: "Authentication required" },
          { status: 401 }
        );
      }
      const ip = getClientIp(req);
      const rateCheck = await checkRateLimit(
        `fetch-doctype-fields:${ip}`,
        FETCH_FIELDS_RATE_LIMIT_MAX,
        FETCH_FIELDS_RATE_LIMIT_WINDOW_MS
      );
      if (!rateCheck.allowed) {
        return Response.json(
          { error: "Too many requests" },
          { status: 429, headers: { "Retry-After": String(Math.ceil(rateCheck.retryAfterMs / 1e3)) } }
        );
      }
      const siteId = req.query?.siteId;
      const doctype = req.query?.doctype;
      if (!siteId || !doctype) {
        return Response.json({ error: "Provide siteId and doctype" }, { status: 400 });
      }
      const sites = await req.payload.find({
        collection: "sites",
        where: { id: { equals: siteId } },
        limit: 1,
        depth: 0,
        overrideAccess: true
      });
      const site = sites.docs[0];
      if (!site) return Response.json({ error: "Site not found" }, { status: 404 });
      const configs = await req.payload.find({
        collection: "erpnext-config",
        where: { site: { equals: site.id }, isActive: { equals: true } },
        limit: 1,
        depth: 0,
        overrideAccess: true,
        context: { preventMasking: true }
      });
      const cfg = configs.docs[0];
      if (!cfg) return Response.json({ error: "No active ERPNext config" }, { status: 400 });
      const erpnextUrl = (cfg.erpnextUrl || "").replace(/\/+$/, "");
      const apiKey = decryptCredential(cfg.apiKey || "");
      const apiSecret = decryptCredential(cfg.apiSecret || "");
      if (!apiKey || !apiSecret) return Response.json({ error: "Missing credentials" }, { status: 400 });
      const fieldsUrl = `${erpnextUrl}/api/resource/DocField?filters=[["parent","=","${doctype}"]]&fields=["fieldname","label","fieldtype"]&limit_page_length=500`;
      const response = await fetch(fieldsUrl, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `token ${apiKey}:${apiSecret}`
        },
        signal: AbortSignal.timeout(15e3)
      });
      if (!response.ok) {
        return Response.json({ error: `ERPNext returned HTTP ${response.status}` }, { status: 502 });
      }
      const result = await response.json();
      const fields = (result.data ?? []).filter((f) => f.fieldname && f.fieldtype !== "Section Break" && f.fieldtype !== "Column Break").map((f) => ({
        value: f.fieldname,
        label: f.label || f.fieldname,
        type: f.fieldtype
      })).sort((a, b) => a.label.localeCompare(b.label));
      return Response.json({ fields });
    } catch (err) {
      req.payload.logger.error(`[fetch-doctype-fields] Error: ${err}`);
      return Response.json(
        { error: err instanceof Error ? err.message : "Failed to fetch fields" },
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

// src/actions/erpActions.ts
var MAX_RETRIES = 3;
var BASE_DELAY_MS = 1e3;
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function erpCall(creds, path, method = "GET", body) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${creds.url}${path}`, {
        method,
        headers: {
          ...authHeaders(creds),
          "Content-Type": "application/json"
        },
        body: body ? JSON.stringify(body) : void 0,
        signal: AbortSignal.timeout(3e4)
      });
      if (!res.ok) {
        let msg = `ERPNext ${method} ${path} \u2192 ${res.status}`;
        try {
          const data = await res.json();
          if (data?.exception) msg = String(data.exception);
          else if (data?.message) msg = String(data.message);
        } catch {
        }
        throw new Error(msg);
      }
      return res.json();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) {
        await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
      }
    }
  }
  throw lastError;
}
function dottedPathLookup(ctx, path) {
  return path.split(".").reduce((o, k) => o === void 0 || o === null ? void 0 : o[k], ctx);
}
function resolveValue(template, ctx) {
  const wholeMatch = template.trim().match(/^\{\{\s*([\w.]+)\s*\}\}$/);
  if (wholeMatch) {
    const val = dottedPathLookup(ctx, wholeMatch[1]);
    return val !== void 0 ? val : template;
  }
  if (template.includes("{{")) {
    return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key) => {
      const val = dottedPathLookup(ctx, key);
      return val !== void 0 && val !== null ? String(val) : "";
    });
  }
  return template;
}
async function erpGetHandler(ctx) {
  const { payload, workflowContext, step } = ctx;
  const siteSlug = workflowContext.siteSlug;
  const creds = await getCredentials(payload, siteSlug);
  if (!creds) return { success: false, error: "Missing ERP credentials for site: " + siteSlug };
  const doctype = step.target_doctype;
  if (!doctype) return { success: false, error: "erp-get requires target_doctype" };
  const mapping = step.field_mapping ?? {};
  const filters = mapping.filters ? String(resolveValue(String(mapping.filters), workflowContext)) : void 0;
  const fields = mapping.fields ? String(resolveValue(String(mapping.fields), workflowContext)) : '["name"]';
  const qs = new URLSearchParams({ fields, limit_page_length: "10" });
  if (filters) qs.set("filters", filters);
  const res = await erpCall(creds, `/api/resource/${encodeURIComponent(doctype)}?${qs}`);
  const list = res.data ?? [];
  const prefix = step.result_key || "erp";
  return {
    success: true,
    data: {
      [`${prefix}_result_list`]: list,
      [`${prefix}_result`]: list[0] ?? null,
      [`${prefix}_name`]: list[0]?.name ?? null,
      erp_company: creds.company
    }
  };
}
async function erpPostHandler(ctx) {
  const { payload, workflowContext, step } = ctx;
  const siteSlug = workflowContext.siteSlug;
  const creds = await getCredentials(payload, siteSlug);
  if (!creds) return { success: false, error: "Missing ERP credentials for site: " + siteSlug };
  const doctype = step.target_doctype;
  if (!doctype) return { success: false, error: "erp-post requires target_doctype" };
  const mapping = step.field_mapping ?? {};
  const docData = { doctype };
  for (const [erpField, sourceTemplate] of Object.entries(mapping)) {
    docData[erpField] = resolveValue(sourceTemplate, workflowContext);
  }
  const res = await erpCall(creds, `/api/resource/${encodeURIComponent(doctype)}`, "POST", docData);
  const createdName = res.data?.name;
  const prefix = step.result_key || "erp";
  return { success: true, data: { [`${prefix}_name`]: createdName, [`${prefix}_doctype`]: doctype, erp_company: creds.company } };
}
async function erpPatchHandler(ctx) {
  const { payload, workflowContext, step } = ctx;
  const siteSlug = workflowContext.siteSlug;
  const creds = await getCredentials(payload, siteSlug);
  if (!creds) return { success: false, error: "Missing ERP credentials for site: " + siteSlug };
  const doctype = step.target_doctype;
  if (!doctype) return { success: false, error: "erp-patch requires target_doctype" };
  const mapping = step.field_mapping ?? {};
  const docNameKey = mapping.doc_name_key ?? "erp_name";
  const docName = workflowContext[docNameKey];
  if (!docName) {
    return { success: false, error: `erp-patch requires context.${docNameKey} to identify the document` };
  }
  const docData = {};
  for (const [erpField, sourceTemplate] of Object.entries(mapping)) {
    if (erpField === "doc_name_key") continue;
    docData[erpField] = resolveValue(sourceTemplate, workflowContext);
  }
  await erpCall(
    creds,
    `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(docName)}`,
    "PUT",
    docData
  );
  return { success: true };
}
async function erpDeleteHandler(ctx) {
  const { payload, workflowContext, step } = ctx;
  const siteSlug = workflowContext.siteSlug;
  const creds = await getCredentials(payload, siteSlug);
  if (!creds) return { success: false, error: "Missing ERP credentials for site: " + siteSlug };
  const doctype = step.target_doctype;
  if (!doctype) return { success: false, error: "erp-delete requires target_doctype" };
  const docName = workflowContext.erp_name;
  if (!docName) return { success: false, error: "erp-delete requires context.erp_name" };
  await erpCall(
    creds,
    `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(docName)}`,
    "DELETE"
  );
  return { success: true };
}

// src/index.ts
function erpnextPlugin(options = {}) {
  const enableAnonymousUpload = options.enableAnonymousUpload !== false;
  if (options.registry) {
    const r = options.registry;
    r.register("erp-get", erpGetHandler);
    r.register("erp-post", erpPostHandler);
    r.register("erp-patch", erpPatchHandler);
    r.register("erp-delete", erpDeleteHandler);
  }
  return (config) => {
    const endpoints = [
      ...config.endpoints || [],
      erpnextProxySubmit,
      erpnextProxyResource,
      erpnextProxyHealth,
      erpnextProxyUpload,
      fetchCompaniesEndpoint,
      fetchDocTypesEndpoint,
      fetchDocTypeFieldsEndpoint,
      fetchLeadSourcesEndpoint,
      retryDeadLettersEndpoint
    ];
    if (enableAnonymousUpload) {
      endpoints.push(anonymousUploadEndpoint);
    }
    const erpnextConfigCollection = options.erpnextConfigHooks?.afterChange?.length ? {
      ...ERPNextConfig,
      hooks: {
        ...ERPNextConfig.hooks,
        afterChange: [
          ...ERPNextConfig.hooks?.afterChange ?? [],
          ...options.erpnextConfigHooks.afterChange
        ]
      }
    } : ERPNextConfig;
    const modifiedCollections = (config.collections || []).map((collection) => {
      if (collection.slug === "workflows") {
        const systemEventField = collection.fields.find((f) => f.name === "system_event_name");
        if (systemEventField && systemEventField.type === "select") {
          systemEventField.options = [
            ...systemEventField.options || [],
            { label: "ERPNext Connection Failed", value: "erpnext.connection.failed" },
            { label: "ERPNext Sync Failed", value: "erpnext.sync.failed" }
          ];
        }
        const stepsField = collection.fields.find((f) => f.name === "steps");
        if (stepsField && stepsField.type === "blocks") {
          stepsField.blocks = [
            ...stepsField.blocks || [],
            {
              slug: "trigger_erp",
              labels: { singular: "Trigger ERP Action", plural: "Trigger ERP Actions" },
              fields: [
                {
                  name: "doctype",
                  type: "text",
                  required: true,
                  admin: {
                    description: "ERPNext DocType (e.g. Customer, Sales Order)",
                    components: { Field: "payload-erpnext-plugin/components/ERPNextDocTypeSelect" }
                  }
                },
                {
                  name: "action",
                  type: "select",
                  required: true,
                  options: [
                    { label: "Read / Search (GET)", value: "GET" },
                    { label: "Create (POST)", value: "POST" },
                    { label: "Update (PUT)", value: "PUT" },
                    { label: "Delete (DELETE)", value: "DELETE" }
                  ]
                },
                {
                  name: "result_key",
                  type: "text",
                  defaultValue: "erp",
                  admin: {
                    description: `Prefix for this step's output context keys (e.g. "erp" \u2192 {{erp_name}}, {{erp_result}}). Use a distinct prefix per step when a workflow calls ERPNext more than once, so a later step doesn't overwrite an earlier one's result.`
                  }
                },
                {
                  name: "field_mapping",
                  type: "array",
                  labels: { singular: "Field Mapping", plural: "Field Mappings" },
                  admin: {
                    description: 'For GET: use "filters" and "fields" as the field names (ERPNext filter/fields JSON, supports {{var}}). For POST/PUT: ERPNext field name \u2192 value.'
                  },
                  fields: [
                    {
                      name: "target_field",
                      type: "text",
                      required: true,
                      admin: {
                        components: { Field: "payload-erpnext-plugin/components/ERPNextTargetFieldSelect" }
                      }
                    },
                    {
                      name: "source_field",
                      type: "text",
                      required: true,
                      admin: { description: "Static value or variable (e.g. {{doc.status}})" }
                    }
                  ]
                }
              ]
            }
          ];
        }
      }
      return collection;
    });
    return {
      ...config,
      collections: [...modifiedCollections, erpnextConfigCollection, ERPNextDeadLetter],
      endpoints
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
  erpnextPlugin,
  getCredentials,
  verifyERPNextWebhookSignature
});
