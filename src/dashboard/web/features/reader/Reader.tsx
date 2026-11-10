import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ExternalLink } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Dialog,DialogContent,DialogTitle,DialogDescription } from "../../components/ui/dialog";
import { ErrorNotice,Loading } from "../../components/feedback";
import { useReader,useValue } from "./use-reader";
import type { FileArtifact } from "../../api/types";
export function ReadableValue({value,depth=0}:{value:unknown;depth?:number}) {
  const v=useValue(value,depth);
  if(v.empty)return <p className="muted">Not available</p>;
  if(v.deep)return <pre>{v.text}</pre>;
  if(v.array)return <ul className="readable-list">{v.entries.map(entry=><li key={entry.key}><ReadableValue value={entry.value} depth={depth+1}/></li>)}</ul>;
  if(v.object)return <dl className="readable-data">{v.entries.map(entry=><div key={entry.key}><dt>{entry.label}</dt><dd><ReadableValue value={entry.value} depth={depth+1}/></dd></div>)}</dl>;
  return <p>{v.text}</p>;
}
export function Reader() {
  const r=useReader();
  return <Dialog open={r.open} onOpenChange={r.onOpenChange}><DialogContent className="reader-panel w-[calc(100vw-32px)]" finalFocus={r.opener} showCloseButton={false}>
    <div className="reader-header"><div><DialogTitle id="preview-title">{r.title}</DialogTitle><DialogDescription>Collection artifact</DialogDescription></div><Button variant="secondary" id="preview-close" onClick={r.close}>Close preview</Button></div>
    <div id="file-preview" className="reader-body"><div id="preview-content">
      {r.kind==="image"&&<img src={r.original} alt={r.title}/>}
      {r.kind==="video"&&r.playable&&<video controls preload="metadata" src={r.original}/>}
      {r.kind==="video"&&!r.playable&&<p className="notice">This video variant has no verified preview. You can download the original file.</p>}
      {r.query.isFetching&&r.kind==="text"&&<Loading label="Opening file…"/>}<ErrorNotice error={r.query.error}/>
      {r.malformed&&<p className="notice">This file is not valid JSON. Its original text is shown below.</p>}
      {r.value!==null?<ReadableValue value={r.value}/>:r.kind==="text"&&<div className="prose"><Markdown remarkPlugins={[remarkGfm]} urlTransform={r.transformUrl}>{r.markdown}</Markdown></div>}
    </div><a className="download-link" href={r.original} target="_blank" rel="noopener noreferrer"><ExternalLink size={16}/>Open original file</a></div>
  </DialogContent></Dialog>;
}
