import { afterEach, expect, test } from "bun:test";
import { act, read, ApiError } from "./client";
import { restoreSelection } from "../state/selection";
const originalFetch = globalThis.fetch;
afterEach(() => {globalThis.fetch=originalFetch;});
test("migrates legacy identities without inventing a selected collection or session", () => {
  const data: Record<string,string> = {"igdash-workflow":"ig:sample:123","igdash-action":"42","igdash-view":"progress"};
  expect(restoreSelection({getItem:key=>data[key]??null})).toMatchObject({workflowId:"ig:sample:123",actionPid:42,sessionPid:"",view:"progress"});
  expect(restoreSelection({getItem:()=>null}).workflowId).toBe("");
  expect(restoreSelection({getItem:()=>"{broken"}).workflowId).toBe("");
});
test("restores selection IDs independent of any list position", () => {
  const value = {section:"account",workflowId:"fork-uuid",actionPid:99,sessionPid:"42",view:"results",receiptPid:88,receiptFor:"fork-uuid"};
  expect(restoreSelection({getItem:()=>JSON.stringify(value)})).toEqual(value);
});
test("suppresses identical in-flight actions and releases the lock after failure", async () => {
  let finish!: (r:Response)=>void;
  globalThis.fetch = (()=>new Promise<Response>(resolve=>{finish=resolve;})) as typeof fetch;
  const first=act("/api/run",{handle:"fixture"});
  await expect(act("/api/run",{handle:"fixture"})).rejects.toThrow("already being submitted");
  finish(Response.json({ok:false,error:"Browser is busy"},{status:409}));
  await expect(first).rejects.toThrow("Browser is busy");
  globalThis.fetch=(async()=>Response.json({ok:true,pid:1})) as typeof fetch;
  expect(await act("/api/run",{handle:"fixture"})).toEqual({ok:true,pid:1});
});
test("passes cancellation through reads and preserves actionable HTTP errors", async () => {
  const controller=new AbortController();
  globalThis.fetch=(async (_path,init)=>{expect(init?.signal).toBe(controller.signal);return Response.json({error:"Collection not found"},{status:404});}) as typeof fetch;
  await expect(read("/api/workflow/missing",controller.signal)).rejects.toBeInstanceOf(ApiError);
});
