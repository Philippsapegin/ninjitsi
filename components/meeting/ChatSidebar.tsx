"use client";

import {
  ChangeEvent,
  DragEvent,
  FormEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  LoaderCircle,
  LockKeyhole,
  MessageCircle,
  Paperclip,
  Send,
  Users,
  X,
} from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type {
  ChatAttachment,
  ChatMessage,
  ParticipantView,
  ChatReplyReference,
} from "@/lib/jitsi/types";
import { playNinjitsiSound } from "@/lib/sounds";
import styles from "./ChatSidebar.module.css";

interface ChatSidebarProps {
  disabled: boolean;
  isSendingAttachment: boolean;
  messages: ChatMessage[];
  onSend: (
    text: string,
    recipientIds?: string[],
    replyTo?: ChatReplyReference,
  ) => void;
  onSendAttachment: (
    file: File,
    recipientIds?: string[],
  ) => Promise<void>;
  participants: ParticipantView[];
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

function formatFileSize(size: number, locale: "en" | "ru") {
  if (size < 1024) {
    return `${size} ${locale === "ru" ? "Б" : "B"}`;
  }

  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} ${locale === "ru" ? "КБ" : "KB"}`;
  }

  return `${(size / 1024 / 1024).toFixed(1)} ${locale === "ru" ? "МБ" : "MB"}`;
}

function Attachment({
  attachment,
  onPreview,
}: {
  attachment: ChatAttachment;
  onPreview: (attachment: ChatAttachment) => void;
}) {
  const { locale, tr } = useI18n();
  const isImage = attachment.mimeType.startsWith("image/");

  if (isImage) {
    return (
      <button
        aria-label={`${tr("Open image", "Открыть изображение")} ${attachment.name}`}
        className={`${styles.attachment} ${styles.imageAttachment}`}
        onClick={() => onPreview(attachment)}
        type="button"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img alt={attachment.name} src={attachment.dataUrl} />
      </button>
    );
  }

  return (
    <a
      className={styles.attachment}
      download={attachment.name}
      href={attachment.dataUrl}
      title={`${tr("Download", "Скачать")} ${attachment.name}`}
    >
      <FileText size={18} />
      <span>
        <strong>{attachment.name}</strong>
        <small>{formatFileSize(attachment.size, locale)}</small>
      </span>
    </a>
  );
}

export function ChatSidebar({
  disabled,
  isSendingAttachment,
  messages,
  onSend,
  onSendAttachment,
  participants,
}: ChatSidebarProps) {
  const { locale, tr } = useI18n();
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(true);
  const [dragActive, setDragActive] = useState(false);
  const [recipientMenuOpen, setRecipientMenuOpen] = useState(false);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<ChatReplyReference | undefined>();
  const [resetRecipientsAfterSend, setResetRecipientsAfterSend] =
    useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [previewAttachment, setPreviewAttachment] =
    useState<ChatAttachment | null>(null);
  const [selectedRecipientIds, setSelectedRecipientIds] = useState<string[]>(
    [],
  );
  const listRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recipientPickerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previousMessageCountRef = useRef(messages.length);
  const remoteParticipants = participants.filter(
    (participant) => !participant.isLocal,
  );
  const selectedRecipients = remoteParticipants.filter((participant) =>
    selectedRecipientIds.includes(participant.id),
  );
  const recipientUnavailable =
    selectedRecipientIds.length > 0 && selectedRecipients.length === 0;

  useEffect(() => {
    listRef.current?.scrollTo({
      behavior: "smooth",
      top: listRef.current.scrollHeight,
    });
  }, [messages]);

  useEffect(() => {
    const previousCount = previousMessageCountRef.current;
    const addedCount = Math.max(0, messages.length - previousCount);

    previousMessageCountRef.current = messages.length;
    if (!open && addedCount > 0) {
      setUnreadCount((current) => current + addedCount);
      for (let index = 0; index < addedCount; index += 1) {
        playNinjitsiSound("message");
      }
    }
  }, [messages, open]);

  useEffect(() => {
    if (!recipientMenuOpen) {
      return;
    }

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (
        event.target instanceof Node &&
        !recipientPickerRef.current?.contains(event.target)
      ) {
        setRecipientMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", closeOnOutsideClick);
    return () =>
      document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [recipientMenuOpen]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!draft.trim() || disabled || recipientUnavailable) {
      return;
    }

    onSend(
      draft,
      selectedRecipients.map((participant) => participant.id),
      replyTo,
    );
    setDraft("");
    setReplyTo(undefined);
    setActiveMessageId(null);
    if (resetRecipientsAfterSend) {
      setSelectedRecipientIds([]);
      setResetRecipientsAfterSend(false);
    }
  }

  async function sendFiles(files: File[]) {
    if (disabled || recipientUnavailable || files.length === 0) {
      return;
    }

    setOpen(true);
    setUnreadCount(0);
    for (const file of files.slice(0, 5)) {
      await onSendAttachment(
        file,
        selectedRecipients.map((participant) => participant.id),
      );
    }
    if (resetRecipientsAfterSend) {
      setSelectedRecipientIds([]);
      setResetRecipientsAfterSend(false);
    }
  }

  function toggleRecipient(participantId: string) {
    setResetRecipientsAfterSend(false);
    setSelectedRecipientIds((current) =>
      current.includes(participantId)
        ? current.filter((id) => id !== participantId)
        : [...current, participantId],
    );
  }

  function replyToMessage(message: ChatMessage) {
    const fallbackText =
      message.attachments?.map((attachment) => attachment.name).join(", ") ||
      tr("Attachment", "Вложение");

    setReplyTo({
      messageId: message.id,
      senderName: message.senderName,
      text: (message.text || fallbackText).slice(0, 320),
    });
    setActiveMessageId(null);
    queueMicrotask(() => textareaRef.current?.focus());
  }

  function sendOnlyTo(message: ChatMessage) {
    if (
      message.isLocal ||
      !remoteParticipants.some(
        (participant) => participant.id === message.senderId,
      )
    ) {
      return;
    }

    setSelectedRecipientIds([message.senderId]);
    setResetRecipientsAfterSend(true);
    setRecipientMenuOpen(false);
    setReplyTo(undefined);
    setActiveMessageId(null);
    queueMicrotask(() => textareaRef.current?.focus());
  }

  function chooseFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);

    event.target.value = "";
    void sendFiles(files);
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragActive(false);
    void sendFiles(Array.from(event.dataTransfer.files));
  }

  return (
    <>
      <aside
        className={`${styles.root} ${open ? styles.open : styles.closed} ${
          dragActive ? styles.dragActive : ""
        }`}
        onDragEnter={(event) => {
          event.preventDefault();
          if (!disabled) {
            setDragActive(true);
          }
        }}
        onDragLeave={(event) => {
          if (
            !event.currentTarget.contains(event.relatedTarget as Node | null)
          ) {
            setDragActive(false);
          }
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
      >
      <button
        aria-label={
          unreadCount > 0
            ? `${tr("Expand chat", "Развернуть чат")}: ${unreadCount} ${tr(
                "unread",
                "непрочитанных",
              )}`
            : tr("Expand chat", "Развернуть чат")
        }
        className={`${styles.tab} ${
          unreadCount > 0 ? styles.tabUnread : ""
        }`}
        onClick={() => {
          setOpen(true);
          setUnreadCount(0);
        }}
        type="button"
      >
        <MessageCircle size={17} />
      </button>

      <div aria-hidden={!open} className={styles.panel}>
        <header>
          <div>
            <MessageCircle size={16} />
            <strong>{tr("Chat", "Чат")}</strong>
          </div>
          <button
            aria-label={tr("Collapse chat", "Свернуть чат")}
            onClick={() => setOpen(false)}
            type="button"
          >
            <ChevronRight size={17} />
          </button>
        </header>

        <div className={styles.messages} ref={listRef}>
          {messages.length === 0 ? (
            <div className={styles.empty}>
              <MessageCircle size={20} />
              <strong>
                {tr(
                  "The conversation starts here",
                  "Здесь начнётся разговор",
                )}
              </strong>
              <span>
                {tr(
                  "Messages and attachments disappear when the meeting closes.",
                  "Сообщения и вложения живут только до закрытия встречи.",
                )}
              </span>
            </div>
          ) : (
            messages.map((message) => (
              <article
                className={message.isLocal ? styles.localMessage : ""}
                data-chat-message={message.id}
                key={message.id}
                onClick={(event) => {
                  if (
                    event.target instanceof Element &&
                    event.target.closest("button, a")
                  ) {
                    return;
                  }
                  setActiveMessageId((current) =>
                    current === message.id ? null : message.id,
                  );
                }}
              >
                <div className={styles.messageAvatar}>
                  {message.avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img alt="" src={message.avatarUrl} />
                  ) : (
                    initials(message.senderName)
                  )}
                </div>
                <div>
                  <header>
                    <strong>{message.senderName}</strong>
                    <time>
                      {new Date(message.timestamp).toLocaleTimeString(
                        locale === "ru" ? "ru-RU" : "en-US",
                        {
                          hour: "2-digit",
                          hour12: false,
                          minute: "2-digit",
                        },
                      )}
                    </time>
                  </header>
                  {message.isPrivate && (
                    <span className={styles.privateMessage}>
                      <LockKeyhole size={9} />
                      {message.isLocal &&
                      message.recipientNames &&
                      message.recipientNames.length > 0
                        ? `${tr("Private", "Лично")}: ${message.recipientNames.join(", ")}`
                        : tr("Private message", "Личное сообщение")}
                    </span>
                  )}
                  {message.replyTo && (
                    <div className={styles.replyQuote}>
                      <strong>{message.replyTo.senderName}</strong>
                      <span>{message.replyTo.text}</span>
                    </div>
                  )}
                  {message.text && <p>{message.text}</p>}
                  {message.attachments?.map((attachment) => (
                    <Attachment
                      attachment={attachment}
                      key={attachment.id}
                      onPreview={setPreviewAttachment}
                    />
                  ))}
                  {activeMessageId === message.id && (
                    <div
                      aria-label={tr("Message actions", "Действия с сообщением")}
                      className={styles.messageActions}
                      onClick={(event) => event.stopPropagation()}
                      role="group"
                    >
                      <button
                        onClick={() => replyToMessage(message)}
                        type="button"
                      >
                        {tr("Reply", "Ответить")}
                      </button>
                      {!message.isLocal &&
                        remoteParticipants.some(
                          (participant) =>
                            participant.id === message.senderId,
                        ) && (
                          <button
                            onClick={() => sendOnlyTo(message)}
                            type="button"
                          >
                            {tr("Only to", "Только ему")}
                          </button>
                        )}
                    </div>
                  )}
                </div>
              </article>
            ))
          )}
        </div>

        <form className={styles.compose} onSubmit={submit}>
          {replyTo && (
            <div className={styles.replyContext}>
              <div>
                <strong>
                  {tr("Reply to", "Ответ для")} {replyTo.senderName}
                </strong>
                <span>{replyTo.text}</span>
              </div>
              <button
                aria-label={tr("Cancel reply", "Отменить ответ")}
                onClick={() => setReplyTo(undefined)}
                type="button"
              >
                <X size={12} />
              </button>
            </div>
          )}
          <div className={styles.recipientPicker} ref={recipientPickerRef}>
            <button
              aria-expanded={recipientMenuOpen}
              aria-label={tr(
                "Select message recipients",
                "Выбрать получателей сообщения",
              )}
              className={
                selectedRecipients.length > 0 ? styles.privateRecipient : ""
              }
              disabled={disabled || remoteParticipants.length === 0}
              onClick={() => setRecipientMenuOpen((current) => !current)}
              type="button"
            >
              {selectedRecipients.length > 0 ? (
                <LockKeyhole size={11} />
              ) : (
                <Users size={11} />
              )}
              <span>
                {recipientUnavailable
                  ? tr("Recipient left", "Получатель вышел")
                  : selectedRecipients.length === 0
                  ? tr("Everyone", "Всем")
                  : `${tr("Private", "Лично")}: ${
                      selectedRecipients.length === 1
                        ? selectedRecipients[0].displayName
                        : `${selectedRecipients.length} ${tr(
                            "people",
                            "участникам",
                          )}`
                    }`}
              </span>
              <ChevronDown size={11} />
            </button>

            {recipientMenuOpen && (
              <section
                aria-label={tr(
                  "Message recipients",
                  "Получатели сообщения",
                )}
                className={styles.recipientMenu}
              >
                <header>
                  <strong>{tr("Send to", "Кому отправить")}</strong>
                  <span>
                    {tr(
                      "You can select more than one",
                      "Можно выбрать несколько",
                    )}
                  </span>
                </header>
                <button
                  className={
                    selectedRecipientIds.length === 0
                      ? styles.recipientSelected
                      : ""
                  }
                  onClick={() => {
                    setSelectedRecipientIds([]);
                    setResetRecipientsAfterSend(false);
                  }}
                  type="button"
                >
                  <Users size={13} />
                  <span>{tr("Everyone", "Всем участникам")}</span>
                  {selectedRecipientIds.length === 0 && <Check size={12} />}
                </button>
                {remoteParticipants.map((participant) => {
                  const selected = selectedRecipientIds.includes(
                    participant.id,
                  );

                  return (
                    <button
                      className={selected ? styles.recipientSelected : ""}
                      key={participant.id}
                      onClick={() => toggleRecipient(participant.id)}
                      type="button"
                    >
                      <span className={styles.recipientAvatar}>
                        {initials(participant.displayName)}
                      </span>
                      <span>{participant.displayName}</span>
                      {selected && <Check size={12} />}
                    </button>
                  );
                })}
              </section>
            )}
          </div>

          <div className={styles.composer}>
            <button
              aria-label={tr("Add attachment", "Добавить вложение")}
              className={styles.attachButton}
              disabled={
                disabled || recipientUnavailable || isSendingAttachment
              }
              onClick={() => fileInputRef.current?.click()}
              title={tr("Up to 2 MB per file", "До 2 МБ на файл")}
              type="button"
            >
              {isSendingAttachment ? (
                <LoaderCircle className={styles.spinner} size={16} />
              ) : (
                <Paperclip size={16} />
              )}
            </button>
            <textarea
              aria-label={tr("Chat message", "Сообщение в чат")}
              disabled={disabled}
              maxLength={4000}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder={
                disabled
                  ? tr("Join to write", "Войдите, чтобы писать")
                  : tr("Message…", "Сообщение…")
              }
              rows={1}
              ref={textareaRef}
              value={draft}
            />
            <button
              aria-label={tr("Send message", "Отправить сообщение")}
              className={styles.sendButton}
              disabled={disabled || recipientUnavailable || !draft.trim()}
              type="submit"
            >
              <Send size={16} />
            </button>
          </div>
        </form>

        <input
          className={styles.fileInput}
          multiple
          onChange={chooseFiles}
          ref={fileInputRef}
          type="file"
        />

        {dragActive && (
          <div className={styles.dropzone}>
            <Paperclip size={23} />
            <strong>{tr("Drop files here", "Отпустите файлы")}</strong>
            <span>{tr("Up to 2 MB per file", "До 2 МБ на файл")}</span>
          </div>
        )}
      </div>

      </aside>

      {previewAttachment && (
        <div
          aria-label={tr("Image preview", "Просмотр изображения")}
          className={styles.imageViewer}
          onClick={() => setPreviewAttachment(null)}
          role="dialog"
        >
          <button
            aria-label={tr("Close image", "Закрыть изображение")}
            onClick={() => setPreviewAttachment(null)}
            type="button"
          >
            <X size={19} />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt={previewAttachment.name}
            onClick={(event) => event.stopPropagation()}
            src={previewAttachment.dataUrl}
          />
        </div>
      )}
    </>
  );
}
