"use client";

import { ChangeEvent, useEffect, useRef, useState } from "react";
import { ImagePlus, Plus, UserRound, X } from "lucide-react";
import {
  deleteClientProfile,
  prepareAvatar,
  profileToDraft,
  readClientProfiles,
  readSelectedProfile,
} from "@/lib/profiles";
import type { ClientProfile, ProfileDraft } from "@/lib/profiles";
import { useI18n } from "@/lib/i18n";
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
  const { tr } = useI18n();
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
      const currentProfileExists = savedProfiles.some(
        (profile) => profile.id === value.profileId,
      );

      if (selected && !currentProfileExists) {
        onChange(profileToDraft(selected));
      } else if (savedProfiles.length === 0 && !value.profileId) {
        onChange({
          avatarDataUrl: "",
          displayName: "",
          profileId: "",
        });
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
          : tr("Could not read the image", "Не удалось прочитать изображение"),
      );
    }
  }

  function selectProfile(profile: ClientProfile) {
    setAvatarError("");
    onChange(profileToDraft(profile));
  }

  function deleteSelectedProfile(profile: ClientProfile) {
    const nextSelected = deleteClientProfile(profile.id);
    const nextProfiles = readClientProfiles();

    setAvatarError("");
    setProfiles(nextProfiles);
    onChange(
      nextSelected
        ? profileToDraft(nextSelected)
        : {
            avatarDataUrl: "",
            displayName: "",
            profileId: "",
          },
    );
  }

  return (
    <section className={styles.editor} data-profile-editor>
      <div className={styles.heading}>
        <span>{tr("Profile", "Профиль")}</span>
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
          {tr("New", "Новый")}
        </button>
      </div>

      {profiles.length > 0 && (
        <div
          aria-label={tr("Saved profiles", "Сохранённые профили")}
          className={styles.saved}
        >
          {profiles.map((profile) => {
            const isSelected = profile.id === value.profileId;

            return (
              <span className={styles.savedProfile} key={profile.id}>
                <button
                  aria-label={`${tr("Select profile", "Выбрать профиль")} ${profile.displayName}`}
                  aria-pressed={isSelected}
                  className={isSelected ? styles.selected : ""}
                  onClick={() => selectProfile(profile)}
                  title={profile.displayName}
                  type="button"
                >
                  <ProfileAvatar
                    avatarDataUrl={profile.avatarDataUrl}
                    displayName={profile.displayName}
                  />
                </button>
                {isSelected && (
                  <button
                    aria-label={`${tr("Delete profile", "Удалить профиль")} ${profile.displayName}`}
                    className={styles.deleteProfile}
                    onClick={() => deleteSelectedProfile(profile)}
                    title={`${tr("Delete profile", "Удалить профиль")} ${profile.displayName}`}
                    type="button"
                  >
                    <X size={8} strokeWidth={3} />
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}

      <div className={styles.profileFields}>
        <button
          aria-label={
            value.avatarDataUrl
              ? tr("Change avatar", "Сменить аватарку")
              : tr("Upload avatar", "Загрузить аватарку")
          }
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
          <span>{tr("Your name", "Ваше имя")}</span>
          <input
            aria-label={tr("Your name", "Ваше имя")}
            autoComplete="name"
            autoFocus={autoFocus}
            onChange={(event) =>
              onChange({ ...value, displayName: event.target.value })
            }
            placeholder={tr(
              "How should we introduce you?",
              "Как вас представить?",
            )}
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
