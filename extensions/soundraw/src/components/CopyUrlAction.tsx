import { Action, Icon } from "@raycast/api";
import { Sample } from "../lib/types";

interface CopyUrlActionProps {
  sample: Sample;
}

export function CopyUrlAction({ sample }: CopyUrlActionProps) {
  return <Action.CopyToClipboard content={sample.sample} title="Copy Audio URL" icon={Icon.Link} />;
}
