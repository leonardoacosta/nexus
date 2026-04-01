//! Tests for the database module.

#[cfg(test)]
mod tests {
    use crate::db::*;

    fn test_db() -> NexusDb {
        let db = NexusDb::open_in_memory().unwrap();
        db.migrate().unwrap();
        db
    }

    fn make_spec(project: &str, name: &str) -> SpecRecord {
        SpecRecord {
            id: format!("{project}/{name}"),
            project: project.to_string(),
            name: name.to_string(),
            status: "unread".to_string(),
            title: Some("Test spec".to_string()),
            summary: None,
            tasks_total: 10,
            tasks_done: 0,
            proposal_hash: Some("abc123".to_string()),
            discovered_at: chrono::Utc::now().to_rfc3339(),
            read_at: None,
            approved_at: None,
            applied_at: None,
            archived_at: None,
            rejected_at: None,
            rejection_reason: None,
        }
    }

    // -------------------------------------------------------------------
    // Task 1.6: Database foundation tests
    // -------------------------------------------------------------------

    #[test]
    fn open_and_migrate() {
        let db = test_db();
        let version: u32 = db
            .read(|conn| Ok(conn.query_row("PRAGMA user_version", [], |row| row.get(0))?))
            .unwrap();
        assert_eq!(version, 3);
    }

    #[test]
    fn migrate_is_idempotent() {
        let db = test_db();
        db.migrate().unwrap();
        let version: u32 = db
            .read(|conn| Ok(conn.query_row("PRAGMA user_version", [], |row| row.get(0))?))
            .unwrap();
        assert_eq!(version, 3);
    }

    #[test]
    fn tables_exist_after_migration() {
        let db = test_db();
        let tables: Vec<String> = db
            .read(|conn| {
                let mut stmt = conn
                    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")?;
                let rows = stmt.query_map([], |row| row.get(0))?;
                let mut names = Vec::new();
                for row in rows {
                    names.push(row?);
                }
                Ok(names)
            })
            .unwrap();

        assert!(tables.contains(&"specs".to_string()));
        assert!(tables.contains(&"sessions".to_string()));
        assert!(tables.contains(&"failures".to_string()));
        assert!(tables.contains(&"events".to_string()));
        // V2 tables.
        assert!(tables.contains(&"health_samples".to_string()));
        assert!(tables.contains(&"spec_snapshots".to_string()));
        assert!(tables.contains(&"credential_polls".to_string()));
        assert!(tables.contains(&"credential_swaps".to_string()));
        assert!(tables.contains(&"notifications".to_string()));
        // V3 tables.
        assert!(tables.contains(&"cron_runs".to_string()));
        assert!(tables.contains(&"git_events".to_string()));
        assert!(tables.contains(&"agent_lifecycle".to_string()));
    }

    #[test]
    fn wal_mode_enabled() {
        let db = test_db();
        let mode: String = db
            .read(|conn| Ok(conn.query_row("PRAGMA journal_mode", [], |row| row.get(0))?))
            .unwrap();
        assert!(mode == "wal" || mode == "memory");
    }

    // -------------------------------------------------------------------
    // Task 2.6: Spec CRUD tests
    // -------------------------------------------------------------------

    #[test]
    fn upsert_and_get_spec() {
        let db = test_db();
        let spec = make_spec("oo", "add-auth");
        db.upsert_spec(&spec).unwrap();

        let fetched = db.get_spec("oo", "add-auth").unwrap().unwrap();
        assert_eq!(fetched.id, "oo/add-auth");
        assert_eq!(fetched.status, "unread");
        assert_eq!(fetched.tasks_total, 10);
        assert_eq!(fetched.tasks_done, 0);
        assert_eq!(fetched.proposal_hash.as_deref(), Some("abc123"));
    }

