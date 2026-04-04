# Add Notification System

## Why
The Rust v1 Nexus had meeting-aware notification queuing that prevented disruptive alerts during calls while ensuring nothing was missed afterward. This carry-forward feature is essential for the multi-session workflow where agents complete tasks asynchronously and users need timely, context-appropriate alerts across desktop, TTS, and Slack channels.

## What Changes
Port the meeting-aware notification system from Rust v1 to Bun/TypeScript. Notifications are buffered in SQLite during detected meetings and flushed when the meeting ends. Three delivery channels are supported: desktop (node-notifier), TTS (ElevenLabs API), and Slack webhook. Project-aware routing rules allow different notification behavior per project.
