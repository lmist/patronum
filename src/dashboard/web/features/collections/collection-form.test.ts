import { describe, expect, it } from "bun:test";
import { collectionDefaults, collectionRequest } from "./collection-form";

describe("collection request", () => {
  it("downloads all media with explicit conservative defaults and no AI work", () => {
    const {body,errors}=collectionRequest({...collectionDefaults,handle:" @remy.engineering "});
    expect(errors).toEqual({});
    expect(body).toMatchObject({handle:"remy.engineering",max:30,"skip-reels":false,"skip-analyze":true,"skip-llm-preflight":true,"detail-workers":2,"dl-workers":4,"analyze-workers":2,timeout:"30m"});
    for(const flag of ["fresh","skip-download","skip-unique","no-detail","scroll-rounds"])expect(body).not.toHaveProperty(flag);
  });
  it("enables provider checks only when AI analysis is requested", () => {
    expect(collectionRequest({...collectionDefaults,handle:"fixture",goal:"analyze"}).body).toMatchObject({"skip-analyze":false,"skip-llm-preflight":false});
    expect(collectionRequest({...collectionDefaults,handle:"fixture",goal:"analyze",skipLlmCheck:true}).body).toMatchObject({"skip-analyze":false,"skip-llm-preflight":true});
  });
  it("ignores hidden analysis options after switching back to download", () => {
    expect(collectionRequest({...collectionDefaults,handle:"fixture",allFrames:true,analysisWorkers:"invalid"}).body).toMatchObject({"all-frames":false,"analyze-workers":2,"skip-analyze":true});
  });
  it("retries saved lists without clearing completed work", () => {
    const {body}=collectionRequest({...collectionDefaults,handle:"fixture",source:"saved",media:"images"});
    expect(body).toMatchObject({"reuse-grid":true,"skip-reels":true});
    expect(body).not.toHaveProperty("fresh");
  });
  it("rejects empty, fractional and excessive limits without launching", () => {
    const {body,errors}=collectionRequest({...collectionDefaults,handle:"bad/handle",max:"",browserWorkers:"32",downloadWorkers:"1.5",timeoutMinutes:"0",goal:"analyze",analysisWorkers:"0"});
    expect(body).toBeUndefined();
    expect(Object.keys(errors).sort()).toEqual(["analysisWorkers","browserWorkers","downloadWorkers","handle","max","timeoutMinutes"]);
  });
});
