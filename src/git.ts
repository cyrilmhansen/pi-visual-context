import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const runGit = promisify(execFile);

export type GitRepository = {
  root: string;
  head: string | null;
  branch: string | null;
  dirty: boolean;
};

export type GitProvenance = {
  repositories: GitRepository[];
};

export type GitSourceProvenance = {
  provenance: GitProvenance;
  repositoryIds: (number | null)[];
};

async function gitOutput(args: string[], cwd: string): Promise<string> {
  const { stdout } = await runGit("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
  return stdout.trim();
}

async function repositoryForPath(sourcePath: string): Promise<string | null> {
  try {
    return await realpath(await gitOutput(["rev-parse", "--show-toplevel"], dirname(resolve(sourcePath))));
  } catch {
    return null;
  }
}

async function inspectRepository(root: string): Promise<GitRepository> {
  const [head, branch, status] = await Promise.all([
    gitOutput(["rev-parse", "HEAD"], root).catch(() => ""),
    gitOutput(["symbolic-ref", "--short", "-q", "HEAD"], root).catch(() => ""),
    gitOutput(["status", "--porcelain", "--untracked-files=all"], root).catch(() => ""),
  ]);
  return { root, head: head || null, branch: branch || null, dirty: status.length > 0 };
}

export async function collectGitProvenance(sourcePaths: string[]): Promise<GitSourceProvenance> {
  const roots = await Promise.all(sourcePaths.map(repositoryForPath));
  const repositories: GitRepository[] = [];
  const repositoryIds = roots.map((root) => {
    if (!root) return null;
    const existing = repositories.findIndex((repository) => repository.root === root);
    if (existing >= 0) return existing;
    repositories.push({ root, head: null, branch: null, dirty: false });
    return repositories.length - 1;
  });
  await Promise.all(repositories.map(async (_repository, index) => {
    repositories[index] = await inspectRepository(repositories[index].root);
  }));
  return { provenance: { repositories }, repositoryIds };
}
