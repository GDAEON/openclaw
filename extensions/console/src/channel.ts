import type { IncomingMessage, ServerResponse } from "node:http";
import {
  buildChannelConfigSchema,
  createAccountListHelpers,
  DEFAULT_ACCOUNT_ID,
  registerPluginHttpRoute,
  readJsonWebhookBodyOrReject,
  setAccountEnabledInConfigSection,
  waitUntilAbort,
  type ChannelGatewayContext,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import { z } from "zod";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { getConsoleRuntime } from "./runtime.js";

const CHANNEL_ID = "console";
const DEFAULT_WEBHOOK_PATH = "/console";
const DEFAULT_SESSION_KEY = "main";
const DEFAULT_SENDER_ID = "console-user";

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

function buildConsoleInboundContext(params: {
  account: ResolvedConsoleAccount;
  body: ConsoleInboundBody;
}) {
  const { account, body } = params;
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

    let callbackUrl: string;
    try {
      callbackUrl = resolveConsoleCallbackRequestUrl(callbackHeader);
    } catch (error) {
      res.statusCode = 400;
      res.end(error instanceof Error ? error.message : "Invalid X-CALLBACK-URL header");
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

    const runtime = getConsoleRuntime();
    const payloads: ConsoleReplyPayload[] = [];

    try {
      await params.channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: buildConsoleInboundContext({
          account: params.account,
          body: inboundBody,
        }),
        cfg: runtime.config.loadConfig(),
        dispatcherOptions: {
          deliver: async (payload) => {
            payloads.push(payload as ConsoleReplyPayload);
          },
          onReplyStart: () => {
            params.log?.info?.(
              `console: reply started for ${inboundBody.conversationId} (${params.account.accountId})`,
            );
          },
          onError: (error, info) => {
            params.log?.error?.(`console: ${info.kind} reply failed: ${String(error)}`);
          },
        },
      });

      await postConsoleCallback({
        callbackUrl,
        payloads,
      });
    } catch (error) {
      params.log?.error?.(`console: inbound request failed: ${String(error)}`);
      res.statusCode = 500;
      res.end("Console request failed");
      return true;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true }));
    return true;
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
      const routeKey = `${account.accountId}:${account.webhookPath}`;
      activeRouteUnregisters.get(routeKey)?.();

      const unregister = registerPluginHttpRoute({
        path: account.webhookPath,
        auth: "plugin",
        replaceExisting: true,
        pluginId: CHANNEL_ID,
        accountId: account.accountId,
        log: (message) => ctx.log?.info?.(message),
        handler: createConsoleWebhookHandler({
          account,
          channelRuntime: ctx.channelRuntime,
          log: ctx.log,
        }),
      });

      activeRouteUnregisters.set(routeKey, unregister);
      ctx.setStatus({
        accountId: account.accountId,
        configured: true,
        enabled: account.enabled,
        running: true,
      });
      ctx.log?.info?.(
        `console: registered HTTP route ${account.webhookPath} for account ${account.accountId}`,
      );

      await waitUntilAbort(ctx.abortSignal);

      unregister();
      activeRouteUnregisters.delete(routeKey);
      ctx.setStatus({
        accountId: account.accountId,
        configured: true,
        enabled: account.enabled,
        running: false,
      });
    },
  },
};

export { resolveConsoleCallbackRequestUrl, parseConsoleInboundBody };
