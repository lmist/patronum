import { Button } from "../../components/ui/button";
import { useFileLink } from "./use-reader";
import type { FileArtifact } from "../../api/types";
export function FileLink({file,label,title}: {file:FileArtifact;label?:string;title?:string}) {
  const props=useFileLink(file);
  return <Button variant="secondary" data-file={file.path} aria-label={title} title={title} onClick={props.onClick}>{label??props.label}</Button>;
}
