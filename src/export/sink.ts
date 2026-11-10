export type KnowledgeDocument = {
  path: string;
  content: string;
  summary: string;
};

export interface KnowledgeSink {
  writeDocuments(documents: KnowledgeDocument[]): Promise<void>;
  audit(path: string): Promise<void>;
  close(): Promise<void>;
}
