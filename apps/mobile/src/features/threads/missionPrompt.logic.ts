import { normalizeMissionPrompt } from "@t3tools/contracts";

export function missionPromptForm(input: {
  readonly promptsOmitted: boolean;
  readonly listed: string | undefined;
  readonly fetchedPrompt: string | null;
  readonly draft: string | null;
  readonly canSave: boolean;
}) {
  const loaded = input.promptsOmitted ? input.fetchedPrompt : (input.listed ?? "");
  const next = input.draft === null ? undefined : normalizeMissionPrompt(input.draft);
  const editable = loaded !== null && input.canSave;
  return {
    value: input.draft ?? loaded ?? "",
    next,
    editable,
    changed: editable && next !== undefined && next !== loaded,
  };
}
