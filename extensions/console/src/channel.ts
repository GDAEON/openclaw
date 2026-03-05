import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import {
  buildChannelConfigSchema,
  createAccountListHelpers,
  DEFAULT_ACCOUNT_ID,
  readJsonFileWithFallback,
  registerPluginHttpRoute,
  readJsonWebhookBodyOrReject,
  setAccountEnabledInConfigSection,
  withFileLock,
  waitUntilAbort,
  writeJsonFileAtomically,
  type ChannelGatewayContext,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import { z } from "zod";
import { resolveSessionAgentId } from "../../../src/agents/agent-scope.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { loadSessionStore, resolveStorePath } from "../../../src/config/sessions.js";
import { estimateUsageCost, resolveModelCostConfig } from "../../../src/utils/usage-format.js";
import { getConsoleRuntime } from "./runtime.js";

const CHANNEL_ID = "console";
const DEFAULT_WEBHOOK_PATH = "/console";
const DEFAULT_SESSION_KEY = "main";
const DEFAULT_SENDER_ID = "console-user";
const PROMPT_STORE_FILE = "session-prompts.json";
const PROMPT_STORE_LOCK_OPTIONS = {
  retries: {
    retries: 10,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 10_000,
    randomize: true,
  },
  stale: 30_000,
} as const;

type ConsoleAccountConfig = {
  enabled?: boolean;
  webhookPath?: string;
};

type ConsoleChannelSection = {
  defaultAccount?: string;
  webhookPath?: string;
  accounts?: Record<string, ConsoleAccountConfig>;
};

export type ResolvedConsoleAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  webhookPath: string;
};

type ConsoleInboundBody = {
  text: string;
  senderId: string;
  senderName?: string;
  sessionKey: string;
  conversationId: string;
  messageId?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  mediaType?: string;
  mediaTypes?: string[];
};

type ConsoleReplyPayload = {
  text?: string;
  body?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  isReasoning?: boolean;
};

type ConsoleCallbackMedia = {
  url: string;
  mimeType: string;
};

type ConsoleCallbackBody = {
  code: "callback";
  params: {
    texts: string[];
    media: ConsoleCallbackMedia[];
  };
};

type ConsolePromptStore = Record<string, string>;
type ConsoleSessionUsageSnapshot = {
  provider?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};
type ConsoleBillingService = {
  service_id: string;
  qty: number;
};
type ConsoleBotMarketingContext = {
  integration: string;
  botId: string;
  userId: string;
};
type ConsoleLogSink = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

const BILLING_MAX_RETRIES = 3;
const BILLING_RETRY_DELAY_MS = 10_000;

const accountHelpers = createAccountListHelpers(CHANNEL_ID);
const ConsoleConfigSchema = buildChannelConfigSchema(
  z
    .object({
      defaultAccount: z.string().trim().min(1).optional(),
      webhookPath: z.string().trim().min(1).optional(),
      accounts: z
        .record(
          z.string(),
          z
            .object({
              enabled: z.boolean().optional(),
              webhookPath: z.string().trim().min(1).optional(),
            })
            .passthrough(),
        )
        .optional(),
    })
    .passthrough(),
);

const activeRouteUnregisters = new Map<string, () => void>();

function resolveConsoleSection(cfg: OpenClawConfig): ConsoleChannelSection {
  const section = cfg.channels?.[CHANNEL_ID];
  if (!section || typeof section !== "object") {
    return {};
  }
  return section as ConsoleChannelSection;
}

function resolveConsoleAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedConsoleAccount {
  const resolvedAccountId = (accountId ?? accountHelpers.resolveDefaultAccountId(cfg)).trim();
  const section = resolveConsoleSection(cfg);
  const account = section.accounts?.[resolvedAccountId] ?? {};
  return {
    accountId: resolvedAccountId || DEFAULT_ACCOUNT_ID,
    enabled: account.enabled !== false,
    configured: true,
    webhookPath: normalizeWebhookPath(
      account.webhookPath ?? section.webhookPath ?? DEFAULT_WEBHOOK_PATH,
    ),
  };
}

function normalizeWebhookPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return DEFAULT_WEBHOOK_PATH;
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function buildConsoleRoutePath(basePath: string, suffix?: string): string {
  const normalizedBase = normalizeWebhookPath(basePath).replace(/\/+$/, "") || DEFAULT_WEBHOOK_PATH;
  if (!suffix) {
    return normalizedBase;
  }
  const normalizedSuffix = suffix.replace(/^\/+/, "");
  return `${normalizedBase}/${normalizedSuffix}`;
}

function readHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0]?.trim() || undefined;
  }
  return value?.trim() || undefined;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function readMediaEntries(value: unknown): Array<{ url: string; mimeType?: string }> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries: Array<{ url: string; mimeType?: string } | null> = value.map((entry) => {
    if (!entry || typeof entry !== "object") {
      return null;
    }
    const record = entry as Record<string, unknown>;
    const url = readOptionalString(record.url);
    if (!url) {
      return null;
    }
    return {
      url,
      mimeType: readOptionalString(record.mimeType),
    };
  });
  const normalized = entries.filter((entry): entry is { url: string; mimeType?: string } =>
    Boolean(entry),
  );
  return normalized.length > 0 ? normalized : undefined;
}

function resolveConsoleCallbackRequestUrl(rawHeader: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawHeader);
  } catch {
    throw new Error("invalid X-CALLBACK-URL header");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("X-CALLBACK-URL must use http or https");
  }
  const trimmedPath = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = trimmedPath.endsWith("/request")
    ? trimmedPath || "/request"
    : `${trimmedPath || ""}/request`;
  return parsed.toString();
}

function resolveConsoleBillingRequestUrl(rawHeader: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawHeader);
  } catch {
    throw new Error("invalid X-BILLING-URL header");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("X-BILLING-URL must use http or https");
  }
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, "") || ""}/bill`;
  return parsed.toString();
}

function resolveConsoleBillingActivityUrl(rawHeader: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawHeader);
  } catch {
    throw new Error("invalid X-BILLING-URL header");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("X-BILLING-URL must use http or https");
  }
  return parsed.toString();
}

function parseConsoleBotMarketingContext(
  rawHeader: string,
): ConsoleBotMarketingContext | undefined {
  const parts = rawHeader
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const map = new Map<string, string>();
  for (const part of parts) {
    const eqIndex = part.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }
    const key = part.slice(0, eqIndex).trim().toLowerCase();
    const value = part.slice(eqIndex + 1).trim();
    if (!key || !value) {
      continue;
    }
    map.set(key, value);
  }
  const app = map.get("app");
  if (!app) {
    return undefined;
  }
  const appParts = app
    .split("/")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (appParts.length < 3) {
    return undefined;
  }
  const [integration, botId, userId] = appParts;
  if (!integration || !botId || !userId) {
    return undefined;
  }
  return { integration, botId, userId };
}

function normalizeConsoleBillingModel(model: string): string {
  return model.trim().replaceAll(".", "_");
}

function toNonNegativeTokenCount(value: number | undefined): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) {
    return 0;
  }
  return Math.floor(value as number);
}

function buildConsoleBillingServices(
  snapshot: ConsoleSessionUsageSnapshot,
): ConsoleBillingService[] {
  const normalizedModel = normalizeConsoleBillingModel(snapshot.model);
  if (!normalizedModel) {
    return [];
  }
  const inputTokens = toNonNegativeTokenCount(snapshot.inputTokens);
  const outputTokens = toNonNegativeTokenCount(snapshot.outputTokens);
  const cachedTokens =
    toNonNegativeTokenCount(snapshot.cacheReadTokens) +
    toNonNegativeTokenCount(snapshot.cacheWriteTokens);
  const services: ConsoleBillingService[] = [];
  if (inputTokens > 0) {
    services.push({ service_id: `${normalizedModel}-input`, qty: inputTokens });
  }
  if (outputTokens > 0) {
    services.push({ service_id: `${normalizedModel}-output`, qty: outputTokens });
  }
  if (cachedTokens > 0) {
    services.push({ service_id: `${normalizedModel}-cached`, qty: cachedTokens });
  }
  return services;
}

async function readConsoleSessionUsageSnapshot(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): Promise<ConsoleSessionUsageSnapshot | undefined> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return undefined;
  }
  const agentId = resolveSessionAgentId({ sessionKey, config: params.cfg });
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  const entry = store[sessionKey.toLowerCase()] ?? store[sessionKey];
  const model = typeof entry?.model === "string" ? entry.model.trim() : "";
  if (!model) {
    return undefined;
  }
  return {
    provider: typeof entry?.modelProvider === "string" ? entry.modelProvider.trim() : undefined,
    model,
    inputTokens: toNonNegativeTokenCount(entry?.inputTokens),
    outputTokens: toNonNegativeTokenCount(entry?.outputTokens),
    cacheReadTokens: toNonNegativeTokenCount(entry?.cacheRead),
    cacheWriteTokens: toNonNegativeTokenCount(entry?.cacheWrite),
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readResponsePreview(response: Response): Promise<string> {
  try {
    const body = (await response.text()).trim();
    if (!body) {
      return "<empty>";
    }
    return body.length > 500 ? `${body.slice(0, 500)}...` : body;
  } catch {
    return "<unreadable>";
  }
}

async function postConsoleBillingWithRetry(params: {
  billingUrl: string;
  services: ConsoleBillingService[];
  bearer: string;
  operationId: string;
  log?: ConsoleLogSink;
}) {
  const body = {
    services: params.services,
    operationId: params.operationId,
  };
  let lastError: unknown;
  for (let attempt = 0; attempt <= BILLING_MAX_RETRIES; attempt += 1) {
    try {
      params.log?.info?.(
        `console: billing /bill request attempt=${attempt + 1} operationId=${params.operationId} url=${params.billingUrl}`,
      );
      const response = await fetch(params.billingUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.bearer}`,
        },
        body: JSON.stringify(body),
      });
      const preview = await readResponsePreview(response.clone());
      params.log?.info?.(
        `console: billing /bill response operationId=${params.operationId} status=${response.status} body=${preview}`,
      );
      if (response.ok) {
        return;
      }
      lastError = new Error(`billing request failed with status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < BILLING_MAX_RETRIES) {
      await sleep(BILLING_RETRY_DELAY_MS);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function isConsoleBillingActive(params: {
  activityUrl: string;
  bearer: string;
  log?: ConsoleLogSink;
}): Promise<boolean> {
  params.log?.info?.(`console: billing activity request url=${params.activityUrl}`);
  const response = await fetch(params.activityUrl, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${params.bearer}`,
    },
  });
  const preview = await readResponsePreview(response.clone());
  params.log?.info?.(
    `console: billing activity response status=${response.status} body=${preview}`,
  );
  if (!response.ok) {
    throw new Error(`billing activity request failed with status ${response.status}`);
  }
  const payload = (await response.json()) as { status?: unknown };
  return (
    String(payload.status ?? "")
      .trim()
      .toLowerCase() === "active"
  );
}

