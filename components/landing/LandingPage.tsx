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
import { useI18n } from "@/lib/i18n";
import { saveClientProfile } from "@/lib/profiles";
import type { ProfileDraft } from "@/lib/profiles";
import {
  normalizeRoomName,
  rememberCreatedRoom,
  savePendingJoin,
} from "@/lib/room";
import { createRoom, getRoom, RoomApiError } from "@/lib/roomApi";
import styles from "./LandingPage.module.css";

type LandingMode = "create" | "join";

export function LandingPage() {
  const { locale, setLocale, tr } = useI18n();
  const [mode, setMode] = useState<LandingMode>("create");
  const [roomName, setRoomName] = useState("");
  const [profile, setProfile] = useState<ProfileDraft>({
    avatarDataUrl: "",
    displayName: "",
    profileId: "",
  });
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [error, setError] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const previewPeople = [
    { name: tr("Laura", "Лера"), tone: "violet" },
    { name: tr("Michael", "Миша"), tone: "blue" },
    { name: tr("Tanya", "Таня"), tone: "sand" },
    { name: tr("Kostya", "Костя"), tone: "mint" },
    { name: tr("Anna", "Аня"), tone: "coral" },
    { name: tr("Sergey", "Сергей"), tone: "slate" },
  ];

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
      let targetRoom: string;

      if (mode === "create") {
        targetRoom = (await createRoom(password)).room.code;
        rememberCreatedRoom(targetRoom, password);
      } else {
        targetRoom = (await getRoom(normalizedRoom)).code;
      }
      const savedProfile = saveClientProfile(profile);

      savePendingJoin({
        avatarDataUrl: savedProfile.avatarDataUrl,
        displayName: savedProfile.displayName,
        isCreator: mode === "create",
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
          : tr(
              "Could not reach the room server.",
              "Не удалось связаться с сервером комнат.",
            ),
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
        <div
          aria-label={tr("Language", "Язык")}
          className={styles.languageToggle}
        >
          <button
            aria-label="Русский"
            aria-pressed={locale === "ru"}
            className={locale === "ru" ? styles.languageActive : ""}
            onClick={() => setLocale("ru")}
            type="button"
          >
            RU
          </button>
          <button
            aria-label="English"
            aria-pressed={locale === "en"}
            className={locale === "en" ? styles.languageActive : ""}
            onClick={() => setLocale("en")}
            type="button"
          >
            EN
          </button>
        </div>
      </header>

      <section className={styles.hero}>
        <div className={styles.copy}>
          <div className={styles.eyebrow}>
            <span className={styles.eyebrowDot} />
            {tr("A simple client for Jitsi", "Простой клиент поверх Jitsi")}
          </div>
          <h1>{tr("Couldn't be simpler", "Проще некуда")}</h1>

          <form className={styles.form} onSubmit={(event) => void submit(event)}>
            <div
              aria-label={tr("Room action", "Действие с комнатой")}
              className={styles.modeSwitch}
              data-mode={mode}
            >
              <button
                aria-pressed={mode === "create"}
                className={mode === "create" ? styles.modeActive : ""}
                onClick={() => selectMode("create")}
                type="button"
              >
                <Plus size={15} />
                {tr("Create", "Создать")}
              </button>
              <button
                aria-pressed={mode === "join"}
                className={mode === "join" ? styles.modeActive : ""}
                onClick={() => selectMode("join")}
                type="button"
              >
                <LogIn size={15} />
                {tr("Join with a code", "Войти по коду")}
              </button>
            </div>

            <ProfileEditor onChange={setProfile} value={profile} />

            <div
              aria-hidden={mode !== "join"}
              className={`${styles.roomCodeReveal} ${
                mode === "join" ? styles.roomCodeRevealOpen : ""
              }`}
            >
              <div>
                <label className={styles.field}>
                  <span>{tr("Room code", "Код комнаты")}</span>
                  <input
                    aria-label={tr("Room code", "Код комнаты")}
                    autoComplete="off"
                    disabled={mode !== "join"}
                    onChange={(event) => setRoomName(event.target.value)}
                    placeholder={tr(
                      "For example, quiet-studio-04210",
                      "Например, quiet-studio-04210",
                    )}
                    spellCheck={false}
                    value={roomName}
                  />
                </label>
              </div>
            </div>

            <label className={styles.field}>
              <span className={styles.passwordLabel}>
                {tr("Password", "Пароль")}
                <em>{tr("optional", "необязательно")}</em>
              </span>
              <div className={styles.inputWithIcon}>
                <button
                  aria-label={tr(
                    "Hold to show password",
                    "Удерживайте, чтобы показать пароль",
                  )}
                  className={styles.passwordReveal}
                  onBlur={() => setPasswordVisible(false)}
                  onPointerCancel={() => setPasswordVisible(false)}
                  onPointerDown={() => setPasswordVisible(true)}
                  onPointerLeave={() => setPasswordVisible(false)}
                  onPointerUp={() => setPasswordVisible(false)}
                  type="button"
                >
                  <LockKeyhole size={17} />
                </button>
                <input
                  aria-label={tr("Room password", "Пароль комнаты")}
                  autoComplete="off"
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={tr(
                    "Leave empty for an open room",
                    "Оставьте пустым для открытой комнаты",
                  )}
                  type={passwordVisible ? "text" : "password"}
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
                  ? tr("Connecting to the server", "Связываемся с сервером")
                  : mode === "create"
                    ? tr("Create room", "Создать комнату")
                    : tr("Join room", "Войти в комнату")}
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
              {tr("No registration", "Без регистрации")}
            </span>
            <span>
              <Video size={16} />
              {tr("Server-issued room code", "Код выдаёт сервер")}
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
                {tr("6 in the room", "6 в комнате")}
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
                  <strong>{tr("Chat", "Чат")}</strong>
                </header>
                <div className={styles.previewMessages}>
                  <article>
                    <i>{tr("L", "Л")}</i>
                    <div>
                      <strong>{tr("Laura", "Лера")}</strong>
                      <p>
                        {tr(
                          "Can everyone see my screen?",
                          "Всем видно экран?",
                        )}
                      </p>
                    </div>
                  </article>
                  <article>
                    <i>{tr("M", "М")}</i>
                    <div>
                      <strong>{tr("Michael", "Миша")}</strong>
                      <p>{tr("Yes, looks great.", "Да, всё отлично.")}</p>
                    </div>
                  </article>
                </div>
                <div className={styles.previewComposer}>
                  <span>{tr("Message…", "Сообщение…")}</span>
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
          <p className={styles.previewCaption}>
            {tr("Everything in sight", "Всё перед глазами")}
          </p>
        </div>
      </section>
    </main>
  );
}
