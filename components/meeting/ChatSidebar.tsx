"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { MessageCircle, Send } from "lucide-react";
import type { ChatMessage } from "@/lib/jitsi/types";
import styles from "./ChatSidebar.module.css";

interface ChatSidebarProps {
  disabled: boolean;
  messages: ChatMessage[];
  onSend: (text: string) => void;
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

export function ChatSidebar({
  disabled,
  messages,
  onSend,
}: ChatSidebarProps) {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

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

  return (
    <aside className={styles.sidebar}>
      <header>
        <div>
          <MessageCircle size={16} />
          <strong>Чат</strong>
        </div>
        <span>{messages.length || ""}</span>
      </header>

      <div className={styles.messages} ref={listRef}>
        {messages.length === 0 ? (
          <div className={styles.empty}>
            <MessageCircle size={20} />
            <strong>Здесь начнётся разговор</strong>
            <span>
              Сообщения видят участники встречи. Бота подключим позже.
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
                  <strong>{message.isLocal ? "Вы" : message.senderName}</strong>
                  <time>
                    {new Date(message.timestamp).toLocaleTimeString("ru-RU", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </header>
                <p>{message.text}</p>
              </div>
            </article>
          ))
        )}
      </div>

      <form onSubmit={submit}>
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
          disabled={disabled || !draft.trim()}
          type="submit"
        >
          <Send size={16} />
        </button>
      </form>
    </aside>
  );
}
