import { ArrowUpRight, Download, ShieldCheck } from "lucide-react";
import { Button } from "../../components/ui/button";
import { ErrorNotice } from "../../components/feedback";
import { useAccount } from "./use-account";
type Control=ReturnType<typeof useAccount>["controls"][number];
function ActionList({controls}:{controls:Control[]}) {
  return <div className="account-actions">{controls.map(control=><button key={control.id} id={control.id} {...control.props} className="account-action"><span><strong>{control.label}</strong><span>{control.description}</span></span><ArrowUpRight size={18} aria-hidden="true"/></button>)}</div>;
}
export function Account() {
  const a=useAccount();
  return <div className="stack">
    <header className="page-header"><h1>Account</h1><p className="muted">Patronum collects through Chrome, signed in to your Instagram account. Sign in once; come back here when a collection reports a login problem.</p></header>
    <section className="surface stack" id="auth-panel">
      <div className="account-group"><div className="group-heading"><h2>Sign-in and readiness</h2><p className="muted">Each check runs once and reports its result below.</p></div><ActionList controls={a.checks}/></div>
      <div className="account-group"><div className="group-heading"><h2>If something is stuck</h2><p className="muted">You only need these after a sign-in or a collection was interrupted.</p></div><ActionList controls={a.repairs}/></div>
      <div role="status" id="auth-status" className="notice">{a.status}{a.readyText&&<p className="account-ready"><ShieldCheck size={16}/>{a.readyText}</p>}{a.error&&<p className="status-error">{a.error}</p>}</div>
      <ErrorNotice error={a.mutation.error}/><ErrorNotice error={a.action.error}/>
      {a.current?.hint&&<p className="notice" id="auth-recovery">{a.current.hint}</p>}
      <div className="actions account-followups"><Button id="auth-check-current" hidden={!a.current?.isolated} variant="secondary" disabled={a.mutation.isPending} onClick={a.checkCurrent}>Check this fresh session</Button><Button id="auth-use-session" hidden={!a.canUseSession} disabled={a.usingSession} onClick={a.chooseSession}>{a.usingSession?"Selected for collections":"Use this session for collections"}</Button><Button id="auth-stop" hidden={!a.canStop} variant="destructive" disabled={a.mutation.isPending} onClick={a.stop}>{a.stopLabel}</Button></div>
    </section>
    <section className="surface stack" id="action-details"><div className="section-heading"><div><h2>Action log</h2><p className="muted">Full output of recent checks and collection commands.</p></div>{a.fullLog&&<a className="download-link" id="action-download" href={a.fullLog} download><Download size={16}/>Download log</a>}</div><label className="field" htmlFor="action-history">Recent actions<select id="action-history" value={a.selectedHistory} onChange={a.changeHistory}><option value="">Select an action</option>{a.history.map(item=><option key={item.value} value={item.value}>{item.label}</option>)}</select></label><ErrorNotice error={a.log.error}/><pre className="log" id="action-log">{a.logText}</pre></section>
  </div>;
}