function resolveBotMarketingBaseUrl(integration: string): string | undefined {
  const normalized = integration.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "ai_delivery") {
    return process.env.ai_delivery_base_url?.trim() || process.env.AI_DELIVERY_BASE_URL?.trim();
  }
  if (normalized === "ai_delivery_test") {
    return (
      process.env.ai_delivery_test_base_url?.trim() || process.env.AI_DELIVERY_TEST_BASE_URL?.trim()
    );
  }
  return undefined;
}

function resolveBotMarketingPrice(): number | undefined {
  const raw = process.env.price?.trim() || process.env.PRICE?.trim();
  if (!raw) {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function calculateBotMarketingAmount(params: {
  cost: number;
  exchangeRate: number;
  price: number;
}): number {
  if (!Number.isFinite(params.cost) || params.cost <= 0) {
    return 0;
  }
  const rate =
    Number.isFinite(params.exchangeRate) && params.exchangeRate > 0 ? params.exchangeRate : 1;
  if (!Number.isFinite(params.price) || params.price <= 0) {
    return 0;
  }
  const rub = params.cost / rate;
  return Math.ceil(rub * params.price);
}

async function fetchExchangeRate(currency: string): Promise<number> {
  const baseUrl = process.env.exchange_api_url?.trim() || process.env.EXCHANGE_API_URL?.trim();
  if (!baseUrl) {
    return 1;
  }
  const response = await fetch(baseUrl, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`exchange request failed with status ${response.status}`);
  }
  const payload = (await response.json()) as { rates?: Record<string, unknown> };
  const rateRaw = payload.rates?.[currency];
  const rate = typeof rateRaw === "number" ? rateRaw : Number(rateRaw);
  if (!Number.isFinite(rate) || rate <= 0) {
    return 1;
  }
  return rate;
}

async function postConsoleBotMarketingBilling(params: {
  context: ConsoleBotMarketingContext;
  costUsd: number;
  log?: ConsoleLogSink;
}) {
  const baseUrl = resolveBotMarketingBaseUrl(params.context.integration);
  if (!baseUrl) {
    throw new Error(
      `unsupported integration for botmarketing billing: ${params.context.integration}`,
    );
  }
  const price = resolveBotMarketingPrice();
  if (!price) {
    throw new Error("botmarketing billing price is not configured");
  }
  params.log?.info?.(
    `console: botmarketing billing start integration=${params.context.integration} botId=${params.context.botId} userId=${params.context.userId} costUsd=${params.costUsd}`,
  );
  const rate = await fetchExchangeRate("USD");
  const amount = calculateBotMarketingAmount({
    cost: params.costUsd,
    exchangeRate: rate,
    price,
  });
  if (amount <= 0) {
    params.log?.info?.("console: botmarketing billing skipped because computed amount <= 0");
    return;
  }
  const requestUrl = `${baseUrl.replace(/\/+$/, "")}/api/bot/${encodeURIComponent(params.context.botId)}/user/${encodeURIComponent(params.context.userId)}/billAgent`;
  params.log?.info?.(`console: botmarketing billing request url=${requestUrl} amount=${amount}`);
  const response = await fetch(requestUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ amount }),
  });
  const preview = await readResponsePreview(response.clone());
  params.log?.info?.(
    `console: botmarketing billing response status=${response.status} body=${preview}`,
  );
  if (!response.ok) {
    throw new Error(`botmarketing billing failed with status ${response.status}`);
  }
}

