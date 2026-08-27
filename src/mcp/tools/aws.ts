import { spawn } from "child_process";
import type { RegisteredTool, McpToolResult } from "../types.js";

export const awsTool: RegisteredTool = {
  tool: {
    name: "use_aws",
    description:
      "Make an AWS CLI API call with the specified service, operation, and parameters. All arguments must conform to the AWS CLI specification.",
    inputSchema: {
      type: "object",
      properties: {
        service_name: {
          type: "string",
          description: "The name of the AWS service (e.g. s3, s3api, lambda, iam, sts, bedrock). Must not start with a dash.",
        },
        operation_name: {
          type: "string",
          description: "The name of the operation to perform (e.g. list-buckets, get-caller-identity, list-functions).",
        },
        parameters: {
          type: "object",
          description: "CLI options and parameters as key-value pairs (e.g. { \"bucket\": \"my-bucket\" }).",
        },
        positional_args: {
          type: "array",
          items: { type: "string" },
          description: "Optional positional arguments passed after the operation name.",
        },
      },
      required: ["service_name", "operation_name"],
    },
  },
  handler: async (args): Promise<McpToolResult> => {
    const service = String(args.service_name || "").trim().replace(/^-+/, "");
    const operation = String(args.operation_name || "").trim();

    if (!service || !operation) {
      return {
        isError: true,
        content: [{ type: "text", text: "Error: service_name and operation_name are required." }],
      };
    }

    const cliArgs: string[] = [service, operation];

    if (Array.isArray(args.positional_args)) {
      for (const pos of args.positional_args) {
        if (typeof pos === "string" && pos.length > 0) {
          cliArgs.push(pos);
        }
      }
    }

    if (args.parameters && typeof args.parameters === "object") {
      for (const [key, val] of Object.entries(args.parameters)) {
        const flag = key.startsWith("-") ? key : `--${key.replace(/_/g, "-")}`;
        if (typeof val === "boolean") {
          if (val) cliArgs.push(flag);
        } else if (val !== null && val !== undefined) {
          cliArgs.push(flag, typeof val === "object" ? JSON.stringify(val) : String(val));
        }
      }
    }

    return new Promise<McpToolResult>((resolve) => {
      let stdout = "";
      let stderr = "";

      const child = spawn("aws", cliArgs, {
        env: { ...process.env, AWS_PAGER: "" },
        timeout: 30000,
      });

      child.stdout.on("data", (d) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });

      child.on("error", (err: any) => {
        if (err.code === "ENOENT") {
          resolve({
            isError: true,
            content: [
              {
                type: "text",
                text: "Error: 'aws' CLI executable was not found in PATH. Please install the AWS CLI or configure it in your environment.",
              },
            ],
          });
        } else {
          resolve({
            isError: true,
            content: [{ type: "text", text: `Error executing AWS command: ${err.message}` }],
          });
        }
      });

      child.on("close", (code) => {
        if (code === 0) {
          resolve({
            content: [{ type: "text", text: stdout.trim() || "(Command executed successfully with no output)" }],
          });
        } else {
          resolve({
            isError: true,
            content: [
              {
                type: "text",
                text: `AWS CLI command failed (exit code ${code}):\n${stderr.trim() || stdout.trim() || "Unknown error"}`,
              },
            ],
          });
        }
      });
    });
  },
};
