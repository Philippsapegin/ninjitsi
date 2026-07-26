"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useJitsiServerUrl } from "@/lib/runtimeConfig";
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
  isAudioBusy: boolean;
  isAudioMuted: boolean;
  isDemo: boolean;
  isScreenShareBusy: boolean;
  isScreenSharing: boolean;
  isVideoBusy: boolean;
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

type LocalMediaDevice = "audio" | "video" | "desktop";

function mediaName(device: LocalMediaDevice) {
  if (device === "audio") {
    return "микрофон";
  }

  return device === "video" ? "камеру" : "демонстрацию экрана";
}

function mediaErrorMessage(device: LocalMediaDevice, caughtError: unknown) {
  const rawError =
    caughtError && typeof caughtError === "object"
      ? `${"name" in caughtError ? String(caughtError.name) : ""} ${
          "message" in caughtError ? String(caughtError.message) : ""
        }`
      : String(caughtError ?? "");
  const normalized = rawError.toLowerCase();
  const target = mediaName(device);

  if (
    normalized.includes("permission") ||
    normalized.includes("notallowed") ||
    normalized.includes("denied")
  ) {
    return `Нет разрешения на ${target}. Разрешите доступ в адресной строке Chrome.`;
  }

  if (
    normalized.includes("notfound") ||
    normalized.includes("devicesnotfound") ||
    normalized.includes("no device")
  ) {
    return `Не удалось найти ${target}. Проверьте подключение устройства.`;
  }

  if (
    normalized.includes("notreadable") ||
    normalized.includes("trackstart") ||
    normalized.includes("could not start")
  ) {
    return `Не удалось запустить ${target}: возможно, устройство занято другим приложением.`;
  }

  if (
    device === "desktop" &&
    (normalized.includes("abort") || normalized.includes("cancel"))
  ) {
    return "Выбор экрана отменён.";
  }

  return `Не удалось подключить ${target}.`;
}

async function createLocalTrack(
  library: JitsiMeetJSLibrary,
  device: LocalMediaDevice,
) {
  const tracks = await library.createLocalTracks({
    devices: [device],
    ...(device === "video" ? { resolution: 720 } : {}),
  });
  const track = tracks.find((candidate) =>
    device === "desktop"
      ? candidate.getVideoType?.() === "desktop"
      : candidate.getType() === device,
  );
  const unusedTracks = tracks.filter((candidate) => candidate !== track);

  await Promise.allSettled(
    unusedTracks.map((unusedTrack) => unusedTrack.dispose()),
  );

  if (!track) {
    throw new Error(`Jitsi did not create a ${device} track`);
  }

  return track;
}

