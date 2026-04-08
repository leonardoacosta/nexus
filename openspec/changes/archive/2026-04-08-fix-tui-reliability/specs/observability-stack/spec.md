## MODIFIED Requirements

### Requirement: OpenTelemetry Trace Export — Rust
The system SHALL compose a `tracing-opentelemetry` layer into the tracing subscriber stack in
all Rust binaries. The OTel layer SHALL export spans via OTLP to the endpoint configured in
`OTEL_EXPORTER_OTLP_ENDPOINT`. When the env var is not set, the OTel layer SHALL not be added.
When the env var is set but the exporter fails to build, the binary SHALL log a warning and
fall back to the non-OTel subscriber instead of panicking.

#### Scenario: OTel layer active with endpoint
- **WHEN** `OTEL_EXPORTER_OTLP_ENDPOINT` is set to `http://localhost:4317`
- **THEN** `tracing::info_span!` calls in nexus-tui produce spans exported to that endpoint

#### Scenario: OTel layer skipped without endpoint
- **WHEN** `OTEL_EXPORTER_OTLP_ENDPOINT` is not set
- **THEN** no OTel layer is composed and the binary starts normally with fmt-only tracing

#### Scenario: OTel exporter build failure — graceful degradation
- **WHEN** `OTEL_EXPORTER_OTLP_ENDPOINT` is set to an unreachable or malformed endpoint
- **AND** the exporter fails to build (e.g. TLS error, invalid URI)
- **THEN** the binary logs a warning at `WARN` level describing the failure
- **AND** the binary continues startup with fmt-only tracing (no panic, no process exit)

#### Scenario: fmt layer always active
- **WHEN** OTel is enabled
- **THEN** the `tracing_subscriber::fmt` layer still emits to stdout as before

## ADDED Requirements

### Requirement: Logging directive parse fallback
The tracing subscriber initialisation in all Rust binaries SHALL use
`.unwrap_or_else(|_| Directive::default())` when parsing hardcoded filter directives. A
malformed or unparseable directive MUST NOT cause a panic; the default directive (no extra
filter) SHALL be used instead.

#### Scenario: Valid directive parses normally
- **WHEN** the hardcoded directive `"nexus_tui=info"` is parsed
- **THEN** the directive is applied and `nexus_tui` spans are filtered to INFO and above

#### Scenario: Invalid directive falls back silently
- **WHEN** a directive string fails to parse (e.g. due to a future code change introducing
  an invalid string)
- **THEN** `Directive::default()` is used and the binary continues startup without panic
