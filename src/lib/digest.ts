import { readdirSync, readFileSync, lstatSync } from "node:fs";
import { join, relative } from "node:path";

export const MAX_FILES = 20;
export const MAX_LINES_PER_FILE = 80;
export const MAX_CHARS_PER_FILE = 4_000;
export const MAX_TOTAL_CHARS = 40_000;
export const MAX_FILE_BYTES = 262_144;

const IGNORE_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", "vendor", "target",
  "__pycache__", ".venv", "venv", ".next", ".idea", ".vscode",
]);

const EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".md",
  ".yaml", ".yml", ".toml", ".sh", ".sql",
]);

function walk(dir: string, root: string, acc: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names.sort()) {
    const abs = join(dir, name);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue; // never follow symlinks: exfiltration + loop risk
    if (st.isDirectory()) {
      if (!IGNORE_DIRS.has(name)) walk(abs, root, acc);
      continue;
    }
    const dot = name.lastIndexOf(".");
    const ext = dot === -1 ? "" : name.slice(dot).toLowerCase();
    if (!EXTENSIONS.has(ext)) continue;
    if (st.size > MAX_FILE_BYTES) continue;
    acc.push(relative(root, abs));
  }
}

function isReadme(rel: string): boolean {
  const base = rel.split("/").pop() ?? "";
  return base.toLowerCase().startsWith("readme");
}

export function buildDigest(root: string): string {
  const all: string[] = [];
  walk(root, root, all);
  all.sort((a, b) =>
    Number(isReadme(b)) - Number(isReadme(a)) || a.localeCompare(b));
  const files = all.slice(0, MAX_FILES);
  if (files.length === 0) return "";

  const lines = ["FILES:", ...files.map(f => `  ${f}`), ""];
  let total = lines.reduce((n, l) => n + l.length + 1, 0);
  for (const rel of files) {
    let text: string;
    try {
      text = readFileSync(join(root, rel), "utf8");
    } catch {
      continue;
    }
    const snippet = text
      .split("\n")
      .slice(0, MAX_LINES_PER_FILE)
      .join("\n")
      .slice(0, MAX_CHARS_PER_FILE);
    const block = `\n----- ${rel} -----\n${snippet}\n`;
    if (total + block.length > MAX_TOTAL_CHARS) break;
    lines.push(block);
    total += block.length;
  }
  return lines.join("\n");
}
