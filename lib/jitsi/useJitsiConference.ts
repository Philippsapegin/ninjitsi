"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadJitsiRuntime } from "./loader";
import type {
  JitsiConferenceLike,
  JitsiConnectionLike,
  JitsiMeetJSLibrary,
  JitsiTrackLike,
  MeetingStatus,
  ParticipantView,
} from "./types";

export interface JoinOptions {
  displayName: string;
  password: string;
  startAudioMuted: boolean;
  startVideoMuted: boolean;
}

interface ConferenceController {
  error: string | null;
  isAudioMuted: boolean;
  isDemo: boolean;
  isScreenSharing: boolean;
  isVideoMuted: boolean;
  join: (options: JoinOptions) => Promise<void>;
  leave: () => Promise<void>;
  participants: ParticipantView[];
  status: MeetingStatus;
  toggleAudio: () => Promise<void>;
  toggleScreenShare: () => Promise<void>;
  toggleVideo: () => Promise<void>;
}

const demoNames = [
  "Лера К.",
  "Михаил",
  "Таня",
  "Костя",
  "Анна",
  "Сергей",
];

function pickPreferredVideo(tracks: JitsiTrackLike[]) {
  const videoTracks = tracks.filter((track) => track.getType() === "video");

  return (
    videoTracks.find((track) => track.getVideoType?.() === "desktop") ??
    videoTracks[0]
  );
}

function createDemoParticipants(displayName: string): ParticipantView[] {
  const people = [displayName, ...demoNames];

  return people.map((name, index) => ({
    audioMuted: index === 3,
    displayName: name,
    id: index === 0 ? "local" : `demo-${index}`,
    isDominantSpeaker: index === 1,
    isLocal: index === 0,
    isModerator: index === 0,
    isScreenSharing: false,
    videoMuted: index === 4,
  }));
}

