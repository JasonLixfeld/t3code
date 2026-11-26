export function missionPromptForm(input: {
  readonly promptsOmitted: boolean;
  readonly listed: string | undefined;
  readonly fetchedPrompt: string | null;
  readonly draft: string | null;
  readonly canSave: boolean;
}) {
  const loaded = input.promptsOmitted ? input.fetchedPrompt : (input.listed ?? "");
  // The server trims the prompt it saves.
  const next = input.draft?.trim();
  const editable = loaded !== null && input.canSave;
  return {
    value: input.draft ?? loaded ?? "",
    next,
    editable,
    changed: editable && next !== undefined && next !== loaded,
  };
}
