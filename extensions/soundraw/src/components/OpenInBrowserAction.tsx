import { Action, Icon, Keyboard } from "@raycast/api";
import { Sample } from "../lib/types";

interface OpenInBrowserActionProps {
  sample: Sample;
}

export function OpenInBrowserAction({ sample }: OpenInBrowserActionProps) {
  return (
    <Action.OpenInBrowser
      url={sample.sample}
      title="Open in Browser"
      icon={Icon.Globe}
      shortcut={Keyboard.Shortcut.Common.Open}
    />
  );
}

