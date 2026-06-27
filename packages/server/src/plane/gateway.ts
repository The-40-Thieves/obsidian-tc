// Generative-roles seam for the sleep-time plane — THE-233 W-WORKERS. The engine speaks
// roles (extract / synthesize / judge), never providers; the self-hosted LiteLLM gateway
// (W-GATEWAY-CLIENT) binds each role to a model. That client lives on its own branch, so the
// plane consumes roles through this injected seam and runs against a MOCK in this unit. At
// integration the gateway client IS a GatewayRoles (its extract/synthesize/judge match this
// shape) — wiring is a direct pass-through. No provider SDKs, no keys in the tree.

export interface GatewayChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GatewayCompletionRequest {
  messages: GatewayChatMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: Record<string, unknown>;
}

export interface GatewayCompletionResult {
  text: string;
  /** Resolved provider:model the gateway used — persisted as the job's judge/synthesis model. */
  model: string;
}

export interface GatewayRoles {
  extract(req: GatewayCompletionRequest): Promise<GatewayCompletionResult>;
  synthesize(req: GatewayCompletionRequest): Promise<GatewayCompletionResult>;
  judge(req: GatewayCompletionRequest): Promise<GatewayCompletionResult>;
}

/** Convenience: build a one-shot request from a system + user prompt. */
export function prompt(system: string, user: string): GatewayCompletionRequest {
  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
}