    #[test]
    fn get_nonexistent_spec_returns_none() {
        let db = test_db();
        let result = db.get_spec("oo", "nonexistent").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn upsert_updates_existing_spec() {
        let db = test_db();
        let mut spec = make_spec("oo", "add-auth");
        db.upsert_spec(&spec).unwrap();

        spec.status = "read".to_string();
        spec.tasks_done = 3;
        spec.read_at = Some(chrono::Utc::now().to_rfc3339());
        db.upsert_spec(&spec).unwrap();

        let fetched = db.get_spec("oo", "add-auth").unwrap().unwrap();
        assert_eq!(fetched.status, "read");
        assert_eq!(fetched.tasks_done, 3);
        assert!(fetched.read_at.is_some());
    }

    #[test]
    fn list_specs_all() {
        let db = test_db();
        db.upsert_spec(&make_spec("oo", "spec-a")).unwrap();
        db.upsert_spec(&make_spec("nx", "spec-b")).unwrap();

        let all = db.list_specs(None).unwrap();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn list_specs_with_status_filter() {
        let db = test_db();
        db.upsert_spec(&make_spec("oo", "spec-a")).unwrap();

        let mut spec_b = make_spec("nx", "spec-b");
        spec_b.status = "approved".to_string();
        db.upsert_spec(&spec_b).unwrap();

        let unread = db.list_specs(Some(&["unread"])).unwrap();
        assert_eq!(unread.len(), 1);
        assert_eq!(unread[0].project, "oo");

        let approved = db.list_specs(Some(&["approved"])).unwrap();
        assert_eq!(approved.len(), 1);
        assert_eq!(approved[0].project, "nx");

        let both = db.list_specs(Some(&["unread", "approved"])).unwrap();
        assert_eq!(both.len(), 2);
    }

    #[test]
    fn update_spec_status_test() {
        let db = test_db();
        db.upsert_spec(&make_spec("oo", "add-auth")).unwrap();

        db.update_spec_status("oo", "add-auth", "read").unwrap();
        let spec = db.get_spec("oo", "add-auth").unwrap().unwrap();
        assert_eq!(spec.status, "read");
        assert!(spec.read_at.is_some());

        db.update_spec_status("oo", "add-auth", "approved").unwrap();
        let spec = db.get_spec("oo", "add-auth").unwrap().unwrap();
        assert_eq!(spec.status, "approved");
        assert!(spec.approved_at.is_some());
    }

    #[test]
    fn update_spec_tasks_test() {
        let db = test_db();
        db.upsert_spec(&make_spec("oo", "add-auth")).unwrap();

        db.update_spec_tasks("oo", "add-auth", 5, 10).unwrap();
        let spec = db.get_spec("oo", "add-auth").unwrap().unwrap();
        assert_eq!(spec.tasks_done, 5);
        assert_eq!(spec.tasks_total, 10);
    }

    // -------------------------------------------------------------------
    // Spec lifecycle transitions
    // -------------------------------------------------------------------

    #[test]
    fn spec_lifecycle_unread_to_archived() {
        let db = test_db();
        db.upsert_spec(&make_spec("oo", "lifecycle")).unwrap();

        for status in &["read", "approved", "applied", "archived"] {
            db.update_spec_status("oo", "lifecycle", status).unwrap();
            let spec = db.get_spec("oo", "lifecycle").unwrap().unwrap();
            assert_eq!(spec.status, *status);
        }
    }

    #[test]
    fn hash_change_resets_to_unread() {
        let db = test_db();
        let mut spec = make_spec("oo", "edited-spec");
        spec.status = "approved".to_string();
        spec.proposal_hash = Some("hash_v1".to_string());
        spec.approved_at = Some(chrono::Utc::now().to_rfc3339());
        db.upsert_spec(&spec).unwrap();

        spec.status = "unread".to_string();
        spec.proposal_hash = Some("hash_v2".to_string());
        spec.read_at = None;
        spec.approved_at = None;
        db.upsert_spec(&spec).unwrap();

        let fetched = db.get_spec("oo", "edited-spec").unwrap().unwrap();
        assert_eq!(fetched.status, "unread");
        assert_eq!(fetched.proposal_hash.as_deref(), Some("hash_v2"));
        assert!(fetched.read_at.is_none());
        assert!(fetched.approved_at.is_none());
    }

    // -------------------------------------------------------------------
    // Retention / pruning
    // -------------------------------------------------------------------

    #[test]
    fn prune_old_records_cleans_archived_specs() {
        let db = test_db();
        let mut spec = make_spec("oo", "old-spec");
        spec.status = "archived".to_string();
        spec.archived_at = Some("2020-01-01T00:00:00Z".to_string());
        db.upsert_spec(&spec).unwrap();

        let stats = db.prune_old_records(30, 90).unwrap();
        assert_eq!(stats.specs_deleted, 1);

        let fetched = db.get_spec("oo", "old-spec").unwrap();
        assert!(fetched.is_none());
    }

    #[test]
    fn prune_preserves_recent_archived_specs() {
        let db = test_db();
        let mut spec = make_spec("oo", "recent-spec");
        spec.status = "archived".to_string();
        spec.archived_at = Some(chrono::Utc::now().to_rfc3339());
        db.upsert_spec(&spec).unwrap();

        let stats = db.prune_old_records(30, 90).unwrap();
        assert_eq!(stats.specs_deleted, 0);

        let fetched = db.get_spec("oo", "recent-spec").unwrap();
        assert!(fetched.is_some());
    }

    #[test]
    fn prune_preserves_non_archived_specs() {
        let db = test_db();
        db.upsert_spec(&make_spec("oo", "active-spec")).unwrap();

        let stats = db.prune_old_records(30, 90).unwrap();
        assert_eq!(stats.specs_deleted, 0);
    }

    // -------------------------------------------------------------------
    // proposal_hash helper
    // -------------------------------------------------------------------

    #[test]
    fn proposal_hash_is_deterministic() {
        let h1 = proposal_hash(b"hello world");
        let h2 = proposal_hash(b"hello world");
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64);
    }

    #[test]
    fn proposal_hash_differs_for_different_content() {
        let h1 = proposal_hash(b"version 1");
        let h2 = proposal_hash(b"version 2");
        assert_ne!(h1, h2);
    }

    // -------------------------------------------------------------------
    // Task 4.4: Session persistence round-trip tests
    // -------------------------------------------------------------------

    fn make_session(id: &str, project: &str) -> SessionRecord {
        SessionRecord {
            id: id.to_string(),
            pid: Some(1234),
            project: Some(project.to_string()),
            cwd: Some("/home/user/dev".to_string()),
            branch: Some("main".to_string()),
            started_at: chrono::Utc::now().to_rfc3339(),
            ended_at: None,
            last_heartbeat: Some(chrono::Utc::now().to_rfc3339()),
            status: Some("active".to_string()),
            model: Some("opus".to_string()),
            session_type: Some("ad_hoc".to_string()),
            total_cost_usd: Some(0.05),
            rate_limit_utilization: Some(0.3),
            rate_limit_type: Some("model".to_string()),
            tmux_target: Some("main:0.1".to_string()),
            cc_session_id: Some("cc-123".to_string()),
            agent: Some("test-agent".to_string()),
        }
    }

    #[test]
    fn insert_and_load_session() {
        let db = test_db();
        let session = make_session("sess-1", "oo");
        db.insert_session(&session).unwrap();

        let active = db.load_active_sessions().unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id, "sess-1");
        assert_eq!(active[0].project.as_deref(), Some("oo"));
        assert_eq!(active[0].model.as_deref(), Some("opus"));
    }

