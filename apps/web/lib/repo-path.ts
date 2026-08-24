import fs from "node:fs";
import path from "node:path";

export function repoPath(...segments: string[]) {
  const cwd = process.cwd();
  const candidates = [
    cwd,
    path.resolve(cwd, "../.."),
    path.resolve(cwd, "../../.."),
  ];
  const root = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, "data", "knowledge", "knowledge-base.generated.json"))
  );
  if (!root) {
    throw new Error(`Could not locate Job Hunt repository root from ${cwd}`);
  }
  return path.join(root, ...segments);
}
