import { MeetingRoom } from "@/components/meeting/MeetingRoom";

interface RoomPageProps {
  params: Promise<{ roomName: string }>;
}

export default async function RoomPage({ params }: RoomPageProps) {
  const { roomName } = await params;

  return <MeetingRoom roomName={decodeURIComponent(roomName)} />;
}
