## 1. Mode Toggle
- [x] [1.1] Implement stream/interact toggle button in session detail page [owner:engineer]
- [x] [1.2] Upgrade WebSocket connection from stream to interact endpoint on toggle [owner:engineer]
- [x] [1.3] Implement mode indicator UI ("Streaming (read-only)" vs "Interactive") [owner:engineer]

## 2. Input Capture
- [x] [2.1] Add keyboard capture in interactive mode (prevent browser shortcuts when terminal focused) [owner:engineer]
- [x] [2.2] Forward resize events to WebSocket as JSON control frames [owner:engineer]

## 3. Disconnect
- [x] [3.1] Add disconnect button to exit interactive mode (revert to stream) [owner:engineer]
- [x] [3.2] Handle edge cases: agent goes offline during interaction, session ends during interaction [owner:engineer]

## 4. Validation
- [x] [4.1] Write E2E test: open session, switch to interactive, type command, verify output [owner:engineer]
- [x] [4.2] Write E2E test: Ctrl+C in interactive mode sends 0x03 to remote PTY [owner:engineer]
- [x] [4.3] Write E2E test: browser resize in interactive mode propagates to remote terminal [owner:engineer]
