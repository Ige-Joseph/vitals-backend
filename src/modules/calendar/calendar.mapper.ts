export function mapCareEventToGoogleEvent(careEvent: {
  title: string;
  description: string | null;
  scheduledFor: Date;
}) {
  const startsAt = careEvent.scheduledFor;
  const endsAt = new Date(startsAt.getTime() + 30 * 60 * 1000);

  return {
    title: careEvent.title,
    description: careEvent.description,
    startsAt,
    endsAt,
  };
}