function parseConsoleInboundBody(value: unknown): ConsoleInboundBody {
  if (!value || typeof value !== "object") {
    throw new Error("request body must be a JSON object");
  }
  const body = value as Record<string, unknown>;
  const text =
    readOptionalString(body.text) ??
    readOptionalString(body.body) ??
    readOptionalString(body.message) ??
    readOptionalString(body.prompt);
  if (!text) {
    throw new Error('request body must include "text" (or body/message/prompt)');
  }

  const senderId = readOptionalString(body.senderId) ?? DEFAULT_SENDER_ID;
  const conversationId = readOptionalString(body.conversationId) ?? senderId;
  const mediaEntries = readMediaEntries(body.media);
  const mediaUrls =
    mediaEntries?.map((entry) => entry.url) ??
    readStringArray(body.mediaUrls) ??
    (readOptionalString(body.mediaUrl) ? [readOptionalString(body.mediaUrl)!] : undefined);
  const mediaTypes = mediaEntries?.map((entry) => entry.mimeType).filter(Boolean) as
    | string[]
    | undefined;

  return {
    text,
    senderId,
    senderName: readOptionalString(body.senderName),
    sessionKey: readOptionalString(body.sessionKey) ?? DEFAULT_SESSION_KEY,
    conversationId,
    messageId: readOptionalString(body.messageId),
    mediaUrl: mediaUrls?.[0],
    mediaUrls,
    mediaType: mediaTypes?.[0] ?? readOptionalString(body.mediaType),
    mediaTypes: mediaTypes?.length ? mediaTypes : readStringArray(body.mediaTypes),
  };
}

function parseConsolePromptSetBody(value: unknown): { sessionKey: string; systemPrompt: string } {
  if (!value || typeof value !== "object") {
    throw new Error("request body must be a JSON object");
  }
  const body = value as Record<string, unknown>;
  const sessionKey = readOptionalString(body.sessionKey);
  if (!sessionKey) {
    throw new Error('request body must include "sessionKey"');
  }
  const systemPrompt = readOptionalString(body.systemPrompt);
  if (!systemPrompt) {
    throw new Error('request body must include "systemPrompt"');
  }
  return { sessionKey, systemPrompt };
}

function parseConsolePromptSessionKey(value: unknown): { sessionKey: string } {
  if (!value || typeof value !== "object") {
    throw new Error("request body must be a JSON object");
  }
  const body = value as Record<string, unknown>;
  const sessionKey = readOptionalString(body.sessionKey);
  if (!sessionKey) {
    throw new Error('request body must include "sessionKey"');
  }
  return { sessionKey };
}

function normalizeConsolePromptStore(value: unknown): ConsolePromptStore {
  if (!value || typeof value !== "object") {
    return {};
  }
  const store = value as Record<string, unknown>;
  const normalized: ConsolePromptStore = {};
  for (const [key, entry] of Object.entries(store)) {
    const normalizedKey = key.trim();
    const normalizedValue = readOptionalString(entry);
    if (!normalizedKey || !normalizedValue) {
      continue;
    }
    normalized[normalizedKey] = normalizedValue;
  }
  return normalized;
}

function resolveConsolePromptStorePath(): string {
  return path.join(
    getConsoleRuntime().state.resolveStateDir(),
    "plugins",
    CHANNEL_ID,
    PROMPT_STORE_FILE,
  );
}

async function withConsolePromptStore<T>(
  task: (store: ConsolePromptStore, filePath: string) => Promise<T>,
): Promise<T> {
  const filePath = resolveConsolePromptStorePath();
  const { exists } = await readJsonFileWithFallback<ConsolePromptStore>(filePath, {});
  if (!exists) {
    await writeJsonFileAtomically(filePath, {});
  }
  return await withFileLock(filePath, PROMPT_STORE_LOCK_OPTIONS, async () => {
    const { value } = await readJsonFileWithFallback<ConsolePromptStore>(filePath, {});
    return await task(normalizeConsolePromptStore(value), filePath);
  });
}

