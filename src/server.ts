import type { Server } from "bun";
import type { Message, Model, Api, Context } from "./types";
import { streamKiro } from "./stream";
import { log } from "./debug";
import { resolveKiroModel } from "./models";

export function startGatewayServer(port: number = 0): Promise<Server<any>> {
  return new Promise((resolve) => {
    const server = Bun.serve({
      port,
      async fetch(req) {
        // Handle CORS preflight
        if (req.method === "OPTIONS") {
          return new Response(null, {
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type, Authorization",
            },
          });
        }

        const url = new URL(req.url);

        // Health check endpoint
        if (url.pathname === "/health" || url.pathname === "/") {
          return new Response(JSON.stringify({ status: "healthy", service: "opencode-kiro-gateway" }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        // Anthropic Messages endpoint
        if ((url.pathname === "/v1/messages" || url.pathname === "/messages") && req.method === "POST") {
          const authHeader = req.headers.get("Authorization");
          if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return new Response(JSON.stringify({ error: { message: "Unauthorized: Missing or invalid Authorization header" } }), {
              status: 401,
              headers: { "Content-Type": "application/json" },
            });
          }

          const accessToken = authHeader.substring(7).trim();
          let body: any;
          try {
            body = await req.json();
          } catch (e) {
            return new Response(JSON.stringify({ error: { message: "Bad Request: Invalid JSON body" } }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }

          const anthropicModelId = body.model;
          const anthropicMessages = body.messages || [];
          const systemPrompt = body.system || "";
          const streamRequested = !!body.stream;
          const temperature = body.temperature ?? 0.5;

          try {
            const piMessages = translateAnthropicToPi(anthropicMessages);
            const kiroModelId = resolveKiroModel(anthropicModelId);

            const context: Context = {
              messages: piMessages,
              systemPrompt,
              tools: body.tools ? translateAnthropicToolsToPi(body.tools) : undefined,
            };

            const piModel: Model<Api> = {
              id: anthropicModelId,
              name: anthropicModelId,
              provider: "kiro",
              api: "kiro-api",
              baseUrl: "https://runtime.us-east-1.kiro.dev", // Will be resolved per region inside streamKiro using the accessToken
              reasoning: true, // Let streamKiro figure out details
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 1_000_000,
              maxTokens: 128_000,
            };

            let reasoningEffort = body.reasoning_effort;
            if (body.thinking) {
              if (body.thinking.type === "disabled") {
                reasoningEffort = undefined;
              } else {
                const budget = body.thinking.budget_tokens ?? 20000;
                if (budget <= 10000) reasoningEffort = "low";
                else if (budget <= 20000) reasoningEffort = "medium";
                else if (budget <= 30000) reasoningEffort = "high";
                else reasoningEffort = "xhigh";
              }
            } else {
              reasoningEffort = reasoningEffort ?? "medium";
            }

            const kiroStream = streamKiro(piModel, context, {
              apiKey: accessToken,
              reasoning: reasoningEffort,
              temperature,
            });

            if (streamRequested) {
              const streamResponse = new ReadableStream({
                async start(controller) {
                  try {
                    const msgId = `msg_${crypto.randomUUID()}`;
                    controller.enqueue(
                      "event: message_start\ndata: " +
                      JSON.stringify({
                        type: "message_start",
                        message: {
                          id: msgId,
                          type: "message",
                          role: "assistant",
                          content: [],
                          model: anthropicModelId,
                          stop_reason: null,
                          stop_sequence: null,
                          usage: { input_tokens: 0, output_tokens: 0 }
                        }
                      }) + "\n\n"
                    );

                    let contentBlockIndex = 0;
                    let activeBlockType: "thinking" | "text" | null = null;

                    const ensureBlockStarted = (type: "thinking" | "text") => {
                      if (activeBlockType === type) return;

                      if (activeBlockType !== null) {
                        controller.enqueue(
                          "event: content_block_stop\ndata: " +
                          JSON.stringify({
                            type: "content_block_stop",
                            index: contentBlockIndex - 1
                          }) + "\n\n"
                        );
                      }

                      activeBlockType = type;
                      controller.enqueue(
                        "event: content_block_start\ndata: " +
                        JSON.stringify({
                          type: "content_block_start",
                          index: contentBlockIndex++,
                          content_block: {
                            type,
                            [type]: ""
                          }
                        }) + "\n\n"
                      );
                    };

                    for await (const event of kiroStream) {
                      if (event.type === "thinking_delta") {
                        ensureBlockStarted("thinking");
                        controller.enqueue(
                          "event: content_block_delta\ndata: " +
                          JSON.stringify({
                            type: "content_block_delta",
                            index: contentBlockIndex - 1,
                            delta: {
                              type: "thinking_delta",
                              thinking: event.delta
                            }
                          }) + "\n\n"
                        );
                      } else if (event.type === "text_delta") {
                        ensureBlockStarted("text");
                        controller.enqueue(
                          "event: content_block_delta\ndata: " +
                          JSON.stringify({
                            type: "content_block_delta",
                            index: contentBlockIndex - 1,
                            delta: {
                              type: "text_delta",
                              text: event.delta
                            }
                          }) + "\n\n"
                        );
                      } else if (event.type === "toolcall_start") {
                        if (activeBlockType !== null) {
                          controller.enqueue(
                            "event: content_block_stop\ndata: " +
                            JSON.stringify({
                              type: "content_block_stop",
                              index: contentBlockIndex - 1
                            }) + "\n\n"
                          );
                          activeBlockType = null;
                        }

                        const tc = event.partial.content[event.contentIndex];
                        if (tc && tc.type === "toolCall") {
                          controller.enqueue(
                            "event: content_block_start\ndata: " +
                            JSON.stringify({
                              type: "content_block_start",
                              index: contentBlockIndex++,
                              content_block: {
                                type: "tool_use",
                                id: tc.id,
                                name: tc.name,
                                input: {}
                              }
                            }) + "\n\n"
                          );
                        }
                      } else if (event.type === "toolcall_delta") {
                        controller.enqueue(
                          "event: content_block_delta\ndata: " +
                          JSON.stringify({
                            type: "content_block_delta",
                            index: contentBlockIndex - 1,
                            delta: {
                              type: "input_json_delta",
                              partial_json: event.delta
                            }
                          }) + "\n\n"
                        );
                      }
                    }

                    if (activeBlockType !== null) {
                      controller.enqueue(
                        "event: content_block_stop\ndata: " +
                        JSON.stringify({
                          type: "content_block_stop",
                          index: contentBlockIndex - 1
                        }) + "\n\n"
                      );
                    }

                    let finishReason = "end_turn";
                    const finalMsg = await kiroStream.result();
                    if (finalMsg.content.some((b: any) => b.type === "toolCall")) {
                      finishReason = "tool_use";
                    }

                    controller.enqueue(
                      "event: message_delta\ndata: " +
                      JSON.stringify({
                        type: "message_delta",
                        delta: {
                          stop_reason: finishReason,
                          stop_sequence: null
                        },
                        usage: {
                          output_tokens: finalMsg.usage?.output ?? 0
                        }
                      }) + "\n\n"
                    );

                    controller.enqueue("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
                    controller.close();
                  } catch (err) {
                    log.error("Gateway stream error", err);
                    controller.enqueue(
                      "event: error\ndata: " +
                      JSON.stringify({
                        type: "error",
                        error: {
                          type: "api_error",
                          message: err instanceof Error ? err.message : String(err)
                        }
                      }) + "\n\n"
                    );
                    controller.close();
                  }
                }
              });

              return new Response(streamResponse, {
                headers: {
                  "Content-Type": "text/event-stream",
                  "Cache-Control": "no-cache",
                  "Connection": "keep-alive",
                  "Access-Control-Allow-Origin": "*",
                }
              });
            } else {
              const finalMsg = await kiroStream.result();
              const contentParts = finalMsg.content;
              const anthropicContent: any[] = [];

              for (const part of contentParts) {
                if (part.type === "text") {
                  anthropicContent.push({
                    type: "text",
                    text: part.text,
                  });
                } else if (part.type === "thinking") {
                  anthropicContent.push({
                    type: "thinking",
                    thinking: part.thinking,
                  });
                } else if (part.type === "toolCall") {
                  anthropicContent.push({
                    type: "tool_use",
                    id: part.id,
                    name: part.name,
                    input: typeof part.arguments === "string" ? JSON.parse(part.arguments) : part.arguments,
                  });
                }
              }

              let finishReason = "end_turn";
              if (finalMsg.content.some((b: any) => b.type === "toolCall")) {
                finishReason = "tool_use";
              }

              const responseBody = {
                id: `msg_${crypto.randomUUID()}`,
                type: "message",
                role: "assistant",
                content: anthropicContent,
                model: anthropicModelId,
                stop_reason: finishReason,
                stop_sequence: null,
                usage: {
                  input_tokens: finalMsg.usage?.input ?? 0,
                  output_tokens: finalMsg.usage?.output ?? 0,
                }
              };

              return new Response(JSON.stringify(responseBody), {
                headers: {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": "*",
                }
              });
            }
          } catch (err) {
            log.error("Completions error", err);
            return new Response(JSON.stringify({ error: { message: err instanceof Error ? err.message : String(err) } }), {
              status: 500,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            });
          }
        }

        return new Response(JSON.stringify({ error: { message: "Not Found" } }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
    });

    log.info(`Gateway server started on port ${server.port}`);
    resolve(server);
  });
}

function translateAnthropicToPi(messages: any[]): Message[] {
  const piMessages: Message[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        piMessages.push({
          role: "user",
          content: msg.content,
          timestamp: Date.now(),
        });
      } else if (Array.isArray(msg.content)) {
        const toolResultParts = msg.content.filter((part: any) => part.type === "tool_result");
        if (toolResultParts.length > 0) {
          for (const part of toolResultParts) {
            piMessages.push({
              role: "toolResult",
              toolCallId: part.tool_use_id,
              content: typeof part.content === "string" ? part.content : (Array.isArray(part.content) ? part.content.map((c: any) => c.text ?? "").join("\n") : ""),
              isError: part.is_error || false,
              timestamp: Date.now(),
            } as any);
          }
        }

        const otherParts = msg.content.map((part: any) => {
          if (part.type === "text") {
            return { type: "text", text: part.text };
          }
          if (part.type === "image" && part.source?.type === "base64") {
            return { type: "image", mimeType: part.source.media_type, data: part.source.data };
          }
          return null;
        }).filter(Boolean);

        if (otherParts.length > 0) {
          piMessages.push({
            role: "user",
            content: otherParts as any,
            timestamp: Date.now(),
          });
        }
      }
    } else if (msg.role === "assistant") {
      const contentParts: any[] = [];
      if (typeof msg.content === "string") {
        contentParts.push({ type: "text", text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "text") {
            contentParts.push({ type: "text", text: part.text });
          } else if (part.type === "thinking") {
            contentParts.push({ type: "thinking", thinking: part.thinking });
          } else if (part.type === "tool_use") {
            contentParts.push({
              type: "toolCall",
              id: part.id,
              name: part.name,
              arguments: part.input,
            });
          }
        }
      }

      piMessages.push({
        role: "assistant",
        content: contentParts,
        stopReason: contentParts.some(p => p.type === "toolCall") ? "toolCalls" : "stop",
        timestamp: Date.now(),
      } as any);
    }
  }

  return piMessages;
}

function translateAnthropicToolsToPi(tools: any[]): any[] {
  return tools.map(t => {
    return {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    };
  });
}
