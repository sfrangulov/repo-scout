import type { Runner } from "./run.ts";

export interface Evaluation {
  idea: number;
  skill: number;
  description: string;
  securityFlag: boolean;
  securityReason: string;
}

const PROMPT_HEADER = `You are a senior code reviewer. Below is a digest of a GitHub repository.
Return a STRICT JSON object with exactly these fields:
  "idea": float in [1.0, 10.0] grading the novelty and usefulness of the project idea,
  "skill": float in [1.0, 10.0] grading the engineering skill shown in the code,
  "security_flag": true only when the code is MALICIOUS (its purpose is to harm whoever runs it), else false,
  "security_reason": empty string, or one sentence naming the malicious behaviour and where it is,
  "description": one short English sentence summarizing what the repository does.
Grade anchors: 1 = trivial/junior, 5 = ordinary/middle, 9 = strong/senior.
MALICIOUS-BEHAVIOUR SCREEN (highest priority): set security_flag=true when the digest shows
credential / API-token / SSH-key / .env / browser-cookie harvesting sent off-host; file,
clipboard or environment exfiltration; obfuscated or base64/hex payloads run via
exec/eval/subprocess; install- or import-time code that fetches and runs remote code;
hardcoded command-and-control endpoints; typosquatting of a well-known project; or a tool
whose stated purpose is innocuous but which also reads secrets and phones home.
Clean, well-structured code does NOT lower suspicion — malware is often tidy; judge intent
from what the code does with data and the network. When flagged, set idea and skill to 1.0.
A risky-but-legitimate pattern (a deploy script fetching an official release, a documented
security tool) is NOT malicious.
Return ONLY the JSON object, no prose.`;

export function buildPrompt(repo: string, digest: string): string {
  return `${PROMPT_HEADER}\n\nRepository: ${repo}\n\nDigest:\n${digest}\n`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function toScore(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? clamp(n, 1, 10) : 1;
}

export function parseEvaluation(text: string): Evaluation {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`no JSON object in model output: ${text.slice(0, 200)}`);
  }
  const data = JSON.parse(match[0]) as Record<string, unknown>;
  const rawFlag = data.security_flag;
  const flagged = typeof rawFlag === "string"
    ? ["true", "1", "yes"].includes(rawFlag.trim().toLowerCase())
    : Boolean(rawFlag);
  const reason = String(data.security_reason ?? "").trim().slice(0, 500);
  return {
    idea: toScore(data.idea),
    skill: toScore(data.skill),
    description: String(data.description ?? "").trim(),
    securityFlag: flagged,
    securityReason: flagged ? (reason || "flagged as malicious (no reason given)") : "",
  };
}

export function evaluateRepo(
  runner: Runner, model: string, repo: string, digest: string,
): Evaluation {
  const res = runner("claude", ["-p", "--model", model], {
    input: buildPrompt(repo, digest),
  });
  if (res.status !== 0) {
    throw new Error(`claude failed (status ${res.status}): ${res.stderr.slice(0, 300)}`);
  }
  return parseEvaluation(res.stdout);
}
