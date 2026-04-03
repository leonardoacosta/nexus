# Add Settings Page

## Why
The dashboard navigation includes a Settings entry but has no implementation yet. Users need a centralized place to manage their agent fleet configuration, notification preferences, and polling behavior without editing TOML files by hand. This is the final dashboard page required for a complete navigation experience.

## What Changes
Build a settings page in the dashboard with three sections: an agent list showing connection status (online/offline with last-seen timestamps) and add/remove controls, a notification preferences form for configuring channels and per-project routing rules, and general preferences for polling interval and a keyboard shortcut reference. Settings persist to the dashboard's local SQLite database.
