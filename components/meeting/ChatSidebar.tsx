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
  ChevronRight,
  FileText,
  ImageIcon,
  LoaderCircle,
  MessageCircle,
  Paperclip,
  Send,
} from "lucide-react";
import type { ChatAttachment, ChatMessage } from "@/lib/jitsi/types";
import styles from "./ChatSidebar.module.css";

interface ChatSidebarProps {
  disabled: boolean;
  isSendingAttachment: boolean;
  messages: ChatMessage[];
  onSend: (text: string) => void;
  onSendAttachment: (file: File) => Promise<void>;
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

function formatFileSize(size: number) {
  if (size < 1024) {
    return `${size} Б`;
  }

  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} КБ`;
  }

  return `${(size / 1024 / 1024).toFixed(1)} МБ`;
}

function Attachment({ attachment }: { attachment: ChatAttachment }) {
  const isImage = attachment.mimeType.startsWith("image/");

  return (
    <a
      className={`${styles.attachment} ${
        isImage ? styles.imageAttachment : ""
      }`}
      download={attachment.name}
      href={attachment.dataUrl}
      title={`Скачать ${attachment.name}`}
    >
      {isImage ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img alt={attachment.name} src={attachment.dataUrl} />
          <span>
            <ImageIcon size={13} />
            {attachment.name}
          </span>
        </>
      ) : (
        <>
          <FileText size={18} />
          <span>
            <strong>{attachment.name}</strong>
            <small>{formatFileSize(attachment.size)}</small>
          </span>
        </>
      )}
    </a>
  );
}

export function ChatSidebar({
  disabled,
  isSendingAttachment,
  messages,
  onSend,
  onSendAttachment,
}: ChatSidebarProps) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(true);
  const [dragActive, setDragActive] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({
      behavior: "smooth",
      top: listRef.current.scrollHeight,
    });
  }, [messages]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!draft.trim() || disabled) {
      return;
    }

    onSend(draft);
    setDraft("");
  }

  async function sendFiles(files: File[]) {
    if (disabled || files.length === 0) {
      return;
    }

    setOpen(true);
    for (const file of files.slice(0, 5)) {
      await onSendAttachment(file);
    }
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
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDragActive(false);
        }
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
    >
      <button
        aria-label="Развернуть чат"
        className={styles.tab}
        onClick={() => setOpen(true)}
        type="button"
      >
        <MessageCircle size={17} />
        <span>Чат</span>
        {messages.length > 0 && <i>{messages.length}</i>}
      </button>

      <div aria-hidden={!open} className={styles.panel}>
        <header>
          <div>
            <MessageCircle size={16} />
            <strong>Чат</strong>
            {messages.length > 0 && <span>{messages.length}</span>}
          </div>
          <button
            aria-label="Свернуть чат"
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
              <strong>Здесь начнётся разговор</strong>
              <span>
                Сообщения и вложения живут только до закрытия встречи.
              </span>
            </div>
          ) : (
            messages.map((message) => (
              <article
                className={message.isLocal ? styles.localMessage : ""}
                key={message.id}
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
                    <strong>
                      {message.isLocal ? "Вы" : message.senderName}
                    </strong>
                    <time>
                      {new Date(message.timestamp).toLocaleTimeString("ru-RU", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  </header>
                  {message.text && <p>{message.text}</p>}
                  {message.attachments?.map((attachment) => (
                    <Attachment
                      attachment={attachment}
                      key={attachment.id}
                    />
                  ))}
                </div>
              </article>
            ))
          )}
        </div>

        <form onSubmit={submit}>
          <button
            aria-label="Добавить вложение"
            className={styles.attachButton}
            disabled={disabled || isSendingAttachment}
            onClick={() => fileInputRef.current?.click()}
            title="До 2 МБ на файл"
            type="button"
          >
            {isSendingAttachment ? (
              <LoaderCircle className={styles.spinner} size={16} />
            ) : (
              <Paperclip size={16} />
            )}
          </button>
          <textarea
            aria-label="Сообщение в чат"
            disabled={disabled}
            maxLength={4000}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={disabled ? "Войдите, чтобы писать" : "Сообщение…"}
            rows={1}
            value={draft}
          />
          <button
            aria-label="Отправить сообщение"
            className={styles.sendButton}
            disabled={disabled || !draft.trim()}
            type="submit"
          >
            <Send size={16} />
          </button>
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
            <strong>Отпустите файлы</strong>
            <span>До 2 МБ на файл</span>
          </div>
        )}
      </div>
    </aside>
  );
}
