import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildConsoleCallbackBody,
  buildConsoleRoutePath,
  buildConsoleInboundContext,
  clearConsoleSessionPrompt,
  getConsoleSessionPrompt,
  parseConsoleInboundBody,
  setConsoleSessionPrompt,
  resolveConsoleCallbackRequestUrl,
  type ResolvedConsoleAccount,
} from "./channel.js";
import { setConsoleRuntime } from "./runtime.js";

const testAccount: ResolvedConsoleAccount = {
  accountId: "default",
  enabled: true,
  configured: true,
  webhookPath: "/console",
};

beforeEach(async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "console-channel-test-"));
  setConsoleRuntime({
    state: {
      resolveStateDir: () => stateDir,
    },
  } as never);
});

describe("console channel helpers", () => {
  it("builds child prompt routes from the base webhook path", () => {
    expect(buildConsoleRoutePath("/console")).toBe("/console");
    expect(buildConsoleRoutePath("/console/", "setPrompt")).toBe("/console/setPrompt");
  });

  it("appends /request to callback URLs", () => {
    expect(resolveConsoleCallbackRequestUrl("https://example.com/callback")).toBe(
      "https://example.com/callback/request",
    );
    expect(resolveConsoleCallbackRequestUrl("https://example.com/callback/")).toBe(
      "https://example.com/callback/request",
    );
  });

  it("keeps callback path idempotent when /request is already present", () => {
    expect(resolveConsoleCallbackRequestUrl("https://example.com/callback/request")).toBe(
      "https://example.com/callback/request",
    );
  });

  it("builds callback payload with text and media arrays", async () => {
    const body = await buildConsoleCallbackBody(
      [
        { text: "first" },
        { body: "second" },
        { mediaUrl: "https://example.com/image.png" },
        { mediaUrls: ["https://example.com/audio.mp3"] },
        { text: "ignored", isReasoning: true },
      ],
      async (url) => (url.endsWith(".png") ? "image/png" : "audio/mpeg"),
    );

    expect(body).toEqual({
      code: "callback",
      params: {
        texts: ["first", "second"],
        media: [
          { url: "https://example.com/image.png", mimeType: "image/png" },
          { url: "https://example.com/audio.mp3", mimeType: "audio/mpeg" },
        ],
      },
    });
  });

  it("stores and clears per-session prompts", async () => {
    await setConsoleSessionPrompt({
      sessionKey: "chat-123",
      systemPrompt: "Answer with JSON only.",
    });

    expect(await getConsoleSessionPrompt("chat-123")).toBe("Answer with JSON only.");
    expect(await clearConsoleSessionPrompt("chat-123")).toBe(true);
    expect(await getConsoleSessionPrompt("chat-123")).toBeUndefined();
  });

  it("injects stored prompts through GroupSystemPrompt", () => {
    expect(
      buildConsoleInboundContext({
        account: testAccount,
        body: {
          text: "hello",
          senderId: "console-user",
          sessionKey: "main",
          conversationId: "console-user",
        },
        systemPrompt: "Be terse.",
      }).GroupSystemPrompt,
    ).toBe("Be terse.");
  });

  it("parses inbound body aliases and defaults", () => {
    expect(
      parseConsoleInboundBody({
        message: "hello",
        senderName: "Midas",
      }),
    ).toEqual({
      text: "hello",
      senderId: "console-user",
      senderName: "Midas",
      sessionKey: "main",
      conversationId: "console-user",
      messageId: undefined,
      mediaUrl: undefined,
      mediaUrls: undefined,
      mediaType: undefined,
      mediaTypes: undefined,
    });
  });
});
