import { describe, it, expect } from "vitest";
import {
  collapseAgenticLoops,
  convertImagesToKiro,
  normalizeImageFormat,
  type KiroHistoryEntry,
} from "../src/transform";

describe("normalizeImageFormat (#15)", () => {
  it("maps common raster types", () => {
    expect(normalizeImageFormat("image/png")).toBe("png");
    expect(normalizeImageFormat("image/jpeg")).toBe("jpeg");
    expect(normalizeImageFormat("image/jpg")).toBe("jpeg");
    expect(normalizeImageFormat("image/gif")).toBe("gif");
    expect(normalizeImageFormat("image/webp")).toBe("webp");
  });

  it("strips parameters and normalizes casing", () => {
    expect(normalizeImageFormat("IMAGE/PNG")).toBe("png");
    expect(normalizeImageFormat("image/jpeg; charset=binary")).toBe("jpeg");
  });

  it("rejects unsupported / structured-syntax subtypes (no bogus format)", () => {
    expect(normalizeImageFormat("image/svg+xml")).toBeNull();
    expect(normalizeImageFormat("image/vnd.microsoft.icon")).toBeNull();
    expect(normalizeImageFormat("application/pdf")).toBeNull();
    expect(normalizeImageFormat("image/")).toBeNull();
  });
});

describe("convertImagesToKiro (#15 — omit unsupported formats)", () => {
  it("omits images with an unsupported format instead of mislabeling them png", () => {
    const { images, omitted } = convertImagesToKiro([
      { mimeType: "image/svg+xml", data: "PHN2Zz48L3N2Zz4=" },
      { mimeType: "image/png", data: "iVBORw0KGgo=" },
    ]);
    expect(omitted).toBe(1);
    expect(images).toHaveLength(1);
    expect(images[0]!.format).toBe("png");
  });

  it("normalizes jpg → jpeg on the wire format", () => {
    const { images } = convertImagesToKiro([{ mimeType: "image/jpg", data: "abcd" }]);
    expect(images[0]!.format).toBe("jpeg");
  });
});

describe("collapseAgenticLoops", () => {
  it("clears repeated assistant prose without injecting model-visible marker text", () => {
    const history: KiroHistoryEntry[] = [
      {
        assistantResponseMessage: {
          content: "I will inspect the first file.",
          toolUses: [{ name: "read", toolUseId: "call-1", input: { path: "a.ts" } }],
        },
      },
      {
        userInputMessage: {
          content: "Tool results provided.",
          origin: "KIRO_CLI",
          userInputMessageContext: {
            toolResults: [{
              content: [{ text: "first" }],
              status: "success",
              toolUseId: "call-1",
            }],
          },
        },
      },
      {
        assistantResponseMessage: {
          content: "I will inspect the second file.",
          toolUses: [{ name: "read", toolUseId: "call-2", input: { path: "b.ts" } }],
        },
      },
      {
        userInputMessage: {
          content: "Tool results provided.",
          origin: "KIRO_CLI",
          userInputMessageContext: {
            toolResults: [{
              content: [{ text: "second" }],
              status: "success",
              toolUseId: "call-2",
            }],
          },
        },
      },
    ];

    const collapsed = collapseAgenticLoops(history);

    expect(collapsed[0]?.assistantResponseMessage?.content)
      .toBe("I will inspect the first file.");
    expect(collapsed[2]?.assistantResponseMessage).toMatchObject({
      content: "",
      toolUses: [{ name: "read", toolUseId: "call-2", input: { path: "b.ts" } }],
    });
    expect(JSON.stringify(collapsed)).not.toContain("[tool calling continues]");
  });
});
