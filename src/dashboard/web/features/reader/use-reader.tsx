import { createContext, useContext, useRef, useState, type MouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { fileUrl, type FileArtifact } from "../../api/types";
export function useReaderState() {
  const [file,setFile]=useState<FileArtifact|null>(null);
  const [initialized,setInitialized]=useState(false);
  const opener=useRef<HTMLElement|null>(null);
  const openFile=(file:FileArtifact,event:MouseEvent<HTMLElement>)=>{opener.current=event.currentTarget;setInitialized(true);setFile(file);};
  return {file,initialized,opener,openFile,close:()=>setFile(null),onOpenChange:(open:boolean)=>{if(!open)setFile(null);}};
}
export const ReaderContext=createContext<ReturnType<typeof useReaderState>|null>(null);
export function useFileLink(file:FileArtifact) {
  const ctx=useContext(ReaderContext);
  return {onClick:(e:MouseEvent<HTMLElement>)=>ctx?.openFile(file,e),label:file.path.split("/").pop()};
}
export function resolveDocumentUrl(url:string,path:string) {
  if(url.startsWith("#"))return url;
  try {
    const resolved=new URL(url,"https://patronum.invalid/"+path);
    if(resolved.origin==="https://patronum.invalid"){
      if(resolved.pathname.startsWith("/api/file"))return resolved.pathname+resolved.search;
      return fileUrl(decodeURIComponent(resolved.pathname.slice(1)))+resolved.hash;
    }
    return ["http:","https:"].includes(resolved.protocol)?resolved.href:"";
  }catch{return "";}
}
export function useReader() {
  const ctx=useContext(ReaderContext)!;
  const file=ctx.file;
  const kind=file?.mediaKind??(file&&/\.(jpe?g|png|webp|gif)$/i.test(file.path)?"image":file&&/\.(mp4|mov)$/i.test(file.path)?"video":"text");
  const query=useQuery({
    queryKey:["reader",file?.path],
    enabled:Boolean(file)&&kind==="text",
    queryFn:async({signal})=>{const r=await fetch(fileUrl(file!.path),{signal});if(!r.ok)throw new Error("File unavailable ("+r.status+"). Close this reader and refresh results.");return r.text();},
    retry:false,
  });
  let value:unknown=null,malformed=false;
  if(file?.path.endsWith(".json")&&query.data){try{value=JSON.parse(query.data);}catch{malformed=true;}}
  return {...ctx,file,kind,query,value,malformed,
    open:Boolean(file),title:file?.path.split("/").pop()??"File preview",
    original:file?fileUrl(file.path):"",
    markdown:query.data?.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,"")??"",
    transformUrl:(url:string)=>resolveDocumentUrl(url,file?.path??""),
    playable:kind!=="video"||file?.playable===true,
  };
}
export function useValue(value:unknown,depth:number) {
  const array=Array.isArray(value),object=value!==null&&typeof value==="object";
  return {array,object,deep:depth>5,empty:value==null,text:typeof value==="string"?value:JSON.stringify(value,null,2),
    entries:object?Object.entries(value as object).slice(0,200).map(([key,value])=>({key,label:key.replace(/[_-]/g," ").replace(/([a-z])([A-Z])/g,"$1 $2"),value})):[],
  };
}