function pickPreferredVideo(tracks: JitsiTrackLike[]) {
  const videoTracks = tracks.filter((track) => track.getType() === "video");
  const activeDesktop = videoTracks.find(
    (track) =>
      track.getVideoType?.() === "desktop" &&
      !track.isMuted(),
  );
  const camera = videoTracks.find(
    (track) => track.getVideoType?.() !== "desktop",
  );

  return activeDesktop ?? camera ?? videoTracks[0];
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
  const serverUrl = useJitsiServerUrl();
  const isDemo = !serverUrl;
  const [status, setStatus] = useState<MeetingStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [participants, setParticipants] = useState<ParticipantView[]>([]);
  const [isAudioBusy, setIsAudioBusy] = useState(false);
  const [isAudioMuted, setIsAudioMuted] = useState(false);
  const [isVideoBusy, setIsVideoBusy] = useState(false);
  const [isVideoMuted, setIsVideoMuted] = useState(false);
  const [isScreenShareBusy, setIsScreenShareBusy] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const connectionRef = useRef<JitsiConnectionLike | null>(null);
  const conferenceRef = useRef<JitsiConferenceLike | null>(null);
  const libraryRef = useRef<JitsiMeetJSLibrary | null>(null);
  const localIdRef = useRef("local");
  const localNameRef = useRef("Вы");
  const dominantSpeakerRef = useRef<string | null>(null);
  const disposedRef = useRef(false);
  const desktopRemovalRef = useRef(new WeakSet<JitsiTrackLike>());
  const audioBusyRef = useRef(false);
  const videoBusyRef = useRef(false);
  const screenShareBusyRef = useRef(false);

  const setMediaBusy = useCallback(
    (device: LocalMediaDevice, busy: boolean) => {
      if (device === "audio") {
        audioBusyRef.current = busy;
        setIsAudioBusy(busy);
      } else if (device === "video") {
        videoBusyRef.current = busy;
        setIsVideoBusy(busy);
      } else {
        screenShareBusyRef.current = busy;
        setIsScreenShareBusy(busy);
      }
    },
    [],
  );

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
          videoMuted: videoTrack
            ? videoTrack.isMuted()
            : participant.isVideoMuted(),
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
        track.getVideoType?.() === "desktop" &&
        !track.isMuted(),
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
        videoMuted: localVideo ? localVideo.isMuted() : true,
        videoTrack: localVideo,
      },
      ...remote,
    ]);
  }, []);

  const scheduleParticipantSync = useCallback(() => {
    syncParticipants();
    queueMicrotask(syncParticipants);
  }, [syncParticipants]);

  const teardown = useCallback(async () => {
    disposedRef.current = true;
    const conference = conferenceRef.current;
    const connection = connectionRef.current;

    conferenceRef.current = null;
    connectionRef.current = null;
    setMediaBusy("audio", false);
    setMediaBusy("video", false);
    setMediaBusy("desktop", false);

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
  }, [setMediaBusy]);

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
      let discardInitialTracks: (() => void) | undefined;

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

        setIsAudioMuted(options.startAudioMuted);
        setIsVideoMuted(options.startVideoMuted);
        setMediaBusy("audio", true);
        setMediaBusy("video", true);

        const initialTracksPromise = Promise.all(
          (
            [
              {
                device: "audio",
                startMuted: options.startAudioMuted,
              },
              {
                device: "video",
                startMuted: options.startVideoMuted,
              },
            ] as const
          ).map(async ({ device, startMuted }) => {
            try {
              const track = await createLocalTrack(library, device);

              if (startMuted) {
                await track.mute();
              }

              return { device, ok: true as const, track };
            } catch (trackError) {
              return {
                device,
                error: trackError,
                ok: false as const,
              };
            }
          }),
        );
        let initialTracksClaimed = false;

        discardInitialTracks = () => {
          if (initialTracksClaimed) {
            return;
          }

          initialTracksClaimed = true;
          void initialTracksPromise.then(async (results) => {
            await Promise.allSettled(
              results.flatMap((result) =>
                result.ok ? [result.track.dispose()] : [],
              ),
            );
            setMediaBusy("audio", false);
            setMediaBusy("video", false);
          });
        };

        const connection = new library.JitsiConnection(null, null, config);
        const connectionEvents = library.events.connection;

        connectionRef.current = connection;
        setStatus("connecting");

        connection.addEventListener(
          connectionEvents.CONNECTION_ESTABLISHED,
          async (...eventArguments) => {
            initialTracksClaimed = true;
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
              conference.on(eventName, scheduleParticipantSync),
            );

            conference.on(
              conferenceEvents.DOMINANT_SPEAKER_CHANGED,
              (participantId) => {
                dominantSpeakerRef.current =
                  typeof participantId === "string" ? participantId : null;
                syncParticipants();
              },
            );
            if (conferenceEvents.TRACK_UNMUTE_REJECTED) {
              conference.on(
                conferenceEvents.TRACK_UNMUTE_REJECTED,
                () => {
                  setError(
                    "Сервер запретил включить медиапоток. Возможно, в комнате действует модерация.",
                  );
                  syncParticipants();
                },
              );
            }

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

            syncParticipants();
            conference.join(options.password);

            void initialTracksPromise.then(async (results) => {
              const isCurrentConference =
                !disposedRef.current &&
                conferenceRef.current === conference;

              if (!isCurrentConference) {
                await Promise.allSettled(
                  results.flatMap((result) =>
                    result.ok ? [result.track.dispose()] : [],
                  ),
                );
                setMediaBusy("audio", false);
                setMediaBusy("video", false);
                return;
              }

              const failures: string[] = [];

              for (const result of results) {
                if (!result.ok) {
                  failures.push(
                    mediaErrorMessage(result.device, result.error),
                  );
                  setMediaBusy(result.device, false);
                  continue;
                }

                try {
                  await conference.addTrack(result.track);
                } catch (publishError) {
                  await result.track.dispose().catch(() => undefined);
                  failures.push(
                    mediaErrorMessage(result.device, publishError),
                  );
                } finally {
                  setMediaBusy(result.device, false);
                }
              }

              syncParticipants();

              if (failures.length > 0) {
                setError(failures.join(" "));
              }
            });
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
            discardInitialTracks?.();
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
        discardInitialTracks?.();
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : "Не удалось запустить видеовстречу",
        );
        setStatus("failed");
        await teardown();
      }
    },
    [
      isDemo,
      roomName,
      scheduleParticipantSync,
      serverUrl,
      setMediaBusy,
      syncParticipants,
      teardown,
    ],
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

    if (audioBusyRef.current) {
      return;
    }

    const conference = conferenceRef.current;
    const library = libraryRef.current;

    if (!conference || !library) {
      return;
    }

    setError(null);
    setMediaBusy("audio", true);

    try {
      const currentTrack = conference.getLocalTracks("audio").find(Boolean);

      if (currentTrack) {
        if (currentTrack.isMuted()) {
          await currentTrack.unmute();
        } else {
          await currentTrack.mute();
        }
      } else {
        const newTrack = await createLocalTrack(library, "audio");

        if (
          disposedRef.current ||
          conferenceRef.current !== conference
        ) {
          await newTrack.dispose();
          return;
        }

        try {
          await conference.addTrack(newTrack);
        } catch (publishError) {
          await newTrack.dispose().catch(() => undefined);
          throw publishError;
        }
      }
    } catch (caughtError) {
      setError(mediaErrorMessage("audio", caughtError));
    } finally {
      setMediaBusy("audio", false);
      syncParticipants();
    }
  }, [isDemo, setMediaBusy, syncParticipants]);

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

    if (videoBusyRef.current) {
      return;
    }

    const conference = conferenceRef.current;
    const library = libraryRef.current;

    if (!conference || !library) {
      return;
    }

    setError(null);
    setMediaBusy("video", true);

    try {
      const currentTrack = conference
        .getLocalTracks("video")
        .find((candidate) => candidate.getVideoType?.() !== "desktop");

      if (currentTrack) {
        if (currentTrack.isMuted()) {
          await currentTrack.unmute();
        } else {
          await currentTrack.mute();
        }
      } else {
        const newTrack = await createLocalTrack(library, "video");

        if (
          disposedRef.current ||
          conferenceRef.current !== conference
        ) {
          await newTrack.dispose();
          return;
        }

        try {
          await conference.addTrack(newTrack);
        } catch (publishError) {
          await newTrack.dispose().catch(() => undefined);
          throw publishError;
        }
      }
    } catch (caughtError) {
      setError(mediaErrorMessage("video", caughtError));
    } finally {
      setMediaBusy("video", false);
      syncParticipants();
    }
  }, [isDemo, setMediaBusy, syncParticipants]);

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

    if (screenShareBusyRef.current) {
      return;
    }

    const conference = conferenceRef.current;
    const library = libraryRef.current;

    if (!conference || !library) {
      return;
    }

    setError(null);
    setMediaBusy("desktop", true);

    try {
      const currentDesktop = conference
        .getLocalTracks("video")
        .find((track) => track.getVideoType?.() === "desktop");

      if (currentDesktop) {
        desktopRemovalRef.current.add(currentDesktop);
        try {
          await conference.removeTrack(currentDesktop);
        } finally {
          await currentDesktop.dispose().catch(() => undefined);
        }
        return;
      }

      const desktopTrack = await createLocalTrack(library, "desktop");
      const stoppedEvent = library.events.track.LOCAL_TRACK_STOPPED;

      if (stoppedEvent) {
        desktopTrack.addEventListener?.(stoppedEvent, () => {
          if (desktopRemovalRef.current.has(desktopTrack)) {
            return;
          }

          desktopRemovalRef.current.add(desktopTrack);
          void (async () => {
            await conference
              .removeTrack(desktopTrack)
              .catch(() => undefined);
            await desktopTrack.dispose().catch(() => undefined);

            if (conferenceRef.current === conference) {
              syncParticipants();
            }
          })();
        });
      }

      if (
        disposedRef.current ||
        conferenceRef.current !== conference
      ) {
        desktopRemovalRef.current.add(desktopTrack);
        await desktopTrack.dispose();
        return;
      }

      try {
        await conference.addTrack(desktopTrack);
      } catch (publishError) {
        desktopRemovalRef.current.add(desktopTrack);
        await desktopTrack.dispose().catch(() => undefined);
        throw publishError;
      }
    } catch (caughtError) {
      setError(mediaErrorMessage("desktop", caughtError));
    } finally {
      setMediaBusy("desktop", false);
      syncParticipants();
    }
  }, [isDemo, setMediaBusy, syncParticipants]);

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
    isAudioBusy,
    isAudioMuted,
    isDemo,
    isScreenShareBusy,
    isScreenSharing,
    isVideoBusy,
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