    #[test]
    fn update_session_partial() {
        let db = test_db();
        db.insert_session(&make_session("sess-2", "nx")).unwrap();

        let update = SessionUpdate {
            model: Some("sonnet".to_string()),
            total_cost_usd: Some(1.5),
            ..Default::default()
        };
        db.update_session("sess-2", &update).unwrap();

        let active = db.load_active_sessions().unwrap();
        assert_eq!(active[0].model.as_deref(), Some("sonnet"));
        assert_eq!(active[0].total_cost_usd, Some(1.5));
        // Unchanged fields remain.
        assert_eq!(active[0].project.as_deref(), Some("nx"));
    }

    #[test]
    fn end_session_removes_from_active() {
        let db = test_db();
        db.insert_session(&make_session("sess-3", "tc")).unwrap();

        let now = chrono::Utc::now().to_rfc3339();
        db.end_session("sess-3", &now).unwrap();

        let active = db.load_active_sessions().unwrap();
        assert!(active.is_empty());
    }

    #[test]
    fn load_active_sessions_excludes_ended() {
        let db = test_db();
        db.insert_session(&make_session("sess-a", "oo")).unwrap();
        db.insert_session(&make_session("sess-b", "nx")).unwrap();

        let now = chrono::Utc::now().to_rfc3339();
        db.end_session("sess-a", &now).unwrap();

        let active = db.load_active_sessions().unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id, "sess-b");
    }

    // -------------------------------------------------------------------
    // Task 5.5: Failure aggregation tests
    // -------------------------------------------------------------------

    fn make_failure(tool: &str, project: &str, error: &str) -> FailureRecord {
        FailureRecord {
            timestamp: chrono::Utc::now().to_rfc3339(),
            tool_name: tool.to_string(),
            error_summary: Some(error.to_string()),
            project: Some(project.to_string()),
            session_id: Some("test-session".to_string()),
        }
    }

    #[test]
    fn insert_and_query_failures() {
        let db = test_db();
        db.insert_failure(&make_failure("Bash", "oo", "command failed"))
            .unwrap();
        db.insert_failure(&make_failure("Read", "tc", "file not found"))
            .unwrap();
        db.insert_failure(&make_failure("Bash", "oo", "command failed"))
            .unwrap();

        let all = db.query_failures(&FailureQuery::default()).unwrap();
        assert_eq!(all.len(), 3);
    }

    #[test]
    fn query_failures_with_tool_filter() {
        let db = test_db();
        db.insert_failure(&make_failure("Bash", "oo", "err"))
            .unwrap();
        db.insert_failure(&make_failure("Read", "tc", "err"))
            .unwrap();

        let bash_only = db
            .query_failures(&FailureQuery {
                tool_name: Some("Bash".to_string()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(bash_only.len(), 1);
        assert_eq!(bash_only[0].tool_name, "Bash");
    }

    #[test]
    fn count_by_tool_test() {
        let db = test_db();
        let cutoff = "2000-01-01T00:00:00Z";
        db.insert_failure(&make_failure("Bash", "oo", "err"))
            .unwrap();
        db.insert_failure(&make_failure("Bash", "oo", "err"))
            .unwrap();
        db.insert_failure(&make_failure("Read", "tc", "err"))
            .unwrap();

        let counts = db.count_by_tool(cutoff).unwrap();
        assert_eq!(counts.len(), 2);
        assert_eq!(counts[0].0, "Bash");
        assert_eq!(counts[0].1, 2);
        assert_eq!(counts[1].0, "Read");
        assert_eq!(counts[1].1, 1);
    }

    #[test]
    fn count_by_project_empty_becomes_global() {
        let db = test_db();
        let cutoff = "2000-01-01T00:00:00Z";
        db.insert_failure(&FailureRecord {
            timestamp: chrono::Utc::now().to_rfc3339(),
            tool_name: "Bash".to_string(),
            error_summary: Some("err".to_string()),
            project: Some(String::new()),
            session_id: None,
        })
        .unwrap();

        let counts = db.count_by_project(cutoff).unwrap();
        assert_eq!(counts[0].0, "(global)");
    }

    #[test]
    fn top_errors_test() {
        let db = test_db();
        let cutoff = "2000-01-01T00:00:00Z";
        for _ in 0..5 {
            db.insert_failure(&make_failure("Bash", "oo", "command failed"))
                .unwrap();
        }
        for _ in 0..3 {
            db.insert_failure(&make_failure("Read", "tc", "file not found"))
                .unwrap();
        }

        let top = db.top_errors(cutoff, 10).unwrap();
        assert_eq!(top.len(), 2);
        assert_eq!(top[0].0, "command failed");
        assert_eq!(top[0].1, 5);
        assert_eq!(top[1].0, "file not found");
        assert_eq!(top[1].1, 3);
    }

    // -------------------------------------------------------------------
    // Event logging tests
    // -------------------------------------------------------------------

    #[test]
    fn log_and_query_events() {
        let db = test_db();
        db.log_event("session_start", "agent", "sess-1", Some("started"))
            .unwrap();
        db.log_event("session_stop", "agent", "sess-1", None)
            .unwrap();

        let all = db.query_events(None, None, 100).unwrap();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn query_events_by_type() {
        let db = test_db();
        db.log_event("session_start", "agent", "sess-1", None)
            .unwrap();
        db.log_event("session_stop", "agent", "sess-1", None)
            .unwrap();
        db.log_event("spec_status", "watcher", "oo/spec", None)
            .unwrap();

        let starts = db.query_events(Some("session_start"), None, 100).unwrap();
        assert_eq!(starts.len(), 1);
        assert_eq!(starts[0].event_type, "session_start");
    }

    #[test]
    fn query_events_by_target() {
        let db = test_db();
        db.log_event("session_start", "agent", "sess-1", None)
            .unwrap();
        db.log_event("session_start", "agent", "sess-2", None)
            .unwrap();

        let events = db.query_events(None, Some("sess-1"), 100).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].target.as_deref(), Some("sess-1"));
    }

    #[test]
    fn query_events_respects_limit() {
        let db = test_db();
        for i in 0..10 {
            db.log_event("test", "agent", &format!("target-{i}"), None)
                .unwrap();
        }

        let events = db.query_events(None, None, 3).unwrap();
        assert_eq!(events.len(), 3);
    }

    // -------------------------------------------------------------------
    // V2: Health samples tests
    // -------------------------------------------------------------------

    #[test]
    fn insert_and_query_health_samples() {
        let db = test_db();
        let sample = HealthSampleRecord {
            timestamp: chrono::Utc::now().to_rfc3339(),
            cpu_percent: Some(42.5),
            memory_used_gb: Some(8.0),
            memory_total_gb: Some(32.0),
            disk_used_gb: Some(100.0),
            disk_total_gb: Some(500.0),
            load1: Some(1.5),
            load5: Some(1.2),
            load15: Some(0.9),
            uptime_seconds: Some(86400),
        };
        db.insert_health_sample(&sample).unwrap();

        let results = db.query_health_samples(None, 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].cpu_percent, Some(42.5));
        assert_eq!(results[0].uptime_seconds, Some(86400));
    }

    #[test]
    fn query_health_samples_with_since() {
        let db = test_db();
        let old = HealthSampleRecord {
            timestamp: "2020-01-01T00:00:00Z".to_string(),
            cpu_percent: Some(10.0),
            memory_used_gb: None,
            memory_total_gb: None,
            disk_used_gb: None,
            disk_total_gb: None,
            load1: None,
            load5: None,
            load15: None,
            uptime_seconds: None,
        };
        db.insert_health_sample(&old).unwrap();

        let recent = HealthSampleRecord {
            timestamp: chrono::Utc::now().to_rfc3339(),
            cpu_percent: Some(50.0),
            memory_used_gb: None,
            memory_total_gb: None,
            disk_used_gb: None,
            disk_total_gb: None,
            load1: None,
            load5: None,
            load15: None,
            uptime_seconds: None,
        };
        db.insert_health_sample(&recent).unwrap();

        let results = db
            .query_health_samples(Some("2024-01-01T00:00:00Z"), 10)
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].cpu_percent, Some(50.0));
    }

    // -------------------------------------------------------------------
    // V2: Spec snapshots tests
    // -------------------------------------------------------------------

    #[test]
    fn insert_and_query_spec_snapshots() {
        let db = test_db();
        let snap = SpecSnapshotRecord {
            timestamp: chrono::Utc::now().to_rfc3339(),
            project: "oo".to_string(),
            spec_name: "add-feature".to_string(),
            completed_tasks: Some(5),
            total_tasks: Some(10),
        };
        db.insert_spec_snapshot(&snap).unwrap();

        let results = db.query_spec_snapshots("oo", 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].spec_name, "add-feature");
        assert_eq!(results[0].completed_tasks, Some(5));
    }

    #[test]
    fn latest_spec_snapshot_returns_most_recent() {
        let db = test_db();
        let snap1 = SpecSnapshotRecord {
            timestamp: "2024-01-01T00:00:00Z".to_string(),
            project: "oo".to_string(),
            spec_name: "feat".to_string(),
            completed_tasks: Some(2),
            total_tasks: Some(10),
        };
        db.insert_spec_snapshot(&snap1).unwrap();

        let snap2 = SpecSnapshotRecord {
            timestamp: "2024-01-02T00:00:00Z".to_string(),
            project: "oo".to_string(),
            spec_name: "feat".to_string(),
            completed_tasks: Some(5),
            total_tasks: Some(10),
        };
        db.insert_spec_snapshot(&snap2).unwrap();

        let latest = db.latest_spec_snapshot("oo", "feat").unwrap().unwrap();
        assert_eq!(latest.completed_tasks, Some(5));
    }

    #[test]
    fn latest_spec_snapshot_none_for_missing() {
        let db = test_db();
        let result = db.latest_spec_snapshot("oo", "nonexistent").unwrap();
        assert!(result.is_none());
    }

    // -------------------------------------------------------------------
    // V2: Credential polls tests
    // -------------------------------------------------------------------

    #[test]
    fn insert_and_query_credential_polls() {
        let db = test_db();
        let poll = CredentialPollRecord {
            timestamp: chrono::Utc::now().to_rfc3339(),
            account: "personal".to_string(),
            five_hour_utilization: Some(0.45),
            seven_day_utilization: Some(0.20),
            five_hour_resets_at: Some("2024-01-01T12:00:00Z".to_string()),
            seven_day_resets_at: Some("2024-01-07T00:00:00Z".to_string()),
        };
        db.insert_credential_poll(&poll).unwrap();

        let results = db.query_credential_polls(Some("personal"), 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].five_hour_utilization, Some(0.45));
    }

    #[test]
    fn latest_credential_polls_groups_by_account() {
        let db = test_db();
        // Two polls for "personal", one for "work".
        db.insert_credential_poll(&CredentialPollRecord {
            timestamp: "2024-01-01T00:00:00Z".to_string(),
            account: "personal".to_string(),
            five_hour_utilization: Some(0.1),
            seven_day_utilization: Some(0.05),
            five_hour_resets_at: None,
            seven_day_resets_at: None,
        })
        .unwrap();
        db.insert_credential_poll(&CredentialPollRecord {
            timestamp: "2024-01-02T00:00:00Z".to_string(),
            account: "personal".to_string(),
            five_hour_utilization: Some(0.5),
            seven_day_utilization: Some(0.3),
            five_hour_resets_at: None,
            seven_day_resets_at: None,
        })
        .unwrap();
        db.insert_credential_poll(&CredentialPollRecord {
            timestamp: "2024-01-01T00:00:00Z".to_string(),
            account: "work".to_string(),
            five_hour_utilization: Some(0.8),
            seven_day_utilization: Some(0.6),
            five_hour_resets_at: None,
            seven_day_resets_at: None,
        })
        .unwrap();

        let latest = db.latest_credential_polls().unwrap();
        assert_eq!(latest.len(), 2);
        // "personal" should have the most recent poll.
        let personal = latest.iter().find(|p| p.account == "personal").unwrap();
        assert_eq!(personal.five_hour_utilization, Some(0.5));
    }

    // -------------------------------------------------------------------
    // V2: Credential swaps tests
    // -------------------------------------------------------------------

    #[test]
    fn insert_and_query_credential_swaps() {
        let db = test_db();
        let swap = CredentialSwapRecord {
            timestamp: chrono::Utc::now().to_rfc3339(),
            from_account: "personal".to_string(),
            to_account: "work".to_string(),
            trigger_session_id: Some("sess-42".to_string()),
        };
        db.insert_credential_swap(&swap).unwrap();

        let results = db.query_credential_swaps(10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].from_account, "personal");
        assert_eq!(results[0].to_account, "work");
        assert_eq!(results[0].trigger_session_id.as_deref(), Some("sess-42"));
    }

    // -------------------------------------------------------------------
    // V2: Notifications tests
    // -------------------------------------------------------------------

    #[test]
    fn insert_and_query_notifications() {
        let db = test_db();
        let notif = NotificationRecord {
            timestamp: chrono::Utc::now().to_rfc3339(),
            message: "OO — session started".to_string(),
            message_type: Some("brief".to_string()),
            project: Some("oo".to_string()),
            channels: Some("[\"tts\",\"banner\"]".to_string()),
            delivered: true,
            suppressed: false,
        };
        db.insert_notification(&notif).unwrap();

        let results = db.query_notifications(Some("oo"), 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].message, "OO — session started");
        assert!(results[0].delivered);
        assert!(!results[0].suppressed);
    }

    #[test]
    fn insert_suppressed_notification() {
        let db = test_db();
        let notif = NotificationRecord {
            timestamp: chrono::Utc::now().to_rfc3339(),
            message: "Suppressed msg".to_string(),
            message_type: Some("brief".to_string()),
            project: None,
            channels: None,
            delivered: false,
            suppressed: true,
        };
        db.insert_notification(&notif).unwrap();

        let results = db.query_notifications(None, 10).unwrap();
        assert_eq!(results.len(), 1);
        assert!(!results[0].delivered);
        assert!(results[0].suppressed);
    }

    // -------------------------------------------------------------------
    // V2: Pruning includes new tables
    // -------------------------------------------------------------------

    #[test]
    fn prune_removes_old_v2_records() {
        let db = test_db();
        let old_ts = "2020-01-01T00:00:00Z".to_string();

        db.insert_health_sample(&HealthSampleRecord {
            timestamp: old_ts.clone(),
            cpu_percent: Some(10.0),
            memory_used_gb: None,
            memory_total_gb: None,
            disk_used_gb: None,
            disk_total_gb: None,
            load1: None,
            load5: None,
            load15: None,
            uptime_seconds: None,
        })
        .unwrap();

        db.insert_spec_snapshot(&SpecSnapshotRecord {
            timestamp: old_ts.clone(),
            project: "oo".to_string(),
            spec_name: "old".to_string(),
            completed_tasks: Some(1),
            total_tasks: Some(5),
        })
        .unwrap();

        db.insert_credential_poll(&CredentialPollRecord {
            timestamp: old_ts.clone(),
            account: "test".to_string(),
            five_hour_utilization: Some(0.1),
            seven_day_utilization: None,
            five_hour_resets_at: None,
            seven_day_resets_at: None,
        })
        .unwrap();

        db.insert_credential_swap(&CredentialSwapRecord {
            timestamp: old_ts.clone(),
            from_account: "a".to_string(),
            to_account: "b".to_string(),
            trigger_session_id: None,
        })
        .unwrap();

        db.insert_notification(&NotificationRecord {
            timestamp: old_ts,
            message: "old notification".to_string(),
            message_type: None,
            project: None,
            channels: None,
            delivered: true,
            suppressed: false,
        })
        .unwrap();

        let stats = db.prune_old_records(30, 90).unwrap();
        assert_eq!(stats.health_samples_deleted, 1);
        assert_eq!(stats.spec_snapshots_deleted, 1);
        assert_eq!(stats.credential_polls_deleted, 1);
        assert_eq!(stats.credential_swaps_deleted, 1);
        assert_eq!(stats.notifications_deleted, 1);
    }

    // -------------------------------------------------------------------
    // V3 consolidation table tests
    // -------------------------------------------------------------------

    #[test]
    fn insert_and_query_cron_runs() {
        let db = test_db();
        let now = chrono::Utc::now().to_rfc3339();

        db.insert_cron_run(&CronRunRecord {
            id: None,
            timestamp: now.clone(),
            job: "maintain".to_string(),
            status: "success".to_string(),
            details: Some("pruned 5 items".to_string()),
            duration_ms: Some(120),
        })
        .unwrap();

        db.insert_cron_run(&CronRunRecord {
            id: None,
            timestamp: now.clone(),
            job: "drift".to_string(),
            status: "success".to_string(),
            details: None,
            duration_ms: Some(50),
        })
        .unwrap();

        // Query all
        let all = db.query_cron_runs(None, 100).unwrap();
        assert_eq!(all.len(), 2);

        // Query by job
        let maintain = db.query_cron_runs(Some("maintain"), 100).unwrap();
        assert_eq!(maintain.len(), 1);
        assert_eq!(maintain[0].job, "maintain");
        assert_eq!(maintain[0].details.as_deref(), Some("pruned 5 items"));
        assert_eq!(maintain[0].duration_ms, Some(120));
    }

    #[test]
    fn insert_and_query_git_events() {
        let db = test_db();
        let now = chrono::Utc::now().to_rfc3339();

        db.insert_git_event(&GitEventRecord {
            id: None,
            timestamp: now.clone(),
            project: "nx".to_string(),
            event_type: "branch_switch".to_string(),
            old_ref: Some("refs/heads/main".to_string()),
            new_ref: Some("refs/heads/feature".to_string()),
        })
        .unwrap();

        db.insert_git_event(&GitEventRecord {
            id: None,
            timestamp: now.clone(),
            project: "oo".to_string(),
            event_type: "new_commit".to_string(),
            old_ref: Some("abc1234".to_string()),
            new_ref: Some("def5678".to_string()),
        })
        .unwrap();

        // Query all
        let all = db.query_git_events(None, 100).unwrap();
        assert_eq!(all.len(), 2);

        // Query by project
        let nx = db.query_git_events(Some("nx"), 100).unwrap();
        assert_eq!(nx.len(), 1);
        assert_eq!(nx[0].event_type, "branch_switch");
        assert_eq!(nx[0].old_ref.as_deref(), Some("refs/heads/main"));
    }

    #[test]
    fn insert_and_query_lifecycle_events() {
        let db = test_db();
        let now = chrono::Utc::now().to_rfc3339();

        db.insert_lifecycle_event(&AgentLifecycleRecord {
            id: None,
            timestamp: now.clone(),
            event_type: "start".to_string(),
            version: Some("0.1.0".to_string()),
            uptime_seconds: None,
            reason: None,
        })
        .unwrap();

        db.insert_lifecycle_event(&AgentLifecycleRecord {
            id: None,
            timestamp: now.clone(),
            event_type: "stop".to_string(),
            version: Some("0.1.0".to_string()),
            uptime_seconds: Some(3600),
            reason: Some("SIGTERM".to_string()),
        })
        .unwrap();

        let events = db.query_lifecycle_events(100).unwrap();
        assert_eq!(events.len(), 2);

        // Most recent first (both same timestamp, so by id DESC)
        let stop_event = events.iter().find(|e| e.event_type == "stop").unwrap();
        assert_eq!(stop_event.uptime_seconds, Some(3600));
        assert_eq!(stop_event.reason.as_deref(), Some("SIGTERM"));
    }

    #[test]
    fn prune_v3_tables() {
        let db = test_db();
        let old_ts = "2020-01-01T00:00:00Z".to_string();

        db.insert_cron_run(&CronRunRecord {
            id: None,
            timestamp: old_ts.clone(),
            job: "maintain".to_string(),
            status: "success".to_string(),
            details: None,
            duration_ms: None,
        })
        .unwrap();

        db.insert_git_event(&GitEventRecord {
            id: None,
            timestamp: old_ts.clone(),
            project: "nx".to_string(),
            event_type: "new_commit".to_string(),
            old_ref: None,
            new_ref: None,
        })
        .unwrap();

        db.insert_lifecycle_event(&AgentLifecycleRecord {
            id: None,
            timestamp: old_ts.clone(),
            event_type: "start".to_string(),
            version: None,
            uptime_seconds: None,
            reason: None,
        })
        .unwrap();

        let stats = db.prune_old_records(30, 90).unwrap();
        assert_eq!(stats.cron_runs_deleted, 1);
        assert_eq!(stats.git_events_deleted, 1);
        assert_eq!(stats.lifecycle_deleted, 1);
    }
}
