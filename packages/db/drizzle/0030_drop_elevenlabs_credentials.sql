-- Custom SQL migration file, put your code below! --

-- Spec: swift-owns-elevenlabs-synth (wave 1 v2 finish — nx-p54s1)
--
-- Drop elevenlabs_credentials table. Swift app owns synthesis now
-- (NexusShared.ElevenLabsClient + Keychain). nx-cao5q deleted the
-- agent-side HTTP routes and runtime singleton; this migration drops
-- the now-orphaned table.
--
-- CASCADE on DROP TABLE handles the agent_id FK constraint
-- (elevenlabs_credentials_agent_id_agents_id_fk) and the two indices
-- (unique + non-unique on agent_id) created by migration 0020.

DROP TABLE IF EXISTS "elevenlabs_credentials" CASCADE;
