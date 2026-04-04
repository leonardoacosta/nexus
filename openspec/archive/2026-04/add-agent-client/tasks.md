## 1. Core Client
- [x] [1.1] Implement agent client that reads agent config and fetches all agents in parallel via Promise.allSettled [owner:engineer]
- [x] [1.2] Add 3-second timeout per agent request [owner:engineer]
- [x] [1.3] Add retry logic: 1 retry with 1-second delay on failure [owner:engineer]

## 2. Resilience
- [x] [2.1] Implement offline tracking with "last seen" timestamps per agent [owner:engineer]
- [x] [2.2] Add response merging: combine sessions from all agents into a unified list with agent metadata [owner:engineer]

## 3. Caching
- [x] [3.1] Add cache layer with configurable TTL (1s for health endpoints, 5s for session endpoints) [owner:engineer]

## 4. Testing
- [x] [4.1] Write tests with mocked agents: online agent, offline agent, and slow agent (timeout) scenarios [owner:engineer]
