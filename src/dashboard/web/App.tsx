import { Button } from "./components/ui/button";
import { ArrowUpRight, Plus, RefreshCw, ChevronRight, GitBranch, CircleAlert } from "lucide-react";
import { ErrorNotice, Empty, Status, Loading } from "./components/feedback";
import { AppContext, useApp, useDashboard } from "./state/app";
import { Composer,CollectionList } from "./features/collections/Collections";
import { Account } from "./features/account/Account";
import { Verification } from "./features/verification/Verification";
import { Progress } from "./features/progress/Progress";
import { Results } from "./features/results/Results";
import { Diagnostics } from "./features/diagnostics/Diagnostics";

const STAGE_SLOTS=Array.from({length:7},(_,i)=>i);

function CollectionsWorkspace() {
  const app=useDashboard();
  return <>
    <div className="workspace-tools">
    <details id="new-collection-disclosure" className="new-collection-disclosure" key={"composer-"+app.workflowId} open={!app.workflowId}><summary>New collection<Plus size={17}/></summary><Composer/></details>
    </div>
    {app.workflowId&&<ErrorNotice error={app.detail.error}><Button variant="link" onClick={app.refresh}>Retry loading collection</Button></ErrorNotice>}
    {app.workflowId&&app.detail.isPending&&<Loading label="Opening collection…"/>}
    {app.workflow&&<section id="detail-body" className="stack" aria-label="Collection details">
      <div className="detail-heading"><div><h1 id="wf-id">@{app.workflow.handle||"Unknown profile"}</h1><div id="wf-meta"><Status status={app.workflow.status}/><span className="muted">{app.created}</span></div></div></div>
      <div className="job-summary"><div className="job-progress"><span className="muted">{app.completeStages} of 7 stages complete · {app.elapsed}</span><div className="stage-meter" data-status={app.canCancel?"running":app.detail.data?.errorText?"error":"idle"} aria-hidden="true">{STAGE_SLOTS.map(i=><span key={i} data-filled={i<app.completeStages} data-next={i===app.completeStages}/>)}</div></div><div className="actions"><Button id="btn-resume" hidden={!app.canResume} disabled={app.command.isPending} onClick={app.resume}>Resume collection<ArrowUpRight size={16}/></Button><Button id="btn-cancel" hidden={!app.canCancel} variant="destructive" disabled={app.command.isPending} onClick={app.cancel}>Cancel collection</Button></div><ErrorNotice error={app.command.error}/></div>
      <p id="launch-status" className="muted" role="status">{app.launchStatus}</p>
      {app.detail.data?.errorText&&<div id="error-banner" role="alert" className="notice notice-error error-banner"><CircleAlert size={18} aria-hidden="true"/><p className="error-advice">{app.recovery.advice}</p><p className="error-detail">{app.detail.data.errorText}</p>{app.recovery.account&&<Button variant="secondary" onClick={app.account}>Open account</Button>}</div>}
      <nav className="detail-tabs" aria-label="Collection views"><Button variant="ghost" data-view="results" {...app.viewProps("results")}>Results</Button><Button variant="ghost" data-view="progress" {...app.viewProps("progress")}>State machine</Button></nav>
      {app.selection.view==="results"?<Results key={app.workflowId}/>:<Progress key={app.workflowId}/>}
    </section>}
    {!app.workflowId&&<section className="surface job-welcome"><GitBranch size={32}/><h1>Select a job to inspect its state machine</h1><p className="muted">Choose a job from the sidebar to follow its states, inspect outputs, or recover unfinished work.</p></section>}
  </>;
}

function JobSidebar() {
  const app=useDashboard();
  return <aside className="jobs-sidebar" aria-label="Jobs sidebar">
    <nav className="sidebar-nav" aria-label="Main navigation">{app.nav.map(item=><Button key={item.id} variant="ghost" {...item.props}><item.icon size={16}/>{item.label}</Button>)}</nav>
    <details id="job-sidebar-list" className="job-sidebar-disclosure" open={app.sidebar.open} onToggle={app.sidebar.onToggle}>
      <summary>Jobs<ChevronRight size={16}/></summary>
      <div className="sidebar-content"><Button id="new-job" className="sidebar-new" onClick={app.newCollection}><Plus size={16}/>New collection</Button><CollectionList/></div>
    </details>
  </aside>;
}
export function App() {
  const app=useApp();
  return <AppContext.Provider value={app}><div className="app" onKeyDown={app.keyDown}>
    <a className="skip-link" href="#workspace">Skip to workspace</a>
    <header className="app-header"><button className="brand" onClick={app.home} aria-label="Patronum home"><img className="brand-mark" src={`${import.meta.env.BASE_URL}brand/patronum-light.svg`} width="20" height="37" alt=""/><span>patronum</span></button><div className="header-trail"><span>Content workspace</span><ChevronRight size={14}/><span>{app.title}</span></div><div className="header-actions"><span id="poll-status" role="status" className={app.connected?"connection":"connection status-error"}><span className="connection-dot"/>{app.connected?"Connected":"Reconnecting"}</span><Button variant="ghost" size="icon" aria-label="Refresh workspace" onClick={app.refresh}><RefreshCw size={17}/></Button></div></header>
    <JobSidebar/>
    <div className="app-grid"><main id="workspace" tabIndex={-1} className="workspace-main stack">
      <ErrorNotice error={app.now.error}><p>Showing the last available data. Refresh to retry.</p></ErrorNotice>
      {app.selection.section==="collections"?<CollectionsWorkspace/>:app.selection.section==="account"?<><Account/><Verification/></>:<Diagnostics/>}
    </main></div>
  </div></AppContext.Provider>;
}
