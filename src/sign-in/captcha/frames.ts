import type { Stagehand } from "@browserbasehq/stagehand";

type Page = ReturnType<Stagehand["context"]["pages"]>[number];
type DomNode = { frameId?: string; children?: DomNode[]; contentDocument?: DomNode; shadowRoots?: DomNode[] };

/** Recover pre-existing OOPIFs omitted by Stagehand when attaching to an open tab. */
export async function refreshCheckpointFrames(page: Page, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const known = new Set(page.listAllFrameIds());
  const { targetInfos } = await page.sendCDP<{ targetInfos: Array<{ targetId: string; type: string }> }>("Target.getTargets");
  const targets = new Set(targetInfos.filter(target => target.type === "iframe").map(target => target.targetId));
  const visited = new Set<string | null>();
  async function visit(frameId: string): Promise<void> {
    if (Date.now() >= deadline) return;
    const session = page.getSessionForFrame(frameId);
    if (visited.has(session.id)) return;
    visited.add(session.id);
    const { root } = await session.send<{ root: DomNode }>("DOM.getDocument", { depth: -1, pierce: true });
    const children: Array<{ id: string; parent: string }> = [];
    function walk(node: DomNode, parent: string) {
      if (node.frameId && node.frameId !== parent) {
        children.push({ id: node.frameId, parent });
        if (node.contentDocument) walk(node.contentDocument, node.frameId);
      } else if (node.contentDocument) walk(node.contentDocument, parent);
      for (const child of [...node.children ?? [], ...node.shadowRoots ?? []]) walk(child, parent);
    }
    walk(root, frameId);
    for (const child of children) {
      if (Date.now() >= deadline) return;
      if (!known.has(child.id)) {
        // The parent relationship must exist before Target.attachedToTarget is
        // delivered, otherwise Stagehand leaves this session orphaned.
        page.onFrameAttached(child.id, child.parent, session);
        known.add(child.id);
        if (targets.has(child.id)) {
          await page.sendCDP("Target.attachToTarget", { targetId: child.id, flatten: true });
          while (page.getSessionForFrame(child.id) === session && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 20));
          }
        }
      }
      if (targets.has(child.id) && page.getSessionForFrame(child.id) !== session) await visit(child.id);
    }
  }
  await visit(page.mainFrameId());
}
