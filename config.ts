import type { Config } from "./src/lib/types.ts";

export default {
  queries: [
    "topic:mcp",
    "topic:claude-code",
    '"claude code" in:name,description',
    "topic:claude-code-plugin",
    "topic:model-context-protocol",
    "topic:rag language:typescript",
    "topic:agent-observability",
    "topic:tmux topic:ai",
  ],
  minStars: 2,
  maxStars: 200,
  perQuery: 10,
  interestThreshold: 6,
  minSkill: 4,
  model: "haiku",
  dbPath: "data/scout.sqlite",
} satisfies Config;
