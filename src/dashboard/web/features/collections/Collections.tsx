import { ArrowUpRight, Search, Layers3, X } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { ErrorNotice, Empty, Loading, Status } from "../../components/feedback";
import { useComposer,useCollections } from "./use-collections";

function FieldError({name, message}: {name: string; message?: string}) {
  return message ? <span id={`collection-${name}-error`} className="field-error" role="alert">{message}</span> : null;
}

export function Composer() {
  const c=useComposer();
  return <section aria-labelledby="composer-title" className="composer-section">
    <div className="composer-heading">
      <div><h2 id="composer-title">New collection</h2><p className="muted">Collect an Instagram profile’s posts and download their media. Optionally have the vision model describe each image and video.</p></div>
      {c.canClose&&<Button type="button" variant="ghost" size="icon" aria-label="Close the new collection form" onClick={c.close}><X size={18}/></Button>}
    </div>
    <form id="run-form" ref={c.form} className="composer stack" onSubmit={c.submit} noValidate>
      <div className="composer-fields">
        <label className="field" htmlFor="run-handle">Instagram handle
          <Input {...c.fields.handle} id="run-handle" placeholder="e.g. remy.engineering" autoComplete="off" spellCheck={false} required/>
          <FieldError name="handle" message={c.errors.handle}/>
        </label>
        <label className="field" htmlFor="run-max-posts">Post limit
          <Input {...c.fields.max} id="run-max-posts" type="number" min="1" step="1" required/>
          <FieldError name="max" message={c.errors.max}/>
        </label>
      </div>
      <div className="form-grid collection-choices">
        <label className="field" htmlFor="collection-media">Media to collect
          <select {...c.fields.media}><option value="all">Images, carousels & reels</option><option value="images">Images & carousels only</option></select>
          <FieldError name="media" message={c.errors.media}/>
        </label>
        <label className="field" htmlFor="collection-goal">What to do with it
          <select {...c.fields.goal}><option value="download">Download media</option><option value="analyze">Download & analyze with AI</option></select>
          <FieldError name="goal" message={c.errors.goal}/>
        </label>
      </div>
      <p className="collection-help" role="status">{c.goalHelp}</p>
      {c.analyzing&&<label className="check"><input {...c.checks.allFrames} data-flag="all-frames" type="checkbox"/>Analyze every media asset instead of one per post</label>}

      <details id="collection-settings" className="disclosure collection-disclosure">
        <summary>Collection settings <span>{c.summary}</span></summary>
        <div className="stack">
          <label className="field" htmlFor="collection-source">Which posts to visit
            <select {...c.fields.source}><option value="discover">Find posts on the profile</option><option value="saved">Retry the saved post list</option></select>
            <span className="collection-help">{c.sourceHelp}</span>
            <FieldError name="source" message={c.errors.source}/>
          </label>
          <label className="field" htmlFor="run-session">Instagram login to use
            <select {...c.sessionProps} id="run-session"><option value="">Saved login (default)</option>{c.sessionMissing&&<option value={c.sessionProps.value} disabled>Session unavailable</option>}{c.sessionOptions.map(s=><option key={s.value} value={s.value}>{s.label}</option>)}</select>
            <FieldError name="session" message={c.errors.session}/>
          </label>
          <fieldset className="collection-limits"><legend>Speed & time limit</legend>
            <p className="collection-help">Start with two browser tabs. More tabs can cause pages to time out.</p>
            <div className="form-grid">
              <label className="field" htmlFor="collection-browserWorkers">Browser tabs<Input {...c.fields.browserWorkers} data-flag="detail-workers" type="number" min="1" max="8" step="1"/><FieldError name="browserWorkers" message={c.errors.browserWorkers}/></label>
              <label className="field" htmlFor="collection-downloadWorkers">Parallel downloads<Input {...c.fields.downloadWorkers} data-flag="dl-workers" type="number" min="1" max="16" step="1"/><FieldError name="downloadWorkers" message={c.errors.downloadWorkers}/></label>
              {c.analyzing&&<label className="field" htmlFor="collection-analysisWorkers">Parallel AI analyses<Input {...c.fields.analysisWorkers} data-flag="analyze-workers" type="number" min="1" max="8" step="1"/><FieldError name="analysisWorkers" message={c.errors.analysisWorkers}/></label>}
              <label className="field" htmlFor="collection-timeoutMinutes">Time limit (minutes)<Input {...c.fields.timeoutMinutes} type="number" min="1" max="360" step="1"/><FieldError name="timeoutMinutes" message={c.errors.timeoutMinutes}/></label>
            </div>
          </fieldset>
        </div>
      </details>

      <details id="collection-troubleshooting" className="disclosure collection-disclosure">
        <summary>Troubleshooting <span>Only if a collection keeps failing</span></summary>
        <div className="stack">
          <div className="collection-checks">
            <label className="check"><input {...c.checks.showBrowser} data-flag="show-browser" type="checkbox"/>Show Chrome while collecting</label>
            <label className="check"><input {...c.checks.forceLogin} data-flag="force-login" type="checkbox"/>Sign in again before collecting</label>
            {c.analyzing&&<label className="check"><input {...c.checks.skipLlmCheck} data-flag="skip-llm-preflight" type="checkbox"/>Skip the LLM readiness check</label>}
          </div>
          <p className="collection-help">Browser actions may still need the LLM. If your key has expired, choose Download media above. Skipping a check does not make AI analysis work.</p>
          <div className="collection-mapping">
            <div><strong>Map Instagram APIs</strong><p className="collection-help">Record the requests Instagram makes for this profile, to debug a collection that finds no posts. This does not start a collection.</p></div>
            <label className="field" htmlFor="collection-mapSurface">Mapping surface<select {...c.fields.mapSurface}><option value="profile">Profile posts</option><option value="saved">Saved posts (this account)</option></select></label>
            <Button id="map-network-btn" type="button" variant="secondary" disabled={c.busy} onClick={c.mapNetwork}>Map APIs<ArrowUpRight size={16}/></Button>
          </div>
          <ErrorNotice error={c.mapCommand.error}/>
        </div>
      </details>

      <div className="composer-footer"><p className="collection-help">Anything already collected for this profile is kept; a repeat run adds to it.</p><Button id="run-btn" type="submit" disabled={c.busy}>{c.launchLabel}<ArrowUpRight size={16}/></Button></div>
      <p id="run-status" role="status">{c.message}</p><ErrorNotice error={c.command.error}/>
    </form>
  </section>;
}
export function CollectionList() {
  const c=useCollections();
  return <section className="collection-list stack" aria-label="Jobs">
    <div className="section-heading"><div><h2>Jobs <span className="count" id="job-count">{c.total}</span></h2></div></div>
    <div className="search-field"><Search size={17} aria-hidden="true"/><label className="sr-only" htmlFor="filter">Search jobs</label><Input id="filter" placeholder="Search jobs" {...c.filterProps}/></div>
    <ErrorNotice error={c.error}/>{c.loading&&<Loading label="Loading collections…"/>}
    <ul id="wf-list" className="collection-rows">{c.rows.map(w=><li key={w.id} {...w.props} data-workflow={w.id} className="collection-row"><span className="collection-avatar" aria-hidden="true"><Layers3 size={19}/></span><span className="collection-name"><strong>@{w.handle||"Unknown profile"}</strong><span>{w.when}</span></span><span className="collection-meta"><Status status={w.status}/><span className="number" data-empty={!w.startedAt||undefined}>{w.elapsed}</span></span><ArrowUpRight size={16} aria-hidden="true" className="muted"/></li>)}</ul>
    {!c.loading&&!c.error&&!c.count&&<div id="list-empty"><Empty title={c.emptyTitle}>{c.emptyText}</Empty></div>}
    {c.more&&<Button variant="secondary" onClick={c.showMore}>Show more jobs</Button>}
  </section>;
}
