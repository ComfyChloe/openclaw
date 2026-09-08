import { createServer } from "node:http";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { attachModelProviderRequestTransport } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createAssistantMessageEventStream,
  streamSimple,
  type Model,
  type Context,
  type AssistantMessage,
  type AssistantMessageEvent,
} from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

function toolCallMessage(
  name: string,
  argumentsValue: Record<string, unknown> = { query: "OpenClaw" },
): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "opencode",
    model: "gpt-5.6-sol",
    content: [{ type: "toolCall", id: "call_1", name, arguments: argumentsValue }],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 1,
  };
}

describe("OpenCode stream adapter", () => {
  it("aliases the reserved web_search function across OpenCode Responses requests", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    let capturedPayload: Record<string, unknown> | undefined;
    const existingAlias = "openclaw_web_search";
    const wireAlias = "openclaw_web_search_2";
    let producerPartial: AssistantMessage | undefined;
    let producerTerminal: AssistantMessage | undefined;
    let releaseTerminal = () => {};
    const allowTerminal = new Promise<void>((resolve) => {
      releaseTerminal = resolve;
    });
    const baseStreamFn: StreamFn = async (model, _context, options) => {
      const initialPayload = { model: model.id };
      const replacement = await options?.onPayload?.(initialPayload, model);
      capturedPayload = (replacement ?? initialPayload) as Record<string, unknown>;
      const stream = createAssistantMessageEventStream();
      const wireArguments = { options: [{ key: "region", value: "us" }] };
      producerPartial = toolCallMessage(wireAlias, wireArguments);
      producerTerminal = toolCallMessage(wireAlias, wireArguments);
      queueMicrotask(() => {
        stream.push({
          type: "toolcall_start",
          contentIndex: 0,
          partial: producerPartial as AssistantMessage,
        });
        void allowTerminal.then(() => {
          stream.push({
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: producerPartial?.content[0] as never,
            partial: producerPartial as AssistantMessage,
          });
          stream.push({
            type: "done",
            reason: "toolUse",
            message: producerTerminal as AssistantMessage,
          });
        });
      });
      return stream;
    };
    const streamFn = provider.wrapStreamFn?.({
      streamFn: baseStreamFn,
      providerId: "opencode",
      modelId: "gpt-5.6-sol",
    } as never);
    if (!streamFn) {
      throw new Error("expected OpenCode stream wrapper");
    }

    const stream = await streamFn(
      { provider: "opencode", id: "gpt-5.6-sol", api: "openai-responses" } as never,
      { messages: [] } as never,
      {
        onPayload: () => ({
          tools: [
            {
              type: "function",
              name: "web_search",
              parameters: {
                type: "object",
                properties: {
                  options: {
                    type: "object",
                    patternProperties: { "^.*$": { type: "string" } },
                  },
                },
              },
            },
            { type: "function", name: existingAlias },
            { type: "function", name: "read" },
          ],
          input: [{ type: "function_call", name: "web_search", call_id: "call_0" }],
          tool_choice: {
            type: "allowed_tools",
            mode: "required",
            tools: [
              { type: "function", name: "web_search" },
              { type: "function", name: existingAlias },
            ],
          },
        }),
      },
    );
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) {
      throw new Error("expected staged tool-call event");
    }
    const events = [first.value];
    expect(first.value).toMatchObject({
      type: "toolcall_start",
      partial: { content: [{ name: "web_search", arguments: { options: { region: "us" } } }] },
    });
    expect([producerPartial, producerTerminal]).toMatchObject([
      { content: [{ name: wireAlias, arguments: { options: [{ key: "region", value: "us" }] } }] },
      { content: [{ name: wireAlias, arguments: { options: [{ key: "region", value: "us" }] } }] },
    ]);
    releaseTerminal();
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
      events.push(next.value);
    }

    expect(capturedPayload).toMatchObject({
      tools: [
        { type: "function", name: wireAlias },
        { type: "function", name: existingAlias },
        { type: "function", name: "read" },
      ],
      input: [{ type: "function_call", name: wireAlias, call_id: "call_0" }],
      tool_choice: {
        type: "allowed_tools",
        mode: "required",
        tools: [
          { type: "function", name: wireAlias },
          { type: "function", name: existingAlias },
        ],
      },
    });
    expect(events[1]).toMatchObject({
      type: "toolcall_end",
      toolCall: { name: "web_search", arguments: { options: { region: "us" } } },
      partial: {
        content: [{ name: "web_search", arguments: { options: { region: "us" } } }],
      },
    });
    expect(events[2]).toMatchObject({
      type: "done",
      message: { content: [{ name: "web_search" }] },
    });
    await expect(stream.result()).resolves.toMatchObject({
      content: [{ name: "web_search", arguments: { options: { region: "us" } } }],
    });
    expect([producerPartial, producerTerminal]).toMatchObject([
      { content: [{ name: wireAlias, arguments: { options: [{ key: "region", value: "us" }] } }] },
      { content: [{ name: wireAlias, arguments: { options: [{ key: "region", value: "us" }] } }] },
    ]);
  });

  it("does not restore an unaliased OpenCode Responses function name", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const existingAlias = "openclaw_web_search";
    const source = createAssistantMessageEventStream();
    const payload = { tools: [{ type: "function", name: existingAlias }] };
    const baseStreamFn: StreamFn = (model, _context, options) => {
      void options?.onPayload?.(payload, model);
      queueMicrotask(() => source.end(toolCallMessage(existingAlias)));
      return source;
    };
    const streamFn = provider.wrapStreamFn?.({
      streamFn: baseStreamFn,
      providerId: "opencode",
      modelId: "gpt-5.6-sol",
    } as never);

    const stream = await streamFn?.(
      { provider: "opencode", id: "gpt-5.6-sol", api: "openai-responses" } as never,
      { messages: [] } as never,
      {},
    );

    expect(payload.tools[0]?.name).toBe(existingAlias);
    await expect(stream?.result()).resolves.toMatchObject({ content: [{ name: existingAlias }] });
  });

  it("round-trips dynamic record tool arguments through OpenCode-compatible schemas", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    let capturedPayload: Record<string, unknown> | undefined;
    let producerDelta: Extract<AssistantMessageEvent, { type: "toolcall_delta" }> | undefined;
    const baseStreamFn: StreamFn = async (model, _context, options) => {
      const initialPayload = { model: model.id };
      const replacement = await options?.onPayload?.(initialPayload, model);
      capturedPayload = (replacement ?? initialPayload) as Record<string, unknown>;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const execMessage = toolCallMessage("exec", {
          command: "node app.js",
          env: [{ key: "NODE_ENV", value: "test" }],
        });
        producerDelta = {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: JSON.stringify({
            command: "node app.js",
            env: [{ key: "NODE_ENV", value: "test" }],
          }),
          partial: execMessage,
        };
        stream.push(producerDelta);
        stream.push({
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: execMessage.content[0] as never,
          partial: execMessage,
        });
        const duplicateMessage = toolCallMessage("dashboard", {
          props: [
            { key: "title", value: '"first"' },
            { key: "title", value: '"second"' },
          ],
        });
        stream.push({
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: duplicateMessage.content[0] as never,
          partial: duplicateMessage,
        });
        const malformedMessage = toolCallMessage("video_generate", {
          providerOptions: [{ key: "broken", value: "not-json" }],
        });
        stream.push({
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: malformedMessage.content[0] as never,
          partial: malformedMessage,
        });
        stream.push({
          type: "done",
          reason: "toolUse",
          message: toolCallMessage("video_generate", {
            providerOptions: [
              { key: "label", value: '"42"' },
              { key: "seed", value: "42" },
              { key: "enabled", value: "true" },
              { key: "empty", value: "null" },
            ],
          }),
        });
      });
      return stream;
    };
    const streamFn = provider.wrapStreamFn?.({
      streamFn: baseStreamFn,
      providerId: "opencode",
      modelId: "gpt-5.6-sol",
    } as never);
    if (!streamFn) {
      throw new Error("expected OpenCode stream wrapper");
    }

    const stream = await streamFn(
      { provider: "opencode", id: "gpt-5.6-sol", api: "openai-responses" } as never,
      { messages: [] } as never,
      {
        onPayload: () => ({
          tools: [
            {
              type: "function",
              name: "exec",
              parameters: {
                type: "object",
                properties: {
                  env: {
                    type: "object",
                    patternProperties: { "^.*$": { type: "string" } },
                  },
                },
              },
            },
            {
              type: "function",
              name: "video_generate",
              parameters: {
                type: "object",
                properties: {
                  providerOptions: {
                    type: "object",
                    patternProperties: { "^.*$": {} },
                  },
                },
              },
            },
            {
              type: "function",
              name: "dashboard",
              parameters: {
                type: "object",
                properties: {
                  props: {
                    type: "object",
                    patternProperties: { "^.*$": {} },
                  },
                },
              },
            },
          ],
          input: [
            {
              type: "function_call",
              name: "exec",
              arguments: JSON.stringify({ command: "node app.js", env: { NODE_ENV: "test" } }),
            },
            {
              type: "function_call",
              name: "video_generate",
              arguments: {
                providerOptions: { label: "42", seed: 42, enabled: true, empty: null },
              },
            },
          ],
        }),
      },
    );
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    const tools = capturedPayload?.tools as Array<Record<string, unknown>>;
    const execParameters = tools[0]?.parameters as Record<string, unknown>;
    const execProperties = execParameters.properties as Record<string, unknown>;
    expect(execProperties.env).toMatchObject({
      type: "array",
      items: {
        properties: { key: { type: "string" }, value: { type: "string" } },
        required: ["key", "value"],
        additionalProperties: false,
      },
    });
    expect(JSON.stringify(execProperties.env)).not.toContain("patternProperties");
    const input = capturedPayload?.input as Array<Record<string, unknown>>;
    expect(JSON.parse(input[0]?.arguments as string)).toEqual({
      command: "node app.js",
      env: [{ key: "NODE_ENV", value: "test" }],
    });
    expect(input[1]?.arguments).toEqual({
      providerOptions: [
        { key: "label", value: '"42"' },
        { key: "seed", value: "42" },
        { key: "enabled", value: "true" },
        { key: "empty", value: "null" },
      ],
    });
    expect(events[0]).toMatchObject({
      type: "toolcall_delta",
      delta: "",
      partial: {
        content: [{ arguments: { command: "node app.js", env: { NODE_ENV: "test" } } }],
      },
    });
    expect(producerDelta).toMatchObject({
      delta: '{"command":"node app.js","env":[{"key":"NODE_ENV","value":"test"}]}',
      partial: {
        content: [
          {
            arguments: {
              command: "node app.js",
              env: [{ key: "NODE_ENV", value: "test" }],
            },
          },
        ],
      },
    });
    expect(events[1]).toMatchObject({
      type: "toolcall_end",
      toolCall: { arguments: { command: "node app.js", env: { NODE_ENV: "test" } } },
    });
    expect(events[2]).toMatchObject({
      type: "toolcall_end",
      toolCall: {
        arguments: {
          props: [
            { key: "title", value: '"first"' },
            { key: "title", value: '"second"' },
          ],
        },
      },
    });
    expect(events[3]).toMatchObject({
      type: "toolcall_end",
      toolCall: {
        arguments: { providerOptions: [{ key: "broken", value: "not-json" }] },
      },
    });
    expect(events[4]).toMatchObject({
      type: "done",
      message: {
        content: [
          {
            arguments: {
              providerOptions: { label: "42", seed: 42, enabled: true, empty: null },
            },
          },
        ],
      },
    });
    await expect(stream.result()).resolves.toMatchObject({
      content: [
        {
          arguments: {
            providerOptions: { label: "42", seed: 42, enabled: true, empty: null },
          },
        },
      ],
    });
  });

  it("rebuilds dynamic record metadata when a Responses request payload is rebuilt", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const firstPayload = {
      tools: [
        {
          type: "function",
          name: "exec",
          parameters: {
            type: "object",
            properties: {
              env: {
                type: "object",
                patternProperties: { "^.*$": { type: "string" } },
              },
            },
          },
        },
      ],
    };
    const secondPayload = {
      tools: [
        {
          type: "function",
          name: "exec",
          parameters: {
            type: "object",
            properties: { env: { type: "array", items: { type: "string" } } },
          },
        },
      ],
    };
    const baseStreamFn: StreamFn = async (model, _context, options) => {
      await options?.onPayload?.(firstPayload, model);
      await options?.onPayload?.(secondPayload, model);
      const source = createAssistantMessageEventStream();
      queueMicrotask(() =>
        source.end(
          toolCallMessage("exec", {
            env: [{ key: "literal", value: "array" }],
          }),
        ),
      );
      return source;
    };
    const streamFn = provider.wrapStreamFn?.({
      streamFn: baseStreamFn,
      providerId: "opencode",
      modelId: "gpt-5.6-sol",
    } as never);

    const stream = await streamFn?.(
      { provider: "opencode", id: "gpt-5.6-sol", api: "openai-responses" } as never,
      { messages: [] } as never,
      {},
    );

    expect(firstPayload.tools[0]?.parameters.properties.env.type).toBe("array");
    expect(secondPayload.tools[0]?.parameters.properties.env).toEqual({
      type: "array",
      items: { type: "string" },
    });
    await expect(stream?.result()).resolves.toMatchObject({
      content: [
        {
          arguments: { env: [{ key: "literal", value: "array" }] },
        },
      ],
    });
  });

  it("leaves web_search unchanged for non-Responses OpenCode models", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const source = createAssistantMessageEventStream();
    const payload = { tools: [{ type: "function", name: "web_search" }] };
    const baseStreamFn: StreamFn = (model, _context, options) => {
      void options?.onPayload?.(payload, model);
      queueMicrotask(() => source.end(toolCallMessage("web_search")));
      return source;
    };
    const streamFn = provider.wrapStreamFn?.({
      streamFn: baseStreamFn,
      providerId: "opencode",
      modelId: "kimi-k2.6",
    } as never);

    const stream = await streamFn?.(
      { provider: "opencode", id: "kimi-k2.6", api: "openai-completions" } as never,
      { messages: [] } as never,
      {},
    );
    expect(stream).toBe(source);
    expect(payload.tools[0]?.name).toBe("web_search");
  });
});

