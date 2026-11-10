import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import sharp from "sharp";
import { layout } from "../paths";

interface Artifact {path:string;url:string;type:"media"|"analysis"|"knowledge";id:string|null;mediaKind?:"image"|"video";playable?:boolean;previewable?:boolean;width?:number;height?:number}
type Metadata = {shortcode?:string;caption?:string;permalink?:string;url?:string;title?:string;[key:string]:unknown};
function sourceKey(value:unknown) {try {return typeof value==="string"?new URL(value).pathname:"";}catch{return "";}}
const validId=(value:unknown):value is string=>typeof value==="string"&&/^[A-Za-z0-9_-]+$/.test(value)&&!["profile","manifest"].includes(value);
const videoCache=new Map<string,{stamp:string;value:Promise<boolean>}>();
const imageCache=new Map<string,{stamp:string;value:Promise<{width:number;height:number}>}>();
async function imageSize(path:string) {
  const info=await stat(path).catch(()=>null);if(!info)return {width:0,height:0};
  const stamp=info.size+":"+info.mtimeMs,cached=imageCache.get(path);
  if(cached?.stamp===stamp)return cached.value;
  const value=sharp(path).metadata().then(m=>({width:m.width??0,height:m.height??0})).catch(()=>({width:0,height:0}));
  if(imageCache.size>=2000)imageCache.delete(imageCache.keys().next().value!);
  imageCache.set(path,{stamp,value});return value;
}
async function playable(path:string) {
  const info=await stat(path).catch(()=>null);if(!info)return false;
  const stamp=info.size+":"+info.mtimeMs;
  const cached=videoCache.get(path);if(cached?.stamp===stamp)return cached.value;
  const value=(async()=>{
    try {
      const child=Bun.spawn(["ffprobe","-v","error","-select_streams","v:0","-count_packets","-show_entries","stream=nb_read_packets,codec_name,width,height","-of","json",path],{stdout:"pipe",stderr:"ignore"});
      const timeout=setTimeout(()=>child.kill(),4000);
      try {
        const data=await new Response(child.stdout).json();
        return await child.exited===0&&data.streams?.some((s:{nb_read_packets?:string;width?:number;height?:number})=>Number(s.nb_read_packets)>0&&Number(s.width)>0&&Number(s.height)>0)===true;
      } finally {clearTimeout(timeout);}
    } catch {return false;}
  })();
  if(videoCache.size>=256)videoCache.delete(videoCache.keys().next().value!);
  videoCache.set(path,{stamp,value});return value;
}
async function jsonFile(path:string|null):Promise<any>{
  if(!path)return null;
  const info=await stat(path).catch(()=>null);
  if(!info||info.size>12*1024*1024)return null;
  return JSON.parse(await readFile(path,"utf8").catch(()=>"null"));
}
export async function collectResults(root:string,handle:string,guard:(path:string)=>string|null) {
  const files:Artifact[]=[];
  const metadata=new Map<string,Metadata>();
  const associations=new Map<string,Set<string>>();
  const coverById=new Map<string,string>();
  const sourceByPath=new Map<string,string>();
  const profile=await jsonFile(guard(layout.profileJson(handle))).catch(()=>null);
  for(const post of [...(profile?.posts??[]),...(profile?.reels??[])])if(validId(post.shortcode)){metadata.set(post.shortcode,{...metadata.get(post.shortcode),...post});const key=sourceKey(post.thumbnailUrl);if(key)coverById.set(post.shortcode,key);}
  const downloads=await jsonFile(guard(layout.mediaManifest(handle))).catch(()=>null);
  for(const entry of downloads?.results??[])if(typeof entry.localPath==="string"){
    const path=entry.localPath.startsWith(root+"/")?relative(root,entry.localPath):entry.localPath;
    if(guard(path))sourceByPath.set(path,sourceKey(entry.url));
  }
  const manifest=await jsonFile(guard(layout.uniqueManifest(handle))).catch(()=>null);
  for(const entry of manifest?.files??[]){
    if(!validId(entry.shortcode))continue;
    for(const key of ["src","dest"])if(typeof entry[key]==="string"){
      const path=entry[key].startsWith(root+"/")?relative(root,entry[key]):entry[key];
      if(guard(path)){const ids=associations.get(path)??new Set<string>();ids.add(entry.shortcode);associations.set(path,ids);}
    }
    if(typeof entry.src==="string"&&typeof entry.dest==="string"){
      const src=entry.src.startsWith(root+"/")?relative(root,entry.src):entry.src;
      const dest=entry.dest.startsWith(root+"/")?relative(root,entry.dest):entry.dest;
      const source=sourceByPath.get(src);if(source)sourceByPath.set(dest,source);
    }
  }
  const publishedIds=new Set((manifest?.files??[]).map((entry:{shortcode?:string})=>entry.shortcode));
  const owned=metadata.size>0&&[...metadata].every(([id,post])=>post.mediaOwnershipVersion===1&&publishedIds.has(id));
  const roots=[layout.uniqueDir(handle),...(!owned?[layout.mediaDir(handle)]:[]),layout.analysisDir(handle),"data/knowledge/"+handle,layout.knowledgeDir(handle)];
  let truncated=false;
  async function walk(path:string,depth=0):Promise<void>{
    if(depth>5)return;
    const abs=guard(path);if(!abs)return;
    const entries=(await readdir(abs,{withFileTypes:true}).catch(()=>[])).sort((a,b)=>a.name.localeCompare(b.name));
    for(const entry of entries){
      if(entry.name==="manifest.json")continue;
      if(files.length>=2000){truncated=true;return;}
      const next=path+"/"+entry.name;
      if(entry.isDirectory()){await walk(next,depth+1);continue;}
      if(!entry.isFile()||!guard(next)||!/\.(json|md|txt|jpe?g|png|webp|gif|mp4|mov)$/i.test(entry.name))continue;
      const image=/\.(jpe?g|png|webp|gif)$/i.test(entry.name),video=/\.(mp4|mov)$/i.test(entry.name);
      const type=image||video?"media":path.startsWith("knowledge/")?"knowledge":"analysis";
      const associatedIds=associations.get(next);
      let id=associatedIds?.values().next().value??null;
      const mediaPrefix=layout.mediaDir(handle)+"/";
      if(!id&&next.startsWith(mediaPrefix)){
        const segments=next.slice(mediaPrefix.length).split("/");
        if(segments.length>1&&validId(segments[0]))id=segments[0];
      }
      if(!id&&next.includes("/items/")&&entry.name.endsWith(".json")){
        const item:Metadata|null=await jsonFile(guard(next)).catch(()=>null);
        const candidate=entry.name.slice(0,-5).replace(/__(still|video)$/,"");
        if(validId(item?.shortcode))id=item.shortcode;
        else if(validId(candidate))id=candidate;
        if(id&&item)metadata.set(id,{...metadata.get(id),...item});
      }
      const kbPrefix="knowledge/clients/"+handle+"/media/";
      if(!id&&next.startsWith(kbPrefix)){const candidate=next.slice(kbPrefix.length).split("/")[0];if(validId(candidate))id=candidate;}
      files.push({path:next,url:"/api/file?path="+encodeURIComponent(next),type,id,...(image||video?{mediaKind:image?"image" as const:"video" as const,previewable:image,playable:image}: {})});
      if(associatedIds&&associatedIds.size>1){const file=files[files.length-1]!;for(const other of associatedIds)if(other!==id){if(files.length>=2000){truncated=true;break;}files.push({...file,id:other});}}
    }
  }
  for(const path of roots)await walk(path);
  const order=new Map([...metadata.keys()].map((id,index)=>[id,index]));
  const ids=[...new Set([...metadata.keys(),...files.map(f=>f.id).filter((id):id is string=>id!==null)])].sort((a,b)=>(order.get(a)??Infinity)-(order.get(b)??Infinity)||a.localeCompare(b));
  const grouped=new Map(ids.map(id=>[id,{id,media:[] as Artifact[],analysis:[] as Artifact[],knowledge:[] as Artifact[]}]));
  for(const file of files)if(file.id)grouped.get(file.id)?.[file.type].push(file);
  const posts=[];
  for(const id of ids){
    const post=grouped.get(id)!;
    const meta=metadata.get(id);
    const canonical=coverById.get(id);
    const allImages=post.media.filter(f=>f.mediaKind==="image");
    const associated=canonical?allImages.filter(f=>sourceByPath.get(f.path)===canonical):[];
    const images=(associated.length?associated:allImages.filter(f=>!/-19\//.test(sourceByPath.get(f.path)??""))).slice(0,64);
    for(let offset=0;offset<images.length;offset+=8)await Promise.all(images.slice(offset,offset+8).map(async file=>{
      const path=guard(file.path);if(path)Object.assign(file,await imageSize(path));
    }));
    let preview=images.reduce<Artifact|null>((best,file)=>(file.width??0)*(file.height??0)>(best?.width??0)*(best?.height??0)?file:best,null)??images[0]??null;
    // A verified unique master may lead the preview. Other video variants stay downloadable.
    const uniqueVideo=post.media.find(f=>f.mediaKind==="video"&&f.path.startsWith(layout.uniqueDir(handle)+"/"));
    const candidates=uniqueVideo?[uniqueVideo]:preview?[]:post.media.filter(f=>f.mediaKind==="video").slice(0,3);
    for(const candidate of candidates){
      const abs=guard(candidate.path);
      candidate.playable=abs?await playable(abs):false;
      candidate.previewable=candidate.playable;
      if(candidate.playable){preview=candidate;break;}
    }
    if(preview)post.media.sort((a,b)=>a===preview?-1:b===preview?1:0);
    posts.push({...post,caption:typeof meta?.caption==="string"?meta.caption:undefined,title:typeof meta?.title==="string"?meta.title:undefined,url:typeof meta?.permalink==="string"?meta.permalink:typeof meta?.url==="string"?meta.url:undefined,preview});
  }
  return {ok:true,handle,posts,files,truncated,scope:"latest-handle-artifacts"};
}
