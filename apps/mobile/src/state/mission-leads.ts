import { useAtomValue } from "@effect/atom-react";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { MissionHost } from "@t3tools/client-runtime/missions";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadFamilyRead } from "@t3tools/client-runtime/state/threads";
import { Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import { appAtomRegistry } from "./atom-registry";
import { threadFamilies } from "./threads";

const activeLeadKeys = (hosts: ReadonlyArray<MissionHost>) =>
  hosts.flatMap((host) =>
    host.snapshot.missions.flatMap((mission) =>
      mission.members.flatMap((member) =>
        member.role === "lead" && member.state === "active" ? [scopedThreadKey(member.ref)] : [],
      ),
    ),
  );

const settledLeadReadsAtom = Atom.family((keys: string) =>
  Atom.make(
    (get): ReadonlySet<string> =>
      new Set(
        (JSON.parse(keys) as ReadonlyArray<string>).filter((key) => {
          const ref = parseScopedThreadKey(key);
          return (
            ref !== null &&
            threadFamilyRead(get(threadFamilies.familyAtom(ref.environmentId, ref.threadId))) ===
              "settled"
          );
        }),
      ),
  ).pipe(Atom.withLabel(`mobile-mission-lead-reads:${keys}`)),
);

/**
 * Loads each active lead the thread list does not hold, such as one on another project or
 * machine, so its row shows its real title and status. Returns the leads whose read settled
 * without them: those are gone.
 */
export function useMissionLeadShells(
  hosts: ReadonlyArray<MissionHost>,
  threads: ReadonlyArray<Pick<EnvironmentThreadShell, "environmentId" | "id">>,
): ReadonlySet<string> {
  const listed = new Set(
    threads.map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
  );
  const leads = activeLeadKeys(hosts);
  const missing = leads.filter((key) => !listed.has(key));
  // A lead stays held once loaded, or it would leave the list again.
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
  return useAtomValue(settledLeadReadsAtom(JSON.stringify(missing)));
}
