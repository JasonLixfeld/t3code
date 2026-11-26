import "~/index.css";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it, onTestFinished } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { clearMissionDraft, markMissionDraft } from "../sidebar/missionDraftStore";
import { DraftHeroHeadline } from "./DraftHeroHeadline";
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

it("with the app's styles, a short window keeps the project and mission on one row", async () => {
  await page.viewport(360, 360);
  const draftId = DraftId.make("short-window-hero");
  const projectRef = scopeProjectRef(LOCAL, ProjectId.make("project"));
  useComposerDraftStore.getState().setProjectDraftThreadId(projectRef, draftId);
  const threadId = useComposerDraftStore.getState().getDraftSession(draftId)!.threadId;
  const name = "Quarterly billing migration and cleanup";
  markMissionDraft(draftId, {
    intent: {
      kind: "lead",
      host: LOCAL,
      missionId: "ba9876543210",
      name,
      expectedLead: ThreadId.make("old-lead"),
    },
    thread: { environmentId: LOCAL, threadId },
  });
  onTestFinished(() => clearMissionDraft(draftId));
  await using _screen = await render(
    <DraftHeroHeadline
      draftId={draftId}
      activeProjectRef={projectRef}
      activeProjectTitle="customer-onboarding-dashboard-v2"
    />,
  );
  const project = page.getByRole("combobox", { name: /^Project: / });
  const mission = page.getByRole("button", { name: `New lead for ${name}` });
  await expect.element(mission).toBeVisible();
  // The prose is visually hidden, so it takes no room in the row.
  expect(
    page.getByText("What should we build in").element().getBoundingClientRect().width,
  ).toBeLessThanOrEqual(1);
  const projectBox = project.element().getBoundingClientRect();
  const missionBox = mission.element().getBoundingClientRect();
  expect(Math.abs(projectBox.top - missionBox.top)).toBeLessThan(2);
  expect(projectBox.right).toBeLessThanOrEqual(missionBox.left);
  expect(missionBox.right).toBeLessThanOrEqual(360);
});
