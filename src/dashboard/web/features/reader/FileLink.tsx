import { Button } from "../../components/ui/button";
import { useFileLink } from "./use-reader";
import type { FileArtifact } from "../../api/types";
export function FileLink({file,label}: {file:FileArtifact;label?:string}) {
  const props=useFileLink(file);
  return <Button variant="secondary" data-file={file.path} onClick={props.onClick}>{label??props.label}</Button>;
}
