import { expect,test,afterEach } from "bun:test";
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join,resolve } from "node:path";
import { collectResults } from "./results";
import sharp from "sharp";
const roots:string[]=[];
test("verified unique manifest preserves shared post references and excludes old raw downloads",async()=>{
  const root=mkdtempSync(join(tmpdir(),"patronum-results-owned-"));roots.push(root);
  const put=(path:string,value:string)=>{const abs=join(root,path);mkdirSync(resolve(abs,".."),{recursive:true});writeFileSync(abs,value);};
  put("data/profiles/fixture-profile.json",JSON.stringify({posts:[{shortcode:"POST1",mediaOwnershipVersion:1},{shortcode:"POST2",mediaOwnershipVersion:1}]}));
  put("data/fixture-unique/shared.png","image");
  put("data/fixture-unique/manifest.json",JSON.stringify({files:[{shortcode:"POST1",dest:"data/fixture-unique/shared.png"},{shortcode:"POST2",dest:"data/fixture-unique/shared.png"}]}));
  put("data/media/fixture/POST1/recommendation.png","wrong");
  put("data/media/fixture/OLD/recommendation.png","wrong");
  const r=await collectResults(root,"fixture",p=>resolve(root,p));
  expect(r.posts.map(p=>p.id)).toEqual(["POST1","POST2"]);
  expect(r.posts.every(p=>p.media.length===1&&p.preview?.path==="data/fixture-unique/shared.png")).toBe(true);
  expect(r.files.some(f=>f.path.endsWith("recommendation.png"))).toBe(false);
  expect(r.files.filter(f=>f.type==="analysis")).toHaveLength(0);
});
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
test("includes reels and posts with missing media without duplicating cross-tab posts",async()=>{
  const root=mkdtempSync(join(tmpdir(),"patronum-results-reels-"));roots.push(root);
  mkdirSync(join(root,"data/profiles"),{recursive:true});
  writeFileSync(join(root,"data/profiles/fixture-profile.json"),JSON.stringify({
    posts:[{shortcode:"POST1",caption:"A still"},{shortcode:"BOTH",caption:"A shared post"}],
    reels:[{shortcode:"BOTH",permalink:"https://www.instagram.com/reel/BOTH/"},{shortcode:"REEL1",caption:"A reel"}],
  }));
  const result=await collectResults(root,"fixture",p=>resolve(root,p));
  expect(result.posts.map(p=>p.id)).toEqual(["POST1","BOTH","REEL1"]);
  expect(result.posts[1]?.caption).toBe("A shared post");
  expect(result.posts[2]?.caption).toBe("A reel");
  expect(result.posts.every(p=>p.media.length===0&&p.preview===null)).toBe(true);
});
test("groups thirteen posts without metadata rows and preserves trailing underscore shortcodes",async()=>{
  const root=mkdtempSync(join(tmpdir(),"patronum-results-"));roots.push(root);
  const put=(path:string,value:string)=>{const abs=join(root,path);mkdirSync(resolve(abs,".."),{recursive:true});writeFileSync(abs,value);};
  for(let i=0;i<13;i++){const id=i===0?"DIMO0SkIKK_":"POST"+i;put("data/media/fixture/"+id+"/image.jpg","image");put("data/analysis/fixture/items/"+id+"__still.json",JSON.stringify({shortcode:id}));}
  put("data/media/fixture/manifest.json","{}");put("data/media/fixture/profile/avatar.jpg","image");
  put("data/analysis/fixture/items/manifest.json","{}");put("data/analysis/fixture/items/profile.json","{}");
  put("data/media/fixture/DIMO0SkIKK_/fragment.mp4","broken dash");
  const guard=(p:string)=>{const abs=resolve(root,p);return abs.startsWith(root+"/")?abs:null;};
  const r=await collectResults(root,"fixture",guard);
  expect(r.posts).toHaveLength(13);
  expect(r.posts.find(p=>p.id==="DIMO0SkIKK_")?.analysis).toHaveLength(1);
  expect(r.posts.some(p=>p.id==="manifest"||p.id==="profile")).toBe(false);
  expect(r.posts.find(p=>p.id==="DIMO0SkIKK_")?.preview?.mediaKind).toBe("image");
  expect(r.files.find(f=>f.path.endsWith("fragment.mp4"))?.previewable).toBe(false);
});
test("caps file inventory at exactly 2000 and signals truncation",async()=>{
  const root=mkdtempSync(join(tmpdir(),"patronum-results-large-"));roots.push(root);
  const path=join(root,"data/media/fixture/POST1");mkdirSync(path,{recursive:true});
  for(let i=0;i<2005;i++)writeFileSync(join(path,i+".jpg"),"x");
  const r=await collectResults(root,"fixture",p=>resolve(root,p));
  expect(r.files).toHaveLength(2000);expect(r.truncated).toBe(true);
});
test("uses the largest suitable image instead of an enlarged thumbnail",async()=>{
  const root=mkdtempSync(join(tmpdir(),"patronum-results-size-"));roots.push(root);
  const dir=join(root,"data/media/fixture/POST1");mkdirSync(dir,{recursive:true});
  await sharp({create:{width:150,height:150,channels:3,background:"#334455"}}).png().toFile(join(dir,"00-thumb.png"));
  await sharp({create:{width:1200,height:1600,channels:3,background:"#334455"}}).png().toFile(join(dir,"01-master.png"));
  const result=await collectResults(root,"fixture",p=>resolve(root,p));
  expect(result.posts[0]?.preview?.path).toEndWith("01-master.png");
  expect(result.posts[0]?.preview?.width).toBe(1200);
});
test("ranks variants of the post's recorded cover before unrelated larger page images",async()=>{
  const root=mkdtempSync(join(tmpdir(),"patronum-results-cover-"));roots.push(root);
  const dir=join(root,"data/media/fixture/POST1");mkdirSync(dir,{recursive:true});mkdirSync(join(root,"data/profiles"),{recursive:true});
  await sharp({create:{width:2000,height:2000,channels:3,background:"#334455"}}).png().toFile(join(dir,"00-unrelated.png"));
  await sharp({create:{width:1080,height:1350,channels:3,background:"#aa5577"}}).png().toFile(join(dir,"01-cover.png"));
  writeFileSync(join(root,"data/profiles/fixture-profile.json"),JSON.stringify({posts:[{shortcode:"POST1",thumbnailUrl:"https://cdn.example/post-cover.jpg?size=small"}]}));
  writeFileSync(join(root,"data/media/fixture/manifest.json"),JSON.stringify({results:[
    {localPath:"data/media/fixture/POST1/00-unrelated.png",url:"https://cdn.example/another-post.jpg"},
    {localPath:"data/media/fixture/POST1/01-cover.png",url:"https://cdn.example/post-cover.jpg?size=large"},
  ]}));
  const result=await collectResults(root,"fixture",p=>resolve(root,p));
  expect(result.posts[0]?.preview?.path).toEndWith("01-cover.png");
  expect(result.posts[0]?.media[0]?.path).toBe(result.posts[0]?.preview?.path);
});
