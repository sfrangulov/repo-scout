import type { Config } from "./src/lib/types.ts";

export default {
  queries: [
    "topic:mcp",
    "topic:claude-code",
    '"claude code" in:name,description',
    "topic:llm-agents",
    "topic:ai-agents language:typescript",
    "topic:rag language:typescript",
  ],
  maxStars: 200,
  perQuery: 10,
  reviewThreshold: 12,
  model: "haiku",
  dbPath: "data/scout.sqlite",
} satisfies Config;
