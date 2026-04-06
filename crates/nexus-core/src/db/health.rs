//! Health sample CRUD operations.
//!
//! The `health_samples` SQLite table was dropped in migration v4.
//! All health persistence now flows through the TypeScript agent's
//! `health_snapshots` PostgreSQL table via `POST /health/ingest`.
//!
//! This file is retained as a placeholder; its methods are removed.
