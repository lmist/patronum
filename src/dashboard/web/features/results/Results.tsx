import { ArrowUpRight, ImageOff, Images } from "lucide-react";
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
  return <article className="surface post-card" data-post={post.id}>
    <div className="post-header"><span className="post-avatar"><Images size={18}/></span><div><h3>@{handle}</h3><p className="muted post-code">{post.id}</p></div>{p.permalink&&<a href={p.permalink} target="_blank" rel="noopener noreferrer" aria-label="Open post on Instagram"><ArrowUpRight size={18}/></a>}</div>
    {p.preview&&!p.failed?<div className="post-media">{p.image&&<img src={p.preview.url} alt={post.title||"Collected post "+post.id} loading="lazy" decoding="async" onError={p.onMediaError}/>} {p.video&&<video controls preload="none" src={p.preview.url} onError={p.onMediaError}/>}</div>:<div className="media-unavailable"><ImageOff size={20}/><p>{p.failed?"Preview unavailable. Open a media file below.":"No media downloaded for this post yet."}</p></div>}
    {p.caption&&<div><p className="post-caption" {...p.captionProps}>{p.caption}</p>{p.hasLongCaption&&<Button className="caption-toggle" variant="link" onClick={p.toggleCaption}>{p.expanded?"Show less":"Read caption"}</Button>}</div>}
    <div className="post-actions">
      {p.media.length>0&&<div className="post-files"><span className="post-files-label">{p.mediaLabel}</span>{p.media.map(item=><FileLink key={item.file.path} file={item.file} label={item.label} title={item.title}/>)}</div>}
      {p.analysis.length>0
        ?<div className="post-files"><span className="post-files-label">{p.analysisLabel}</span>{p.analysis.map(item=><FileLink key={item.file.path} file={item.file} label={item.label} title={item.title}/>)}</div>
        :<p className="muted post-note">No analysis for this post yet.</p>}
    </div>
  </article>;
}
export function Results() {
  const r=useResults(),reader=useReaderState();
  return <ReaderContext.Provider value={reader}><section id="results-panel" className="stack">
    <div className="section-heading"><div><h2>Collected posts</h2><p className="muted">Everything collected for @{r.handle} so far, across all of its jobs.</p></div><Button id="results-refresh" variant="ghost" onClick={r.refresh} disabled={r.query.isFetching}>Refresh results</Button></div>
    <ErrorNotice error={r.query.error}/>{r.query.isPending&&<Loading label="Loading collected posts…"/>}
    {r.query.data&&<div id="results-content" className="stack"><div className="result-summary"><span>{r.count} posts</span><span>{r.mediaCount} media files</span><span>{r.analysisCount} analysis files</span>{r.knowledge.length>0&&<span>{r.knowledge.length} wiki files</span>}</div>
      {r.truncated&&<p className="notice">This profile has more files than the dashboard lists. Showing the first 2,000 files; the counts above cover only those.</p>}
      {!r.count&&<Empty title={r.active?"Your collection is taking shape":"No results yet"}>Posts appear here as the collection finds them; media and analysis follow as each stage completes.</Empty>}
      <div className="post-grid">{r.posts.map(post=><PostCard key={post.id} post={post} handle={r.handle}/>)}</div>{r.more&&<Button id="results-more" variant="secondary" onClick={r.showMore}>Show more posts</Button>}
      {/* Only an old job that published a wiki has these; the stage is retired. */}
      {r.knowledge.length>0&&<><div className="section-heading results-secondary"><div><h2>Knowledge wiki</h2><p className="muted">Published by an earlier version of Patronum.</p></div></div>
      <ul className="file-list">{r.knowledge.map(file=><li key={file.path}><FileLink file={file}/></li>)}</ul></>}
      <details className="disclosure results-disclosure"><summary>All files <span>{r.files.length}</span></summary><ul className="file-list">{r.visibleFiles.map(file=><li key={file.path}><FileLink file={file}/></li>)}</ul>{r.moreFiles&&<Button variant="secondary" onClick={r.showMoreFiles}>Show more files</Button>}</details>
    </div>}
    {r.handle&&<CoverageExport key={r.handle} handle={r.handle}/>}
  </section>{reader.initialized&&<Suspense fallback={<Loading label="Opening reader…"/>}><Reader/></Suspense>}</ReaderContext.Provider>;
}
