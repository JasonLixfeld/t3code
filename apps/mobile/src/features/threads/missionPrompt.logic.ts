/**
 * The web's mission prompt editor. Reading needs only the Missions list (orchestration read);
 * saving needs `missions.setPrompt` (orchestration operate). The menu row is disabled for a session
 * that may not save, so it never opens; a session that loses the right while open keeps the text
 * but cannot save it.
 */
export function missionPromptForm(input: {
  /** The list left prompts out, so the editor reads it with `missions.getPrompt`. */
  readonly promptsOmitted: boolean;
  readonly listed: string | undefined;
  /** The `missions.getPrompt` answer, null until it lands. */
  readonly read: string | null;
  readonly draft: string | null;
  readonly canSave: boolean;
}) {
  const loaded = input.promptsOmitted ? input.read : (input.listed ?? "");
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
