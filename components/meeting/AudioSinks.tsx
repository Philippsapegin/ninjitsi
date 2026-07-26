import type { ParticipantView } from "@/lib/jitsi/types";
import { AudioTrack } from "./MediaTrack";

interface AudioSinksProps {
  participantVolumes: Record<string, number>;
  participants: ParticipantView[];
}

export function AudioSinks({
  participantVolumes,
  participants,
}: AudioSinksProps) {
  return (
    <div aria-hidden="true">
      {participants
        .filter((participant) => !participant.isLocal && participant.audioTrack)
        .map((participant) => (
          <AudioTrack
            key={participant.id}
            track={participant.audioTrack!}
            volume={participantVolumes[participant.id] ?? 1}
          />
        ))}
    </div>
  );
}
