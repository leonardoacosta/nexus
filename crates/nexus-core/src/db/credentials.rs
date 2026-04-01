//! Credential poll and swap CRUD operations.

use anyhow::Result;
use rusqlite::params;

use super::types::{CredentialPollRecord, CredentialSwapRecord};
use super::NexusDb;

impl NexusDb {
    /// Insert a credential usage poll record.
    pub fn insert_credential_poll(&self, poll: &CredentialPollRecord) -> Result<()> {
        self.write(|conn| {
            conn.execute(
                "INSERT INTO credential_polls (
                    timestamp, account, five_hour_utilization, seven_day_utilization,
                    five_hour_resets_at, seven_day_resets_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    poll.timestamp,
                    poll.account,
                    poll.five_hour_utilization,
                    poll.seven_day_utilization,
                    poll.five_hour_resets_at,
                    poll.seven_day_resets_at,
                ],
            )?;
            Ok(())
        })
    }

    /// Query credential polls for an account, ordered by timestamp descending.
    pub fn query_credential_polls(
        &self,
        account: Option<&str>,
        limit: u32,
    ) -> Result<Vec<CredentialPollRecord>> {
        self.read(|conn| {
            let (sql, bind_values): (String, Vec<String>) = match account {
                Some(a) => (
                    "SELECT timestamp, account, five_hour_utilization, seven_day_utilization,
                            five_hour_resets_at, seven_day_resets_at
                     FROM credential_polls WHERE account = ?1
                     ORDER BY timestamp DESC LIMIT ?2"
                        .to_string(),
                    vec![a.to_string()],
                ),
                None => (
                    "SELECT timestamp, account, five_hour_utilization, seven_day_utilization,
                            five_hour_resets_at, seven_day_resets_at
                     FROM credential_polls
                     ORDER BY timestamp DESC LIMIT ?1"
                        .to_string(),
                    vec![],
                ),
            };

            let mut stmt = conn.prepare(&sql)?;
            let mut all_params: Vec<Box<dyn rusqlite::types::ToSql>> = bind_values
                .iter()
                .map(|v| Box::new(v.clone()) as Box<dyn rusqlite::types::ToSql>)
                .collect();
            all_params.push(Box::new(limit));
            let rows = stmt.query_map(
                rusqlite::params_from_iter(all_params.iter().map(|p| p.as_ref())),
                |row| {
                    Ok(CredentialPollRecord {
                        timestamp: row.get(0)?,
                        account: row.get(1)?,
                        five_hour_utilization: row.get(2)?,
                        seven_day_utilization: row.get(3)?,
                        five_hour_resets_at: row.get(4)?,
                        seven_day_resets_at: row.get(5)?,
                    })
                },
            )?;

            let mut results = Vec::new();
            for row in rows {
                results.push(row?);
            }
            Ok(results)
        })
    }

    /// Get the latest poll for each account (for startup bootstrap).
    pub fn latest_credential_polls(&self) -> Result<Vec<CredentialPollRecord>> {
        self.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT cp.timestamp, cp.account, cp.five_hour_utilization, cp.seven_day_utilization,
                        cp.five_hour_resets_at, cp.seven_day_resets_at
                 FROM credential_polls cp
                 INNER JOIN (
                     SELECT account, MAX(timestamp) as max_ts
                     FROM credential_polls GROUP BY account
                 ) latest ON cp.account = latest.account AND cp.timestamp = latest.max_ts",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(CredentialPollRecord {
                    timestamp: row.get(0)?,
                    account: row.get(1)?,
                    five_hour_utilization: row.get(2)?,
                    seven_day_utilization: row.get(3)?,
                    five_hour_resets_at: row.get(4)?,
                    seven_day_resets_at: row.get(5)?,
                })
            })?;
            let mut results = Vec::new();
            for row in rows {
                results.push(row?);
            }
            Ok(results)
        })
    }

    /// Insert a credential swap event.
    pub fn insert_credential_swap(&self, swap: &CredentialSwapRecord) -> Result<()> {
        self.write(|conn| {
            conn.execute(
                "INSERT INTO credential_swaps (timestamp, from_account, to_account, trigger_session_id)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    swap.timestamp,
                    swap.from_account,
                    swap.to_account,
                    swap.trigger_session_id,
                ],
            )?;
            Ok(())
        })
    }

    /// Query credential swaps, ordered by timestamp descending.
    pub fn query_credential_swaps(&self, limit: u32) -> Result<Vec<CredentialSwapRecord>> {
        self.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT timestamp, from_account, to_account, trigger_session_id
                 FROM credential_swaps ORDER BY timestamp DESC LIMIT ?1",
            )?;
            let rows = stmt.query_map(params![limit], |row| {
                Ok(CredentialSwapRecord {
                    timestamp: row.get(0)?,
                    from_account: row.get(1)?,
                    to_account: row.get(2)?,
                    trigger_session_id: row.get(3)?,
                })
            })?;
            let mut results = Vec::new();
            for row in rows {
                results.push(row?);
            }
            Ok(results)
        })
    }
}
