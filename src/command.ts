import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { VISUAL_CONTEXT_HELP } from "./help.ts";

export function registerVisualContextCommand(pi: Pick<ExtensionAPI, "registerCommand">): void {
  pi.registerCommand("visual-context", {
    description: "Show pi-visual-context usage and options",
    handler: async (_args, ctx) => {
      ctx.ui.setWidget("visual-context-help", VISUAL_CONTEXT_HELP.split("\n"));
    },
  });
}