export async function getConsoleSessionPrompt(sessionKey: string): Promise<string | undefined> {
  return await withConsolePromptStore(async (store) => store[sessionKey]);
}

export async function setConsoleSessionPrompt(params: {
  sessionKey: string;
  systemPrompt: string;
}): Promise<void> {
  await withConsolePromptStore(async (store, filePath) => {
    store[params.sessionKey] = params.systemPrompt;
    await writeJsonFileAtomically(filePath, store);
  });
}

export async function clearConsoleSessionPrompt(sessionKey: string): Promise<boolean> {
  return await withConsolePromptStore(async (store, filePath) => {
    if (!(sessionKey in store)) {
      return false;
    }
    delete store[sessionKey];
    await writeJsonFileAtomically(filePath, store);
    return true;
  });
}

export function buildConsoleInboundContext(params: {
  account: ResolvedConsoleAccount;
  body: ConsoleInboundBody;
  systemPrompt?: string;
}) {
  const { account, body, systemPrompt } = params;
  return {
    Body: body.text,
    BodyForAgent: body.text,
    BodyForCommands: body.text,
    RawBody: body.text,
    CommandBody: body.text,
    From: `${CHANNEL_ID}:${body.senderId}`,
    To: `${CHANNEL_ID}:${body.conversationId}`,
    SessionKey: body.sessionKey,
    AccountId: account.accountId,
    MessageSid: body.messageId,
    MediaUrl: body.mediaUrl,
    MediaUrls: body.mediaUrls,
    MediaType: body.mediaType,
    MediaTypes: body.mediaTypes,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `${CHANNEL_ID}:${body.conversationId}`,
    ChatType: "direct",
    SenderName: body.senderName,
    SenderId: body.senderId,
    GroupSystemPrompt: systemPrompt,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    ConversationLabel: body.senderName ?? body.conversationId,
    Timestamp: Date.now(),
    CommandAuthorized: true,
  };
}

async function resolveConsoleMediaMimeType(mediaUrl: string): Promise<string> {
  try {
    const detected = await getConsoleRuntime().media.detectMime({ filePath: mediaUrl });
    return detected ?? "application/octet-stream";
  } catch {
    return "application/octet-stream";
  }
}

export async function buildConsoleCallbackBody(
  payloads: readonly ConsoleReplyPayload[],
  resolveMimeType: (mediaUrl: string) => Promise<string> = resolveConsoleMediaMimeType,
): Promise<ConsoleCallbackBody> {
  const texts: string[] = [];
  const media: ConsoleCallbackMedia[] = [];

  for (const payload of payloads) {
    if (payload.isReasoning) {
      continue;
    }
    const text = (payload.text ?? payload.body ?? "").trim();
    if (text) {
      texts.push(text);
    }
    const mediaUrls = payload.mediaUrls?.length
      ? payload.mediaUrls
      : payload.mediaUrl
        ? [payload.mediaUrl]
        : [];
    for (const mediaUrl of mediaUrls) {
      const trimmedUrl = mediaUrl.trim();
      if (!trimmedUrl) {
        continue;
      }
      media.push({
        url: trimmedUrl,
        mimeType: await resolveMimeType(trimmedUrl),
      });
    }
  }

  return {
    code: "callback",
    params: {
      texts,
      media,
    },
  };
}

async function postConsoleCallback(params: {
  callbackUrl: string;
  payloads: readonly ConsoleReplyPayload[];
}) {
  const body = await buildConsoleCallbackBody(params.payloads);
  const response = await fetch(params.callbackUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`callback request failed with status ${response.status}`);
  }
}

