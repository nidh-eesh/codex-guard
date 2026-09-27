import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { convertToModelMessages, pruneMessages, streamText } from "ai";
import { MODEL } from "./model-config";
import { withReferrerPolicy } from "./http";
import { rejectInvalidWorkspace } from "./workspace";

export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  chatRecovery = true;

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai(MODEL.id, {
        sessionAffinity: this.sessionAffinity
      }),
      maxOutputTokens: MODEL.maxOutputTokens,
      system:
        "You are Codex Guard, an assistant that helps an engineering team manage the rules their code reviews check. Keep answers short.",
      // Prune old tool calls to save tokens on long conversations
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages"
      }),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }
}

// The instance name is the workspace ID. Hooks run before the Durable Object
// is reached, for WebSocket upgrades and plain HTTP requests alike.
const checkWorkspace = (_request: Request, lobby: { name: string }) =>
  rejectInvalidWorkspace(lobby.name);

export default {
  async fetch(request: Request, env: Env) {
    const response =
      (await routeAgentRequest(request, env, {
        onBeforeConnect: checkWorkspace,
        onBeforeRequest: checkWorkspace
      })) ?? new Response("Not found", { status: 404 });
    return withReferrerPolicy(response);
  }
} satisfies ExportedHandler<Env>;