export function useJitsiConference(roomName: string): ConferenceController {
  const serverUrl =
    process.env.NEXT_PUBLIC_JITSI_URL?.trim().replace(/\/+$/, "") ?? "";
  const isDemo = !serverUrl;
  const [status, setStatus] = useState<MeetingStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [participants, setParticipants] = useState<ParticipantView[]>([]);
  const [isAudioMuted, setIsAudioMuted] = useState(false);
  const [isVideoMuted, setIsVideoMuted] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const connectionRef = useRef<JitsiConnectionLike | null>(null);
  const conferenceRef = useRef<JitsiConferenceLike | null>(null);
  const libraryRef = useRef<JitsiMeetJSLibrary | null>(null);
  const localIdRef = useRef("local");
  const localNameRef = useRef("Вы");
  const dominantSpeakerRef = useRef<string | null>(null);
  const disposedRef = useRef(false);
  const desktopRemovalRef = useRef(new WeakSet<JitsiTrackLike>());

  const syncParticipants = useCallback(() => {
    const conference = conferenceRef.current;

    if (!conference) {
      return;
    }

    const localTracks = conference.getLocalTracks();
    const localVideo = pickPreferredVideo(localTracks);
    const localAudio = localTracks.find((track) => track.getType() === "audio");
    const remote = conference
      .getParticipants()
      .filter((participant) => !participant.isHidden?.())
      .map<ParticipantView>((participant) => {
        const tracks = participant.getTracks();
        const videoTrack = pickPreferredVideo(tracks);
        const audioTrack = tracks.find((track) => track.getType() === "audio");

        return {
          audioMuted: participant.isAudioMuted(),
          audioTrack,
          displayName: participant.getDisplayName() || "Без имени",
          id: participant.getId(),
          isDominantSpeaker:
            participant.getId() === dominantSpeakerRef.current,
          isLocal: false,
          isModerator: participant.getRole() === "moderator",
          isScreenSharing: videoTrack?.getVideoType?.() === "desktop",
          videoMuted: participant.isVideoMuted(),
          videoTrack,
        };
      });

    const audioMuted = !localAudio || localAudio.isMuted();
    const cameraTracks = localTracks.filter(
      (track) =>
        track.getType() === "video" &&
        track.getVideoType?.() !== "desktop",
    );
    const videoMuted =
      cameraTracks.length === 0 || cameraTracks.every((track) => track.isMuted());
    const sharing = localTracks.some(
      (track) =>
        track.getType() === "video" &&
        track.getVideoType?.() === "desktop",
    );

    setIsAudioMuted(audioMuted);
    setIsVideoMuted(videoMuted);
    setIsScreenSharing(sharing);
    setParticipants([
      {
        audioMuted,
        audioTrack: localAudio,
        displayName: localNameRef.current,
        id: localIdRef.current,
        isDominantSpeaker:
          localIdRef.current === dominantSpeakerRef.current,
        isLocal: true,
        isModerator: conference.isModerator(),
        isScreenSharing: localVideo?.getVideoType?.() === "desktop",
        videoMuted,
        videoTrack: localVideo,
      },
      ...remote,
    ]);
  }, []);

  const teardown = useCallback(async () => {
    disposedRef.current = true;
    const conference = conferenceRef.current;
    const connection = connectionRef.current;

    conferenceRef.current = null;
    connectionRef.current = null;

    if (conference) {
      const tracks = conference.getLocalTracks();

      await Promise.allSettled(
        tracks.map(async (track) => {
          await conference.removeTrack(track).catch(() => undefined);
          await track.dispose().catch(() => undefined);
        }),
      );
      await conference.leave().catch(() => undefined);
    }

    connection?.disconnect();
  }, []);

  const join = useCallback(
    async (options: JoinOptions) => {
      setError(null);
      localNameRef.current = options.displayName;
      disposedRef.current = false;

      if (isDemo) {
        setStatus("loading");
        await new Promise((resolve) => window.setTimeout(resolve, 420));
        const demoParticipants = createDemoParticipants(options.displayName);

        demoParticipants[0].audioMuted = options.startAudioMuted;
        demoParticipants[0].videoMuted = options.startVideoMuted;
        setParticipants(demoParticipants);
        setIsAudioMuted(options.startAudioMuted);
        setIsVideoMuted(options.startVideoMuted);
        setStatus("joined");
        return;
      }

      setStatus("loading");

      try {
        const { config, library } = await loadJitsiRuntime(
          serverUrl,
          roomName,
        );

        if (disposedRef.current) {
          return;
        }

        libraryRef.current = library;
        library.init({
          disableAudioLevels: false,
          disableThirdPartyRequests: true,
        });

        if (library.setLogLevel && library.logLevels?.ERROR) {
          library.setLogLevel(library.logLevels.ERROR);
        }

        const localTracksPromise = library
          .createLocalTracks({
            devices: ["audio", "video"],
            resolution: 720,
          })
          .then(async (tracks) => {
            await Promise.all(
              tracks.map(async (track) => {
                const shouldStartMuted =
                  (track.getType() === "audio" && options.startAudioMuted) ||
                  (track.getType() === "video" && options.startVideoMuted);

                if (shouldStartMuted) {
                  await track.mute?.();
                }
              }),
            );
            return tracks;
          });

        const connection = new library.JitsiConnection(null, null, config);
        const connectionEvents = library.events.connection;

        connectionRef.current = connection;
        setStatus("connecting");

        connection.addEventListener(
          connectionEvents.CONNECTION_ESTABLISHED,
          async (...eventArguments) => {
            localIdRef.current =
              typeof eventArguments[0] === "string"
                ? eventArguments[0]
                : "local";

            const conference = connection.initJitsiConference(roomName, config);
            const conferenceEvents = library.events.conference;

            conferenceRef.current = conference;
            conference.setDisplayName(options.displayName);

            const resyncEvents = [
              conferenceEvents.TRACK_ADDED,
              conferenceEvents.TRACK_REMOVED,
              conferenceEvents.TRACK_MUTE_CHANGED,
              conferenceEvents.USER_JOINED,
              conferenceEvents.USER_LEFT,
              conferenceEvents.USER_ROLE_CHANGED,
              conferenceEvents.DISPLAY_NAME_CHANGED,
            ].filter(Boolean);

            resyncEvents.forEach((eventName) =>
              conference.on(eventName, syncParticipants),
            );

            conference.on(
              conferenceEvents.DOMINANT_SPEAKER_CHANGED,
              (participantId) => {
                dominantSpeakerRef.current =
                  typeof participantId === "string" ? participantId : null;
                syncParticipants();
              },
            );

            conference.on(conferenceEvents.CONNECTION_INTERRUPTED, () =>
              setStatus("reconnecting"),
            );
            conference.on(conferenceEvents.CONNECTION_RESTORED, () =>
              setStatus("joined"),
            );
            conference.on(conferenceEvents.CONFERENCE_JOINED, async () => {
              setStatus("joined");
              syncParticipants();

              if (options.password && conference.isModerator()) {
                await conference.lock(options.password).catch(() => {
                  setError("Сервер не позволил установить пароль комнаты");
                });
              }
            });
            conference.on(
              conferenceEvents.CONFERENCE_FAILED,
              async (reason) => {
                const isPasswordError =
                  reason === "conference.passwordRequired";

                setError(
                  isPasswordError
                    ? "Комната защищена: пароль не подошёл"
                    : `Не удалось войти в комнату${
                        typeof reason === "string" ? `: ${reason}` : ""
                      }`,
                );
                setStatus("failed");
                await teardown();
              },
            );

            const localTracks = await localTracksPromise;

            await Promise.all(
              localTracks.map((track) => conference.addTrack(track)),
            );
            syncParticipants();
            conference.join(options.password);
          },
        );

        connection.addEventListener(
          connectionEvents.CONNECTION_FAILED,
          async (...eventArguments) => {
            const reason = eventArguments
              .filter((value) => typeof value === "string")
              .join(": ");

            setError(`Jitsi-сервер отклонил соединение${reason ? `: ${reason}` : ""}`);
            setStatus("failed");
            await teardown();
          },
        );

        connection.addEventListener(
          connectionEvents.CONNECTION_DISCONNECTED,
          () => {
            if (!disposedRef.current) {
              setStatus("failed");
              setError("Соединение с Jitsi-сервером прервано");
            }
          },
        );

        connection.connect();
      } catch (caughtError) {
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : "Не удалось запустить видеовстречу",
        );
        setStatus("failed");
        await teardown();
      }
    },
    [isDemo, roomName, serverUrl, syncParticipants, teardown],
  );

  const toggleAudio = useCallback(async () => {
    if (isDemo) {
      setIsAudioMuted((muted) => {
        setParticipants((current) =>
          current.map((participant) =>
            participant.isLocal
              ? { ...participant, audioMuted: !muted }
              : participant,
          ),
        );
        return !muted;
      });
      return;
    }

    const track = conferenceRef.current
      ?.getLocalTracks("audio")
      .find(Boolean);

    if (!track) {
      setError("Микрофон не был подключён при входе");
      return;
    }

    if (track.isMuted()) {
      await track.unmute?.();
    } else {
      await track.mute?.();
    }
    syncParticipants();
  }, [isDemo, syncParticipants]);

  const toggleVideo = useCallback(async () => {
    if (isDemo) {
      setIsVideoMuted((muted) => {
        setParticipants((current) =>
          current.map((participant) =>
            participant.isLocal
              ? { ...participant, videoMuted: !muted }
              : participant,
          ),
        );
        return !muted;
      });
      return;
    }

    const track = conferenceRef.current
      ?.getLocalTracks("video")
      .find((candidate) => candidate.getVideoType?.() !== "desktop");

    if (!track) {
      setError("Камера не была подключена при входе");
      return;
    }

    if (track.isMuted()) {
      await track.unmute?.();
    } else {
      await track.mute?.();
    }
    syncParticipants();
  }, [isDemo, syncParticipants]);

  const toggleScreenShare = useCallback(async () => {
    if (isDemo) {
      setIsScreenSharing((sharing) => {
        setParticipants((current) =>
          current.map((participant) =>
            participant.isLocal
              ? { ...participant, isScreenSharing: !sharing }
              : participant,
          ),
        );
        return !sharing;
      });
      return;
    }

    const conference = conferenceRef.current;
    const library = libraryRef.current;

    if (!conference || !library) {
      return;
    }

    const currentDesktop = conference
      .getLocalTracks("video")
      .find((track) => track.getVideoType?.() === "desktop");

    if (currentDesktop) {
      desktopRemovalRef.current.add(currentDesktop);
      await conference.removeTrack(currentDesktop);
      await currentDesktop.dispose();
      syncParticipants();
      return;
    }

    try {
      const [desktopTrack] = await library.createLocalTracks({
        devices: ["desktop"],
      });

      if (!desktopTrack) {
        return;
      }

      const stoppedEvent = library.events.track.LOCAL_TRACK_STOPPED;

      if (stoppedEvent) {
        desktopTrack.addEventListener?.(stoppedEvent, async () => {
          if (desktopRemovalRef.current.has(desktopTrack)) {
            return;
          }

          desktopRemovalRef.current.add(desktopTrack);
          await conference.removeTrack(desktopTrack).catch(() => undefined);
          await desktopTrack.dispose().catch(() => undefined);
          syncParticipants();
        });
      }

      await conference.addTrack(desktopTrack);
      syncParticipants();
    } catch {
      setError("Не удалось начать показ экрана");
    }
  }, [isDemo, syncParticipants]);

  const leave = useCallback(async () => {
    if (!isDemo) {
      await teardown();
    }
    setParticipants([]);
    setStatus("left");
  }, [isDemo, teardown]);

  useEffect(
    () => () => {
      if (!isDemo) {
        void teardown();
      }
    },
    [isDemo, teardown],
  );

  return {
    error,
    isAudioMuted,
    isDemo,
    isScreenSharing,
    isVideoMuted,
    join,
    leave,
    participants,
    status,
    toggleAudio,
    toggleScreenShare,
    toggleVideo,
  };
}
