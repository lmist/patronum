import { describe, expect, it } from "bun:test";
import { assertDocumentBatch } from "./open-knowledge.js";
import type { KnowledgeDocument } from "./sink.js";

const docs: KnowledgeDocument[] = [
  { path: "knowledge/clients/acme/INDEX", content: "# Index\n", summary: "Refresh index" },
];

describe("OpenKnowledge MCP batch validation", () => {
  it("requires a complete structured result", () => {
    expect(() => assertDocumentBatch({}, docs)).toThrow("incomplete document batch");
  });

  it("rejects content-integrity warnings", () => {
    const response = {
      structuredContent: {
        documents: [{
          ok: true,
          docName: docs[0].path,
          warnings: [{ kind: "content-divergence", message: "written body differs" }],
        }],
      },
    };
    expect(() => assertDocumentBatch(response, docs)).toThrow("integrity warning");
  });

  it("accepts the exact successful batch", () => {
    const response = {
      structuredContent: { documents: [{ ok: true, docName: docs[0].path, warnings: [] }] },
    };
    expect(() => assertDocumentBatch(response, docs)).not.toThrow();
  });
});
