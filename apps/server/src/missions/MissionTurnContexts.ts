import type { ThreadId } from "@t3tools/contracts";
import type { ProviderAdapterV2TurnInput } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

type MissionContext = NonNullable<ProviderAdapterV2TurnInput["missionContext"]>;
type Read = (threadId: ThreadId) => Effect.Effect<MissionContext | undefined>;

export class MissionTurnContexts extends Context.Service<
  MissionTurnContexts,
  {
    readonly read: Read;
    readonly serve: (read: Read) => Effect.Effect<void>;
  }
>()("t3/missions/MissionTurnContexts") {}

export const layer = Layer.effect(
  MissionTurnContexts,
  Effect.gen(function* () {
    const reader = yield* Ref.make<Read>(() => Effect.undefined);
    return MissionTurnContexts.of({
      read: Effect.fn("MissionTurnContexts.read")(function* (threadId) {
        return yield* (yield* Ref.get(reader))(threadId);
      }),
      serve: Effect.fn("MissionTurnContexts.serve")(function* (read) {
        yield* Ref.set(reader, read);
      }),
    });
  }),
);