async function processConsoleWebhookRequest(params: {
  account: ResolvedConsoleAccount;
  callbackUrl: string;
  billingUrl?: string;
  billingActivityUrl?: string;
  botMarketingContextHeader?: string;
  body: ConsoleInboundBody;
  channelRuntime: NonNullable<ChannelGatewayContext<ResolvedConsoleAccount>["channelRuntime"]>;
  log?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
}) {
  const runtime = getConsoleRuntime();
  const cfg = runtime.config.loadConfig();
  const payloads: ConsoleReplyPayload[] = [];
  const systemPrompt = await getConsoleSessionPrompt(params.body.sessionKey);

  await params.channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: buildConsoleInboundContext({
      account: params.account,
      body: params.body,
      ...(systemPrompt ? { systemPrompt } : {}),
    }),
    cfg,
    dispatcherOptions: {
      deliver: async (payload) => {
        payloads.push(payload as ConsoleReplyPayload);
      },
      onReplyStart: () => {
        params.log?.info?.(
          `console: reply started for ${params.body.conversationId} (${params.account.accountId})`,
        );
      },
      onError: (error, info) => {
        params.log?.error?.(`console: ${info.kind} reply failed: ${String(error)}`);
      },
    },
  });

  await postConsoleCallback({
    callbackUrl: params.callbackUrl,
    payloads,
  });

  if (!params.billingUrl && !params.botMarketingContextHeader) {
    return;
  }

  let usageSnapshot: ConsoleSessionUsageSnapshot | undefined;
  try {
    usageSnapshot = await readConsoleSessionUsageSnapshot({
      cfg,
      sessionKey: params.body.sessionKey,
    });
  } catch (error) {
    params.log?.error?.(`console: failed to read billing usage snapshot: ${String(error)}`);
    return;
  }
  if (!usageSnapshot) {
    params.log?.warn?.(
      `console: billing skipped for ${params.body.sessionKey} because model/usage snapshot is missing`,
    );
    return;
  }

  const billingTasks: Promise<void>[] = [];

  if (params.billingUrl) {
    const bearer = process.env.BILLING_BEARER?.trim();
    if (!bearer) {
      params.log?.warn?.("console: X-BILLING-URL was provided but BILLING_BEARER is empty");
    } else {
      const services = buildConsoleBillingServices(usageSnapshot);
      if (services.length > 0) {
        const activityUrl = params.billingActivityUrl ?? params.billingUrl;
        billingTasks.push(
          (async () => {
            const active = await isConsoleBillingActive({
              activityUrl,
              bearer,
              log: params.log,
            });
            if (!active) {
              params.log?.warn?.("console: billing is not active; skipping /bill request");
              return;
            }
            const operationId = crypto.randomUUID();
            await postConsoleBillingWithRetry({
              billingUrl: params.billingUrl!,
              services,
              bearer,
              operationId,
              log: params.log,
            });
          })(),
        );
      }
    }
  }

  if (params.botMarketingContextHeader) {
    const parsedContext = parseConsoleBotMarketingContext(params.botMarketingContextHeader);
    if (!parsedContext) {
      params.log?.warn?.(
        "console: invalid x-botmarketing-context header; skipping botmarketing bill",
      );
    } else {
      const costConfig = resolveModelCostConfig({
        provider: usageSnapshot.provider,
        model: usageSnapshot.model,
        config: cfg,
      });
      const estimatedCostUsd = estimateUsageCost({
        usage: {
          input: usageSnapshot.inputTokens,
          output: usageSnapshot.outputTokens,
          cacheRead: usageSnapshot.cacheReadTokens,
          cacheWrite: usageSnapshot.cacheWriteTokens,
        },
        cost: costConfig,
      });
      if (!Number.isFinite(estimatedCostUsd) || (estimatedCostUsd ?? 0) <= 0) {
        params.log?.warn?.(
          "console: botmarketing billing skipped because estimated cost is unavailable",
        );
      } else {
        billingTasks.push(
          postConsoleBotMarketingBilling({
            context: parsedContext,
            costUsd: estimatedCostUsd,
            log: params.log,
          }),
        );
      }
    }
  }

  if (billingTasks.length === 0) {
    return;
  }

  void Promise.allSettled(billingTasks).then((results) => {
    for (const result of results) {
      if (result.status === "rejected") {
        params.log?.error?.(`console: billing request failed: ${String(result.reason)}`);
      }
    }
  });
}

