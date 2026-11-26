import { useAtomValue } from "@effect/atom-react";
import { useGT } from "gt-react";
import { SearchIcon } from "lucide-react";

import { shortcutLabelForCommand } from "~/keybindings";
import { primaryServerKeybindingsAtom } from "~/state/server";

import { Toggle } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { DiffFind } from "./useDiffFind";

export function DiffFindToggle({ find }: { readonly find: DiffFind }) {
  const gt = useGT();
  const shortcutLabel = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "preview.find",
    { context: { previewFocus: true } },
  );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            aria-label={gt("Find in diff")}
            variant="ghost"
            size="sm"
            pressed={find.state !== null}
            onPressedChange={(pressed) => (pressed ? find.open() : find.close())}
          />
        }
      >
        <SearchIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">
        {gt("Find in diff")}
        {shortcutLabel ? ` (${shortcutLabel})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}
