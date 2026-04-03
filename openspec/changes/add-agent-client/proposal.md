# Add Agent Client

## Why
Every dashboard page needs to fetch data from multiple agents simultaneously. Without a shared client with parallel fetching, timeout handling, and offline detection, each page would re-implement the same HTTP orchestration logic, leading to inconsistent error handling and duplicated code.

## What Changes
Build the @nexus/agent-client server-side package that reads agents from config, fetches all agents in parallel via Promise.allSettled with a 3-second timeout, tracks offline agents with "last seen" timestamps, merges responses into unified lists, and caches results with configurable TTL (1s for health, 5s for sessions). Includes retry logic (1 retry, 1-second delay).