function createConsoleWebhookHandler(params: {
  account: ResolvedConsoleAccount;
  channelRuntime: NonNullable<ChannelGatewayContext<ResolvedConsoleAccount>["channelRuntime"]>;
  log?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
}) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? "GET";
    if (method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.end("Method Not Allowed");
      return true;
    }

    const contentType = readHeaderValue(req.headers["content-type"]) ?? "";
    if (!contentType.toLowerCase().includes("json")) {
      res.statusCode = 415;
      res.end("Unsupported Media Type");
      return true;
    }

    const callbackHeader = readHeaderValue(req.headers["x-callback-url"]);
    if (!callbackHeader) {
      res.statusCode = 400;
      res.end("Missing X-CALLBACK-URL header");
      return true;
    }

    const billingHeader = readHeaderValue(req.headers["x-billing-url"]);
    const botMarketingContextHeader = readHeaderValue(req.headers["x-botmarketing-context"]);
    let callbackUrl: string;
    let billingUrl: string | undefined;
    let billingActivityUrl: string | undefined;
    try {
      callbackUrl = resolveConsoleCallbackRequestUrl(callbackHeader);
      if (billingHeader) {
        billingActivityUrl = resolveConsoleBillingActivityUrl(billingHeader);
        billingUrl = resolveConsoleBillingRequestUrl(billingHeader);
      }
    } catch (error) {
      res.statusCode = 400;
      res.end(error instanceof Error ? error.message : "Invalid request header");
      return true;
    }

    const jsonBody = await readJsonWebhookBodyOrReject({
      req,
      res,
      emptyObjectOnEmpty: false,
      invalidJsonMessage: "Invalid JSON body",
    });
    if (!jsonBody.ok) {
      return true;
    }

    let inboundBody: ConsoleInboundBody;
    try {
      inboundBody = parseConsoleInboundBody(jsonBody.value);
    } catch (error) {
      res.statusCode = 400;
      res.end(error instanceof Error ? error.message : "Invalid request body");
      return true;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true, accepted: true }));

    void processConsoleWebhookRequest({
      account: params.account,
      callbackUrl,
      ...(billingUrl ? { billingUrl } : {}),
      ...(billingActivityUrl ? { billingActivityUrl } : {}),
      ...(botMarketingContextHeader ? { botMarketingContextHeader } : {}),
      body: inboundBody,
      channelRuntime: params.channelRuntime,
      log: params.log,
    }).catch((error) => {
      params.log?.error?.(`console: inbound request failed: ${String(error)}`);
      params.log?.warn?.(
        `console: request for ${inboundBody.conversationId} was accepted but callback failed`,
      );
    });

    return true;
  };
}

function createConsolePromptSetHandler(params: {
  account: ResolvedConsoleAccount;
  log?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
}) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if ((req.method ?? "GET") !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.end("Method Not Allowed");
      return true;
    }

    const contentType = readHeaderValue(req.headers["content-type"]) ?? "";
    if (!contentType.toLowerCase().includes("json")) {
      res.statusCode = 415;
      res.end("Unsupported Media Type");
      return true;
    }

    const jsonBody = await readJsonWebhookBodyOrReject({
      req,
      res,
      emptyObjectOnEmpty: false,
      invalidJsonMessage: "Invalid JSON body",
    });
    if (!jsonBody.ok) {
      return true;
    }

    let body: { sessionKey: string; systemPrompt: string };
    try {
      body = parseConsolePromptSetBody(jsonBody.value);
    } catch (error) {
      res.statusCode = 400;
      res.end(error instanceof Error ? error.message : "Invalid request body");
      return true;
    }

    try {
      await setConsoleSessionPrompt(body);
    } catch (error) {
      params.log?.error?.(`console: failed to store system prompt: ${String(error)}`);
      res.statusCode = 500;
      res.end("Failed to store system prompt");
      return true;
    }

    params.log?.info?.(
      `console: stored system prompt for ${body.sessionKey} (${params.account.accountId})`,
    );
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true, sessionKey: body.sessionKey, hasPrompt: true }));
    return true;
  };
}

function createConsolePromptGetHandler(params: {
  account: ResolvedConsoleAccount;
  log?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
}) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? "GET";
    let sessionKey: string | undefined;

    if (method === "GET") {
      const requestUrl = new URL(req.url ?? "/", "http://localhost");
      sessionKey = readOptionalString(requestUrl.searchParams.get("sessionKey"));
    } else if (method === "POST") {
      const contentType = readHeaderValue(req.headers["content-type"]) ?? "";
      if (!contentType.toLowerCase().includes("json")) {
        res.statusCode = 415;
        res.end("Unsupported Media Type");
        return true;
      }
      const jsonBody = await readJsonWebhookBodyOrReject({
        req,
        res,
        emptyObjectOnEmpty: false,
        invalidJsonMessage: "Invalid JSON body",
      });
      if (!jsonBody.ok) {
        return true;
      }
      try {
        sessionKey = parseConsolePromptSessionKey(jsonBody.value).sessionKey;
      } catch (error) {
        res.statusCode = 400;
        res.end(error instanceof Error ? error.message : "Invalid request body");
        return true;
      }
    } else {
      res.statusCode = 405;
      res.setHeader("Allow", "GET, POST");
      res.end("Method Not Allowed");
      return true;
    }

    if (!sessionKey) {
      res.statusCode = 400;
      res.end('request must include "sessionKey"');
      return true;
    }

    try {
      const systemPrompt = await getConsoleSessionPrompt(sessionKey);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          ok: true,
          sessionKey,
          systemPrompt: systemPrompt ?? null,
          hasPrompt: Boolean(systemPrompt),
        }),
      );
      return true;
    } catch (error) {
      params.log?.error?.(`console: failed to read system prompt: ${String(error)}`);
      res.statusCode = 500;
      res.end("Failed to read system prompt");
      return true;
    }
  };
}

