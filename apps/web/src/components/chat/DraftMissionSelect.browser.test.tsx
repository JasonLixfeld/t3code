import "~/index.css";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, onTestFinished } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { clearMissionDraft, markMissionDraft } from "../sidebar/missionDraftStore";
import { useDraftMissionChoice } from "./DraftMissionSelect";

const LOCAL = EnvironmentId.make("local");

function MissionWord(props: { draftId: DraftId; environmentId: EnvironmentId }) {
  return useDraftMissionChoice(props.draftId, props.environmentId)?.standalone ?? null;
}

it("with the app's styles, a pointer over the fixed Mission choice shows why it is fixed", async () => {
  const draftId = DraftId.make("fixed-mission-hover");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(LOCAL, ProjectId.make("project")), draftId);
  const threadId = useComposerDraftStore.getState().getDraftSession(draftId)!.threadId;
  markMissionDraft(draftId, {
    intent: { kind: "new" },
    thread: { environmentId: LOCAL, threadId },
  });
  onTestFinished(() => clearMissionDraft(draftId));
  await using screen = await render(<MissionWord draftId={draftId} environmentId={LOCAL} />);
  const trigger = screen.getByRole("button", { name: "New mission" });
  await expect.element(trigger).toBeVisible();
  // The disabled look lets the pointer through, so over the button it lands on the tooltip's
  // wrapper. Hovering the button itself is refused for that reason; a user's pointer is not.
  const button = trigger.element() as HTMLElement;
  const box = button.getBoundingClientRect();
  const landed = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
  expect(landed).toBe(button.parentElement);
  expect(landed).toHaveAttribute("data-slot", "tooltip-trigger");
  await userEvent.hover(page.elementLocator(landed!));
  await expect
    .element(
      page.getByText(
        "This thread leads its mission, so it cannot join another. Send it as a plain thread to undo this.",
      ),
    )
    .toBeVisible();
});
