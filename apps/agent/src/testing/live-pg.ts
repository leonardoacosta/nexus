// Live-Postgres integration tests are OPT-IN. They mutate the DB, so they must
// NEVER run against an unspecified/prod POSTGRES_URL — set NEXUS_PG_TESTS=1
// (and point POSTGRES_URL at a throwaway TEST database) to run them.
export const hasLivePg =
  process.env.NEXUS_PG_TESTS === "1" && !!process.env.POSTGRES_URL;
