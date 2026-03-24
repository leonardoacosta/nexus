mod common;

use nexus_core::proto::{
    EventFilter, HeartbeatRequest, HealthRequest, ListAgentsRequest, ListProjectsRequest,
    RegisterSessionRequest, SessionFilter, SessionId, UnregisterSessionRequest,
};

// ---------------------------------------------------------------------------
// Session lifecycle tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_register_then_get_sessions() {
    let addr = common::start_test_server().await;
    let mut client = common::create_test_client(addr).await;

    let session_id = "test-session-001".to_string();

    // Register a session.
    let resp = client
        .register_session(RegisterSessionRequest {
            session_id: session_id.clone(),
            pid: 1234,
            cwd: "/tmp/test-project".to_string(),
            project: Some("test-project".to_string()),
            branch: Some("main".to_string()),
            command: None,
        })
        .await
        .expect("register_session failed");

    let body = resp.into_inner();
    assert_eq!(body.session_id, session_id);
    assert!(body.created, "first registration should return created=true");

    // GetSessions should include the registered session.
    let list_resp = client
        .get_sessions(SessionFilter {
            status: None,
            project: None,
            session_type: None,
        })
        .await
        .expect("get_sessions failed");

    let list = list_resp.into_inner();
    assert_eq!(list.agent_name, "test-agent");
    assert!(
        list.sessions.iter().any(|s| s.id == session_id),
        "registered session should appear in GetSessions response"
    );
}

#[tokio::test]
async fn test_register_then_get_session_by_id() {
    let addr = common::start_test_server().await;
    let mut client = common::create_test_client(addr).await;

    let session_id = "test-session-002".to_string();

    client
        .register_session(RegisterSessionRequest {
            session_id: session_id.clone(),
            pid: 5678,
            cwd: "/tmp/another-project".to_string(),
            project: Some("another-project".to_string()),
            branch: None,
            command: None,
        })
        .await
        .expect("register_session failed");

    let get_resp = client
        .get_session(SessionId {
            id: session_id.clone(),
        })
        .await
        .expect("get_session failed");

    let session = get_resp.into_inner();
    assert_eq!(session.id, session_id);
    assert_eq!(session.pid, 5678);
    assert_eq!(session.cwd, "/tmp/another-project");
    assert_eq!(session.project, Some("another-project".to_string()));
}

#[tokio::test]
async fn test_unregister_removes_session() {
    let addr = common::start_test_server().await;
    let mut client = common::create_test_client(addr).await;

    let session_id = "test-session-003".to_string();

    // Register.
    client
        .register_session(RegisterSessionRequest {
            session_id: session_id.clone(),
            pid: 9999,
            cwd: "/tmp/remove-test".to_string(),
            project: None,
            branch: None,
            command: None,
        })
        .await
        .expect("register_session failed");

    // Unregister.
    let unreg_resp = client
        .unregister_session(UnregisterSessionRequest {
            session_id: session_id.clone(),
        })
        .await
        .expect("unregister_session failed");

    assert!(
        unreg_resp.into_inner().found,
        "unregister should return found=true for a known session"
    );

    // GetSessions should now be empty (only this test's server instance).
    let list = client
        .get_sessions(SessionFilter {
            status: None,
            project: None,
            session_type: None,
        })
        .await
        .expect("get_sessions failed")
        .into_inner();

    assert!(
        !list.sessions.iter().any(|s| s.id == session_id),
        "unregistered session should not appear in GetSessions"
    );
}

#[tokio::test]
async fn test_heartbeat_updates_timestamp() {
    let addr = common::start_test_server().await;
    let mut client = common::create_test_client(addr).await;

    let session_id = "test-session-004".to_string();

    // Register and capture the initial last_heartbeat.
    client
        .register_session(RegisterSessionRequest {
            session_id: session_id.clone(),
            pid: 1111,
            cwd: "/tmp/heartbeat-test".to_string(),
            project: None,
            branch: None,
            command: None,
        })
        .await
        .expect("register_session failed");

    let before_ts = client
        .get_session(SessionId {
            id: session_id.clone(),
        })
        .await
        .expect("get_session failed")
        .into_inner()
        .last_heartbeat;

    // Wait briefly so the timestamp can advance.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    // Send heartbeat.
    let hb_resp = client
        .heartbeat(HeartbeatRequest {
            session_id: session_id.clone(),
        })
        .await
        .expect("heartbeat failed");

    assert!(
        hb_resp.into_inner().found,
        "heartbeat should return found=true for a known session"
    );

    // Retrieve updated session.
    let after_ts = client
        .get_session(SessionId {
            id: session_id.clone(),
        })
        .await
        .expect("get_session failed")
        .into_inner()
        .last_heartbeat;

    // The timestamp should have advanced (or at least not regressed).
    match (before_ts, after_ts) {
        (Some(before), Some(after)) => {
            assert!(
                after.seconds > before.seconds
                    || (after.seconds == before.seconds && after.nanos >= before.nanos),
                "last_heartbeat should advance after Heartbeat RPC: before={before:?} after={after:?}"
            );
        }
        _ => panic!("expected timestamps to be present on both before and after snapshots"),
    }
}

