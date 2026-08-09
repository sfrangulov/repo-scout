import { spawnSync } from "node:child_process";

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type Runner = (
  cmd: string,
  args: string[],
  opts?: { input?: string; timeoutMs?: number },
) => RunResult;

export const run: Runner = (cmd, args, opts = {}) => {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    input: opts.input,
    timeout: opts.timeoutMs ?? 180_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.error ? String(res.error) : (res.stderr ?? ""),
  };
};
