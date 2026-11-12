import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { read } from "../../api/client";
import { useDashboard } from "../../state/app";
import { isRunning, type Results, type Post } from "../../api/types";
export function useResults() {
  const app=useDashboard();
  const handle=app.detail.data?.workflow.handle??"";
  const version=app.detail.data?.workflow.status+":"+app.detail.data?.currentStage;
  const query=useQuery<Results,Error>({
    queryKey:["results",handle,version],queryFn:({signal})=>read<Results>("/api/results?handle="+encodeURIComponent(handle),signal),
    enabled:Boolean(handle),refetchInterval:isRunning(app.workflow?.status)?6000:false,
    placeholderData:(previous,query)=>query?.queryKey[1]===handle?previous:undefined,
  });
  const [limit,setLimit]=useState(8);
  const [fileLimit,setFileLimit]=useState(100);
  const data=query.data;
  return {query,handle,posts:(data?.posts??[]).slice(0,limit),count:data?.posts.length??0,files:data?.files??[],
    mediaCount:data?.files.filter(f=>f.type==="media").length??0,analysisCount:data?.files.filter(f=>f.type==="analysis").length??0,
    knowledge:data?.files.filter(f=>f.type==="knowledge")??[],truncated:data?.truncated,
    more:(data?.posts.length??0)>limit,showMore:()=>setLimit(n=>n+12),refresh:()=>query.refetch(),
    visibleFiles:(data?.files??[]).slice(0,fileLimit),moreFiles:(data?.files.length??0)>fileLimit,showMoreFiles:()=>setFileLimit(n=>n+100),
    active:isRunning(app.workflow?.status),
  };
}
const shown=(name:string,total:number)=>total>6?name+" · first 6 of "+total:name+" · "+total;
export function usePost(post:Post) {
  const [expanded,setExpanded]=useState(false),[failed,setFailed]=useState(false);
  const preview=post.preview??post.media.find(f=>f.mediaKind==="image")??null;
  const media=post.media.filter(f=>f.previewable!==false);
  return {preview,failed,onMediaError:()=>setFailed(true),
    image:preview?.mediaKind==="image",video:preview?.mediaKind==="video"&&preview.playable===true,
    caption:post.caption,captionProps:{"data-expanded":expanded},toggleCaption:()=>setExpanded(v=>!v),expanded,
    hasLongCaption:(post.caption?.length??0)>280,
    // Six of each keeps a card compact; everything else is under All files.
    media:media.slice(0,6).map((file,i)=>({file,label:String(i+1),title:"Open media file "+(i+1)})),mediaLabel:shown("Media",media.length),
    analysis:post.analysis.slice(0,6).map((file,i)=>({file,label:String(i+1),title:"Read analysis "+(i+1)})),analysisLabel:shown("Analysis",post.analysis.length),
    permalink:post.url&&/^https:\/\/(?:www\.)?instagram\.com\//.test(post.url)?post.url:null,
  };
}
