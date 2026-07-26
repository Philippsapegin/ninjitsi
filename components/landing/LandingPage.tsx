"use client";

import { FormEvent, useState } from "react";
import {
  ArrowRight,
  Camera,
  LoaderCircle,
  LockKeyhole,
  LogIn,
  MessageCircle,
  Mic,
  MonitorUp,
  PhoneOff,
  Plus,
  Send,
  ShieldCheck,
  Video,
} from "lucide-react";
import { Brand } from "@/components/brand/Brand";
import { ProfileEditor } from "@/components/profile/ProfileEditor";
import { saveClientProfile } from "@/lib/profiles";
import type { ProfileDraft } from "@/lib/profiles";
import { normalizeRoomName, savePendingJoin } from "@/lib/room";
import { createRoom, getRoom, RoomApiError } from "@/lib/roomApi";
import styles from "./LandingPage.module.css";

const previewPeople = [
  { name: "Лера", tone: "violet" },
  { name: "Миша", tone: "blue" },
  { name: "Таня", tone: "sand" },
  { name: "Костя", tone: "mint" },
  { name: "Аня", tone: "coral" },
  { name: "Сергей", tone: "slate" },
];

type LandingMode = "create" | "join";

export function LandingPage() {
  const [mode, setMode] = useState<LandingMode>("create");
  const [roomName, setRoomName] = useState("");
  const [profile, setProfile] = useState<ProfileDraft>({
    avatarDataUrl: "",
    displayName: "",
    profileId: "",
  });
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedRoom = normalizeRoomName(roomName);

    if (
      !profile.displayName.trim() ||
      (mode === "join" && !normalizedRoom) ||
      isBusy
    ) {
      return;
    }

    setError("");
    setIsBusy(true);

    try {
      const targetRoom =
        mode === "create"
          ? (await createRoom(password)).room.code
          : (await getRoom(normalizedRoom)).code;
      const savedProfile = saveClientProfile(profile);

      savePendingJoin({
        avatarDataUrl: savedProfile.avatarDataUrl,
        displayName: savedProfile.displayName,
        password,
        profileId: savedProfile.id,
        startAudioMuted: false,
        startVideoMuted: false,
      });

      window.location.assign(`/room/${encodeURIComponent(targetRoom)}`);
    } catch (caughtError) {
      setError(
        caughtError instanceof RoomApiError
          ? caughtError.message
          : "Не удалось связаться с сервером комнат.",
      );
      setIsBusy(false);
    }
  }

  function selectMode(nextMode: LandingMode) {
    setMode(nextMode);
    setError("");
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Brand />
        <span className={styles.headerNote}>
          Спокойные видеовстречи для компьютера
        </span>
      </header>

      <section className={styles.hero}>
        <div className={styles.copy}>
          <div className={styles.eyebrow}>
            <span className={styles.eyebrowDot} />
            Простой клиент поверх Jitsi
          </div>
          <h1>
            <span>Проще</span>
            <span>некуда</span>
          </h1>

          <form className={styles.form} onSubmit={(event) => void submit(event)}>
            <div aria-label="Действие с комнатой" className={styles.modeSwitch}>
              <button
                aria-pressed={mode === "create"}
                className={mode === "create" ? styles.modeActive : ""}
                onClick={() => selectMode("create")}
                type="button"
              >
                <Plus size={15} />
                Создать
              </button>
              <button
                aria-pressed={mode === "join"}
                className={mode === "join" ? styles.modeActive : ""}
                onClick={() => selectMode("join")}
                type="button"
              >
                <LogIn size={15} />
                Войти по коду
              </button>
            </div>

            {mode === "join" && (
              <label className={styles.field}>
                <span>Код комнаты</span>
                <input
                  aria-label="Код комнаты"
                  autoComplete="off"
                  onChange={(event) => setRoomName(event.target.value)}
                  placeholder="Например, quiet-studio-04210"
                  spellCheck={false}
                  value={roomName}
                />
              </label>
            )}

            <ProfileEditor onChange={setProfile} value={profile} />

            <label className={styles.field}>
              <span className={styles.passwordLabel}>
                Пароль
                <em>необязательно</em>
              </span>
              <div className={styles.inputWithIcon}>
                <LockKeyhole size={17} />
                <input
                  aria-label="Пароль комнаты"
                  autoComplete="off"
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Оставьте пустым для открытой комнаты"
                  type="password"
                  value={password}
                />
              </div>
            </label>

            {error && <div className={styles.formError}>{error}</div>}

            <button
              className={styles.primaryButton}
              disabled={
                !profile.displayName.trim() ||
                (mode === "join" && !normalizeRoomName(roomName)) ||
                isBusy
              }
              type="submit"
            >
              <span>
                {isBusy
                  ? "Связываемся с сервером"
                  : mode === "create"
                    ? "Создать комнату"
                    : "Войти в комнату"}
              </span>
              {isBusy ? (
                <LoaderCircle className={styles.spinner} size={18} />
              ) : (
                <ArrowRight size={18} strokeWidth={2.2} />
              )}
            </button>
          </form>

          <div className={styles.assurances}>
            <span>
              <ShieldCheck size={16} />
              Без регистрации
            </span>
            <span>
              <Video size={16} />
              Код выдаёт сервер
            </span>
          </div>
        </div>

        <div className={styles.previewColumn}>
          <div className={styles.previewGlow} />
          <div className={styles.previewWindow} data-landing-preview>
            <div className={styles.previewTopbar}>
              <span className={styles.previewRoom}>small-studio-24</span>
              <span className={styles.previewLive}>
                <i />
                6 в комнате
              </span>
            </div>
            <div className={styles.previewWorkspace}>
              <div className={styles.previewGrid}>
                {previewPeople.map((person) => (
                  <div
                    className={`${styles.previewTile} ${styles[person.tone]}`}
                    key={person.name}
                  >
                    <span className={styles.previewAvatar}>
                      {person.name.slice(0, 1)}
                    </span>
                    <span className={styles.previewName}>{person.name}</span>
                  </div>
                ))}
              </div>
              <aside className={styles.previewChat}>
                <header>
                  <MessageCircle size={13} />
                  <strong>Чат</strong>
                </header>
                <div className={styles.previewMessages}>
                  <article>
                    <i>Л</i>
                    <div>
                      <strong>Лера</strong>
                      <p>Всем видно экран?</p>
                    </div>
                  </article>
                  <article>
                    <i>М</i>
                    <div>
                      <strong>Миша</strong>
                      <p>Да, всё отлично.</p>
                    </div>
                  </article>
                </div>
                <div className={styles.previewComposer}>
                  <span>Сообщение…</span>
                  <Send size={11} />
                </div>
              </aside>
            </div>
            <div className={styles.previewControls}>
              <span><Mic size={16} /></span>
              <span><Camera size={16} /></span>
              <span><MonitorUp size={16} /></span>
              <i />
              <span className={styles.previewHangup}><PhoneOff size={17} /></span>
            </div>
          </div>
          <p className={styles.previewCaption}>Всё перед глазами</p>
        </div>
      </section>
    </main>
  );
}
