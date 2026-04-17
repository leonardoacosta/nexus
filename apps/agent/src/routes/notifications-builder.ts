/**
 * Notification + meeting route table builder.
 *
 * Handlers live in ./notifications.ts.
 *
 * Extracted from the monolithic `buildRoutes` in apps/agent/src/routes.ts.
 */

import type { Db } from "@nexus/db";
import type { Route } from "../router";
import {
  handleSendNotification,
  handleMeetingStart,
  handleMeetingEnd,
  handleMeetingStatus,
} from "./notifications";

export function buildNotificationsRoutes(db?: Db): Route[] {
  const dbRef = db as Db;

  return [
    {
      method: "POST",
      path: "/notifications/send",
      requiresDb: true,
      handler(req) {
        return handleSendNotification(dbRef, req);
      },
    },
    {
      method: "POST",
      path: "/meeting/start",
      requiresDb: true,
      handler() {
        return handleMeetingStart();
      },
    },
    {
      method: "POST",
      path: "/meeting/end",
      requiresDb: true,
      handler() {
        return handleMeetingEnd();
      },
    },
    {
      method: "GET",
      path: "/meeting/status",
      requiresDb: true,
      handler() {
        return handleMeetingStatus();
      },
    },
  ];
}
