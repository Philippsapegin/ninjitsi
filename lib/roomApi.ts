export interface RoomRecord {
  code: string;
  createdAt: string;
  passwordRequired: boolean;
}

interface RoomResponse {
  room: RoomRecord;
}

interface CreateRoomResponse extends RoomResponse {
  joinPath: string;
}

export class RoomApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "RoomApiError";
    this.status = status;
  }
}

async function roomRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(path, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new RoomApiError(
      "Сервер комнат недоступен. Проверьте, что Ninjitsi запущен.",
      0,
    );
  }

  const body = (await response.json().catch(() => null)) as
    | { error?: string }
    | T
    | null;

  if (!response.ok) {
    const responseError =
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof body.error === "string"
        ? body.error
        : null;

    throw new RoomApiError(
      responseError ?? "Сервер комнат отклонил запрос.",
      response.status,
    );
  }

  return body as T;
}

export async function createRoom(password: string): Promise<CreateRoomResponse> {
  return roomRequest<CreateRoomResponse>("/api/rooms", {
    body: JSON.stringify({ password }),
    method: "POST",
  });
}

export async function getRoom(code: string): Promise<RoomRecord> {
  const response = await roomRequest<RoomResponse>(
    `/api/rooms/${encodeURIComponent(code)}`,
  );

  return response.room;
}

export async function authorizeRoom(
  code: string,
  password: string,
): Promise<RoomRecord> {
  const response = await roomRequest<
    RoomResponse & { admitted: true }
  >(`/api/rooms/${encodeURIComponent(code)}/join`, {
    body: JSON.stringify({ password }),
    method: "POST",
  });

  return response.room;
}
