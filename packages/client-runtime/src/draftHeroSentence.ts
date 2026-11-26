export const PROJECT_SLOT = "";
export const MISSION_SLOT = "";

export function splitDraftHeroSentence(sentence: string) {
  const projectAt = sentence.indexOf(PROJECT_SLOT);
  const missionAt = sentence.indexOf(MISSION_SLOT);
  const malformed =
    sentence.indexOf(PROJECT_SLOT, projectAt + 1) > projectAt ||
    sentence.indexOf(MISSION_SLOT, missionAt + 1) > missionAt ||
    (projectAt !== -1 && missionAt !== -1 && missionAt < projectAt);
  if (malformed) {
    const words = sentence.replaceAll(PROJECT_SLOT, "").replaceAll(MISSION_SLOT, "");
    return { beforeProject: words, beforeMission: "", afterMission: "" };
  }
  const beforeProject = projectAt === -1 ? "" : sentence.slice(0, projectAt);
  const rest = projectAt === -1 ? sentence : sentence.slice(projectAt + 1);
  const restMissionAt = rest.indexOf(MISSION_SLOT);
  return restMissionAt === -1
    ? { beforeProject, beforeMission: rest, afterMission: "" }
    : {
        beforeProject,
        beforeMission: rest.slice(0, restMissionAt),
        afterMission: rest.slice(restMissionAt + 1),
      };
}