function createConsolePromptClearHandler(params: {
  account: ResolvedConsoleAccount;
  log?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
}) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if ((req.method ?? "GET") !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.end("Method Not Allowed");
      return true;
    }

    const contentType = readHeaderValue(req.headers["content-type"]) ?? "";
    if (!contentType.toLowerCase().includes("json")) {
      res.statusCode = 415;
      res.end("Unsupported Media Type");
      return true;
    }

    const jsonBody = await readJsonWebhookBodyOrReject({
      req,
      res,
      emptyObjectOnEmpty: false,
      invalidJsonMessage: "Invalid JSON body",
    });
    if (!jsonBody.ok) {
      return true;
    }

    let body: { sessionKey: string };
    try {
      body = parseConsolePromptSessionKey(jsonBody.value);
    } catch (error) {
      res.statusCode = 400;
      res.end(error instanceof Error ? error.message : "Invalid request body");
      return true;
    }

    try {
      const cleared = await clearConsoleSessionPrompt(body.sessionKey);
      params.log?.info?.(
        `console: cleared system prompt for ${body.sessionKey} (${params.account.accountId})`,
      );
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: true, sessionKey: body.sessionKey, cleared }));
      return true;
    } catch (error) {
      params.log?.error?.(`console: failed to clear system prompt: ${String(error)}`);
      res.statusCode = 500;
      res.end("Failed to clear system prompt");
      return true;
    }
  };
}

export const consolePlugin: ChannelPlugin<ResolvedConsoleAccount> = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: "Console",
    selectionLabel: "Console (HTTP callback)",
    detailLabel: "Console",
    docsPath: "/channels/console",
    docsLabel: "console",
    blurb: "Accepts HTTP requests and posts replies to the supplied callback URL.",
    order: 200,
  },
  capabilities: {
    chatTypes: ["direct"],
    media: true,
  },
  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
  configSchema: ConsoleConfigSchema,
  config: {
    listAccountIds: (cfg) => accountHelpers.listAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveConsoleAccount(cfg, accountId),
    defaultAccountId: (cfg) => accountHelpers.resolveDefaultAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: CHANNEL_ID,
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    isConfigured: () => true,
    isEnabled: (account) => account.enabled,
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      if (!ctx.channelRuntime) {
        throw new Error("console channel runtime is not available");
      }

      const account = ctx.account;
      const routes = [
        {
          path: buildConsoleRoutePath(account.webhookPath),
          handler: createConsoleWebhookHandler({
            account,
            channelRuntime: ctx.channelRuntime,
            log: ctx.log,
          }),
        },
        {
          path: buildConsoleRoutePath(account.webhookPath, "setPrompt"),
          handler: createConsolePromptSetHandler({ account, log: ctx.log }),
        },
        {
          path: buildConsoleRoutePath(account.webhookPath, "getPrompt"),
          handler: createConsolePromptGetHandler({ account, log: ctx.log }),
        },
        {
          path: buildConsoleRoutePath(account.webhookPath, "clearPrompt"),
          handler: createConsolePromptClearHandler({ account, log: ctx.log }),
        },
      ];

      for (const route of routes) {
        const routeKey = `${account.accountId}:${route.path}`;
        activeRouteUnregisters.get(routeKey)?.();
        const unregister = registerPluginHttpRoute({
          path: route.path,
          auth: "plugin",
          replaceExisting: true,
          pluginId: CHANNEL_ID,
          accountId: account.accountId,
          log: (message) => ctx.log?.info?.(message),
          handler: route.handler,
        });
        activeRouteUnregisters.set(routeKey, unregister);
      }

      ctx.setStatus({
        accountId: account.accountId,
        configured: true,
        enabled: account.enabled,
        running: true,
      });
      ctx.log?.info?.(
        `console: registered HTTP routes for account ${account.accountId} on ${account.webhookPath}`,
      );

      await waitUntilAbort(ctx.abortSignal);

      for (const route of routes) {
        const routeKey = `${account.accountId}:${route.path}`;
        activeRouteUnregisters.get(routeKey)?.();
        activeRouteUnregisters.delete(routeKey);
      }
      ctx.setStatus({
        accountId: account.accountId,
        configured: true,
        enabled: account.enabled,
        running: false,
      });
    },
  },
};

export {
  resolveConsoleBillingRequestUrl,
  resolveConsoleBillingActivityUrl,
  resolveConsoleCallbackRequestUrl,
  parseConsoleInboundBody,
  buildConsoleBillingServices,
  parseConsoleBotMarketingContext,
  calculateBotMarketingAmount,
};
