"use client";

import { FormEvent, useState } from "react";
import { ArrowRight, LockKeyhole, ShieldCheck, Video } from "lucide-react";
import { useRouter } from "next/navigation";
import { Brand } from "@/components/brand/Brand";
import {
  normalizeRoomName,
  savePendingJoin,
} from "@/lib/room";
import styles from "./LandingPage.module.css";

const previewPeople = [
  { name: "Лера", tone: "violet" },
  { name: "Миша", tone: "blue" },
  { name: "Таня", tone: "sand" },
  { name: "Костя", tone: "mint" },
  { name: "Аня", tone: "coral" },
  { name: "Вы", tone: "slate" },
];

function makeRoomName() {
  const first = ["quiet", "open", "small", "soft", "clear"];
  const second = ["studio", "kitchen", "signal", "circle", "room"];
  const pick = (values: string[]) =>
    values[Math.floor(Math.random() * values.length)];

  return `${pick(first)}-${pick(second)}-${Math.floor(10 + Math.random() * 89)}`;
}

export function LandingPage() {
  const router = useRouter();
  const [roomName, setRoomName] = useState(makeRoomName);
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedRoom = normalizeRoomName(roomName);

    if (!normalizedRoom || !displayName.trim()) {
      return;
    }

    savePendingJoin({
      displayName: displayName.trim(),
      password,
      startAudioMuted: false,
      startVideoMuted: false,
    });

    router.push(`/room/${encodeURIComponent(normalizedRoom)}`);
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
            Свой клиент поверх Jitsi
          </div>
          <h1>
            Все собеседники
            <span> перед глазами.</span>
          </h1>
          <p className={styles.lead}>
            Никаких боковых лент и спрятанных участников. Только ровная сетка
            16:9, которая сама собирается под размер разговора.
          </p>

          <form className={styles.form} onSubmit={submit}>
            <div className={styles.fieldRow}>
              <label className={styles.field}>
                <span>Комната</span>
                <input
                  aria-label="Название комнаты"
                  autoComplete="off"
                  onChange={(event) => setRoomName(event.target.value)}
                  spellCheck={false}
                  value={roomName}
                />
              </label>
              <label className={styles.field}>
                <span>Ваше имя</span>
                <input
                  aria-label="Ваше имя"
                  autoComplete="name"
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="Как вас представить?"
                  value={displayName}
                />
              </label>
            </div>

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

            <button
              className={styles.primaryButton}
              disabled={!displayName.trim() || !normalizeRoomName(roomName)}
              type="submit"
            >
              Войти в комнату
              <ArrowRight size={18} strokeWidth={2.2} />
            </button>
          </form>

          <div className={styles.assurances}>
            <span>
              <ShieldCheck size={16} />
              Без регистрации
            </span>
            <span>
              <Video size={16} />
              Ссылка сразу готова
            </span>
          </div>
        </div>

        <div className={styles.previewColumn}>
          <div className={styles.previewGlow} />
          <div className={styles.previewWindow}>
            <div className={styles.previewTopbar}>
              <span className={styles.previewRoom}>small-studio-24</span>
              <span className={styles.previewLive}>
                <i />
                6 в комнате
              </span>
            </div>
            <div className={styles.previewGrid}>
              {previewPeople.map((person, index) => (
                <div
                  className={`${styles.previewTile} ${styles[person.tone]}`}
                  key={person.name}
                >
                  <span className={styles.previewAvatar}>
                    {person.name.slice(0, 1)}
                  </span>
                  <span className={styles.previewName}>{person.name}</span>
                  {index === 0 && (
                    <span className={styles.speaking}>говорит</span>
                  )}
                </div>
              ))}
            </div>
            <div className={styles.previewControls}>
              <span />
              <span />
              <span className={styles.previewHangup} />
              <span />
              <span />
            </div>
          </div>
          <p className={styles.previewCaption}>
            Плитки всегда 16:9 и занимают максимум доступного пространства.
          </p>
        </div>
      </section>
    </main>
  );
}
