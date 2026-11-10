import { Download, ChevronRight, GitBranch, ArrowRight, CircleAlert, Ban } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Status, ErrorNotice } from "../../components/feedback";
import { useProgress } from "./use-progress";
export function Progress() {
  const p=useProgress();
  return <div className="stack" id="progress-panel">
    <section className="surface fsm-card" aria-label="Job state machine">
      <div className="section-heading"><div><h2>State machine</h2><p className="muted">Select a state to inspect its output and activity.</p></div><div className="fsm-current" role="status"><span>Current state</span><strong>{p.fsm.current}</strong></div></div>
      <ol id="pipeline-rail" className="fsm-flow">{p.fsmNodes.map(node=><li key={node.id} data-node={node.id} data-state={node.state} data-direction={node.direction} className="fsm-node">
        {node.stage?<button {...node.props} className="fsm-state"><span className="fsm-state-top"><span className="stage-dot"/><span className="sval">{node.status}</span></span><strong className="sname">{node.name}</strong><span className="sdesc">{node.label}</span></button>:<div className="fsm-state fsm-terminal"><span className="fsm-state-top"><span className="stage-dot"/><span className="sval">{node.status}</span></span><strong>{node.name}</strong><span className="sdesc">{node.label}</span></div>}
        {node.direction!=="none"&&<ArrowRight className="fsm-connector" size={20} aria-hidden="true"/>}
      </li>)}</ol>
      <div className="fsm-branches"><div className="fsm-branch" data-active={p.fsm.failed}><CircleAlert size={17}/><span>Stage error</span><ArrowRight size={15}/><strong>Needs attention</strong><span className="muted">Resume unfinished work</span></div><div className="fsm-branch" data-active={p.fsm.cancelled}><Ban size={17}/><span>Cancel active job</span><ArrowRight size={15}/><strong>Cancelled</strong></div></div>
    </section>
    {p.lineage&&<div className="notice actions"><GitBranch size={16}/><span>This attempt continues an earlier collection.</span><Button variant="link" onClick={p.openLineage}>View earlier attempt</Button></div>}
    <section className="surface state-inspector stack" aria-label="Selected state"><div className="section-heading"><h2>{p.inspectedLabel}</h2><span className="muted">Selected state</span></div><pre className="log" id="state-output">{p.inspectedText}</pre></section>
    <details className="disclosure execution-details"><summary>Execution steps & internals</summary>
    <div className="section-heading"><h2>Collection steps</h2><Button id="toggle-internals" variant="ghost" onClick={p.toggleInternals}>{p.internals?"Hide internals":"Show internals"}</Button></div>
    <ol id="timeline" className="timeline">{p.rows.map(s=><li key={s.stepId}><Button variant="ghost" {...s.props} className="step-row"><Status status={s.status}/><span className="step-name">{s.name}</span><span className="number muted">{s.duration}</span><ChevronRight size={15}/></Button>{s.childWorkflowId&&<Button variant="link" {...s.childProps}>View child workflow</Button>}</li>)}</ol>
    <details className="disclosure" open><summary>Selected step output</summary><pre className="log" id="step-focus">{p.selectedText}</pre></details>
    </details>
    <section className="surface stack"><div className="section-heading"><h2>Live activity</h2><a className="download-link" id="log-download" href={p.download} download><Download size={16}/>Download log</a></div><div className="log-toolbar"><label className="field" htmlFor="log-stage">Stage<select id="log-stage" value={p.logStage} onChange={p.selectLog}><option value="all">All stages</option>{p.stages.map(s=><option key={s.name} value={s.name}>{s.name}</option>)}</select></label><label className="check"><input id="log-follow" type="checkbox" checked={p.follow} onChange={p.toggleFollow}/>Follow latest</label></div><ErrorNotice error={p.log.error}/><pre id="stream-tail" className="log" ref={p.followRef}>{p.logText}</pre>{!p.follow&&<p className="muted">Updates paused here. Turn on Follow latest to catch up.</p>}</section>
  </div>;
}
