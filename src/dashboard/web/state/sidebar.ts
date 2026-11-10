import { useState, useSyncExternalStore, type SyntheticEvent } from "react";
const query = "(min-width: 901px)";
function subscribe(listener: () => void) {
  const media = window.matchMedia(query);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
export function useJobSidebar() {
  const desktop = useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => true);
  const [expanded, setExpanded] = useState(false);
  return {
    open: desktop || expanded,
    close: () => setExpanded(false),
    reveal: () => setExpanded(true),
    onToggle: (event: SyntheticEvent<HTMLDetailsElement>) => {
      if (!desktop) setExpanded(event.currentTarget.open);
    },
  };
}
