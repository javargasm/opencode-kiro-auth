import { spawn } from "child_process";
import type { RegisteredTool, McpToolResult, SpawnFn } from "../types.js";

let _spawnFn: SpawnFn = spawn;

export function setGitSpawnRunner(fn: SpawnFn): void {
  _spawnFn = fn;
}

export function resetGitSpawnRunner(): void {
  _spawnFn = spawn;
}

function execGit(args: string[], cwd?: string, env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = _spawnFn("git", args, {
      cwd: cwd || process.cwd(),
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "opencode-kiro",
        GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "opencode-kiro@local",
        GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "opencode-kiro",
        GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || "opencode-kiro@local",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";

    if (child.stdout) {
      child.stdout.on("data", (d) => {
        stdout += d.toString();
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });
    }

    child.on("error", (err: any) => {
      resolve({ stdout: "", stderr: err?.message || String(err), code: 1 });
    });

    child.on("close", (code) => {
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 0 });
    });
  });
}

export const checkpointTool: RegisteredTool = {
  tool: {
    name: "kiro_checkpoint",
    description:
      "Manage workspace checkpoints and safe restore points using Git underneath. Use before making major changes to preserve the ability to rollback.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "list", "diff", "restore"],
          description: "Checkpoint action to execute.",
        },
        message: {
          type: "string",
          description: "Descriptive message for the checkpoint when creating.",
        },
        checkpoint_id: {
          type: "string",
          description: "Checkpoint ID (or Git tree hash/commit) for diff or restore.",
        },
      },
      required: ["action"],
    },
  },
  handler: async (args): Promise<McpToolResult> => {
    const action = String(args.action || "").toLowerCase().trim();

    // Check if git repository exists
    const checkGit = await execGit(["rev-parse", "--is-inside-work-tree"]);
    if (checkGit.code !== 0) {
      return {
        isError: true,
        content: [{ type: "text", text: "Error: Current directory is not a Git repository. Checkpoints require Git." }],
      };
    }

    switch (action) {
      case "create": {
        const msg = args.message || `Checkpoint at ${new Date().toISOString()}`;
        // Create a stash-like commit object without modifying current index/HEAD
        const headRes = await execGit(["rev-parse", "HEAD"]);
        const parentArgs = headRes.code === 0 && headRes.stdout ? ["-p", headRes.stdout] : [];

        // Save tree
        await execGit(["add", "-A"]);
        const writeTree = await execGit(["write-tree"]);
        if (writeTree.code !== 0 || !writeTree.stdout) {
          return {
            isError: true,
            content: [{ type: "text", text: `Failed to create checkpoint tree: ${writeTree.stderr || "Unknown error"}` }],
          };
        }

        const treeSha = writeTree.stdout;
        const commitTree = await execGit([
          "commit-tree",
          treeSha,
          ...parentArgs,
          "-m",
          `kiro-checkpoint: ${msg}`,
        ]);

        if (commitTree.code !== 0 || !commitTree.stdout) {
          return {
            isError: true,
            content: [{ type: "text", text: `Failed to create checkpoint commit: ${commitTree.stderr || "Unknown error"}` }],
          };
        }

        const checkpointId = commitTree.stdout.slice(0, 8);
        const tagRef = `refs/kiro/checkpoints/${checkpointId}`;
        await execGit(["update-ref", tagRef, commitTree.stdout]);

        return {
          content: [
            {
              type: "text",
              text: `✅ Checkpoint created successfully!\n- **ID**: \`${checkpointId}\`\n- **Tree**: \`${treeSha.slice(0, 8)}\`\n- **Message**: "${msg}"`,
            },
          ],
        };
      }

      case "list": {
        const refs = await execGit(["for-each-ref", "--format=%(refname:short)|%(objectname:short)|%(contents:subject)|%(authordate:relative)", "refs/kiro/checkpoints/"]);
        if (!refs.stdout) {
          return {
            content: [{ type: "text", text: "No saved checkpoints found in this repository." }],
          };
        }

        const lines = ["### Saved Workspace Checkpoints:\n"];
        for (const row of refs.stdout.split("\n")) {
          const parts = row.split("|");
          if (parts.length >= 4) {
            const ref = parts[0]!;
            const sha = parts[1]!;
            const subject = parts[2]!;
            const date = parts[3]!;
            const id = ref.replace("refs/kiro/checkpoints/", "");
            lines.push(`- **\`${id}\`** (\`${sha}\`, ${date}): ${subject}`);
          }
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      }

      case "diff": {
        const id = args.checkpoint_id;
        if (!id) {
          return {
            isError: true,
            content: [{ type: "text", text: "Error: 'checkpoint_id' parameter is required for action 'diff'." }],
          };
        }
        const diffRes = await execGit(["diff", id]);
        return {
          content: [
            {
              type: "text",
              text: diffRes.stdout ? `\`\`\`diff\n${diffRes.stdout}\n\`\`\`` : "No differences between workspace and checkpoint.",
            },
          ],
        };
      }

      case "restore": {
        const id = args.checkpoint_id;
        if (!id) {
          return {
            isError: true,
            content: [{ type: "text", text: "Error: 'checkpoint_id' parameter is required for action 'restore'." }],
          };
        }

        const restoreRes = await execGit(["checkout", id, "--", "."]);
        if (restoreRes.code !== 0) {
          return {
            isError: true,
            content: [{ type: "text", text: `Failed to restore checkpoint ${id}: ${restoreRes.stderr}` }],
          };
        }

        return {
          content: [{ type: "text", text: `✅ Workspace successfully restored to checkpoint \`${id}\`.` }],
        };
      }

      default:
        return {
          isError: true,
          content: [{ type: "text", text: `Unknown action '${action}'. Supported: 'create', 'list', 'diff', 'restore'.` }],
        };
    }
  },
};