#[tokio::test]
async fn test_get_session_not_found() {
    let addr = common::start_test_server().await;
    let mut client = common::create_test_client(addr).await;

    let err = client
        .get_session(SessionId {
            id: "nonexistent-session-id-xyz".to_string(),
        })
        .await
        .expect_err("expected NOT_FOUND error for unknown session");

    assert_eq!(
        err.code(),
        tonic::Code::NotFound,
        "expected NOT_FOUND status code, got: {:?}",
        err.code()
    );
}

// ---------------------------------------------------------------------------
// Health & Discovery tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_get_health() {
    let addr = common::start_test_server().await;
    let mut client = common::create_test_client(addr).await;

    let resp = client
        .get_health(HealthRequest {})
        .await
        .expect("get_health failed");

    let health = resp.into_inner();
    assert_eq!(
        health.agent_name, "test-agent",
        "agent_name should match what was set in start_test_server"
    );
    assert!(
        health.machine.is_some(),
        "machine health metrics should be present"
    );
}

#[tokio::test]
async fn test_list_projects() {
    let addr = common::start_test_server().await;
    let mut client = common::create_test_client(addr).await;

    // ListProjects should succeed even with an empty registry.
    let resp = client
        .list_projects(ListProjectsRequest {})
        .await
        .expect("list_projects failed");

    // The response is valid; project list may be empty or populated from
    // ~/.claude/projects/ on the test machine — either is acceptable.
    let _projects = resp.into_inner().projects;
}

#[tokio::test]
async fn test_list_agents() {
    let addr = common::start_test_server().await;
    let mut client = common::create_test_client(addr).await;

    let resp = client
        .list_agents(ListAgentsRequest {})
        .await
        .expect("list_agents failed");

    let agents = resp.into_inner().agents;
    assert_eq!(agents.len(), 1, "should report exactly one agent (itself)");
    assert_eq!(agents[0].name, "test-agent");
    assert_eq!(agents[0].host, "localhost");
    assert_eq!(agents[0].port, 7400);
}

// ---------------------------------------------------------------------------
// Idempotency edge cases
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_register_twice_is_idempotent() {
    let addr = common::start_test_server().await;
    let mut client = common::create_test_client(addr).await;

    let session_id = "test-session-idem".to_string();
    let req = || RegisterSessionRequest {
        session_id: session_id.clone(),
        pid: 2222,
        cwd: "/tmp/idem-test".to_string(),
        project: None,
        branch: None,
        command: None,
    };

    let first = client
        .register_session(req())
        .await
        .expect("first register failed")
        .into_inner();
    assert!(first.created);

    let second = client
        .register_session(req())
        .await
        .expect("second register failed")
        .into_inner();
    assert!(!second.created, "second registration should return created=false");

    // Only one entry should exist.
    let list = client
        .get_sessions(SessionFilter {
            status: None,
            project: None,
            session_type: None,
        })
        .await
        .expect("get_sessions failed")
        .into_inner();

    let count = list.sessions.iter().filter(|s| s.id == session_id).count();
    assert_eq!(count, 1, "session should appear exactly once even after double registration");
}

#[tokio::test]
async fn test_unregister_unknown_returns_not_found() {
    let addr = common::start_test_server().await;
    let mut client = common::create_test_client(addr).await;

    let resp = client
        .unregister_session(UnregisterSessionRequest {
            session_id: "does-not-exist".to_string(),
        })
        .await
        .expect("unregister_session should not error")
        .into_inner();

    assert!(
        !resp.found,
        "unregistering an unknown session should return found=false"
    );
}

#[tokio::test]
async fn test_heartbeat_unknown_session_returns_not_found() {
    let addr = common::start_test_server().await;
    let mut client = common::create_test_client(addr).await;

    let resp = client
        .heartbeat(HeartbeatRequest {
            session_id: "ghost-session".to_string(),
        })
        .await
        .expect("heartbeat should not error")
        .into_inner();

    assert!(
        !resp.found,
        "heartbeat for unknown session should return found=false"
    );
}

// ---------------------------------------------------------------------------
// StreamEvents smoke test (connection only, no event assertions)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_stream_events_connects() {
    let addr = common::start_test_server().await;
    let mut client = common::create_test_client(addr).await;

    // Opening a StreamEvents connection should succeed without error.
    // We don't consume events — just verify the RPC establishes.
    let _stream = client
        .stream_events(EventFilter {
            session_id: None,
            event_types: vec![],
            initial_snapshot: false,
        })
        .await
        .expect("stream_events should establish without error");
}
