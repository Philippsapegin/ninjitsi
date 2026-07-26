import type { ParticipantView } from "@/lib/jitsi/types";

export const GRID_LAB_ROOM = "grid-lab";
export const GRID_LAB_MAX_PHANTOMS = 63;

const names = [
  "Ада Лавлейс",
  "Грейс Хоппер",
  "Алан Тьюринг",
  "Маргарет Гамильтон",
  "Дональд Кнут",
  "Барбара Лисков",
  "Эдсгер Дейкстра",
  "Фрэнсис Аллен",
  "Кен Томпсон",
  "Радья Перлман",
  "Джон Кармак",
  "Мэри Джексон",
];

export function isGridLabRoom(roomName: string) {
  return roomName.toLowerCase() === GRID_LAB_ROOM;
}

export function createPhantomParticipants(count: number): ParticipantView[] {
  return Array.from({ length: count }, (_, index) => ({
    audioMuted: index % 5 === 2,
    displayName: names[index % names.length],
    id: `phantom-${index + 1}`,
    isDominantSpeaker: index === count - 1 && count > 1,
    isLocal: false,
    isModerator: false,
    isScreenSharing: false,
    videoMuted: index % 7 === 4,
  }));
}
