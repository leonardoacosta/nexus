/** Notification delivery channels. */
export type NotificationChannel = "desktop" | "tts" | "slack";

/** Notification priority levels. */
export type NotificationPriority = "low" | "normal" | "high";

/** Notification delivery status. */
export type NotificationStatus = "queued" | "delivered" | "expired";

/** Meeting behavior when a notification arrives during an active meeting. */
export type MeetingBehavior = "buffer" | "drop" | "allow";

/** A notification queued or delivered by the agent. */
export interface Notification {
  id: string;
  channel: NotificationChannel;
  title: string;
  body: string;
  project?: string;
  priority: NotificationPriority;
  status: NotificationStatus;
  created_at: string;
  sent_at?: string;
}

/** Per-project routing rule for notification delivery. */
export interface NotificationRule {
  project?: string;
  channels: NotificationChannel[];
  meeting_behavior: MeetingBehavior;
}
