import { useState, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { act, read } from "../../api/client";

type CoveragePost = {shortcode:string; status?:string; analysisStatus?:string; reasons?:string[]; inCurrentScrape?:boolean; [key:string]:unknown};
type Coverage = {posts:CoveragePost[]; summary:Record<string,number>; updatedAt?:string};
type ExportState = {status:"running"|"complete"|"failed"; targetDir:string; result?:{indexPath:string;postCount:number;assetCount:number;topicCount:number}; error?:string};

export function useCoverageExport(handle:string) {
  const client=useQueryClient();
  const [targetDir,setTargetDir]=useState("");
  const [filter,setFilter]=useState("");
  const [limit,setLimit]=useState(50);
  const coverage=useQuery({queryKey:["coverage",handle],enabled:Boolean(handle),
    queryFn:({signal})=>read<{coverage:Coverage|null}>("/api/coverage?handle="+encodeURIComponent(handle),signal)});
  const refresh=useMutation({mutationFn:()=>act<{coverage:Coverage}>("/api/coverage/refresh",{handle}),
    onSuccess:value=>client.setQueryData(["coverage",handle],value)});
  const exported=useQuery({queryKey:["trinket-export",handle],enabled:Boolean(handle),
    queryFn:({signal})=>read<{export:ExportState|null}>("/api/trinket-export?handle="+encodeURIComponent(handle),signal),
    refetchInterval:query=>query.state.data?.export?.status==="running"?2000:false});
  const publish=useMutation({mutationFn:()=>act<{export:ExportState}>("/api/trinket-export",{handle,targetDir:targetDir.trim()||undefined}),
    onSuccess:value=>client.setQueryData(["trinket-export",handle],value)});
  const state=exported.data?.export;
  const all=coverage.data?.coverage?.posts??[];
  const matched=all.filter(post=>[post.shortcode,post.analysisStatus??post.status,...(post.reasons??[])].join(" ").toLowerCase().includes(filter.toLowerCase()));
  return {coverage,refresh,publish,exported,state,
    targetProps:{value:targetDir,onChange:(event:ChangeEvent<HTMLInputElement>)=>setTargetDir(event.target.value)},
    filterProps:{value:filter,onChange:(event:ChangeEvent<HTMLInputElement>)=>{setFilter(event.target.value);setLimit(50);}},
    update:()=>refresh.mutate(),exportNow:()=>publish.mutate(),busy:publish.isPending||state?.status==="running",
    rows:matched.slice(0,limit).map(post=>({id:post.shortcode,status:post.analysisStatus??post.status??"pending",reasons:(post.reasons??[]).map(reason=>reason.replaceAll("_"," ")).join(", ")||"—",current:post.inCurrentScrape!==false})),
    count:all.length,more:matched.length>limit,showMore:()=>setLimit(value=>value+100),
    summary:Object.entries(coverage.data?.coverage?.summary??{}).filter(([,value])=>typeof value==="number").map(([key,value])=>({key,value})),
  };
}
