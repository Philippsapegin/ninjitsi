"use client";

import { ChangeEvent, useEffect, useRef, useState } from "react";
import { ImagePlus, Plus, UserRound } from "lucide-react";
import {
  prepareAvatar,
  profileToDraft,
  readClientProfiles,
  readSelectedProfile,
} from "@/lib/profiles";
import type { ClientProfile, ProfileDraft } from "@/lib/profiles";
import styles from "./ProfileEditor.module.css";

interface ProfileEditorProps {
  autoFocus?: boolean;
  onChange: (profile: ProfileDraft) => void;
  value: ProfileDraft;
}

function initials(name: string) {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "?"
  );
}

function ProfileAvatar({
  avatarDataUrl,
  displayName,
}: {
  avatarDataUrl: string;
  displayName: string;
}) {
  return avatarDataUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img alt="" src={avatarDataUrl} />
  ) : (
    <span>{initials(displayName)}</span>
  );
}

export function ProfileEditor({
  autoFocus = false,
  onChange,
  value,
}: ProfileEditorProps) {
  const [profiles, setProfiles] = useState<ClientProfile[]>([]);
  const [avatarError, setAvatarError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (initializedRef.current) {
      return;
    }

    initializedRef.current = true;
    queueMicrotask(() => {
      const savedProfiles = readClientProfiles();
      const selected = readSelectedProfile();

      setProfiles(savedProfiles);
      if (!value.profileId && !value.displayName && selected) {
        onChange(profileToDraft(selected));
      }
    });
  }, [onChange, value.displayName, value.profileId]);

  async function chooseAvatar(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    event.target.value = "";
    if (!file) {
      return;
    }

    setAvatarError("");

    try {
      onChange({ ...value, avatarDataUrl: await prepareAvatar(file) });
    } catch (caughtError) {
      setAvatarError(
        caughtError instanceof Error
          ? caughtError.message
          : "Не удалось прочитать изображение",
      );
    }
  }

  function selectProfile(profile: ClientProfile) {
    setAvatarError("");
    onChange(profileToDraft(profile));
  }

  return (
    <section className={styles.editor}>
      <div className={styles.heading}>
        <span>Профиль</span>
        <button
          onClick={() =>
            onChange({
              avatarDataUrl: "",
              displayName: "",
              profileId: "",
            })
          }
          type="button"
        >
          <Plus size={13} />
          Новый
        </button>
      </div>

      {profiles.length > 0 && (
        <div aria-label="Сохранённые профили" className={styles.saved}>
          {profiles.map((profile) => (
            <button
              aria-label={`Выбрать профиль ${profile.displayName}`}
              aria-pressed={profile.id === value.profileId}
              className={
                profile.id === value.profileId ? styles.selected : ""
              }
              key={profile.id}
              onClick={() => selectProfile(profile)}
              title={profile.displayName}
              type="button"
            >
              <ProfileAvatar
                avatarDataUrl={profile.avatarDataUrl}
                displayName={profile.displayName}
              />
            </button>
          ))}
        </div>
      )}

      <div className={styles.profileFields}>
        <button
          aria-label={value.avatarDataUrl ? "Сменить аватарку" : "Загрузить аватарку"}
          className={styles.avatarButton}
          onClick={() => fileInputRef.current?.click()}
          type="button"
        >
          {value.avatarDataUrl ? (
            <ProfileAvatar
              avatarDataUrl={value.avatarDataUrl}
              displayName={value.displayName}
            />
          ) : (
            <UserRound size={22} />
          )}
          <i>
            <ImagePlus size={12} />
          </i>
        </button>

        <label className={styles.nameField}>
          <span>Ваше имя</span>
          <input
            aria-label="Ваше имя"
            autoComplete="name"
            autoFocus={autoFocus}
            onChange={(event) =>
              onChange({ ...value, displayName: event.target.value })
            }
            placeholder="Как вас представить?"
            value={value.displayName}
          />
        </label>
      </div>

      <input
        accept="image/*"
        className={styles.fileInput}
        onChange={(event) => void chooseAvatar(event)}
        ref={fileInputRef}
        type="file"
      />
      {avatarError && <span className={styles.error}>{avatarError}</span>}
    </section>
  );
}
