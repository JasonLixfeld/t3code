import { useAtomValue } from "@effect/atom-react";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { MissionHost } from "@t3tools/client-runtime/missions";
import { arrayElementsEqual, threadKey } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadFamilyRead } from "@t3tools/client-runtime/state/threads";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import { appAtomRegistry } from "./atom-registry";
import { environmentThreadShells, steadyThreadShells, threadFamilies } from "./threads";

const activeLeadKeys = (hosts: ReadonlyArray<MissionHost>) =>
  hosts.flatMap((host) =>
    host.snapshot.missions.flatMap((mission) =>
      mission.members.flatMap((member) =>
        member.role === "lead" && member.state === "active" ? [scopedThreadKey(member.ref)] : [],
      ),
    ),
  );

const settledMissingLeadsAtom = Atom.family((keys: string) =>
  Atom.make(
    (get): ReadonlySet<string> =>
      new Set(
        (JSON.parse(keys) as ReadonlyArray<string>).filter((key) => {
          const ref = parseScopedThreadKey(key);
          if (ref === null) return false;
          const read = get(threadFamilies.familyAtom(ref.environmentId, ref.threadId));
          return (
            threadFamilyRead(read) === "settled" &&
            AsyncResult.isSuccess(read) &&
            !read.value.threads.some((thread) => thread.id === ref.threadId) &&
            !get(environmentThreadShells.environmentThreadIndexAtom(ref.environmentId)).has(
              ref.threadId,
            )
          );
        }),
      ),
  ).pipe(Atom.withLabel(`mobile-mission-missing-leads:${keys}`)),
);

export function useMissionLeadShells(
  hosts: ReadonlyArray<MissionHost>,
  threads: ReadonlyArray<Pick<EnvironmentThreadShell, "environmentId" | "id">>,
): ReadonlySet<string> {
  const listed = new Set(
    threads.map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
  );
  const leads = activeLeadKeys(hosts);
  const missing = leads.filter((key) => !listed.has(key));
  const [mounted, setMounted] = useState<ReadonlyArray<string>>([]);
  const wanted = leads.filter((key) => !listed.has(key) || mounted.includes(key));
  const wantedKey = JSON.stringify(wanted);
  if (wantedKey !== JSON.stringify(mounted)) setMounted(wanted);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds each wanted lead's family in the thread family registry while the list shows it
  useEffect(() => {
    const releases = (JSON.parse(wantedKey) as ReadonlyArray<string>).flatMap((key) => {
      const ref = parseScopedThreadKey(key);
      return ref === null
        ? []
        : [threadFamilies.mount(appAtomRegistry, ref.environmentId, ref.threadId)];
    });
    return () => {
      for (const release of releases) release();
    };
  }, [wantedKey]);
  return useAtomValue(settledMissingLeadsAtom(JSON.stringify(missing)));
}

/**
 * Each Mission thread's shell, as the web sidebar reads them. The thread list leaves out an
 * archived thread and a task delegated from its lead's machine, which left a blank member row.
 */
const missionThreadShellsAtom = Atom.family((keys: string) => {
  let previous: ReadonlyArray<EnvironmentThreadShell> = [];
  return Atom.make((get) => {
    const wanted = JSON.parse(keys) as ReadonlyArray<string>;
    if (wanted.length === 0) return previous;
    const hidden = get(steadyThreadShells.hiddenThreadKeysAtom);
    const next = wanted.flatMap((key) => {
      const ref = parseScopedThreadKey(key);
      if (ref === null || hidden.has(threadKey(ref))) return [];
      const shell = get(steadyThreadShells.quietThreadShellAtom(ref));
      return shell === null ? [] : [shell];
    });
    if (arrayElementsEqual(previous, next)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel(`mobile-mission-thread-shells:${keys}`));
});

export function useMissionThreadShells(
  hosts: ReadonlyArray<MissionHost>,
): ReadonlyArray<EnvironmentThreadShell> {
  const keys = hosts.flatMap((host) =>
    host.snapshot.missions.flatMap((mission) =>
      mission.members.map((member) => scopedThreadKey(member.ref)),
    ),
  );
  return useAtomValue(missionThreadShellsAtom(JSON.stringify(keys)));
}
