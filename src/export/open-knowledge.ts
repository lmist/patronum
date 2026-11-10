import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeDocument, KnowledgeSink } from "./sink.js";

function responseText(response: any): string {
  const text = (response?.content ?? [])
    .filter((part: any) => part?.type === "text")
    .map((part: any) => String(part.text ?? ""))
    .join("\n")
    .trim();
  return text || "OpenKnowledge MCP call failed";
}

export function assertDocumentBatch(response: any, documents: KnowledgeDocument[]): void {
  const results = response?.structuredContent?.documents;
  if (!Array.isArray(results) || results.length !== documents.length) {
    throw new Error("OpenKnowledge returned an incomplete document batch result");
  }
  const expected = new Set(documents.map((document) => document.path));
  for (const result of results) {
    if (result?.ok !== true || !expected.delete(String(result?.docName ?? ""))) {
      throw new Error(`OpenKnowledge document write failed: ${JSON.stringify(result)}`);
    }
    const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
    const integrity = warnings.find((warning: any) =>
      /diverg|loss|integrity|write-failed/i.test(
        `${warning?.kind ?? ""} ${warning?.code ?? ""} ${warning?.message ?? ""}`,
      ),
    );
    if (integrity) {
      throw new Error(`OpenKnowledge document integrity warning: ${JSON.stringify(integrity)}`);
    }
  }
  if (expected.size > 0) {
    throw new Error(`OpenKnowledge omitted document results: ${[...expected].join(", ")}`);
  }
}

export class OpenKnowledgeMcpSink implements KnowledgeSink {
  private client: Client;
  private command: string;
  private connected = false;

  constructor(private root: string, command?: string) {
    const local = join(root, "node_modules", ".bin", "ok");
    this.command = command ?? process.env.OK_CLI ?? (existsSync(local) ? local : "ok");
    this.client = new Client({ name: "patronum-okf-export", version: "0.1.0" });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    const transport = new StdioClientTransport({
      command: this.command,
      cwd: this.root,
      args: ["mcp", "--no-bundle-proxy"],
      env: { ...process.env, OK_BUNDLE_PROXY: "0" },
      stderr: "inherit",
    });
    await this.client.connect(transport);
    this.connected = true;
  }

  private async call(name: string, args: Record<string, unknown>): Promise<any> {
    await this.connect();
    const response = await this.client.callTool({
      name,
      arguments: { ...args, cwd: this.root },
    });
    if ((response as any).isError) throw new Error(responseText(response));
    return response;
  }

  async writeDocuments(documents: KnowledgeDocument[]): Promise<void> {
    for (let offset=0;offset<documents.length;offset+=25) {
      const batch=documents.slice(offset,offset+25);
      const response = await this.call("write", {
      documents: batch.map((document) => ({
        path: document.path,
        content: document.content,
        position: "replace",
        summary: document.summary,
      })),
      summary: "Refresh client style knowledge base",
    });
      assertDocumentBatch(response, batch);
    }
  }

  async prepareFolders(paths: string[]): Promise<void> {
    const all=new Set<string>();
    for(const path of paths){
      const parts=path.split("/");
      if(parts.some(part=>!part||part===".."||part==="."||!/^[A-Za-z0-9_.-]+$/.test(part))) throw new Error("Invalid wiki folder path");
      for(let n=1;n<=parts.length;n++)all.add(parts.slice(0,n).join("/"));
    }
    const folders=[...all].sort((a,b)=>a.split("/").length-b.split("/").length||a.localeCompare(b));
    for(const path of folders)if(!existsSync(join(this.root,path)))await this.call("write",{folder:{path},summary:"Add collection folder"});
    for(let offset=0;offset<folders.length;offset+=20)await this.call("exec",{command:"ls -A "+folders.slice(offset,offset+20).join(" ")});
  }

  async audit(path: string): Promise<void> {
    const response=await this.call("audit", { path });
    const audit=response.structuredContent;
    if(!audit?.ran?.includes("links"))throw new Error("OpenKnowledge did not validate collection links");
    const broken=audit.files?.some((file:any)=>(file.diagnostics??file.violations??[]).some((item:any)=>item.source==="links"));
    if(audit.errorCount>0||broken)throw new Error("OpenKnowledge collection validation failed: "+responseText(response));
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    await this.client.close();
    this.connected = false;
  }
}
