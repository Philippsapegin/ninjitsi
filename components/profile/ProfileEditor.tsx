"use client";

import {
  type ChangeEvent,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ImagePlus,
  Palette,
  Plus,
  Trash2,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import {
  DEFAULT_PROFILE_TILE_COLOR,
  deleteClientProfile,
  normalizeProfileTileColor,
  prepareAvatar,
  prepareVideoBackground,
  profileToDraft,
  readClientProfiles,
  readProfileBackground,
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

const TILE_COLOR_PRESETS = [
  "#485D78",
  "#6B576F",
  "#6D614B",
  "#466B5F",
  "#735153",
  "#52606B",
  "#574C82",
  "#326E72",
];

function emptyProfile(): ProfileDraft {
  return {
    avatarDataUrl: "",
    displayName: "",
    profileId: "",
    tileColor: DEFAULT_PROFILE_TILE_COLOR,
    videoBackgroundDataUrl: "",
    videoBackgroundRevision: "",
  };
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
  tileColor,
}: {
  avatarDataUrl: string;
  displayName: string;
  tileColor: string;
}) {
  return avatarDataUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img alt="" src={avatarDataUrl} />
  ) : (
    <span style={{ backgroundColor: tileColor }}>{initials(displayName)}</span>
  );
}

export function ProfileEditor({
  autoFocus = false,
  onChange,
  value,
}: ProfileEditorProps) {
  const { tr } = useI18n();
  const [profiles, setProfiles] = useState<ClientProfile[]>([]);
  const [assetError, setAssetError] = useState("");
  const [backgroundOpen, setBackgroundOpen] = useState(false);
  const [backgroundLoading, setBackgroundLoading] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
  const [colorText, setColorText] = useState(value.tileColor);
  const [dragActive, setDragActive] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const backgroundInputRef = useRef<HTMLInputElement>(null);
  const colorPickerRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);
  const valueRef = useRef(value);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    if (initializedRef.current) {
      return;
    }

    initializedRef.current = true;
    queueMicrotask(() => {
      const savedProfiles = readClientProfiles();
      const selected = readSelectedProfile();
      const currentProfile = savedProfiles.find(
        (profile) => profile.id === value.profileId,
      );

      setProfiles(savedProfiles);
      if (currentProfile ?? selected) {
        onChange(profileToDraft(currentProfile ?? selected!));
      } else {
        onChange(emptyProfile());
      }
    });
  }, [onChange, value.profileId]);

  useEffect(() => {
    if (!colorOpen) {
      return;
    }

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (
        event.target instanceof Node &&
        !colorPickerRef.current?.contains(event.target)
      ) {
        setColorOpen(false);
      }
    };

    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [colorOpen]);

  async function chooseAvatar(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    event.target.value = "";
    if (!file) {
      return;
    }

    setAssetError("");

    try {
      onChange({
        ...valueRef.current,
        avatarDataUrl: await prepareAvatar(file),
      });
    } catch (caughtError) {
      setAssetError(
        caughtError instanceof Error
          ? caughtError.message
          : tr("Could not read the image", "Не удалось прочитать изображение"),
      );
    }
  }

  async function chooseBackgroundFile(file: File) {
    setAssetError("");
    setBackgroundLoading(true);

    try {
      const prepared = await prepareVideoBackground(file);

      onChange({
        ...valueRef.current,
        videoBackgroundDataUrl: prepared.dataUrl,
        videoBackgroundRevision: prepared.revision,
      });
    } catch (caughtError) {
      setAssetError(
        caughtError instanceof Error
          ? caughtError.message
          : tr("Could not read the background", "Не удалось прочитать фон"),
      );
    } finally {
      setBackgroundLoading(false);
    }
  }

  async function chooseBackground(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    event.target.value = "";
    if (file) {
      await chooseBackgroundFile(file);
    }
  }

  async function openBackgroundEditor() {
    setAssetError("");
    setBackgroundOpen(true);

    if (
      value.videoBackgroundDataUrl === undefined &&
      value.profileId &&
      value.videoBackgroundRevision
    ) {
      setBackgroundLoading(true);
      const profileId = value.profileId;
      const dataUrl = await readProfileBackground(profileId);

      if (valueRef.current.profileId === profileId) {
        onChange({
          ...valueRef.current,
          videoBackgroundDataUrl: dataUrl,
          videoBackgroundRevision: dataUrl
            ? valueRef.current.videoBackgroundRevision
            : "",
        });
      }
      setBackgroundLoading(false);
    }
  }

  function handleBackgroundDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer.files[0];

    if (file) {
      void chooseBackgroundFile(file);
    }
  }

  function applyTileColor() {
    if (!/^#[0-9a-f]{6}$/i.test(colorText)) {
      setAssetError(
        tr(
          "Enter a HEX color in the form #485D78",
          "Введите HEX-цвет в формате #485D78",
        ),
      );
      setColorText(value.tileColor);
      return;
    }

    const tileColor = normalizeProfileTileColor(colorText);

    setAssetError("");
    setColorText(tileColor);
    onChange({ ...valueRef.current, tileColor });
  }

  function handleColorKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      applyTileColor();
    }
  }

  function toggleColorPicker() {
    if (!colorOpen) {
      setColorText(value.tileColor);
    }
    setColorOpen(!colorOpen);
  }

  function selectProfile(profile: ClientProfile) {
    setAssetError("");
    setBackgroundOpen(false);
    setColorOpen(false);
    onChange(profileToDraft(profile));
  }

  function deleteSelectedProfile(profile: ClientProfile) {
    const nextSelected = deleteClientProfile(profile.id);
    const nextProfiles = readClientProfiles();

    setAssetError("");
    setProfiles(nextProfiles);
    onChange(nextSelected ? profileToDraft(nextSelected) : emptyProfile());
  }

  return (
    <section className={styles.editor} data-profile-editor>
      <div className={styles.heading}>
        <span>{tr("Profile", "Профиль")}</span>
        <button
          onClick={() => {
            setAssetError("");
            setBackgroundOpen(false);
            setColorOpen(false);
            onChange(emptyProfile());
          }}
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
                    tileColor={profile.tileColor}
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
        <div className={styles.avatarCluster}>
          <button
            aria-label={
              value.avatarDataUrl
                ? tr("Change avatar", "Сменить аватарку")
                : tr("Upload avatar", "Загрузить аватарку")
            }
            className={styles.avatarButton}
            onClick={() => avatarInputRef.current?.click()}
            type="button"
          >
            {value.avatarDataUrl ? (
              <ProfileAvatar
                avatarDataUrl={value.avatarDataUrl}
                displayName={value.displayName}
                tileColor={value.tileColor}
              />
            ) : (
              <UserRound size={22} />
            )}
            <i>
              <ImagePlus size={12} />
            </i>
          </button>

          <div className={styles.colorPicker} ref={colorPickerRef}>
            <button
              aria-expanded={colorOpen}
              aria-label={tr("Tile color", "Цвет плитки")}
              className={styles.appearanceButton}
              onClick={toggleColorPicker}
              style={{ "--profile-color": value.tileColor } as CSSProperties}
              title={tr("Tile color", "Цвет плитки")}
              type="button"
            >
              <Palette size={11} />
            </button>
            {colorOpen && (
              <div
                aria-label={tr("Choose tile color", "Выбор цвета плитки")}
                className={styles.colorPopover}
                role="dialog"
              >
                <strong>{tr("Tile color", "Цвет плитки")}</strong>
                <div className={styles.colorPresets}>
                  {TILE_COLOR_PRESETS.map((color) => (
                    <button
                      aria-label={color}
                      aria-pressed={value.tileColor === color}
                      key={color}
                      onClick={() => {
                        setColorText(color);
                        setAssetError("");
                        onChange({ ...valueRef.current, tileColor: color });
                      }}
                      style={{ backgroundColor: color }}
                      type="button"
                    />
                  ))}
                </div>
                <label>
                  <span>HEX</span>
                  <input
                    aria-label={tr("HEX tile color", "HEX-цвет плитки")}
                    maxLength={7}
                    onBlur={applyTileColor}
                    onChange={(event) =>
                      setColorText(event.target.value.toUpperCase())
                    }
                    onKeyDown={handleColorKeyDown}
                    placeholder="#485D78"
                    spellCheck={false}
                    value={colorText}
                  />
                </label>
              </div>
            )}
          </div>

          <button
            aria-label={
              value.videoBackgroundRevision
                ? tr("Change video background", "Сменить видеофон")
                : tr("Add video background", "Добавить видеофон")
            }
            className={`${styles.appearanceButton} ${styles.backgroundButton} ${
              value.videoBackgroundRevision ? styles.assetPresent : ""
            }`}
            onClick={() => void openBackgroundEditor()}
            title={tr("Video background", "Видеофон")}
            type="button"
          >
            <ImagePlus size={11} />
          </button>
        </div>

        <label className={styles.nameField}>
          <span>{tr("Your name", "Ваше имя")}</span>
          <input
            aria-label={tr("Your name", "Ваше имя")}
            autoComplete="name"
            autoFocus={autoFocus}
            onChange={(event) =>
              onChange({ ...valueRef.current, displayName: event.target.value })
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
        ref={avatarInputRef}
        type="file"
      />
      <input
        accept=".jpg,.jpeg,.png,.gif,image/jpeg,image/png,image/gif"
        className={styles.fileInput}
        onChange={(event) => void chooseBackground(event)}
        ref={backgroundInputRef}
        type="file"
      />
      {assetError && !backgroundOpen && (
        <span className={styles.error}>{assetError}</span>
      )}

      {backgroundOpen && (
        <div
          className={styles.backgroundBackdrop}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setBackgroundOpen(false);
            }
          }}
        >
          <section
            aria-label={tr("Video background", "Видеофон")}
            className={styles.backgroundDialog}
            role="dialog"
          >
            <header>
              <div>
                <strong>{tr("Video background", "Видеофон")}</strong>
                <span>
                  {tr(
                    "Shown to everyone while your camera is off",
                    "Показывается всем, пока камера выключена",
                  )}
                </span>
              </div>
              <button
                aria-label={tr("Close", "Закрыть")}
                onClick={() => setBackgroundOpen(false)}
                type="button"
              >
                <X size={16} />
              </button>
            </header>

            <button
              className={`${styles.backgroundDropzone} ${
                dragActive ? styles.dragActive : ""
              }`}
              disabled={backgroundLoading}
              onClick={() => backgroundInputRef.current?.click()}
              onDragEnter={(event) => {
                event.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={(event) => {
                event.preventDefault();
                if (
                  !(event.relatedTarget instanceof Node) ||
                  !event.currentTarget.contains(event.relatedTarget)
                ) {
                  setDragActive(false);
                }
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={handleBackgroundDrop}
              type="button"
            >
              {value.videoBackgroundDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img alt="" src={value.videoBackgroundDataUrl} />
              ) : (
                <div>
                  <Upload size={24} />
                  <strong>
                    {backgroundLoading
                      ? tr("Loading background…", "Загружаем фон…")
                      : tr(
                          "Drop an image here",
                          "Перетащите изображение сюда",
                        )}
                  </strong>
                  <span>
                    {tr(
                      "or click to choose · JPG, PNG, GIF · up to 3 MB",
                      "или нажмите для выбора · JPG, PNG, GIF · до 3 МБ",
                    )}
                  </span>
                </div>
              )}
              {value.videoBackgroundDataUrl && (
                <span className={styles.replaceHint}>
                  {tr(
                    "Click or drop to replace",
                    "Нажмите или перетащите для замены",
                  )}
                </span>
              )}
            </button>

            <div className={styles.backgroundMeta}>
              <span>
                {tr(
                  "Frame: 16:9 · fills the entire tile",
                  "Кадр: 16:9 · заполняет всю плитку",
                )}
              </span>
              {value.videoBackgroundRevision && (
                <button
                  onClick={() => {
                    setAssetError("");
                    onChange({
                      ...valueRef.current,
                      videoBackgroundDataUrl: "",
                      videoBackgroundRevision: "",
                    });
                  }}
                  type="button"
                >
                  <Trash2 size={13} />
                  {tr("Remove", "Удалить")}
                </button>
              )}
            </div>
            {assetError && <span className={styles.error}>{assetError}</span>}
          </section>
        </div>
      )}
    </section>
  );
}
