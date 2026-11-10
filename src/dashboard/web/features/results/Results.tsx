import { ArrowUpRight, ImageOff, BookOpen, Images } from "lucide-react";
import { Button } from "../../components/ui/button";
import { ErrorNotice,Empty,Loading } from "../../components/feedback";
import { FileLink } from "../reader/FileLink";
import { lazy,Suspense } from "react";
const Reader=lazy(()=>import("../reader/Reader").then(m=>({default:m.Reader})));
import { ReaderContext,useReaderState } from "../reader/use-reader";
import { usePost,useResults } from "./use-results";
import type { Post } from "../../api/types";
import { CoverageExport } from "./CoverageExport";
function PostCard({post,handle}:{post:Post;handle:string}) {
  const p=usePost(post);
  return <article className="surface feed-surface post-card" data-post={post.id}>
    <div className="post-header"><span className="post-avatar"><Images size={19}/></span><div><h3>@{handle}</h3><p className="muted post-code">{post.id}</p></div>{p.permalink&&<a href={p.permalink} target="_blank" rel="noopener noreferrer" aria-label="Open post on Instagram"><ArrowUpRight size={18}/></a>}</div>
    {p.caption&&<div><p className="post-caption" {...p.captionProps}>{p.caption}</p>{p.hasLongCaption&&<Button className="caption-toggle" variant="link" onClick={p.toggleCaption}>{p.expanded?"Show less":"Read caption"}</Button>}</div>}
    {p.preview&&!p.failed?<div className="post-media">{p.image&&<img src={p.preview.url} alt={post.title||"Collected post "+post.id} loading="lazy" decoding="async" onError={p.onMediaError}/>} {p.video&&<video controls preload="none" src={p.preview.url} onError={p.onMediaError}/>}</div>:<div className="media-unavailable"><ImageOff size={24}/><p>{p.failed?"Preview unavailable. Open a media file below.":"Media is not available yet."}</p></div>}
    <div className="post-actions">{p.media.slice(0,6).map(item=><FileLink key={item.file.path} file={item.file} label={item.label}/>)}{p.analysis.slice(0,2).map(file=><FileLink key={file.path} file={file} label="Read analysis"/>)}</div>
    {!p.analysis.length&&<p className="muted">Analysis is not available for this post yet.</p>}
  </article>;
}
export function Results() {
  const r=useResults(),reader=useReaderState();
  return <ReaderContext.Provider value={reader}><section id="results-panel" className="stack">
    <div className="section-heading"><div><h2>Collected content</h2><p className="muted">Latest files for @{r.handle}. Shared across its collection attempts.</p></div><Button id="results-refresh" variant="ghost" onClick={r.refresh} disabled={r.query.isFetching}>Refresh results</Button></div>
    <ErrorNotice error={r.query.error}/>{r.query.isPending&&<Loading label="Loading collected content…"/>}
    {r.handle&&<CoverageExport key={r.handle} handle={r.handle}/>}
    {r.query.data&&<div id="results-content" className="stack"><div className="result-summary"><span>{r.count} posts</span><span>{r.mediaCount} media files</span><span>{r.analysisCount} analysis files</span><span>{r.knowledge.length} wiki files</span></div>
      {r.truncated&&<p className="notice">Showing the first 2,000 files. Counts reflect this inventory.</p>}
      {!r.count&&<Empty title={r.active?"Your collection is taking shape":"No results yet"}>Media, analysis, and wiki documents appear as each stage completes.</Empty>}
      <div className="post-grid stack">{r.posts.map(post=><PostCard key={post.id} post={post} handle={r.handle}/>)}</div>{r.more&&<Button id="results-more" variant="secondary" onClick={r.showMore}>Show more posts</Button>}
      <div className="section-heading"><h2>Knowledge wiki</h2><BookOpen size={20} className="muted"/></div>
      <ul className="file-list">{r.knowledge.map(file=><li key={file.path}><FileLink file={file}/></li>)}</ul>{!r.knowledge.length&&<p className="notice">{r.skippedWiki?"Wiki publishing was skipped for this attempt.":"Wiki documents will appear after publishing completes."}</p>}
      <details className="disclosure"><summary>Analysis & all files ({r.files.length})</summary><ul className="file-list">{r.visibleFiles.map(file=><li key={file.path}><FileLink file={file}/></li>)}</ul>{r.moreFiles&&<Button variant="secondary" onClick={r.showMoreFiles}>Show more files</Button>}</details>
    </div>}
  </section>{reader.initialized&&<Suspense fallback={<Loading label="Opening reader…"/>}><Reader/></Suspense>}</ReaderContext.Provider>;
}
