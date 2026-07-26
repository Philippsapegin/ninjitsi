import type { ParticipantView } from "@/lib/jitsi/types";
import { AudioTrack } from "./MediaTrack";

interface AudioSinksProps {
  participants: ParticipantView[];
}

export function AudioSinks({ participants }: AudioSinksProps) {
  return (
    <div aria-hidden="true">
      {participants
        .filter((participant) => !participant.isLocal && participant.audioTrack)
        .map((participant) => (
          <AudioTrack
            key={participant.id}
            track={participant.audioTrack!}
          />
        ))}
    </div>
  );
}