describe.each(["openai-responses", "openai-completions"] as const)(
  "OpenCode image capability on the %s wire",
  (api) => {
    it.each([
      { capability: "image" as const, reasoning: { effort: "none" }, removed: true },
      { capability: "image" as const, reasoning: "none", removed: true },
      { capability: "image" as const, reasoning: { effort: "low" }, removed: false },
      { capability: undefined, reasoning: { effort: "none" }, removed: false },
      { capability: undefined, reasoning: { effort: "low" }, removed: false },
    ])(
      "preserves caller payloads for capability=$capability reasoning=$reasoning",
      async ({ capability, reasoning, removed }) => {
        let captured: Record<string, unknown> | undefined;
        const server = createServer((request, response) => {
          let body = "";
          request.on("data", (chunk) => {
            body += chunk;
          });
          request.on("end", () => {
            captured = JSON.parse(body);
            response.writeHead(200, { "content-type": "text/event-stream" });
            if (api === "openai-completions") {
              for (const chunk of [
                {
                  id: "chat-proof",
                  choices: [
                    {
                      index: 0,
                      delta: { role: "assistant", content: "wire ok" },
                      finish_reason: null,
                    },
                  ],
                },
                {
                  id: "chat-proof",
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                },
              ]) {
                response.write(`data: ${JSON.stringify(chunk)}\n\n`);
              }
              response.end("data: [DONE]\n\n");
              return;
            }
            const item = {
              id: "msg-proof",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "wire ok", annotations: [] }],
            };
            for (const event of [
              {
                type: "response.created",
                response: { id: "resp-proof", status: "in_progress", output: [] },
              },
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { ...item, status: "in_progress", content: [] },
              },
              {
                type: "response.output_text.delta",
                output_index: 0,
                content_index: 0,
                item_id: item.id,
                delta: "wire ok",
              },
              { type: "response.output_item.done", output_index: 0, item },
              {
                type: "response.completed",
                response: {
                  id: "resp-proof",
                  status: "completed",
                  model: "gpt-5-nano",
                  output: [item],
                  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                },
              },
            ]) {
              response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            }
            response.end();
          });
        });
        await new Promise<void>((resolve) => {
          server.listen(0, "127.0.0.1", resolve);
        });
        try {
          const address = server.address();
          if (!address || typeof address === "string") {
            throw new Error("Expected loopback TCP server");
          }
          const model: Model<typeof api> = attachModelProviderRequestTransport(
            {
              provider: "opencode",
              id: "gpt-5-nano",
              name: "Wire proof",
              api,
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              reasoning: true,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8192,
              maxTokens: 128,
            },
            { allowPrivateNetwork: true },
          );
          const provider = await registerSingleProviderPlugin(plugin);
          const wrapped = provider.wrapStreamFn?.({
            provider: "opencode",
            modelId: model.id,
            model,
            streamFn: streamSimple,
            capability,
          });
          if (!wrapped) {
            throw new Error("Expected OpenCode stream wrapper");
          }
          const context: Context = {
            messages: [
              {
                role: "user",
                timestamp: 1,
                content: [
                  { type: "text", text: "Describe the input." },
                  ...(capability === "image"
                    ? [
                        {
                          type: "image" as const,
                          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=",
                          mimeType: "image/png",
                        },
                      ]
                    : []),
                ],
              },
            ],
          };
          let callerTransforms = 0;
          const result = await (
            await wrapped(model, context, {
              apiKey: "synthetic-wire-key",
              maxTokens: 64,
              signal: AbortSignal.timeout(10000),
              onPayload: async (payload) => {
                if (!isRecord(payload)) {
                  throw new Error("Expected provider payload");
                }
                callerTransforms += 1;
                await Promise.resolve();
                return { ...payload, reasoning, metadata: { caller: "preserved" } };
              },
            })
          ).result();
          expect(result.stopReason).toBe("stop");
          expect(callerTransforms).toBe(1);
          expect(captured?.metadata).toEqual({ caller: "preserved" });
          expect(captured?.reasoning).toEqual(removed ? undefined : reasoning);
          const imageKind = api === "openai-responses" ? "input_image" : "image_url";
          const wireInput = JSON.stringify(captured?.input ?? captured?.messages);
          if (capability === "image") {
            expect(wireInput).toContain(imageKind);
          } else {
            expect(wireInput).not.toContain(imageKind);
          }
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        }
      },
    );
  },
);
