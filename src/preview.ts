import { spawn } from "node:child_process";
import { join } from "node:path";

type Launcher = (command: string, args: string[]) => Promise<void>;

const nativeLauncher: Launcher = (command, args) => new Promise((resolve) => {
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.once("error", () => resolve());
  child.once("spawn", () => { child.unref(); resolve(); });
});

export async function openPreview(debugDirectory: string, platform = process.platform, launcher: Launcher = nativeLauncher, filename = "page-001.png"): Promise<void> {
  const page = join(debugDirectory, filename);
  try {
    if (platform === "linux") await launcher("xdg-open", [page]);
    else if (platform === "darwin") await launcher("open", [page]);
    else if (platform === "win32") await launcher("cmd", ["/c", "start", "", page]);
  } catch {
    // Preview files remain available even when no graphical launcher exists.
  }
}
