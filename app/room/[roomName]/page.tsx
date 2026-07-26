"use client";

import { useParams } from "next/navigation";
import { MeetingRoom } from "@/components/meeting/MeetingRoom";

export default function RoomPage() {
  const params = useParams<{ roomName: string }>();
  const roomName = decodeURIComponent(params.roomName);

  return <MeetingRoom roomName={roomName} />;
}
