import { describe, expect, it } from "vitest";
import {
  buildConsoleCallbackBody,
  parseConsoleInboundBody,
  resolveConsoleCallbackRequestUrl,
} from "./channel.js";

describe("console channel helpers", () => {
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
